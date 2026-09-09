/**
 * Cohort Curation test harness (plan Slice 2, §3.2 item 4).
 *
 * Test-only disposable workspace/DB setup, deterministic fixture data, and
 * transport recording. NOT an alternate implementation of cohort execution:
 * every scenario runs through the production `executeClaim` seam.
 *
 * Each fixture path lives beneath a newly created temp root; setup FAILS if
 * it resolves outside `os.tmpdir()` (never the real workspace/catalog/DB).
 * Callers clean only that exact temp root via the returned `cleanup`.
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb, closeDb } from '../../../db/connection';
import { runMigrations } from '../../../db/migrations';
import { insertWorkspace } from '../../../db/repositories/workspace-repo';
import { createBatch } from '../../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  listItemsByBatch,
  updateItemExtractionData,
} from '../../../db/repositories/onboarding-item-repo';
import { insertExtraction } from '../../../db/repositories/onboarding-extraction-repo';
import {
  refreshCandidateCohorts,
  updateCohortStatus,
} from '../../../db/repositories/curation-cohort-repo';
import { syncConfigToCache } from '../../../db/repositories/classification-config-repo';
import { saveClassificationConfig, loadClassificationConfig } from '../../../classification/config-loader';
import { hashCanonicalJson } from '../../../shared/stable-id';
import { computeCohortTitleInputHash } from '../../../onboarding/cohort-curation/titles';
import { titleExecutionTypeAuthorityFromRun } from '../../../classification/cohort-decision-authority';
import { formatDeterministicTitle } from '../../../onboarding/cohort-name-coordinator';
import { insertCohortTitleOutputsOnce } from '../../../db/repositories/classification-cohort-output-repo';
import { getCohortSnapshotByHash } from '../../../db/repositories/classification-cohort-run-repo';
import { getRuntimeSnapshotByHash } from '../../../classification/runtime-snapshot';
import { parseExecutionEvidenceProjection } from '../../../shared/schemas/cohorts';
import type { CohortRun, ExecutionEvidenceProjection } from '../../../shared/schemas/cohorts';
import type { ClassificationConfig } from '../../../shared/schemas/classification';
import type { InsertItemData } from '../../../db/repositories/onboarding-item-repo';
import type { OnboardingItem } from '../../../shared/schemas/onboarding';
import type { CurationCohort } from '../../../shared/schemas/cohorts';
import { createCohortCuration } from '../../../onboarding/cohort-curation/index';
import type { CohortCurationTestCheckpoints } from '../../../onboarding/cohort-curation/index';
import type { CohortExecutionSummary } from '../../../onboarding/cohort-curation/members';

export interface DisposableCurationContext {
  workspaceId: string;
  workspacePath: string;
  /** Absolute path of the disposable SQLite file (for subprocess tests). */
  dbPath: string;
  /** Remove ONLY the temp root created by `createDisposableCurationContext`. */
  cleanup: () => void;
}

/** Minimal legacy config with every curation target disabled (mirrors the
 *  worker-suite V1_CONFIG): the modular pipeline emits no reviewable
 *  abstentions and name_consolidation always has title signals, so a fully
 *  successful member run deterministically completes. */
export const DISABLED_TARGETS_CONFIG: ClassificationConfig = {
  manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: '2026-08-01T12:00:00.000Z', updatedAt: '2026-08-01T12:00:00.000Z', fileVersions: {} },
  productTypes: [
    { id: 'dry-dog-food', name: 'Dry Dog Food', description: null, attributeProfileId: 'dry-dog-food-profile', oldIdAliases: [] },
  ],
  attributes: [
    { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled' as const, canonicalUnit: null, allowedValues: ['Chicken', 'Beef', 'Salmon', 'Lamb'], valueAliases: [{ alias: 'chicken', mapsTo: 'Chicken' }, { alias: 'beef', mapsTo: 'Beef' }], visualEvidenceEligibility: 'eligible' as const, isClaim: false, isCompositionAttribute: false, group: 'Food' },
  ],
  attributeProfiles: [
    { id: 'dry-dog-food-profile', productTypeId: 'dry-dog-food', name: 'Dry Dog Food Profile', attributes: [{ attributeId: 'flavor', required: true, cardinality: 'single' as const, applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] }] },
  ],
  attributeMappings: [
    { id: 'flavor-mapping', attributeId: 'flavor', catalogField: 'ProductField1', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
  ],
  curationTargets: [
    { id: 'test-product-type', kind: 'product_type' as const, label: 'Test Product Type', enabled: false, selectionMode: 'single' as const, attributeId: null, catalogField: null, optionSource: 'configured' as const, required: false, mandatory: false, sortOrder: 0 },
    { id: 'test-pages', kind: 'page' as const, label: 'Test Pages', enabled: false, selectionMode: 'multiple' as const, attributeId: null, catalogField: null, optionSource: 'live_store' as const, required: false, mandatory: false, sortOrder: 1 },
    { id: 'test-flavor', kind: 'product_field' as const, label: 'Test Flavor', enabled: false, selectionMode: 'single' as const, attributeId: 'flavor', catalogField: 'ProductField1', optionSource: 'configured' as const, required: false, mandatory: false, sortOrder: 2 },
  ],
  brands: [],
  guidance: [],
  modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only' as const, textDataSharing: 'local_only' as const },
  dataSharing: { imagePolicy: 'local_only' as const, textPolicy: 'local_only' as const, sensitiveDataFiltering: true, retentionDays: 90 },
};

