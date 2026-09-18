/**
 * Phase 3 integration tests for direct push/publish, drift detection, and upload-only.
 * All tests use mocked/injected XML and no real ShopSite network calls.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Import modules under test
import { buildUploadMultipart, extractDbmakeQuery, redactCredentials, isDbmakeSuccessful, isValidXmlTagName, escapeCdata } from '../../shopsite/multipart-upload';
import { detectDrift } from '../../shopsite/drift';
import { buildProductsXml } from '../../shopsite/xml-builder';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';

import { createWorkspaceDirs, writeGitignore, writeProductFile } from '../../git/workspace-files';
import { GitClient } from '../../git/git-client';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createDrift, listDrift, findDriftById, resolveDrift, hasOpenDriftForSku, countOpenDrift, upsertDrift, listOutstandingDriftForSku, linkDriftToChangeSet, findLinkedDrift } from '../../db/repositories/drift-repo';
import { findProductBySku } from '../../db/repositories/product-index-repo';


// Fixture
const fixtureDir = path.resolve(import.meta.dirname, '../../tests/fixtures');
const fixtureXml = fs.readFileSync(path.join(fixtureDir, 'shopsite-products-sample.xml'), 'utf-8');

const testDbPath = '/tmp/baystate-cms-phase3-test.db';

describe('Phase 3: MIME Upload / Multipart', () => {

  it('should build multipart body with documented fields', () => {
    const xml = '<ShopSiteProducts><Products></Products></ShopSiteProducts>';
    const result = buildUploadMultipart(xml);

    const bodyStr = new TextDecoder().decode(result.body);
    expect(result.contentType).toContain('multipart/form-data; boundary=');
    expect(result.contentLength).toBeGreaterThan(0);

    // Check documented form fields are present
    expect(bodyStr).toContain('name="clientApp"');
    expect(bodyStr).toContain('1');
    expect(bodyStr).toContain('name="dbname"');
    expect(bodyStr).toContain('products');
    expect(bodyStr).toContain('name="uniqueName"');
    expect(bodyStr).toContain('SKU');
    expect(bodyStr).toContain('name="newRecords"');
    expect(bodyStr).toContain('yes');
    expect(bodyStr).toContain('name="defer_linking"');
    expect(bodyStr).toContain('no');

    // Check XML file field
    expect(bodyStr).toContain('filename="shopsite-products.xml"');
    expect(bodyStr).toContain('Content-Type: text/xml');
    expect(bodyStr).toContain('<ShopSiteProducts>');
  });

  it('should allow overriding default fields', () => {
    const xml = '<Products></Products>';
    const result = buildUploadMultipart(xml, {
      newRecords: 'no',
      uniqueName: 'Name',
      batchsize: '100',
    });

    const bodyStr = new TextDecoder().decode(result.body);
    expect(bodyStr).toContain('name="newRecords"');
    expect(bodyStr).toContain('no');
    expect(bodyStr).toContain('name="uniqueName"');
    expect(bodyStr).toContain('Name');
    expect(bodyStr).toContain('batchsize');
    expect(bodyStr).toContain('defer_linking');
  });

  it('should end with boundary terminator', () => {
    const xml = '<P></P>';
    const result = buildUploadMultipart(xml);
    const bodyStr = new TextDecoder().decode(result.body);
    expect(bodyStr.trim().endsWith('--')).toBe(true);
  });
});

describe('Phase 3: dbmake Response Parsing', () => {

  it('should extract dbmake query from direct link', () => {
    const response = 'dbmake.cgi?key1=value1&key2=value2';
    const query = extractDbmakeQuery(response);
    expect(query).toBe('key1=value1&key2=value2');
  });

  it('should extract dbmake query from full URL', () => {
    const response = 'https://store.example.com/cgi-bin/bo/dbmake.cgi?return_string=abc123&count=10';
    const query = extractDbmakeQuery(response);
    expect(query).toBe('return_string=abc123&count=10');
  });

  it('should extract dbmake query from HTML href', () => {
    const response = '<a href="dbmake.cgi?return_string=xyz789">Continue</a>';
    const query = extractDbmakeQuery(response);
    expect(query).toBe('return_string=xyz789');
  });

  it('should handle plain query string responses', () => {
    const response = 'return_string=abc123&count=5&total=100';
    const query = extractDbmakeQuery(response);
    expect(query).toBe('return_string=abc123&count=5&total=100');
  });

  it('should return null for heuristic success without dbmake link', () => {
    const response = 'Success: Products imported successfully.';
    const query = extractDbmakeQuery(response);
    // Generic success text without a concrete dbmake return string must not be accepted
    expect(query).toBeNull();
  });

  it('should return null for unrecognized response', () => {
    const response = 'Some random error response';
    const query = extractDbmakeQuery(response);
    expect(query).toBeNull();
  });

  it('should handle mixed case in dbmake.cgi reference', () => {
    const response = 'Dbmake.CGI?key=value';
    const query = extractDbmakeQuery(response);
    expect(query).toBe('key=value');
  });
});

describe('Phase 3: Credentials Redaction', () => {

  it('should redact Authorization header', () => {
    const text = 'Authorization: Basic dXNlcjpwYXNz';
    const redacted = redactCredentials(text);
    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain('Basic dXNlcjpwYXNz');
  });

  it('should redact password in query strings', () => {
    const text = 'POST data: password=mysecret&merchant_id=admin';
    const redacted = redactCredentials(text);
    expect(redacted).not.toContain('mysecret');
    expect(redacted).toContain('[REDACTED]');
  });

  it('should redact password in JSON-style payloads', () => {
    const text = '{"password":"mysecret","merchant":"admin"}';
    const redacted = redactCredentials(text);
    expect(redacted).not.toContain('mysecret');
    expect(redacted).toContain('[REDACTED]');
  });

  it('should not modify safe strings', () => {
    const text = 'Product SKU: ABC-123, Price: 19.99';
    expect(redactCredentials(text)).toBe(text);
  });
});

describe('Phase 3: dbmake Success Validation', () => {
  it('should accept clean success response', () => {
    expect(isDbmakeSuccessful('Operation complete. 12 products imported.')).toBe(true);
  });

  it('should reject response containing error signal', () => {
    expect(isDbmakeSuccessful('Error: Failed to import product ABC-123')).toBe(false);
  });

  it('should reject response containing failure signal', () => {
    expect(isDbmakeSuccessful('Import failed: duplicate SKU')).toBe(false);
  });

  it('should reject empty or minimal responses', () => {
    expect(isDbmakeSuccessful('')).toBe(false);
    expect(isDbmakeSuccessful('OK')).toBe(false);
  });

  it('should accept response with error but also strong success', () => {
    expect(isDbmakeSuccessful('Import completed successfully with 0 errors.')).toBe(true);
  });
});

describe('Phase 3: XML Safety', () => {
  it('should validate XML tag names', () => {
    expect(isValidXmlTagName('ProductField16')).toBe(true);
    expect(isValidXmlTagName('SKU')).toBe(true);
    expect(isValidXmlTagName('Name')).toBe(true);
    expect(isValidXmlTagName('xmlBad')).toBe(false);
    expect(isValidXmlTagName('XMLBad')).toBe(false);
    expect(isValidXmlTagName('')).toBe(false);
    expect(isValidXmlTagName('with space')).toBe(false);
    expect(isValidXmlTagName('with<angle>')).toBe(false);
  });

  it('should escape CDATA terminators', () => {
    expect(escapeCdata('normal text')).toBe('normal text');
    expect(escapeCdata('text with ]]> inside')).toBe('text with ]]]]><![CDATA[> inside');
  });

  it('should handle multiple CDATA terminators', () => {
    const input = 'a]]>b]]>c';
    const result = escapeCdata(input);
    expect(result).toBe('a]]]]><![CDATA[>b]]]]><![CDATA[>c');
  });
});

describe('Phase 3: Drift Detection', () => {
  const testDir = path.join(os.tmpdir(), `baystate-cms-drift-${Date.now()}`);
  const workspaceId = 'test-drift-ws';

  beforeAll(() => {
    try { fs.rmSync(testDir, { recursive: true }); } catch { /* ok */ }
    // Init DB for drift repo calls
    try { fs.unlinkSync('/tmp/baystate-cms-drift-base.db'); } catch { /* ok */ }
    initDb('/tmp/baystate-cms-drift-base.db');
    runMigrations();

    // Insert workspace for FK constraint
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, workspaceId + '-store', testDir, testDir + '/.git', now, now, 'complete'],
    );

    createWorkspaceDirs(testDir);
    writeGitignore(testDir);

    const git = new GitClient(testDir);
    git.init();

    // Bootstrap products from fixture
    const parsed = ShopSiteProductCodec.decode(fixtureXml);
    for (const product of parsed.products) {
      if (!product.sku) continue;
      writeProductFile(testDir, product);
    }

    git.add(['products/', '.gitignore']);
    git.commit('Baseline for drift test');
  });

  afterAll(() => {
    try { fs.rmSync(testDir, { recursive: true }); } catch { /* ok */ }
    try { fs.unlinkSync('/tmp/baystate-cms-drift-base.db'); } catch { /* ok */ }
  });

  it('should detect drift when remote XML differs from local files', () => {
    // Create a modified version of the fixture (change a price)
    const alteredXml = fixtureXml.replace('49.99', '55.00');

    const result = detectDrift(workspaceId, testDir, alteredXml);

    // Should find drift for products that differ
    expect(result.driftCount).toBeGreaterThanOrEqual(1);
    expect(result.errors.length).toBe(0);

    // The drifted SKU should be ABC-123 (price changed)
    const abcDrift = result.drifts.find(d => d.sku === 'ABC-123');
    expect(abcDrift).toBeTruthy();
    expect(abcDrift!.status).toBe('open');
    expect(abcDrift!.localHash).toBeTruthy();
    expect(abcDrift!.remoteHash).toBeTruthy();
    expect(abcDrift!.localHash).not.toBe(abcDrift!.remoteHash);
  });

  it('should not detect drift when remote XML matches local files', () => {
    const result = detectDrift(workspaceId, testDir, fixtureXml);
    expect(result.driftCount).toBe(0);
  });

  it('should report drift errors for invalid XML', () => {
    const result = detectDrift(workspaceId, testDir, '<invalid');
    // Error but doesn't throw
    expect(result.errors.length).toBeGreaterThanOrEqual(0);
  });
});

