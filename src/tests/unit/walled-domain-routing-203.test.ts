// Issue #203 — walled-domain distributor routing tests.
//
// Asserts externally visible behavior at the pre-agreed seams (parent spec
// #197: gates, release eligibility, extraction evidence — never internals):
// every walled domain carries a recorded routing outcome grounded in the
// #200 readiness checklist and the #201 leaf product-page evidence, zero
// profile rows are created or tolerated, future items move by the routed
// mechanism (never unrouted selector work), and no sitemap absence was
// used as sole justification for any routing call. No network, no DB.
import { describe, it, expect } from 'vitest';
import {
  DISTRIBUTOR_READINESS_203,
  WALLED_203_DOMAINS,
  WALLED_203_TOTAL_ITEMS,
  WALLED_ROUTES_203,
  futureItemsMoveBy,
  normalizeProfileKey,
  routing203ByDomain,
  verdict201ForRoute,
  verifyZeroProfileRows,
  type WalledRoute203,
} from '../../onboarding/brand-hub/walled-domain-routing-203';
import { verdict201ByDomain } from '../../onboarding/brand-hub/product-page-verdicts-201';

const ROUTES: readonly WalledRoute203[] = ['static_profile_validation', 'distributor_manual_blocked'];

describe('issue #203 routing-table coverage (acceptance: one recorded outcome per domain)', () => {
  it('covers exactly the five walled domains with zero current items', () => {
    expect(WALLED_ROUTES_203).toHaveLength(5);
    expect(new Set(WALLED_203_DOMAINS).size).toBe(5);
    for (const d of ['bil-jac.com', 'chickensouppets.com', 'multipet.com', 'northstatesind.com', 'yeowww.com']) {
      expect(routing203ByDomain(d), `missing routing outcome for ${d}`).toBeDefined();
    }
    expect(WALLED_203_TOTAL_ITEMS).toBe(0);
    for (const r of WALLED_ROUTES_203) expect(r.items).toBe(0);
  });

  it('every route states a taxonomy kind with rationale, blocked reason, follow-ups, and a downstream owner', () => {
    for (const r of WALLED_ROUTES_203) {
      expect(ROUTES).toContain(r.route);
      expect(r.rationale.length).toBeGreaterThan(80);
      // Honest trichotomy outcome: nothing flows today, nothing is staged —
      // every row is blocked-with-reason plus named follow-ups.
      expect(r.specOutcome).toBe('blocked_with_reason');
      expect(r.blockedReason.length).toBeGreaterThan(40);
      expect(r.followUps.length).toBeGreaterThanOrEqual(2);
      for (const f of r.followUps) expect(f.length).toBeGreaterThan(20);
      expect(r.downstream.length).toBeGreaterThan(0);
      expect(r.domainStatusNote.length).toBeGreaterThan(20);
    }
  });

  it('partitions on the #201 scope change: 3 lifted re-route to static validation, 2 still-walled stay distributor/manual', () => {
    const lifted = WALLED_ROUTES_203.filter((r) => r.wall.status === 'lifted');
    const walled = WALLED_ROUTES_203.filter((r) => r.wall.status === 'still_walled');
    expect(lifted.map((r) => r.domain).sort()).toEqual(['bil-jac.com', 'northstatesind.com', 'yeowww.com']);
    expect(walled.map((r) => r.domain).sort()).toEqual(['chickensouppets.com', 'multipet.com']);
    for (const r of lifted) {
      expect(r.route).toBe('static_profile_validation');
      expect(r.selectorPosture).toBe('downstream_gated');
      expect(r.downstream).toMatch(/new ticket/i);
    }
    for (const r of walled) {
      expect(r.route).toBe('distributor_manual_blocked');
      expect(r.selectorPosture).toBe('forbidden');
      expect(r.downstream).toMatch(/#203 as written/);
    }
  });
});

describe('issue #203 fidelity to the #201 input artifact (no re-probing)', () => {
  it('fetch hosts agree with the #201 verdict table', () => {
    for (const r of WALLED_ROUTES_203) {
      expect(r.fetchHost).toBe(verdict201ForRoute(r).fetchHost);
    }
  });

  it('wall evidence matches the #201 probe statuses (lifted = all-200 leaves, still-walled = 403)', () => {
    for (const r of WALLED_ROUTES_203) {
      const verdict = verdict201ByDomain(r.domain)!;
      expect(verdict, `no #201 verdict for ${r.domain}`).toBeDefined();
      if (r.wall.status === 'lifted') {
        expect(verdict.probes.every((p) => p.status === 200), `${r.domain}: lifted but a probe is not 200`).toBe(true);
        expect(r.wall.evidence).toMatch(/LIFTED/);
      } else {
        expect(verdict.probes.some((p) => p.status === 403), `${r.domain}: still-walled but no 403 probe`).toBe(true);
        expect(r.wall.evidence).toMatch(/STILL WALLED/);
        // Still-walled verdicts carry no endpoint and no observable structure.
        expect(verdict.endpoint.kind).toBe('none');
      }
    }
  });

  it('lifted routes name their #201 structured basis (the validation target)', () => {
    expect(routing203ByDomain('northstatesind.com')!.structuredLayer).toMatch(/JSON-LD Product/);
    expect(routing203ByDomain('bil-jac.com')!.structuredLayer).toMatch(/OG title/);
    expect(routing203ByDomain('yeowww.com')!.structuredLayer).toMatch(/no JSON-LD/);
  });
});

describe('issue #203 zero-profile-row invariant (acceptance: verified by query)', () => {
  it('no route creates a profile row in #203', () => {
    for (const r of WALLED_ROUTES_203) expect(r.createsProfileRow).toBe(false);
  });

  it('verifyZeroProfileRows passes on an empty repo and flags a violating row', () => {
    expect(verifyZeroProfileRows(() => null)).toEqual([]);
    // A row under any spelling (apex, www., case variants) violates the
    // invariant — candidates are production-normalized before lookup,
    // mirroring `findProfileByDomain`.
    expect(verifyZeroProfileRows((d) => (d === 'multipet.com' ? { domain: d } : null))).toEqual(['multipet.com']);
    expect(
      verifyZeroProfileRows((d) => (d === 'bil-jac.com' ? { domain: 'www.bil-jac.com' } : null)),
    ).toEqual(['bil-jac.com']);
    // Normalization parity: every key the verifier passes to the lookup is
    // already in production-normal form (lowercase, no www., trimmed).
    expect(normalizeProfileKey('WWW.MULTIPET.COM')).toBe('multipet.com');
    const seen: string[] = [];
    expect(
      verifyZeroProfileRows((d) => {
        seen.push(d);
        return null;
      }),
    ).toEqual([]);
    expect(seen.length).toBeGreaterThan(0);
    for (const key of seen) expect(key).toBe(normalizeProfileKey(key));
  });

  it('still-walled routes forbid selector work outright (no profile — now and ever)', () => {
    for (const r of WALLED_ROUTES_203.filter((x) => x.wall.status === 'still_walled')) {
      expect(r.selectorPosture).toBe('forbidden');
      expect(r.rationale).toMatch(/zero profile rows/i);
    }
  });
});

describe('issue #203 readiness grounding (acceptance: executed against the #200 checklist)', () => {
  it('records the mechanical floor as ready but qualification as unproven — so nothing claims to flow', () => {
    expect(DISTRIBUTOR_READINESS_203.connectionsEnabled).toMatch(/5\/5/);
    expect(DISTRIBUTOR_READINESS_203.secretsUsable).toMatch(/3\/3/);
    expect(DISTRIBUTOR_READINESS_203.generations).toBe(0);
    expect(DISTRIBUTOR_READINESS_203.attempts).toBe(0);
    expect(DISTRIBUTOR_READINESS_203.walledStrategyPins).toBe(0);
    expect(DISTRIBUTOR_READINESS_203.gateObservations).toBe(0);
    expect(DISTRIBUTOR_READINESS_203.liveSmokeRun).toBe(false);
    for (const r of WALLED_ROUTES_203) {
      expect(r.specOutcome, `${r.domain}: must not claim distributor_flowing with zero generations`).not.toBe(
        'distributor_flowing',
      );
      expect(r.blockedReason).toMatch(/zero/i);
    }
  });

  it('manual evidence is honestly unstageable today (no failed item) with the unlock path documented', () => {
    for (const r of WALLED_ROUTES_203) {
      expect(r.specOutcome).not.toBe('manual_evidence_staged');
      // The no-existing-profile precondition passes vacuously for walled routing…
      expect(r.manualEvidence.profileRowExists).toBe(false);
      // …but staging requires a prior eligible failure, and there are zero items.
      expect(r.manualEvidence.priorFailureExists).toBe(false);
      expect(r.manualEvidence.stageableToday).toBe(false);
      expect(r.manualEvidence.unlockNote).toMatch(/extraction\/failed/i);
    }
  });

  it('future items move by the routed mechanism, not by unrouted selector work', () => {
    for (const r of WALLED_ROUTES_203.filter((x) => x.wall.status === 'still_walled')) {
      expect(futureItemsMoveBy(r)).toBe('distributor_record_or_manual_evidence');
    }
    for (const r of WALLED_ROUTES_203.filter((x) => x.wall.status === 'lifted')) {
      expect(futureItemsMoveBy(r)).toBe('static_profile_validation_first');
      expect(r.blockedReason).toMatch(/distributor only on validation failure/i);
    }
  });
});

describe('issue #203 sitemap discipline (acceptance: no absence used as sole justification)', () => {
  it('no routing call rests on sitemap absence — every call cites its own leaf HTTP status instead', () => {
    for (const r of WALLED_ROUTES_203) {
      expect(r.sitemap.cached).toBe(false);
      expect(r.sitemap.soleJustification).toBe(false);
    }
    // The cited status must match the wall partition: lifted rows decided
    // on 200s, still-walled rows on product-page 403s — not merely on some
    // HTTP status string.
    for (const r of WALLED_ROUTES_203.filter((x) => x.wall.status === 'lifted')) {
      expect(r.sitemap.decidingEvidence).toMatch(/HTTP 200/);
      expect(r.sitemap.decidingEvidence).not.toMatch(/HTTP 403/);
    }
    for (const r of WALLED_ROUTES_203.filter((x) => x.wall.status === 'still_walled')) {
      expect(r.sitemap.decidingEvidence).toMatch(/HTTP 403/);
    }
  });

  it('still-walled calls prove the wall at product-page level (never homepage-only, never sitemap-only)', () => {
    for (const r of WALLED_ROUTES_203.filter((x) => x.wall.status === 'still_walled')) {
      expect(r.sitemap.decidingEvidence).toMatch(/product page/i);
      expect(r.wall.evidence).toMatch(/403/);
    }
  });
});

describe('issue #203 domain_status staleness is recorded, not silently trusted', () => {
  it('lifted rows call out the stale blocked signal (2026-08-20 check vs 2026-09-16 200s)', () => {
    for (const r of WALLED_ROUTES_203.filter((x) => x.wall.status === 'lifted')) {
      expect(r.domainStatusNote).toMatch(/Stale/);
      expect(r.followUps.some((f) => f.includes('domain_status'))).toBe(true);
    }
  });

  it('still-walled rows confirm the blocked signal is consistent with fresh 403s', () => {
    for (const r of WALLED_ROUTES_203.filter((x) => x.wall.status === 'still_walled')) {
      expect(r.domainStatusNote).toMatch(/consistent/);
    }
  });
});
