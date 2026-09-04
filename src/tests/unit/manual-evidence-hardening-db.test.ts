// Ticket #105 (parent #101) — fail-closed hardening, retry exclusion, no-backfill.
// Uses bun:sqlite via the repository layer: run under `bun test` (vitest
// cannot collect bun:sqlite suites).
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations, verifyManualEvidenceInvariants } from '../../db/migrations';
import { insertExtraction } from '../../db/repositories/onboarding-extraction-repo';
import {
  overrideManualEvidenceFlags,
  resetManualEvidenceFlagsOverride,
} from '../../onboarding/flags';
import {
  hasActiveManualEvidence,
  submitManualEvidence,
  withdrawManualEvidence,
} from '../../onboarding/manual-evidence-service';

const TEST_DB = 'src/tests/unit/manual-evidence-hardening-db-test.db';

function seedBatch(): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at)
     VALUES ('ws-1', 'ws', '/tmp/ws', '/tmp/ws/.git', ?, ?)`,
  ).run(now, now);
  db.query(
    `INSERT INTO onboarding_batches (id, workspace_id, name, file_name, created_at, updated_at)
     VALUES ('b1', 'ws-1', 'batch', 'batch.csv', ?, ?)`,
  ).run(now, now);
}

function seedItem(
  itemId: string,
  overrides?: { stage?: string; stageStatus?: string; errorMessage?: string | null },
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO onboarding_items (id, batch_id, upc, name, row_number, stage, stage_status, error_message, source_url, created_at, updated_at)
     VALUES (?, 'b1', ?, 'Seed Item', 1, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    itemId,
    `upc-${itemId}`,
    overrides?.stage ?? 'extraction',
    overrides?.stageStatus ?? 'failed',
    overrides?.errorMessage === undefined
      ? 'No extractor profile for butcherspup.example.com'
      : overrides.errorMessage,
    now,
    now,
  );
}

const OPERATOR = 'operator-1';
const noProfile = { findProfileByDomain: (_domain: string) => null };

function submitInput(itemId: string) {
  return {
    itemId,
    workspaceId: 'ws-1',
    operatorId: OPERATOR,
    title: 'Butcher Pup Beef Bites',
    attestation: { noFamilyInheritance: true, perSkuVerified: true, rightsAttested: true },
  };
}

beforeAll(() => {
  try {
    resetDb();
  } catch {
    /* ok */
  }
  initDb(TEST_DB);
  runMigrations();
  seedBatch();
  overrideManualEvidenceFlags({ enabled: true });
});

afterAll(() => {
  resetManualEvidenceFlagsOverride();
  closeDb();
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      unlinkSync(`${TEST_DB}${suffix}`);
    } catch {
      /* ok */
    }
  }
});

describe('hardening: every forbidden transition rejects with its distinct code', () => {
  test('sourcing item rejects with the bypass code (never reaches curation)', () => {
    seedItem('item-hard-sourcing', { stage: 'sourcing', stageStatus: 'pending' });
    const result = submitManualEvidence(submitInput('item-hard-sourcing'), noProfile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('sourcing_curation_bypass_rejected');
  });

  test('discovery item rejects with the discovery code', () => {
    seedItem('item-hard-discovery', { stage: 'discovery', stageStatus: 'pending' });
    const result = submitManualEvidence(submitInput('item-hard-discovery'), noProfile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('discovery_to_manual_rejected');
  });

  test('extraction/pending (never attempted) rejects with the never-attempted code', () => {
    seedItem('item-hard-pending', { stage: 'extraction', stageStatus: 'pending' });
    const result = submitManualEvidence(submitInput('item-hard-pending'), noProfile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('extraction_never_attempted');
  });

  test('curation and promotion items reject without touching extraction', () => {
    seedItem('item-hard-curation', { stage: 'curation', stageStatus: 'pending' });
    seedItem('item-hard-promotion', { stage: 'promotion', stageStatus: 'pending' });
    for (const itemId of ['item-hard-curation', 'item-hard-promotion']) {
      const result = submitManualEvidence(submitInput(itemId), noProfile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('extraction_not_failed');
      const count = getDb().query('SELECT COUNT(*) AS cnt FROM onboarding_extractions WHERE item_id = ?').get(itemId) as { cnt: number };
      expect(count.cnt).toBe(0);
    }
  });

  test('extraction/completed automated item rejects (no downgrade to manual)', () => {
    seedItem('item-hard-auto', { stage: 'extraction', stageStatus: 'completed' });
    const result = submitManualEvidence(submitInput('item-hard-auto'), noProfile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('extraction_not_failed');
  });
});

describe('hardening: repo never-stronger identity covers exact and probable', () => {
  test('probable_match on a manual row throws like exact_match', () => {
    seedItem('item-hard-probable');
    for (const identityStatus of ['exact_match', 'probable_match']) {
      expect(() =>
        insertExtraction({
          itemId: 'item-hard-probable',
          sourceType: 'official_page',
          sourceUrl: null,
          extractionMethod: 'manual_evidence_v1',
          manualAttestationId: 'attest-hard',
          extractionDataJson: JSON.stringify({
            identityStatus,
            manualEvidenceAttestationId: 'attest-hard',
          }),
          confidence: 0,
        } as unknown as Parameters<typeof insertExtraction>[0]),
      ).toThrow(/identity/);
    }
  });
});

describe('hardening: boot-time invariant verification', () => {
  test('a clean database passes verification', () => {
    expect(() => verifyManualEvidenceInvariants(getDb())).not.toThrow();
  });

  test('a manual row with a source URL fails boot verification', () => {
    seedItem('item-hard-badurl');
    const db = getDb();
    db.query(
      `INSERT INTO onboarding_extractions (id, item_id, source_url, extraction_data_json, extraction_method, confidence, source_type, manual_attestation_id, created_at)
       VALUES ('ext-hard-badurl', 'item-hard-badurl', 'https://butcherspup.example.com/family', '{}', 'manual_evidence_v1', 0, 'official_page', 'attest-hard', '2026-09-04T00:00:00.000Z')`,
    ).run();
    expect(() => verifyManualEvidenceInvariants(db)).toThrow(/NULL-URL|invariant/);
    db.query(`DELETE FROM onboarding_extractions WHERE id = 'ext-hard-badurl'`).run();
    expect(() => verifyManualEvidenceInvariants(db)).not.toThrow();
  });

  test('a manual row with a sourcing generation fails boot verification', () => {
    seedItem('item-hard-badgen');
    const db = getDb();
    db.query(
      `INSERT INTO onboarding_extractions (id, item_id, source_url, extraction_data_json, extraction_method, confidence, source_type, sourcing_generation_id, manual_attestation_id, created_at)
       VALUES ('ext-hard-badgen', 'item-hard-badgen', NULL, '{}', 'manual_evidence_v1', 0, 'official_page', 'gen-1', 'attest-hard', '2026-09-04T00:00:00.000Z')`,
    ).run();
    expect(() => verifyManualEvidenceInvariants(db)).toThrow(/invariant/);
    db.query(`DELETE FROM onboarding_extractions WHERE id = 'ext-hard-badgen'`).run();
  });

  test('an attestation with empty checklist JSON fails boot verification', () => {
    seedItem('item-hard-badatt');
    const db = getDb();
    db.query(
      `INSERT INTO onboarding_manual_evidence_attestations (attestation_id, item_id, operator_id, attested_at, field_checklist_json, value_hashes_json, created_at)
       VALUES ('attest-hard-bad', 'item-hard-badatt', 'op-1', '2026-09-04T00:00:00.000Z', '', '{}', '2026-09-04T00:00:00.000Z')`,
    ).run();
    expect(() => verifyManualEvidenceInvariants(db)).toThrow(/checklist/);
    db.query(`DELETE FROM onboarding_manual_evidence_attestations WHERE attestation_id = 'attest-hard-bad'`).run();
  });

  test('a manual row with a non-official source type fails boot verification', () => {
    seedItem('item-hard-badtype');
    const db = getDb();
    db.query(
      `INSERT INTO onboarding_extractions (id, item_id, source_url, extraction_data_json, extraction_method, confidence, source_type, manual_attestation_id, created_at)
       VALUES ('ext-hard-badtype', 'item-hard-badtype', NULL, '{}', 'manual_evidence_v1', 0, 'distributor_record', 'attest-hard', '2026-09-04T00:00:00.000Z')`,
    ).run();
    expect(() => verifyManualEvidenceInvariants(db)).toThrow(/invariant/);
    db.query(`DELETE FROM onboarding_extractions WHERE id = 'ext-hard-badtype'`).run();
    expect(() => verifyManualEvidenceInvariants(db)).not.toThrow();
  });

  test('a manual row with a NULL attestation link fails boot verification', () => {
    seedItem('item-hard-noatt');
    const db = getDb();
    db.query(
      `INSERT INTO onboarding_extractions (id, item_id, source_url, extraction_data_json, extraction_method, confidence, source_type, manual_attestation_id, created_at)
       VALUES ('ext-hard-noatt', 'item-hard-noatt', NULL, '{}', 'manual_evidence_v1', 0, 'official_page', NULL, '2026-09-04T00:00:00.000Z')`,
    ).run();
    expect(() => verifyManualEvidenceInvariants(db)).toThrow(/invariant/);
    db.query(`DELETE FROM onboarding_extractions WHERE id = 'ext-hard-noatt'`).run();
    expect(() => verifyManualEvidenceInvariants(db)).not.toThrow();
  });

  test('an attestation with invalid image-rights JSON fails boot verification', () => {
    seedItem('item-hard-badrights');
    const db = getDb();
    db.query(
      `INSERT INTO onboarding_manual_evidence_attestations (attestation_id, item_id, operator_id, attested_at, field_checklist_json, value_hashes_json, image_rights_json, created_at)
       VALUES ('attest-hard-badrights', 'item-hard-badrights', 'op-1', '2026-09-04T00:00:00.000Z', '{}', '{}', 'not-json', '2026-09-04T00:00:00.000Z')`,
    ).run();
    expect(() => verifyManualEvidenceInvariants(db)).toThrow(/image_rights/);
    db.query(`DELETE FROM onboarding_manual_evidence_attestations WHERE attestation_id = 'attest-hard-badrights'`).run();
    expect(() => verifyManualEvidenceInvariants(db)).not.toThrow();
  });

  test('an attestation with an oversized family-reference snapshot fails boot verification', () => {
    seedItem('item-hard-bigsnap');
    const db = getDb();
    const oversized = 'x'.repeat(8001);
    db.query(
      `INSERT INTO onboarding_manual_evidence_attestations (attestation_id, item_id, operator_id, attested_at, field_checklist_json, value_hashes_json, family_reference_text, created_at)
       VALUES ('attest-hard-bigsnap', 'item-hard-bigsnap', 'op-1', '2026-09-04T00:00:00.000Z', '{}', '{}', ?, '2026-09-04T00:00:00.000Z')`,
    ).run(oversized);
    expect(() => verifyManualEvidenceInvariants(db)).toThrow(/family_reference_text/);
    db.query(`DELETE FROM onboarding_manual_evidence_attestations WHERE attestation_id = 'attest-hard-bigsnap'`).run();
    expect(() => verifyManualEvidenceInvariants(db)).not.toThrow();
  });
});

describe('hardening: no backfill — legacy rows are never converted', () => {
  test('migrations create zero manual rows and legacy automated rows verify unchanged', () => {
    const db = getDb();
    const countManual = () =>
      (db.query("SELECT COUNT(*) AS cnt FROM onboarding_extractions WHERE extraction_method = 'manual_evidence_v1'").get() as { cnt: number }).cnt;
    // Snapshot the manual-row count first: other tests in this file create
    // manual rows in the shared fixture DB, so the assertion must pin that
    // THIS legacy seed changes nothing — not merely that the count is
    // non-negative (which passes vacuously).
    const manualBefore = countManual();
    seedItem('item-hard-legacy');
    insertExtraction({
      itemId: 'item-hard-legacy',
      sourceType: 'official_page',
      sourceUrl: 'https://butcherspup.example.com/beef-bites',
      extractionMethod: 'profile_selector',
      extractionDataJson: JSON.stringify({ identityStatus: 'exact_match' }),
      confidence: 0.9,
    } as unknown as Parameters<typeof insertExtraction>[0]);
    expect(() => verifyManualEvidenceInvariants(db)).not.toThrow();
    // The legacy automated row keeps its own method (never converted) and
    // the manual-row count is exactly unchanged by the legacy seed.
    const legacy = db.query('SELECT extraction_method FROM onboarding_extractions WHERE item_id = ?').get('item-hard-legacy') as { extraction_method: string };
    expect(legacy.extraction_method).toBe('profile_selector');
    expect(countManual()).toBe(manualBefore);
    const attestations = db.query('SELECT COUNT(*) AS cnt FROM onboarding_manual_evidence_attestations WHERE item_id = ?').get('item-hard-legacy') as { cnt: number };
    expect(attestations.cnt).toBe(0);
  });
});

describe('hardening: kill-switch never strands active-manual items (P0-1)', () => {
  test('withdraw succeeds with the flag OFF; submit stays gated', () => {
    seedItem('item-hard-killswitch');
    const submitted = submitManualEvidence(submitInput('item-hard-killswitch'), noProfile);
    expect(submitted.ok).toBe(true);
    expect(hasActiveManualEvidence('item-hard-killswitch')).toBe(true);
    // Kill switch: new submissions stop, but the operator can still back
    // out of the in-flight manual row to the fail-closed blocked state.
    overrideManualEvidenceFlags({ enabled: false });
    try {
      const blocked = submitManualEvidence(submitInput('item-hard-killswitch'), noProfile);
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.code).toBe('manual_evidence_disabled');
      const withdrawn = withdrawManualEvidence({ itemId: 'item-hard-killswitch', workspaceId: 'ws-1', operatorId: OPERATOR });
      expect(withdrawn.ok).toBe(true);
    } finally {
      overrideManualEvidenceFlags({ enabled: true });
    }
    expect(hasActiveManualEvidence('item-hard-killswitch')).toBe(false);
    const restored = getDb().query('SELECT stage_status FROM onboarding_items WHERE id = ?').get('item-hard-killswitch') as { stage_status: string };
    expect(restored.stage_status).toBe('failed');
  });
});

describe('hardening: retry exclusion with withdraw-then-retry', () => {
  test('manual-completed item reports active evidence (excluded from retry selection); withdraw clears it', () => {
    seedItem('item-hard-retry');
    expect(hasActiveManualEvidence('item-hard-retry')).toBe(false);
    const submitted = submitManualEvidence(submitInput('item-hard-retry'), noProfile);
    expect(submitted.ok).toBe(true);
    // The profile-retry preview lists extraction/failed only; a completed
    // manual item is structurally excluded while evidence is active.
    expect(hasActiveManualEvidence('item-hard-retry')).toBe(true);
    const item = getDb().query('SELECT stage_status FROM onboarding_items WHERE id = ?').get('item-hard-retry') as { stage_status: string };
    expect(item.stage_status).toBe('completed');
    const withdrawn = withdrawManualEvidence({ itemId: 'item-hard-retry', workspaceId: 'ws-1', operatorId: OPERATOR });
    expect(withdrawn.ok).toBe(true);
    expect(hasActiveManualEvidence('item-hard-retry')).toBe(false);
    const restored = getDb().query('SELECT stage_status, error_message FROM onboarding_items WHERE id = ?').get('item-hard-retry') as { stage_status: string; error_message: string };
    expect(restored.stage_status).toBe('failed');
    expect(restored.error_message).toMatch(/profile|withdrawn/);
  });
});
