import { describe, it, expect, beforeAll } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createRun, completeRun } from '../../db/repositories/classification-run-repo';
import {
  insertModelCallStart,
  completeModelCall,
  insertTerminalModelCall,
  getModelCallsByRun,
  getModelCallById,
  verifyModelCallsBelongToRun,
  computeModelCallCost,
  recordTerminalPreflight,
} from '../../db/repositories/classification-model-call-repo';
import { MODEL_CALL_STATUS, COST_BASIS } from '../../classification/model-operation-registry';

let workspacePath: string;
let workspaceId: string;

const HASH = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);

function makeStart(runId: string, overrides: Record<string, unknown> = {}) {
  return {
    runId,
    stageName: 'product_attribute_proposals',
    operation: 'attribute_ranking',
    attempt: 1,
    provider: 'ollama',
    model: 'llama3',
    locality: 'local',
    snapshotHash: HASH,
    modelPolicyDigest: DIGEST,
    promptTemplateVersion: 'attribute-ranking-prompt-v1',
    ruleVersion: 'attribute-ranking-rules-v1',
    systemPromptHash: 's'.repeat(64),
    userPromptHash: 'u'.repeat(64),
    ...overrides,
  };
}

describe('classification model-call repo (issue #17 E)', () => {
  beforeAll(() => {
    workspaceId = randomUUID();
    workspacePath = path.join(os.tmpdir(), `baystate-cms-model-calls-${workspaceId.slice(0, 8)}`);
    fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
    initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
    runMigrations();
    insertWorkspace({ id: workspaceId, name: 'test', workspacePath, gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });
  });

  it('inserts a started row with all audit fields', () => {
    const run = createRun(workspaceId, 'SKU-1', null, HASH, { sourceKind: 'catalog_product', sourceProductHash: 'p1' });
    const callId = insertModelCallStart(makeStart(run.id));
    const row = getModelCallById(callId)!;
    expect(row.status).toBe(MODEL_CALL_STATUS.started);
    expect(row.run_id).toBe(run.id);
    expect(row.operation).toBe('attribute_ranking');
    expect(row.stage_name).toBe('product_attribute_proposals');
    expect(row.attempt).toBe(1);
    expect(row.provider).toBe('ollama');
    expect(row.model).toBe('llama3');
    expect(row.locality).toBe('local');
    expect(row.snapshot_hash).toBe(HASH);
    expect(row.model_policy_digest).toBe(DIGEST);
    expect(row.prompt_template_version).toBe('attribute-ranking-prompt-v1');
    expect(row.rule_version).toBe('attribute-ranking-rules-v1');
    expect(row.system_prompt_hash).toBe('s'.repeat(64));
    expect(row.user_prompt_hash).toBe('u'.repeat(64));
    expect(row.ended_at).toBeNull();
  });

  it('start-insert fails closed on a missing run (FK violation)', () => {
    expect(() => insertModelCallStart(makeStart('no-such-run'))).toThrow();
  });

  it('completes a started call to success with tokens and honest local cost', () => {
    const run = createRun(workspaceId, 'SKU-2', null, HASH, { sourceKind: 'catalog_product', sourceProductHash: 'p2' });
    const callId = insertModelCallStart(makeStart(run.id));
    const ok = completeModelCall(callId, {
      status: MODEL_CALL_STATUS.success,
      durationMs: 12,
      promptTokens: 10,
      completionTokens: 5,
      estimatedCostUsd: 0,
      costBasis: COST_BASIS.localZero,
    });
    expect(ok).toBe(true);
    const row = getModelCallById(callId)!;
    expect(row.status).toBe(MODEL_CALL_STATUS.success);
    expect(row.prompt_tokens).toBe(10);
    expect(row.completion_tokens).toBe(5);
    expect(row.duration_ms).toBe(12);
    expect(row.estimated_cost_usd).toBe(0);
    expect(row.cost_basis).toBe(COST_BASIS.localZero);
    // A second update on a terminal row is a no-op (returns false).
    expect(completeModelCall(callId, { status: MODEL_CALL_STATUS.failed })).toBe(false);
  });

  it('records policy_denied and unavailable terminal rows without transport', () => {
    const run = createRun(workspaceId, 'SKU-3', null, HASH, { sourceKind: 'catalog_product', sourceProductHash: 'p3' });
    const denied = insertTerminalModelCall({
      ...makeStart(run.id, { provider: null, model: null, locality: null }),
      status: MODEL_CALL_STATUS.policyDenied,
      errorMessage: 'Model policy denied (text_local_only_non_local_provider)',
    });
    const unavailable = insertTerminalModelCall({
      ...makeStart(run.id, { provider: null, model: null, locality: null }),
      status: MODEL_CALL_STATUS.unavailable,
      errorMessage: 'No LLM config available',
    });
    expect(getModelCallById(denied)!.status).toBe(MODEL_CALL_STATUS.policyDenied);
    expect(getModelCallById(unavailable)!.status).toBe(MODEL_CALL_STATUS.unavailable);
  });

  it('redacts and bounds error messages persisted to call rows', () => {
    const run = createRun(workspaceId, 'SKU-4', null, HASH, { sourceKind: 'catalog_product', sourceProductHash: 'p4' });
    const callId = insertModelCallStart(makeStart(run.id));
    const secret = `provider error {\"api_key\":\"supersecret\"} Authorization: Basic dXNlcjpwYXNz` + 'x'.repeat(500);
    completeModelCall(callId, { status: MODEL_CALL_STATUS.failed, errorMessage: secret });
    const row = getModelCallById(callId)!;
    expect(row.error_message).not.toContain('supersecret');
    expect(row.error_message).not.toContain('dXNlcjpwYXNz');
    expect(row.error_message!.length).toBeLessThan(300);
  });

  it('FK cascade removes call rows when the run is deleted; unrelated runs remain', () => {
    const runA = createRun(workspaceId, 'SKU-A', null, HASH, { sourceKind: 'catalog_product', sourceProductHash: 'pA' });
    const runB = createRun(workspaceId, 'SKU-B', null, HASH, { sourceKind: 'catalog_product', sourceProductHash: 'pB' });
    insertModelCallStart(makeStart(runA.id));
    insertModelCallStart(makeStart(runB.id));
    getDb().run('DELETE FROM classification_runs WHERE id = ?', [runA.id]);
    expect(getModelCallsByRun(runA.id)).toHaveLength(0);
    expect(getModelCallsByRun(runB.id)).toHaveLength(1);
  });

  it('verifyModelCallsBelongToRun enforces run + snapshot linkage', () => {
    const run = createRun(workspaceId, 'SKU-5', null, HASH, { sourceKind: 'catalog_product', sourceProductHash: 'p5' });
    const otherRun = createRun(workspaceId, 'SKU-6', null, HASH, { sourceKind: 'catalog_product', sourceProductHash: 'p6' });
    const sameCall = insertModelCallStart(makeStart(run.id));
    const otherCall = insertModelCallStart(makeStart(otherRun.id));
    expect(verifyModelCallsBelongToRun(run.id, HASH, [sameCall])).toEqual({ ok: true, missing: [] });
    const bad = verifyModelCallsBelongToRun(run.id, HASH, [sameCall, otherCall]);
    expect(bad.ok).toBe(false);
    expect(bad.missing).toEqual([otherCall]);
    const wrongSnap = verifyModelCallsBelongToRun(run.id, 'f'.repeat(64), [sameCall]);
    expect(wrongSnap.ok).toBe(false);
    expect(verifyModelCallsBelongToRun(run.id, HASH, ['no-such-call']).ok).toBe(false);
  });

  it('computeModelCallCost: local → honest zero, cloud/unknown → null + unknown', () => {
    expect(computeModelCallCost('local', 10, 5)).toEqual({ estimatedCostUsd: 0, costBasis: COST_BASIS.localZero });
    expect(computeModelCallCost('cloud', 10, 5)).toEqual({ estimatedCostUsd: null, costBasis: COST_BASIS.unknown });
    expect(computeModelCallCost(null, 10, 5)).toEqual({ estimatedCostUsd: null, costBasis: COST_BASIS.unknown });
  });

  it('getModelCallsByRun returns calls in start order', () => {
    const run = createRun(workspaceId, 'SKU-7', null, HASH, { sourceKind: 'catalog_product', sourceProductHash: 'p7' });
    insertModelCallStart(makeStart(run.id, { operation: 'evidence_extraction' }));
    insertModelCallStart(makeStart(run.id, { operation: 'attribute_ranking' }));
    const calls = getModelCallsByRun(run.id);
    expect(calls.map(c => c.operation)).toEqual(['evidence_extraction', 'attribute_ranking']);
  });

  it('recordTerminalPreflight writes an observable unavailable/policy_denied row (pass 4b)', () => {
    const run = createRun(workspaceId, 'SKU-8', null, HASH, { sourceKind: 'catalog_product', sourceProductHash: 'p8' });
    const ctx = {
      runId: run.id,
      snapshotHash: HASH,
      stage: 'product_attribute_proposals' as const,
      operation: 'attribute_ranking' as const,
      attempt: 1,
      promptTemplateVersion: 'attribute-ranking-prompt-v1',
      ruleVersion: 'attribute-ranking-rules-v1',
    };
    recordTerminalPreflight(ctx, 'd'.repeat(64), 'unavailable', 'No LLM config available.');
    recordTerminalPreflight(ctx, 'd'.repeat(64), 'policy_denied', 'Model policy denied.');
    const rows = getModelCallsByRun(run.id);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.status).sort()).toEqual(['policy_denied', 'unavailable']);
    expect(rows[0].snapshot_hash).toBe(HASH);
    expect(rows[0].operation).toBe('attribute_ranking');
    // No-op without a context.
    recordTerminalPreflight(null, '', 'unavailable', 'nope');
    expect(getModelCallsByRun(run.id)).toHaveLength(2);
  });

  it('stores and updates requested_model, resolved_model, and typed_result_json (#297)', () => {
    const run = createRun(workspaceId, 'SKU-9', null, HASH, { sourceKind: 'catalog_product', sourceProductHash: 'p9' });
    const callId = insertModelCallStart({
      ...makeStart(run.id),
      provider: 'typesafe',
      model: 'jev-1.13.0',
      requestedModel: 'jev-1.13.0',
    });

    const startRow = getModelCallById(callId)!;
    expect(startRow.requested_model).toBe('jev-1.13.0');
    expect(startRow.resolved_model).toBeNull();
    expect(startRow.typed_result_json).toBeNull();

    const typedMetadata = {
      questionId: 'primary_product_type',
      choice: 'opt_1',
      selectedProbability: 0.88,
      vendorConfidence: 0.94,
      basis: 'choice_probability',
    };

    const completed = completeModelCall(callId, {
      status: MODEL_CALL_STATUS.success,
      durationMs: 45,
      resolvedModel: 'jev-1.13.0',
      typedResultMetadata: typedMetadata,
    });
    expect(completed).toBe(true);

    const completedRow = getModelCallById(callId)!;
    expect(completedRow.requested_model).toBe('jev-1.13.0');
    expect(completedRow.resolved_model).toBe('jev-1.13.0');
    expect(completedRow.typed_result_json).toBe(JSON.stringify(typedMetadata));
  });
});
