import type { OnboardingItem, OnboardingSource } from '../shared/schemas/onboarding';
import { getDb } from '../db/connection';
import { insertSources, listSourcesByItem, stampSourceWithDiscoveryRun } from '../db/repositories/onboarding-source-repo';
import { proposePageCandidate, recordOfficialPageDecision, type OfficialPageDecision } from '../db/repositories/official-page-decision-repo';
import { createVariantResolutionRepo } from '../db/repositories/onboarding-variant-resolution-repo';
import { findItemById } from '../db/repositories/onboarding-item-repo';
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
  /** Expected current item revision; a stale in-flight confirmation fails closed. Required on live paths. */
  expectedUpdatedAt: string;
  /** Expected discovery run that produced the candidate; stale runs fail closed. Required on live paths. */
  expectedDiscoveryRunId: string;
}): Promise<OfficialPageDecision> {
  const { item, source } = input;
  if (item.sourceType === 'distributor_record' || !['discovery', 'find_product_page'].includes(item.stage)) {
    throw new OfficialPageConfirmationError('source_not_selectable', 'This item is not awaiting an official product page.');
  }
  // Currentness: a stale in-flight result must never overwrite a newer
  // operator/source decision. Re-read the live item and the source row and
  // refuse when the revision, stage, URL, or run moved underneath us. Both
  // bindings are required on live paths; legacy rows with a NULL run are
  // unconfirmable (source_not_selectable with an explicit re-run reason —
  // never a silent 400, never an overwrite). An in-progress item write
  // (stageStatus in_progress) refuses the confirmation the same way.
  try {
    const fresh = findItemById(item.id);
    if (!fresh) {
      throw new OfficialPageConfirmationError('source_not_selectable', 'This item no longer exists.');
    }
    if (fresh.updatedAt !== input.expectedUpdatedAt) {
      throw new OfficialPageConfirmationError('stale_item', 'This product changed while the confirmation was in flight. Reload and confirm the current page.');
    }
    if (fresh.stageStatus === 'in_progress') {
      throw new OfficialPageConfirmationError('stale_item', 'Discovery is still running for this product. Wait for the current run, then confirm its page.');
    }
    if (fresh.sourceUrl && fresh.sourceUrl !== source.url && (fresh.stageStatus === 'completed' || fresh.status === 'source_confirmed')) {
      throw new OfficialPageConfirmationError('stale_item', 'A newer official page was already confirmed for this product.');
    }
    const liveSource = listSourcesByItem(item.id).find(s => s.id === source.id);
    if (!liveSource) {
      throw new OfficialPageConfirmationError('source_not_selectable', 'This candidate is no longer offered for this product.');
    }
    if (liveSource.url !== source.url) {
      throw new OfficialPageConfirmationError('stale_item', 'This candidate changed while the confirmation was in flight.');
    }
    if (liveSource.discoveryRunId === null || liveSource.discoveryRunId === undefined) {
      throw new OfficialPageConfirmationError('source_not_selectable', 'This candidate predates run-bound discovery (no discovery run). Re-run discovery, then confirm the current page.');
    }
    if (liveSource.discoveryRunId !== input.expectedDiscoveryRunId) {
      throw new OfficialPageConfirmationError('stale_item', 'This candidate came from an older discovery run. Re-run discovery first.');
    }
  } catch (err) {
    if (err instanceof OfficialPageConfirmationError) throw err;
    throw new OfficialPageConfirmationError('strategy_guard_unavailable', 'The current product state could not be checked.', 503);
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
  // Taxonomy Category Page guard: a listing/collection/category page can
  // never satisfy manufacturer-URL authority — only a readable single
  // product-detail page may confirm. The verifier's listing/blog signals
  // are the authority here (category-import IDs never reach this path as
  // product candidates; this reject is defense-in-depth).
  if (signals.isListingOrSearchPage || signals.isBlogOrCmsPage || !signals.isProductDetailPage || !identity.pageName) {
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
  // A redirect-final URL inherits the confirmed run binding (same run that
  // produced the candidate), so the decision row stays bound. The guarded
  // transport checked each redirect hop; Extraction reads the final URL.
  // proposePageCandidate reuses the existing row on retry (no duplicate);
  // stamp the run binding on whichever row backs the final URL.
  const finalSource = finalUrl === source.url ? source : source.sourceMethod === 'operator_url' ||
    source.sourceMethod === 'imported_url' || source.sourceMethod === 'historical_url' || source.sourceMethod === 'legacy_unverified_url'
    ? (() => {
        const proposed = proposePageCandidate({
          itemId: item.id, url: finalUrl,
          origin: source.sourceMethod === 'imported_url' ? 'import' : source.sourceMethod === 'historical_url' ? 'historical' : source.sourceMethod === 'legacy_unverified_url' ? 'legacy' : 'operator',
        });
        stampSourceWithDiscoveryRun(proposed.id, input.expectedDiscoveryRunId);
        return { ...proposed, discoveryRunId: proposed.discoveryRunId ?? input.expectedDiscoveryRunId };
      })()
    : insertSources(item.id, [{ url: finalUrl, domain: new URL(finalUrl).hostname, confidence: source.confidence, sourceMethod: source.sourceMethod, discoveryRunId: input.expectedDiscoveryRunId }])[0];
  const decision = recordOfficialPageDecision({
    workspaceId: input.workspaceId, itemId: item.id, sourceId: finalSource.id,
    evidenceKind: result.proofClass !== 'none' ? 'observed_gtin' : 'operator_name',
    pageTitle: identity.pageName, variantKey: identity.variantKey,
    signals: { ...signals, identity, observedGtins: result.extractedGtins, originalUrl: source.url, finalUrl },
    sourceRunId: input.expectedDiscoveryRunId,
    expectedUpdatedAt: input.expectedUpdatedAt,
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
