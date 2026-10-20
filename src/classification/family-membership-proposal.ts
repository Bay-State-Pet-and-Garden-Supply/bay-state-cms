/**
 * TypeSafe family-membership proposal (issue #371).
 *
 * Bounded, evidence-backed closed-set relationship judgment over ≤16
 * eligible family anchors for ONE incoming SKU. The model proposes;
 * existing #370 deterministic gates dispose:
 *
 * - One independent closed-set Choice per anchor: `same_sellable_sku` /
 *   `same_permitted_family` / `different_product` / `insufficient_evidence`.
 * - No transitive union: A~B + B~C never merges incompatible A/C endpoints
 *   (code verifies every member's hard invariants + tuple uniqueness before
 *   acceptance; multiple matches → explicit conflict resolution; same-SKU
 *   answers route to identity/duplicate handling, never family creation).
 * - The model never writes membership, generates products, or merges
 *   identities. Every positive remains a proposal gated by the complete
 *   plan validation path (#370) before staging/apply.
 *
 * One logical request covers the bounded anchor set (≤16 questions per the
 * 32-question SystemOne cap). Required overflow or insufficient state is
 * explicit, never silent prefix adjudication or extra unbounded calls. No
 * chat fallback: without a TypeSafe route the outcome is service/disabled
 * (operator-recoverable), never generated text.
 */
import { TYPESAFE_EVALUATED_MODEL, assertSystemOneModelMatch } from '../ai/systemone-transport';
import { assertConnectionEnabledForDispatch } from '../ai/provider-connections';
import {
  completeModelCall,
  insertModelCallStart,
  insertTerminalModelCall,
} from '../db/repositories/classification-model-call-repo';
import { hashCanonicalJson } from '../shared/stable-id';
import {
  MODEL_CALL_STATUS,
  PROMPT_TEMPLATE_VERSIONS,
  RULE_VERSIONS,
  type ModelCallContext,
} from './model-operation-registry';
import {
  ModelPolicyDeniedError,
  assertModelPolicyIntact,
  resolveModelRoute,
  type ModelPolicyView,
  type ModelRoute,
} from './model-policy-gateway';
import { HeartbeatLostError } from './heartbeat-errors';
import type { ProviderConnection } from '../ai/provider-connections';
import {
  MAX_ORDINARY_CHOICE_CANDIDATES,
  SYSTEMONE_SINGLE_CHOICE_MIN_PROBABILITY,
  asEffectivePolicyView,
  buildChoiceKeyMaps,
  choiceKeyToCanonicalId,
  findSystemOneConnection,
  fitStateToBudget,
  protectedSystemOneDispatchOptions,
  resolveSystemOneCredential,
  truncateSnippets,
} from './systemone-decision-core';
import { dispatchSystemOne } from '../ai/systemone-transport';
import { getFullAiRoutingConfig } from '../db/repositories/provider-connection-repo';
import type { FamilyVariantRuleVersion } from './family-variant-rule';
import type { ImportedJoinQuery, JoinCandidate, CatalogJoinAnchor } from './storefront-family-join';

/** The protected operation backing this boundary. */
export const FAMILY_MEMBERSHIP_OPERATION = 'family_membership_proposal' as const;

/** Anchor bound: every proposal freezes ≤16 eligible anchors (one Choice each). */
export const FAMILY_MEMBERSHIP_ANCHOR_LIMIT = 16;

/** Minimum probability for a `same_permitted_family` verdict to stand. */
export const FAMILY_MEMBERSHIP_MIN_PROBABILITY = SYSTEMONE_SINGLE_CHOICE_MIN_PROBABILITY;

export type FamilyMembershipVerdict =
  | 'same_sellable_sku'
  | 'same_permitted_family'
  | 'different_product'
  | 'insufficient_evidence';

export type FamilyMembershipOutcome =
  | 'selected'
  | 'negative'
  | 'same_sku'
  | 'no_fit'
  | 'insufficient'
  | 'overflow'
  | 'service'
  | 'disabled'
  | 'stale';

export interface FamilyMembershipAnchorInput {
  /** Family anchor reached through #370 equality-key discovery (never sole authority). */
  anchor: CatalogJoinAnchor;
  /** Join discovery candidate record (signals + matched keys; stem-only never qualifies upstream). */
  candidate: JoinCandidate;
  /** Family's reviewed common product identity (brand/recipe/flavor/species/lifeStage/form or non-food identity). */
  reviewedIdentity: string;
  /** Approved rule identity + version governing this anchor. */
  ruleVersion: FamilyVariantRuleVersion;
  ruleIdentity: string;
  /** Relevant evidence snippets for THIS anchor relationship (SKU-local). */
  evidence: string[];
  /** Complete hard invariants + member variant tuples for code-side rechecks. */
  hardInvariants: string;
  memberTuples: string;
  /** Anchor family's live member evidence bound into hashes: per-member hashes, invariant values, tuples, bases. */
  stateBinding?: unknown;
}

