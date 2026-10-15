/**
 * PR11 C1 unit tests (issue #30): the PURE promotion gate.
 *
 * The gate is deterministic over its inputs (no DB access) — every branch:
 * legacy pass; blocked refuse (first finding as reason); malformed/missing
 * semantic payload in an ACTIVE cohort child refuse `semantic_validation_unavailable`;
 * parent missing/superseded/not-completed refuses; stale type-dependency
 * (mismatch) refuses; matching dependency passes; no-dependency (universal)
 * passes; a present dependency against a MISSING effective type refuses;
 * reviewed-source member pass/mismatch.
 */
import { describe, it, expect } from 'vitest';
import { validatePromotionGate, resolvePromotionEffectiveTypeId, computeExecutionAuthorityHash, computeReviewedAuthorityHash } from '../../classification/promotion-gate';
import type { PromotionGateInput } from '../../classification/promotion-gate';
import { hashCanonicalJson } from '../../shared/stable-id';
import type { ClassificationRunRow } from '../../db/repositories/classification-run-repo';
import type { CohortRun } from '../../shared/schemas/cohorts';
import type { RuntimeClassificationSnapshot } from '../../classification/runtime-snapshot';
import type { ClassificationProposal } from '../../shared/types';
import type { CurationData } from '../../shared/schemas/onboarding';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function run(overrides: Partial<ClassificationRunRow> = {}): ClassificationRunRow {
  return {
    id: 'run-1',
    workspaceId: 'ws-1',
    onboardingItemId: 'item-1',
    sourceKind: 'onboarding',
    sourceProductHash: null,
    productSku: 'SKU-1',
    configSnapshotId: null,
    configSnapshotHash: null,
    status: 'completed',
    startedAt: '2025-01-01T00:00:00.000Z',
    completedAt: '2025-01-01T00:01:00.000Z',
    errorMessage: null,
    cohortRunId: null,
    ...overrides,
  };
}

/** A frozen snapshot carrying ONE provenance-compatible reviewed PT fact. */
function snapshotWithReviewedFact(typeId: string): RuntimeClassificationSnapshot {
  return {
    schemaVersion: 2,
    snapshotHash: 'snap-reviewed-1',
    workspaceId: 'ws-1',
    workspacePath: '/tmp/ws',
    productSku: 'SKU-1',
    createdAt: '2025-01-01T00:00:00.000Z',
    config: {} as never,
    configSnapshotRef: { id: 'x', hash: 'y', sourceCommit: null, createdAt: '2025-01-01T00:00:00.000Z' },
    modelExecutionPlan: { version: 1 as const, registryVersion: 2, entries: [], digest: 'plan-digest' },
    runtimeRuleVersions: { version: 1 as const, registryVersion: 2, promptTemplateVersions: {}, ruleVersions: {}, outputPolicyVersion: 'v1', digest: 'rules-digest' },
    modelPolicy: {} as never,
    attributeMappings: [],
    attributes: [],
    brands: [],
    reviewedFacts: [
      {
        proposalId: 'pt-proposal-1',
        decisionId: 'pt-decision-1',
        runId: 'run-1',
        workspaceId: 'ws-1',
        productSku: 'SKU-1',
        proposalType: 'product_classification',
        targetId: typeId,
        value: { categoryId: 'dog-food', productTypeId: typeId },
      },
    ],
    rules: [] as never,
  } as unknown as RuntimeClassificationSnapshot;
}

