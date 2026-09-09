/**
 * Value Gap Abstain Stage (P3 — classification roadmap plan B.P3.3)
 *
 * Covers:
 * - flag OFF (default): inert no-op success, zero LLM calls;
 * - constraint adherence: in-constraint pick becomes a pending field_assignment;
 * - out-of-constraint model output ⇒ deterministic abstain, never invention
 *   (property/fuzz test over randomized responses);
 * - claim/composition attributes are excluded without any LLM call;
 * - operation registration: `value_gap_resolution` registered in the model
 *   operation registry with prompt/rule versions and stage mapping;
 * - audit threading: ranker receives the run-bound ModelCallContext + snapshot.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageContext, StageInput, StageResult, StageOutput } from '../../classification/types';

/** Narrow a StageResult to its output; fails loudly on 'failed', tolerates absent abstention output. */
function out(result: StageResult): StageOutput {
  if (result.status === 'failed') throw new Error(`stage failed: ${result.error}`);
  return result.output ?? { evidence: [], proposals: [], abstained: true };
}
import type { ClassificationConfig, ProductAttributeConfig } from '../../shared/schemas/classification';

const mocks = vi.hoisted(() => ({
  llmRankOptions: vi.fn(),
}));

vi.mock('@/classification/curation-target-ranker', () => ({ llmRankOptions: mocks.llmRankOptions }));
vi.mock('@/classification/runtime-snapshot', () => ({
  buildModelCallContext: vi.fn((_snapshot, runId: string, operation: string, attempt: number) => ({
    runId,
    snapshotHash: 'snap-hash-1',
    stage: 'value_gap_abstain',
    operation,
    attempt,
    promptTemplateVersion: '1',
    ruleVersion: '1',
  })),
}));
vi.mock('@/classification/config-loader', () => ({ loadClassificationConfig: vi.fn(() => { throw new Error('no disk reads in unit tests'); }) }));
vi.mock('@/classification/curation-target-resolver', () => ({
  resolveEnabledTargets: vi.fn(),
  resolveTargetsFromSnapshot: vi.fn(),
}));

import { resolveTargetsFromSnapshot } from '../../classification/curation-target-resolver';
import type { ResolvedTargets } from '../../classification/curation-target-resolver';
import { valueGapAbstainStage } from '../../classification/stages/value-gap-abstain';
import {
  DEFAULT_UNIVERSAL_TIER_FLAGS,
  overrideUniversalTierFlags,
  resetUniversalTierFlagsOverride,
} from '../../classification/flags';
import {
  MODEL_OPERATION_REGISTRY_VERSION,
  OPERATION_PARAMETERS,
  OPERATION_TO_STAGE,
  PROMPT_TEMPLATE_VERSIONS,
  RULE_VERSIONS,
} from '../../classification/model-operation-registry';

function makeAttribute(overrides: Partial<ProductAttributeConfig> = {}): ProductAttributeConfig {
  return {
    id: 'flavor',
    name: 'Flavor',
    description: null,
    valueMode: 'controlled',
    canonicalUnit: null,
    allowedValues: ['Chicken', 'Beef', 'Salmon'],
    valueAliases: [],
    visualEvidenceEligibility: 'eligible',
    isClaim: false,
    isCompositionAttribute: false,
    group: 'Nutrition',
    ...overrides,
  };
}

const flavorTarget = {
  id: 'flavor-target',
  kind: 'product_field' as const,
  label: 'Flavor',
  enabled: true,
  mandatory: false,
  selectionMode: 'single' as const,
  attributeId: 'flavor',
  catalogField: 'ProductField23',
  optionSource: 'configured' as const,
  required: false,
  sortOrder: 0,
};

