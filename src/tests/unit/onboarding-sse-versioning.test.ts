/**
 * Slice 4-SERVER — SSE representation versioning (Bun, UNCONDITIONAL).
 *
 * Route-level contract for GET /api/onboarding/batches/:id/events:
 * - v1 (absent/unversioned param) is byte-identical legacy: exact welcome
 *   shape + exact event passthrough.
 * - v2 (?stageVocabularyVersion=2) emits typed connection frames and
 *   sanitized bounded envelopes; named event types unchanged; missing stage
 *   stays absent; unmappable stages are dropped; raw errors/URLs/tokens
 *   never reach the wire.
 * - invalid version rejects BEFORE the stream opens; unknown batches 404.
 *
 * Isolated temp DBs, no network. Batch is paused so the endpoint's worker
 * accessor stays inert; the worker is stopped after every case.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch, updateBatchExecutionState } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { onboardingEvents } from '../../onboarding/sse-emitter';
import { LIVE_ACTIVITY_STAGE_STATUSES } from '../../shared/schemas/onboarding-live-activity';
import { StageStatusEnum } from '../../shared/schemas/onboarding';
import onboardingRoutes, { resetActiveWorkerForTest } from '../../server/routes/onboarding-routes';

let workspaceId: string;
let batchId: string;
let app: Hono;
let readers: Array<ReadableStreamDefaultReader<Uint8Array>> = [];

function makeWorkspace(): void {
  workspaceId = randomUUID();
  const workspacePath = path.join(os.tmpdir(), `ws-sse-version-${workspaceId.slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'test',
    workspacePath,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
  const batch = createBatch({ workspaceId, name: 'SSE batch', fileName: 'test.csv', totalItems: 0 });
  batchId = batch.id;
  // Paused: the endpoint's getWorker() accessor stays inert (no claims).
  updateBatchExecutionState(batchId, 'paused');
  insertItems(
    batchId,
    [{ upc: 'sse-1', name: 'SSE item', rowNumber: 1, stage: 'curation', stageStatus: 'in_progress' }],
    'curation',
    1,
  );
  app = new Hono();
  app.route('/api', onboardingRoutes);
}

beforeEach(() => {
  readers = [];
  makeWorkspace();
});

afterEach(async () => {
  for (const reader of readers) {
    try {
      await reader.cancel();
    } catch {
      // Already closed — cleanup is best-effort.
    }
  }
  readers = [];
  resetActiveWorkerForTest();
  closeDb();
});

interface SseFrame {
  event: string;
  data: string;
}

/**
 * Persistent SSE session: ONE reader per response (a locked stream cannot be
 * re-acquired). Accumulates frames across sequential readMore() calls.
 */
class SseSession {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buffer = '';
  readonly frames: SseFrame[] = [];

  constructor(res: Response) {
    this.reader = res.body!.getReader();
    readers.push(this.reader);
  }

  /** Read until `wantTotal` cumulative frames arrive or the budget elapses. */
  async readMore(wantTotal: number, timeoutMs = 8000): Promise<SseFrame[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.frames.length < wantTotal && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const chunk = await Promise.race([
        this.reader.read(),
        new Promise<{ done: true; value?: undefined }>(resolve =>
          setTimeout(() => resolve({ done: true }), remaining),
        ),
      ]);
      if (chunk.done) break;
      if (!chunk.value) continue;
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
      let idx: number;
      while ((idx = this.buffer.indexOf('\n\n')) >= 0) {
        const raw = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        const eventLine = raw.split('\n').find(l => l.startsWith('event:'));
        const dataLines = raw.split('\n').filter(l => l.startsWith('data:'));
        if (eventLine) {
          this.frames.push({
            event: eventLine.slice('event:'.length).trim(),
            data: dataLines.map(l => l.slice('data:'.length).trim()).join('\n'),
          });
        }
        if (this.frames.length >= wantTotal) break;
      }
    }
    return this.frames;
  }
}