export function createDisposableCurationContext(): DisposableCurationContext {
  const root = path.join(os.tmpdir(), `baystate-cms-cohort-curation-${randomUUID().slice(0, 8)}`);
  const resolved = path.resolve(root);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    throw new Error(`Harness refusal: temp root ${resolved} is outside os.tmpdir()`);
  }
  if (fs.existsSync(path.join(resolved, '.baystate-cms', 'app.db'))) {
    throw new Error(`Harness refusal: ${resolved} already holds a database`);
  }
  fs.mkdirSync(path.join(resolved, '.baystate-cms'), { recursive: true });
  fs.mkdirSync(path.join(resolved, 'store', 'classification'), { recursive: true });
  initDb(path.join(resolved, '.baystate-cms', 'app.db'));
  runMigrations();  const workspaceId = randomUUID();
  const workspacePath = path.join(resolved, `ws-${workspaceId.slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
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
  saveClassificationConfig(workspacePath, DISABLED_TARGETS_CONFIG);
  syncConfigToCache(workspaceId, loadClassificationConfig(workspacePath));
  return {
    workspaceId,
    workspacePath,
    dbPath: path.join(resolved, '.baystate-cms', 'app.db'),
    cleanup: () => {
      try { closeDb(); } catch { /* ok */ }
      try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* ok */ }
    },
  };
}

export function settledExtraction(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    title: 'Original Web Title',
    brand: 'Acme',
    description: 'Original description',
    bulletPoints: ['Bullet one', 'Bullet two'],
    primaryImage: 'https://img.example.com/primary.jpg',
    additionalImages: ['https://img.example.com/alt1.jpg'],
    searchKeywords: 'kibble dog',
    customFields: { Flavor: 'Chicken' },
    fieldProvenance: { title: 'json-ld' },
    packagingTitle: 'Package OCR Title',
    packagingOcrData: null,
    ocrOutcome: { status: 'succeeded', localStatus: 'succeeded', model: 'test-vlm', imageCount: 1 },
    productIntelligenceEvidence: [],
    ...overrides,
  };
}

export function ocrInputHashFor(sourceUrl: string, ext: Record<string, any>): string {
  return hashCanonicalJson({
    sourceUrl,
    extractionSourceUrl: sourceUrl,
    primaryImage: ext.primaryImage ?? null,
    additionalImages: Array.isArray(ext.additionalImages) ? ext.additionalImages : [],
  });
}

/** Insert batch + items, write extraction data, form cohorts, flip ready. */
export function createReadyCohort(
  wsId: string,
  extByUpc: Record<string, Record<string, any>>,
): { batchId: string; items: OnboardingItem[]; cohorts: CurationCohort[] } {
  const itemsData: InsertItemData[] = Object.entries(extByUpc).map(([upc, ext], index) => ({
    upc,
    name: String(ext._name ?? ext.title ?? `Item ${upc}`),
    brandHint: String(ext._brandHint ?? ext.brand ?? 'Acme'),
    sourceUrl: String(ext._sourceUrl ?? `https://brand.example.com/${upc}`),
    rowNumber: index + 1,
    stage: 'curation' as const,
    stageStatus: 'pending' as const,
  }));
  const batchId = createBatch({ workspaceId: wsId, name: 'Curation Batch', fileName: 'curation.xlsx', totalItems: itemsData.length }).id;
  const items = insertItems(batchId, itemsData);
  for (const item of items) {
    const sourceUrl = item.sourceUrl ?? `https://brand.example.com/${item.upc}`;
    const ext: Record<string, any> = { ...extByUpc[item.upc] };
    delete ext._sourceUrl;
    delete ext._name;
    delete ext._brandHint;
    if (ext.ocrInputHash === undefined) {
      ext.ocrInputHash = ocrInputHashFor(sourceUrl, ext);
    }
    updateItemExtractionData(item.id, JSON.stringify(ext));
    insertExtraction({
      itemId: item.id,
      sourceUrl,
      extractionDataJson: JSON.stringify(ext),
      extractionMethod: 'test',
      confidence: 1,
    });
  }
  const formed = refreshCandidateCohorts(wsId, batchId, listItemsByBatch(batchId));
  for (const cohort of formed) updateCohortStatus(cohort.id, 'ready');
  return { batchId, items: listItemsByBatch(batchId), cohorts: formed };
}