function makeSnapshot() {
  const attributes = [makeAttribute()];
  return {
    schemaVersion: 2 as const,
    snapshotHash: 'snap-hash-1',
    createdAt: '2026-08-24T00:00:00.000Z',
    workspaceId: 'ws-1',
    workspacePath: '/tmp/ws',
    productSku: 'sku-1',
    configAuthorityKind: 'v1' as const,
    config: { curationTargets: [flavorTarget], attributeMappings: [], attributes } as unknown as ClassificationConfig,
    curationTargets: [],
    productTypes: [],
    attributes,
    fieldOptions: {},
    pages: { state: 'empty', records: [] },
    modelPolicy: {
      defaultProvider: 'openai',
      providerLocalities: { openai: 'cloud' },
      stageOverrides: {},
      imageDataSharing: 'local_only',
      textDataSharing: 'local_only',
      mlFeatures: {
        productionRetrieval: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        pageReranking: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        confidenceCalibration: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        productionEmbeddings: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
      },
    } as unknown as Record<string, unknown>,
  };
}

function makeContext(snapshot: ReturnType<typeof makeSnapshot> | undefined): StageContext {
  return { runId: 'run-1', workspaceId: 'ws-1', workspacePath: '/tmp/ws', ...(snapshot ? { snapshot } : {}) } as StageContext;
}

function makeEvidenceRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ev-1',
    runId: 'run-1',
    stageName: 'evidence_extraction',
    productSku: 'sku-1',
    attributeId: null,
    source: 'catalog_product',
    reliability: 'high',
    sourceUrl: null,
    sourceField: 'ProductField23',
    snippet: null,
    value: 'Roasted chicken dinner',
    metadata: null,
    capturedAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  };
}

function makeInput(overrides: Record<string, unknown> = {}): StageInput {
  return {
    sku: 'sku-1',
    evidence: [makeEvidenceRecord()],
    acceptedProposals: [],
    allProposals: [],
    stageOutputs: {
      attribute_applicability: {
        evidence: [],
        proposals: [],
        abstained: false,
        metadata: { applicability: [{ attributeId: 'flavor', state: 'applicable' }] },
      },
      product_attribute_proposals: {
        evidence: [],
        proposals: [],
        abstained: false,
      },
    },
    ...overrides,
  } as StageInput;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetUniversalTierFlagsOverride();
});

describe('valueGapAbstainStage — composition gating', () => {
  it('defaults OFF and is inert when invoked directly (no LLM call, zero proposals)', async () => {
    expect(DEFAULT_UNIVERSAL_TIER_FLAGS.valueGapLlmEnabled).toBe(false);
    const result = await valueGapAbstainStage.execute(makeInput(), makeContext(undefined));
    expect(result.status).toBe('succeeded');
    expect(out(result).proposals).toEqual([]);
    expect(mocks.llmRankOptions).not.toHaveBeenCalled();
  });
});

