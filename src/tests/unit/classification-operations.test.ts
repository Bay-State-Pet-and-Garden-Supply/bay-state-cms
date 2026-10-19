import { describe, expect, it, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import classificationOperationsRoutes from '../../server/routes/classification-operations-routes';

const workspaceId = 'ws-ops-26';
let workspacePath = '';

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-ops-26-'));
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'ops',
    workspacePath,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
  // getCurrentWorkspace reads the workspace table; ensure ours is the one.
  getDb().run(`DELETE FROM workspace WHERE id != ?`, [workspaceId]);
});

describe('classification operations aggregates (P2 #26)', () => {
  it('returns zeroed aggregates on an empty window without sensitive text', async () => {
    const app = new Hono();
    app.route('/api', classificationOperationsRoutes);
    const res = await app.request('/api/classification-operations');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      workspaceId: string; modelCalls: { total: number }; ocr: { textOnlyRuns: number; imageRuns: number }; queue: { activeRequests: number };
    };
    expect(body.workspaceId).toBe(workspaceId);
    expect(body.modelCalls.total).toBe(0);
    expect(body.ocr.textOnlyRuns).toBe(0);
    const text = JSON.stringify(body);
    expect(text).not.toContain('password');
    expect(text).not.toContain('merchant');
    expect(text).not.toContain('token');
  });

  it('separates success, timeout, empty, and missing-image outcomes', async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const runId = 'run-ops-1';
    db.run(
      `INSERT INTO classification_runs (id, workspace_id, onboarding_item_id, source_kind, source_product_hash, product_sku, config_snapshot_id, config_snapshot_hash, status, started_at, cohort_run_id)
       VALUES (?, ?, NULL, 'catalog_product', NULL, 'SKU-OPS', NULL, NULL, 'completed', ?, NULL)`,
      [runId, workspaceId, now],
    );
    // One success + one failed (timeout-shaped) model call.
    db.run(
      `INSERT INTO classification_model_calls (id, run_id, stage_name, operation, attempt, provider, model, locality, snapshot_hash, model_policy_digest, prompt_template_version, rule_version, system_prompt_hash, user_prompt_hash, status, duration_ms, error_message, started_at, created_at)
       VALUES ('call-ok', ?, 'evidence_extraction', 'evidence_extraction', 1, 'ollama', 'qwen2.5vl:latest', 'local', 'snap', 'digest', 'v1', 'v3', 's', 'u', 'success', 1200, NULL, ?, ?)`,
      [runId, now, now],
    );
    db.run(
      `INSERT INTO classification_model_calls (id, run_id, stage_name, operation, attempt, provider, model, locality, snapshot_hash, model_policy_digest, prompt_template_version, rule_version, system_prompt_hash, user_prompt_hash, status, duration_ms, error_message, started_at, created_at)
       VALUES ('call-timeout', ?, 'evidence_extraction', 'evidence_extraction', 1, 'ollama', 'qwen2.5vl:latest', 'local', 'snap', 'digest', 'v1', 'v3', 's', 'u', 'failed', 90000, 'vision timeout after 120s', ?, ?)`,
      [runId, now, now],
    );
    // One image run (succeeded image) + one text-only run (no summary).
    db.run(
      `INSERT INTO classification_stage_results (id, run_id, stage_name, status, output_json, started_at, completed_at)
       VALUES ('stage-img', ?, 'evidence_extraction', 'succeeded', ?, ?, ?)`,
      [runId, JSON.stringify({ metadata: { ocrSummary: { status: 'succeeded', images: [{ status: 'succeeded' }] } } }), now, now],
    );

    const app = new Hono();
    app.route('/api', classificationOperationsRoutes);
    const res = await app.request('/api/classification-operations');
    const body = await res.json() as {
      modelCalls: { total: number; byStatus: Record<string, number> };
      ocr: { textOnlyRuns: number; imageRuns: number; succeededImages: number; failedImages: number };
    };
    expect(body.modelCalls.total).toBe(2);
    expect(body.modelCalls.byStatus['success']).toBe(1);
    expect(body.modelCalls.byStatus['failed']).toBe(1);
  });
});
