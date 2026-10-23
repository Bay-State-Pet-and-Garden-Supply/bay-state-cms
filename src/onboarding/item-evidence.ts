import { createHash, randomUUID } from 'node:crypto';
import {
  AcceptedItemEvidenceSchema,
  AcceptedItemFactSchema,
  ItemEvidenceObservationSchema,
  type AcceptedItemEvidence,
  type AcceptedItemFact,
  type ItemEvidenceFinding,
  type ItemEvidenceObservation,
  type ItemEvidenceSourceRole,
  type ItemEvidenceCollectionMethod,
} from '../shared/schemas/item-evidence';
import type { ClassificationEvidence } from '../shared/schemas/classification';
import { ExtractionDataSchema, SourcingDecisionV2Schema } from '../shared/schemas/onboarding';
import { ProductIdentityEvidenceSchema, EvidenceAttemptSchema, type EvidenceAttempt } from '../shared/schemas/distributor-evidence';
import { canonicalJsonStringify, hashCanonicalJson } from '../shared/stable-id';
import { findItemById, type OnboardingItemWithEntryPolicy } from '../db/repositories/onboarding-item-repo';
import { findBatchById } from '../db/repositories/onboarding-batch-repo';
import { itemInputIdentityHash } from './item-input-identity';
import { getLatestExtraction, type OnboardingExtractionRow } from '../db/repositories/onboarding-extraction-repo';
import {
  appendAcceptedItemEvidenceSnapshot,
  acceptedItemEvidenceHash,
  getCurrentItemEvidence,
  listItemEvidenceSnapshots,
} from '../db/repositories/accepted-item-evidence-repo';
import { listOfficialPageDecisions } from '../db/repositories/official-page-decision-repo';
import { listSourcesByItem } from '../db/repositories/onboarding-source-repo';
import {
  getActiveManualEvidenceAttestationForItem,
  getManualEvidenceAttestation,
  parseManualEvidenceImageRights,
  verifyManualEvidenceAttestationHash,
  computeManualEvidenceValueHashes,
  type ManualEvidenceAttestationRow,
} from '../db/repositories/onboarding-manual-evidence-repo';
import { buildManualEvidenceFieldValues } from './manual-evidence-eligibility';
import {
  getAllowedOfficialPageDomains,
  isAuthorizedOfficialPageUrl,
} from './official-page-authority';
import { isKnownRetailerOrDistributorDomain } from './discovery/retailer-domain-list';
import { matchOfficialPageIdentity, findContradictoryProductAxes, normalizedMeasuredQuantityKey } from './official-page-identity';
import { createVariantResolutionRepo } from '../db/repositories/onboarding-variant-resolution-repo';
import { findProfileByDomain } from '../db/repositories/extractor-profile-repo';
import {
  getCurrentSourcingGeneration,
  getEvidenceAttemptsByItemAndGeneration,
} from '../db/repositories/onboarding-evidence-repo';
import { getCurrentGenerationAcceptedAttemptIds } from '../db/repositories/onboarding-acceptance-repo';
import { listCurrentGenerationConflictsForItem, listResolvedConflictResolutions } from '../db/repositories/onboarding-conflict-repo';
import { buildDistributorRecordProjection, buildDistributorRecordProjectionV1 } from './sourcing/distributor-record-projection';
import {
  reconstructDistributorExtractionPayload,
  reconstructStrategyCollectionExtractionPayload,
  payloadsEquivalentForDistributorRecord,
} from './sourcing/distributor-record-materializer';
import type { StrategyCollectionResult } from './sourcing/strategy-collection-result';
import { getStrategyCollectionResult } from '../db/repositories/strategy-collection-result-repo';
import { getConnectionById, getDistributorById } from '../db/repositories/distributor-repo';
import { getDb } from '../db/connection';
import { normalizeGtin, normalizeVariantAxis } from './sourcing/contracts';

export const ITEM_EVIDENCE_RULES_VERSION = 'item-evidence-admission-v1';
const ITEM_EVIDENCE_MAX_CONTENT_BYTES = 262144;
const ITEM_EVIDENCE_MAX_OBSERVATIONS = 64;
const ITEM_EVIDENCE_MAX_FACTS = 512;
const DIRECT_EXTRACTION_PROVENANCE = new Set(['json-ld', 'meta', 'microdata', 'html']);
const MANUAL_FIELD_NAMES = [
  'title', 'brand', 'description', 'bulletPoints', 'weight', 'dimensions', 'primaryImage', 'additionalImages',
] as const;
const RETAILER_BASIC_FIELDS = new Set([
  'size', 'weight', 'dimensions', 'count', 'packCount', 'flavor', 'formula',
  'color', 'material', 'productForm', 'species', 'model', 'manufacturerPartNumber', 'unitOfMeasure',
]);
const RETAILER_SENSITIVE_FIELD = /(?:ingredient|nutrition|allergen|safety|warning|dose|dosage|medical|disease|health.?claim|claim|benefit|instruction|directions|guarantee|description|bullet|feature|image|photo|copy|prose|price|stock|inventory)/i;
const MULTIVALUE_FIELDS = new Set(['bulletPoints', 'additionalImages', 'image']);
const IMAGE_FIELD = /image|photo/i;
const COMMERCIAL_FIELD = /price|cost|stock|inventory|quantity|availability/i;
type OfficialProvenanceContract = Record<string, unknown>;

function verifiedOfficialProvenanceContract(
  owner: OwnerContext,
  extraction: OnboardingExtractionRow,
  payload: Record<string, unknown>,
  field: string,
): OfficialProvenanceContract | null {
  const provenance = ownObject(payload.fieldProvenance);
  const source = String(provenance?.[field] ?? '');
  if (DIRECT_EXTRACTION_PROVENANCE.has(source)) {
    return { field, source, extractionMethod: extraction.extraction_method };
  }
  if (source === 'custom-selector') {
    if (extraction.extraction_method !== 'worker_crawlee_camoufox' || !extraction.source_url) return null;
    let domain: string;
    try { domain = new URL(extraction.source_url).hostname; } catch { return null; }
    const profile = findProfileByDomain(domain);
    if (!profile) return null;
    const selector = field === 'title' ? profile.titleSelector
      : field === 'brand' ? profile.brandSelector
        : field === 'description' ? profile.descriptionSelector
          : field === 'primaryImage' || field === 'additionalImages' ? profile.imagesSelector
            : profile.customSelectors[field] ?? null;
    if (typeof selector !== 'string' || !selector.trim()) return null;
    return { field, source, profileId: profile.id, profileUpdatedAt: profile.updatedAt, selector };
  }
  if (source === 'variant-selected') {
    const selected = ownObject(payload.selectedVariant);
    const selectedKey = typeof selected?.selectedVariantKey === 'string'
      ? selected.selectedVariantKey
      : typeof selected?.variantKey === 'string' ? selected.variantKey : null;
    const matrixHash = typeof selected?.identityMatrixHash === 'string' ? selected.identityMatrixHash : null;
    const resolution = createVariantResolutionRepo(getDb()).getCurrentForItem(owner.item.id);
    if (!resolution || resolution.status !== 'selected' || resolution.selected_variant_key !== selectedKey ||
      resolution.identity_matrix_hash !== matrixHash || resolution.canonical_parent_key !== owner.item.sourceUrl) return null;
    return { field, source, resolutionId: resolution.id, selectedVariantKey: selectedKey, identityMatrixHash: matrixHash, sourceUrl: resolution.source_url };
  }
  return null;
}
const PRODUCT_AXIS_FIELDS = new Set([
  'title', 'size', 'weight', 'dimensions', 'count', 'packcount', 'casepack', 'flavor', 'formula',
  'color', 'material', 'productform', 'species', 'unitofmeasure',
]);

function structuredIdentityAxes(value: unknown): Array<{ field: string; value: string }> {
  const source = ownObject(value);
  if (!source) return [];
  const axes: Array<{ field: string; value: string }> = [];
  const add = (field: string, raw: unknown): void => {
    const normalizedField = ['name', 'productname'].includes(field.trim().toLowerCase()) ? 'title'
      : normalizeVariantAxis(field) ?? field.trim().toLowerCase().replace(/[\s_-]+/gu, '');
    if (!PRODUCT_AXIS_FIELDS.has(normalizedField)) return;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const entry of values) {
      if (typeof entry !== 'string' && typeof entry !== 'number') continue;
      const text = String(entry).trim();
      if (!text) continue;
      axes.push({
        field: normalizedField,
        value: ['count', 'packcount', 'casepack'].includes(normalizedField) && /^\d+(?:\.\d+)?$/u.test(text) ? `${text} ct` : text,
      });
    }
  };
  for (const [field, raw] of Object.entries(source)) {
    if (['variantAttributes', 'customVariantAxes', 'attributes'].includes(field)) {
      const nested = ownObject(raw);
      if (nested) for (const [axis, axisValue] of Object.entries(nested)) add(axis, axisValue);
      continue;
    }
    add(field, raw);
  }
  return axes;
}

export type ItemEvidenceReference = {
  kind: 'text_span';
  start: number;
  end: number;
} | {
  kind: 'json_pointer';
  pointer: string;
};

export interface ItemEvidenceContributionInput {
  workspaceId: string;
  itemId: string;
  /** Method is supplied only by a code-owned collector; it never grants source authority. */
  collectedVia: Extract<ItemEvidenceCollectionMethod, 'static_extraction' | 'rendered_browser' | 'ocr'>;
  sourceUrl: string;
  finalUrl: string | null;
  observedAt: string;
  expiresAt: string | null;
  contentType: 'text/plain' | 'application/json';
  /** Complete bounded retained source content, not a snippet or model summary. */
  content: string;
  /** Facts identify locations only; values, roles, hashes, identity and rights are server-derived. */
  facts: Array<{
    field: string;
    reference: ItemEvidenceReference;
    rightsApprovalId?: string | null;
  }>;
}

export interface ItemEvidenceResult {
  status: 'accepted' | 'unavailable' | 'conflict' | 'stale';
  evidence: AcceptedItemEvidence | null;
  findings: ItemEvidenceFinding[];
}

interface OwnerContext {
  item: OnboardingItemWithEntryPolicy;
  batchId: string;
  workspaceId: string;
  inputHash: string;
}

interface DerivedEvidence {
  observations: ItemEvidenceObservation[];
  candidateFacts: AcceptedItemFact[];
  facts: AcceptedItemFact[];
  submittedFactReferences: AcceptedItemEvidence['submittedFactReferences'];
  findings: ItemEvidenceFinding[];
  sourceState: unknown;
  authorityHashes: string[];
  producingRunId: string | null;
}

interface ContributionAuthority {
  role: Extract<ItemEvidenceSourceRole, 'manufacturer_official' | 'retailer_corroboration'>;
  authorityId: string;
  authorityHash: string;
  sourceUrl: string;
  finalUrl: string | null;
  officialDomains: string[];
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function ownObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return ownObject(JSON.parse(raw));
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function canonicalString(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function inputHashFor(item: OwnerContext['item'], workspaceId: string): string {
  return itemInputIdentityHash(workspaceId, item);
}

function loadOwner(workspaceId: string, itemId: string): OwnerContext | null {
  const item = findItemById(itemId);
  if (!item) return null;
  const batch = findBatchById(item.batchId);
  if (!batch || batch.workspaceId !== workspaceId || !item.upc.trim()) return null;
  const owner = { item, batchId: item.batchId, workspaceId, inputHash: '' };
  owner.inputHash = inputHashFor(item, workspaceId);
  return owner;
}

function finding(
  code: string,
  reason: string,
  field: string | null = null,
  observationId: string | null = null,
): ItemEvidenceFinding {
  return { code, reason, field, observationId };
}

function objectPointerSegments(pointer: string): string[] | null {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) return null;
  const encoded = pointer.slice(1).split('/');
  const segments: string[] = [];
  for (const part of encoded) {
    if (/~(?:[^01]|$)/u.test(part)) return null;
    segments.push(part.replace(/~1/g, '/').replace(/~0/g, '~'));
  }
  return segments;
}

function resolveOwnJsonPointer(value: unknown, pointer: string): unknown | undefined {
  const segments = objectPointerSegments(pointer);
  if (!segments) return undefined;
  let current = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) return undefined;
      const index = Number(segment);
      if (index >= current.length || !Object.prototype.hasOwnProperty.call(current, index)) return undefined;
      current = current[index];
      continue;
    }
    const object = ownObject(current);
    if (!object || !Object.prototype.hasOwnProperty.call(object, segment)) return undefined;
    current = object[segment];
  }
  return current;
}

