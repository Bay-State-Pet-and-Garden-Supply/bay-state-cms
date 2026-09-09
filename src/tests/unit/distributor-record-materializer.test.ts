import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import fs from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  findItemById,
  completeSourcingWithDecision,
  updateItemStageStatus,
} from '../../db/repositories/onboarding-item-repo';
import {
  startSourcingGeneration,
  insertEvidenceAttempt,
  getEvidenceAttemptsByItemAndGeneration,
  supersedeCurrentSourcingGeneration,
} from '../../db/repositories/onboarding-evidence-repo';
import { recordAcceptances } from '../../db/repositories/onboarding-acceptance-repo';
import {
  insertConflictWithCandidates,
  resolveConflict,
  listResolvedConflictResolutions,
} from '../../db/repositories/onboarding-conflict-repo';
import { createDistributor, createConnection } from '../../db/repositories/distributor-repo';
import { SOURCING_ENTRY_POLICY_VERSION } from '../../onboarding/sourcing/entry-policy';
import {
  buildDistributorRecordProjection,
  buildDistributorRecordProjectionV1,
} from '../../onboarding/sourcing/distributor-record-projection';
import {
  buildDistributorExtractionDataV1,
} from '../../onboarding/sourcing/distributor-record-materializer';
import {
  materializeDistributorRecordExtraction,
  DISTRIBUTOR_MATERIALIZATION_ERROR_CODES,
  canonicalMaterializedWeight,
  payloadsEquivalentAfterWeightNormalization,
} from '../../onboarding/sourcing/distributor-record-materializer';
import type { SourcingDecisionV2 } from '../../shared/schemas/onboarding';
import type { EvidenceAttempt } from '../../shared/schemas/distributor-evidence';
import type { Workspace } from '../../shared/types';
// Spy-seam targets (MD item 6 / round-6 defect 8): the official extraction
// path reaches these modules; the distributor-record branch must never call
// them. Namespace imports let bun:test spyOn the exported functions.
import * as pageExtractor from '../../onboarding/page-extractor';
import * as profileRepo from '../../db/repositories/extractor-profile-repo';
import * as packagingOcr from '../../onboarding/packaging-ocr';
import * as vlmClient from '../../onboarding/vlm-client';

