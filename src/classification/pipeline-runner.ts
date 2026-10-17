import { getDb } from '../db/connection';
import { randomUUID } from 'node:crypto';
import type { ClassificationStageName, StageDefinition, StageContext, StageInput, StageOutput, PipelineRunResult } from './types';
import type { ClassificationEvidence, ClassificationProposal } from '../shared/types';
import { snapshotHash } from './runtime-snapshot';
import { redactTransportText } from './model-policy-gateway';
import { MODEL_CALL_STATUS } from './model-operation-registry';
import { validateProposalSafety } from './proposal-safety';

const now = () => new Date().toISOString();

function recordStageResult(runId: string, stageName: ClassificationStageName, status: string, outputJson?: string, errorMessage?: string): string {
  const id = randomUUID();
  getDb().run(`INSERT INTO classification_stage_results (id, run_id, stage_name, status, output_json, error_message, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id, runId, stageName, status, outputJson ?? null, errorMessage ?? null, now(), now()]);
  return id;
}

function persistEvidence(runId: string, sku: string, evidence: ClassificationEvidence[], onboardingItemId?: string): void {
  if (evidence.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`INSERT INTO classification_evidence (id, run_id, onboarding_item_id, product_sku, stage_name, source, reliability, attribute_id, source_url, source_field, snippet, value_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const e of evidence) stmt.run(e.id || randomUUID(), runId, onboardingItemId ?? null, sku, e.stageName, e.source, e.reliability, e.attributeId ?? null, e.sourceUrl ?? null, e.sourceField ?? null, e.snippet ?? null, JSON.stringify(e.value ?? null), JSON.stringify(e.metadata ?? {}), now());
}

function persistProposals(runId: string, sku: string, proposals: ClassificationProposal[], configSnapshotHash?: string): void {
  if (proposals.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, is_bulk_acceptable, is_stale, staleness_reason, config_snapshot_hash, evidence_ids_json, supporting_evidence_ids_json, contradicting_evidence_ids_json, model_call_ids_json, derivation_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const p of proposals) stmt.run(p.id || randomUUID(), runId, sku, p.proposalType, p.targetId ?? null, JSON.stringify(p.proposedValue), p.confidence, p.status, p.isBulkAcceptable ? 1 : 0, p.isStale ? 1 : 0, p.stalenessReason ?? null, configSnapshotHash ?? null, JSON.stringify(p.evidenceIds ?? []), JSON.stringify(p.supportingEvidenceIds ?? []), JSON.stringify(p.contradictingEvidenceIds ?? []), JSON.stringify(p.modelCallIds ?? []), p.derivation ? JSON.stringify(p.derivation) : null, now());
}

/**
 * Fail-closed evidence linkage (issue #17 H + pass 5b): every proposal
 * evidence id must exist, belong to the same run/SKU, and be persisted in the
 * same stage transaction. The complete role union is validated:
 *
 * - `supportingEvidenceIds` and `contradictingEvidenceIds` must be pairwise
 *   disjoint and subsets of the full `evidenceIds` union (roles can never
 *   reference ids outside the union, and role-only ids can never bypass
 *   validation when the union is empty).
 * - Every union member is persisted with its authoritative relation
 *   (supporting/contradicting/context).
 * - Contradictions are never resolved here — they are persisted as visible
 *   contradicting relations and forced to individual review upstream.
 */
function linkProposalEvidence(
  proposalId: string,
  runId: string,
  sku: string,
  evidenceIds: string[],
  supportingEvidenceIds: string[],
  contradictingEvidenceIds: string[],
): void {
  const supporting = supportingEvidenceIds ?? [];
  const contradicting = contradictingEvidenceIds ?? [];

  // Role arrays must be subsets of the union and pairwise disjoint.
  const union = new Set(evidenceIds ?? []);
  for (const id of [...supporting, ...contradicting]) {
    if (!union.has(id)) {
      throw new Error(
        `Evidence linkage failed: proposal "${proposalId}" references evidence "${id}" ` +
          `in a role array that is not part of the proposal's evidence union.`,
      );
    }
  }
  const supportingSet = new Set(supporting);
  const contradictingSet = new Set(contradicting);
  for (const id of supportingSet) {
    if (contradictingSet.has(id)) {
      throw new Error(
        `Evidence linkage failed: proposal "${proposalId}" lists evidence "${id}" ` +
          `as BOTH supporting and contradicting.`,
      );
    }
  }
  if (union.size === 0) {
    if (supportingSet.size > 0 || contradictingSet.size > 0) {
      throw new Error(
        `Evidence linkage failed: proposal "${proposalId}" has role evidence ids ` +
          `but an empty evidence union.`,
      );
    }
    return;
  }

  const db = getDb();
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO classification_proposal_evidence (proposal_id, evidence_id, relation) VALUES (?, ?, ?)',
  );
  for (const evId of union) {
    const row = db.query(
      'SELECT run_id, product_sku FROM classification_evidence WHERE id = ?',
    ).get(evId) as { run_id: string; product_sku: string } | undefined;
    if (!row || String(row.run_id) !== runId || String(row.product_sku) !== sku) {
      throw new Error(
        `Evidence linkage failed: proposal "${proposalId}" references evidence "${evId}" ` +
          `that does not exist in run "${runId}" / SKU "${sku}".`,
      );
    }
    let relation: 'supporting' | 'contradicting' | 'context' = 'context';
    if (supportingSet.has(evId)) relation = 'supporting';
    else if (contradictingSet.has(evId)) relation = 'contradicting';
    stmt.run(proposalId, evId, relation);
  }
}

