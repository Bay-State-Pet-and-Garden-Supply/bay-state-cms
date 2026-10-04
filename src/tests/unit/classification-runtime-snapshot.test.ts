import { describe, it, expect, beforeAll } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createRun } from '../../db/repositories/classification-run-repo';
import { saveClassificationConfig, loadClassificationConfig } from '../../classification/config-loader';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { createConfigSnapshot } from '../../db/repositories/classification-config-repo';
import {
  buildRuntimeSnapshot,
  deepFreeze,
  snapshotHash,
  persistRuntimeSnapshot,
  getRuntimeSnapshotByHash,
  runtimeSnapshotHashMatchesConfig,
} from '../../classification/runtime-snapshot';
import type { RuntimeSnapshotInput } from '../../classification/runtime-snapshot';
import { resolveTargetsFromSnapshot } from '../../classification/curation-target-resolver';

let workspacePath: string;
let workspaceId: string;

const TARGETS = [
  { id: 'primary-product-type', kind: 'product_type' as const, label: 'Primary Product Type', enabled: true, selectionMode: 'single' as const, attributeId: null, catalogField: null, optionSource: 'configured' as const, required: false, mandatory: false, sortOrder: 0 },
  { id: 'flavor', kind: 'product_field' as const, label: 'Flavor', enabled: true, selectionMode: 'single' as const, attributeId: 'flavor', catalogField: 'ProductField1', optionSource: 'configured' as const, required: false, mandatory: false, sortOrder: 1 },
];

function buildInput(overrides: Partial<RuntimeSnapshotInput> = {}): RuntimeSnapshotInput {
  const config = loadClassificationConfig(workspacePath);
  const { id: snapId, hash: snapHash } = createConfigSnapshot(workspaceId, config);
  return {
    workspaceId,
    workspacePath,
    productSku: 'SKU-001',
    config,
    configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: '2026-08-01T12:00:00.000Z' },
    sourceProductHash: 'src-hash-1',
    searchKeywords: 'dog food',
    productPageNames: ['Dog Food'],
    pages: {
      state: 'no_verified_page_catalog',
      nameOnlyRecords: [{ pageId: 'Dog Food', pageName: 'Dog Food', verified: false }],
    },
    ...overrides,
  };
}

