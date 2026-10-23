import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { findItemById, insertItems } from '../../db/repositories/onboarding-item-repo';
import { insertSources, stampSourcesWithDiscoveryRun } from '../../db/repositories/onboarding-source-repo';
import { listOfficialPageDecisions, recordOfficialPageDecision } from '../../db/repositories/official-page-decision-repo';
import { OnboardingWorker } from '../../onboarding/job-queue';
import { ExtractionDataSchema } from '../../shared/schemas/onboarding';
import { createAndActivateVersion } from '../../db/repositories/profile-version-repo';
import { runMatrix, resetTestMatrixForTest } from '../../onboarding/profile-test-matrix';
import { setRepresentativeSuite } from '../../db/repositories/representative-suite-repo';
import { createWaiver } from '../../db/repositories/waiver-repo';
import { advanceDiscoveryItemToExtraction } from '../../onboarding/auto-advance';

const url = 'https://wild.example/products/better-bone-medium-venison-12oz';
let extractPayload: unknown = null;

function extraction(title: string, variantKey: string | null = null) {
  return ExtractionDataSchema.parse({
    title, brand: 'Wild', sourceUrl: url, confidence: 0.9, fieldProvenance: { title: 'profile_selector' },
    selectedVariant: variantKey ? {
      resolutionId: 'res-1', identityMatrixHash: 'a'.repeat(64), parserVersion: 1,
      selectedVariantKey: variantKey, decisionOrigin: 'automatic',
      selectedDeepLink: url, matchedBy: 'sku', evidencePaths: [], createdAt: new Date().toISOString(),
    } : null,
  });
}

