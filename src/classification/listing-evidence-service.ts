/**
 * Listing-Evidence Evaluation Service (issue #366).
 *
 * Runs in Curation against read-only eligible materialization and persists
 * the `listingEvidenceValidation` record on the item's curation data:
 *
 * 1. Build claim units in code from the final projected title, description
 *    sentences/bullets, and included variant facts (offsets/qualifiers
 *    preserved; no generative extractor).
 * 2. Deterministic checks first (citation/span, eligibility/currentness/
 *    linkage, hard conflicts, identifiers, quantities/units, variant
 *    consistency). Exact supported structured copies need no call; a model
 *    can never overrule concrete contradiction or wrong identity.
 * 3. One bounded request: independent supported/contradicted/insufficient
 *    Choice per REMAINING claim (<=24). Whole-block support required.
 * 4. Persist hashes, versions, per-claim verdict/producer/evidence,
 *    true call ids, aggregate status.
 *
 * Failure, incomplete responses, uncertainty, or overflow never produce a
 * partial all-clear (status `unavailable`, release-blocking).
 */
import type { ClassificationEvidence } from '../shared/schemas/classification';
import type {
  ListingEvidenceClaim,
  ListingEvidenceValidation,
} from '../shared/schemas/onboarding';
import {
  buildClaimUnits,
  deterministicClaimCheck,
  eligibleEvidenceFor,
  hashAcceptedEvidenceBundle,
  hashEvidenceBundle,
  hashFinalListing,
  oversizedUnavailableRecords,
  toDeterministicClaimRecord,
  LISTING_EVIDENCE_MAX_CLAIMS,
  LISTING_EVIDENCE_MAX_UNIT_CHARS,
  LISTING_EVIDENCE_RULES_VERSION,
  type BuiltClaim,
  type EligibleEvidence,
  type FinalListingInput,
} from './listing-evidence';
import {
  dispatchSystemOne,
  TYPESAFE_EVALUATED_MODEL,
  assertSystemOneModelMatch,
} from '../ai/systemone-transport';
import { findSystemOneConnection, resolveSystemOneCredential } from './systemone-decision-core';
import { resolveModelRoute, assertModelPolicyIntact, ModelPolicyDeniedError, type ModelPolicyView, type ModelRoute } from './model-policy-gateway';
import { getFullAiRoutingConfig } from '../db/repositories/provider-connection-repo';
import { assertConnectionEnabledForDispatch, type ProviderConnection } from '../ai/provider-connections';
import { insertModelCallStart, completeModelCall, insertTerminalModelCall } from '../db/repositories/classification-model-call-repo';
import { MODEL_CALL_STATUS, PROMPT_TEMPLATE_VERSIONS, RULE_VERSIONS } from './model-operation-registry';
import { hashCanonicalJson } from '../shared/stable-id';

export const LISTING_EVIDENCE_OPERATION = 'listing_evidence_check' as const;

export interface ListingEvidenceRuntime {
  runId: string;
  modelPolicy: ModelPolicyView | null;
  assertHeld?: () => void;
  evaluatedAt?: string;
  /** Current authority hash from the accepted item-evidence snapshot. */
  sourceAuthority?: string | null;
  /** Exact immutable accepted evidence snapshot hash bound to this evaluation. */
  acceptedSnapshotHash?: string | null;
}

/** Result of one evaluation (persisted verbatim as the record). */
export interface ListingEvidenceEvaluationResult {
  record: ListingEvidenceValidation;
  /** Claims resolved deterministically (no call). */
  deterministicCount: number;
  /** Claims resolved by the bounded Choice. */
  modelCount: number;
  /** Model call ids issued (true ids, in order). */
  callIds: string[];
}

