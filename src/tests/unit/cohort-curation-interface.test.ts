/**
 * Cohort Curation public-execution interface tests (plan Slice 2, §3.2.1).
 *
 * Everything runs through `executeClaim` — never around it. The seeded
 * title-reuse recipe (zero transport) mirrors the surviving worker suite;
 * a default-deny fetch installer proves the seam performs no undeclared
 * model calls on these paths.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  assertCohortSynthesisOrdering,
  COHORT_SYNTHESIS_REQUIRED_STAGES,
} from '../../onboarding/product-curator';
import type { PipelineRunResult, StageOutput } from '../../classification/types';
import { getDb } from '../../db/connection';
import { findItemById } from '../../db/repositories/onboarding-item-repo';
import {
  claimReadyCurationCohorts,
  getCohortRunById,
} from '../../db/repositories/classification-cohort-run-repo';
import {
  countCohortTitleOutputs,
  getCohortPageOutputsByRun,
} from '../../db/repositories/classification-cohort-output-repo';
import { freezeCohortForExecution } from '../../onboarding/cohort-curation/freeze';
import { createCohortCuration } from '../../onboarding/cohort-curation/index';
import {
  overrideCohortCurationFlags,
  resetCohortCurationFlagsOverride,
} from '../../classification/flags';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import {
  createDisposableCurationContext,
  createReadyCohort,
  settledExtraction,
  installFetchTransport,
  seedDeterministicTitleOutputs,
  type DisposableCurationContext,
} from './helpers/cohort-curation-harness';

let ctx: DisposableCurationContext;
let denyFetch: { calls: unknown[]; restore: () => void };

beforeAll(() => {
  setTaxonomyFreezeForTests(false);
  ctx = createDisposableCurationContext();
  overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
  // Default-deny transport for the whole suite: every test below must pass
  // with zero model calls unless it installs its own fake.
  denyFetch = installFetchTransport(() => {
    throw new Error('unexpected model transport on a seeded-reuse path');
  });
});

afterAll(() => {
  denyFetch.restore();
  ctx.cleanup();
  setTaxonomyFreezeForTests(true);
});

afterEach(() => {
  resetCohortCurationFlagsOverride();
  overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
});

function cohortRunCount(workspaceId: string): number {
  const row = getDb().query(
    'SELECT COUNT(*) AS cnt FROM classification_cohort_runs WHERE workspace_id = ?',
  ).get(workspaceId) as { cnt: number };
  return Number(row.cnt);
}

function modelCallCount(): number {
  // classification_model_calls carries no workspace column; the disposable
  // DB is file-scoped, so a global before/after count is exact.
  const row = getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number };
  return Number(row.cnt);
}

describe('executeClaim input authority', () => {
  it('missing run fails without mutation', async () => {
    const curation = createCohortCuration({ workspacePath: ctx.workspacePath, workspaceId: ctx.workspaceId });
    const before = cohortRunCount(ctx.workspaceId);
    const result = await curation.executeClaim('no-such-run', 'worker-a');
    expect(result).toEqual({ executed: false, runId: 'no-such-run', disposition: 'missing-run' });
    expect(cohortRunCount(ctx.workspaceId)).toBe(before);
    expect(denyFetch.calls.length).toBe(0);
  });

  it('stale owner (including unclaimed) fails without mutation', async () => {
    createReadyCohort(ctx.workspaceId, {
      '200000000001': settledExtraction({ _name: 'Acme Anvil 5 lb' }),
    });
    const [claimed] = claimReadyCurationCohorts(ctx.workspaceId, 10, 'owner-a', 15 * 60 * 1000);
    const curation = createCohortCuration({ workspacePath: ctx.workspacePath, workspaceId: ctx.workspaceId });
    const before = modelCallCount();
    const result = await curation.executeClaim(claimed.id, 'owner-b');
    expect(result.executed).toBe(false);
    if (!result.executed) expect(result.disposition).toBe('stale-owner');
    // Untouched: still freezing under the original owner, no calls, no outputs.
    expect(getCohortRunById(claimed.id)!.status).toBe('freezing');
    expect(getCohortRunById(claimed.id)!.claimedBy).toBe('owner-a');
    expect(modelCallCount()).toBe(before);
    expect(countCohortTitleOutputs(claimed.id)).toBe(0);
    // The rightful owner can still execute afterwards.
    const retry = await curation.executeClaim(claimed.id, 'owner-a');
    expect(retry.executed).toBe(true);
  });

  it('foreign workspace binding fails without mutation', async () => {
    createReadyCohort(ctx.workspaceId, {
      '200000000002': settledExtraction({ _name: 'Acme Anvil 10 lb' }),
    });
    const [claimed] = claimReadyCurationCohorts(ctx.workspaceId, 10, 'owner-a', 15 * 60 * 1000);
    const foreign = createCohortCuration({ workspacePath: ctx.workspacePath, workspaceId: 'foreign-workspace' });
    const result = await foreign.executeClaim(claimed.id, 'owner-a');
    expect(result.executed).toBe(false);
    if (!result.executed) expect(result.disposition).toBe('workspace-mismatch');
    expect(getCohortRunById(claimed.id)!.status).toBe('freezing');
  });

  it('terminal parent is never re-executed and gains no new rows', async () => {
    createReadyCohort(ctx.workspaceId, {
      '200000000003': settledExtraction({ _name: 'Acme Wedge 5 lb' }),
    });
    const [claimed] = claimReadyCurationCohorts(ctx.workspaceId, 10, 'owner-a', 15 * 60 * 1000);
    const curation = createCohortCuration({ workspacePath: ctx.workspacePath, workspaceId: ctx.workspaceId });
    const first = await curation.executeClaim(claimed.id, 'owner-a');
    expect(first.executed).toBe(true);
    const callsBefore = modelCallCount();
    const titlesBefore = countCohortTitleOutputs(claimed.id);
    const second = await curation.executeClaim(claimed.id, 'owner-a');
    expect(second.executed).toBe(false);
    if (!second.executed) expect(second.disposition).toBe('already-terminal');
    expect(modelCallCount()).toBe(callsBefore);
    expect(countCohortTitleOutputs(claimed.id)).toBe(titlesBefore);
    expect(denyFetch.calls.length).toBe(0);
  });
});

describe('executeClaim execution paths', () => {
  it('singleton executes from freezing with member-local naming and zero durable titles', async () => {
    const { items } = createReadyCohort(ctx.workspaceId, {
      '200000000011': settledExtraction({ _name: 'Acme Solo Widget 5 lb' }),
    });
    const [claimed] = claimReadyCurationCohorts(ctx.workspaceId, 10, 'worker-s', 15 * 60 * 1000);
    const curation = createCohortCuration({ workspacePath: ctx.workspacePath, workspaceId: ctx.workspaceId });
    const result = await curation.executeClaim(claimed.id, 'worker-s');
    expect(result.executed).toBe(true);
    if (!result.executed) throw new Error('singleton did not execute');
    expect(result.summary.memberCount).toBe(1);
    // True singleton: no durable title rows; the member keeps local naming.
    expect(countCohortTitleOutputs(claimed.id)).toBe(0);
    const stored = findItemById(items[0].id)!;
    expect(stored.stageStatus).toBe('completed');
    expect(stored.curationData).not.toBeNull();
    expect(String(stored.curationData!.curatedTitle).length).toBeGreaterThan(0);
    expect(getCohortRunById(claimed.id)!.status).toBe('completed');
  });

  it('multi-member family reuses seeded titles with zero transport; pages expected-empty; members complete', async () => {
    const { items } = createReadyCohort(ctx.workspaceId, {
      '200000000021': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
      '200000000022': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
    });
    const [claimed] = claimReadyCurationCohorts(ctx.workspaceId, 10, 'worker-m', 15 * 60 * 1000);
    // Freeze through the existing implementation (characterized), seed the
    // canonical title set, then execute the running run through the seam.
    const frozen = await freezeCohortForExecution(claimed, ctx.workspacePath, ctx.workspaceId);
    expect(frozen.status).toBe('running');
    seedDeterministicTitleOutputs(ctx.workspaceId, frozen);
    const curation = createCohortCuration({ workspacePath: ctx.workspacePath, workspaceId: ctx.workspaceId });
    const result = await curation.executeClaim(frozen.id, 'worker-m');
    expect(result.executed).toBe(true);
    if (!result.executed) throw new Error('multi-member run did not execute');
    expect(result.summary.memberCount).toBe(2);
    expect(result.summary.parentStatus).toBe('completed');
    // Titles reused (still exactly the seeded set — no second coordination).
    expect(countCohortTitleOutputs(frozen.id)).toBe(2);
    // Page target disabled → expected-empty: zero rows, members still complete.
    expect(getCohortPageOutputsByRun(frozen.id)).toEqual([]);
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      expect(stored.curationData).not.toBeNull();
    }
    expect(denyFetch.calls.length).toBe(0);
  });

  it('unseeded multi-member family fails closed before any transport (no frozen plan)', async () => {
    createReadyCohort(ctx.workspaceId, {
      '200000000031': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
      '200000000032': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
    });
    const [claimed] = claimReadyCurationCohorts(ctx.workspaceId, 10, 'worker-f', 15 * 60 * 1000);
    const frozen = await freezeCohortForExecution(claimed, ctx.workspacePath, ctx.workspaceId);
    expect(frozen.status).toBe('running');
    const curation = createCohortCuration({ workspacePath: ctx.workspacePath, workspaceId: ctx.workspaceId });
    // No seeded titles and no frozen model-execution plan: the parent op
    // must fail closed BEFORE any transport — never a non-audited live call.
    await expect(curation.executeClaim(frozen.id, 'worker-f')).rejects.toThrow();
    expect(denyFetch.calls.length).toBe(0);
    expect(countCohortTitleOutputs(frozen.id)).toBe(0);
    // The run stays claimed-running for expiry recovery (no terminal write
    // on this path); nothing committed for any member.
    expect(getCohortRunById(frozen.id)!.status).toBe('running');
  });
});

// ─── Synthesis ordering guard (transferred from synthesis-ordering-guard.test.ts, Slice 5) ──
// Case-level replacement map (ledger §3): all five guard-contract cases move
// here. The per-stage omission matrix stays DIRECT guard invocations BY
// DESIGN: `runPipeline` records `stageOutputs[stageName]` unconditionally on
// every succeeded stage (pipeline-runner.ts), so a silent-success stage is
// unreachable through any real pipeline — the contract pins below plus the
// invocation-order assertion and the executed-member proof are the complete,
// honest transfer. The isolated suite is deleted in this slice.

/** Identity the production call site passes (parent run id + member SKU). */
const GUARD_IDENTITY = { runId: 'run-1', sku: 'SKU1' };

