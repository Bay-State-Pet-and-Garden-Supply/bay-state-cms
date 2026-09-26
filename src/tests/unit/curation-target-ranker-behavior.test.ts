import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  callLlmForTask: vi.fn(),
  callLlmForTaskWithProvenance: vi.fn(),
  getLlmConfigForTask: vi.fn(() => ({
    provider: 'openai',
    model: 'test-model',
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'test',
  })),
}));

vi.mock('@/onboarding/llm-client', () => ({
  callLlmForTask: mocks.callLlmForTask,
  callLlmForTaskWithProvenance: mocks.callLlmForTaskWithProvenance,
  getLlmConfigForTask: mocks.getLlmConfigForTask,
  defaultProtectedOperationForTask: () => 'product_type_ranking',
}));
// The ranker now records terminal preflight rows; mock the repo so the
// bun:sqlite-backed module never loads in the Vitest graph.
vi.mock('@/db/repositories/classification-model-call-repo', () => ({
  recordTerminalPreflight: vi.fn(),
}));

import { llmRankOptions } from '../../classification/curation-target-ranker';
import { HeartbeatLostError } from '../../classification/heartbeat-errors';

const baseParams = {
  targetLabel: 'Flavor',
  options: [
    { value: 'chicken', label: 'Chicken' },
    { value: 'salmon', label: 'Salmon' },
  ],
  selectionMode: 'single' as const,
  evidenceText: 'Official packaging says chicken recipe for adult dogs.',
  // Protected ranking requires a frozen policy context (issue #17 pass 1c).
  modelPolicy: {} as unknown as import('../../classification/model-policy-gateway').ModelPolicyView,
};