const CLAIM_INSTRUCTIONS =
  'For the listing claim below, judge it ONLY against the supplied eligible evidence for this exact SKU. ' +
  'Every material assertion in the claim block must be supported for a supported verdict; one matching clause cannot certify the block. ' +
  'Negations and qualifiers matter (e.g. "unsuitable for puppies" is not "suitable for puppies"). ' +
  'Sibling, stale, other-variant, or unlinked text is not evidence. ' +
  'Choose exactly one: claim_supported (every material assertion is affirmed by the eligible evidence), ' +
  'claim_contradicted (eligible evidence denies a material assertion), or ' +
  'claim_insufficient (the eligible evidence neither affirms every assertion nor denies one).';

function criterionText(kind: 'supported' | 'contradicted' | 'insufficient'): string {
  if (kind === 'supported') return 'Every material assertion in the claim is affirmed by the eligible SKU-local evidence.';
  if (kind === 'contradicted') return 'Eligible SKU-local evidence denies a material assertion in the claim.';
  return 'The eligible evidence neither affirms every material assertion nor denies one.';
}

function currentPolicyDigest(policy: ModelPolicyView | null): string {
  return policy?.policyDigest ?? 'policy_unavailable';
}

/**
 * Resolve the frozen route for the listing-evidence operation (null when
 * the stage is onboarding-only: resolve from the snapshot default
 * provider/model). Returns null when no policy/call is possible — the
 * caller records `unavailable`, never a pass.
 */
