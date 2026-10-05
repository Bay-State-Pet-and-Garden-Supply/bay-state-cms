import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { sha256Hex } from '../../shared/stable-id';
import { getDatasetMetadataOnly } from '../../db/repositories/benchmark-repo';
import { findWorkspaceIdReadonly } from '../../db/repositories/workspace-repo';
import { captureVerifiedPageSnapshot } from '../../classification/page-snapshot';
import { loadRuntimeConfigAuthority } from '../../classification/config-loader';
import { readWorkspaceState } from '../../classification/workspace-state';
import {
  assignFamilyManifest,
  buildDryRunSummary,
  capturePreparationAuthority,
  revalidatePreparationAuthority,
  validateSourceCandidates,
} from '../../classification/jev-benchmark-preparation';
import { splitForFamily } from '../../classification/benchmark-exporter';
import { isDbInitialized } from '../../db/connection';

const SOURCE_HASH = 'c'.repeat(64);
const IMPORT_HASH = 'b'.repeat(64);
const WS_ID = '5d0e7adf-9e7f-4e23-a59e-267cfd775d0b';
const DATASET_ID = '6b4248f4-23fd-4920-a798-e47f2e3b60d4';
const FOREIGN_WS = '00000000-0000-4000-8000-000000000001';

function candidate(sku: string, familyId: string, extra: Record<string, unknown> = {}) {
  return {
    sku,
    title: `Title ${sku}`,
    brand: 'Brand',
    canonicalUrl: `https://manufacturer.example/products/${sku.toLowerCase()}`,
    productIdentity: `identity-${sku}`,
    sourceLocator: `locator-${sku}`,
    sourceHash: SOURCE_HASH,
    retrievedAt: '2026-10-04T00:00:00.000Z',
    familyId,
    excerpts: [{ text: 'supports use', locator: 'page 1' }],
    ...extra,
  };
}

// ─── Fixture: temp workspace + temp SQLite db ────────────────────────────────

let tmpRoot = '';
let workspacePath = '';
let dbPath = '';
let dbBytesBefore = '';

function pageRecords() {
  return [
    { identity: { kind: 'exported_guid', key: 'p1', status: 'verified' }, name: 'Dogs', parentRef: null, availability: 'available' },
    { identity: { kind: 'exported_guid', key: 'p2', status: 'verified' }, name: 'Cats', parentRef: null, availability: 'available' },
  ];
}