function resolveReference(contentType: 'text/plain' | 'application/json', content: string, reference: ItemEvidenceReference): string | null {
  if (reference.kind === 'text_span') {
    if (!Number.isInteger(reference.start) || !Number.isInteger(reference.end) || reference.start < 0 || reference.end <= reference.start || reference.end > content.length) return null;
    return content.slice(reference.start, reference.end);
  }
  if (contentType !== 'application/json') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const resolved = resolveOwnJsonPointer(parsed, reference.pointer);
  return typeof resolved === 'string' ? resolved : null;
}

function observationId(prefix: string, authorityId: string, artifactHash: string): string {
  return `${prefix}_${hashText(`${authorityId}\0${artifactHash}`).slice(0, 32)}`;
}

function factId(observation: ItemEvidenceObservation, field: string, reference: ItemEvidenceReference, rawValue: string): string {
  return `fact_${hashText(`${observation.id}\0${field}\0${canonicalJsonStringify(reference)}\0${rawValue}`).slice(0, 32)}`;
}

function addFact(
  observation: ItemEvidenceObservation,
  facts: AcceptedItemFact[],
  findings: ItemEvidenceFinding[],
  input: { field: string; reference: ItemEvidenceReference; rights?: AcceptedItemFact['rights'] | null },
): void {
  const rawValue = resolveReference(observation.contentType, observation.content, input.reference);
  if (rawValue === null || !rawValue.trim()) {
    findings.push(finding('invalid_source_reference', 'The cited source location is absent, not an own property, or does not contain a non-empty string.', input.field, observation.id));
    return;
  }
  const value = canonicalString(rawValue);
  const unitMatch = /(?:^|\s)(fl\s?oz|oz|lbs?|pounds?|kg|g|ml|l|count|ct)\s*$/iu.exec(value);
  const unit = unitMatch ? unitMatch[1] : null;
  const normalization = value === rawValue ? 'verbatim' : 'whitespace';
  const candidate = {
    id: factId(observation, input.field, input.reference, rawValue),
    field: input.field,
    value,
    unit,
    observationId: observation.id,
    reference: input.reference,
    rawValue,
    normalization,
    valueHash: hashCanonicalJson({ value, unit }),
    rights: input.rights ?? null,
  };
  const parsed = AcceptedItemFactSchema.safeParse(candidate);
  if (!parsed.success) {
    findings.push(finding('invalid_fact', 'A retained source value does not meet the accepted-fact contract.', input.field, observation.id));
    return;
  }
  facts.push(parsed.data);
}

function createObservation(input: ItemEvidenceObservation): ItemEvidenceObservation | null {
  const parsed = ItemEvidenceObservationSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

function classifyStatus(facts: AcceptedItemFact[], findings: ItemEvidenceFinding[]): ItemEvidenceResult['status'] {
  if (findings.some((entry) => entry.code === 'hard_fact_conflict' || entry.code === 'identity_conflict')) return 'conflict';
  return facts.length ? 'accepted' : 'unavailable';
}

const MEASURED_CONFLICT_FIELDS = new Set(['weight', 'size', 'dimensions', 'unitofmeasure', 'casepack', 'packcount', 'count']);

function finalizeConflicts(facts: AcceptedItemFact[], findings: ItemEvidenceFinding[]): AcceptedItemFact[] {
  const valuesByField = new Map<string, Set<string>>();
  for (const fact of facts) {
    if (MULTIVALUE_FIELDS.has(fact.field)) continue;
    const quantityKey = MEASURED_CONFLICT_FIELDS.has(fact.field.toLowerCase())
      ? normalizedMeasuredQuantityKey(fact.value)
      : null;
    const assertionKey = quantityKey
      ? `quantity:${quantityKey}`
      : hashCanonicalJson({ value: canonicalString(fact.value).toLocaleLowerCase('en-US'), unit: fact.unit?.toLocaleLowerCase('en-US') ?? null });
    const values = valuesByField.get(fact.field) ?? new Set<string>();
    values.add(assertionKey);
    valuesByField.set(fact.field, values);
  }
  const conflictingFields = new Set<string>();
  for (const [field, values] of valuesByField) {
    if (values.size > 1) {
      conflictingFields.add(field);
      findings.push(finding('hard_fact_conflict', `Current eligible sources disagree on '${field}'; all competing facts for this field are quarantined.`, field));
    }
  }
  return facts.filter((fact) => !conflictingFields.has(fact.field));
}

function uniqueFindings(entries: ItemEvidenceFinding[]): ItemEvidenceFinding[] {
  const seen = new Set<string>();
  const result: ItemEvidenceFinding[] = [];
  for (const entry of entries) {
    const key = canonicalJsonStringify(entry);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(entry);
    }
  }
  return result;
}

function authorityAndIdentityForContribution(
  input: ItemEvidenceContributionInput,
  owner: OwnerContext,
  contentJson: unknown | null,
): { authority: ContributionAuthority | null; identity: ItemEvidenceObservation['identity'] | null; reason: ItemEvidenceFinding | null } {
  const now = Date.now();
  const observed = Date.parse(input.observedAt);
  const expires = input.expiresAt === null ? null : Date.parse(input.expiresAt);
  if (!Number.isFinite(observed) || observed > now + 5 * 60_000 || (input.expiresAt !== null && (!Number.isFinite(expires) || expires! <= observed || expires! <= now))) {
    return { authority: null, identity: null, reason: finding('observation_time_invalid', 'The collector observation time is invalid, in the future, or expired.') };
  }
  if (!input.content || Buffer.byteLength(input.content, 'utf8') > ITEM_EVIDENCE_MAX_CONTENT_BYTES) {
    return { authority: null, identity: null, reason: finding('observation_content_invalid', 'The complete retained source content is empty or exceeds the contract limit.') };
  }
  if (input.contentType === 'application/json' && contentJson === null) {
    return { authority: null, identity: null, reason: finding('observation_content_invalid', 'The retained JSON source content cannot be parsed.') };
  }

  let source: URL;
  let final: URL | null = null;
  try {
    source = new URL(input.sourceUrl);
    if (input.finalUrl !== null) final = new URL(input.finalUrl);
  } catch {
    return { authority: null, identity: null, reason: finding('source_url_invalid', 'The source or final URL is invalid.') };
  }
  if (![source, ...(final ? [final] : [])].every((url) => ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.port)) {
    return { authority: null, identity: null, reason: finding('source_url_invalid', 'Source references must be credential-free HTTP(S) URLs on standard ports.') };
  }

  let officialDomains: string[];
  try {
    officialDomains = getAllowedOfficialPageDomains({ workspaceId: owner.workspaceId, itemId: owner.item.id, brandHint: owner.item.brandHint ?? null });
  } catch {
    return { authority: null, identity: null, reason: finding('source_authority_unavailable', 'Current official-domain authority could not be loaded.') };
  }
  const sourceOfficial = isAuthorizedOfficialPageUrl(source.toString(), officialDomains);
  const finalOfficial = !final || isAuthorizedOfficialPageUrl(final.toString(), officialDomains);
  const sourceHost = source.hostname.toLowerCase().replace(/^www\./u, '');
  const finalHost = final?.hostname.toLowerCase().replace(/^www\./u, '') ?? sourceHost;
  let role: ContributionAuthority['role'];
  let authorityId: string;
  if (sourceOfficial && finalOfficial) {
    role = 'manufacturer_official';
    const matchingDomain = officialDomains.map((domain) => domain.toLowerCase().replace(/^www\./u, '')).find((domain) => sourceHost === domain || sourceHost.endsWith(`.${domain}`));
    if (!matchingDomain) return { authority: null, identity: null, reason: finding('source_authority_unavailable', 'The official source host is not in current approved authority.') };
    authorityId = `official-domain:${matchingDomain}`;
  } else if (
    !sourceOfficial && !finalOfficial &&
    isKnownRetailerOrDistributorDomain(sourceHost) && isKnownRetailerOrDistributorDomain(finalHost) && sourceHost === finalHost
  ) {
    role = 'retailer_corroboration';
    authorityId = `retailer-domain:${sourceHost}`;
  } else {
    return { authority: null, identity: null, reason: finding('source_authority_unavailable', 'The final source does not retain one current approved authority role; retailer or unapproved pages cannot be promoted to official.') };
  }

  const titleFact = input.facts.find((fact) => ['title', 'name'].includes(fact.field.toLowerCase()));
  if (!titleFact) return { authority: null, identity: null, reason: finding('identity_unavailable', 'An exact item contribution requires a directly cited product title.') };
  const pageName = resolveReference(input.contentType, input.content, titleFact.reference);
  if (!pageName || !pageName.trim()) return { authority: null, identity: null, reason: finding('identity_unavailable', 'The product title reference is not a retained source value.', titleFact.field) };
  const brandFact = input.facts.find((fact) => fact.field.toLowerCase() === 'brand');
  const pageBrand = brandFact ? resolveReference(input.contentType, input.content, brandFact.reference) : null;
  const gtinValues = input.facts
    .filter((fact) => ['upc', 'gtin', 'barcode'].includes(fact.field.toLowerCase()))
    .map((fact) => resolveReference(input.contentType, input.content, fact.reference))
    .filter(isNonEmptyString);
  const sourceContent = ownObject(contentJson);
  const declaredAxes = sourceContent ? structuredIdentityAxes({
    variantAttributes: sourceContent.variantAttributes,
    customVariantAxes: sourceContent.customVariantAxes,
    attributes: sourceContent.attributes,
  }) : [];
  const axisConflicts = findContradictoryProductAxes(owner.item.name, [
    ...declaredAxes,
    { field: titleFact.field, value: pageName },
  ]);
  if (axisConflicts.length) {
    return { authority: null, identity: null, reason: finding('identity_conflict', `Structured contribution axes contradict the imported item: ${axisConflicts.join('; ')}.`, titleFact.field) };
  }
  const identityMatch = matchOfficialPageIdentity({
    registerName: owner.item.name,
    registerUpc: owner.item.upc,
    brandHint: owner.item.brandHint ?? null,
    pageName,
    pageBrand,
    pageKind: 'product',
    variants: [],
    observedGtins: gtinValues,
  });
  if (identityMatch.outcome !== 'unique_name_variant_match') {
    const conflict = identityMatch.outcome === 'reject_conflict';
    return {
      authority: null,
      identity: null,
      reason: finding(conflict ? 'identity_conflict' : 'identity_unavailable', `Exact item and variant matching refused this contribution: ${identityMatch.reasons.join(', ') || identityMatch.outcome}.`, titleFact.field),
    };
  }
  const normalizedUpc = normalizeGtin(owner.item.upc);
  const matchingGtin = gtinValues.find((value) => normalizeGtin(value) === normalizedUpc);
  const inputHash = owner.inputHash;
  const artifactHash = hashText(input.content);
  const authorityHash = hashCanonicalJson({
    role,
    authorityId,
    sourceHost,
    finalHost,
    officialDomains: role === 'manufacturer_official' ? [...officialDomains].sort() : [],
    rulesVersion: ITEM_EVIDENCE_RULES_VERSION,
  });
  const authority: ContributionAuthority = {
    role,
    authorityId,
    authorityHash,
    sourceUrl: source.toString(),
    finalUrl: final?.toString() ?? null,
    officialDomains,
  };
  const identity: ItemEvidenceObservation['identity'] = {
    itemId: owner.item.id,
    sku: owner.item.upc,
    inputHash,
    outcome: 'confirmed',
    proofType: matchingGtin ? 'gtin' : 'name_variant',
    proofHash: hashCanonicalJson({
      itemId: owner.item.id,
      sku: owner.item.upc,
      inputHash,
      role,
      authorityId,
      artifactHash,
      titleReference: titleFact.reference,
      pageName,
      variantKey: identityMatch.variantKey,
    }),
    variantKey: identityMatch.variantKey,
    attestationId: null,
    reasons: [],
  };
  return { authority, identity, reason: null };
}