export interface IncomingMembershipEvidence {
  /** The incoming SKU's reviewed identity, live evidence, invariant values, and canonical variant tuple. */
  sku: string;
  evidenceHash: string;
  typeHash: string;
  ruleVersion: FamilyVariantRuleVersion | null;
  brand: string | null;
  recipe: string | null;
  flavor: string | null;
  species: string | null;
  lifeStage: string | null;
  form: string | null;
  model: string | null;
  material: string | null;
  function: string | null;
  safetyDose: string | null;
  strength: string | null;
  fit: string | null;
  sizeRaw: string | null;
  ounces: number | null;
  retailUnit: string | null;
  colorRaw: string | null;
  countRaw: string | null;
  countQuantity: number | null;
  invariants: Record<string, string | null>;
  tuple: string;
}

/**
 * One canonical live-state binding for a proposal: the incoming SKU's live
 * evidence plus every touched family's live revision and the full anchor
 * member evidence. Built once per live state and reused UNCHANGED for
 * creation hashing, dispatch hashing, reuse checks, and freshness
 * revalidation — identical live state always yields identical hashes.
 */
export interface ProposalLiveBinding {
  sku: string;
  evidenceHash: string;
  typeHash: string;
  ruleVersion: FamilyVariantRuleVersion | null;
  memberEvidence: unknown;
  revisions: Array<number | null>;
  primaryRevision: number | null;
}

export interface FamilyMembershipProposalParams {
  sku: string;
  query: ImportedJoinQuery;
  anchors: FamilyMembershipAnchorInput[];
  runId: string;
  modelPolicy: ModelPolicyView | null;
  assertHeld?: () => void;
  /**
   * Canonical live-state binding (route-built from current evidence + every
   * touched family revision). Required: dispatch refuses without it, so
   * hashes always bind the same construction the route reuses for
   * creation/reuse/freshness.
   */
  liveBinding: ProposalLiveBinding | null;
  /**
   * Incoming SKU's reviewed identity/evidence/invariants/tuple, embedded in
   * every anchor state of the model request. Required: dispatch refuses
   * without it, so the model always sees the incoming relationship evidence.
   */
  incomingState: IncomingMembershipEvidence | null;
}

export interface FamilyMembershipAnchorJudgment {
  anchorSku: string;
  familyPlanId: string | null;
  verdict: FamilyMembershipVerdict | null;
  outcome: FamilyMembershipOutcome;
  rawChoice: string | null;
  selectedProbability: number | null;
  vendorConfidence: number | null;
  distribution: Record<string, number>;
  reason: string;
}

export interface FamilyMembershipProposalResult {
  status: 'proposed' | 'unresolved' | 'failed';
  outcome: FamilyMembershipOutcome;
  sku: string;
  questionCount: number;
  judgments: FamilyMembershipAnchorJudgment[];
  /** True typed producing call IDs (empty when no dispatch occurred). */
  modelCallIds: string[];
  rawJudgments: Array<{ anchorSku: string; choice: string; probabilities: Record<string, number>; confidence: number }>;
  /** Same logical request coverage: ≤16 anchors per call batch. */
  overflow: boolean;
  evidenceHash: string;
  ruleHash: string;
  anchorHash: string;
  modelPolicyDigest: string;
  ruleVersion: string;
  promptTemplateVersion: string;
  error?: unknown;
}

const SAME_SKU_CHOICE = 'same_sellable_sku';
const SAME_FAMILY_CHOICE = 'same_permitted_family';
const DIFFERENT_CHOICE = 'different_product';
const INSUFFICIENT_CHOICE = 'insufficient_evidence';

function evidenceHashFor(anchors: FamilyMembershipAnchorInput[], incoming?: { evidenceHash: string; typeHash: string; ruleVersion: string | null; revision: number | null; revisions?: Array<number | null>; memberEvidence?: unknown }): string {
  return hashCanonicalJson({
    incoming: incoming ?? null,
    anchors: anchors.map((a) => ({
      anchorSku: a.anchor.sku,
      familyPlanId: a.anchor.familyPlanId,
      identity: a.reviewedIdentity,
      rule: a.ruleVersion,
      evidence: [...a.evidence].sort(),
      invariants: a.hardInvariants,
      tuples: a.memberTuples,
      state: a.stateBinding ?? null,
    })),
  });
}

function anchorHashFor(anchors: FamilyMembershipAnchorInput[], incoming?: { sku: string; typeHash: string; ruleVersion: string | null; revision: number | null; revisions?: Array<number | null> }): string {
  return hashCanonicalJson({
    incoming: incoming ?? null,
    anchors: anchors.map((a) => `${a.anchor.sku}:${a.anchor.familyPlanId ?? 'none'}:${a.ruleVersion}`).sort(),
    states: anchors.map((a) => a.stateBinding ?? null),
  });
}