/**
 * Fail closed when any evidence or proposal does not belong to the current
 * run, or when a proposal was stamped with a different immutable runtime
 * snapshot hash than the run's snapshot.
 */
function assertRunBoundary(options: {
  runId: string;
  evidence: ClassificationEvidence[];
  proposals: ClassificationProposal[];
  snapshotHash?: string | null;
}): void {
  for (const evidence of options.evidence) {
    if (evidence.runId !== options.runId) {
      throw new Error(
        `Evidence runId mismatch: evidence "${evidence.id}" belongs to run "${evidence.runId}", expected "${options.runId}".`,
      );
    }
  }
  for (const proposal of options.proposals) {
    if (proposal.runId !== options.runId) {
      throw new Error(
        `Proposal runId mismatch: proposal "${proposal.id}" belongs to run "${proposal.runId}", expected "${options.runId}".`,
      );
    }
    if (options.snapshotHash !== undefined && options.snapshotHash !== null && proposal.snapshotHash !== options.snapshotHash) {
      throw new Error(
        `Proposal snapshot hash mismatch: proposal "${proposal.id}" is stamped with snapshot hash ` +
          `${proposal.snapshotHash ?? 'null'}, expected "${options.snapshotHash}".`,
      );
    }
  }
}

/**
 * Verify every model-call ID stamped on the proposals belongs to the current
 * run AND snapshot hash. A foreign call row (another run or snapshot) must
 * never be linked to a proposal — fail closed before persistence.
 *
 * PR7 C6b cohort-aware exemption (issue #30): a materialized proposal in an
 * ACTIVE cohort run references the call id stored on its durable
 * `classification_cohort_outputs` row — and the parent op's audited page/title
 * calls are deliberately bound to the ordinal-0 member child run (DECISION-N
 * audit binding, mirroring titles), so every group/singleton member's output
 * row carries a call id that belongs to the ORDINAL-0 child, not the member's
 * own child. The exemption is NARROW and preserves fail-closed safety:
 *   - the call row must EXIST and be terminal-success BEFORE any exemption
 *     (a missing row or a non-success status still hard-fails);
 *   - ONLY the run_id / snapshot_hash mismatch is exempted, and ONLY when the
 *     proposal's run is a cohort child (`classification_runs.cohort_run_id`
 *     NOT NULL) AND a `classification_cohort_outputs` row exists with
 *     `model_call_id = callId` for the SAME cohort run AND the SAME
 *     `product_sku` as the proposal — the output rows are write-once
 *     historical truth written only by the parent ops, so a resolved
 *     reference is real audit truth, never a forged id.
 * Any call id that does not resolve through that check fails exactly as
 * before: non-cohort runs, foreign runs/cohorts, wrong SKU, missing output
 * row, and non-success statuses are all unchanged hard fails.
 */
