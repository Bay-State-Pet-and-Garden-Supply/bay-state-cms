import fs from 'node:fs';
import path from 'node:path';
import { createRun, completeRun, getRun, getEvidenceByRun, getProposalsByRun, getStageResults } from '../../../db/repositories/classification-run-repo';
import { getDb } from '../../../db/connection';
import { findItemById } from '../../../db/repositories/onboarding-item-repo';
import { ClassificationManifestV2Schema } from '../../../shared/schemas/classification';
import { ListingRequirementSchema } from '../../../shared/schemas/item-evidence';
import { computeClassificationBundleHash } from '../../../classification/config-validation';
import { previewListingStandard } from '../../../onboarding/listing-standards';
import { acceptedEvidenceToClassificationEvidence, getCurrentItemEvidenceView, refreshItemEvidence } from '../../../onboarding/item-evidence';
import { submitManualEvidence, withdrawManualEvidence } from '../../../onboarding/manual-evidence-service';
import { seedCanonicalPromotionAuthority } from './seed-canonical-promotion-authority';
import { buildItemExecutionCurrentness, hashClassificationRunOutput, validateLiveItemExecutionCurrentness } from '../../../classification/item-execution-currentness';
import { getRuntimeSnapshotByHash } from '../../../classification/runtime-snapshot';
import { modelPolicyViewFromConfig } from '../../../onboarding/model-policy-snapshot';
import { activatePageImportFromRecords } from '../../../shopsite/page-import-service';
import { sha256Hex } from '../../../shared/stable-id';
const REQUIRED_DESCRIPTION = ListingRequirementSchema.parse({
  id: 'product-description',
  field: 'description',
  label: 'Product description',
  kind: 'field',
  required: true,
  exceptionEligible: false,
  allowedSourceRoles: ['operator_attested', 'distributor_record', 'manufacturer_official'],
  applicableWhen: null,
});
const REQUIRED_TITLE = ListingRequirementSchema.parse({
  id: 'product-title',
  field: 'title',
  label: 'Product title',
  kind: 'field',
  required: true,
  exceptionEligible: false,
  // Manufacturer-official covers extractor-path fixtures (rich extraction
  // with direct-source provenance); distributor_record covers sourcing
  // authority. Operator transcription remains the manual path.
  allowedSourceRoles: ['operator_attested', 'distributor_record', 'manufacturer_official'],
  applicableWhen: null,
});

/** Title+description standard for rerun/currentness parity tests (T4). The shared workspace default stays title-only. */
export function previewTitleDescriptionStandard(workspacePath: string): void {
  const directory = path.join(workspacePath, 'store', 'classification');
  const preview = previewListingStandard({
    workspacePath,
    actor: 'listing-evidence-test',
    standardId: 'listing-evidence-test-standard',
    categoryId: 'dog-food',
    productTypeId: 'dog-food-dry',
    requirements: [REQUIRED_TITLE, REQUIRED_DESCRIPTION],
  });
  const current = JSON.parse(fs.readFileSync(path.join(directory, 'listing-completeness.json'), 'utf8')) as {
    recordVersion: number; standards: Array<Record<string, unknown>>;
  };
  const next = current.standards.filter((s) => !(
    (s as { categoryId?: string }).categoryId === 'dog-food' &&
    (s as { productTypeId?: string }).productTypeId === 'dog-food-dry'
  ));
  next.push(preview.standard as unknown as Record<string, unknown>);
  fs.writeFileSync(
    path.join(directory, 'listing-completeness.json'),
    `${JSON.stringify({ recordVersion: 1, standards: next }, null, 2)}\n`,
  );
}

 /** Install a strictly versioned active manifest and its approved listing standard. */
 export function prepareListingEvidenceWorkspace(workspacePath: string, workspaceId: string): void {
  const directory = path.join(workspacePath, 'store', 'classification');
  fs.mkdirSync(directory, { recursive: true });
  const now = new Date().toISOString();
  const manifestWithoutHash = {
    schemaVersion: 2 as const,
    compatibilityVersion: 2 as const,
    createdAt: now,
    updatedAt: now,
    activeRevision: 'listing-evidence-test-active',
    lifecycle: 'active' as const,
    hasUnresolvedSafetyFindings: false,
    migrationProvenance: { kind: 'reviewed_generation' as const },
    sourceCatalogCommit: 'a'.repeat(40),
    catalogEvidenceHash: 'b'.repeat(64),
    fileVersions: {},
  };
  const manifest = ClassificationManifestV2Schema.parse({
    ...manifestWithoutHash,
    bundleHash: computeClassificationBundleHash(manifestWithoutHash),
  });
  fs.writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const dogPreview = previewListingStandard({
    workspacePath,
    actor: 'listing-evidence-test',
    standardId: 'listing-evidence-test-standard',
    categoryId: 'dog-food',
    productTypeId: 'dog-food-dry',
    requirements: [REQUIRED_TITLE],
  });
  // The cat-food pair retains its title-only contract.
  const catPreview = previewListingStandard({
    workspacePath,
    actor: 'listing-evidence-test',
    standardId: 'listing-evidence-test-standard',
    categoryId: 'cat-food',
    productTypeId: 'cat-food-wet',
    requirements: [REQUIRED_TITLE],
  });
  const wetPreview = previewListingStandard({
    workspacePath,
    actor: 'listing-evidence-test',
    standardId: 'listing-evidence-test-standard',
    categoryId: 'dog-food',
    productTypeId: 'dog-food-wet',
    requirements: [REQUIRED_TITLE],
  });
  // The conflicting-pair fixture resolves a wild-bird pair via the reviewed
  // target; same title-only contract.
  const birdPreview = previewListingStandard({
    workspacePath,
    actor: 'listing-evidence-test',
    standardId: 'listing-evidence-test-standard',
    categoryId: 'wild-bird',
    productTypeId: 'bird-food',
    requirements: [REQUIRED_TITLE],
  });
  fs.writeFileSync(
    path.join(directory, 'listing-completeness.json'),
    `${JSON.stringify({ recordVersion: 1, standards: [dogPreview.standard, catPreview.standard, wetPreview.standard, birdPreview.standard] }, null, 2)}\n`,
  );

  activatePageImportFromRecords({
    workspaceId,
    sourceHash: sha256Hex('listing-evidence-test-pages-v1'),
    parserFormatVersion: 'pages-xml-1',
    records: [{
      identity: { kind: 'exported_guid', key: 'listing-evidence-test-dog-food', status: 'verified' },
      name: 'QA/test-only dog-food category',
      parentRef: null,
      availability: 'available',
    }],
    activatedBy: 'listing-evidence-test',
  });
}

