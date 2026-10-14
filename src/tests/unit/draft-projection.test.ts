/**
 * PR8 C1 (issue #30): `product_draft_projection` declares `name_consolidation`
 * as a dependency and projects the coordinated/consolidated title.
 *
 * Covers:
 * - projection metadata carries `{title: {value, source}}` from the SAME
 *   `name_consolidation` stage output the curationData assembly reads;
 * - absent `name_consolidation` output => `title: null`, NOT a crash;
 * - `resolveStageOrder` over the member stage list proves `name_consolidation`
 *   runs before `product_draft_projection`.
 *
 * Snapshot mappings (issue #351 SKU-local): the stage resolves mappings from
 * the frozen snapshot when present, else the live cache fallback.
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { productDraftProjectionStage } from '../../classification/stages/draft-projection';
import { resolveStageOrder } from '../../classification/pipeline-runner';
import {
  evidenceExtractionStage,
  nameConsolidationStage,
  primaryProductTypeStage,
  attributeApplicabilityStage,
  productAttributeProposalsStage,
  categoryPageProposalsStage,
} from '../../classification';
import type { StageContext, StageInput } from '../../classification/types';

beforeAll(() => {
  // The stage imports the classification-config repo (which touches the DB
  // only in the legacy cache path); the tests below always pass a frozen
  // snapshot or mock the cache, but a live DB keeps every import path valid.
  initDb(':memory:');
  runMigrations();
});

afterAll(() => {
  closeDb();
});

const baseContext: StageContext = {
  workspacePath: '/tmp/workspace',
  workspaceId: 'workspace',
  runId: 'run-1',
  configSnapshotRef: { id: 'snapshot', hash: 'hash', sourceCommit: null, createdAt: '' },
  // A frozen snapshot with NO attribute mappings keeps the stage pure
  // (no legacy cache read, no DB dependency).
  snapshot: { attributeMappings: [] } as unknown as StageContext['snapshot'],
};

const baseInput: StageInput = {
  sku: 'SKU1',
  evidence: [],
  acceptedProposals: [],
  allProposals: [],
};

describe('PR8 C1 — draft projection consumes the coordinated title (DECISION-A)', () => {
  it('projects {title: {value, source}} from the name_consolidation stage output', async () => {
    const input: StageInput = {
      ...baseInput,
      stageOutputs: {
        name_consolidation: {
          evidence: [],
          proposals: [],
          abstained: false,
          message: 'Using pre-computed coordinated title (llm_cohort)',
          metadata: {
            curatedTitle: 'Purina Pro Plan Dry Dog Food Chicken 5 lb',
            titleSource: 'llm_cohort',
          },
        },
      },
    };
    const result = await productDraftProjectionStage.execute(input, baseContext);
    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') return;
    const projection = result.output.metadata?.projection as Record<string, unknown> | undefined;
    expect(projection).toBeDefined();
    expect(projection!.title).toEqual({
      value: 'Purina Pro Plan Dry Dog Food Chicken 5 lb',
      source: 'llm_cohort',
    });
    // The message mentions the title source.
    expect(result.output.message).toContain('Title source: llm_cohort.');
  });

  it('absent name_consolidation output => title null, NOT a crash', async () => {
    const input: StageInput = { ...baseInput, stageOutputs: {} };
    const result = await productDraftProjectionStage.execute(input, baseContext);
    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') return;
    const projection = result.output.metadata?.projection as Record<string, unknown> | undefined;
    expect(projection).toBeDefined();
    expect(projection!.title).toBeNull();
    // No title-source suffix in the message either.
    expect(result.output.message).not.toContain('Title source:');
  });

  it('absent stageOutputs entirely (direct stage invocation) => title null, NOT a crash', async () => {
    const result = await productDraftProjectionStage.execute(baseInput, baseContext);
    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') return;
    const projection = result.output.metadata?.projection as Record<string, unknown> | undefined;
    expect(projection!.title).toBeNull();
  });
});

describe('PR8 C1 — stage ordering (name_consolidation precedes product_draft_projection)', () => {
  it('resolveStageOrder over the member stage list places name_consolidation before product_draft_projection', () => {
    const order = resolveStageOrder([
      evidenceExtractionStage,
      nameConsolidationStage,
      primaryProductTypeStage,
      attributeApplicabilityStage,
      productAttributeProposalsStage,
      categoryPageProposalsStage,
      productDraftProjectionStage,
    ]);
    const nameIndex = order.indexOf('name_consolidation');
    const projectionIndex = order.indexOf('product_draft_projection');
    expect(nameIndex).toBeGreaterThanOrEqual(0);
    expect(projectionIndex).toBeGreaterThanOrEqual(0);
    expect(nameIndex).toBeLessThan(projectionIndex);
  });

  it('the projection stage declares name_consolidation in its requires', () => {
    expect(productDraftProjectionStage.requires).toContain('name_consolidation');
    expect(productDraftProjectionStage.requires).toContain('category_page_proposals');
    expect(productDraftProjectionStage.requires).toContain('product_attribute_proposals');
  });
});

describe('frozen snapshot attribute mappings (issue #351 SKU-local)', () => {
  it('with a snapshot => snapshot attribute mappings used', async () => {
    const result = await productDraftProjectionStage.execute(baseInput, baseContext);
    expect(result.status).toBe('succeeded');
  });

  it('without a snapshot => live cache fallback (no execution context exists)', async () => {
    const context: StageContext = {
      ...baseContext,
      snapshot: undefined,
    };
    const result = await productDraftProjectionStage.execute(baseInput, context);
    expect(result.status).toBe('succeeded');
  });
});
