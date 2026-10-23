/**
 * Issue #352 — provisional classification drives attribute proposals in one pass (TDD).
 *
 * The provisional (pending, unreviewed) canonical pair proposal produced by
 * the type stage must unlock type-gated attribute proposals in the SAME
 * pipeline pass: flavor (explicit fact, applicable profile) proposes while
 * a missing pair withholds — without waiting for a reviewer to accept the
 * pair first. A member with NO pair (pending or accepted) still withholds
 * type-gated attributes (fail closed on truly unknown). Explicit universal
 * attributes can propose from own-SKU evidence without a pair, but cannot
 * authorize output into protected catalog fields.
 *
 * Public seam only (runPipeline with real stages over a lifecycle-ACTIVE v2
 * bundle built from a minimal seed; isolated persistence, deterministic
 * adapters); no live ShopSite mutation.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { runPipeline } from '../../classification/pipeline-runner';
import { primaryProductTypeStage } from '../../classification/stages/primary-product-type';
import { attributeApplicabilityStage } from '../../classification/stages/attribute-applicability';
import { productAttributeProposalsStage } from '../../classification/stages/attribute-proposals';
import { buildRuntimeSnapshot, persistRuntimeSnapshot } from '../../classification/runtime-snapshot';
import { generateCandidate, buildFocusedFiles, type BayStateSeed } from '../../classification/config-generator';
import { ClassificationFocusedFileNames, ClassificationManifestV2Schema } from '../../shared/schemas/classification';
import { computeClassificationBundleHash } from '../../classification/config-validation';
import { canonicalJsonFileString, sha256Hex } from '../../shared/stable-id';
import { createRun as createRepositoryRun } from '../../db/repositories/classification-run-repo';
import { createRuntimeActivationContext, loadRuntimeConfigAuthority } from '../../classification/config-loader';
import { syncConfigToCache, upsertConfigSnapshot } from '../../db/repositories/classification-config-repo';
import { completeRun, getProposalsByRun, getStageResults } from '../../db/repositories/classification-run-repo';
import type { ClassificationConfigBundleV2 } from '../../shared/schemas/classification';
import type { ClassificationEvidence, ClassificationProposal } from '../../shared/types';
import type { CatalogEvidence } from '../../classification/catalog-evidence';

const WS_ID = 'ws-provisional-attr-seam';

const EVIDENCE: CatalogEvidence = {
  schemaVersion: 1,
  sourceTreeHash: '0'.repeat(64),
  productFileCount: 0,
  parseFailureCount: 0,
  parseFailures: [],
  fieldRegistry: { entryCount: 3, xmlFields: ['ProductField21', 'ProductField23', 'ProductField28'] },
  fields: [{ xmlField: 'ProductField21' } as any, { xmlField: 'ProductField23' } as any, { xmlField: 'ProductField28' } as any],
  pages: [],
};

function seedFixture(): BayStateSeed {
  return {
    name: 'Provisional Seam Seed',
    revision: 'test-v1',
    createdAt: '2026-08-01T12:00:00.000Z',
    categories: [
      { id: 'dog-food', name: 'Dog Food', description: null },
      { id: 'dog-toys', name: 'Dog Toys', description: null },
    ],
    productTypes: [
      { id: 'dog-food-dry', name: 'Dry Dog Food', description: 'Dry dog food (kibble).', categoryId: 'dog-food' },
      { id: 'dog-toy', name: 'Dog Toy', description: 'Dog toy for play.', categoryId: 'dog-toys' },
    ],
    attributes: [
      { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Chicken'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: 'Food', isUniversal: false },
      { id: 'material', name: 'Material', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Rubber'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: 'Toys', isUniversal: false },
      { id: 'health-benefits', name: 'Health Benefits', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Joint Support'], valueAliases: [], visualEvidenceEligibility: 'ineligible', isClaim: true, isCompositionAttribute: false, group: 'Health', isUniversal: false },
    ],
    profileTemplates: [
      { id: 'dog-profile', name: 'Dog', productTypeIds: ['dog-food-dry'], attributes: [
        { attributeId: 'flavor', required: false, cardinality: 'single' },
        { attributeId: 'health-benefits', required: false, cardinality: 'single' },
      ] },
      { id: 'toy-profile', name: 'Toy', productTypeIds: ['dog-toy'], attributes: [{ attributeId: 'material', required: false, cardinality: 'single' }] },
    ],
    mappings: [
      { id: 'flavor-map', attributeId: 'flavor', catalogField: 'ProductField23', serialization: { kind: 'scalar', prefix: '', suffix: '' } },
      { id: 'material-map', attributeId: 'material', catalogField: 'ProductField28', serialization: { kind: 'scalar', prefix: '', suffix: '' } },
      { id: 'health-map', attributeId: 'health-benefits', catalogField: 'ProductField21', serialization: { kind: 'scalar', prefix: '', suffix: '' } },
    ],
    curationTargets: [
      { id: 'pt', kind: 'product_type', label: 'Type', enabled: true, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: false, mandatory: false, sortOrder: 0 },
      { id: 'ft', kind: 'product_field', label: 'Flavor', enabled: true, selectionMode: 'single', attributeId: 'flavor', catalogField: 'ProductField23', optionSource: 'configured', required: false, mandatory: false, sortOrder: 1 },
      { id: 'mt', kind: 'product_field', label: 'Material', enabled: true, selectionMode: 'single', attributeId: 'material', catalogField: 'ProductField28', optionSource: 'configured', required: false, mandatory: false, sortOrder: 2 },
      { id: 'ht', kind: 'product_field', label: 'Health Benefits', enabled: false, selectionMode: 'single', attributeId: 'health-benefits', catalogField: 'ProductField21', optionSource: 'configured', required: false, mandatory: false, sortOrder: 3 },
    ],
    brands: [],
    guidance: [],
    modelPolicy: { defaultProvider: 'ollama', defaultModel: 'test-model', providerLocalities: { ollama: 'local' }, stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only', mlFeatures: { productionRetrieval: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null }, pageReranking: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null }, confidenceCalibration: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null }, productionEmbeddings: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null } } },
    dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
  } as unknown as BayStateSeed;
}

let workspacePath: string;

beforeEach(() => {
  setTaxonomyFreezeForTests(false);
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'provisional-attr-'));
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({ id: WS_ID, name: 'seam', workspacePath, gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });
  // Lifecycle-ACTIVE v2 bundle from the minimal seed (same helper shape as
  // pr9-acceptance writeActiveV2Bundle, trimmed to this seam's needs).
  const candidate = generateCandidate(seedFixture(), EVIDENCE);
  const bundle: any = candidate.bundle;
  const focusedFiles = buildFocusedFiles(bundle);
  const fileVersions = Object.fromEntries(
    ClassificationFocusedFileNames.map(fileName => [fileName, sha256Hex(focusedFiles[fileName])]),
  );
  const xmlFields = [...new Set(bundle.attributeMappings.map((mapping: any) => mapping.catalogField))];
  fs.writeFileSync(path.join(workspacePath, 'store', 'field-registry.json'), JSON.stringify({ entries: xmlFields.map(xmlField => ({ xmlField })) }));
  const artifactContent = JSON.stringify({ schemaVersion: 1, xmlFields });
  fs.writeFileSync(path.join(workspacePath, 'store', 'classification', 'catalog-evidence.json'), artifactContent);
  // Git-anchored workspace so sourceCatalogCommit verifies.
  execFileSync('git', ['init', '-b', 'main'], { cwd: workspacePath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspacePath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: workspacePath, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: workspacePath, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'test evidence'], { cwd: workspacePath, stdio: 'ignore' });
  const sourceCatalogCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspacePath, encoding: 'utf-8' }).trim();
  const manifestWithoutHash: any = {
    ...bundle.manifest,
    activeRevision: 'test-v1',
    lifecycle: 'active' as const,
    hasUnresolvedSafetyFindings: false,
    migrationProvenance: { kind: 'reviewed_generation' as const },
    sourceCatalogCommit,
    catalogEvidenceHash: sha256Hex(artifactContent),
    fileVersions,
  };
  const manifest = ClassificationManifestV2Schema.parse({
    ...manifestWithoutHash,
    bundleHash: computeClassificationBundleHash(manifestWithoutHash),
  });
  const dir = path.join(workspacePath, 'store', 'classification');
  fs.writeFileSync(path.join(dir, 'manifest.json'), canonicalJsonFileString(manifest));
  for (const [name, content] of Object.entries(focusedFiles)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  upsertConfigSnapshot(WS_ID, { ...bundle, manifest });
});

function evidence(
  id: string, runId: string, sku: string, field: string | null, value: string,
  attributeId: string | null = null, source: ClassificationEvidence['source'] = 'official_product_page',
): ClassificationEvidence {
  return {
    id, runId, stageName: 'evidence_extraction', productSku: sku,
    attributeId, source, reliability: 'high', sourceUrl: null,
    sourceField: field, snippet: value, value,
    metadata: {}, capturedAt: new Date().toISOString(),
  } as ClassificationEvidence;
}

async function runAttrPass(sku: string, texts: string[], options: {
  configure?: (bundle: ClassificationConfigBundleV2) => void;
  afterFreeze?: (bundle: ClassificationConfigBundleV2) => void;
  acceptedPair?: { categoryId: string; productTypeId: string };
  claimEvidence?: string;
  claimSource?: ClassificationEvidence['source'];
} = {}) {
  const authority = loadRuntimeConfigAuthority(workspacePath, createRuntimeActivationContext(workspacePath, WS_ID));
  if (authority.kind !== 'v2') throw new Error('expected active v2 authority');
  // Deliberately incomplete historical configurations are frozen fixtures,
  // not live authority edits or a bypass in the production stage.
  const bundle = structuredClone(authority.bundle);
  options.configure?.(bundle);
  const snapshot = buildRuntimeSnapshot({
    workspaceId: WS_ID, workspacePath, productSku: sku,
    authority: { ...authority, bundle },
    configSnapshotRef: { id: 'test-ref', hash: bundle.manifest.bundleHash, sourceCommit: null, createdAt: new Date().toISOString() },
    sourceProductHash: null,
  });
  const persisted = persistRuntimeSnapshot(snapshot);
  options.afterFreeze?.(bundle);
  const run = createRepositoryRun(WS_ID, sku, persisted.id, snapshot.snapshotHash, { sourceKind: 'catalog_product' });
  const runId = run.id;
  const ev = [
    ...texts.map((text, i) => evidence(`ev-${runId}-${i}`, runId, sku, 'description', text)),
    ...(options.claimEvidence
      ? [evidence(
          `ev-${runId}-claim`, runId, sku, 'description', options.claimEvidence,
          'health-benefits', options.claimSource ?? 'official_product_page',
        )]
      : []),
  ];
  // Seed input evidence under the run so fail-closed linkage passes.
  {
    const { getDb } = await import('../../db/connection');
    const db = getDb();
    const now = new Date().toISOString();
    for (const e of ev) {
      db.run(
        `INSERT INTO classification_evidence (id, run_id, onboarding_item_id, product_sku, stage_name, source, reliability, attribute_id, source_url, source_field, snippet, value_json, metadata_json, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        [e.id, runId, sku, e.stageName, e.source, e.reliability, e.attributeId, e.sourceField, e.snippet, JSON.stringify(e.value ?? null), JSON.stringify((e as any).metadata ?? {}), now],
      );
    }
  }
  const context: any = {
    workspacePath, workspaceId: WS_ID, runId,
    configSnapshotRef: snapshot.configSnapshotRef,
    snapshot,
  };
  // A historical accepted input may name individually configured members
  // whose combination is invalid. It must remain inspectable, not executable.
  const acceptedProposals: ClassificationProposal[] = options.acceptedPair ? [{
    id: randomUUID(), runId, productSku: sku, proposalType: 'product_classification',
    targetId: options.acceptedPair.productTypeId, proposedValue: options.acceptedPair,
    confidence: 1, status: 'accepted', isBulkAcceptable: false, isStale: false,
    stalenessReason: null, snapshotHash: snapshot.snapshotHash, evidenceIds: [],
    createdAt: new Date().toISOString(),
  }] : [];
  await runPipeline(
    [primaryProductTypeStage, attributeApplicabilityStage, productAttributeProposalsStage],
    context,
    { sku, evidence: ev, acceptedProposals, allProposals: acceptedProposals },
  );
  return { runId, proposals: getProposalsByRun(runId), stages: getStageResults(runId) };
}

describe('provisional classification drives attributes in one pass (issue #352)', () => {
  it('pending pair proposal unlocks the applicable flavor attribute in the same pass', async () => {
    const result = await runAttrPass('SKU-FLAVOR', ['Dry Dog Food chicken kibble, flavor Chicken']);
    const pair = result.proposals.find(p => p.proposalType === 'product_classification');
    expect(pair).toBeDefined();
    expect(pair!.status).toBe('pending');
    const flavor = result.proposals.find(p => p.proposalType === 'field_assignment' && p.targetId === 'flavor');
    expect(flavor).toBeDefined();
  });

  it('requires eligible direct product wording for claims and preserves independent supported attributes', async () => {
    const configureClaim = (bundle: ClassificationConfigBundleV2) => {
      bundle.curationTargets.find(target => target.attributeId === 'health-benefits')!.enabled = true;
    };
    const supported = await runAttrPass('SKU-CLAIM-SUPPORTED', [
      'Dry Dog Food chicken kibble, flavor Chicken, supports healthy joints with Joint Support.',
    ], { configure: configureClaim, claimEvidence: 'Joint Support' });
    const health = supported.proposals.find(proposal =>
      proposal.proposalType === 'field_assignment' && proposal.targetId === 'health-benefits',
    );
    expect(health?.proposedValue).toBe('Joint Support');
    expect(supported.proposals.some(proposal =>
      proposal.proposalType === 'field_assignment' && proposal.targetId === 'flavor' && proposal.proposedValue === 'Chicken',
    )).toBe(true);

    await expect(runAttrPass('SKU-CLAIM-UNSUPPORTED', [
      'Dry Dog Food chicken kibble, flavor Chicken.',
    ], {
      configure: configureClaim,
      claimEvidence: 'Joint Support',
      claimSource: 'third_party_page',
    })).rejects.toThrow(/claim_unapproved_source/);
  });


  it('allows configured universal attributes without a pair but refuses protected field ownership', async () => {
    const result = await runAttrPass('SKU-UNIVERSAL', ['flavor Chicken, material Rubber'], {
      configure(bundle) {
        bundle.curationTargets.find(target => target.kind === 'product_type')!.enabled = false;
        for (const attribute of bundle.attributes) attribute.isUniversal = true;
        bundle.attributeMappings.find(mapping => mapping.attributeId === 'material')!.catalogField = 'ProductField16';
        bundle.curationTargets.find(target => target.attributeId === 'material')!.catalogField = 'ProductField16';
      },
    });

    expect(result.proposals.find(proposal => proposal.proposalType === 'product_classification')).toBeUndefined();
    expect(result.proposals.filter(proposal => proposal.proposalType === 'field_assignment').map(proposal => ({
      targetId: proposal.targetId, proposedValue: proposal.proposedValue, status: proposal.status,
    }))).toEqual([{ targetId: 'flavor', proposedValue: 'Chicken', status: 'pending' }]);
  });

  it('keeps food and non-food memberships separate in the same provisional pass', async () => {
    const food = await runAttrPass('SKU-FOOD', ['Dry Dog Food chicken kibble, flavor Chicken, material Rubber']);
    expect(food.proposals.find(p => p.proposalType === 'field_assignment' && p.targetId === 'flavor')?.proposedValue).toBe('Chicken');
    expect(food.proposals.some(p => p.proposalType === 'field_assignment' && p.targetId === 'material')).toBe(false);

    const toy = await runAttrPass('SKU-TOY', ['Dog Toy for play, material Rubber, flavor Chicken']);
    expect(toy.proposals.find(p => p.proposalType === 'product_classification')?.proposedValue).toMatchObject({ categoryId: 'dog-toys', productTypeId: 'dog-toy' });
    expect(toy.proposals.find(p => p.proposalType === 'field_assignment' && p.targetId === 'material')?.proposedValue).toBe('Rubber');
    expect(toy.proposals.some(p => p.proposalType === 'field_assignment' && p.targetId === 'flavor')).toBe(false);
  });

  it.each(['null', 'empty'] as const)('respects an intentionally %s declared profile', async kind => {
    const result = await runAttrPass(`SKU-EMPTY-${kind}`, ['Dry Dog Food chicken kibble, flavor Chicken'], {
      configure(bundle) {
        const type = bundle.productTypes.find(type => type.id === 'dog-food-dry')!;
        bundle.attributes.find(attribute => attribute.id === 'flavor')!.isUniversal = true;
        if (kind === 'null') type.attributeProfileId = null;
        else bundle.attributeProfiles.find(profile => profile.id === type.attributeProfileId)!.attributes = [];
      },
    });
    expect(result.proposals.filter(p => p.proposalType === 'field_assignment').map(proposal => proposal.targetId)).toEqual(['flavor']);
    const applicability = result.stages.find(stage => stage.stage_name === 'attribute_applicability')!;
    expect(applicability.status).toBe('succeeded');
    expect(JSON.parse(applicability.output_json).metadata.profileStatus).toBe('ready');
  });

  it.each(['missing declaration', 'missing profile', 'unknown category', 'ambiguous type'] as const)('attributes a %s configuration gap instead of admitting all fields', async kind => {
    const result = await runAttrPass(`SKU-GAP-${kind}`, ['Dry Dog Food chicken kibble, flavor Chicken, material Rubber'], {
      configure(bundle) {
        const type = bundle.productTypes.find(type => type.id === 'dog-food-dry')!;
        if (kind === 'missing declaration') Reflect.deleteProperty(type, 'attributeProfileId');
        else if (kind === 'missing profile') type.attributeProfileId = 'absent-profile';
        else if (kind === 'unknown category') type.categoryId = 'absent-category';
        else bundle.productTypes.push({ ...type, categoryId: 'dog-toys' });
      },
    });
    expect(result.proposals.filter(p => p.proposalType === 'field_assignment')).toHaveLength(0);
    const gap = result.proposals.find(p => p.proposalType === 'reviewable_abstention' && p.targetId === 'attribute_applicability');
    expect(gap).toBeDefined();
    expect(String((gap!.proposedValue as { reason: string }).reason)).toMatch(/frozen|Category|Profile|mapping/i);
  });

  it('does not let universal attributes conceal a missing selected profile', async () => {
    const result = await runAttrPass('SKU-UNIVERSAL-PROFILE-GAP', ['Dry Dog Food chicken kibble, flavor Chicken'], {
      configure(bundle) {
        bundle.productTypes.find(type => type.id === 'dog-food-dry')!.attributeProfileId = 'absent-profile';
        bundle.attributes.find(attribute => attribute.id === 'flavor')!.isUniversal = true;
      },
    });
    expect(result.proposals.filter(proposal => proposal.proposalType === 'field_assignment')).toHaveLength(0);
    const gap = result.proposals.find(proposal =>
      proposal.proposalType === 'reviewable_abstention' && proposal.targetId === 'attribute_applicability',
    );
    expect(String((gap?.proposedValue as { reason?: string } | undefined)?.reason)).toMatch(/missing or invalid Attribute Profile/i);
  });

  it('rejects an invalid canonical combination even when both members are configured', async () => {
    const result = await runAttrPass('SKU-INVALID-PAIR', ['Dry Dog Food chicken kibble, flavor Chicken, material Rubber'], {
      acceptedPair: { categoryId: 'dog-toys', productTypeId: 'dog-food-dry' },
    });
    expect(result.proposals.filter(p => p.proposalType === 'field_assignment')).toHaveLength(0);
    const gap = result.proposals.find(p => p.proposalType === 'reviewable_abstention' && p.targetId === 'attribute_applicability');
    expect(gap?.proposedValue).toMatchObject({
      reason: expect.stringContaining('not an approved pair'),
    });
  });

  it('withholds an optional attribute whose configured applicability is unknown', async () => {
    const result = await runAttrPass('SKU-OPTIONAL', ['Dog Toy for play, material Rubber'], {
      configure(bundle) {
        const type = bundle.productTypes.find(type => type.id === 'dog-toy')!;
        bundle.attributeProfiles.find(profile => profile.id === type.attributeProfileId)!.attributes[0]!.applicabilityConditions = [
          { operator: 'equals', attributeId: 'flavor', value: 'Chicken', factSource: 'accepted_reviewed' },
        ];
      },
    });
    expect(result.proposals.some(p => p.proposalType === 'field_assignment' && p.targetId === 'material')).toBe(false);
    const applicability = result.stages.find(stage => stage.stage_name === 'attribute_applicability')!;
    expect(JSON.parse(applicability.output_json).metadata.applicability).toContainEqual({
      attributeId: 'material', state: 'unknown', reason: 'Applicability condition cannot be decided from accepted/reviewed facts.',
    });
  });

  it('does not un-gate profile attributes when the type target is disabled', async () => {
    const result = await runAttrPass('SKU-DISABLED-TYPE', ['flavor Chicken, material Rubber'], {
      configure(bundle) {
        bundle.curationTargets.find(target => target.kind === 'product_type')!.enabled = false;
      },
    });
    expect(result.proposals.filter(p => p.proposalType === 'field_assignment')).toHaveLength(0);
    expect(result.proposals.find(p => p.proposalType === 'reviewable_abstention' && p.targetId === 'attribute_applicability')?.proposedValue).toMatchObject({
      reason: expect.stringContaining('No complete own-SKU Product Classification'),
    });
  });

  it('retains compatible own-SKU reviewed precedence without sharing it with another SKU', async () => {
    const { submitProposalDecisions } = await import('../../classification/proposal-review-service');
    const first = await runAttrPass('SKU-REVIEWED', ['Dry Dog Food chicken kibble, flavor Chicken']);
    const pair = first.proposals.find(p => p.proposalType === 'product_classification')!;
    completeRun(first.runId, 'completed');
    const reviewed = submitProposalDecisions({
      workspaceId: WS_ID, productSku: 'SKU-REVIEWED', runId: first.runId, sourceKind: 'catalog_product',
      decisions: [{ proposalId: pair.id, decision: 'accepted' }],
    });
    if (!reviewed.ok) throw new Error(reviewed.reason ?? reviewed.code);

    const own = await runAttrPass('SKU-REVIEWED', ['Dog Toy for play, material Rubber, flavor Chicken']);
    expect(own.proposals.find(p => p.proposalType === 'field_assignment' && p.targetId === 'flavor')?.proposedValue).toBe('Chicken');
    expect(own.proposals.some(p => p.proposalType === 'field_assignment' && p.targetId === 'material')).toBe(false);
    const ownApplicability = own.stages.find(stage => stage.stage_name === 'attribute_applicability')!;
    expect(JSON.parse(ownApplicability.output_json).metadata.effectiveTypeSource).toBe('reviewed');

    const other = await runAttrPass('SKU-SEPARATE', ['Dog Toy for play, material Rubber, flavor Chicken']);
    expect(other.proposals.find(p => p.proposalType === 'field_assignment' && p.targetId === 'material')?.proposedValue).toBe('Rubber');
    expect(other.proposals.some(p => p.proposalType === 'field_assignment' && p.targetId === 'flavor')).toBe(false);
  });

  it('uses the frozen profile and controlled options after the mutable cache changes', async () => {
    const result = await runAttrPass('SKU-FROZEN', ['Dry Dog Food chicken kibble, flavor Chicken'], {
      afterFreeze(bundle) {
        const changed = structuredClone(bundle);
        changed.attributeProfiles.forEach(profile => { profile.attributes = []; });
        changed.attributes.find(attribute => attribute.id === 'flavor')!.allowedValues = ['Beef'];
        syncConfigToCache(WS_ID, changed as any);
      },
    });
    expect(result.proposals.find(p => p.proposalType === 'field_assignment' && p.targetId === 'flavor')?.proposedValue).toBe('Chicken');
  });

  it('no pair at all withholds type-gated attributes (fail closed)', async () => {
    const result = await runAttrPass('SKU-NONE', []);
    expect(result.proposals.find(p => p.proposalType === 'product_classification')).toBeUndefined();
    expect(result.proposals.filter(p => p.proposalType === 'field_assignment')).toHaveLength(0);
  });
});

describe('provisional first pass flows without a redundant second decision (issues #352 + #354)', () => {
  it('accepting the unchanged provisional pair needs no second pair decision; rejecting it stales first-pass dependents', async () => {
    const sku = 'SKU-FIRST-PASS';
    const { submitProposalDecisions } = await import('../../classification/proposal-review-service');
    const { getPendingRefreshCount } = await import('../../db/repositories/classification-refresh-repo');

    // First pass: provisional pair + dependent flavor proposal, same run, persisted.
    const pass = await runAttrPass(sku, ['Dry Dog Food chicken kibble, flavor Chicken']);
    const pair = pass.proposals.find(p => p.proposalType === 'product_classification');
    if (!pair) throw new Error('first pass produced no provisional pair');
    const flavor = pass.proposals.find(p => p.proposalType === 'field_assignment' && p.targetId === 'flavor');
    if (!flavor) throw new Error('first pass produced no dependent flavor proposal');
    const runId = (pair as { runId: string }).runId;
    completeRun(runId, 'completed');

    // Accept the UNCHANGED provisional pair plus its first-pass dependent in
    // one request: no redundant second pair decision is forced.
    const accept = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: pair.id, decision: 'accepted' },
        { proposalId: flavor.id, decision: 'accepted' },
      ],
    });
    if (!accept.ok) throw new Error(`unchanged accept failed: ${accept.reason ?? accept.code}`);
    expect(accept.refreshRequired).toBe(false);
    const afterAccept = getProposalsByRun(runId);
    expect(afterAccept.find(p => p.id === flavor.id)?.status).toBe('accepted');
    expect(getPendingRefreshCount(WS_ID)).toBe(0);

    // Reject the pair: the first-pass dependent stales and a refresh is
    // queued for new review — invalidation before application (#354). (A
    // same-value re-accept is correctly a no-op and would not stale.)
    const pairDecisionId = accept.decisions.find(d => d.proposalId === pair.id)?.id;
    if (!pairDecisionId) throw new Error('pair decision id missing');
    const correct = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId, sourceKind: 'catalog_product',
      decisions: [{ proposalId: pair.id, decision: 'rejected', expectedRevisionId: pairDecisionId }],
    });
    expect(correct.ok).toBe(true);
    const afterCorrect = getProposalsByRun(runId);
    expect(afterCorrect.find(p => p.id === flavor.id)?.status).toBe('stale');
    // A rejection clears the pair (no corrected pair to refresh from), so no
    // dependent refresh is queued; a CHANGED pair (different type) would queue
    // one — covered by the #354 readiness-invalidation seam.
    expect(getPendingRefreshCount(WS_ID)).toBe(0);
  });
});
