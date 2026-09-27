/**
 * Curation target processor coordinator.
 *
 * Combines the resolver → matcher → ranker → proposal builder pipeline
 * for each target kind. This is the "glue" that the thin stage wrappers
 * delegate to, so stage files contain orchestration only — no duplication
 * of matching, ranking, or proposal construction logic.
 */
import type { StageContext, StageInput, CoordinatedPageMemberValue } from './types';
import { type ClassificationProposal, CanonicalBrandEvidenceValueSchema } from '../shared/schemas/classification';
import { CohortPageOutputSchema } from '../shared/schemas/cohorts';
import { loadClassificationConfig } from './config-loader';
import {
  resolveEnabledTargets,
  type ResolvedTarget,
} from './curation-target-resolver';
import {
  matchKeywordOptions,
  matchAttributeOptions,
} from './curation-target-matcher';
import {
  buildEvidenceTargetPacket,
  buildPageEvidencePacket,
  evidenceMatchesTarget,
  resolveCanonicalAssertion,
  tokenGroundingSupport,
  type EvidenceTargetPacket,
} from './evidence-targeting';
import { enrichProductDetails } from './detail-enrichment';
import { llmRankOptions } from './curation-target-ranker';
import { isCalibratedBulkAcceptable } from './proposal-safety';
import type { CalibratedThresholds } from './confidence-calibrator';
import { buildModelCallContext } from './runtime-snapshot';
import { modelPolicyViewFromConfig } from '../onboarding/model-policy-snapshot';
import type { ModelPolicyConfigV2 } from '../shared/schemas/classification';
import {
  buildProductTypeProposal,
  buildFieldAssignmentProposal,
  buildCategoryPageProposal,
} from './curation-target-proposal';
import {
  buildPageHierarchy,
  extractProductContext,
  llmAssignCategoryPages,
  type PageAssignmentResult,
} from './page-assignment-llm';
import { coordinateCohortPagesOnce } from './cohort-page-proposal-engine';

// ─── Shared Target Constants ──────────────────────────────────────────────────

const KEYWORD_MATCH_MIN_CONFIDENCE = 0.7;

/**
 * Reviewed page-context source fields (issue #17 H): the Page stage uses only
 * identity/species/type/category context. Cross-species evidence is a
 * contradiction/rejection signal, never hidden concatenated text.
 */
const PAGE_CONTEXT_SOURCE_FIELDS = [
  'name',
  'title',
  'description',
  'page_name',
  'category',
  'species',
  'productForm',
  'productType',
  'brand',
  'resolved_brand',
];

/** Reviewed page-context attribute ids (records with explicit attributeId). */
const PAGE_CONTEXT_ATTRIBUTE_IDS = ['species', 'brand'];

/**
 * Reviewed species value for cross-species page-context detection. Uses a
 * REVIEWED fact (accepted decision carried in the snapshot), never
 * first-evidence order: reversing evidence order must not change which
 * species is labeled contradictory. Without a reviewed fact, no species
 * contradiction can be labeled.
 */
function reviewedSpeciesValue(context: StageContext): unknown {
  const facts = context.snapshot?.reviewedFacts ?? [];
  const speciesFact = facts.find(f => f.targetId === 'species');
  return speciesFact?.value ?? undefined;
}

// ─── Shared small helpers (complexity/duplication extraction) ───────────────
// Each helper is intentionally tiny (<60 lines, <20 cyclomatic) so the Fallow
// complexity gate passes per-function. Behavior is preserved verbatim: same
// inputs, same outputs, same ordering, same confidence floors, same messages.
// Frozen execution hashes and audit/lease behavior are unchanged — these
// helpers only hoist byte-identical blocks out of the oversized processors.

/** Build the frozen model-policy view once (byte-identical everywhere). */
function modelPolicyViewFromSnapshot(snapshot: StageContext['snapshot']) {
  if (!snapshot) return null;
  return modelPolicyViewFromConfig(
    snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
    snapshot.snapshotHash,
  );
}

/** Shared SystemOne route check for `attribute_ranking` (byte-identical). */
async function isSystemOneAttributeRoute(modelPolicy: ReturnType<typeof modelPolicyViewFromConfig> | null): Promise<boolean> {
  if (!modelPolicy) return false;
  try {
    const { resolveModelRoute, assertModelPolicyIntact } = await import('./model-policy-gateway');
    const { getFullAiRoutingConfig } = await import('../db/repositories/provider-connection-repo');
    assertModelPolicyIntact(modelPolicy);
    const resolvedRoute = resolveModelRoute(modelPolicy, 'attribute_ranking', {
      getCredential: (p: string) => {
        try {
          const aiConfig = getFullAiRoutingConfig();
          const conn =
            aiConfig.connections[p] ||
            Object.values(aiConfig.connections).find(
              (c) => c.id === p || (p === 'typesafe' && (c.id === 'typesafe-jev' || c.transport === 'systemone')),
            );
          if (conn && conn.credential) return { provider: p, apiKey: conn.credential, baseUrl: conn.baseUrl, model: null };
        } catch {}
        return null;
      },
      defaultBaseUrls: {
        typesafe: 'https://api.typesafe.ai/v1',
        ollama: 'http://127.0.0.1:11434/v1',
        openai: 'https://api.openai.com/v1',
        deepseek: 'https://api.deepseek.com',
      },
    });
    const aiConfig = getFullAiRoutingConfig();
    const conn =
      aiConfig.connections[resolvedRoute.provider] ||
      Object.values(aiConfig.connections).find(
        (c) => c.id === resolvedRoute.provider || (resolvedRoute.provider === 'typesafe' && (c.id === 'typesafe-jev' || c.transport === 'systemone')),
      );
    return resolvedRoute.provider === 'typesafe' || conn?.transport === 'systemone';
  } catch {
    return false;
  }
}

/**
 * Parse one brand assertion to its canonical identity (mirrors
 * `resolveBrandRecordName` in `attribute-decision.ts` — local helper because
 * the SystemOne decision core is not a natural home for brand parsing).
 * Returns null when the assertion carries no canonical brand.
 */
function parseBrandRecordName(
  recordValue: unknown,
  aliases: Array<{ alias: string; mapsTo: string }> | undefined,
): string | null {
  const parsed = CanonicalBrandEvidenceValueSchema.safeParse(recordValue);
  let name: unknown = parsed.success
    ? parsed.data.brandName
    : ((recordValue as any)?.brandName ?? (recordValue as any)?.name);
  if (typeof name !== 'string' && typeof recordValue === 'string') {
    name = recordValue;
  }
  return resolveCanonicalAssertion(name, aliases ?? []);
}

