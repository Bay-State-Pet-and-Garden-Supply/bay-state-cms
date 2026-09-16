// Issue #199 — brand inventory + sourcing-strategy resolution tests.
//
// Asserts externally visible behavior at the established seams:
// the 10 resolution payloads validate through the approval schema,
// distributor-first-class brands derive profile bypass eligibility (never
// "unmatched"), official brands derive mapped availability, and the guarded
// approval flow rejects unmapped official domains / unknown distributors.
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import {
  computeBrandStrategyConfigurationToken,
  getBrandStrategyRow,
  listStrategyApprovalInputs,
  normalizeBrandKey,
  saveBrandStrategy,
} from '../../db/repositories/brand-strategy-approval-repo';
import { findBrandSites } from '../../db/repositories/brand-site-repo';
import { isSupportedDistributorId } from '../../onboarding/sourcing/connector-registry';
import { deriveBrandStrategies } from '../../onboarding/brand-hub/brand-strategy-derive';
import { ApproveBrandStrategySchema } from '../../shared/schemas/brand-strategy';
import {
  BRAND_199_RESOLUTIONS,
  BRAND_199_TOTAL_ITEMS,
  brand199SaveInput,
  summarizeItemCoverage,
} from '../../onboarding/brand-hub/brand-strategies-199';

const workspaceId = 'ws-199';

beforeEach(() => {
  initDb(':memory:');
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'Issue 199 WS',
    workspacePath: '/tmp/test-199-ws',
    gitPath: '/tmp/test-199-ws/.git',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
});

describe('issue #199 inventory reconciliation', () => {
  it('covers exactly 10 brands and the corrected 34-item inventory', () => {
    expect(BRAND_199_RESOLUTIONS).toHaveLength(10);
    expect(BRAND_199_TOTAL_ITEMS).toBe(34);
    const normalized = BRAND_199_RESOLUTIONS.map((r) => normalizeBrandKey(r.brand));
    expect(new Set(normalized).size).toBe(10);
  });

  it('matches the corrected per-brand counts', () => {
    const counts = new Map(BRAND_199_RESOLUTIONS.map((r) => [normalizeBrandKey(r.brand), r.itemCount]));
    expect(counts.get('snif-snax')).toBe(8);
    expect(counts.get('jolly pets')).toBe(6);
    expect(counts.get('hummzinger')).toBe(4);
    expect(counts.get('yowup')).toBe(3);
    expect(counts.get('wondercide')).toBe(3);
    expect(counts.get('sevin')).toBe(3);
    expect(counts.get('ourpets')).toBe(3);
    expect(counts.get('coop & range')).toBe(2);
    expect(counts.get('oc')).toBe(1);
    expect(counts.get("horsemen's pride")).toBe(1);
  });

  it('every brand states official vs distributor with a recorded rationale', () => {
    for (const r of BRAND_199_RESOLUTIONS) {
      if (r.kind === 'official_page') {
        expect(r.officialDomains).toHaveLength(1);
        expect(r.distributorIds).toHaveLength(0);
      } else {
        expect(r.officialDomains).toHaveLength(0);
        expect(r.distributorIds.length).toBeGreaterThan(0);
      }
      expect(r.rationale.length).toBeGreaterThan(80);
      expect(r.evidence.length).toBeGreaterThan(20);
    }
  });

  it('summarizeItemCoverage reconciles live rows against the inventory', () => {
    const rows = [
      ...Array.from({ length: 8 }, () => ({ brand_hint: 'Snif-Snax' })),
      ...Array.from({ length: 6 }, () => ({ brand_hint: 'jolly pets' })),
      { brand_hint: 'Snif Snax' },
      { brand_hint: null },
      { brand_hint: '  ' },
    ];
    const { perBrand, blankHints, unjoined } = summarizeItemCoverage(rows);
    const byBrand = new Map(perBrand.map((c) => [c.brand, c]));
    // Exact-normalized join: 'jolly pets' matches 'Jolly Pets'.
    expect(byBrand.get('Jolly Pets')).toMatchObject({ expected: 6, live: 6, matched: true });
    // 'Snif Snax' (space) does NOT join 'Snif-Snax' (hyphen): it surfaces
    // as unjoined inventory instead of silently disappearing.
    expect(byBrand.get('Snif-Snax')).toMatchObject({ expected: 8, live: 8, matched: true });
    expect(unjoined).toEqual([{ spelling: 'Snif Snax', count: 1 }]);
    expect(blankHints).toBe(2);
    expect(byBrand.get('OC')).toMatchObject({ live: 0, matched: false });
  });

  it('all pinned distributors are registry-supported (no invented ids)', () => {
    for (const r of BRAND_199_RESOLUTIONS) {
      for (const id of r.distributorIds) {
        expect(isSupportedDistributorId(id)).toBe(true);
      }
    }
  });
});

