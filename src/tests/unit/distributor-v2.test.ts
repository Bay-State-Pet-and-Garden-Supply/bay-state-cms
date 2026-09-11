import { describe, test, expect, beforeEach } from 'bun:test';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import {
  createDistributor,
  getDistributorById,
  listDistributors,
  createConnection,
  getConnectionById,
  listConnectionsByWorkspace,
  updateConnection,
  updateConnectionPolicy,
  createCatalogSnapshot,
  getLatestSnapshotForConnection,
} from '../../db/repositories/distributor-repo';
import { DistributorConnectionSchema, InsertDistributorConnectionSchema, DistributorConnectorTypeEnum } from '../../shared/schemas/distributor';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import {
  insertEvidenceAttempt,
  startSourcingGeneration,
} from '../../db/repositories/onboarding-evidence-repo';
import {
  insertExtraction,
  getLatestExtractionBindingsByItemIds,
} from '../../db/repositories/onboarding-extraction-repo';

describe('Multi-Distributor V2 Entity & Repository Tests', () => {
  beforeEach(() => {
    initDb(':memory:');
    runMigrations();
    insertWorkspace({
      id: 'w1',
      name: 'Test Workspace 1',
      workspacePath: '/tmp/test-ws1',
      gitPath: '/tmp/test-ws1/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    insertWorkspace({
      id: 'w2',
      name: 'Test Workspace 2',
      workspacePath: '/tmp/test-ws2',
      gitPath: '/tmp/test-ws2/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
  });

  test('creates and retrieves distributors', () => {
    const dist = createDistributor({ id: 'phillips', name: 'Phillips Pet Food & Supplies', status: 'active' });
    expect(dist.id).toBe('phillips');
    expect(dist.name).toBe('Phillips Pet Food & Supplies');

    const found = getDistributorById('phillips');
    expect(found).not.toBeNull();
    expect(found?.name).toBe('Phillips Pet Food & Supplies');

    const all = listDistributors();
    expect(all.some((d) => d.id === 'phillips')).toBe(true);
  });

  test('creates workspace connection with secret_ref and validates security bounds', () => {
    const dist = createDistributor({ id: 'animal_supply', name: 'Animal Supply Co', status: 'active' });
    const conn = createConnection({
      workspaceId: 'w1',
      distributorId: dist.id,
      connectorType: 'ftp_catalog',
      secretRef: 'ANIMAL_SUPPLY_FTP_KEY',
      configuration: { host: 'ftp.animalsupply.com', port: 21 },
      authorityPolicy: {
        skuAuthority: true,
        identityFieldOverrides: [],
      },
    });

    expect(conn.workspaceId).toBe('w1');
    expect(conn.secretRef).toBe('ANIMAL_SUPPLY_FTP_KEY');
    expect(conn.authorityPolicy.skuAuthority).toBe(true);
    // Amendment A: creation is always disabled (enable via separate update).
    expect(conn.enabled).toBe(false);
    // Narrowed authority policy (ADR 0014): commerce fields do not exist.
    expect('pricingAuthority' in conn.authorityPolicy).toBe(false);

    // Schema-level guardrail: create-as-enabled is rejected; literal false
    // and omitted both parse and persist disabled (Amendment A).
    const createBase = {
      workspaceId: 'w1',
      distributorId: dist.id,
      connectorType: 'api',
    };
    expect(InsertDistributorConnectionSchema.safeParse({ ...createBase, enabled: true }).success).toBe(false);
    expect(InsertDistributorConnectionSchema.safeParse({ ...createBase, enabled: false }).success).toBe(true);
    expect(InsertDistributorConnectionSchema.safeParse(createBase).success).toBe(true);

    // Verify secret_ref guardrail blocks raw password in configuration
    // (recursive rejection + closed connectorType enum both fail).
    const invalidConfig = DistributorConnectionSchema.safeParse({
      id: 'c1',
      workspaceId: 'w1',
      distributorId: 'dist1',
      connectorType: 'ftp',
      configuration: { password: 'raw-secret-password-123' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(invalidConfig.success).toBe(false);
  });

  test('html_scraper connections create disabled with empty fixed-code configuration; raw credentials still rejected', () => {
    const dist = createDistributor({ id: 'bradley', name: 'Bradley Caldwell', status: 'active' });
    const conn = createConnection({
      workspaceId: 'w1',
      distributorId: dist.id,
      connectorType: 'html_scraper',
      secretRef: null, // public storefront: no secret required (M2 resolves this)
      configuration: {},
    });

    expect(conn.connectorType).toBe('html_scraper');
    expect(conn.enabled).toBe(false); // Amendment A: create is always disabled
    expect(conn.secretRef).toBeNull();

    // Amendment B: the closed schema accepts html_scraper but never
    // selectors/login URLs/origins/credentials in configuration.
    expect(DistributorConnectorTypeEnum.safeParse('html_scraper').success).toBe(true);
    expect(() =>
      createConnection({
        workspaceId: 'w1',
        distributorId: dist.id,
        connectorType: 'html_scraper',
        configuration: { password: 'raw-secret-password-123' },
      }),
    ).toThrow(/credential|forbidden/i);
    expect(() =>
      createConnection({
        workspaceId: 'w1',
        distributorId: dist.id,
        connectorType: 'html_scraper',
        configuration: { authorization: 'Bearer raw-token-abc' },
      }),
    ).toThrow(/credential|forbidden/i);
  });

  test('createConnection rejects credential-bearing values and unknown connector types', () => {
    const dist = createDistributor({ id: 'd1', name: 'D1' });
    expect(() =>
      createConnection({
        workspaceId: 'w1',
        distributorId: dist.id,
        connectorType: 'api',
        configuration: { baseUrl: 'https://token@api.example.com' },
      }),
    ).toThrow(/credential|forbidden/i);
    expect(() =>
      createConnection({
        workspaceId: 'w1',
        distributorId: dist.id,
        connectorType: 'edi_832' as never,
      }),
    ).toThrow(/Invalid distributor connection/);
  });

  test('enforces workspace boundaries for distributor connections', () => {
    const dist = createDistributor({ id: 'unfi', name: 'UNFI Retail', status: 'active' });
    createConnection({ workspaceId: 'w1', distributorId: dist.id, connectorType: 'api' });

    const w1Conns = listConnectionsByWorkspace('w1');
    const w2Conns = listConnectionsByWorkspace('w2');

    expect(w1Conns.length).toBe(1);
    expect(w2Conns.length).toBe(0);
  });

  test('updateConnection is workspace-scoped and supports enabled/config/policy/secretRef', () => {
    const dist = createDistributor({ id: 'unfi', name: 'UNFI Retail', status: 'active' });
    const conn = createConnection({
      workspaceId: 'w1',
      distributorId: dist.id,
      connectorType: 'api',
      secretRef: 'UNFI_KEY',
      configuration: { baseUrl: 'https://api.unfi.com' },
    });
    // Amendment A: created disabled; enablement is a separate update.
    expect(conn.enabled).toBe(false);
    updateConnection(conn.id, 'w1', { enabled: true });

    // Cross-workspace update must not mutate (returns null).
    const crossWorkspace = updateConnection(conn.id, 'w2', { enabled: false });
    expect(crossWorkspace).toBeNull();
    expect(getConnectionById(conn.id)?.enabled).toBe(true);

    const updated = updateConnection(conn.id, 'w1', {
      enabled: false,
      secretRef: 'UNFI_KEY_V2',
      configuration: { baseUrl: 'https://api.unfi.com/v2' },
    });
    expect(updated?.enabled).toBe(false);
    expect(updated?.secretRef).toBe('UNFI_KEY_V2');
    expect(updated?.configuration).toEqual({ baseUrl: 'https://api.unfi.com/v2' });

    // Credential-shaped updates are rejected before SQL.
    expect(() => updateConnection(conn.id, 'w1', { configuration: { password: 'x' } })).toThrow(/forbidden/i);
  });

  test('updateConnectionPolicy updates the narrowed authority policy', () => {
    const dist = createDistributor({ id: 'phillips', name: 'Phillips', status: 'active' });
    const conn = createConnection({ workspaceId: 'w1', distributorId: dist.id, connectorType: 'api' });
    const updated = updateConnectionPolicy(conn.id, 'w1', {
      skuAuthority: false,
      identityFieldOverrides: ['brand'],
    });
    expect(updated?.authorityPolicy.skuAuthority).toBe(false);
    expect(updated?.authorityPolicy.identityFieldOverrides).toEqual(['brand']);

    // Workspace-scoped: cross-workspace policy updates are no-ops.
    expect(updateConnectionPolicy(conn.id, 'w2', { skuAuthority: true, identityFieldOverrides: [] })).toBeNull();
    expect(getConnectionById(conn.id)?.authorityPolicy.skuAuthority).toBe(false);

    // Malformed policies are rejected before SQL.
    expect(() => updateConnectionPolicy(conn.id, 'w1', { skuAuthority: 'yes' } as never)).toThrow(/Invalid distributor authority policy/);
  });

  test('manages versioned catalog snapshots', () => {
    const dist = createDistributor({ id: 'bradley', name: 'Bradley Caldwell', status: 'active' });
    const conn = createConnection({ workspaceId: 'w1', distributorId: dist.id, connectorType: 'csv' });

    const snap1 = createCatalogSnapshot({
      distributorConnectionId: conn.id,
      externalVersion: '2026-08-01',
      contentHash: 'hash123',
    });

    expect(snap1.externalVersion).toBe('2026-08-01');

    const latest = getLatestSnapshotForConnection(conn.id);
    expect(latest?.id).toBe(snap1.id);
  });

  test('final schema has no advisory table; distributor/connection/evidence APIs intact (issue #150)', () => {
    // The advisory profile table is retired: no table, no advisory row
    // helpers on the repository, and unrelated distributor/connection
    // storage keeps working.
    const tables = (getDb().query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toContain('distributors');
    expect(tables).toContain('distributor_connections');
    expect(tables).not.toContain('brand_advisory_profiles');
    const repo = require('../../db/repositories/distributor-repo') as Record<string, unknown>;
    for (const retired of [
      'upsertBrandAdvisoryProfile',
      'listBrandAdvisoryProfiles',
      'deleteBrandAdvisoryProfile',
      'listBrandAdvisoryProfilesByNormalized',
      'getPreferredDistributorOrder',
      'getBrandSourcingConfig',
    ]) {
      expect(retired in repo).toBe(false);
    }
    // Connections remain workspace-scoped and creatable.
    const dist = createDistributor({ id: 'nutro-dist', name: 'Nutro Dist' });
    expect(dist.id).toBe('nutro-dist');
    expect(listDistributors().map((x) => x.id)).toContain('nutro-dist');
  });

  test('distributor_connections storage default is disabled; raw inserts omitting enabled stay disabled (Amendment A)', () => {
    const db = getDb();
    const enabledCol = (db.query('PRAGMA table_info(distributor_connections)').all() as Array<{ name: string; dflt_value: string | null }>)
      .find((c) => c.name === 'enabled');
    expect(enabledCol?.dflt_value).toBe('0');

    // A raw SQL insert that OMITS `enabled` must produce a DISABLED row — the
    // storage default is the fail-closed backstop independent of the repo.
    const dist = createDistributor({ id: 'phillips', name: 'Phillips', status: 'active' });
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO distributor_connections (id, workspace_id, distributor_id, connector_type, secret_ref, configuration_json, authority_policy_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, '{}', '{}', ?, ?)`,
      ['conn-raw-default', 'w1', dist.id, 'api', now, now],
    );
    const row = db.query('SELECT enabled FROM distributor_connections WHERE id = ?').get('conn-raw-default') as { enabled: number };
    expect(row.enabled).toBe(0);
  });

  test('evidence attempts round-trip duration_ms and extraction provenance columns', () => {
    const batch = createBatch({ workspaceId: 'w1', name: 'B-DUR', fileName: 'bdur.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678960', name: 'Duration', rowNumber: 1 }]);

    // duration_ms round-trips through the evidence writer (Amendment A
    // measured p95 / source-error gates).
    const generation = startSourcingGeneration(item.id);
    const attempt = insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'phillips',
      lookupUpc: item.upc,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: JSON.stringify({ name: 'Duration' }),
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      sourcingGenerationId: generation.id,
      durationMs: 1234,
    });
    expect(attempt.durationMs).toBe(1234);

    // Distributor-record extraction provenance (null URL, generation,
    // canonical sorted accepted ids, hash) round-trips via the bindings helper.
    const hash = 'b'.repeat(64);
    insertExtraction({
      itemId: item.id,
      sourceType: 'distributor_record',
      sourceUrl: null,
      extractionDataJson: JSON.stringify({ name: 'Duration' }),
      extractionMethod: 'distributor_record_v1',
      confidence: 0.9,
      sourcingGenerationId: generation.id,
      acceptedEvidenceAttemptIds: [attempt.id],
      evidenceHash: hash,
    });

    const binding = getLatestExtractionBindingsByItemIds([item.id]).get(item.id);
    expect(binding).toBeDefined();
    expect(binding?.sourceType).toBe('distributor_record');
    expect(binding?.sourceUrl).toBeNull();
    expect(binding?.extractionMethod).toBe('distributor_record_v1');
    expect(binding?.sourcingGenerationId).toBe(generation.id);
    expect(binding?.acceptedEvidenceAttemptIds).toEqual([attempt.id]);
    expect(binding?.evidenceHash).toBe(hash);
  });
});
