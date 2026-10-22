import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import { createWorkspaceDirs, writeProductFile, readProductFile } from '../../git/workspace-files';
import { GitClient } from '../../git/git-client';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { approveChangeSet, loadApprovedLinkedExport } from '../../server/services/change-set-service';
import { stageNativeAdoption, applyAdoptedFamilyPlan, type AdoptionEvidence } from '../../classification/storefront-family-adoption';
import { decideStorefrontFamilyPlan } from '../../classification/storefront-family-plan-service';
import {
  freezeProposalAnchors,
  hashProposalAnchors,
  hashProposalEvidence,
  hashProposalRules,
  interpretAnchorChoice,
  proposeFamilyMembership,
  resolveProposalDisposition,
  checkTransitiveSafety,
  FAMILY_MEMBERSHIP_ANCHOR_LIMIT,
  type FamilyMembershipAnchorInput,
  type FamilyMembershipAnchorJudgment,
  type IncomingMembershipEvidence,
  type ProposalLiveBinding,
} from '../../classification/family-membership-proposal';
import {
  buildImportedJoinQuery,
  stageFamilyJoin,
  reviewFamilyJoin,
  decideFamilyJoin,
  applyFamilyJoin,
  type JoinMemberEvidence,
} from '../../classification/storefront-family-join';
import {
  createFamilyMembershipProposal,
  findFamilyMembershipProposalById,
  findReusableFamilyMembershipProposal,
  decideFamilyMembershipProposal,
  markFamilyMembershipProposalStale,
  markProposalsStaleForSkus,
} from '../../db/repositories/family-membership-proposal-repo';
import { findStorefrontFamilyPlanById, parseStorefrontFamilyPlan } from '../../db/repositories/storefront-family-plan-repo';
import { createRun } from '../../db/repositories/classification-run-repo';
import { upsertProviderConnection } from '../../db/repositories/provider-connection-repo';
import type { ProviderConnection } from '../../ai/provider-connections';
import { buildModelPolicyView } from '../../classification/model-policy-gateway';
import type { Product } from '../../shared/types';
import { approveFamilyCatalogProduct } from './family-authority';
import { computeReviewedAuthorityHash } from '../../classification/promotion-gate';

// Behavioral coverage for issue #371: TypeSafe ambiguous family membership.
// Pure gates first (no workspace), then repo lifecycle, then an isolated
// proposal → review → acceptance → export smoke through applyFamilyJoin →
// approval → export. The model never writes: every acceptance below passes
// through the unchanged complete plan gates.

function anchorInput(sku: string, familyPlanId: string | null, overrides?: Partial<FamilyMembershipAnchorInput>): FamilyMembershipAnchorInput {
  return {
    anchor: {
      sku,
      familyPlanId,
      familyMain: 'FAM-5',
      familyOrder: ['FAM-5', sku],
      familyRuleVersion: 'food-family-variant-rule-v1',
      normalizedSku: sku.toLowerCase(),
      sourceIdentifiers: [],
      blockingBrand: 'acme',
      blockingTypeId: '',
      blockingRule: 'food-family-variant-rule-v1',
      nameStem: 'acme chicken dinner',
      nameTokens: ['acme', 'chicken', 'dinner'],
      model: null,
      sameSkuConflict: false,
      duplicateTuple: false,
      origin: 'managed_plan',
    },
    candidate: {
      sku,
      familyPlanId,
      familyMain: 'FAM-5',
      familyOrder: ['FAM-5', sku],
      familyRuleVersion: 'food-family-variant-rule-v1',
      signals: ['name_model_evidence', 'stem_corroboration'],
      matchedOn: ['acme'],
    },
    reviewedIdentity: `family plan · main FAM-5 · members FAM-5, FAM-15 · rule food-family-variant-rule-v1`,
    ruleVersion: 'food-family-variant-rule-v1',
    ruleIdentity: 'approved family',
    evidence: ['name_model_evidence'],
    hardInvariants: 'brand, recipe, flavor, species, lifeStage, form must agree across every member (missing is unknown, never equal)',
    memberTuples: 'FAM-5:80oz, FAM-15:240oz',
    ...overrides,
  };
}

function judgment(anchorSku: string, familyPlanId: string | null, outcome: FamilyMembershipAnchorJudgment['outcome']): FamilyMembershipAnchorJudgment {
  const verdict = outcome === 'selected' ? 'same_permitted_family'
    : outcome === 'same_sku' ? 'same_sellable_sku'
    : outcome === 'negative' ? 'different_product'
    : outcome === 'insufficient' ? 'insufficient_evidence' : null;
  return {
    anchorSku, familyPlanId, verdict, outcome,
    rawChoice: outcome === 'service' ? 'out-of-set' : outcome,
    selectedProbability: outcome === 'selected' ? 0.9 : outcome === 'service' ? null : 0.1,
    vendorConfidence: null,
    distribution: {},
    reason: `${outcome} for ${anchorSku}`,
  };
}
function testLiveBinding(sku = 'FAM-30'): ProposalLiveBinding {
  return {
    sku, evidenceHash: `evidence-${sku}`, typeHash: 'reviewed-type-v1',
    ruleVersion: 'food-family-variant-rule-v1', memberEvidence: [], revisions: [null], primaryRevision: null,
  };
}