describe('issue #199 approval payloads', () => {
  it('all 10 save inputs validate through the approval schema', () => {
    for (const r of BRAND_199_RESOLUTIONS) {
      const input = brand199SaveInput(r);
      const parsed = ApproveBrandStrategySchema.safeParse({
        ...input,
        expectedRevision: 0,
        // Schema shape only here (the live token is computed per workspace
        // at apply time); the value is irrelevant to validation.
        ...(input.configuration ? { expectedConfigurationToken: 'test-token' } : {}),
      });
      expect(parsed.success, `brand ${r.brand}: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);
    }
  });
});

describe('issue #199 derivation', () => {
  function deriveAllApproved() {
    const approvals = new Map(
      BRAND_199_RESOLUTIONS.map((r) => {
        const input = brand199SaveInput(r);
        return [
          normalizeBrandKey(r.brand),
          { approved: true, revision: 1, approvedAt: '2026-09-16T00:00:00.000Z', approvedBy: 'issue-199', brand: r.brand, sources: input.sources },
        ];
      }),
    );
    return deriveBrandStrategies({
      brandSites: BRAND_199_RESOLUTIONS.filter((r) => r.kind === 'official_page').map((r) => ({
        brandName: r.brand,
        domain: r.officialDomains[0]!,
      })),
      approvals,
    });
  }

  it('zero approved brands stay unmatched', () => {
    for (const s of deriveAllApproved()) {
      expect(s.unmatched, s.brandKey).toBe(false);
    }
  });

  it('distributor-first-class brands derive profile bypass eligibility explicitly', () => {
    const byBrand = new Map(deriveAllApproved().map((s) => [s.normalizedBrand, s]));
    for (const key of ['ourpets', 'coop & range']) {
      const s = byBrand.get(key)!;
      expect(s).toBeDefined();
      expect(s.extractorReadiness).toBe('profile_bypass_eligible');
      expect(s.approvedSources?.every((src) => src.kind === 'distributor_record')).toBe(true);
    }
  });

  it('official brands derive mapped domains with an official proposal', () => {
    const byBrand = new Map(deriveAllApproved().map((s) => [s.normalizedBrand, s]));
    const snif = byBrand.get('snif-snax')!;
    expect(snif.officialDomains.map((d) => d.domain)).toEqual(['snifsnax.com']);
    expect(snif.proposalSources).toContainEqual({ kind: 'official_page', domain: 'snifsnax.com' });
  });
});

describe('issue #199 approval-flow guards', () => {
  it('applies an official brand: mapping + approval commit together', () => {
    const r = BRAND_199_RESOLUTIONS.find((x) => normalizeBrandKey(x.brand) === 'snif-snax')!;
    const input = brand199SaveInput(r);
    const saved = saveBrandStrategy(workspaceId, {
      ...input,
      expectedRevision: 0,
      expectedConfigurationToken: computeBrandStrategyConfigurationToken(workspaceId, normalizeBrandKey(r.brand)),
      approvedBy: 'issue-199',
    });
    expect(saved.revision).toBe(1);
    expect(saved.approved).toBe(true);
    expect(findBrandSites(normalizeBrandKey(r.brand)).map((m) => m.domain)).toEqual(['snifsnax.com']);
    expect(getBrandStrategyRow(workspaceId, r.brand)?.sources).toEqual([{ kind: 'official_page', domain: 'snifsnax.com' }]);
  });

  it('applies a distributor-first-class brand with no mapping', () => {
    const r = BRAND_199_RESOLUTIONS.find((x) => normalizeBrandKey(x.brand) === 'ourpets')!;
    const saved = saveBrandStrategy(workspaceId, { ...brand199SaveInput(r), expectedRevision: 0, approvedBy: 'issue-199' });
    expect(saved.revision).toBe(1);
    expect(saved.sources).toEqual([
      { kind: 'distributor_record', distributorId: 'phillips' },
      { kind: 'distributor_record', distributorId: 'pet_food_experts' },
    ]);
    expect(findBrandSites(normalizeBrandKey(r.brand))).toHaveLength(0);
  });

  it('rejects an official_page source for an unmapped domain (no silent fallback)', () => {
    expect(() =>
      saveBrandStrategy(workspaceId, {
        brand: 'Coop & Range',
        sources: [{ kind: 'official_page', domain: 'coopandrange.com' }],
        expectedRevision: 0,
      }),
    ).toThrow(/not mapped for this brand/);
  });

  it('rejects unknown distributor pins', () => {
    expect(() =>
      saveBrandStrategy(workspaceId, {
        brand: 'OurPets',
        sources: [{ kind: 'distributor_record', distributorId: 'acme_feeds' }],
        expectedRevision: 0,
      }),
    ).toThrow(/unknown distributor/);
  });

  it('identical re-approval is detectable so the applicator stays idempotent', () => {
    const r = BRAND_199_RESOLUTIONS.find((x) => normalizeBrandKey(x.brand) === 'yowup')!;
    const first = saveBrandStrategy(workspaceId, {
      ...brand199SaveInput(r),
      expectedRevision: 0,
      expectedConfigurationToken: computeBrandStrategyConfigurationToken(workspaceId, normalizeBrandKey(r.brand)),
    });
    // Stale guard: re-saving at revision 0 must fail (revision is checked
    // before configuration, so any token value still yields stale_revision).
    // The applicator reads the current revision and skips identical
    // approved sources instead.
    expect(() =>
      saveBrandStrategy(workspaceId, {
        ...brand199SaveInput(r),
        expectedRevision: 0,
        expectedConfigurationToken: 'stale-token',
      }),
    ).toThrow(/stale_revision/);
    expect(listStrategyApprovalInputs(workspaceId).get(normalizeBrandKey(r.brand))?.revision).toBe(first.revision);
  });
});
