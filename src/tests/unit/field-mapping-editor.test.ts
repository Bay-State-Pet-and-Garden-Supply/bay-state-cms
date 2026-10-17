import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { getCachedAttributeMappings } from '../../db/repositories/classification-config-repo';
import { GitClient } from '../../git/git-client';
import { previewCandidate, activateBundle } from '../../classification/config-store';
import { generateCandidate } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import {
  applyFieldMappingEdits,
  FieldMappingEditError,
} from '../../classification/field-mapping-editor';
import {
  loadRuntimeConfigAuthority,
  createRuntimeActivationContext,
} from '../../classification/config-loader';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { sha256Hex } from '../../shared/stable-id';
import type { ClassificationConfigBundleV2 } from '../../shared/schemas/classification';

const REVIEWED_FIELDS = [
  'ProductField8', 'ProductField16', 'ProductField17', 'ProductField18',
  'ProductField19', 'ProductField20', 'ProductField21', 'ProductField22',
  'ProductField23', 'ProductField24', 'ProductField25', 'ProductField26',
  'ProductField27', 'ProductField28', 'ProductField29', 'ProductField30',
  'ProductField32',
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), `mapping-editor-${workspaceId.slice(0, 8)}`));
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

function activeBundle(): ClassificationConfigBundleV2 {
  const authority = loadRuntimeConfigAuthority(root, createRuntimeActivationContext(root, workspaceId));
  if (authority.kind !== 'v2') {
    throw new Error('expected an active v2 authority');
  }
  return authority.bundle;
}

function persistedState() {
  const classificationDir = path.join(root, 'store', 'classification');
  return {
    bundleHash: activeBundle().manifest.bundleHash,
    files: ['mappings.json', 'curation-targets.json', 'manifest.json']
      .map(fileName => fs.readFileSync(path.join(classificationDir, fileName))),
    cachedMappings: getCachedAttributeMappings(workspaceId),
    gitHead: runGit(['rev-parse', 'HEAD']),
  };
}