function ruleHashFor(anchors: FamilyMembershipAnchorInput[], policyDigest: string, incoming?: { ruleVersion: string | null; revision: number | null; revisions?: Array<number | null> }): string {
  return hashCanonicalJson({
    incoming: incoming ?? null,
    rules: anchors.map((a) => a.ruleVersion).sort(),
    prompt: PROMPT_TEMPLATE_VERSIONS[FAMILY_MEMBERSHIP_OPERATION],
    rulesVersion: RULE_VERSIONS[FAMILY_MEMBERSHIP_OPERATION],
    policy: policyDigest,
  });
}

export function familyMembershipQuestionId(anchorSku: string): string {
  const sanitized = anchorSku.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 48);
  return `fam_${sanitized || 'anchor'}`;
}

function buildAnchorState(
  sku: string,
  query: ImportedJoinQuery,
  anchor: FamilyMembershipAnchorInput,
  incoming?: IncomingMembershipEvidence | null,
): Record<string, unknown> {
  const incomingState = (anchor.stateBinding ?? null) as Record<string, unknown> | null;
  const state: Record<string, unknown> = {
    incomingSku: sku,
    query: {
      normalizedSku: query.normalizedSku,
      identifiers: query.sourceIdentifiers.slice(0, 8),
      brand: query.brand,
      type: query.reviewedProductTypeId,
      rule: query.ruleVersion,
    },
    ...(incoming
      ? {
        incoming: {
          sku: incoming.sku,
          evidenceHash: incoming.evidenceHash,
          typeHash: incoming.typeHash,
          ruleVersion: incoming.ruleVersion,
          brand: incoming.brand,
          recipe: incoming.recipe,
          flavor: incoming.flavor,
          species: incoming.species,
          lifeStage: incoming.lifeStage,
          form: incoming.form,
          model: incoming.model,
          material: incoming.material,
          function: incoming.function,
          safetyDose: incoming.safetyDose,
          strength: incoming.strength,
          fit: incoming.fit,
          sizeRaw: incoming.sizeRaw,
          ounces: incoming.ounces,
          retailUnit: incoming.retailUnit,
          colorRaw: incoming.colorRaw,
          countRaw: incoming.countRaw,
          countQuantity: incoming.countQuantity,
          invariants: incoming.invariants,
          tuple: incoming.tuple,
        },
      }
      : {}),
    anchorSku: anchor.anchor.sku,
    familyPlanId: anchor.anchor.familyPlanId,
    familyMain: anchor.anchor.familyMain,
    familyOrder: anchor.anchor.familyOrder.slice(0, 16),
    reviewedIdentity: anchor.reviewedIdentity.slice(0, 800),
    rule: `${anchor.ruleIdentity} (${anchor.ruleVersion})`,
    hardInvariants: anchor.hardInvariants.slice(0, 1200),
    memberTuples: anchor.memberTuples.slice(0, 1200),
    evidence: truncateSnippets(anchor.evidence, 15, 500),
    ...(incomingState ? { liveMemberEvidence: incomingState } : {}),
  };
  fitStateToBudget(state, (s) => {
    const rec = s as Record<string, unknown>;
    rec['evidence'] = [];
  });
  return state;
}

function buildProposalCallContext(runId: string, snapshotHash: string): ModelCallContext {
  return {
    runId,
    snapshotHash,
    stage: null,
    operation: FAMILY_MEMBERSHIP_OPERATION,
    attempt: 1,
    promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS[FAMILY_MEMBERSHIP_OPERATION],
    ruleVersion: RULE_VERSIONS[FAMILY_MEMBERSHIP_OPERATION],
  };
}

function resolveRoute(policy: ModelPolicyView | null): {
  route: ModelRoute;
  conn: ProviderConnection;
} | null {
  if (!policy) return null;
  try {
    assertModelPolicyIntact(policy);
    const route = resolveModelRoute(policy, FAMILY_MEMBERSHIP_OPERATION, {
      getCredential: (p: string) => resolveSystemOneCredential(p),
      defaultBaseUrls: { typesafe: 'https://api.typesafe.ai/v1' },
    });
    const aiConfig = getFullAiRoutingConfig();
    const conn = findSystemOneConnection(aiConfig.connections, route.provider);
    const jevConn: ProviderConnection = conn ?? {
      id: route.provider,
      label: 'TypeSafe Jev',
      transport: 'systemone' as const,
      baseUrl: route.baseUrl,
      trustZone: 'cloud' as const,
      credential: route.apiKey,
      enabled: true,
    };
    assertConnectionEnabledForDispatch(jevConn, route.model || TYPESAFE_EVALUATED_MODEL);
    return { route, conn: jevConn };
  } catch {
    return null;
  }
}

