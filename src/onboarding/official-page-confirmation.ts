import type { OnboardingItem, OnboardingSource } from '../shared/schemas/onboarding';
import { getDb } from '../db/connection';
import { insertSources } from '../db/repositories/onboarding-source-repo';
import { proposePageCandidate, recordOfficialPageDecision, type OfficialPageDecision } from '../db/repositories/official-page-decision-repo';
import { createVariantResolutionRepo } from '../db/repositories/onboarding-variant-resolution-repo';
import { getEffectiveVariantResolutionMode } from './variant-flags';
import { verifyCandidate } from './page-verifier';
import { createDiscoveryFetch } from './job-queue';
import { getAllowedOfficialPageDomains, isAuthorizedOfficialPageUrl } from './official-page-authority';
import { matchOfficialPageIdentity } from './official-page-identity';
import { enrichUrlMetadata } from '../db/repositories/brand-url-index-repo';

export class OfficialPageConfirmationError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: 400 | 409 | 503 = 409) {
    super(message);
  }
}

/** A candidate is never an approval: fetch, check identity/variant and write one decision. */
export async function confirmOfficialPageCandidate(input: {
  item: OnboardingItem;
  source: OnboardingSource;
  workspaceId: string;
  attestedProductAndVariant: boolean;
}): Promise<OfficialPageDecision> {
  const { item, source } = input;
  if (item.sourceType === 'distributor_record' || !['discovery', 'find_product_page'].includes(item.stage)) {
    throw new OfficialPageConfirmationError('source_not_selectable', 'This item is not awaiting an official product page.');
  }
  let domains: string[];
  try {
    domains = getAllowedOfficialPageDomains({ workspaceId: input.workspaceId, itemId: item.id, brandHint: item.brandHint });
  } catch {
    throw new OfficialPageConfirmationError('strategy_guard_unavailable', 'Official-domain approval could not be checked.', 503);
  }
  if (domains.length === 0 || !isAuthorizedOfficialPageUrl(source.url, domains)) {
    throw new OfficialPageConfirmationError('strategy_source_not_approved', 'Choose a product page on the brand’s approved official site. Retailer pages cannot be confirmed.');
  }
  if (getEffectiveVariantResolutionMode() === 'active') {
    const resolution = createVariantResolutionRepo(getDb()).getCurrentForItem(item.id);
    if (resolution && ['ambiguous', 'no_match', 'stale', 'too_many_variants', 'unsupported'].includes(resolution.status)) {
      throw new OfficialPageConfirmationError('variant_unresolved', 'Choose the exact size or flavor before confirming this page.');
    }
  }

  let finalUrl = source.url;
  const safeFetch = createDiscoveryFetch(domains);
  const result = await verifyCandidate({
    url: source.url, domain: new URL(source.url).hostname,
    confidence: source.confidence, sourceMethod: source.sourceMethod,
    title: source.title, metadataJson: source.metadataJson,
  }, {
    upc: item.upc, expectedName: item.name, brandHint: item.brandHint,
    price: item.price ? Number(item.price) : null, officialDomains: domains,
  }, async (url, init) => {
    const response = await safeFetch(url, init);
    finalUrl = response.url || source.url;
    if (!isAuthorizedOfficialPageUrl(finalUrl, domains)) {
      throw new OfficialPageConfirmationError('strategy_source_not_approved', 'The page redirected outside the approved official site.');
    }
    return response;
  });
  if (!result) throw new OfficialPageConfirmationError('page_unavailable', 'Could not load the official product page. Retry or choose another page.');
  const signals = result.signals;
  const pageName = signals.pageTitle ?? '';
  const observedGtins = result.extractedGtins
    .filter(g => g.type === 'single')
    .map(g => g.gtin);
  const identity = matchOfficialPageIdentity({
    registerName: item.name,
    registerUpc: item.upc,
    brandHint: item.brandHint ?? null,
    pageName,
    pageBrand: null,
    pageKind: signals.isProductDetailPage ? 'product'
      : signals.isListingOrSearchPage ? 'listing' : 'blog',
    variants: [],
    observedGtins,
  });
  if (!signals.isProductDetailPage || signals.isListingOrSearchPage || signals.isBlogOrCmsPage || !identity.pageName) {
    throw new OfficialPageConfirmationError('wrong_page', 'This is not a readable product-detail page. Choose the product itself, not a listing.');
  }
  if (identity.outcome === 'reject_conflict') {
    throw new OfficialPageConfirmationError('identity_conflict', `The visible product page conflicts with the register item: ${identity.reasons.join(', ')}.`);
  }
  if (identity.reasons.some((reason: string) => ['ambiguous_variant', 'unresolved_variant', 'missing_variant_details'].includes(reason))) {
    throw new OfficialPageConfirmationError('variant_unresolved', 'The exact size or flavor is not identifiable on this page.');
  }
  // Name-first (ADR 0040): without structured GTIN proof, confirmation
  // always requires the operator's explicit attestation — whether identity
  // resolved uniquely or parks as needs_operator. Strong proof carries its
  // own authority; attestation is not required on top of it.
  if (!result.hasStrongProof && !input.attestedProductAndVariant) {
    throw new OfficialPageConfirmationError('identity_needs_review', 'Check the visible product name and exact size/flavor, then explicitly confirm the match.');
  }
  // The guarded transport checked each redirect hop. Store the final URL so
  // Extraction reads the very page on which identity was checked.
  const finalSource = finalUrl === source.url ? source : source.sourceMethod === 'operator_url' ||
    source.sourceMethod === 'imported_url' || source.sourceMethod === 'historical_url' || source.sourceMethod === 'legacy_unverified_url'
    ? proposePageCandidate({
        itemId: item.id, url: finalUrl,
        origin: source.sourceMethod === 'imported_url' ? 'import' : source.sourceMethod === 'historical_url' ? 'historical' : source.sourceMethod === 'legacy_unverified_url' ? 'legacy' : 'operator',
      })
    : insertSources(item.id, [{ url: finalUrl, domain: new URL(finalUrl).hostname, confidence: source.confidence, sourceMethod: source.sourceMethod }])[0];
  const decision = recordOfficialPageDecision({
    workspaceId: input.workspaceId, itemId: item.id, sourceId: finalSource.id,
    evidenceKind: result.proofClass !== 'none' ? 'observed_gtin' : 'operator_name',
    pageTitle: identity.pageName, variantKey: identity.variantKey,
    signals: { ...signals, identity, observedGtins: result.extractedGtins, originalUrl: source.url, finalUrl },
    sourceRunId: null,
  });
  const observed = result.extractedGtins.find(gtin => gtin.isValidChecksum) ?? null;
  try {
    enrichUrlMetadata(decision.url, {
      title: identity.pageName,
      brand: item.brandHint ?? null,
      upc: observed?.gtin ?? item.upc ?? null,
      lastFetchedAt: decision.decidedAt,
    });
  } catch (error) {
    console.warn('[OfficialPageConfirmation] Confirmed-page indexing failed (non-blocking):', error);
  }
  return decision;
}
