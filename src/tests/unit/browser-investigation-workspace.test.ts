// T5 (#229) — workspace operator flow: evidence-rich results, holdout
// coverage, budgets, drift entry, and action separation (Vitest, pure).
//
// - The operator sees platform and structure evidence, field
//   recommendations, identity support, gaps, provider/model, actual
//   usage/cost or explicit unavailable, and stable failure codes.
// - Representative selection shows confirmed vs investigated URLs with
//   visible holdout coverage and budgets.
// - Drift/failure entry pre-attaches last-healthy policy, artifact hashes,
//   failing extraction, provenance, failure codes, and affected fields.
// - Missing, failing, wrong-product, wrong-variant, and pending-image-review
//   outcomes block through the SHARED health evaluator (no second health
//   definition — this view computes no gate).

import { describe, expect, it } from 'vitest';
import { hashCanonicalJson } from '../../shared/stable-id';
import {
  INVESTIGATION_RESULT_VERSION,
  resolveInvestigationBudget,
  type InvestigationRecord,
} from '../../shared/schemas/browser-investigation';
import { POLICY_FIELDS } from '../../shared/schemas/browser-investigation-policy';
import { evaluateGate } from '../../onboarding/profile-activation-gate';
import {
  attachDriftRepairContext,
  buildDriftRepairContext,
  describeHoldoutCoverage,
  describeInvestigationCost,
  describeInvestigationEvidence,
  describeInvestigationWorkspace,
} from '../../onboarding/browser-investigation/workspace';

const WS = 'ws-t5-workspace';
const DOMAIN = 'shop.example.com';
const REP_A = 'https://shop.example.com/products/alpha';
const REP_B = 'https://shop.example.com/products/beta';
const HOLDOUT_1 = 'https://shop.example.com/products/holdout-1';

