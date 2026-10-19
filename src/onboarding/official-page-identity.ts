import { expandAbbreviations, splitAttachedSizeTokens } from './product-line-token-normalizer';

/** Evidence from the visible product heading and the page's actual variant choices. */
export interface OfficialPageIdentityInput {
  registerName: string;
  registerUpc: string | null;
  brandHint: string | null;
  pageName: string;
  pageBrand: string | null;
  pageKind: 'product' | 'listing' | 'blog';
  variants: Array<{ key: string; label: string; gtin?: string | null }>;
  /** Product-level GTINs only. GTINs of unselected variants belong on `variants`. */
  observedGtins: string[];
}

export interface OfficialPageIdentityResult {
  outcome: 'unique_name_variant_match' | 'needs_operator' | 'reject_conflict';
  pageName: string;
  variantKey: string | null;
  reasons: string[];
  matchedTerms: string[];
  missingTerms: string[];
  conflictingTerms: string[];
}

const NON_DISTINCTIVE = new Set(['dog', 'cat', 'pet', 'food', 'treat', 'treats', 'toy', 'toys', 'recipe', 'for', 'with', 'and', 'the', 'of', 'in', 'a', 'an']);
const FLAVORS = new Set(['chicken', 'turkey', 'venison', 'salmon', 'duck', 'beef', 'lamb', 'pork', 'rabbit', 'fish', 'tuna']);
const KNOWN_ABBREVIATIONS = new Set(['sm', 'md', 'lg', 'xl', 'xs', 'xxl', 'oz', 'lb', 'lbs', 'ct', 'kg', 'vnsn', 'chkn', 'ckn', 'trky', 'slmn', 'brly', 'vgg', 'frzn']);
const SIZE_WORDS = new Set(['sm', 'md', 'lg', 'xl', 'xs', 'xxl']);
const UNIT_WORDS = new Set(['oz', 'lb', 'ct', 'kg', 'g']);

function canonicalTokens(text: string): string[] {
  const prepared = expandAbbreviations(splitAttachedSizeTokens(text).toLowerCase())
    .replace(/\bextra[- ]small\b|\bx[- ]small\b/g, ' xs ')
    .replace(/\bextra[- ]large\b|\bx[- ]large\b/g, ' xl ')
    .replace(/\bsmall\b/g, ' sm ')
    .replace(/\bmedium\b|\bmed\b/g, ' md ')
    .replace(/\blarge\b/g, ' lg ')
    .replace(/\bpounds?\b|\blbs\b/g, ' lb ')
    .replace(/\bounces?\b/g, ' oz ')
    .replace(/\bcount\b/g, ' ct ')
    .replace(/(\d)(oz|lb|lbs|ct|kg|g)\b/g, '$1 $2');
  return prepared.replace(/[^a-z0-9.]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function packageAxes(tokens: string[]): string[] {
  const axes: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (/^\d+(?:\.\d+)?$/.test(tokens[i]) && UNIT_WORDS.has(tokens[i + 1])) {
      axes.push(`${tokens[i]} ${tokens[i + 1]}`);
      i++;
    } else if (SIZE_WORDS.has(tokens[i]) || FLAVORS.has(tokens[i])) {
      axes.push(tokens[i]);
    }
  }
  return axes;
}

function unknownAbbreviation(name: string): boolean {
  return splitAttachedSizeTokens(name).split(/[^A-Za-z0-9]+/).some((word) =>
    word.length >= 3 && word === word.toUpperCase() && !/[AEIOUY]/.test(word) &&
    !KNOWN_ABBREVIATIONS.has(word.toLowerCase()));
}

function equivalentGtin(a: string, b: string): boolean {
  const left = a.replace(/\D/g, '').replace(/^0+/, '');
  const right = b.replace(/\D/g, '').replace(/^0+/, '');
  return left.length > 0 && left === right;
}

/** Abstain rather than inferring identity from brand, UPC-in-body, or a partial product title. */
export function matchOfficialPageIdentity(input: OfficialPageIdentityInput): OfficialPageIdentityResult {
  const expected = canonicalTokens(input.registerName);
  const brand = canonicalTokens(input.brandHint ?? '');
  const title = canonicalTokens(input.pageName);
  const expectedAxes = packageAxes(expected);
  const titleAxes = packageAxes(title);
  const expectedLine = [...new Set(expected.filter((token) =>
    !brand.includes(token) && !NON_DISTINCTIVE.has(token) && !FLAVORS.has(token) &&
    !SIZE_WORDS.has(token) && !UNIT_WORDS.has(token) && !/^\d+(?:\.\d+)?$/.test(token)))];
  const matchedTerms = expectedLine.filter((term) => title.includes(term));
  const missingTerms = expectedLine.filter((term) => !title.includes(term));
  const conflictingTerms: string[] = [];
  const reasons: string[] = [];
  let variantKey: string | null = null;
  let outcome: OfficialPageIdentityResult['outcome'] = 'unique_name_variant_match';

  if (input.pageKind !== 'product') reasons.push('not_product_page');
  if (brand.length && input.pageBrand && brand.join(' ') !== canonicalTokens(input.pageBrand).join(' ')) reasons.push('brand_conflict');
  if (input.registerUpc && input.observedGtins.length &&
    input.observedGtins.some((gtin) => !equivalentGtin(gtin, input.registerUpc!))) reasons.push('product_gtin_conflict');
  if (missingTerms.length && title.length > 0 && !unknownAbbreviation(input.registerName)) reasons.push('product_line_mismatch');
  // The heading must not identify a different flavor or package. A generic group
  // heading is fine only if one and exactly one explicit variant supplies the axes.
  for (const axis of titleAxes) {
    if (expectedAxes.includes(axis)) continue;
    const conflicting = FLAVORS.has(axis) && expectedAxes.some((e) => FLAVORS.has(e)) ||
      SIZE_WORDS.has(axis) && expectedAxes.some((e) => SIZE_WORDS.has(e)) ||
      axis.includes(' ') && expectedAxes.some((e) => e.includes(' '));
    if (conflicting) conflictingTerms.push(axis);
  }
  if (conflictingTerms.length) reasons.push('variant_conflict');

  if (reasons.length) outcome = 'reject_conflict';
  else if (unknownAbbreviation(input.registerName) || expectedLine.length < 2 || !input.pageName.trim()) {
    reasons.push('insufficient_name_evidence');
    outcome = 'needs_operator';
  } else if (input.variants.length) {
    const matches = input.variants.filter((variant) => {
      const axes = [...titleAxes, ...packageAxes(canonicalTokens(variant.label))];
      return expectedAxes.every((axis) => axes.includes(axis)) &&
        (!input.registerUpc || !variant.gtin || equivalentGtin(variant.gtin, input.registerUpc));
    });
    if (matches.length === 1) variantKey = matches[0].key;
    else {
      reasons.push(matches.length ? 'ambiguous_variant' : 'unresolved_variant');
      outcome = 'needs_operator';
    }
  } else if (expectedAxes.some((axis) => !titleAxes.includes(axis))) {
    reasons.push('missing_variant_details');
    outcome = 'needs_operator';
  }

  return { outcome, pageName: input.pageName, variantKey, reasons, matchedTerms, missingTerms, conflictingTerms };
}
