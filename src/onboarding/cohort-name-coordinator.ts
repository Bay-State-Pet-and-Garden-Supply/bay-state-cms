/**
 * Cohort Name Coordinator
 *
 * Pre-pipeline coordination pass that groups curation items by product
 * line and makes ONE LLM call per group to produce consistent variant
 * names across all siblings.
 *
 * Exports:
 * - coordinateCohortItemsOnce(batchId, items) — cached per-fingerprint
 * - clearCohortCoordinationCache() — for tests
 *
 * For each multi-item group the result is ALL-OR-NOTHING: either every
 * sibling gets an LLM-coordinated title (source: 'llm_cohort') or every
 * sibling gets a deterministic fallback (source: 'cohort_fallback').
 * Singletons are never coordinated and return absent.
 */
import { getLlmConfigForTask, callLlmForTask, callLlmForTaskWithProvenance } from './llm-client';
import { redactTransportText } from '../classification/model-policy-gateway';
import { familyGroupingIdentityFor, knownBrandsForBatch } from './product-line-grouper';
import { buildCohortPrompt, FORMAT_RULES, ensureBrandInTitle, ensureVariantTokensInTitle, ensureColorInTitle, knownColorsAcross, resolveOwnColor, extractColorWords } from './title-prompt-template';
import type { CohortExecutionTypeContext } from './title-prompt-template';
import { normalizeTitleAuthorityString, TITLE_AUTHORITY_TRUNCATION } from './cohort-title-hash';
import { HeartbeatLostError } from '../classification/heartbeat-errors';
import { validateFamilyTitleSet } from '../classification/family-title-consistency';
import type { TitleFrozenFacts } from '../classification/family-title-consistency';
import { lintTitleSet, DEFAULT_BRAND_CASE_MAP } from '../classification/title-lint';
import type { ModelCallContext } from '../classification/model-operation-registry';
import type { RuntimeClassificationSnapshot } from '../classification/runtime-snapshot';
import type { OnboardingItem } from '../shared/schemas/onboarding';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface CoordinatedTitle {
  /** The store-ready product title. */
  title: string;
  /** How the title was produced. */
  source: 'llm_cohort' | 'cohort_fallback';
}

/**
 * Additive audit/ownership options for the uncached cohort title call (PR6
 * C3, issue #30). Absent → today's non-audited, non-lease-scoped call — the
 * legacy per-item and shadow paths stay byte-identical.
 */
export interface CohortCoordinationOptions {
  /**
   * Durable model-call audit context (issue #17 work item E). When present
   * the group call is audited through `classification_model_calls` (started
   * → terminal on every path) and the returned callId is surfaced via
   * `onCoordinatedCallId` for durable output-row provenance.
   */
  modelCall?: ModelCallContext;
  /**
   * Immutable runtime snapshot the audited call is bound to. Plan
   * compatibility fails closed when the snapshot's frozen plan lacks the
   * operation.
   */
  snapshot?: RuntimeClassificationSnapshot | null;
  /**
   * Ownership assertion forwarded to the audited transport (lease-scoped
   * callers re-assert the cohort claim before every run-scoped audit write; a
   * rejected assertion throws `HeartbeatLostError`).
   */
  assertHeld?: () => void;
  /**
   * PR6 hardening B/C (issue #30 P1-3): the frozen Execution Product Type as
   * title context — the same authority the canonical title input hash
   * (T-hash) claims. Rendered ONLY when `includeTitleHashSignals` is true;
   * absent/null → no context line (legacy/shadow/no-opts callers stay
   * byte-identical).
   */
  executionTypeContext?: CohortExecutionTypeContext | null;
  /**
   * PR6: invoked with the audited model-call id and the member SKUs of the
   * group that produced it — the durable `model_call_id` provenance for
   * persisted output rows. Called once per GROUP call that returned a result
   * (multi-item groups only), so a two-group cohort surfaces two distinct
   * call ids and each output row can be persisted with ITS producing call.
   */
  onCoordinatedCallId?: (callId: string, skus: string[]) => void;
  /**
   * PR6 hardening C (issue #30 P1-3): explicit opt-in to the T-hash-only
   * prompt signals — `webBrand`, `ocrWeight`, `ocrFlavor`, and the Execution
   * Product Type context. Set ONLY by `ensureCohortTitlesCoordinated` (the
   * active parent op). When absent/false the sibling mapping and prompt are
   * the EXACT pre-hardening shape (byte-identical legacy/shadow/no-opts
   * calls), even when the items carry OCR/web data.
   */
  includeTitleHashSignals?: boolean;
  /**
   * T1 authoritative: when set, the caller asserts that `items` are the frozen
   * cohort_members for this cohortId and must NOT be regrouped via
   * familyGroupingIdentityFor/extractNameStem. The coordinator treats the
   * entire `items` array as one authoritative family (T10 grouping boundary).
   */
  authoritativeCohortId?: string;
}

/** Stable fingerprint inputs for cache. Excludes volatile fields. */
interface FingerprintInput {
  id: string;
  upc: string;
  name: string;
  brandHint: string | null;
  expectedName: string | null;
  webTitle: string | null;
}

// ─── Cache ─────────────────────────────────────────────────────────────────────
// LEGACY/SHADOW ONLY — active cohort mode uses classification_cohort_outputs (ADR 0013 PR6/PR7). Do not use in cohortMode.
/* istanbul ignore next — legacy path */
const cohortCache = new Map<string, Promise<Map<string, CoordinatedTitle>>>();

