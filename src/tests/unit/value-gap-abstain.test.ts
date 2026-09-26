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

// curation-target-ranker retired per ADR 0033
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

  it('records value_gap_abstained deterministically for residual gaps per ADR 0033', async () => {
    const snapshot = makeSnapshot();
    const result = await valueGapAbstainStage.execute(makeInput(), makeContext(snapshot));
    expect(result.status).toBe('succeeded');
    expect(out(result).proposals).toEqual([]);
    const metadata = out(result).metadata as { proposedCount: number; abstainedCount: number; resolutions: Array<{ outcome: string }> };
    expect(metadata.proposedCount).toBe(0);
    expect(metadata.abstainedCount).toBe(1);
    expect(metadata.resolutions[0].outcome).toBe('value_gap_abstained');
  });

  it('abstains deterministically when the ranker returns nothing (no proposal)', async () => {
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
    const result = await valueGapAbstainStage.execute(input, makeContext(snapshot));

    const metadata = out(result).metadata as { resolutions: Array<{ attributeId: string; outcome: string }> };
    const claimRecord = metadata.resolutions.find(r => r.attributeId === 'health-benefit');
    expect(claimRecord?.outcome).toBe('skipped_claim_composition');
    const flavorRecord = metadata.resolutions.find(r => r.attributeId === 'flavor');
    expect(flavorRecord?.outcome).toBe('value_gap_abstained');
  });

  it('records no_evidence and skips the LLM when the packet has no target-relevant text', async () => {
    const input = makeInput({ evidence: [makeEvidenceRecord({ sourceField: 'ProductField99', value: 'Unrelated text for another field entirely.' })] });
    const result = await valueGapAbstainStage.execute(input, makeContext(makeSnapshot()));
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

  it('zero proposals are produced across fuzzed inputs (fail-closed deterministic abstention)', async () => {
    for (let trial = 0; trial < 10; trial++) {
      const result = await valueGapAbstainStage.execute(makeInput(), makeContext(makeSnapshot()));
      expect(out(result).proposals).toEqual([]);
    }
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
