import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { upsertRegistryEntry } from '../../db/repositories/field-registry-repo';
import { listMappingValidityFindings } from '../../db/repositories/mapping-validity-repo';
import { GitClient } from '../../git/git-client';
import { previewCandidate, activateBundle } from '../../classification/config-store';
import { generateCandidate } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import {
  loadRuntimeConfigAuthority,
  createRuntimeActivationContext,
} from '../../classification/config-loader';
import { bootstrapFromXml } from '../../server/services/sync-service';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { sha256Hex } from '../../shared/stable-id';
import type { Workspace } from '../../shared/types';

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

// The pull only contains ProductField16 + ProductField24 — both are mapped
// fields in the active bundle. A mapped field like ProductField26 is absent.
const XML = `<SHOP-SITE>
  <PRODUCTLIST>
    <Product>
      <SKU>D4-SYNC-1</SKU>
      <Name>D4 Sync Product</Name>
      <ProductField16>Purina</ProductField16>
      <ProductField24>Dog Food</ProductField24>
    </Product>
  </PRODUCTLIST>
</SHOP-SITE>`;

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

describe('mapping-validity findings on sync (D4, issue #31 commit 3)', () => {
  beforeAll(async () => {
    // P0 taxonomy freeze: this suite exercises activation, so the freeze is
    // explicitly lifted for the duration of the tests.
    setTaxonomyFreezeForTests(false);
    workspaceId = randomUUID();
    root = fs.mkdtempSync(path.join(os.tmpdir(), `mapping-validity-${workspaceId.slice(0, 8)}`));
    fs.mkdirSync(path.join(root, 'store', 'classification'), { recursive: true });
    fs.mkdirSync(path.join(root, 'products'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gitignore'), '', 'utf-8');

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

    // Seed R1 (authoritative field_registry) with the attested field set so
    // the sync's registry merge keeps R2 == REVIEWED_FIELDS (rows absent from
    // the pull are kept) and the live-field attestation stays satisfied.
    const now = new Date().toISOString();
    for (const xmlField of REVIEWED_FIELDS) {
      upsertRegistryEntry({
        id: randomUUID(),
        workspaceId,
        xmlField,
        label: xmlField,
        kind: 'custom',
        dataType: 'string',
        editable: true,
        required: false,
        uiGroup: 'Custom Fields',
        sampleValuesJson: null,
        createdAt: now,
        updatedAt: now,
      });
    }

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
  });

  afterAll(() => {
    setTaxonomyFreezeForTests(true);
    closeDb();
  });

  it('records field_present findings per mapped field and never writes isStale', () => {
    const result = bootstrapFromXml(
      { id: workspaceId, workspacePath: root, name: 'test' } as Workspace,
      XML,
      'xml_text',
    );
    expect(result.success).toBe(true);

    const authority = loadRuntimeConfigAuthority(root, createRuntimeActivationContext(root, workspaceId));
    if (authority.kind !== 'v2') {
      throw new Error('expected an active v2 authority');
    }
    const mappings = authority.bundle.attributeMappings;
    const findings = listMappingValidityFindings(workspaceId);

    // One finding per mapped field (latest observation semantics).
    expect(findings.length).toBe(mappings.length);

    for (const mapping of mappings) {
      const finding = findings.find(f => f.catalogField === mapping.catalogField);
      expect(finding).toBeDefined();
      if (mapping.catalogField === 'ProductField16' || mapping.catalogField === 'ProductField24') {
        // Present in the pull → field_present = 1.
        expect(finding!.fieldPresent).toBe(1);
      } else {
        // Mapped field absent from the pull → field_present = 0.
        expect(finding!.fieldPresent).toBe(0);
      }
      expect(finding!.detectedAt).toBeTruthy();
    }

    // ProductField26 is the canonical absent-field example (product-feature).
    expect(findings.find(f => f.catalogField === 'ProductField26')?.fieldPresent).toBe(0);
    expect(findings.find(f => f.catalogField === 'ProductField24')?.fieldPresent).toBe(1);

    // Sync writes findings ONLY — the active bundle's mappings are untouched
    // (no isStale mutation, no remapping).
    expect(mappings.every(m => m.isStale === false)).toBe(true);
    expect(mappings.find(m => m.catalogField === 'ProductField26')?.attributeId).toBe('product-feature');
  });
});