function fieldAllowedForRole(role: ItemEvidenceSourceRole, field: string): boolean {
  const lowered = field.toLowerCase();
  if (COMMERCIAL_FIELD.test(field)) return false;
  if (role === 'retailer_corroboration') {
    return RETAILER_BASIC_FIELDS.has(field) && !RETAILER_SENSITIVE_FIELD.test(field);
  }
  if (role === 'operator_attested' && field.toLowerCase() === 'manualreferenceurl') return false;
  return !RETAILER_SENSITIVE_FIELD.test(lowered) || role === 'manufacturer_official' || role === 'distributor_record' || role === 'operator_attested';
}

function imageRightsFromManual(
  row: ManualEvidenceAttestationRow,
  imageUrl: string,
): AcceptedItemFact['rights'] | null {
  try {
    const right = parseManualEvidenceImageRights(row).find((entry) => entry.imageUrl === imageUrl && entry.rightsAttested === true && entry.approvalOrigin === 'operator_review' && entry.attestedBy === row.operator_id);
    if (!right) return null;
    return {
      assetUrl: imageUrl,
      approvalId: row.attestation_id,
      authorityHash: hashCanonicalJson({
        attestationId: row.attestation_id,
        itemId: row.item_id,
        assetUrl: imageUrl,
        approvedBy: right.attestedBy,
        approvedAt: right.attestedAt,
        approvalOrigin: right.approvalOrigin,
      }),
      approvedBy: right.attestedBy,
      approvedAt: right.attestedAt,
    };
  } catch {
    return null;
  }
}

function rightsForContribution(
  workspaceId: string,
  itemId: string,
  approvalId: string | null | undefined,
  imageUrl: string,
): AcceptedItemFact['rights'] | null {
  if (!approvalId) return null;
  const row = getManualEvidenceAttestation(approvalId);
  if (!row || row.item_id !== itemId || row.superseded_at !== null) return null;
  const item = findItemById(itemId);
  const batch = item ? findBatchById(item.batchId) : null;
  if (!item || !batch || batch.workspaceId !== workspaceId || row.batch_id !== batch.id) return null;
  return imageRightsFromManual(row, imageUrl);
}

function isImageField(field: string): boolean {
  return IMAGE_FIELD.test(field);
}

function normalizeOfficialSource(
  owner: OwnerContext,
  extraction: OnboardingExtractionRow,
  observations: ItemEvidenceObservation[],
  facts: AcceptedItemFact[],
  findings: ItemEvidenceFinding[],
  sourceState: unknown[],
  authorityHashes: string[],
): boolean {
  if (owner.item.sourceType !== 'official_page' || extraction.source_type === 'distributor_record' || extraction.extraction_method === 'manual_evidence_v1' || !extraction.source_url || owner.item.sourceUrl !== extraction.source_url) return false;
  const decision = listOfficialPageDecisions(owner.item.id).find((entry) => entry.workspaceId === owner.workspaceId && entry.url === extraction.source_url);
  if (!decision || decision.itemId !== owner.item.id) {
    findings.push(finding('official_source_unavailable', 'No current workspace-owned official-page decision is bound to this extraction URL.'));
    sourceState.push({ kind: 'official_missing_decision', extractionId: extraction.id, sourceUrl: extraction.source_url });
    return false;
  }
  let domains: string[];
  try {
    domains = getAllowedOfficialPageDomains({ workspaceId: decision.workspaceId, itemId: owner.item.id, brandHint: owner.item.brandHint ?? null });
  } catch {
    findings.push(finding('source_authority_unavailable', 'Current official-domain authority could not be loaded.'));
    return false;
  }
  if (!isAuthorizedOfficialPageUrl(decision.url, domains)) {
    findings.push(finding('official_source_unapproved', 'The confirmed page no longer belongs to a currently approved manufacturer domain.'));
    sourceState.push({ kind: 'official_unapproved', decisionId: decision.id, url: decision.url, domains });
    return false;
  }
  const source = listSourcesByItem(owner.item.id).find((entry) => entry.url === decision.url && entry.isSelected && entry.discoveryRunId === decision.sourceRunId);
  if (!source || !decision.sourceRunId || extraction.source_url !== decision.url) {
    findings.push(finding('official_source_stale', 'The selected source or discovery-run binding no longer matches the confirmed official page.'));
    sourceState.push({ kind: 'official_stale', decisionId: decision.id, sourceId: source?.id ?? null });
    return false;
  }
  const signals = parseObject(decision.identitySignalsJson);
  const signalTitle = typeof signals?.pageTitle === 'string' ? signals.pageTitle : decision.pageTitle;
  const isProduct = signals?.isProductDetailPage === true;
  const observedGtins = Array.isArray(signals?.observedGtins)
    ? signals!.observedGtins.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
      .map((entry) => typeof entry.gtin === 'string' ? entry.gtin : null)
      .filter(isNonEmptyString)
    : [];
  const identityMatch = matchOfficialPageIdentity({
    registerName: owner.item.name,
    registerUpc: owner.item.upc,
    brandHint: owner.item.brandHint ?? null,
    pageName: signalTitle,
    pageBrand: typeof signals?.brand === 'string' ? signals.brand : null,
    pageKind: isProduct ? 'product' : 'listing',
    variants: [],
    observedGtins,
  });
  const exactGtin = observedGtins.some((value) => normalizeGtin(value) === normalizeGtin(owner.item.upc));
  if (identityMatch.outcome !== 'unique_name_variant_match' || (decision.evidenceKind === 'observed_gtin' && !exactGtin)) {
    const conflict = identityMatch.outcome === 'reject_conflict' || (decision.evidenceKind === 'observed_gtin' && observedGtins.length > 0 && !exactGtin);
    findings.push(finding(conflict ? 'identity_conflict' : 'official_identity_unavailable', `The persisted official identity receipt does not establish the current exact item and variant: ${identityMatch.reasons.join(', ') || 'missing exact GTIN'}.`));
    sourceState.push({ kind: 'official_identity_refused', decisionId: decision.id, identityMatch, observedGtins });
    return false;
  }
  const payload = parseObject(extraction.extraction_data_json);
  const itemPayload = ownObject(owner.item.extractionData);
  if (!payload || !itemPayload || hashCanonicalJson(payload) !== hashCanonicalJson(itemPayload)) {
    findings.push(finding('official_extraction_stale', 'The extraction record and current item payload do not match.'));
    sourceState.push({ kind: 'official_extraction_mismatch', extractionId: extraction.id });
    return false;
  }
  const parsedExtraction = ExtractionDataSchema.safeParse(payload);
  const payloadProvenance = ownObject(payload.fieldProvenance);
  const structuredProvenance = parseObject(extraction.raw_structured_data_json);
  if (!parsedExtraction.success || !payloadProvenance || !structuredProvenance || hashCanonicalJson(payloadProvenance) !== hashCanonicalJson(structuredProvenance)) {
    findings.push(finding('official_provenance_unavailable', 'The official extraction has no intact direct-source field provenance.'));
    sourceState.push({ kind: 'official_provenance_invalid', extractionId: extraction.id, rawStructuredDataJson: extraction.raw_structured_data_json });
    return false;
  }
  const extractedData = payload;
  const provenanceContracts: OfficialProvenanceContract[] = [];
  const titleContract = verifiedOfficialProvenanceContract(owner, extraction, payload, 'title');
  if (!titleContract) {
    findings.push(finding('official_identity_unavailable', 'The current extracted item title has no verifiable direct-source, configured-selector, or selected-variant contract.'));
    sourceState.push({ kind: 'official_extracted_title_untrusted', extractionId: extraction.id, provenance: payloadProvenance.title ?? null });
    return false;
  }
  provenanceContracts.push(titleContract);
  const extractedTitle = typeof extractedData.title === 'string' ? extractedData.title : '';
  const brandContract = verifiedOfficialProvenanceContract(owner, extraction, payload, 'brand');
  const extractedBrand = brandContract && typeof extractedData.brand === 'string'
    ? extractedData.brand
    : typeof signals?.brand === 'string' ? signals.brand : null;
  if (brandContract) provenanceContracts.push(brandContract);
  const variantAttributesContract = verifiedOfficialProvenanceContract(owner, extraction, payload, 'variantAttributes');
  const extractedVariantAttributes = variantAttributesContract ? ownObject(extractedData.variantAttributes) : null;
  if (variantAttributesContract) provenanceContracts.push(variantAttributesContract);
  const axisPayload: Record<string, unknown> = { title: extractedTitle };
  for (const field of ['size', 'weight', 'dimensions', 'count', 'packCount', 'casePack', 'flavor', 'formula', 'color', 'material', 'productForm', 'species', 'unitOfMeasure']) {
    const contract = verifiedOfficialProvenanceContract(owner, extraction, payload, field);
    if (!contract) continue;
    axisPayload[field] = payload[field];
    provenanceContracts.push(contract);
  }
  if (variantAttributesContract) axisPayload.variantAttributes = extractedVariantAttributes;
  const axisConflicts = findContradictoryProductAxes(owner.item.name, structuredIdentityAxes(axisPayload));
  if (axisConflicts.length) {
    findings.push(finding('identity_conflict', `Structured extracted variant axes contradict the imported item: ${axisConflicts.join('; ')}.`));
    sourceState.push({ kind: 'official_extracted_axes_conflict', extractionId: extraction.id, axisConflicts });
    return false;
  }
  const extractedVariantLabel = extractedVariantAttributes
    ? Object.values(extractedVariantAttributes).filter((value): value is string => typeof value === 'string').join(' ')
    : '';
  
  const extractedIdentityMatch = matchOfficialPageIdentity({
    registerName: owner.item.name,
    registerUpc: owner.item.upc,
    brandHint: owner.item.brandHint ?? null,
    pageName: extractedTitle,
    pageBrand: extractedBrand ?? (typeof signals?.brand === 'string' ? signals.brand : null),
    pageKind: 'product',
    variants: extractedVariantLabel ? [{ key: decision.variantKey ?? 'extracted-variant', label: extractedVariantLabel }] : [],
    observedGtins,
  });
  const selectedVariant = ownObject(extractedData?.selectedVariant) ?? ownObject(payload.selectedVariant);
  const extractedVariantKey = typeof selectedVariant?.selectedVariantKey === 'string'
    ? selectedVariant.selectedVariantKey
    : typeof selectedVariant?.variantKey === 'string' ? selectedVariant.variantKey : null;
  const selectedVariantMismatch = decision.variantKey !== null && decision.variantKey !== undefined && extractedVariantKey !== decision.variantKey;
  if (extractedIdentityMatch.outcome !== 'unique_name_variant_match' || selectedVariantMismatch) {
    const conflict = extractedIdentityMatch.outcome === 'reject_conflict' || selectedVariantMismatch;
    const reason = selectedVariantMismatch
      ? `confirmed variant ${decision.variantKey} differs from extracted variant ${extractedVariantKey ?? 'missing'}`
      : extractedIdentityMatch.reasons.join(', ') || 'missing exact item identity';
    findings.push(finding(conflict ? 'identity_conflict' : 'official_identity_unavailable', `The current extraction title and variant do not match the imported item: ${reason}.`));
    sourceState.push({ kind: 'official_extracted_identity_refused', extractionId: extraction.id, extractedIdentityMatch, selectedVariantMismatch, extractedVariantKey });
    return false;
  }
  const prior = listItemEvidenceSnapshots(owner.workspaceId, owner.item.id)
    .flatMap((snapshot) => snapshot.observations)
    .find((entry) => entry.authorityId === decision.id && entry.sourceRole === 'manufacturer_official');
  if (prior && prior.identity.inputHash !== owner.inputHash) {
    findings.push(finding('official_identity_stale', 'This official decision was already bound to a different imported identity; a fresh decision is required.'));
    sourceState.push({ kind: 'official_input_stale', decisionId: decision.id, priorInputHash: prior.identity.inputHash });
    return false;
  }

  const signalSnapshot = {
    id: decision.id,
    workspaceId: decision.workspaceId,
    itemId: decision.itemId,
    url: decision.url,
    candidateOrigin: decision.candidateOrigin,
    evidenceKind: decision.evidenceKind,
    pageTitle: decision.pageTitle,
    variantKey: decision.variantKey,
    identitySignals: signals,
    sourceRunId: decision.sourceRunId,
    decidedAt: decision.decidedAt,
  };
  const sourceSnapshot = {
    id: source.id,
    url: source.url,
    title: source.title,
    domain: source.domain,
    sourceMethod: source.sourceMethod,
    discoveryRunId: source.discoveryRunId,
  };
  const content = canonicalJsonStringify({
    officialDecision: signalSnapshot,
    selectedSource: sourceSnapshot,
    extractionData: payload,
    fieldProvenance: structuredProvenance,
  });
  const artifactHash = hashText(content);
  const originalUrl = typeof signals?.originalUrl === 'string' ? signals.originalUrl : source.url;
  const finalUrl = typeof signals?.finalUrl === 'string' ? signals.finalUrl : decision.url;
  if (!isAuthorizedOfficialPageUrl(originalUrl, domains) || !isAuthorizedOfficialPageUrl(finalUrl, domains)) {
    findings.push(finding('official_redirect_unapproved', 'The retained original or final official-page URL no longer belongs to a currently approved manufacturer domain.'));
    sourceState.push({ kind: 'official_redirect_unapproved', decisionId: decision.id, originalUrl, finalUrl });
    return false;
  }
  const authorityHash = hashCanonicalJson({
    sourceRole: 'manufacturer_official',
    decisionId: decision.id,
    sourceRunId: decision.sourceRunId,
    sourceMethod: source.sourceMethod,
    domains: [...domains].sort(),
    url: decision.url,
    rulesVersion: ITEM_EVIDENCE_RULES_VERSION,
  });
  const id = observationId('official', decision.id, artifactHash);
  const identity: ItemEvidenceObservation['identity'] = {
    itemId: owner.item.id,
    sku: owner.item.upc,
    inputHash: owner.inputHash,
    outcome: 'confirmed',
    proofType: exactGtin ? 'gtin' : 'name_variant',
    proofHash: hashCanonicalJson({
      itemId: owner.item.id,
      sku: owner.item.upc,
      inputHash: owner.inputHash,
      decisionId: decision.id,
      evidenceKind: decision.evidenceKind,
      identityMatch,
      extractedIdentityMatch,
      extractedVariantKey,
      observedGtins,
    }),
    variantKey: decision.variantKey ?? identityMatch.variantKey,
    attestationId: null,
    reasons: [],
  };
  const observation = createObservation({
    id,
    sourceRole: 'manufacturer_official',
    collectedVia: 'static_extraction',
    authorityId: decision.id,
    authorityHash,
    sourceUrl: originalUrl,
    finalUrl,
    connectorRecordId: null,
    generationId: null,
    observedAt: decision.decidedAt,
    expiresAt: null,
    contentType: 'application/json',
    content,
    artifactHash,
    complete: true,
    identity,
    modelCallIds: [],
  });
  if (!observation) {
    findings.push(finding('official_observation_invalid', 'The retained official extraction cannot be represented as a complete observation.'));
    return false;
  }
  observations.push(observation);
  authorityHashes.push(authorityHash);
  sourceState.push({ kind: 'official', decision: signalSnapshot, source: sourceSnapshot, extractionId: extraction.id, artifactHash, rawProvenance: structuredProvenance, provenanceContracts });

  const addOfficial = (field: string, pointer: string, rights: AcceptedItemFact['rights'] | null = null): void => {
    const sourceField = field === 'title' ? 'title' : field;
    const contract = verifiedOfficialProvenanceContract(owner, extraction, payload, sourceField);
    if (!fieldAllowedForRole('manufacturer_official', field) || !contract) return;
    provenanceContracts.push(contract);
    const reference: ItemEvidenceReference = { kind: 'json_pointer', pointer };
    if (isImageField(field) && !rights) {
      findings.push(finding('rights_missing', 'Official image observations are not accepted without a current asset-specific rights approval.', field, observation.id));
      return;
    }
    addFact(observation, facts, findings, { field, reference, rights });
  };
  addOfficial('title', '/extractionData/title');
  addOfficial('brand', '/extractionData/brand');
  addOfficial('description', '/extractionData/description');
  addOfficial('weight', '/extractionData/weight');
  addOfficial('dimensions', '/extractionData/dimensions');
  const bulletPointsContract = verifiedOfficialProvenanceContract(owner, extraction, payload, 'bulletPoints');
  if (Array.isArray(payload.bulletPoints) && bulletPointsContract) {
    provenanceContracts.push(bulletPointsContract);
    payload.bulletPoints.forEach((_, index) => addFact(observation, facts, findings, {
      field: 'bulletPoints', reference: { kind: 'json_pointer', pointer: `/extractionData/bulletPoints/${index}` },
    }));
  }
  const variantAttributes = extractedVariantAttributes;
  if (variantAttributes && variantAttributesContract) {
    provenanceContracts.push(variantAttributesContract);
    for (const field of Object.keys(variantAttributes).sort()) {
      if (!fieldAllowedForRole('manufacturer_official', field)) continue;
      if (isImageField(field)) {
        findings.push(finding('rights_missing', 'Official image observations are not accepted without a current asset-specific rights approval.', field, observation.id));
        continue;
      }
      addFact(observation, facts, findings, {
        field,
        reference: { kind: 'json_pointer', pointer: `/extractionData/variantAttributes/${field.replace(/~/g, '~0').replace(/\//g, '~1')}` },
      });
    }
  }
  if (!facts.length) findings.push(finding('official_facts_unavailable', 'The current official extraction contains no directly sourced, retained eligible facts.', null, observation.id));
  return true;
}