describe('valueGapAbstainStage — gap resolution (flag ON)', () => {
  beforeEach(() => {
    overrideUniversalTierFlags({ valueGapLlmEnabled: true });
    vi.mocked(resolveTargetsFromSnapshot).mockImplementation((snapshot) => ({
      productTypes: snapshot.productTypes.map(pt => ({ config: pt, options: [] })),
      productFields: [{
        config: flavorTarget,
        options: [],
        attribute: snapshot.attributes.find(a => a.id === flavorTarget.attributeId),
      }],
      pages: [],
      hasAny: true,
    }) as unknown as ResolvedTargets);
  });

  it('proposes an in-constraint pick as a pending field_assignment with audit ids threaded', async () => {
    const snapshot = makeSnapshot();
    mocks.llmRankOptions.mockResolvedValue({
      values: ['Chicken'],
      confidence: 0.72,
      modelCallIds: ['mc-1'],
    });

    const result = await valueGapAbstainStage.execute(makeInput(), makeContext(snapshot));

    expect(mocks.llmRankOptions).toHaveBeenCalledTimes(1);
    const params = mocks.llmRankOptions.mock.calls[0][0];
    expect(params.protectedOperation).toBe('value_gap_resolution');
    // Constraint surface: ONLY the attribute's frozen allowedValues.
    expect(params.options.map((o: { value: string }) => o.value)).toEqual(['Chicken', 'Beef', 'Salmon']);
    expect(params.selectionMode).toBe('single');
    // Audit provenance is bound to the run + frozen snapshot.
    expect(params.modelPolicy).not.toBeNull();
    expect(params.modelCall?.operation).toBe('value_gap_resolution');
    expect(params.modelCall?.stage).toBe('value_gap_abstain');
    expect(params.modelCall?.runId).toBe('run-1');
    expect(params.snapshot?.snapshotHash).toBe('snap-hash-1');

    expect(result.status).toBe('succeeded');
    expect(out(result).proposals).toHaveLength(1);
    const proposal = out(result).proposals[0];
    expect(proposal.proposalType).toBe('field_assignment');
    expect(proposal.targetId).toBe('flavor');
    expect(proposal.proposedValue).toBe('Chicken');
    expect(proposal.status).toBe('pending');
    expect(proposal.isBulkAcceptable ?? false).toBe(false); // calibration never granted here
    expect(proposal.modelCallIds).toEqual(['mc-1']);
    const metadata = out(result).metadata as { proposedCount: number; abstainedCount: number; resolutions: Array<{ outcome: string }> };
    expect(metadata.proposedCount).toBe(1);
    expect(metadata.abstainedCount).toBe(0);
    expect(metadata.resolutions[0].outcome).toBe('proposed');
  });

  it('abstains deterministically when the ranker returns nothing (no proposal)', async () => {
    mocks.llmRankOptions.mockResolvedValue(null);
    const result = await valueGapAbstainStage.execute(makeInput(), makeContext(makeSnapshot()));
    expect(out(result).proposals).toEqual([]);
    const metadata = out(result).metadata as { resolutions: Array<{ outcome: string }> };
    expect(metadata.resolutions[0].outcome).toBe('value_gap_abstained');
  });

  it('excludes claim/composition attributes from the gap set without calling the LLM', async () => {
    const snapshot = makeSnapshot();
    snapshot.attributes.push(makeAttribute({ id: 'health-benefit', name: 'Health Benefit', allowedValues: ['Joint'], isClaim: true }));
    vi.mocked(resolveTargetsFromSnapshot).mockImplementation((s) => ({
      productTypes: [],
      productFields: [
        { config: flavorTarget, options: [], attribute: s.attributes[0] },
        {
          config: { ...flavorTarget, id: 'claim-target', label: 'Health Benefit', catalogField: 'ProductField21', attributeId: 'health-benefit' },
          options: [],
          attribute: s.attributes[1],
        },
      ],
      pages: [],
      hasAny: true,
    }) as unknown as ResolvedTargets);

    const input = makeInput({
      stageOutputs: {
        attribute_applicability: {
          evidence: [], proposals: [], abstained: false,
          metadata: { applicability: [{ attributeId: 'flavor', state: 'applicable' }, { attributeId: 'health-benefit', state: 'applicable' }] },
        },
        product_attribute_proposals: { evidence: [], proposals: [], abstained: false },
      },
    });
    mocks.llmRankOptions.mockResolvedValue({ values: ['Chicken'], confidence: 0.8, modelCallIds: ['mc-2'] });

    const result = await valueGapAbstainStage.execute(input, makeContext(snapshot));

    expect(mocks.llmRankOptions).toHaveBeenCalledTimes(1); // only flavor resolved
    const metadata = out(result).metadata as { resolutions: Array<{ attributeId: string; outcome: string }> };
    const claimRecord = metadata.resolutions.find(r => r.attributeId === 'health-benefit');
    expect(claimRecord?.outcome).toBe('skipped_claim_composition');
  });

  it('records no_evidence and skips the LLM when the packet has no target-relevant text', async () => {
    const input = makeInput({ evidence: [makeEvidenceRecord({ sourceField: 'ProductField99', value: 'Unrelated text for another field entirely.' })] });
    const result = await valueGapAbstainStage.execute(input, makeContext(makeSnapshot()));
    expect(mocks.llmRankOptions).not.toHaveBeenCalled();
    const metadata = out(result).metadata as { resolutions: Array<{ outcome: string }> };
    expect(metadata.resolutions[0].outcome).toBe('no_evidence');
  });
});

