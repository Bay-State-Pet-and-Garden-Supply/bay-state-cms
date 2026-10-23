import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { findItemById, findCurationDataJsonById } from '../db/repositories/onboarding-item-repo';
import { listPiAssetsByOnboardingItem } from '../db/repositories/onboarding-pi-asset-repo';
import type { Product } from '../shared/schemas/product';
import type { ItemAssetRightsBinding } from './item-checklist';
import type { OnboardingItem } from '../shared/schemas/onboarding';
import { findWorkspacePathById } from '../db/repositories/workspace-repo';
import { findGateRunById } from '../db/repositories/classification-run-repo';
import { getCurrentItemEvidenceView, type ItemEvidenceResult } from '../onboarding/item-evidence';
import { currentListingEvidenceHashes, projectedCuratedString, type DraftListingProjection, type ListingEvidenceCurrentHashes } from './listing-evidence-currentness';
import { findListingStandard } from '../onboarding/listing-standards';
import { listListingCompletenessExceptions } from '../db/repositories/listing-completeness-exception-repo';
import { evaluateItemChecklist } from './item-checklist';
import type { ItemChecklistEvaluation, ListingCompletenessStandard } from '../shared/schemas/item-evidence';
import { CurationDataSchema, ExtractionDataSchema } from '../shared/schemas/onboarding';
import { hashCanonicalJson } from '../shared/stable-id';
import { evaluateCanonicalReadiness, getRequiredCatalogFieldsForRun, selectRunListingClassificationTarget } from './classification-readiness';
import { itemInputIdentityHash } from '../onboarding/item-input-identity';
import { hashFinalListing } from './listing-evidence';

export interface ItemListingReadiness {
  evaluation: ItemChecklistEvaluation;
  standard: ListingCompletenessStandard | null;
  evidence: ItemEvidenceResult['evidence'];
  nonWaivableFields: string[];
  classificationSource: 'reviewed' | 'provisional' | 'none';
  classificationReady: boolean;
  classificationReason: string | null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try { return JSON.parse(value); } catch { return null; }
}

function unavailable(reason: string, classificationSource: ItemListingReadiness['classificationSource'] = 'none'): ItemListingReadiness {
  return {
    standard: null, evidence: null, nonWaivableFields: [], classificationSource,
    classificationReady: false, classificationReason: reason,
    evaluation: { status: 'unavailable', inputHash: null, evidenceHash: null, standardHash: null,
      classificationHash: null, listingHash: null, requirements: [], reasons: [reason] },
  };
}

function productListing(product: Pick<Product, 'core' | 'customFields' | 'metadata'>): Record<string, unknown> {
  const { core, customFields } = product;
  const media = [core.media.primary, ...core.media.additional].filter((value): value is string =>
    typeof value === 'string' && value.trim().length > 0,
  );
  return {
    ...customFields,
    title: core.name,
    name: core.name,
    description: core.description,
    weight: core.weight,
    primaryImage: core.media.primary,
    additionalImages: [...core.media.additional],
    images: media,
    image_rights: media,
  };
}

function verifiedMediaHash(workspacePath: string, localPath: string): string | null {
  if (!localPath.trim() || path.isAbsolute(localPath) || /^[a-zA-Z]:[\\/]/u.test(localPath)) return null;
  const root = path.resolve(workspacePath, 'products', 'images');
  const candidate = path.resolve(root, localPath);
  if (candidate === root || !candidate.startsWith(root + path.sep)) return null;
  try {
    const rootReal = fs.realpathSync(root);
    const candidateReal = fs.realpathSync(candidate);
    if (candidateReal === rootReal || !candidateReal.startsWith(rootReal + path.sep) ||
        !fs.statSync(candidateReal).isFile()) return null;
    return createHash('sha256').update(fs.readFileSync(candidateReal)).digest('hex');
  } catch {
    return null;
  }
}