function currentDistributorProjection(owner: OwnerContext, extraction: OnboardingExtractionRow): {
  valid: boolean;
  attempts: EvidenceAttempt[];
  projection: Record<string, unknown> | null;
  authorityByAttempt: Map<string, { authorityHash: string; connectionId: string }>;
  sourceState: unknown;
  finding: ItemEvidenceFinding | null;
} {
  const refusal = (code: string, reason: string, sourceState: unknown = null) => ({
    valid: false, attempts: [] as EvidenceAttempt[], projection: null,
    authorityByAttempt: new Map<string, { authorityHash: string; connectionId: string }>(),
    sourceState, finding: finding(code, reason),
  });
  const decision = SourcingDecisionV2Schema.safeParse(owner.item.sourcingDecision);
  if (!decision.success || (decision.data.route !== 'distributor_record_to_extraction' && decision.data.route !== 'completed_strategy_collection')) return refusal('distributor_decision_unavailable', 'The item has no current schema-valid distributor materialization decision.');
  const isStrategyCollection = decision.data.route === 'completed_strategy_collection';
  const generation = getCurrentSourcingGeneration(owner.item.id);
  if (!generation || generation.status === 'superseded' || generation.id !== decision.data.sourcingGenerationId || extraction.sourcing_generation_id !== generation.id) {
    return refusal('distributor_generation_stale', 'The materialized distributor source is not bound to the current sourcing generation.', generation);
  }
  const acceptedIds = getCurrentGenerationAcceptedAttemptIds(owner.item.id);
  if (acceptedIds.length !== decision.data.acceptedEvidenceAttemptIds.length || acceptedIds.some((id) => !decision.data.acceptedEvidenceAttemptIds.includes(id)) || decision.data.acceptedEvidenceAttemptIds.some((id) => !acceptedIds.includes(id))) {
    return refusal('distributor_acceptance_stale', 'The current relational accepted-attempt set differs from the materialized decision.', { generation, acceptedIds });
  }
  if (listCurrentGenerationConflictsForItem(owner.item.id, 'open').some((entry) => entry.severity === 'hard')) {
    return refusal('distributor_conflict_open', 'A hard conflict is still open in the current distributor generation.', { generation, acceptedIds });
  }
  let strategyCollection: { envelope: StrategyCollectionResult; hash: string } | null = null;
  let distributorAttemptIds = decision.data.acceptedEvidenceAttemptIds;
  if (isStrategyCollection) {
    try {
      strategyCollection = getStrategyCollectionResult(generation.id);
    } catch (error) {
      const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
      return refusal('distributor_strategy_collection_unavailable', `The current strategy collection could not be validated${code ? ` (${code})` : ''}: ${String(error)}.`, { generation, acceptedIds });
    }
    if (strategyCollection.hash !== decision.data.evidenceHash || strategyCollection.envelope.identityConflict) {
      return refusal('distributor_strategy_collection_unavailable', 'The current strategy collection is missing, conflicting, or not bound to the sourcing decision.', { generation, acceptedIds });
    }
    distributorAttemptIds = [...new Set(strategyCollection.envelope.contributions
      .filter((contribution) => contribution.kind === 'distributor_record' && contribution.outcome === 'success')
      .flatMap((contribution) => contribution.attemptIds))].sort();
    if (!distributorAttemptIds.length || distributorAttemptIds.some((id) => !decision.data.acceptedEvidenceAttemptIds.includes(id))) {
      return refusal('distributor_strategy_collection_unavailable', 'The strategy collection has no accepted distributor attempts.', { generation, acceptedIds });
    }
  }
  const attempts = getEvidenceAttemptsByItemAndGeneration(owner.item.id, generation.id);
  const attemptById = new Map(attempts.map((entry) => [entry.id, entry]));
  const authorityByAttempt = new Map<string, { authorityHash: string; connectionId: string }>();
  const currentTime = Date.now();
  for (const attemptId of distributorAttemptIds) {
    const attempt = attemptById.get(attemptId);
    if (!attempt || !EvidenceAttemptSchema.safeParse(attempt).success || attempt.outcome !== 'found' || attempt.itemId !== owner.item.id || !attempt.lookupUpc || normalizeGtin(attempt.lookupUpc) !== normalizeGtin(owner.item.upc) || !attempt.identityJson || !attempt.distributorConnectionId || !attempt.observedAt || !attempt.sourcingGenerationId || (attempt.expiresAt != null && Date.parse(attempt.expiresAt) <= currentTime)) {
      return refusal('distributor_attempt_invalid', 'A current accepted distributor attempt is missing, expired, cross-item, malformed, or bound to a different UPC.', { generation, acceptedIds, attemptId });
    }
    const connection = getConnectionById(attempt.distributorConnectionId);
    const distributor = connection ? getDistributorById(connection.distributorId) : null;
    const batch = findBatchById(owner.item.batchId);
    if (!connection || !batch || connection.workspaceId !== batch.workspaceId || !distributor || distributor.status !== 'active' || !connection.enabled || connection.authorityPolicy.skuAuthority !== true) {
      return refusal('distributor_authority_unavailable', 'The accepted distributor connection is not currently enabled and authorized for this workspace.', { generation, acceptedIds, attemptId, connectionId: attempt.distributorConnectionId });
    }
    authorityByAttempt.set(attemptId, {
      connectionId: connection.id,
      authorityHash: hashCanonicalJson({
        role: 'distributor_record',
        distributorId: connection.distributorId,
        distributorStatus: distributor.status,
        connectionId: connection.id,
        connectorType: connection.connectorType,
        enabled: connection.enabled,
        authorityPolicy: connection.authorityPolicy,
        providerId: attempt.providerId,
        catalogVersion: attempt.catalogVersion,
      }),
    });
  }
  const projectionInput = {
    itemId: owner.item.id,
    itemUpc: owner.item.upc,
    sourcingGenerationId: generation.id,
    attempts,
    acceptedAttemptIds: distributorAttemptIds,
    declaredVariantAxes: Array.from(new Set(attempts.flatMap((entry) => (entry.variantAxisDeclarations ?? []).map((axis) => axis.normalizedAxis)))),
    resolutions: listResolvedConflictResolutions(owner.item.id),
  };
  const v2 = buildDistributorRecordProjection(projectionInput);
  if (!v2.qualified || (!isStrategyCollection && extraction.extraction_method === 'distributor_record_v2' && v2.evidenceHash !== decision.data.evidenceHash)) {
    return refusal('distributor_projection_stale', 'The current source records no longer reproduce the distributor decision hash.', { generation, acceptedIds, expectedHash: decision.data.evidenceHash, projectedHash: v2.qualified ? v2.evidenceHash : null });
  }
  const v1 = isStrategyCollection ? null : buildDistributorRecordProjectionV1(projectionInput);
  const selectedProjection = isStrategyCollection
    ? v2.projection
    : extraction.extraction_method === 'distributor_record_v1' && v1?.qualified && v1.evidenceHash === decision.data.evidenceHash
      ? v1.projection
      : v2.projection;
  const expectedMethod = isStrategyCollection ? 'strategy_collection_v1'
    : extraction.extraction_method === 'distributor_record_v1' || extraction.extraction_method === 'distributor_record_v2'
      ? extraction.extraction_method
      : null;
  if (!expectedMethod || selectedProjection.version !== (expectedMethod === 'distributor_record_v1' ? 'distributor-record-projection-v1' : 'distributor-record-projection-v2') || extraction.extraction_method !== expectedMethod || extraction.source_type !== 'distributor_record' || extraction.source_url !== null || owner.item.sourceUrl !== null || extraction.evidence_hash !== decision.data.evidenceHash) {
    return refusal('distributor_row_invalid', 'The persisted distributor extraction row is not an immutable URL-null current materialization.', { generation, acceptedIds, extractionMethod: extraction.extraction_method });
  }
  let storedPayload: Record<string, unknown> | null;
  try { storedPayload = ownObject(JSON.parse(extraction.extraction_data_json)); } catch { storedPayload = null; }
  let expectedPayload: Record<string, unknown> | null;
  if (isStrategyCollection) {
    if (!strategyCollection) return refusal('distributor_strategy_collection_unavailable', 'The current strategy collection could not be validated.', { generation, acceptedIds });
    expectedPayload = reconstructStrategyCollectionExtractionPayload({
      itemName: owner.item.name ?? null,
      brandHint: owner.item.brandHint ?? null,
      generationId: generation.id,
      acceptedAttemptIds: decision.data.acceptedEvidenceAttemptIds,
      envelope: strategyCollection.envelope,
      evidenceHash: decision.data.evidenceHash,
    });
  } else {
    expectedPayload = reconstructDistributorExtractionPayload(selectedProjection, decision.data.evidenceHash, attempts);
  }
  const itemPayload = ownObject(owner.item.extractionData);
  if (!storedPayload || !expectedPayload || !itemPayload || !payloadsEquivalentForDistributorRecord(storedPayload, expectedPayload) || !payloadsEquivalentForDistributorRecord(itemPayload, expectedPayload)) {
    return refusal('distributor_payload_diverged', 'The persisted URL-null distributor materialization no longer equals its recomputed current projection.', { generation, acceptedIds, extractionId: extraction.id });
  }
  const projectionRecord = (selectedProjection as unknown as Record<string, unknown>);
  const variantValues = ownObject(projectionRecord.customVariantAxes) ?? {};
  const variantAttributes = [
    'size', 'count', 'packCount', 'flavor', 'formula',
  ].map((key) => projectionRecord[key]).filter(isNonEmptyString);
  for (const value of Object.values(variantValues)) if (isNonEmptyString(value)) variantAttributes.push(value);
  const variantLabel = variantAttributes.join(' ');
  const title = String(projectionRecord.name ?? '');
  const nameMatch = matchOfficialPageIdentity({
    registerName: owner.item.name,
    registerUpc: owner.item.upc,
    brandHint: owner.item.brandHint ?? null,
    pageName: title,
    pageBrand: isNonEmptyString(projectionRecord.brand) ? String(projectionRecord.brand) : null,
    pageKind: 'product',
    variants: variantLabel ? [{ key: generation.id, label: variantLabel, gtin: String(projectionRecord.upc ?? '') }] : [],
    observedGtins: [String(projectionRecord.upc ?? '')],
  });
  const exactGtin = isNonEmptyString(projectionRecord.upc) &&
    normalizeGtin(String(projectionRecord.upc)) === normalizeGtin(owner.item.upc);
  const identityEstablished = owner.item.name.trim()
    ? nameMatch.outcome === 'unique_name_variant_match'
    : exactGtin && nameMatch.outcome !== 'reject_conflict';
  if (!identityEstablished) {
    return refusal(nameMatch.outcome === 'reject_conflict' ? 'identity_conflict' : 'distributor_variant_unavailable', `Distributor evidence does not establish the current exact item variant: ${nameMatch.reasons.join(', ') || nameMatch.outcome}.`, { generation, acceptedIds, nameMatch });
  }
  return {
    valid: true,
    attempts,
    projection: selectedProjection as unknown as Record<string, unknown>,
    authorityByAttempt,
    sourceState: { generation, decision: decision.data, acceptedIds, projectionHash: decision.data.evidenceHash, attemptHashes: attempts.map((attempt) => ({ id: attempt.id, identityHash: attempt.identityJson ? hashText(attempt.identityJson) : null, observedAt: attempt.observedAt, expiresAt: attempt.expiresAt })), authorityByAttempt: [...authorityByAttempt.entries()] },
    finding: null,
  };
}