describe('curation target ranker response handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('abstains without any LLM call when no modelPolicy is supplied (pass 1c)', async () => {
    const { targetLabel, options, selectionMode, evidenceText } = baseParams;
    await expect(
      llmRankOptions({ targetLabel, options, selectionMode, evidenceText }),
    ).resolves.toBeNull();
    expect(mocks.callLlmForTask).not.toHaveBeenCalled();
    expect(mocks.getLlmConfigForTask).not.toHaveBeenCalled();
  });

  it('records an observable unavailable terminal row on the no-policy preflight (pass 4b)', async () => {
    const mocks2 = await import('../../db/repositories/classification-model-call-repo');
    const { targetLabel, options, selectionMode, evidenceText } = baseParams;
    const { llmRankOptions } = await import('../../classification/curation-target-ranker');
    // With an audit context but no frozen policy, the preflight must both
    // abstain AND record a durable unavailable terminal row.
    await expect(
      llmRankOptions({
        targetLabel,
        options,
        selectionMode,
        evidenceText,
        modelCall: {
          runId: 'run-1',
          snapshotHash: 'a'.repeat(64),
          stage: 'product_attribute_proposals',
          operation: 'attribute_ranking',
          attempt: 1,
          promptTemplateVersion: 'attribute-ranking-prompt-v1',
          ruleVersion: 'attribute-ranking-rules-v1',
        },
        snapshot: {} as any,
      }),
    ).resolves.toBeNull();
    expect((mocks2 as any).recordTerminalPreflight).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'attribute_ranking' }),
      '',
      'unavailable',
      expect.any(String),
    );
  });

  it('does not retry a valid empty abstention', async () => {
    mocks.callLlmForTaskWithProvenance.mockResolvedValueOnce({ content: '{"values":[],"confidence":0}', callId: 'c1', provider: 'openai', model: 'test-model', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });

    await expect(llmRankOptions(baseParams)).resolves.toBeNull();
    expect(mocks.callLlmForTaskWithProvenance).toHaveBeenCalledTimes(1);
    expect(mocks.callLlmForTask).not.toHaveBeenCalled();
  });

  it('retries once after invalid JSON and accepts repaired JSON', async () => {
    mocks.callLlmForTaskWithProvenance
      .mockResolvedValueOnce({ content: 'not valid json', callId: 'c1', provider: 'openai', model: 'test-model', usage: { promptTokens: null, completionTokens: null, totalTokens: null } })
      .mockResolvedValueOnce({ content: '{"values":["Chicken"],"confidence":0.8}', callId: 'c2', provider: 'openai', model: 'test-model', usage: { promptTokens: null, completionTokens: null, totalTokens: null } });

    await expect(llmRankOptions(baseParams)).resolves.toEqual({
      values: ['Chicken'],
      confidence: 0.8,
      // BOTH influencing calls are linked: the primary parse failed, so the
      // retry prompt embedded the first response and both influenced the
      // accepted output.
      modelCallIds: ['c1', 'c2'],
    });
    expect(mocks.callLlmForTaskWithProvenance).toHaveBeenCalledTimes(2);
  });

  it('does not retry a valid non-empty response', async () => {
    mocks.callLlmForTaskWithProvenance.mockResolvedValueOnce(
      { content: '{"values":["Salmon"],"confidence":0.7}', callId: 'c3', provider: 'openai', model: 'test-model', usage: { promptTokens: null, completionTokens: null, totalTokens: null } },
    );

    await expect(llmRankOptions(baseParams)).resolves.toEqual({
      values: ['Salmon'],
      confidence: 0.7,
      modelCallIds: ['c3'],
    });
    expect(mocks.callLlmForTaskWithProvenance).toHaveBeenCalledTimes(1);
    expect(mocks.callLlmForTask).not.toHaveBeenCalled();
  });

  it('P1-1: a healthy assertHeld is invoked around the transport (before + after the await) and the call still succeeds', async () => {
    const assertHeld = vi.fn();
    mocks.callLlmForTaskWithProvenance.mockResolvedValueOnce(
      { content: '{"values":["Salmon"],"confidence":0.7}', callId: 'c3', provider: 'openai', model: 'test-model', usage: { promptTokens: null, completionTokens: null, totalTokens: null } },
    );

    await expect(llmRankOptions({ ...baseParams, assertHeld })).resolves.toEqual({
      values: ['Salmon'],
      confidence: 0.7,
      modelCallIds: ['c3'],
    });
    // Exactly one pre-await + one post-await assertion (no retry).
    expect(assertHeld).toHaveBeenCalledTimes(2);
    expect(mocks.callLlmForTaskWithProvenance).toHaveBeenCalledTimes(1);
  });

  it('P1-1: assertHeld runs BEFORE the no-policy terminal preflight row (a stale owner never writes it)', async () => {
    const assertHeld = vi.fn();
    const { targetLabel, options, selectionMode, evidenceText } = baseParams;
    await expect(
      llmRankOptions({ targetLabel, options, selectionMode, evidenceText, assertHeld }),
    ).resolves.toBeNull();
    expect(assertHeld).toHaveBeenCalledTimes(1);
    expect(mocks.callLlmForTaskWithProvenance).not.toHaveBeenCalled();
  });

  it('P1-1: ownership lost mid-transport (post-await assertion throws) aborts with HeartbeatLostError — never an abstain, no retry', async () => {
    let calls = 0;
    const assertHeld = vi.fn(() => {
      calls++;
      if (calls > 1) throw new HeartbeatLostError('Claim ownership lost during a long-running operation (run r1 is no longer claimed by worker-a).');
    });
    mocks.callLlmForTaskWithProvenance.mockResolvedValueOnce(
      { content: '{"values":["Chicken"],"confidence":0.8}', callId: 'c1', provider: 'openai', model: 'test-model', usage: { promptTokens: null, completionTokens: null, totalTokens: null } },
    );

    await expect(llmRankOptions({ ...baseParams, assertHeld })).rejects.toBeInstanceOf(HeartbeatLostError);
    // The pre-await assertion passed, the post-await one rejected — and the
    // ownership-loss exception was NOT swallowed into a null/abstain result.
    expect(calls).toBe(2);
    expect(mocks.callLlmForTaskWithProvenance).toHaveBeenCalledTimes(1);
  });

  it('P1-1: ownership lost BEFORE the transport (pre-await assertion throws) aborts with HeartbeatLostError and never starts a transport', async () => {
    const assertHeld = vi.fn(() => {
      throw new HeartbeatLostError('Claim ownership already lost at operation start (run r1 is no longer claimed by worker-a).');
    });

    await expect(llmRankOptions({ ...baseParams, assertHeld })).rejects.toBeInstanceOf(HeartbeatLostError);
    expect(assertHeld).toHaveBeenCalledTimes(1);
    expect(mocks.callLlmForTaskWithProvenance).not.toHaveBeenCalled();
  });
});