describe('classification runtime snapshot', () => {
  beforeAll(() => {
    // P0 taxonomy freeze: this suite writes a legacy config, so the freeze is
    // explicitly lifted for the duration of the tests.
    setTaxonomyFreezeForTests(false);
    workspaceId = randomUUID();
    workspacePath = path.join(os.tmpdir(), `baystate-cms-runtime-snap-${workspaceId.slice(0, 8)}`);
    fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
    initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
    runMigrations();
    insertWorkspace({ id: workspaceId, name: 'test', workspacePath, gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });

    const now = '2026-08-01T12:00:00.000Z';
    saveClassificationConfig(workspacePath, {
      manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: now, updatedAt: now, fileVersions: {} },
      productTypes: [
        { id: 'dry-dog-food', name: 'Dry Dog Food', description: null, attributeProfileId: 'dry-dog-food-profile', oldIdAliases: [] },
      ],
      attributes: [
        { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled' as const, canonicalUnit: null, allowedValues: ['Chicken', 'Beef'], valueAliases: [], visualEvidenceEligibility: 'eligible' as const, isClaim: false, isCompositionAttribute: false, group: 'Food' },
      ],
      attributeProfiles: [
        { id: 'dry-dog-food-profile', productTypeId: 'dry-dog-food', name: 'Dry Dog Food Profile', attributes: [{ attributeId: 'flavor', required: true, cardinality: 'single' as const, applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] }] },
      ],
      attributeMappings: [
        { id: 'flavor-mapping', attributeId: 'flavor', catalogField: 'ProductField1', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      ],
      curationTargets: TARGETS,
      brands: [],
      guidance: [],
      modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only' as const, textDataSharing: 'local_only' as const },
      dataSharing: { imagePolicy: 'local_only' as const, textPolicy: 'local_only' as const, sensitiveDataFiltering: true, retentionDays: 90 },
    });
  });

  it('deep-freezes the snapshot so mutation attempts throw', () => {
    const snapshot = buildRuntimeSnapshot(buildInput());
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.config)).toBe(true);
    expect(Object.isFrozen(snapshot.config.productTypes)).toBe(true);
    expect(Object.isFrozen(snapshot.fieldOptions)).toBe(true);

    expect(() => {
      (snapshot as { sourceProductHash: string }).sourceProductHash = 'mutated';
    }).toThrow();

    expect(() => {
      (snapshot.config.productTypes as unknown as Array<Record<string, unknown>>).push({ id: 'x', name: 'x' });
    }).toThrow();

    expect(() => {
      snapshot.fieldOptions['flavor']!.push({ value: 'Injected', label: 'Injected' });
    }).toThrow();
  });

  it('hashes identically for identical inputs and differs on any stage-visible change', () => {
    const first = buildRuntimeSnapshot(buildInput());
    const second = buildRuntimeSnapshot(buildInput());
    expect(first.snapshotHash).toBe(second.snapshotHash);

    const differentSource = buildRuntimeSnapshot(buildInput({ sourceProductHash: 'src-hash-2' }));
    expect(differentSource.snapshotHash).not.toBe(first.snapshotHash);

    const differentKeywords = buildRuntimeSnapshot(buildInput({ searchKeywords: 'other keywords' }));
    expect(differentKeywords.snapshotHash).not.toBe(first.snapshotHash);

    const differentPages = buildRuntimeSnapshot(buildInput({ productPageNames: ['Bird Food'] }));
    expect(differentPages.snapshotHash).not.toBe(first.snapshotHash);
  });

  it('excludes createdAt and the embedded hash from the snapshot hash', () => {
    const a = buildRuntimeSnapshot(buildInput({ createdAt: '2026-08-01T12:00:00.000Z' }));
    const b = buildRuntimeSnapshot(buildInput({ createdAt: '2026-09-01T12:00:00.000Z' }));
    expect(a.snapshotHash).toBe(b.snapshotHash);

    // snapshotHash must be a pure function of the snapshot object (no embedded value).
    expect(snapshotHash(a)).toBe(a.snapshotHash);
    expect(snapshotHash(b)).toBe(b.snapshotHash);
  });

  it('produces identical hashes regardless of the configSnapshotRef creation timestamp', () => {
    const inputA = buildInput();
    const inputB = buildInput();
    inputB.configSnapshotRef = {
      ...inputA.configSnapshotRef,
      createdAt: '2026-09-15T08:30:00.000Z',
    };
    const a = buildRuntimeSnapshot(inputA);
    const b = buildRuntimeSnapshot(inputB);
    // Two builds at different wall-clock times must deduplicate by hash.
    expect(a.snapshotHash).toBe(b.snapshotHash);
    expect(snapshotHash(a)).toBe(snapshotHash(b));
  });

  it('resolves product-field options with canonical controlled-value identity (issue #17 G)', () => {
    const snapshot = buildRuntimeSnapshot(buildInput());
    const resolved = resolveTargetsFromSnapshot(snapshot);
    const flavorTarget = resolved.productFields.find(target => target.config.id === 'flavor');
    expect(flavorTarget).toBeDefined();
    // Options carry {value: id, label: id} — label equals the exact canonical ID.
    const options = flavorTarget!.options;
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.value).toBe(option.label);
      expect(option.value).toBe(option.value.trim());
      expect(option.value).toBe(option.value.normalize('NFC'));
    }
  });

  it('persists the snapshot and recomputes an identical hash after persistence', () => {
    const snapshot = buildRuntimeSnapshot(buildInput());
    const { id, hash } = persistRuntimeSnapshot(snapshot);
    expect(hash).toBe(snapshot.snapshotHash);

    // Recompute from the persisted row — must match.
    const rehydrated = getRuntimeSnapshotByHash(workspaceId, hash);
    expect(rehydrated).not.toBeNull();
    expect(rehydrated!.snapshotHash).toBe(hash);
    expect(snapshotHash(rehydrated!)).toBe(hash);

    // Idempotent: same snapshot hash returns the existing row.
    const again = persistRuntimeSnapshot(snapshot);
    expect(again.id).toBe(id);
    expect(again.hash).toBe(hash);

    // Persisted row is queryable and bound to the workspace.
    const rows = getDb().query('SELECT id, snapshot_hash FROM classification_config_snapshots WHERE workspace_id = ?').all(workspaceId) as Array<{ id: string; snapshot_hash: string }>;
    expect(rows.some(row => row.id === id && row.snapshot_hash === hash)).toBe(true);
  });

  it('fails closed when the embedded hash disagrees before persistence', () => {
    const snapshot = buildRuntimeSnapshot(buildInput());
    // structuredClone produces an unfrozen copy with the same shape; tampering
    // the embedded hash must be rejected by the persistence guard.
    const tampered = structuredClone(snapshot);
    tampered.snapshotHash = '0'.repeat(64);
    expect(() => persistRuntimeSnapshot(tampered)).toThrow(/hash mismatch/);
  });

  it('reports the snapshot as matching the current config and not matching drifted config', () => {
    const snapshot = buildRuntimeSnapshot(buildInput());
    persistRuntimeSnapshot(snapshot);

    const currentConfig = loadClassificationConfig(workspacePath);
    expect(runtimeSnapshotHashMatchesConfig(workspaceId, snapshot.snapshotHash, currentConfig)).toBe(true);

    const driftedConfig = {
      ...currentConfig,
      productTypes: [...currentConfig.productTypes, { id: 'cat-food', name: 'Cat Food', description: null, attributeProfileId: null, oldIdAliases: [] }],
    };
    expect(runtimeSnapshotHashMatchesConfig(workspaceId, snapshot.snapshotHash, driftedConfig)).toBe(false);

    // Unknown hashes are not treated as runtime snapshots (fail closed).
    expect(runtimeSnapshotHashMatchesConfig(workspaceId, 'deadbeef', currentConfig)).toBe(false);
  });

  it('collects reviewed facts into the snapshot and marks page context low reliability', () => {
    const snapshot = buildRuntimeSnapshot(buildInput());
    expect(snapshot.reviewedFacts).toBeInstanceOf(Array);
    expect(snapshot.pageContextReliability).toBe('low');
    expect(snapshot.pages.state).toBe('no_verified_page_catalog');
  });

  it('carries only provenance-compatible reviewed facts and drops drifted facts', () => {
    const config = loadClassificationConfig(workspacePath);
    const { hash: configHash } = createConfigSnapshot(workspaceId, config);
    const db = getDb();
    const now = new Date().toISOString();

    // Run A: accepted type under this config + source hash 'src-hash-1'.
    const run = createRun(workspaceId, 'FACT-SKU', null, configHash, {
      sourceKind: 'catalog_product',
      sourceProductHash: 'src-hash-1',
    });
    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'primary_product_type', 'dry-dog-food', '{"productTypeId":"dry-dog-food"}', 0.9, 'accepted', ?)`,
      ['fact-proposal', run.id, 'FACT-SKU', now],
    );
    db.run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, revised_value_json, revised_target_id, created_at, superseded_at)
       VALUES (?, ?, 'accepted', '{"productTypeId":"dry-dog-food"}', 'dry-dog-food', ?, NULL)`,
      ['fact-decision', 'fact-proposal', now],
    );

    // Compatible snapshot: same config + same source hash → fact carried.
    const unattributed = buildRuntimeSnapshot(buildInput({ productSku: 'FACT-SKU', sourceProductHash: 'src-hash-1' }));
    expect(unattributed.reviewedFacts.some(fact => fact.decisionId === 'fact-decision')).toBe(false);
    db.run(`UPDATE classification_proposal_decisions SET decision_origin = 'human_review' WHERE id = 'fact-decision'`);
    const compatible = buildRuntimeSnapshot(buildInput({
      productSku: 'FACT-SKU',
      sourceProductHash: 'src-hash-1',
    }));
    expect(compatible.reviewedFacts.some(fact => fact.decisionId === 'fact-decision')).toBe(true);

    // Drifted source hash → the fact is dropped (never silently reused).
    const drifted = buildRuntimeSnapshot(buildInput({
      productSku: 'FACT-SKU',
      sourceProductHash: 'src-hash-999',
    }));
    expect(drifted.reviewedFacts.some(fact => fact.decisionId === 'fact-decision')).toBe(false);
  });

  it('normalizes empty and null source product hashes to one representation', () => {
    const config = loadClassificationConfig(workspacePath);
    const { hash: configHash } = createConfigSnapshot(workspaceId, config);
    const db = getDb();
    const now = new Date().toISOString();

    // Onboarding-style run: source_product_hash stored as NULL.
    const run = createRun(workspaceId, 'ONB-SKU', null, configHash, {
      sourceKind: 'onboarding',
      sourceProductHash: null,
    });
    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'primary_product_type', 'dry-dog-food', '{"productTypeId":"dry-dog-food"}', 0.9, 'accepted', ?)`,
      ['onb-proposal', run.id, 'ONB-SKU', now],
    );
    db.run(
      `INSERT INTO classification_proposal_decisions
        (id, proposal_id, decision, revised_value_json, revised_target_id, created_at, superseded_at, decision_origin)
        VALUES (?, ?, 'accepted', '{"productTypeId":"dry-dog-food"}', 'dry-dog-food', ?, NULL, 'human_review')`,
      ['onb-decision', 'onb-proposal', now],
    );

    // Snapshot built with an empty source hash (the historical onboarding
    // representation) must match the NULL run row and carry the fact.
    const snapshot = buildRuntimeSnapshot(buildInput({
      productSku: 'ONB-SKU',
      sourceProductHash: '',
    }));
    expect(snapshot.sourceProductHash).toBeNull();
    expect(snapshot.reviewedFacts.some(fact => fact.decisionId === 'onb-decision')).toBe(true);
  });

  it('deepFreeze is transitive for nested arrays of objects', () => {
    const nested = { a: [{ b: 1 }], c: new Map() } as unknown as Record<string, unknown>;
    const frozen = deepFreeze(nested) as { a: Array<{ b: number }> };
    expect(Object.isFrozen(frozen.a)).toBe(true);
    expect(Object.isFrozen(frozen.a[0])).toBe(true);
    expect(() => {
      frozen.a[0].b = 2;
    }).toThrow();
  });

  it('freezes invariantAttributes on product types and affects snapshotHash', () => {
    const baseInput = buildInput({ productSku: 'INVARIANT-SKU' });
    const snap1 = buildRuntimeSnapshot(baseInput);

    const configWithInvariants = {
      ...baseInput.config,
      productTypes: [
        {
          id: 'dry-dog-food',
          name: 'Dry Dog Food',
          description: null,
          attributeProfileId: 'dry-dog-food-profile',
          oldIdAliases: [],
          invariantAttributes: {
            species: 'Dog',
          },
        },
      ],
    };
    const snap2 = buildRuntimeSnapshot(buildInput({
      productSku: 'INVARIANT-SKU',
      config: configWithInvariants as any,
    }));

    expect(snap2.productTypes[0].invariantAttributes).toEqual({ species: 'Dog' });
    expect(Object.isFrozen(snap2.productTypes[0].invariantAttributes)).toBe(true);
    expect(snap1.snapshotHash).not.toBe(snap2.snapshotHash);
  });
});

setTaxonomyFreezeForTests(true);