function getDistributorAttemptValue(
  identity: Record<string, unknown>,
  field: string,
  attempt: EvidenceAttempt,
): Array<{ reference: ItemEvidenceReference; rawValue: string }> {
  const output: Array<{ reference: ItemEvidenceReference; rawValue: string }> = [];
  if (field === 'features') {
    if (Array.isArray(identity.features)) identity.features.forEach((value, index) => {
      if (isNonEmptyString(value)) output.push({ reference: { kind: 'json_pointer', pointer: `/features/${index}` }, rawValue: value });
    });
    return output;
  }
  if (field === 'size' || field === 'count' || field === 'packCount' || field === 'flavor' || field === 'formula' || (attempt.variantAxisDeclarations ?? []).some((axis) => axis.normalizedAxis === field)) {
    const attributes = ownObject(identity.attributes) ?? {};
    for (const [rawKey, value] of Object.entries(attributes)) {
      const declared = (attempt.variantAxisDeclarations ?? []).some((axis) => axis.rawField === rawKey && axis.normalizedAxis === field);
      if ((declared || normalizeVariantAxis(rawKey) === field) && isNonEmptyString(value)) {
        output.push({ reference: { kind: 'json_pointer', pointer: `/attributes/${rawKey.replace(/~/g, '~0').replace(/\//g, '~1')}` }, rawValue: value });
      }
    }
    if (field === 'packCount' && output.length === 0 && isNonEmptyString(identity.casePack) && /^\d+$/u.test(identity.casePack.trim())) {
      output.push({ reference: { kind: 'json_pointer', pointer: '/casePack' }, rawValue: identity.casePack });
    }
    return output;
  }
  const value = identity[field];
  if (isNonEmptyString(value)) output.push({ reference: { kind: 'json_pointer', pointer: `/${field.replace(/~/g, '~0').replace(/\//g, '~1')}` }, rawValue: value });
  return output;
}

function projectionValues(projection: Record<string, unknown>, field: string): string[] {
  if (field === 'features') return Array.isArray(projection.features) ? projection.features.filter(isNonEmptyString) : [];
  if (field === 'imageUrls') return Array.isArray(projection.imageUrls) ? projection.imageUrls.filter(isNonEmptyString) : [];
  const axes = ownObject(projection.customVariantAxes);
  if (axes && Object.prototype.hasOwnProperty.call(axes, field)) {
    return isNonEmptyString(axes[field]) ? [axes[field] as string] : [];
  }
  if (field === 'customVariantAxes') {
    return axes ? Object.values(axes).filter(isNonEmptyString) : [];
  }
  const value = projection[field];
  return isNonEmptyString(value) ? [value] : [];
}

function addDistributorFacts(
  observation: ItemEvidenceObservation,
  attempt: EvidenceAttempt,
  projection: Record<string, unknown>,
  facts: AcceptedItemFact[],
  findings: ItemEvidenceFinding[],
): void {
  const identity = parseObject(attempt.identityJson);
  const parsedIdentity = identity ? ProductIdentityEvidenceSchema.safeParse(identity) : null;
  const provenance = ownObject(projection.provenance);
  const fieldProvenance = ownObject(provenance?.fieldProvenance);
  if (!identity || !parsedIdentity?.success || !fieldProvenance) return;
  const fieldNames = [
    'name', 'brand', 'weight', 'size', 'count', 'packCount', 'flavor', 'formula', 'manufacturerPartNumber',
    'description', 'category', 'dimensions', 'casePack', 'unitOfMeasure', 'ingredients', 'features', 'imageUrls',
    ...Object.keys(ownObject(projection.customVariantAxes) ?? {}),
  ];
  for (const sourceField of [...new Set(fieldNames)]) {
    const provenanceEntries = fieldProvenance[sourceField];
    if (!Array.isArray(provenanceEntries) || !provenanceEntries.some((entry) => ownObject(entry)?.attemptId === attempt.id)) continue;
    const allowedValues = projectionValues(projection, sourceField).map(canonicalString);
    const sourceValues = getDistributorAttemptValue(identity, sourceField, attempt);
    for (const sourceValue of sourceValues) {
      const normalized = canonicalString(sourceValue.rawValue);
      if (!allowedValues.includes(normalized)) continue;
      const field = sourceField === 'name' ? 'title'
        : sourceField === 'category' ? 'distributorCategory'
          : sourceField === 'features' ? 'bulletPoints'
            : sourceField === 'imageUrls' ? 'image'
              : sourceField;
      if (isImageField(field)) {
        findings.push(finding('rights_missing', 'Distributor image candidates remain unavailable until a current asset-specific rights receipt is bound.', field, observation.id));
        continue;
      }
      if (!fieldAllowedForRole('distributor_record', field)) continue;
      addFact(observation, facts, findings, { field, reference: sourceValue.reference });
    }
  }
}

