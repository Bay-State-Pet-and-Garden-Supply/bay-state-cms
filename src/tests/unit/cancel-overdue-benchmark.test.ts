import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { runStoreManagerOperationsMigration } from '../../db/store-manager-operations-migration';
import {
  createSchedule,
  createOccurrence,
  cancelOverdueOccurrences,
  type CreateScheduleInput,
} from '../../db/repositories/store-manager-schedule-repo';
import {
  createTrigger,
  createTriggerOccurrence,
  cancelOverdueTriggerOccurrences,
  type CreateTriggerInput,
} from '../../db/repositories/store-manager-trigger-repo';

const ws = 'ws-benchmark';

describe('cancelOverdueOccurrences benchmark', () => {
  const testDbPath = './test-benchmark-overdue.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    runStoreManagerOperationsMigration();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-shm`); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-wal`); } catch { /* ok */ }
  });

  it('benchmark cancelOverdueOccurrences with 200 overdue items', () => {
    const schedInput: CreateScheduleInput = {
      workspaceId: ws,
      name: 'Benchmark Schedule',
      templateKind: 'daily_catalog_health',
      timezone: 'UTC',
      recurrencePreset: 'daily',
      timeOfDay: '06:00',
      dayOfWeek: null,
      scopeJson: null,
      selectedModel: null,
      objective: 'Benchmark test',
      definitionHash: 'a'.repeat(64),
      policyProfileJson: null,
      enabled: true,
    };
    const schedule = createSchedule(schedInput);

    const count = 200;
    for (let i = 0; i < count; i++) {
      createOccurrence({
        workspaceId: ws,
        scheduleId: schedule.id,
        scheduleVersion: 1,
        occurrenceKey: `bench-sched-${i}-${randomUUID()}`,
        scheduledAt: '2020-01-01T00:00:00.000Z',
      });
    }

    const start = performance.now();
    const cancelled = cancelOverdueOccurrences(ws, '2026-01-01T00:00:00.000Z', 200);
    const duration = performance.now() - start;

    expect(cancelled).toBe(count);
    console.log(`[BENCHMARK] cancelOverdueOccurrences (${count} rows) took ${duration.toFixed(3)} ms`);
  });

  it('benchmark cancelOverdueTriggerOccurrences with 200 overdue items', () => {
    const trigInput: CreateTriggerInput = {
      workspaceId: ws,
      name: 'Benchmark Trigger',
      kind: 'sync_failed',
      config: { kind: 'sync_failed' },
      scopeJson: null,
      selectedModel: null,
      objective: 'Benchmark trigger test',
      definitionHash: 'b'.repeat(64),
      enabled: true,
    };
    const trigger = createTrigger(trigInput);

    const count = 200;
    for (let i = 0; i < count; i++) {
      createTriggerOccurrence({
        workspaceId: ws,
        triggerId: trigger.id,
        triggerVersion: 1,
        occurrenceKey: `bench-trig-${i}-${randomUUID()}`,
        sourceRef: { kind: 'manual', id: 'ref-1' },
        scopeJson: null,
        scheduledAt: '2020-01-01T00:00:00.000Z',
      });
    }

    const start = performance.now();
    const cancelled = cancelOverdueTriggerOccurrences(ws, '2026-01-01T00:00:00.000Z', 200);
    const duration = performance.now() - start;

    expect(cancelled).toBe(count);
    console.log(`[BENCHMARK] cancelOverdueTriggerOccurrences (${count} rows) took ${duration.toFixed(3)} ms`);
  });
});
