import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { AcceptedItemEvidence, ItemChecklistEvaluation, ListingRequirement } from '../shared/schemas/item-evidence';
import type { ItemEvidenceReference } from './item-evidence';
import type { ItemAcquisitionModelPrice } from '../shared/schemas/item-acquisition';
import { findGateRunById } from '../db/repositories/classification-run-repo';
import { listOfficialPageDecisions } from '../db/repositories/official-page-decision-repo';
import { itemInputIdentityHash } from './item-input-identity';
import { findItemById } from '../db/repositories/onboarding-item-repo';
import { listSourcesByItem } from '../db/repositories/onboarding-source-repo';
import { getAllowedOfficialPageDomains, isAuthorizedOfficialPageUrl } from './official-page-authority';
import { refreshItemEvidence, admitItemEvidenceContribution } from './item-evidence';
import { loadItemListingReadinessForRun, type ItemListingReadiness } from '../classification/item-listing-readiness';
import { checkItemAcquisitionActionRoute, decideItemAcquisitionAction, type ItemAcquisitionActionOption } from '../classification/item-acquisition-action-decision';
import { BraveSearchError, BRAVE_SEARCH_MAX_RESPONSE_BYTES, BRAVE_SEARCH_TIMEOUT_MS, searchBraveWeb } from './brave-search';
import { collectItemEvidenceBrowser, ItemEvidenceBrowserError, type ItemEvidenceBrowserCandidate, type ItemEvidenceBrowserAction } from './item-evidence-browser';
import {
  createItemAcquisitionBudgetLedger,
  ItemAcquisitionBudgetDeniedError,
  getItemAcquisitionModelPrice,
  itemAcquisitionInvestigationBudget,
  markItemAcquisitionDispatched,
  releaseItemAcquisitionReservation,
  reserveItemAcquisitionAttempt,
  settleItemAcquisitionAttempt,
  type ItemAcquisitionBudgetScope,
  withItemAcquisitionBudget,
} from './item-acquisition-budget';
import type { ModelPolicyView } from '../classification/model-policy-gateway';

export type ItemEvidenceAcquisitionStatus = 'completed' | 'needs_attention' | 'unavailable' | 'conflict' | 'stale' | 'cancelled' | 'budget_exhausted';
export interface ItemEvidenceAcquisitionCall {
  kind: 'brave_search' | 'typesafe_action_selection' | 'guarded_browser';
  attempts: number;
  billing: 'flat_rate' | 'rate_derived' | 'unavailable' | 'not_applicable';
  modelCallIds: string[];
}
export interface ItemEvidenceAcquisitionUsage {
  attempts: number;
  pages: number;
  actions: number;
  redirects: number;
  bytes: number;
  unknownBytes: number;
  requestAttempts: number;
  modelInputTokens: number;
  modelOutputTokens: number;
  calls: ItemEvidenceAcquisitionCall[];
}
export interface ItemEvidenceAcquisitionResult {
  status: ItemEvidenceAcquisitionStatus;
  evidence: AcceptedItemEvidence | null;
  checklist: ItemChecklistEvaluation;
  modelCallIds: string[];
  usage: ItemEvidenceAcquisitionUsage;
  reason: string;
}
export interface RunItemEvidenceAcquisitionInput {
  workspaceId: string;
  intent?: 'listing_gaps' | 'identity_bootstrap';
  itemId: string;
  runId: string;
  signal?: AbortSignal;
  assertHeld?: () => void;
  modelPolicy?: ModelPolicyView | null;
}

const FIELD_LABELS: Readonly<Record<string, readonly string[]>> = {
  title: ['Product Name', 'Product Title', 'Name'],
  brand: ['Brand', 'Manufacturer'],
  upc: ['UPC', 'GTIN', 'GTIN-8', 'GTIN-12', 'GTIN-13', 'Barcode'],
  gtin: ['UPC', 'GTIN', 'GTIN-8', 'GTIN-12', 'GTIN-13', 'Barcode'],
  size: ['Package Size', 'Size'],
  weight: ['Net Weight', 'Weight'],
  dimensions: ['Product Dimensions', 'Dimensions'],
  count: ['Pack Count', 'Unit Count', 'Count'],
  packCount: ['Pack Count', 'Unit Count', 'Count'],
  flavor: ['Flavor'],
  formula: ['Formula'],
  color: ['Color'],
  material: ['Material'],
  productForm: ['Product Form'],
  species: ['Species'],
  model: ['Model', 'Model Number'],
  manufacturerPartNumber: ['Manufacturer Part Number', 'MPN'],
  unitOfMeasure: ['Unit of Measure'],
  safety: ['Safety Information', 'Safety Warnings', 'Warnings', 'Warning', 'Caution'],
  warnings: ['Safety Warnings', 'Warnings', 'Warning', 'Caution'],
  ingredients: ['Ingredients'],
  allergens: ['Allergen Information', 'Allergens'],
};

/** Opportunistic source fields only; these are not a listing standard or completion requirements. */
const IDENTITY_BOOTSTRAP_FIELDS = [
  'title', 'brand', 'upc', 'gtin', 'size', 'weight', 'dimensions', 'count', 'packCount',
  'flavor', 'formula', 'color', 'material', 'productForm', 'species', 'model',
  'manufacturerPartNumber', 'unitOfMeasure',
] as const;

function emptyUsage(): ItemEvidenceAcquisitionUsage {
  return { attempts: 0, pages: 0, actions: 0, redirects: 0, bytes: 0, unknownBytes: 0, requestAttempts: 0, modelInputTokens: 0, modelOutputTokens: 0, calls: [] };
}

function statusChecklist(reason: string, status: ItemChecklistEvaluation['status'] = 'unavailable'): ItemChecklistEvaluation {
  return {
    status, inputHash: null, evidenceHash: null, standardHash: null, classificationHash: null,
    listingHash: null, requirements: [], reasons: [reason],
  };
}
function fallbackReadiness(evaluation: ItemChecklistEvaluation, evidence: AcceptedItemEvidence | null = null): ItemListingReadiness {
  return {
    evaluation, standard: null, evidence, nonWaivableFields: [],
    classificationSource: 'none', classificationReady: false, classificationReason: evaluation.reasons[0] ?? 'Current-run classification is unavailable.',
  };
}

function unavailableResult(reason: string, checklist = statusChecklist(reason), evidence: AcceptedItemEvidence | null = null, usage = emptyUsage()): ItemEvidenceAcquisitionResult {
  return { status: 'unavailable', evidence, checklist, modelCallIds: usage.calls.flatMap(call => call.modelCallIds), usage, reason };
}


function identityBootstrapReadiness(evidence: AcceptedItemEvidence | null, reason: string): ItemListingReadiness {
  const evaluation = {
    ...statusChecklist(reason, 'needs_attention'),
    inputHash: evidence?.inputHash ?? null,
    evidenceHash: evidence?.evidenceHash ?? null,
  };
  return { ...fallbackReadiness(evaluation, evidence), classificationReason: 'Identity evidence can be collected, but no listing classification pair is selected.' };
}