/** Match detail-enrichment candidates for one attribute (local helper). */
function resolveEnrichmentFieldValues(input: {
  text: string;
  optionStrings: string[];
  aliases: Array<{ alias: string; mapsTo: string }>;
  attrId: string;
  selectionMode: 'single' | 'multiple';
}): { values: string[]; confidence: number } | null {
  const { text, optionStrings, aliases, attrId, selectionMode } = input;
  const enrichmentParams = {
    evidenceText: text,
    packagingOcrData: null as any,
    curatedTitle: null,
    allowedValues: optionStrings,
    aliases,
  };
  const enrichmentCandidates = enrichProductDetails(enrichmentParams);
  const matching = enrichmentCandidates.filter(
    c => c.attributeId === attrId || c.attributeId === 'all',
  );
  if (matching.length === 0) return null;
  const values = [...new Set(matching.map(m => m.value))].slice(
    0, selectionMode === 'multiple' ? 10 : 1,
  );
  return { values, confidence: Math.max(...matching.map(m => m.confidence)) };
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TargetProcessResult {
  proposals: ClassificationProposal[];
  message: string;
}

// ─── Product Type Processing ──────────────────────────────────────────────────

/**
 * Process a product type curation target.
 *
 * Uses keyword matching against evidence first, then falls back to
 * the LLM ranker if no confident match is found.
 */
export async function processProductTypeTarget(
  target: ResolvedTarget,
  input: StageInput,
  context: StageContext,
): Promise<TargetProcessResult> {
  const modelPolicy = modelPolicyViewFromSnapshot(context.snapshot);

  const { resolveProductTypeDecision } = await import('./product-type-decision');
  const decision = await resolveProductTypeDecision({
    target,
    evidence: input.evidence,
    sku: input.sku,
    runId: context.runId,
    snapshot: context.snapshot,
    modelPolicy,
    assertHeld: context.assertHeld,
  });

  if (decision.status === 'abstained' || !decision.productTypeId) {
    return {
      proposals: [],
      message:
        decision.abstentionReason ??
        `Abstained from proposing product type (${decision.abstentionCode ?? 'unresolved'}).`,
    };
  }

  const proposal = buildProductTypeProposal({
    runId: context.runId,
    sku: input.sku,
    productTypeId: decision.productTypeId,
    confidence: decision.confidence,
    evidenceIds: decision.evidenceIds,
    ...(decision.supportingEvidenceIds.length
      ? { supportingEvidenceIds: decision.supportingEvidenceIds }
      : {}),
    ...(decision.contradictingEvidenceIds.length
      ? { contradictingEvidenceIds: decision.contradictingEvidenceIds }
      : {}),
    snapshotHash: context.snapshot?.snapshotHash ?? null,
    ...(decision.modelCallIds.length ? { modelCallIds: decision.modelCallIds } : {}),
    derivation: decision.derivation,
  });

  const sourceLabel =
    decision.source === 'jev' ? 'TypeSafe Jev' : decision.source === 'llm' ? 'llm' : 'keyword';
  const label =
    target.options.find(o => o.value === decision.productTypeId)?.label ?? decision.productTypeId;
  return {
    proposals: [proposal],
    message: `${label} (${sourceLabel}, ${(decision.confidence * 100).toFixed(0)}%)`,
  };
}

// ─── Product Field Processing ─────────────────────────────────────────────────

// Free-text / measured branch (no controlled options required).
function findFreeTextGroundedValue(
  evidence: StageInput['evidence'],
  attrId: string,
  targetSourceFields: string[],
): string | null {
  const grounded = evidence.find(
    e =>
      evidenceMatchesTarget(e, { attributeId: attrId, sourceField: null, sourceFields: targetSourceFields }) &&
      typeof e.value === 'string' &&
      e.value.trim().length > 0,
  );
  return grounded ? String(grounded.value) : null;
}

function proposeFreeTextValue(input: {
  context: StageContext;
  stageInput: StageInput;
  targetConfig: ResolvedTarget['config'];
  groundedValue: string;
  fieldPacket: EvidenceTargetPacket;
  selectionMode: 'single' | 'multiple';
  snapshotHash: string | null;
}): TargetProcessResult {
  const { context, stageInput, targetConfig, groundedValue, fieldPacket, selectionMode, snapshotHash } = input;
  const proposal = buildFieldAssignmentProposal({
    runId: context.runId,
    sku: stageInput.sku,
    attributeId: targetConfig.attributeId ?? targetConfig.id,
    value: groundedValue,
    confidence: 0.85,
    evidenceIds: fieldPacket.evidenceIds,
    supportingEvidenceIds: fieldPacket.supportingEvidenceIds,
    contradictingEvidenceIds: fieldPacket.contradictingEvidenceIds,
    isMultiple: selectionMode === 'multiple',
    snapshotHash,
  });
  return { proposals: [proposal], message: `"${targetConfig.label}": ${groundedValue} (free-text, 85%)` };
}

function proposeMeasuredValue(input: {
  context: StageContext;
  stageInput: StageInput;
  targetConfig: ResolvedTarget['config'];
  groundedValue: string;
  fieldPacket: EvidenceTargetPacket;
  snapshotHash: string | null;
}): TargetProcessResult {
  const { context, stageInput, targetConfig, groundedValue, fieldPacket, snapshotHash } = input;
  const valStr = groundedValue.trim();
  const proposal = buildFieldAssignmentProposal({
    runId: context.runId,
    sku: stageInput.sku,
    attributeId: targetConfig.attributeId ?? targetConfig.id,
    value: valStr,
    confidence: 0.85,
    evidenceIds: fieldPacket.evidenceIds,
    supportingEvidenceIds: fieldPacket.supportingEvidenceIds,
    contradictingEvidenceIds: fieldPacket.contradictingEvidenceIds,
    isMultiple: false,
    snapshotHash,
  });
  return { proposals: [proposal], message: `"${targetConfig.label}": ${valStr} (measured, 85%)` };
}

async function processFreeTextMeasuredTarget(input: {
  target: ResolvedTarget;
  input: StageInput;
  context: StageContext;
  selectionMode: 'single' | 'multiple';
  snapshotHash: string | null;
}): Promise<TargetProcessResult | null> {
  const { target, input: stageInput, context, selectionMode, snapshotHash } = input;
  const { config: targetConfig, attribute } = target;
  if (attribute?.valueMode !== 'freeText' && attribute?.valueMode !== 'measured') return null;
  const attrId = targetConfig.attributeId ?? targetConfig.id;
  const catalogField = targetConfig.catalogField ?? null;
  const targetSourceFields = [catalogField, attrId].filter((f): f is string => Boolean(f));
  const fieldPacket = buildEvidenceTargetPacket(stageInput.evidence, {
    attributeId: attrId,
    sourceField: null,
    sourceFields: targetSourceFields,
    selectionMode,
    aliases: attribute?.valueAliases ?? [],
    isGroundingSupport: tokenGroundingSupport,
  });
  const text = fieldPacket.promptText;
  if (!text || text.trim().length === 0) {
    return { proposals: [], message: `No evidence text for "${targetConfig.label}".` };
  }
  const groundedValue = findFreeTextGroundedValue(stageInput.evidence, attrId, targetSourceFields);
  if (!groundedValue) {
    return {
      proposals: [],
      message: `No ${targetConfig.label} evidence on ${catalogField ?? attrId} — abstaining rather than inventing a value.`,
    };
  }
  if (attribute.valueMode === 'freeText') {
    return proposeFreeTextValue({ context, stageInput, targetConfig, groundedValue, fieldPacket, selectionMode, snapshotHash });
  }
  return proposeMeasuredValue({ context, stageInput, targetConfig, groundedValue, fieldPacket, snapshotHash });
}

function isBrandFieldTarget(targetConfig: ResolvedTarget['config']): boolean {
  const label = targetConfig.label.toLowerCase();
  const id = (targetConfig.attributeId ?? targetConfig.id).toLowerCase();
  return label.includes('brand') || id.includes('brand');
}

function collectBrandEvidence(input: StageInput, brandAttributeId: string) {
  return input.evidence.filter(
    e =>
      e.sourceField === 'resolved_brand'
      || e.sourceField === 'brand'
      || e.attributeId === brandAttributeId
      || e.attributeId === 'brand',
  );
}

function parseBrandAssertions(
  brandEvidence: ReturnType<typeof collectBrandEvidence>,
  aliases: Array<{ alias: string; mapsTo: string }> | undefined,
): Array<{ id: string; brandName: string }> {
  const parsedBrands: Array<{ id: string; brandName: string }> = [];
  for (const record of brandEvidence) {
    const canonicalName = parseBrandRecordName(record.value, aliases);
    if (canonicalName !== null) {
      parsedBrands.push({ id: record.id, brandName: canonicalName });
    }
  }
  return parsedBrands;
}

// Brand shortcut: agreement → direct proposal; disagreement → conflict ids.
function tryBrandShortcut(input: {
  target: ResolvedTarget;
  input: StageInput;
  context: StageContext;
  options: ResolvedTarget['options'];
  snapshotHash: string | null;
}): { shortcut: TargetProcessResult | null; conflictIds: string[]; isBrandField: boolean } {
  const { target, input: stageInput, context, options: options2, snapshotHash } = input;
  const { config: targetConfig, attribute } = target;
  const isBrandField = isBrandFieldTarget(targetConfig);
  if (!isBrandField) return { shortcut: null, conflictIds: [], isBrandField: false };
  const brandAttributeId = targetConfig.attributeId ?? targetConfig.id;
  const brandEvidence = collectBrandEvidence(stageInput, brandAttributeId);
  if (brandEvidence.length === 0) return { shortcut: null, conflictIds: [], isBrandField: true };
  const parsedBrands = parseBrandAssertions(brandEvidence, attribute?.valueAliases ?? []);
  if (parsedBrands.length === 0) return { shortcut: null, conflictIds: [], isBrandField: true };
  const uniqueBrands = [...new Set(parsedBrands.map(p => p.brandName))];
  const allBrandIds = parsedBrands.map(p => p.id).filter(Boolean);
  if (uniqueBrands.length === 1) {
    const brandName = uniqueBrands[0];
    const matchedOption = options2.find(o =>
      resolveCanonicalAssertion(o.label, attribute?.valueAliases ?? []) === brandName,
    );
    const value = matchedOption?.label ?? brandName;
    const proposal = buildFieldAssignmentProposal({
      runId: context.runId,
      sku: stageInput.sku,
      attributeId: brandAttributeId,
      value,
      confidence: 0.9,
      evidenceIds: allBrandIds,
      supportingEvidenceIds: allBrandIds,
      isMultiple: false,
      isBulkAcceptable: false,
      snapshotHash,
    });
    return { shortcut: { proposals: [proposal], message: `Brand: "${brandName}" (resolved, 90%)` }, conflictIds: [], isBrandField: true };
  }
  return { shortcut: null, conflictIds: allBrandIds, isBrandField: true };
}

function buildControlledFieldPacket(input: {
  evidence: StageInput['evidence'];
  attrId: string;
  catalogField: string | null;
  packetSourceFields: string[] | null;
  selectionMode: 'single' | 'multiple';
  aliases: Array<{ alias: string; mapsTo: string }>;
  proposedValue?: unknown;
}) {
  return buildEvidenceTargetPacket(input.evidence, {
    attributeId: input.attrId,
    sourceField: input.catalogField,
    sourceFields: input.packetSourceFields,
    selectionMode: input.selectionMode,
    ...(input.proposedValue !== undefined ? { proposedValue: input.proposedValue } : {}),
    aliases: input.aliases,
    isGroundingSupport: tokenGroundingSupport,
  });
}

function resolvePacketSourceFields(catalogField: string | null, isBrandField: boolean): string[] | null {
  const brandSourceFields = isBrandField ? ['brand', 'resolved_brand'] : [];
  if (catalogField) return [...new Set([catalogField, ...brandSourceFields])];
  if (brandSourceFields.length) return brandSourceFields;
  return null;
}

// Deterministic alias + enrichment matching (keyword-first ordering preserved).
function resolveDeterministicFieldValues(input: {
  attribute: ResolvedTarget['attribute'];
  text: string;
  optionStrings: string[];
  selectionMode: 'single' | 'multiple';
  attrId: string;
}): { values: string[]; confidence: number } | null {
  const { attribute, text, optionStrings, selectionMode, attrId } = input;
  if (attribute) {
    const aliasMatches = matchAttributeOptions(attribute, text, optionStrings, selectionMode);
    if (aliasMatches.length > 0) {
      return {
        values: aliasMatches.map(m => m.value),
        confidence: Math.max(...aliasMatches.map(m => m.confidence)),
      };
    }
    const enriched = resolveEnrichmentFieldValues({
      text,
      optionStrings,
      aliases: attribute.valueAliases ?? [],
      attrId,
      selectionMode,
    });
    if (enriched) return enriched;
  }
  return null;
}

// SystemOne dispatch for one field (always returns when SystemOne handles).
async function trySystemOneFieldDecision(input: {
  target: ResolvedTarget;
  input: StageInput;
  context: StageContext;
  selectionMode: 'single' | 'multiple';
  modelPolicy: ReturnType<typeof modelPolicyViewFromSnapshot>;
  snapshotHash: string | null;
  targetLabel: string;
}): Promise<TargetProcessResult | null> {
  const { target, input: stageInput, context, selectionMode, modelPolicy, snapshotHash, targetLabel } = input;
  const isSystemOne = await isSystemOneAttributeRoute(modelPolicy);
  if (!isSystemOne) return null;
  const { resolveAttributeDecision, buildProposalFromAttributeDecision } = await import('./attribute-decision');
  const decision = await resolveAttributeDecision({
    target,
    cardinality: selectionMode,
    evidence: stageInput.evidence,
    sku: stageInput.sku,
    runId: context.runId,
    snapshot: context.snapshot,
    modelPolicy,
    assertHeld: context.assertHeld,
    productContext: { productType: context.cohortExecutionType?.id ?? null },
  });
  if (decision.status === 'abstained' || decision.status === 'failed' || !decision.value) {
    const abstentionProposal = buildProposalFromAttributeDecision(decision, stageInput.sku, context.runId, snapshotHash);
    return {
      proposals: [abstentionProposal],
      message: decision.abstentionReason ?? `Abstained from proposing attribute value (${decision.abstentionCode ?? 'unresolved'}).`,
    };
  }
  const proposal = buildProposalFromAttributeDecision(decision, stageInput.sku, context.runId, snapshotHash);
  return {
    proposals: [proposal],
    message: `"${targetLabel}": ${decision.value} (TypeSafe Jev, ${(decision.confidence * 100).toFixed(0)}%)`,
  };
}

async function rankFieldWithLlm(input: {
  targetLabel: string;
  options: ResolvedTarget['options'];
  selectionMode: 'single' | 'multiple';
  evidenceText: string;
  context: StageContext;
  modelPolicy: ReturnType<typeof modelPolicyViewFromSnapshot>;
}): Promise<{ values: string[]; confidence: number; modelCallIds?: string[] } | null> {
  const { targetLabel, options, selectionMode, evidenceText, context, modelPolicy } = input;
  const llmResult = await llmRankOptions({
    targetLabel,
    options,
    selectionMode,
    evidenceText,
    task: 'attribute_value_classification',
    modelPolicy,
    protectedOperation: 'attribute_ranking',
    ...(context.snapshot
      ? { modelCall: buildModelCallContext(context.snapshot, context.runId, 'attribute_ranking', 1), snapshot: context.snapshot }
      : {}),
  });
  if (llmResult && llmResult.values.length > 0) {
    return { values: llmResult.values, confidence: llmResult.confidence, modelCallIds: llmResult.modelCallIds };
  }
  return null;
}

function mergeBrandConflict(input: {
  rolePacket: EvidenceTargetPacket;
  brandConflictEvidenceIds: string[];
}): { supporting: string[]; contradicting: string[]; hasConflict: boolean } {
  const { rolePacket, brandConflictEvidenceIds } = input;
  let supporting = rolePacket.supportingEvidenceIds;
  let contradicting = rolePacket.contradictingEvidenceIds;
  let hasConflict = rolePacket.hasConflict;
  if (brandConflictEvidenceIds.length > 0) {
    const conflictSet = new Set(brandConflictEvidenceIds);
    supporting = supporting.filter(id => !conflictSet.has(id));
    contradicting = [...new Set([...contradicting, ...brandConflictEvidenceIds])];
    hasConflict = true;
  }
  return { supporting, contradicting, hasConflict };
}

// Fallback when deterministic matching yields nothing (SystemOne then LLM).
async function resolveFallbackFieldValues(input: {
  target: ResolvedTarget;
  input: StageInput;
  context: StageContext;
  selectionMode: 'single' | 'multiple';
  options: ResolvedTarget['options'];
  text: string;
  snapshotHash: string | null;
}): Promise<
  | { handled: true; result: TargetProcessResult }
  | { handled: false; values: string[]; confidence: number; llmModelCallIds?: string[] }
> {
  const { target, input: stageInput, context, selectionMode, options: options2, text, snapshotHash } = input;
  const { config: targetConfig } = target;
  const modelPolicy = modelPolicyViewFromSnapshot(context.snapshot);
  const systemOneResult = await trySystemOneFieldDecision({
    target,
    input: stageInput,
    context,
    selectionMode,
    modelPolicy,
    snapshotHash,
    targetLabel: targetConfig.label,
  });
  if (systemOneResult) return { handled: true, result: systemOneResult };
  const llmFallback = await rankFieldWithLlm({
    targetLabel: targetConfig.label,
    options: options2,
    selectionMode,
    evidenceText: text,
    context,
    modelPolicy,
  });
  if (llmFallback) {
    return { handled: false, values: llmFallback.values, confidence: llmFallback.confidence, llmModelCallIds: llmFallback.modelCallIds };
  }
  return { handled: false, values: [], confidence: 0 };
}

// Resolve controlled values (packet + deterministic + SystemOne/LLM fallback).
async function resolveControlledFieldValues(input: {
  target: ResolvedTarget;
  input: StageInput;
  context: StageContext;
  selectionMode: 'single' | 'multiple';
  options: ResolvedTarget['options'];
  attrId: string;
  catalogField: string | null;
  packetSourceFields: string[] | null;
  snapshotHash: string | null;
}): Promise<
  | { ok: true; values: string[]; confidence: number; llmModelCallIds?: string[]; text: string }
  | { ok: false; result: TargetProcessResult }
> {
  const { target, input: stageInput, context, selectionMode, options: options2, attrId, catalogField, packetSourceFields, snapshotHash } = input;
  const { config: targetConfig, attribute } = target;
  const fieldPacket = buildControlledFieldPacket({
    evidence: stageInput.evidence,
    attrId,
    catalogField,
    packetSourceFields,
    selectionMode,
    aliases: attribute?.valueAliases ?? [],
  });
  const text = fieldPacket.promptText;
  if (!text) {
    return { ok: false, result: { proposals: [], message: `No evidence text for "${targetConfig.label}".` } };
  }
  const optionStrings = options2.map(o => o.label);
  const deterministic = resolveDeterministicFieldValues({ attribute, text, optionStrings, selectionMode, attrId });
  let values: string[] = deterministic?.values ?? [];
  let confidence = deterministic?.confidence ?? 0;
  let llmModelCallIds: string[] | undefined;
  if (values.length === 0) {
    const fallback = await resolveFallbackFieldValues({
      target, input: stageInput, context, selectionMode, options: options2, text, snapshotHash,
    });
    if (fallback.handled) return { ok: false, result: fallback.result };
    values = fallback.values;
    confidence = fallback.confidence;
    llmModelCallIds = fallback.llmModelCallIds;
  }
  if (values.length === 0) {
    return { ok: false, result: { proposals: [], message: `No value match found for "${targetConfig.label}".` } };
  }
  return { ok: true, values, confidence, llmModelCallIds, text };
}

function finalizeControlledFieldProposal(input: {
  input: StageInput;
  context: StageContext;
  target: ResolvedTarget;
  selectionMode: 'single' | 'multiple';
  attrId: string;
  catalogField: string | null;
  packetSourceFields: string[] | null;
  values: string[];
  confidence: number;
  brandConflictEvidenceIds: string[];
  calibratedThresholds?: CalibratedThresholds | null;
  snapshotHash: string | null;
  llmModelCallIds?: string[];
}): TargetProcessResult {
  const { input: stageInput, context, target, selectionMode, attrId, catalogField, packetSourceFields } = input;
  const rolePacket = buildControlledFieldPacket({
    evidence: stageInput.evidence,
    attrId,
    catalogField,
    packetSourceFields,
    selectionMode,
    aliases: target.attribute?.valueAliases ?? [],
    proposedValue: selectionMode === 'multiple' ? input.values : input.values[0],
  });
  const merged = mergeBrandConflict({ rolePacket, brandConflictEvidenceIds: input.brandConflictEvidenceIds });
  return assembleFinalFieldProposal({
    context,
    inputEvidence: stageInput,
    target,
    selectionMode,
    values: input.values,
    confidence: input.confidence,
    supporting: merged.supporting,
    contradicting: merged.contradicting,
    contextIds: rolePacket.context.map(r => r.id).filter(Boolean),
    hasConflict: merged.hasConflict,
    calibratedThresholds: input.calibratedThresholds,
    snapshotHash: input.snapshotHash,
    llmModelCallIds: input.llmModelCallIds,
  });
}

function assembleFinalFieldProposal(input: {
  context: StageContext;
  inputEvidence: StageInput;
  target: ResolvedTarget;
  selectionMode: 'single' | 'multiple';
  values: string[];
  confidence: number;
  supporting: string[];
  contradicting: string[];
  contextIds: string[];
  hasConflict: boolean;
  calibratedThresholds?: CalibratedThresholds | null;
  snapshotHash: string | null;
  llmModelCallIds?: string[];
}): TargetProcessResult {
  const { context, inputEvidence, target, selectionMode, values, confidence } = input;
  const { supporting, contradicting, contextIds, hasConflict } = input as unknown as {
    supporting: string[]; contradicting: string[]; contextIds: string[]; hasConflict: boolean;
  };
  const proposal = buildFieldAssignmentProposal({
    runId: context.runId,
    sku: inputEvidence.sku,
    attributeId: target.config.attributeId ?? target.config.id,
    value: selectionMode === 'multiple' ? values : values[0],
    confidence,
    evidenceIds: [...new Set([...supporting, ...contradicting, ...contextIds])],
    supportingEvidenceIds: supporting,
    contradictingEvidenceIds: contradicting,
    isMultiple: selectionMode === 'multiple',
    isBulkAcceptable: hasConflict
      ? false
      : isCalibratedBulkAcceptable(
          { proposalType: 'field_assignment', confidence, contradictingEvidenceIds: contradicting },
          target.attribute ?? null,
          input.calibratedThresholds ?? null,
        ),
    snapshotHash: input.snapshotHash,
    ...(input.llmModelCallIds?.length ? { modelCallIds: input.llmModelCallIds } : {}),
  });
  return {
    proposals: [proposal],
    message: `"${target.config.label}": ${values.join(', ')} (${(confidence * 100).toFixed(0)}%)${hasConflict ? ' [conflicting evidence]' : ''}`,
  };
}

/**
 * Process a product field (attribute) curation target.
 *
 * Uses alias + exact matching first, then LLM fallback.
 *
 * @param options.cardinality - Per-Product-Type cardinality from the accepted
 *   type's profile; overrides the global target selectionMode when supplied.
 * @param options.calibratedThresholds - P3 (plan B.P3.4): CALIBRATED review
 *   thresholds from a fitted calibration model. Absent/null (the default —
 *   no production fitted thresholds exist today) keeps bulk acceptance
 *   byte-identical to legacy: nothing becomes bulk-acceptable from
 *   confidence alone.
 */
export async function processProductFieldTarget(
  target: ResolvedTarget,
  input: StageInput,
  context: StageContext,
  options: { cardinality?: 'single' | 'multiple'; calibratedThresholds?: CalibratedThresholds | null } = {},
): Promise<TargetProcessResult> {
  const { config: targetConfig, options: targetOptions } = target;
  const options2 = targetOptions;
  const selectionMode = options.cardinality ?? (targetConfig.selectionMode ?? 'single') as 'single' | 'multiple';
  const snapshotHash = context.snapshot?.snapshotHash ?? null;

  const freeTextResult = await processFreeTextMeasuredTarget({ target, input, context, selectionMode, snapshotHash });
  if (freeTextResult) return freeTextResult;
  if (!options2 || options2.length === 0) {
    return { proposals: [], message: `No options available for "${targetConfig.label}".` };
  }

  const brandShortcut = tryBrandShortcut({ target, input, context, options: options2, snapshotHash });
  if (brandShortcut.shortcut) return brandShortcut.shortcut;

  const attrId = targetConfig.attributeId ?? targetConfig.id;
  const catalogField = targetConfig.catalogField ?? null;
  const packetSourceFields = resolvePacketSourceFields(catalogField, brandShortcut.isBrandField);
  const resolved = await resolveControlledFieldValues({
    target, input, context, selectionMode, options: options2, attrId, catalogField, packetSourceFields, snapshotHash,
  });
  if (!resolved.ok) return resolved.result;

  return finalizeControlledFieldProposal({
    input, context, target, selectionMode, attrId, catalogField, packetSourceFields,
    values: resolved.values, confidence: resolved.confidence,
    brandConflictEvidenceIds: brandShortcut.conflictIds,
    calibratedThresholds: options.calibratedThresholds,
    snapshotHash, llmModelCallIds: resolved.llmModelCallIds,
  });
}

export interface ProcessProductFieldTargetsBatchResult {
  proposals: ClassificationProposal[];
  messages: string[];
}

// Collect one sequential result (dedupes the 8-line clone pair).
function collectBatchResult(
  allProposals: ClassificationProposal[],
  messages: string[],
  res: TargetProcessResult,
): void {
  allProposals.push(...res.proposals);
  if (res.message) messages.push(res.message);
}

async function processBatchSequentially(
  items: Array<{ target: ResolvedTarget; cardinality?: 'single' | 'multiple' }>,
  input: StageInput,
  context: StageContext,
  calibratedThresholds?: CalibratedThresholds | null,
): Promise<ProcessProductFieldTargetsBatchResult> {
  const allProposals: ClassificationProposal[] = [];
  const messages: string[] = [];
  for (const item of items) {
    const res = await processProductFieldTarget(item.target, input, context, {
      cardinality: item.cardinality,
      calibratedThresholds,
    });
    collectBatchResult(allProposals, messages, res);
  }
  return { proposals: allProposals, messages };
}

function splitBatchControlledItems(
  items: Array<{ target: ResolvedTarget; cardinality?: 'single' | 'multiple' }>,
): {
  freeTextItems: typeof items;
  controlledItems: Array<{ target: ResolvedTarget; cardinality: 'single' | 'multiple' }>;
} {
  const freeTextItems: typeof items = [];
  const controlledItems: Array<{ target: ResolvedTarget; cardinality: 'single' | 'multiple' }> = [];
  for (const item of items) {
    const valMode = item.target.attribute?.valueMode;
    if (valMode === 'freeText' || valMode === 'measured') {
      freeTextItems.push(item);
    } else {
      controlledItems.push({
        target: item.target,
        cardinality: item.cardinality ?? (item.target.config.selectionMode as 'single' | 'multiple') ?? 'single',
      });
    }
  }
  return { freeTextItems, controlledItems };
}

function renderBatchDecisionMessage(
  decision: { status: string; value: unknown; values?: unknown; source: string; confidence: number; abstentionReason?: string | null; targetId: string },
  targetLabel: string,
): string {
  if (decision.status === 'resolved' && (decision.value !== null || (Array.isArray(decision.values) && decision.values.length > 0))) {
    const sourceLabel =
      decision.source === 'jev' ? 'TypeSafe Jev' : decision.source === 'brand_resolved' ? 'resolved' : 'keyword';
    const displayVal = Array.isArray(decision.values) && decision.values.length > 0
      ? (decision.values as unknown[]).join(', ')
      : String(decision.value);
    return `"${targetLabel}": ${displayVal} (${sourceLabel}, ${(decision.confidence * 100).toFixed(0)}%)`;
  }
  return decision.abstentionReason ?? `Abstained from proposing "${targetLabel}".`;
}

/**
 * Process a batch of product field (attribute) curation targets.
 *
 * Dispatches via TypeSafe Jev System One Choice when System One is active,
 * batching independent questions whose permitted evidence state is identical (AC 7).
 * When System One is not active, processes each target sequentially through
 * processProductFieldTarget.
 */
export async function processProductFieldTargetsBatch(
  items: Array<{ target: ResolvedTarget; cardinality?: 'single' | 'multiple' }>,
  input: StageInput,
  context: StageContext,
  options: { calibratedThresholds?: CalibratedThresholds | null } = {},
): Promise<ProcessProductFieldTargetsBatchResult> {
  if (items.length === 0) {
    return { proposals: [], messages: [] };
  }

  const modelPolicy = modelPolicyViewFromSnapshot(context.snapshot);
  const isSystemOne = await isSystemOneAttributeRoute(modelPolicy);

  if (!isSystemOne) {
    return processBatchSequentially(items, input, context, options.calibratedThresholds);
  }

  // System One is active:
  const allProposals: ClassificationProposal[] = [];
  const messages: string[] = [];
  const { freeTextItems, controlledItems } = splitBatchControlledItems(items);

  for (const item of freeTextItems) {
    const res = await processProductFieldTarget(item.target, input, context, {
      cardinality: item.cardinality,
      calibratedThresholds: options.calibratedThresholds,
    });
    collectBatchResult(allProposals, messages, res);
  }

  if (controlledItems.length > 0) {
    const { batchResolveAttributeDecisions, buildProposalFromAttributeDecision } = await import('./attribute-decision');
    const decisions = await batchResolveAttributeDecisions({
      items: controlledItems,
      evidence: input.evidence,
      sku: input.sku,
      runId: context.runId,
      snapshot: context.snapshot,
      modelPolicy,
      assertHeld: context.assertHeld,
      productContext: {
        productType: context.cohortExecutionType?.id ?? null,
      },
    });

    const snapshotHash = context.snapshot?.snapshotHash ?? null;
    for (const decision of decisions) {
      const targetItem = controlledItems.find(
        (ci) => (ci.target.config.attributeId ?? ci.target.config.id) === decision.targetId,
      );
      const targetLabel = targetItem?.target.config.label ?? decision.targetId;

      const proposal = buildProposalFromAttributeDecision(
        decision,
        input.sku,
        context.runId,
        snapshotHash,
      );
      allProposals.push(proposal);
      messages.push(renderBatchDecisionMessage(decision as unknown as Parameters<typeof renderBatchDecisionMessage>[0], targetLabel));
    }
  }

  return { proposals: allProposals, messages };
}

// ─── Page Processing ──────────────────────────────────────────────────────────

/**
 * Process a category page curation target.
 *
 * Uses LLM-first page assignment with rich product context (VLM OCR data,
 * product type, web description, store page hierarchy). The LLM is given
 * structured product data and the full page tree so it can make informed
 * specificity- and species-aware decisions.
 *
 * Page options carry page ID as value and page name as label.
 * Both are passed to the proposal for identity-based promotion.
 */
export async function processPageTarget(
  target: ResolvedTarget,
  input: StageInput,
  context: StageContext,
): Promise<TargetProcessResult> {
  const { config: targetConfig, options } = target;
  const snapshotHash = context.snapshot?.snapshotHash ?? null;

  if (!options || options.length === 0) {
    return { proposals: [], message: `No options available for "${targetConfig.label}".` };
  }

  const selectionMode = (targetConfig.selectionMode ?? 'single') as 'single' | 'multiple';
  const maxPages = selectionMode === 'multiple' ? 5 : 1;

  // ── Build page hierarchy from FROZEN verified snapshot records ────────
  // Pure over the immutable Page snapshot; no DB reads during the stage.
  const pageHierarchy = buildPageHierarchy(
    options,
    context.snapshot?.pages.state === 'verified' ? context.snapshot.pages.records : [],
  );

  // ── Restricted page-evidence packet built ONCE before assignment: the full
  // run evidence never leaks into page context. Only identity/species/type/
  // category records (by source field OR explicit attribute id) enter; the
  // reviewed species value (never first evidence) drives cross-species
  // contradiction labeling.
  const speciesValue = reviewedSpeciesValue(context);
  const pagePacket = buildPageEvidencePacket(input.evidence, {
    pageContextSourceFields: PAGE_CONTEXT_SOURCE_FIELDS,
    pageContextAttributeIds: PAGE_CONTEXT_ATTRIBUTE_IDS,
    sourceField: null,
    speciesValue,
  });

  // ── Extract product context ONLY from the restricted packet records ────
  // The LLM prompt is built from the frozen packet (supporting/contradicting/
  // context), deterministically ordered by evidence id so reversing the input
  // evidence order cannot change the prompt content or species order, and a
  // row excluded from the page packet (e.g. healthConcern) can never reach
  // the prompt (issue #17 pass 5c).
  const pageContextEvidence = [
    ...pagePacket.supporting,
    ...pagePacket.contradicting,
    ...pagePacket.context,
  ].sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''));
  const productContext = extractProductContext(pageContextEvidence, input.allProposals);

  const groupedSkus = context.productLineContext?.siblingSkus ?? [];
  const isMultiItemGroup = groupedSkus.length >= 2;

  const modelPolicy = context.snapshot
    ? modelPolicyViewFromConfig(
        context.snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
        context.snapshot.snapshotHash,
      )
    : null;

  let isSystemOne = false;
  if (modelPolicy) {
    const stageOverride = modelPolicy.stageOverrides?.category_page_proposals ?? modelPolicy.stageOverrides?.page_assignment;
    const provider = stageOverride?.provider ?? modelPolicy.defaultProvider;
    if (provider === 'typesafe') {
      isSystemOne = true;
    } else {
      try {
        const { getFullAiRoutingConfig } = await import('../db/repositories/provider-connection-repo');
        const aiConfig = getFullAiRoutingConfig();
        const conn =
          aiConfig.connections[provider] ||
          Object.values(aiConfig.connections).find(
            (c) => c.id === provider || (c.transport === 'systemone'),
          );
        isSystemOne = conn?.transport === 'systemone';
      } catch {
        isSystemOne = false;
      }
    }
  }

  if (isSystemOne && !isMultiItemGroup) {
    const { resolvePageDecision, buildProposalsFromPageDecision } = await import('./page-decision');
    const decision = await resolvePageDecision({
      target,
      evidence: input.evidence,
      sku: input.sku,
      runId: context.runId,
      snapshot: context.snapshot,
      modelPolicy,
      assertHeld: context.assertHeld,
      selectionMode,
      maxPages,
      productContext: {
        productName: productContext.productName,
        productDescription: productContext.productDescription,
        productType: productContext.productType,
        ocrSummary: productContext.ocrSummary,
      },
      reviewedProductTypeId: productContext.productType,
    });

    if (decision.status === 'abstained' || decision.status === 'failed' || decision.pages.length === 0) {
      const abstentionProposals = buildProposalsFromPageDecision(
        decision,
        input.sku,
        context.runId,
        snapshotHash,
      );
      return {
        proposals: abstentionProposals,
        message: decision.abstentionReason ?? `Abstained from proposing category pages (${decision.abstentionCode ?? 'unresolved'}).`,
      };
    }

    const proposals = buildProposalsFromPageDecision(
      decision,
      input.sku,
      context.runId,
      snapshotHash,
    );
    const pageNames = decision.pages.map(p => p.pageName);
    return {
      proposals,
      message: `${pageNames.join(', ')} (TypeSafe Jev, ${((decision.selectedProbability ?? decision.pages[0].confidence) * 100).toFixed(0)}%)`,
    };
  }

  let llmResult: PageAssignmentResult | null;
  let assignmentSource = 'LLM';

  if (isMultiItemGroup) {
    const products = context.productLineItems ?? [];
    const productSkus = new Set(products.map(product => product.sku));
    if (products.length !== groupedSkus.length || groupedSkus.some(sku => !productSkus.has(sku))) {
      return {
        proposals: [],
        message: 'Cohort page coordination abstained: the frozen product-line snapshot is incomplete.',
      };
    }
    const coordinated = await coordinateCohortPagesOnce({
      groupId: context.productLineContext!.groupId,
      products,
      pages: pageHierarchy,
      selectionMode,
      maxPages,
      modelPolicy: context.snapshot
        ? modelPolicyViewFromConfig(
            context.snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
            context.snapshot.snapshotHash,
          )
        : null,
      ...(context.snapshot
        ? {
            modelCall: buildModelCallContext(context.snapshot, context.runId, 'cohort_page_assignment', 1),
            snapshot: context.snapshot,
          }
        : {}),
    });
    const member = coordinated.get(input.sku);
    if (!member || member.status === 'abstained') {
      return {
        proposals: [],
        message: `Cohort page coordination abstained: ${member?.reason ?? `missing result for SKU ${input.sku}`}`,
      };
    }
    llmResult = { pages: member.pages, modelCallIds: member.modelCallIds };
    assignmentSource = isSystemOne ? 'TypeSafe Jev' : 'cohort LLM';
  } else {
    llmResult = await llmAssignCategoryPages({
      productName: productContext.productName,
      productDescription: productContext.productDescription,
      ocrSummary: productContext.ocrSummary,
      productType: productContext.productType,
      pages: pageHierarchy,
      selectionMode,
      maxPages,
      modelPolicy: context.snapshot
        ? modelPolicyViewFromConfig(
            context.snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
            context.snapshot.snapshotHash,
          )
        : null,
      ...(context.snapshot
        ? {
            modelCall: buildModelCallContext(context.snapshot, context.runId, 'page_assignment', 1),
            snapshot: context.snapshot,
          }
        : {}),
    });
  }

  if (!llmResult || llmResult.pages.length === 0) {
    return {
      proposals: [],
      message: `No page assignment from ${assignmentSource}. Evidence length: ${input.evidence.length} records, ${pagePacket.evidenceIds.length} linked.`,
    };
  }

  // ── Build proposals from LLM results ───────────────────────────────────
  // Verified identity is stamped only for pageIds present in the frozen
  // verified snapshot (never inferred from a name or a mutable DB read).
  const verifiedPageIdSet = new Set(
    context.snapshot?.pages.state === 'verified'
      ? context.snapshot.pages.records.map(r => r.pageId)
      : [],
  );
  const proposals = llmResult.pages.map((p: any) =>
    buildCategoryPageProposal({
      runId: context.runId,
      sku: input.sku,
      pageId: p.pageId,
      pageName: p.pageName,
      confidence: p.confidence,
      evidenceIds: pagePacket.evidenceIds,
      ...(pagePacket.contradictingEvidenceIds.length
        ? { contradictingEvidenceIds: pagePacket.contradictingEvidenceIds }
        : {}),
      verifiedPageIdentity: verifiedPageIdSet.has(p.pageId),
      isBulkAcceptable: (p.isBrandShortcut || p.pageName.startsWith('Brand -') || isSystemOne) ? false : undefined,
      snapshotHash,
      ...(llmResult.modelCallIds?.length ? { modelCallIds: llmResult.modelCallIds } : {}),
    }),
  );

  const pageNames = llmResult.pages.map(p => p.pageName);
  return {
    proposals,
    message: `${pageNames.join(', ')} (${assignmentSource}, ${(llmResult.pages[0].confidence * 100).toFixed(0)}%)`,
  };
}

