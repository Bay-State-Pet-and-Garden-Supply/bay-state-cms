import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';

export interface ExtractorProfile {
  id: string;
  version?: number;
  domain: string;
  titleSelector: string | null;
  titleOptionalSelectors: string[];
  priceSelector: string | null;
  descriptionSelector: string | null;
  brandSelector: string | null;
  imagesSelector: string | null;
  customSelectors: Record<string, string>;
  sitemapProductUrlPattern: string | null;
  shopifyJSONPath: boolean;
  variantSelectionStrategy: Record<string, unknown> | null;
  customSelectorMetadata: Record<string, unknown>;
  /** Shared extraction-policy content (T2); null for legacy profiles. */
  extractionPolicy?: Record<string, unknown> | null;
  runtime: 'static' | 'rendered';
  profileType?: 'brand' | 'retailer';
  createdAt: string;
  updatedAt: string;
}

interface DbProfile {
  id: string;
  domain: string;
  title_selector: string | null;
  title_optional_selectors_json: string | null;
  price_selector: string | null;
  description_selector: string | null;
  brand_selector: string | null;
  images_selector: string | null;
  custom_selectors_json: string | null;
  sitemap_product_url_pattern: string | null;
  shopify_json_path: number;
  variant_selection_strategy_json: string | null;
  custom_selector_metadata_json: string | null;
  runtime: string | null;
  profile_type?: string | null;
  created_at: string;
  updated_at: string;
}

function mapToProfile(db: DbProfile): ExtractorProfile {
  return {
    id: db.id,
    domain: db.domain,
    titleSelector: db.title_selector,
    titleOptionalSelectors: db.title_optional_selectors_json ? JSON.parse(db.title_optional_selectors_json) : [],
    priceSelector: db.price_selector,
    descriptionSelector: db.description_selector,
    brandSelector: db.brand_selector,
    imagesSelector: db.images_selector,
    customSelectors: db.custom_selectors_json ? JSON.parse(db.custom_selectors_json) : {},
    sitemapProductUrlPattern: db.sitemap_product_url_pattern,
    shopifyJSONPath: !!db.shopify_json_path,
    variantSelectionStrategy: db.variant_selection_strategy_json ? JSON.parse(db.variant_selection_strategy_json) : null,
    customSelectorMetadata: db.custom_selector_metadata_json ? JSON.parse(db.custom_selector_metadata_json) : {},
    // Legacy profile rows predate extraction policies; the health evaluator
    // normalizes absent policies to null for drift comparison.
    extractionPolicy: null,
    runtime: db.runtime === 'static' ? 'static' : 'rendered',
    profileType: (db.profile_type === 'retailer' ? 'retailer' : 'brand'),
    createdAt: db.created_at,
    updatedAt: db.updated_at,
  };
}

export function findProfileByDomain(domain: string): ExtractorProfile | null {
  const db = getDb();
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '').trim();
  const row = db.query('SELECT * FROM extractor_profiles WHERE domain = ?').get(normalizedDomain) as DbProfile | undefined;
  return row ? mapToProfile(row) : null;
}

export function listAllProfiles(): ExtractorProfile[] {
  const db = getDb();
  const rows = db.query('SELECT * FROM extractor_profiles ORDER BY domain').all() as DbProfile[];
  return rows.map(mapToProfile);
}

/**
 * Insert or update an extractor profile.
 *
 * Selector merge semantics (important for self-healing safety):
 *   - When the row is new: omitted selectors default to `null`.
 *   - When the row already exists: only the provided selectors are touched.
 *     - `undefined` (omitted or explicit): preserve the existing value.
 *     - `null` (explicit): clear the selector.
 *     - `string` (explicit): replace the existing value.
 *   This prevents a partial update from erasing selectors the caller
 *   didn't intend to touch, which is critical before the LLM-assisted
 *   generator starts promoting profiles in later phases.
 */
