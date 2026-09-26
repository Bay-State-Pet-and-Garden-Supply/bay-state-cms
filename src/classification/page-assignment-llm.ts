/**
 * Category Page Assignment Domain Rules
 *
 * Provides deterministic helpers for page hierarchy construction, structured
 * product context extraction from evidence, response validation, and cross-species
 * page normalization.
 *
 * @module page-assignment-llm
 */

import { type ClassificationEvidence, type ClassificationProposal, CanonicalBrandEvidenceValueSchema } from '../shared/schemas/classification';
import type { PageSnapshotRecord } from './runtime-snapshot';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProductOcrSummary {
  species: string[];
  flavor: string | null;
  lifeStage: string | null;
  productForm: string | null;
  healthConcern: string[];
  productName: string | null;
  brand: string | null;
}

export interface PageAssignmentResult {
  pages: Array<{ pageId: string; pageName: string; confidence: number; isBrandShortcut?: boolean }>;
  modelCallIds?: string[];
}

// ─── Page Hierarchy Builder ──────────────────────────────────────────────────

/**
 * Build a page hierarchy array from flattened options PURELY over frozen
 * verified Page snapshot records (issue #17 D1). No DB or workspace reads:
 * the records are the immutable snapshot captured before run creation.
 *
 * Duplicate display names remain distinct because identity is the local page
 * row ID; parent metadata comes from the frozen records and is never looked
 * up from mutable store state during a stage.
 */
export function buildPageHierarchy(
  options: Array<{ value: string; label: string }>,
  records: ReadonlyArray<PageSnapshotRecord> = [],
): Array<{ id: string; name: string; parentName: string | null }> {
  const pageMap = new Map(records.map(p => [p.pageId, p]));

  return options.map(opt => {
    const page = pageMap.get(opt.value);
    const parentName = page?.parentPageId
      ? (pageMap.get(page.parentPageId)?.pageName ?? null)
      : null;
    return {
      id: opt.value,
      name: opt.label,
      parentName,
    };
  });
}

// ─── Product Context Extractor ───────────────────────────────────────────────

/**
 * Extract structured product context from classification evidence and proposals.
 *
 * Assembles the best available product name, description, VLM OCR summary,
 * and upstream product type — all used by `llmAssignCategoryPages()` to build
 * a rich prompt.
 *
 * Brand resolution priority (highest first):
 *   1. resolved_brand evidence (value.brandName from brands.json)
 *   2. Official product page brand evidence
 *   3. Highest-confidence distributor (third_party_page) brand evidence
 *   4. Spreadsheet brand hint evidence
 *   5. Visual OCR brand evidence
 */
