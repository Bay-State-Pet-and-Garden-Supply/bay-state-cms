/**
 * Pure naming-invariant assessment (issue #106, SEQUENCE 1a).
 *
 * One pure assessment used by Review and both Promotion checks, assessing
 * the ACTUAL FINAL draft title (never 'applied' metadata flags). DB-free by
 * design: importable from vitest-safe modules.
 *
 * - Brand: the resolved authoritative brand must occur exactly once with
 *   bounded matching. `missing_brand` distinguishes `evidence_absent` (no
 *   brand evidenced anywhere — abstain, never invent) from `title_absent`
 *   (evidenced brand dropped from the title); multiples are
 *   `duplicate_brand`.
 * - Measurement: at least one required category (size, capacity,
 *   weight/count/pack) must be satisfied by evidenced tokens, and every
 *   applicable evidenced distinguishing token must stay represented in the
 *   title — a pack count never excuses a dropped capacity. Absent evidence
 *   or contradictory evidence holds with a coded reason, never fabrication.
 * - Color: a known multicolor family (≥2 distinct known colors) requires
 *   the known own color present; unknown own color holds. Fewer than two
 *   known colors is never a blocker (absence of evidence is not a hold).
 * - Siblings: the final title must not duplicate a frozen cohort sibling
 *   title — duplicates are rejected, never regrouped or rewritten here.
 */