function normalizeDistributorSource(
  owner: OwnerContext,
  extraction: OnboardingExtractionRow,
  observations: ItemEvidenceObservation[],
  facts: AcceptedItemFact[],
  findings: ItemEvidenceFinding[],
  sourceState: unknown[],
  authorityHashes: string[],
): boolean {
  if (owner.item.sourceType !== 'distributor_record' || extraction.source_type !== 'distributor_record') return false;
  const state = currentDistributorProjection(owner, extraction);
  if (!state.valid || !state.projection) {
    if (state.finding) findings.push(state.finding);
    sourceState.push({ kind: 'distributor_refused', sourceState: state.sourceState });
    return false;
  }
  const projection = state.projection;
  const distributorAxisConflicts = findContradictoryProductAxes(owner.item.name, structuredIdentityAxes(projection));
  if (distributorAxisConflicts.length) {
    findings.push(finding('identity_conflict', `Distributor structured variant axes contradict the imported item: ${distributorAxisConflicts.join('; ')}.`));
    sourceState.push({ kind: 'distributor_axes_conflict', generationId: extraction.sourcing_generation_id, distributorAxisConflicts });
    return false;
  }
  const identity = {
    itemId: owner.item.id,
    sku: owner.item.upc,
    inputHash: owner.inputHash,
    outcome: 'confirmed' as const,
    proofType: 'gtin' as const,
    proofHash: hashCanonicalJson({ itemId: owner.item.id, sku: owner.item.upc, inputHash: owner.inputHash, projectionHash: (projection.provenance as Record<string, unknown> | undefined)?.sourcingGenerationId, evidenceHash: extraction.evidence_hash, generationId: extraction.sourcing_generation_id }),
    variantKey: extraction.sourcing_generation_id,
    attestationId: null,
    reasons: [],
  };
  for (const attemptId of (projection.provenance as { acceptedAttemptIds?: string[] }).acceptedAttemptIds ?? []) {
    const attempt = state.attempts.find((entry) => entry.id === attemptId);
    const authority = state.authorityByAttempt.get(attemptId);
    if (!attempt || !authority || !attempt.identityJson || !attempt.sourcingGenerationId || !attempt.observedAt) continue;
    const artifactHash = hashText(attempt.identityJson);
    const observation = createObservation({
      id: observationId('distributor', attempt.id, artifactHash),
      sourceRole: 'distributor_record',
      collectedVia: 'structured',
      authorityId: attempt.providerId,
      authorityHash: authority.authorityHash,
      sourceUrl: attempt.evidenceUrl ?? null,
      finalUrl: null,
      connectorRecordId: attempt.id,
      generationId: attempt.sourcingGenerationId,
      observedAt: attempt.observedAt,
      expiresAt: attempt.expiresAt ?? null,
      contentType: 'application/json',
      content: attempt.identityJson,
      artifactHash,
      complete: true,
      identity,
      modelCallIds: [],
    });
    if (!observation) {
      findings.push(finding('distributor_observation_invalid', 'A complete normalized distributor record cannot be represented under the evidence contract.', null, null));
      sourceState.push({ kind: 'distributor_observation_invalid', attemptId });
      return false;
    }
    observations.push(observation);
    authorityHashes.push(authority.authorityHash);
    addDistributorFacts(observation, attempt, projection, facts, findings);
  }
  sourceState.push({ kind: 'distributor', state: state.sourceState, extractionId: extraction.id, extractionMethod: extraction.extraction_method, payloadHash: hashText(extraction.extraction_data_json) });
  return observations.some((entry) => entry.sourceRole === 'distributor_record');
}

function addManualFacts(
  row: ManualEvidenceAttestationRow,
  observation: ItemEvidenceObservation,
  extractionPayload: Record<string, unknown>,
  facts: AcceptedItemFact[],
  findings: ItemEvidenceFinding[],
): void {
  const fieldProvenance = ownObject(extractionPayload.fieldProvenance);
  const checklist = parseObject(row.field_checklist_json);
  const payload = ownObject(extractionPayload.extractionData);
  if (!fieldProvenance || !checklist || !payload) return;
  const addManualField = (field: string, pointer: string): void => {
    if (fieldProvenance[field] !== 'user' || !Object.prototype.hasOwnProperty.call(checklist, field)) return;
    const reference: ItemEvidenceReference = { kind: 'json_pointer', pointer };
    const rawValue = resolveReference(observation.contentType, observation.content, reference);
    if (rawValue === null) return;
    const rights = isImageField(field) ? imageRightsFromManual(row, rawValue) : null;
    if (isImageField(field) && !rights) {
      findings.push(finding('rights_missing', 'The attested manual image has no matching active operator-review rights receipt.', field, observation.id));
      return;
    }
    addFact(observation, facts, findings, { field, reference, rights });
  };
  for (const field of MANUAL_FIELD_NAMES) {
    if (field === 'bulletPoints') {
      if (Array.isArray(payload.bulletPoints)) payload.bulletPoints.forEach((_, index) => addManualField(field, `/extractionData/bulletPoints/${index}`));
    } else if (field === 'additionalImages') {
      if (Array.isArray(payload.additionalImages)) payload.additionalImages.forEach((_, index) => addManualField(field, `/extractionData/additionalImages/${index}`));
    } else {
      addManualField(field, `/extractionData/${field}`);
    }
  }
}

function normalizeManualSource(
  owner: OwnerContext,
  extraction: OnboardingExtractionRow,
  observations: ItemEvidenceObservation[],
  facts: AcceptedItemFact[],
  findings: ItemEvidenceFinding[],
  sourceState: unknown[],
  authorityHashes: string[],
): boolean {
  if (extraction.extraction_method !== 'manual_evidence_v1' || extraction.source_url !== null || extraction.source_type !== 'official_page') return false;
  const attestationId = extraction.manual_attestation_id ?? null;
  const row = attestationId ? getManualEvidenceAttestation(attestationId) : null;
  const active = getActiveManualEvidenceAttestationForItem(owner.item.id);
  if (!row || !active || active.attestation_id !== row.attestation_id || row.item_id !== owner.item.id || row.batch_id !== owner.batchId || row.superseded_at !== null || row.operator_id.trim().length === 0) {
    findings.push(finding('manual_attestation_unavailable', 'The manual extraction is not bound to the current active item-owned operator attestation.'));
    sourceState.push({ kind: 'manual_refused', extractionId: extraction.id, attestationId, activeAttestationId: active?.attestation_id ?? null });
    return false;
  }
  const currentPayload = ownObject(owner.item.extractionData);
  let payload: Record<string, unknown> | null;
  try { payload = ownObject(JSON.parse(extraction.extraction_data_json)); } catch { payload = null; }
  if (!payload || !currentPayload || hashCanonicalJson(payload) !== hashCanonicalJson(currentPayload) || payload.manualEvidenceAttestationId !== attestationId || payload.sourceUrl !== null) {
    findings.push(finding('manual_extraction_stale', 'The manual extraction record no longer matches the current item payload and attestation.'));
    sourceState.push({ kind: 'manual_payload_mismatch', extractionId: extraction.id, attestationId });
    return false;
  }
  const validatedPayload = ExtractionDataSchema.safeParse(payload);
  if (!validatedPayload.success) {
    findings.push(finding('manual_extraction_invalid', 'The current manual extraction does not match the persisted extraction contract.'));
    sourceState.push({ kind: 'manual_extraction_invalid', extractionId: extraction.id, attestationId });
    return false;
  }
  const manualValues = buildManualEvidenceFieldValues(validatedPayload.data);
  if (!verifyManualEvidenceAttestationHash(attestationId!, manualValues)) {
    findings.push(finding('manual_value_hash_mismatch', 'The current manual field values do not match the operator attestation hashes.'));
    sourceState.push({ kind: 'manual_hash_mismatch', extractionId: extraction.id, attestationId });
    return false;
  }
  const expectedValueHashes = computeManualEvidenceValueHashes(manualValues);
  const storedValueHashes = parseObject(row.value_hashes_json);
  if (!storedValueHashes || hashCanonicalJson(storedValueHashes) !== hashCanonicalJson(expectedValueHashes)) {
    findings.push(finding('manual_value_hash_mismatch', 'The stored manual value hashes do not match the current attested values.'));
    sourceState.push({ kind: 'manual_stored_hash_mismatch', extractionId: extraction.id, attestationId });
    return false;
  }
  const prior = listItemEvidenceSnapshots(owner.workspaceId, owner.item.id)
    .flatMap((snapshot) => snapshot.observations)
    .find((entry) => entry.authorityId === attestationId && entry.sourceRole === 'operator_attested');
  const storedIdentityHash = row.identity_input_hash ?? null;
  if (!storedIdentityHash) {
    findings.push(finding('manual_identity_binding_unavailable', 'This legacy operator attestation has no immutable imported-identity binding; a fresh item-specific attestation is required.'));
    sourceState.push({ kind: 'manual_identity_binding_missing', attestationId, historicalBindingFound: Boolean(prior) });
    return false;
  }
  if (storedIdentityHash !== owner.inputHash || (prior && prior.identity.inputHash !== owner.inputHash)) {
    findings.push(finding('manual_identity_stale', 'This operator attestation was created or accepted under a different imported identity; a fresh item-specific attestation is required.'));
    sourceState.push({ kind: 'manual_identity_stale', attestationId, priorInputHash: storedIdentityHash });
    return false;
  }
  const attestedInputHash = storedIdentityHash;
  const imageRights = (() => { try { return parseManualEvidenceImageRights(row); } catch { return []; } })();
  const content = canonicalJsonStringify({
    extractionData: payload,
    attestation: {
      attestationId: row.attestation_id,
      identityInputHash: attestedInputHash,
      itemId: row.item_id,
      batchId: row.batch_id,
      operatorId: row.operator_id,
      attestedAt: row.attested_at,
      fieldChecklist: parseObject(row.field_checklist_json),
      valueHashes: storedValueHashes,
      imageRights,
      familyReferenceUrl: row.family_reference_url,
      supersededAt: row.superseded_at,
    },
  });
  const artifactHash = hashText(content);
  const authorityHash = hashCanonicalJson({
    sourceRole: 'operator_attested',
    attestationId,
    itemId: row.item_id,
    batchId: row.batch_id,
    operatorId: row.operator_id,
    attestedAt: row.attested_at,
    identityInputHash: attestedInputHash,
    checklist: row.field_checklist_json,
    valueHashes: row.value_hashes_json,
    imageRights: row.image_rights_json,
    familyReferenceUrl: row.family_reference_url,
    rulesVersion: ITEM_EVIDENCE_RULES_VERSION,
  });
  const id = observationId('manual', attestationId!, artifactHash);
  const identity: ItemEvidenceObservation['identity'] = {
    itemId: owner.item.id,
    sku: owner.item.upc,
    inputHash: owner.inputHash,
    outcome: 'confirmed',
    proofType: 'operator_attestation',
    proofHash: hashCanonicalJson({ attestationId, operatorId: row.operator_id, attestedAt: row.attested_at, inputHash: owner.inputHash, attestedInputHash, itemId: owner.item.id, sku: owner.item.upc }),
    variantKey: null,
    attestationId,
    reasons: [],
  };
  const observation = createObservation({
    id,
    sourceRole: 'operator_attested',
    collectedVia: 'manual',
    authorityId: attestationId!,
    authorityHash,
    sourceUrl: null,
    finalUrl: null,
    connectorRecordId: null,
    generationId: null,
    observedAt: row.attested_at,
    expiresAt: null,
    contentType: 'application/json',
    content,
    artifactHash,
    complete: true,
    identity,
    modelCallIds: [],
  });
  if (!observation) {
    findings.push(finding('manual_observation_invalid', 'The retained manual attestation cannot be represented as a complete observation.'));
    return false;
  }
  observations.push(observation);
  authorityHashes.push(authorityHash);
  sourceState.push({ kind: 'manual', extractionId: extraction.id, attestationId, artifactHash, authorityHash });
  addManualFacts(row, observation, { ...payload, extractionData: payload }, facts, findings);
  return true;
}

function retailerIdentityOnlyField(role: ItemEvidenceSourceRole, field: string): boolean {
  return role === 'retailer_corroboration' && ['title', 'name', 'brand'].includes(field.toLowerCase());
}

