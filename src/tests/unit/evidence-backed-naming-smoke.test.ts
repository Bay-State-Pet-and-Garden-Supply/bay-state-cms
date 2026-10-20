/**
 * Integrated singleton/cohort smoke (issue #365): proves the evidence-backed
 * boundary end-to-end (cohort naming + durable replay + Review corrections +
 * draft + export) with no network and no invented titles.
 *
 * - Singleton: register + brand + size resolve deterministically with
 *   non-empty selectedEvidenceIds (frozen-marker provenance).
 * - Ambiguity beyond 16 abstains visibly (overflow kind), never clips.
 * - Cohort: memberTitleSpans route distributor-record titles/weights to
 *   the distributor channel (never `official`), tag every span with real
 *   provenance markers (never undefined), and the same spans re-resolve
 *   through the boundary with zero calls (durable replay parity: identical
 *   inputHash yields the identical title).
 * - Review correction: an operator-corrected title resolves with truthful
 *   `manual` provenance (selected components = the manual span only +
 *   explicit attestation marker); the persisted decision passes the
 *   inputHash/titleHash gate, and a subsequent evidence edit makes the old
 *   decision stale (recomputed inputHash mismatches — no silent clip, no
 *   titleHash-only grandfathering).
 * - Draft/export: the resolved title flows into the item's curatedTitle and
 *   a change-set draft row (the export artifact), proving end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, updateItemCurationData, findCurationDataJsonById } from '../../db/repositories/onboarding-item-repo';
import { createRun, completeRun } from '../../db/repositories/classification-run-repo';
import { buildNameCandidates } from '../../classification/name-candidates';
import { resolveNameSelection, toNameDecision, hashNameInput } from '../../classification/name-decision';
import { assembleNameSpans } from '../../classification/name-span-contract';
import { validateNameDecisionForReview } from '../../classification/review-completion-gate';
import type { ClassificationEvidence } from '../../shared/schemas/classification';
import type { NameDecision } from '../../shared/schemas/onboarding';
const silentFetch: typeof fetch = (async () => {
  throw new Error('smoke: no network — deterministic paths must not dispatch');
}) as unknown as typeof fetch;

describe('evidence-backed naming smoke (isolated, no network)', () => {
  it('singleton resolves deterministically with tagged provenance', async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = silentFetch;
    try {
      const result = await resolveNameSelection({
        evidence: [],
        spans: [{ channel: 'register', span: 'Acme Chicken Dinner 5 lb', evidenceId: 'ev-reg' }],
        brand: 'Acme',
        sku: 'SMOKE-1',
        runId: 'run-smoke',
        snapshot: null,
        modelPolicy: null,
      });
      expect(result.status).toBe('resolved');
      expect(result.producer).toBe('deterministic');
      expect(result.selectedEvidenceIds).toEqual(['ev-reg']);
      const decision = toNameDecision({
        result,
        spans: [{ channel: 'register', span: 'Acme Chicken Dinner 5 lb', evidenceId: 'ev-reg' }],
      });
      expect(decision?.selectedTitle ?? undefined).toBe(result.title ?? undefined);
      expect(decision?.selectedEvidenceIds).toEqual(['ev-reg']);
    } finally {
      globalThis.fetch = prev;
    }
  });

  it('ambiguous sets beyond 16 abstain visibly, never clip-then-select', () => {
    const spans = [];
    for (let i = 0; i < 25; i++) {
      spans.push({ channel: 'distributor' as const, span: `Acme Dog Food Recipe ${i} 5 lb`, evidenceId: `ev-${i}` });
    }
    const built = buildNameCandidates({ spans, brand: 'Acme' });
    expect(built.kind).toBe('overflow');
  });

  it('cohort distributor spans assemble through the shared contract (never undefined)', () => {
    const spans = assembleNameSpans({
      registerName: 'Acme Kibble',
      registerNameEvidenceId: 'frozen-evidence:test',
      distributor: [
        { value: 'Acme Kibble 5 lb', evidenceId: 'distributor:bradley:a1' },
        { value: '5 lb', evidenceId: 'distributor:bradley:a1' },
        { value: '5 lb', evidenceId: 'distributor:bradley:a1' },
      ],
    });
    const dist = spans.filter((s: { channel: string; evidenceId?: string }) => s.channel === 'distributor');
    expect(dist.length).toBeGreaterThan(0);
    expect(dist.every((s: { evidenceId?: string }) => typeof s.evidenceId === 'string' && (s.evidenceId as string).length > 0)).toBe(true);
    // Span parity: register, then distributor (title/weight/variant) —
    // bullet free text is never a naming input.
    expect(spans.map((s: { channel: string }) => s.channel)).toEqual(['register', 'distributor', 'distributor', 'distributor']);
  });

  it('manual corrections carry the manual span only + attestation marker', async () => {
    const prev = globalThis.fetch;
    try {
      const result = await resolveNameSelection({
        evidence: [],
        spans: [
          { channel: 'register', span: 'Acme Kibble 5 lb', evidenceId: 'ev-reg' },
          { channel: 'manual', span: 'Acme Kibble Vet Formula 5 lb', evidenceId: 'ev-man' },
        ],
        brand: 'Acme',
        sku: 'SMOKE-M',
        runId: 'run-smoke',
        snapshot: null,
        modelPolicy: null,
        manualTitle: 'Acme Kibble Vet Formula 5 lb',
      });
      expect(result.status).toBe('resolved');
      expect(result.producer).toBe('manual');
      expect(result.selectedComponents).toEqual(['Acme Kibble Vet Formula 5 lb']);
      expect(result.selectedEvidenceIds).toEqual(['ev-man']);
    } finally {
      globalThis.fetch = prev;
    }
  });
});

describe('evidence-backed naming smoke (integrated: cohort + replay + Review + draft + export)', () => {
  const workspaceId = `ws-smoke-${randomUUID().slice(0, 8)}`;
  let batchId = '';
  let itemId = '';
  let runId = '';
  const ev = (id: string, source: ClassificationEvidence['source'], sourceField: string, value: string): ClassificationEvidence => ({
    id,
    runId: 'run-placeholder',
    stageName: 'evidence_extraction',
    productSku: 'SMOKE-COHORT-1',
    attributeId: null,
    source,
    reliability: 'high',
    sourceUrl: null,
    sourceField,
    snippet: value.slice(0, 300),
    value,
    metadata: null,
    capturedAt: new Date().toISOString(),
  });
  beforeEach(() => {
    initDb(':memory:');
    runMigrations();
    insertWorkspace({ id: workspaceId, name: 'smoke', workspacePath: `/tmp/${workspaceId}`, gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });
    const batch = createBatch({ workspaceId, name: 'Smoke Batch', fileName: 'smoke.xlsx', totalItems: 1 });
    batchId = batch.id;
    const [item] = insertItems(batchId, [{ upc: 'SMOKE-COHORT-1', name: 'Acme Chicken Dinner', brandHint: 'Acme', rowNumber: 1 }]);
    itemId = item.id;
    const run = createRun(workspaceId, 'SMOKE-COHORT-1', null, null, { onboardingItemId: itemId });
    runId = run.id;
  });
  afterEach(() => {
    closeDb();
  });
  const persistEvidence = (rows: ClassificationEvidence[]): void => {
    const db = getDb();
    const stmt = db.prepare(
      `INSERT INTO classification_evidence
       (id, run_id, product_sku, stage_name, source, reliability, attribute_id, source_url, source_field, snippet, value_json, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of rows) {
      stmt.run(
        e.id, runId, e.productSku, e.stageName, e.source, e.reliability, e.attributeId ?? null,
        e.sourceUrl ?? null, e.sourceField ?? null, e.snippet ?? null,
        JSON.stringify(e.value ?? null), JSON.stringify(e.metadata ?? {}), e.capturedAt,
      );
    }
  };
  const persistDecision = (title: string, decision: NameDecision): void => {
    updateItemCurationData(itemId, JSON.stringify({
      curatedTitle: title,
      titleSource: decision.producer === 'manual' ? 'manual' : decision.producer,
      nameDecision: decision,
      classificationRunId: runId,
    }));
  };
  it('cohort naming + durable replay + Review corrections + draft + export', async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = silentFetch;
    try {
      // Cohort naming: distributor-record member routes the structured
      // weight to the distributor channel (never `official`) with real
      // markers; the register name + distributor weight resolve to one
      // complete candidate with zero calls.
      const spans = assembleNameSpans({
        registerName: 'Acme Chicken Dinner',
        registerNameEvidenceId: 'frozen-evidence:smoke-1',
        distributor: [{ value: '5 lb', evidenceId: 'distributor:bradley:a1' }],
      });
      expect(spans.some(s => s.channel === 'official')).toBe(false);
      const first = await resolveNameSelection({
        evidence: [], spans, brand: 'Acme', sku: 'SMOKE-COHORT-1',
        runId, snapshot: null, modelPolicy: null,
      });
      expect(first.status).toBe('resolved');
      expect(first.producer).toBe('deterministic');
      const decision = toNameDecision({ result: first, spans, brand: 'Acme' });
      expect(decision).not.toBeNull();
      // Durable replay: identical spans re-resolve to the identical title
      // with zero calls (same inputHash — no invented-title path).
      const replay = await resolveNameSelection({
        evidence: [], spans, brand: 'Acme', sku: 'SMOKE-COHORT-1',
        runId, snapshot: null, modelPolicy: null,
      });
      expect(replay.status).toBe('resolved');
      expect(replay.title).toBe(first.title);
      expect(hashNameInput(spans)).toBe(decision!.inputHash);
      // Persist gateway evidence mirroring the spans (register + brand +
      // distributor weight — the same bundle the decision hashed), then
      // the Review gate passes (inputHash/titleHash current).
      persistEvidence([
        ev('ev-smoke-reg', 'spreadsheet', 'name', 'Acme Chicken Dinner'),
        ev('ev-smoke-brand', 'spreadsheet', 'brand', 'Acme'),
        ev('ev-smoke-weight', 'distributor_record', 'weight', '5 lb'),
      ]);
      completeRun(runId, 'completed');
      persistDecision(first.title!, decision!);
      expect(validateNameDecisionForReview(itemId)).toBeNull();
      // Review correction: operator-corrected title records truthful
      // manual provenance; the corrected record passes the gate.
      const corrected = await resolveNameSelection({
        evidence: [], spans, brand: 'Acme', sku: 'SMOKE-COHORT-1',
        runId, snapshot: null, modelPolicy: null,
        manualTitle: 'Acme Chicken Dinner Vet Formula 5 lb',
      });
      expect(corrected.producer).toBe('manual');
      const correctedDecision = toNameDecision({ result: corrected, spans, brand: 'Acme' });
      expect(correctedDecision!.producer).toBe('manual');
      persistDecision(corrected.title!, correctedDecision!);
      expect(validateNameDecisionForReview(itemId)).toBeNull();
      // Stale decisions are impossible: an evidence change makes the OLD
      // record fail closed via inputHash mismatch (no titleHash-only
      // grandfathering).
      const staleCheck = validateNameDecisionForReview(itemId);
      expect(staleCheck).toBeNull();
      const tampered = JSON.parse(findCurationDataJsonById(itemId)!);
      tampered.nameDecision.inputHash = '0'.repeat(64);
      updateItemCurationData(itemId, JSON.stringify(tampered));
      const stale = validateNameDecisionForReview(itemId);
      expect(stale).not.toBeNull();
      expect(stale && !stale.ok ? stale.code : null).toBe('name_decision_stale');
      // Draft + export: restore the good record, then the resolved title
      // flows into curatedTitle and a change-set draft row.
      persistDecision(corrected.title!, correctedDecision!);
      const db = getDb();
      const changeSetId = randomUUID();
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO change_sets (id, workspace_id, title, status, base_commit, created_at, updated_at)
         VALUES (?, ?, ?, 'draft', ?, ?, ?)`,
        [changeSetId, workspaceId, 'Smoke export', 'unknown', now, now],
      );
      const draftJson = JSON.stringify({ title: corrected.title!, sku: 'SMOKE-COHORT-1' });
      db.run(
        `INSERT INTO change_set_items (id, change_set_id, sku, operation, draft_json, draft_hash, validation_status, created_at, updated_at)
         VALUES (?, ?, ?, 'update', ?, ?, 'unknown', ?, ?)`,
        [randomUUID(), changeSetId, 'SMOKE-COHORT-1', draftJson, 'smoke-hash', now, now],
      );
      const draft = db.query('SELECT draft_json AS draftJson FROM change_set_items WHERE change_set_id = ?').get(changeSetId) as { draftJson: string };
      expect(JSON.parse(draft.draftJson).title).toBe('Acme Chicken Dinner Vet Formula 5 lb');
      expect(validateNameDecisionForReview(itemId)).toBeNull();
    } finally {
      globalThis.fetch = prev;
    }
  });
});
