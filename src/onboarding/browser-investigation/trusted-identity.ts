// Trusted validation identity requirement (#241).
//
// One shared definition consumed by BOTH the acceptance pilot gate
// (`pilot.ts`) and the validation service (`validate.ts`), so the two can
// never drift: a sample proves identity only with a trusted parent product
// ID plus at least one trusted identifier (GTIN / trusted SKU / platform
// variant ID / expected variant key). A product name alone never proves
// identity.

/** Minimal trusted-expectation shape (pilot + validation sample expectations). */
export interface TrustedExpectation {
  name?: string | null;
  gtin?: string | null;
  sku?: string | null;
  platformVariantId?: string | null;
  variantKey?: string | null;
  productId?: string | null;
}

/** Trusted identifier that can prove variant identity (a name alone cannot). */
export function hasTrustedIdentifier(expected: TrustedExpectation | null | undefined): boolean {
  if (!expected) return false;
  return (
    !!expected.gtin?.trim() ||
    !!expected.sku?.trim() ||
    !!expected.platformVariantId?.trim() ||
    !!expected.variantKey?.trim()
  );
}

/** Trusted parent product anchor: the worker must prove product identity against it. */
export function hasTrustedParentProductId(expected: TrustedExpectation | null | undefined): boolean {
  return !!expected?.productId?.trim();
}

/** Both halves of the trusted-identity rule hold. */
export function isTrustedExpectation(expected: TrustedExpectation | null | undefined): boolean {
  return hasTrustedIdentifier(expected) && hasTrustedParentProductId(expected);
}

/** One sample's trusted-expectation problems (name, identifier, product anchor). */
export function trustedExpectationProblemsFor(
  url: string,
  expected: TrustedExpectation | null | undefined,
): string[] {
  const shown = url.slice(0, 120);
  if (!expected || !expected.name || !expected.name.trim()) {
    return [`refused: trusted expected identity with a product name is required for ${shown}`];
  }
  const problems: string[] = [];
  if (!hasTrustedIdentifier(expected)) {
    problems.push(
      `refused: trusted identifier (gtin, sku, platformVariantId, or variantKey) is required for ${shown} — ` +
        'names alone cannot prove variant identity',
    );
  }
  if (!hasTrustedParentProductId(expected)) {
    problems.push(
      `refused: trusted parent productId is required for ${shown} — the worker must prove product identity`,
    );
  }
  return problems;
}
