import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { closeDb, getDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { GitClient } from '../../git/git-client';
import { previewCandidate, activateBundle } from '../../classification/config-store';
import { generateCandidate } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { writeProductFile } from '../../git/workspace-files';
import { sha256Hex } from '../../shared/stable-id';
import { ClassificationReadinessReportSchema } from '../../shared/schemas/classification';
import { assertClassificationReady, ClassificationNotReadyError } from '../../classification/readiness';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { loadRuntimeConfigAuthority, createRuntimeActivationContext } from '../../classification/config-loader';
import classificationRoutes from '../../server/routes/classification-routes';
import catalogClassificationRoutes from '../../server/routes/catalog-classification-routes';
import type { PageRecord } from '../../shared/schemas/page';

const REVIEWED_FIELDS = [
  'ProductField1', 'ProductField4', 'ProductField8', 'ProductField16', 'ProductField17',
  'ProductField18', 'ProductField19', 'ProductField20', 'ProductField21',
  'ProductField22', 'ProductField23', 'ProductField24', 'ProductField25',
  'ProductField26', 'ProductField27', 'ProductField28', 'ProductField29',
  'ProductField30', 'ProductField32',
];
const ARTIFACT_CONTENT = JSON.stringify({
  schemaVersion: 1,
  sourceTreeHash: 'm7'.repeat(32),
  productFileCount: 0,
  parseFailureCount: 0,
  parseFailures: [],
  fieldRegistry: { entryCount: REVIEWED_FIELDS.length, xmlFields: [...REVIEWED_FIELDS].sort() },
  fields: [],
  pages: [],
});
const EVIDENCE_HASH = sha256Hex(ARTIFACT_CONTENT);

let root: string;
let workspaceId: string;

function runGit(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
}

function verifiedRecord(key: string, name: string): PageRecord {
  return {
    identity: { kind: 'exported_guid', key, status: 'verified' },
    name,
    parentRef: null,
    availability: 'available',
  };
}

function evidenceWithFields(fields: string[]): CatalogEvidence {
  return {
    schemaVersion: 1,
    sourceTreeHash: '0'.repeat(64),
    productFileCount: 0,
    parseFailureCount: 0,
    parseFailures: [],
    fieldRegistry: { entryCount: fields.length, xmlFields: [...fields].sort() },
    fields: [...fields].sort().map(xmlField => ({
      xmlField,
      recordCount: 1,
      nonEmptyCount: 1,
      distinctValueCount: 1,
      distinctValueHash: '0'.repeat(64),
      delimiterEvidence: [],
    })),
    pages: [],
  };
}

async function freshWorkspace(): Promise<void> {
  workspaceId = randomUUID();
  root = fs.mkdtempSync(path.join(os.tmpdir(), `readiness-${workspaceId.slice(0, 8)}`));
  fs.mkdirSync(path.join(root, 'store', 'classification'), { recursive: true });
  fs.mkdirSync(path.join(root, 'products'), { recursive: true });

  const dbPath = path.join(root, '.shopsite-cms', 'app.db');
  initDb(dbPath);
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'test',
    workspacePath: root,
    gitPath: path.join(root, '.git'),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });

  const git = new GitClient(root);
  git.init();
  fs.writeFileSync(path.join(root, 'store', 'manifest.json'), JSON.stringify({ schemaVersion: 1 }), 'utf-8');
  // Field registry attests the reviewed Catalog Field set for active v2 loads.
  fs.writeFileSync(
    path.join(root, 'store', 'field-registry.json'),
    JSON.stringify({ entries: [...REVIEWED_FIELDS].sort().map(xmlField => ({ xmlField })) }),
    'utf-8',
  );
  runGit(['add', '--', 'store/manifest.json', 'store/field-registry.json']);
  runGit(['commit', '-m', 'seed catalog manifest']);

  // Activate the reviewed v2 candidate (page target enabled) with the
  // reviewed activation context. Verified page IDs are supplied so active
  // validation passes; the REAL runtime context reads the page import.
  const candidate = generateCandidate(BayStatePetGardenSeed, evidenceWithFields(REVIEWED_FIELDS));
  const preview = previewCandidate(candidate.bundle, root, { catalogEvidence: ARTIFACT_CONTENT });
  if (!preview.hash) {
    throw new Error(`preview failed: ${preview.report.findings.map(f => f.code).join(', ')}`);
  }
  const activationContext = {
    catalogFields: REVIEWED_FIELDS,
    verifiedPageIds: ['page-1', 'page-2'],
    verifyCatalogEvidence: (input: { catalogEvidenceHash: string; sourceCatalogCommit: string }) => ({
      verified: input.catalogEvidenceHash === EVIDENCE_HASH && input.sourceCatalogCommit === runGit(['rev-parse', 'HEAD']),
      reason: 'test verifier',
    }),
  };
  await activateBundle(preview.hash, null, {
    workspacePath: root,
    workspaceId,
    activationContext: activationContext as never,
    catalogEvidenceHash: EVIDENCE_HASH,
  });
}

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api', classificationRoutes);
  app.route('/api', catalogClassificationRoutes);
  return app;
}