function resolveListingRoute(policy: ModelPolicyView | null): {
  route: ModelRoute;
  conn: ProviderConnection;
} | null {
  if (!policy) return null;
  try {
    assertModelPolicyIntact(policy);
    const route = resolveModelRoute(policy, LISTING_EVIDENCE_OPERATION, {
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
  } catch (err) {
    if (err instanceof ModelPolicyDeniedError) return null;
    return null;
  }
}

/**
 * Evaluate the final projected listing against eligible evidence.
 * Never throws for model/policy/transport reasons: those become
 * `unavailable` claims (release-blocking), never a partial all-clear.
 */
export async function evaluateListingEvidence(
  listing: FinalListingInput,
  allEvidence: ClassificationEvidence[],
  sku: string,
  runtime: ListingEvidenceRuntime,
): Promise<ListingEvidenceEvaluationResult> {
  const evaluatedAt = runtime.evaluatedAt ?? new Date().toISOString();
  const { claims, overflow, oversized } = buildClaimUnits(listing);
  const eligible = eligibleEvidenceFor(allEvidence, sku);
  const listingHash = hashFinalListing(listing);
  const evidenceHash = runtime.acceptedSnapshotHash
    ? hashAcceptedEvidenceBundle(runtime.acceptedSnapshotHash, eligible)
    : hashEvidenceBundle(eligible);
  const policyDigest = currentPolicyDigest(runtime.modelPolicy);
  const sourceAuthority = runtime.sourceAuthority ?? null;

  if (oversized) {
    // Gap 3: an oversized sentence/bullet/title exceeds the semantic
    // question bound, so its full content was never evaluated. Fail closed:
    // every claim is `unavailable` (never a partial all-clear over the
    // truncated prefix), release-blocking until the listing is narrowed.
    const unavailable = oversizedUnavailableRecords(
      claims,
      eligible,
      `A listing claim exceeds the ${LISTING_EVIDENCE_MAX_UNIT_CHARS}-character single-unit bound; narrow the listing and re-run.`,
    );
    return {
      record: {
        recordVersion: 1,
        listingHash,
        evidenceHash,
        requiredFields: [...listing.requiredFields].sort(),
        rulesVersion: LISTING_EVIDENCE_RULES_VERSION,
        modelPolicyDigest: policyDigest,
        sourceAuthority,
        claims: unavailable,
        overflow: false,
        modelCallIds: [],
        status: 'unavailable',
        findings: ['A listing claim exceeds the single-unit semantic bound; evaluation is incomplete and release-blocking.'],
        evaluatedAt,
      },
      deterministicCount: 0,
      modelCount: 0,
      callIds: [],
    };
  }
  if (overflow) {
    // Overflow is explicit, never silently clipped: every claim is
    // `unavailable` so the listing cannot ship on a partial check.
    const unavailable: ListingEvidenceClaim[] = claims.map(c => ({
      id: c.id,
      field: c.field,
      span: c.span,
      text: c.text.slice(0, 2000),
      claimHash: c.claimHash,
      material: c.material,
      verdict: 'unavailable' as const,
      producer: 'unavailable' as const,
      evidenceConsidered: eligible.map(e => e.evidence.id).sort(),
      modelCallId: null,
      reason: `Listing exceeds the ${LISTING_EVIDENCE_MAX_CLAIMS}-claim semantic bound; narrow the listing and re-run.`,
    }));
    return {
      record: {
        recordVersion: 1,
        listingHash,
        evidenceHash,
        requiredFields: [...listing.requiredFields].sort(),
        rulesVersion: LISTING_EVIDENCE_RULES_VERSION,
        modelPolicyDigest: policyDigest,
        sourceAuthority,
        claims: unavailable,
        overflow: true,
        modelCallIds: [],
        status: 'unavailable',
        findings: ['Listing exceeds the semantic claim bound; evaluation is incomplete and release-blocking.'],
        evaluatedAt,
      },
      deterministicCount: 0,
      modelCount: 0,
      callIds: [],
    };
  }

  const records: ListingEvidenceClaim[] = [];
  const pending: Array<{ claim: BuiltClaim; eligible: EligibleEvidence[] }> = [];
  for (const claim of claims) {
    const verdict = deterministicClaimCheck(claim, eligible);
    if (verdict.verdict === 'supported' || verdict.verdict === 'contradicted') {
      records.push(toDeterministicClaimRecord(claim, verdict, eligible));
    } else {
      pending.push({ claim, eligible });
    }
  }

  // Exact supported copies needed no call; remaining claims get ONE bounded
  // request with independent Choices. No remaining claims ⇒ no call at all.
  let modelCallIds: string[] = [];
  if (pending.length > 0) {
    const routed = resolveListingRoute(runtime.modelPolicy);
    if (!routed) {
      for (const { claim } of pending) {
        records.push({
          id: claim.id,
          field: claim.field,
          span: claim.span,
          text: claim.text.slice(0, 2000),
          claimHash: claim.claimHash,
          material: claim.material,
          verdict: 'unavailable',
          producer: 'unavailable',
          evidenceConsidered: eligible.map(e => e.evidence.id).sort(),
          modelCallId: null,
          reason: 'No usable model route for the listing-evidence check; evaluation unavailable.',
        });
      }
      try {
        insertTerminalModelCall({
          runId: runtime.runId,
          stageName: null,
          operation: LISTING_EVIDENCE_OPERATION,
          attempt: 1,
          provider: null,
          model: null,
          locality: null,
          snapshotHash: runtime.modelPolicy?.snapshotHash ?? '',
          modelPolicyDigest: policyDigest,
          promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS[LISTING_EVIDENCE_OPERATION],
          ruleVersion: RULE_VERSIONS[LISTING_EVIDENCE_OPERATION],
          systemPromptHash: '',
          userPromptHash: '',
          status: 'unavailable',
          errorMessage: 'listing-evidence route unavailable (policy/connection denied or unconfigured)',
        });
      } catch { /* audit best-effort */ }
    } else {
      modelCallIds = await runBoundedClaimChoices(pending, eligible, sku, runtime, policyDigest, records);
    }
  }

  records.sort((a, b) => (a.id < b.id ? -1 : 1));
  const status = aggregateStatus(records, overflow);
  const findings = buildFindings(records);
  return {
    record: {
      recordVersion: 1,
      listingHash,
      evidenceHash,
      requiredFields: [...listing.requiredFields].sort(),
      rulesVersion: LISTING_EVIDENCE_RULES_VERSION,
      modelPolicyDigest: policyDigest,
      sourceAuthority,
      claims: records,
      overflow: false,
      modelCallIds,
      status,
      findings,
      evaluatedAt,
    },
    deterministicCount: records.filter(r => r.producer === 'deterministic').length,
    modelCount: records.filter(r => r.producer === 'typesafe').length,
    callIds: modelCallIds,
  };
}

/** Aggregate: any included unsafe claim blocks; uncertainty never clears. Exported for behavioral tests. */
export function aggregateStatus(
  records: ListingEvidenceClaim[],
  overflow: boolean,
): ListingEvidenceValidation['status'] {
  if (overflow) return 'unavailable';
  if (records.length === 0) return 'passed'; // no included material text ⇒ nothing to block
  let hasUnavailable = false;
  let hasInsufficient = false;
  for (const record of records) {
    if (!record.material) continue;
    if (record.verdict === 'contradicted') return 'blocked';
    if (record.verdict === 'unavailable' || record.verdict === 'stale') hasUnavailable = true;
    if (record.verdict === 'insufficient') hasInsufficient = true;
  }
  // Insufficient (unsupported-but-included) material text blocks release even
  // when its field is optional: remove it, correct it, or supply evidence.
  if (hasUnavailable) return 'unavailable';
  if (hasInsufficient) return 'blocked';
  return 'passed';
}

/** Operator-actionable findings: field-linked, bounded, no invented quotes. */
function buildFindings(records: ListingEvidenceClaim[]): string[] {
  const findings: string[] = [];
  for (const record of records) {
    if (!record.material) continue;
    if (record.verdict === 'supported') continue;
    const where = record.field === 'variant' ? `variant fact "${record.text.slice(0, 80)}"` : `${record.field} "${record.text.slice(0, 80)}"`;
    if (record.verdict === 'contradicted') {
      findings.push(`Contradicted ${where}: ${record.reason ?? 'eligible evidence denies it'}`.slice(0, 500));
    } else if (record.verdict === 'insufficient') {
      findings.push(`Unsupported ${where}: remove it, correct it, or supply eligible evidence.`.slice(0, 500));
    } else {
      findings.push(`Unevaluated ${where}: ${record.reason ?? 're-run the listing check'}`.slice(0, 500));
    }
    if (findings.length >= 12) break;
  }
  return findings;
}

/**
 * One bounded request: independent supported/contradicted/insufficient
 * Choice per remaining claim over the relevant eligible bundle. Partial
 * responses or transport failure become `unavailable` (never all-clear).
 * Mutates `records` in place with the resolved claims; returns call ids.
 */
async function runBoundedClaimChoices(
  pending: Array<{ claim: BuiltClaim; eligible: EligibleEvidence[] }>,
  eligible: EligibleEvidence[],
  sku: string,
  runtime: ListingEvidenceRuntime,
  policyDigest: string,
  records: ListingEvidenceClaim[],
): Promise<string[]> {
  const routed = resolveListingRoute(runtime.modelPolicy);
  if (!routed) return [];
  const route = routed.route;
  const jevConn: ProviderConnection = routed.conn;
  const model = route.model || TYPESAFE_EVALUATED_MODEL;

  const evidenceLines = eligible
    .map(e => `[${e.evidence.id}] (${e.sourceField || 'unstated'}): ${e.text.slice(0, 500)}`)
    .slice(0, 40);
  const state = {
    sku,
    evidence: evidenceLines,
    operation: LISTING_EVIDENCE_OPERATION,
  };

  const questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }> = {};
  const keyToClaim = new Map<string, BuiltClaim>();
  for (const { claim } of pending) {
    const questionId = `lev_${claim.id}`;
    // Gap 3: the FULL claim text rides the question (claims never exceed
    // 2000 chars by schema; oversized units fail closed before reaching
    // here, so no truncation certifies unevaluated content).
    questions[questionId] = {
      type: 'choice',
      instructions: `${CLAIM_INSTRUCTIONS}\n\nClaim [${claim.id}] (${claim.field}): "${claim.text}"`,
      criteria: {
        claim_supported: criterionText('supported'),
        claim_contradicted: criterionText('contradicted'),
        claim_insufficient: criterionText('insufficient'),
      },
    };
    keyToClaim.set(questionId, claim);
  }

  const request = { model, state, questions };
  const promptHash = hashCanonicalJson(request);
  let callId: string;
  try {
    runtime.assertHeld?.();
    callId = insertModelCallStart({
      runId: runtime.runId,
      stageName: null,
      operation: LISTING_EVIDENCE_OPERATION,
      attempt: 1,
      provider: route.provider,
      model: route.model,
      requestedModel: route.model,
      locality: route.locality,
      snapshotHash: runtime.modelPolicy?.snapshotHash ?? '',
      modelPolicyDigest: policyDigest,
      promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS[LISTING_EVIDENCE_OPERATION],
      ruleVersion: RULE_VERSIONS[LISTING_EVIDENCE_OPERATION],
      systemPromptHash: promptHash,
      userPromptHash: promptHash,
    });
  } catch {
    for (const { claim } of pending) {
      records.push(unavailableClaim(claim, eligible, 'Model-call audit open failed; evaluation unavailable.'));
    }
    return [];
  }

  const startedAt = Date.now();
  try {
    runtime.assertHeld?.();
    const result = await dispatchSystemOne(jevConn, request, {
      assertHeld: runtime.assertHeld,
    });
    runtime.assertHeld?.();
    assertSystemOneModelMatch(model, result.returnedModel);
    const durationMs = Date.now() - startedAt;
    completeModelCall(callId, {
      status: MODEL_CALL_STATUS.success,
      endedAt: new Date().toISOString(),
      durationMs,
      promptTokens: result.usage.inputTokens,
      completionTokens: result.usage.outputTokens,
      resolvedModel: result.returnedModel,
      typedResultMetadata: {
        operation: LISTING_EVIDENCE_OPERATION,
        questionCount: pending.length,
        basis: 'choice_probability',
      },
    });

    for (const [questionId, claim] of keyToClaim) {
      const answer = result.answers[questionId];
      if (!answer || answer.type !== 'choice') {
        records.push(unavailableClaim(claim, eligible, 'Incomplete model response; claim unevaluated.'));
        continue;
      }
      const choice = answer.choice;
      if (choice !== 'claim_supported' && choice !== 'claim_contradicted' && choice !== 'claim_insufficient') {
        records.push(unavailableClaim(claim, eligible, 'Model returned an out-of-set choice; claim unevaluated.'));
        continue;
      }
      records.push({
        id: claim.id,
        field: claim.field,
        span: claim.span,
        text: claim.text.slice(0, 2000),
        claimHash: claim.claimHash,
        material: claim.material,
        verdict: choice === 'claim_supported' ? 'supported' : choice === 'claim_contradicted' ? 'contradicted' : 'insufficient',
        producer: 'typesafe',
        evidenceConsidered: eligible.map(e => e.evidence.id).sort(),
        modelCallId: callId,
        reason: `Bounded Choice: ${choice.replace('claim_', '')} over ${eligible.length} eligible record(s).`.slice(0, 500),
      });
    }
    return [callId];
  } catch {
    try {
      completeModelCall(callId, {
        status: MODEL_CALL_STATUS.failed,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        errorMessage: 'listing-evidence dispatch failed',
      });
    } catch { /* audit best-effort */ }
    for (const { claim } of pending) {
      records.push(unavailableClaim(claim, eligible, 'Listing-evidence service failure; claim unevaluated.'));
    }
    return [callId];
  }
}

function unavailableClaim(claim: BuiltClaim, eligible: EligibleEvidence[], reason: string): ListingEvidenceClaim {
  return {
    id: claim.id,
    field: claim.field,
    span: claim.span,
    text: claim.text.slice(0, 2000),
    claimHash: claim.claimHash,
    material: claim.material,
    verdict: 'unavailable',
    producer: 'unavailable',
    evidenceConsidered: eligible.map(e => e.evidence.id).sort(),
    modelCallId: null,
    reason: reason.slice(0, 500),
  };
}