function buildFixtureDb(file: string): void {
  const db = new Database(file);
  db.exec(`CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE benchmark_datasets (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
      holdout_strategy TEXT NOT NULL, split_seed INTEGER NOT NULL, total_examples INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft', family_review_complete INTEGER NOT NULL DEFAULT 0,
      family_reviewed_by TEXT, family_reviewed_at TEXT, dataset_hash TEXT, frozen_at TEXT,
      frozen_by TEXT, retired_at TEXT, source_config_hash TEXT, created_at TEXT NOT NULL);
    CREATE TABLE benchmark_examples (id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, product_sku TEXT NOT NULL,
      product_family_id TEXT, split_group TEXT NOT NULL, input_snapshot_json TEXT NOT NULL,
      gold_labels_json TEXT NOT NULL, example_hash TEXT, reviewer_id TEXT, adjudicated_by TEXT,
      source_run_id TEXT, source_config_hash TEXT, source_product_hash TEXT, created_at TEXT NOT NULL);
    CREATE TABLE page_imports (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, source_hash TEXT NOT NULL,
      parser_format_version TEXT NOT NULL, status TEXT NOT NULL, counts_json TEXT NOT NULL,
      records_json TEXT NOT NULL, created_at TEXT NOT NULL, activated_at TEXT,
      superseded_at TEXT, activated_by TEXT);
    CREATE TABLE page_index (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT,
      source_hash TEXT, identity_kind TEXT NOT NULL, identity_key TEXT NOT NULL,
      identity_status TEXT NOT NULL, availability TEXT NOT NULL, workspace_id TEXT NOT NULL, import_id TEXT NOT NULL);`);
  const now = '2026-10-04T00:00:00.000Z';
  db.exec(`INSERT INTO workspace (id, name) VALUES ('${WS_ID}', 'Bay State')`);
  db.exec(`INSERT INTO benchmark_datasets (id, workspace_id, name, holdout_strategy, split_seed, total_examples, status, dataset_hash, frozen_at, source_config_hash, created_at)
    VALUES ('${DATASET_ID}', '${WS_ID}', 'fixture', 'product_family', 42, 2, 'frozen', 'hash1', '${now}', '${SOURCE_HASH}', '${now}')`);
  // Gold + input-snapshot payloads exist in the table — the metadata path must never surface them.
  db.exec(`INSERT INTO benchmark_examples (id, dataset_id, product_sku, product_family_id, split_group, input_snapshot_json, gold_labels_json, example_hash, reviewer_id, adjudicated_by, created_at) VALUES
    ('ex-1', '${DATASET_ID}', 'SECRET-SKU-1', 'fam-a', 'train', '{"secret":"input-payload-1"}', '{"productType":"secret-gold-1"}', 'h1', 'r1', 'a1', '${now}'),
    ('ex-2', '${DATASET_ID}', 'SECRET-SKU-2', 'fam-b', 'holdout', '{"secret":"input-payload-2"}', '{"productType":"secret-gold-2"}', 'h2', NULL, 'a2', '${now}')`);
  db.exec(`INSERT INTO page_imports (id, workspace_id, source_hash, parser_format_version, status, counts_json, records_json, created_at, activated_at)
    VALUES ('import-1', '${WS_ID}', '${IMPORT_HASH}', 'v1', 'active', '{"total":2,"verified":2,"nameOnly":0,"withParent":0}', '${JSON.stringify(pageRecords()).replace(/'/g, "''")}', '${now}', '${now}')`);
  db.exec(`INSERT INTO page_index (id, name, parent_id, source_hash, identity_kind, identity_key, identity_status, availability, workspace_id, import_id) VALUES
    ('page-1', 'Dogs', NULL, '${IMPORT_HASH}', 'exported_guid', 'p1', 'verified', 'available', '${WS_ID}', 'import-1'),
    ('page-2', 'Cats', NULL, '${IMPORT_HASH}', 'exported_guid', 'p2', 'verified', 'available', '${WS_ID}', 'import-1')`);
  db.close();
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-prep-'));
  workspacePath = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, 'store', 'classification', 'state.json'),
    JSON.stringify({ activeTaxonomyRevision: 'bay-state-v5', updatedAt: '2026-10-04T00:00:00.000Z' }),
  );
  dbPath = path.join(tmpRoot, 'app.db');
  buildFixtureDb(dbPath);
  dbBytesBefore = sha256Hex(fs.readFileSync(dbPath));
  // Fixture workspace is a real git repo so catalog-commit derivation runs for real.
  execFileSync('git', ['init', '-q'], { cwd: workspacePath });
  execFileSync('git', ['add', '.'], { cwd: workspacePath });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture'], { cwd: workspacePath });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function openTrackedReadonly() {
  const executedSql: string[] = [];
  const db = new Database(dbPath, { readonly: true });
  db.exec('PRAGMA query_only = ON;');
  const tracked = {
    query: (sql: string) => {
      executedSql.push(sql);
      return db.query(sql);
    },
    transaction: <T>(fn: () => T): (() => T) => db.transaction(fn) as () => T,
    close: () => db.close(),
  };
  return { tracked, executedSql };
}

const FORBIDDEN_SQL = /input_snapshot_json|gold_labels_json|example_hash|product_sku|predictions_json|metrics_json|model_config_json|api_key|credential|password|reviewed_fact|classification_proposal_decision|classification_run|llm_task|model_call/i;
const WRITE_SQL = /\b(insert|update|delete|alter|create|drop|migrat|vacuum)\b/i;

