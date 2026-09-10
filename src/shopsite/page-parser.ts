import { XMLParser } from 'fast-xml-parser';
import type { PageParserAdapter } from './page-import-service';
import type { PageRecord } from '../shared/schemas/page';

/**
 * ShopSite Pages XML parser.
 *
 * Parses a real ShopSite Pages export (root `<ShopSitePages version="15.0">`,
 * `<Response>` block, `<Pages>` containing `<Page>` elements). Raw `<Page>`
 * fragments are preserved verbatim and
 * each fragment is parsed structurally with fast-xml-parser, so unknown
 * elements and nested blocks are never lost.
 *
 * Identity contract (from the real Bay State export):
 * - `<PageID>` is a numeric, unique, immutable page GUID (all 211 pages have
 *   one). It is the preferred exported identity.
 * - `<PageFileName>` is unique and is the documented fallback identity.
 * - `<LinksToPage>` is the parent page reference (empty in this export).
 *
 * ShopSite exports declare ISO-8859-1 and use named entities (`&amp;`,
 * `&lt;`, `&apos;`) plus Latin-1/Windows-1252 numeric character references
 * (e.g. `&#233;` for é, `&#145;`/`&#146;` for curly quotes). fast-xml-parser
 * decodes named entities; numeric references are decoded here (0x80-0x9F per
 * Windows-1252, which is what ShopSite actually emits for curly quotes/€).
 */

export interface ParsedShopSitePage {
  /** String form of `<PageID>`; empty string when the page has no PageID. */
  pageId: string;
  /** Decoded `<Name>`. */
  name: string;
  /** `<PageFileName>` (unique exported file name), or ''. */
  pageFileName: string;
  /** Decoded `<LinksToPage>` text, or null when absent/empty. */
  parentRef: string | null;
  /** Product display names from `<ProductLinks>` (decoded), document order. */
  productLinks: string[];
  /** Exact `<Page>…</Page>` fragment, preserved verbatim. */
  rawXml: string;
  /** Ordered map of scalar element name → decoded text (unknown tags included). */
  fields: Record<string, string>;
  /** Raw XML for nested/block elements (e.g. ProductLinks) keyed by tag. */
  blocks: Record<string, string>;
}

export interface ShopSitePagesDocument {
  /** `version` attribute of the root element. */
  version: string;
  /** `<ResponseCode>` or null. */
  responseCode: string | null;
  /** `<ResponseDescription>` or null. */
  responseDescription: string | null;
  pages: ParsedShopSitePage[];
}

/** Windows-1252 glyphs for the ISO-8859-1 control range 0x80-0x9F. */
const WINDOWS_1252_HIGH: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž',
  0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
  0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

/** Decode `&#N;` numeric character references (ShopSite Latin-1/Windows-1252). */
export function decodeNumericEntities(text: string): string {
  return text.replace(/&#(\d+);/g, (whole, dec: string) => {
    const cp = Number(dec);
    if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return whole;
    if (cp >= 0x80 && cp <= 0x9f) return WINDOWS_1252_HIGH[cp] ?? whole;
    try {
      return String.fromCodePoint(cp);
    } catch {
      return whole;
    }
  });
}

/** Decode named (fast-xml-parser) and numeric character references. */
function decodeText(value: string): string {
  // fast-xml-parser already decodes &amp; &lt; &gt; &quot; &apos;.
  return decodeNumericEntities(value);
}

const PAGE_BLOCK_REGEX = /<Page(?:\s[^>]*)?>[\s\S]*?<\/Page>/gi;

