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
  applyCurationTargetEdits,
  CurationTargetEditError,
} from '../../classification/curation-target-editor';
import {
  loadRuntimeConfigAuthority,
  createRuntimeActivationContext,
} from '../../classification/config-loader';
import { deriveCurationApplicability } from '../../classification/curation-applicability';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { sha256Hex } from '../../shared/stable-id';

const REVIEWED_FIELDS = [
  'ProductField4', 'ProductField8', 'ProductField16', 'ProductField17',
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
      observedProductCount: 1,
      distinctValueCount: 1,
      distinctValueHash: '0'.repeat(64),
      delimiterEvidence: [],
      parseFailures: [],
    })),
    pages: [],
  };
}

beforeAll(async () => {
  // P0 taxonomy freeze: this suite exercises the editor implementation, so
  // the freeze is explicitly lifted for the duration of the tests.
  setTaxonomyFreezeForTests(false);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'curation-target-editor-test-'));
  runGit(['init']);
  runGit(['config', 'user.name', 'Test']);
  runGit(['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(root, 'readme.md'), '# test');
  runGit(['add', '.']);
  runGit(['commit', '-m', 'initial']);

  const dbPath = path.join(root, 'test.db');
  initDb(dbPath);
  runMigrations();

  workspaceId = randomUUID();
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

  fs.mkdirSync(path.join(root, 'store', 'classification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'store', 'manifest.json'), JSON.stringify({ schemaVersion: 1 }), 'utf-8');
  fs.writeFileSync(
    path.join(root, 'store', 'classification', 'manifest.json'),
    JSON.stringify({ schemaVersion: 1, compatibilityVersion: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(root, 'store', 'field-registry.json'),
    JSON.stringify({ entries: [...REVIEWED_FIELDS].sort().map(xmlField => ({ xmlField })) }),
    'utf-8',
  );
  runGit(['add', '--', 'store/manifest.json', 'store/field-registry.json', 'store/classification/manifest.json']);
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
});

afterAll(() => {
  setTaxonomyFreezeForTests(true);
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('applyCurationTargetEdits (v2 surgical editor)', () => {
  it('toggles curation target enablement in the active v2 bundle without spurious health findings', () => {
    const ctxBefore = createRuntimeActivationContext(root, workspaceId);
    const authBefore = loadRuntimeConfigAuthority(root, ctxBefore);
    expect(authBefore.kind).toBe('v2');
    if (authBefore.kind !== 'v2') return;

    // Seed defaults: every product-field target ships enabled
    const crossSellBefore = authBefore.bundle.curationTargets.find(t => t.catalogField === 'ProductField32');
    expect(crossSellBefore).toBeDefined();
    expect(crossSellBefore?.enabled).toBe(true);

    // Disable via the surgical editor
    const disableResult = applyCurationTargetEdits(root, workspaceId, [
      {
        id: crossSellBefore!.id,
        kind: 'product_field',
        catalogField: 'ProductField32',
        enabled: false,
      },
    ]);
    expect(disableResult.bundleHash).toBeDefined();

    let authAfter = loadRuntimeConfigAuthority(root, createRuntimeActivationContext(root, workspaceId));
    expect(authAfter.kind).toBe('v2');
    if (authAfter.kind !== 'v2') return;
    const crossSellDisabled = authAfter.bundle.curationTargets.find(t => t.catalogField === 'ProductField32');
    expect(crossSellDisabled?.enabled).toBe(false);

    // Disabling a curation target is intentional choice; no spurious health findings are emitted
    const findings = deriveCurationApplicability(authAfter.bundle as never).findings;
    expect(findings.some(f => (f.details as any)?.catalogField === 'ProductField32')).toBe(false);

    // Re-enable: the target is enabled again
    applyCurationTargetEdits(root, workspaceId, [
      {
        id: crossSellBefore!.id,
        kind: 'product_field',
        catalogField: 'ProductField32',
        enabled: true,
      },
    ]);

    authAfter = loadRuntimeConfigAuthority(root, createRuntimeActivationContext(root, workspaceId));
    expect(authAfter.kind).toBe('v2');
    if (authAfter.kind !== 'v2') return;
    const crossSellReenabled = authAfter.bundle.curationTargets.find(t => t.catalogField === 'ProductField32');
    expect(crossSellReenabled?.enabled).toBe(true);
  });

  it('fails closed when attempting to add a target for an unmapped field', () => {
    expect(() => {
      applyCurationTargetEdits(root, workspaceId, [
        {
          kind: 'product_field',
          catalogField: 'ProductField999',
          enabled: true,
        },
      ]);
    }).toThrow(CurationTargetEditError);
  });
});
