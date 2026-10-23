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
 * Frozen mappings are the only projection authority. Missing snapshots fail
 * closed; the stage never falls back to live cache.
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
import { buildRuntimeSnapshot } from '../../classification/runtime-snapshot';
import type { ClassificationConfig } from '../../shared/schemas/classification';

let baseContext: StageContext;

beforeAll(() => {
  initDb(':memory:');
  runMigrations();
  const config = {
    manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: '', updatedAt: '', fileVersions: {} },
    productTypes: [],
    attributes: [],
    attributeProfiles: [],
    attributeMappings: [],
    curationTargets: [],
    brands: [],
    guidance: [],
    modelPolicy: {
      defaultProvider: 'ollama',
      defaultModel: '',
      stageOverrides: {},
      imageDataSharing: 'local_only',
      textDataSharing: 'local_only',
    },
    dataSharing: {
      imagePolicy: 'local_only',
      textPolicy: 'local_only',
      sensitiveDataFiltering: true,
      retentionDays: 90,
    },
  } satisfies ClassificationConfig;
  const snapshot = buildRuntimeSnapshot({
    workspaceId: 'workspace',
    workspacePath: '/tmp/workspace',
    productSku: 'SKU1',
    config,
    configSnapshotRef: { id: 'snapshot', hash: 'hash', sourceCommit: null, createdAt: '' },
    sourceProductHash: null,
    pages: { state: 'no_verified_page_catalog', nameOnlyRecords: [] },
  });
  baseContext = {
    workspacePath: '/tmp/workspace',
    workspaceId: 'workspace',
    runId: 'run-1',
    configSnapshotRef: snapshot.configSnapshotRef,
    snapshot,
  };
});

afterAll(() => {
  closeDb();
});

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

  it('without a snapshot => fails closed instead of using live cache fallback', async () => {
    const context: StageContext = {
      ...baseContext,
      snapshot: undefined,
    };
    const result = await productDraftProjectionStage.execute(baseInput, context);
    expect(result.status).toBe('failed');
  });
});
