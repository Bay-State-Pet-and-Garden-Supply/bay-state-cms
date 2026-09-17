// @vitest-environment node
// Ticket #102 (parent #101) — manual-evidence foundation, vitest lane
// (no bun:sqlite imports here; DB-backed coverage lives in
// manual-evidence-foundation-db.test.ts under `bun test` via test:db).
//
// NOTE: the manual-evidence route is always available (no toggle); the flag
// suite that lived here was removed with BAYSTATE_CMS_MANUAL_EVIDENCE_ENABLED.
// This file now pins the additive source vocabulary only.
import { describe, it, expect } from 'vitest';
import {
  SourceTypeEnum,
  ManualEvidenceExtractionMethodEnum,
  ManualEvidenceAttestationSchema,
  ExtractionDataSchema,
} from '../../shared/schemas/onboarding';

describe('source vocabulary audit (plan §2: no new enum)', () => {
  it('SourceTypeEnum stays two-valued', () => {
    expect(SourceTypeEnum.options).toEqual(['official_page', 'distributor_record']);
  });

  it('manual method literal is additive and distinct from automated methods', () => {
    expect(ManualEvidenceExtractionMethodEnum.value).toBe('manual_evidence_v1');
    expect(
      ['json_ld', 'platform_api', 'profile_selector', 'distributor_record_v1'].includes(
        ManualEvidenceExtractionMethodEnum.value,
      ),
    ).toBe(false);
  });

  it('ExtractionDataSchema accepts manual additive fields and stays passthrough', () => {
    const parsed = ExtractionDataSchema.safeParse({
      manualEvidenceAttestationId: 'att-1',
      manualReferenceUrl: 'https://brand.example.com/family',
    });
    expect(parsed.success).toBe(true);
  });

  it('attestation schema requires all three boolean attestations to be true', () => {
    const base = {
      attestationId: 'att-1',
      itemId: 'item-foundation-1',
      operatorId: 'op-1',
      attestedAt: new Date().toISOString(),
      fieldChecklist: {
        title: {
          valueHash: 'a'.repeat(64),
          sourceKind: 'operator_transcription' as const,
          referenceUrl: null,
        },
      },
      rightsAttestedForImages: true as const,
      notes: null,
      supersededAt: null,
    };
    expect(
      ManualEvidenceAttestationSchema.safeParse({
        ...base,
        noFamilyInheritanceAttested: true,
        perSkuVerificationAttested: true,
      }).success,
    ).toBe(true);
    expect(
      ManualEvidenceAttestationSchema.safeParse({
        ...base,
        noFamilyInheritanceAttested: false,
        perSkuVerificationAttested: true,
      }).success,
    ).toBe(false);
  });
});