describe('Distributor-record materializer (Amendment A, Milestone D)', () => {
  const WORKSPACE = 'w1';
  const FOREIGN_WS = 'w2';
  const UPC = '012345678901';
  let itemId: string;
  let generationId: string;

  beforeEach(() => {
    resetDb();
    initDb(':memory:');
    runMigrations();
    insertWorkspace({
      id: WORKSPACE,
      name: 'WS1',
      workspacePath: '/tmp/ws1',
      gitPath: '/tmp/ws1/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    } as Workspace);
    insertWorkspace({
      id: FOREIGN_WS,
      name: 'WS2',
      workspacePath: '/tmp/ws2',
      gitPath: '/tmp/ws2/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    } as Workspace);

    const batch = createBatch({ workspaceId: WORKSPACE, name: 'B', fileName: 'b.csv', totalItems: 1 });
    const [item] = insertItems(
      batch.id,
      [{ upc: UPC, name: 'Pet Kibble', rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    itemId = item.id;
    const gen = startSourcingGeneration(itemId, 'automatic');
    generationId = gen.id;
  });

  afterEach(() => {
    closeDb();
  });

  function makeConnection(providerId: string, workspaceId = WORKSPACE) {
    createDistributor({ id: providerId, name: providerId, status: 'active' });
    const conn = createConnection({ workspaceId, distributorId: providerId, connectorType: 'api' });
    return conn;
  }

  function makeFoundAttempt(
    providerId: string,
    identity: Record<string, unknown>,
    opts: {
      lookupUpc?: string;
      connectionId?: string | null;
      outcome?: 'found' | 'source_error' | 'not_stocked';
      errorCode?: string | null;
      catalogVersion?: string | null;
    } = {},
  ) {
    const conn = opts.connectionId === undefined ? makeConnection(providerId) : { id: opts.connectionId };
    const outcome = opts.outcome ?? 'found';
    return insertEvidenceAttempt({
      itemId,
      providerId,
      distributorConnectionId: conn.id,
      lookupUpc: opts.lookupUpc ?? UPC,
      outcome,
      confidence: outcome === 'found' ? 0.9 : 0,
      evidenceUrl: null,
      matchedFields: ['upc', 'name'],
      identityJson: outcome === 'found' ? JSON.stringify({ upc: UPC, name: 'Pet Kibble 5lb', ...identity }) : null,
      warningsJson: null,
      errorCode: opts.errorCode ?? null,
      errorMessage: opts.errorCode ? 'provider timed out' : null,
      catalogVersion: opts.catalogVersion ?? 'v2026.3',
      observedAt: '2026-08-13T00:00:00.000Z',
      sourcingGenerationId: generationId,
    });
  }

  /** Route a qualified fixture to extraction/pending (the worker equivalent). */
  function routeQualified(attempts: EvidenceAttempt[], declaredVariantAxes: string[] = []) {
    const ids = attempts.map((a) => a.id);
    recordAcceptances(itemId, ids, 'system', 'test');
    const projection = buildDistributorRecordProjection({
      itemId,
      itemUpc: UPC,
      sourcingGenerationId: generationId,
      attempts,
      acceptedAttemptIds: ids,
      declaredVariantAxes,
    });
    if (!projection.qualified) {
      console.log('DBG reasons', JSON.stringify(projection.reasonCodes), 'attempts', JSON.stringify(attempts.map(a => ({id:a.id, cat:a.catalogVersion, obs:a.observedAt, out:a.outcome, gen:a.sourcingGenerationId, upc:a.lookupUpc, ij:a.identityJson}))));
      throw new Error(`fixture must be qualified: ${projection.reasonCodes.join(',')}`);
    }
    const decision: SourcingDecisionV2 = {
      schemaVersion: 2,
      route: 'distributor_record_to_extraction',
      origin: 'automatic_policy',
      acceptedEvidenceAttemptIds: projection.acceptedAttemptIds,
      providerIds: projection.providerIds,
      sourcingGenerationId: generationId,
      conflicts: [],
      warnings: [],
      decidedAt: new Date().toISOString(),
      evidenceHash: projection.evidenceHash,
      sourceType: 'distributor_record',
      target: 'extraction',
    };
    const res = completeSourcingWithDecision(itemId, decision, 'collect_details');
    if (!res.ok) throw new Error(`routing failed: ${res.reason}`);
    return decision;
  }

  /** Simulate the worker claim: extraction/in_progress. */
  function claimForExtraction() {
    updateItemStageStatus(itemId, 'in_progress');
    const item = findItemById(itemId);
    expect(item?.stage).toBe('extraction');
  }

  test('single provider qualifies and materializes the merchandising-depth v2 extraction', () => {
    const att = makeFoundAttempt('phillips', {
      brand: 'Brand A',
      weight: '10 lbs',
      distributorSku: 'SKU-1',
      manufacturerPartNumber: 'MPN-1',
      description: 'High-quality pet kibble',
      features: ['Chicken first', 'Grain free'],
      category: 'Dog Food',
      dimensions: '12x8x4 in',
      casePack: '6',
      unitOfMeasure: 'EA',
      ingredients: 'Chicken, rice, vitamins',
      images: ['https://cdn.example.com/kibble-a.jpg', 'https://cdn.example.com/kibble-b.jpg'],
    });
    const decision = routeQualified([att]);
    claimForExtraction();

    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = getDb().query('SELECT * FROM onboarding_extractions WHERE item_id = ?').all(itemId) as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0].extraction_method).toBe('distributor_record_v2');
    expect(rows[0].source_type).toBe('distributor_record');
    expect(rows[0].source_url).toBeNull();
    expect(rows[0].sourcing_generation_id).toBe(generationId);
    expect(rows[0].evidence_hash).toBe(decision.evidenceHash);
    const idsJson = JSON.parse(String(rows[0].accepted_evidence_attempt_ids_json ?? '[]')) as string[];
    expect(idsJson).toEqual([att.id]);

    // Item payload + stage.
    const item = findItemById(itemId);
    expect(item?.stage).toBe('extraction');
    expect(item?.stageStatus).toBe('completed');
    const data = item?.extractionData as Record<string, unknown>;
    expect(data?.title).toBe('Pet Kibble 5lb');
    expect(data?.brand).toBe('Brand A');
    // Epic #46 follow-up (operator weight rule): canonical pounds, 2dp.
    expect(data?.weight).toBe('10.00');
    expect(data?.distributorSku).toBe('SKU-1');
    expect(data?.manufacturerPartNumber).toBe('MPN-1');
    // Amendment B (M5): merchandising-depth materialization.
    expect(data?.description).toBe('High-quality pet kibble');
    expect(data?.bulletPoints).toEqual(['Chicken first', 'Grain free']);
    expect(data?.distributorCategory).toBe('Dog Food');
    expect(data?.dimensions).toBe('12x8x4 in');
    expect(data?.casePack).toBe('6');
    expect(data?.unitOfMeasure).toBe('EA');
    expect(data?.ingredients).toBe('Chicken, rice, vitamins');
    // Approved image candidates (store-owner opt-in, Amendment B addendum 3)
    // with attempt/provider provenance and rights attestation.
    expect(data?.distributorImageCandidates).toHaveLength(2);
    expect((data?.distributorImageCandidates as Array<Record<string, unknown>>)[0].sourceAttemptIds).toEqual([att.id]);
    expect((data?.distributorImageCandidates as Array<Record<string, unknown>>)[0].sourceProviderIds).toEqual(['phillips']);
    const approvals = (data?.distributorImageApprovals ?? []) as Array<{
      imageUrl: string;
      sourceAttemptIds: string[];
      rightsAttested: boolean;
      approvalOrigin: string;
      approvedAt: string;
    }>;
    expect(approvals).toHaveLength(2);
    expect(approvals[0].rightsAttested).toBe(true);
    expect(approvals[0].approvalOrigin).toBe('distributor_channel_opt_in');
    expect(approvals[0].sourceAttemptIds).toEqual([att.id]);
    expect(approvals[0].approvedAt).toBeTruthy();
    expect(new Set(approvals.map((a) => a.imageUrl))).toEqual(
      new Set((data?.distributorImageCandidates as Array<{ url: string }>).map((c) => c.url)),
    );
    // Forbidden commerce fields stay absent.
    expect(data?.price).toBeNull();
    expect(data?.primaryImage).toBeNull();
    expect(data?.additionalImages).toEqual([]);
    expect(data?.sourceUrl).toBeNull();
    // Provenance v2 carries projection version + method + full per-field provenance.
    const prov = data?.distributorRecordProvenance as Record<string, unknown>;
    expect(prov?.projectionVersion).toBe('distributor-record-projection-v2');
    expect(prov?.extractionMethod).toBe('distributor_record_v2');
    expect((prov?.fieldProvenance as Record<string, unknown>).description).toBeDefined();
    expect((prov?.merchandisingProvenance as Record<string, unknown>).features).toBeDefined();
    expect(data?.sourceType).toBe('distributor_record');
    expect(data?.sourceUrl).toBeNull();
    expect(data?.confidence).toBe(0);
    // Excluded fields stay empty/null (v2 merchandising-depth contract).
    expect(data?.price).toBeNull();
    expect(data?.primaryImage).toBeNull();
    expect(data?.additionalImages).toEqual([]);
    expect(data?.packagingTitle).toBeNull();
    expect(data?.packagingOcrData).toBeNull();
    const provenance = data?.distributorRecordProvenance as Record<string, unknown>;
    expect(provenance?.sourcingGenerationId).toBe(generationId);
    expect(provenance?.evidenceHash).toBe(decision.evidenceHash);
    expect(provenance?.acceptedEvidenceAttemptIds).toEqual([att.id]);
    expect(provenance?.providerIds).toEqual(['phillips']);
  });

  test('a malformed serialized sourcing decision fails closed with malformed_decision, never throws', () => {
    const att = makeFoundAttempt('phillips', { brand: 'Brand A' });
    routeQualified([att]);
    // Corrupt the durable decision authority directly (Milestone D round-8:
    // the row mapper hydrates malformed JSON as null — the materializer must
    // fail closed with the stable code instead of throwing).
    getDb()
      .query('UPDATE onboarding_items SET sourcing_decision_json = ? WHERE id = ?')
      .run('{not-valid-json', itemId);
    claimForExtraction();

    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.malformed_decision);
    }
    // Zero partial materialization.
    const rows = getDb()
      .query('SELECT COUNT(*) AS c FROM onboarding_extractions WHERE item_id = ?')
      .get(itemId) as { c: number };
    expect(rows.c).toBe(0);
    expect(findItemById(itemId)?.extractionData).toBeNull();
  });

  test('multiple agreeing providers qualify; all appear in provenance', () => {
    const a1 = makeFoundAttempt('phillips', { brand: 'Brand A', weight: '10 lbs' });
    const a2 = makeFoundAttempt('unfi', { brand: 'Brand A', weight: '10 lbs' });
    routeQualified([a1, a2]);
    claimForExtraction();

    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const item = findItemById(itemId);
    const provenance = (item?.extractionData as Record<string, unknown>)?.distributorRecordProvenance as Record<string, unknown>;
    expect(provenance?.providerIds).toEqual(['phillips', 'unfi']);
    expect(provenance?.acceptedEvidenceAttemptIds).toEqual([a1.id, a2.id].sort());
  });

  test('disagreeing distributor SKUs/names across accepted providers consolidate; ALL values reach the extraction payload', () => {
    const a1 = makeFoundAttempt('phillips', {
      brand: 'Brand A',
      weight: '10 lbs',
      distributorSku: 'SKU-PHIL',
      name: 'Pet Kibble 5lb',
      manufacturerPartNumber: 'MPN-1',
    });
    const a2 = makeFoundAttempt('unfi', {
      brand: 'Brand A',
      weight: '10 lbs',
      distributorSku: 'SKU-UNFI',
      name: 'PET KIBBLE 5LB',
      manufacturerPartNumber: 'MPN-1',
    });
    const decision = routeQualified([a1, a2]);
    claimForExtraction();

    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const item = findItemById(itemId);
    const data = item?.extractionData as Record<string, unknown>;
    // The projection consolidates the single pick (primary provider)…
    expect(data?.distributorSku).toBe('SKU-PHIL');
    expect(data?.title).toBe('Pet Kibble 5lb');
    // …but EVERY accepted attempt's reference value is preserved for
    // Curation (sorted-unique; per-distributor reference fields only).
    expect(data?.distributorReferenceValues).toEqual({
      distributorSku: ['SKU-PHIL', 'SKU-UNFI'],
      name: ['PET KIBBLE 5LB', 'Pet Kibble 5lb'],
    });
    // The evidence-hash contract is unchanged: the hash covers the
    // projection only; the reference map is a deterministic payload
    // addition derived from the same immutable accepted attempts.
    const rows = getDb()
      .query('SELECT evidence_hash FROM onboarding_extractions WHERE item_id = ?')
      .all(itemId) as Array<{ evidence_hash: string }>;
    expect(rows[0].evidence_hash).toBe(decision.evidenceHash);
    const prov = data?.distributorRecordProvenance as Record<string, unknown>;
    expect(prov?.evidenceHash).toBe(decision.evidenceHash);
  });

  test('found + provider error: qualified record materializes, error attempt is not accepted', () => {
    const att = makeFoundAttempt('phillips', { brand: 'Brand A', weight: '10 lbs' });
    makeFoundAttempt('unfi', {}, { outcome: 'source_error', errorCode: 'timeout' });
    routeQualified([att]);
    claimForExtraction();

    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const item = findItemById(itemId);
    const provenance = (item?.extractionData as Record<string, unknown>)?.distributorRecordProvenance as Record<string, unknown>;
    expect(provenance?.acceptedEvidenceAttemptIds).toEqual([att.id]);
  });

  test('whitelisted variant attributes (built-in axes) are projected into variantAttributes', () => {
    const att = makeFoundAttempt('phillips', {
      brand: 'Brand A',
      attributes: { flavor: 'chicken', size: '5lb' },
    });
    // Built-in axes normalize from identity attributes WITHOUT any connector
    // declaration (size/count/packCount/flavor/formula are canonical).
    routeQualified([att]);
    claimForExtraction();

    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const item = findItemById(itemId);
    const data = item?.extractionData as Record<string, unknown>;
    expect((data?.variantAttributes as Record<string, string>)?.flavor).toBe('chicken');
    expect((data?.variantAttributes as Record<string, string>)?.size).toBe('5lb');
    // Custom (connector-declared) axes are empty when none were declared.
    expect((data?.customFields as Record<string, unknown>)).toBeDefined();
  });

  test('idempotent retry: same generation/hash reuses the existing row, no divergent insert', () => {
    const att = makeFoundAttempt('phillips', { brand: 'Brand A', weight: '10 lbs' });
    routeQualified([att]);
    claimForExtraction();

    const first = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.idempotent).toBe(false);

    // Simulate a re-claim after a crash before the worker read the result.
    claimForExtraction();
    const second = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.idempotent).toBe(true);
    expect(second.extractionId).toBe(first.extractionId);

    const rows = getDb().query('SELECT * FROM onboarding_extractions WHERE item_id = ?').all(itemId) as unknown[];
    expect(rows.length).toBe(1);

    // Defect 3 fix: the retried item must reach extraction/completed with its
    // payload restored — otherwise it stays claimable at extraction/in_progress.
    const retried = findItemById(itemId);
    expect(retried?.stage).toBe('extraction');
    expect(retried?.stageStatus).toBe('completed');
    expect(retried?.extractionData).not.toBeNull();
  });

  test('idempotent retry upgrades a historical v2 payload missing distributorReferenceValues', () => {
    const att = makeFoundAttempt('phillips', {
      brand: 'Brand A',
      distributorSku: 'SKU-OLD',
      distributorUpc: '000123456789',
      weight: '10 lbs',
    });
    routeQualified([att]);
    claimForExtraction();

    const first = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Recreate the pre-feature v2 shape in both durable copies.
    const row = getDb()
      .query("SELECT extraction_data_json FROM onboarding_extractions WHERE item_id = ? AND extraction_method = 'distributor_record_v2'")
      .get(itemId) as { extraction_data_json: string };
    const historical = JSON.parse(row.extraction_data_json) as Record<string, unknown>;
    delete historical.distributorReferenceValues;
    const historicalJson = JSON.stringify(historical);
    getDb().query('UPDATE onboarding_extractions SET extraction_data_json = ? WHERE item_id = ?').run(historicalJson, itemId);
    getDb().query('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?').run(historicalJson, itemId);

    claimForExtraction();
    const retry = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.idempotent).toBe(true);
    expect(retry.extractionData.distributorReferenceValues).toEqual({
      distributorSku: ['SKU-OLD'],
      distributorUpc: ['000123456789'],
      name: ['Pet Kibble 5lb'],
    });

    const upgradedRow = getDb()
      .query('SELECT extraction_data_json FROM onboarding_extractions WHERE item_id = ?')
      .get(itemId) as { extraction_data_json: string };
    const upgraded = JSON.parse(upgradedRow.extraction_data_json) as Record<string, unknown>;
    expect(upgraded.distributorReferenceValues).toBeDefined();
  });

  test('idempotent retry fails closed when the stored payload was altered outside the materializer', () => {
    const att = makeFoundAttempt('phillips', { brand: 'Brand A', weight: '10 lbs' });
    routeQualified([att]);
    claimForExtraction();

    const first = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.idempotent).toBe(false);

    // Tamper the durable extraction ROW without changing the canonical
    // evidence/projection (simulates a generic edit route that slipped
    // through the immutability guard).
    const row = getDb()
      .query(
        "SELECT extraction_data_json FROM onboarding_extractions WHERE item_id = ? AND extraction_method = 'distributor_record_v2'",
      )
      .get(itemId) as { extraction_data_json: string };
    const tampered = JSON.parse(row.extraction_data_json) as Record<string, unknown>;
    tampered.title = 'Tampered Title';
    getDb()
      .query('UPDATE onboarding_extractions SET extraction_data_json = ? WHERE item_id = ?')
      .run(JSON.stringify(tampered), itemId);

    // Re-claim and retry: the diverged stored payload must NEVER be restored.
    claimForExtraction();
    const second = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('stored_payload_diverged');

    // No completion, no restore of the tampered payload onto the item.
    const item = findItemById(itemId);
    expect(item?.stageStatus).toBe('in_progress');
    expect(item?.extractionData?.title).not.toBe('Tampered Title');
  });

  test('idempotent retry fails closed when the stored accepted-attempt provenance diverged', () => {
    const att = makeFoundAttempt('phillips', { brand: 'Brand A', weight: '10 lbs' });
    routeQualified([att]);
    claimForExtraction();

    const first = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const row = getDb()
      .query(
        "SELECT extraction_data_json FROM onboarding_extractions WHERE item_id = ? AND extraction_method = 'distributor_record_v2'",
      )
      .get(itemId) as { extraction_data_json: string };
    const tampered = JSON.parse(row.extraction_data_json) as {
      distributorRecordProvenance: { acceptedEvidenceAttemptIds: string[] };
    };
    tampered.distributorRecordProvenance.acceptedEvidenceAttemptIds = ['foreign-attempt'];
    getDb()
      .query('UPDATE onboarding_extractions SET extraction_data_json = ? WHERE item_id = ?')
      .run(JSON.stringify(tampered), itemId);

    claimForExtraction();
    const second = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('stored_payload_diverged');
    expect(findItemById(itemId)?.stageStatus).toBe('in_progress');
  });

  test('idempotent retry fails closed when the durable ROW accepted-attempt column diverged (payload intact)', () => {
    const att = makeFoundAttempt('phillips', { brand: 'Brand A', weight: '10 lbs' });
    routeQualified([att]);
    claimForExtraction();

    const first = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Tamper ONLY the durable row column accepted_evidence_attempt_ids_json;
    // the extraction_data_json payload stays untouched.
    getDb()
      .query(
        "UPDATE onboarding_extractions SET accepted_evidence_attempt_ids_json = ? WHERE item_id = ? AND extraction_method = 'distributor_record_v2'",
      )
      .run(JSON.stringify(['foreign-attempt']), itemId);

    claimForExtraction();
    const second = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('stored_payload_diverged');
    // The retry did NOT complete the item; the payload is untouched (the
    // first successful materialization legitimately set it, and the tampered
    // ROW column was never read back onto the item).
    expect(findItemById(itemId)?.stageStatus).toBe('in_progress');
    expect(findItemById(itemId)?.extractionData?.title).toBe('Pet Kibble 5lb');
  });

  test('a mis-shaped distributor_record_v1 row (official_page source_type) fails closed and never creates a second row', () => {
    const att = makeFoundAttempt('phillips', { brand: 'Brand A', weight: '10 lbs' });
    const decision = routeQualified([att]);
    claimForExtraction();

    // Seed a row with the SAME method but source_type official_page
    // (URL deliberately mis-shaped) BEFORE materialization. The finder
    // locates by immutable identity (item + method) only, so this row IS
    // found and must fail validation — never silently insert a second row.
    getDb()
      .query(
        `INSERT INTO onboarding_extractions
          (id, item_id, source_url, extraction_data_json, extraction_method, confidence, images_json,
           raw_structured_data_json, source_type, sourcing_generation_id, accepted_evidence_attempt_ids_json,
           evidence_hash, created_at)
         VALUES (?, ?, NULL, '{}', 'distributor_record_v2', 0, NULL, NULL, 'official_page', ?, ?, ?, ?)`,
      )
      .run(
        'ext-official-twin',
        itemId,
        generationId,
        JSON.stringify(decision.acceptedEvidenceAttemptIds),
        decision.evidenceHash,
        new Date().toISOString(),
      );

    // The row exists but is mis-shaped → fail closed with NO restore, NO
    // completion, NO second insert (the divergent row is never papered over).
    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('stored_payload_diverged');
    const rows = getDb().query('SELECT * FROM onboarding_extractions WHERE item_id = ?').all(itemId) as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows.some((r) => r.source_type === 'official_page')).toBe(true);
    expect(findItemById(itemId)?.stageStatus).toBe('in_progress');
  });

  test('idempotent retry fails closed when the durable ROW source_url diverged', () => {
    const att = makeFoundAttempt('phillips', { brand: 'Brand A', weight: '10 lbs' });
    routeQualified([att]);
    claimForExtraction();

    const first = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Tamper ONLY the durable row source_url (payload intact).
    getDb()
      .query(
        "UPDATE onboarding_extractions SET source_url = ? WHERE item_id = ? AND extraction_method = 'distributor_record_v2'",
      )
      .run('https://tampered.example/product', itemId);

    claimForExtraction();
    const second = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('stored_payload_diverged');
    expect(findItemById(itemId)?.stageStatus).toBe('in_progress');
  });

  test('a current generation marked superseded (no successor) fails closed with superseded_generation', () => {
    const att = makeFoundAttempt('phillips', { brand: 'Brand A', weight: '10 lbs' });
    routeQualified([att]);
    claimForExtraction();
    // Mark the LATEST (decision-named) generation superseded WITHOUT creating
    // a successor: the decision still names it, but superseded state must
    // never materialize.
    getDb().query("UPDATE sourcing_generations SET status = 'superseded' WHERE id = ?").run(generationId);

    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.superseded_generation);
    const rows = getDb().query('SELECT * FROM onboarding_extractions WHERE item_id = ?').all(itemId) as unknown[];
    expect(rows.length).toBe(0);
    expect(findItemById(itemId)?.extractionData).toBeNull();
  });

  test('a foreign-connection attempt (other workspace) fails closed with invalid_attempt', () => {
    // The connection EXISTS but belongs to another workspace. The repo insert
    // guard would reject this cross-workspace attempt outright, so insert the
    // row directly to exercise the materializer's own connection-ownership
    // recheck (the same defense the repo provides at write time).
    const foreignConn = makeConnection('unfi', FOREIGN_WS);
    getDb().query(
      `INSERT INTO onboarding_evidence_attempts
        (id, item_id, provider_id, distributor_connection_id, catalog_snapshot_id, lookup_upc, outcome,
         confidence, evidence_url, matched_fields_json, identity_json, warnings_json, error_code,
         error_message, catalog_version, observed_at, expires_at, sourcing_generation_id, duration_ms, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, 'found', 0.9, NULL, ?, ?, NULL, NULL, NULL, 'v2026.3', ?, NULL, ?, NULL, ?)`,
    ).run(
      'att-foreign',
      itemId,
      'unfi',
      foreignConn.id,
      UPC,
      JSON.stringify(['upc', 'name']),
      JSON.stringify({ upc: UPC, name: 'Pet Kibble 5lb' }),
      '2026-08-13T00:00:00.000Z',
      generationId,
      new Date().toISOString(),
    );
    const att = getEvidenceAttemptsByItemAndGeneration(itemId, generationId).find((a) => a.id === 'att-foreign')!;
    expect(att).toBeDefined();
    routeQualified([att]);
    claimForExtraction();

    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.invalid_attempt);
  });

  test('deterministic ordering: reversed attempt input produces the same evidence hash', () => {
    const a1 = makeFoundAttempt('phillips', { brand: 'Brand A', weight: '10 lbs' });
    const a2 = makeFoundAttempt('unfi', { brand: 'Brand A', weight: '10 lbs' });
    const decision = routeQualified([a1, a2]);
    claimForExtraction();

    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Recompute the projection over REVERSED attempts/ids: hash must be stable.
    const reversed = buildDistributorRecordProjection({
      itemId,
      itemUpc: UPC,
      sourcingGenerationId: generationId,
      attempts: [a2, a1],
      acceptedAttemptIds: [a2.id, a1.id],
    });
    expect(reversed.qualified).toBe(true);
    if (!reversed.qualified) return;
    expect(reversed.evidenceHash).toBe(decision.evidenceHash);
  });

  test('reviewed merchandising description materializes; arbitrary/inventory fields stay excluded', () => {
    const att = makeFoundAttempt('phillips', {
      brand: 'Brand A',
      weight: '10 lbs',
      description: 'provider marketing copy',
      price: '9.99',
      inStock: 'true',
      leadTimeDays: '5',
    });
    routeQualified([att]);
    claimForExtraction();

    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = findItemById(itemId)?.extractionData as Record<string, unknown>;
    // Amendment B (M5): the reviewed description field now materializes.
    expect(data?.description).toBe('provider marketing copy');
    // Price/inventory/arbitrary fields remain excluded by contract.
    expect(data?.price).toBeNull();
    expect(data?.bulletPoints).toEqual([]);
    expect(data?.customFields).toEqual({});
    expect(data?.inStock).toBeUndefined();
    expect(data?.leadTimeDays).toBeUndefined();
  });

  test('injected failure mid-write rolls the whole transaction back (zero partial rows)', () => {
    const att = makeFoundAttempt('phillips', { brand: 'Brand A', weight: '10 lbs' });
    routeQualified([att]);
    claimForExtraction();
    // Abort the transaction AFTER the extraction insert but BEFORE commit by
    // raising from a trigger on the item payload update (the last write).
    getDb().run(
      `CREATE TRIGGER trg_inject_fail AFTER UPDATE OF extraction_data_json ON onboarding_items
       BEGIN SELECT RAISE(ABORT, 'injected late-write failure'); END`,
    );
    expect(() => materializeDistributorRecordExtraction(itemId, WORKSPACE)).toThrow();
    getDb().run('DROP TRIGGER trg_inject_fail');

    const rows = getDb().query('SELECT * FROM onboarding_extractions WHERE item_id = ?').all(itemId) as unknown[];
    expect(rows.length).toBe(0);
    const item = findItemById(itemId);
    expect(item?.extractionData).toBeNull();
    expect(item?.stageStatus).toBe('in_progress');
  });

  test('stale generation fails closed with stale_generation', () => {
    const att = makeFoundAttempt('phillips', { brand: 'Brand A', weight: '10 lbs' });
    routeQualified([att]);
    // Supersede the generation AFTER routing: the decision now names a stale gen.
    supersedeCurrentSourcingGeneration(itemId, 'retry');
    claimForExtraction();

    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.stale_generation);
    // Zero partial writes.
    const rows = getDb().query('SELECT * FROM onboarding_extractions WHERE item_id = ?').all(itemId) as unknown[];
    expect(rows.length).toBe(0);
    expect(findItemById(itemId)?.extractionData).toBeNull();
  });

  test('missing connection ownership fails closed with invalid_attempt', () => {
    const att = makeFoundAttempt('phillips', { brand: 'Brand A', weight: '10 lbs' });
    const decision = routeQualified([att]);
    claimForExtraction();
    // Delete the connection the accepted attempt is owned by.
    getDb().query('DELETE FROM distributor_connections WHERE distributor_id = ?').run('phillips');

    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.invalid_attempt);
    expect(decision.evidenceHash).toBeTruthy();
  });

  test('changed acceptance set fails closed with acceptance_mismatch', () => {
    const att = makeFoundAttempt('phillips', { brand: 'Brand A', weight: '10 lbs' });
    routeQualified([att]);
    claimForExtraction();
    // Remove the relational acceptance: the decision still names it.
    getDb().query('DELETE FROM onboarding_item_evidence_acceptances WHERE item_id = ?').run(itemId);

    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.acceptance_mismatch);
  });

  test('open hard conflict fails closed with open_conflict', () => {
    const att = makeFoundAttempt('phillips', { brand: 'Brand A', weight: '10 lbs' });
    routeQualified([att]);
    claimForExtraction();
    getDb().query(
      `INSERT INTO onboarding_evidence_conflicts
        (id, item_id, field, severity, status, sourcing_generation_id, created_at)
       VALUES ('conflict-1', ?, 'weight', 'hard', 'open', ?, ?)`,
    ).run(itemId, generationId, new Date().toISOString());

    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.open_conflict);
  });

  test('hash mismatch fails closed with hash_mismatch and zero partial writes', () => {
    const att = makeFoundAttempt('phillips', { brand: 'Brand A', weight: '10 lbs' });
    routeQualified([att]);
    claimForExtraction();
    // Corrupt the persisted decision hash.
    const item = findItemById(itemId);
    const decision = item?.sourcingDecision as SourcingDecisionV2;
    const tampered = { ...decision, evidenceHash: 'f'.repeat(64) };
    getDb().query('UPDATE onboarding_items SET sourcing_decision_json = ? WHERE id = ?').run(
      JSON.stringify(tampered),
      itemId,
    );

    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.hash_mismatch);
    const rows = getDb().query('SELECT * FROM onboarding_extractions WHERE item_id = ?').all(itemId) as unknown[];
    expect(rows.length).toBe(0);
    expect(findItemById(itemId)?.extractionData).toBeNull();
    expect(findItemById(itemId)?.stageStatus).toBe('in_progress');
  });

  test('wrong stage fails closed with wrong_stage', () => {
    const att = makeFoundAttempt('phillips', { brand: 'Brand A', weight: '10 lbs' });
    routeQualified([att]);
    // NO claim: the item stays extraction/pending (not in_progress).
    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.wrong_stage);
  });

  test('wrong decision route fails closed with wrong_decision', () => {
    const att = makeFoundAttempt('phillips', { brand: 'Brand A', weight: '10 lbs' });
    routeQualified([att]);
    claimForExtraction();
    // Rewrite the decision to evidence_to_discovery (a route that never targets extraction).
    const decision: SourcingDecisionV2 = {
      schemaVersion: 2,
      route: 'evidence_to_discovery',
      origin: 'automatic_policy',
      acceptedEvidenceAttemptIds: [att.id],
      providerIds: ['phillips'],
      sourcingGenerationId: generationId,
      sourceType: 'official_page',
      target: 'discovery',
      conflicts: [],
      warnings: [],
      decidedAt: new Date().toISOString(),
    };
    getDb().query('UPDATE onboarding_items SET sourcing_decision_json = ? WHERE id = ?').run(
      JSON.stringify(decision),
      itemId,
    );

    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.wrong_decision);
  });

  test('foreign workspace fails closed with not_owned', () => {
    const att = makeFoundAttempt('phillips', { brand: 'Brand A', weight: '10 lbs' });
    routeQualified([att]);
    claimForExtraction();

    const result = materializeDistributorRecordExtraction(itemId, FOREIGN_WS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.not_owned);
  });

  test('operator-resolved custom override: routing hash is reproducible at materialization', () => {
    // Two providers disagree on weight → HARD conflict (reconciler-equivalent
    // durable conflict with candidates).
    const a1 = makeFoundAttempt('phillips', { brand: 'Brand A', weight: '10 lbs' });
    const a2 = makeFoundAttempt('unfi', { brand: 'Brand A', weight: '12 lbs' });
    const ids = [a1.id, a2.id];
    recordAcceptances(itemId, ids, 'system', 'test');
    const conflict = insertConflictWithCandidates(
      itemId,
      'weight',
      'hard',
      [
        { evidenceAttemptId: a1.id, valueJson: JSON.stringify('10 lbs') },
        { evidenceAttemptId: a2.id, valueJson: JSON.stringify('12 lbs') },
      ],
      generationId,
    );
    // Operator picks a custom value → resolution persisted (generation-scoped).
    resolveConflict(conflict.id, { action: 'custom_value', customValue: '11 lbs' }, 'operator');

    // Routing recomputes the projection WITH the persisted resolutions (both
    // final conflict resolution and the manual use_distributor_record action
    // call completeSourcingViaProjection with listResolvedConflictResolutions).
    const resolutions = listResolvedConflictResolutions(itemId);
    expect(resolutions).toEqual([{ field: 'weight', kind: 'custom_override', value: '11 lbs' }]);
    const projection = buildDistributorRecordProjection({
      itemId,
      itemUpc: UPC,
      sourcingGenerationId: generationId,
      attempts: [a1, a2],
      acceptedAttemptIds: ids,
      resolutions,
    });
    expect(projection.qualified).toBe(true);
    if (!projection.qualified) return;
    // Without the resolution this would be an open hard conflict; with it the
    // resolved value lands in the projection.
    expect(projection.projection.weight).toBe('11 lbs');

    const decision: SourcingDecisionV2 = {
      schemaVersion: 2,
      route: 'distributor_record_to_extraction',
      origin: 'operator_override',
      acceptedEvidenceAttemptIds: projection.acceptedAttemptIds,
      providerIds: projection.providerIds,
      sourcingGenerationId: generationId,
      conflicts: [],
      warnings: [],
      decidedAt: new Date().toISOString(),
      evidenceHash: projection.evidenceHash,
      sourceType: 'distributor_record',
      target: 'extraction',
    };
    const routed = completeSourcingWithDecision(itemId, decision, 'collect_details');
    expect(routed.ok).toBe(true);
    claimForExtraction();

    // Materializer recomputes WITH the SAME persisted resolutions — the hash
    // must reproduce. Before the MD round-3 fix this failed with hash_mismatch
    // (resolutions omitted from the recompute).
    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = findItemById(itemId);
    const data = item?.extractionData as Record<string, unknown>;
    // Epic #46 follow-up (operator weight rule): structured weight is
    // canonical pounds, two decimals — never the raw provider string.
    expect(data?.weight).toBe('11.00');
    const provenance = data?.distributorRecordProvenance as Record<string, unknown>;
    expect(provenance?.evidenceHash).toBe(decision.evidenceHash);
    expect(findItemById(itemId)?.stageStatus).toBe('completed');
  });

  test('a schema-invalid accepted attempt fails closed with invalid_attempt (zero partial writes)', () => {
    // The repo insert guards would reject this, but hydration does NOT
    // re-validate rows: insert directly to prove the materializer's full
    // EvidenceAttemptSchema recheck. Out-of-range confidence + malformed
    // observedAt escape the projection (which only validates identityJson)
    // but MUST fail the materializer.
    const conn = makeConnection('phillips');
    getDb().query(
      `INSERT INTO onboarding_evidence_attempts
        (id, item_id, provider_id, distributor_connection_id, catalog_snapshot_id, lookup_upc, outcome,
         confidence, evidence_url, matched_fields_json, identity_json, warnings_json, error_code,
         error_message, catalog_version, observed_at, expires_at, sourcing_generation_id, duration_ms, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, 'found', 1.5, NULL, ?, ?, NULL, NULL, NULL, 'v2026.3', 'not-a-date', NULL, ?, NULL, ?)`,
    ).run(
      'att-bad-schema',
      itemId,
      'phillips',
      conn.id,
      UPC,
      JSON.stringify(['upc']),
      JSON.stringify({ upc: UPC, name: 'Pet Kibble 5lb' }),
      generationId,
      new Date().toISOString(),
    );
    const att = getEvidenceAttemptsByItemAndGeneration(itemId, generationId).find((a) => a.id === 'att-bad-schema')!;
    expect(att).toBeDefined();
    routeQualified([att]);
    claimForExtraction();

    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.invalid_attempt);
    const rows = getDb().query('SELECT * FROM onboarding_extractions WHERE item_id = ?').all(itemId) as unknown[];
    expect(rows.length).toBe(0);
    expect(findItemById(itemId)?.extractionData).toBeNull();
    expect(findItemById(itemId)?.stageStatus).toBe('in_progress');
  });

  test('zero external calls: spy seams prove no page/profile/OCR/VLM/LLM/fetch machinery runs', () => {
    // SPY SEAM (MD item 6 / round-6 defect 8): instrument every module the
    // distributor branch MUST NOT call, then run a full materialization and
    // assert zero invocations. The official extraction path calls these
    // modules (job-queue processExtraction -> page-extractor / profile repo /
    // packaging-ocr / vlm-client); the materializer must never touch them.
    const attempt = makeFoundAttempt('phillips', { upc: UPC, name: 'Pet Kibble 5lb' });
    routeQualified([attempt]);
    claimForExtraction();

    const spies = [
      spyOn(pageExtractor, 'extractProductData'),
      spyOn(pageExtractor, 'extractViaHttpDetailed'),
      spyOn(profileRepo, 'findProfileByDomain'),
      spyOn(packagingOcr, 'extractPackagingOcr'),
      spyOn(packagingOcr, 'loadProductImageAsBase64'),
      spyOn(vlmClient, 'callVlm'),
    ];
    try {
      const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      for (const s of spies) {
        expect(s).not.toHaveBeenCalled();
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }

    // SUPPLEMENT — structural guarantee: the module graph itself stays on the
    // allowed import surface (db repos, shared schemas, sourcing/projection),
    // and no network / machine-vision / DOM APIs appear anywhere in the body.
    const source = fs.readFileSync(
      'src/onboarding/sourcing/distributor-record-materializer.ts',
      'utf8',
    );
    const importSpecifiers: string[] = [];
    const importRe = /from\s+['"]([^'"]+)['"]/g;
    let importMatch: RegExpExecArray | null;
    while ((importMatch = importRe.exec(source)) !== null) {
      importSpecifiers.push(importMatch[1]);
    }
    expect(importSpecifiers.length).toBeGreaterThan(0);
    for (const from of importSpecifiers) {
      const allowed =
        from.startsWith('../../db/') ||
        from.startsWith('../../shared/') ||
        // Pure, dependency-free identity normalization (epic #46 follow-up):
        // no DB, network, or model machinery — safe for the boundary.
        from.startsWith('../normalization/') ||
        from.startsWith('./');
      expect(allowed, `disallowed import source in materializer: ${from}`).toBe(true);
    }
    for (const needle of ['fetch(', 'node-fetch', 'WebSocket', 'sharp(', 'document.', 'XMLHttpRequest']) {
      expect(source).not.toContain(needle);
    }
  });
describe('canonical structured weight (epic #46 follow-up, operator rule)', () => {
  test('canonicalMaterializedWeight converts to pounds with two decimals', () => {
    expect(canonicalMaterializedWeight('16 oz')).toBe('1.00');
    expect(canonicalMaterializedWeight('0.0600 lb')).toBe('0.06');
    expect(canonicalMaterializedWeight('10 lbs')).toBe('10.00');
    expect(canonicalMaterializedWeight('0.25')).toBe('0.25');
  });
  test('null/empty pass through; malformed yields null (never raw text in the canonical field)', () => {
    expect(canonicalMaterializedWeight(null)).toBeNull();
    expect(canonicalMaterializedWeight('')).toBe('');
    expect(canonicalMaterializedWeight('approx 1 lb')).toBeNull();
  });
  test('payloadsEquivalentAfterWeightNormalization accepts legacy raw weight formats only', () => {
    const expected = { title: 'Pet Kibble', weight: '1.00', brand: 'Brand A' };
    expect(payloadsEquivalentAfterWeightNormalization({ ...expected, weight: '1.0000 lb' }, expected)).toBe(true);
    expect(payloadsEquivalentAfterWeightNormalization({ ...expected, weight: '16 oz' }, expected)).toBe(true);
    // Identical payloads take the main equality path.
    expect(payloadsEquivalentAfterWeightNormalization(expected, expected)).toBe(false);
    // Real divergence anywhere else is NOT tolerated.
    expect(payloadsEquivalentAfterWeightNormalization({ ...expected, weight: '1.00', brand: 'Brand B' }, expected)).toBe(false);
    // Unparseable stored weight is never silently equivalent.
    expect(payloadsEquivalentAfterWeightNormalization({ ...expected, weight: 'approx 1 lb' }, expected)).toBe(false);
  });
});

describe('Distributor-record materializer v1/v2 authority dispatch (Amendment B, M5)', () => {
  test('a pre-deployment v1 decision fails closed with projection_version_mismatch (no silent upgrade)', () => {
    const att = makeFoundAttempt('phillips', { brand: 'Brand A', description: 'Copy' });
    const ids = [att.id];
    recordAcceptances(itemId, ids, 'system', 'test');
    // Route with the V1 authority explicitly (pre-deployment decision).
    const v1Projection = buildDistributorRecordProjectionV1({
      itemId,
      itemUpc: UPC,
      sourcingGenerationId: generationId,
      attempts: [att],
      acceptedAttemptIds: ids,
    });
    expect(v1Projection.qualified).toBe(true);
    if (!v1Projection.qualified) return;
    const decision: SourcingDecisionV2 = {
      schemaVersion: 2,
      route: 'distributor_record_to_extraction',
      origin: 'automatic_policy',
      acceptedEvidenceAttemptIds: v1Projection.acceptedAttemptIds,
      providerIds: v1Projection.providerIds,
      sourcingGenerationId: generationId,
      conflicts: [],
      warnings: [],
      decidedAt: new Date().toISOString(),
      evidenceHash: v1Projection.evidenceHash,
      sourceType: 'distributor_record',
      target: 'extraction',
    };
    const res = completeSourcingWithDecision(itemId, decision, 'collect_details');
    if (!res.ok) throw new Error(`routing failed: ${res.reason}`);
    claimForExtraction();

    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('projection_version_mismatch');
    // No row, no completion, no payload.
    const rows = getDb().query('SELECT * FROM onboarding_extractions WHERE item_id = ?').all(itemId) as unknown[];
    expect(rows.length).toBe(0);
    expect(findItemById(itemId)?.extractionData).toBeNull();
    expect(findItemById(itemId)?.stageStatus).toBe('in_progress');
  });

  test('a v1 extraction row remains idempotently verifiable under the v1 authority', () => {
    const att = makeFoundAttempt('phillips', { brand: 'Brand A', description: 'Copy' });
    const ids = [att.id];
    recordAcceptances(itemId, ids, 'system', 'test');
    const v1Projection = buildDistributorRecordProjectionV1({
      itemId,
      itemUpc: UPC,
      sourcingGenerationId: generationId,
      attempts: [att],
      acceptedAttemptIds: ids,
    });
    expect(v1Projection.qualified).toBe(true);
    if (!v1Projection.qualified) return;
    const decision: SourcingDecisionV2 = {
      schemaVersion: 2,
      route: 'distributor_record_to_extraction',
      origin: 'automatic_policy',
      acceptedEvidenceAttemptIds: v1Projection.acceptedAttemptIds,
      providerIds: v1Projection.providerIds,
      sourcingGenerationId: generationId,
      conflicts: [],
      warnings: [],
      decidedAt: new Date().toISOString(),
      evidenceHash: v1Projection.evidenceHash,
      sourceType: 'distributor_record',
      target: 'extraction',
    };
    const res = completeSourcingWithDecision(itemId, decision, 'collect_details');
    if (!res.ok) throw new Error(`routing failed: ${res.reason}`);

    // Seed the durable v1 row exactly as a pre-deployment materialization would.
    const v1Data = buildDistributorExtractionDataV1(v1Projection.projection, decision.evidenceHash);
    getDb()
      .query(
        `INSERT INTO onboarding_extractions
          (id, item_id, source_url, extraction_data_json, extraction_method, confidence, images_json,
           raw_structured_data_json, source_type, sourcing_generation_id, accepted_evidence_attempt_ids_json,
           evidence_hash, created_at)
         VALUES (?, ?, NULL, ?, 'distributor_record_v1', 0, NULL, ?, 'distributor_record', ?, ?, ?, ?)`,
      )
      .run(
        'ext-v1',
        itemId,
        JSON.stringify(v1Data),
        JSON.stringify(v1Data.fieldProvenance),
        generationId,
        JSON.stringify(v1Projection.projection.provenance.acceptedAttemptIds),
        decision.evidenceHash,
        new Date().toISOString(),
      );
    claimForExtraction();

    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.idempotent).toBe(true);
    expect(result.extractionId).toBe('ext-v1');
    // The v1 payload stays identity-only (no merchandising was added).
    expect((result.extractionData as Record<string, unknown>).description).toBeNull();
    const rows = getDb().query('SELECT * FROM onboarding_extractions WHERE item_id = ?').all(itemId) as unknown[];
    expect(rows.length).toBe(1);
  });

  test('an extraction row with an unknown method fails closed with unknown_extraction_method', () => {
    const att = makeFoundAttempt('phillips', { brand: 'Brand A' });
    const decision = routeQualified([att]);
    claimForExtraction();
    getDb()
      .query(
        `INSERT INTO onboarding_extractions
          (id, item_id, source_url, extraction_data_json, extraction_method, confidence, images_json,
           raw_structured_data_json, source_type, sourcing_generation_id, accepted_evidence_attempt_ids_json,
           evidence_hash, created_at)
         VALUES (?, ?, NULL, '{}', 'mystery_method', 0, NULL, NULL, 'distributor_record', ?, ?, ?, ?)`,
      )
      .run(
        'ext-mystery',
        itemId,
        generationId,
        JSON.stringify(decision.acceptedEvidenceAttemptIds),
        decision.evidenceHash,
        new Date().toISOString(),
      );
    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unknown_extraction_method');
    const rows = getDb().query('SELECT * FROM onboarding_extractions WHERE item_id = ?').all(itemId) as unknown[];
    expect(rows.length).toBe(1);
    expect(findItemById(itemId)?.stageStatus).toBe('in_progress');
  });

  test('multi-provider merchandising disagreement materializes with deterministic union and warning', () => {
    const att1 = makeFoundAttempt('phillips', {
      brand: 'Brand A',
      description: 'Copy A',
      features: ['Chicken first'],
      images: ['https://cdn.example.com/a.jpg'],
    });
    const att2 = makeFoundAttempt('unfi', {
      brand: 'Brand A',
      description: 'Copy B',
      features: ['grain free'],
      images: ['https://cdn.example.com/b.jpg'],
    });
    routeQualified([att1, att2]);
    claimForExtraction();

    const result = materializeDistributorRecordExtraction(itemId, WORKSPACE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = findItemById(itemId)?.extractionData as Record<string, unknown>;
    // Deterministic lexical selection on disagreement (warning only).
    expect(data?.description).toBe('Copy A');
    // Feature union merged deterministically.
    expect(data?.bulletPoints).toEqual(['Chicken first', 'grain free']);
    // Image candidates from both providers with per-provider provenance.
    const candidates = data?.distributorImageCandidates as Array<Record<string, unknown>>;
    expect(candidates).toHaveLength(2);
    const prov = data?.distributorRecordProvenance as Record<string, unknown>;
    expect(prov?.merchandisingProvenance as Record<string, unknown>).toBeDefined();
    // The extraction completed despite merchandising disagreement.
    expect(findItemById(itemId)?.stageStatus).toBe('completed');
  });
});

});