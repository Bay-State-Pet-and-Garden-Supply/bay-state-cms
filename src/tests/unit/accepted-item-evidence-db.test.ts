import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { Hono } from 'hono';
import { closeDb, getDb, initDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  appendAcceptedItemEvidenceSnapshot,
  getCurrentItemEvidence,
  getItemEvidenceSnapshot,
  installAcceptedItemEvidenceSchema,
} from '../../db/repositories/accepted-item-evidence-repo';
import { installManualEvidenceIdentityBindingSchema } from '../../db/repositories/onboarding-manual-evidence-repo';
import { insertExtraction } from '../../db/repositories/onboarding-extraction-repo';
import { upsertBrandSite } from '../../db/repositories/brand-site-repo';
import { proposePageCandidate, recordOfficialPageDecision } from '../../db/repositories/official-page-decision-repo';
import { insertItems, completeSourcingWithDecision, updateItemStageStatus } from '../../db/repositories/onboarding-item-repo';
import { startSourcingGeneration, insertEvidenceAttempt } from '../../db/repositories/onboarding-evidence-repo';
import { recordAcceptances } from '../../db/repositories/onboarding-acceptance-repo';
import { createConnection, updateConnection } from '../../db/repositories/distributor-repo';
import { SOURCING_ENTRY_POLICY_VERSION } from '../../onboarding/sourcing/entry-policy';
import { buildDistributorRecordProjection } from '../../onboarding/sourcing/distributor-record-projection';
import { materializeDistributorRecordExtraction } from '../../onboarding/sourcing/distributor-record-materializer';
import { submitManualEvidence } from '../../onboarding/manual-evidence-service';
import {
  acceptedEvidenceToClassificationEvidence,
  admitItemEvidenceContribution,
  refreshItemEvidence,
} from '../../onboarding/item-evidence';
import acceptedItemEvidenceRoutes from '../../server/routes/accepted-item-evidence-routes';
import type { ItemEvidenceContributionInput } from '../../onboarding/item-evidence';
import type { SourcingDecisionV2 } from '../../shared/schemas/onboarding';

const TEST_DB = 'src/tests/unit/accepted-item-evidence-db-test.db';
const WORKSPACE = 'evidence-ws';
const OTHER_WORKSPACE = 'evidence-other-ws';
const BATCH = 'evidence-batch';
const OTHER_BATCH = 'evidence-other-batch';
const TITLE = 'NorthPaw Grain Free Cat Food Chicken 12 oz';
const noProfile = { findProfileByDomain: (_domain: string) => null };

function seedWorkspaceAndBatches(): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at)
     VALUES (?, 'evidence', '/tmp/evidence', '/tmp/evidence/.git', ?, ?)`,
  ).run(WORKSPACE, now, now);
  db.query(
    `INSERT INTO onboarding_batches (id, workspace_id, name, file_name, created_at, updated_at)
     VALUES (?, ?, 'evidence', 'evidence.csv', ?, ?)`,
  ).run(BATCH, WORKSPACE, now, now);
}

function seedItem(itemId: string, options: { batchId?: string; title?: string; sourceUrl?: string | null } = {}): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO onboarding_items
       (id, batch_id, upc, name, error_message, brand_hint, row_number, stage, stage_status, source_type, source_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'No extractor profile for northpaw.example.com', 'NorthPaw', 1, 'extraction', 'failed', 'official_page', ?, ?, ?)`,
  ).run(
    itemId,
    options.batchId ?? BATCH,
    `sku-${itemId}`,
    options.title ?? TITLE,
    options.sourceUrl ?? null,
    now,
    now,
  );
}