/**
 * Freeze ≤16 eligible family anchors for the incoming SKU from #370
 * equality-key discovery. Pure precondition (throws on violations):
 * - anchors come pre-filtered by discoverJoinCandidates (stem-only never
 *   qualifies upstream); this asserts the freeze, not re-searches.
 * - same-SKU anchors are legal inputs (they resolve to identity/duplicate
 *   handling, never a merge) but count toward the bound.
 */
export function freezeProposalAnchors(
  querySku: string,
  anchors: FamilyMembershipAnchorInput[],
): { frozen: FamilyMembershipAnchorInput[]; overflow: boolean } {
  if (anchors.length === 0) {
    return { frozen: [], overflow: false };
  }
  if (anchors.length > FAMILY_MEMBERSHIP_ANCHOR_LIMIT) {
    throw new Error(
      `family_membership_overflow: ${anchors.length} eligible anchors exceed the ${FAMILY_MEMBERSHIP_ANCHOR_LIMIT}-anchor bound; narrow discovery or reject explicitly — first-N clipping is forbidden.`,
    );
  }
  if (anchors.length > MAX_ORDINARY_CHOICE_CANDIDATES) {
    throw new Error(
      `family_membership_overflow: ${anchors.length} anchors exceed the Choice candidate capacity; explicit overflow, never silent prefix adjudication.`,
    );
  }
  const seen: Record<string, true> = {};
  for (const anchor of anchors) {
    const key = `${anchor.anchor.sku}:${anchor.anchor.familyPlanId ?? 'none'}`;
    if (seen[key]) {
      throw new Error(`family_membership_duplicate_anchor: anchor "${key}" appears twice for SKU "${querySku}".`);
    }
    seen[key] = true;
    if (!anchor.reviewedIdentity.trim()) {
      throw new Error(`family_membership_missing_identity: anchor "${anchor.anchor.sku}" has no reviewed common product identity.`);
    }
    if (!anchor.hardInvariants.trim() || !anchor.memberTuples.trim()) {
      throw new Error(
        `family_membership_missing_invariants: anchor "${anchor.anchor.sku}" lacks complete hard invariants/member tuples; missing invariant evidence never means equality.`,
      );
    }
  }
  return { frozen: [...anchors], overflow: false };
}

/**
 * Interpret one anchor Choice answer. Closed-set: out-of-set keys fail
 * closed (service), never coerce to membership.
 */
export function interpretAnchorChoice(input: {
  anchor: FamilyMembershipAnchorInput;
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}): FamilyMembershipAnchorJudgment {
  const { anchor, choice, probabilities, confidence } = input;
  const distribution: Record<string, number> = {};
  for (const key of [SAME_SKU_CHOICE, SAME_FAMILY_CHOICE, DIFFERENT_CHOICE, INSUFFICIENT_CHOICE]) {
    distribution[key] = typeof probabilities[key] === 'number' ? probabilities[key] : 0;
  }
  const base = {
    anchorSku: anchor.anchor.sku,
    familyPlanId: anchor.anchor.familyPlanId,
    rawChoice: choice,
    vendorConfidence: Number.isFinite(confidence) ? confidence : null,
    distribution,
  };
  if (choice === SAME_SKU_CHOICE) {
    return {
      ...base,
      verdict: 'same_sellable_sku',
      outcome: 'same_sku',
      selectedProbability: distribution[SAME_SKU_CHOICE],
      reason: `Anchor "${anchor.anchor.sku}" judged the same sellable SKU as the incoming product; routes to identity/duplicate resolution, never a family merge.`,
    };
  }
  if (choice === SAME_FAMILY_CHOICE) {
    const prob = distribution[SAME_FAMILY_CHOICE] ?? 0;
    if (prob < FAMILY_MEMBERSHIP_MIN_PROBABILITY) {
      return {
        ...base,
        verdict: null,
        outcome: 'insufficient',
        selectedProbability: prob,
        reason: `Permitted-family probability (${prob.toFixed(3)}) is below the required floor (${FAMILY_MEMBERSHIP_MIN_PROBABILITY}); treated as insufficient, never a merge.`,
      };
    }
    return {
      ...base,
      verdict: 'same_permitted_family',
      outcome: 'selected',
      selectedProbability: prob,
      reason: `Anchor "${anchor.anchor.sku}" judged a permitted member of the same family under the anchor's approved rule; code rechecks every member's hard invariants/tuple uniqueness before acceptance.`,
    };
  }
  if (choice === DIFFERENT_CHOICE) {
    return {
      ...base,
      verdict: 'different_product',
      outcome: 'negative',
      selectedProbability: distribution[DIFFERENT_CHOICE],
      reason: `Anchor "${anchor.anchor.sku}" judged a different product; explicit reviewed negative.`,
    };
  }
  if (choice === INSUFFICIENT_CHOICE) {
    return {
      ...base,
      verdict: 'insufficient_evidence',
      outcome: 'insufficient',
      selectedProbability: distribution[INSUFFICIENT_CHOICE],
      reason: `Eligible evidence is insufficient or ambiguous for anchor "${anchor.anchor.sku}"; unresolved, never equality.`,
    };
  }
  return {
    ...base,
    verdict: null,
    outcome: 'service',
    selectedProbability: null,
    reason: `service_failure: model returned an out-of-set choice ("${choice}") for anchor "${anchor.anchor.sku}".`,
  };
}