export function upsertProfile(
  domain: string,
  selectors: {
    titleSelector?: string | null;
    titleOptionalSelectors?: string[];
    priceSelector?: string | null;
    descriptionSelector?: string | null;
    brandSelector?: string | null;
    imagesSelector?: string | null;
    customSelectors?: Record<string, string>;
    sitemapProductUrlPattern?: string | null;
    shopifyJSONPath?: boolean;
    variantSelectionStrategy?: Record<string, unknown> | null;
    customSelectorMetadata?: Record<string, unknown>;
    runtime?: 'static' | 'rendered';
  },
): ExtractorProfile {
  const db = getDb();
  const now = new Date().toISOString();
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '').trim();

  const existing = db.query('SELECT * FROM extractor_profiles WHERE domain = ?').get(normalizedDomain) as DbProfile | undefined;

  const resolve = (
    existingValue: string | null,
    provided: string | null | undefined,
  ): string | null => {
    if (!existing) return provided ?? null;
    return provided === undefined ? existingValue : provided;
  };

  const tSel = resolve(existing?.title_selector ?? null, selectors.titleSelector);
  // titleOptionalSelectors: undefined = preserve existing; explicit array = replace
  const toSel = selectors.titleOptionalSelectors !== undefined
    ? selectors.titleOptionalSelectors
    : (existing?.title_optional_selectors_json ? JSON.parse(existing.title_optional_selectors_json) : []);
  const pSel = resolve(existing?.price_selector ?? null, selectors.priceSelector);
  const dSel = resolve(existing?.description_selector ?? null, selectors.descriptionSelector);
  const bSel = resolve(existing?.brand_selector ?? null, selectors.brandSelector);
  const iSel = resolve(existing?.images_selector ?? null, selectors.imagesSelector);
  const cSel = selectors.customSelectors !== undefined
    ? selectors.customSelectors
    : (existing?.custom_selectors_json ? JSON.parse(existing.custom_selectors_json) : {});
  const sSel = resolve(existing?.sitemap_product_url_pattern ?? null, selectors.sitemapProductUrlPattern);
  const shopifyJSONPath = existing ? (selectors.shopifyJSONPath ?? !!existing.shopify_json_path) : (selectors.shopifyJSONPath ?? false);
  // variantSelectionStrategy: undefined = preserve existing; explicit null = clear; explicit object = replace
  const vsSel = existing
    ? (selectors.variantSelectionStrategy === undefined
        ? (existing.variant_selection_strategy_json ? JSON.parse(existing.variant_selection_strategy_json) : null)
        : selectors.variantSelectionStrategy)
    : (selectors.variantSelectionStrategy ?? null);
  // customSelectorMetadata: undefined = preserve existing; explicit object = replace
  const csmSel = existing
    ? (selectors.customSelectorMetadata !== undefined
        ? selectors.customSelectorMetadata
        : (existing.custom_selector_metadata_json ? JSON.parse(existing.custom_selector_metadata_json) : {}))
    : (selectors.customSelectorMetadata ?? {});
  // runtime: undefined = preserve existing; explicit value = replace
  const runSel = existing
    ? (selectors.runtime ?? (existing.runtime as 'static' | 'rendered' | null) ?? 'rendered')
    : (selectors.runtime ?? 'rendered');

  if (existing) {
    db.query(`
      UPDATE extractor_profiles
      SET title_selector = ?, title_optional_selectors_json = ?, price_selector = ?, description_selector = ?, brand_selector = ?, images_selector = ?, custom_selectors_json = ?, sitemap_product_url_pattern = ?, shopify_json_path = ?, variant_selection_strategy_json = ?, custom_selector_metadata_json = ?, runtime = ?, updated_at = ?
      WHERE domain = ?
    `).run(tSel, JSON.stringify(toSel), pSel, dSel, bSel, iSel, JSON.stringify(cSel), sSel, shopifyJSONPath ? 1 : 0, vsSel ? JSON.stringify(vsSel) : null, JSON.stringify(csmSel), runSel, now, normalizedDomain);

    return mapToProfile({
      ...existing,
      title_selector: tSel,
      title_optional_selectors_json: JSON.stringify(toSel),
      price_selector: pSel,
      description_selector: dSel,
      brand_selector: bSel,
      images_selector: iSel,
      custom_selectors_json: JSON.stringify(cSel),
      sitemap_product_url_pattern: sSel,
      shopify_json_path: shopifyJSONPath ? 1 : 0,
      variant_selection_strategy_json: vsSel ? JSON.stringify(vsSel) : null,
      custom_selector_metadata_json: JSON.stringify(csmSel),
      runtime: runSel,
      updated_at: now,
    });
  }

  const id = randomUUID();
  db.query(`
    INSERT INTO extractor_profiles (id, domain, title_selector, title_optional_selectors_json, price_selector, description_selector, brand_selector, images_selector, custom_selectors_json, sitemap_product_url_pattern, shopify_json_path, variant_selection_strategy_json, custom_selector_metadata_json, runtime, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, normalizedDomain, tSel, JSON.stringify(toSel), pSel, dSel, bSel, iSel, JSON.stringify(cSel), sSel, shopifyJSONPath ? 1 : 0, vsSel ? JSON.stringify(vsSel) : null, JSON.stringify(csmSel), runSel, now, now);

  return {
    id,
    domain: normalizedDomain,
    titleSelector: tSel,
    titleOptionalSelectors: toSel,
    priceSelector: pSel,
    descriptionSelector: dSel,
    brandSelector: bSel,
    imagesSelector: iSel,
    customSelectors: cSel,
    sitemapProductUrlPattern: sSel,
    shopifyJSONPath,
    variantSelectionStrategy: vsSel,
    customSelectorMetadata: csmSel,
    runtime: runSel as 'static' | 'rendered',
    createdAt: now,
    updatedAt: now,
  };
}

export function deleteProfile(id: string): boolean {
  const db = getDb();
  const result = db.query('DELETE FROM extractor_profiles WHERE id = ?').run(id);
  return result.changes > 0;
}

export function deleteProfileByDomain(domain: string): boolean {
  const db = getDb();
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '').trim();
  const result = db.query('DELETE FROM extractor_profiles WHERE domain = ?').run(normalizedDomain);
  return result.changes > 0;
}
