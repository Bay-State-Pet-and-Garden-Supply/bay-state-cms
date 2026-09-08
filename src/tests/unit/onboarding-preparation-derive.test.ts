/**
 * Slice 4-SERVER — preparation-section server derivation (Bun).
 *
 * - Pure derivation matrix: every section branch from fabricated chunk facts
 *   (no DB) — five fixed sections always, bounded reasons, unavailable never
 *   completion, no raw text leakage.
 * - DB-backed wiring: getStageReadItems returns preparationByItem for exactly
 *   the matched items with schema-valid summaries.
 * - Budget proof: preparation derivation issues ZERO new SQL statements —
 *   proven by running buildPreparationByItem with the DB connection closed
 *   (any query would throw) and by asserting the items response queryCount
 *   stays within the single-chunk envelope.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { createRun } from '../../db/repositories/classification-run-repo';
import {
  PreparationSummarySchema,
  PREPARATION_SECTION_KEYS,
} from '../../shared/schemas/onboarding-preparation';
import {
  derivePreparationForItems,
  derivePreparationSummary,
  type PreparationItemFacts,
} from '../../onboarding/onboarding-preparation-read';
import { buildPreparationByItem } from '../../onboarding/onboarding-stage-read';
import onboardingStageReadRoutes from '../../server/routes/onboarding-stage-read-routes';

function facts(overrides: Partial<PreparationItemFacts> = {}): PreparationItemFacts {
  return {
    itemId: 'item-1',
    stageRows: null,
    cohort: null,
    cohortRunStatus: null,
    curatedTitle: null,
    imageUrl: null,
    semanticBlocked: false,
    ...overrides,
  };
}

function section(summary: ReturnType<typeof derivePreparationSummary>, key: string) {
  return summary.sections.find(s => s.key === key)!;
}

describe('preparation derivation (pure matrix)', () => {
  it('always returns exactly the five fixed sections in order', () => {
    const summary = derivePreparationSummary(facts());
    expect(summary.schemaVersion).toBe(1);
    expect(summary.sections.map(s => s.key)).toEqual([...PREPARATION_SECTION_KEYS]);
    expect(PreparationSummarySchema.safeParse(summary).success).toBe(true);
  });

  it('keeps every reason within 160 display characters', () => {
    const summary = derivePreparationSummary(
      facts({
        cohort: {
          cohortId: 'c1',
          label: 'x'.repeat(500),
          memberCount: 99,
          readyCount: 0,
          blockedCount: 99,
          waitingOnItemIds: Array.from({ length: 60 }, (_, i) => `item-${i}-${'y'.repeat(200)}`),
          cohortStatus: 'ready',
          cohortState: 'blocked',
          blockedReason: 'z'.repeat(500),
        },
      }),
    );
    for (const s of summary.sections) {
      expect((s.reason ?? '').length).toBeLessThanOrEqual(160);
    }
    const family = section(summary, 'family_cohort');
    expect(family.relatedIds!.length).toBeLessThanOrEqual(25);
    expect(PreparationSummarySchema.safeParse(summary).success).toBe(true);
  });

  it('ocr_evidence: no image, pending, running, available, failed, abstained', () => {
    expect(section(derivePreparationSummary(facts()), 'ocr_evidence').state).toBe('no_image');
    expect(
      section(derivePreparationSummary(facts({ imageUrl: 'https://img/x.jpg' })), 'ocr_evidence').state,
    ).toBe('not_started_or_unknown');
    const run = (status: string) =>
      section(
        derivePreparationSummary(
          facts({ imageUrl: 'https://img/x.jpg', stageRows: [{ stage_name: 'packaging_ocr', status }] }),
        ),
        'ocr_evidence',
      ).state;
    expect(run('running')).toBe('running');
    expect(run('succeeded')).toBe('available');
    expect(run('failed')).toBe('failed');
    // Abstention is reported honestly — never as OCR evidence.
    expect(run('abstained')).toBe('unavailable');
  });

  it('family_cohort: no family, forming/waiting, blocked, ready, freezing, superseded', () => {
    const withCohort = (cohort: NonNullable<PreparationItemFacts['cohort']>, cohortRunStatus: string | null = null) =>
      section(derivePreparationSummary(facts({ cohort, cohortRunStatus })), 'family_cohort');
    expect(withCohort(null as never).state).toBe('not_started_or_unknown');
    const base = {
      cohortId: 'c1',
      label: 'Family A',
      memberCount: 3,
      readyCount: 1,
      blockedCount: 0,
      waitingOnItemIds: ['item-2'] as string[],
      cohortStatus: 'ready',
      blockedReason: null,
    };
    expect(withCohort({ ...base, cohortState: 'waiting' }).state).toBe('forming_or_waiting');
    expect(withCohort({ ...base, cohortState: 'blocked', blockedReason: 'Size mismatch' }).state).toBe('blocked');
    const ready = withCohort({ ...base, cohortState: 'ready' });
    expect(ready.state).toBe('ready');
    expect(ready.count).toBe(3);
    expect(ready.relatedIds).toEqual(['item-2']);
    expect(ready.crossStageContext).toBe(true);
    expect(withCohort({ ...base, cohortState: 'ready' }, 'freezing').state).toBe('freezing_or_running');
    expect(withCohort({ ...base, cohortState: 'ready' }, 'running').state).toBe('freezing_or_running');
    expect(withCohort({ ...base, cohortState: 'ready', cohortStatus: 'superseded' }).state).toBe(
      'superseded_or_unknown',
    );
  });

  it('names: conflicted, running, proposed, abstained, failed, not started', () => {
    const withName = (f: Partial<PreparationItemFacts>) => section(derivePreparationSummary(facts(f)), 'names');
    expect(withName({}).state).toBe('not_started_or_unknown');
    expect(withName({ semanticBlocked: true }).state).toBe('conflicted');
    expect(withName({ stageRows: [{ stage_name: 'name_consolidation', status: 'running' }] }).state).toBe('running');
    expect(withName({ stageRows: [{ stage_name: 'name_consolidation', status: 'failed' }] }).state).toBe('failed');
    expect(withName({ stageRows: [{ stage_name: 'name_consolidation', status: 'abstained' }] }).state).toBe(
      'abstained',
    );
    expect(
      withName({
        stageRows: [{ stage_name: 'name_consolidation', status: 'succeeded' }],
        curatedTitle: 'Acme Anvil',
      }).state,
    ).toBe('proposed');
    // Succeeded without a recorded title is not a proposal.
    expect(
      withName({ stageRows: [{ stage_name: 'name_consolidation', status: 'succeeded' }] }).state,
    ).toBe('not_started_or_unknown');
  });

  it('product_type: proposed only on recorded success, never fabricated', () => {
    const withType = (f: Partial<PreparationItemFacts>) =>
      section(derivePreparationSummary(facts(f)), 'product_type');
    expect(withType({}).state).toBe('not_started_or_unknown');
    expect(withType({ semanticBlocked: true }).state).toBe('conflicted');
    expect(withType({ stageRows: [{ stage_name: 'primary_product_type_proposal', status: 'running' }] }).state).toBe(
      'running',
    );
    expect(
      withType({ stageRows: [{ stage_name: 'primary_product_type_proposal', status: 'succeeded' }] }).state,
    ).toBe('proposed');
    expect(
      withType({ stageRows: [{ stage_name: 'primary_product_type_proposal', status: 'abstained' }] }).state,
    ).toBe('abstained');
  });

  it('field_classification: aggregates attribute/page stages without approving', () => {
    const withFields = (rows: Array<{ stage_name: string; status: string }> | null) =>
      section(derivePreparationSummary(facts({ stageRows: rows })), 'field_classification');
    expect(withFields(null).state).toBe('not_started_or_unknown');
    expect(
      withFields([
        { stage_name: 'attribute_applicability', status: 'succeeded' },
        { stage_name: 'product_attribute_proposals', status: 'succeeded' },
        { stage_name: 'category_page_proposals', status: 'succeeded' },
      ]).state,
    ).toBe('pending_or_proposed');
    expect(
      withFields([
        { stage_name: 'attribute_applicability', status: 'succeeded' },
        { stage_name: 'product_attribute_proposals', status: 'running' },
      ]).state,
    ).toBe('running');
    expect(withFields([{ stage_name: 'product_attribute_proposals', status: 'failed' }]).state).toBe('failed');
    // Proposals pending review are never labeled decided/approved.
    const decided = withFields([
      { stage_name: 'attribute_applicability', status: 'succeeded' },
      { stage_name: 'product_attribute_proposals', status: 'succeeded' },
      { stage_name: 'category_page_proposals', status: 'succeeded' },
    ]);
    expect(decided.state).not.toBe('decided');
    expect(decided.reason).toContain('pending review');
  });

  it('never leaks raw payload text into reasons', () => {
    const summary = derivePreparationSummary(
      facts({
        cohort: {
          cohortId: 'c1',
          label: null,
          memberCount: 2,
          readyCount: 0,
          blockedCount: 2,
          waitingOnItemIds: [],
          cohortStatus: 'ready',
          cohortState: 'blocked',
          blockedReason: 'password=hunter2 https://evil.example/x <script>alert(1)</script>',
        },
      }),
    );
    const text = JSON.stringify(summary);
    expect(text).not.toContain('password=hunter2');
    expect(text).not.toContain('evil.example');
    expect(text).not.toContain('<script>');
    expect(section(summary, 'family_cohort').state).toBe('blocked');
  });
});

describe('preparation derivation budget (zero new statements)', () => {
  it('buildPreparationByItem performs no I/O with the DB closed', () => {
    closeDb();
    const out = buildPreparationByItem(
      [],
      new Map(),
      {
        reviewStates: new Map(),
        cohortByItem: new Map(),
        changeSetStatusBySku: new Map(),
        candidateCountByItem: new Map(),
        variantResolutionByItem: new Map(),
        cohortRunStatusByItem: new Map(),
        latestRunIdByItem: new Map(),
        stageResultsByRunId: new Map(),
        healthIssues: [],
      },
    );
    expect(out).toEqual({});
  });

  it('derivePreparationForItems derives pure summaries with the DB closed (non-empty facts)', () => {
    closeDb();
    // Any SQL issued here would throw with the connection closed.
    const out = derivePreparationForItems([
      {
        itemId: 'closed-1',
        facts: {
          stageRows: [
            { stage_name: 'packaging_ocr', status: 'succeeded' },
            { stage_name: 'name_consolidation', status: 'succeeded' },
            { stage_name: 'primary_product_type_proposal', status: 'running' },
          ],
          cohort: {
            cohortId: 'c1',
            label: 'Family A',
            memberCount: 3,
            readyCount: 1,
            blockedCount: 1,
            waitingOnItemIds: ['closed-2'],
            cohortStatus: 'ready',
            cohortState: 'waiting',
            blockedReason: null,
          },
          cohortRunStatus: null,
          curatedTitle: 'Acme Anvil',
          imageUrl: 'https://img.example/a.jpg',
          semanticBlocked: false,
        },
      },
    ]);
    const summary = out.get('closed-1')!;
    expect(PreparationSummarySchema.safeParse(summary).success).toBe(true);
    const byKey = Object.fromEntries(summary.sections.map(s => [s.key, s.state]));
    expect(byKey.ocr_evidence).toBe('available');
    expect(byKey.family_cohort).toBe('forming_or_waiting');
    expect(byKey.names).toBe('proposed');
    expect(byKey.product_type).toBe('running');
    expect(summary.sections.map(s => s.key)).toEqual([...PREPARATION_SECTION_KEYS]);
  });
});

describe('preparation wiring through v2 items', () => {
  let workspaceId: string;
  let batchId: string;
  let app: Hono;

  beforeEach(() => {
    workspaceId = randomUUID();
    const workspacePath = path.join(os.tmpdir(), `ws-prep-derive-${workspaceId.slice(0, 8)}`);
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
    const batch = createBatch({ workspaceId, name: 'Prep batch', fileName: 'test.csv', totalItems: 0 });
    batchId = batch.id;
    app = new Hono();
    const routes = onboardingStageReadRoutes;
    app.route('/api', routes);
  });

  afterEach(() => {
    closeDb();
  });

  it('returns schema-valid preparation for exactly the matched items within budget', async () => {
    const inserted = insertItems(
      batchId,
      [
        { upc: 'prep-1', name: 'Curated item', rowNumber: 1, stage: 'curation', stageStatus: 'in_progress' },
        { upc: 'prep-2', name: 'Fresh item', rowNumber: 2, stage: 'curation', stageStatus: 'pending' },
        { upc: 'prep-3', name: 'Other stage', rowNumber: 3, stage: 'discovery', stageStatus: 'pending' },
      ],
      'curation',
      1,
    );
    // One item carries a real classification run with recorded stage facts.
    const run = createRun(workspaceId, 'prep-1', null, null, { onboardingItemId: inserted[0].id });
    const db = getDb();
    const now = new Date().toISOString();
    const stageStmt = db.query(
      'INSERT INTO classification_stage_results (id, run_id, stage_name, status, started_at) VALUES (?, ?, ?, ?, ?)',
    );
    stageStmt.run(randomUUID(), run.id, 'packaging_ocr', 'succeeded', now);
    stageStmt.run(randomUUID(), run.id, 'name_consolidation', 'succeeded', now);
    stageStmt.run(randomUUID(), run.id, 'primary_product_type_proposal', 'succeeded', now);
    db.query('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?').run(
      JSON.stringify({ classificationRunId: run.id, curatedTitle: 'Acme Anvil' }),
      inserted[0].id,
    );
    db.query('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?').run(
      JSON.stringify({ primaryImage: 'https://img.example/a.jpg' }),
      inserted[0].id,
    );

    const res = await app.request(
      `/api/onboarding/v2/batches/${batchId}/stage-work-state/items?stage=prepare_listing&limit=50`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ itemId: string }>;
      preparationByItem?: Record<string, unknown>;
      queryCount: number;
    };
    expect(body.items.map(i => i.itemId).sort()).toEqual([inserted[0].id, inserted[1].id].sort());
    expect(Object.keys(body.preparationByItem ?? {}).sort()).toEqual(
      body.items.map(i => i.itemId).sort(),
    );
    for (const summary of Object.values(body.preparationByItem!)) {
      expect(PreparationSummarySchema.safeParse(summary).success).toBe(true);
    }
    const curated = body.preparationByItem![inserted[0].id] as {
      sections: Array<{ key: string; state: string }>;
    };
    const byKey = Object.fromEntries(curated.sections.map(s => [s.key, s.state]));
    expect(byKey.ocr_evidence).toBe('available');
    expect(byKey.names).toBe('proposed');
    expect(byKey.product_type).toBe('proposed');
    const fresh = body.preparationByItem![inserted[1].id] as {
      sections: Array<{ key: string; state: string }>;
    };
    expect(fresh.sections.find(s => s.key === 'ocr_evidence')!.state).toBe('no_image');
    // Single-chunk envelope: bounded statements, no per-item fan-out.
    expect(body.queryCount).toBeLessThanOrEqual(24);
  });
});