function resolvedAssetRightsBindings(
  itemId: string,
  runId: string,
  item: OnboardingItem,
  workspacePath: string,
  product: Pick<Product, 'core' | 'customFields' | 'metadata'>,
  evidence: ItemEvidenceResult['evidence'],
): ItemAssetRightsBinding[] {
  if (!evidence) return [];
  const mediaPaths = [product.core.media.primary, ...product.core.media.additional]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const provenance = product.metadata.imageProvenance ?? [];
  const byPath = new Map<string, (typeof provenance)[number]>();
  const ambiguous = new Set<string>();
  for (const mapping of provenance) {
    const previous = byPath.get(mapping.localPath);
    if (previous && (previous.sourceUrl !== mapping.sourceUrl || previous.contentHash !== mapping.contentHash ||
        previous.assetId !== mapping.assetId || previous.rightsApprovalId !== mapping.rightsApprovalId ||
        previous.rightsAuthorityHash !== mapping.rightsAuthorityHash)) ambiguous.add(mapping.localPath);
    else byPath.set(mapping.localPath, mapping);
  }
  let assets: ReturnType<typeof listPiAssetsByOnboardingItem>;
  try { assets = listPiAssetsByOnboardingItem(itemId); } catch { return []; }
  const output: ItemAssetRightsBinding[] = [];
  for (const localPath of new Set(mediaPaths)) {
    const mapping = byPath.get(localPath);
    if (!mapping || ambiguous.has(localPath) || verifiedMediaHash(workspacePath, localPath) !== mapping.contentHash) continue;
    const accepted = evidence.facts.find(fact =>
      /image|photo|media/i.test(fact.field) && fact.value.trim() === mapping.sourceUrl &&
      fact.rights?.assetUrl === mapping.sourceUrl &&
      fact.rights.approvalId === mapping.rightsApprovalId &&
      fact.rights.authorityHash === mapping.rightsAuthorityHash,
    );
    if (!accepted) continue;
    if (mapping.assetId) {
      const asset = assets.find((candidate: { id: string }) => candidate.id === mapping.assetId);
      if (!asset || asset.sourceUrl !== mapping.sourceUrl || asset.rightsStatus !== 'approved' ||
          asset.qualityStatus !== 'usable' || asset.exactProductMatch !== 1 || asset.commerceApproved !== 1 ||
          !asset.verifiedAgainstHash || !asset.verifiedAgainstJson) continue;
      let verifiedAgainst: Record<string, unknown>;
      let conflicts: unknown;
      try {
        const parsed: unknown = JSON.parse(asset.verifiedAgainstJson);
        conflicts = JSON.parse(asset.conflictsJson);
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(conflicts) || conflicts.length > 0) continue;
        verifiedAgainst = parsed as Record<string, unknown>;
      } catch { continue; }
      if (verifiedAgainst.runId !== runId || verifiedAgainst.gtin !== item.upc ||
          verifiedAgainst.name !== item.name) continue;
    }
    output.push({
      localPath, sourceUrl: mapping.sourceUrl, assetId: mapping.assetId,
      factId: accepted.id, approvalId: mapping.rightsApprovalId,
      rightsAuthorityHash: mapping.rightsAuthorityHash,
    });
  }
  return output;
}

export function loadItemListingReadiness(
  workspaceId: string,
  itemId: string,
  projection?: DraftListingProjection,
): ItemListingReadiness {
  return loadReadiness(workspaceId, itemId, null, projection);
}

/** Evaluate an own-run reviewed or provisional pair for preparation; provisional never means release-ready. */
export function loadItemListingReadinessForRun(
  workspaceId: string,
  itemId: string,
  runId: string,
  projection?: DraftListingProjection,
): ItemListingReadiness {
  return loadReadiness(workspaceId, itemId, runId, projection);
}