function testIncomingState(sku = 'FAM-30'): IncomingMembershipEvidence {
  return {
    sku, evidenceHash: `evidence-${sku}`, typeHash: 'reviewed-type-v1',
    ruleVersion: 'food-family-variant-rule-v1',
    brand: 'Acme', recipe: 'Chicken Dinner', flavor: 'Chicken', species: 'Dog',
    lifeStage: 'Adult', form: 'Dry Kibble',
    model: null, material: null, function: null, safetyDose: null, strength: null, fit: null,
    sizeRaw: '30 lb', ounces: 480, retailUnit: null, colorRaw: null, countRaw: null, countQuantity: null,
    invariants: { brand: 'Acme', recipe: 'Chicken Dinner', flavor: 'Chicken', species: 'Dog', lifeStage: 'Adult', form: 'Dry Kibble' },
    tuple: 'food|480|',
  };
}


describe('family membership proposal gates (issue #371)', () => {
  it('freezes true size variants up to the bound and refuses overflow explicitly', () => {
    const one = freezeProposalAnchors('FAM-30', [anchorInput('FAM-5', 'fam-a')]);
    expect(one.frozen).toHaveLength(1);
    expect(one.overflow).toBe(false);
    const full = freezeProposalAnchors('FAM-30', Array.from({ length: FAMILY_MEMBERSHIP_ANCHOR_LIMIT }, (_, i) => anchorInput(`A-${i}`, 'fam-a')));
    expect(full.frozen).toHaveLength(FAMILY_MEMBERSHIP_ANCHOR_LIMIT);
    expect(() => freezeProposalAnchors(
      'FAM-30',
      Array.from({ length: FAMILY_MEMBERSHIP_ANCHOR_LIMIT + 1 }, (_, i) => anchorInput(`A-${i}`, 'fam-a')),
    )).toThrow(/overflow/);
  });
  it('hashes identical live state identically across repeated canonical bindings (all family revisions bound)', () => {
    // Canonical binding regression: the same anchor inputs + incoming
    // evidence + every touched family revision always hash identically —
    // creation, reuse, and freshness reuse one construction, so a fresh
    // proposal never refuses itself as stale.
    const anchors = [anchorInput('FAM-5', 'fam-a'), anchorInput('FAM-9', 'fam-b')];
    const binding = {
      evidenceHash: 'evidence-FAM-30', typeHash: 'reviewed-type-v1',
      ruleVersion: 'food-family-variant-rule-v1' as const, revision: 3, revisions: [3, 7],
    };
    const anchorBinding = { sku: 'FAM-30', ...binding };
    const ruleBinding = { ruleVersion: binding.ruleVersion, revision: binding.revision, revisions: binding.revisions };
    expect(hashProposalEvidence(anchors, binding)).toBe(hashProposalEvidence(anchors, { ...binding }));
    expect(hashProposalAnchors(anchors, anchorBinding)).toBe(hashProposalAnchors(anchors, { ...anchorBinding }));
    expect(hashProposalRules(anchors, 'policy-digest', ruleBinding)).toBe(hashProposalRules(anchors, 'policy-digest', { ...ruleBinding }));
    // Any touched family's revision moves the binding: member
    // additions/removals or re-staging refuse at decide/stage.
    expect(hashProposalEvidence(anchors, { ...binding, revisions: [3, 8] })).not.toBe(hashProposalEvidence(anchors, binding));
    expect(hashProposalAnchors(anchors, { ...anchorBinding, revision: 4, revisions: [4, 7] })).not.toBe(hashProposalAnchors(anchors, anchorBinding));
  });

  it('refuses duplicate anchors and unknown invariants (missing never means equal)', () => {
    expect(() => freezeProposalAnchors('FAM-30', [anchorInput('FAM-5', 'fam-a'), anchorInput('FAM-5', 'fam-a')]))
      .toThrow(/duplicate_anchor/);
    expect(() => freezeProposalAnchors('FAM-30', [anchorInput('FAM-5', 'fam-a', { hardInvariants: '  ' })]))
      .toThrow(/missing_invariants/);
    expect(() => freezeProposalAnchors('FAM-30', [anchorInput('FAM-5', 'fam-a', { reviewedIdentity: '' })]))
      .toThrow(/missing_identity/);
  });

  it('interprets the closed-set relationship choice (same-SKU never merges)', () => {
    const anchor = anchorInput('FAM-5', 'fam-a');
    const probs = { same_sellable_sku: 0.02, same_permitted_family: 0.9, different_product: 0.05, insufficient_evidence: 0.03 };
    const selected = interpretAnchorChoice({ anchor, choice: 'same_permitted_family', probabilities: probs, confidence: 0.9 });
    expect(selected.outcome).toBe('selected');
    const sku = interpretAnchorChoice({ anchor, choice: 'same_sellable_sku', probabilities: probs, confidence: 0.9 });
    expect(sku.outcome).toBe('same_sku');
    const negative = interpretAnchorChoice({ anchor, choice: 'different_product', probabilities: probs, confidence: 0.9 });
    expect(negative.outcome).toBe('negative');
    const thin = interpretAnchorChoice({ anchor, choice: 'insufficient_evidence', probabilities: probs, confidence: 0.4 });
    expect(thin.outcome).toBe('insufficient');
    // Sub-floor permitted-family probability degrades to insufficient, never a merge.
    const weak = interpretAnchorChoice({
      anchor, choice: 'same_permitted_family',
      probabilities: { ...probs, same_permitted_family: 0.01 }, confidence: 0.9,
    });
    expect(weak.outcome).toBe('insufficient');
  });

  it('fails service closed on out-of-set model output (never coerced to membership)', () => {
    const anchor = anchorInput('FAM-5', 'fam-a');
    const judged = interpretAnchorChoice({
      anchor, choice: 'same_family_maybe', probabilities: { same_permitted_family: 0.99 }, confidence: 0.9,
    });
    expect(judged.outcome).toBe('service');
    expect(judged.verdict).toBeNull();
  });

  it('requires explicit conflict resolution across competing families', () => {
    const solo = resolveProposalDisposition([judgment('FAM-5', 'fam-a', 'selected'), judgment('FAM-9', 'fam-a', 'negative')]);
    expect(solo.conflicts).toBe(false);
    expect(solo.positives).toHaveLength(1);
    expect(solo.sameSku).toHaveLength(0);
    const competing = resolveProposalDisposition([judgment('FAM-5', 'fam-a', 'selected'), judgment('OTH-1', 'fam-b', 'selected')]);
    expect(competing.conflicts).toBe(true);
    expect(competing.reason).toMatch(/never merge/);
    const sku = resolveProposalDisposition([judgment('FAM-5', 'fam-a', 'same_sku')]);
    expect(sku.sameSku).toHaveLength(1);
    expect(sku.positives).toHaveLength(0);
  });

  it('never merges incompatible endpoints across a transitive bridge', () => {
    const positives = [judgment('FAM-5', 'fam-a', 'selected'), judgment('FAM-15', 'fam-a', 'selected')];
    const safe = checkTransitiveSafety({
      positives,
      invariantOf: () => ({ brand: 'Acme', flavor: 'Chicken', recipe: 'Chicken Dinner' }),
    });
    expect(safe.safe).toBe(true);
    // Same-flavor different recipe/form/life-stage: endpoint invariants disagree.
    const bridged = checkTransitiveSafety({
      positives,
      invariantOf: (sku) => sku === 'FAM-5'
        ? { brand: 'Acme', flavor: 'Chicken', recipe: 'Chicken Dinner' }
        : { brand: 'Acme', flavor: 'Chicken', recipe: 'Beef Dinner' },
    });
    expect(bridged.safe).toBe(false);
    expect(bridged.reason).toMatch(/Transitive union refused/);
    expect(checkTransitiveSafety({ positives: [positives[0]!], invariantOf: () => ({}) }).safe).toBe(true);
  });

  it('records refusals as unresolved audit rows that never replay (regression: no cached failure reuse)', () => {
    const { workspaceId } = setupProposalWorkspace();
    const mk = (outcome: 'disabled' | 'overflow' | 'service' | 'no_fit' | 'insufficient') =>
      createFamilyMembershipProposal({
        workspaceId, sku: 'FAM-30', outcome, judgments: [judgment('FAM-5', 'fam-a', outcome === 'disabled' || outcome === 'service' ? 'service' : outcome)],
        rawJudgments: [], modelCallIds: [], evidenceHash: 'eh', ruleHash: 'rh', anchorHash: 'ah',
        modelPolicyDigest: 'pd', ruleVersion: 'food-family-variant-rule-v1', promptTemplateVersion: 'v1',
      });
    for (const outcome of ['disabled', 'overflow', 'service', 'no_fit', 'insufficient'] as const) {
      const row = mk(outcome);
      expect(row.status).toBe('unresolved');
    }
    const pin = { workspaceId, sku: 'FAM-30', evidenceHash: 'eh', anchorHash: 'ah', modelPolicyDigest: 'pd', ruleHash: 'rh' };
    expect(findReusableFamilyMembershipProposal(pin)).toBeNull();
    const refused = mk('disabled');
    expect(() => decideFamilyMembershipProposal({ id: refused.id, actor: 'op', action: 'accept' }))
      .toThrow(/unresolved/);
  });

  it('never persists negatives as live rows: recorded refusals stay unresolved and excluded from reuse', () => {
    const { workspaceId } = setupProposalWorkspace();
    const negative = createFamilyMembershipProposal({
      workspaceId, sku: 'FAM-30', outcome: 'negative', judgments: [judgment('FAM-5', 'fam-a', 'negative')],
      rawJudgments: [], modelCallIds: ['call-neg'], evidenceHash: 'eh', ruleHash: 'rh', anchorHash: 'ah',
      modelPolicyDigest: 'pd', ruleVersion: 'food-family-variant-rule-v1', promptTemplateVersion: 'v1',
    });
    expect(negative.status).toBe('unresolved');
    expect(findReusableFamilyMembershipProposal({ workspaceId, sku: 'FAM-30', evidenceHash: 'eh', anchorHash: 'ah', modelPolicyDigest: 'pd', ruleHash: 'rh' })).toBeNull();
    expect(() => decideFamilyMembershipProposal({ id: negative.id, actor: 'op', action: 'accept' }))
      .toThrow(/unresolved/);
  });

  it('marks live proposals stale when touched SKUs mutate (incoming or anchor side)', () => {
    const { workspaceId } = setupProposalWorkspace();
    const live = createFamilyMembershipProposal({
      workspaceId, sku: 'FAM-30', outcome: 'selected', judgments: [judgment('FAM-5', 'fam-a', 'selected')],
      rawJudgments: [], modelCallIds: ['call-1'], evidenceHash: 'eh', ruleHash: 'rh', anchorHash: 'ah',
      modelPolicyDigest: 'pd', ruleVersion: 'food-family-variant-rule-v1', promptTemplateVersion: 'v1',
    });
    expect(markProposalsStaleForSkus(workspaceId, ['FAM-5'])).toBe(1);
    expect(findFamilyMembershipProposalById(live.id)?.status).toBe('stale');
    expect(findReusableFamilyMembershipProposal({ workspaceId, sku: 'FAM-30', evidenceHash: 'eh', anchorHash: 'ah', modelPolicyDigest: 'pd', ruleHash: 'rh' })).toBeNull();
  });

  it('refuses decisions against drifted hashes (fail closed without pre-marking)', () => {
    const { workspaceId } = setupProposalWorkspace();
    const row = createFamilyMembershipProposal({
      workspaceId, sku: 'FAM-30', outcome: 'selected', judgments: [judgment('FAM-5', 'fam-a', 'selected')],
      rawJudgments: [], modelCallIds: ['call-1'], evidenceHash: 'eh', ruleHash: 'rh', anchorHash: 'ah',
      modelPolicyDigest: 'pd', ruleVersion: 'food-family-variant-rule-v1', promptTemplateVersion: 'v1',
    });
    expect(() => decideFamilyMembershipProposal({
      id: row.id, actor: 'op', action: 'accept',
      current: { evidenceHash: 'changed', anchorHash: 'ah', ruleHash: 'rh', modelPolicyDigest: 'pd' },
    })).toThrow(/stale/);
    const decided = decideFamilyMembershipProposal({
      id: row.id, actor: 'op', action: 'accept',
      current: { evidenceHash: 'eh', anchorHash: 'ah', ruleHash: 'rh', modelPolicyDigest: 'pd' },
    });
    expect(decided.status).toBe('accepted');
  });

  it('reports no-fit on empty discovery and overflow on excess anchors without dispatching', async () => {
    const query = buildImportedJoinQuery({ sku: 'FAM-30', brand: 'Acme', name: 'Acme Chicken Dinner 30 lb' });
    const empty = await proposeFamilyMembership({ sku: 'FAM-30', query, anchors: [], runId: 'run-test', modelPolicy: null, liveBinding: testLiveBinding(), incomingState: testIncomingState() });
    expect(empty.outcome).toBe('no_fit');
    expect(empty.modelCallIds).toEqual([]);
    const tooMany = await proposeFamilyMembership({
      sku: 'FAM-30', query,
      anchors: Array.from({ length: FAMILY_MEMBERSHIP_ANCHOR_LIMIT + 1 }, (_, i) => anchorInput(`A-${i}`, 'fam-a')),
      runId: 'run-test', modelPolicy: null, liveBinding: testLiveBinding(), incomingState: testIncomingState(),
    });
    expect(tooMany.outcome).toBe('overflow');
    expect(tooMany.overflow).toBe(true);
    expect(tooMany.modelCallIds).toEqual([]);
  });

  it('refuses dispatch without canonical live binding or incoming evidence (fail closed, never a silent guess)', async () => {
    const query = buildImportedJoinQuery({ sku: 'FAM-30', brand: 'Acme', name: 'Acme Chicken Dinner 30 lb' });
    await expect(proposeFamilyMembership({
      sku: 'FAM-30', query, anchors: [anchorInput('FAM-5', 'fam-a')], runId: 'run-test', modelPolicy: null,
      liveBinding: null, incomingState: testIncomingState(),
    })).rejects.toThrow(/missing_binding/);
    await expect(proposeFamilyMembership({
      sku: 'FAM-30', query, anchors: [anchorInput('FAM-5', 'fam-a')], runId: 'run-test', modelPolicy: null,
      liveBinding: testLiveBinding(), incomingState: null,
    })).rejects.toThrow(/missing_incoming/);
  });

  it('reports disabled when no usable TypeSafe route exists (never a silent guess)', async () => {
    const query = buildImportedJoinQuery({ sku: 'FAM-30', brand: 'Acme', name: 'Acme Chicken Dinner 30 lb' });
    const result = await proposeFamilyMembership({
      sku: 'FAM-30', query, anchors: [anchorInput('FAM-5', 'fam-a')], runId: 'run-test', modelPolicy: null,
      liveBinding: testLiveBinding(), incomingState: testIncomingState(),
    });
    expect(result.outcome).toBe('disabled');
    expect(result.judgments.every((j) => j.outcome === 'disabled')).toBe(true);
  });

  it('dispatches one logical request over a stubbed transport: selected, negative, and insufficient distributions', async () => {
    // Stubbed-transport coverage for the dispatch path (:608+): the SystemOne
    // transport answers each anchor Choice by request key, and the boundary
    // remaps request-keyed probabilities to canonical relationship IDs
    // before the probability floor. Without the remap every selection
    // degrades to insufficient (request keys never match canonical IDs).
    const { workspaceId } = setupProposalWorkspace();
    const conn: ProviderConnection = {
      id: 'typesafe-jev',
      label: 'TypeSafe Jev (Cloud)',
      transport: 'systemone',
      baseUrl: 'https://api.typesafe.ai/v1',
      credential: 'fixturekey',
      trustZone: 'cloud',
      approvedHost: 'api.typesafe.ai',
      approvedPort: 443,
      enabled: true,
      connectTimeoutMs: 2000,
      inferenceTimeoutMs: 5000,
    };
    upsertProviderConnection(conn);
    const policy = buildModelPolicyView(
      {
        defaultProvider: 'typesafe',
        defaultModel: 'jev-1.13.0',
        providerLocalities: { typesafe: 'cloud' },
        stageOverrides: {},
        imageDataSharing: 'local_only',
        textDataSharing: 'cloud_allowed',
      } as never,
      { snapshotHash: 'snap-family-371-dispatch' },
    );
    const anchors = [anchorInput('FAM-5', 'fam-a'), anchorInput('FAM-9', 'fam-b'), anchorInput('FAM-15', 'fam-c')];
    const query = buildImportedJoinQuery({ sku: 'FAM-30', brand: 'Acme', name: 'Acme Chicken Dinner 30 lb' });
    const run = createRun(workspaceId, 'FAM-30', null, null);
    const requested: unknown[] = [];
    const originalFetch = globalThis.fetch;
    // Option keys are per-anchor (`fam_<sku-alnum>_<n>`) in criteria order
    // (same_sku, same_family, different, insufficient): read them from the
    // request rather than reconstructing the prefix.
    const answerFor = (optionKeys: string[], n: number, prob: number): { choice: string; probabilities: Record<string, number>; confidence: number } => {
      const rest = (1 - prob) / 3;
      const probabilities: Record<string, number> = {};
      optionKeys.forEach((key, i) => { probabilities[key] = i === n ? prob : rest; });
      return { choice: optionKeys[n]!, probabilities, confidence: 0.9 };
    };
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      requested.push({ url, init });
      const body = JSON.parse(String(init?.body ?? '{}')) as { questions: Record<string, { criteria: Record<string, string> }> };
      const answers: Record<string, { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }> = {};
      for (const [questionId, question] of Object.entries(body.questions)) {
        const optionKeys = Object.keys(question.criteria);
        // FAM-5 selects (same_family argmax 0.9), FAM-9 is negative
        // (different argmax 0.9), FAM-15 is insufficient (same_family is
        // the argmax at 0.4 but below the 0.50 floor — the selected key
        // must be the argmax or the transport rejects the response).
        const answer = questionId.endsWith('FAM-5')
          ? answerFor(optionKeys, 1, 0.9)
          : questionId.endsWith('FAM-9')
            ? answerFor(optionKeys, 2, 0.9)
            : answerFor(optionKeys, 1, 0.4);
        answers[questionId] = { type: 'choice', ...answer };
      }
      return new Response(
        JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 10 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    try {
      const incomingState = testIncomingState();
      const result = await proposeFamilyMembership({ sku: 'FAM-30', query, anchors, runId: run.id, modelPolicy: policy, liveBinding: testLiveBinding(), incomingState });
      expect(requested).toHaveLength(1);
      // The model request carries the incoming SKU's reviewed identity,
      // evidence, invariants, and tuple in every anchor state — never just
      // the query SKU with anchor-derived evidence.
      const first = requested[0];
      if (!first || typeof first !== 'object' || !('init' in first)) throw new Error('stubbed transport captured no request');
      const init = first.init;
      if (!init || typeof init !== 'object' || !('body' in init)) throw new Error('stubbed transport captured no request body');
      const sentBody: unknown = JSON.parse(String(init.body ?? '{}'));
      if (!sentBody || typeof sentBody !== 'object' || !('state' in sentBody)) throw new Error('stubbed transport captured no request state');
      const state: unknown = sentBody.state;
      if (!state || typeof state !== 'object' || !('anchors' in state) || !Array.isArray(state.anchors)) {
        throw new Error('stubbed transport captured no anchor states');
      }
      expect(state.anchors).toHaveLength(3);
      for (const anchorState of state.anchors) {
        if (!anchorState || typeof anchorState !== 'object') throw new Error('anchor state is not an object');
        if (!('incomingSku' in anchorState) || !('incoming' in anchorState)) throw new Error('anchor state carries no incoming evidence');
        expect(anchorState.incomingSku).toBe('FAM-30');
        const incoming: unknown = anchorState.incoming;
        if (!incoming || typeof incoming !== 'object') throw new Error('incoming evidence is not an object');
        if (!('sku' in incoming) || !('evidenceHash' in incoming) || !('tuple' in incoming)) {
          throw new Error('incoming evidence is incomplete');
        }
        expect(incoming.sku).toBe('FAM-30');
        expect(incoming.evidenceHash).toBe('evidence-FAM-30');
        expect(incoming.tuple).toBe('food|480|');
      }
      expect(result.outcome).toBe('selected');
      expect(result.modelCallIds).toHaveLength(1);
      expect(result.rawJudgments).toHaveLength(3);
      const bySku = new Map(result.judgments.map((j) => [j.anchorSku, j]));
      expect(bySku.get('FAM-5')?.outcome).toBe('selected');
      expect(bySku.get('FAM-5')?.selectedProbability).toBeCloseTo(0.9, 5);
      expect(bySku.get('FAM-9')?.outcome).toBe('negative');
      expect(bySku.get('FAM-15')?.outcome).toBe('insufficient');
      expect(result.questionCount).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

const PROPOSAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ShopSiteProducts version="15.0"><Products>
<Product><SKU>FAM-5</SKU><Name>Acme Chicken Dinner 5 lb</Name><Price>19.99</Price>
<ProductDisabled>checked</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/fam-5.jpg</Graphic><QuantityOnHand>7</QuantityOnHand>
<Weight>5 lb</Weight><ProductField7>Acme 5 lb</ProductField7>
<ProductField16>Acme</ProductField16><ProductField17>Dog</ProductField17><ProductField18>Adult</ProductField18>
<ProductField22>Dry Kibble</ProductField22><ProductField23>Chicken</ProductField23><ProductField24>Chicken Dinner</ProductField24>
<MoreInformationText>Real chicken dinner.</MoreInformationText>
<Subproducts><Subproduct><SKU>FAM-5</SKU><Name>Acme Chicken Dinner 5 lb</Name><Price>19.99</Price></Subproduct><Subproduct><SKU>FAM-15</SKU><Name>Acme Chicken Dinner 15 lb</Name><Price>39.99</Price></Subproduct></Subproducts>
</Product>
<Product><SKU>FAM-15</SKU><Name>Acme Chicken Dinner 15 lb</Name><Price>39.99</Price>
<ProductDisabled>checked</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/fam-15.jpg</Graphic><QuantityOnHand>4</QuantityOnHand>
<Weight>15 lb</Weight><ProductField7>Acme 15 lb</ProductField7>
<ProductField16>Acme</ProductField16><ProductField17>Dog</ProductField17><ProductField18>Adult</ProductField18>
<ProductField22>Dry Kibble</ProductField22><ProductField23>Chicken</ProductField23><ProductField24>Chicken Dinner</ProductField24>
<MoreInformationText>Real chicken dinner.</MoreInformationText></Product>
</Products></ShopSiteProducts>`;

function setupProposalWorkspace() {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-family-371-'));
  const dbPath = path.join(workspacePath, `family-371-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const workspaceId = `ws-family-371-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  initDb(dbPath);
  runMigrations();
  const now = new Date().toISOString();
  getDb().run(
    `INSERT OR IGNORE INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [workspaceId, `${workspaceId}-store`, workspacePath, `${workspacePath}/.git`, now, now, 'complete'],
  );
  createWorkspaceDirs(workspacePath);
  fs.writeFileSync(path.join(workspacePath, '.gitignore'), 'exports/\n');
  const git = new GitClient(workspacePath);
  git.init();
  const decoded = ShopSiteProductCodec.decode(PROPOSAL_XML, { workspaceId });
  for (const p of decoded.products) writeProductFile(workspacePath, p);
  git.add(['products/', '.gitignore']);
  git.commit('Baseline for family membership proposal');
  const authorized = decoded.products.map((product) => approveFamilyCatalogProduct({
    workspaceId, workspacePath, product, productTypeId: 'dog-food-dry',
  }));
  return { workspacePath, workspaceId, products: authorized.map((item) => item.product) };
}

function axisFor371(p: Product) {
  const ounces: Record<string, number> = { 'FAM-5': 80, 'FAM-15': 240, 'FAM-30': 480 };
  return {
    brand: 'Acme', recipe: 'Chicken Dinner', flavor: 'Chicken', species: 'Dog',
    lifeStage: 'Adult', form: 'Dry Kibble',
    sizeRaw: p.core.weight ?? '5 lb', ounces: ounces[p.sku] ?? 80,
    retailUnit: null, packCountDeclared: false, packCount: null, purchasable: true,
  };
}

function joinEvidence371(sku: string, weight: string, ounces: number, flavor = 'Chicken', recipe = 'Chicken Dinner'): JoinMemberEvidence {
  const now = new Date().toISOString();
  const draft: Product = {
    schemaVersion: 1, id: `family-new-${sku}`, sku, status: 'draft',
    core: {
      name: `Acme ${recipe} ${weight}`, price: '49.99', salePrice: null, description: 'Real chicken dinner.',
      inventory: { quantityOnHand: 2, lowStockThreshold: null, outOfStockLimit: null }, availability: null,
      weight, taxable: true, media: { primary: `media/${sku.toLowerCase()}.jpg`, additional: [] },
      seo: { fileName: null, searchKeywords: null, googleProductCategory: null }, productOnPages: [],
    },
    customFields: { ProductField7: '', ProductField16: 'Acme', ProductField17: 'Dog', ProductField18: 'Adult', ProductField22: 'Dry Kibble', ProductField23: flavor, ProductField24: recipe },
    shopsite: {
      productId: null, productGuid: null, xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null,
      source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
    },
    metadata: { createdAt: now, updatedAt: now, archivedAt: null },
  };
  return {
    sku, base: null, draftBase: draft, purchasable: true, brand: 'Acme', recipe, flavor,
    species: 'Dog', lifeStage: 'Adult', form: 'Dry Kibble', sizeRaw: weight, ounces,
    retailUnit: null, packCountDeclared: false, packCount: null,
    reviewedTypeHash: computeReviewedAuthorityHash('dog-food-dry') ?? (() => { throw new Error('Missing dog-food-dry authority hash'); })(), evidenceHash: `evidence-${sku}`, origin: 'import' as const,
    productTypeId: null, model: null, material: null, function: null, safetyDose: null,
    strength: null, fit: null, colorRaw: null, countRaw: null, countQuantity: null,
  };
}

function catalogEvidence371(p: Product): JoinMemberEvidence {
  return {
    sku: p.sku, base: structuredClone(p), draftBase: structuredClone(p), purchasable: true,
    brand: 'Acme', recipe: 'Chicken Dinner', flavor: 'Chicken', species: 'Dog', lifeStage: 'Adult',
    form: 'Dry Kibble', sizeRaw: p.core.weight ?? '5 lb', ounces: p.sku === 'FAM-5' ? 80 : 240,
    retailUnit: null, packCountDeclared: false, packCount: null,
    reviewedTypeHash: p.shopsite.preserved.rawAttributes.reviewedTypeHash as string, evidenceHash: `evidence-${p.sku}`, origin: 'catalog',
    productTypeId: null, model: null, material: null, function: null, safetyDose: null,
    strength: null, fit: null, colorRaw: null, countRaw: null, countQuantity: null,
  };
}

describe('family membership proposal lifecycle + acceptance smoke (issue #371)', () => {
  it('persists judgments, reuses identical state, and never carries approval across reuse', () => {
    const { workspaceId } = setupProposalWorkspace();
    const stored = createFamilyMembershipProposal({
      workspaceId, sku: 'FAM-30', outcome: 'selected',
      judgments: [judgment('FAM-5', 'fam-a', 'selected')],
      rawJudgments: [{ anchorSku: 'FAM-5', choice: 'same_permitted_family', probabilities: { same_permitted_family: 0.9 }, confidence: 0.9 }],
      modelCallIds: ['call-1'], evidenceHash: 'eh', ruleHash: 'rh', anchorHash: 'ah',
      modelPolicyDigest: 'pd', ruleVersion: 'food-family-variant-rule-v1', promptTemplateVersion: 'v1',
    });
    expect(stored.status).toBe('proposed');
    expect(stored.judgments).toHaveLength(1);
    expect(stored.modelCallIds).toEqual(['call-1']);
    const pin = { workspaceId, sku: 'FAM-30', evidenceHash: 'eh', anchorHash: 'ah', modelPolicyDigest: 'pd', ruleHash: 'rh' };
    expect(findReusableFamilyMembershipProposal(pin)?.id).toBe(stored.id);
    expect(findReusableFamilyMembershipProposal({ ...pin, evidenceHash: 'changed' })).toBeNull();
    // A rule-version change over identical anchors/evidence re-proposes, never replays stale judgments.
    expect(findReusableFamilyMembershipProposal({ ...pin, ruleHash: 'rh-changed' })).toBeNull();
    // Accepted rows never auto-apply: reuse is proposed-only.
    decideFamilyMembershipProposal({ id: stored.id, actor: 'reviewer-1', action: 'accept', linkedPlanId: 'plan-1' });
    expect(findReusableFamilyMembershipProposal(pin)).toBeNull();
    expect(findFamilyMembershipProposalById(stored.id)?.status).toBe('accepted');
  });

  it('revise/reject/defer dispose the proposal and stale rows refuse further decisions', () => {
    const { workspaceId } = setupProposalWorkspace();
    const mk = (sku: string) => createFamilyMembershipProposal({
      workspaceId, sku, outcome: 'selected', judgments: [judgment('FAM-5', 'fam-a', 'selected')],
      rawJudgments: [], modelCallIds: ['call-1'], evidenceHash: 'eh', ruleHash: 'rh', anchorHash: 'ah',
      modelPolicyDigest: 'pd', ruleVersion: 'food-family-variant-rule-v1', promptTemplateVersion: 'v1',
    });

    const revised = decideFamilyMembershipProposal({ id: mk('S-1').id, actor: 'op', action: 'revise', note: 'recheck anchor' });
    expect(revised.status).toBe('revised');
    expect(revised.revision).toBe(1);
    expect(decideFamilyMembershipProposal({ id: mk('S-2').id, actor: 'op', action: 'reject' }).status).toBe('rejected');
    expect(decideFamilyMembershipProposal({ id: mk('S-3').id, actor: 'op', action: 'defer' }).status).toBe('deferred');
    const staleRow = mk('S-4');
    markFamilyMembershipProposalStale(staleRow.id);
    expect(findFamilyMembershipProposalById(staleRow.id)?.status).toBe('stale');
    expect(() => decideFamilyMembershipProposal({ id: staleRow.id, actor: 'op', action: 'accept' }))
      .toThrow(/stale/);
  });

  it('proposal → review → acceptance → export smoke: accepted proposal stages the complete join and exports one commit', () => {
    const { workspacePath, workspaceId, products } = setupProposalWorkspace();
    const adopted = stageNativeAdoption({
      workspaceId, workspacePath, memberSkus: ['FAM-5', 'FAM-15'], actor: 'operator-1',
      evidenceBySku: new Map(products.map((p) => [p.sku, {
        base: structuredClone(p), draftBase: structuredClone(p),
        reviewedTypeHash: p.shopsite.preserved.rawAttributes.reviewedTypeHash as string, evidenceHash: `evidence-${p.sku}`, axis: axisFor371(p),
      } satisfies AdoptionEvidence])),
    });
    const acceptedAdoption = decideStorefrontFamilyPlan({ planId: adopted.plan.id, actor: 'reviewer-2', action: 'accept' });
    const appliedAdoption = applyAdoptedFamilyPlan({
      planId: acceptedAdoption.plan.id, workspaceId, workspacePath,
      draftsBySku: new Map(products.map((p) => [p.sku, structuredClone(p)])), actor: 'reviewer-2',
    });
    expect(approveChangeSet(appliedAdoption.changeSetId, workspacePath).success).toBe(true);

    // The TypeSafe verdict (selected anchor in the applied family) is stored;
    // the operator accepts the proposal before the join stages.
    const proposal = createFamilyMembershipProposal({
      workspaceId, sku: 'FAM-30', outcome: 'selected',
      judgments: [judgment('FAM-5', adopted.plan.id, 'selected')],
      rawJudgments: [{ anchorSku: 'FAM-5', choice: 'same_permitted_family', probabilities: { same_permitted_family: 0.92 }, confidence: 0.9 }],
      modelCallIds: ['call-371-1'], evidenceHash: 'eh-371', ruleHash: 'rh-371', anchorHash: 'ah-371',
      modelPolicyDigest: 'pd-371', ruleVersion: 'food-family-variant-rule-v1', promptTemplateVersion: 'v1',
    });
    const disposition = resolveProposalDisposition(proposal.judgments);
    expect(disposition.conflicts).toBe(false);
    expect(disposition.sameSku).toHaveLength(0);
    expect(checkTransitiveSafety({ positives: disposition.positives, invariantOf: () => ({ brand: 'Acme', recipe: 'Chicken Dinner' }) }).safe).toBe(true);
    decideFamilyMembershipProposal({ id: proposal.id, actor: 'reviewer-2', action: 'accept' });

    const live = products.map((p) => readProductFile(workspacePath, p.sku)!);
    const evidenceBySku = new Map<string, JoinMemberEvidence>([
      ...live.map((p) => [p.sku, catalogEvidence371(p)] as const),
      ['FAM-30', joinEvidence371('FAM-30', '30 lb', 480)],
    ]);
    const staged = stageFamilyJoin({
      workspaceId, workspacePath, familyPlanId: adopted.plan.id, joinedSkus: ['FAM-30'],
      actor: 'operator-1', evidenceBySku,
      membershipProposal: { proposalId: proposal.id, outcome: 'selected', familyPlanId: adopted.plan.id },
    });
    expect(staged.plan.joinOrigin?.membershipProposalId).toBe(proposal.id);
    expect(staged.plan.mainSku).toBe('FAM-5');

    // Review binds the truthful proposal section: selected, accepted, not stale.
    const reviewLive = new Map<string, Product | null>([...live.map((p) => [p.sku, p] as const), ['FAM-30', null]]);
    const review = reviewFamilyJoin({
      planId: staged.plan.id, workspacePath, liveBySku: reviewLive, evidenceBySku,
      membershipProposal: {
        proposalId: proposal.id, outcome: 'selected', status: 'accepted',
        judgments: proposal.judgments.map((j) => ({ anchorSku: j.anchorSku, familyPlanId: j.familyPlanId, outcome: j.outcome, reason: j.reason })),
        modelCallIds: ['call-371-1'], stale: false, staleReasons: [],
      },
    });
    expect(review.membershipProposal?.outcome).toBe('selected');
    expect(review.membershipProposal?.status).toBe('accepted');
    expect(review.membershipProposal?.stale).toBe(false);
    expect(review.membershipProposal?.judgments).toHaveLength(1);
    expect(review.blockers).toEqual([]);

    // Same-flavor different recipe is a separate family: the complete plan gates refuse it.
    const beef = joinEvidence371('FAM-BEEF', '30 lb', 480, 'Chicken', 'Beef Dinner');
    const beefEvidence = new Map(evidenceBySku);
    beefEvidence.set('FAM-BEEF', beef);
    expect(() => stageFamilyJoin({
      workspaceId, workspacePath, familyPlanId: adopted.plan.id, joinedSkus: ['FAM-BEEF'],
      actor: 'operator-1', evidenceBySku: beefEvidence,
    })).toThrow(/FAMILY_INVARIANT_CONFLICT/);

    // Accepted current proposal flows through the same complete plan,
    // approval, and export path as explicit selection.
    const accepted = decideFamilyJoin({ planId: staged.plan.id, actor: 'reviewer-2', action: 'accept' });
    expect(accepted.plan.status).toBe('accepted');
    const drafts = new Map<string, Product>([
      ...live.map((p) => [p.sku, structuredClone(p)] as const),
      ['FAM-30', joinEvidence371('FAM-30', '30 lb', 480).draftBase],
    ]);
    const applied = applyFamilyJoin({
      planId: accepted.plan.id, workspaceId, workspacePath, draftsBySku: drafts, actor: 'reviewer-2',
      currentTypeHashBySku: new Map([...evidenceBySku].map(([sku, ev]) => [sku, ev.reviewedTypeHash] as const)),
      currentEvidenceHashBySku: new Map([...evidenceBySku].map(([sku, ev]) => [sku, ev.evidenceHash] as const)),
      currentRuleVersionBySku: new Map([...evidenceBySku.keys()].map((sku) => [sku, staged.plan.ruleVersion] as const)),
      currentProductTypeIdBySku: new Map([...evidenceBySku].map(([sku, ev]) => [sku, ev.productTypeId] as const)),
      currentLabelBySku: new Map([...evidenceBySku.keys()].map((sku) => [sku, null] as const)),
    });
    expect(approveChangeSet(applied.changeSetId, workspacePath).success).toBe(true);
    const linked = loadApprovedLinkedExport(applied.changeSetId, workspacePath);
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    // Delta-write shape (#370, mirrors storefront-family-join.test.ts):
    // the change set carries only the import create + main managed-block
    // update; the unchanged member exports from the approved commit via
    // the linked read-dependency contract. Full group still verified.
    expect(linked.load.manifest.writes.map((w) => w.sku).sort()).toEqual(['FAM-30', 'FAM-5']);
    expect(linked.load.products.map((p) => p.sku).sort()).toEqual(['FAM-30', 'FAM-5']);
    expect(linked.load.manifest.reads.map((r) => r.sku)).toContain('FAM-15');
    expect(readProductFile(workspacePath, 'FAM-15')!.customFields['ProductField7']).toBe('Acme 15 lb');
    const bySku = new Map(linked.load.products.map((p) => [p.sku, p]));
    expect(bySku.get('FAM-5')?.customFields['ProductField7']).toBe('Acme 5 lb');
    expect(bySku.get('FAM-30')?.customFields['ProductField7']).toBe('30 lb (480 oz)');
    const familyRow = findStorefrontFamilyPlanById(accepted.plan.id)!;
    expect(parseStorefrontFamilyPlan(familyRow.planJson).linkedChangeSetId).toBe(applied.changeSetId);
  });
});