function assertModelCallLinkage(options: {
  runId: string;
  snapshotHash?: string | null;
  proposals: ClassificationProposal[];
}): void {
  if (options.snapshotHash === undefined || options.snapshotHash === null) return;
  const db = getDb();
  for (const proposal of options.proposals) {
    const callIds = proposal.modelCallIds ?? [];
    if (callIds.length === 0) continue;
    for (const callId of callIds) {
      const row = db
        .query('SELECT run_id, snapshot_hash, status FROM classification_model_calls WHERE id = ?')
        .get(callId) as { run_id: string; snapshot_hash: string | null; status: string } | undefined;
      // Hard-fail 1: the call row MUST exist — a nonexistent id can never be
      // linked to a persisted proposal (no exemption).
      if (!row) {
        throw new Error(
          `Model call linkage failed: proposal "${proposal.id}" references model call "${callId}" ` +
            'that does not exist.',
        );
      }
      // Hard-fail 2: the call MUST be terminal-success — a `started`
      // (non-terminal) call can never be linked to a persisted proposal (no
      // durable success means no model output reached it). No exemption.
      if (row.status !== MODEL_CALL_STATUS.success) {
        throw new Error(
          `Model call linkage failed: proposal "${proposal.id}" references model call "${callId}" ` +
            `with non-terminal/non-success status "${row.status}"; only durable success calls can be linked.`,
        );
      }
      // PR7 C6b + review R2 (F3-2): ONLY the run/snapshot mismatch may be
      // exempted, and only for a CATEGORY_PAGE proposal whose call id
      // resolves to a durable `coordinated_page` output row of the SAME
      // cohort run + SKU (the parent op's ordinal-0-bound audited call). A
      // category_page proposal carrying a curated_title call id, or a
      // non-category_page proposal carrying a coordinated_page call id, must
      // FAIL CLOSED exactly as before.
      if (row.run_id !== options.runId || row.snapshot_hash !== options.snapshotHash) {
        if (
          proposal.proposalType !== 'category_page' ||
          !cohortCoordinatedOutputLinkage(options.runId, callId, proposal.productSku)
        ) {
          throw new Error(
            `Model call linkage failed: proposal "${proposal.id}" references model call "${callId}" ` +
              `that does not belong to run "${options.runId}" / snapshot "${options.snapshotHash}".`,
          );
        }
      }
    }
  }
}

/**
 * PR7 C6b (issue #30): cohort-coordinated output linkage — the ONLY narrow
 * exemption to the model-call run/snapshot check. Resolves true when the
 * proposal's run is a COHORT CHILD (`classification_runs.cohort_run_id` NOT
 * NULL) AND a durable `classification_cohort_outputs` row exists whose
 * `model_call_id` equals the call id for the SAME cohort run AND the SAME
 * `product_sku` as the proposal. The output rows are write-once historical
 * truth written only by the parent ops, so a resolved reference is genuine
 * audit provenance: the parent op's audited calls bind to the ordinal-0
 * member child run (DECISION-N), and every member's durable row inherits that
 * call id. Any call id that does NOT resolve through this query fails exactly
 * as before (non-cohort runs, foreign runs/cohorts, wrong SKU, missing row).
 * PR7 review R2 (F3-2): the resolved output row MUST be output_kind
 * 'coordinated_page' — a curated_title row (or any other kind) never
 * satisfies the page exemption, so a category_page proposal carrying a
 * title-op call id fails closed.
 */
function cohortCoordinatedOutputLinkage(
  runId: string,
  callId: string,
  productSku: string | undefined,
): boolean {
  if (!productSku) return false;
  const row = getDb().query(
    `SELECT 1
     FROM classification_runs c
     JOIN classification_cohort_outputs o ON o.cohort_run_id = c.cohort_run_id
     WHERE c.id = ? AND c.cohort_run_id IS NOT NULL
       AND o.output_kind = 'coordinated_page'
       AND o.model_call_id = ? AND o.product_sku = ?
     LIMIT 1`,
  ).get(runId, callId, productSku);
  return row !== null && row !== undefined;
}

/**
 * Persist a successful or abstained stage atomically. A stage result must
 * never claim success unless all evidence, proposals, evidence links, and
 * model-call linkages are durable in the same transaction.
 */
