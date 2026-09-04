// @vitest-environment node
// Ticket #102 (parent #101) — manual-evidence foundation, vitest lane
// (no bun:sqlite imports here; DB-backed coverage lives in
// manual-evidence-foundation-db.test.ts under `bun test` via test:db).
import { describe, it, expect, afterEach } from 'vitest';
import {
  MANUAL_EVIDENCE_ENV_KEY,
  DEFAULT_MANUAL_EVIDENCE_FLAGS,
  loadManualEvidenceFlags,
  getManualEvidenceFlags,
  overrideManualEvidenceFlags,
  resetManualEvidenceFlagsOverride,
} from '../../onboarding/flags';
import {
  SourceTypeEnum,
  ManualEvidenceExtractionMethodEnum,
  ManualEvidenceAttestationSchema,
  ExtractionDataSchema,
} from '../../shared/schemas/onboarding';

afterEach(() => {
  resetManualEvidenceFlagsOverride();
});

describe('manual-evidence flag (fail-closed, default OFF)', () => {
  it('is OFF when the env key is absent', () => {
    expect(DEFAULT_MANUAL_EVIDENCE_FLAGS.enabled).toBe(false);
    expect(DEFAULT_MANUAL_EVIDENCE_FLAGS.reason).toBe('disabled_default');
    expect(loadManualEvidenceFlags({})).toEqual(DEFAULT_MANUAL_EVIDENCE_FLAGS);
  });

  it('accepts every true spelling as enabled', () => {
    for (const raw of ['true', '1', 'yes', 'TRUE', ' Yes ']) {
      const flags = loadManualEvidenceFlags({ [MANUAL_EVIDENCE_ENV_KEY]: raw });
      expect(flags.enabled).toBe(true);
      expect(flags.reason).toBe('env_enabled');
    }
  });

  it('treats explicit false spellings as disabled', () => {
    for (const raw of ['false', '0', 'no', 'FALSE', ' No ']) {
      const flags = loadManualEvidenceFlags({ [MANUAL_EVIDENCE_ENV_KEY]: raw });
      expect(flags.enabled).toBe(false);
      expect(flags.reason).toBe('env_disabled');
    }
  });

  it('treats empty/whitespace/malformed values as malformed (disabled)', () => {
    for (const raw of ['', '   ', 'maybe', 'on']) {
      const flags = loadManualEvidenceFlags({ [MANUAL_EVIDENCE_ENV_KEY]: raw });
      expect(flags.enabled).toBe(false);
      expect(flags.reason).toBe('malformed_config');
    }
  });

  it('in-memory override wins and reset restores the default', () => {
    expect(getManualEvidenceFlags().enabled).toBe(false);
    overrideManualEvidenceFlags({ enabled: true });
    expect(getManualEvidenceFlags()).toEqual({ enabled: true, reason: 'override' });
    resetManualEvidenceFlagsOverride();
    expect(getManualEvidenceFlags().enabled).toBe(false);
  });
});

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