function extractBlock(rawXml: string, tagName: string): string | undefined {
  const regex = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?</${tagName}>`, 'i');
  const match = rawXml.match(regex);
  return match ? match[0] : undefined;
}

function parseProductLinks(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return [];
  const product = (value as Record<string, unknown>).Product;
  if (product === undefined || product === null) return [];
  const entries = Array.isArray(product) ? product : [product];
  const names: string[] = [];
  for (const entry of entries) {
    if (entry && typeof entry === 'object') {
      const name = (entry as Record<string, unknown>).Name;
      if (typeof name === 'string' && name.trim().length > 0) {
        names.push(decodeText(name.trim()));
      }
    }
  }
  return names;
}

function parsePageBlock(rawXml: string): ParsedShopSitePage | null {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    preserveOrder: false,
    trimValues: true,
    parseTagValue: false,
    isArray: () => false,
  });
  const wrapped = `<Root>${rawXml}</Root>`;
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(wrapped) as Record<string, unknown>;
  } catch {
    return null;
  }
  const root = parsed?.Root as Record<string, unknown> | undefined;
  const pageData = root?.Page as Record<string, unknown> | undefined;
  if (!pageData || typeof pageData !== 'object') return null;

  const fields: Record<string, string> = {};
  const blocks: Record<string, string> = {};
  let productLinks: string[] = [];

  for (const [tag, value] of Object.entries(pageData)) {
    if (tag.startsWith('@_')) continue;
    if (typeof value === 'string') {
      fields[tag] = decodeText(value);
    } else if (tag === 'ProductLinks') {
      productLinks = parseProductLinks(value);
      const block = extractBlock(rawXml, 'ProductLinks');
      if (block) blocks.ProductLinks = block;
    } else {
      // Nested/block element — preserve the raw fragment.
      const block = extractBlock(rawXml, tag);
      if (block) blocks[tag] = block;
    }
  }

  const pageId = (fields.PageID ?? '').trim();
  const name = (fields.Name ?? '').trim();
  const pageFileName = (fields.PageFileName ?? '').trim();
  const linksToPage = (fields.LinksToPage ?? '').trim();
  const parentRef = linksToPage.length > 0 ? linksToPage : null;

  return {
    pageId,
    name,
    pageFileName,
    parentRef,
    productLinks,
    rawXml,
    fields,
    blocks,
  };
}

/**
 * Parse a ShopSite Pages XML export into a normalized document.
 * Never throws on malformed individual pages — unparsable pages are skipped
 * and the raw document data is preserved where possible.
 */
export function parseShopSitePagesXml(xmlText: string): ShopSitePagesDocument {
  const document: ShopSitePagesDocument = {
    version: '15.0',
    responseCode: null,
    responseDescription: null,
    pages: [],
  };

  const versionMatch = xmlText.match(/<ShopSitePages[^>]*\sversion="([^"]+)"/i);
  if (versionMatch) document.version = versionMatch[1];

  const responseMatch = xmlText.match(/<Response>[\s\S]*?<\/Response>/i);
  if (responseMatch) {
    const code = responseMatch[0].match(/<ResponseCode>([\s\S]*?)<\/ResponseCode>/i);
    const description = responseMatch[0].match(/<ResponseDescription>([\s\S]*?)<\/ResponseDescription>/i);
    document.responseCode = code ? code[1].trim() : null;
    document.responseDescription = description ? description[1].trim() : null;
  }

  let match: RegExpExecArray | null;
  while ((match = PAGE_BLOCK_REGEX.exec(xmlText)) !== null) {
    const page = parsePageBlock(match[0]);
    if (page) document.pages.push(page);
  }

  return document;
}

/**
 * Map a parsed Pages document to the normalized PageRecord import shape.
 * Pages with a PageID become `exported_guid` verified identities (the
 * immutable ShopSite page GUID). Pages without one (none in the real export)
 * degrade to `unverified_name_only` so activation can never silently verify
 * an identity-less page.
 */
export function toPageRecords(document: ShopSitePagesDocument): PageRecord[] {
  return document.pages.map((page) => {
    const hasId = page.pageId.length > 0;
    const name = page.name.length > 0 ? page.name : (page.pageFileName || 'unnamed');
    return {
      identity: hasId
        ? { kind: 'exported_guid', key: page.pageId, status: 'verified' }
        : { kind: 'unverified_name_only', key: name, status: 'unverified' },
      name,
      parentRef: page.parentRef,
      availability: 'available',
    };
  });
}

/** Parser adapter satisfying the PageParserAdapter contract. */
export class ShopSitePagesXmlParserAdapter implements PageParserAdapter {
  readonly name = 'shopsite-pages-xml-1';
  parsePagesXml(input: string): PageRecord[] {
    return toPageRecords(parseShopSitePagesXml(input));
  }
}

export const shopSitePagesXmlParserAdapter: PageParserAdapter = new ShopSitePagesXmlParserAdapter();