/**
 * One logical request over the bounded anchor set: independent closed-set
 * Relationship Choice per anchor. Raw judgments + actual call IDs persist;
 * reuse is only of identical relevant state, never carried human approval.
 */
export async function proposeFamilyMembership(
  params: FamilyMembershipProposalParams,
): Promise<FamilyMembershipProposalResult> {
  const { sku, query, anchors, runId, assertHeld } = params;
  const policyDigest = params.modelPolicy?.policyDigest ?? 'policy_unavailable';
  const promptTemplateVersion = PROMPT_TEMPLATE_VERSIONS[FAMILY_MEMBERSHIP_OPERATION];
  const rulesVersion = RULE_VERSIONS[FAMILY_MEMBERSHIP_OPERATION];
  // Canonical live-state binding: the route builds one live binding per
  // current state (incoming evidence + all touched family revisions) and it
  // is reused UNCHANGED here — the same construction the route reuses for
  // creation/reuse/freshness, so identical live state hashes identically.
  // Missing live binding or incoming state refuses closed: dispatch never
  // hashes or requests on unknown evidence.
  const liveBinding: ProposalLiveBinding | null = params.liveBinding ?? null;
  const incomingState: IncomingMembershipEvidence | null = params.incomingState ?? null;
  if (!liveBinding) {
    throw new Error('family_membership_missing_binding: no canonical live-state binding for the proposal; re-propose with current evidence.');
  }
  if (!incomingState) {
    throw new Error('family_membership_missing_incoming: no incoming reviewed identity/evidence/invariants/tuple for the proposal; re-propose with current evidence.');
  }
  const incomingBinding = {
    evidenceHash: liveBinding.evidenceHash,
    typeHash: liveBinding.typeHash,
    ruleVersion: liveBinding.ruleVersion ?? query.ruleVersion ?? null,
    revisions: liveBinding.revisions,
    revision: liveBinding.primaryRevision,
    memberEvidence: liveBinding.memberEvidence,
  };
  const evidenceHash = evidenceHashFor(anchors, incomingBinding);
  const anchorHash = anchorHashFor(anchors, { sku, typeHash: incomingBinding.typeHash, ruleVersion: incomingBinding.ruleVersion, revision: incomingBinding.revision, revisions: incomingBinding.revisions });
  const ruleHash = ruleHashFor(anchors, policyDigest, { ruleVersion: incomingBinding.ruleVersion, revision: incomingBinding.revision, revisions: incomingBinding.revisions });

  const finishUnresolved = (
    outcome: FamilyMembershipOutcome,
    reason: string,
    extra?: Partial<FamilyMembershipProposalResult>,
  ): FamilyMembershipProposalResult => ({
    status: outcome === 'selected' || outcome === 'same_sku' ? 'proposed' : 'unresolved',
    outcome,
    sku,
    questionCount: anchors.length,
    judgments: anchors.map((a) => ({
      anchorSku: a.anchor.sku,
      familyPlanId: a.anchor.familyPlanId,
      verdict: null,
      outcome,
      rawChoice: null,
      selectedProbability: null,
      vendorConfidence: null,
      distribution: {},
      reason,
    })),
    modelCallIds: [],
    rawJudgments: [],
    overflow: false,
    evidenceHash,
    ruleHash,
    anchorHash,
    modelPolicyDigest: policyDigest,
    ruleVersion: rulesVersion,
    promptTemplateVersion,
    ...extra,
  });

  // 0. Empty anchor set: no fit, no call.
  if (anchors.length === 0) {
    return finishUnresolved('no_fit', 'no_fit: eligible family-anchor discovery returned no candidates; unresolved, never a guess.');
  }

  // 1. Freeze ≤16 eligible anchors (throws on overflow → explicit, never silent clip).
  let frozen: FamilyMembershipAnchorInput[];
  try {
    frozen = freezeProposalAnchors(sku, anchors).frozen;
  } catch (err) {
    return finishUnresolved('overflow', err instanceof Error ? err.message : String(err), { overflow: true });
  }

  // 2. Frozen policy route (null/disabled ⇒ disabled outcome, never chat fallback).
  const effectivePolicy = asEffectivePolicyView(params.modelPolicy);
  if (!effectivePolicy) {
    return finishUnresolved('disabled', 'disabled: no frozen model policy for family-membership proposal — enable the evaluated TypeSafe model or resolve manually.');
  }
  let route: ModelRoute | null = null;
  let conn: ProviderConnection | null = null;
  let policyDenied: Error | null = null;
  try {
    const resolved = resolveRoute(effectivePolicy);
    if (resolved) {
      route = resolved.route;
      conn = resolved.conn;
    }
  } catch (err) {
    if (err instanceof HeartbeatLostError) throw err;
    if (err instanceof ModelPolicyDeniedError) policyDenied = err;
    else policyDenied = err instanceof Error ? err : new Error(String(err));
  }
  if (policyDenied || !route || !conn) {
    assertHeld?.();
    let deniedProvider: string | null = null;
    if (policyDenied instanceof ModelPolicyDeniedError && typeof policyDenied.provider === 'string') {
      deniedProvider = policyDenied.provider;
    }
    try {
      insertTerminalModelCall({
        runId,
        stageName: null,
        operation: FAMILY_MEMBERSHIP_OPERATION,
        attempt: 1,
        provider: deniedProvider,
        model: null,
        locality: null,
        snapshotHash: effectivePolicy.snapshotHash ?? '',
        modelPolicyDigest: effectivePolicy.policyDigest,
        promptTemplateVersion,
        ruleVersion: rulesVersion,
        systemPromptHash: hashCanonicalJson({ denied: FAMILY_MEMBERSHIP_OPERATION }),
        userPromptHash: hashCanonicalJson({ denied: FAMILY_MEMBERSHIP_OPERATION }),
        status: policyDenied ? 'policy_denied' : 'unavailable',
        errorMessage: policyDenied ? policyDenied.message : 'family-membership route unavailable (connection disabled or unconfigured)',
      });
    } catch { /* audit best-effort */ }
    return finishUnresolved(
      'disabled',
      policyDenied ? `Model policy denied: ${policyDenied.message}` : 'disabled: no usable TypeSafe route for family-membership proposal.',
    );
  }

  // 3. One logical request: independent Choice per anchor with full
  // relationship instructions (question IDs alone are never the instruction).
  const criteriaPerAnchor: Record<string, string> = {
    [SAME_SKU_CHOICE]: 'The incoming SKU and this anchor are the SAME sellable SKU (same product, same variant — identity/duplicate handling, never a family merge).',
    [SAME_FAMILY_CHOICE]: 'The incoming SKU is a permitted member of THIS anchor family: same common product identity, all hard invariants agree (missing never equals), and the package difference is allowed by the approved Family Variant Rule.',
    [DIFFERENT_CHOICE]: 'The incoming SKU is a DIFFERENT product from this anchor family (invariant conflict, different recipe/flavor/form/life-stage, or unpermitted axis).',
    [INSUFFICIENT_CHOICE]: 'The eligible evidence is insufficient or ambiguous to decide this relationship — missing invariant evidence never means equality.',
  };
  const questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }> = {};
  const keyMapsByQuestion = new Map<string, { keyToIdMap: Map<string, string> }>();
  const idByQuestion = new Map<string, string>();
  for (const anchor of frozen) {
    const questionId = familyMembershipQuestionId(anchor.anchor.sku);
    if (questions[questionId]) {
      return finishUnresolved('service', `service_failure: duplicate anchor question "${questionId}" — anchors must be distinct.`);
    }
    const keyMaps = buildChoiceKeyMaps(criteriaPerAnchor, [
      { value: SAME_SKU_CHOICE, label: SAME_SKU_CHOICE },
      { value: SAME_FAMILY_CHOICE, label: SAME_FAMILY_CHOICE },
      { value: DIFFERENT_CHOICE, label: DIFFERENT_CHOICE },
      { value: INSUFFICIENT_CHOICE, label: INSUFFICIENT_CHOICE },
    ], `fam_${anchor.anchor.sku.replace(/[^A-Za-z0-9]/g, '') || 'anchor'}`);
    const criteria: Record<string, string> = {};
    for (const [key, id] of keyMaps.keyToIdMap) {
      criteria[key] = criteriaPerAnchor[id] ?? id;
    }
    questions[questionId] = {
      type: 'choice',
      instructions:
        `Decide the EXACT relationship between incoming SKU "${sku}" and the family anchored at "${anchor.anchor.sku}" ` +
        `(family ${anchor.anchor.familyPlanId ? anchor.anchor.familyPlanId.slice(0, 8) : '(unlisted)'}; main ${anchor.anchor.familyMain ?? '(none)'}). ` +
        `Reviewed family identity: ${anchor.reviewedIdentity.slice(0, 400)}. Approved rule: ${anchor.ruleIdentity} (${anchor.ruleVersion}). ` +
        `Hard invariants every member must share: ${anchor.hardInvariants.slice(0, 400)}. ` +
        `Existing member variant tuples: ${anchor.memberTuples.slice(0, 400)}. ` +
        `Judge ONLY this relationship from the supplied anchor evidence; sibling anchors, unlisted families, and missing evidence never authorize membership. ` +
        `Same-SKU means identity/duplicate handling — never create or merge a family record. Multiple positive families require explicit conflict resolution.`,
      criteria,
    };
    keyMapsByQuestion.set(questionId, keyMaps);
    idByQuestion.set(questionId, anchor.anchor.sku);
  }

  const states = frozen.map((anchor) => buildAnchorState(sku, query, anchor, params.incomingState ?? null));
  const requestState = {
    sku,
    anchorCount: frozen.length,
    anchors: states,
    operation: FAMILY_MEMBERSHIP_OPERATION,
  };
  const model = route.model || TYPESAFE_EVALUATED_MODEL;
  const request = { model, state: requestState, questions };
  const promptHash = hashCanonicalJson(request);

  let callId: string;
  try {
    assertHeld?.();
    const ctx = buildProposalCallContext(runId, effectivePolicy.snapshotHash ?? '');
    callId = insertModelCallStart({
      runId,
      stageName: ctx.stage,
      operation: ctx.operation,
      attempt: ctx.attempt,
      provider: route.provider,
      model: route.model,
      requestedModel: route.model,
      locality: route.locality,
      snapshotHash: ctx.snapshotHash,
      modelPolicyDigest: effectivePolicy.policyDigest,
      promptTemplateVersion: ctx.promptTemplateVersion,
      ruleVersion: ctx.ruleVersion,
      systemPromptHash: promptHash,
      userPromptHash: promptHash,
    });
  } catch {
    return finishUnresolved('service', 'service_failure: model-call audit open failed; proposal unavailable.');
  }

  const startedAt = Date.now();
  try {
    assertHeld?.();
    const result = await dispatchSystemOne(
      conn,
      request,
      protectedSystemOneDispatchOptions(conn, model, assertHeld),
    );
    assertHeld?.();
    assertSystemOneModelMatch(model, result.returnedModel);
    completeModelCall(callId, {
      status: MODEL_CALL_STATUS.success,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      promptTokens: result.usage.inputTokens,
      completionTokens: result.usage.outputTokens,
      resolvedModel: result.returnedModel,
      typedResultMetadata: {
        questionIds: Object.keys(questions).sort(),
        questionCount: frozen.length,
        basis: 'choice_probability',
      },
    });

    const judgments: FamilyMembershipAnchorJudgment[] = [];
    const rawJudgments: FamilyMembershipProposalResult['rawJudgments'] = [];
    let sawService = false;
    for (const [questionId] of Object.entries(questions)) {
      const anchorSku = idByQuestion.get(questionId)!;
      const anchor = frozen.find((a) => a.anchor.sku === anchorSku)!;
      const keyMaps = keyMapsByQuestion.get(questionId)!;
      const answer = result.answers[questionId];
      if (!answer || answer.type !== 'choice') {
        sawService = true;
        judgments.push({
          anchorSku,
          familyPlanId: anchor.anchor.familyPlanId,
          verdict: null,
          outcome: 'service',
          rawChoice: null,
          selectedProbability: null,
          vendorConfidence: null,
          distribution: {},
          reason: `service_failure: incomplete model response for anchor "${anchorSku}"; relationship unevaluated.`,
        });
        continue;
      }
      const probabilities: Record<string, number> = {};
      for (const [key, value] of Object.entries(answer.probabilities ?? {})) {
        if (typeof value === 'number' && Number.isFinite(value)) probabilities[key] = value;
      }
      let canonicalChoice: string;
      try {
        canonicalChoice = choiceKeyToCanonicalId(keyMaps.keyToIdMap, answer.choice, 'option ID');
      } catch {
        sawService = true;
        judgments.push({
          anchorSku,
          familyPlanId: anchor.anchor.familyPlanId,
          verdict: null,
          outcome: 'service',
          rawChoice: answer.choice,
          selectedProbability: null,
          vendorConfidence: typeof answer.confidence === 'number' ? answer.confidence : null,
          distribution: {},
          reason: `service_failure: model returned an out-of-set choice ("${answer.choice}") for anchor "${anchorSku}".`,
        });
        continue;
      }
      // Remap request-keyed probabilities to canonical relationship IDs:
      // interpretAnchorChoice floors `same_permitted_family` by its canonical
      // key, and request keys (`fam_<sku>_<n>`) never match it — without this
      // every dispatched selection degrades to insufficient.
      const canonicalProbabilities: Record<string, number> = {};
      for (const [key, value] of Object.entries(probabilities)) {
        const canonical = keyMaps.keyToIdMap.get(key);
        if (canonical !== undefined) canonicalProbabilities[canonical] = value;
      }
      rawJudgments.push({ anchorSku, choice: canonicalChoice, probabilities: { ...canonicalProbabilities }, confidence: answer.confidence });
      const judged = interpretAnchorChoice({ anchor, choice: canonicalChoice, probabilities: canonicalProbabilities, confidence: answer.confidence });
      if (judged.outcome === 'service') sawService = true;
      judgments.push(judged);
    }

    const anySelected = judgments.some((j) => j.outcome === 'selected');
    const anySameSku = judgments.some((j) => j.outcome === 'same_sku');
    const overall: FamilyMembershipOutcome = sawService && !anySelected && !anySameSku
      ? 'service'
      : anySelected
        ? 'selected'
        : anySameSku
          ? 'same_sku'
          : judgments.every((j) => j.outcome === 'insufficient')
            ? 'insufficient'
            : 'insufficient';
    return {
      // Negative is a recorded refusal, never a live row: per-anchor
      // negatives carry no family selection, so an all-negative verdict set
      // persists unresolved and never replays from the reuse check.
      status: sawService && !anySelected && !anySameSku ? 'failed' : anySelected || anySameSku ? 'proposed' : 'unresolved',
      outcome: overall,
      sku,
      questionCount: frozen.length,
      judgments,
      modelCallIds: [callId],
      rawJudgments,
      overflow: false,
      evidenceHash,
      ruleHash,
      anchorHash,
      modelPolicyDigest: effectivePolicy.policyDigest,
      ruleVersion: rulesVersion,
      promptTemplateVersion,
    };
  } catch (err) {
    if (err instanceof HeartbeatLostError) throw err;
    assertHeld?.();
    try {
      completeModelCall(callId, {
        status: MODEL_CALL_STATUS.failed,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    } catch { /* audit best-effort */ }
    return {
      ...finishUnresolved('service', `service_failure: ${err instanceof Error ? err.message : String(err)}`),
      modelCallIds: [callId],
      error: err,
    };
  }
}

/**
 * Code-side gate: multiple `same_permitted_family` matches require
 * explicit conflict resolution — never automatic merging/reparenting.
 * Pure: returns the disposition without touching storage or the model.
 */
export function resolveProposalDisposition(judgments: FamilyMembershipAnchorJudgment[]): {
  positives: FamilyMembershipAnchorJudgment[];
  sameSku: FamilyMembershipAnchorJudgment[];
  conflicts: boolean;
  reason: string | null;
} {
  const positives = judgments.filter((j) => j.outcome === 'selected' && j.verdict === 'same_permitted_family');
  const sameSku = judgments.filter((j) => j.outcome === 'same_sku');
  const families = new Set(positives.map((j) => j.familyPlanId ?? `anchor:${j.anchorSku}`));
  const conflicts = families.size > 1;
  return {
    positives,
    sameSku,
    conflicts,
    reason: conflicts
      ? `Imported SKU matches ${families.size} families (${positives.map((j) => `"${(j.familyPlanId ?? j.anchorSku).slice(0, 8)}"`).join(', ')}); ` +
        `explicit conflict resolution required — never merge or reparent competing families.`
      : sameSku.length > 0
        ? `Same-SKU signal for ${sameSku.map((j) => `"${j.anchorSku}"`).join(', ')}; routes to identity/duplicate resolution, never family creation.`
        : null,
  };
}

/** No transitive union: A~B + B~C positives never merge incompatible A/C endpoints. */
export function checkTransitiveSafety(input: {
  positives: FamilyMembershipAnchorJudgment[];
  invariantOf: (anchorSku: string) => Record<string, string | null>;
}): { safe: boolean; reason: string | null } {
  if (input.positives.length < 2) return { safe: true, reason: null };
  const axes = new Set<string>();
  for (const p of input.positives) {
    for (const axis of Object.keys(input.invariantOf(p.anchorSku))) axes.add(axis);
  }
  for (const axis of axes) {
    const values = new Set(
      input.positives.map((p) => {
        const value = input.invariantOf(p.anchorSku)[axis];
        return value == null ? '∅' : value.toLowerCase();
      }),
    );
    if (values.size > 1) {
      return {
        safe: false,
        reason: `Transitive union refused: positive anchors disagree on invariant "${axis}"; A~B + B~C never merges incompatible endpoints.`,
      };
    }
  }
  return { safe: true, reason: null };
}


/** Hash helpers for identical-state reuse checks (same construction as dispatch). */
export function hashProposalEvidence(inputs: FamilyMembershipAnchorInput[], incoming?: { evidenceHash: string; typeHash: string; ruleVersion: string | null; revision: number | null; revisions?: Array<number | null>; memberEvidence?: unknown }): string {
  return evidenceHashFor(inputs, incoming);
}
export function hashProposalAnchors(inputs: FamilyMembershipAnchorInput[], incoming?: { sku: string; typeHash: string; ruleVersion: string | null; revision: number | null; revisions?: Array<number | null> }): string {
  return anchorHashFor(inputs, incoming);
}
export function hashProposalRules(inputs: FamilyMembershipAnchorInput[], policyDigest: string, incoming?: { ruleVersion: string | null; revision: number | null; revisions?: Array<number | null> }): string {
  return ruleHashFor(inputs, policyDigest, incoming);
}