function containsControlCharacters(value: string): boolean {
  return [...value].some(char => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function stripControlCharacters(value: string): string {
  return [...value]
    .filter(char => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('');
}

/**
 * Build a stable cache key from the batch ID and sorted fingerprints of every
 * item. Only title-significant fields participate; stage status, updatedAt,
 * curationData, and OCR fields do not change the key.
 */
function buildCacheKey(
  batchId: string,
  items: OnboardingItem[],
  modelPolicy?: import('../classification/model-policy-gateway').ModelPolicyView | null,
): string {
  const fingerprints: FingerprintInput[] = items.map(item => ({
    id: item.id,
    upc: item.upc,
    name: item.name ?? '',
    brandHint: item.brandHint ?? null,
    expectedName: item.expectedName ?? null,
    webTitle: item.extractionData?.title ?? null,
  }));
  fingerprints.sort((a, b) => a.id.localeCompare(b.id));

  const llmConfig = getLlmConfigForTask('product_curation', {
    allowFallback: true,
    modelPolicy,
    protectedOperation: 'cohort_title_consolidation',
  });
  const modelIdentity = llmConfig
    ? {
        provider: llmConfig.provider,
        model: llmConfig.model,
        policyDigest: modelPolicy?.policyDigest ?? null,
      }
    : null;
  return `${batchId}\u0000${JSON.stringify({ fingerprints, modelIdentity, formatRules: FORMAT_RULES })}`;
}

/**
 * Coordinate cohort names once per batch/fingerprint.
 *
 * Concurrent calls for the same batch with the same stable inputs share
 * one promise/LLM pass. The resolved map is reused until the stable
 * fingerprint changes (name, brandHint, expectedName, or web title).
 *
 * PR6 (issue #30): this cached path is the LEGACY / flag-OFF / shadow
 * authority ONLY. Active cohort mode never calls it — the parent title op
 * (`ensureCohortTitlesCoordinated`, PR6 C4) persists durable
 * `classification_cohort_outputs` WRITE-ONCE: at most one ACTIVE
 * coordination call at a time, ZERO FURTHER calls once the durable set
 * commits, and every pre-commit crash (between transport success and the
 * output-set commit) may cause another independently audited invocation —
 * the DB outputs are the authority there, never this in-memory
 * `cohortCache`.
 *
 * @param batchId - The onboarding batch ID.
 * @param items   - Items from the same batch.
 * @returns Map of UPC → CoordinatedTitle. Only multi-item groups appear.
 */
export function coordinateCohortItemsOnce(
  batchId: string,
  items: OnboardingItem[],
  modelPolicy?: import('../classification/model-policy-gateway').ModelPolicyView | null,
): Promise<Map<string, CoordinatedTitle>> {
  const key = buildCacheKey(batchId, items, modelPolicy);

  const existing = cohortCache.get(key);
  if (existing) return existing;

  // A changed stable fingerprint supersedes the prior cache entry for this
  // batch. Resolved promises remain cached so sequential workers reuse the
  // exact same cohort decision, not just concurrent callers.
  const batchPrefix = `${batchId}\u0000`;
  for (const cachedKey of cohortCache.keys()) {
    if (cachedKey.startsWith(batchPrefix) && cachedKey !== key) {
      cohortCache.delete(cachedKey);
    }
  }

  const promise = coordinateCohortItems(items, modelPolicy);
  cohortCache.set(key, promise);
  return promise;
}

/**
 * Clear the in-memory cache. Intended for tests.
 */
// fallow-ignore-next-line unused-export — used by tests
export function clearCohortCoordinationCache(): void {
  cohortCache.clear();
}

// ─── Deterministic Fallback Formatter ─────────────────────────────────────────

/**
 * Known abbreviation expansions for deterministic title cleaning.
 * Applied case-insensitively; the output uses the canonical form.
 * Includes distributor abbreviations (vnsn, hypo, frzn, vgg) so fallback
 * titles are consistent with LLM-coordinated titles.
 * Common subset chkn/ckn/slmn/trky/vnsn/frzn/vgg must stay in sync with
 * product-line-token-normalizer.ts EXPAND_ABBREVIATIONS; coordinator adds
 * hypo/hypoallergenic formatter-only.
 */
const ABBREVIATIONS: Record<string, string> = {
  sm: 'Small',
  md: 'Medium',
  lg: 'Large',
  xl: 'X-Large',
  xxl: 'XX-Large',
  xs: 'X-Small',
  chkn: 'Chicken',
  ckn: 'Chicken',
  slmn: 'Salmon',
  trky: 'Turkey',
  dntl: 'Dental',
  vnsn: 'Venison',
  hypo: 'Hypoallergenic',
  hypoallergenic: 'Hypoallergenic',
  frzn: 'Frozen',
  vgg: 'Veggie',
};

/** Units to normalize after title casing. */
const UNIT_PATTERNS: Array<[RegExp, string]> = [
  [/\b(\d+(?:\.\d+)?)\s*oz\b/gi, '$1 oz'],
  [/\b(\d+(?:\.\d+)?)\s*lb\b/gi, '$1 lb'],
  [/\b(\d+(?:\.\d+)?)\s*kg\b/gi, '$1 kg'],
  [/\b(\d+(?:\.\d+)?)\s*g\b/gi, '$1 g'],
  [/\b(\d+(?:\.\d+)?)\s*ml\b/gi, '$1 mL'],
  [/\b(\d+)\s*ct\b/gi, '$1-Count'],
  [/\b(\d+)\s*pk\b/gi, '$1-Pack'],
];

/**
 * Deterministically produce a store-ready title from a spreadsheet name.
 *
 * Handles: SM/MD/LG/XL expansion, CHKN/CKN/SLMN/TRKY/DNTL/VNSN/HYPO/FRZN/VGG
 * expansion, OZ/LB/CT/PK normalization, parenthesis removal (content preserved),
 * brand prefixing, whitespace normalization, title casing.
 */
export function formatDeterministicTitle(
  spreadsheetName: string,
  brandHint: string | null,
): string {
  let t = spreadsheetName.trim();

  // 0. Pre-process attached abbreviation+unit patterns (e.g. SM5CT, MD2CT,
  // LG30PK, SM6PK). Convert to the canonical expanded form immediately.
  t = t.replace(
    /(SM|MD|LG|XL|XS|XXL)(\d+(?:\.\d+)?)(PK|CT|OZ|LB|G|KG|ML|GAL)/gi,
    (_match, prefix, digits, unit) => {
      const abbrMap: Record<string, string> = {
        SM: 'Small', MD: 'Medium', LG: 'Large', XL: 'X-Large', XS: 'X-Small', XXL: 'XX-Large',
      };
      const unitMap: Record<string, string> = {
        PK: '-Pack', CT: '-Count', OZ: ' oz', LB: ' lb', G: ' g', KG: ' kg', ML: ' mL', GAL: ' gal',
      };
      return `${abbrMap[prefix.toUpperCase()] || prefix} ${digits}${unitMap[unit.toUpperCase()] || ` ${unit}`}`;
    },
  );

  // 1. Remove parentheses delimiters but keep inner text
  t = t.replace(/\(([^)]*)\)/g, '$1');

  // 2. Expand known abbreviations (case-insensitive, word-boundary)
  for (const [abbr, expanded] of Object.entries(ABBREVIATIONS)) {
    const re = new RegExp(`\\b${abbr}\\b`, 'gi');
    t = t.replace(re, expanded);
  }

  // 3. Remove non-printable/control characters and normalize whitespace.
  t = stripControlCharacters(t).replace(/\s+/g, ' ').trim();

  // 4. Apply deterministic title casing. Unit/count formatting is restored
  // afterwards so hyphenated quantity suffixes keep their canonical case.
  t = t
    .toLowerCase()
    .replace(/\b([a-z])/g, letter => letter.toUpperCase());

  // 5. Normalize attached and separated unit/count tokens, including decimals.
  for (const [pattern, replacement] of UNIT_PATTERNS) {
    t = t.replace(pattern, replacement);
  }
  t = t.replace(/\s+/g, ' ').trim();

  // 6. Deterministic brand guarantee (issue #108, design B): the resolved
  // brand appears exactly once — prefixed when absent, casing-restored when
  // present. Shared with the LLM-path authorship post-step so deterministic
  // and coordinated titles obey one rule.
  if (brandHint?.trim()) {
    return ensureBrandInTitle(t, brandHint);
  }

  return t;
}

// ─── Core Coordination Logic ──────────────────────────────────────────────────

/**
 * Variant sources for one cohort member (issue #111): spreadsheet names,
 * official/distributor titles, structured weight, distributor variant
 * attributes (size/capacity/count), structured OCR measurements, distributor
 * reference names, and case pack / unit of measure. The authorship
 * guarantee restores from this merged set — never invents. Manual evidence
 * has no item-level counterpart, so manual-only sizes stay member-side and
 * the member holds (missing_size) rather than throwing parent-defect.
 */
// fallow-ignore-next-line unused-export — used by product-curator member fallbacks
export function itemVariantSources(item: OnboardingItem): Array<string | null | undefined> {
  const ext = item.extractionData as {
    title?: string | null;
    weight?: string | null;
    variantAttributes?: Record<string, string> | null;
    packagingTitle?: string | null;
    packagingOcrData?: { productName?: string | null; weight?: string | null; size?: string | null; count?: string | null; color?: string | null } | null;
    distributorReferenceValues?: Record<string, string[]> | null;
    casePack?: string | null;
    unitOfMeasure?: string | null;
  } | null | undefined;
  return [
    item.name,
    item.expectedName,
    ext?.title,
    ext?.weight,
    ...(ext?.variantAttributes ? Object.values(ext.variantAttributes) : []),
    ext?.packagingTitle,
    ext?.packagingOcrData?.productName,
    ext?.packagingOcrData?.weight,
    ext?.packagingOcrData?.size,
    ext?.packagingOcrData?.count,
    ext?.packagingOcrData?.color,
    ...(ext?.distributorReferenceValues ? Object.values(ext.distributorReferenceValues).flat() : []),
    ext?.casePack,
    ext?.unitOfMeasure,
  ];
}

/**
 * Author-visible color channels for one cohort member (issue #112):
 * distributor color attribute (key-aware — the producer classified it),
 * packaging OCR color, and color words in the member's own title texts.
 * Manual titles and distributor per-attempt rows have no item-level
 * counterpart and stay member-side.
 */
function itemColorChannels(item: OnboardingItem): { structured: string[]; texts: Array<string | null | undefined> } {
  const ext = item.extractionData as {
    title?: string | null;
    variantAttributes?: Record<string, string> | null;
    packagingOcrData?: { color?: string | null } | null;
  } | null | undefined;
  const structured: string[] = [];
  if (ext?.variantAttributes) {
    for (const [key, value] of Object.entries(ext.variantAttributes)) {
      if (key.toLowerCase() === 'color' && value?.trim()) structured.push(value.trim());
    }
  }
  const ocrColor = ext?.packagingOcrData?.color?.trim();
  if (ocrColor) structured.push(ocrColor);
  return { structured, texts: [item.name, item.expectedName, ext?.title] };
}

/**
 * The item's own color under authorship authority (issue #112): first
 * structured color, else the first color word in its own title texts.
 */
// fallow-ignore-next-line unused-export — used by tests
export function itemOwnColor(item: OnboardingItem): string | null {
  const { structured, texts } = itemColorChannels(item);
  return resolveOwnColor(structured, texts);
}

/**
 * Family color set across cohort members (issue #112): union of
 * structured colors and title-text color words. Two or more distinct
 * colors marks a multi-color family whose members each carry their own.
 */
// fallow-ignore-next-line unused-export — used by tests
export function familyColorsForGroup(items: OnboardingItem[]): string[] {
  const structured: string[] = [];
  const texts: Array<string | null | undefined> = [];
  for (const item of items) {
    const channels = itemColorChannels(item);
    structured.push(...channels.structured);
    texts.push(...channels.texts);
  }
  return knownColorsAcross([...structured, ...texts]);
}

/**
 * Deterministic fallback title with the variant guarantee applied
 * (issue #111): the spreadsheet-derived title plus any evidenced variant
 * tokens missing from it, so fallback sets obey the same rule as
 * LLM-coordinated sets. Unknown sizes leave the title unchanged — the
 * member holds later via missing_size abstention.
 *
 * NOTE (issue #111 follow-up): contradictory evidence is appended, not
 * adjudicated — e.g. an OCR weight disagreeing with the name-embedded
 * size lands in the title verbatim. A family mixing such titles fails T7
 * family validation, which cascades past title-lint for the whole family.
 * Conflict handling (evidence-conflict routing for contradictory variant
 * values) is intentionally out of scope here; fixture OCR weights must
 * therefore stay consistent with each item's own size.
 */
// fallow-ignore-next-line unused-export — used by product-curator member fallbacks
export function deterministicTitleWithVariants(
  spreadsheetName: string | null | undefined,
  upc: string,
  brandHint: string | null | undefined,
  variantSources: Array<string | null | undefined>,
): string {
  return ensureVariantTokensInTitle(
    formatDeterministicTitle(spreadsheetName ?? upc, brandHint ?? null),
    variantSources,
  );
}

/**
 * Canonicalize an abbreviation flavor token to its rendered form.
 */
function canonicalFlavorToken(token: string): string {
  return token.replace(/vnsn/, 'venison').replace(/chkn|ckn/, 'chicken').replace(/slmn/, 'salmon').replace(/trky/, 'turkey').replace(/vgg/, 'veggie');
}

const FLAVOR_TOKEN_RE = /\b(beef|venison|vnsn|chicken|chkn|ckn|salmon|slmn|turkey|trky|veggie|vgg|duck|lamb|pork|bison|fish|tuna)\b/g;

/**
 * Derive minimal frozenFacts for pure family-title validation (B1 T4/T5).
 * Heuristic: modifiers/flavor/size inferred from the spreadsheet name so the
 * validator can enforce always-visible + no-leakage without DB access.
 * T10: never calls extractNameStem / grouping — local regex only.
 *
 * Round-3 slot unification: ALL distinct flavor words normalize into the
 * {flavor} slot (first match = flavorOrColorOrSubline, remaining matches are
 * emitted as extraFlavorTokens rather than silently dropped); a weight and a
 * size word occupying the same title BOTH normalize into the single adjudicated
 * Size/Weight/Count {size} slot (weight wins as primary, the size word is kept
 * as an extraSizeToken) so a family mixing "...Small" and "...5 lb" siblings
 * produces matching skeletons instead of hard-failing T7.
 */
// fallow-ignore-next-line unused-export — exported for direct slot-unification tests (round-3 FIX 2)
export function deriveFrozenFactsForValidation(item: OnboardingItem): TitleFrozenFacts {
  const raw = (item.name ?? '').toLowerCase();
  const brand = item.brandHint?.trim() ?? '';
  const productLine = brand;
  const modifiers = {
    soft: /\bsoft\b/.test(raw) || undefined,
    hard: /\bhard\b/.test(raw) || undefined,
    classic: /\bclassic\b/.test(raw) || undefined,
    hypoallergenic: /\b(hypoallergenic|hypo)\b/.test(raw) || undefined,
  };
  const flavorMatches = [...raw.matchAll(FLAVOR_TOKEN_RE)].map(match => canonicalFlavorToken(match[1]));
  // Dedupe while preserving order — repeated mentions of the SAME flavor are one
  // logical value; only DISTINCT flavors become extra slot tokens.
  const distinctFlavors = [...new Set(flavorMatches)];
  // Issue #112: color words share the {flavor} slot (flavorOrColorOrSubline)
  // so multi-color families ("... Red" vs "... Blue") skeleton-match
  // instead of hard-failing T7 — the slot was always named for both.
  // Lowercased to match the flavor pipeline's canonical forms; words
  // already covered by a flavor match are not duplicated. Structured
  // colors (distributor color attribute, OCR color) join the pool AFTER
  // name words: without them, attribute-only color families could never
  // coordinate — appended candidates would fail T2 against colorless
  // skeletons. T4 then requires each pooled color in its member's title,
  // which authorship guarantees before the gate runs.
  const extForColor = item.extractionData as {
    variantAttributes?: Record<string, string> | null;
    packagingOcrData?: { color?: string | null } | null;
  } | null | undefined;
  const structuredColorTexts: string[] = [];
  if (extForColor?.variantAttributes) {
    for (const [key, value] of Object.entries(extForColor.variantAttributes)) {
      if (key.toLowerCase() === 'color' && value?.trim()) structuredColorTexts.push(value);
    }
  }
  const extOcrColor = extForColor?.packagingOcrData?.color?.trim();
  if (extOcrColor) structuredColorTexts.push(extOcrColor);
  const colorMatches = [
    ...extractColorWords(raw),
    ...knownColorsAcross(structuredColorTexts),
  ].map(c => c.toLowerCase());
  const distinctColors = [...new Set(colorMatches)].filter(c => !distinctFlavors.includes(c));
  const slotCandidates = [...distinctFlavors, ...[...new Set(distinctColors)]];
  const flavorOrColorOrSubline = slotCandidates[0];
  const extraFlavorTokens = slotCandidates.length > 1 ? slotCandidates.slice(1) : undefined;
  const sizeMatch = raw.match(/\b(small|medium|large|x-?large|xx-?large|x-small|sm|md|lg|xl|xxl|xs)\b/);
  const sizeMap: Record<string,string> = { sm:'Small', md:'Medium', lg:'Large', xl:'X-Large', xxl:'XX-Large', xs:'X-Small' };
  // Weight/count slot (adjudicated Size/Weight/Count slot, plan §6.2): families legitimately
  // vary by packaged weight/count ("Chicken 5 lb" vs "Beef 10 lb") — without this extraction
  // the literal stays in the T2 skeleton and every weight-variant family hard-fails T7.
  // Token is emitted in the SAME rendered form formatDeterministicTitle produces
  // ("1 lb" spaced; "6 ct" → "6-count" per UNIT_PATTERNS) so deriveSkeleton's word-boundary
  // match aligns with candidate/fallback titles. Regex-only, idempotent.
  const weightMatch = raw.match(/\b(\d+(?:\.\d+)?)[ \t]*(lbs|lb|oz|kg|count|ct|pack)\b/);
  const sizeWord = sizeMatch ? (sizeMap[sizeMatch[1].toLowerCase()] ?? sizeMatch[1]) : undefined;
  // Explicit numbered sizes ("Sz 4", "Size 10", "sz. 6") carry NO weight unit,
  // so the weight regex above never sees them — the literal digit previously
  // stayed in the T2 skeleton and every numbered-size family hard-failed T7
  // ("shared skeleton mismatch: ... muzzle sz 4 | ... muzzle sz 5"). The FULL
  // match text is kept verbatim (whitespace-collapsed) so deriveSkeleton's
  // standalone-token rule matches the rendered candidate/fallback title exactly.
  const szNumMatch = raw.match(/\b(?:sizes?|sz)\.?[ \t]*(\d+(?:\.\d+)?)\b/);
  const szNumToken = szNumMatch ? szNumMatch[0].replace(/\s+/g, ' ').trim() : undefined;
  let sizeOrCount: string | undefined;
  let extraSizeTokens: string[] | undefined;
  if (weightMatch) {
    const num = weightMatch[1];
    const unit = weightMatch[2];
    sizeOrCount = unit === 'ct' ? `${num}-count` : unit === 'lbs' ? `${num} lb` : `${num} ${unit}`;
    // A weight must NOT displace a co-present size word — both occupy the SAME
    // {size} slot; the deriveSkeleton same-slot unification collapses them onto
    // one placeholder so mixed Small/weight members still skeleton-match.
    if (sizeWord && sizeWord.toLowerCase() !== sizeOrCount.toLowerCase()) {
      extraSizeTokens = [sizeWord];
    }
    if (szNumToken && szNumToken.toLowerCase() !== sizeOrCount.toLowerCase()
      && !(extraSizeTokens ?? []).some(t => t.toLowerCase() === szNumToken.toLowerCase())) {
      extraSizeTokens = [...(extraSizeTokens ?? []), szNumToken];
    }
  } else if (sizeWord && szNumToken) {
    // Co-present size word + numbered size both occupy the SAME {size} slot —
    // adjacent placeholders collapse in deriveSkeleton so mixed
    // "Small Sz 4"-style families still skeleton-match.
    sizeOrCount = sizeWord;
    if (sizeWord.toLowerCase() !== szNumToken.toLowerCase()) {
      extraSizeTokens = [szNumToken];
    }
  } else if (szNumToken) {
    sizeOrCount = szNumToken;
  } else if (sizeWord) {
    sizeOrCount = sizeWord;
  }
  return { brand, productLine, flavorOrColorOrSubline, extraFlavorTokens, sizeOrCount, extraSizeTokens, modifiers };
}

/**
 * Title-lint evidence strings for one member: every string leaf of the frozen
 * extraction payload (title, description, OCR fields...). Bounded walk so a
 * pathological payload cannot blow up the corpus.
 */
function extractionEvidenceStrings(item: OnboardingItem): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || out.length >= 60) return;
    if (typeof v === 'string') { if (v.trim()) out.push(v.slice(0, 500)); return; }
    if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
    if (v && typeof v === 'object') Object.values(v).forEach(x => walk(x, depth + 1));
  };
  if (item.extractionData && typeof item.extractionData === 'object') {
    walk(item.extractionData as unknown, 0);
  }
  return out;
}

