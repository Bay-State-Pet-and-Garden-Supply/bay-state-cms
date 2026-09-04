// Ticket #103 (parent #101) — thin manual-evidence slice, DB lane.
// Uses bun:sqlite via the repository layer: run under `bun test` via the
// test:db script (vitest cannot collect bun:sqlite suites).
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  insertExtraction,
  getLatestExtraction,
} from '../../db/repositories/onboarding-extraction-repo';
import {
  getActiveManualEvidenceAttestationForItem,
} from '../../db/repositories/onboarding-manual-evidence-repo';
import {
  overrideManualEvidenceFlags,
  resetManualEvidenceFlagsOverride,
} from '../../onboarding/flags';
import {
  submitManualEvidence,
  withdrawManualEvidence,
} from '../../onboarding/manual-evidence-service';
import { buildManualEvidenceEntries } from '../../classification/stages/evidence-extraction';
import { validateManualEvidenceForReview } from '../../classification/review-completion-gate';

const TEST_DB = 'src/tests/unit/manual-evidence-thin-slice-db-test.db';

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

function seedItem(itemId: string, overrides?: { stage?: string; stageStatus?: string; errorMessage?: string | null; sourceUrl?: string | null }): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO onboarding_items (id, batch_id, upc, name, row_number, stage, stage_status, error_message, source_url, created_at, updated_at)
     VALUES (?, 'b1', ?, 'Seed Item', 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    itemId,
    `upc-${itemId}`,
    overrides?.stage ?? 'extraction',
    overrides?.stageStatus ?? 'failed',
    overrides?.errorMessage === undefined ? 'No extractor profile for butcherspup.example.com' : overrides.errorMessage,
    overrides?.sourceUrl === undefined ? null : overrides.sourceUrl,
    now,
    now,
  );
}

const OPERATOR = 'operator-1';
const noProfile = { findProfileByDomain: (_domain: string) => null };
const healthyProfile = { findProfileByDomain: (_domain: string) => ({}) };

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

