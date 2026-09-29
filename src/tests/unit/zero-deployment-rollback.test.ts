import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import {
  upsertLlmTaskConfig,
  getLlmTaskConfig,
  deleteLlmTaskConfig,
} from '../../db/repositories/llm-task-config-repo';
import { getLlmConfigForTask } from '../../onboarding/llm-client';

describe('Zero-Deployment Rollback & End-to-End Route Resolution (PR 6)', () => {
  const testDbPath = 'src/tests/unit/zero-deployment-rollback-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();

    // AI Compute isolation: a stale DB file (e.g. left by a killed `bun
    // test` process whose afterAll unlink never ran) may carry
    // provider_connections rows, workload routes, or routing defaults that
    // flip isAiComputeConfigured() on. AI Compute is authoritative once
    // configured, so reset to the pristine-install state — the seeded
    // builtins/defaults re-seed lazily via ensureSeededDefaults() and the
    // legacy api_keys/llm_task_configs chain below only resolves on
    // pristine installs.
    getDb().run('DELETE FROM ai_workload_routes');
    getDb().run('DELETE FROM provider_connections');
    getDb().run('DELETE FROM ai_routing_defaults');

    // Seed credentials for providers
    upsertApiKey('ollama', 'ollama-key', 'http://localhost:11434/v1', 'gemma4:12b-mlx');
    upsertApiKey('deepseek', 'sk-test-deepseek-key-12345', 'https://api.deepseek.com', 'deepseek-v4-flash');
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  test('promotes task to local route gemma4:12b-mlx with fallback deepseek-v4-flash', () => {
    const config = upsertLlmTaskConfig({
      task: 'product_field_refactor',
      provider: 'ollama',
      model: 'gemma4:12b-mlx',
      fallbackProvider: 'deepseek',
      fallbackModel: 'deepseek-v4-flash',
    });

    expect(config.provider).toBe('ollama');
    expect(config.model).toBe('gemma4:12b-mlx');
    expect(config.fallbackProvider).toBe('deepseek');
    expect(config.fallbackModel).toBe('deepseek-v4-flash');

    // Transport client resolves configured local Ollama route
    const resolvedConfig = getLlmConfigForTask('product_field_refactor');
    expect(resolvedConfig).not.toBeNull();
    expect(resolvedConfig?.provider).toBe('ollama');
    expect(resolvedConfig?.model).toBe('gemma4:12b-mlx');
  });

  test('instantly rolls back route to DeepSeek cloud baseline on sequential invocation with zero code deployment', () => {
    // 1. Initial invocation resolves Ollama local candidate
    const routeBefore = getLlmConfigForTask('product_field_refactor');
    expect(routeBefore?.provider).toBe('ollama');

    // 2. Zero-deployment rollback: update the database task config row directly
    const updated = upsertLlmTaskConfig({
      task: 'product_field_refactor',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      fallbackProvider: null,
      fallbackModel: null,
    });

    expect(updated.provider).toBe('deepseek');
    expect(updated.model).toBe('deepseek-v4-flash');

    // 3. Immediate sequential invocation resolves DeepSeek cloud baseline without server restart or redeployment
    const routeAfter = getLlmConfigForTask('product_field_refactor');
    expect(routeAfter?.provider).toBe('deepseek');
    expect(routeAfter?.model).toBe('deepseek-v4-flash');
    expect(routeAfter?.apiKey).toBe('sk-test-deepseek-key-12345');

    deleteLlmTaskConfig('product_field_refactor');
  });
});