function guardStageOutput(name: string): StageOutput {
  return {
    evidence: [],
    proposals: [],
    abstained: false,
    message: `${name} succeeded`,
    metadata: { [name]: true },
  };
}

/** A fully-successful pipeline result (every required stage produced output). */
function guardCompleteResult(): PipelineRunResult {
  const stageOutputs: PipelineRunResult['stageOutputs'] = {};
  for (const stageName of COHORT_SYNTHESIS_REQUIRED_STAGES) {
    stageOutputs[stageName] = guardStageOutput(stageName);
  }
  return { evidence: [], proposals: [], stageOutputs };
}

describe('PR8 C3 — assertCohortSynthesisOrdering (DECISION-C, transferred Slice 5)', () => {
  it('passes when every required stage produced a terminal stage output', () => {
    expect(() => assertCohortSynthesisOrdering(guardCompleteResult(), GUARD_IDENTITY)).not.toThrow();
  });

  it('passes when a required stage abstained (its reviewable_abstention proposal is a terminal outcome)', () => {
    const result = guardCompleteResult();
    delete result.stageOutputs.category_page_proposals;
    result.proposals.push({
      id: 'abstention-1',
      runId: 'run-1',
      productSku: 'SKU1',
      proposalType: 'reviewable_abstention',
      targetId: 'category_page_proposals',
      proposedValue: { reason: 'stored abstained page output' },
      confidence: 0,
      evidenceIds: [],
      status: 'pending',
      isBulkAcceptable: false,
      isStale: false,
      stalenessReason: null,
      snapshotHash: null,
      createdAt: new Date().toISOString(),
    });
    expect(() => assertCohortSynthesisOrdering(result, GUARD_IDENTITY)).not.toThrow();
  });

  it('fails closed when a required stage silently produced no output (no stageOutputs entry, no abstention proposal)', () => {
    const result = guardCompleteResult();
    delete result.stageOutputs.product_attribute_proposals;
    expect(() => assertCohortSynthesisOrdering(result, GUARD_IDENTITY)).toThrow(/product_attribute_proposals/);
    expect(() => assertCohortSynthesisOrdering(result, GUARD_IDENTITY)).toThrow(/failing closed — no partial draft/);
  });

  it('fails closed when the silent stage is the draft projection itself', () => {
    const result = guardCompleteResult();
    delete result.stageOutputs.product_draft_projection;
    expect(() => assertCohortSynthesisOrdering(result, GUARD_IDENTITY)).toThrow(/product_draft_projection/);
  });

  it('PR8 review R1: the guard error carries BOTH the parent run identity and the member identity', () => {
    const result = guardCompleteResult();
    delete result.stageOutputs.evidence_extraction;
    let message = '';
    try {
      assertCohortSynthesisOrdering(result, { runId: 'parent-run-77', sku: 'SKU-ALPHA' });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('SKU-ALPHA');
    expect(message).toContain('parent-run-77');
  });

  it('the guard call precedes description/search-keyword synthesis in the shared member body', () => {
    // Invocation wiring proof: the guard must run BEFORE any synthesis
    // output can be assembled. Static position (the negative case is
    // unreachable at runtime — see header note).
    const src = readFileSync('src/onboarding/product-curator.ts', 'utf8');
    const guardAt = src.indexOf('assertCohortSynthesisOrdering(result,');
    const synthAt = src.indexOf('synthesizeSearchKeywords({');
    expect(guardAt).toBeGreaterThan(-1);
    expect(synthAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(synthAt);
  });

  it('an executed member commits synthesis outputs (the guard passed in-path before synthesis ran)', async () => {
      const { items } = createReadyCohort(ctx.workspaceId, {
        '200000000051': settledExtraction({ _name: 'Acme Synthesis Proof 5 lb' }),
      });
      const [claimed] = claimReadyCurationCohorts(ctx.workspaceId, 10, 'worker-sp', 15 * 60 * 1000);
      const curation = createCohortCuration({ workspacePath: ctx.workspacePath, workspaceId: ctx.workspaceId });
      const result = await curation.executeClaim(claimed.id, 'worker-sp');
      expect(result.executed).toBe(true);
      const stored = findItemById(items[0].id)!;
      expect(stored.stageStatus).toBe('completed');
      // Synthesis ran: keywords assembled, description key present — both
      // exist only downstream of the guard in the shared member body.
      expect(typeof stored.curationData!.searchKeywords).toBe('string');
      expect(stored.curationData!.searchKeywords!.length).toBeGreaterThan(0);
      expect('curatedDescription' in stored.curationData!).toBe(true);
      expect(denyFetch.calls.length).toBe(0);
  });
});