/** Expire a run's claim lease (same characterized mechanism the existing
 *  reclaim tests use: backdate `lease_expires_at`). Ownership, CAS, and
 *  reclaim semantics stay production code. */
export function expireClaimLease(runId: string): void {
  getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', runId]);
}

export interface RecordedTransport {
  url: string;
  init: RequestInit | undefined;
}

export interface FetchTransportInstaller {
  calls: RecordedTransport[];
  restore: () => void;
}

/**
 * Default-deny fetch transport: only explicitly faked LLM/OCR replies cross
 * the transport boundary. The responder returns a `Response` (and may
 * record), or throws to deny. Restores the original fetch on `restore`.
 */
export function installFetchTransport(
  responder: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): FetchTransportInstaller {
  const calls: RecordedTransport[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
    calls.push({ url, init });
    return responder(url, init);
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

/** Canned Ollama-chat reply carrying a JSON payload in message.content. */
export function ollamaChatReply(payload: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/**
 * Seed the durable `curated_title` outputs for a frozen run (mirrors the
 * worker-suite helper): active-cohort runs over schema-v1 member snapshots
 * (no frozen model-execution plan) fail closed before any transport, so
 * tests that execute members seed the canonical v1 T-hash set FIRST and the
 * parent op REUSES it with zero transport. Seeded titles mirror the
 * deterministic cohort fallback the legacy coordinator produced.
 */
export function seedDeterministicTitleOutputs(workspaceId: string, run: CohortRun): void {
  const snap = getCohortSnapshotByHash(workspaceId, run.evidenceSnapshotHash!)!;
  // Slice 3: the stale @ts-expect-error was removed (unused directive — the
  // parse adapter types cleanly). V2 test fixtures stay byte-readable via
  // the parse adapter; no behavior change.
  const projection = parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson)) as ExecutionEvidenceProjection;
  const ordered = [...projection.members].sort((a, b) => a.ordinal - b.ordinal);
  const child = getDb().query(
    'SELECT config_snapshot_hash FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at DESC LIMIT 1',
  ).get(run.id, ordered[0]?.onboardingItemId ?? '') as { config_snapshot_hash: string } | undefined;
  const snapshot = child?.config_snapshot_hash
    ? getRuntimeSnapshotByHash(workspaceId, child.config_snapshot_hash)
    : null;
  const inputHash = computeCohortTitleInputHash({
    run,
    projection,
    executionTypeAuthority: titleExecutionTypeAuthorityFromRun(run, snapshot),
  });
  const outputs = projection.members
    .map(member => ({
      productSku: member.productSku ?? '',
      title: formatDeterministicTitle(
        member.spreadsheetIdentity.name,
        member.spreadsheetIdentity.brandHint,
      ),
      source: 'cohort_fallback' as const,
    }))
    .filter(o => o.productSku.length > 0);
  if (outputs.length === 0) return;
  insertCohortTitleOutputsOnce({ workspaceId, runId: run.id, inputHash, outputs });
}

/**
 * Enter cohort execution through the PUBLIC seam (plan Slice 6): the only
 * production entry is `executeClaim`, so characterization suites that used to
 * call `processCohort` directly go through here. Returns the execution
 * summary, or throws on a not-executed disposition (a test that reaches this
 * helper always expects execution).
 */
export async function executeViaSeam(
  workspacePath: string,
  workspaceId: string,
  runId: string,
  workerId: string,
  checkpoints?: CohortCurationTestCheckpoints,
): Promise<CohortExecutionSummary> {
  const curation = createCohortCuration({ workspacePath, workspaceId });
  const result = await curation.executeClaim(runId, workerId, checkpoints);
  if (!result.executed) {
    throw new Error(`expected execution through the public seam (disposition: ${result.disposition})`);
  }
  return result.summary;
}