/**
 * Brand casing map for the lint: census defaults, then canonical spellings
 * derived from the batch's own known-brand set for keys the defaults do not
 * already cover (defaults win so batch drift like "kong" cannot undo KONG).
 */
function brandCaseMapFor(items: OnboardingItem[]): Record<string, string> {
  const map: Record<string, string> = { ...DEFAULT_BRAND_CASE_MAP };
  for (const b of knownBrandsForBatch(items)) {
    const key = b.trim().toLowerCase();
    if (key && !(key in map)) map[key] = b.trim();
  }
  return map;
}

/**
 * Validate that the LLM response covers every expected UPC, contains no
 * duplicate titles (case/whitespace-insensitive), and has no structural issues.
 * Returns null on validation failure (caller must use fallback for the group).
 */
function validateCohortResponse(
  parsed: unknown,
  expectedUpcs: string[],
): Map<string, string> | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const entries = Object.entries(parsed as Record<string, unknown>);
  const expected = new Set(expectedUpcs);
  if (entries.length !== expected.size || entries.some(([upc]) => !expected.has(upc))) {
    return null;
  }

  const result = new Map<string, string>();
  const seenTitles = new Set<string>();
  for (const [upc, rawTitle] of entries) {
    if (typeof rawTitle !== 'string' || containsControlCharacters(rawTitle)) {
      return null;
    }
    const title = rawTitle
      .replace(/\(([^)]*)\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (title.length < 2 || /[{}[\]]/.test(title)) return null;

    const duplicateKey = title.toLowerCase();
    if (seenTitles.has(duplicateKey)) return null;
    seenTitles.add(duplicateKey);
    result.set(upc, title);
  }

  return result.size === expected.size ? result : null;
}