export function extractProductContext(
  evidence: ClassificationEvidence[],
  allProposals: ClassificationProposal[],
): {
  productName: string;
  productDescription: string;
  ocrSummary: ProductOcrSummary;
  productType: string | null;
} {
  // ── Safe value extraction helper ──────────────────────────────────────
  const safeString = (v: unknown): string | undefined => {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    if (v != null) return String(v).trim();
    return undefined;
  };

  // ── Product name: prefer expected_name → official page name/title →
  //    highest-confidence distributor name/title → OCR name → spreadsheet name
  const expectedName = safeString(evidence.find(
    e => e.source === 'spreadsheet' && e.sourceField === 'expected_name',
  )?.value);
  const webName = safeString(evidence.find(
    e => e.source === 'official_product_page' && e.sourceField === 'name',
  )?.value);
  const webTitle = safeString(evidence.find(
    e => e.source === 'official_product_page' && e.sourceField === 'title',
  )?.value);
  const officialName = webName ?? webTitle;

  // Best distributor name/title (confidence-ordered, per-attempt preferred)
  const distNameEvidence = evidence
    .filter(e => e.source === 'third_party_page' && (e.sourceField === 'name' || e.sourceField === 'title'))
    .sort((a, b) => {
      const ca = typeof a.metadata?.confidence === 'number' ? a.metadata.confidence : 0.5;
      const cb = typeof b.metadata?.confidence === 'number' ? b.metadata.confidence : 0.5;
      if (cb !== ca) return cb - ca;
      // Prefer per-attempt over flattened
      const hasA = a.metadata?.attemptId ? 1 : 0;
      const hasB = b.metadata?.attemptId ? 1 : 0;
      return hasB - hasA;
    });
  const distName = safeString(distNameEvidence[0]?.value);

  const ocrName = safeString(evidence.find(
    e => e.source === 'visual_product_evidence' && e.sourceField === 'name',
  )?.value);
  const spreadsheetName = safeString(evidence.find(
    e => e.source === 'spreadsheet' && e.sourceField === 'name',
  )?.value);

  const productName = expectedName ?? officialName ?? distName ?? ocrName ?? spreadsheetName ?? 'Unknown Product';

  // ── Product description ──────────────────────────────────────────────────
  // Allocate 2,000 characters fairly across official + distributor sources.
  // Official copy comes first, then each distinct distributor description
  // labelled with provider provenance.
  const MAX_DESC_CHARS = 2000;
  const descParts: string[] = [];

  const officialDesc = safeString(evidence.find(
    e => e.source === 'official_product_page' && e.sourceField === 'description',
  )?.value);
  if (officialDesc) {
    descParts.push(officialDesc);
  }

  // Collect distinct distributor descriptions, ordered by confidence/provider
  const seenDistDescs = new Set<string>();
  const distDescs = evidence
    .filter(e => e.source === 'third_party_page' && (e.sourceField === 'description'))
    .sort((a, b) => {
      const ca = typeof a.metadata?.confidence === 'number' ? a.metadata.confidence : 0.5;
      const cb = typeof b.metadata?.confidence === 'number' ? b.metadata.confidence : 0.5;
      return cb - ca;
    });

  for (const de of distDescs) {
    const val = safeString(de.value);
    if (!val) continue;
    const normalized = val.toLowerCase();
    // Skip duplicates (same text from multiple rows)
    if (seenDistDescs.has(normalized)) continue;
    seenDistDescs.add(normalized);
    const provider = de.metadata?.providerId as string | undefined;
    descParts.push(provider ? `[${provider}] ${val}` : val);
  }

  // Fair allocation: each part gets an equal share of the budget
  const perPartBudget = descParts.length > 0
    ? Math.floor(MAX_DESC_CHARS / descParts.length)
    : MAX_DESC_CHARS;
  const productDescription = descParts
    .map(p => p.slice(0, perPartBudget))
    .join('\n')
    .slice(0, MAX_DESC_CHARS);

  // ── OCR summary from visual_product_evidence ─────────────────────────────
  const visualEvidence = evidence.filter(e => e.source === 'visual_product_evidence');

  const getFirst = (field: string): string | null => {
    const entry = visualEvidence.find(e => e.sourceField === field);
    if (!entry) return null;
    return safeString(entry.value) ?? null;
  };

  const getAll = (field: string): string[] => {
    return visualEvidence
      .filter(e => e.sourceField === field)
      .map(e => safeString(e.value))
      .filter((v): v is string => !!v);
  };

  // ── Brand resolution (priority order) ────────────────────────────────────
  let resolvedBrand: string | null = null;

  // 1. resolved_brand evidence (canonical brand from brands.json)
  const resolvedBrandEvidence = evidence.find(
    e => e.source === 'catalog_manager_guidance' && e.sourceField === 'resolved_brand',
  );
  if (resolvedBrandEvidence) {
    const parsed = CanonicalBrandEvidenceValueSchema.safeParse(resolvedBrandEvidence.value);
    const bName = parsed.success ? parsed.data.brandName : ((resolvedBrandEvidence.value as any)?.brandName ?? (resolvedBrandEvidence.value as any)?.name);
    if (bName) {
      resolvedBrand = bName;
    }
  }

  // 2. Official product page brand
  if (!resolvedBrand) {
    resolvedBrand = safeString(evidence.find(
      e => e.source === 'official_product_page' && e.sourceField === 'brand',
    )?.value) ?? null;
  }

  // 3. Highest-confidence distributor brand
  if (!resolvedBrand) {
    const distBrand = evidence
      .filter(e => e.source === 'third_party_page' && e.sourceField === 'brand')
      .sort((a, b) => {
        const ca = typeof a.metadata?.confidence === 'number' ? a.metadata.confidence : 0.5;
        const cb = typeof b.metadata?.confidence === 'number' ? b.metadata.confidence : 0.5;
        return cb - ca;
      });
    resolvedBrand = safeString(distBrand[0]?.value) ?? null;
  }

  // 4. Spreadsheet brand hint
  if (!resolvedBrand) {
    resolvedBrand = safeString(evidence.find(
      e => e.source === 'spreadsheet' && e.sourceField === 'brand',
    )?.value) ?? null;
  }

  // 5. Visual OCR brand
  if (!resolvedBrand) {
    resolvedBrand = getFirst('brand');
  }

  const ocrSummary: ProductOcrSummary = {
    species: getAll('species'),
    flavor: getFirst('flavor'),
    lifeStage: getFirst('lifeStage'),
    productForm: getFirst('productForm'),
    healthConcern: getAll('healthConcern'),
    productName: getFirst('name'),
    brand: resolvedBrand,
  };

  // ── Product type from upstream proposals ─────────────────────────────────
  const typeProposal = allProposals.find(
    p => p.proposalType === 'primary_product_type',
  );
  const productType = typeProposal?.targetId ?? null;

  return { productName, productDescription, ocrSummary, productType };
}