function contribution(input: Partial<ItemEvidenceContributionInput> & Pick<ItemEvidenceContributionInput, 'itemId' | 'sourceUrl' | 'contentType' | 'content' | 'facts'>): ItemEvidenceContributionInput {
  return {
    workspaceId: WORKSPACE,
    itemId: input.itemId,
    collectedVia: input.collectedVia ?? 'rendered_browser',
    sourceUrl: input.sourceUrl,
    finalUrl: input.finalUrl ?? input.sourceUrl,
    observedAt: input.observedAt ?? new Date(Date.now() - 1_000).toISOString(),
    expiresAt: input.expiresAt ?? null,
    contentType: input.contentType,
    content: input.content,
    facts: input.facts,
  };
}

beforeAll(() => {
  try { resetDb(); } catch { /* ok */ }
  initDb(TEST_DB);
  runMigrations();
  installManualEvidenceIdentityBindingSchema(getDb());
  installAcceptedItemEvidenceSchema(getDb());
  seedWorkspaceAndBatches();
});

afterAll(() => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { unlinkSync(`${TEST_DB}${suffix}`); } catch { /* ok */ }
  }
});

describe('accepted item evidence from persisted state', () => {
  test('manual operator attestations produce own-SKU facts, immutable history, and a read-only API view', async () => {
    seedItem('manual-item');
    const images = [
      'https://northpaw.example/images/cat-a.jpg',
      'https://northpaw.example/images/cat-b.jpg',
    ];
    const submitted = submitManualEvidence({
      itemId: 'manual-item',
      workspaceId: WORKSPACE,
      operatorId: 'operator-1',
      title: TITLE,
      brand: 'NorthPaw',
      description: 'Operator-transcribed package detail.',
      additionalImages: images,
      imageApprovals: images.map((imageUrl) => ({ imageUrl, rightsAttested: true })),
      attestation: { noFamilyInheritance: true, perSkuVerified: true, rightsAttested: true },
    }, noProfile);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const first = refreshItemEvidence(WORKSPACE, 'manual-item');
    expect(first.status).toBe('accepted');
    expect(first.evidence?.revision).toBe(1);
    expect(first.evidence?.facts.some((fact) => fact.field === 'title' && fact.value === TITLE)).toBe(true);
    expect(first.evidence?.facts.filter((fact) => fact.field === 'additionalImages')).toHaveLength(2);
    expect(first.evidence?.facts.filter((fact) => fact.field === 'additionalImages').every((fact) => fact.rights?.assetUrl === fact.value)).toBe(true);
    expect(first.evidence?.observations[0]).toMatchObject({
      sourceRole: 'operator_attested',
      collectedVia: 'manual',
      sourceUrl: null,
      connectorRecordId: null,
      identity: { itemId: 'manual-item', sku: 'sku-manual-item', proofType: 'operator_attestation', attestationId: submitted.attestationId },
    });

    const historical = getItemEvidenceSnapshot(WORKSPACE, 'manual-item', first.evidence!.id);
    expect(historical).toEqual(first.evidence);
    expect(getCurrentItemEvidence(WORKSPACE, 'manual-item')).toEqual(first.evidence);
    const replay = refreshItemEvidence(WORKSPACE, 'manual-item');
    expect(replay.status).toBe('accepted');
    expect(replay.evidence?.id).toBe(first.evidence?.id);
    expect(replay.evidence?.revision).toBe(1);
    const attestation = getDb().query('SELECT attestation_id FROM onboarding_manual_evidence_attestations WHERE item_id = ?').get('manual-item') as { attestation_id: string };
    expect(() => getDb().query('UPDATE onboarding_manual_evidence_attestations SET identity_input_hash = ? WHERE attestation_id = ?').run('forged-input-hash', attestation.attestation_id)).toThrow();

    const app = new Hono();
    app.route('/api', acceptedItemEvidenceRoutes);
    const response = await app.request('/api/onboarding/items/manual-item/accepted-evidence');
    expect(response.status).toBe(200);
    const payload = await response.json() as { status: string; evidence: { id: string; facts: Array<{ field: string }> } };
    expect(payload.status).toBe('accepted');
    expect(payload.evidence.id).toBe(first.evidence?.id ?? '');
    expect(payload.evidence.facts.some((fact) => fact.field === 'title')).toBe(true);
    const writeResponse = await app.request('/api/onboarding/items/manual-item/accepted-evidence', { method: 'POST' });
    expect(writeResponse.status).toBe(404);

    const historyCount = (getDb().query('SELECT COUNT(*) AS count FROM accepted_item_evidence_snapshots WHERE item_id = ?').get('manual-item') as { count: number }).count;
    expect(appendAcceptedItemEvidenceSnapshot({ workspaceId: WORKSPACE, itemId: 'manual-item', expectedRevision: 0, evidence: first.evidence! })).toBe(false);
    expect((getDb().query('SELECT COUNT(*) AS count FROM accepted_item_evidence_snapshots WHERE item_id = ?').get('manual-item') as { count: number }).count).toBe(historyCount);
    expect(() => getDb().query('UPDATE accepted_item_evidence_snapshots SET accepted_at = accepted_at WHERE id = ?').run(first.evidence!.id)).toThrow();

    getDb().query('UPDATE onboarding_items SET name = ?, updated_at = ? WHERE id = ?').run('NorthPaw Grain Free Cat Food Salmon 12 oz', new Date().toISOString(), 'manual-item');
    const stale = refreshItemEvidence(WORKSPACE, 'manual-item');
    expect(stale.status).toBe('unavailable');
    expect(stale.evidence?.revision).toBe(2);
    expect(stale.evidence?.facts).toHaveLength(0);
    const stillStale = refreshItemEvidence(WORKSPACE, 'manual-item');
    expect(stillStale.status).toBe('unavailable');
    expect(stillStale.evidence?.revision).toBe(2);
    expect(stillStale.evidence?.facts).toHaveLength(0);
    expect(getItemEvidenceSnapshot(WORKSPACE, 'manual-item', first.evidence!.id)?.facts).toEqual(first.evidence!.facts);
  });
  test('manual attestations cannot be rebound after an input edit before first refresh', () => {
    seedItem('manual-item-first-edit');
    const submitted = submitManualEvidence({
      itemId: 'manual-item-first-edit',
      workspaceId: WORKSPACE,
      operatorId: 'operator-2',
      title: TITLE,
      brand: 'NorthPaw',
      attestation: { noFamilyInheritance: true, perSkuVerified: true, rightsAttested: true },
    }, noProfile);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    getDb().query('UPDATE onboarding_items SET upc = ?, updated_at = ? WHERE id = ?')
      .run('different-sku', new Date().toISOString(), 'manual-item-first-edit');
    const firstRefresh = refreshItemEvidence(WORKSPACE, 'manual-item-first-edit');
    expect(firstRefresh.status).toBe('unavailable');
    expect(firstRefresh.evidence?.facts).toHaveLength(0);
    expect(firstRefresh.findings.some((entry) => entry.code === 'manual_identity_stale')).toBe(true);
    expect(refreshItemEvidence(WORKSPACE, 'manual-item-first-edit').evidence?.facts).toHaveLength(0);
  });

  test('a persisted confirmed manufacturer decision admits only its current direct extraction values', () => {
    const sourceUrl = 'https://northpaw.example/products/chicken-12-oz';
    seedItem('official-item');
    upsertBrandSite('NorthPaw', 'northpaw.example');
    getDb().query(`UPDATE onboarding_items SET stage = 'find_product_page', stage_status = 'failed' WHERE id = ?`).run('official-item');
    const source = proposePageCandidate({ itemId: 'official-item', url: sourceUrl, origin: 'operator' });
    const sourceRunId = 'official-discovery-run';
    getDb().query('UPDATE onboarding_sources SET discovery_run_id = ? WHERE id = ?').run(sourceRunId, source.id);
    recordOfficialPageDecision({
      workspaceId: WORKSPACE,
      itemId: 'official-item',
      sourceId: source.id,
      evidenceKind: 'operator_name',
      pageTitle: TITLE,
      variantKey: null,
      signals: {
        pageTitle: TITLE,
        isProductDetailPage: true,
        brand: 'NorthPaw',
        observedGtins: [],
        originalUrl: sourceUrl,
        finalUrl: sourceUrl,
      },
      sourceRunId,
    });
    const payload = {
      title: TITLE,
      brand: 'NorthPaw',
      description: 'Direct manufacturer detail.',
      bulletPoints: ['First distinct manufacturer bullet.', 'Second distinct manufacturer bullet.'],
      fieldProvenance: { title: 'html', brand: 'html', description: 'html', bulletPoints: 'html' },
    };
    insertExtraction({
      itemId: 'official-item',
      sourceType: 'official_page',
      sourceUrl,
      extractionMethod: 'static_extraction',
      extractionDataJson: JSON.stringify(payload),
      rawStructuredDataJson: JSON.stringify(payload.fieldProvenance),
      confidence: 1,
    });
    getDb().query('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?').run(JSON.stringify(payload), 'official-item');

    const result = refreshItemEvidence(WORKSPACE, 'official-item');
    expect(result.status).toBe('accepted');
    expect(result.evidence?.facts.some((fact) => fact.field === 'title' && fact.value === TITLE)).toBe(true);
    expect(result.evidence?.observations[0]).toMatchObject({
      sourceRole: 'manufacturer_official',
      collectedVia: 'static_extraction',
      sourceUrl,
      finalUrl: sourceUrl,
      identity: { itemId: 'official-item', sku: 'sku-official-item', outcome: 'confirmed' },
    });
    expect(result.evidence?.facts.filter((fact) => fact.field === 'bulletPoints').map((fact) => fact.value)).toEqual([
      'First distinct manufacturer bullet.',
      'Second distinct manufacturer bullet.',
    ]);
    const contradictoryAxesPayload = {
      ...payload,
      variantAttributes: { size: '15 oz' },
      fieldProvenance: { ...payload.fieldProvenance, variantAttributes: 'html' },
    };
    getDb().query('UPDATE onboarding_extractions SET extraction_data_json = ?, raw_structured_data_json = ? WHERE item_id = ?')
      .run(JSON.stringify(contradictoryAxesPayload), JSON.stringify(contradictoryAxesPayload.fieldProvenance), 'official-item');
    getDb().query('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?').run(JSON.stringify(contradictoryAxesPayload), 'official-item');
    const contradictoryAxes = refreshItemEvidence(WORKSPACE, 'official-item');
    expect(contradictoryAxes.status).toBe('conflict');
    expect(contradictoryAxes.evidence?.facts).toHaveLength(0);
    expect(contradictoryAxes.findings.some((entry) => entry.code === 'identity_conflict')).toBe(true);

    const changedPayload = {
      ...payload,
      title: 'NorthPaw Grain Free Cat Food Salmon 12 oz',
    };
    getDb().query('UPDATE onboarding_extractions SET extraction_data_json = ?, raw_structured_data_json = ? WHERE item_id = ?')
      .run(JSON.stringify(changedPayload), JSON.stringify(changedPayload.fieldProvenance), 'official-item');
    getDb().query('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?').run(JSON.stringify(changedPayload), 'official-item');
    const mismatchedExtraction = refreshItemEvidence(WORKSPACE, 'official-item');
    expect(mismatchedExtraction.evidence?.facts).toHaveLength(0);
    expect(mismatchedExtraction.status).toBe('conflict');
    expect(mismatchedExtraction.findings.some((entry) => entry.code === 'identity_conflict' || entry.code === 'official_identity_unavailable')).toBe(true);
  });

  test('current accepted distributor attempts produce URL-null, connection-authorized own-SKU facts', () => {
    const upc = '012345678901';
    const name = TITLE;
    const [item] = insertItems(
      BATCH,
      [{ upc, name, rowNumber: 900, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    const generation = startSourcingGeneration(item.id, 'automatic');
    const connection = createConnection({
      workspaceId: WORKSPACE,
      distributorId: 'evidence-distributor',
      connectorType: 'api',
      authorityPolicy: { skuAuthority: true },
    });
    updateConnection(connection.id, WORKSPACE, { enabled: true });
    const attempt = insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'evidence-distributor',
      distributorConnectionId: connection.id,
      lookupUpc: upc,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc', 'name'],
      identityJson: JSON.stringify({ upc, name, brand: 'NorthPaw', weight: '12 oz', casePack: '6' }),
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      catalogVersion: 'fixture-v1',
      observedAt: new Date().toISOString(),
      sourcingGenerationId: generation.id,
    });
    const acceptedIds = [attempt.id];
    recordAcceptances(item.id, acceptedIds, 'system', 'test');
    const projection = buildDistributorRecordProjection({
      itemId: item.id,
      itemUpc: upc,
      sourcingGenerationId: generation.id,
      attempts: [attempt],
      acceptedAttemptIds: acceptedIds,
      declaredVariantAxes: [],
    });
    expect(projection.qualified).toBe(true);
    if (!projection.qualified) return;

    const decision: SourcingDecisionV2 = {
      schemaVersion: 2,
      route: 'distributor_record_to_extraction',
      origin: 'automatic_policy',
      acceptedEvidenceAttemptIds: projection.acceptedAttemptIds,
      providerIds: projection.providerIds,
      sourcingGenerationId: generation.id,
      conflicts: [],
      warnings: [],
      decidedAt: new Date().toISOString(),
      evidenceHash: projection.evidenceHash,
      sourceType: 'distributor_record',
      target: 'extraction',
    };
    const routed = completeSourcingWithDecision(item.id, decision, 'collect_details');
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    updateItemStageStatus(item.id, 'in_progress');
    expect(materializeDistributorRecordExtraction(item.id, WORKSPACE).ok).toBe(true);

    const result = refreshItemEvidence(WORKSPACE, item.id);
    expect(result.status).toBe('accepted');
    expect(result.evidence?.sku).toBe(upc);
    expect(result.evidence?.facts.some((fact) => fact.field === 'title' && fact.value === name)).toBe(true);
    expect(result.evidence?.facts.some((fact) => fact.field === 'packCount' && fact.value === '6')).toBe(true);
    expect(result.evidence?.observations[0]).toMatchObject({
      sourceRole: 'distributor_record',
      collectedVia: 'structured',
      sourceUrl: null,
      connectorRecordId: attempt.id,
      authorityId: 'evidence-distributor',
      identity: { itemId: item.id, sku: upc, proofType: 'gtin', outcome: 'confirmed' },
    });
    const disagreement = admitItemEvidenceContribution(contribution({
      itemId: item.id,
      sourceUrl: 'https://chewy.com/northpaw/chicken-12-oz',
      contentType: 'application/json',
      content: JSON.stringify({ title: name, weight: '10 oz' }),
      facts: [
        { field: 'title', reference: { kind: 'json_pointer', pointer: '/title' } },
        { field: 'weight', reference: { kind: 'json_pointer', pointer: '/weight' } },
      ],
    }));
    expect(disagreement.status).toBe('conflict');
    expect(disagreement.evidence?.submittedFactReferences).toHaveLength(2);
    expect(disagreement.evidence?.facts.some((fact) => fact.field === 'weight')).toBe(false);
    const repeatedDisagreement = refreshItemEvidence(WORKSPACE, item.id);
    expect(repeatedDisagreement.status).toBe('conflict');
    expect(repeatedDisagreement.evidence?.submittedFactReferences).toEqual(disagreement.evidence?.submittedFactReferences);
    expect(repeatedDisagreement.evidence?.facts.some((fact) => fact.field === 'weight')).toBe(false);
  });

  test('no source and an unreviewed legacy extraction remain unavailable', () => {
    seedItem('unknown-item');
    const unknown = refreshItemEvidence(WORKSPACE, 'unknown-item');
    expect(unknown.status).toBe('unavailable');
    expect(unknown.evidence?.observations).toHaveLength(0);
    expect(unknown.evidence?.facts).toHaveLength(0);

    const unreviewedUrl = 'https://northpaw.example/products/chicken-12-oz';
    seedItem('unreviewed-item', { sourceUrl: unreviewedUrl });
    const payload = {
      title: TITLE,
      brand: 'NorthPaw',
      fieldProvenance: { title: 'html', brand: 'html' },
    };
    insertExtraction({
      itemId: 'unreviewed-item',
      sourceType: 'official_page',
      sourceUrl: unreviewedUrl,
      extractionMethod: 'static_extraction',
      extractionDataJson: JSON.stringify(payload),
      rawStructuredDataJson: JSON.stringify(payload.fieldProvenance),
      confidence: 1,
    });
    getDb().query('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?').run(JSON.stringify(payload), 'unreviewed-item');
    const unreviewed = refreshItemEvidence(WORKSPACE, 'unreviewed-item');
    expect(unreviewed.status).toBe('unavailable');
    expect(unreviewed.evidence?.facts).toHaveLength(0);
    expect(unreviewed.findings.some((entry) => entry.code === 'official_source_unavailable')).toBe(true);
  });

  test('internal collection admission derives authority and exact variant, rejects bad references, retailer prose, and unapproved images', () => {
    seedItem('contribution-item');
    upsertBrandSite('NorthPaw', 'northpaw.example');
    const validContent = JSON.stringify({ title: TITLE, weight: '0.75 lb' });
    const valid = contribution({
      itemId: 'contribution-item',
      sourceUrl: 'https://chewy.com/northpaw/chicken-12-oz',
      contentType: 'application/json',
      content: validContent,
      facts: [
        { field: 'title', reference: { kind: 'json_pointer', pointer: '/title' } },
        { field: 'weight', reference: { kind: 'json_pointer', pointer: '/weight' } },
      ],
    });
    const accepted = admitItemEvidenceContribution(valid);
    expect(accepted.status).toBe('accepted');
    expect(accepted.evidence?.facts).toHaveLength(1);
    expect(accepted.evidence?.facts[0]).toMatchObject({ field: 'weight', value: '0.75 lb' });
    expect(accepted.evidence?.observations[0]).toMatchObject({ sourceRole: 'retailer_corroboration', collectedVia: 'rendered_browser' });
    expect(accepted.evidence?.observations[0].sourceRole).not.toBe('rendered_browser');
    const mapped = acceptedEvidenceToClassificationEvidence(accepted.evidence!, 'run-evidence');
    expect(mapped[0]).toMatchObject({
      runId: 'run-evidence',
      productSku: 'sku-contribution-item',
      source: 'third_party_page',
      sourceField: 'weight',
      value: '0.75 lb',
      metadata: { sourceRole: 'retailer_corroboration', collectionMethod: 'rendered_browser' },
    });

    const replay = admitItemEvidenceContribution(valid);
    expect(replay.status).toBe('accepted');
    expect(replay.evidence?.id).toBe(accepted.evidence?.id);
    expect(replay.evidence?.revision).toBe(accepted.evidence?.revision);
    expect(replay.findings.some((entry) => entry.code === 'contribution_replayed')).toBe(true);

    const wrongVariant = admitItemEvidenceContribution(contribution({
      itemId: 'contribution-item',
      sourceUrl: 'https://chewy.com/northpaw/salmon-12-oz',
      contentType: 'application/json',
      content: JSON.stringify({ title: 'NorthPaw Grain Free Cat Food Salmon 12 oz' }),
      facts: [{ field: 'title', reference: { kind: 'json_pointer', pointer: '/title' } }],
    }));
    const contradictoryAxes = admitItemEvidenceContribution(contribution({
      itemId: 'contribution-item',
      sourceUrl: 'https://chewy.com/northpaw/chicken-12-oz',
      contentType: 'application/json',
      content: JSON.stringify({ title: TITLE, variantAttributes: { size: '15 oz' }, weight: '12 oz' }),
      facts: [
        { field: 'title', reference: { kind: 'json_pointer', pointer: '/title' } },
        { field: 'weight', reference: { kind: 'json_pointer', pointer: '/weight' } },
      ],
    }));
    expect(contradictoryAxes.status).toBe('conflict');
    expect(contradictoryAxes.findings.some((entry) => entry.code === 'identity_conflict')).toBe(true);

    const retailerTitleClaim = `${TITLE} — Supports kidney health`;
    const titleClaim = admitItemEvidenceContribution(contribution({
      itemId: 'contribution-item',
      sourceUrl: 'https://chewy.com/northpaw/chicken-12-oz',
      contentType: 'application/json',
      content: JSON.stringify({ title: retailerTitleClaim, weight: '12 oz' }),
      facts: [
        { field: 'title', reference: { kind: 'json_pointer', pointer: '/title' } },
        { field: 'weight', reference: { kind: 'json_pointer', pointer: '/weight' } },
      ],
    }));
    expect(titleClaim.status).toBe('accepted');
    expect(titleClaim.evidence?.facts.every((fact) => fact.field === 'weight')).toBe(true);
    const titleClaimObservation = titleClaim.evidence?.observations.find((observation) => observation.content.includes(retailerTitleClaim));
    expect(titleClaim.evidence?.facts.some((fact) => fact.observationId === titleClaimObservation?.id && fact.value === '12 oz')).toBe(true);
    expect(titleClaim.evidence?.facts.some((fact) => fact.value.includes('kidney'))).toBe(false);
    const qualifiedMeasurement = admitItemEvidenceContribution(contribution({
      itemId: 'contribution-item',
      sourceUrl: 'https://chewy.com/northpaw/chicken-12-oz',
      contentType: 'application/json',
      content: JSON.stringify({ title: TITLE, weight: 'not 12 oz' }),
      facts: [
        { field: 'title', reference: { kind: 'json_pointer', pointer: '/title' } },
        { field: 'weight', reference: { kind: 'json_pointer', pointer: '/weight' } },
      ],
    }));
    expect(qualifiedMeasurement.status).toBe('conflict');
    expect(qualifiedMeasurement.evidence?.facts.some((fact) => fact.field === 'weight')).toBe(false);
    seedItem('symbolic-bound-item');
    const exactMeasurement = admitItemEvidenceContribution(contribution({
      itemId: 'symbolic-bound-item',
      sourceUrl: 'https://chewy.com/northpaw/chicken-12-oz',
      contentType: 'application/json',
      content: JSON.stringify({ title: TITLE, weight: '12 oz' }),
      facts: [
        { field: 'title', reference: { kind: 'json_pointer', pointer: '/title' } },
        { field: 'weight', reference: { kind: 'json_pointer', pointer: '/weight' } },
      ],
    }));
    expect(exactMeasurement.status).toBe('accepted');
    const boundedMeasurement = admitItemEvidenceContribution(contribution({
      itemId: 'symbolic-bound-item',
      sourceUrl: 'https://chewy.com/northpaw/chicken-12-oz',
      contentType: 'application/json',
      content: JSON.stringify({ title: TITLE, weight: '<12 oz' }),
      facts: [
        { field: 'title', reference: { kind: 'json_pointer', pointer: '/title' } },
        { field: 'weight', reference: { kind: 'json_pointer', pointer: '/weight' } },
      ],
    }));
    expect(boundedMeasurement.status).toBe('conflict');
    expect(boundedMeasurement.evidence?.facts.some((fact) => fact.field === 'weight')).toBe(false);
    seedItem('mixed-flavor-item', { title: 'NorthPaw Grain Free Cat Food Chicken Salmon 12 oz' });
    const mixedFlavor = admitItemEvidenceContribution(contribution({
      itemId: 'mixed-flavor-item',
      sourceUrl: 'https://chewy.com/northpaw/chicken-salmon-12-oz',
      contentType: 'application/json',
      content: JSON.stringify({ title: 'NorthPaw Grain Free Cat Food Chicken Salmon 12 oz', weight: '0.75 lb' }),
      facts: [
        { field: 'title', reference: { kind: 'json_pointer', pointer: '/title' } },
        { field: 'weight', reference: { kind: 'json_pointer', pointer: '/weight' } },
      ],
    }));
    expect(mixedFlavor.status).toBe('accepted');
    expect(mixedFlavor.evidence?.facts.some((fact) => fact.field === 'weight' && fact.value === '0.75 lb')).toBe(true);
    expect(wrongVariant.status).toBe('conflict');
    expect(wrongVariant.evidence).toBeNull();

    const forgedSpan = admitItemEvidenceContribution(contribution({
      itemId: 'contribution-item',
      sourceUrl: 'https://chewy.com/northpaw/chicken-12-oz',
      contentType: 'text/plain',
      content: TITLE,
      facts: [{ field: 'title', reference: { kind: 'text_span', start: 0, end: TITLE.length + 1 } }],
    }));
    expect(forgedSpan.status).toBe('unavailable');
    expect(forgedSpan.evidence).toBeNull();

    const retailerProse = admitItemEvidenceContribution(contribution({
      itemId: 'contribution-item',
      sourceUrl: 'https://chewy.com/northpaw/chicken-12-oz',
      contentType: 'application/json',
      content: JSON.stringify({ title: TITLE, description: 'A health-support promise.' }),
      facts: [
        { field: 'title', reference: { kind: 'json_pointer', pointer: '/title' } },
        { field: 'description', reference: { kind: 'json_pointer', pointer: '/description' } },
      ],
    }));
    expect(retailerProse.status).toBe('unavailable');
    expect(retailerProse.findings.some((entry) => entry.code === 'retailer_sensitive_field_refused')).toBe(true);

    const missingRights = admitItemEvidenceContribution(contribution({
      itemId: 'contribution-item',
      sourceUrl: 'https://northpaw.example/products/chicken-12-oz',
      contentType: 'application/json',
      content: JSON.stringify({ title: TITLE, primaryImage: 'https://northpaw.example/images/chicken.jpg' }),
      facts: [
        { field: 'title', reference: { kind: 'json_pointer', pointer: '/title' } },
        { field: 'primaryImage', reference: { kind: 'json_pointer', pointer: '/primaryImage' } },
      ],
    }));
    expect(missingRights.status).toBe('unavailable');
    expect(missingRights.findings.some((entry) => entry.code === 'rights_missing')).toBe(true);
    expect(getCurrentItemEvidence(WORKSPACE, 'contribution-item')?.facts.some((fact) => fact.field === 'primaryImage')).toBe(false);
  });

  test('repository and route lookups refuse cross-workspace item access', async () => {
    const db = getDb();
    const now = new Date().toISOString();
    db.query(`INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at) VALUES (?, 'other', '/tmp/other', '/tmp/other/.git', ?, ?)`).run(OTHER_WORKSPACE, now, now);
    db.query(`INSERT INTO onboarding_batches (id, workspace_id, name, file_name, created_at, updated_at) VALUES (?, ?, 'other', 'other.csv', ?, ?)`).run(OTHER_BATCH, OTHER_WORKSPACE, now, now);
    seedItem('foreign-item', { batchId: OTHER_BATCH });
    expect(getCurrentItemEvidence(OTHER_WORKSPACE, 'manual-item')).toBeNull();
    const app = new Hono();
    app.route('/api', acceptedItemEvidenceRoutes);
    const response = await app.request('/api/onboarding/items/foreign-item/accepted-evidence');
    expect(response.status).toBe(404);
  });
});