/**
 * Deterministic fallback for every sibling — linted then family-consistency
 * validated before any commit (T7). Shared by the authoritative-cohort path
 * and the per-group path so the lint/T7 contract cannot drift between them.
 *
 * Throws (with `cause`) when the fallback set fails title lint or family
 * consistency; otherwise returns the LINTED titles.
 */
function lintAndValidateFallbackTitles(
  familyId: string,
  group: OnboardingItem[],
  cause: unknown,
): Array<{ upc: string; title: string }> {
  // Issue #112: family color at fallback authorship, ordered brand →
  // color → variant (FORMAT_RULES size-final) like the coordinated-LLM
  // path. Composed explicitly (not via deterministicTitleWithVariants)
  // because color must land BEFORE the variant append. Single-color
  // families pass through untouched.
  const fallbackFamilyColors = familyColorsForGroup(group);
  const fallbackTitles = group.map(item => ({
    upc: item.upc,
    title: ensureVariantTokensInTitle(
      ensureColorInTitle(
        formatDeterministicTitle(item.name ?? item.upc, item.brandHint ?? null),
        itemOwnColor(item),
        fallbackFamilyColors,
      ),
      itemVariantSources(item),
    ),
  }));
  // Title Lint (e09 follow-through): the fallback is a candidate set like any
  // other — lint first (blocked => fail closed, zero rows), then validate the
  // LINTED titles for family consistency (T7).
  const fbCaseMap = brandCaseMapFor(group);
  const fallbackLint = lintTitleSet(
    group.map((item, i) => ({
      upc: item.upc,
      candidateTitle: fallbackTitles[i].title,
      rawTitle: item.name ?? '',
      // The fallback is derived from rawTitle by construction — B1
      // (spreadsheet_fallback_leak) is an LLM-echo detector and must not
      // fire on it.
      candidateSource: 'deterministic_fallback' as const,
      extractionStrings: extractionEvidenceStrings(item),
    })),
    { brandCaseMap: fbCaseMap },
  );
  if (fallbackLint.anyBlocked) {
    const first = fallbackLint.results.find(r => r.blocked);
    throw new Error(`Deterministic fallback failed title lint (${first?.blockReason ?? 'blocked'}): upc ${first?.upc ?? 'unknown'}`, { cause });
  }
  for (const r of fallbackLint.results) {
    const ft = fallbackTitles.find(f => f.upc === r.upc);
    if (ft && r.changed) ft.title = r.title;
  }
  const fallbackValidation = validateFamilyTitleSet({
    familyId,
    members: group.map(item => ({
      onboardingItemId: item.id,
      upc: item.upc,
      frozenEvidenceHash: 'fallback:' + item.upc,
      frozenFacts: deriveFrozenFactsForValidation(item),
    })),
    candidateTitles: fallbackTitles,
  });
  if (!fallbackValidation.valid) {
    // Last resort keeps the color-augmented set (issue #112): rebuilding
    // via plain deterministicTitleWithVariants here would silently drop
    // known multi-color tokens the rest of the pipeline guaranteed.
    console.warn(`[CohortCoordinator] Fallback title set family validation failed (${fallbackValidation.reason}), using color-augmented individual titles for cohort: ${familyId}`);
    return fallbackTitles;
  }
  return fallbackTitles;
}