// ─── Response Validator ───────────────────────────────────────────────────────

/**
 * Validate parsed LLM response entries against the known page list.
 *
 * Two modes:
 * 1. ID-bearing: entry has `pageId` that exists in `idToPage` — name is optional
 *    but if present it must match case-insensitively.
 * 2. Name-only (backward compat): entry has only `pageName` — must resolve to
 *    exactly ONE unique page name (case-insensitive). Ambiguous duplicate names
 *    are discarded.
 *
 * Returns validated entries with pageId and pageName resolved.
 */
export function validatePageResponseEntries(
  entries: unknown[],
  nameToPage: Map<string, { id: string; name: string }>,
  idToPage: Map<string, { id: string; name: string }>,
): Array<{ pageId: string; pageName: string; confidence: number }> {
  const valid: Array<{ pageId: string; pageName: string; confidence: number }> = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;

    const raw = entry as Record<string, unknown>;
    const pageIdRaw = raw.pageId;
    const pageNameRaw = raw.pageName;
    const confidenceRaw = raw.confidence;

    const confidence =
      typeof confidenceRaw === 'number'
        ? Math.max(0.35, Math.min(0.95, confidenceRaw))
        : 0.55;

    // Mode 1: ID-bearing
    if (typeof pageIdRaw === 'string' && pageIdRaw.length > 0) {
      const known = idToPage.get(pageIdRaw);
      if (!known) continue; // Unknown ID — discard

      // If name is also provided, it must match (case-insensitive)
      if (typeof pageNameRaw === 'string' && pageNameRaw.length > 0) {
        if (pageNameRaw.toLowerCase() !== known.name.toLowerCase()) continue; // Mismatch — discard
      }

      valid.push({ pageId: known.id, pageName: known.name, confidence });
      continue;
    }

    // Mode 2: Name-only (backward compat)
    if (typeof pageNameRaw === 'string' && pageNameRaw.length > 0) {
      // Resolve case-insensitively — must be EXACTLY one matching page.
      // Compare values rather than Map keys because duplicate display names
      // are stored under synthetic keys to preserve their ambiguity.
      const matches = [...nameToPage.values()].filter(
        info => info.name.toLowerCase() === pageNameRaw.toLowerCase(),
      );

      if (matches.length === 1) {
        const info = matches[0];
        valid.push({ pageId: info.id, pageName: info.name, confidence });
      }
      // Ambiguous (0 or 2+) — discard silently
    }
  }

  return valid;
}

// ─── Page Assignment Normalizer ───────────────────────────────────────────────

/**
 * Normalize a list of validated page assignments with deterministic rules.
 *
 * Rules applied in order:
 * 1. Deduplicate by page ID (first occurrence wins)
 * 2. If any specific (non-"Shop All") category is present, remove generic
 *    pages whose name ends with "Shop All" (case-insensitive).
 * 3. In multiple-selection mode, if an exact configured brand page named
 *    "Brand - <resolvedBrand>" exists (case-insensitive), include it
 *    deterministically without exceeding maxResults. Drop a Shop All first
 *    if present; otherwise use one slot for the brand page.
 * 4. Cross-species safety: if the product context includes species evidence
 *    for a specific non-empty species, remove pages whose name contains
 *    a conflicting species term (e.g. "Cat Food" for a dog product).
 * 5. Clamp output to maxResults.
 *
 * @param pages - Validated page entries (validated against known page list)
 * @param pageIndex - Map of page name → { id, name } for all known pages
 * @param resolvedBrand - The resolved brand name (from extractProductContext)
 * @param species   - Species evidence strings from OCR/evidence
 * @param maxResults - Maximum number of pages to return
 * @returns Normalized page assignment results
 */