function completedRecord(): InvestigationRecord {
  const result = {
    version: INVESTIGATION_RESULT_VERSION,
    summary: 'T5 workspace fixture. Untrusted proposal evidence only.',
    observations: [
      { kind: 'shopify_json_observation', sourceUrl: REP_A, artifactHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', incomplete: false },
    ],
    evidenceRefs: ['artifact:alpha'],
    gaps: ['unresolved:availability has no supported source'],
    renderedBrowserRequired: false,
    platform: 'shopify',
    incompatibleStructureIds: [],
    structures: [{ id: 'shopify-default', sampleUrls: [REP_A], description: 'Default product template', platformSource: 'shopify_product_json' }],
    fieldRecommendations: POLICY_FIELDS.map((field) => ({
      field,
      sources: ['shopify_product_json'],
      structureId: 'shopify-default',
      evidenceRef: 'artifact:alpha',
    })),
    identityRequirements: {
      productIdentity: ['gtin_exact'],
      variantIdentity: ['gtin_exact', 'sku_exact', 'platform_id_exact', 'options_exact_tuple', 'operator_selected'],
      optionAxes: ['size'],
    },
  };
  return {
    id: 'binv_workspace_1',
    workspaceId: WS,
    domain: DOMAIN,
    mode: 'domain_onboarding',
    status: 'completed',
    provider: 'local_browser_harness',
    runId: 'binvrun_workspace_1',
    requestedModel: { provider: 'local', model: 'qwen2.5vl:latest' },
    actualModel: { provider: 'local', model: 'qwen2.5vl:latest' },
    inputSnapshot: {
      domain: DOMAIN,
      mode: 'domain_onboarding',
      sampleUrls: [REP_A, REP_B],
      budget: resolveInvestigationBudget(),
      modelPolicy: { allowCloudTextAnalysis: false, allowImageSharing: false },
      knownContext: { operatorNote: 'recheck variant images' },
      requestedAt: '2026-09-17T00:00:00.000Z',
    },
    inputHash: 'input-hash-workspace-1-input-hash-workspace-1',
    budget: resolveInvestigationBudget(),
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:01.000Z',
    startedAt: '2026-09-17T00:00:00.000Z',
    completedAt: '2026-09-17T00:00:01.000Z',
    usage: { modelCalls: 3, pagesVisited: 2, readsPerformed: 9, durationMs: 42000, costUsd: null, costBasis: 'unavailable' },
    failureCode: null,
    failureDetail: null,
    result: result as InvestigationRecord['result'],
    resultHash: hashCanonicalJson(result),
    discardedAt: null,
    discardActor: null,
  } as InvestigationRecord;
}

describe('evidence-rich investigation results', () => {
  it('exposes platform, structures, recommendations, identity, gaps, provider/model, usage, and failure codes', () => {
    const evidence = describeInvestigationEvidence(completedRecord());
    expect(evidence.platform).toBe('shopify');
    expect(evidence.evidenceLinks).toEqual(['artifact:alpha']);
    expect(evidence.structures).toEqual([
      { id: 'shopify-default', sampleUrls: [REP_A], description: 'Default product template', platformSource: 'shopify_product_json' },
    ]);
    expect(evidence.fieldRecommendations).toHaveLength(POLICY_FIELDS.length);
    expect(evidence.fieldRecommendations[0]).toMatchObject({ field: 'title', sources: ['shopify_product_json'] });
    expect(evidence.identity?.productIdentity).toContain('gtin_exact');
    expect(evidence.gaps).toEqual(['unresolved:availability has no supported source']);
    expect(evidence.codeAdapterNeeded).toBeNull();
    expect(evidence.renderedBrowser).toEqual({ required: false, reason: null });
    expect(evidence.provider).toBe('local_browser_harness');
    expect(evidence.requestedModel).toContain('qwen2.5vl');
    expect(evidence.actualModel).toContain('qwen2.5vl');
    expect(evidence.failure).toBeNull();
    // Workspace-private values stay in workspace tables: keys only.
    expect(evidence.knownContextKeys).toEqual(['operatorNote']);
    expect(JSON.stringify(evidence)).not.toContain('recheck variant images');
  });

  it('reports actual cost distinctly from estimates and explicit unavailable', () => {
    expect(describeInvestigationCost(null).costDisplay).toBe('unavailable');
    expect(describeInvestigationCost({ modelCalls: 1, costUsd: null, costBasis: 'unavailable' }).costDisplay).toBe('unavailable');
    expect(describeInvestigationCost({ costUsd: 0.42, costBasis: 'billed' }).costDisplay).toBe('$0.42 (billed)');
    expect(describeInvestigationCost({ costUsd: 0.42, costBasis: 'estimated' }).costDisplay).toBe('$0.42 (estimated)');
    // Never fabricated: absent usage yields nulls, not zeros.
    expect(describeInvestigationCost(null)).toMatchObject({ modelCalls: null, costUsd: null });
  });

  it('surfaces stable failure codes on failed investigations', () => {
    const record = { ...completedRecord(), status: 'failed' as const, failureCode: 'timeout' as const, failureDetail: 'capture exceeded 10 min' };
    expect(describeInvestigationEvidence(record).failure).toEqual({ code: 'timeout', detail: 'capture exceeded 10 min' });
  });
});

function defaultView() {
  const record = completedRecord();
  return describeInvestigationWorkspace({
    record,
    budget: record.budget,
    representatives: [REP_A, REP_B, HOLDOUT_1],
    corpusUrls: [REP_A, REP_B, HOLDOUT_1],
    reservedUrls: [],
    validation: null,
  });
}

describe('workspace view: selection, coverage, and budgets', () => {
  it('shows confirmed vs investigated representatives with holdout coverage and budgets', () => {
    const workspace = defaultView();
    expect(workspace.representatives).toEqual({ confirmed: [REP_A, REP_B, HOLDOUT_1], investigated: [REP_A, REP_B] });
    expect(workspace.holdouts.required).toBe(1);
    expect(workspace.holdouts.validationStatus).toBe('not_run');
    expect(workspace.holdouts.suggestion.preferred).toContain(HOLDOUT_1);
    expect(workspace.budgets.some((row) => row.key === 'maxPages')).toBe(true);
    expect(workspace.budgets.some((row) => row.key === 'maxCostUsd')).toBe(true);
  });

  it('computes no health verdict — the shared evaluator stays the single definition', () => {
    const workspace = defaultView();
    expect(workspace.healthVerdict).toContain('shared domain-version-health evaluator');
    expect(workspace).not.toHaveProperty('healthy');
    expect(workspace).not.toHaveProperty('gate');
    expect(workspace).not.toHaveProperty('allowed');
  });
});

describe('workspace view: separate actions without automatic activation', () => {
  it('separates validate, apply, and discard with no automatic activation or release', () => {
    const workspace = defaultView();
    expect(workspace.actions.validate).toEqual({ allowed: true, reason: expect.any(String) });
    expect(workspace.actions.apply.allowed).toBe(true);
    expect(workspace.actions.discard.allowed).toBe(true);
    expect(workspace.actions.automaticActivation).toBe(false);
    expect(workspace.actions.automaticRelease).toBe(false);
    expect(workspace).not.toHaveProperty('activate');
    expect(workspace).not.toHaveProperty('release');
  });

  it('withholds apply for unappliable outcomes and validate/discard by lifecycle', () => {
    const record = completedRecord();
    const queued = describeInvestigationWorkspace({
      record: { ...record, status: 'queued' },
      budget: record.budget,
      representatives: [],
      corpusUrls: [],
      reservedUrls: [],
      validation: null,
    });
    expect(queued.actions.validate.allowed).toBe(false);
    expect(queued.actions.apply.allowed).toBe(false);
    expect(queued.actions.discard.allowed).toBe(false);
    expect(queued.proposal).toEqual({ available: false, reason: expect.stringContaining('queued') });
  });

  it('surfaces reserved holdouts and passing counts from validation', () => {
    const record = completedRecord();
    const workspace = describeInvestigationWorkspace({
      record,
      budget: record.budget,
      representatives: [REP_A, REP_B, HOLDOUT_1],
      corpusUrls: [REP_A, REP_B, HOLDOUT_1],
      reservedUrls: [HOLDOUT_1],
      validation: {
        validationId: 'vval_x',
        investigationId: record.id,
        domain: DOMAIN,
        status: 'failed',
        proposalHash: 'p'.repeat(64),
        policyHash: 'q'.repeat(64),
        baselineVersionId: null,
        samples: [],
        holdouts: { required: 1, passed: 0, sampleIds: [HOLDOUT_1] },
        blockers: ['holdout_failed:no blind holdout passed'],
        validatedAt: record.completedAt!,
        validationHash: 'r'.repeat(64),
      },
    });
    expect(workspace.holdouts.reserved).toEqual([HOLDOUT_1]);
    expect(workspace.holdouts.passed).toBe(0);
    expect(workspace.holdouts.validationStatus).toBe('failed');
    // Reserved holdouts are covered, never re-suggested as fresh candidates.
    expect(workspace.holdouts.suggestion.preferred).not.toContain(HOLDOUT_1);
  });
});

describe('drift/failure entry pre-attaches the frozen last-healthy baseline', () => {
  const POLICY_SELECTORS = {
    titleSelector: 'h1.product-title',
    extractionPolicy: {
      version: 1,
      platform: 'shopify',
      structures: [],
      fields: [],
      identity: {},
      renderedBrowserRequired: false,
    },
  };

  it('attaches policy, artifact hashes, failing extraction, provenance, failure codes, and affected fields', () => {
    const ctx = buildDriftRepairContext(DOMAIN, {
      activeVersion: { id: 'ver_healthy_1', selectors: POLICY_SELECTORS, artifactHashes: ['hash-a', 'hash-b'] },
      matrix: {
        rows: [
          {
            sampleId: 's1',
            sampleUrl: REP_A,
            cells: [
              { field: 'title', provenance: 'shopify_product_json', success: true, failureReason: null },
              { field: 'price', provenance: 'selector', success: false, failureReason: 'field_missing:price' },
            ],
          },
        ],
      },
    });
    expect(ctx.available).toBe(true);
    if (!ctx.available) throw new Error('fixture must be available');
    expect(ctx.lastHealthyVersionId).toBe('ver_healthy_1');
    expect(ctx.policy).toMatchObject({ platform: 'shopify' });
    expect(ctx.artifactHashes).toEqual(['hash-a', 'hash-b']);
    expect(ctx.failingSamples).toEqual([
      {
        sampleId: 's1',
        sampleUrl: REP_A,
        affectedFields: ['price'],
        failureCodes: ['field_missing:price'],
        provenance: ['selector'],
      },
    ]);
    expect(ctx.failureCodes).toEqual(['field_missing:price']);
    expect(ctx.affectedFields).toEqual(['price']);
  });

  it('marks unavailable explicitly when no active version exists', () => {
    expect(buildDriftRepairContext(DOMAIN, { activeVersion: null, matrix: null })).toEqual({
      available: false,
      reason: expect.stringContaining('no_active_version'),
    });
  });

  it('the server-owned driftRepair key cannot be spoofed through the launch payload', () => {
    const attached = attachDriftRepairContext(
      { operatorNote: 'x', driftRepair: { forged: true } },
      { available: false, reason: 'no_active_version:test' },
    );
    expect(attached).toEqual({ operatorNote: 'x', driftRepair: { available: false, reason: 'no_active_version:test' } });
  });
});

describe('all five failure signals block through the shared health evaluator', () => {
  function investigationBase() {
    return {
      requiredResults: [
        { field: 'title', success: true },
        { field: 'title', success: true },
        { field: 'title', success: true },
      ],
      wrongProduct: false,
      wrongVariant: false,
      waiver: true,
      confirmedCount: 1,
      imageRuleOk: true as const,
      investigationDerived: true,
      policyValidationStatus: 'passed' as const,
      holdoutPassedCount: 1,
    };
  }

  it('missing results block', () => {
    const r = evaluateGate({ ...investigationBase(), requiredResults: [] });
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toBe('missing_results');
  });

  it('failing field results block', () => {
    const r = evaluateGate({
      ...investigationBase(),
      requiredResults: [
        { field: 'title', success: true },
        { field: 'price', success: false },
      ],
    });
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toContain('price');
  });

  it('wrong-product blocks', () => {
    const r = evaluateGate({ ...investigationBase(), wrongProduct: true });
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toBe('wrong_product');
  });

  it('wrong-variant blocks', () => {
    const r = evaluateGate({ ...investigationBase(), wrongVariant: true });
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toBe('wrong_variant');
  });

  it('pending image review blocks', () => {
    const pending = evaluateGate({ ...investigationBase(), imageRuleOk: false });
    expect(pending.allowed).toBe(false);
    expect(pending.blockReason).toBe('image rule failed');
    const absent = evaluateGate({ ...investigationBase(), imageRuleOk: undefined });
    expect(absent.allowed).toBe(false);
    expect(absent.blockReason).toBe('missing_image_attestation');
  });
});

describe('holdout coverage display', () => {
  it('reports the hard minimum of one with reserved, preferred, and gaps', () => {
    const record = completedRecord();
    const coverage = describeHoldoutCoverage({ record, reservedUrls: [HOLDOUT_1], corpusUrls: [REP_A, REP_B, HOLDOUT_1], validation: null });
    expect(coverage.required).toBe(1);
    expect(coverage.passed).toBe(0);
    expect(coverage.reserved).toEqual([HOLDOUT_1]);
    expect(coverage.suggestion.preferred).not.toContain(HOLDOUT_1);
    expect(coverage.validationStatus).toBe('not_run');
  });
});