function getConfirmedOfficialSource(workspaceId: string, itemId: string): { url: string; sourceId: string; sourceRunId: string; decisionId: string } | null {
  const item = findItemById(itemId);
  if (!item || item.sourceType !== 'official_page' || item.status !== 'source_confirmed' || !item.sourceUrl) return null;
  const decision = listOfficialPageDecisions(itemId).find(entry =>
    entry.workspaceId === workspaceId && entry.itemId === itemId && entry.url === item.sourceUrl && Boolean(entry.sourceRunId));
  if (!decision?.sourceRunId) return null;
  const source = listSourcesByItem(itemId).find(entry =>
    entry.url === decision.url && entry.isSelected && entry.discoveryRunId === decision.sourceRunId);
  if (!source) return null;
  const domains = getAllowedOfficialPageDomains({ workspaceId, itemId, brandHint: item.brandHint ?? null });
  if (!isAuthorizedOfficialPageUrl(decision.url, domains)) return null;
  return { url: decision.url, sourceId: source.id, sourceRunId: decision.sourceRunId, decisionId: decision.id };
}
function loadIdentityBootstrapState(
  workspaceId: string,
  itemId: string,
  runId: string,
  evidence: AcceptedItemEvidence | null,
  modelPolicy: ModelPolicyView | null | undefined,
): { evidence: AcceptedItemEvidence | null; readiness: ItemListingReadiness; reason: string | null; status: 'ok' | 'conflict' | 'stale' | 'unavailable' } {
  const item = findItemById(itemId);
  if (!item) {
    const reason = 'The current item is unavailable.';
    return { evidence, readiness: identityBootstrapReadiness(evidence, reason), reason, status: 'stale' };
  }
  const run = findGateRunById(runId);
  const expectedProductHash = evidence?.inputHash ?? itemInputIdentityHash(workspaceId, item);
  if (!run || run.status !== 'running' || run.workspaceId !== workspaceId || run.onboardingItemId !== itemId ||
    run.sourceKind !== 'onboarding' || run.productSku !== item.upc || run.sourceProductHash !== expectedProductHash) {
    const reason = 'The bootstrap run is not the current running workspace/item/SKU execution bound to the current item and evidence.';
    return { evidence, readiness: identityBootstrapReadiness(evidence, reason), reason, status: 'stale' };
  }
  if (modelPolicy && modelPolicy.snapshotHash !== run.configSnapshotHash) {
    const reason = 'The frozen model policy does not match this bootstrap run configuration snapshot.';
    return { evidence, readiness: identityBootstrapReadiness(evidence, reason), reason, status: 'stale' };
  }
  if (item.sourceType !== 'official_page' || item.status !== 'source_confirmed' || !item.sourceUrl) {
    const reason = 'Identity bootstrap requires an existing operator-confirmed official product URL; a candidate URL is not authority.';
    return { evidence, readiness: identityBootstrapReadiness(evidence, reason), reason, status: 'unavailable' };
  }
  let domains: string[];
  try { domains = getAllowedOfficialPageDomains({ workspaceId, itemId, brandHint: item.brandHint ?? null }); }
  catch {
    const reason = 'Current manufacturer-domain authority could not be loaded.';
    return { evidence, readiness: identityBootstrapReadiness(evidence, reason), reason, status: 'unavailable' };
  }
  if (!isAuthorizedOfficialPageUrl(item.sourceUrl, domains)) {
    const reason = 'The confirmed official URL is outside current manufacturer-domain authority.';
    return { evidence, readiness: identityBootstrapReadiness(evidence, reason), reason, status: 'conflict' };
  }
  const decisions = listOfficialPageDecisions(itemId);
  const decision = decisions.find(entry => entry.workspaceId === workspaceId && entry.itemId === itemId && entry.url === item.sourceUrl);
  const selectedSource = listSourcesByItem(itemId).find(entry => entry.url === item.sourceUrl && entry.isSelected);
  if (!decision || !decision.sourceRunId || !selectedSource || selectedSource.discoveryRunId !== decision.sourceRunId) {
    const reason = 'The current official URL has no matching workspace-owned confirmation and selected discovery source binding.';
    return { evidence, readiness: identityBootstrapReadiness(evidence, reason), reason, status: 'unavailable' };
  }
  return { evidence, readiness: identityBootstrapReadiness(evidence, 'Identity bootstrap evidence is pending.'), reason: null, status: 'ok' };
}
function loadCurrentState(
  workspaceId: string,
  itemId: string,
  runId: string,
  intent: RunItemEvidenceAcquisitionInput['intent'] = 'listing_gaps',
  modelPolicy?: ModelPolicyView | null,
): {
  evidence: AcceptedItemEvidence | null;
  readiness: ItemListingReadiness;
  reason: string | null;
  status: 'ok' | 'conflict' | 'stale' | 'unavailable';
} {
  let refreshed;
  try { refreshed = refreshItemEvidence(workspaceId, itemId); }
  catch {
    const reason = 'Accepted evidence could not be refreshed.';
    return { evidence: null, readiness: fallbackReadiness(statusChecklist(reason)), reason, status: 'unavailable' };
  }
  if (refreshed.status === 'conflict') {
    const reason = refreshed.findings[0]?.reason ?? 'Current accepted evidence contains a hard conflict.';
    return { evidence: refreshed.evidence, readiness: fallbackReadiness(statusChecklist(reason), refreshed.evidence), reason, status: 'conflict' };
  }
  if (refreshed.status === 'stale') {
    const reason = refreshed.findings[0]?.reason ?? 'Accepted evidence changed during refresh.';
    return { evidence: null, readiness: fallbackReadiness(statusChecklist(reason, 'stale')), reason, status: 'stale' };
  }
  if (intent === 'identity_bootstrap') {
    try { return loadIdentityBootstrapState(workspaceId, itemId, runId, refreshed.evidence, modelPolicy); }
    catch {
      const reason = 'The confirmed source or bootstrap run context could not be checked.';
      return { evidence: refreshed.evidence, readiness: identityBootstrapReadiness(refreshed.evidence, reason), reason, status: 'unavailable' };
    }
  }
  let readiness: ItemListingReadiness;
  try { readiness = loadItemListingReadinessForRun(workspaceId, itemId, runId); }
  catch {
    const reason = 'Current run checklist could not be read.';
    return { evidence: refreshed.evidence, readiness: fallbackReadiness(statusChecklist(reason), refreshed.evidence), reason, status: 'unavailable' };
  }
  if (readiness.evaluation.status === 'stale') return { evidence: readiness.evidence, readiness, reason: readiness.evaluation.reasons[0] ?? 'Current run evidence is stale.', status: 'stale' };
  const provisionalBootstrap = readiness.classificationSource === 'provisional' && readiness.standard !== null &&
    readiness.evaluation.status === 'needs_attention' && readiness.evaluation.inputHash !== null;
  if (readiness.evaluation.status === 'unavailable' || (!readiness.evidence && !provisionalBootstrap)) {
    return { evidence: readiness.evidence, readiness, reason: readiness.evaluation.reasons[0] ?? 'Current-run checklist is unavailable.', status: 'unavailable' };
  }
  if (readiness.evaluation.requirements.some(requirement => requirement.state === 'conflicted')) {
    return { evidence: readiness.evidence, readiness, reason: 'The current listing checklist has a hard evidence conflict.', status: 'conflict' };
  }
  if (readiness.evaluation.requirements.some(requirement => requirement.state === 'stale')) {
    return { evidence: readiness.evidence, readiness, reason: 'The current listing checklist is stale.', status: 'stale' };
  }
  return { evidence: readiness.evidence, readiness, reason: null, status: 'ok' };
}

function loadCurrentStateForInput(input: RunItemEvidenceAcquisitionInput): ReturnType<typeof loadCurrentState> {
  return loadCurrentState(input.workspaceId, input.itemId, input.runId, input.intent, input.modelPolicy);
}

function supportedGaps(readiness: ItemListingReadiness): ListingRequirement[] {
  if (!readiness.standard) return [];
  const requirements = new Map(readiness.standard.requirements.map(requirement => [requirement.id, requirement]));
  return readiness.evaluation.requirements.flatMap(state => {
    const standard = requirements.get(state.requirementId);
    if (state.state !== 'missing' || !standard || !['field', 'safety', 'identity'].includes(standard.kind) ||
      !standard.allowedSourceRoles.includes('manufacturer_official') || !FIELD_LABELS[standard.field]) return [];
    return [standard];
  });
}

type AcquisitionFact = { field: string; reference: ItemEvidenceReference };