describe('extraction identity revalidation', () => {
  let dir = '';
  const workspaceId = 'ws-extraction-identity';
  let wsPath = '';
  let batchId = '';

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'extraction-identity-'));
    initDb(path.join(dir, 'test.db'));
    runMigrations();
    wsPath = path.join(dir, 'ws');
    insertWorkspace({ id: workspaceId, name: workspaceId, workspacePath: wsPath, gitPath: path.join(wsPath, '.git'), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });
    batchId = createBatch({ workspaceId, name: 'batch', fileName: 'batch.csv', totalItems: 3 }).id;
    extractPayload = null;
  });

  afterEach(() => {
    resetTestMatrixForTest();
    try {
      getDb().exec('DELETE FROM profile_sample_observations');
    } catch { /* best-effort */ }
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedConfirmedItem(variantKey: string | null = null) {
    const [item] = insertItems(batchId, [{ upc: '017800010009', name: 'WILD BETTER BONE MD VNSN 12 OZ', brandHint: 'Wild', rowNumber: 1 }], 'find_product_page');
    const [source] = insertSources(item.id, [{ url, domain: 'wild.example', confidence: 0.95, sourceMethod: 'sitemap_upc' }]);
    stampSourcesWithDiscoveryRun(item.id, 'discovery-run-test');
    recordOfficialPageDecision({ workspaceId, itemId: item.id, sourceId: source.id, evidenceKind: 'automatic_name', pageTitle: 'Wild Better Bone Medium Venison 12oz', variantKey, signals: {}, sourceRunId: 'discovery-run-test' });
    getDb().query("UPDATE onboarding_items SET stage = 'collect_details', stage_status = 'pending' WHERE id = ?").run(item.id);
    return findItemById(item.id)!;
  }

  async function seedProfile() {
    const version = createAndActivateVersion({
      domain: 'wild.example', selectors: { titleSelector: 'h1' }, runtime: 'rendered',
      sampleIds: [url], artifactHashes: ['hash'], validationSummary: { imageRuleOk: true },
      provenance: { provider: 'test', model: 'test', configId: 'test' }, approver: 'operator', reason: 'test',
    });
    setRepresentativeSuite('wild.example', [url], 'operator');
    createWaiver('wild.example', 'single fixture sample', 'operator');
    const { recordSampleObservation } = await import('../../db/repositories/profile-sample-observation-repo');
    recordSampleObservation({
      domain: 'wild.example', versionId: version.id, sampleUrl: url,
      expectedTitle: 'Wild Better Bone Medium Venison 12oz',
      expectedDescription: 'Wild venison chew for medium dogs',
      expectedPrimaryImage: 'https://wild.example/images/better-bone.jpg',
      contentHash: 'hash', approver: 'operator',
    });
    await runMatrix({ domain: 'wild.example', draftVersion: version.id,
      samples: [{ id: url, url, expectedTitle: 'Wild Better Bone Medium Venison 12oz',
        observation: { title: 'Wild Better Bone Medium Venison 12oz', description: 'Wild venison chew for medium dogs', primaryImage: 'https://wild.example/images/better-bone.jpg', variantKey: null, contentHash: 'hash' },
        expectedContentHash: 'hash' }],
      runner: async () => ({ extractedTitle: 'Wild Better Bone Medium Venison 12oz', provenance: 'profile_selector', artifactHash: 'hash', success: true,
        extractedProduct: { title: 'Wild Better Bone Medium Venison 12oz', description: 'Wild venison chew for medium dogs', images: ['https://wild.example/images/better-bone.jpg'], primaryImage: 'https://wild.example/images/better-bone.jpg' } }),
    });
  }

  async function runExtractionOnce() {
    const worker = new OnboardingWorker(workspaceId, wsPath, 1, 1, undefined, {
      extractProductData: (async () => extractPayload) as never,
    });
    await worker.poll();
    await worker.drain();
  }

  test('changed page content fails closed without persisting an extraction', async () => {
    const item = seedConfirmedItem();
    await seedProfile();
    extractPayload = extraction('Wild Better Bone Medium Chicken 12oz');
    await runExtractionOnce();
    expect(findItemById(item.id)?.stageStatus).toBe('failed');
    expect(findItemById(item.id)?.errorMessage).toContain('variant_conflict');
    expect(getDb().query('SELECT COUNT(*) AS count FROM onboarding_extractions WHERE item_id = ?').get(item.id)).toMatchObject({ count: 0 });
  });

  test('stale variant receipt fails closed without retrying the same selection', async () => {
    const item = seedConfirmedItem('medium-12oz');
    await seedProfile();
    extractPayload = extraction('Wild Better Bone Medium Venison 12oz', 'large-24oz');
    await runExtractionOnce();
    expect(findItemById(item.id)?.stageStatus).toBe('failed');
    expect(findItemById(item.id)?.errorMessage).toContain('stale_selection');
    expect(getDb().query('SELECT COUNT(*) AS count FROM onboarding_extractions WHERE item_id = ?').get(item.id)).toMatchObject({ count: 0 });
  });

  test('missing package detail parks for operator review instead of advancing', async () => {
    const item = seedConfirmedItem();
    await seedProfile();
    extractPayload = extraction('Wild Better Bone');
    await runExtractionOnce();
    expect(findItemById(item.id)?.stageStatus).toBe('needs_input');
    expect(findItemById(item.id)?.errorMessage).toContain('needs operator');
    expect(getDb().query('SELECT COUNT(*) AS count FROM onboarding_extractions WHERE item_id = ?').get(item.id)).toMatchObject({ count: 0 });
  });

  test('an unconfirmed source URL never reaches extraction even when it looks plausible', async () => {
    const [item] = insertItems(batchId, [{ upc: '017800010009', name: 'WILD BETTER BONE MD VNSN 12 OZ', brandHint: 'Wild', rowNumber: 1 }], 'find_product_page');
    const [source] = insertSources(item.id, [{ url, domain: 'wild.example', confidence: 0.95, sourceMethod: 'sitemap_upc' }]);
    expect(listOfficialPageDecisions(item.id)).toEqual([]);
    getDb().query("UPDATE onboarding_items SET source_url = ?, stage = 'collect_details', stage_status = 'pending' WHERE id = ?").run(source.url, item.id);
    await seedProfile();
    extractPayload = extraction('Wild Better Bone Medium Venison 12oz');
    await runExtractionOnce();
    expect(findItemById(item.id)?.stageStatus).toBe('needs_input');
    expect(getDb().query('SELECT COUNT(*) AS count FROM onboarding_extractions WHERE item_id = ?').get(item.id)).toMatchObject({ count: 0 });
  });
  test('a URL without a matching durable decision and discovery run cannot advance', () => {
    const [item] = insertItems(batchId, [{ upc: '017800010009', name: 'WILD BETTER BONE MD VNSN 12 OZ', brandHint: 'Wild', rowNumber: 1 }], 'find_product_page');
    getDb().query("UPDATE onboarding_items SET source_url = ?, stage_status = 'completed' WHERE id = ?").run(url, item.id);
    expect(advanceDiscoveryItemToExtraction(item.id)).toEqual({
      advanced: false,
      reason: 'official_decision_binding_missing',
    });
    expect(findItemById(item.id)?.stage).toBe('find_product_page');
  });
});
