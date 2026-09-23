import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClassificationConfig } from '../../shared/schemas/classification';
import { canonicalJsonFileString, sha256Hex } from '../../shared/stable-id';
import {
  ClassificationConfigLoadError,
  ClassificationConfigNotConfiguredError,
  classificationDir,
  hasClassificationConfig,
  loadClassificationConfig,
  loadActiveClassificationConfigBundleV2,
  loadClassificationConfigBundleV2Preview,
  loadLegacyV1ConfigForMigration,
  loadRuntimeConfigAuthority,
  loadStrictLegacyV1RuntimeConfig,
  saveClassificationConfig,
} from '../../classification/config-loader';
import {
  ClassificationManifestV2Schema,
  ModelPolicyFileV2Schema,
  DataSharingFileV2Schema,
} from '../../shared/schemas/classification';
import { writeWorkspaceState } from '../../classification/workspace-state';
import { V5_TAXONOMY_REVISION } from '../../classification/release-compiler';
import {
  LegacyClassificationConfigV1Schema,
  migrateClassificationConfigV1,
} from '../../classification/config-migrate-v1';
import { computeClassificationBundleHash, computeMigrationFindingsDigest } from '../../classification/config-validation';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';

// P0 taxonomy freeze: this suite exercises the transitional legacy writer, so
// the freeze is explicitly lifted for the duration of the tests (restored in
// afterEach below).
setTaxonomyFreezeForTests(false);

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'classification-config-loader-'));
  roots.push(root);
  return root;
}

function v1Config(overrides: Partial<ClassificationConfig> = {}): ClassificationConfig {
  const now = '2026-08-01T12:00:00.000Z';
  return {
    manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: now, updatedAt: now, fileVersions: {} },
    productTypes: [],
    attributes: [{
      id: 'brand',
      name: 'Brand',
      description: null,
      valueMode: 'controlled',
      canonicalUnit: null,
      allowedValues: ['Woof'],
      valueAliases: [],
      visualEvidenceEligibility: 'eligible',
      isClaim: false,
      isCompositionAttribute: false,
      group: 'Identity',
    }],
    attributeProfiles: [],
    attributeMappings: [{
      id: 'brand-mapping',
      attributeId: 'brand',
      catalogField: 'ProductField16',
      serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' },
      isStale: false,
    }],
    curationTargets: [{
      id: 'primary-product-type',
      kind: 'product_type',
      label: 'Primary Product Type',
      enabled: true,
      mandatory: false,
      selectionMode: 'single',
      attributeId: null,
      catalogField: null,
      optionSource: 'configured',
      required: true,
      sortOrder: 0,
    }],
    brands: [],
    guidance: [],
    modelPolicy: {
      defaultProvider: 'ollama',
      defaultModel: 'test',
      stageOverrides: {},
      imageDataSharing: 'local_only',
      textDataSharing: 'local_only',
    },
    dataSharing: {
      imagePolicy: 'local_only',
      textPolicy: 'local_only',
      sensitiveDataFiltering: true,
      retentionDays: 90,
    },
    ...overrides,
  };
}

function writeV2(root: string, source = v1Config()): ReturnType<typeof migrateClassificationConfigV1> {
  const migrated = migrateClassificationConfigV1(source);
  const dir = classificationDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), canonicalJsonFileString(migrated.bundle.manifest));
  for (const [fileName, content] of Object.entries(migrated.focusedFiles)) {
    fs.writeFileSync(path.join(dir, fileName), content);
  }
  return migrated;
}

function writeManifest(root: string, manifest: ReturnType<typeof migrateClassificationConfigV1>['bundle']['manifest']): void {
  fs.writeFileSync(path.join(classificationDir(root), 'manifest.json'), canonicalJsonFileString(manifest));
}