/**
 * Coordinate titles for a single multi-item group: run LLM coordination, or on
 * failure produce the deterministic fallback set via lintAndValidateFallbackTitles.
 * Rethrows HeartbeatLostError unchanged (PR6 C3: ownership loss never becomes a
 * fallback outcome).
 */
async function coordinateSingleGroup(
  groupItems: OnboardingItem[],
  modelPolicy?: import('../classification/model-policy-gateway').ModelPolicyView | null,
  opts?: CohortCoordinationOptions,
): Promise<Map<string, CoordinatedTitle>> {
  const groupResultMap = new Map<string, CoordinatedTitle>();
  try {
    const groupResult = await coordinateGroup(groupItems, modelPolicy, opts);
    for (const [upc, ct] of groupResult) {
      groupResultMap.set(upc, ct);
    }
  } catch (err: any) {
    // PR6 C3: ownership loss is NEVER converted into an 'LLM unavailable →
    // fallback' outcome. `HeartbeatLostError` (a sibling worker reclaimed
    // the cohort run) rethrows unchanged so the stale owner aborts
    // deterministically with NO output rows — the run belongs to the
    // reclaiming worker, which re-enters the parent op and coordinates only
    // if no complete durable output set exists yet.
    if (err instanceof HeartbeatLostError) {
      throw err;
    }
    console.warn(
      `[CohortCoordinator] Coordination failed for group, using fallbacks: ${redactTransportText(err.message)}`,
    );
    // All-or-nothing: deterministic fallback for every sibling (linted + T7-validated in the shared helper)
    const fallbackTitles = lintAndValidateFallbackTitles(groupItems.map(i => i.upc).sort().join(','), groupItems, err);
    for (const item of groupItems) {
      const t = fallbackTitles.find(f => f.upc === item.upc)?.title ?? deterministicTitleWithVariants(item.name, item.upc, item.brandHint, itemVariantSources(item));
      groupResultMap.set(item.upc, { title: t, source: 'cohort_fallback' });
    }
  }
  return groupResultMap;
}

