/**
 * Page download service: pulls the live Pages database from ShopSite
 * (`db_xml.cgi` with `dbname=pages`) and converts it into an
 * activation-ready preview payload. This service performs NO database
 * writes — activation still goes through the atomic
 * `activatePageImportFromRecords` path so a download can never mutate
 * `page_index` by itself.
 *
 * Fail-closed rules:
 * - A ShopSite-reported non-success `ResponseCode` (anything but `1`,
 *   the success code observed in the real Bay State export) fails the
 *   download with the reported `ResponseDescription`.
 * - A successful envelope containing zero `<Page>` blocks fails — an
 *   empty pages database must be a visible error, not a silent wipe of
 *   page candidates.
 * - Records without a `<PageID>` degrade to `unverified_name_only` via
 *   `toPageRecords` and can never activate.
 */
import { sha256Hex } from '../shared/stable-id';
import { computePageImportCounts } from '../db/repositories/page-import-repo';
import { parseShopSitePagesXml, toPageRecords, shopSitePagesXmlParserAdapter } from './page-parser';
import type { PageRecord } from '../shared/schemas/page';

/** Minimal fetch contract so tests can substitute a stub fetcher. */
export interface PagesXmlFetchResult {
  success: boolean;
  data?: string;
  errors: string[];
  error?: string;
}

export type PagesXmlFetcher = {
  fetchPagesXml(options?: { version?: string; fields?: string[] }): Promise<PagesXmlFetchResult>;
};

export interface PageDownloadFailure {
  ok: false;
  error: string;
}

export interface PageDownloadPreview {
  ok: true;
  /** SHA-256 of the raw ShopSite XML — the import source hash. */
  sourceHash: string;
  parserFormatVersion: string;
  counts: { total: number; verified: number; nameOnly: number; withParent: number };
  records: PageRecord[];
  warnings: string[];
  responseCode: string | null;
  responseDescription: string | null;
}

export type PageDownloadResult = PageDownloadFailure | PageDownloadPreview;

/**
 * Download and normalize the ShopSite Pages database. No DB effect.
 */
export async function downloadPagesFromShopSite(fetcher: PagesXmlFetcher): Promise<PageDownloadResult> {
  // Do not inherit a merchant's saved/default field selection. The live
  // store can return hundreds of empty Page records without these fields.
  // 14.0 is a documented XML compatibility version (the store may declare
  // its running 15.0 version in the response). Page ID is an export field,
  // not a Name/position-derived identity.
  const result = await fetcher.fetchPagesXml({
    version: '14.0', fields: ['Name', 'File name', 'Page ID', 'Title'],
  });
  if (!result.success || !result.data) {
    return {
      ok: false,
      error: result.error ?? (result.errors && result.errors.length > 0 ? result.errors[0] : 'ShopSite Pages download failed.'),
    };
  }

  const rawXml = result.data;
  const document = parseShopSitePagesXml(rawXml);

  if (document.responseCode !== null && document.responseCode !== '1') {
    return {
      ok: false,
      error: `ShopSite reported a failed Pages download: ${document.responseDescription ?? `ResponseCode ${document.responseCode}`}`,
    };
  }

  const records = toPageRecords(document);
  if (document.pages.some(page => !page.name.trim())) {
    return { ok: false, error: 'ShopSite Pages download contains unnamed records. Export Name, File name and Page ID explicitly; no assignment pages were imported.' };
  }
  if (records.length === 0) {
    return { ok: false, error: 'ShopSite Pages download contained no pages.' };
  }

  const warnings = records
    .filter(record => record.identity.kind === 'unverified_name_only')
    .map(record => `Page "${record.name}" is name-only and will be excluded from activation.`);

  return {
    ok: true,
    sourceHash: sha256Hex(rawXml),
    parserFormatVersion: shopSitePagesXmlParserAdapter.name,
    counts: computePageImportCounts(records),
    records,
    warnings,
    responseCode: document.responseCode,
    responseDescription: document.responseDescription,
  };
}
