// Ticket #104 (parent #101) — full manual fact set, DB lane.
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
} from '../../onboarding/manual-evidence-service';
import { buildManualEvidenceEntries } from '../../classification/stages/evidence-extraction';
import { validateManualEvidenceForReview } from '../../classification/review-completion-gate';

const TEST_DB = 'src/tests/unit/manual-evidence-full-set-db-test.db';

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
const ATTEST = { noFamilyInheritance: true, perSkuVerified: true, rightsAttested: true } as const;

function fullSubmit(itemId: string, overrides?: Record<string, unknown>) {
  return submitManualEvidence(
    {
      itemId,
      workspaceId: 'ws-1',
      operatorId: OPERATOR,
      title: 'Butcher\u2019s Pup Chicken Recipe 2lb',
      brand: 'The Butcher\u2019s Pup',
      description: 'Oven-baked chicken treats for small dogs.',
      bulletPoints: ['Grain free', 'Oven baked daily'],
      weight: '32 oz',
      dimensions: '8 x 6 x 2 in',
      primaryImage: 'https://cdn.example.com/pup-primary.jpg',
      additionalImages: ['https://cdn.example.com/pup-alt.jpg'],
      fieldSources: { description: 'packaging_photo', weight: 'distributor_sheet' },
      imageApprovals: [
        { imageUrl: 'https://cdn.example.com/pup-primary.jpg', rightsAttested: true as const },
        { imageUrl: 'https://cdn.example.com/pup-alt.jpg', rightsAttested: true as const },
      ],
      familyReferenceUrl: 'https://butcherspup.example.com/family-treats',
      attestation: { ...ATTEST },
      ...overrides,
    } as Parameters<typeof submitManualEvidence>[0],
    noProfile,
  );
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

describe('full set: migration v2 columns', () => {
  test('attestation table carries image-rights + snapshot columns; schema version is 2', () => {
    const cols = getDb().query('PRAGMA table_info(onboarding_manual_evidence_attestations)').all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('image_rights_json');
    expect(names).toContain('family_reference_text');
    const version = getDb().query('SELECT value FROM app_meta WHERE key = ?').get('manual_evidence_schema_version') as { value: string };
    expect(version.value).toBe('2');
  });
});

describe('full set: full-field submission end to end', () => {
  test('persists every field with user provenance, canonical weight, approvals, and passes the gate', () => {
    seedItem('full-happy-1');
    const result = fullSubmit('full-happy-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = getLatestExtraction('full-happy-1')!;
    expect(row.extraction_method).toBe('manual_evidence_v1');
    expect(row.source_url).toBeNull();
    expect(row.sourcing_generation_id).toBeNull();
    const data = JSON.parse(row.extraction_data_json) as Record<string, unknown>;
    expect(data.title).toBe('Butcher\u2019s Pup Chicken Recipe 2lb');
    expect(data.description).toBe('Oven-baked chicken treats for small dogs.');
    expect(data.bulletPoints).toEqual(['Grain free', 'Oven baked daily']);
    // 32 oz canonicalized to lbs (plan §6).
    expect(data.weight).toBe('2');
    expect(data.dimensions).toBe('8 x 6 x 2 in');
    expect(data.primaryImage).toBe('https://cdn.example.com/pup-primary.jpg');
    expect(data.additionalImages).toEqual(['https://cdn.example.com/pup-alt.jpg']);
    expect(data.identityStatus).toBe('parent_product_only');
    const provenance = data.fieldProvenance as Record<string, string>;
    for (const field of ['title', 'brand', 'description', 'bulletPoints', 'weight', 'dimensions', 'primaryImage', 'additionalImages']) {
      expect(provenance[field]).toBe('user');
    }

    const attestation = getActiveManualEvidenceAttestationForItem('full-happy-1')!;
    const checklist = JSON.parse(attestation.field_checklist_json) as Record<string, { sourceKind: string }>;
    expect(checklist.description.sourceKind).toBe('packaging_photo');
    expect(checklist.weight.sourceKind).toBe('distributor_sheet');
    expect(checklist.title.sourceKind).toBe('operator_transcription');
    const rights = JSON.parse(attestation.image_rights_json!) as Array<{ imageUrl: string; rightsAttested: boolean; approvalOrigin: string }>;
    expect(rights.map((r) => r.imageUrl).sort()).toEqual(
      ['https://cdn.example.com/pup-alt.jpg', 'https://cdn.example.com/pup-primary.jpg'],
    );
    for (const right of rights) {
      expect(right.rightsAttested).toBe(true);
      expect(right.approvalOrigin).toBe('operator_review');
    }

    const entries = buildManualEvidenceEntries({
      title: data.title as string,
      brand: data.brand as string,
      description: data.description as string,
      bulletPoints: data.bulletPoints as string[],
      weight: data.weight as string,
      dimensions: data.dimensions as string,
      primaryImage: data.primaryImage as string,
      additionalImages: data.additionalImages as string[],
      attestationId: result.attestationId,
      fieldProvenance: provenance,
      manualReferenceUrl: data.manualReferenceUrl as string,
    });
    expect(entries.map((e) => e.sourceField).sort()).toEqual(
      ['additional_image', 'brand', 'bullet_point', 'bullet_point', 'description', 'dimensions', 'name', 'primary_image', 'weight'],
    );
    for (const entry of entries) {
      expect(entry.source).toBe('operator_manual');
      expect(entry.reliability).toBe('low');
      expect(entry.sourceUrl).toBeNull();
    }

    expect(validateManualEvidenceForReview('full-happy-1')).toBeNull();
  });

  test('title-only submissions from the prior slice keep working unchanged', () => {
    seedItem('full-regress-1');
    const result = submitManualEvidence(
      { itemId: 'full-regress-1', workspaceId: 'ws-1', operatorId: OPERATOR, title: 'Plain Title', attestation: { ...ATTEST } },
      noProfile,
    );
    expect(result.ok).toBe(true);
    expect(validateManualEvidenceForReview('full-regress-1')).toBeNull();
    const entries = buildManualEvidenceEntries({
      title: 'Plain Title',
      brand: null,
      attestationId: 'x',
      fieldProvenance: { title: 'user' },
      manualReferenceUrl: null,
    });
    expect(entries.length).toBe(1);
  });

  test('unparseable weight omits the field instead of persisting raw text', () => {
    seedItem('full-weight-1');
    const result = fullSubmit('full-weight-1', { weight: 'approximately heavy' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = JSON.parse(getLatestExtraction('full-weight-1')!.extraction_data_json) as Record<string, unknown>;
    expect(data.weight).toBeNull();
    expect((data.fieldProvenance as Record<string, string>).weight).toBeUndefined();
    expect(validateManualEvidenceForReview('full-weight-1')).toBeNull();
  });
});

describe('full set: distributor_sheet kind never links', () => {
  test('distributor-sourced fields persist as user provenance with no distributor linkage', () => {
    seedItem('full-dist-1');
    const result = fullSubmit('full-dist-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = getLatestExtraction('full-dist-1')!;
    expect(row.sourcing_generation_id).toBeNull();
    expect(row.evidence_hash).toBeNull();
    const data = JSON.parse(row.extraction_data_json) as Record<string, unknown>;
    expect(data.distributorRecordProvenance).toBeNull();
    expect(data.distributorProviderId).toBeNull();
    expect(data.distributorProviderIds).toEqual([]);
    expect(data.distributorEvidenceAttemptIds).toEqual([]);
    expect((data.fieldProvenance as Record<string, string>).weight).toBe('user');
  });

  test('repo guard throws when distributor provenance is smuggled onto a manual row', () => {
    seedItem('full-dist-2');
    expect(() =>
      insertExtraction({
        itemId: 'full-dist-2',
        sourceType: 'official_page',
        sourceUrl: null,
        extractionMethod: 'manual_evidence_v1',
        manualAttestationId: 'attest-dist',
        extractionDataJson: JSON.stringify({
          identityStatus: 'insufficient_evidence',
          manualEvidenceAttestationId: 'attest-dist',
          fieldProvenance: { title: 'user' },
          distributorRecordProvenance: { sourcingGenerationId: 'g1' },
        }),
        confidence: 0,
      } as unknown as Parameters<typeof insertExtraction>[0]),
    ).toThrow(/distributor/);
  });
});

describe('full set: inheritance guard', () => {
  const SNAPSHOT = 'The Butcher\u2019s Pup family treats page. Chicken Recipe Grain-Free Bites For Small Dogs, oven baked daily in small batches for puppies and adults.';

  test('a field copied from the stored snapshot is refused with the inheritance code', () => {
    seedItem('full-inherit-1');
    const result = fullSubmit('full-inherit-1', {
      title: 'Chicken Recipe Grain-Free Bites For Small Dogs',
      familyReferenceText: SNAPSHOT,
    });
    // Submit succeeds (the operator attests); Review refuses.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const refused = validateManualEvidenceForReview('full-inherit-1');
    expect(refused?.ok).toBe(false);
    if (refused && !refused.ok) expect(refused.code).toBe('manual_family_inheritance_suspected');
  });

  test('an unrelated snapshot passes the gate', () => {
    seedItem('full-inherit-2');
    const result = fullSubmit('full-inherit-2', {
      title: 'Salmon Dinner Patties 5lb',
      familyReferenceText: SNAPSHOT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateManualEvidenceForReview('full-inherit-2')).toBeNull();
  });
});

describe('full set: image rights', () => {
  test('submitting an image without a matching approval is rejected at submit time', () => {
    seedItem('full-rights-1');
    const result = fullSubmit('full-rights-1', { imageApprovals: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('manual_image_rights_missing');
  });

  test('corrupted rights approvals are refused at gate time', () => {
    seedItem('full-rights-2');
    const result = fullSubmit('full-rights-2');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateManualEvidenceForReview('full-rights-2')).toBeNull();
    // Simulate post-submit corruption of the stored approvals.
    getDb().query(
      `UPDATE onboarding_manual_evidence_attestations SET image_rights_json = '[]' WHERE attestation_id = ?`,
    ).run(result.attestationId);
    const refused = validateManualEvidenceForReview('full-rights-2');
    expect(refused?.ok).toBe(false);
    if (refused && !refused.ok) expect(refused.code).toBe('manual_image_rights_missing');
  });
});

describe('full set: hash-match discipline', () => {
  test('post-submit payload edits are refused as incomplete', () => {
    seedItem('full-hash-1');
    const result = fullSubmit('full-hash-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = getLatestExtraction('full-hash-1')!;
    const data = JSON.parse(row.extraction_data_json) as Record<string, unknown>;
    data.title = 'Tampered Title After Attestation';
    getDb().query('UPDATE onboarding_extractions SET extraction_data_json = ? WHERE id = ?').run(JSON.stringify(data), row.id);
    const refused = validateManualEvidenceForReview('full-hash-1');
    expect(refused?.ok).toBe(false);
    if (refused && !refused.ok) expect(refused.code).toBe('manual_attestation_incomplete');
  });
});