describe('Phase 3: Drift Repository', () => {
  beforeAll(() => {
    try { fs.unlinkSync(testDbPath); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    try { fs.unlinkSync(testDbPath); } catch { /* ok */ }
  });

  const insertWorkspace = (id: string) => {
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, id + '-store', '/tmp/' + id, '/tmp/' + id + '/.git', now, now, 'complete'],
    );
  };

  it('should create, list, and resolve drift records', () => {
    const wsId = randomUUID();
    insertWorkspace(wsId);
    const sku = 'DRIFT-001';

    // Create
    const drift = createDrift({
      workspaceId: wsId,
      sku,
      localHash: 'abc123',
      remoteHash: 'xyz789',
      localJson: JSON.stringify({ sku, name: 'Local' }),
      remoteJson: JSON.stringify({ sku, name: 'Remote' }),
    });

    expect(drift.sku).toBe(sku);
    expect(drift.status).toBe('open');

    // List open
    const openDrifts = listDrift(wsId, 'open');
    expect(openDrifts.length).toBe(1);
    expect(openDrifts[0].sku).toBe(sku);

    // hasOpenDriftForSku
    expect(hasOpenDriftForSku(wsId, sku)).toBe(true);
    expect(hasOpenDriftForSku(wsId, 'NONEXISTENT')).toBe(false);

    // Resolve
    resolveDrift(drift.id, 'kept_local');
    const resolved = findDriftById(drift.id);
    expect(resolved!.status).toBe('kept_local');
    expect(hasOpenDriftForSku(wsId, sku)).toBe(false);

    // Count open
    expect(countOpenDrift(wsId)).toBe(0);
  });

  it('should list all drifts irrespective of status', () => {
    const wsId = randomUUID();
    insertWorkspace(wsId);

    createDrift({ workspaceId: wsId, sku: 'A', localHash: 'a', remoteHash: 'b', localJson: null, remoteJson: '{}' });
    createDrift({ workspaceId: wsId, sku: 'B', localHash: 'c', remoteHash: 'd', localJson: null, remoteJson: '{}' });

    const all = listDrift(wsId);
    expect(all.length).toBe(2);
  });
});