/**
 * Coordinate cohort names for a set of onboarding items.
 *
 * @param items - Items from the same batch (any stage)
 * @param opts  - Optional audit/ownership threading (PR6 C3). Absent → the
 *   legacy non-audited call (byte-identical legacy/shadow behavior).
 * @returns Map of UPC → CoordinatedTitle. Only includes items
 *   from multi-item groups. Missing entries fall back to per-item.
 */
// fallow-ignore-next-line unused-export — used by tests
export async function coordinateCohortItems(
  items: OnboardingItem[],
  modelPolicy?: import('../classification/model-policy-gateway').ModelPolicyView | null,
  opts?: CohortCoordinationOptions,
): Promise<Map<string, CoordinatedTitle>> {
  const result = new Map<string, CoordinatedTitle>();

  if (items.length === 0) return result;

  // T1 authoritative: do not regroup existing cohort — the caller-provided
  // member list IS the frozen cohort membership. Regrouping via
  // familyGroupingIdentityFor -> extractNameStem is only for pre-cohort
  // routing (initial grouping). For an existing cohort we treat the entire
  // items array as one authoritative family so validateFamilyTitleSet sees
  // the ORIGINAL frozen set, not a re-derived chunk. T10: no new
  // extractNameStem calls are added by validation (deriveFrozenFactsForValidation is regex-only).
  if (opts?.authoritativeCohortId) {
    if (items.length <= 1) return result;
    const authoritativeGroup = items;
    try {
      const groupResult = await coordinateGroup(authoritativeGroup, modelPolicy, opts);
      for (const [upc, ct] of groupResult) result.set(upc, ct);
    } catch (err: any) {
      if (err instanceof HeartbeatLostError) throw err;
      console.warn(`[CohortCoordinator] Authoritative coordination failed for cohort ${opts.authoritativeCohortId}: ${redactTransportText(err.message)}`);
      const fallbackTitles = lintAndValidateFallbackTitles(opts.authoritativeCohortId, authoritativeGroup, err);
      for (const item of authoritativeGroup) {
        const t = fallbackTitles.find(f => f.upc === item.upc)?.title ?? deterministicTitleWithVariants(item.name, item.upc, item.brandHint, itemVariantSources(item));
        result.set(item.upc, { title: t, source: 'cohort_fallback' });
      }
    }
    return result;
  }

  const groups = groupByProductLine(items);

  for (const [, groupItems] of groups) {
    if (groupItems.length <= 1) continue;

    const groupResult = await coordinateSingleGroup(groupItems, modelPolicy, opts);
    for (const [upc, ct] of groupResult) {
      result.set(upc, ct);
    }
  }

  return result;
}