describe('LLM propose gate (epic #46 review round)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("abstains when the model's own confidence is below the 0.5 propose gate", async () => {
    // The live-batch failure shape: qwen2.5vl ranked "Poultry Feed" for a
    // beehive feeder with a floor-level 0.35 confidence and no keyword
    // evidence. Such a weak guess is noise, not a decision.
    mocks.callLlmForTaskWithProvenance.mockResolvedValueOnce(
      { content: '{"values":["Poultry Feed"],"confidence":0.3}', callId: 'c-low', provider: 'ollama', model: 'qwen2.5vl:latest', usage: { promptTokens: null, completionTokens: null, totalTokens: null } },
    );

    await expect(llmRankOptions(baseParams)).resolves.toBeNull();
    expect(mocks.callLlmForTaskWithProvenance).toHaveBeenCalledTimes(1);
  });

  it('still proposes at exactly 0.5 (the gate is inclusive)', async () => {
    mocks.callLlmForTaskWithProvenance.mockResolvedValueOnce(
      { content: '{"values":["Chicken"],"confidence":0.5}', callId: 'c5', provider: 'openai', model: 'test-model', usage: { promptTokens: null, completionTokens: null, totalTokens: null } },
    );

    await expect(llmRankOptions(baseParams)).resolves.toEqual({
      values: ['Chicken'],
      confidence: 0.5,
      modelCallIds: ['c5'],
    });
  });

  it('proposes when the model omits confidence (defaults to 0.55)', async () => {
    mocks.callLlmForTaskWithProvenance.mockResolvedValueOnce(
      { content: '{"values":["Chicken"]}', callId: 'c6', provider: 'openai', model: 'test-model', usage: { promptTokens: null, completionTokens: null, totalTokens: null } },
    );

    await expect(llmRankOptions(baseParams)).resolves.toEqual({
      values: ['Chicken'],
      confidence: 0.55,
      modelCallIds: ['c6'],
    });
  });
});

describe('LLM margin gate (epic #46 Package C)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('abstains when the top pick is barely ahead of the runner-up (margin < 0.1)', async () => {
    mocks.callLlmForTaskWithProvenance.mockResolvedValueOnce(
      { content: '{"values":["Chicken","Salmon"],"scores":[0.55,0.5],"confidence":0.55}', callId: 'c-m1', provider: 'openai', model: 'test-model', usage: { promptTokens: null, completionTokens: null, totalTokens: null } },
    );

    await expect(llmRankOptions(baseParams)).resolves.toBeNull();
    expect(mocks.callLlmForTaskWithProvenance).toHaveBeenCalledTimes(1);
  });

  it('proposes when the top pick leads by a clear margin', async () => {
    mocks.callLlmForTaskWithProvenance.mockResolvedValueOnce(
      { content: '{"values":["Chicken","Salmon"],"scores":[0.8,0.3],"confidence":0.8}', callId: 'c-m2', provider: 'openai', model: 'test-model', usage: { promptTokens: null, completionTokens: null, totalTokens: null } },
    );

    await expect(llmRankOptions(baseParams)).resolves.toEqual({
      values: ['Chicken'],
      confidence: 0.8,
      modelCallIds: ['c-m2'],
    });
  });

  it('skips the margin gate when scores are absent', async () => {
    mocks.callLlmForTaskWithProvenance.mockResolvedValueOnce(
      { content: '{"values":["Chicken"],"confidence":0.6}', callId: 'c-m3', provider: 'openai', model: 'test-model', usage: { promptTokens: null, completionTokens: null, totalTokens: null } },
    );

    await expect(llmRankOptions(baseParams)).resolves.toEqual({
      values: ['Chicken'],
      confidence: 0.6,
      modelCallIds: ['c-m3'],
    });
  });

  it('applies only the confidence gate for a single value even with scores', async () => {
    mocks.callLlmForTaskWithProvenance.mockResolvedValueOnce(
      { content: '{"values":["Chicken"],"scores":[0.45],"confidence":0.45}', callId: 'c-m4', provider: 'openai', model: 'test-model', usage: { promptTokens: null, completionTokens: null, totalTokens: null } },
    );

    await expect(llmRankOptions(baseParams)).resolves.toBeNull();
  });

  it('fails closed on malformed scores (length mismatch with values) — abstains, never proposes (review round 2 MEDIUM-3)', async () => {
    mocks.callLlmForTaskWithProvenance.mockResolvedValueOnce(
      { content: '{"values":["Chicken","Salmon"],"scores":[0.9],"confidence":0.8}', callId: 'c-m5', provider: 'openai', model: 'test-model', usage: { promptTokens: null, completionTokens: null, totalTokens: null } },
    );

    await expect(llmRankOptions(baseParams)).resolves.toBeNull();
  });

  it('uses the raw-score spread even when a non-option value sits in the list', async () => {
    // Scores [0.55, 0.9, 0.3]: top raw score 0.9 leads 0.55 by 0.35 — the
    // margin gate passes and the accepted option (Chicken, single mode) is
    // proposed even though "made-up" isn't an allowed option.
    mocks.callLlmForTaskWithProvenance.mockResolvedValueOnce(
      { content: '{"values":["Chicken","made-up","Salmon"],"scores":[0.55,0.9,0.3],"confidence":0.7}', callId: 'c-m6', provider: 'openai', model: 'test-model', usage: { promptTokens: null, completionTokens: null, totalTokens: null } },
    );

    await expect(llmRankOptions(baseParams)).resolves.toEqual({
      values: ['Chicken'],
      confidence: 0.7,
      modelCallIds: ['c-m6'],
    });
  });
});
