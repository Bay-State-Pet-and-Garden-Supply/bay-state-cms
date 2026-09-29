import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import {
  upsertLlmTaskConfig,
  deleteLlmTaskConfig,
} from '../../db/repositories/llm-task-config-repo';
import { getAiModelCallsByWorkspace } from '../../db/repositories/ai-model-call-repo';
import { callLlmForTask } from '../../onboarding/llm-client';

describe('General Task Fallback & Telemetry Integration', () => {
  const testDbPath = 'src/tests/unit/general-task-fallback-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();

    // AI Compute isolation: a stale DB file (e.g. left by a killed `bun
    // test` process whose afterAll unlink never ran) may carry
    // provider_connections rows, workload routes, or routing defaults that
    // flip isAiComputeConfigured() on. AI Compute is authoritative once
    // configured and would divert this live task into the dispatcher, so
    // reset to the pristine-install state — the seeded builtins/defaults
    // re-seed lazily via ensureSeededDefaults() and the legacy
    // llm_task_configs/api_keys chain below only resolves on pristine
    // installs.
    getDb().run('DELETE FROM ai_workload_routes');
    getDb().run('DELETE FROM provider_connections');
    getDb().run('DELETE FROM ai_routing_defaults');

    upsertApiKey('ollama', 'ollama-key', 'http://127.0.0.1:59999/v1', 'gemma4:12b-mlx');
    upsertApiKey('deepseek', 'sk-test-fallback-key', 'http://127.0.0.1:59998/v1', 'deepseek-v4-flash');
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  test('callLlmForTask logs telemetry start/terminal and escalates to fallback on primary transport failure', async () => {
    upsertLlmTaskConfig({
      task: 'product_field_refactor',
      provider: 'ollama',
      model: 'gemma4:12b-mlx',
      fallbackProvider: 'deepseek',
      fallbackModel: 'deepseek-v4-flash',
    });

    // Mock global fetch to simulate primary port failure and fallback success
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('59999')) {
        throw new Error('Connection refused to local Ollama on port 59999');
      }
      if (url.includes('59998')) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Refactored field' } }],
            usage: { prompt_tokens: 50, completion_tokens: 15 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof fetch;

    try {
      const output = await callLlmForTask('product_field_refactor', 'Refactor field');
      expect(output).toBe('Refactored field');

      // Verify ai_model_calls wrote 2 telemetry rows (primary failure + fallback success)
      const calls = getAiModelCallsByWorkspace('default');
      expect(calls.length).toBeGreaterThanOrEqual(2);

      const primaryCall = calls.find((c) => !c.fallback_from_call_id);
      const fallbackCall = calls.find((c) => c.fallback_from_call_id);

      expect(primaryCall).toBeDefined();
      expect(fallbackCall).toBeDefined();

      if (primaryCall && fallbackCall) {
        expect(primaryCall.task).toBe('product_field_refactor');
        expect(primaryCall.provider).toBe('ollama');
        expect(primaryCall.status).toBe('failed');

        expect(fallbackCall.task).toBe('product_field_refactor');
        expect(fallbackCall.provider).toBe('deepseek');
        expect(fallbackCall.status).toBe('success');
        expect(fallbackCall.fallback_from_call_id).toBe(primaryCall.id);
        expect(fallbackCall.retry_count).toBe(1);
        expect(fallbackCall.prompt_tokens).toBe(50);
        expect(fallbackCall.completion_tokens).toBe(15);
        expect(fallbackCall.cost_basis).toBe('published_rate');
      }
    } finally {
      globalThis.fetch = originalFetch;
      deleteLlmTaskConfig('product_field_refactor');
    }
  });
});