describe('jev benchmark preparation: readonly integration', () => {
  it('reads metadata + pages over readonly driver; payloads never surface; DB bytes unchanged; globals untouched', () => {
    const { tracked, executedSql } = openTrackedReadonly();
    try {
      expect(findWorkspaceIdReadonly(tracked)).toBe(WS_ID);
      const meta = getDatasetMetadataOnly(tracked, DATASET_ID, WS_ID);
      expect(meta?.status).toBe('frozen');
      expect(meta?.total_examples).toBe(2);
      expect(meta?.splitCounts).toEqual({ train: 1, holdout: 1 });
      expect(meta?.attribution).toEqual({ reviewed: 1, adjudicated: 2, total: 2 });
      expect(JSON.stringify(meta)).not.toMatch(/SECRET-SKU|secret-gold|secret-input/);

      const snap = captureVerifiedPageSnapshot(WS_ID, tracked);
      expect(snap.pageImportId).toBe('import-1');
      expect(snap.verifiedPageIds).toHaveLength(2);

      for (const sql of executedSql) {
        expect(sql).not.toMatch(FORBIDDEN_SQL);
        expect(sql).not.toMatch(WRITE_SQL);
      }
      // Readonly writes fail closed at the driver boundary.
      expect(() => tracked.query('INSERT INTO workspace (id) VALUES (?)').run('x')).toThrow();
    } finally {
      tracked.close();
    }
    expect(sha256Hex(fs.readFileSync(dbPath))).toBe(dbBytesBefore);
    expect(isDbInitialized()).toBe(false);
  });

  it('workspace-scopes dataset lookup: foreign workspace reads null', () => {
    const { tracked } = openTrackedReadonly();
    try {
      expect(getDatasetMetadataOnly(tracked, DATASET_ID, FOREIGN_WS)).toBeNull();
      expect(getDatasetMetadataOnly(tracked, DATASET_ID, '')).toBeNull();
    } finally {
      tracked.close();
    }
    expect(sha256Hex(fs.readFileSync(dbPath))).toBe(dbBytesBefore);
  });

  it('captures + revalidates real authority shape (nested profiles/aliases/invariants intact)', () => {
    const { tracked } = openTrackedReadonly();
    try {
      const deps = {
        workspaceId: WS_ID,
        loadAuthority: () => loadRuntimeConfigAuthority(workspacePath),
        capturePages: (id: string) => captureVerifiedPageSnapshot(id, tracked),
        readReleasePin: () => readWorkspaceState(workspacePath)?.activeTaxonomyRevision ?? null,
        readCatalogCommit: () => '9cf6cf5d2551c4d93311a32c45d471877b85a9f1',
      };
      const view = capturePreparationAuthority(deps);
      expect(view.binding.release).toBe('bay-state-v5');
      expect(view.counts.pages).toBe(2);
      expect(view.authorityHash).toMatch(/^[0-9a-f]{64}$/);
      // Full validated snapshot payload survives (usable later), not counts.
      const bundle = view.payload.bundle as Record<string, unknown>;
      expect(Array.isArray(bundle.productTypes)).toBe(true);
      expect((bundle.productTypes as unknown[]).length).toBeGreaterThan(0);
      expect(Array.isArray(bundle.attributeProfiles)).toBe(true);
      const profiles = bundle.attributeProfiles as Array<{ attributes: Array<{ applicabilityConditions: unknown[]; cardinality: string }> }>;
      expect(profiles.length).toBeGreaterThan(0);
      expect(profiles[0].attributes[0].applicabilityConditions).toBeDefined();
      expect(profiles[0].attributes[0].cardinality).toBeDefined();
      expect(bundle.modelPolicy).toBeDefined();
      expect(bundle.dataSharing).toBeDefined();
      expect(() => revalidatePreparationAuthority(view, deps)).not.toThrow();
      // Drift fails closed.
      const drifted = { ...view, authorityHash: '0'.repeat(64) };
      expect(() => revalidatePreparationAuthority(drifted, deps)).toThrow(/authority_hash_drift/);
    } finally {
      tracked.close();
    }
  });

  it('fails closed without release pin or verified catalog', () => {
    const { tracked } = openTrackedReadonly();
    try {
      const base = {
        workspaceId: WS_ID,
        loadAuthority: () => loadRuntimeConfigAuthority(workspacePath),
        capturePages: (id: string) => captureVerifiedPageSnapshot(id, tracked),
        readReleasePin: () => readWorkspaceState(workspacePath)?.activeTaxonomyRevision ?? null,
        readCatalogCommit: () => '9cf6cf5d2551c4d93311a32c45d471877b85a9f1',
      };
      expect(() => capturePreparationAuthority({ ...base, readReleasePin: () => null })).toThrow(/no active taxonomy release pin/);
      expect(() => capturePreparationAuthority({ ...base, capturePages: () => ({ pageImportId: null, pageImportHash: null, records: [], verifiedPageIds: [] }) })).toThrow(/no_verified_page_catalog/);
    } finally {
      tracked.close();
    }
  });
});

