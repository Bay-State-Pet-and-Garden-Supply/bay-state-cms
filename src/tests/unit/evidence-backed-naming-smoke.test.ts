/**
 * Accepted-item naming smoke. Draft rows are fixture setup only; this suite
 * does not exercise promotion or export.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, updateItemCurationData, findItemById } from '../../db/repositories/onboarding-item-repo';
import { buildNameCandidates, acceptedItemNameSpans } from '../../classification/name-candidates';
import { resolveNameSelection, toNameDecision, hashNameInput } from '../../classification/name-decision';
import { validateNameDecisionForReview } from '../../classification/review-completion-gate';
import type { ClassificationEvidence } from '../../shared/schemas/classification';
import type { NameDecision } from '../../shared/schemas/onboarding';
import { getCurrentItemEvidenceView } from '../../onboarding/item-evidence';
import { prepareListingEvidenceWorkspace, seedListingEvidenceItem, rotateListingEvidenceAuthority } from './helpers/listing-evidence-authority';

const silentFetch: typeof fetch = (async () => { throw new Error('smoke: no network — deterministic paths must not dispatch'); }) as unknown as typeof fetch;

describe('evidence-backed naming smoke (isolated, no network)', () => {
  it('ambiguous sets beyond 16 abstain visibly, never clip-then-select', () => {
    const spans = Array.from({ length: 25 }, (_, i) => ({ channel: 'distributor' as const, span: `Acme Dog Food Recipe ${i} 5 lb`, evidenceId: `ev-${i}` }));
    expect(buildNameCandidates({ spans, brand: 'Acme' }).kind).toBe('overflow');
  });
});

describe('evidence-backed naming smoke (accepted-item authority + deterministic replay)', () => {
  const workspaceId = `ws-smoke-${randomUUID().slice(0, 8)}`;
  let itemId = '';
  let runId = '';
  let workspacePath = '';
  beforeEach(() => {
    initDb(':memory:');
    runMigrations();
    workspacePath = `/tmp/${workspaceId}`;
    insertWorkspace({ id: workspaceId, name: 'smoke', workspacePath, gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });
    prepareListingEvidenceWorkspace(workspacePath, workspaceId);
    const batch = createBatch({ workspaceId, name: 'Smoke Batch', fileName: 'smoke.xlsx', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: 'SMOKE-COHORT-1', name: 'Acme Chicken Dinner', brandHint: 'Acme', rowNumber: 1 }]);
    itemId = item.id;
    const authority = seedListingEvidenceItem({ workspaceId, workspacePath, itemId, sku: 'SMOKE-COHORT-1' });
    runId = authority.runId;
  });
  afterEach(() => closeDb());

  const currentSpans = () => {
    const current = getCurrentItemEvidenceView(workspaceId, itemId);
    if (current.status !== 'accepted' || !current.evidence) throw new Error(`accepted naming evidence unavailable: ${current.status}`);
    return acceptedItemNameSpans(current.evidence).spans;
  };
  const persistDecision = (title: string, decision: NameDecision, targetItemId = itemId, targetRunId = runId): void => {
    const item = findItemById(targetItemId)!;
    updateItemCurationData(targetItemId, JSON.stringify({ ...(item.curationData ?? {}), curatedTitle: title, titleSource: decision.producer === 'manual' ? 'manual' : decision.producer, nameDecision: decision, classificationRunId: targetRunId }));
  };

  it('uses accepted spans, preserves receipt, replays, corrects manually, and refuses stale/unavailable authority', async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = silentFetch;
    try {
      const spans = currentSpans();
      expect(spans.length).toBeGreaterThan(0);
      const evidence = getDb().query('SELECT * FROM classification_evidence WHERE run_id = ?').all(runId).map((row: unknown) => row as ClassificationEvidence);
      const resolve = (manualTitle?: string) => resolveNameSelection({ evidence, spans, brand: 'Acme', sku: 'SMOKE-COHORT-1', runId, snapshot: null, modelPolicy: null, ...(manualTitle ? { manualTitle } : {}) });
      const first = await resolve();
      expect(first.status).toBe('resolved');
      expect(first.producer).toBe('deterministic');
      const decision = toNameDecision({ result: first, spans, brand: 'Acme' });
      expect(decision).not.toBeNull();
      const replay = await resolve();
      expect(replay.title).toBe(first.title);
      expect(hashNameInput(spans)).toBe(decision!.inputHash);
      persistDecision(first.title!, decision!);
      const persisted = findItemById(itemId)!;
      expect(persisted.curationData?.itemExecutionCurrentness).toBeDefined();
      expect(validateNameDecisionForReview(itemId)).toBeNull();

      const corrected = await resolve('Acme Chicken Dinner Vet Formula 5 lb');
      expect(corrected.producer).toBe('manual');
      const manualDecision = toNameDecision({ result: corrected, spans, brand: 'Acme' });
      expect(manualDecision!.producer).toBe('manual');
      persistDecision(corrected.title!, manualDecision!);
      expect(validateNameDecisionForReview(itemId)).toBeNull();
      expect(findItemById(itemId)!.curationData?.itemExecutionCurrentness).toBeDefined();

      // A decision cannot borrow another item's current run authority.
      const batch = createBatch({ workspaceId, name: 'Foreign Batch', fileName: 'foreign.xlsx', totalItems: 1 });
      const [foreignItem] = insertItems(batch.id, [{ upc: 'SMOKE-COHORT-2', name: 'Acme Chicken Dinner', brandHint: 'Acme', rowNumber: 2 }]);
      const foreign = seedListingEvidenceItem({ workspaceId, workspacePath, itemId: foreignItem.id, sku: 'SMOKE-COHORT-2', weight: '5 lb' });
      updateItemCurationData(foreignItem.id, JSON.stringify({
        ...(findItemById(foreignItem.id)!.curationData ?? {}),
        curatedTitle: first.title,
        titleSource: decision!.producer,
        nameDecision: decision,
        classificationRunId: runId,
        itemExecutionCurrentness: findItemById(itemId)!.curationData?.itemExecutionCurrentness,
      }));
      const foreignRun = validateNameDecisionForReview(foreignItem.id);
      expect(foreignRun && !foreignRun.ok ? foreignRun.code : null).toBe('name_evidence_unavailable');
      updateItemCurationData(foreignItem.id, JSON.stringify({
        ...(findItemById(foreignItem.id)!.curationData ?? {}),
        classificationRunId: foreign.runId,
        itemExecutionCurrentness: findItemById(itemId)!.curationData?.itemExecutionCurrentness,
      }));
      const foreignBinding = validateNameDecisionForReview(foreignItem.id);
      expect(foreignBinding && !foreignBinding.ok ? foreignBinding.code : null).toBe('name_evidence_unavailable');

      rotateListingEvidenceAuthority(workspaceId, itemId);
      const rotated = validateNameDecisionForReview(itemId);
      expect(rotated && !rotated.ok ? rotated.code : null).toBe('name_evidence_unavailable');
      const afterRotation = findItemById(itemId)!;
      const noReceipt = { ...(afterRotation.curationData ?? {}) };
      delete noReceipt.itemExecutionCurrentness;
      updateItemCurationData(itemId, JSON.stringify(noReceipt));
      const missingReceipt = validateNameDecisionForReview(itemId);
      expect(missingReceipt && !missingReceipt.ok ? missingReceipt.code : null).toBe('name_evidence_unavailable');
      const db = getDb();
      const changeSetId = randomUUID();
      const now = new Date().toISOString();
      db.run(`INSERT INTO change_sets (id, workspace_id, title, status, base_commit, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?)`, [changeSetId, workspaceId, 'Fixture only; not promoted or exported', 'unknown', now, now]);
      const draftJson = JSON.stringify({ title: corrected.title!, sku: 'SMOKE-COHORT-1' });
      db.run(`INSERT INTO change_set_items (id, change_set_id, sku, operation, draft_json, draft_hash, validation_status, created_at, updated_at) VALUES (?, ?, ?, 'update', ?, ?, 'unknown', ?, ?)`, [randomUUID(), changeSetId, 'SMOKE-COHORT-1', draftJson, 'smoke-hash', now, now]);
      const draftRow = db.query('SELECT draft_json AS draftJson FROM change_set_items WHERE change_set_id = ?').get(changeSetId);
      if (!draftRow || typeof draftRow !== 'object' || !('draftJson' in draftRow) || typeof draftRow.draftJson !== 'string') throw new Error('fixture draft row missing');
      expect(JSON.parse(draftRow.draftJson).title).toBe(corrected.title);
      expect(validateNameDecisionForReview(itemId)).not.toBeNull();
    } finally {
      globalThis.fetch = prev;
    }
  });
});
