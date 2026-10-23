/**
 * Discovery run traceability (epic #46 batch-analysis follow-up).
 *
 * GPT review found the HIGH-severity gap: `onboarding_discovery_runs` had
 * zero rows and every `onboarding_sources.discovery_run_id` was NULL — the
 * table existed only in legacy live databases, no migration created it, and
 * no code wrote it. This suite proves the fixed worker:
 *
 * - creates one run row per discovery execution (trigger 'automatic');
 * - advances the run's current_step through the pipeline stages;
 * - stamps every candidate source with `discovery_run_id`;
 * - completes the run with the terminal outcome that matches the applied
 *   result (auto_selected / needs_input_candidates / failed);
 * - keeps runs batch-listed for audit.
 *
 * Offline-only: `discoverSources` and `verifyTopCandidates` are mocked — no
 * network, no LLM.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { upsertBrandSite } from '../../db/repositories/brand-site-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, findItemById } from '../../db/repositories/onboarding-item-repo';
import {
  getLatestDiscoveryRunForItem,
  listDiscoveryRunsForBatch,
  createDiscoveryRun,
} from '../../db/repositories/onboarding-source-repo';
import { OnboardingWorker } from '../../onboarding/job-queue';
import type { Workspace } from '../../shared/types';
import type { InsertSourceData, DiscoveryRunRow } from '../../db/repositories/onboarding-source-repo';
import type { VerificationResult } from '../../onboarding/page-verifier';

// Discovery + verification are injected through the worker's deps seam (no
// module mocking — vi.mock would leak into sibling test files).
let discoverImpl: ((upc: string, name: string, brandHint?: string | null) => Promise<{
  candidates: InsertSourceData[];
  consolidatedName: string | null;
  noDomainMapped?: boolean;
}>) | null = null;
let verifyImpl: ((candidates: InsertSourceData[]) => Promise<VerificationResult[]>) | null = null;

const CANDIDATE: InsertSourceData = {
  url: 'https://brand.example.com/product/upc1',
  title: 'Brand Product',
  confidence: 0.95,
  domain: 'brand.example.com',
  sourceMethod: 'sitemap_upc',
};

const STRONG_SIGNALS: VerificationResult['signals'] = {
  domainOfficial: true,
  isProductDetailPage: true,
  isListingOrSearchPage: false,
  isBlogOrCmsPage: false,
  titleSimilarity: 0.8,
  brandInPage: true,
  upcInPage: true,
  skuInPage: true,
  hasJsonLdProduct: true,
  hasShopifyProductJson: false,
  variantResolved: false,
  canonicalMatchesCandidate: true,
  pageTitle: 'Brand Product',
  pageHeading: 'Brand Product',
  titleNameOverlap: 0.85,
};

function strongVerification(candidate: InsertSourceData): VerificationResult {
  return {
    candidate,
    verificationScore: 0.9,
    signals: STRONG_SIGNALS,
    proofClass: 'exact_structured_gtin',
    hasStrongProof: true,
    extractedGtins: [],
    decisionReason: 'UPC match + title overlap',
    observedIdentity: { pageName: 'Brand Product', pageBrand: null, pageKind: 'product', variants: [], observedGtins: [], artifactRef: null, coverageComplete: true },
  };
}

function weakVerification(candidate: InsertSourceData): VerificationResult {
  return {
    candidate,
    verificationScore: 0.1,
    signals: { ...STRONG_SIGNALS, domainOfficial: false, upcInPage: false, titleNameOverlap: 0.05 },
    proofClass: 'none',
    hasStrongProof: false,
    extractedGtins: [],
    decisionReason: 'no identity proof on retailer page',
    observedIdentity: { pageName: 'Brand Product', pageBrand: null, pageKind: 'product', variants: [], observedGtins: [], artifactRef: null, coverageComplete: true },
  };
}

// ─── Harness ──────────────────────────────────────────────────────────────────

describe('discovery run traceability (epic #46 follow-up)', () => {
  let tempDir: string;
  let workspaceId: string;
  let wsPath: string;
  let batchId: string;

  beforeEach(() => {
    delete process.env.BAYSTATE_CMS_SOURCING_ENABLED;
    delete process.env.BAYSTATE_CMS_SOURCING_MODE;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-run-trace-test-'));
    initDb(path.join(tempDir, 'test.db'));
    runMigrations();
    wsPath = path.join(tempDir, 'ws');
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    fs.mkdirSync(path.join(wsPath, 'store', 'classification'), { recursive: true });
    workspaceId = 'ws-discovery-trace';
    const ws: Workspace = {
      id: workspaceId,
      name: 'Test Workspace',
      workspacePath: wsPath,
      gitPath: path.join(wsPath, '.git'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    };
    insertWorkspace(ws);
    batchId = createBatch({ workspaceId, name: 'Trace batch', fileName: 'trace.csv', totalItems: 2 }).id;
    discoverImpl = null;
    verifyImpl = null;
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function runWorkerOnce(): Promise<void> {
    const worker = new OnboardingWorker(workspaceId, wsPath, 10, 3, undefined, {
      discoverSources: (async (upc: string, name: string, brandHint?: string | null) => {
        if (!discoverImpl) throw new Error('discoverImpl not configured');
        return discoverImpl(upc, name, brandHint);
      }) as never,
      verifyTopCandidates: (async (candidates: InsertSourceData[]) => {
        if (!verifyImpl) return [];
        return verifyImpl(candidates);
      }) as never,
    });
    await worker.poll();
    await worker.drain();
  }

  test('auto-selected discovery writes a completed run and stamps sources', async () => {
    const [item] = insertItems(batchId, [{ upc: 'UPC-1', name: 'Brand Product', rowNumber: 1, stage: 'discovery', brandHint: 'BrandX' }], 'discovery', 1);
    // Map BrandX → brand.example.com so the ADR 0017 authority gate permits
    // auto-accept for the candidate (gate behavior is covered by
    // brand-authority-gate.test.ts).
    upsertBrandSite('BrandX', 'brand.example.com');
    discoverImpl = async () => ({
      candidates: [CANDIDATE],
      consolidatedName: 'Brand Product',
      noDomainMapped: false,
    });
    verifyImpl = async (candidates: InsertSourceData[]) => candidates.map(strongVerification);

    await runWorkerOnce();

    const run = getLatestDiscoveryRunForItem(item.id);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('completed');
    expect(run!.trigger).toBe('automatic');
    expect(run!.outcome).toBe('auto_selected');
    expect(run!.outcome_message).toContain('Auto-selected');
    expect(run!.started_at).not.toBeNull();
    expect(run!.completed_at).not.toBeNull();

    // Sources stamped with the run id (the auditability fix).
    const stamp = getDb().query('SELECT discovery_run_id FROM onboarding_sources WHERE item_id = ?').get(item.id) as
      | { discovery_run_id: string | null }
      | undefined;
    expect(stamp).not.toBeUndefined();
    expect(stamp!.discovery_run_id).toBe(run!.id);

    // Item progressed with the selected URL.
    const after = findItemById(item.id)!;
    expect(after.stage).toBe('discovery');
    expect(after.stageStatus).toBe('completed');
    expect(after.sourceUrl).toBe(CANDIDATE.url);
  });

  test('no-verification outcome records needs_input_candidates with the reason', async () => {
    const [item] = insertItems(batchId, [{ upc: 'UPC-2', name: 'Retailer Item', rowNumber: 1, stage: 'discovery' }], 'discovery', 1);
    discoverImpl = async () => ({
      candidates: [CANDIDATE],
      consolidatedName: 'Retailer Item',
      noDomainMapped: false,
    });
    verifyImpl = async (candidates: InsertSourceData[]) => candidates.map(weakVerification);

    await runWorkerOnce();

    const run = getLatestDiscoveryRunForItem(item.id);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('completed');
    expect(run!.outcome).toBe('needs_input_candidates');
    expect(run!.outcome_message).toContain('No candidate passed verification');

    // Human-held: item parked at discovery/completed without a URL.
    const after = findItemById(item.id)!;
    expect(after.stageStatus).toBe('completed');
    expect(after.sourceUrl).toBeNull();
  });
  test('identity-blocked strong proof does not claim authority failure', async () => {
    // DEV-0015 shape: strong GTIN proof on the mapped official domain, but the
    // matcher rejects — the parked reason must name gates, not authority.
    const [item] = insertItems(batchId, [{ upc: 'UPC-2B', name: 'WOOF PUPSICLE LAVENDER XL', rowNumber: 1, stage: 'discovery', brandHint: 'BrandX' }], 'discovery', 1);
    upsertBrandSite('BrandX', 'brand.example.com');
    discoverImpl = async () => ({
      candidates: [CANDIDATE],
      consolidatedName: 'WOOF PUPSICLE LAVENDER XL',
      noDomainMapped: false,
    });
    verifyImpl = async (candidates: InsertSourceData[]) => candidates.map((c) => ({
      ...strongVerification(c),
      observedIdentity: {
        ...strongVerification(c).observedIdentity,
        pageName: 'Pupsicle', // product_line_mismatch vs register line
        variants: [{ key: 'sm', label: 'Small' }, { key: 'lg', label: 'Large' }],
      },
    }));

    await runWorkerOnce();

    const run = getLatestDiscoveryRunForItem(item.id);
    expect(run!.outcome).toBe('needs_input_candidates');
    expect(run!.outcome_message).not.toContain('authority: auto-accept');
    expect(run!.outcome_message).toContain('gates:');
    expect(run!.outcome_message).toContain('BLOCKED:');
  });

  test('off-domain strong proof still reports authority denial', async () => {
    // Genuine authority fail: strong proof on a domain with no brand mapping.
    const [item] = insertItems(batchId, [{ upc: 'UPC-2C', name: 'Other Product', rowNumber: 1, stage: 'discovery', brandHint: 'Unmapped' }], 'discovery', 1);
    discoverImpl = async () => ({
      candidates: [{ ...CANDIDATE, url: 'https://other.example/product', domain: 'other.example' }],
      consolidatedName: 'Other Product',
      noDomainMapped: false,
    });
    verifyImpl = async (candidates: InsertSourceData[]) => candidates.map(strongVerification);

    await runWorkerOnce();

    const run = getLatestDiscoveryRunForItem(item.id);
    expect(run!.outcome).toBe('needs_input_candidates');
    expect(run!.outcome_message).toContain('authority: auto-accept');
  });

  test('no-domain-mapped brand parks with needs_input_setup outcome', async () => {
    const [item] = insertItems(batchId, [{ upc: 'UPC-3', name: 'No Domain Item', rowNumber: 1, stage: 'discovery' }], 'discovery', 1);
    discoverImpl = async () => ({
      candidates: [CANDIDATE],
      consolidatedName: null,
      noDomainMapped: true,
    });

    await runWorkerOnce();

    const run = getLatestDiscoveryRunForItem(item.id);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('completed');
    expect(run!.outcome).toBe('needs_input_setup');
    expect(run!.outcome_message).toContain('No official domain mapped');
  });

  test('discovery failure records a failed run with the error', async () => {
    const [item] = insertItems(batchId, [{ upc: 'UPC-4', name: 'Broken Item', rowNumber: 1, stage: 'discovery' }], 'discovery', 1);
    discoverImpl = async () => {
      throw new Error('simulated discovery failure');
    };

    await runWorkerOnce();

    const run = getLatestDiscoveryRunForItem(item.id);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('failed');
    expect(run!.outcome).toBe('failed');
    expect(run!.outcome_message).toContain('simulated discovery failure');

    // Retry path still active for the item (first failure → back to pending).
    const after = findItemById(item.id)!;
    expect(after.stage).toBe('discovery');
    expect(after.retryCount).toBeGreaterThan(0);
  });

  test('retry supersedes a stale running run instead of hitting the unique index', async () => {
    // Live-DB failure reproduction: a previous discovery attempt was
    // interrupted (process died mid-run), leaving a 'running' run row for the
    // item. The unique partial index `idx_discovery_runs_one_running` (v2
    // migration) forbids a second running run, so the retry's INSERT used to
    // raise `UNIQUE constraint failed: onboarding_discovery_runs.item_id` and
    // mark the item failed. `createDiscoveryRun` must supersede the stale run
    // first, preserving the old row as a failed audit trace.
    const [item] = insertItems(batchId, [{ upc: 'UPC-7', name: 'Brand Product', rowNumber: 1, stage: 'discovery', brandHint: 'BrandX' }], 'discovery', 1);
    // Map BrandX → brand.example.com so the candidate passes the ADR 0017
    // authority gate and the run completes deterministic-ally with
    // auto_selected (the gate outcome itself is covered by
    // brand-authority-gate.test.ts).
    upsertBrandSite('BrandX', 'brand.example.com');
    const staleId = createDiscoveryRun(item.id, {
      trigger: 'automatic',
      upc: 'UPC-7',
      name: 'Brand Product',
      brandHint: 'BrandX',
    });
    discoverImpl = async () => ({
      candidates: [CANDIDATE],
      consolidatedName: 'Brand Product',
      noDomainMapped: false,
    });
    verifyImpl = async (candidates: InsertSourceData[]) => candidates.map(strongVerification);

    await runWorkerOnce(); // pre-fix: throws UNIQUE constraint failed here

    const runs = getDb()
      .query('SELECT * FROM onboarding_discovery_runs WHERE item_id = ? ORDER BY rowid')
      .all(item.id) as DiscoveryRunRow[];
    expect(runs.length).toBe(2);

    // Stale run superseded with the audit reason preserved.
    expect(runs[0].id).toBe(staleId);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].outcome).toBe('failed');
    expect(runs[0].outcome_message).toContain('Superseded');

    // New run owns the trace and completes normally.
    expect(runs[1].status).toBe('completed');
    expect(runs[1].outcome).toBe('auto_selected');
    const after = findItemById(item.id)!;
    expect(after.stageStatus).toBe('completed');
    expect(after.sourceUrl).toBe(CANDIDATE.url);
  });

  test('runs are listable per batch (audit view)', async () => {
    // Both items carry a mapped brand so the authority gate auto-accepts
    // (see brand-authority-gate.test.ts for the gate itself).
    upsertBrandSite('BrandX', 'brand.example.com');
    insertItems(batchId, [{ upc: 'UPC-5', name: 'Brand Product', rowNumber: 1, stage: 'discovery', brandHint: 'BrandX' }], 'discovery', 1);
    insertItems(batchId, [{ upc: 'UPC-6', name: 'Brand Product', rowNumber: 2, stage: 'discovery', brandHint: 'BrandX' }], 'discovery', 1);
    discoverImpl = async () => ({
      candidates: [CANDIDATE],
      consolidatedName: null,
      noDomainMapped: false,
    });
    verifyImpl = async (candidates: InsertSourceData[]) => candidates.map(strongVerification);

    await runWorkerOnce();

    const runs = listDiscoveryRunsForBatch(batchId);
    expect(runs.length).toBe(2);
    for (const run of runs) {
      expect(run.status).toBe('completed');
      expect(run.outcome).toBe('auto_selected');
    }
  });
});