/** Escape a string for literal use inside a RegExp. */
function escapeRegExpWord(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordsOf(value: string): string[] {
  return value.match(/[a-z0-9]+/gi) ?? [];
}

/**
 * Count whole-word occurrences of a brand in a title.
 *
 * Same bounded matching as `titleContainsBrand` (case-insensitive, flexible
 * separators, never substrings of larger words) but global: pre-existing
 * duplication such as "Acme Acme Bucket" counts 2 instead of slipping
 * through a first-match test.
 */
export function countBrandOccurrences(title: string, brand: string): number {
  if (!title?.trim() || !brand?.trim()) return 0;
  const words = wordsOf(brand.trim());
  if (words.length === 0) return 0;
  const core = words.map(escapeRegExpWord).join('[^a-z0-9]+');
  const re = new RegExp(`(?:^|[^a-z0-9])${core}(?=[^a-z0-9]|$)`, 'gi');
  let count = 0;
  let match: RegExpExecArray | null;
  // Guard against zero-length matches looping forever.
  while ((match = re.exec(title)) !== null) {
    count += 1;
    if (match[0].length === 0) re.lastIndex += 1;
  }
  return count;
}

/** Recognized product-volume units for capacity evidence. */
const CAPACITY_UNITS = [
  'gal', 'gallon', 'gallons',
  'fl oz', 'floz', 'fluid ounce', 'fluid ounces',
  'ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres',
  'l', 'liter', 'liters', 'litre', 'litres',
  'qt', 'quart', 'quarts',
  'pt', 'pint', 'pints',
];

/**
 * Whether a value is product-bound capacity: an amount plus a recognized
 * volume unit ("5 gal", "16 fl oz", "500 ml"). Bare numbers, shipping
 * weight, dimensions, and unit-alone strings are NOT capacity.
 */
export function isProductCapacity(value: string): boolean {
  const clean = value?.trim().toLowerCase() ?? '';
  if (!clean) return false;
  if (!/\d/.test(clean)) return false;
  return CAPACITY_UNITS.some((unit) => {
    const words = unit.split(' ');
    const pattern = words.length === 1
      ? new RegExp(`\\d[\\s-]*${escapeRegExpWord(unit)}\\b`)
      : new RegExp(`\\d[\\s-]*${words.map(escapeRegExpWord).join('[\\s-]*')}\\b`);
    return pattern.test(clean);
  });
}

/**
 * Flexible whole-token presence of a structured value in a title.
 * Single-word values match word-boundary case-insensitively; multi-word
 * values match with flexible separators — mirroring colorTokenPresentInTitle
 * so structured distributor values ("Navy Blue", "5 gal") verify the same
 * way everywhere.
 */
export function measurementValuePresentInTitle(title: string, value: string): boolean {
  if (!title?.trim() || !value?.trim()) return false;
  const words = wordsOf(value.trim());
  if (words.length === 0) return false;
  if (words.length === 1) {
    return new RegExp(`\\b${escapeRegExpWord(words[0])}\\b`, 'i').test(title);
  }
  const core = words.map(escapeRegExpWord).join('[^a-z0-9]+');
  return new RegExp(`(^|[^a-z0-9])${core}(?=[^a-z0-9]|$)`, 'i').test(title);
}

/**
 * Classify a title-embedded protected token into a measurement axis.
 * Volume units are capacity first (a fluid-ounce size is capacity, not
 * weight); remaining number+unit tokens are weight/count, abbreviations
 * are size. Mirrors extractProtectedTokens patterns. Client-safe (pure).
 */
export function classifyTitleEmbeddedToken(token: string): string {
  if (isProductCapacity(token)) return 'capacity';
  if (/(\d+(?:\.\d+)?)[\s-]*(FLOZ|FL\s*OZ|OZ|OZS?|LB|LBS?|OUNCE|OUNCES|GRAM|GRAMS|G|KG|ML|GAL|QT|LTR)\b/i.test(token)) {
    return 'weight';
  }
  if (/(\d+)[\s-]*(PK|CT|COUNT|PACK|CAN|BAG|PC|PCS|PIECE|PIECES)\b/i.test(token)) {
    return 'count';
  }
  return 'size';
}

export type NamingFindingCode =
  | 'missing_brand'
  | 'duplicate_brand'
  | 'missing_size'
  | 'missing_color'
  | 'duplicate_sibling';

export interface NamingMeasurementToken {
  /** Evidence axis: size, capacity, weight, count, packCount/pack, or a declared custom axis. */
  axis: string;
  /** Structured evidenced value, e.g. "5 LB", "5 gal", "2 Pack". */
  value: string;
  /** Contradictory evidence for this token — holds, never fabricates. */
  conflicted?: boolean;
  /** Classification Evidence / run refs for audit (story 20). */
  refs?: string[];
}

export interface NamingFinding {
  code: NamingFindingCode;
  /** Stable machine detail: evidence_absent/title_absent, axis/value, family/own. */
  detail: string;
  axis?: string;
  value?: string;
  conflict?: boolean;
  evidenceRefs?: string[];
}

export interface NamingAssessmentInput {
  /** ACTUAL FINAL draft title. */
  title: string | null;
  /** Resolved authoritative brand (null = no brand evidenced anywhere). */
  brand: string | null;
  brandEvidence: 'present' | 'absent';
  /** Evidenced distinguishing measurement tokens. */
  measurementTokens: NamingMeasurementToken[];
  /** False skips measurement (caller-determined non-applicability). */
  measurementApplicable: boolean;
  /** Structured own color (null = unknown — never invent). */
  ownColor: string | null;
  /** Known family colors (multicolor evidence requires ≥2 distinct). */
  familyColors: string[];
  /** Final titles of frozen cohort siblings (excluding self). */
  siblingTitles: string[];
}

export interface NamingAssessment {
  ok: boolean;
  findings: NamingFinding[];
}

const MEASUREMENT_CATEGORIES = new Set(['size', 'capacity', 'weight', 'count', 'packcount', 'pack']);

function categoryOf(axis: string): string {
  return axis.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

export function assessNamingInvariants(input: NamingAssessmentInput): NamingAssessment {
  const findings: NamingFinding[] = [];
  const title = input.title?.trim() ?? '';

  // ── Brand: exactly-once containment ────────────────────────────────
  if (!input.brand?.trim()) {
    findings.push({
      code: 'missing_brand',
      detail: input.brandEvidence === 'absent' ? 'evidence_absent' : 'title_absent',
    });
  } else {
    const occurrences = countBrandOccurrences(title, input.brand);
    if (occurrences === 0) {
      findings.push({ code: 'missing_brand', detail: 'title_absent' });
    } else if (occurrences > 1) {
      findings.push({ code: 'duplicate_brand', detail: `occurrences:${occurrences}` });
    }
  }

  // ── Measurement: one required category + every token represented ──
  if (input.measurementApplicable) {
    const tokens = input.measurementTokens ?? [];
    if (tokens.length === 0) {
      findings.push({ code: 'missing_size', detail: 'no_measurement_evidence' });
    } else {
      const representedCategories = new Set<string>();
      for (const token of tokens) {
        const present = measurementValuePresentInTitle(title, token.value);
        const refs = token.refs && token.refs.length > 0 ? token.refs : undefined;
        if (token.conflicted && !present) {
          findings.push({
            code: 'missing_size', detail: 'conflicted_evidence',
            axis: token.axis, value: token.value, conflict: true, evidenceRefs: refs,
          });
          continue;
        }
        if (!present) {
          findings.push({
            code: 'missing_size', detail: 'token_absent_from_title',
            axis: token.axis, value: token.value, evidenceRefs: refs,
          });
          continue;
        }
        representedCategories.add(categoryOf(token.axis));
      }
      const satisfied = [...representedCategories].some((c) => MEASUREMENT_CATEGORIES.has(c));
      if (!satisfied && findings.length === 0) {
        findings.push({ code: 'missing_size', detail: 'no_required_category' });
      }
    }
  }

  // ── Color: known multicolor family requires known own color ────────
  const distinctFamily = [...new Set((input.familyColors ?? []).map((c) => c?.trim()).filter(Boolean))] as string[];
  if (distinctFamily.length >= 2) {
    const own = input.ownColor?.trim() ?? '';
    if (!own) {
      findings.push({ code: 'missing_color', detail: 'own_color_unknown' });
    } else if (!measurementValuePresentInTitle(title, own)) {
      findings.push({ code: 'missing_color', detail: 'own_color_absent', value: own });
    }
  }

  // ── Siblings: reject duplicates, never regroup/rewrite ────────────
  const normalizedTitle = title.toLowerCase();
  if (normalizedTitle) {
    const duplicate = (input.siblingTitles ?? []).some(
      (s) => (s ?? '').trim().toLowerCase() === normalizedTitle,
    );
    if (duplicate) {
      findings.push({ code: 'duplicate_sibling', detail: 'title_matches_frozen_sibling' });
    }
  }

  return { ok: findings.length === 0, findings };
}
