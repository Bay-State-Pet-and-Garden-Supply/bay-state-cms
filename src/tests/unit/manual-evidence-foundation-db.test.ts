// Ticket #102 (parent #101) — manual-evidence foundation, DB lane.
// Uses bun:sqlite via the repository layer: run under `bun test` via the
// test:db script (vitest cannot collect bun:sqlite suites).
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertExtraction } from '../../db/repositories/onboarding-extraction-repo';
import {
  createManualEvidenceAttestation,
  getManualEvidenceAttestation,
  getActiveManualEvidenceAttestationForItem,
  listManualEvidenceAttestationsForItem,
  supersedeManualEvidenceAttestation,
  verifyManualEvidenceAttestationHash,
  getManualEvidenceObservation,
  hashManualEvidenceFieldValue,
} from '../../db/repositories/onboarding-manual-evidence-repo';

const TEST_DB = 'src/tests/unit/manual-evidence-foundation-db-test.db';

function seedItem(itemId: string): void {
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
  db.query(
    `INSERT INTO onboarding_items (id, batch_id, upc, name, row_number, created_at, updated_at)
     VALUES (?, 'b1', 'upc-1', 'Seed Item', 1, ?, ?)`,
  ).run(itemId, now, now);
}

beforeAll(() => {
  try {
    resetDb();
  } catch {
    /* ok */
  }
  initDb(TEST_DB);
  runMigrations();
  seedItem('item-foundation-1');
});

afterAll(() => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      unlinkSync(`${TEST_DB}${suffix}`);
    } catch {
      /* ok */
    }
  }
});

describe('official_page does not prove automated extraction ran (audit)', () => {
  test('official_page extraction accepts any method with a URL (no profile gate)', () => {
    const row = insertExtraction({
      itemId: 'item-foundation-1',
      sourceUrl: 'https://brand.example.com/products/widget',
      extractionDataJson: JSON.stringify({ title: 'Widget' }),
      confidence: 0.5,
      extractionMethod: 'arbitrary_future_method_without_profile',
    });
    expect(row.source_type).toBe('official_page');
    expect(row.source_url).toBe('https://brand.example.com/products/widget');
  });

  test('official_page still fails closed without a URL', () => {
    expect(() =>
      insertExtraction({
        itemId: 'item-foundation-1',
        sourceUrl: '   ',
        extractionDataJson: '{}',
        confidence: 0,
        extractionMethod: 'profile_selector',
      }),
    ).toThrow(/non-empty source URL/);
  });

  test('distributor_record still requires a NULL URL (never fabricated)', () => {
    // Intentionally bypasses the input union (which already forbids a URL)
    // to prove the runtime guard also fails closed for untyped callers.
    const badInput = {
      itemId: 'item-foundation-1',
      sourceType: 'distributor_record',
      sourceUrl: 'https://brand.example.com/products/widget',
      extractionMethod: 'distributor_record_v1',
      sourcingGenerationId: 'gen-1',
      acceptedEvidenceAttemptIds: ['a1'],
      evidenceHash: 'b'.repeat(64),
    } as unknown as Parameters<typeof insertExtraction>[0];
    expect(() => insertExtraction(badInput)).toThrow(/NULL source URL/);
  });
});

describe('migration adds attestation store without touching behavior', () => {
  test('creates the attestation table, columns, and marker', () => {
    const db = getDb();
    const table = db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'onboarding_manual_evidence_attestations'",
      )
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('onboarding_manual_evidence_attestations');
    const extCols = db.query('PRAGMA table_info(onboarding_extractions)').all() as Array<{
      name: string;
    }>;
    expect(extCols.some((c) => c.name === 'manual_attestation_id')).toBe(true);
    const itemCols = db.query('PRAGMA table_info(onboarding_items)').all() as Array<{
      name: string;
    }>;
    expect(itemCols.some((c) => c.name === 'manual_reference_url')).toBe(true);
    const marker = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('manual_evidence_schema_version') as { value: string } | undefined;
    expect(marker?.value).toBe('1');
    const ddl = db
      .query(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'onboarding_extractions'",
      )
      .get() as { sql: string };
    expect(ddl.sql).toContain("'official_page'");
    expect(ddl.sql).toContain("'distributor_record'");
  });

  test('observation counts start at zero on a fresh database', () => {
    expect(getManualEvidenceObservation()).toEqual({
      attestationCount: 0,
      activeAttestationCount: 0,
      manualExtractionCount: 0,
      coveredItemCount: 0,
      uncoveredAttestationCount: 0,
    });
  });
});