describe('valueGapAbstainStage — constraint enforcement (property/fuzz)', () => {
  beforeEach(() => {
    overrideUniversalTierFlags({ valueGapLlmEnabled: true });
    vi.mocked(resolveTargetsFromSnapshot).mockImplementation((snapshot) => ({
      productTypes: [],
      productFields: [{ config: flavorTarget, options: [], attribute: snapshot.attributes[0] }],
      pages: [],
      hasAny: true,
    }));
  });

  const ALLOWED = new Set(['Chicken', 'Beef', 'Salmon']);
  const POISON = ['Turducken', 'chicken extra spicy', '{"values":["Chicken"]}', '', 'Beef; Chicken', 42, null];

  function randomResponse(rand: () => number): unknown[] {
    // Random mix of allowed values and out-of-constraint noise; at least one
    // poisoned entry per response so EVERY response must fail closed.
    const values: unknown[] = [];
    const count = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < count; i++) {
      if (rand() < 0.5) values.push([...ALLOWED][Math.floor(rand() * ALLOWED.size)]);
      else values.push(POISON[Math.floor(rand() * POISON.length)]);
    }
    const STRING_POISON = POISON.filter((v): v is string => typeof v === 'string');
    values.push(STRING_POISON[Math.floor(rand() * STRING_POISON.length)]); // guaranteed string-level violation
    return values;
  }

  it('zero out-of-constraint responses can produce a proposal across fuzzed inputs', async () => {
    let seed = 20260824;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    let violationsBlocked = 0;
    for (let trial = 0; trial < 200; trial++) {
      const responseValues = randomResponse(rand);
      mocks.llmRankOptions.mockResolvedValueOnce({
        values: responseValues.filter(v => typeof v === 'string'),
        confidence: 0.9,
        modelCallIds: [`mc-fuzz-${trial}`],
      });
      const result = await valueGapAbstainStage.execute(makeInput(), makeContext(makeSnapshot()));
      const proposalsWithValue = out(result).proposals.filter(p => p.targetId === 'flavor');
      for (const p of proposalsWithValue) {
        expect(ALLOWED.has(String(p.proposedValue))).toBe(true);
      }
      // Violation check covers only STRING entries: the ranker contract filters
      // non-string values before the stage sees them (mirrored by the mock).
      const stringResponses = responseValues.filter((v): v is string => typeof v === 'string');
      if (stringResponses.some(v => !ALLOWED.has(v))) {
        violationsBlocked++;
        expect(proposalsWithValue).toHaveLength(0);
      }
    }
    // Every fuzzed trial carried a string-level violation, and every one was blocked.
    expect(violationsBlocked).toBe(200);
    expect(mocks.llmRankOptions).toHaveBeenCalledTimes(200);
  });
});

describe('value_gap_resolution — model operation registry registration', () => {
  it('is registered with versions, parameters, and its stage mapping (registry v3)', () => {
    expect(MODEL_OPERATION_REGISTRY_VERSION).toBe(3);
    expect(PROMPT_TEMPLATE_VERSIONS.value_gap_resolution).toBe('value-gap-resolution-prompt-v1');
    expect(RULE_VERSIONS.value_gap_resolution).toBe('value-gap-resolution-rules-v1');
    expect(OPERATION_PARAMETERS.value_gap_resolution).toEqual({ temperature: 0.0, maxTokens: null });
    expect(OPERATION_TO_STAGE.value_gap_resolution).toBe('value_gap_abstain');
  });
});