describe('jev benchmark preparation: source candidates', () => {
  it('keeps one family in one split via the existing grouping', () => {
    const candidates = validateSourceCandidates([candidate('SKU-A1', 'fam-a'), candidate('SKU-A2', 'fam-a'), candidate('SKU-B1', 'fam-b')]);
    const manifest = assignFamilyManifest(candidates, { splitSeed: 42, holdoutPercent: 20 });
    expect(new Set(manifest.filter(m => m.familyId === 'fam-a').map(m => m.splitGroup)).size).toBe(1);
    expect(manifest[0].splitGroup).toBe(splitForFamily('fam-a', 42, 20));
    expect(JSON.stringify(manifest)).not.toMatch(/goldLabels|productType/);
  });

  it('rejects duplicate SKUs and incoherent shared URLs', () => {
    expect(() => validateSourceCandidates([candidate('SKU-X', 'fam-x'), candidate('SKU-X', 'fam-y')])).toThrow(/duplicate_source_sku/);
    const a = candidate('SKU-A', 'fam-a');
    const crossFamily = { ...candidate('SKU-B', 'fam-b'), canonicalUrl: a.canonicalUrl };
    expect(() => validateSourceCandidates([a, crossFamily])).toThrow(/across families/);
    const contraIdentity = {
      ...candidate('SKU-C', 'fam-a'),
      canonicalUrl: a.canonicalUrl,
      productIdentity: 'identity-OTHER',
    };
    expect(() => validateSourceCandidates([a, contraIdentity])).toThrow(/contradictory identities/);
    const contraSource = {
      ...candidate('SKU-D', 'fam-a'),
      canonicalUrl: a.canonicalUrl,
      productIdentity: a.productIdentity,
      sourceHash: 'd'.repeat(64),
    };
    expect(() => validateSourceCandidates([a, contraSource])).toThrow(/not the record source/);
  });

  it('permits a shared manufacturer page for coherent size/flavor variants', () => {
    const base = candidate('SKU-V1', 'fam-v');
    const variant = {
      ...candidate('SKU-V2', 'fam-v'),
      canonicalUrl: base.canonicalUrl,
      productIdentity: base.productIdentity,
      sourceLocator: base.sourceLocator,
      sourceHash: base.sourceHash,
      title: 'Title SKU-V2 5lb',
    };
    const rows = validateSourceCandidates([base, variant]);
    expect(rows).toHaveLength(2);
    const manifest = assignFamilyManifest(rows, { splitSeed: 42 });
    expect(new Set(manifest.map(m => m.splitGroup)).size).toBe(1);
  });

  it('rejects nested gold/provenance smuggling at any depth', () => {
    expect(() => validateSourceCandidates([candidate('S1', 'f1', { price: '9.99' })])).toThrow(/forbidden_source_field/);
    expect(() => validateSourceCandidates([{
      ...candidate('S1', 'f1'),
      excerpts: [{ text: 'x', locator: 'p1', goldLabels: { productType: 'dog-food' } }],
    }])).toThrow(/forbidden_source_field/);
  });

  it('rejects userinfo/localhost/LAN/secrets URLs, accepts public https', () => {
    expect(() => validateSourceCandidates([candidate('S1', 'f1', { canonicalUrl: 'https://user:pass@manufacturer.example/p' })])).toThrow();
    expect(() => validateSourceCandidates([candidate('S1', 'f1', { canonicalUrl: 'http://manufacturer.example/p' })])).toThrow();
    expect(() => validateSourceCandidates([candidate('S1', 'f1', { canonicalUrl: 'https://localhost/p' })])).toThrow();
    expect(() => validateSourceCandidates([candidate('S1', 'f1', { canonicalUrl: 'https://192.168.1.5/p' })])).toThrow();
    expect(() => validateSourceCandidates([candidate('S1', 'f1', { canonicalUrl: 'https://manufacturer.example/p?api_key=abc' })])).toThrow();
    expect(() => validateSourceCandidates([candidate('S1', 'f1', { canonicalUrl: 'https://manufacturer.example/p?access_token=abc' })])).toThrow();
    expect(() => validateSourceCandidates([candidate('S1', 'f1')])).not.toThrow();
  });

  it('rejects omitted source provenance', () => {
    const { sourceHash: _omitted, ...noHash } = candidate('SKU-X', 'fam-x');
    expect(() => validateSourceCandidates([noHash])).toThrow(/omitted_source_provenance|invalid_source_candidate/);
  });

  it('dry-run summary performs no writes and carries no payloads', () => {
    const { tracked } = openTrackedReadonly();
    try {
      const deps = {
        workspaceId: WS_ID,
        loadAuthority: () => loadRuntimeConfigAuthority(workspacePath),
        capturePages: (id: string) => captureVerifiedPageSnapshot(id, tracked),
        readReleasePin: () => readWorkspaceState(workspacePath)?.activeTaxonomyRevision ?? null,
        readCatalogCommit: () => '9cf6cf5d2551c4d93311a32c45d471877b85a9f1',
      };
      const view = capturePreparationAuthority(deps);
      const candidates = validateSourceCandidates([candidate('SKU-A1', 'fam-a')]);
      const manifest = assignFamilyManifest(candidates, { splitSeed: 42 });
      const summary = buildDryRunSummary({ workspaceId: WS_ID, authority: view, candidates, manifest });
      expect(summary.dryRun).toBe(true);
      expect(summary.writes).toBe(0);
      expect(JSON.stringify(summary)).not.toMatch(/goldLabels|input_snapshot_json|password/);
    } finally {
      tracked.close();
    }
  });

  it('CLI dry-run against the fixture succeeds with counts-only output', () => {
    const out = execFileSync(
      'bun',
      ['scripts/prepare-jev-benchmark.ts', '--workspace', workspacePath, '--db', dbPath, '--dataset', DATASET_ID],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const parsed = JSON.parse(out.slice(out.lastIndexOf('\n{') + 1)) as Record<string, unknown>;
    expect(parsed.dryRun).toBe(true);
    expect(parsed.writes).toBe(0);
    expect(parsed.verifiedPages).toBe(2);
    expect(out).not.toMatch(/SECRET-SKU|secret-gold|secret-input/);
    expect(sha256Hex(fs.readFileSync(dbPath))).toBe(dbBytesBefore);
  });

  it('CLI --write into an isolated out dir writes 4 public files with coherent accounting', () => {
    const base = candidate('SKU-W1', 'fam-w');
    const variant = {
      ...candidate('SKU-W2', 'fam-w'),
      canonicalUrl: base.canonicalUrl,
      productIdentity: base.productIdentity,
      sourceLocator: base.sourceLocator,
      sourceHash: base.sourceHash,
      title: 'Title SKU-W2 5lb',
    };
    const inventory = path.join(tmpRoot, 'inventory.json');
    fs.writeFileSync(inventory, JSON.stringify([base, variant]));
    const outDir = path.join(tmpRoot, 'write-out');
    expect(fs.existsSync(outDir)).toBe(false);
    const out = execFileSync(
      'bun',
      ['scripts/prepare-jev-benchmark.ts', '--workspace', workspacePath, '--db', dbPath,
        '--inventory', inventory, '--write', '--out', outDir],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const result = extractResultJson(out);
    // Explicit writes are accounted as writes — never the dry-run claim.
    expect(result.dryRun).toBe(false);
    expect(result.dbWrites).toBe(0);
    expect(result.filesWritten).toBe(4);
    expect(result.candidateCount).toBe(2);
    expect(result.verifiedPages).toBe(2);
    const names = ['manifest.json', 'taxonomy.json', 'development.json', 'support.json'];
    for (const name of names) expect(fs.existsSync(path.join(outDir, name))).toBe(true);
    const support = JSON.parse(fs.readFileSync(path.join(outDir, 'support.json'), 'utf8')) as Record<string, unknown>;
    expect(support).toMatchObject({
      dryRun: false,
      dbWrites: 0,
      filesWritten: 4,
      candidateCount: 2,
      authorityHash: result.authorityHash,
    });
    expect(support.splitDistribution).toEqual(result.splitDistribution);
    const bodies = names.map(name => fs.readFileSync(path.join(outDir, name), 'utf8')).join('\n');
    expect(bodies).not.toMatch(/goldLabels|SECRET-SKU|secret-gold|secret-input/);
    expect(out).not.toMatch(/SECRET-SKU|secret-gold|secret-input/);
    expect(sha256Hex(fs.readFileSync(dbPath))).toBe(dbBytesBefore);
  });
});

/** Brace-matched extraction of the printed result object (stdout carries log lines too). */
function extractResultJson(out: string): Record<string, unknown> {
  const start = out.indexOf('{\n  "dryRun"');
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < out.length; i++) {
    const ch = out[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(out.slice(start, i + 1)) as Record<string, unknown>;
    }
  }
  throw new Error('result JSON not found in CLI output');
}