function buildSourceFacts(content: string, contentType: 'text/plain' | 'application/json', requirements: readonly { field: string }[]): AcquisitionFact[] {
  const factPairs = new Map<string, AcquisitionFact>();
  const labelField = new Map<string, string>();
  for (const requirement of requirements) {
    for (const label of FIELD_LABELS[requirement.field] ?? []) labelField.set(label.toLowerCase(), requirement.field);
  }
  if (contentType === 'application/json') {
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { return []; }
    const stack: Array<{ value: unknown; pointer: string }> = [{ value: parsed, pointer: '' }];
    while (stack.length > 0) {
      const entry = stack.pop()!;
      if (!entry.value || typeof entry.value !== 'object') continue;
      if (Array.isArray(entry.value)) {
        for (let index = entry.value.length - 1; index >= 0; index -= 1) {
          stack.push({ value: entry.value[index], pointer: `${entry.pointer}/${index}` });
        }
        continue;
      }
      for (const [key, value] of Object.entries(entry.value as Record<string, unknown>)) {
        const segment = key.replace(/~/g, '~0').replace(/\//g, '~1');
        const pointer = `${entry.pointer}/${segment}`;
        let field = labelField.get(key.trim().replace(/[_-]+/gu, ' ').toLowerCase());
        const parentKey = entry.pointer.split('/').at(-1)?.replace(/~1/g, '/').replace(/~0/g, '~').toLowerCase();
        if (field === 'title' && key.trim().toLowerCase() === 'name' && (parentKey === 'brand' || parentKey === 'manufacturer')) {
          field = labelField.get(parentKey);
        }
        if (field && typeof value === 'string' && value.trim() && value.length <= 512) {
          const reference: ItemEvidenceReference = { kind: 'json_pointer', pointer };
          factPairs.set(`${field}:${pointer}`, { field, reference });
        }
        if (value && typeof value === 'object') stack.push({ value, pointer });
      }
    }
    return [...factPairs.values()];
  }
  let lineStart = 0;
  for (const line of content.split(/\n/)) {
    const lineEnd = lineStart + line.length;
    const match = /^(\s*)([^:]{1,80})\s*:\s*(\S(?:.*\S)?)\s*$/.exec(line);
    if (match) {
      const field = labelField.get(match[2].trim().toLowerCase());
      if (field && match[3].length <= 512) {
        const colon = line.indexOf(':', match[1].length + match[2].length);
        let valueOffset = colon + 1;
        while (valueOffset < line.length && /\s/.test(line[valueOffset])) valueOffset += 1;
        const reference: ItemEvidenceReference = { kind: 'text_span', start: lineStart + valueOffset, end: lineStart + valueOffset + match[3].length };
        factPairs.set(`${field}:${reference.start}:${reference.end}`, { field, reference });
      }
    }
    lineStart = lineEnd + 1;
  }
  return [...factPairs.values()];
}

function isSafeOfficialCandidate(raw: string, domains: readonly string[]): string | null {
  if (!isAuthorizedOfficialPageUrl(raw, [...domains])) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (isIP(host) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.includes(':')) return null;
  if (url.port && url.port !== '80' && url.port !== '443') return null;
  url.hash = '';
  return url.toString();
}

function candidateIds(runId: string, evidenceHash: string, url: string): { candidateId: string; actionId: string } {
  const digest = createHash('sha256').update(`${runId}\0${evidenceHash}\0${url}`).digest('hex').slice(0, 24);
  return { candidateId: `candidate_${digest}`, actionId: `action_${digest}` };
}

function currentBinding(readiness: ItemListingReadiness): string {
  return `${readiness.evidence?.evidenceHash ?? ''}\0${readiness.evaluation.inputHash ?? ''}\0${readiness.evaluation.standardHash ?? ''}\0${readiness.evaluation.classificationHash ?? ''}\0${readiness.evaluation.listingHash ?? ''}`;
}
function sourceStateBinding(sources: readonly { id: string; url: string; isSelected: boolean }[]): string {
  return sources.map(source => JSON.stringify([source.id, source.url, source.isSelected])).sort().join('\0');
}

function currentSourceBinding(itemId: string): string {
  const decisions = listOfficialPageDecisions(itemId)
    .map(decision => JSON.stringify([decision.id, decision.workspaceId, decision.url, decision.sourceRunId, decision.decidedAt]))
    .sort();
  return `${sourceStateBinding(listSourcesByItem(itemId))}\0${decisions.join('\0')}`;
}

function mapBudgetFailure(error: ItemAcquisitionBudgetDeniedError): { status: ItemEvidenceAcquisitionStatus; reason: string } {
  if (error.code === 'cancelled') return { status: 'cancelled', reason: 'Acquisition was cancelled or its time allowance expired.' };
  if (error.code === 'budget_exhausted' || error.code === 'concurrency_limit') return { status: 'budget_exhausted', reason: 'The approved item or batch acquisition budget is exhausted.' };
  if (error.code === 'lease_lost' || error.code === 'policy_changed') return { status: 'stale', reason: 'The item lease or approved acquisition policy changed during the run.' };
  return { status: 'unavailable', reason: `Acquisition is unavailable (${error.code}); review the approved policy, pricing, and required provider credentials.` };
}

function classifyBrowserError(error: unknown): { status: ItemEvidenceAcquisitionStatus; reason: string } {
  if (error instanceof ItemEvidenceBrowserError) {
    if (error.code === 'cancelled') return { status: 'cancelled', reason: 'Guarded page collection was cancelled.' };
    if (error.code === 'budget_exhausted') return { status: 'budget_exhausted', reason: 'Guarded page collection exceeded its approved item resource budget.' };
    if (error.code === 'invalid_input') return { status: 'stale', reason: 'The supplied guarded-browser action or URL became invalid; no arbitrary target was executed.' };
    return { status: 'unavailable', reason: error.code === 'isolation_unavailable' ? 'The isolated browser host prerequisite is unavailable; install and enable the approved internal render network and interception proxy.' : 'Guarded browser collection failed; no partial observation was admitted.' };
  }
  return { status: 'unavailable', reason: 'Guarded browser collection could not complete; no partial observation was admitted.' };
}

function bootstrapResult(
  status: ItemEvidenceAcquisitionStatus,
  state: ReturnType<typeof loadCurrentState>,
  usage: ItemEvidenceAcquisitionUsage,
  reason: string,
  modelCallIds = usage.calls.flatMap(call => call.modelCallIds),
): ItemEvidenceAcquisitionResult {
  return { status, evidence: state.evidence, checklist: state.readiness.evaluation, modelCallIds, usage, reason };
}

async function runIdentityBootstrapWithinBudget(
  input: RunItemEvidenceAcquisitionInput,
  scope: ItemAcquisitionBudgetScope,
  initial: ReturnType<typeof loadCurrentState>,
  usage: ItemEvidenceAcquisitionUsage,
): Promise<ItemEvidenceAcquisitionResult> {
  const confirmed = getConfirmedOfficialSource(input.workspaceId, input.itemId);
  if (!confirmed) return bootstrapResult('unavailable', initial, usage, 'Identity bootstrap requires the current selected official-page confirmation and its discovery-run binding.');
  const item = findItemById(input.itemId);
  if (!item) return bootstrapResult('stale', initial, usage, 'The current item is unavailable.');
  const domains = getAllowedOfficialPageDomains({ workspaceId: input.workspaceId, itemId: input.itemId, brandHint: item.brandHint ?? null });
  const candidateUrl = isSafeOfficialCandidate(confirmed.url, domains);
  if (!candidateUrl) return bootstrapResult('conflict', initial, usage, 'The confirmed page is no longer a safe URL inside current approved manufacturer authority.');
  const itemBinding = currentBinding(initial.readiness);
  let sourcesBinding: string;
  try { sourcesBinding = currentSourceBinding(input.itemId); }
  catch { return bootstrapResult('unavailable', initial, usage, 'Current official-page confirmation and source bindings could not be read.'); }

  const evidence = initial.evidence;
  const knownFields = new Set(evidence?.facts.map(fact => fact.field) ?? []);
  const alreadyIdentityConfirmed = Boolean(evidence?.observations.some(observation =>
    observation.sourceRole === 'manufacturer_official' && observation.sourceUrl === confirmed.url &&
    observation.identity.outcome === 'confirmed' &&
    evidence.facts.some(fact => fact.observationId === observation.id && ['title', 'name'].includes(fact.field.toLowerCase()))));
  if (alreadyIdentityConfirmed) return bootstrapResult('completed', initial, usage, 'Current accepted complete-source evidence already confirms this item identity; listing classification remains pending.');

  const retained = evidence?.observations.find(observation =>
    observation.sourceRole === 'manufacturer_official' && observation.sourceUrl === confirmed.url && observation.complete);
  if (retained) {
    const facts = buildSourceFacts(retained.content, retained.contentType, IDENTITY_BOOTSTRAP_FIELDS.map(field => ({ field })));
    const retainedTitle = evidence?.facts.find(fact => fact.observationId === retained.id && ['title', 'name'].includes(fact.field.toLowerCase()));
    if (!facts.some(fact => ['title', 'name'].includes(fact.field.toLowerCase())) && retainedTitle) {
      facts.push({ field: retainedTitle.field, reference: retainedTitle.reference });
    }
    if (!facts.some(fact => ['title', 'name'].includes(fact.field.toLowerCase()))) {
      return bootstrapResult('needs_attention', initial, usage, 'The complete retained official page has no code-recognized product-title reference; no generated title was substituted.');
    }
    const additional = facts.filter(fact => ['title', 'name'].includes(fact.field.toLowerCase()) || !knownFields.has(fact.field));
    if (additional.every(fact => knownFields.has(fact.field))) {
      return bootstrapResult('completed', initial, usage, 'Current accepted official-page identity facts are already retained; listing classification remains pending.');
    }
    const beforeAdmission = loadCurrentStateForInput(input);
    if (beforeAdmission.status !== 'ok' || currentBinding(beforeAdmission.readiness) !== itemBinding ||
      currentSourceBinding(input.itemId) !== sourcesBinding) {
      return bootstrapResult('stale', beforeAdmission, usage, 'Item, source, or authority changed before retained identity evidence admission.');
    }
    if (retained.collectedVia !== 'static_extraction' && retained.collectedVia !== 'rendered_browser' && retained.collectedVia !== 'ocr') {
      return bootstrapResult('needs_attention', beforeAdmission, usage, 'Retained identity evidence uses an unsupported collection method.');
    }
    const admission = admitItemEvidenceContribution({
      workspaceId: input.workspaceId, itemId: input.itemId, collectedVia: retained.collectedVia,
      sourceUrl: retained.sourceUrl ?? confirmed.url, finalUrl: retained.finalUrl, observedAt: retained.observedAt,
      expiresAt: retained.expiresAt, contentType: retained.contentType, content: retained.content, facts: additional,
    });
    if (admission.status === 'conflict') return { status: 'conflict', evidence: admission.evidence, checklist: beforeAdmission.readiness.evaluation, modelCallIds: [], usage, reason: admission.findings[0]?.reason ?? 'Retained official identity evidence conflicts with current item authority.' };
    if (admission.status === 'stale') return { status: 'stale', evidence: admission.evidence, checklist: beforeAdmission.readiness.evaluation, modelCallIds: [], usage, reason: admission.findings[0]?.reason ?? 'Retained identity evidence admission lost currentness.' };
    if (admission.status !== 'accepted' || !admission.evidence) return bootstrapResult('needs_attention', beforeAdmission, usage, admission.findings[0]?.reason ?? 'Retained complete-page identity facts could not be admitted.');
    const finalState = loadCurrentStateForInput(input);
    return finalState.status === 'ok'
      ? bootstrapResult('completed', finalState, usage, 'Complete retained official-page identity provenance was admitted; classification remains pending.')
      : bootstrapResult(finalState.status, finalState, usage, finalState.reason ?? 'Current identity evidence became unavailable.');
  }

  const missingFields = IDENTITY_BOOTSTRAP_FIELDS.filter(field => !knownFields.has(field));
  const actionRoute = checkItemAcquisitionActionRoute(input.modelPolicy ?? null);
  if (actionRoute.status !== 'available') return bootstrapResult('unavailable', initial, usage, actionRoute.reason);
  let actionPrice: ItemAcquisitionModelPrice | null;
  try { actionPrice = getItemAcquisitionModelPrice(actionRoute.provider, actionRoute.model); }
  catch (error) {
    const failure = error instanceof ItemAcquisitionBudgetDeniedError
      ? mapBudgetFailure(error)
      : { status: 'unavailable' as const, reason: 'The TypeSafe bootstrap action model has no enforceable approved price and token bound.' };
    return bootstrapResult(failure.status, initial, usage, failure.reason);
  }
  if (!actionPrice) return bootstrapResult('unavailable', initial, usage, 'The TypeSafe bootstrap action model has no enforceable approved price and token bound.');
  const ids = candidateIds(input.runId, evidence?.evidenceHash ?? itemBinding, candidateUrl);
  const candidate: ItemEvidenceBrowserCandidate = { id: ids.candidateId, url: candidateUrl };
  const action: ItemEvidenceBrowserAction = { id: ids.actionId, candidateId: candidate.id, kind: 'observe' };
  const options: ItemAcquisitionActionOption[] = [{ id: action.id, kind: 'observe', candidateId: candidate.id, label: 'Observe the current confirmed official product page' }];
  const decision = await decideItemAcquisitionAction({
    runId: input.runId, itemId: input.itemId, sku: item.upc, itemName: item.name,
    missingFields: [...missingFields], actions: options, modelPolicy: input.modelPolicy ?? null, assertHeld: scope.assertHeld,
  });
  usage.calls.push({
    kind: 'typesafe_action_selection', attempts: decision.modelCallIds.length,
    billing: decision.modelCallIds.length === 0 ? 'not_applicable'
      : actionPrice.inputMicrosPerMillionTokens !== null && actionPrice.outputMicrosPerMillionTokens !== null ? 'rate_derived' : 'unavailable',
    modelCallIds: decision.modelCallIds,
  });
  if (decision.modelCallIds.length) usage.attempts += 1;
  if (decision.inputTokens !== undefined) usage.modelInputTokens += decision.inputTokens;
  if (decision.outputTokens !== undefined) usage.modelOutputTokens += decision.outputTokens;
  if (decision.status === 'unavailable') return bootstrapResult('unavailable', initial, usage, decision.reason);
  if (decision.status === 'stale') return bootstrapResult('stale', initial, usage, decision.reason);
  if (decision.status === 'abstain') return bootstrapResult('needs_attention', initial, usage, decision.reason);
  if (decision.actionId !== action.id) return bootstrapResult('stale', initial, usage, 'TypeSafe selected an ID outside the current confirmed-page action.');

  scope.assertHeld();
  const beforeBrowser = loadCurrentStateForInput(input);
  const currentConfirmed = getConfirmedOfficialSource(input.workspaceId, input.itemId);
  if (beforeBrowser.status !== 'ok' || currentBinding(beforeBrowser.readiness) !== itemBinding ||
    currentSourceBinding(input.itemId) !== sourcesBinding || currentConfirmed?.url !== candidate.url) {
    return bootstrapResult('stale', beforeBrowser, usage, 'Item, confirmed URL, or authority changed before browser dispatch.');
  }
  const budget = itemAcquisitionInvestigationBudget();
  const ledger = createItemAcquisitionBudgetLedger();
  const browserReservation = reserveItemAcquisitionAttempt({
    kind: 'browser', provider: 'browser', model: '',
    resources: { attempts: 0, pages: 1, actions: 1, redirects: 0, bytes: budget.maxObservationBytesPerOperation, artifacts: 1, durationMs: 0, inputTokens: 0, outputTokens: 0 },
  });
  const browserResources = { pages: 0, actions: 0, bytes: 0, requestAttempts: 0, redirects: 0, responseBytesTransferred: 0 };
  let reservationSettled = false;
  let usageRecorded = false;
  let dispatched = false;
  try {
    scope.assertHeld();
    markItemAcquisitionDispatched(browserReservation.id);
    dispatched = true;
    const result = await collectItemEvidenceBrowser({
      investigationId: `item-acquisition-${input.runId}`, workspaceId: input.workspaceId,
      candidates: [candidate], actions: [action], budget, ledger, resources: browserResources, signal: scope.signal,
    });
    settleItemAcquisitionAttempt(browserReservation.id, {
      actualResources: { attempts: 0, pages: result.usage.pages, actions: result.usage.actions, redirects: 0,
        bytes: result.usage.bytes, artifacts: result.observations.length, durationMs: 0, inputTokens: 0, outputTokens: 0 },
      billing: 'not_applicable',
    });
    reservationSettled = true;
    const observation = result.observations[0];
    const browserPrice = scope.policy.services.find(service => service.service === 'browser')?.costMicrosPerAttempt ?? null;
    usage.attempts += result.usage.requestAttempts;
    usage.pages += result.usage.pages;
    usage.actions += result.usage.actions;
    usage.redirects += result.usage.redirects;
    usage.requestAttempts += result.usage.requestAttempts;
    usage.bytes += result.usage.bytes + result.usage.responseBytesTransferred;
    usage.calls.push({ kind: 'guarded_browser', attempts: result.usage.requestAttempts,
      billing: result.usage.requestAttempts === 0 ? 'not_applicable' : browserPrice === null ? 'unavailable' : 'flat_rate', modelCallIds: [] });
    usageRecorded = true;
    const beforeAdmission = loadCurrentStateForInput(input);
    const liveSource = getConfirmedOfficialSource(input.workspaceId, input.itemId);
    const currentDomains = getAllowedOfficialPageDomains({ workspaceId: input.workspaceId, itemId: input.itemId, brandHint: findItemById(input.itemId)?.brandHint ?? null });
    if (beforeAdmission.status !== 'ok' || currentBinding(beforeAdmission.readiness) !== itemBinding ||
      currentSourceBinding(input.itemId) !== sourcesBinding || liveSource?.url !== candidate.url) {
      return bootstrapResult('stale', beforeAdmission, usage, 'Item, official source, or authority changed before bootstrap evidence admission.', decision.modelCallIds);
    }
    const finalUrl = observation.finalUrl;
    if (!isSafeOfficialCandidate(finalUrl, currentDomains)) {
      return bootstrapResult('conflict', beforeAdmission, usage, 'The confirmed page redirected outside current approved manufacturer authority; no content was admitted.', decision.modelCallIds);
    }
    const contentType = observation.contentType.toLowerCase().split(';', 1)[0]!;
    if (contentType !== 'text/plain' && contentType !== 'application/json') return bootstrapResult('needs_attention', beforeAdmission, usage, 'The complete official page has an unsupported content type.', decision.modelCallIds);
    const facts = buildSourceFacts(observation.content, contentType, IDENTITY_BOOTSTRAP_FIELDS.map(field => ({ field })));
    if (!facts.some(fact => ['title', 'name'].includes(fact.field.toLowerCase()))) {
      return bootstrapResult('needs_attention', beforeAdmission, usage, 'The complete official page contains no code-recognized direct product-title reference; no generated identity was admitted.', decision.modelCallIds);
    }
    const additional = facts.filter(fact => ['title', 'name'].includes(fact.field.toLowerCase()) || !knownFields.has(fact.field));
    const admission = admitItemEvidenceContribution({
      workspaceId: input.workspaceId, itemId: input.itemId, collectedVia: 'rendered_browser',
      sourceUrl: observation.sourceUrl, finalUrl, observedAt: new Date().toISOString(), expiresAt: null,
      contentType, content: observation.content, facts: additional,
    });
    if (admission.status === 'conflict') return { status: 'conflict', evidence: admission.evidence, checklist: beforeAdmission.readiness.evaluation, modelCallIds: decision.modelCallIds, usage, reason: admission.findings[0]?.reason ?? 'Server identity, variant, rights, or source-authority validation found a hard conflict.' };
    if (admission.status === 'stale') return { status: 'stale', evidence: admission.evidence, checklist: beforeAdmission.readiness.evaluation, modelCallIds: decision.modelCallIds, usage, reason: admission.findings[0]?.reason ?? 'Bootstrap evidence admission lost currentness.' };
    if (admission.status !== 'accepted' || !admission.evidence) return bootstrapResult('needs_attention', beforeAdmission, usage, admission.findings[0]?.reason ?? 'The complete official observation did not pass server-side identity admission.', decision.modelCallIds);
    const finalState = loadCurrentStateForInput(input);
    return finalState.status === 'ok'
      ? bootstrapResult('completed', finalState, usage, 'Complete confirmed official-page identity facts were admitted; listing classification remains pending.', decision.modelCallIds)
      : bootstrapResult(finalState.status, finalState, usage, finalState.reason ?? 'Current bootstrap evidence became unavailable.', decision.modelCallIds);
  } catch (error) {
    if (!reservationSettled) {
      if (dispatched) {
        settleItemAcquisitionAttempt(browserReservation.id, { actualResources: browserReservation.resources, billing: 'unknown' });
        usage.unknownBytes += browserReservation.resources.bytes;
      } else {
        try { releaseItemAcquisitionReservation(browserReservation.id, 'bootstrap_browser_not_dispatched'); } catch { /* Keep failed releases fail-closed. */ }
      }
    }
    if (!usageRecorded) {
      usage.attempts += browserResources.requestAttempts;
      usage.requestAttempts += browserResources.requestAttempts;
      usage.redirects += browserResources.redirects;
      usage.bytes += browserResources.responseBytesTransferred;
      usage.calls.push({ kind: 'guarded_browser', attempts: browserResources.requestAttempts,
        billing: browserResources.requestAttempts === 0 ? 'not_applicable' : 'unavailable', modelCallIds: [] });
    }
    const latest = loadCurrentStateForInput(input);
    if (latest.status !== 'ok') return bootstrapResult(latest.status, latest, usage, latest.reason ?? 'Current bootstrap evidence is unavailable.', decision.modelCallIds);
    if (currentBinding(latest.readiness) !== itemBinding) return bootstrapResult('stale', latest, usage, 'Item or evidence changed during confirmed-page collection.', decision.modelCallIds);
    if (error instanceof ItemAcquisitionBudgetDeniedError) {
      const failure = mapBudgetFailure(error);
      return bootstrapResult(failure.status, latest, usage, failure.reason, decision.modelCallIds);
    }
    if (scope.signal.aborted) return bootstrapResult('cancelled', latest, usage, 'Confirmed-page collection was cancelled.', decision.modelCallIds);
    const failure = classifyBrowserError(error);
    return bootstrapResult(failure.status, latest, usage, failure.reason, decision.modelCallIds);
  }
}
async function runWithinBudget(input: RunItemEvidenceAcquisitionInput, usage: ItemEvidenceAcquisitionUsage): Promise<ItemEvidenceAcquisitionResult> {
  return withItemAcquisitionBudget({
    workspaceId: input.workspaceId, itemId: input.itemId, runId: input.runId,
    signal: input.signal, assertHeld: input.assertHeld,
  }, async scope => {
    const initial = loadCurrentStateForInput(input);
    if (initial.status !== 'ok') return { status: initial.status, evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: [], usage, reason: initial.reason ?? 'Current acquisition state is unavailable.' };
    if (input.intent === 'identity_bootstrap') return runIdentityBootstrapWithinBudget(input, scope, initial, usage);
    if (initial.readiness.evaluation.status === 'ready' && initial.readiness.classificationReady) {
      return { status: 'completed', evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: [], usage, reason: 'The current-run listing checklist and reviewed classification are satisfied; no supplemental retrieval was dispatched.' };
    }
    if (initial.readiness.evaluation.status === 'ready' && !initial.readiness.classificationReady) {
      return { status: 'needs_attention', evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: [], usage, reason: initial.readiness.classificationReason ?? 'Human review is required before the current listing classification can be ready.' };
    }
    const gaps = supportedGaps(initial.readiness);
    if (gaps.length === 0) return { status: 'needs_attention', evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: [], usage, reason: 'No missing checklist field is both manufacturer-authorized and supported by complete retained-page extraction.' };
    let domains: string[];
    try { domains = getAllowedOfficialPageDomains({ workspaceId: input.workspaceId, itemId: input.itemId, brandHint: findItemById(input.itemId)?.brandHint ?? null }); }
    catch { return { status: 'unavailable', evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: [], usage, reason: 'Current manufacturer-domain authority could not be loaded; no search or page request was made.' }; }
    if (domains.length === 0) return { status: 'unavailable', evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: [], usage, reason: 'No approved manufacturer domain is configured; approve an official domain before supplemental search.' };
    const authorityBinding = [...domains].sort().join('\0');

    const actionRoute = checkItemAcquisitionActionRoute(input.modelPolicy ?? null);
    if (actionRoute.status !== 'available') return { status: 'unavailable', evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: [], usage, reason: actionRoute.reason };
    let actionPrice: ItemAcquisitionModelPrice | null;
    try { actionPrice = getItemAcquisitionModelPrice(actionRoute.provider, actionRoute.model); }
    catch (error) {
      const failure = error instanceof ItemAcquisitionBudgetDeniedError ? mapBudgetFailure(error) : { status: 'unavailable' as const, reason: 'The TypeSafe action model has no enforceable approved item price and token bound.' };
      return { ...failure, evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: [], usage, reason: failure.reason };
    }
    if (!actionPrice) return { status: 'unavailable', evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: [], usage, reason: 'The TypeSafe action model has no enforceable approved item price and token bound.' };
    const sourceCandidates = new Map<string, { id: string; url: string }>();
    let sourceBinding: string;
    try {
      const sources = listSourcesByItem(input.itemId);
      sourceBinding = sourceStateBinding(sources);
      for (const source of sources) {
        if (!source.isSelected) continue;
        const url = isSafeOfficialCandidate(source.url, domains);
        if (url) sourceCandidates.set(url, { id: candidateIds(input.runId, currentBinding(initial.readiness), url).candidateId, url });
      }
    } catch { return { status: 'unavailable', evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: [], usage, reason: 'Current approved source records could not be read.' }; }

    if (sourceCandidates.size === 0) {
      if (input.modelPolicy?.textDataSharing !== 'cloud_allowed') {
        return { status: 'needs_attention', evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: [], usage, reason: 'Brave Search requires explicit cloud text-sharing permission; no query was sent.' };
      }
      const item = findItemById(input.itemId);
      if (!item || !item.upc || !item.name) return { status: 'stale', evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: [], usage, reason: 'The current imported item identity is unavailable.' };
      const reservedBytes = Math.min(scope.policy.itemLimits.bytes, BRAVE_SEARCH_MAX_RESPONSE_BYTES);
      if (reservedBytes < 1) return { status: 'budget_exhausted', evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: [], usage, reason: 'The approved byte budget cannot cover even a bounded Brave response.' };
      const reservation = reserveItemAcquisitionAttempt({
        kind: 'brave_search', provider: 'brave_search', model: 'web',
        resources: { attempts: 1, pages: 0, actions: 0, redirects: 0, bytes: reservedBytes, artifacts: 0, durationMs: BRAVE_SEARCH_TIMEOUT_MS, inputTokens: 0, outputTokens: 0 },
      });
      let dispatched = false;
      let searchReservationSettled = false;
      const startedAt = Date.now();
      try {
        scope.assertHeld();
        const beforeSearch = loadCurrentStateForInput(input);
        if (beforeSearch.status !== 'ok' || currentBinding(beforeSearch.readiness) !== currentBinding(initial.readiness) ||
          currentSourceBinding(input.itemId) !== sourceBinding) {
          releaseItemAcquisitionReservation(reservation.id, 'item_or_source_state_changed_before_search');
          return { status: 'stale', evidence: beforeSearch.evidence, checklist: beforeSearch.readiness.evaluation, modelCallIds: [], usage, reason: 'Item, source, or checklist state changed before search dispatch.' };
        }
        const currentDomains = getAllowedOfficialPageDomains({ workspaceId: input.workspaceId, itemId: input.itemId, brandHint: findItemById(input.itemId)?.brandHint ?? null });
        if ([...currentDomains].sort().join('\0') !== authorityBinding) {
          releaseItemAcquisitionReservation(reservation.id, 'manufacturer_authority_changed_before_search');
          return { status: 'stale', evidence: beforeSearch.evidence, checklist: beforeSearch.readiness.evaluation, modelCallIds: [], usage, reason: 'Manufacturer-domain authority changed before search dispatch.' };
        }
        const results = await searchBraveWeb(`${item.upc} ${item.name}`, {
          count: 20, maxResponseBytes: reservedBytes, signal: scope.signal,
          onDispatch: () => { scope.assertHeld(); markItemAcquisitionDispatched(reservation.id); dispatched = true; },
        });
        const actualResources = { attempts: 1, pages: 0, actions: 0, redirects: 0, bytes: results.responseBytes, artifacts: 0, durationMs: Date.now() - startedAt, inputTokens: 0, outputTokens: 0 };
        settleItemAcquisitionAttempt(reservation.id, { actualResources, billing: reservation.costMicros === null ? 'unknown' : 'known', actualCostMicros: reservation.costMicros });
        searchReservationSettled = true;
        usage.attempts += 1;
        usage.requestAttempts += 1;
        usage.bytes += results.responseBytes;
        usage.calls.push({ kind: 'brave_search', attempts: 1, billing: reservation.costMicros === null ? 'unavailable' : 'flat_rate', modelCallIds: [] });
        for (const result of results.results) {
          const url = isSafeOfficialCandidate(result.url, domains);
          if (url) sourceCandidates.set(url, { id: candidateIds(input.runId, currentBinding(initial.readiness), url).candidateId, url });
        }
      } catch (error) {
        if (dispatched && !searchReservationSettled) {
          settleItemAcquisitionAttempt(reservation.id, { actualResources: reservation.resources, billing: 'unknown' });
          usage.attempts += 1;
          usage.requestAttempts += 1;
          usage.unknownBytes += reservation.resources.bytes;
          usage.calls.push({ kind: 'brave_search', attempts: 1, billing: 'unavailable', modelCallIds: [] });
        } else if (!dispatched) {
          try { releaseItemAcquisitionReservation(reservation.id, error instanceof BraveSearchError && error.code === 'credential_missing' ? 'brave_credential_missing' : 'brave_search_not_dispatched'); } catch { /* A failed release retains the safe reservation. */ }
        }
        if (error instanceof BraveSearchError && error.code === 'cancelled' || scope.signal.aborted) return { status: 'cancelled', evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: [], usage, reason: 'Brave Search was cancelled.' };
        if (error instanceof BraveSearchError && error.code === 'credential_missing') return { status: 'unavailable', evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: [], usage, reason: 'Brave Search credential is missing; configure the server-side brave_search API key.' };
        if (error instanceof ItemAcquisitionBudgetDeniedError) { const failure = mapBudgetFailure(error); return { ...failure, evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: [], usage, reason: failure.reason }; }
        return { status: 'unavailable', evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: [], usage, reason: 'Brave Search did not return a complete usable response; no snippet was treated as evidence.' };
      }
      if (sourceCandidates.size === 0) return { status: 'needs_attention', evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: [], usage, reason: 'Brave Search found no URLs inside the currently approved manufacturer domains.' };
      if (sourceCandidates.size > scope.policy.itemLimits.pages) return { status: 'budget_exhausted', evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: [], usage, reason: 'The complete approved candidate set exceeds the per-item page budget; candidates were not truncated.' };
    }

    const candidateValues = [...sourceCandidates.values()];
    if (candidateValues.length > scope.policy.itemLimits.pages) return { status: 'budget_exhausted', evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: [], usage, reason: 'The complete approved source set exceeds the per-item page budget; candidates were not truncated.' };
    const candidates: ItemEvidenceBrowserCandidate[] = candidateValues;
    const actionById = new Map<string, ItemEvidenceBrowserAction>();
    const actions: ItemEvidenceBrowserAction[] = [];
    const options: ItemAcquisitionActionOption[] = [];
    for (const candidate of candidates) {
      const actionId = candidateIds(input.runId, currentBinding(initial.readiness), candidate.url).actionId;
      const action: ItemEvidenceBrowserAction = { id: actionId, candidateId: candidate.id, kind: 'observe' };
      actions.push(action);
      actionById.set(actionId, action);
      options.push({ id: actionId, kind: 'observe', candidateId: candidate.id, label: 'Observe one supplied approved manufacturer product page' });
    }
    const decision = await decideItemAcquisitionAction({
      runId: input.runId, itemId: input.itemId, sku: findItemById(input.itemId)?.upc ?? '',
      itemName: findItemById(input.itemId)?.name ?? '', missingFields: gaps.map(gap => gap.field), actions: options,
      modelPolicy: input.modelPolicy ?? null, assertHeld: scope.assertHeld,
    });
    const actionBilling = decision.modelCallIds.length === 0 ? 'not_applicable'
      : actionPrice.inputMicrosPerMillionTokens !== null && actionPrice.outputMicrosPerMillionTokens !== null ? 'rate_derived' : 'unavailable';
    usage.calls.push({ kind: 'typesafe_action_selection', attempts: decision.modelCallIds.length, billing: actionBilling, modelCallIds: decision.modelCallIds });
    if (decision.modelCallIds.length) usage.attempts += 1;
    if (decision.inputTokens !== undefined) usage.modelInputTokens += decision.inputTokens;
    if (decision.outputTokens !== undefined) usage.modelOutputTokens += decision.outputTokens;
    if (decision.status === 'unavailable') return { status: 'unavailable', evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: decision.modelCallIds, usage, reason: decision.reason };
    if (decision.status === 'stale') return { status: 'stale', evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: decision.modelCallIds, usage, reason: decision.reason };
    if (decision.status === 'abstain') return { status: 'needs_attention', evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: decision.modelCallIds, usage, reason: decision.reason };
    const selected = actionById.get(decision.actionId ?? '');
    if (!selected) return { status: 'stale', evidence: initial.evidence, checklist: initial.readiness.evaluation, modelCallIds: decision.modelCallIds, usage, reason: 'TypeSafe returned an action ID outside the current supplied set; no page was loaded.' };
    scope.assertHeld();
    const beforeBrowser = loadCurrentStateForInput(input);
    if (beforeBrowser.status !== 'ok' || currentBinding(beforeBrowser.readiness) !== currentBinding(initial.readiness) ||
      currentSourceBinding(input.itemId) !== sourceBinding) {
      return { status: 'stale', evidence: beforeBrowser.evidence, checklist: beforeBrowser.readiness.evaluation, modelCallIds: decision.modelCallIds, usage, reason: 'Item, source, or checklist changed after action selection; the stale action was not executed.' };
    }
    const liveDomains = getAllowedOfficialPageDomains({ workspaceId: input.workspaceId, itemId: input.itemId, brandHint: findItemById(input.itemId)?.brandHint ?? null });
    if ([...liveDomains].sort().join('\0') !== authorityBinding) {
      return { status: 'stale', evidence: beforeBrowser.evidence, checklist: beforeBrowser.readiness.evaluation, modelCallIds: decision.modelCallIds, usage, reason: 'Manufacturer-domain authority changed after action selection; no page was loaded.' };
    }
    const candidate = candidates.find(entry => entry.id === selected.candidateId);
    if (!candidate || !isSafeOfficialCandidate(candidate.url, liveDomains)) return { status: 'stale', evidence: beforeBrowser.evidence, checklist: beforeBrowser.readiness.evaluation, modelCallIds: decision.modelCallIds, usage, reason: 'The selected source no longer belongs to current approved manufacturer authority.' };

    const budget = itemAcquisitionInvestigationBudget();
    const selectedCandidate: ItemEvidenceBrowserCandidate = candidate;
    const selectedAction: ItemEvidenceBrowserAction = selected;
    const reservedBytes = budget.maxObservationBytesPerOperation;
    const ledger = createItemAcquisitionBudgetLedger();
    const browserReservation = reserveItemAcquisitionAttempt({
      kind: 'browser', provider: 'browser', model: '',
      resources: { attempts: 0, pages: 1, actions: 1, redirects: 0, bytes: reservedBytes, artifacts: 1, durationMs: 0, inputTokens: 0, outputTokens: 0 },
    });
    const browserResources = { pages: 0, actions: 0, bytes: 0, requestAttempts: 0, redirects: 0, responseBytesTransferred: 0 };
    let browserReservationSettled = false;
    let browserUsageRecorded = false;
    try {
      scope.assertHeld();
      markItemAcquisitionDispatched(browserReservation.id);
      const observed = await collectItemEvidenceBrowser({
        investigationId: `item-acquisition-${input.runId}`, workspaceId: input.workspaceId,
        candidates: [selectedCandidate], actions: [selectedAction], budget, ledger, resources: browserResources, signal: scope.signal,
      });
      const transferBytes = observed.usage.responseBytesTransferred;
      const redirects = observed.usage.redirects;
      const actualResources = {
        attempts: 0, pages: observed.usage.pages, actions: observed.usage.actions,
        redirects: 0, bytes: observed.usage.bytes, artifacts: observed.observations.length,
        durationMs: 0, inputTokens: 0, outputTokens: 0,
      };
      settleItemAcquisitionAttempt(browserReservation.id, { actualResources, billing: 'not_applicable' });
      browserReservationSettled = true;
      const browserPrice = scope.policy.services.find(service => service.service === 'browser')?.costMicrosPerAttempt ?? null;
      usage.attempts += observed.usage.requestAttempts;
      usage.pages += observed.usage.pages;
      usage.actions += observed.usage.actions;
      usage.redirects += redirects;
      usage.requestAttempts += observed.usage.requestAttempts;
      usage.bytes += observed.usage.bytes + transferBytes;
      usage.calls.push({ kind: 'guarded_browser', attempts: observed.usage.requestAttempts, billing: observed.usage.requestAttempts === 0 ? 'not_applicable' : browserPrice === null ? 'unavailable' : 'flat_rate', modelCallIds: [] });
      browserUsageRecorded = true;
      const observation = observed.observations[0];
      const currentDomains = getAllowedOfficialPageDomains({ workspaceId: input.workspaceId, itemId: input.itemId, brandHint: findItemById(input.itemId)?.brandHint ?? null });
      const beforeAdmission = loadCurrentStateForInput(input);
      if (beforeAdmission.status !== 'ok' || currentBinding(beforeAdmission.readiness) !== currentBinding(initial.readiness) ||
        currentSourceBinding(input.itemId) !== sourceBinding) {
        return { status: 'stale', evidence: beforeAdmission.evidence, checklist: beforeAdmission.readiness.evaluation, modelCallIds: decision.modelCallIds, usage, reason: 'Item, source, or checklist changed before evidence admission.' };
      }
      if ([...currentDomains].sort().join('\0') !== authorityBinding) {
        return { status: 'stale', evidence: beforeAdmission.evidence, checklist: beforeAdmission.readiness.evaluation, modelCallIds: decision.modelCallIds, usage, reason: 'Manufacturer-domain authority changed before evidence admission.' };
      }
      const finalUrl = observation.finalUrl;
      if (!isSafeOfficialCandidate(finalUrl, currentDomains)) return { status: 'conflict', evidence: beforeAdmission.evidence, checklist: beforeAdmission.readiness.evaluation, modelCallIds: decision.modelCallIds, usage, reason: 'The observed page redirected outside current approved manufacturer authority; its content was not admitted.' };
      const contentType = observation.contentType.toLowerCase().split(';', 1)[0]!;
      if (contentType !== 'text/plain' && contentType !== 'application/json') return { status: 'needs_attention', evidence: beforeAdmission.evidence, checklist: beforeAdmission.readiness.evaluation, modelCallIds: decision.modelCallIds, usage, reason: 'The complete page has an unsupported content type.' };
      const facts = buildSourceFacts(observation.content, contentType, gaps);
      if (facts.length === 0) return { status: 'needs_attention', evidence: beforeAdmission.evidence, checklist: beforeAdmission.readiness.evaluation, modelCallIds: decision.modelCallIds, usage, reason: 'The complete approved page contained no code-recognized explicit field values; no partial or generated fact was admitted.' };
      const admission = admitItemEvidenceContribution({
        workspaceId: input.workspaceId, itemId: input.itemId, collectedVia: 'rendered_browser',
        sourceUrl: observation.sourceUrl, finalUrl, observedAt: new Date().toISOString(), expiresAt: null,
        contentType, content: observation.content, facts,
      });
      if (admission.status === 'conflict') return { status: 'conflict', evidence: admission.evidence, checklist: initial.readiness.evaluation, modelCallIds: decision.modelCallIds, usage, reason: admission.findings[0]?.reason ?? 'The server rejected the evidence contribution at a hard identity, authority, or conflict boundary.' };
      if (admission.status === 'stale') return { status: 'stale', evidence: admission.evidence, checklist: initial.readiness.evaluation, modelCallIds: decision.modelCallIds, usage, reason: admission.findings[0]?.reason ?? 'Evidence admission lost its current-state compare-and-swap.' };
      if (admission.status !== 'accepted' || !admission.evidence) return { status: 'unavailable', evidence: admission.evidence, checklist: initial.readiness.evaluation, modelCallIds: decision.modelCallIds, usage, reason: admission.findings[0]?.reason ?? 'The complete browser observation could not be accepted as item evidence.' };
      const finalState = loadCurrentStateForInput(input);
      if (finalState.status !== 'ok') return { status: finalState.status, evidence: finalState.evidence, checklist: finalState.readiness.evaluation, modelCallIds: decision.modelCallIds, usage, reason: finalState.reason ?? 'Current evidence became unavailable after admission.' };
      const status: ItemEvidenceAcquisitionStatus = finalState.readiness.evaluation.status === 'ready' && finalState.readiness.classificationReady ? 'completed' : 'needs_attention';
      return { status, evidence: finalState.evidence, checklist: finalState.readiness.evaluation, modelCallIds: decision.modelCallIds, usage,
        reason: status === 'completed' ? 'The current-run listing checklist is satisfied by newly admitted complete source evidence.' : 'Complete authorized evidence was admitted; remaining checklist gaps need attention.' };
    } catch (error) {
      if (!browserReservationSettled) {
        settleItemAcquisitionAttempt(browserReservation.id, { actualResources: browserReservation.resources, billing: 'unknown' });
        usage.unknownBytes += browserReservation.resources.bytes;
      }
      if (!browserUsageRecorded) {
        usage.attempts += browserResources.requestAttempts;
        usage.requestAttempts += browserResources.requestAttempts;
        usage.redirects += browserResources.redirects;
        usage.bytes += browserResources.responseBytesTransferred;
        usage.calls.push({
          kind: 'guarded_browser', attempts: browserResources.requestAttempts,
          billing: browserResources.requestAttempts === 0 ? 'not_applicable' : 'unavailable', modelCallIds: [],
        });
      }
      const latest = loadCurrentStateForInput(input);
      if (latest.status !== 'ok') return { status: latest.status, evidence: latest.evidence, checklist: latest.readiness.evaluation, modelCallIds: decision.modelCallIds, usage, reason: latest.reason ?? 'Current acquisition state is unavailable.' };
      let sourceChanged: boolean;
      try { sourceChanged = currentSourceBinding(input.itemId) !== sourceBinding; } catch { sourceChanged = true; }
      if (currentBinding(latest.readiness) !== currentBinding(initial.readiness) || sourceChanged) {
        return { status: 'stale', evidence: latest.evidence, checklist: latest.readiness.evaluation, modelCallIds: decision.modelCallIds, usage, reason: 'Item, source, or checklist changed during guarded collection.' };
      }
      if (error instanceof ItemAcquisitionBudgetDeniedError) { const failure = mapBudgetFailure(error); return { ...failure, evidence: latest.evidence, checklist: latest.readiness.evaluation, modelCallIds: decision.modelCallIds, usage, reason: failure.reason }; }
      if (scope.signal.aborted) return { status: 'cancelled', evidence: latest.evidence, checklist: latest.readiness.evaluation, modelCallIds: decision.modelCallIds, usage, reason: 'Guarded page collection was cancelled.' };
      const failure = classifyBrowserError(error);
      return { ...failure, evidence: latest.evidence, checklist: latest.readiness.evaluation, modelCallIds: decision.modelCallIds, usage, reason: failure.reason };
    }
  });
}

/** Run bounded supplemental retrieval; all executions are inside a durable item+batch budget scope. */
export async function runItemEvidenceAcquisition(input: RunItemEvidenceAcquisitionInput): Promise<ItemEvidenceAcquisitionResult> {
  const usage = emptyUsage();
  let state = loadCurrentStateForInput(input);
  if (state.status !== 'ok') return { status: state.status, evidence: state.evidence, checklist: state.readiness.evaluation, modelCallIds: [], usage, reason: state.reason ?? 'Current acquisition state is unavailable.' };
  if (state.readiness.evaluation.status === 'ready' && state.readiness.classificationReady) return { status: 'completed', evidence: state.evidence, checklist: state.readiness.evaluation, modelCallIds: [], usage, reason: 'The current-run listing checklist and reviewed classification are satisfied; no supplemental retrieval was dispatched.' };
  if (state.readiness.evaluation.status === 'ready' && !state.readiness.classificationReady) return { status: 'needs_attention', evidence: state.evidence, checklist: state.readiness.evaluation, modelCallIds: [], usage, reason: state.readiness.classificationReason ?? 'Human review is required before the current listing classification can be ready.' };
  try {
    return await runWithinBudget(input, usage);
  } catch (error) {
    state = loadCurrentStateForInput(input);
    if (state.status !== 'ok') return { status: state.status, evidence: state.evidence, checklist: state.readiness.evaluation, modelCallIds: usage.calls.flatMap(call => call.modelCallIds), usage, reason: state.reason ?? 'Current acquisition state is unavailable.' };
    if (error instanceof ItemAcquisitionBudgetDeniedError) {
      const failure = mapBudgetFailure(error);
      return { ...failure, evidence: state.evidence, checklist: state.readiness.evaluation, modelCallIds: usage.calls.flatMap(call => call.modelCallIds), usage, reason: failure.reason };
    }
    if (input.signal?.aborted) return { status: 'cancelled', evidence: state.evidence, checklist: state.readiness.evaluation, modelCallIds: usage.calls.flatMap(call => call.modelCallIds), usage, reason: 'Acquisition was cancelled.' };
    return unavailableResult('Supplemental acquisition is unavailable; no evidence was accepted.', state.readiness.evaluation, state.evidence, usage);
  }
}