/**
 * Group items by product line using familyGroupingIdentityFor (batch-aware).
 *
 * PR6 C4 (issue #30): exported so the parent title op
 * (`ensureCohortTitlesCoordinated`) can compute the exact multi-item-group
 * member set over the FROZEN sibling views for its completeness/reuse check
 * with the SAME grouping the coordinator uses — single source of truth.
 */
export function groupByProductLine(
  items: OnboardingItem[],
): Map<string, OnboardingItem[]> {
  const knownBrands = knownBrandsForBatch(items);
  const groups = new Map<string, OnboardingItem[]>();

  for (const item of items) {
    const identity = familyGroupingIdentityFor(item, knownBrands);
    if (!identity.stem) {
      groups.set(`single-${item.upc}`, [item]);
      continue;
    }
    const key = identity.key;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }

  return groups;
}

/**
 * Make ONE LLM call for a group of sibling items.
 * Throws on any failure so the caller provides all-or-nothing fallback.
 *
 * PR6 C3: when `opts.modelCall` is present the group call is AUDITED — the
 * audit context + snapshot + ownership assertion are threaded into the
 * audited transport (`callLlmForTaskWithProvenance`) so the
 * `classification_model_calls` started/terminal rows are written on every
 * path and the durable callId is surfaced via `opts.onCoordinatedCallId`.
 * Absent opts → the legacy non-audited `callLlmForTask` call, byte-identical.
 */