function activateManifest(root: string, migrated: ReturnType<typeof migrateClassificationConfigV1>): void {
  const reviewedOrigin = { kind: 'reviewed_generation' as const };
  migrated.bundle.bundleOrigin = reviewedOrigin;
  for (const fileName of Object.keys(migrated.focusedFiles)) {
    const filePath = path.join(classificationDir(root), fileName);
    const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    envelope.bundleOrigin = reviewedOrigin;
    const content = canonicalJsonFileString(envelope);
    fs.writeFileSync(filePath, content);
    migrated.bundle.manifest.fileVersions[fileName] = sha256Hex(content);
  }
  migrated.bundle.manifest.activeRevision = 'bay-state-v2';
  migrated.bundle.manifest.lifecycle = 'active';
  migrated.bundle.manifest.hasUnresolvedSafetyFindings = false;
  // Milestone 3's reviewed generator produces clean focused payloads and a
  // clean manifest together; this test simulates that regeneration.
  migrated.bundle.manifest.migrationProvenance = reviewedOrigin;
  migrated.bundle.manifest.sourceCatalogCommit = 'a'.repeat(40);
  migrated.bundle.manifest.catalogEvidenceHash = 'b'.repeat(64);
  migrated.bundle.manifest.bundleHash = computeClassificationBundleHash(migrated.bundle.manifest);
  writeManifest(root, migrated.bundle.manifest);
}

beforeEach(() => {
  // Lift the P0 freeze for each test in this suite (restored in afterEach).
  setTaxonomyFreezeForTests(false);
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  setTaxonomyFreezeForTests(true);
});

