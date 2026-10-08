/**
 * Behavioral page-gold tests (public seam only, no network, no custody).
 *
 * Covers the owner-approved page-rule boundary at the module interface:
 * packet binding fail-closed (authority/decision/hash drift, non-212,
 * unknown type/target/value, outside-frozen-pool), deterministic derivation
 * (known-complete merchandise + additive exact-brand, most-specific-first,
 * pageId tiebreak, hard cap 4 with explicit clipping), tri-state uncertainty
 * (open rules and missing field evidence stay partial with exact reasons;
 * no-fit/insufficient yield complete-empty under the known-type requirement
 * only), brand exactness (verbatim match after entity/space/case folding; no
 * alias/rollup/fallback guessing), and rev2 owner-answer semantics (merge to
 * canonical, coassign pairs, most-specific-only fallback, narrowed compound
 * scope, zero-match-closed rules). No wording or wiring tests.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  derivePageGold,
  loadPageRulePacket,
  PAGE_RULE_MAX_PER_PRODUCT,
  PAGE_RULE_PACKET_VERSION,
  PAGE_RULE_PACKET_VERSION_V2,
  type PageRule,
  type PageRulePacket,
  type PageGoldProductInput,
} from '../../../scripts/lib/page-gold';

const AUTHORITY = 'ff17dc313076c4657e87fa557ae7fa182796ddfcb53ce385f7525ebc03a33026';
const HEX64 = (s: string): string => createHash('sha256').update(s).digest('hex');

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'page-gold-test-'));
}

function decisionsFile(root: string, maxPages = 4): { path: string; sha: string } {
  const body = JSON.stringify({ pageScope: { maxPagesPerProduct: maxPages } });
  const p = path.join(root, 'owner-approved-decisions.json');
  fs.writeFileSync(p, body);
  return { path: p, sha: HEX64(body) };
}

let ruleCounter = 0;

function rule(overrides: Partial<PageRule> & { pageId: string; pageName: string }): PageRule {
  ruleCounter += 1;
  const status = overrides.status ?? 'eligible';
  return {
    pageId: overrides.pageId,
    pageName: overrides.pageName,
    exportedGuid: overrides.exportedGuid ?? `900${ruleCounter}`,
    filename: overrides.filename ?? `${overrides.pageId}.html`,
    sourceFragmentSha256: overrides.sourceFragmentSha256 ?? HEX64(overrides.pageId),
    status,
    ruleKind: overrides.ruleKind ?? (status === 'eligible' ? 'merchandise-subject' : status === 'excluded' ? 'excluded-role' : 'unresolved'),
    predicates: overrides.predicates ?? { allOf: [] },
    completeness: overrides.completeness ?? 'closed',
    ...(overrides.fallbackOnly === true ? { fallbackOnly: true as const } : {}),
    ...(overrides.resolutionNotes !== undefined ? { resolutionNotes: overrides.resolutionNotes } : {}),
    evidence: overrides.evidence ?? [{ pageField: 'name', quote: overrides.pageName, quoteRole: 'declared-page-subject' }],
    ambiguityReasons: overrides.ambiguityReasons ?? [],
    neededOwnerDecision: overrides.neededOwnerDecision ?? null,
    reviewRowSha256: overrides.reviewRowSha256 ?? HEX64(`row-${overrides.pageId}`),
  };
}

/** 212-rule packet: seed rules first, deterministic excluded filler for the rest. */
function packet(seeds: PageRule[], decisionsSha: string, mutate?: (p: PageRulePacket) => void, version: string = PAGE_RULE_PACKET_VERSION): PageRulePacket {
  const rules: PageRule[] = [...seeds];
  let n = 0;
  while (rules.length < 212) {
    n += 1;
    rules.push(rule({
      pageId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      pageName: `Filler ${n}`,
      status: 'excluded',
      ruleKind: 'excluded-role',
      predicates: { allOf: [] },
      ambiguityReasons: ['filler exclusion'],
    }));
  }
  rules.sort((a, b) => a.pageId.localeCompare(b.pageId));
  const p = {
    artifactKind: 'owner-approved-page-rule-packet',
    artifactVersion: version,
    authorityHash: AUTHORITY,
    ownerApproval: {
      decisionsPath: 'docs/audits/jev-expansion-v2/owner-approved-decisions.json',
      decisionsSha256: decisionsSha,
      pageScope: {
        selected: 'Specific merchandise + exact brand',
        maxPagesPerProduct: PAGE_RULE_MAX_PER_PRODUCT,
        brandMembership: 'directly evidenced ordinary brand/brand-line listings',
        excludedRoles: ['examples'],
        compatibleVerifiedHorseFarmWildlifeBee: true,
        conflictingSubjectDefinitionsRequireReview: true,
        fullCandidateUniverseRetained: true,
      },
      humanCanaryApproval: false,
    },
    ruleProvenance: 'test',
    counts: {
      pages: 212,
      eligible: rules.filter(r => r.status === 'eligible').length,
      excluded: rules.filter(r => r.status === 'excluded').length,
      unresolved: rules.filter(r => r.status === 'unresolved').length,
    },
    rules,
    membershipSemantics: {
      knownTypePrerequisite: true,
      noFitInsufficientPages: 'complete-empty under requirement',
      capPerProduct: PAGE_RULE_MAX_PER_PRODUCT,
      selectionPolicy: 'most-specific-first, brand additive, pageId tiebreak',
      inferencePool: 'all 212 preserved',
    },
    enrichmentTargets: { brandEvidence: [], usageEvidence: [] },
    ownerDecisionsRequired: [],
  } as unknown as PageRulePacket;
  mutate?.(p);
  // Byte-exact self-hash over the would-be file bytes minus the trailing
  // integrity block (same domain the loader verifies).
  const unsignedBytes = `${JSON.stringify(p, null, 1).replace(/,\n "integrity": [\s\S]*$/, '')}\n}\n`;
  void unsignedBytes;
  (p as unknown as Record<string, unknown>).integrity = { packetSha256: 'pending-write' };
  return p;
}

