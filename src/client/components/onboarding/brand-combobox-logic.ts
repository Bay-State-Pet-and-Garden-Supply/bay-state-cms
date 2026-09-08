/**
 * Brand combobox suggestions — UI-only slice over the EXISTING
 * `getBrandSites()` client (`src/client/onboarding-api.ts`).
 *
 * The suggestion pool is `brandSites[].brandName` plus `catalogBrands`,
 * deduplicated case-insensitively with the stored brand_sites spelling kept
 * as canonical. All matching/filtering/canonicalization here is pure so unit
 * tests can pin it without a DOM.
 *
 * Why this exists: assigning a brand with a casing/typo variant of an
 * existing brand creates ghost brands that never hit brand_sites keys.
 * Every brand submit path resolves through `resolveCanonicalBrand` so an
 * existing brand is always submitted in its canonical stored spelling,
 * while genuinely new brands still pass through untouched (with a confirm
 * nudge rendered by `BrandCombobox`).
 */
import { getBrandSites } from '../../onboarding-api';

export const BRAND_SUGGESTION_LIMIT = 8;

/**
 * Merge brand_sites rows + catalog brands into one canonical option list.
 * First spelling wins per case-insensitive key; brand_sites entries come
 * first so the stored spelling is canonical. Tolerates undefined/blank
 * entries (mocked or failed reads degrade to a plain free-text input).
 */
export function buildBrandOptions(
  brandSites: Array<{ brandName?: unknown }> | null | undefined,
  catalogBrands: Array<unknown> | null | undefined,
): string[] {
  const seen = new Set<string>();
  const options: string[] = [];
  const push = (raw: unknown) => {
    if (typeof raw !== 'string') return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    options.push(trimmed);
  };
  for (const site of brandSites ?? []) push(site?.brandName);
  for (const brand of catalogBrands ?? []) push(brand);
  return options;
}

/**
 * Case-insensitive substring match over the option list. Prefix matches
 * rank first, then alphabetical within each group. Empty queries return no
 * suggestions (the input doubles as free entry — no dropdown on empty).
 */
export function filterBrandOptions(
  options: string[],
  query: string,
  limit: number = BRAND_SUGGESTION_LIMIT,
): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const prefix: string[] = [];
  const contains: string[] = [];
  for (const option of options) {
    const lower = option.toLowerCase();
    if (lower === q || lower.startsWith(q)) prefix.push(option);
    else if (lower.includes(q)) contains.push(option);
  }
  const byName = (a: string, b: string) => a.localeCompare(b);
  prefix.sort(byName);
  contains.sort(byName);
  return [...prefix, ...contains].slice(0, Math.max(0, limit));
}

/**
 * Resolve the value to submit: an exact case-insensitive hit returns the
 * canonical stored spelling; anything else (genuinely new brand) returns
 * the trimmed free entry untouched.
 */
export function resolveCanonicalBrand(value: string, options: string[]): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  for (const option of options) {
    if (option.toLowerCase() === lower) return option;
  }
  return trimmed;
}

/**
 * True when the trimmed value matches nothing existing — the caller shows
 * the "Create new brand X?" confirm nudge but still allows the submit.
 */
export function isNewBrandValue(value: string, options: string[]): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  return !options.some((option) => option.toLowerCase() === lower);
}

// Module-level cache: every combobox in a view shares one in-flight/read
// result; views never add per-row requests. Resettable for tests.
let cachedOptions: Promise<string[]> | null = null;

/** Canonical brand options via the EXISTING getBrandSites() client. Never rejects. */
export function getBrandOptions(): Promise<string[]> {
  if (!cachedOptions) {
    cachedOptions = (async () => {
      try {
        const loader = getBrandSites as unknown as
          | (() => Promise<{ brandSites?: unknown; catalogBrands?: unknown }>)
          | undefined;
        if (typeof loader !== 'function') return [];
        const res = await loader();
        const sites = Array.isArray(res?.brandSites) ? res.brandSites : [];
        const catalog = Array.isArray(res?.catalogBrands) ? res.catalogBrands : [];
        return buildBrandOptions(
          sites as Array<{ brandName?: unknown }>,
          catalog as Array<unknown>,
        );
      } catch {
        // Failed reads degrade to free-text entry — never a broken input.
        return [];
      }
    })();
  }
  return cachedOptions;
}

/** Test hook: drop the cached options so the next read refetches. */
export function resetBrandOptionsCache(): void {
  cachedOptions = null;
}