describe('field mapping editor (active v2 bundle)', () => {
  beforeEach(async () => {
    closeDb();
    setTaxonomyFreezeForTests(false);
    await freshWorkspace();
  });
  afterAll(() => {
    setTaxonomyFreezeForTests(true);
    closeDb();
  });

  it('unmaps and restores an optional semantic binding under its governed role', () => {
    const before = activeBundle();
    expect(before.attributeMappings.find(mapping => mapping.attributeId === 'size')?.catalogField).toBe('ProductField27');
    expect(before.attributeProfiles.some(profile =>
      profile.attributes.some(attribute => attribute.attributeId === 'size' && !attribute.required),
    )).toBe(true);

    applyFieldMappingEdits(root, workspaceId, [
      { catalogField: 'ProductField27', attributeId: null },
      {
        catalogField: 'ProductField27',
        attributeId: 'size',
        serialization: { kind: 'delimited', delimiter: '|', escapePolicy: 'reject', prefix: '', suffix: '' },
      },
    ], { gitEnabled: false });

    const after = activeBundle();
    const sizeMapping = after.attributeMappings.find(mapping => mapping.attributeId === 'size')!;
    expect(sizeMapping.catalogField).toBe('ProductField27');
    expect(sizeMapping.serialization).toEqual({
      kind: 'delimited',
      delimiter: '|',
      escapePolicy: 'reject',
      prefix: '',
      suffix: '',
    });
    expect(after.manifest.fileVersions['mappings.json']).not.toBe(before.manifest.fileVersions['mappings.json']);
    expect(after.curationTargets.find(target => target.kind === 'product_field' && target.attributeId === 'size')?.catalogField)
      .toBe('ProductField27');
    expect(getCachedAttributeMappings(workspaceId).find(mapping => mapping.attributeId === 'size')?.catalogField)
      .toBe('ProductField27');
    expect(getCachedAttributeMappings(workspaceId).find(mapping => mapping.attributeId === 'size')?.serialization)
      .toMatchObject({ kind: 'delimited', delimiter: '|' });
  });

  it('updates serialization on a certified semantic mapping and synchronizes the cache', () => {
    const before = activeBundle();
    applyFieldMappingEdits(root, workspaceId, [
      {
        catalogField: 'ProductField23',
        attributeId: 'flavor',
        serialization: { kind: 'delimited', delimiter: '|', escapePolicy: 'reject', prefix: '', suffix: '' },
      },
    ], { gitEnabled: false });

    const after = activeBundle();
    const mapping = after.attributeMappings.find(candidate => candidate.attributeId === 'flavor')!;
    expect(mapping.catalogField).toBe('ProductField23');
    expect(mapping.serialization).toEqual({ kind: 'delimited', delimiter: '|', escapePolicy: 'reject', prefix: '', suffix: '' });
    expect(after.manifest.fileVersions['mappings.json']).not.toBe(before.manifest.fileVersions['mappings.json']);
    expect(getCachedAttributeMappings(workspaceId).find(candidate => candidate.attributeId === 'flavor')?.serialization)
      .toMatchObject({ kind: 'delimited', delimiter: '|' });
  });

  it('fails active validation atomically for an incompatible serializer on a certified field', () => {
    const before = persistedState();
    let refusal: FieldMappingEditError | null = null;
    try {
      applyFieldMappingEdits(root, workspaceId, [
        {
          catalogField: 'ProductField23',
          attributeId: 'flavor',
          serialization: { kind: 'measured', unit: 'kg', valueUnitSeparator: ' ', prefix: '', suffix: '' },
        },
      ], { gitEnabled: false });
    } catch (error) {
      refusal = error as FieldMappingEditError;
    }
    expect(refusal?.code).toBe('validation_failed');
    expect(refusal?.message).toContain('unexpected_measured_serialization');
    expect(persistedState()).toEqual(before);
  });

  it('keeps an unchanged input-only Brand reaffirmation out of a mixed save batch', () => {
    const before = activeBundle();
    const brandBefore = before.attributeMappings.find(mapping => mapping.attributeId === 'brand')!;
    const result = applyFieldMappingEdits(root, workspaceId, [
      { catalogField: 'ProductField16', attributeId: 'brand' },
      {
        catalogField: 'ProductField23',
        attributeId: 'flavor',
        serialization: { kind: 'delimited', delimiter: '|', escapePolicy: 'reject', prefix: '', suffix: '' },
      },
    ], { gitEnabled: false });

    const after = activeBundle();
    expect(result.appliedFields).toEqual(['ProductField23']);
    expect(after.attributeMappings.find(mapping => mapping.attributeId === 'brand')).toEqual(brandBefore);
    expect(after.attributeMappings.find(mapping => mapping.attributeId === 'flavor')?.serialization)
      .toMatchObject({ kind: 'delimited', delimiter: '|' });
    expect(getCachedAttributeMappings(workspaceId).find(mapping => mapping.attributeId === 'brand')?.catalogField)
      .toBe('ProductField16');
  });

  it('refuses removal of the input-only Brand mapping without changing files, cache, or Git history', () => {
    const before = persistedState();
    let refusal: FieldMappingEditError | null = null;
    try {
      applyFieldMappingEdits(root, workspaceId, [
        { catalogField: 'ProductField16', attributeId: null },
      ], { gitEnabled: false });
    } catch (error) {
      refusal = error as FieldMappingEditError;
    }
    expect(refusal?.code).toBe('invalid_edit');
    expect(refusal?.message).toContain('input-only Brand');
    expect(persistedState()).toEqual(before);
  });

  it('refuses protected, unknown, and cross-role outputs atomically', () => {
    const before = persistedState();
    const rejectedEdits = [
      { catalogField: 'ProductField6', attributeId: 'flavor' },
      { catalogField: 'ProductField99', attributeId: 'size' },
      { catalogField: 'ProductField27', attributeId: 'material' },
    ] as const;

    for (const edit of rejectedEdits) {
      let refusal: FieldMappingEditError | null = null;
      try {
        applyFieldMappingEdits(root, workspaceId, [edit], { gitEnabled: false });
      } catch (error) {
        refusal = error as FieldMappingEditError;
      }
      expect(refusal?.code).toBe('invalid_edit');
      expect(refusal?.message).toContain(edit.catalogField);
    }

    expect(persistedState()).toEqual(before);
    const after = activeBundle();
    expect(after.attributeMappings.find(mapping => mapping.attributeId === 'material')?.catalogField).toBe('ProductField28');
    expect(after.attributeMappings.find(mapping => mapping.attributeId === 'size')?.catalogField).toBe('ProductField27');
  });

  it('commits a valid mapping serialization change only within the classification scope', () => {
    const headBefore = runGit(['rev-parse', 'HEAD']);
    const result = applyFieldMappingEdits(root, workspaceId, [
      {
        catalogField: 'ProductField28',
        attributeId: 'material',
        serialization: { kind: 'delimited', delimiter: '|', escapePolicy: 'reject', prefix: '', suffix: '' },
      },
    ]);
    const headAfter = runGit(['rev-parse', 'HEAD']);
    expect(headAfter).not.toBe(headBefore);
    expect(result.commitHash).toBe(headAfter);
    expect(activeBundle().attributeMappings.find(mapping => mapping.attributeId === 'material')?.catalogField)
      .toBe('ProductField28');
    expect(getCachedAttributeMappings(workspaceId).find(mapping => mapping.attributeId === 'material')?.serialization)
      .toMatchObject({ kind: 'delimited', delimiter: '|' });
    const touched = runGit(['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean);
    expect(touched).toContain('store/classification/mappings.json');
    expect(touched.every(file => file.startsWith('store/classification/'))).toBe(true);
  });
});