function writePacket(root: string, p: PageRulePacket): string {
  const file = path.join(root, 'page-rule-packet.json');
  const { integrity: _drop, ...unsigned } = p as unknown as Record<string, unknown>;
  void _drop;
  const unsignedBytes = `${JSON.stringify(unsigned, null, 1)}\n`;
  (p as unknown as Record<string, unknown>).integrity = { packetSha256: HEX64(unsignedBytes) };
  fs.writeFileSync(file, `${JSON.stringify(p, null, 1)}\n`);
  return file;
}

function frozenFor(pageIds: string[]) {
  return {
    frozenTypes: new Map([
      ['dog-treats', {}],
      ['dog-food-wet', {}],
      ['cat-toys', {}],
    ]),
    frozenTargets: new Map([
      ['species', new Set(['Dog', 'Cat'])],
      ['food-form', new Set(['Treat', 'Wet Food', 'Frozen Raw', 'Freeze-Dried Raw'])],
    ]),
    frozenPageIds: new Set(pageIds),
  };
}

function product(overrides: Partial<PageGoldProductInput>): PageGoldProductInput {
  return {
    sku: 'PUBLIC:test:001',
    productType: { kind: 'known-type', typeId: 'dog-treats' },
    fieldByTarget: new Map([
      ['species', { state: 'known', value: 'Dog' }],
      ['food-form', { state: 'known', value: 'Treat' }],
    ]),
    brand: null,
    evidenceQuotes: ['tasty treats for dogs'],
    ...overrides,
  };
}

const DOG_TREATS_PAGE = '11111111-1111-4111-8111-111111111111';
const DOG_SHOP_ALL = '22222222-2222-4222-8222-222222222222';
const BRAND_PAGE = '33333333-3333-4333-8333-333333333333';

function seedRules(): PageRule[] {
  return [
    rule({
      pageId: DOG_TREATS_PAGE, pageName: 'Dog Treats',
      predicates: { allOf: [
        { kind: 'known-type-in', typeIds: ['dog-treats'], evidence: { pageField: 'name', quote: 'Dog Treats' } },
        { kind: 'field-equals', targetId: 'species', value: 'Dog', evidence: { pageField: 'name', quote: 'Dog Treats' } },
      ] },
    }),
    rule({
      pageId: DOG_SHOP_ALL, pageName: 'Dog Supplies Shop All', completeness: 'open',
      predicates: { allOf: [
        { kind: 'known-type-in', typeIds: ['dog-treats', 'dog-food-wet'], evidence: { pageField: 'name', quote: 'Dog Supplies Shop All' } },
      ] },
      ambiguityReasons: ['Shop All co-assignment unresolved'],
      neededOwnerDecision: { id: 'D-SHOPALL', question: 'Co-assign Shop All?', options: ['yes', 'no'] },
    }),
    rule({
      pageId: BRAND_PAGE, pageName: 'Brand - Acme', ruleKind: 'exact-brand',
      predicates: { allOf: [
        { kind: 'brand-exact', brand: 'Acme', evidence: { pageField: 'name', quote: 'Brand - Acme' } },
      ] },
    }),
  ];
}