// ─── PR7 Materialized Page Processing (C5) ────────────────────────────────────

/**
 * PR7 C5 (issue #30): materialize the member's DURABLE parent page output
 * into the existing `category_page` proposal shape. Active cohort mode ONLY —
 * `context.coordinatedPages` (set by `ensureCohortPagesCoordinated` before the
 * member loop) carries every member's stored `coordinated_page` result; the
 * child stage NEVER calls the Page LLM and NEVER invents an assignment.
 *
 * - `assigned` → one `buildCategoryPageProposal` per STORED page
 *   (`pageId`/`pageName`/`confidence` FROM THE STORED ROW, verified identity
 *   only when the pageId is in the frozen verified snapshot records,
 *   `evidenceIds` from the SAME deterministic restricted page-evidence packet
 *   the legacy path builds — pure, no LLM — and `modelCallIds` = the stored
 *   audited parent `model_call_id`);
 * - `abstained` → `{proposals: [], message: <stored reason>}` (the stage
 *   abstains — no LLM, no fallback invention);
 * - a missing row for a member that should have one (no `pageCoordinationAbsent`
 *   expected-empty marker), or a corrupt stored payload → THROW (PR8
 *   DECISION-B: the member fails closed — pages NEVER invent an assignment;
 *   PR7's deterministic abstain for these two cases is replaced by the
 *   fail-closed member failure).
 */