function contributionFactFieldsAreSafe(input: ItemEvidenceContributionInput, role: ItemEvidenceSourceRole): ItemEvidenceFinding | null {
  for (const fact of input.facts) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(fact.field)) return finding('fact_field_invalid', 'The contribution contains an invalid fact field name.', fact.field ?? null);
    if (COMMERCIAL_FIELD.test(fact.field)) return finding('commercial_field_refused', 'Product sources cannot replace imported price, stock, inventory, or quantity authority.', fact.field);
    if (retailerIdentityOnlyField(role, fact.field)) continue;
    if (role === 'retailer_corroboration' && (!RETAILER_BASIC_FIELDS.has(fact.field) || RETAILER_SENSITIVE_FIELD.test(fact.field))) {
      return finding('retailer_sensitive_field_refused', 'Retailer corroboration is limited to attributable basic specifications; sensitive claims, prose, and images are refused.', fact.field);
    }
    if (isImageField(fact.field) && !fact.rightsApprovalId) {
      return finding('rights_missing', 'Every image fact requires an existing item-owned, asset-specific rights approval receipt.', fact.field);
    }
  }
  return null;
}

function validateExistingContribution(
  workspaceId: string,
  owner: OwnerContext,
  observation: ItemEvidenceObservation,
  submittedReferences: AcceptedItemEvidence['submittedFactReferences'],
): { facts: AcceptedItemFact[]; sourceState: unknown; authorityHash: string } | null {
  if (!observation.id.startsWith('contrib_') || !observation.sourceUrl) return null;
  const references = submittedReferences.filter((entry) => entry.observationId === observation.id);
  if (!references.length || observation.identity.inputHash !== owner.inputHash || observation.identity.itemId !== owner.item.id || observation.identity.sku !== owner.item.upc || observation.artifactHash !== hashText(observation.content)) return null;
  const input: ItemEvidenceContributionInput = {
    workspaceId,
    itemId: owner.item.id,
    collectedVia: observation.collectedVia as ItemEvidenceContributionInput['collectedVia'],
    sourceUrl: observation.sourceUrl,
    finalUrl: observation.finalUrl,
    observedAt: observation.observedAt,
    expiresAt: observation.expiresAt,
    contentType: observation.contentType,
    content: observation.content,
    facts: references.map((entry) => ({ field: entry.field, reference: entry.reference, rightsApprovalId: entry.rightsApprovalId })),
  };
  const parsedContent = observation.contentType === 'application/json' ? (() => { try { return JSON.parse(observation.content); } catch { return null; } })() : null;
  const authorityCheck = authorityAndIdentityForContribution(input, owner, parsedContent);
  if (!authorityCheck.authority || !authorityCheck.identity || authorityCheck.reason || authorityCheck.authority.role !== observation.sourceRole || authorityCheck.authority.authorityId !== observation.authorityId || authorityCheck.authority.authorityHash !== observation.authorityHash || authorityCheck.identity.proofHash !== observation.identity.proofHash) return null;
  const safeFinding = contributionFactFieldsAreSafe(input, observation.sourceRole);
  if (safeFinding) return null;
  const factsStillValid: AcceptedItemFact[] = [];
  const referenceFindings: ItemEvidenceFinding[] = [];
  for (const entry of references) {
    const raw = resolveReference(observation.contentType, observation.content, entry.reference);
    if (raw === null || !raw.trim()) return null;
    let rights: AcceptedItemFact['rights'] | null = null;
    if (isImageField(entry.field)) {
      rights = rightsForContribution(workspaceId, owner.item.id, entry.rightsApprovalId, raw);
      if (!rights) return null;
    }
    if (retailerIdentityOnlyField(observation.sourceRole, entry.field)) continue;
    addFact(observation, factsStillValid, referenceFindings, { field: entry.field, reference: entry.reference, rights });
    if (referenceFindings.length) return null;
  }
  return {
    facts: factsStillValid,
    sourceState: { observationId: observation.id, artifactHash: observation.artifactHash, authorityHash: observation.authorityHash, submittedReferences: references, factHashes: factsStillValid.map((fact) => fact.valueHash) },
    authorityHash: observation.authorityHash,
  };
}

interface BuiltEvidenceState {
  owner: OwnerContext | null;
  derived: DerivedEvidence | null;
  status: ItemEvidenceResult['status'];
  findings: ItemEvidenceFinding[];
}
function buildEvidenceState(workspaceId: string, itemId: string, current: AcceptedItemEvidence | null): BuiltEvidenceState {
  const owner = loadOwner(workspaceId, itemId);
  if (!owner) return { owner: null, derived: null, status: 'unavailable', findings: [finding('item_not_found', 'The item is not available in the current workspace.')] };
  const observations: ItemEvidenceObservation[] = [];
  const facts: AcceptedItemFact[] = [];
  const findings: ItemEvidenceFinding[] = [];
  const sourceState: unknown[] = [];
  const authorityHashes: string[] = [];
  const producingRunId: string | null = null;
  const extraction = getLatestExtraction(itemId);
  if (!extraction) {
    findings.push(finding('source_unavailable', 'No persisted current official, distributor, or attested source record is available.'));
    sourceState.push({ kind: 'no_extraction' });
  } else if (extraction.extraction_method === 'manual_evidence_v1') {
    normalizeManualSource(owner, extraction, observations, facts, findings, sourceState, authorityHashes);
  } else if (extraction.source_type === 'distributor_record' || owner.item.sourceType === 'distributor_record') {
    normalizeDistributorSource(owner, extraction, observations, facts, findings, sourceState, authorityHashes);
  } else {
    normalizeOfficialSource(owner, extraction, observations, facts, findings, sourceState, authorityHashes);
  }

  const contributionObservations: ItemEvidenceObservation[] = [];
  const contributionFacts: AcceptedItemFact[] = [];
  const contributionState: unknown[] = [];
  const submittedFactReferences = current?.submittedFactReferences ?? [];
  if (current) {
    for (const priorObservation of current.observations) {
      if (!priorObservation.id.startsWith('contrib_')) continue;
      contributionObservations.push(priorObservation);
      const validated = validateExistingContribution(workspaceId, owner, priorObservation, submittedFactReferences);
      if (!validated) {
        findings.push(finding('contribution_stale', 'A previously admitted collection is no longer current under its input, authority, reference, rights, or source bindings.', null, priorObservation.id));
        contributionState.push({ observationId: priorObservation.id, stale: true, artifactHash: priorObservation.artifactHash });
        continue;
      }
      contributionFacts.push(...validated.facts);
      contributionState.push(validated.sourceState);
      authorityHashes.push(validated.authorityHash);
    }
  }
  observations.push(...contributionObservations);
  facts.push(...contributionFacts);
  const eligibleFacts = finalizeConflicts(facts, findings);
  const unique = uniqueFindings(findings);
  const state: DerivedEvidence = {
    observations,
    candidateFacts: facts,
    facts: eligibleFacts,
    submittedFactReferences,
    findings: unique,
    sourceState: {
      workspaceId,
      itemId,
      inputHash: owner.inputHash,
      persistedSources: sourceState,
      currentContributions: contributionState,
      submittedFactReferences,
      rulesVersion: ITEM_EVIDENCE_RULES_VERSION,
    },
    authorityHashes,
    producingRunId,
  };
  const status = classifyStatus(eligibleFacts, unique);
  return { owner, derived: state, status, findings: unique };
}