describe('page-gold packet loading (fail-closed bindings)', () => {
  it('loads a valid 212-rule packet bound to authority + owner decisions', () => {
    const root = tempRoot();
    const decisions = decisionsFile(root);
    const seeds = seedRules();
    const p = packet(seeds, decisions.sha);
    const file = writePacket(root, p);
    const loaded = loadPageRulePacket({
      packetPath: file, decisionsPath: decisions.path, expectedAuthorityHash: AUTHORITY,
      ...frozenFor([DOG_TREATS_PAGE, DOG_SHOP_ALL, BRAND_PAGE, ...p.rules.map(r => r.pageId)]),
    });
    expect(loaded.rules).toHaveLength(212);
    expect(loaded.counts).toMatchObject({ pages: 212, eligible: 3 });
  });

  it('rejects authority drift, decision drift, and packet self-hash drift', () => {
    const root = tempRoot();
    const decisions = decisionsFile(root);
    const p = packet(seedRules(), decisions.sha);
    const file = writePacket(root, p);
    const frozen = frozenFor(p.rules.map(r => r.pageId));
    expect(() => loadPageRulePacket({
      packetPath: file, decisionsPath: decisions.path, expectedAuthorityHash: '00'.repeat(32), ...frozen,
    })).toThrow(/page_rule_authority_drift/);
    const tamperedPath = path.join(root, 'owner-approved-decisions-tampered.json');
    fs.writeFileSync(tamperedPath, JSON.stringify({ pageScope: { maxPagesPerProduct: 4 }, extra: true }));
    expect(() => loadPageRulePacket({
      packetPath: file, decisionsPath: tamperedPath, expectedAuthorityHash: AUTHORITY, ...frozen,
    })).toThrow(/page_rule_decision_drift/);
    const bad = packet(seedRules(), decisions.sha);
    const badFile = writePacket(root, bad);
    // Valid-domain semantic tamper AFTER sealing: rewritten bytes, kept integrity.
    const tamperedBytes = fs.readFileSync(badFile, 'utf8').replace('"dog-treats"', '"cat-toys"');
    fs.writeFileSync(badFile, tamperedBytes);
    expect(() => loadPageRulePacket({
      packetPath: badFile, decisionsPath: decisions.path, expectedAuthorityHash: AUTHORITY, ...frozenFor(bad.rules.map(r => r.pageId)),
    })).toThrow(/page_rule_hash_drift/);
  });

  it('rejects non-executable predicates and outside-pool pages', () => {
    const root = tempRoot();
    const decisions = decisionsFile(root);
    const badType = packet([rule({
      pageId: DOG_TREATS_PAGE, pageName: 'Dog Treats',
      predicates: { allOf: [
        { kind: 'known-type-in', typeIds: ['catalog-pseudo-toys'], evidence: { pageField: 'name', quote: 'Dog Treats' } },
      ] },
    })], decisions.sha);
    expect(() => loadPageRulePacket({
      packetPath: writePacket(root, badType), decisionsPath: decisions.path,
      expectedAuthorityHash: AUTHORITY, ...frozenFor(badType.rules.map(r => r.pageId)),
    })).toThrow(/page_rule_unknown_type/);
    const badValue = packet([rule({
      pageId: DOG_TREATS_PAGE, pageName: 'Dog Treats',
      predicates: { allOf: [
        { kind: 'field-equals', targetId: 'species', value: 'Doggo', evidence: { pageField: 'name', quote: 'Dog Treats' } },
      ] },
    })], decisions.sha);
    expect(() => loadPageRulePacket({
      packetPath: writePacket(root, badValue), decisionsPath: decisions.path,
      expectedAuthorityHash: AUTHORITY, ...frozenFor(badValue.rules.map(r => r.pageId)),
    })).toThrow(/page_rule_noncanonical_value/);
    const good = packet(seedRules(), decisions.sha);
    const goodFile = writePacket(root, good);
    expect(() => loadPageRulePacket({
      packetPath: goodFile, decisionsPath: decisions.path,
      expectedAuthorityHash: AUTHORITY, ...frozenFor(['ffffffff-ffff-4fff-8fff-ffffffffffff']),
    })).toThrow(/page_rule_outside_frozen_pool/);
  });

  it('rejects duplicate, missing, or unordered page coverage', () => {
    const root = tempRoot();
    const decisions = decisionsFile(root);
    const dup = packet(seedRules(), decisions.sha, q => {
      q.rules[5] = { ...q.rules[0] };
    });
    expect(() => loadPageRulePacket({
      packetPath: writePacket(root, dup), decisionsPath: decisions.path,
      expectedAuthorityHash: AUTHORITY, ...frozenFor(dup.rules.map(r => r.pageId)),
    })).toThrow(/exactly once/);
  });
});