describe('classification config loader fail-closed reads', () => {
  it('distinguishes an unconfigured workspace and creates nothing while reading', () => {
    const root = tempRoot();
    const dir = classificationDir(root);
    expect(fs.existsSync(dir)).toBe(false);
    expect(() => loadClassificationConfig(root)).toThrow(ClassificationConfigNotConfiguredError);
    expect(() => hasClassificationConfig(root)).toThrow(ClassificationConfigNotConfiguredError);
    expect(fs.existsSync(dir)).toBe(false);

    fs.mkdirSync(dir, { recursive: true });
    expect(() => loadClassificationConfig(root)).toThrow(ClassificationConfigNotConfiguredError);
    // Only exact manifest absence under verified real directories maps to false.
    expect(hasClassificationConfig(root)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('treats a partial active directory as malformed rather than defaulting files', () => {
    const root = tempRoot();
    const dir = classificationDir(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'attributes.json'), '[]\n');
    try {
      loadClassificationConfig(root);
      throw new Error('expected load to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ClassificationConfigLoadError);
      expect((error as ClassificationConfigLoadError).code).toBe('missing_file');
    }
    expect(fs.readdirSync(dir)).toEqual(['attributes.json']);
  });

  it('loads a complete validated v1 bundle without changing directory entries or mtimes', () => {
    const root = tempRoot();
    saveClassificationConfig(root, v1Config());
    const dir = classificationDir(root);
    const before = Object.fromEntries(fs.readdirSync(dir).sort().map(file => [file, fs.statSync(path.join(dir, file)).mtimeMs]));

    const loaded = loadClassificationConfig(root);
    expect(loaded.attributes.map(attribute => attribute.id)).toEqual(['brand']);
    expect(loadLegacyV1ConfigForMigration(root).manifest.schemaVersion).toBe(1);
    // Explicitly attests the approved transitional boundary: v1 remains the
    // runtime source until the locked store/native-v2 activation milestones.
    expect(loadStrictLegacyV1RuntimeConfig(root).manifest.schemaVersion).toBe(1);

    const after = Object.fromEntries(fs.readdirSync(dir).sort().map(file => [file, fs.statSync(path.join(dir, file)).mtimeMs]));
    expect(after).toEqual(before);
  });

  it('rejects missing, invalid JSON, structurally invalid, and unsupported v1 files', () => {
    const missingRoot = tempRoot();
    saveClassificationConfig(missingRoot, v1Config());
    fs.rmSync(path.join(classificationDir(missingRoot), 'brands.json'));
    expect(() => loadClassificationConfig(missingRoot)).toThrowError(expect.objectContaining({ code: 'missing_file' }));

    const jsonRoot = tempRoot();
    saveClassificationConfig(jsonRoot, v1Config());
    fs.writeFileSync(path.join(classificationDir(jsonRoot), 'attributes.json'), '{not json');
    expect(() => loadClassificationConfig(jsonRoot)).toThrowError(expect.objectContaining({ code: 'invalid_json' }));

    const invalidRoot = tempRoot();
    saveClassificationConfig(invalidRoot, v1Config());
    fs.writeFileSync(path.join(classificationDir(invalidRoot), 'model-policies.json'), JSON.stringify({ defaultProvider: false }));
    expect(() => loadClassificationConfig(invalidRoot)).toThrowError(expect.objectContaining({ code: 'invalid_config' }));

    const unsupportedRoot = tempRoot();
    saveClassificationConfig(unsupportedRoot, v1Config());
    const manifestPath = path.join(classificationDir(unsupportedRoot), 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 99 }));
    expect(() => loadClassificationConfig(unsupportedRoot)).toThrowError(expect.objectContaining({ code: 'unsupported_version' }));
  });

  it('separates preview v2 loading from active validation and refuses the lossy legacy runtime adapter', () => {
    const root = tempRoot();
    const migrated = writeV2(root);
    const preview = loadClassificationConfigBundleV2Preview(root);
    expect(preview.manifest.bundleHash).toBe(migrated.bundle.manifest.bundleHash);
    expect(preview.modelPolicy.mlFeatures.productionRetrieval.state).toBe('disabled');
    expect(() => loadActiveClassificationConfigBundleV2(root, { catalogFields: ['ProductField16'] }))
      .toThrowError(expect.objectContaining({ code: 'invalid_config' }));
    expect(() => loadClassificationConfig(root))
      .toThrowError(expect.objectContaining({ code: 'unsupported_version' }));

    activateManifest(root, migrated);
    // An active-lifecycle bundle must never be returned by the preview loader.
    expect(() => loadClassificationConfigBundleV2Preview(root))
      .toThrowError(expect.objectContaining({ code: 'invalid_config' }));
    // Active loading without a verified activation context fails closed.
    expect(() => loadActiveClassificationConfigBundleV2(root, { catalogFields: ['ProductField16'] }))
      .toThrowError(expect.objectContaining({ code: 'invalid_config' }));
    const active = loadActiveClassificationConfigBundleV2(root, {
      catalogFields: ['ProductField16'],
      verifyCatalogEvidence: () => ({ verified: true as const }),
    });
    expect(active.manifest.activeRevision).toBe('bay-state-v2');
  });

  it('rejects missing persisted v2 fields instead of injecting defaults', () => {
    const root = tempRoot();
    const migrated = writeV2(root);
    const mappingPath = path.join(classificationDir(root), 'mappings.json');
    const mappingFile = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
    delete mappingFile.entries[0].serialization.prefix;
    const content = canonicalJsonFileString(mappingFile);
    fs.writeFileSync(mappingPath, content);
    migrated.bundle.manifest.fileVersions['mappings.json'] = sha256Hex(content);
    migrated.bundle.manifest.bundleHash = computeClassificationBundleHash(migrated.bundle.manifest);
    writeManifest(root, migrated.bundle.manifest);
    expect(() => loadClassificationConfigBundleV2Preview(root))
      .toThrowError(expect.objectContaining({ code: 'invalid_config' }));
  });

  it('hashes exact raw bytes and rejects malformed UTF-8 before JSON parsing', () => {
    const root = tempRoot();
    const migrated = writeV2(root);
    const attributesPath = path.join(classificationDir(root), 'attributes.json');
    const original = fs.readFileSync(attributesPath);
    const marker = Buffer.from('Brand');
    const markerIndex = original.indexOf(marker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    const raw = Buffer.from(original);
    raw[markerIndex] = 0xff;
    fs.writeFileSync(attributesPath, raw);
    migrated.bundle.manifest.fileVersions['attributes.json'] = sha256Hex(raw);
    migrated.bundle.manifest.bundleHash = computeClassificationBundleHash(migrated.bundle.manifest);
    writeManifest(root, migrated.bundle.manifest);
    expect(() => loadClassificationConfigBundleV2Preview(root))
      .toThrowError(expect.objectContaining({ code: 'invalid_json' }));
  });

  it('rejects symlinked classification directories and focused files', () => {
    const fileRoot = tempRoot();
    writeV2(fileRoot);
    const mappingPath = path.join(classificationDir(fileRoot), 'mappings.json');
    const outside = path.join(fileRoot, 'outside.json');
    fs.renameSync(mappingPath, outside);
    fs.symlinkSync(outside, mappingPath);
    expect(() => loadClassificationConfigBundleV2Preview(fileRoot))
      .toThrowError(expect.objectContaining({ code: 'read_error' }));

    const dirRoot = tempRoot();
    const outsideDir = path.join(dirRoot, 'outside-classification');
    fs.mkdirSync(path.join(dirRoot, 'store'), { recursive: true });
    fs.mkdirSync(outsideDir);
    fs.symlinkSync(outsideDir, classificationDir(dirRoot));
    expect(() => loadClassificationConfig(dirRoot))
      .toThrowError(expect.objectContaining({ code: 'read_error' }));
  });

  it('rejects byte-level focused-file hash drift even when JSON semantics are unchanged', () => {
    const root = tempRoot();
    writeV2(root);
    const filePath = path.join(classificationDir(root), 'product-types.json');
    fs.appendFileSync(filePath, ' ');
    expect(() => loadClassificationConfigBundleV2Preview(root))
      .toThrowError(expect.objectContaining({ code: 'hash_mismatch' }));
  });

  it('rejects a hash-valid but semantically dangling v2 bundle', () => {
    const root = tempRoot();
    writeV2(root, v1Config({
      productTypes: [{
        id: 'dog-food',
        name: 'Dog Food',
        description: null,
        attributeProfileId: 'missing-profile',
        oldIdAliases: [],
      }],
    }));
    expect(() => loadClassificationConfigBundleV2Preview(root)).toThrowError(expect.objectContaining({ code: 'invalid_config' }));
  });

  it('rejects v1 sensitive-data filtering disabled at write, load, and migration time', () => {
    const unsafe = v1Config();
    (unsafe.dataSharing as { sensitiveDataFiltering: boolean }).sensitiveDataFiltering = false;
    expect(LegacyClassificationConfigV1Schema.safeParse(unsafe).success).toBe(false);
    expect(() => migrateClassificationConfigV1(unsafe)).toThrow();
    expect(() => saveClassificationConfig(tempRoot(), unsafe))
      .toThrowError(expect.objectContaining({ code: 'invalid_config' }));
  });

  it('binds the migration findings digest and keeps flag-flipped migrated bundles activation-blocked', () => {
    const root = tempRoot();
    const migrated = writeV2(root);
    if (migrated.bundle.manifest.migrationProvenance.kind !== 'migrated_v1') {
      throw new Error('Expected migrated provenance.');
    }
    expect(computeMigrationFindingsDigest(migrated.findings))
      .toBe(migrated.bundle.manifest.migrationProvenance.findingsDigest);
    expect(migrated.bundle.manifest.migrationProvenance).toEqual(expect.objectContaining({
      sourceSchemaVersion: 1,
      findingCount: migrated.findings.length,
    }));

    migrated.bundle.manifest.activeRevision = 'bay-state-v2';
    migrated.bundle.manifest.lifecycle = 'active';
    migrated.bundle.manifest.hasUnresolvedSafetyFindings = false;
    migrated.bundle.manifest.sourceCatalogCommit = 'a'.repeat(40);
    migrated.bundle.manifest.catalogEvidenceHash = 'b'.repeat(64);
    migrated.bundle.manifest.bundleHash = computeClassificationBundleHash(migrated.bundle.manifest);
    writeManifest(root, migrated.bundle.manifest);
    expect(() => loadActiveClassificationConfigBundleV2(root, {
      catalogFields: ['ProductField16'],
      verifyCatalogEvidence: () => ({ verified: true as const }),
    })).toThrowError(expect.objectContaining({ code: 'invalid_config' }));

    // Replacing only manifest provenance and recomputing its self-hash cannot
    // clean the migrated origin still bound into every focused payload.
    migrated.bundle.manifest.migrationProvenance = { kind: 'reviewed_generation' };
    migrated.bundle.manifest.bundleHash = computeClassificationBundleHash(migrated.bundle.manifest);
    writeManifest(root, migrated.bundle.manifest);
    try {
      loadActiveClassificationConfigBundleV2(root, {
        catalogFields: ['ProductField16'],
        verifyCatalogEvidence: () => ({ verified: true as const }),
      });
      throw new Error('expected manifest-only provenance stripping to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ClassificationConfigLoadError);
      expect((error as ClassificationConfigLoadError).code).toBe('invalid_config');
      expect((error as ClassificationConfigLoadError).details).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'bundle_origin_mismatch' }),
        expect.objectContaining({ code: 'unresolved_migration_provenance' }),
      ]));
    }
  });

  it('refuses to write through symlinked or non-regular classification paths and preserves typed presence errors', () => {
    const root = tempRoot();
    saveClassificationConfig(root, v1Config());
    const dir = classificationDir(root);

    const outside = path.join(root, 'outside.json');
    fs.renameSync(path.join(dir, 'brands.json'), outside);
    fs.symlinkSync(outside, path.join(dir, 'brands.json'));
    expect(() => saveClassificationConfig(root, v1Config()))
      .toThrowError(expect.objectContaining({ code: 'write_error' }));
    fs.rmSync(path.join(dir, 'brands.json'));
    fs.renameSync(outside, path.join(dir, 'brands.json'));

    const manifestPath = path.join(dir, 'manifest.json');
    const outsideManifest = path.join(root, 'outside-manifest.json');
    fs.renameSync(manifestPath, outsideManifest);
    fs.symlinkSync(outsideManifest, manifestPath);
    expect(() => hasClassificationConfig(root))
      .toThrowError(expect.objectContaining({ code: 'read_error' }));
    fs.rmSync(manifestPath);
    fs.renameSync(outsideManifest, manifestPath);
    expect(hasClassificationConfig(root)).toBe(true);

    const outsideDir = path.join(root, 'outside-classification');
    fs.renameSync(dir, outsideDir);
    fs.symlinkSync(outsideDir, dir);
    expect(() => saveClassificationConfig(root, v1Config()))
      .toThrowError(expect.objectContaining({ code: 'read_error' }));

    const presenceRoot = tempRoot();
    const externalStore = tempRoot();
    fs.mkdirSync(path.join(externalStore, 'classification'));
    fs.writeFileSync(path.join(externalStore, 'classification', 'manifest.json'), '{}');
    fs.symlinkSync(externalStore, path.join(presenceRoot, 'store'));
    expect(() => hasClassificationConfig(presenceRoot))
      .toThrowError(expect.objectContaining({ code: 'read_error' }));

    const writeRoot = tempRoot();
    const emptyExternalStore = tempRoot();
    fs.symlinkSync(emptyExternalStore, path.join(writeRoot, 'store'));
    expect(() => saveClassificationConfig(writeRoot, v1Config()))
      .toThrowError(expect.objectContaining({ code: 'read_error' }));
    expect(fs.existsSync(path.join(emptyExternalStore, 'classification'))).toBe(false);
  });

  describe('workspace overlay policy loading (issue #296)', () => {
    function setupV5Workspace(): string {
      const root = tempRoot();
      const dir = classificationDir(root);
      fs.mkdirSync(dir, { recursive: true });
      writeWorkspaceState(root, { activeTaxonomyRevision: V5_TAXONOMY_REVISION, updatedAt: '2026-09-01T12:00:00.000Z' });
      const manifest = {
        schemaVersion: 2,
        compatibilityVersion: 2,
        createdAt: '2026-09-01T12:00:00.000Z',
        updatedAt: '2026-09-01T12:00:00.000Z',
        activeRevision: V5_TAXONOMY_REVISION,
        lifecycle: 'active',
        bundleHash: '0000000000000000000000000000000000000000000000000000000000000000',
        hasUnresolvedSafetyFindings: false,
        migrationProvenance: { kind: 'reviewed_generation' },
        sourceCatalogCommit: null,
        catalogEvidenceHash: null,
        fileVersions: {},
      };
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      return root;
    }

    it('overlays valid workspace model-policies.json and data-sharing.json onto pinned release', () => {
      const root = setupV5Workspace();
      const dir = classificationDir(root);

      const customPolicy = {
        schemaVersion: 2,
        bundleOrigin: { kind: 'reviewed_generation' },
        policy: {
          defaultProvider: 'ollama',
          defaultModel: 'qwen2.5:7b',
          providerLocalities: { ollama: 'local' },
          stageOverrides: {
            primary_product_type_proposal: {
              provider: 'ollama',
              model: 'qwen2.5:14b',
              fallbackProvider: null,
              fallbackModel: null,
            },
          },
          imageDataSharing: 'local_only',
          textDataSharing: 'local_only',
          mlFeatures: {
            productionRetrieval: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
            pageReranking: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
            confidenceCalibration: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
            productionEmbeddings: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
          },
        },
      };

      const customDataSharing = {
        schemaVersion: 2,
        bundleOrigin: { kind: 'reviewed_generation' },
        policy: {
          imagePolicy: 'local_only',
          textPolicy: 'local_only',
          sensitiveDataFiltering: true,
          retentionDays: 60,
        },
      };

      fs.writeFileSync(path.join(dir, 'model-policies.json'), JSON.stringify(customPolicy, null, 2));
      fs.writeFileSync(path.join(dir, 'data-sharing.json'), JSON.stringify(customDataSharing, null, 2));

      const authority = loadRuntimeConfigAuthority(root);
      expect(authority.kind).toBe('v2');
      if (authority.kind !== 'v2') throw new Error('Expected v2 authority');

      expect(authority.bundle.modelPolicy.defaultModel).toBe('qwen2.5:7b');
      expect(authority.bundle.modelPolicy.stageOverrides.primary_product_type_proposal?.model).toBe('qwen2.5:14b');
      expect(authority.bundle.dataSharing.retentionDays).toBe(60);
    });

    it('fails closed when workspace model-policies.json is present but invalid JSON', () => {
      const root = setupV5Workspace();
      const dir = classificationDir(root);
      fs.writeFileSync(path.join(dir, 'model-policies.json'), '{"broken json');
      fs.writeFileSync(path.join(dir, 'data-sharing.json'), JSON.stringify({
        schemaVersion: 2,
        bundleOrigin: { kind: 'seed', name: 'bay-state' },
        policy: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
      }));

      expect(() => loadRuntimeConfigAuthority(root)).toThrowError(
        expect.objectContaining({ code: 'invalid_json' }),
      );
    });

    it('fails closed when workspace model-policies.json is present but schema-invalid', () => {
      const root = setupV5Workspace();
      const dir = classificationDir(root);
      fs.writeFileSync(path.join(dir, 'model-policies.json'), JSON.stringify({
        schemaVersion: 2,
        policy: { defaultProvider: 123 }, // invalid type
      }));
      fs.writeFileSync(path.join(dir, 'data-sharing.json'), JSON.stringify({
        schemaVersion: 2,
        bundleOrigin: { kind: 'seed', name: 'bay-state' },
        policy: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
      }));

      expect(() => loadRuntimeConfigAuthority(root)).toThrowError(
        expect.objectContaining({ code: 'invalid_config' }),
      );
    });

    it('fails closed when workspace data-sharing.json is present but schema-invalid', () => {
      const root = setupV5Workspace();
      const dir = classificationDir(root);
      fs.writeFileSync(path.join(dir, 'model-policies.json'), JSON.stringify({
        schemaVersion: 2,
        bundleOrigin: { kind: 'seed', name: 'bay-state' },
        policy: {
          defaultProvider: 'ollama',
          defaultModel: 'qwen2.5:7b',
          providerLocalities: { ollama: 'local' },
          stageOverrides: {},
          imageDataSharing: 'local_only',
          textDataSharing: 'local_only',
        },
      }));
      fs.writeFileSync(path.join(dir, 'data-sharing.json'), JSON.stringify({
        schemaVersion: 2,
        policy: { retentionDays: -5 }, // invalid retentionDays
      }));

      expect(() => loadRuntimeConfigAuthority(root)).toThrowError(
        expect.objectContaining({ code: 'invalid_config' }),
      );
    });

    it('fails closed when workspace overlay has mixed policy files (only one present)', () => {
      const root = setupV5Workspace();
      const dir = classificationDir(root);
      fs.writeFileSync(path.join(dir, 'model-policies.json'), JSON.stringify({
        schemaVersion: 2,
        bundleOrigin: { kind: 'seed', name: 'bay-state' },
        policy: {
          defaultProvider: 'ollama',
          defaultModel: 'qwen2.5:7b',
          providerLocalities: { ollama: 'local' },
          stageOverrides: {},
          imageDataSharing: 'local_only',
          textDataSharing: 'local_only',
        },
      }));
      // data-sharing.json NOT created

      expect(() => loadRuntimeConfigAuthority(root)).toThrowError(
        expect.objectContaining({ code: 'invalid_config' }),
      );
    });
  });
});