function makeSnapshot(
  workspaceId: string,
  owner: OwnerContext,
  derived: DerivedEvidence,
  revision: number,
): AcceptedItemEvidence | null {
  if (derived.observations.length > ITEM_EVIDENCE_MAX_OBSERVATIONS || derived.facts.length > ITEM_EVIDENCE_MAX_FACTS || derived.findings.length > ITEM_EVIDENCE_MAX_FACTS) return null;
  const sourceStateHash = hashCanonicalJson(derived.sourceState);
  const authorityHash = hashCanonicalJson({
    rulesVersion: ITEM_EVIDENCE_RULES_VERSION,
    authorities: [...new Set(derived.authorityHashes)].sort(),
  });
  const base = {
    recordVersion: 1 as const,
    id: randomUUID(),
    workspaceId,
    batchId: owner.batchId,
    itemId: owner.item.id,
    sku: owner.item.upc,
    revision,
    inputHash: owner.inputHash,
    sourceStateHash,
    authorityHash,
    registerName: owner.item.name,
    importedPrice: owner.item.price ?? null,
    observations: derived.observations,
    submittedFactReferences: derived.submittedFactReferences,
    facts: derived.facts,
    findings: derived.findings,
    evidenceHash: '',
    rulesVersion: ITEM_EVIDENCE_RULES_VERSION,
    producingRunId: derived.producingRunId,
    acceptedAt: new Date().toISOString(),
  };
  const candidate = { ...base, evidenceHash: acceptedItemEvidenceHash(base as AcceptedItemEvidence) };
  const parsed = AcceptedItemEvidenceSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function sameEvidenceState(current: AcceptedItemEvidence, derived: DerivedEvidence, owner: OwnerContext, authorityHash: string): boolean {
  return current.inputHash === owner.inputHash &&
    current.sourceStateHash === hashCanonicalJson(derived.sourceState) &&
    current.authorityHash === authorityHash &&
    current.rulesVersion === ITEM_EVIDENCE_RULES_VERSION;
}

function currentAuthorityHash(derived: DerivedEvidence): string {
  return hashCanonicalJson({ rulesVersion: ITEM_EVIDENCE_RULES_VERSION, authorities: [...new Set(derived.authorityHashes)].sort() });
}

function commitDerivedState(workspaceId: string, itemId: string, derivedState: BuiltEvidenceState, current: AcceptedItemEvidence | null): ItemEvidenceResult {
  const { owner, derived, status, findings } = derivedState;
  if (!owner || !derived) return { status, evidence: null, findings };
  if (current && sameEvidenceState(current, derived, owner, currentAuthorityHash(derived))) return { status, evidence: current, findings };
  if (derived.observations.length > ITEM_EVIDENCE_MAX_OBSERVATIONS || derived.facts.length > ITEM_EVIDENCE_MAX_FACTS || derived.findings.length > ITEM_EVIDENCE_MAX_FACTS) {
    const overflow = finding('evidence_limit_exceeded', 'Complete current evidence exceeds the accepted snapshot contract; no inspected prefix is accepted.');
    return { status: 'unavailable', evidence: null, findings: uniqueFindings([...findings, overflow]) };
  }
  const expectedRevision = current?.revision ?? 0;
  const evidence = makeSnapshot(workspaceId, owner, derived, expectedRevision + 1);
  if (!evidence) {
    return { status: 'unavailable', evidence: null, findings: uniqueFindings([...findings, finding('snapshot_invalid', 'The complete current source state cannot be represented as a valid accepted-evidence snapshot.')]) };
  }
  const committed = appendAcceptedItemEvidenceSnapshot({ workspaceId, itemId, expectedRevision, evidence });
  if (!committed) return { status: 'stale', evidence: null, findings: uniqueFindings([...findings, finding('snapshot_cas_stale', 'A newer evidence snapshot advanced the item while this revision was being committed.')]) };
  return { status, evidence, findings };
}

/** Rebuild accepted facts from current persisted official, distributor and manual sources, then append under revision CAS. */
export function refreshItemEvidence(workspaceId: string, itemId: string): ItemEvidenceResult {
  const db = getDb();
  return db.transaction(() => {
    let current: AcceptedItemEvidence | null;
    try { current = getCurrentItemEvidence(workspaceId, itemId); }
    catch {
      return { status: 'unavailable' as const, evidence: null, findings: [finding('evidence_repository_unavailable', 'The accepted-evidence snapshot store is unavailable or corrupt.')] };
    }
    const derived = buildEvidenceState(workspaceId, itemId, current);
    return commitDerivedState(workspaceId, itemId, derived, current);
  })();
}

/** Read accepted evidence without creating or advancing a snapshot. */
export function getCurrentItemEvidenceView(workspaceId: string, itemId: string): ItemEvidenceResult {
  let current: AcceptedItemEvidence | null;
  try { current = getCurrentItemEvidence(workspaceId, itemId); }
  catch {
    return { status: 'unavailable', evidence: null, findings: [finding('evidence_repository_unavailable', 'The accepted-evidence snapshot store is unavailable or corrupt.')] };
  }
  if (!current) return { status: 'unavailable', evidence: null, findings: [finding('evidence_unavailable', 'No accepted evidence snapshot exists for this item.')] };
  const derived = buildEvidenceState(workspaceId, itemId, current);
  if (!derived.owner || !derived.derived) return { status: 'unavailable', evidence: null, findings: derived.findings };
  const sourceStateHash = hashCanonicalJson(derived.derived.sourceState);
  const authorityHash = currentAuthorityHash(derived.derived);
  if (current.inputHash !== derived.owner.inputHash || current.sourceStateHash !== sourceStateHash || current.authorityHash !== authorityHash || current.rulesVersion !== ITEM_EVIDENCE_RULES_VERSION) {
    return { status: 'stale', evidence: null, findings: uniqueFindings([...derived.findings, finding('snapshot_stale', 'The accepted snapshot no longer matches current item, source, or authority state.')]) };
  }
  const status = classifyStatus(current.facts, current.findings);
  return { status, evidence: current, findings: current.findings };
}

/**
 * Internal code-owned acquisition seam. It derives source role, identity, fact values,
 * value hashes and rights from the retained observation and current server authority;
 * no client/model acceptance flags or arbitrary write route exist.
 */
export function admitItemEvidenceContribution(input: ItemEvidenceContributionInput): ItemEvidenceResult {
  const db = getDb();
  return db.transaction((): ItemEvidenceResult => {
    let current: AcceptedItemEvidence | null;
    try { current = getCurrentItemEvidence(input.workspaceId, input.itemId); }
    catch {
      return { status: 'unavailable' as const, evidence: null, findings: [finding('evidence_repository_unavailable', 'The accepted-evidence snapshot store is unavailable or corrupt.')] };
    }
    const base = buildEvidenceState(input.workspaceId, input.itemId, current);
    if (!base.owner || !base.derived) return { status: 'unavailable', evidence: null, findings: base.findings };
    if (!['static_extraction', 'rendered_browser', 'ocr'].includes(input.collectedVia)) {
      return { status: 'unavailable', evidence: null, findings: [finding('collection_method_refused', 'This internal collection method is not admitted through the acquisition contribution seam.')] };
    }
    let contentJson: unknown | null = null;
    if (input.contentType === 'application/json') {
      try { contentJson = JSON.parse(input.content); }
      catch { contentJson = null; }
    }
    const authorityAndIdentity = authorityAndIdentityForContribution(input, base.owner, contentJson);
    if (!authorityAndIdentity.authority || !authorityAndIdentity.identity || authorityAndIdentity.reason) {
      const reason = authorityAndIdentity.reason ?? finding('contribution_refused', 'The source contribution could not be admitted.');
      return { status: reason.code === 'identity_conflict' ? 'conflict' : 'unavailable', evidence: null, findings: [reason] };
    }
    const disallowed = contributionFactFieldsAreSafe(input, authorityAndIdentity.authority.role);
    if (disallowed) return { status: 'unavailable', evidence: null, findings: [disallowed] };

    const artifactHash = hashText(input.content);
    const id = observationId('contrib', authorityAndIdentity.authority.authorityId, hashCanonicalJson({ artifactHash, sourceUrl: input.sourceUrl, finalUrl: input.finalUrl, observedAt: input.observedAt, collectedVia: input.collectedVia }));
    const observation = createObservation({
      id,
      sourceRole: authorityAndIdentity.authority.role,
      collectedVia: input.collectedVia,
      authorityId: authorityAndIdentity.authority.authorityId,
      authorityHash: authorityAndIdentity.authority.authorityHash,
      sourceUrl: authorityAndIdentity.authority.sourceUrl,
      finalUrl: authorityAndIdentity.authority.finalUrl,
      connectorRecordId: null,
      generationId: null,
      observedAt: input.observedAt,
      expiresAt: input.expiresAt,
      contentType: input.contentType,
      content: input.content,
      artifactHash,
      complete: true,
      identity: authorityAndIdentity.identity,
      modelCallIds: [],
    });
    if (!observation) return { status: 'unavailable', evidence: null, findings: [finding('contribution_invalid', 'The complete contribution does not meet the observation schema.')] };

    if (base.derived.observations.some((prior) => prior.id === observation.id && prior.artifactHash === observation.artifactHash)) {
      const existingResult = commitDerivedState(input.workspaceId, input.itemId, base, current);
      return { ...existingResult, findings: uniqueFindings([...existingResult.findings, finding('contribution_replayed', 'This exact retained contribution is already current.', null, observation.id)]) };
    }
    const nextFacts = [...base.derived.candidateFacts];
    const contributionFindings: ItemEvidenceFinding[] = [];
    const addedReferences: AcceptedItemEvidence['submittedFactReferences'] = [];
    if (!input.facts.length) return { status: 'unavailable', evidence: null, findings: [finding('contribution_invalid', 'A contribution must identify at least one observed source value.')] };
    for (const entry of input.facts) {
      const image = isImageField(entry.field);
      let rights: AcceptedItemFact['rights'] | null = null;
      const rawValue = resolveReference(input.contentType, input.content, entry.reference);
      if (image) {
        rights = rawValue ? rightsForContribution(input.workspaceId, input.itemId, entry.rightsApprovalId, rawValue) : null;
        if (!rights) {
          return { status: 'unavailable', evidence: null, findings: [finding('rights_missing', 'The image fact has no current item-owned asset-specific rights approval matching this exact source value.', entry.field)] };
        }
      }
      addedReferences.push({
        observationId: observation.id,
        field: entry.field,
        reference: entry.reference,
        rightsApprovalId: entry.rightsApprovalId ?? null,
      });
      if (retailerIdentityOnlyField(authorityAndIdentity.authority.role, entry.field)) continue;
      addFact(observation, nextFacts, contributionFindings, { field: entry.field, reference: entry.reference, rights });
    }
    if (contributionFindings.some((entry) => entry.code === 'invalid_source_reference' || entry.code === 'invalid_fact')) {
      return { status: 'unavailable', evidence: null, findings: contributionFindings };
    }
    if (!nextFacts.some((fact) => fact.observationId === observation.id)) {
      return { status: 'unavailable', evidence: null, findings: [finding('contribution_invalid', 'The contribution contains no reusable accepted fact beyond retailer identity clues.')] };
    }
    const observations = [...base.derived.observations, observation];
    const findings = [...base.derived.findings, ...contributionFindings];
    const eligibleFacts = finalizeConflicts([...nextFacts], findings);
    const submittedFactReferences = [...base.derived.submittedFactReferences, ...addedReferences];
    const sourceState = {
      ...(ownObject(base.derived.sourceState) ?? {}),
      currentContributions: [
        ...((ownObject(base.derived.sourceState)?.currentContributions as unknown[] | undefined) ?? []),
        { observationId: observation.id, artifactHash, authorityHash: observation.authorityHash, submittedReferences: addedReferences, factHashes: nextFacts.filter((fact) => fact.observationId === observation.id).map((fact) => fact.valueHash) },
      ],
      submittedFactReferences,
    };
    const derived: DerivedEvidence = {
      ...base.derived,
      observations,
      candidateFacts: nextFacts,
      facts: eligibleFacts,
      submittedFactReferences,
      findings: uniqueFindings(findings),
      sourceState,
      authorityHashes: [...base.derived.authorityHashes, observation.authorityHash],
    };
    return commitDerivedState(input.workspaceId, input.itemId, {
      owner: base.owner,
      derived,
      status: classifyStatus(eligibleFacts, derived.findings),
      findings: derived.findings,
    }, current);
  })();
}

/** Pure conversion of one accepted snapshot to the classifier evidence representation. */
export function acceptedEvidenceToClassificationEvidence(
  snapshot: AcceptedItemEvidence,
  runId: string,
): ClassificationEvidence[] {
  const parsed = AcceptedItemEvidenceSchema.safeParse(snapshot);
  if (!parsed.success || acceptedItemEvidenceHash(parsed.data) !== parsed.data.evidenceHash) return [];
  const evidence = parsed.data;
  const observationById = new Map(evidence.observations.map((observation) => [observation.id, observation]));
  const source: Record<ItemEvidenceSourceRole, ClassificationEvidence['source']> = {
    manufacturer_official: 'official_product_page',
    distributor_record: 'distributor_record',
    retailer_corroboration: 'third_party_page',
    operator_attested: 'operator_manual',
  };
  return evidence.facts.flatMap((fact) => {
    const observation = observationById.get(fact.observationId);
    if (!observation || observation.identity.outcome !== 'confirmed' || observation.identity.itemId !== evidence.itemId || observation.identity.sku !== evidence.sku || observation.identity.inputHash !== evidence.inputHash || observation.artifactHash !== hashText(observation.content)) return [];
    const rawValue = resolveReference(observation.contentType, observation.content, fact.reference);
    if (!rawValue || rawValue !== fact.rawValue || canonicalString(rawValue) !== fact.value || fact.id !== factId(observation, fact.field, fact.reference, rawValue) || hashCanonicalJson({ value: fact.value, unit: fact.unit }) !== fact.valueHash) return [];
    const unitMatch = /(?:^|\s)(fl\s?oz|oz|lbs?|pounds?|kg|g|ml|l|count|ct)\s*$/iu.exec(fact.value);
    const expectedUnit = unitMatch ? unitMatch[1] : null;
    const expectedNormalization = canonicalString(rawValue) === rawValue ? 'verbatim' : 'whitespace';
    if (fact.unit !== expectedUnit || fact.normalization !== expectedNormalization || (isImageField(fact.field) && (!fact.rights || fact.rights.assetUrl !== rawValue)) || (fact.rights !== null && fact.rights.assetUrl !== rawValue)) return [];
    return [{
      id: `${runId}:${evidence.id}:${fact.id}`,
      runId,
      stageName: 'evidence_extraction',
      productSku: evidence.sku,
      attributeId: null,
      source: source[observation.sourceRole],
      reliability: observation.sourceRole === 'operator_attested' || observation.sourceRole === 'retailer_corroboration' ? 'low' : observation.sourceRole === 'manufacturer_official' ? 'high' : 'medium',
      sourceUrl: observation.finalUrl ?? observation.sourceUrl,
      sourceField: fact.field,
      snippet: fact.rawValue,
      value: fact.value,
      metadata: {
        acceptedEvidenceId: evidence.id,
        acceptedEvidenceRevision: evidence.revision,
        acceptedEvidenceHash: evidence.evidenceHash,
        acceptedInputHash: evidence.inputHash,
        acceptedSourceStateHash: evidence.sourceStateHash,
        acceptedAuthorityHash: evidence.authorityHash,
        factId: fact.id,
        factValueHash: fact.valueHash,
        observationId: observation.id,
        sourceRole: observation.sourceRole,
        collectionMethod: observation.collectedVia,
        sourceAuthorityId: observation.authorityId,
        sourceAuthorityHash: observation.authorityHash,
        sourceReference: fact.reference,
        identityProofType: observation.identity.proofType,
        identityProofHash: observation.identity.proofHash,
        variantKey: observation.identity.variantKey,
        rights: fact.rights,
      },
      capturedAt: observation.observedAt,
    }];
  });
}