describe('thin slice: title-only blocked item end to end', () => {
  test('submit completes extraction with manual provenance, null URL, insufficient identity', () => {
    seedItem('item-submit-1');
    const result = submitManualEvidence(
      {
        itemId: 'item-submit-1',
        workspaceId: 'ws-1',
        operatorId: OPERATOR,
        title: 'Butcher Pup Chicken Recipe',
        attestation: { noFamilyInheritance: true, perSkuVerified: true, rightsAttested: true },
      },
      noProfile,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attestationId.length).toBeGreaterThan(0);

    const row = getLatestExtraction('item-submit-1')!;
    expect(row.extraction_method).toBe('manual_evidence_v1');
    expect(row.source_type).toBe('official_page');
    expect(row.source_url).toBeNull();
    expect(row.sourcing_generation_id).toBeNull();
    expect(row.evidence_hash).toBeNull();
    expect(row.confidence).toBe(0);

    const data = JSON.parse(row.extraction_data_json) as Record<string, unknown>;
    expect(data.sourceType).toBe('official_page');
    expect(data.sourceUrl).toBeNull();
    expect(data.confidence).toBe(0);
    expect(data.identityStatus).toBe('insufficient_evidence');
    expect(Array.isArray(data.identityReasons) && (data.identityReasons as string[]).length > 0).toBe(true);
    expect((data.fieldProvenance as Record<string, string>).title).toBe('user');
    expect(data.manualEvidenceAttestationId).toBe(result.attestationId);
    expect(data.manualReferenceUrl).toBeNull();

    const item = getDb().query('SELECT stage, stage_status, error_message, manual_reference_url FROM onboarding_items WHERE id = ?').get('item-submit-1') as {
      stage: string; stage_status: string; error_message: string | null; manual_reference_url: string | null;
    };
    expect(item.stage).toBe('extraction');
    expect(item.stage_status).toBe('completed');
    expect(item.error_message).toBeNull();
    expect(item.manual_reference_url).toBeNull();

    const attestation = getActiveManualEvidenceAttestationForItem('item-submit-1');
    expect(attestation?.attestation_id).toBe(result.attestationId);
  });

  test('submit with a family reference records parent-only identity + reference-only URL', () => {
    seedItem('item-submit-2');
    const result = submitManualEvidence(
      {
        itemId: 'item-submit-2',
        workspaceId: 'ws-1',
        operatorId: OPERATOR,
        title: 'Butcher Pup Beef Recipe',
        brand: 'The Butcher\u2019s Pup',
        familyReferenceUrl: 'https://butcherspup.example.com/family-treats',
        attestation: { noFamilyInheritance: true, perSkuVerified: true, rightsAttested: true },
      },
      noProfile,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = getLatestExtraction('item-submit-2')!;
    const data = JSON.parse(row.extraction_data_json) as Record<string, unknown>;
    expect(data.identityStatus).toBe('parent_product_only');
    expect(data.manualReferenceUrl).toBe('https://butcherspup.example.com/family-treats');
    expect((data.fieldProvenance as Record<string, string>).brand).toBe('user');
    const item = getDb().query('SELECT manual_reference_url FROM onboarding_items WHERE id = ?').get('item-submit-2') as { manual_reference_url: string | null };
    expect(item.manual_reference_url).toBe('https://butcherspup.example.com/family-treats');
  });

  test('double submit is an idempotent replay (no second row)', () => {
    seedItem('item-replay-1');
    const first = submitManualEvidence(
      { itemId: 'item-replay-1', workspaceId: 'ws-1', operatorId: OPERATOR, title: 'Replay Title', attestation: { noFamilyInheritance: true, perSkuVerified: true, rightsAttested: true } },
      noProfile,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = submitManualEvidence(
      { itemId: 'item-replay-1', workspaceId: 'ws-1', operatorId: OPERATOR, title: 'Replay Title', attestation: { noFamilyInheritance: true, perSkuVerified: true, rightsAttested: true } },
      noProfile,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.attestationId).toBe(first.attestationId);
    expect(second.extractionId).toBe(first.extractionId);
    const count = getDb().query(
      `SELECT COUNT(*) AS n FROM onboarding_extractions WHERE item_id = ? AND extraction_method = 'manual_evidence_v1'`,
    ).get('item-replay-1') as { n: number };
    expect(count.n).toBe(1);
  });

  test('withdraw restores the blocked state and supersedes the attestation', () => {
    seedItem('item-withdraw-1');
    const submitted = submitManualEvidence(
      { itemId: 'item-withdraw-1', workspaceId: 'ws-1', operatorId: OPERATOR, title: 'Withdraw Me', attestation: { noFamilyInheritance: true, perSkuVerified: true, rightsAttested: true } },
      noProfile,
    );
    expect(submitted.ok).toBe(true);
    const withdrawn = withdrawManualEvidence({ itemId: 'item-withdraw-1', workspaceId: 'ws-1', operatorId: OPERATOR });
    expect(withdrawn.ok).toBe(true);
    const item = getDb().query('SELECT stage, stage_status, error_message FROM onboarding_items WHERE id = ?').get('item-withdraw-1') as {
      stage: string; stage_status: string; error_message: string | null;
    };
    expect(item.stage).toBe('extraction');
    expect(item.stage_status).toBe('failed');
    expect(item.error_message).toMatch(/No extractor profile/);
    expect(getActiveManualEvidenceAttestationForItem('item-withdraw-1')).toBeNull();
  });
});

describe('thin slice: fail-closed entries', () => {
  test('flag OFF hides the entire path', () => {
    seedItem('item-flagoff-1');
    overrideManualEvidenceFlags({ enabled: false });
    try {
      const result = submitManualEvidence(
        { itemId: 'item-flagoff-1', workspaceId: 'ws-1', operatorId: OPERATOR, title: 'Nope', attestation: { noFamilyInheritance: true, perSkuVerified: true, rightsAttested: true } },
        noProfile,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('manual_evidence_disabled');
    } finally {
      overrideManualEvidenceFlags({ enabled: true });
    }
  });

  test('sourcing, discovery, and never-attempted items are rejected with distinct codes', () => {
    seedItem('item-rej-sourcing', { stage: 'sourcing', stageStatus: 'pending', errorMessage: null });
    seedItem('item-rej-discovery', { stage: 'discovery', stageStatus: 'failed', errorMessage: 'No extractor profile for butcherspup.example.com' });
    seedItem('item-rej-pending', { stage: 'extraction', stageStatus: 'pending', errorMessage: null });
    for (const [id, code] of [['item-rej-sourcing', 'sourcing_curation_bypass_rejected'], ['item-rej-discovery', 'discovery_to_manual_rejected'], ['item-rej-pending', 'extraction_never_attempted']] as const) {
      const result = submitManualEvidence(
        { itemId: id, workspaceId: 'ws-1', operatorId: OPERATOR, title: 'Nope', attestation: { noFamilyInheritance: true, perSkuVerified: true, rightsAttested: true } },
        noProfile,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(code);
    }
  });

  test('non-profile failure without triage is rejected; triage confirms it', () => {
    seedItem('item-rej-triage', { errorMessage: 'HTTP timeout' });
    const untriaged = submitManualEvidence(
      { itemId: 'item-rej-triage', workspaceId: 'ws-1', operatorId: OPERATOR, title: 'Nope', attestation: { noFamilyInheritance: true, perSkuVerified: true, rightsAttested: true } },
      noProfile,
    );
    expect(untriaged.ok).toBe(false);
    const triaged = submitManualEvidence(
      { itemId: 'item-rej-triage', workspaceId: 'ws-1', operatorId: OPERATOR, title: 'Triaged Title', familyPageOnlyConfirmed: true, attestation: { noFamilyInheritance: true, perSkuVerified: true, rightsAttested: true } },
      noProfile,
    );
    expect(triaged.ok).toBe(true);
  });

  test('healthy profile at submit time forces profile retry, not manual', () => {
    seedItem('item-rej-profile');
    const result = submitManualEvidence(
      { itemId: 'item-rej-profile', workspaceId: 'ws-1', operatorId: OPERATOR, title: 'Nope', attestation: { noFamilyInheritance: true, perSkuVerified: true, rightsAttested: true } },
      healthyProfile,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('profile_now_healthy');
  });

  test('missing title and missing attestation booleans are rejected', () => {
    seedItem('item-rej-title');
    const noTitle = submitManualEvidence(
      { itemId: 'item-rej-title', workspaceId: 'ws-1', operatorId: OPERATOR, title: '   ', attestation: { noFamilyInheritance: true, perSkuVerified: true, rightsAttested: true } },
      noProfile,
    );
    expect(noTitle.ok).toBe(false);
    const noAttest = submitManualEvidence(
      { itemId: 'item-rej-title', workspaceId: 'ws-1', operatorId: OPERATOR, title: 'Real Title', attestation: { noFamilyInheritance: false, perSkuVerified: true, rightsAttested: true } },
      noProfile,
    );
    expect(noAttest.ok).toBe(false);
    if (!noAttest.ok) expect(noAttest.code).toBe('manual_attestation_incomplete');
  });

  test('workspace mismatch is rejected', () => {
    seedItem('item-rej-ws');
    const result = submitManualEvidence(
      { itemId: 'item-rej-ws', workspaceId: 'ws-other', operatorId: OPERATOR, title: 'Nope', attestation: { noFamilyInheritance: true, perSkuVerified: true, rightsAttested: true } },
      noProfile,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('workspace_mismatch');
  });
});

describe('thin slice: repo invariants for manual rows', () => {
  test('manual insert persists the attestation link', () => {
    seedItem('item-repo-1');
    const row = insertExtraction({
      itemId: 'item-repo-1',
      sourceType: 'official_page',
      sourceUrl: null,
      extractionMethod: 'manual_evidence_v1',
      manualAttestationId: 'attest-1',
      extractionDataJson: JSON.stringify({
        sourceType: 'official_page',
        sourceUrl: null,
        confidence: 0,
        fieldProvenance: { title: 'user' },
        identityStatus: 'insufficient_evidence',
        identityReasons: ['operator manual transcription'],
        manualEvidenceAttestationId: 'attest-1',
        manualReferenceUrl: null,
      }),
      confidence: 0,
    } as unknown as Parameters<typeof insertExtraction>[0]);
    expect(row.extraction_method).toBe('manual_evidence_v1');
    const stored = getDb().query('SELECT manual_attestation_id FROM onboarding_extractions WHERE id = ?').get(row.id) as { manual_attestation_id: string | null };
    expect(stored.manual_attestation_id).toBe('attest-1');
  });

  test('manual insert rejects a source URL, missing attestation, and exact identity', () => {
    seedItem('item-repo-2');
    const base = {
      itemId: 'item-repo-2',
      sourceType: 'official_page' as const,
      extractionMethod: 'manual_evidence_v1',
      manualAttestationId: 'attest-2',
      confidence: 0,
    };
    expect(() =>
      insertExtraction({ ...base, sourceUrl: 'https://butcherspup.example.com/family', extractionDataJson: '{}' } as unknown as Parameters<typeof insertExtraction>[0]),
    ).toThrow(/NULL source URL/);
    expect(() =>
      insertExtraction({ ...base, sourceUrl: null, manualAttestationId: '', extractionDataJson: '{}' } as unknown as Parameters<typeof insertExtraction>[0]),
    ).toThrow(/attestation/);
    expect(() =>
      insertExtraction({
        ...base,
        sourceUrl: null,
        extractionDataJson: JSON.stringify({ identityStatus: 'exact_match', manualEvidenceAttestationId: 'attest-2' }),
      } as unknown as Parameters<typeof insertExtraction>[0]),
    ).toThrow(/exact_match|identity/);
  });
});

describe('thin slice: frozen evidence + review gate for manual rows', () => {
  test('manual entries emit operator-manual low-reliability evidence with null URL', () => {
    const entries = buildManualEvidenceEntries({
      title: 'Butcher Pup Chicken Recipe',
      brand: 'The Butcher\u2019s Pup',
      attestationId: 'attest-9',
      fieldProvenance: { title: 'user', brand: 'user' },
      manualReferenceUrl: 'https://butcherspup.example.com/family-treats',
    });
    expect(entries.length).toBe(2);
    for (const entry of entries) {
      expect(entry.source).toBe('operator_manual');
      expect(entry.reliability).toBe('low');
      expect(entry.sourceUrl).toBeNull();
      expect((entry.metadata as Record<string, unknown>).provenance).toBe('manual_evidence');
      expect((entry.metadata as Record<string, unknown>).attestationId).toBe('attest-9');
    }
    expect(entries.map((e) => e.sourceField).sort()).toEqual(['brand', 'name']);
  });

  test('review gate refuses manual rows without an active attestation', () => {
    seedItem('item-gate-1');
    insertExtraction({
      itemId: 'item-gate-1',
      sourceType: 'official_page',
      sourceUrl: null,
      extractionMethod: 'manual_evidence_v1',
      manualAttestationId: 'attest-orphan',
      extractionDataJson: JSON.stringify({ identityStatus: 'insufficient_evidence', manualEvidenceAttestationId: 'attest-orphan' }),
      confidence: 0,
    } as unknown as Parameters<typeof insertExtraction>[0]);
    const refused = validateManualEvidenceForReview('item-gate-1');
    expect(refused?.ok).toBe(false);
    if (refused && !refused.ok) expect(refused.code).toBe('manual_attestation_missing');
  });

  test('review gate passes manual rows with an active attestation and ignores automated rows', () => {
    seedItem('item-gate-2');
    const submitted = submitManualEvidence(
      { itemId: 'item-gate-2', workspaceId: 'ws-1', operatorId: OPERATOR, title: 'Gated Title', attestation: { noFamilyInheritance: true, perSkuVerified: true, rightsAttested: true } },
      noProfile,
    );
    expect(submitted.ok).toBe(true);
    expect(validateManualEvidenceForReview('item-gate-2')).toBeNull();
    seedItem('item-gate-3');
    insertExtraction({
      itemId: 'item-gate-3',
      sourceUrl: 'https://brand.example.com/p/1',
      extractionDataJson: JSON.stringify({ title: 'Auto' }),
      confidence: 0.5,
      extractionMethod: 'profile_selector',
    });
    expect(validateManualEvidenceForReview('item-gate-3')).toBeNull();
  });
});