async function coordinateGroup(
  items: OnboardingItem[],
  modelPolicy?: import('../classification/model-policy-gateway').ModelPolicyView | null,
  opts?: CohortCoordinationOptions,
): Promise<Map<string, CoordinatedTitle>> {
  // PR6 review fix: the legacy preflight MUST NOT run for audited calls —
  // `callLlmForTaskWithProvenance` resolves the config itself and writes the
  // durable `policy_denied` / `unavailable` terminal `classification_model_calls`
  // rows on those paths. A preflight throw here would exit before the audited
  // wrapper, silently persisting a fallback with NO audited terminal row.
  if (!opts?.modelCall) {
    const llmConfig = getLlmConfigForTask('product_curation', {
      allowFallback: true,
      modelPolicy,
      protectedOperation: 'cohort_title_consolidation',
    });
    if (!llmConfig) {
      throw new Error('No LLM configured for product_curation');
    }
  }

  const siblings = items.map(item => ({
    upc: item.upc,
    name: item.name,
    expectedName: item.expectedName ?? null,
    webTitle: item.extractionData?.title ?? null,
    ocrTitle: item.extractionData?.packagingOcrData?.productName ?? item.extractionData?.packagingTitle ?? null,
    brand: item.brandHint,
    // PR6 hardening C (P1-3): the T-hash-claimed signals (webBrand + the
    // structured OCR weight/flavor) are added to the sibling mapping ONLY when
    // the ACTIVE parent op opts in (`includeTitleHashSignals`). Without the
    // opt-in the mapping is the EXACT pre-hardening shape — legacy/shadow/
    // no-opts prompts stay byte-identical even when items carry OCR/web data.
    ...(opts?.includeTitleHashSignals === true
      ? {
          webBrand: item.extractionData?.brand ?? null,
          ocrWeight: item.extractionData?.packagingOcrData?.weight ?? null,
          ocrFlavor: item.extractionData?.packagingOcrData?.flavorVariety ?? null,
        }
      : {}),
  }));

  // All items in one prompt (no cap). Individual signal strings are
  // truncated at 500 characters to keep prompt size reasonable — via the
  // SHARED prompt-normalization helper from cohort-title-hash so the hashed
  // authority equals the prompted authority by construction (a suffix-only
  // mutation beyond the cutoffs changes neither the prompt NOR the T-hash).
  const truncatedSiblings = siblings.map(s => ({
    ...s,
    name: normalizeTitleAuthorityString(s.name, TITLE_AUTHORITY_TRUNCATION.signalMaxChars) ?? '',
    expectedName: normalizeTitleAuthorityString(s.expectedName, TITLE_AUTHORITY_TRUNCATION.signalMaxChars),
    webTitle: normalizeTitleAuthorityString(s.webTitle, TITLE_AUTHORITY_TRUNCATION.signalMaxChars),
    ocrTitle: normalizeTitleAuthorityString(s.ocrTitle, TITLE_AUTHORITY_TRUNCATION.signalMaxChars),
    ...(opts?.includeTitleHashSignals === true
      ? {
          webBrand: normalizeTitleAuthorityString(s.webBrand ?? null, TITLE_AUTHORITY_TRUNCATION.brandMaxChars),
          ocrWeight: normalizeTitleAuthorityString(s.ocrWeight ?? null, TITLE_AUTHORITY_TRUNCATION.signalMaxChars),
          ocrFlavor: normalizeTitleAuthorityString(s.ocrFlavor ?? null, TITLE_AUTHORITY_TRUNCATION.signalMaxChars),
        }
      : {}),
    brand: normalizeTitleAuthorityString(s.brand, TITLE_AUTHORITY_TRUNCATION.brandMaxChars),
  }));

  // PR6 hardening C (P1-3): the Execution Product Type context is part of the
  // T-hash-only prompt signals — it renders ONLY when the active parent op
  // opted in (absent opt-in ⇒ the EXACT pre-hardening prompt builds).
  const effectiveTypeContext =
    opts?.includeTitleHashSignals === true ? (opts?.executionTypeContext ?? null) : null;
  const prompt = buildCohortPrompt(truncatedSiblings, effectiveTypeContext);

  let response: string | null;
  if (opts?.modelCall) {
    // Audited path (PR6 C3): the started → terminal `classification_model_calls`
    // rows are written by the transport on every path, the model output is
    // returned only after the terminal row is durable, and the returned
    // callId is surfaced for durable output-row provenance.
    const result = await callLlmForTaskWithProvenance(
      'product_curation',
      prompt,
      'You are a clean product taxonomy assistant.',
      {
        allowFallback: true,
        modelPolicy,
        protectedOperation: 'cohort_title_consolidation',
        modelCall: opts.modelCall,
        snapshot: opts.snapshot ?? null,
        assertHeld: opts.assertHeld,
      },
    );
    response = result?.content ?? null;
    if (result) {
      // PR6 review SHOULD-FIX 1: surface the producing call id WITH the group
      // member SKUs so the parent op can persist each row with its own call.
      opts.onCoordinatedCallId?.(result.callId, items.map(i => i.upc));
    }
  } else {
    // Legacy / shadow byte-identical path: non-audited transport.
    response = await callLlmForTask(
      'product_curation',
      prompt,
      'You are a clean product taxonomy assistant.',
      {
        allowFallback: true,
        modelPolicy,
        protectedOperation: 'cohort_title_consolidation',
      },
    );
  }

  if (!response || response.length < 2) {
    throw new Error('LLM returned empty response');
  }

  // Strip markdown code blocks
  const cleaned = response
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse LLM JSON: ${cleaned.slice(0, 200)}`);
  }

  const expectedUpcs = items.map(i => i.upc);
  const validated = validateCohortResponse(parsed, expectedUpcs);

  if (!validated) {
    throw new Error('LLM response validation failed (missing UPCs or duplicate titles)');
  }

  // Issue #108 (design B): deterministic brand guarantee at AUTHORSHIP.
  // Every coordinated title carries its item's resolved brand exactly once
  // BEFORE lint + family gate, so validators and durable rows see final
  // titles. Unknown brand → persisted raw, never invented (the member holds
  // later via missing_brand abstention or the parent-defect error).
  // Issue #111: same authorship rule for variant tokens — every coordinated
  // title carries its item's evidenced size/capacity as final tokens BEFORE
  // lint + family gate. Unknown size → persisted raw (the member holds via
  // missing_size abstention or the parent-defect error).
  const brandByUpc = new Map(items.map(i => [i.upc, i.brandHint?.trim() || null]));
  const itemByUpc = new Map(items.map(i => [i.upc, i]));
  // Issue #112: family colors computed once across the group — multi-color
  // families (two or more distinct) get per-member own-color appends below.
  const familyColors = familyColorsForGroup(items);
  // Issue #112: authorship order is brand → color → variant (FORMAT_RULES
  // size-final) — color before variant so the color never lands after size.
  for (const [upc, title] of validated) {
    const itemBrand = brandByUpc.get(upc);
    let finalTitle = itemBrand ? ensureBrandInTitle(title, itemBrand) : title;
    const item = itemByUpc.get(upc);
    if (item) {
      finalTitle = ensureVariantTokensInTitle(
        ensureColorInTitle(finalTitle, itemOwnColor(item), familyColors),
        itemVariantSources(item),
      );
    }
    validated.set(upc, finalTitle);
  }

  // Title Lint (e09 follow-through): normalize mechanically-repairable defects
  // (tight units, decimals, casing, dup trailing size) and BLOCK unverifiable
  // garbage (spreadsheet fallback leaks, phantom weights) BEFORE the family
  // gate. Blocked => throw so the caller falls through to the deterministic
  // fallback (which is itself linted + revalidated, T7). Changed titles are
  // written back so the family gate below validates the LINTED set — only a
  // linted+revalidated set may commit durably (T8: the lint is a
  // post-processing rule change covered by FAMILY_TITLE_CONSISTENCY_VERSION).
  const brandCaseMap = brandCaseMapFor(items);
  const lint = lintTitleSet(
    items.map(item => ({
      upc: item.upc,
      candidateTitle: validated.get(item.upc) ?? '',
      rawTitle: item.name ?? '',
      candidateSource: 'llm' as const,
      extractionStrings: extractionEvidenceStrings(item),
    })),
    { brandCaseMap },
  );
  if (lint.anyBlocked) {
    const first = lint.results.find(r => r.blocked);
    throw new Error(`LLM title set failed title lint (${first?.blockReason ?? 'blocked'}): upc ${first?.upc ?? 'unknown'}`);
  }
  if (lint.anyChanged) {
    for (const r of lint.results) {
      if (r.changed && r.upc !== null) validated.set(r.upc, r.title);
    }
  }

  // Phase B1 (e09 T7/T8): pure family-title consistency gate — validated set must share skeleton Brand→Line→Form→Flavor→Size,
  // preserve always-visible modifiers (Soft/Hard/Classic/Hypo), and have no sibling leakage. On valid=false the caller
  // writes zero durable rows and may try the deterministic fallback (which is also validated before commit).
  const familyValidation = validateFamilyTitleSet({
    familyId: items.map(i => i.upc).sort().join(','),
    members: items.map(item => ({
      onboardingItemId: item.id,
      upc: item.upc,
      frozenEvidenceHash: 'llm:' + item.upc,
      frozenFacts: deriveFrozenFactsForValidation(item),
    })),
    candidateTitles: [...validated.entries()].map(([upc, title]) => ({ upc, title })),
  });
  if (!familyValidation.valid) {
    throw new Error(`LLM title set failed family consistency (T2-T6): ${familyValidation.reason ?? familyValidation.perMember.find(p => !p.valid)?.reason ?? 'unknown'}`);
  }

  const result = new Map<string, CoordinatedTitle>();
  for (const [upc, title] of validated) {
    result.set(upc, { title, source: 'llm_cohort' });
  }

  console.log(
    `[CohortCoordinator] Coordinated ${result.size} titles via LLM for group`,
  );
  return result;
}