function loadReadiness(
  workspaceId: string,
  itemId: string,
  requestedRunId: string | null,
  requestedProjection?: DraftListingProjection,
): ItemListingReadiness {
  const item = findItemById(itemId);
  const workspacePath = findWorkspacePathById(workspaceId);
  if (!item || !workspacePath) return unavailable('The item or its workspace is unavailable.');
  const curationRaw = findCurationDataJsonById(itemId);
  const curationResult = curationRaw ? CurationDataSchema.safeParse(parseJson(curationRaw)) : null;
  if (curationRaw && !curationResult?.success) return unavailable('Current curation data is invalid.');
  const curation: Record<string, unknown> = curationResult?.success
    ? curationResult.data as Record<string, unknown>
    : {};
  const storedRunId = curation.classificationRunId;
  const runId = requestedRunId ?? (typeof storedRunId === 'string' ? storedRunId : null);
  if (!runId) return unavailable('The item has no current classification run.');
  const run = findGateRunById(runId);
  if (!run || run.workspaceId !== workspaceId || run.productSku !== item.upc ||
      (requestedRunId ? run.onboardingItemId !== itemId : run.onboardingItemId !== null && run.onboardingItemId !== itemId)) {
    return unavailable('The classification run is not owned by this workspace item.');
  }
  const target = selectRunListingClassificationTarget({ workspaceId, runId });
  if (target.source === 'none' || !target.categoryId || !target.productTypeId) {
    return unavailable('No valid own-run reviewed or provisional configured Category + Product Type pair is available.');
  }
  if (!requestedRunId && target.source !== 'reviewed') {
    return unavailable('Human-reviewed canonical classification is required for current listing readiness.', target.source);
  }
  let standard: ListingCompletenessStandard | null;
  try { standard = findListingStandard(workspacePath, target.categoryId, target.productTypeId); }
  catch { return unavailable('The versioned listing standard could not be read.', target.source); }
  if (!standard) return unavailable('No versioned listing standard exists for the selected classification pair.', target.source);

  const readiness = evaluateCanonicalReadiness({ workspaceId, runId });
  const requiredClassificationFields = target.source === 'reviewed' && run.status !== 'running'
    ? getRequiredCatalogFieldsForRun({ workspaceId, runId })
    : target.source === 'reviewed' ? null : [];
  const classificationReady = target.source === 'reviewed' && readiness.ok && requiredClassificationFields !== null;
  const classificationReason = target.source === 'provisional'
    ? 'The configured classification pair is provisional and requires human review before release.'
    : classificationReady ? null
      : requiredClassificationFields === null && target.source === 'reviewed'
        ? 'Required classification fields could not be resolved from the captured profile.'
        : readiness.reason;
  const hardClassificationFields = requiredClassificationFields ?? [];
  if (!requestedRunId && !classificationReady) {
    return unavailable(classificationReason ?? 'Human-reviewed canonical classification is required for current listing readiness.', target.source);
  }

  let currentEvidence: ItemEvidenceResult;
  try { currentEvidence = getCurrentItemEvidenceView(workspaceId, itemId); }
  catch { return unavailable('Current accepted evidence could not be read.', target.source); }
  const evidence = currentEvidence.evidence;
  if (currentEvidence.status === 'stale' || currentEvidence.status === 'conflict') {
    return { ...unavailable(currentEvidence.findings[0]?.reason ?? 'Accepted evidence is stale or conflicting.', target.source),
      evaluation: { status: currentEvidence.status === 'stale' ? 'stale' : 'unavailable',
        inputHash: null, evidenceHash: null, standardHash: standard.standardHash,
        classificationHash: null, listingHash: null, requirements: [],
        reasons: [currentEvidence.findings[0]?.reason ?? 'Accepted evidence is stale or conflicting.'] } };
  }
  const noSnapshot = currentEvidence.status === 'unavailable' && currentEvidence.findings.some(finding => finding.code === 'evidence_unavailable');
  const bootstrap = !evidence && requestedRunId !== null && target.source === 'provisional' && noSnapshot;
  if (!evidence && !bootstrap) return unavailable(currentEvidence.findings[0]?.reason ?? 'Current accepted evidence is unavailable.', target.source);

  const requiredFields = standard.requirements.filter(requirement => requirement.required).map(requirement => requirement.field);
  if (requestedProjection?.requiredFields !== undefined &&
      [...new Set(requestedProjection.requiredFields)].sort().join('\0') !== [...new Set(requiredFields)].sort().join('\0')) {
    return unavailable('The draft projection does not match the current standard-required fields.', target.source);
  }
  const extractionResult = requestedProjection?.product
    ? null
    : ExtractionDataSchema.safeParse(parseJson(item.extractionData));
  if (extractionResult && !extractionResult.success) return unavailable('Current extracted listing data is invalid.', target.source);
  const extraction = extractionResult?.success ? extractionResult.data : {};
  if (requestedProjection?.product && (
    requestedProjection.title !== requestedProjection.product.core.name ||
    requestedProjection.description !== requestedProjection.product.core.description
  )) return unavailable('The draft title or description does not match the validated Product projection.', target.source);
  if (requestedProjection && !requestedProjection.product &&
      standard.requirements.some(requirement => requirement.kind === 'image_rights')) {
    return unavailable('The final Product media and its source-rights provenance are required for draft image-rights readiness.', target.source);
  }
  const curationFields: Record<string, unknown> = curation as Record<string, unknown>;
  const product = requestedProjection?.product;
  const productFields = product ? productListing(product) : null;
  const actualVariantFacts = product
    ? Object.fromEntries([
        ...Object.entries(product.customFields).filter(([field]) => field.trim().toLocaleLowerCase() !== 'weight'),
        ...(product.core.weight?.trim() ? [['weight', product.core.weight] as [string, string]] : []),
        ...(product.core.media.primary ? [['__primaryMedia', product.core.media.primary] as [string, string]] : []),
        ['__additionalMedia', JSON.stringify(product.core.media.additional)],
      ])
    : requestedProjection?.variantFacts ?? {};
  const listing: Record<string, unknown> = productFields
    ? { ...productFields, sku: item.upc }
    : requestedProjection
      ? { ...(requestedProjection.fields ?? {}), ...requestedProjection.variantFacts, sku: item.upc }
      : { ...extraction, ...curationFields, sku: item.upc };
  const projection: DraftListingProjection | undefined = requestedProjection
    ? { title: requestedProjection.title, description: requestedProjection.description,
        variantFacts: actualVariantFacts, fields: (requestedProjection as { fields?: Record<string, unknown> }).fields,
        requiredFields, classificationRunId: runId, product }
    : undefined;
  const curated = curation as { curatedTitle?: unknown; curatedDescription?: unknown };
  const titleSlot = projectedCuratedString(curated.curatedTitle);
  const descriptionSlot = projectedCuratedString(curated.curatedDescription);
  const extractionTitle = typeof extraction === 'object' && extraction !== null && 'title' in extraction &&
    typeof (extraction as { title?: unknown }).title === 'string'
    ? String((extraction as { title: string }).title) : null;
  const extractionDescription = typeof extraction === 'object' && extraction !== null && 'description' in extraction &&
    typeof (extraction as { description?: unknown }).description === 'string'
    ? String((extraction as { description: string }).description) : null;
  const title = product
    ? product.core.name
    : requestedProjection ? requestedProjection.title
      : titleSlot.text ?? (titleSlot.removed ? null : (extractionTitle ?? item.name ?? null));
  const description = product
    ? product.core.description
    : requestedProjection ? requestedProjection.description
      : descriptionSlot.text ?? (descriptionSlot.removed ? null : extractionDescription);
  listing.title = title;
  listing.description = description;
  const assetRightsBindings = product
    ? resolvedAssetRightsBindings(itemId, runId, item, workspacePath, product, evidence)
    : [];
  let currentHashes: ListingEvidenceCurrentHashes;
  if (evidence) {
    try {
      currentHashes = currentListingEvidenceHashes(itemId, curation as Record<string, unknown>, { workspacePath, workspaceId }, projection, runId);
    } catch { return unavailable('Current listing hashes could not be read.', target.source); }
  } else {
    currentHashes = {
      listingHash: hashFinalListing({ title, description, variantFacts: actualVariantFacts, requiredFields }),
      evidenceHash: '', modelPolicyDigest: '', sourceAuthority: '', requiredFields,
    };
  }
  const inputHash = evidence?.inputHash ?? itemInputIdentityHash(workspaceId, item);
  const classificationHash = hashCanonicalJson({
    categoryId: target.categoryId, productTypeId: target.productTypeId, runId,
    source: target.source, classificationReady,
    requiredValues: readiness.details.requiredValues,
    requiredClassificationFields: hardClassificationFields,
  });
  let exceptions;
  try { exceptions = listListingCompletenessExceptions(workspaceId, itemId); }
  catch { return unavailable('Listing omission receipts could not be read.', target.source); }
  const nonWaivableFields = [...new Set([
    ...hardClassificationFields,
    ...standard.requirements.filter(requirement => ['identity', 'image_rights', 'safety', 'classification'].includes(requirement.kind))
      .map(requirement => requirement.field),
  ])];
  const evaluation = evaluateItemChecklist({
    workspaceId, itemId, sku: item.upc,
    classification: { categoryId: target.categoryId, productTypeId: target.productTypeId },
    listing, evidence, standard, exceptions, inputHash, listingHash: currentHashes.listingHash || null,
    classificationHash, nonWaivableFields, allowMissingEvidence: bootstrap, assetRightsBindings,
  });
  return { standard, evidence, evaluation, nonWaivableFields,
    classificationSource: target.source, classificationReady,
    classificationReason };
}