/** Bind a test item to accepted, per-SKU evidence and a V2 classified run. */
export function seedListingEvidenceItem(input: {
  workspaceId: string;
  workspacePath: string;
  itemId: string;
  sku: string;
  description?: string;
  weight?: string;
  extractionData?: Record<string, unknown>;
}): { runId: string; evidenceIds: string[]; titleEvidenceId: string } {
  const item = findItemById(input.itemId);
  if (!item) throw new Error(`Listing-evidence fixture item ${input.itemId} is missing.`);
  const db = getDb();
  db.query(
    `UPDATE onboarding_items
     SET stage = 'extraction', stage_status = 'failed', error_message = ?,
         extraction_data_json = ?, curation_data_json = NULL
     WHERE id = ?`,
  ).run(
    'No extractor profile for listing-evidence-test.example.com',
    input.extractionData ? JSON.stringify(input.extractionData) : null,
    input.itemId,
  );
  const submitted = submitManualEvidence(
    {
      itemId: input.itemId,
      workspaceId: input.workspaceId,
      operatorId: 'listing-evidence-test-operator',
      title: item.name,
      brand: item.brandHint,
      ...(input.description ? { description: input.description } : {}),
      ...(input.weight ? { weight: input.weight } : {}),
      attestation: { noFamilyInheritance: true, perSkuVerified: true, rightsAttested: true },
    },
    { findProfileByDomain: () => null },
  );
  if (!submitted.ok) throw new Error(`Listing-evidence fixture manual authority failed: ${submitted.code}`);
  const refreshed = refreshItemEvidence(input.workspaceId, input.itemId);
  if (!refreshed.evidence) throw new Error(`Listing-evidence fixture snapshot failed: ${refreshed.status}`);

  // Listing behavior fixtures need the item in its normal review state; the
  // accepted snapshot is source-bound to identity, not this workflow stage.
  db.query(`UPDATE onboarding_items SET stage = 'review', stage_status = 'pending', error_message = NULL, curation_data_json = ? WHERE id = ?`)
    .run(JSON.stringify({ suggestedPages: ['QA/test-only dog-food category'] }), input.itemId);

  const run = createRun(input.workspaceId, input.sku, null, null, input.itemId);
  const runtime = seedCanonicalPromotionAuthority({
    db,
    workspaceId: input.workspaceId,
    workspacePath: input.workspacePath,
    sku: input.sku,
    runId: run.id,
  });
  db.query('UPDATE classification_runs SET config_snapshot_id = ? WHERE id = ?').run(runtime.id, run.id);
  completeRun(run.id, 'completed');

  db.query('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?').run(
    JSON.stringify({ suggestedPages: ['QA/test-only dog-food category'], classificationRunId: run.id }),
    input.itemId,
  );
  const current = getCurrentItemEvidenceView(input.workspaceId, input.itemId);
  if (!current.evidence) throw new Error(`Listing-evidence fixture accepted snapshot is not current: ${current.status}`);
  const acceptedRows = acceptedEvidenceToClassificationEvidence(current.evidence, run.id);
  const titleEvidenceId = acceptedRows.find((row) => row.sourceField === 'title')?.id;
  if (!titleEvidenceId) throw new Error('Listing-evidence fixture accepted snapshot contains no title fact.');
  const now = new Date().toISOString();
  for (const row of acceptedRows) {
    db.query(
      `INSERT INTO classification_evidence
       (id, run_id, product_sku, stage_name, source, reliability, source_url, source_field, snippet, value_json, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id, run.id, input.sku, row.stageName, row.source, row.reliability, row.sourceUrl,
      row.sourceField, row.snippet, JSON.stringify(row.value), JSON.stringify(row.metadata), row.capturedAt || now,
    );
  }
  refreshListingEvidenceRunCurrentness(input.workspaceId, input.itemId, run.id);
  return { runId: run.id, evidenceIds: acceptedRows.map((row) => row.id), titleEvidenceId };
}

/** Recompute the currentness receipt from the seeded run's actual persisted output. */
export function refreshListingEvidenceRunCurrentness(workspaceId: string, itemId: string, runId: string): void {
  const current = getCurrentItemEvidenceView(workspaceId, itemId);
  const item = findItemById(itemId);
  const run = getRun(runId);
  const runtimeSnapshot = run?.configSnapshotHash ? getRuntimeSnapshotByHash(workspaceId, run.configSnapshotHash) : null;
  if (!current.evidence || !item || !run || !runtimeSnapshot || !run.configSnapshotId || !run.configSnapshotHash) {
    throw new Error(`Listing-evidence fixture execution inputs are incomplete: evidence=${!!current.evidence} item=${!!item} run=${!!run} snapshot=${!!runtimeSnapshot} snapId=${run?.configSnapshotId} snapHash=${run?.configSnapshotHash?.slice(0, 8)}`);
  }
  const classificationEvidence = getEvidenceByRun(runId);
  const proposals = getProposalsByRun(runId);
  const stageResults = getStageResults(runId).map(stage => ({
    stage_name: String(stage.stage_name),
    output_json: typeof stage.output_json === 'string' ? stage.output_json : null,
  }));
  const policy = modelPolicyViewFromConfig(runtimeSnapshot.modelPolicy, runtimeSnapshot.snapshotHash);
  if (!policy) throw new Error('Listing-evidence fixture model policy is unavailable.');
  const itemExecutionCurrentness = buildItemExecutionCurrentness({
    recordVersion: 1,
    inputRevision: item.inputRevision,
    evidenceId: current.evidence.id,
    evidenceRevision: current.evidence.revision,
    evidenceHash: current.evidence.evidenceHash,
    inputHash: current.evidence.inputHash,
    sourceStateHash: current.evidence.sourceStateHash,
    authorityHash: current.evidence.authorityHash,
    configSnapshotId: run.configSnapshotId,
    configSnapshotHash: run.configSnapshotHash,
    runtimeSnapshotId: null,
    runtimeSnapshotHash: runtimeSnapshot.snapshotHash,
    policyDigest: policy.policyDigest,
    classificationRunId: runId,
    classificationOutputHash: hashClassificationRunOutput({ evidence: classificationEvidence, proposals, stageResults }),
  });
  getDb().query('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?').run(
    JSON.stringify({ ...(item.curationData ?? {}), classificationRunId: runId, itemExecutionCurrentness }),
    itemId,
  );
  const persistedItem = findItemById(itemId);
  const persistedRun = getRun(runId);
  if (!persistedItem || !persistedRun || !validateLiveItemExecutionCurrentness({
    workspaceId,
    item: persistedItem,
    run: persistedRun,
    evidence: current.evidence,
    configSnapshotId: persistedRun.configSnapshotId,
    configSnapshotHash: persistedRun.configSnapshotHash ?? '',
    runtimeSnapshotHash: runtimeSnapshot.snapshotHash,
    policyDigest: policy.policyDigest,
    classificationEvidence,
    proposals,
    stageResults,
  })) throw new Error('Listing-evidence fixture execution receipt does not match live seeded run state.');
}


/** Replace an accepted manual snapshot with a newly attested revision. */
export function rotateListingEvidenceAuthority(workspaceId: string, itemId: string): void {
  const item = findItemById(itemId);
  if (!item) throw new Error(`Listing-evidence fixture item ${itemId} is missing.`);
  const withdrawn = withdrawManualEvidence({ workspaceId, itemId, operatorId: 'listing-evidence-test-operator' });
  if (!withdrawn.ok) throw new Error(`Listing-evidence fixture withdrawal failed: ${withdrawn.code}`);
  const submitted = submitManualEvidence(
    {
      itemId,
      workspaceId,
      operatorId: 'listing-evidence-test-operator',
      title: item.name,
      brand: item.brandHint,
      attestation: { noFamilyInheritance: true, perSkuVerified: true, rightsAttested: true },
    },
    { findProfileByDomain: () => null },
  );
  if (!submitted.ok) throw new Error(`Listing-evidence fixture resubmission failed: ${submitted.code}`);
  const refreshed = refreshItemEvidence(workspaceId, itemId);
  if (!refreshed.evidence) throw new Error(`Listing-evidence fixture rotated snapshot failed: ${refreshed.status}`);
}