function cohortRun(overrides: Partial<CohortRun> = {}): CohortRun {
  return {
    id: 'parent-1',
    workspaceId: 'ws-1',
    cohortId: 'cohort-1',
    candidateMembershipHash: 'candidate-hash',
    finalMembershipHash: 'final-hash',
    evidenceSnapshotHash: 'evidence-hash',
    evidenceSnapshotId: null,
    configSnapshotId: null,
    configSnapshotHash: null,
    pageImportId: null,
    pageImportHash: null,
    modelPolicyDigest: null,
    executionProductTypeId: 'dog-food-dry',
    productTypeConfidence: 0.9,
    productTypeOutcome: 'coherent',
    status: 'completed',
    claimedBy: null,
    claimedAt: null,
    leaseExpiresAt: null,
    startedAt: '2025-01-01T00:00:00.000Z',
    completedAt: '2025-01-01T00:05:00.000Z',
    errorMessage: null,
    supersededAt: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function proposal(overrides: Partial<ClassificationProposal> = {}): ClassificationProposal {
  return {
    id: 'proposal-1',
    runId: 'run-1',
    productSku: 'SKU-1',
    proposalType: 'field_assignment',
    targetId: 'flavor',
    proposedValue: 'Chicken',
    confidence: 0.9,
    evidenceIds: [],
    status: 'accepted',
    isBulkAcceptable: false,
    isStale: false,
    stalenessReason: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function curationData(overrides: Partial<CurationData> = {}): CurationData {
  return {
    curatedTitle: 'Test Product',
    searchKeywords: null,
    packagingOcrTitle: null,
    curatedWeight: null,
    titleSource: 'web',
    curatedDescription: null,
    curatedDescriptionSourceAttemptIds: [],
    suggestedPages: [],
    suggestedProductType: null,
    curatedAt: '2025-01-01T00:00:00.000Z',
    curationMethod: 'auto',
    classificationRunId: 'run-1',
    classificationConfigSnapshot: null,
    classificationEvidence: [],
    classificationProposals: [],
    classificationDecisions: [],
    classificationHistory: [],
    ...overrides,
  };
}

function blockedSemanticValidation(message: string): CurationData['semanticValidation'] {
  return {
    status: 'blocked',
    findings: [{ code: 'family_brand', memberSku: 'SKU-1', message, conflictingValues: null, suggestedAction: null }],
  };
}

function passedSemanticValidation(): CurationData['semanticValidation'] {
  return { status: 'passed', findings: [] };
}

function gateInput(overrides: Partial<PromotionGateInput> = {}): PromotionGateInput {
  return {
    workspaceId: 'ws-1',
    itemId: 'item-1',
    productSku: 'SKU-1',
    curationData: curationData(),
    activeRun: run(),
    parentRun: null,
    effectiveTypeId: 'dog-food-dry',
    acceptedProposals: [],
    dependencyLookup: () => [],
    ...overrides,
  };
}

/** PR12 C2: the CURRENT authority hashes a production caller supplies. */
function authorityHashes(
  parent: CohortRun | null,
  effectiveTypeId: string | null,
): { execution: string | null; reviewed: string | null } {
  return {
    execution: computeExecutionAuthorityHash(
      parent?.executionProductTypeId ?? null,
      parent?.productTypeConfidence ?? null,
    ),
    reviewed: computeReviewedAuthorityHash(effectiveTypeId),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PR11 C1 — validatePromotionGate (pure)', () => {
  it('legacy pass: no curation data or no classification run pointer is byte-identical (no gate)', () => {
    expect(validatePromotionGate(gateInput({ curationData: null }))).toEqual({ ok: true });
    expect(
      validatePromotionGate(gateInput({ curationData: curationData({ classificationRunId: null }) })),
    ).toEqual({ ok: true });
    // A blocked semantic payload on a legacy item (no run pointer) is NOT a
    // gate input at all — legacy promotion is byte-identical.
    expect(
      validatePromotionGate(gateInput({
        curationData: curationData({
          classificationRunId: null,
          semanticValidation: blockedSemanticValidation('legacy finding'),
        }),
      })),
    ).toEqual({ ok: true });
  });

  it('refuses a blocked member with the FIRST finding as the reason', () => {
    const result = validatePromotionGate(gateInput({
      curationData: curationData({
        semanticValidation: blockedSemanticValidation('Brand conflict: blue-buffalo vs woof'),
      }),
    }));
    expect(result).toEqual({
      ok: false,
      code: 'semantic_validation_blocked',
      reason: 'Brand conflict: blue-buffalo vs woof',
    });
  });

  it('refuses a blocked member even when the parent would also be stale (first refusal wins)', () => {
    const result = validatePromotionGate(gateInput({
      curationData: curationData({
        semanticValidation: blockedSemanticValidation('coordinated_page mismatch'),
      }),
      activeRun: run({ cohortRunId: 'parent-1' }),
      parentRun: cohortRun({ status: 'superseded' }),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('semantic_validation_blocked');
  });

  it('blocked with no parseable findings falls back to the deterministic default', () => {
    const result = validatePromotionGate(gateInput({
      curationData: curationData({ semanticValidation: { status: 'blocked', findings: [] } }),
    }));
    expect(result).toEqual({
      ok: false,
      code: 'semantic_validation_blocked',
      reason: 'A hard cohort semantic validation finding blocks this item.',
    });
  });

  it('active cohort child with a MISSING semantic payload fails closed (semantic_validation_unavailable)', () => {
    const result = validatePromotionGate(gateInput({
      activeRun: run({ cohortRunId: 'parent-1' }),
      parentRun: cohortRun(),
      curationData: curationData({ semanticValidation: undefined }),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('semantic_validation_unavailable');
  });

  it('active cohort child with a MALFORMED semantic payload fails closed (semantic_validation_unavailable)', () => {
    const malformed = { status: 'banana', findings: [] } as unknown as CurationData['semanticValidation'];
    const result = validatePromotionGate(gateInput({
      activeRun: run({ cohortRunId: 'parent-1' }),
      parentRun: cohortRun(),
      curationData: curationData({ semanticValidation: malformed }),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('semantic_validation_unavailable');
  });

  it('a non-cohort run with an absent semantic payload proceeds', () => {
    const result = validatePromotionGate(gateInput({
      activeRun: run({ cohortRunId: null }),
      curationData: curationData({ semanticValidation: undefined }),
    }));
    expect(result).toEqual({ ok: true });
  });

  it('cohort child with a MISSING parent refuses parent_not_found', () => {
    const result = validatePromotionGate(gateInput({
      curationData: curationData({ semanticValidation: passedSemanticValidation() }),
      activeRun: run({ cohortRunId: 'parent-missing' }),
      parentRun: null,
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('parent_not_found');
      expect(result.reason).toContain('parent-missing');
    }
  });

  it('cohort child of a SUPERSEDED parent refuses parent_superseded (reason: parent id)', () => {
    const result = validatePromotionGate(gateInput({
      curationData: curationData({ semanticValidation: passedSemanticValidation() }),
      activeRun: run({ cohortRunId: 'parent-1' }),
      parentRun: cohortRun({ id: 'parent-1', status: 'superseded' }),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('parent_superseded');
      expect(result.reason).toContain('parent-1');
    }
  });

  it('cohort child of a NON-TERMINAL parent refuses parent_not_completed', () => {
    const result = validatePromotionGate(gateInput({
      curationData: curationData({ semanticValidation: passedSemanticValidation() }),
      activeRun: run({ cohortRunId: 'parent-1' }),
      parentRun: cohortRun({ status: 'running' }),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('parent_not_completed');
      expect(result.reason).toContain('running');
    }
  });

  it('cohort child of a completed_with_member_failures parent is terminal (passed parent gate)', () => {
    const result = validatePromotionGate(gateInput({
      curationData: curationData({ semanticValidation: passedSemanticValidation() }),
      activeRun: run({ cohortRunId: 'parent-1' }),
      parentRun: cohortRun({ status: 'completed_with_member_failures' }),
    }));
    // No parent refusal; with no type dependencies the gate passes.
    expect(result).toEqual({ ok: true });
  });

  it('refuses a STALE proposal: execution dependency target != current effective type', () => {
    const result = validatePromotionGate(gateInput({
      acceptedProposals: [proposal()],
      dependencyLookup: () => [
        { dependencyKind: 'execution_product_type', dependencyTargetId: 'dog-food-wet' },
      ],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('stale_proposal');
      expect(result.reason).toContain('proposal-1');
      expect(result.reason).toContain('execution_product_type');
      expect(result.reason).toContain('dog-food-wet');
      expect(result.reason).toContain('dog-food-dry');
    }
  });

  it('passes a MATCHING execution dependency', () => {
    const result = validatePromotionGate(gateInput({
      acceptedProposals: [proposal()],
      dependencyLookup: () => [
        { dependencyKind: 'execution_product_type', dependencyTargetId: 'dog-food-dry' },
      ],
    }));
    expect(result).toEqual({ ok: true });
  });

  it('a universal-attribute proposal (NO dependency rows) is never stale', () => {
    const result = validatePromotionGate(gateInput({
      acceptedProposals: [proposal({ id: 'brand-proposal', targetId: 'brand' })],
      dependencyLookup: () => [],
    }));
    expect(result).toEqual({ ok: true });
  });

  it('a present type-dependency against a MISSING effective type is itself stale', () => {
    const result = validatePromotionGate(gateInput({
      effectiveTypeId: null,
      acceptedProposals: [proposal()],
      dependencyLookup: () => [
        { dependencyKind: 'execution_product_type', dependencyTargetId: 'dog-food-dry' },
      ],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('stale_proposal');
  });

  // ── PR12 C2 (DECISION-A): value-hash staleness ─────────────────────────

  it('PR12: target AND execution value-hash match => pass', () => {
    const parent = cohortRun({ executionProductTypeId: 'dog-food-dry', productTypeConfidence: 0.9 });
    const hashes = authorityHashes(parent, 'dog-food-dry');
    const result = validatePromotionGate(gateInput({
      activeRun: run({ cohortRunId: 'parent-1' }),
      parentRun: parent,
      curationData: curationData({ semanticValidation: passedSemanticValidation() }),
      effectiveTypeId: 'dog-food-dry',
      acceptedProposals: [proposal()],
      dependencyLookup: () => [
        {
          dependencyKind: 'execution_product_type',
          dependencyTargetId: 'dog-food-dry',
          dependencyValueHash: hashes.execution!,
        },
      ],
      currentAuthorityHashes: hashes,
    }));
    expect(result).toEqual({ ok: true });
  });

  it('PR12: target match + execution confidence drift => stale (value hash distinguishes from target)', () => {
    const parent = cohortRun({ executionProductTypeId: 'dog-food-dry', productTypeConfidence: 0.9 });
    const hashes = authorityHashes(parent, 'dog-food-dry');
    // The stamped hash was created under the OLD confidence (0.8) while the
    // CURRENT parent run carries 0.9 — the same target id, a drifted value.
    const stampedUnderOldConfidence = computeExecutionAuthorityHash('dog-food-dry', 0.8)!;
    expect(stampedUnderOldConfidence).not.toBe(hashes.execution);
    const result = validatePromotionGate(gateInput({
      activeRun: run({ cohortRunId: 'parent-1' }),
      parentRun: parent,
      curationData: curationData({ semanticValidation: passedSemanticValidation() }),
      effectiveTypeId: 'dog-food-dry',
      acceptedProposals: [proposal()],
      dependencyLookup: () => [
        {
          dependencyKind: 'execution_product_type',
          dependencyTargetId: 'dog-food-dry',
          dependencyValueHash: stampedUnderOldConfidence,
        },
      ],
      currentAuthorityHashes: hashes,
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('stale_proposal');
      expect(result.reason).toContain('value hash');
      expect(result.reason).toContain('execution_product_type');
      expect(result.reason).toContain('(execution)');
    }
  });

  it('PR12: reviewed-kind hash mismatch (same target) => stale', () => {
    const hashes = authorityHashes(null, 'cat-food-wet');
    const result = validatePromotionGate(gateInput({
      effectiveTypeId: 'cat-food-wet',
      acceptedProposals: [proposal()],
      dependencyLookup: () => [
        {
          dependencyKind: 'reviewed_product_type',
          dependencyTargetId: 'cat-food-wet',
          dependencyValueHash: computeReviewedAuthorityHash('dog-food-dry')!,
        },
      ],
      currentAuthorityHashes: hashes,
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('stale_proposal');
      expect(result.reason).toContain('value hash');
      expect(result.reason).toContain('reviewed_product_type');
      expect(result.reason).toContain('(reviewed)');
    }
  });

  it('PR12: null authority hash => any stamped (non-null) hash is stale', () => {
    const result = validatePromotionGate(gateInput({
      effectiveTypeId: 'dog-food-dry',
      acceptedProposals: [proposal()],
      dependencyLookup: () => [
        {
          dependencyKind: 'execution_product_type',
          dependencyTargetId: 'dog-food-dry',
          dependencyValueHash: 'stamped-hash',
        },
      ],
      currentAuthorityHashes: { execution: null, reviewed: computeReviewedAuthorityHash('dog-food-dry') },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('stale_proposal');
      expect(result.reason).toContain('value hash');
      expect(result.reason).toContain('stamped-hash');
    }
  });

  it('PR12: absent currentAuthorityHashes keeps the pre-PR12 target-only behavior (dependency rows without a stamped hash pass on target match)', () => {
    const result = validatePromotionGate(gateInput({
      effectiveTypeId: 'dog-food-dry',
      acceptedProposals: [proposal()],
      dependencyLookup: () => [
        { dependencyKind: 'execution_product_type', dependencyTargetId: 'dog-food-dry' },
      ],
    }));
    expect(result).toEqual({ ok: true });
  });

  it('reviewed-source member: MATCHING reviewed_product_type dependency passes', () => {
    const result = validatePromotionGate(gateInput({
      effectiveTypeId: 'cat-food-wet',
      acceptedProposals: [proposal()],
      dependencyLookup: () => [
        {
          dependencyKind: 'reviewed_product_type',
          dependencyTargetId: 'cat-food-wet',
          dependencyValueHash: computeReviewedAuthorityHash('cat-food-wet')!,
        },
      ],
      currentAuthorityHashes: authorityHashes(null, 'cat-food-wet'),
    }));
    expect(result).toEqual({ ok: true });
  });

  it('reviewed-source member: MISMATCHED reviewed_product_type dependency refuses stale_proposal', () => {
    const result = validatePromotionGate(gateInput({
      effectiveTypeId: 'cat-food-wet',
      acceptedProposals: [proposal()],
      dependencyLookup: () => [
        { dependencyKind: 'reviewed_product_type', dependencyTargetId: 'dog-food-dry' },
      ],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('stale_proposal');
      expect(result.reason).toContain('reviewed_product_type');
    }
  });

  it('non-type dependency kinds are ignored', () => {
    const result = validatePromotionGate(gateInput({
      acceptedProposals: [proposal()],
      dependencyLookup: () => [
        { dependencyKind: 'some_other_kind', dependencyTargetId: 'dog-food-wet' },
      ],
    }));
    expect(result).toEqual({ ok: true });
  });

  it('refuses stale_proposal as soon as ANY accepted proposal is stale', () => {
    const result = validatePromotionGate(gateInput({
      acceptedProposals: [proposal({ id: 'universal-brand' }), proposal({ id: 'stale-flavor' })],
      dependencyLookup: proposalId =>
        proposalId === 'stale-flavor'
          ? [{ dependencyKind: 'execution_product_type', dependencyTargetId: 'dog-food-wet' }]
          : [],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('stale_proposal');
      expect(result.reason).toContain('stale-flavor');
    }
  });

  it('defensive: a present run pointer with an unresolved active run fails closed', () => {
    const result = validatePromotionGate(gateInput({ activeRun: null }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('semantic_validation_unavailable');
  });

  // ── PR11 review R1 (P1-B): independent terminal authority ───────────────

  it('R1: a NON-TERMINAL child run is refused (run_not_completed) even when semantic + parent checks would pass', () => {
    const result = validatePromotionGate(gateInput({
      activeRun: run({ status: 'running', cohortRunId: 'parent-1' }),
      parentRun: cohortRun(),
      curationData: curationData({ semanticValidation: { status: 'passed', findings: [] } }),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('run_not_completed');
      expect(result.reason).toContain('running');
    }
  });

  it('R1: a cross-workspace parent is refused (workspace_mismatch) — never this item\'s authority', () => {
    const result = validatePromotionGate(gateInput({
      activeRun: run({ cohortRunId: 'parent-1' }),
      parentRun: cohortRun({ workspaceId: 'ws-OTHER' }),
      curationData: curationData({ semanticValidation: { status: 'passed', findings: [] } }),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('workspace_mismatch');
      expect(result.reason).toContain('ws-OTHER');
    }
  });

  it('R1: a completed child with a same-workspace terminal parent still passes the authority checks (regression guard)', () => {
    const result = validatePromotionGate(gateInput({
      activeRun: run({ cohortRunId: 'parent-1' }),
      parentRun: cohortRun(),
      curationData: curationData({ semanticValidation: { status: 'passed', findings: [] } }),
      effectiveTypeId: 'dog-food-dry', // a reviewed authority exists
    }));
    // No authority refusal — the gate continues to the stale checks.
    expect(result.ok).toBe(true);
  });

  // ── PR11 review R2 (P1): Reviewed Product Type authority completeness ────

  it('R2: an active cohort child with NO reviewed type is REFUSED (reviewed_product_type_required) — even with a matching execution dependency', () => {
    const result = validatePromotionGate(gateInput({
      activeRun: run({ cohortRunId: 'parent-1' }),
      parentRun: cohortRun(),
      curationData: curationData({ semanticValidation: { status: 'passed', findings: [] } }),
      effectiveTypeId: null, // no in-run decision, no frozen fact
      acceptedProposals: [proposal({ proposalType: 'field_assignment', targetId: 'flavor' })],
      dependencyLookup: () => [
        { dependencyKind: 'execution_product_type', dependencyTargetId: 'dog-food-dry' },
      ],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('reviewed_product_type_required');
  });

  it('R2: snapshot-reviewed wet + reviewed_product_type dependency wet => PASS', () => {
    const parent = cohortRun({ executionProductTypeId: 'dry-dog-food' });
    const result = validatePromotionGate(gateInput({
      activeRun: run({ cohortRunId: 'parent-1' }),
      parentRun: parent,
      curationData: curationData({ semanticValidation: { status: 'passed', findings: [] } }),
      effectiveTypeId: 'wet-dog-food', // resolved from the frozen reviewed fact
      acceptedProposals: [proposal({ proposalType: 'field_assignment', targetId: 'flavor' })],
      dependencyLookup: () => [
        {
          dependencyKind: 'reviewed_product_type',
          dependencyTargetId: 'wet-dog-food',
          dependencyValueHash: computeReviewedAuthorityHash('wet-dog-food')!,
        },
      ],
      currentAuthorityHashes: authorityHashes(parent, 'wet-dog-food'),
    }));
    expect(result.ok).toBe(true);
  });

  it('R2: snapshot-reviewed wet + execution_product_type dependency dry => STALE', () => {
    const result = validatePromotionGate(gateInput({
      activeRun: run({ cohortRunId: 'parent-1' }),
      parentRun: cohortRun({ executionProductTypeId: 'dry-dog-food' }),
      curationData: curationData({ semanticValidation: { status: 'passed', findings: [] } }),
      effectiveTypeId: 'wet-dog-food', // resolved from the frozen reviewed fact
      acceptedProposals: [proposal({ proposalType: 'field_assignment', targetId: 'flavor' })],
      dependencyLookup: () => [
        { dependencyKind: 'execution_product_type', dependencyTargetId: 'dog-food-dry' },
      ],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('stale_proposal');
      expect(result.reason).toContain('wet-dog-food');
    }
  });

  // ── e09 B3 (P11): Category Page currentness against the ACTIVE verified import ──

  it('refuses an accepted category_page proposal whose identity is NOT in the verified set (stale_page_assignment)', () => {
    const result = validatePromotionGate(gateInput({
      acceptedProposals: [proposal({
        id: 'page-proposal-1',
        proposalType: 'category_page',
        targetId: 'page-bogus',
        proposedValue: { pageId: 'page-bogus', pageName: 'Bogus Page' },
      })],
      dependencyLookup: () => [],
      verifiedPageIds: new Set(['page-verified-1']),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('stale_page_assignment');
      expect(result.reason).toContain('page-bogus');
      expect(result.reason).toContain('P11');
    }
  });

  it('refuses a NAME-ONLY accepted category_page proposal (no verifiable identity, P2/P12)', () => {
    const result = validatePromotionGate(gateInput({
      acceptedProposals: [proposal({
        id: 'page-name-only',
        proposalType: 'category_page',
        targetId: null,
        proposedValue: 'Legacy Page Name',
      })],
      dependencyLookup: () => [],
      verifiedPageIds: new Set(['page-verified-1']),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('stale_page_assignment');
      expect(result.reason).toContain('name-only');
    }
  });

  it('passes when every accepted category_page identity resolves into the verified set', () => {
    const result = validatePromotionGate(gateInput({
      acceptedProposals: [proposal({
        id: 'page-proposal-ok',
        proposalType: 'category_page',
        targetId: 'page-verified-1',
        proposedValue: { pageId: 'page-verified-1', pageName: 'Verified Page' },
      })],
      dependencyLookup: () => [],
      verifiedPageIds: new Set(['page-verified-1', 'page-verified-2']),
    }));
    expect(result).toEqual({ ok: true });
  });

  it('skips the page-currentness check when the caller supplies no verified set (synthetic callers unchanged)', () => {
    const result = validatePromotionGate(gateInput({
      acceptedProposals: [proposal({
        id: 'page-proposal-bogus',
        proposalType: 'category_page',
        targetId: 'page-bogus',
        proposedValue: { pageId: 'page-bogus', pageName: 'Bogus Page' },
      })],
      dependencyLookup: () => [],
    }));
    expect(result).toEqual({ ok: true });
  });

  // ── PR12 C1 (issue #30): recompute the CURRENT execution-kind authority ──
});

describe('PR12 C1 — pure authority-hash recomputation helpers (issue #30)', () => {
  it('computeExecutionAuthorityHash mirrors the stamped shape for identical inputs', () => {
    const helper = computeExecutionAuthorityHash('dog-food-dry', 0.9);
    const stamped = hashCanonicalJson({ executionProductTypeId: 'dog-food-dry', productTypeConfidence: 0.9 });
    expect(helper).toBe(stamped);
    expect(helper).toMatch(/^[a-f0-9]{64}$/);
    // Deterministic across calls.
    expect(computeExecutionAuthorityHash('dog-food-dry', 0.9)).toBe(stamped);
  });

  it('computeReviewedAuthorityHash mirrors the stamped shape for identical inputs', () => {
    const helper = computeReviewedAuthorityHash('cat-food-wet');
    const stamped = hashCanonicalJson({ reviewedProductTypeId: 'cat-food-wet' });
    expect(helper).toBe(stamped);
    expect(helper).toMatch(/^[a-f0-9]{64}$/);
    expect(computeReviewedAuthorityHash('cat-food-wet')).toBe(stamped);
  });

  it('a confidence drift changes the execution hash (same target id)', () => {
    expect(computeExecutionAuthorityHash('dog-food-dry', 0.9)).not.toBe(
      computeExecutionAuthorityHash('dog-food-dry', 0.8),
    );
    expect(computeExecutionAuthorityHash('dog-food-dry', 0.9)).not.toBe(
      computeExecutionAuthorityHash('dog-food-wet', 0.9),
    );
  });

  it('null handling: a null execution/reviewed id yields null (never a matchable hash)', () => {
    expect(computeExecutionAuthorityHash(null, 0.9)).toBeNull();
    expect(computeExecutionAuthorityHash(null, null)).toBeNull();
    expect(computeReviewedAuthorityHash(null)).toBeNull();
    // A non-null id with a null confidence still hashes (confidence is part
    // of the tuple only when the id exists).
    expect(computeExecutionAuthorityHash('dog-food-dry', null)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('PR11 C1 — resolvePromotionEffectiveTypeId (reviewed-first, PR11 review R1 P1-A + R2)', () => {
  it('cohort child with NO reviewed type: the resolver returns null — the gate refuses (reviewed_product_type_required); Execution Type is Curation-only', () => {
    expect(resolvePromotionEffectiveTypeId(cohortRun(), [proposal()], null)).toBeNull();
    expect(resolvePromotionEffectiveTypeId(cohortRun({ executionProductTypeId: null }), [], null)).toBeNull();
  });

  it('cohort child WITH an accepted reviewed type: REVIEWED wins even when the Execution Type differs (PR5 precedence — the flipped authority test)', () => {
    expect(
      resolvePromotionEffectiveTypeId(cohortRun(), [
        proposal({ proposalType: 'product_classification', targetId: 'dog-food-dry' }),
      ], null),
    ).toBe('dog-food-dry');
    // The reviewer-revised type is the promotion authority over the frozen
    // execution type — the exact inversion the R1 P1-A blocker described.
    expect(
      resolvePromotionEffectiveTypeId(cohortRun(), [
        proposal({
          proposalType: 'product_classification',
          targetId: 'dry-dog-food',
          hasRevisedTargetId: true,
          revisedTargetId: 'wet-dog-food',
        }),
      ], null),
    ).toBe('wet-dog-food');
    expect(
      resolvePromotionEffectiveTypeId(cohortRun({ executionProductTypeId: 'dry-dog-food' }), [
        proposal({ proposalType: 'product_classification', targetId: 'wet-dog-food' }),
      ], null),
    ).toBe('wet-dog-food');
  });

  it('R2: a FROZEN-SNAPSHOT reviewed fact is the reviewed authority when no in-run decision exists (PR5 second source)', () => {
    const snapshot = snapshotWithReviewedFact('wet-dog-food');
    expect(resolvePromotionEffectiveTypeId(cohortRun({ executionProductTypeId: 'dry-dog-food' }), [], snapshot)).toBe('wet-dog-food');
  });

  it('R2: an in-run accepted/revised decision OVERRIDES an older snapshot reviewed fact', () => {
    const snapshot = snapshotWithReviewedFact('wet-dog-food');
    expect(
      resolvePromotionEffectiveTypeId(cohortRun(), [
        proposal({ proposalType: 'product_classification', targetId: 'dry-dog-food' }),
      ], snapshot),
    ).toBe('dry-dog-food');
  });

  it('R3: an EXPLICIT in-run CLEAR (hasRevisedTargetId=true, revisedTargetId=null) SUPPRESSES the snapshot fallback — the old reviewed authority is never resurrected', () => {
    const snapshot = snapshotWithReviewedFact('dry-dog-food');
    // The in-run decision is present by presence, its effective identity is
    // explicitly null (a reviewer clearing the type). The resolver must
    // return null — NOT the frozen fact.
    expect(
      resolvePromotionEffectiveTypeId(cohortRun(), [
        proposal({
          proposalType: 'product_classification',
          targetId: 'dry-dog-food',
          hasRevisedTargetId: true,
          revisedTargetId: null,
        }),
      ], snapshot),
    ).toBeNull();
    // No in-run decision at all + snapshot fact => still the snapshot fact.
    expect(
      resolvePromotionEffectiveTypeId(cohortRun(), [], snapshot),
    ).toBe('dry-dog-food');
  });

  it('non-cohort member: the live accepted primary_product_type proposal target is the reviewed truth', () => {
    expect(
      resolvePromotionEffectiveTypeId(null, [
        proposal({ proposalType: 'product_classification', targetId: 'dog-food-dry' }),
      ]),
    ).toBe('dog-food-dry');
  });

  it('non-cohort member: a reviewer-corrected type target wins over the prediction', () => {
    expect(
      resolvePromotionEffectiveTypeId(null, [
        proposal({
          proposalType: 'product_classification',
          targetId: 'dog-food-dry',
          hasRevisedTargetId: true,
          revisedTargetId: 'cat-food-wet',
        }),
      ]),
    ).toBe('cat-food-wet');
  });

  it('non-cohort member with no type proposal resolves to none', () => {
    expect(resolvePromotionEffectiveTypeId(null, [proposal({ proposalType: 'field_assignment' })])).toBeNull();
  });
});
