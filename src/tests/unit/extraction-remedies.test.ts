import { expect, test, describe, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  getDomainStatus,
  recordDomainStatus,
  clearDomainStatus,
  listAllDomainStatuses,
} from '../../db/repositories/domain-status-repo';
import { validateExtraction } from '../../onboarding/extraction-validator';

describe('Extraction Remedies and Validation Tests', () => {
  const testDbPath = 'src/tests/unit/extraction-remedies-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  describe('Domain Status Repository', () => {
    test('should record and check domain status correctly', () => {
      const domain = 'earthanimal.com';
      const status = 'blocked';
      const reason = 'Matches WAF block';

      const entry = recordDomainStatus(domain, status, reason);
      expect(entry.domain).toBe('earthanimal.com');
      expect(entry.status).toBe('blocked');
      expect(entry.reason).toBe(reason);

      const retrieved = getDomainStatus(domain);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.status).toBe('blocked');
      expect(retrieved?.reason).toBe(reason);
    });

    test('should normalize domains (lowercase & strip www.)', () => {
      const entry = recordDomainStatus('WWW.EarthAnimal.com', 'offline', 'Offline reason');
      expect(entry.domain).toBe('earthanimal.com');

      const retrieved = getDomainStatus('earthanimal.com');
      expect(retrieved?.status).toBe('offline');
    });

    test('should support clearing domain status', () => {
      const cleared = clearDomainStatus('earthanimal.com');
      expect(cleared).toBe(true);

      const retrieved = getDomainStatus('earthanimal.com');
      expect(retrieved).toBeNull();
    });
  });

  describe('listAllDomainStatuses (read-only diagnostics)', () => {
    test('returns rows sorted by domain ascending', () => {
      recordDomainStatus('zeta.example.com', 'ok', 'zeta reason');
      recordDomainStatus('alpha.example.com', 'blocked', 'alpha reason');
      recordDomainStatus('mid.example.com', 'offline', 'mid reason');

      const all = listAllDomainStatuses();
      const domains = all.map((r) => r.domain);
      expect(domains).toEqual([...domains].sort());
      expect(domains).toContain('alpha.example.com');
      expect(domains).toContain('mid.example.com');
      expect(domains).toContain('zeta.example.com');
    });

    test('returns a >7-day-old row without deleting it', () => {
      const domain = 'ancient.example.com';
      recordDomainStatus(domain, 'blocked', 'long-running block');

      // Manually rewind checked_at to 30 days ago.
      const db = getDb();
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      db.query('UPDATE domain_status SET checked_at = ? WHERE domain = ?').run(thirtyDaysAgo, domain);

      // listAllDomainStatuses must surface the stale row.
      const rows = listAllDomainStatuses();
      const found = rows.find((r) => r.domain === domain);
      expect(found).toBeDefined();
      expect(found?.status).toBe('blocked');
      expect(found?.reason).toBe('long-running block');

      // And critically: the row must still exist in the table.
      const stillThere = db
        .query('SELECT COUNT(*) as count FROM domain_status WHERE domain = ?')
        .get(domain) as { count: number };
      expect(stillThere.count).toBe(1);

      // For comparison: getDomainStatus() WOULD have deleted it.
      const evicted = getDomainStatus(domain);
      expect(evicted).toBeNull();
      const after = db
        .query('SELECT COUNT(*) as count FROM domain_status WHERE domain = ?')
        .get(domain) as { count: number };
      expect(after.count).toBe(0);
    });

    test('returns no rows when the table is empty', () => {
      // Clear any rows from earlier tests to validate the empty case.
      const db = getDb();
      db.query('DELETE FROM domain_status').run();

      const all = listAllDomainStatuses();
      expect(all).toEqual([]);
    });
  });

  describe('Extraction Validator', () => {
    const expected = {
      name: 'Woof Poomergency Lavender Wet Dog Food',
      brandHint: 'Woof',
    };

    test('should pass valid extractions', () => {
      const data = {
        title: 'Woof Poomergency Lavender Wet Dog Food',
        sourceUrl: 'https://mywoof.com/products/poomergency',
      };
      const result = validateExtraction(data, expected);
      expect(result.valid).toBe(true);
      expect(result.status).toBe('ok');
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    test('should catch empty title as offline', () => {
      const data = {
        title: '',
        sourceUrl: 'https://mywoof.com/products/poomergency',
      };
      const result = validateExtraction(data, expected);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('offline');
      expect(result.reason).toContain('empty');
    });

    test('should catch Cloudflare blocks', () => {
      const data = {
        title: 'Sorry, you have been blocked | Earth Animal',
        sourceUrl: 'https://earthanimal.com/products/rolls',
      };
      const result = validateExtraction(data, expected);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('blocked');
      expect(result.reason).toContain('blocked');
    });

    test('should catch dead page messages', () => {
      const data = {
        title: 'This Shopify store is currently unavailable.',
        sourceUrl: 'https://chefscut.com/products/jerky',
      };
      const result = validateExtraction(data, expected);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('offline');
      expect(result.reason).toContain('unavailable');
    });

    test('should flag catalog mismatches (e.g. Baby Wipes instead of Dog Food)', () => {
      const data = {
        title: 'BABY WIPE PINK 72PC | Price Power USA, Inc.',
        sourceUrl: 'https://pricepower.com/06863',
      };
      const result = validateExtraction(data, expected);
      expect(result.valid).toBe(false);
      expect(result.status).toBe('mismatch');
      expect(result.reason).toContain('Catalog mismatch');
    });
  });

  describe('Distributor-record extraction remedies (Amendment A, Milestone D)', () => {
    const WS = 'remedy-ws';
    const UPC = '019288888888';
    let itemId: string;
    let generationId: string;

    test('integrity failure stays failed with the stable code and never falls through to the official path', async () => {
      const { insertWorkspace } = await import('../../db/repositories/workspace-repo');
      const { createBatch } = await import('../../db/repositories/onboarding-batch-repo');
      const { insertItems, findItemById, completeSourcingWithDecision, updateItemStageStatus } = await import('../../db/repositories/onboarding-item-repo');
      const { startSourcingGeneration, insertEvidenceAttempt } = await import('../../db/repositories/onboarding-evidence-repo');
      const { recordAcceptances } = await import('../../db/repositories/onboarding-acceptance-repo');
      const { createDistributor, createConnection } = await import('../../db/repositories/distributor-repo');
      const { SOURCING_ENTRY_POLICY_VERSION } = await import('../../onboarding/sourcing/entry-policy');
      const { buildDistributorRecordProjection } = await import('../../onboarding/sourcing/distributor-record-projection');
      const { materializeDistributorRecordExtraction, DISTRIBUTOR_MATERIALIZATION_ERROR_CODES } = await import('../../onboarding/sourcing/distributor-record-materializer');
      const { revertToOfficialDiscovery } = await import('../../db/repositories/onboarding-item-repo');

      insertWorkspace({ id: WS, name: 'Remedy WS', workspacePath: '/tmp/remedy', gitPath: '/tmp/remedy/.git', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null } as never);
      const batch = createBatch({ workspaceId: WS, name: 'Remedy Batch', fileName: 'r.csv', totalItems: 1 });
      const [item] = insertItems(batch.id, [{ upc: UPC, name: 'Remedy Kibble', rowNumber: 1, stage: 'sourcing' }], 'sourcing', SOURCING_ENTRY_POLICY_VERSION);
      itemId = item.id;
      const gen = startSourcingGeneration(itemId, 'automatic');
      generationId = gen.id;

      createDistributor({ id: 'phillips', name: 'phillips', status: 'active' });
      const conn = createConnection({ workspaceId: WS, distributorId: 'phillips', connectorType: 'api' });
      const att = insertEvidenceAttempt({
        itemId, providerId: 'phillips', distributorConnectionId: conn.id, lookupUpc: UPC,
        outcome: 'found', confidence: 0.9, evidenceUrl: null, matchedFields: ['upc', 'name'],
        identityJson: JSON.stringify({ upc: UPC, name: 'Remedy Kibble 5lb', brand: 'Brand R', weight: '10 lbs' }),
        warningsJson: null, errorCode: null, errorMessage: null,
        catalogVersion: 'v2026.3', observedAt: '2026-08-13T00:00:00.000Z', sourcingGenerationId: generationId,
      });
      recordAcceptances(itemId, [att.id], 'system', 'test');

      const projection = buildDistributorRecordProjection({
        itemId, itemUpc: UPC, sourcingGenerationId: generationId, attempts: [att], acceptedAttemptIds: [att.id],
      });
      expect(projection.qualified).toBe(true);
      if (!projection.qualified) return;
      const decision: never = {
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
      } as never;
      const res = completeSourcingWithDecision(itemId, decision as never, 'collect_details');
      expect(res.ok).toBe(true);
      updateItemStageStatus(itemId, 'in_progress');

      // Corrupt the persisted decision hash BEFORE materialization.
      const routed = findItemById(itemId);
      const routedDecision = routed?.sourcingDecision as Record<string, unknown>;
      getDb().query('UPDATE onboarding_items SET sourcing_decision_json = ? WHERE id = ?').run(
        JSON.stringify({ ...routedDecision, evidenceHash: 'f'.repeat(64) }),
        itemId,
      );

      const result = materializeDistributorRecordExtraction(itemId, WS);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.hash_mismatch);
      // Zero partial writes: no extraction row, no payload, still in_progress.
      const rows = getDb().query('SELECT * FROM onboarding_extractions WHERE item_id = ?').all(itemId) as unknown[];
      expect(rows.length).toBe(0);
      expect(findItemById(itemId)?.extractionData).toBeNull();
      // The official URL/profile path was never touched.
      expect(findItemById(itemId)?.sourceUrl).toBeNull();

      // The WORKER marks the item extraction/failed with the stable code
      // (the materializer itself never writes on integrity failure).
      updateItemStageStatus(itemId, 'failed', 'distributor_materialization:hash_mismatch');
      expect(findItemById(itemId)?.errorMessage).toContain('distributor_materialization:hash_mismatch');

      // Explicit operator fallback: Continue with Official Site Discovery.
      const fallback = revertToOfficialDiscovery(itemId, WS);
      expect(fallback.ok).toBe(true);
      const after = findItemById(itemId);
      expect(after?.stage).toBe('discovery');
      expect(after?.stageStatus).toBe('pending');
      expect(after?.sourceType).toBe('official_page');
      expect(after?.sourceUrl).toBeNull();
      expect(after?.extractionData).toBeNull();
      // Immutable sourcing evidence is preserved.
      const attempts = getDb().query('SELECT * FROM onboarding_evidence_attempts WHERE item_id = ?').all(itemId) as unknown[];
      expect(attempts.length).toBe(1);
      const gens = getDb().query('SELECT * FROM sourcing_generations WHERE item_id = ?').all(itemId) as unknown[];
      expect(gens.length).toBe(1);
      const acceptances = getDb().query('SELECT * FROM onboarding_item_evidence_acceptances WHERE item_id = ?').all(itemId) as unknown[];
      expect(acceptances.length).toBe(1);
      const decisions = getDb().query('SELECT sourcing_decision_json FROM onboarding_items WHERE id = ?').get(itemId) as { sourcing_decision_json: string };
      expect(JSON.parse(decisions.sourcing_decision_json).route).toBe('fallback_to_discovery');
    });

    test('revertToOfficialDiscovery refuses non-distributor, wrong-stage, and foreign-workspace items', async () => {
      const { revertToOfficialDiscovery } = await import('../../db/repositories/onboarding-item-repo');
      const { findItemById } = await import('../../db/repositories/onboarding-item-repo');
      // The routed item from the previous test is now at discovery/official.
      expect(revertToOfficialDiscovery(itemId, WS).ok).toBe(false); // not_distributor_source
      expect(revertToOfficialDiscovery(itemId, 'other-ws').ok).toBe(false);
      const after = findItemById(itemId);
      expect(after?.stage).toBe('discovery');
    });

    test('revert preserves a prior extraction row and conflict rows, and writes a strict V2 decision', async () => {
      const { insertWorkspace } = await import('../../db/repositories/workspace-repo');
      const { createBatch } = await import('../../db/repositories/onboarding-batch-repo');
      const { insertItems, findItemById, completeSourcingWithDecision, updateItemStageStatus, revertToOfficialDiscovery } = await import('../../db/repositories/onboarding-item-repo');
      const { startSourcingGeneration, insertEvidenceAttempt } = await import('../../db/repositories/onboarding-evidence-repo');
      const { recordAcceptances } = await import('../../db/repositories/onboarding-acceptance-repo');
      const { createDistributor, createConnection } = await import('../../db/repositories/distributor-repo');
      const { SOURCING_ENTRY_POLICY_VERSION } = await import('../../onboarding/sourcing/entry-policy');
      const { buildDistributorRecordProjection } = await import('../../onboarding/sourcing/distributor-record-projection');
      const { materializeDistributorRecordExtraction } = await import('../../onboarding/sourcing/distributor-record-materializer');
      const { SourcingDecisionV2Schema } = await import('../../shared/schemas/onboarding');

      insertWorkspace({ id: 'ws-remedy-2', name: 'Remedy WS2', workspacePath: '/tmp/remedy2', gitPath: '/tmp/remedy2/.git', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null } as never);
      const batch = createBatch({ workspaceId: 'ws-remedy-2', name: 'Remedy Batch 2', fileName: 'r2.csv', totalItems: 1 });
      const [item] = insertItems(batch.id, [{ upc: '019288889999', name: 'Remedy Kibble 2', rowNumber: 1, stage: 'sourcing' }], 'sourcing', SOURCING_ENTRY_POLICY_VERSION);
      const gen = startSourcingGeneration(item.id, 'automatic');

      createDistributor({ id: 'unfi', name: 'unfi', status: 'active' });
      const conn = createConnection({ workspaceId: 'ws-remedy-2', distributorId: 'unfi', connectorType: 'api' });
      const att = insertEvidenceAttempt({
        itemId: item.id, providerId: 'unfi', distributorConnectionId: conn.id, lookupUpc: item.upc,
        outcome: 'found', confidence: 0.9, evidenceUrl: null, matchedFields: ['upc', 'name'],
        identityJson: JSON.stringify({ upc: item.upc, name: 'Remedy Kibble 2', brand: 'Brand R', weight: '10 lbs' }),
        warningsJson: null, errorCode: null, errorMessage: null,
        catalogVersion: 'v2026.3', observedAt: '2026-08-13T00:00:00.000Z', sourcingGenerationId: gen.id,
      });
      recordAcceptances(item.id, [att.id], 'system', 'test');
      const projection = buildDistributorRecordProjection({
        itemId: item.id, itemUpc: item.upc, sourcingGenerationId: gen.id, attempts: [att], acceptedAttemptIds: [att.id],
      });
      expect(projection.qualified).toBe(true);
      if (!projection.qualified) return;
      const decision: never = {
        schemaVersion: 2,
        route: 'distributor_record_to_extraction',
        origin: 'automatic_policy',
        acceptedEvidenceAttemptIds: projection.acceptedAttemptIds,
        providerIds: projection.providerIds,
        sourcingGenerationId: gen.id,
        conflicts: [],
        warnings: [],
        decidedAt: new Date().toISOString(),
        evidenceHash: projection.evidenceHash,
        sourceType: 'distributor_record',
        target: 'extraction',
      } as never;
      const routed = completeSourcingWithDecision(item.id, decision, 'collect_details');
      expect(routed.ok).toBe(true);
      updateItemStageStatus(item.id, 'in_progress');
      const materialized = materializeDistributorRecordExtraction(item.id, 'ws-remedy-2');
      expect(materialized.ok).toBe(true);
      // A durable conflict row that the revert must preserve.
      getDb().query(
        `INSERT INTO onboarding_evidence_conflicts
          (id, item_id, field, severity, status, sourcing_generation_id, created_at)
         VALUES ('remedy-conflict', ?, 'weight', 'hard', 'resolved', ?, ?)`,
      ).run(item.id, gen.id, new Date().toISOString());

      const fallback = revertToOfficialDiscovery(item.id, 'ws-remedy-2');
      expect(fallback.ok).toBe(true);

      // Prior extraction audit row + conflict rows survive the revert.
      const extractionRows = getDb().query('SELECT * FROM onboarding_extractions WHERE item_id = ?').all(item.id) as unknown[];
      expect(extractionRows.length).toBe(1);
      const conflictRows = getDb().query('SELECT * FROM onboarding_evidence_conflicts WHERE item_id = ?').all(item.id) as unknown[];
      expect(conflictRows.length).toBe(1);
      // The replacement decision validates as a strict V2 fallback_to_discovery.
      const decisionRow = getDb().query('SELECT sourcing_decision_json FROM onboarding_items WHERE id = ?').get(item.id) as { sourcing_decision_json: string };
      const written = JSON.parse(decisionRow.sourcing_decision_json);
      const v2 = SourcingDecisionV2Schema.safeParse(written);
      expect(v2.success).toBe(true);
      if (v2.success) {
        expect(v2.data.route).toBe('fallback_to_discovery');
        expect(v2.data.origin).toBe('operator_override');
        expect(v2.data.schemaVersion).toBe(2);
      }
      const after = findItemById(item.id);
      expect(after?.stage).toBe('discovery');
      expect(after?.sourceType).toBe('official_page');
    });
  });
});