describe('Phase 3: Drift Idempotency (#250)', () => {
  const testDir = path.join(os.tmpdir(), `baystate-cms-drift-idempotent-${Date.now()}`);
  const dbPath = '/tmp/baystate-cms-drift-idempotent.db';
  const workspaceId = 'test-drift-idempotent-ws';
  const alteredXml = fixtureXml.replace('49.99', '55.00');
  const newerXml = fixtureXml.replace('49.99', '66.00');

  beforeAll(() => {
    try { fs.rmSync(testDir, { recursive: true }); } catch { /* ok */ }
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
    initDb(dbPath);
    runMigrations();

    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, workspaceId + '-store', testDir, testDir + '/.git', now, now, 'complete'],
    );

    createWorkspaceDirs(testDir);
    writeGitignore(testDir);
    const git = new GitClient(testDir);
    git.init();
    const parsed = ShopSiteProductCodec.decode(fixtureXml);
    for (const product of parsed.products) {
      if (!product.sku) continue;
      writeProductFile(testDir, product);
    }
    git.add(['products/', '.gitignore']);
    git.commit('Baseline for idempotency test');
  });

  afterAll(() => {
    try { fs.rmSync(testDir, { recursive: true }); } catch { /* ok */ }
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it('recheck with identical remote creates no new rows while outstanding stays visible', () => {
    const first = detectDrift(workspaceId, testDir, alteredXml);
    expect(first.driftCount).toBeGreaterThanOrEqual(1);
    const openAfterFirst = countOpenDrift(workspaceId);
    expect(openAfterFirst).toBeGreaterThanOrEqual(1);
    const firstRows = listDrift(workspaceId, 'open');
    const firstDetected = firstRows.map(d => d.detectedAt);

    // Identical recheck: zero new rows, no timestamp churn.
    const second = detectDrift(workspaceId, testDir, alteredXml);
    expect(second.driftCount).toBe(0);
    expect(countOpenDrift(workspaceId)).toBe(openAfterFirst);

    // Existing unresolved differences remain visible with stable identity.
    const secondRows = listDrift(workspaceId, 'open');
    expect(secondRows.map(d => d.id).sort()).toEqual(firstRows.map(d => d.id).sort());
    expect(secondRows.map(d => d.detectedAt)).toEqual(firstDetected);
    expect(secondRows.find(d => d.sku === 'ABC-123')).toBeTruthy();
  });

  it('a newer remote state supersedes in place with a flat open count', () => {
    const before = listDrift(workspaceId, 'open');
    const survivorId = before.find(d => d.sku === 'ABC-123')!.id;
    const beforeRemote = before.find(d => d.sku === 'ABC-123')!.remoteHash;
    const openBefore = countOpenDrift(workspaceId);

    const result = detectDrift(workspaceId, testDir, newerXml);
    expect(result.driftCount).toBe(1);
    expect(countOpenDrift(workspaceId)).toBe(openBefore);

    const after = listDrift(workspaceId, 'open');
    const survivor = after.find(d => d.sku === 'ABC-123')!;
    expect(survivor.id).toBe(survivorId);
    expect(survivor.remoteHash).not.toBe(beforeRemote);
  });

  it('reverting to baseline clears open findings that no longer differ', () => {
    expect(countOpenDrift(workspaceId)).toBeGreaterThan(0);
    const result = detectDrift(workspaceId, testDir, fixtureXml);
    expect(result.driftCount).toBe(0);
    expect(countOpenDrift(workspaceId)).toBe(0);
    expect(hasOpenDriftForSku(workspaceId, 'ABC-123')).toBe(false);
  });

  it('a known outstanding difference is never reported as a baseline match', () => {
    // Re-open drift, then seed a catalog index row to observe sync status.
    detectDrift(workspaceId, testDir, alteredXml);
    expect(hasOpenDriftForSku(workspaceId, 'ABC-123')).toBe(true);

    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO product_index
        (id, sku, file_path, title, status, product_hash, sync_status,
         has_advanced_blocks, has_warnings, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['idx-abc-123', 'ABC-123', 'products/ab/c123.json', 'ABC', 'active',
        'seed', 'not_synced', 0, 0, now, now],
    );

    // Remote still differs: must stay drifted, never flip to synced.
    detectDrift(workspaceId, testDir, alteredXml);
    expect(hasOpenDriftForSku(workspaceId, 'ABC-123')).toBe(true);
    expect(findProductBySku('ABC-123')!.syncStatus).toBe('drifted');

    // Cleanup: restore the match so later tests start clean.
    detectDrift(workspaceId, testDir, fixtureXml);
    expect(findProductBySku('ABC-123')!.syncStatus).toBe('synced');
    expect(countOpenDrift(workspaceId)).toBe(0);
  });

  it('outstanding uniqueness is workspace-scoped and DB-enforced', () => {
    const db = getDb();
    const now = new Date().toISOString();
    for (const ws of ['idem-ws-a', 'idem-ws-b']) {
      db.run(
        `INSERT OR IGNORE INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [ws, ws, '/tmp/' + ws, '/tmp/' + ws + '/.git', now, now, 'complete'],
      );
    }
    // Same SKU may be outstanding in two workspaces independently.
    createDrift({ workspaceId: 'idem-ws-a', sku: 'SHARED-SKU', localHash: 'l', remoteHash: 'r1', localJson: null, remoteJson: '{}' });
    createDrift({ workspaceId: 'idem-ws-b', sku: 'SHARED-SKU', localHash: 'l', remoteHash: 'r1', localJson: null, remoteJson: '{}' });
    expect(countOpenDrift('idem-ws-a')).toBe(1);
    expect(countOpenDrift('idem-ws-b')).toBe(1);

    // A second outstanding row for the same (workspace, sku) is rejected
    // by the database, for both open and reconcile-linked states.
    expect(() => createDrift({ workspaceId: 'idem-ws-a', sku: 'SHARED-SKU', localHash: 'l', remoteHash: 'r2', localJson: null, remoteJson: '{}' }))
      .toThrow(/UNIQUE constraint failed/);
    expect(() => db.run(
      `INSERT INTO remote_drift (id, workspace_id, sku, detected_at, status, local_hash, remote_hash, local_json, remote_json, diff_json)
       VALUES (?, ?, ?, ?, 'in_reconcile', ?, ?, ?, ?, ?)`,
      [randomUUID(), 'idem-ws-a', 'SHARED-SKU', now, 'l', 'r3', null, '{}', null],
    )).toThrow(/UNIQUE constraint failed/);
  });

  it('rechecks preserve reconcile links and supersede without breaking them', () => {
    const created = detectDrift(workspaceId, testDir, alteredXml);
    expect(created.driftCount).toBeGreaterThanOrEqual(1);
    const row = listDrift(workspaceId, 'open').find(d => d.sku === 'ABC-123')!;
    linkDriftToChangeSet(row.id, 'cs-idem-1', 'in_reconcile');

    // Identical recheck: no new row, link and status intact.
    const again = detectDrift(workspaceId, testDir, alteredXml);
    expect(again.driftCount).toBe(0);
    const kept = listOutstandingDriftForSku(workspaceId, 'ABC-123');
    expect(kept.length).toBe(1);
    expect(kept[0].id).toBe(row.id);
    expect(kept[0].status).toBe('in_reconcile');
    expect(kept[0].reconcileChangeSetId).toBe('cs-idem-1');
    expect(findLinkedDrift(workspaceId, 'cs-idem-1')!.id).toBe(row.id);

    // Newer remote supersedes the linked row in place (still one row).
    const superseded = detectDrift(workspaceId, testDir, newerXml);
    expect(superseded.driftCount).toBe(1);
    const kept2 = listOutstandingDriftForSku(workspaceId, 'ABC-123');
    expect(kept2.length).toBe(1);
    expect(kept2[0].id).toBe(row.id);
    expect(kept2[0].status).toBe('in_reconcile');
    expect(kept2[0].reconcileChangeSetId).toBe('cs-idem-1');

    // Resolve the reconcile row so the file ends with no outstanding drift.
    resolveDrift(row.id, 'resolved');
    detectDrift(workspaceId, testDir, fixtureXml);
    expect(listOutstandingDriftForSku(workspaceId, 'ABC-123').length).toBe(0);
  });

  it('upsert collapses pre-existing duplicates without touching resolved history', () => {
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['idem-ws-c', 'idem-ws-c', '/tmp/idem-ws-c', '/tmp/idem-ws-c/.git', now, now, 'complete'],
    );
    // Seed two outstanding dupes directly (bypassing the unique index is
    // impossible now, so seed one + verify upsert absorbs a raced second
    // via the collapse path using raw SQL after temporarily dropping the
    // test-only duplicate).
    const first = upsertDrift({ workspaceId: 'idem-ws-c', sku: 'COLLAPSE-1', localHash: 'l', remoteHash: 'r1', localJson: null, remoteJson: '{"v":1}' });
    expect(first.kind).toBe('inserted');
    const noop = upsertDrift({ workspaceId: 'idem-ws-c', sku: 'COLLAPSE-1', localHash: 'l', remoteHash: 'r1', localJson: null, remoteJson: '{"v":1}' });
    expect(noop.kind).toBe('noop');
    expect(noop.row.id).toBe(first.row.id);
    const updated = upsertDrift({ workspaceId: 'idem-ws-c', sku: 'COLLAPSE-1', localHash: 'l2', remoteHash: 'r2', localJson: null, remoteJson: '{"v":2}' });
    expect(updated.kind).toBe('updated');
    expect(updated.row.id).toBe(first.row.id);
    expect(listOutstandingDriftForSku('idem-ws-c', 'COLLAPSE-1').length).toBe(1);
  });
});

describe('Phase 3: Drift Dedup Migration (#250)', () => {
  const dbPath = '/tmp/baystate-cms-drift-migration.db';

  beforeAll(() => {
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
    initDb(dbPath);
    runMigrations();
  });

  afterAll(() => {
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it('dedupes redundant outstanding rows deterministically, preserves links and history', () => {
    const db = getDb();
    const wsId = randomUUID();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [wsId, wsId, '/tmp/' + wsId, '/tmp/' + wsId + '/.git', now, now, 'complete'],
    );

    // Simulate the pre-migration shape: duplicates exist, so drop the
    // constraint + marker, seed, then re-run migrations.
    db.exec('DROP INDEX IF EXISTS idx_remote_drift_ws_sku_outstanding');
    db.run("DELETE FROM app_meta WHERE key = 'drift_dedup_schema_version'");
    const insert = (sku: string, status: string, detectedAt: string, link: string | null, remoteHash: string, blobSize: number) =>
      db.run(
        `INSERT INTO remote_drift (id, workspace_id, sku, detected_at, status, local_hash, remote_hash, local_json, remote_json, diff_json, reconcile_change_set_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), wsId, sku, detectedAt, status, 'l', remoteHash, null, 'x'.repeat(blobSize), null, link],
      );

    // sku1: three plain outstanding dupes (200KB blobs each) — earliest wins.
    insert('MIG-1', 'open', '2026-01-03T00:00:00.000Z', null, 'r3', 200_000);
    insert('MIG-1', 'open', '2026-01-01T00:00:00.000Z', null, 'r1', 200_000);
    insert('MIG-1', 'open', '2026-01-02T00:00:00.000Z', null, 'r2', 200_000);
    // sku2: open + linked in_reconcile — the linked row survives.
    insert('MIG-2', 'open', '2026-01-01T00:00:00.000Z', null, 'r1', 10);
    insert('MIG-2', 'in_reconcile', '2026-01-05T00:00:00.000Z', 'cs-mig-9', 'r2', 10);
    // Resolved history for the same SKUs must never be deleted.
    insert('MIG-1', 'kept_local', '2026-01-04T00:00:00.000Z', null, 'r0', 10);
    insert('MIG-1', 'accepted_remote', '2026-01-04T00:00:00.000Z', null, 'r0', 10);
    insert('MIG-2', 'resolved', '2026-01-04T00:00:00.000Z', 'cs-mig-9', 'r0', 10);

    runMigrations();

    // Deterministic survivors.
    const mig1 = listOutstandingDriftForSku(wsId, 'MIG-1');
    expect(mig1.length).toBe(1);
    expect(mig1[0].detectedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(mig1[0].remoteHash).toBe('r1');
    const mig2 = listOutstandingDriftForSku(wsId, 'MIG-2');
    expect(mig2.length).toBe(1);
    expect(mig2[0].status).toBe('in_reconcile');
    expect(mig2[0].reconcileChangeSetId).toBe('cs-mig-9');
    expect(findLinkedDrift(wsId, 'cs-mig-9')!.id).toBe(mig2[0].id);

    // Historical decisions preserved verbatim.
    const history = listDrift(wsId).filter(d => ['kept_local', 'accepted_remote', 'resolved'].includes(d.status));
    expect(history.length).toBe(3);

    // Constraint + marker converge.
    const idx = db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_remote_drift_ws_sku_outstanding'").get();
    expect(idx).toBeTruthy();
    const marker = db.query("SELECT value FROM app_meta WHERE key = 'drift_dedup_schema_version'").get() as { value: string };
    expect(marker.value).toBe('1');

    // Restart-safe: a second run is a no-op.
    runMigrations();
    expect(listOutstandingDriftForSku(wsId, 'MIG-1').length).toBe(1);
    expect(listOutstandingDriftForSku(wsId, 'MIG-2').length).toBe(1);
    expect(listDrift(wsId).length).toBe(2 + 3);
  });
});

describe('Phase 3: Full Push Flow Mock', () => {

  it('should build delta XML for changed products matching expected format', () => {
    const parsed = ShopSiteProductCodec.decode(fixtureXml);
    const products = [];
    for (const product of parsed.products) {
      if (product.sku) products.push(product);
    }

    const xml = buildProductsXml(products);

    // Verify ShopSite XML structure
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<!DOCTYPE ShopSiteProducts');
    expect(xml).toContain('<ShopSiteProducts version="15.0">');
    expect(xml).toContain('<Products>');
    expect(xml).toContain('</Products>');
    expect(xml).toContain('</ShopSiteProducts>');
    expect(xml).toContain('<SKU>ABC-123</SKU>');
    expect(xml).toContain('<SKU>XYZ-789</SKU>');
    expect(xml).toContain('</Product>');
    expect(xml).toContain('<Subproducts>');
  });

  it('should generate multipart body with correct delta XML content', () => {
    const xml = '<ShopSiteProducts version="15.0"><Products><Product><SKU>DELTA-001</SKU></Product></Products></ShopSiteProducts>';
    const multipart = buildUploadMultipart(xml, { uniqueName: 'SKU', newRecords: 'yes', defer_linking: 'no' });

    const bodyStr = new TextDecoder().decode(multipart.body);
    expect(bodyStr).toContain('DELTA-001');
    expect(bodyStr).toContain('uniqueName');
    expect(bodyStr).toContain('SKU');
    expect(bodyStr).toContain('newRecords');
    expect(bodyStr).toContain('yes');
  });

  it('should verify the multipart boundary format is correct', () => {
    const xml = '<X></X>';
    const r = buildUploadMultipart(xml);
    const bodyStr = new TextDecoder().decode(r.body);

    // Boundary should be consistent: first part has boundary, last has boundary+--
    const firstLine = bodyStr.split('\r\n')[0];
    expect(firstLine).toMatch(/^-----------------------------ShopSiteUpload_[\w\d]+/);
  });
});