describe('SSE v1 legacy behavior (byte-identical)', () => {
  it('sends the exact legacy welcome frame', async () => {
    const res = await app.request(`/api/onboarding/batches/${batchId}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const session = new SseSession(res);
    const frames = await session.readMore(1);
    expect(frames.length).toBe(1);
    expect(frames[0].event).toBe('welcome');
    expect(frames[0].data).toBe(JSON.stringify({ message: 'SSE connection established', batchId }));
  });

  it('passes live events through byte-identical', async () => {
    const res = await app.request(`/api/onboarding/batches/${batchId}/events`);
    const session = new SseSession(res);
    const frames = await session.readMore(1);
    expect(frames.length).toBe(1);
    onboardingEvents.emitItemStatus(batchId, 'item-9', 'completed', { stage: 'curation', stageStatus: 'completed' });
    const later = await session.readMore(2);
    expect(later.length).toBe(2);
    const live = later[1];
    expect(live.event).toBe('item:status');
    expect(live.data).toBe(
      JSON.stringify({
        type: 'item:status',
        batchId,
        itemId: 'item-9',
        data: { status: 'completed', stage: 'curation', stageStatus: 'completed' },
      }),
    );
  });
});

describe('SSE v2 representation (?stageVocabularyVersion=2)', () => {
  it('sends a typed connection frame (never work activity)', async () => {
    const res = await app.request(`/api/onboarding/batches/${batchId}/events?stageVocabularyVersion=2`);
    expect(res.status).toBe(200);
    const session = new SseSession(res);
    const frames = await session.readMore(1);
    expect(frames.length).toBe(1);
    expect(frames[0].event).toBe('welcome');
    expect(JSON.parse(frames[0].data)).toEqual({ frame: 'welcome', batchId });
  });

  it('serializes live events as sanitized bounded v2 envelopes', async () => {
    const res = await app.request(`/api/onboarding/batches/${batchId}/events?stageVocabularyVersion=2`);
    const session = new SseSession(res);
    await session.readMore(1);
    onboardingEvents.emitItemStatus(batchId, 'item-9', 'failed', {
      stage: 'curation',
      stageStatus: 'failed',
      error: 'DB password hunter2 leaked; see https://admin:s3cret@example.com/logs?token=abc',
    });
    const frames = await session.readMore(2);
    expect(frames.length).toBe(2);
    const live = frames[1];
    expect(live.event).toBe('item:status');
    const envelope = JSON.parse(live.data);
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.stageVocabularyVersion).toBe(2);
    expect(envelope.event).toBe('item:status');
    expect(envelope.batchId).toBe(batchId);
    expect(envelope.itemId).toBe('item-9');
    expect(envelope.stage).toBe('prepare_listing');
    expect(envelope.stageStatus).toBe('failed');
    expect(typeof envelope.summary).toBe('string');
    expect(envelope.summary.length).toBeLessThanOrEqual(160);
    // Raw error text, credentials, URLs, and tokens never reach the wire.
    expect(live.data).not.toContain('hunter2');
    expect(live.data).not.toContain('admin:s3cret');
    expect(live.data).not.toContain('example.com/logs');
    expect(live.data).not.toContain('token=abc');
  });

  it('never forwards attacker-controlled status text (stageStatus allowlist only)', async () => {
    const res = await app.request(`/api/onboarding/batches/${batchId}/events?stageVocabularyVersion=2`);
    const session = new SseSession(res);
    await session.readMore(1);
    const poison = 'DB password=hunter2 https://admin:s3cret@example.com/x <script>alert(1)</script>';
    // Poisoned via the legacy `status` fallback key (no stageStatus present).
    onboardingEvents.emitItemStatus(batchId, 'item-poison-status', 'failed', { stage: 'curation', status: poison });
    // Poisoned directly in stageStatus.
    onboardingEvents.emitItemStatus(batchId, 'item-poison-stagestatus', 'failed', {
      stage: 'curation',
      stageStatus: poison,
    });
    // Valid control for comparison.
    onboardingEvents.emitItemStatus(batchId, 'item-ok', 'failed', { stage: 'curation', stageStatus: 'failed' });
    const frames = await session.readMore(4);
    expect(frames.length).toBe(4);
    const byItem = new Map(frames.slice(1).map(f => {
      const envelope = JSON.parse(f.data);
      return [envelope.itemId, envelope] as const;
    }));
    // Attacker text is omitted from the envelope — never rides the wire.
    for (const id of ['item-poison-status', 'item-poison-stagestatus']) {
      expect('stageStatus' in (byItem.get(id) as Record<string, unknown>)).toBe(false);
    }
    expect(byItem.get('item-ok').stageStatus).toBe('failed');
    const wire = frames.map(f => f.data).join('\n');
    expect(wire).not.toContain('hunter2');
    expect(wire).not.toContain('s3cret');
    expect(wire).not.toContain('<script>');
  });

  it('live-activity stageStatus allowlist matches StageStatusEnum exactly', () => {
    expect([...LIVE_ACTIVITY_STAGE_STATUSES]).toEqual(StageStatusEnum.options);
  });

  it('keeps named event types unchanged across versions', async () => {
    const res = await app.request(`/api/onboarding/batches/${batchId}/events?stageVocabularyVersion=2`);
    const session = new SseSession(res);
    await session.readMore(1);
    onboardingEvents.emitBatchProgress(batchId, 3, 1, 10);
    const frames = await session.readMore(2);
    expect(frames[1].event).toBe('batch:progress');
    const envelope = JSON.parse(frames[1].data);
    expect(envelope.event).toBe('batch:progress');
    expect(envelope.summary).toBe('Batch progress counts changed.');
    // Missing stage stays absent — never invented.
    expect('stage' in envelope).toBe(false);
  });

  it('drops unmappable stages in v2 (counts still refresh by polling)', async () => {
    const res = await app.request(`/api/onboarding/batches/${batchId}/events?stageVocabularyVersion=2`);
    const session = new SseSession(res);
    await session.readMore(1);
    onboardingEvents.emit({
      type: 'item:status',
      batchId,
      itemId: 'item-bad',
      data: { status: 'migrating', stage: 'nonsense_stage' },
    });
    onboardingEvents.emitBatchProgress(batchId, 4, 1, 10);
    // Short budget: live frames arrive in milliseconds, so 2s of silence
    // proves the unmappable event produced no frame.
    const frames = await session.readMore(3, 2000);
    // welcome + batch:progress only — the unmappable event produced no frame.
    expect(frames.map(f => f.event)).toEqual(['welcome', 'batch:progress']);
  });
});

describe('SSE version guards', () => {
  it('rejects unknown versions BEFORE the stream opens', async () => {
    const res = await app.request(`/api/onboarding/batches/${batchId}/events?stageVocabularyVersion=banana`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('invalid_version');
  });

  it('treats explicit v1 like legacy', async () => {
    const res = await app.request(`/api/onboarding/batches/${batchId}/events?stageVocabularyVersion=1`);
    expect(res.status).toBe(200);
    const session = new SseSession(res);
    const frames = await session.readMore(1);
    expect(frames[0].event).toBe('welcome');
    expect(frames[0].data).toBe(JSON.stringify({ message: 'SSE connection established', batchId }));
  });

  it('404s unknown batches before any connection opens', async () => {
    const res = await app.request('/api/onboarding/batches/does-not-exist/events');
    expect(res.status).toBe(404);
  });
});