export function normalizePageAssignments(
  pages: Array<{ pageId: string; pageName: string; confidence: number; isBrandShortcut?: boolean }>,
  pageIndex: Map<string, { id: string; name: string }>,
  resolvedBrand: string | null,
  species: string[],
  maxResults: number,
  selectionMode: 'single' | 'multiple' = 'multiple',
): Array<{ pageId: string; pageName: string; confidence: number; isBrandShortcut?: boolean }> {
  if (pages.length === 0) return [];

  let result = [...pages];

  // 1. Deduplicate by page ID (first occurrence wins)
  const seenIds = new Set<string>();
  result = result.filter(p => {
    if (seenIds.has(p.pageId)) return false;
    seenIds.add(p.pageId);
    return true;
  });

  if (result.length === 0) return [];

  // 2. If any specific category exists, remove "Shop All" pages.
  // A brand landing page alone is not a more-specific category.
  const hasSpecificPage = result.some(p => {
    const name = p.pageName.toLowerCase();
    return !name.endsWith('shop all') && !name.startsWith('brand -');
  });
  if (hasSpecificPage) {
    result = result.filter(p => p.pageName.toLowerCase().endsWith('shop all') === false);
  }

  // 3. Include exact brand page only when multiple selections are allowed.
  if (selectionMode === 'multiple' && resolvedBrand) {
    const brandPageName = `Brand - ${resolvedBrand}`;
    // Check if this brand page exists in the page index
    let brandPageInfo: { id: string; name: string } | null = null;
    for (const [, info] of pageIndex) {
      if (info.name.toLowerCase() === brandPageName.toLowerCase()) {
        brandPageInfo = info;
        break;
      }
    }

    if (brandPageInfo) {
      // Only add if not already present
      const alreadyPresent = result.some(
        p => p.pageId === brandPageInfo!.id,
      );
      if (!alreadyPresent) {
        // Reserve one slot for the exact brand page. Shop All pages are
        // discarded first; otherwise drop the lowest-ranked trailing result.
        if (result.length >= maxResults && maxResults > 0) {
          const shopAllIdx = result.findIndex(
            p => p.pageName.toLowerCase().endsWith('shop all'),
          );
          if (shopAllIdx !== -1) result.splice(shopAllIdx, 1);
          if (result.length >= maxResults) {
            result = result.slice(0, Math.max(0, maxResults - 1));
          }
        }

        if (maxResults > 0) {
          result.push({
            pageId: brandPageInfo.id,
            pageName: brandPageInfo.name,
            confidence: 0.95,
            isBrandShortcut: true,
          });
        }
      }
    }
  }

  // 4. Cross-species safety
  // Determine the primary species from evidence
  const speciesLower = species.map(s => s.toLowerCase());
  const hasDog = speciesLower.some(s => s.includes('dog') || s.includes('canine'));
  const hasCat = speciesLower.some(s => s.includes('cat') || s.includes('feline'));
  const hasFish = speciesLower.some(s => s.includes('fish') || s.includes('aquatic'));
  const hasBird = speciesLower.some(s => s.includes('bird') || s.includes('avian'));
  const hasHorse = speciesLower.some(s => s.includes('horse') || s.includes('equine'));
  const hasPoultry = speciesLower.some(s => s.includes('poultry') || s.includes('chicken') || s.includes('fowl'));
  const hasLivestock = speciesLower.some(s => s.includes('livestock') || s.includes('cattle') || s.includes('swine') || s.includes('goat') || s.includes('sheep'));

  if (hasDog && !hasCat) {
    result = result.filter(p => {
      const name = p.pageName.toLowerCase();
      // Keep if the page explicitly mentions dog
      if (/\bdog\b/.test(name)) return true;
      if (/\bcat\b/.test(name)) return false;
      if (/\bfish\b/.test(name)) return false;
      if (/\bbird\b/.test(name)) return false;
      if (/\bsmall animal\b/.test(name)) return false;
      if (/\breptile\b/.test(name)) return false;
      if (/\b(horse|equine)\b/.test(name)) return false;
      if (/\b(poultry|chicken feed|chicken coop)\b/.test(name)) return false;
      if (/\blivestock\b/.test(name)) return false;
      return true;
    });
  } else if (hasCat && !hasDog) {
    result = result.filter(p => {
      const name = p.pageName.toLowerCase();
      if (/\bcat\b/.test(name)) return true;
      if (/\bdog\b/.test(name)) return false;
      if (/\bfish\b/.test(name)) return false;
      if (/\bbird\b/.test(name)) return false;
      if (/\bsmall animal\b/.test(name)) return false;
      if (/\breptile\b/.test(name)) return false;
      if (/\b(horse|equine)\b/.test(name)) return false;
      if (/\b(poultry|chicken feed|chicken coop)\b/.test(name)) return false;
      if (/\blivestock\b/.test(name)) return false;
      return true;
    });
  } else if (hasHorse && !hasDog && !hasCat) {
    result = result.filter(p => {
      const name = p.pageName.toLowerCase();
      if (/\b(horse|equine)\b/.test(name)) return true;
      if (/\bdog\b/.test(name)) return false;
      if (/\bcat\b/.test(name)) return false;
      if (/\bfish\b/.test(name)) return false;
      if (/\bbird\b/.test(name)) return false;
      if (/\bsmall animal\b/.test(name)) return false;
      if (/\breptile\b/.test(name)) return false;
      return true;
    });
  } else if (hasPoultry && !hasDog && !hasCat) {
    result = result.filter(p => {
      const name = p.pageName.toLowerCase();
      if (/\b(poultry|chicken feed|chicken coop)\b/.test(name)) return true;
      if (/\bdog\b/.test(name)) return false;
      if (/\bcat\b/.test(name)) return false;
      if (/\bfish\b/.test(name)) return false;
      if (/\b(horse|equine)\b/.test(name)) return false;
      if (/\bsmall animal\b/.test(name)) return false;
      if (/\breptile\b/.test(name)) return false;
      return true;
    });
  } else if (hasLivestock && !hasDog && !hasCat) {
    result = result.filter(p => {
      const name = p.pageName.toLowerCase();
      if (/\blivestock\b/.test(name)) return true;
      if (/\bdog\b/.test(name)) return false;
      if (/\bcat\b/.test(name)) return false;
      if (/\bfish\b/.test(name)) return false;
      if (/\bbird\b/.test(name)) return false;
      if (/\bsmall animal\b/.test(name)) return false;
      if (/\breptile\b/.test(name)) return false;
      return true;
    });
  } else if (hasFish && !hasDog && !hasCat) {
    result = result.filter(p => {
      const name = p.pageName.toLowerCase();
      if (/\bfish\b/.test(name)) return true;
      if (/\bdog\b/.test(name)) return false;
      if (/\bcat\b/.test(name)) return false;
      if (/\bbird\b/.test(name)) return false;
      if (/\bsmall animal\b/.test(name)) return false;
      if (/\breptile\b/.test(name)) return false;
      if (/\b(horse|equine)\b/.test(name)) return false;
      if (/\b(poultry|chicken feed|chicken coop)\b/.test(name)) return false;
      if (/\blivestock\b/.test(name)) return false;
      return true;
    });
  } else if (hasBird && !hasDog && !hasCat) {
    result = result.filter(p => {
      const name = p.pageName.toLowerCase();
      if (/\bbird\b/.test(name)) return true;
      if (/\bdog\b/.test(name)) return false;
      if (/\bcat\b/.test(name)) return false;
      if (/\bfish\b/.test(name)) return false;
      if (/\bsmall animal\b/.test(name)) return false;
      if (/\breptile\b/.test(name)) return false;
      if (/\b(horse|equine)\b/.test(name)) return false;
      if (/\blivestock\b/.test(name)) return false;
      return true;
    });
  }

  // 5. Clamp to maxResults
  if (result.length > maxResults) {
    result = result.slice(0, maxResults);
  }

  return result;
}