function persistStageCompletion(options: {
  runId: string;
  sku: string;
  stageName: ClassificationStageName;
  status: 'succeeded' | 'abstained';
  evidence: ClassificationEvidence[];
  proposals: ClassificationProposal[];
  onboardingItemId?: string;
  configSnapshotHash?: string;
  outputJson?: string;
  errorMessage?: string;
}): void {
  const db = getDb();
  db.transaction(() => {
    assertModelCallLinkage({
      runId: options.runId,
      snapshotHash: options.configSnapshotHash,
      proposals: options.proposals,
    });
    persistEvidence(options.runId, options.sku, options.evidence, options.onboardingItemId);
    persistProposals(options.runId, options.sku, options.proposals, options.configSnapshotHash);
    for (const proposal of options.proposals) {
      linkProposalEvidence(
        proposal.id,
        options.runId,
        options.sku,
        proposal.evidenceIds ?? [],
        proposal.supportingEvidenceIds ?? [],
        proposal.contradictingEvidenceIds ?? [],
      );
    }
    recordStageResult(
      options.runId,
      options.stageName,
      options.status,
      options.outputJson,
      options.errorMessage,
    );
  })();
}

export async function runPipeline(stages: StageDefinition[], context: StageContext, input: StageInput,
  options: { prepareOnly?: boolean } = {}): Promise<PipelineRunResult> {
  const preparedStages: Array<() => void> = [];
  const publishCompletion = (completion: Parameters<typeof persistStageCompletion>[0]): void => {
    if (options.prepareOnly) preparedStages.push(() => persistStageCompletion(completion));
    else persistStageCompletion(completion);
  };
  // Fail closed if the frozen snapshot was tampered with since build.
  if (context.snapshot) {
    const recomputed = snapshotHash(context.snapshot);
    if (recomputed !== context.snapshot.snapshotHash) {
      throw new Error(
        `Runtime snapshot hash mismatch: recomputed ${recomputed}, embedded ${context.snapshot.snapshotHash}. Snapshot mutated since build.`,
      );
    }
  }

  const order = resolveStageOrder(stages);
  const allEvidence: ClassificationEvidence[] = [...input.evidence];
  const allProposals: ClassificationProposal[] = [...input.allProposals];
  const acceptedProposals: ClassificationProposal[] = [...input.acceptedProposals];
  const stageOutputs: Partial<Record<ClassificationStageName, StageOutput>> = {};

  // PR3 hardening C (in-flight lease assertion): when the cohort executor
  // injects an ownership assertion (`StageContext.assertHeld`), it is invoked
  // IMMEDIATELY BEFORE every post-await persistence transaction / terminal
  // update below. A rejected assertion throws `HeartbeatLostError` and that
  // persistence is SKIPPED — a stale owner never writes run-scoped shared
  // state (model calls / stage results / evidence / proposals) after a sibling
  // reclaim. Absent in legacy mode (no-op).
  const assertOwnership = (): void => {
    context.assertHeld?.();
  };

  for (const stageName of order) {
    const stage = stages.find(s => s.name === stageName);
    if (!stage) continue;
    // PR8 C1 (issue #30): prior stage outputs are threaded to downstream
    // stages so e.g. `product_draft_projection` reads the SAME
    // `name_consolidation.metadata` the orchestrator reads post-run (never a
    // re-derivation).
    const stageInput: StageInput = { sku: input.sku, onboardingItemId: input.onboardingItemId, sourceKind: input.sourceKind, evidence: allEvidence, acceptedProposals, allProposals, stageOutputs };
    let failureRecorded = false;
    try {
      const result = await stage.execute(stageInput, context);
      if (result.status === 'succeeded') {
        const out = result.output;
        const outputPayload: Record<string, unknown> = {
          ec: out.evidence.length,
          pc: out.proposals.length,
        };
        if (out.metadata) outputPayload.metadata = out.metadata;

        assertRunBoundary({
          runId: context.runId,
          evidence: out.evidence,
          proposals: out.proposals,
          snapshotHash: context.snapshot?.snapshotHash,
        });

        assertOwnership();
        publishCompletion({
          runId: context.runId,
          sku: input.sku,
          stageName,
          status: 'succeeded',
          evidence: out.evidence,
          proposals: out.proposals,
          onboardingItemId: input.onboardingItemId,
          configSnapshotHash: context.snapshot?.snapshotHash ?? context.configSnapshotRef?.hash,
          outputJson: JSON.stringify(outputPayload),
        });

        // Downstream stages only see data after the transaction commits.
        allEvidence.push(...out.evidence);
        allProposals.push(...out.proposals);
        stageOutputs[stageName] = out;
      } else if (result.status === 'abstained') {
        const abstentionProposal: ClassificationProposal = {
          id: randomUUID(),
          runId: context.runId,
          productSku: input.sku,
          proposalType: 'reviewable_abstention',
          targetId: stageName,
          proposedValue: { reason: result.reason },
          confidence: 0,
          evidenceIds: [],
          status: 'pending',
          isBulkAcceptable: false,
          isStale: false,
          stalenessReason: null,
          snapshotHash: context.snapshot?.snapshotHash ?? null,
          createdAt: now(),
        };
        const outputPayload: Record<string, unknown> = {
          ec: 0,
          pc: 1,
          reason: result.reason,
        };
        if (result.output?.metadata) {
          outputPayload.metadata = result.output.metadata;
        }
        assertRunBoundary({
          runId: context.runId,
          evidence: [],
          proposals: [abstentionProposal],
          snapshotHash: context.snapshot?.snapshotHash,
        });
        assertOwnership();
        publishCompletion({
          runId: context.runId,
          sku: input.sku,
          stageName,
          status: 'abstained',
          evidence: [],
          proposals: [abstentionProposal],
          onboardingItemId: input.onboardingItemId,
          configSnapshotHash: context.snapshot?.snapshotHash ?? context.configSnapshotRef?.hash,
          outputJson: JSON.stringify(outputPayload),
          errorMessage: result.reason,
        });
        stageOutputs[stageName] = {
          evidence: [],
          proposals: [],
          abstained: true,
          ...(result.output?.metadata ? { metadata: result.output.metadata } : {}),
        };
        allProposals.push(abstentionProposal);
      } else {
        assertOwnership();
        recordStageResult(context.runId, stageName, 'failed', undefined, result.error);
        failureRecorded = true;
        throw new Error(`Stage ${stageName} failed: ${result.error}`);
      }
    } catch (err) {
      if (!failureRecorded) {
        assertOwnership();
        recordStageResult(
          context.runId,
          stageName,
          'failed',
          undefined,
          redactTransportText(err instanceof Error ? err.message : String(err)),
        );
      }
      throw err;
    }
  }
  // Central candidate safety choke point: every accumulated proposal must
  // pass claim/composition evidence, controlled membership, measured-unit,
  // cardinality, and delimiter policy validation before the run can succeed.
  // Confidence never bypasses this review gate.
  // story: e05s02 — pass verified page ids so category_page invented IDs fail closed (ADR 0012)
  const verifiedPageIdsForSafety = (() => {
    const pages = context.snapshot?.pages;
    if (!pages || pages.state !== 'verified') return null;
    const ids = pages.records.filter(r => r.verified).map(r => r.pageId);
    return ids.length > 0 ? new Set(ids) : null;
  })();
  const safety = validateProposalSafety(allProposals, {
    attributes: context.snapshot?.attributes ?? [],
    evidence: allEvidence,
    verifiedPageIds: verifiedPageIdsForSafety,
  });
  if (!safety.ok) {
    const finding = safety.findings[0];
    throw new Error(`Proposal safety validation failed: ${finding.code} — ${finding.message}`);
  }

  return { evidence: allEvidence, proposals: allProposals, stageOutputs,
    ...(options.prepareOnly ? { commitPreparedStages: () => { assertOwnership(); for (const commit of preparedStages) commit(); } } : {}) };
}

export function resolveStageOrder(stages: StageDefinition[]): ClassificationStageName[] {
  const names = new Set(stages.map(s => s.name));
  const inDegree = new Map<ClassificationStageName, number>();
  const dependents = new Map<ClassificationStageName, ClassificationStageName[]>();
  for (const s of stages) { inDegree.set(s.name, 0); dependents.set(s.name, []); for (const dep of s.requires) { if (names.has(dep)) { inDegree.set(s.name, (inDegree.get(s.name) ?? 0) + 1); dependents.set(dep, [...(dependents.get(dep) ?? []), s.name]); } } }
  const queue: ClassificationStageName[] = []; for (const [n, d] of inDegree) if (d === 0) queue.push(n);
  const result: ClassificationStageName[] = [];
  while (queue.length) { const n = queue.shift()!; result.push(n); for (const dep of dependents.get(n) ?? []) { const nd = (inDegree.get(dep) ?? 1) - 1; inDegree.set(dep, nd); if (nd === 0) queue.push(dep); } }
  for (const s of stages) if (!result.includes(s.name)) result.push(s.name);
  return result;
}