export async function materializeCoordinatedPages(
  _target: ResolvedTarget,
  input: StageInput,
  context: StageContext,
): Promise<TargetProcessResult> {
  const snapshotHash = context.snapshot?.snapshotHash ?? null;

  // Look up the member's durable parent output. A missing row for a member
  // that should have one is a parent-op contract violation. PR8 DECISION-B:
  // unless the parent page op chose EXPECTED-EMPTY (pageCoordinationAbsent —
  // the stage-level guard in `categoryPageProposalsStage` handles that case
  // before delegating here), a missing row FAILS the member closed — PR7's
  // deterministic abstain + warning is replaced by the fail-closed throw.
  const stored = context.coordinatedPages?.get(input.sku) as
    | CoordinatedPageMemberValue
    | undefined;
  if (!stored) {
    if (context.pageCoordinationAbsent === true) {
      return { proposals: [], message: 'missing parent page output' };
    }
    throw new Error(
      `Member ${input.sku} (run ${context.runId}) has no parent page output row in active cohort mode (PR8 DECISION-B): ` +
        'a missing durable page output fails the member closed — pages never invent an assignment.',
    );
  }

  // PR8 DECISION-B: fail-closed parse — a corrupt stored payload never yields
  // proposals; the member FAILS (PR7's deterministic abstain is replaced by
  // the throw).
  const parsed = CohortPageOutputSchema.safeParse(stored.output);
  if (!parsed.success) {
    throw new Error(
      `Member ${input.sku} (run ${context.runId}) has a corrupt parent page output payload in active cohort mode (PR8 DECISION-B): ` +
        'failing closed — pages never invent an assignment.',
    );
  }
  const output = parsed.data;

  // Durable parent abstention (policy denied / model unavailable / unsafe or
  // invalid response): the stage abstains with the STORED reason. No LLM, no
  // fallback invention.
  if (output.status === 'abstained') {
    return { proposals: [], message: output.reason };
  }

  // PR8 review R1 (BLOCKER 2c): an `assigned` row with an EMPTY page list can
  // never be produced by any writer (the coordinator abstains instead of
  // emitting assigned-empty) — a row carrying one is corrupt. The schema also
  // rejects it, so this defensive throw is belt-and-suspenders: FAIL the
  // member closed, never emit a partial no-page draft. Abstained rows remain
  // complete results (handled above).
  if (output.pages.length === 0) {
    throw new Error(
      `Member ${input.sku} (run ${context.runId}) has an assigned parent page output with no pages in active cohort mode ` +
        '(PR8 review R1): failing closed — pages never invent an assignment.',
    );
  }

  // ── Restricted page-evidence packet (the SAME deterministic packet the
  // legacy path builds) — pure, no LLM. Only identity/species/type/category
  // records enter; the reviewed species value (never first evidence) drives
  // cross-species contradiction labeling.
  const speciesValue = reviewedSpeciesValue(context);
  const pagePacket = buildPageEvidencePacket(input.evidence, {
    pageContextSourceFields: PAGE_CONTEXT_SOURCE_FIELDS,
    pageContextAttributeIds: PAGE_CONTEXT_ATTRIBUTE_IDS,
    sourceField: null,
    speciesValue,
  });

  // Verified identity from the FROZEN verified snapshot records (never a
  // mutable DB read) — the parent only passed verified pages, so every stored
  // pageId is verified by construction.
  const verifiedPageIdSet = new Set(
    context.snapshot?.pages.state === 'verified'
      ? context.snapshot.pages.records.map(record => record.pageId)
      : [],
  );
  const modelCallIds = stored.modelCallId ? [stored.modelCallId] : undefined;
  const isJev = output.source === 'typesafe';
  const proposals = output.pages.map(page =>
    buildCategoryPageProposal({
      runId: context.runId,
      sku: input.sku,
      pageId: page.pageId,
      pageName: page.pageName,
      confidence: page.confidence,
      evidenceIds: pagePacket.evidenceIds,
      ...(pagePacket.contradictingEvidenceIds.length
        ? { contradictingEvidenceIds: pagePacket.contradictingEvidenceIds }
        : {}),
      verifiedPageIdentity: verifiedPageIdSet.has(page.pageId),
      snapshotHash,
      ...(modelCallIds?.length ? { modelCallIds } : {}),
      ...(isJev ? { isBulkAcceptable: false } : {}),
    }),
  );

  const pageNames = output.pages.map(page => page.pageName);
  const sourceLabel = isJev ? 'TypeSafe Jev' : 'cohort LLM';
  return {
    proposals,
    message: `${pageNames.join(', ')} (Cohort page assignment materialized from parent coordination (${sourceLabel}), ${(output.pages[0].confidence * 100).toFixed(0)}%)`,
  };
}