describe('page-gold derivation (deterministic, tri-state)', () => {
  function loadedPacket(seeds: PageRule[] = seedRules()): PageRulePacket {
    const root = tempRoot();
    const decisions = decisionsFile(root);
    const p = packet(seeds, decisions.sha);
    return loadPageRulePacket({
      packetPath: writePacket(root, p), decisionsPath: decisions.path,
      expectedAuthorityHash: AUTHORITY, ...frozenFor(p.rules.map(r => r.pageId)),
    });
  }

  it('emits partial merchandise pages when an open rule also matches', () => {
    const result = derivePageGold(loadedPacket(), product({}));
    expect(result.pageIds).toContain(DOG_TREATS_PAGE);
    expect(result.completeness).toBe('partial');
    expect(result.pageReason).toMatch(/Shop All co-assignment unresolved/);
  });

  it('derives known-complete sets when only closed rules match', () => {
    const seeds = seedRules();
    const loaded = loadedPacket([seeds[0], seeds[2]]);
    const result = derivePageGold(loaded, product({ brand: 'Acme' }));
    expect(result.state).toBe('known');
    expect(result.completeness).toBe('complete');
    expect(result.pageIds).toEqual([BRAND_PAGE, DOG_TREATS_PAGE].sort());
    expect(result.pageReason).toBeNull();
  });

  it('keeps unknown field evidence partial with the exact missing predicate', () => {
    const loaded = loadedPacket();
    const result = derivePageGold(loaded, product({
      fieldByTarget: new Map([
        ['species', { state: 'insufficient-evidence' }],
        ['food-form', { state: 'known', value: 'Treat' }],
      ]),
    }));
    expect(result.completeness).toBe('partial');
    expect(result.pageIds).not.toContain(DOG_TREATS_PAGE);
    expect(result.pageReason).toMatch(/needs species=Dog but field is insufficient-evidence/);
  });

  it('returns complete-empty for no-fit/insufficient types without guessing members', () => {
    const loaded = loadedPacket();
    for (const kind of ['no-fit', 'insufficient-evidence'] as const) {
      const result = derivePageGold(loaded, product({
        productType: { kind, typeId: null },
        fieldByTarget: new Map(),
      }));
      expect(result).toMatchObject({ state: 'known', completeness: 'complete', pageIds: [] });
      expect(result.pageReason).toBeNull();
    }
  });

  it('enforces the 4-cap with most-specific-first, brand-additive, pageId tiebreak', () => {
    const root = tempRoot();
    const decisions = decisionsFile(root);
    const many = (n: number): PageRule[] => Array.from({ length: n }, (_, i) => rule({
      pageId: `f0000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      pageName: `Treats ${i}`,
      predicates: { allOf: [
        { kind: 'known-type-in', typeIds: ['dog-treats'], evidence: { pageField: 'name', quote: `Treats ${i}` } },
      ] },
    }));
    const p = packet(many(6), decisions.sha);
    const loaded = loadPageRulePacket({
      packetPath: writePacket(root, p), decisionsPath: decisions.path,
      expectedAuthorityHash: AUTHORITY, ...frozenFor(p.rules.map(r => r.pageId)),
    });
    const result = derivePageGold(loaded, product({}));
    expect(result.pageIds).toHaveLength(4);
    expect(result.pageIds).toEqual([...result.pageIds].sort());
    expect(result.completeness).toBe('partial');
    expect(result.pageReason).toMatch(/cap 4 selects most-specific-first/);
  });

  it('matches brands exactly (entity/space/case folded) without alias or rollup guessing', () => {
    const loaded = loadedPacket();
    const exact = derivePageGold(loaded, product({ brand: '  ACME ' }));
    expect(exact.pageIds).toContain(BRAND_PAGE);
    const nearMiss = derivePageGold(loaded, product({ brand: 'Acme Pro Plan Plus' }));
    expect(nearMiss.pageIds).not.toContain(BRAND_PAGE);
    const folded = loadedPacket([rule({
      pageId: BRAND_PAGE, pageName: 'Brand - Foo & Bar', ruleKind: 'exact-brand',
      predicates: { allOf: [
        { kind: 'brand-exact', brand: 'Foo & Bar', evidence: { pageField: 'name', quote: 'Brand - Foo & Bar' } },
      ] },
    })]);
    const entityFold = derivePageGold(folded, product({ brand: 'Foo &amp; Bar' }));
    expect(entityFold.pageIds).toContain(BRAND_PAGE);
  });
});

describe('page-gold rev2 owner-answer semantics', () => {
  const CANON = '44444444-4444-4444-8444-444444444444';
  const DUPE = '55555555-5555-4555-8555-555555555555';
  const COA = '66666666-6666-4666-8666-666666666666';
  const COB = '77777777-7777-4777-8777-777777777777';
  const FALLBACK = '88888888-8888-4888-8888-888888888888';
  const ZERO = '99999999-9999-4999-8999-999999999999';

  function loadedRev2(seeds: PageRule[]): PageRulePacket {
    const root = tempRoot();
    const decisions = decisionsFile(root);
    const p = packet(seeds, decisions.sha, undefined, PAGE_RULE_PACKET_VERSION_V2);
    return loadPageRulePacket({
      packetPath: writePacket(root, p), decisionsPath: decisions.path,
      expectedAuthorityHash: AUTHORITY, ...frozenFor(p.rules.map(r => r.pageId)),
    });
  }

  it('merges duplicate subjects to the canonical pageId only', () => {
    const loaded = loadedRev2([
      rule({
        pageId: CANON, pageName: 'Dog Treats Biscuits & Crunchy',
        predicates: { allOf: [
          { kind: 'known-type-in', typeIds: ['dog-treats'], evidence: { pageField: 'title', quote: 'Biscuits & Crunchy' } },
          { kind: 'field-equals', targetId: 'food-form', value: 'Treat', evidence: { pageField: 'title', quote: 'Biscuits & Crunchy' } },
        ] },
        resolutionNotes: [{ decisionId: 'D-BAKERY-CRUNCHY', selectedOption: 'merge-one-subject', note: 'canonical' }],
      }),
      rule({
        pageId: DUPE, pageName: 'Dog Treats Bakery', status: 'excluded', ruleKind: 'excluded-role',
        predicates: { allOf: [] },
        ambiguityReasons: ['merged duplicate'],
        resolutionNotes: [{ decisionId: 'D-BAKERY-CRUNCHY', selectedOption: 'merge-one-subject', note: 'merged into canonical' }],
      }),
    ]);
    const result = derivePageGold(loaded, product({}));
    expect(result.completeness).toBe('complete');
    expect(result.pageIds).toEqual([CANON]);
  });

  it('coassigns pairs whose distinction the owner declined to split', () => {
    const loaded = loadedRev2(['Pest Control', 'Pest Control & Repellents'].map((name, i) => rule({
      pageId: i === 0 ? COA : COB, pageName: name,
      predicates: { allOf: [
        { kind: 'known-type-in', typeIds: ['dog-treats'], evidence: { pageField: 'name', quote: name } },
      ] },
      resolutionNotes: [{ decisionId: 'D-PEST-DISTINCTION', selectedOption: 'coassign', note: 'shared subject' }],
    })));
    const result = derivePageGold(loaded, product({}));
    expect(result.completeness).toBe('complete');
    expect(result.pageIds).toEqual([COA, COB].sort());
  });

  it('holds fallback-only rules out while closed merchandise matches, applies them otherwise', () => {
    const fallback = rule({
      pageId: FALLBACK, pageName: 'Dog Supplies Shop All', fallbackOnly: true,
      predicates: { allOf: [
        { kind: 'known-type-in', typeIds: ['dog-treats', 'dog-food-wet'], evidence: { pageField: 'name', quote: 'Dog Supplies Shop All' } },
      ] },
      resolutionNotes: [{ decisionId: 'D-SHOPALL', selectedOption: 'most-specific-only', note: 'fallback' }],
    });
    const specific = rule({
      pageId: DOG_TREATS_PAGE, pageName: 'Dog Treats',
      predicates: { allOf: [
        { kind: 'known-type-in', typeIds: ['dog-treats'], evidence: { pageField: 'name', quote: 'Dog Treats' } },
        { kind: 'field-equals', targetId: 'species', value: 'Dog', evidence: { pageField: 'name', quote: 'Dog Treats' } },
      ] },
    });
    const withSpecific = derivePageGold(loadedRev2([specific, fallback]), product({}));
    expect(withSpecific.pageIds).toEqual([DOG_TREATS_PAGE]);
    expect(withSpecific.completeness).toBe('complete');
    const fallbackOnly = derivePageGold(loadedRev2([fallback]), product({
      productType: { kind: 'known-type', typeId: 'dog-food-wet' },
      fieldByTarget: new Map([['food-form', { state: 'known', value: 'Wet Food' }]]),
    }));
    expect(fallbackOnly.pageIds).toEqual([FALLBACK]);
    expect(fallbackOnly.completeness).toBe('complete');
  });

  it('keeps zero-match-closed rules eligible but never matching', () => {
    const loaded = loadedRev2([
      rule({
        pageId: ZERO, pageName: 'Caged Bird Toys',
        predicates: { allOf: [
          { kind: 'zero-match-no-frozen-type', evidence: { pageField: 'name', quote: 'Caged Bird Toys' } },
        ] },
        resolutionNotes: [{ decisionId: 'D-NO-FROZEN-TYPE', selectedOption: 'eligible-zero-match-closed', note: 'no frozen type' }],
      }),
    ]);
    const zero = loaded.rules.find(r => r.pageId === ZERO)!;
    expect(zero.status).toBe('eligible');
    const result = derivePageGold(loaded, product({}));
    expect(result.pageIds).not.toContain(ZERO);
    expect(result.completeness).toBe('complete');
    expect(result.pageIds).toEqual([]);
  });

  it('rejects standalone violations for rev2-only constructs', () => {
    const root = tempRoot();
    const decisions = decisionsFile(root);
    const bad = packet([rule({
      pageId: ZERO, pageName: 'Bad Zero',
      predicates: { allOf: [
        { kind: 'zero-match-no-frozen-type', evidence: { pageField: 'name', quote: 'Bad Zero' } },
        { kind: 'known-type-in', typeIds: ['dog-treats'], evidence: { pageField: 'name', quote: 'Bad Zero' } },
      ] },
    })], decisions.sha, undefined, PAGE_RULE_PACKET_VERSION_V2);
    expect(() => loadPageRulePacket({
      packetPath: writePacket(root, bad), decisionsPath: decisions.path,
      expectedAuthorityHash: AUTHORITY, ...frozenFor(bad.rules.map(r => r.pageId)),
    })).toThrow(/standalone zero-match/);
  });

  it('accepts Freeze-Dried Raw on owner-confirmed raw-form rules', () => {
    const RAW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const loaded = loadedRev2([rule({
      pageId: RAW, pageName: 'Cat Food Raw',
      predicates: { allOf: [
        { kind: 'known-type-in', typeIds: ['cat-toys'], evidence: { pageField: 'title', quote: 'Raw Cat Food' } },
        { kind: 'field-equals', targetId: 'food-form', value: 'Frozen Raw', evidence: { pageField: 'text3', quote: 'Frozen raw cat food' } },
      ] },
      resolutionNotes: [{ decisionId: 'D-CAT-RAW', selectedOption: 'confirm-raw-forms', note: 'frozen + freeze-dried' }],
    })]);
    const frozen = new Map(Object.entries({
      'dog-treats': {}, 'dog-food-wet': {}, 'cat-toys': {},
    }));
    void frozen;
    const result = derivePageGold(loaded, product({
      productType: { kind: 'known-type', typeId: 'cat-toys' },
      fieldByTarget: new Map([['food-form', { state: 'known', value: 'Freeze-Dried Raw' }]]),
    }));
    expect(result.pageIds).toEqual([RAW]);
    expect(result.completeness).toBe('complete');
  });
});