describe('attestation store with hash-match discipline', () => {
  test('creates, reads, verifies, and withdraws an attestation', () => {
    const fieldValues = { title: 'Butcher Pup Beef Bites', brand: 'The Butcher\u2019s Pup' };
    const created = createManualEvidenceAttestation({
      itemId: 'item-foundation-1',
      batchId: 'b1',
      operatorId: 'op-1',
      fieldValues,
      fieldSources: {
        title: { sourceKind: 'operator_transcription' },
        brand: { sourceKind: 'packaging_photo' },
      },
      familyReferenceUrl: 'https://butchers-pup.example.com/shop',
      notes: 'transcribed from package',
    });
    expect(created.attestation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.family_reference_url).toBe('https://butchers-pup.example.com/shop');

    const fetched = getManualEvidenceAttestation(created.attestation_id);
    expect(fetched?.item_id).toBe('item-foundation-1');

    expect(getActiveManualEvidenceAttestationForItem('item-foundation-1')?.attestation_id).toBe(
      created.attestation_id,
    );
    expect(listManualEvidenceAttestationsForItem('item-foundation-1')).toHaveLength(1);

    // Hash-match: identical payload verifies, tampered payload refuses.
    expect(verifyManualEvidenceAttestationHash(created.attestation_id, fieldValues)).toBe(true);
    expect(
      verifyManualEvidenceAttestationHash(created.attestation_id, {
        ...fieldValues,
        title: 'Tampered Title',
      }),
    ).toBe(false);
    expect(
      verifyManualEvidenceAttestationHash(created.attestation_id, {
        title: 'Butcher Pup Beef Bites',
      }),
    ).toBe(false);

    const obs = getManualEvidenceObservation();
    expect(obs.attestationCount).toBe(1);
    expect(obs.activeAttestationCount).toBe(1);
    expect(obs.manualExtractionCount).toBe(0);
    expect(obs.uncoveredAttestationCount).toBe(1);

    expect(supersedeManualEvidenceAttestation(created.attestation_id)).toBe(true);
    expect(getActiveManualEvidenceAttestationForItem('item-foundation-1')).toBeNull();
    expect(() =>
      verifyManualEvidenceAttestationHash(created.attestation_id, fieldValues),
    ).toThrow(/superseded/);
  });

  test('rejects missing checklist entries, bad source kinds, and bad URLs', () => {
    expect(() =>
      createManualEvidenceAttestation({
        itemId: 'item-foundation-1',
        operatorId: 'op-1',
        fieldValues: {},
        fieldSources: {},
      }),
    ).toThrow(/at least one field value/);
    expect(() =>
      createManualEvidenceAttestation({
        itemId: 'item-foundation-1',
        operatorId: 'op-1',
        fieldValues: { title: 'X' },
        fieldSources: {},
      }),
    ).toThrow(/missing checklist entry/);
    expect(() =>
      createManualEvidenceAttestation({
        itemId: 'item-foundation-1',
        operatorId: 'op-1',
        fieldValues: { title: 'X' },
        fieldSources: { title: { sourceKind: 'scraped' as never } },
      }),
    ).toThrow(/invalid source kind/);
    expect(() =>
      createManualEvidenceAttestation({
        itemId: 'item-foundation-1',
        operatorId: 'op-1',
        fieldValues: { title: 'X' },
        fieldSources: { title: { sourceKind: 'operator_transcription' } },
        familyReferenceUrl: 'not-a-url',
      }),
    ).toThrow(/invalid family reference URL/);
    expect(() =>
      createManualEvidenceAttestation({
        itemId: '',
        operatorId: 'op-1',
        fieldValues: { title: 'X' },
        fieldSources: { title: { sourceKind: 'operator_transcription' } },
      }),
    ).toThrow(/item id/);
  });

  test('hashes are canonical (key order independent) and 64-hex', () => {
    const a = hashManualEvidenceFieldValue({ z: 1, a: [1, 2] });
    const b = hashManualEvidenceFieldValue({ a: [1, 2], z: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});