// ─── Internal Generic Processor ───────────────────────────────────────────────

interface TargetProposalBuilder {
  kind: string;
  buildProposal: (
    value: string,
    confidence: number,
    evidence: {
      evidenceIds: string[];
      supportingEvidenceIds?: string[];
      contradictingEvidenceIds?: string[];
    },
    modelCallIds?: string[],
  ) => ClassificationProposal;
  /** LLM task name for routing, or undefined to use 'category_classification' fallback */
  task?: string;
}

/**
 * Generic target processing pipeline shared by product type and page targets.
 * Product field targets use a separate path because they need alias matching.
 */
async function processTargetInternal(
  target: ResolvedTarget,
  input: StageInput,
  context: StageContext,
  builder: TargetProposalBuilder,
): Promise<TargetProcessResult> {
  const { config: targetConfig, options } = target;

  if (!options || options.length === 0) {
    return { proposals: [], message: `No options available for "${targetConfig.label}".` };
  }

  const selectionMode = (targetConfig.selectionMode ?? 'single') as 'single' | 'multiple';

  // Bounded target packet. General title/description evidence is context
  // unless the deterministic grounding rule links it to the selected value.
  const buildPacket = (proposedValue?: unknown): EvidenceTargetPacket =>
    buildEvidenceTargetPacket(input.evidence, {
      attributeId: targetConfig.attributeId ?? null,
      sourceField: targetConfig.catalogField ?? null,
      selectionMode,
      proposedValue,
      isGroundingSupport: tokenGroundingSupport,
      includeProductTypeContext: builder.kind === 'product_type',
    });
  const matchingPacket = buildPacket();
  const text = matchingPacket.promptText;
  if (!text || text.length < 3) {
    return { proposals: [], message: `Insufficient evidence text for "${targetConfig.label}".` };
  }

  // Try deterministic keyword/token matching first
  const keywordMatches = matchKeywordOptions({
    options,
    text,
    selectionMode,
  });

  if (keywordMatches.length > 0 && keywordMatches[0].confidence >= KEYWORD_MATCH_MIN_CONFIDENCE) {
    const proposals = keywordMatches.map(m => {
      const singlePacket = buildPacket(m.value);
      return builder.buildProposal(m.value, m.confidence, {
        evidenceIds: singlePacket.evidenceIds,
        supportingEvidenceIds: singlePacket.supportingEvidenceIds,
        contradictingEvidenceIds: singlePacket.contradictingEvidenceIds,
      });
    });
    const values = keywordMatches.map(m => m.label);
    return {
      proposals,
      message: `${values.join(', ')} (keyword, ${(keywordMatches[0].confidence * 100).toFixed(0)}%)`,
    };
  }

  // Fall back to LLM ranker
  const llmResult = await llmRankOptions({
    targetLabel: targetConfig.label,
    options,
    selectionMode,
    evidenceText: text,
    task: builder.task,
    modelPolicy: context.snapshot
      ? modelPolicyViewFromConfig(
          context.snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
          context.snapshot.snapshotHash,
        )
      : null,
    protectedOperation: builder.task === 'category_page_assignment' ? 'page_assignment' : 'product_type_ranking',
    ...(context.snapshot
      ? {
          modelCall: buildModelCallContext(
            context.snapshot,
            context.runId,
            builder.task === 'category_page_assignment' ? 'page_assignment' : 'product_type_ranking',
            1,
          ),
          snapshot: context.snapshot,
        }
      : {}),
  });

  if (!llmResult || llmResult.values.length === 0) {
    return { proposals: [], message: `No match found for "${targetConfig.label}".` };
  }

  const proposals = llmResult.values.map(v => {
    const opt = options.find(
      o => o.label.toLowerCase() === v.toLowerCase() || o.value.toLowerCase() === v.toLowerCase(),
    );
    const proposalValue = targetConfig.kind === 'product_type' ? (opt?.value ?? v) : v;
    const singlePacket = buildPacket(proposalValue);
    return builder.buildProposal(proposalValue, llmResult.confidence, {
      evidenceIds: singlePacket.evidenceIds,
      supportingEvidenceIds: singlePacket.supportingEvidenceIds,
      contradictingEvidenceIds: singlePacket.contradictingEvidenceIds,
    }, llmResult.modelCallIds);
  });

  return {
    proposals,
    message: `${llmResult.values.join(', ')} (LLM, ${(llmResult.confidence * 100).toFixed(0)}%)`,
  };
}

// ─── Convenience: Check if Product Type is an enabled target ──────────────────

/**
 * Check whether Product Type is an enabled curation target for the given workspace.
 * Returns false when no config exists or the target is disabled.
 */
// fallow-ignore-next-line unused-export
export function isProductTypeTargetEnabled(workspacePath: string): boolean {
  const config = loadClassificationConfig(workspacePath);
  const resolved = resolveEnabledTargets(config, '');
  return resolved.productTypes.length > 0;
}

/**
 * Check whether any curation targets are enabled.
 */
// fallow-ignore-next-line unused-export
export function hasAnyEnabledTarget(workspacePath: string): boolean {
  const config = loadClassificationConfig(workspacePath);
  const resolved = resolveEnabledTargets(config, '');
  return resolved.hasAny;
}
