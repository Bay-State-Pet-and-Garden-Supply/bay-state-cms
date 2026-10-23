import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { GitClient } from '../../git/git-client';
import { previewCandidate, activateBundle } from '../../classification/config-store';
import { generateCandidate } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import {
  applyAttributeProfileEdits,
  AttributeProfileEditError,
} from '../../classification/attribute-profile-editor';
import {
  loadRuntimeConfigAuthority,
  createRuntimeActivationContext,
} from '../../classification/config-loader';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { sha256Hex } from '../../shared/stable-id';

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
  root = fs.mkdtempSync(path.join(os.tmpdir(), `profile-editor-${workspaceId.slice(0, 8)}`));
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
  fs.writeFileSync(
    path.join(root, 'store', 'field-registry.json'),
    JSON.stringify({ entries: [...REVIEWED_FIELDS].sort().map(xmlField => ({ xmlField })) }),
    'utf-8',
  );
  runGit(['add', '--', 'store/manifest.json', 'store/field-registry.json']);
  runGit(['commit', '-m', 'seed catalog manifest']);

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
    gitEnabled: true,
  });
}

describe('attribute-profile-editor', () => {
  beforeAll(async () => {
    // P0 taxonomy freeze: this suite exercises the editor implementation, so
    // the freeze is explicitly lifted for the duration of the tests.
    setTaxonomyFreezeForTests(false);
    await freshWorkspace();
  });

  afterAll(() => {
    setTaxonomyFreezeForTests(true);
    try { closeDb(); } catch {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });

  it('applies surgical edits to a profile', () => {
    const activationContext = createRuntimeActivationContext(root, workspaceId);
    const initialAuth = loadRuntimeConfigAuthority(root, activationContext);
    expect(initialAuth.kind).toBe('v2');
    if (initialAuth.kind !== 'v2') return;

    const initialBundle = initialAuth.bundle;
    const dogFoodType = initialBundle.productTypes.find(pt => pt.name.toLowerCase().includes('dog')) ?? initialBundle.productTypes[0];

    const result = applyAttributeProfileEdits(root, workspaceId, dogFoodType.id, [
      { attributeId: 'material', included: true, required: false, cardinality: 'single' },
    ]);

    expect(result.bundleHash).toBeDefined();
    expect(result.updatedAttributeIds).toContain('material');

    const updatedAuth = loadRuntimeConfigAuthority(root, activationContext);
    expect(updatedAuth.kind).toBe('v2');
    if (updatedAuth.kind !== 'v2') return;

    const profile = updatedAuth.bundle.attributeProfiles.find(
      p => p.id === dogFoodType.attributeProfileId || p.productTypeId === dogFoodType.id,
    );
    expect(profile).toBeDefined();
    const materialEntry = profile?.attributes.find(a => a.attributeId === 'material');
    expect(materialEntry).toBeDefined();
    expect(materialEntry?.cardinality).toBe('single');
  });

  it('removes an attribute from a profile when included is false', () => {
    const activationContext = createRuntimeActivationContext(root, workspaceId);
    const auth = loadRuntimeConfigAuthority(root, activationContext);
    if (auth.kind !== 'v2') return;

    const dogFoodType = auth.bundle.productTypes.find(pt => pt.name.toLowerCase().includes('dog')) ?? auth.bundle.productTypes[0];

    applyAttributeProfileEdits(root, workspaceId, dogFoodType.id, [
      { attributeId: 'material', included: false },
    ]);

    const updatedAuth = loadRuntimeConfigAuthority(root, activationContext);
    if (updatedAuth.kind !== 'v2') return;

    const profile = updatedAuth.bundle.attributeProfiles.find(
      p => p.id === dogFoodType.attributeProfileId || p.productTypeId === dogFoodType.id,
    );
    const materialEntry = profile?.attributes.find(a => a.attributeId === 'material');
    expect(materialEntry).toBeUndefined();
  });

  it('fails with unknown_product_type if product type does not exist', () => {
    expect(() =>
      applyAttributeProfileEdits(root, workspaceId, 'non-existent-type', [
        { attributeId: 'material', included: true },
      ]),
    ).toThrowError(AttributeProfileEditError);
  });

  it('fails with unknown_attribute if attribute does not exist', () => {
    const activationContext = createRuntimeActivationContext(root, workspaceId);
    const auth = loadRuntimeConfigAuthority(root, activationContext);
    if (auth.kind !== 'v2') return;

    const pt = auth.bundle.productTypes[0];
    expect(() =>
      applyAttributeProfileEdits(root, workspaceId, pt.id, [
        { attributeId: 'non-existent-attr', included: true },
      ]),
    ).toThrowError(AttributeProfileEditError);
  });
});