function writeSkuProduct(sku: string): void {
  writeProductFile(root, {
    sku,
    name: 'Readiness test product',
    core: {
      name: 'Readiness test product',
      description: '',
      weight: null,
      media: { primary: null, additional: [] },
      seo: { searchKeywords: '' },
    },
    customFields: {},
    shopsite: { preserved: { unknownElements: {}, advancedBlocks: {} } },
  } as never);
}

describe('classification readiness (issue #17 L)', () => {
  beforeEach(async () => {
    // P0 taxonomy freeze: this suite exercises activation, so the freeze is
    // explicitly lifted for the duration of the tests.
    setTaxonomyFreezeForTests(false);
    await freshWorkspace();
  });

  afterAll(() => {
    setTaxonomyFreezeForTests(true);
    closeDb();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  describe('assertClassificationReady', () => {
    it('throws ClassificationNotReadyError for an enabled Page target without verified Page IDs', () => {
      const authority = loadRuntimeConfigAuthority(root, createRuntimeActivationContext(root, workspaceId));
      const context = createRuntimeActivationContext(root, workspaceId);
      expect(() => assertClassificationReady(authority, {
        catalogFields: context.catalogFields,
        verifyCatalogEvidence: context.verifyCatalogEvidence,
        verifiedPageIds: context.verifiedPageIds,
      })).toThrow(ClassificationNotReadyError);
      try {
        assertClassificationReady(authority, {
          catalogFields: context.catalogFields,
          verifyCatalogEvidence: context.verifyCatalogEvidence,
          verifiedPageIds: context.verifiedPageIds,
        });
        throw new Error('expected ClassificationNotReadyError');
      } catch (err) {
        expect(err).toBeInstanceOf(ClassificationNotReadyError);
        const notReady = err as ClassificationNotReadyError;
        expect(notReady.code).toBe('classification_not_ready');
        expect(notReady.readiness.isReady).toBe(false);
        expect(notReady.readiness.findings.map(f => f.code)).toContain('verified_page_catalog_required');
      }
    });

    it('passes once verified Page IDs are available from an active import', () => {
      activatePageImportFromRecords({
        workspaceId,
        sourceHash: 'a'.repeat(64),
        parserFormatVersion: 'pages-xml-1',
        records: [verifiedRecord('1', 'Dog Food'), verifiedRecord('2', 'Dog Toys')],
        activatedBy: 'test',
      });
      const authority = loadRuntimeConfigAuthority(root, createRuntimeActivationContext(root, workspaceId));
      const context = createRuntimeActivationContext(root, workspaceId);
      expect([...(context.verifiedPageIds ?? [])].length).toBeGreaterThan(0);
      const report = assertClassificationReady(authority, {
        catalogFields: context.catalogFields,
        verifyCatalogEvidence: context.verifyCatalogEvidence,
        verifiedPageIds: context.verifiedPageIds,
      });
      expect(report!.isReady).toBe(true);
      expect(report!.capabilities.categoryPages.runnable).toBe(true);
    });
  });

  describe('readiness route', () => {
    it('GET /api/classification/readiness returns a schema-valid not-ready report without a Page import', async () => {
      const app = makeApp();
      const res = await app.request('/api/classification/readiness');
      expect(res.status).toBe(200);
      const body = await res.json() as { readiness: unknown };
      const parsed = ClassificationReadinessReportSchema.safeParse(body.readiness);
      expect(parsed.success).toBe(true);
      expect(parsed.data!.isReady).toBe(false);
      expect(parsed.data!.capabilities.categoryPages.enabled).toBe(true);
      expect(parsed.data!.capabilities.categoryPages.runnable).toBe(false);
      expect(parsed.data!.findings.map(f => f.code)).toContain('verified_page_catalog_required');
    });

    it('POST runs returns 409 classification_not_ready and creates NO run when not ready', async () => {
      const app = makeApp();
      writeSkuProduct('READY-1');
      const before = (getDb().query('SELECT COUNT(*) c FROM classification_runs').get() as { c: number }).c;
      const res = await app.request('/api/products/READY-1/classification/runs', { method: 'POST' });
      expect(res.status).toBe(409);
      const body = await res.json() as { code: string; readiness: { isReady: boolean } };
      expect(body.code).toBe('classification_not_ready');
      expect(body.readiness.isReady).toBe(false);
      // The 409 readiness payload must conform to the shared report schema
      // (every capability carries reason: string | null).
      const parsed = ClassificationReadinessReportSchema.safeParse(body.readiness);
      expect(parsed.success).toBe(true);
      expect(parsed.data!.capabilities.categoryPages.reason).not.toBeUndefined();
      const after = (getDb().query('SELECT COUNT(*) c FROM classification_runs').get() as { c: number }).c;
      expect(after).toBe(before);
    });

    it('fails closed with NO run when the Page catalog is incoherent during capture', async () => {
      // Activate a verified import, then empty its records_json while the
      // verified page_index rows remain — capture must throw before any run.
      activatePageImportFromRecords({
        workspaceId,
        sourceHash: 'd'.repeat(64),
        parserFormatVersion: 'pages-xml-1',
        records: [verifiedRecord('1', 'Dog Food'), verifiedRecord('2', 'Dog Toys')],
        activatedBy: 'test',
      });
      getDb().run("UPDATE page_imports SET records_json = '[]' WHERE workspace_id = ?", [workspaceId]);
      const app = makeApp();
      writeSkuProduct('READY-3');
      const before = (getDb().query('SELECT COUNT(*) c FROM classification_runs').get() as { c: number }).c;
      const res = await app.request('/api/products/READY-3/classification/runs', { method: 'POST' });
      // Capture drift is a hard failure (not readiness): the request fails and
      // no run row is created.
      expect(res.status).not.toBe(200);
      const after = (getDb().query('SELECT COUNT(*) c FROM classification_runs').get() as { c: number }).c;
      expect(after).toBe(before);
    });

    it('starts a run once the verified Page catalog exists (no readiness 409)', async () => {
      activatePageImportFromRecords({
        workspaceId,
        sourceHash: 'b'.repeat(64),
        parserFormatVersion: 'pages-xml-1',
        records: [verifiedRecord('1', 'Dog Food'), verifiedRecord('2', 'Dog Toys')],
        activatedBy: 'test',
      });
      const app = makeApp();
      writeSkuProduct('READY-2');
      const res = await app.request('/api/products/READY-2/classification/runs', { method: 'POST' });
      const body = (await res.json()) as { code?: string };
      // Readiness no longer blocks: a run row is created before pipeline
      // execution. The pipeline may still 409 for unrelated model-policy
      // reasons (no credentials in tests), but never for readiness.
      expect(body.code).not.toBe('classification_not_ready');
      const runs = (getDb().query(
        'SELECT COUNT(*) c FROM classification_runs WHERE product_sku = ?',
      ).get('READY-2') as { c: number }).c;
      expect(runs).toBe(1);
    });
  });
});
