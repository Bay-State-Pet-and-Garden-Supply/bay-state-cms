/**
 * PR9 C1 (issue #30): pure cohort semantic validator — unit tests.
 *
 * Covers every check family of `cohort-semantic-validator.ts`:
 *   - SKU-local (issue #351): NO family Product Type invariant — the
 *     suggested type is never judged against a parent conclusion;
 *   - family_invariant: Brand mismatch blocked; tie-brand blocked;
 *   - coordinated_variant: title correspondence pass/mismatch; page
 *     correspondence (assigned exact, abstained none, missing row); sibling
 *     title/page VARIANT differences always pass (never sibling equality);
 *   - member_local: inapplicable attribute blocked; universal exempt;
 *     cardinality finding (defense-in-depth);
 *   - singleton cohort follows the same validator architecture.
 */
import { describe, it, expect } from 'bun:test';
import {
  validateMemberSemantics,
  validateMemberLocalAttributes,
  validateCohortBrandCoherence,
} from '../../classification/cohort-semantic-validator';

/** A fully coherent member semantics input (group member with durable title
 *  + assigned durable pages). */
function coherentMember(overrides: Record<string, unknown> = {}) {
  return {
    memberSku: '100000000001',
    curatedTitle: 'Purina Pro Plan Dry Dog Food Chicken 5 lb',
    titleSource: 'cohort_fallback',
    suggestedPages: ['Dog Food Dry'],
    suggestedProductType: 'dry-dog-food',
    durableTitleOutput: { title: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', source: 'cohort_fallback' as const },
    durablePageOutput: { status: 'assigned' as const, pages: [{ pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.9 }] },
    pageOutputExpectedEmpty: false,
    ...overrides,
  };
}

// ─── SKU-local evidence (issue #351): no family Product Type invariant ────────

describe('validateMemberSemantics — no family Product Type invariant', () => {
  it('passes regardless of the suggested type — siblings are never judged against a parent conclusion', () => {
    for (const suggestedProductType of ['dry-dog-food', 'Dry Dog Food', 'dog-treats', null, '']) {
      const result = validateMemberSemantics(coherentMember({ suggestedProductType }));
      expect(result.findings.map(f => String(f.code))).not.toContain('family_product_type');
    }
  });

  it('a fully coherent member still passes with no family findings', () => {
    const result = validateMemberSemantics(coherentMember());
    expect(result.status).toBe('passed');
    expect(result.findings).toEqual([]);
  });
});

// ─── coordinated_variant: title correspondence ────────────────────────────────

describe('validateMemberSemantics — coordinated_variant title', () => {
  it('R2 (B): a matching title with a DIFFERENT source than the durable authority is a coordinated_title finding (the fixed bug-locking test)', () => {
    // The fixture's durable source is 'cohort_fallback'; the test used to flip
    // the member source to 'llm_cohort' and expect a pass — exact title/source
    // correspondence now requires BOTH to equal the durable authority.
    const result = validateMemberSemantics(coherentMember({ titleSource: 'llm_cohort' }));
    expect(result.status).toBe('blocked');
    expect(result.findings.some(f => f.code === 'coordinated_title')).toBe(true);
  });

  it('R2 (B): exact title source equality in both directions', () => {
    // Direction 1: member claims cohort_fallback while the durable authority
    // is llm_cohort (title text matches) → finding.
    const mismatched = validateMemberSemantics(coherentMember({
      durableTitleOutput: { title: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', source: 'llm_cohort' as const },
    }));
    expect(mismatched.status).toBe('blocked');
    expect(mismatched.findings.some(f => f.code === 'coordinated_title')).toBe(true);
    // Direction 2: exact title AND source equality passes (both cohort
    // sources, and the llm_cohort pair).
    expect(validateMemberSemantics(coherentMember({ titleSource: 'cohort_fallback' })).status).toBe('passed');
    expect(validateMemberSemantics(coherentMember({
      titleSource: 'llm_cohort',
      durableTitleOutput: { title: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', source: 'llm_cohort' as const },
    })).status).toBe('passed');
  });

  it('blocks a curated title that differs from the durable output', () => {
    const result = validateMemberSemantics(coherentMember({ curatedTitle: 'Some Other Title' }));
    expect(result.status).toBe('blocked');
    const finding = result.findings.find(f => f.code === 'coordinated_title')!;
    expect(finding.message).toContain('Some Other Title');
  });

  it('blocks a non-cohort titleSource on a member with a durable title', () => {
    const result = validateMemberSemantics(coherentMember({ titleSource: 'web' }));
    expect(result.status).toBe('blocked');
    expect(result.findings.some(f => f.code === 'coordinated_title')).toBe(true);
  });

  it('blocks a cohort-coordinated title that claims a source without a durable output', () => {
    const result = validateMemberSemantics(coherentMember({
      durableTitleOutput: null,
      titleSource: 'cohort_fallback',
    }));
    expect(result.status).toBe('blocked');
    expect(result.findings.some(f => f.code === 'coordinated_title')).toBe(true);
  });

  it('passes a singleton-style per-item title (no durable output, non-cohort source)', () => {
    const result = validateMemberSemantics(coherentMember({
      durableTitleOutput: null,
      titleSource: 'ocr',
      curatedTitle: 'Per Item Title',
    }));
    expect(result.status).toBe('passed');
  });
});

// ─── coordinated_variant: page correspondence ─────────────────────────────────

describe('validateMemberSemantics — coordinated_variant pages', () => {
  it('passes when suggestedPages exactly match the assigned durable pages (any order)', () => {
    const result = validateMemberSemantics(coherentMember({ suggestedPages: ['Dog Food Dry'] }));
    expect(result.status).toBe('passed');
    const multi = validateMemberSemantics(coherentMember({
      suggestedPages: ['Brand - Acme', 'Dog Food Dry'],
      durablePageOutput: { status: 'assigned' as const, pages: [
        { pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.9 },
        { pageId: 'p2', pageName: 'Brand - Acme', confidence: 0.7 },
      ] },
    }));
    expect(multi.status).toBe('passed');
  });

  it('blocks pages that do not exactly match the assigned durable pages', () => {
    const result = validateMemberSemantics(coherentMember({ suggestedPages: ['Dog Treats'] }));
    expect(result.status).toBe('blocked');
    const finding = result.findings.find(f => f.code === 'coordinated_page')!;
    expect(finding.message).toContain('Dog Treats');
    expect(finding.message).toContain('Dog Food Dry');
  });

  it('passes when an abstained durable row corresponds to zero pages', () => {
    const result = validateMemberSemantics(coherentMember({
      suggestedPages: [],
      durablePageOutput: { status: 'abstained' as const, reason: 'policy denied' },
    }));
    expect(result.status).toBe('passed');
  });

  it('blocks pages on an abstained durable row', () => {
    const result = validateMemberSemantics(coherentMember({
      suggestedPages: ['Dog Food Dry'],
      durablePageOutput: { status: 'abstained' as const, reason: 'policy denied' },
    }));
    expect(result.status).toBe('blocked');
    expect(result.findings.some(f => f.code === 'coordinated_page')).toBe(true);
  });

  it('blocks a missing durable page row without the expected-empty marker', () => {
    const result = validateMemberSemantics(coherentMember({
      durablePageOutput: null,
      pageOutputExpectedEmpty: false,
    }));
    expect(result.status).toBe('blocked');
    expect(result.findings.some(f => f.code === 'coordinated_page')).toBe(true);
  });

  it('passes a missing row when the parent chose expected-empty', () => {
    const result = validateMemberSemantics(coherentMember({
      durablePageOutput: null,
      pageOutputExpectedEmpty: true,
      suggestedPages: [],
    }));
    expect(result.status).toBe('passed');
  });

  // ── PR9 review R2 (B): STABLE PAGE ID identity correspondence ────────────

  it('R2 (B): passes when the member proposal page IDs exactly set-match the durable ids', () => {
    const result = validateMemberSemantics(coherentMember({
      suggestedPages: ['Dog Food Dry'],
      pageProposals: [{ pageId: 'p1', pageName: 'Dog Food Dry' }],
    }));
    expect(result.status).toBe('passed');
    expect(result.findings).toEqual([]);
  });

  it('R2 (B): blocks a proposal whose STABLE PAGE ID differs while the display name matches (wrong id, same name)', () => {
    const result = validateMemberSemantics(coherentMember({
      suggestedPages: ['Dog Food Dry'],
      pageProposals: [{ pageId: 'pX', pageName: 'Dog Food Dry' }],
      durablePageOutput: { status: 'assigned' as const, pages: [{ pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.9 }] },
    }));
    expect(result.status).toBe('blocked');
    const finding = result.findings.find(f => f.code === 'coordinated_page')!;
    expect(finding.memberSku).toBe('100000000001');
    expect(finding.message).toContain('pX');
    expect(finding.message).toContain('p1');
  });

  it('R2 (B): a pageName mismatch on a MATCHED page id is an advisory diagnostic — never a review blocker', () => {
    const result = validateMemberSemantics(coherentMember({
      suggestedPages: ['Dog Food Dry (New)'],
      pageProposals: [{ pageId: 'p1', pageName: 'Dog Food Dry (New)' }],
      durablePageOutput: { status: 'assigned' as const, pages: [{ pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.9 }] },
    }));
    expect(result.status).toBe('passed'); // advisory-only
    const finding = result.findings.find(f => f.code === 'coordinated_page_name_mismatch')!;
    expect(finding.memberSku).toBe('100000000001');
    expect(finding.message).toContain('p1');
    expect(result.findings.some(f => f.code === 'coordinated_page')).toBe(false);
  });

  it('R2 (B): expected-empty REQUIRES zero pages AND zero category_page proposals', () => {
    const blocked = validateMemberSemantics(coherentMember({
      durablePageOutput: null,
      pageOutputExpectedEmpty: true,
      suggestedPages: ['Dog Food Dry'],
      pageProposals: [{ pageId: 'p1', pageName: 'Dog Food Dry' }],
    }));
    expect(blocked.status).toBe('blocked');
    expect(blocked.findings.some(f => f.code === 'coordinated_page')).toBe(true);
    const passes = validateMemberSemantics(coherentMember({
      durablePageOutput: null,
      pageOutputExpectedEmpty: true,
      suggestedPages: [],
      pageProposals: [],
    }));
    expect(passes.status).toBe('passed');
  });

  it('R2 (B): an abstained durable row requires zero pages AND zero proposals — a proposal with the same display name but a wrong id must NOT pass', () => {
    const result = validateMemberSemantics(coherentMember({
      suggestedPages: [],
      pageProposals: [{ pageId: 'pX', pageName: 'Dog Food Dry' }],
      durablePageOutput: { status: 'abstained' as const, reason: 'policy denied' },
    }));
    expect(result.status).toBe('blocked');
    expect(result.findings.some(f => f.code === 'coordinated_page')).toBe(true);
  });

  // ── PR9 review R3: PRESENCE vs NON-EMPTINESS of the proposal set ──────────

  it('R3: an EXPLICITLY SUPPLIED EMPTY proposal set against an assigned durable set BLOCKS — the display-name fallback must never mask a missing materialization', () => {
    const result = validateMemberSemantics(coherentMember({
      suggestedPages: ['Dog Food Dry'], // display name matches the durable page
      pageProposals: [], // production supplied the member's set — it is empty
      durablePageOutput: { status: 'assigned' as const, pages: [{ pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.9 }] },
    }));
    expect(result.status).toBe('blocked');
    const finding = result.findings.find(f => f.code === 'coordinated_page')!;
    expect(finding.memberSku).toBe('100000000001');
    expect(finding.message).toContain('p1');
  });

  it('R3: an EXPLICITLY SUPPLIED set containing an identity-less proposal BLOCKS even when the stable-id subset matches', () => {
    const result = validateMemberSemantics(coherentMember({
      suggestedPages: ['Dog Food Dry'],
      pageProposals: [
        { pageId: 'p1', pageName: 'Dog Food Dry' },
        { pageId: null, pageName: 'Dog Food Dry' }, // no stable identity
      ],
      durablePageOutput: { status: 'assigned' as const, pages: [{ pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.9 }] },
    }));
    expect(result.status).toBe('blocked');
    const finding = result.findings.find(f => f.code === 'coordinated_page')!;
    expect(finding.memberSku).toBe('100000000001');
    expect(finding.message).toContain('no stable page identity');
  });

  it('R3: the legacy name-based fallback still applies ONLY when the proposal set is absent entirely (direct/synthetic callers)', () => {
    const result = validateMemberSemantics(coherentMember({
      suggestedPages: ['Dog Food Dry'],
      // pageProposals NOT supplied (undefined) — synthetic caller
      durablePageOutput: { status: 'assigned' as const, pages: [{ pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.9 }] },
    }));
    expect(result.status).toBe('passed');
  });
});

// ─── coordinated_variant: sibling VARIANT differences pass ───────────────────

describe('validateMemberSemantics — sibling VARIANT differences never fail', () => {
  it('title variant differences between siblings pass (each matches its own durable output)', () => {
    // Sibling A: Chicken variant; Sibling B: Beef variant. Different titles,
    // each corresponding to its OWN durable output → PASS.
    const siblingA = validateMemberSemantics(coherentMember({
      memberSku: '100000000001',
      curatedTitle: 'Purina Pro Plan Dry Dog Food Chicken 5 lb',
      titleSource: 'cohort_fallback',
      durableTitleOutput: { title: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', source: 'cohort_fallback' },
    }));
    const siblingB = validateMemberSemantics(coherentMember({
      memberSku: '100000000002',
      curatedTitle: 'Purina Pro Plan Dry Dog Food Beef 10 lb',
      titleSource: 'cohort_fallback',
      durableTitleOutput: { title: 'Purina Pro Plan Dry Dog Food Beef 10 lb', source: 'cohort_fallback' },
    }));
    expect(siblingA.status).toBe('passed');
    expect(siblingB.status).toBe('passed');
  });

  it('page differences between siblings pass (each matches its own durable output)', () => {
    // Sibling A pages=[Dog Food Dry], Sibling B pages=[Dog Food Dry, Brand - Acme].
    // The MIGRATION TEST: the new validator passes this coordinated_variant
    // case (the legacy validateSiblingConsistency still warns on the same data).
    const siblingA = validateMemberSemantics(coherentMember({
      memberSku: '100000000001',
      suggestedPages: ['Dog Food Dry'],
      durablePageOutput: { status: 'assigned' as const, pages: [{ pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.9 }] },
    }));
    const siblingB = validateMemberSemantics(coherentMember({
      memberSku: '100000000002',
      suggestedPages: ['Dog Food Dry', 'Brand - Acme'],
      durablePageOutput: { status: 'assigned' as const, pages: [
        { pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.9 },
        { pageId: 'p2', pageName: 'Brand - Acme', confidence: 0.7 },
      ] },
    }));
    expect(siblingA.status).toBe('passed');
    expect(siblingB.status).toBe('passed');
  });
});

// ─── member_local: profile applicability + cardinality ───────────────────────

const ATTRIBUTE_CONFIG = [
  { id: 'brand', isUniversal: true },
  { id: 'flavor', isUniversal: false },
  { id: 'species', isUniversal: false },
];

function localInput(overrides: Record<string, unknown> = {}) {
  return {
    memberSku: '100000000001',
    proposals: [{ targetId: 'flavor' }],
    effectiveTypeId: 'dry-dog-food',
    attributeConfig: ATTRIBUTE_CONFIG,
    universalAttributeIds: ['brand'],
    profileAttributeIds: new Set(['flavor']),
    cardinalityByAttributeId: new Map<string, 'single' | 'multiple'>([['flavor', 'single']]),
    ...overrides,
  };
}

/** Minimal frozen ReviewedFact for conditional-applicability tests. */
function makeReviewedFact(targetId: string, value: unknown) {
  return {
    proposalId: 'fact-proposal',
    decisionId: 'fact-decision',
    runId: 'fact-run',
    workspaceId: 'ws-test',
    productSku: '100000000001',
    proposalType: 'field_assignment',
    targetId,
    value,
    configSnapshotHash: null,
    sourceHash: null,
    createdAt: '2026-08-01T00:00:00.000Z',
  };
}

describe('validateMemberLocalAttributes — profile applicability', () => {
  it('passes a profile-applicable non-universal proposal', () => {
    const result = validateMemberLocalAttributes(localInput());
    expect(result.status).toBe('passed');
  });

  it('blocks a non-universal proposal outside the effective type profile', () => {
    const result = validateMemberLocalAttributes(localInput({
      proposals: [{ targetId: 'species' }],
    }));
    expect(result.status).toBe('blocked');
    const finding = result.findings.find(f => f.code === 'member_attribute_applicability')!;
    expect(finding.memberSku).toBe('100000000001');
    expect(finding.message).toContain('species');
    expect(finding.message).toContain('dry-dog-food');
  });

  it('exempts universal attribute proposals regardless of the profile', () => {
    const result = validateMemberLocalAttributes(localInput({
      proposals: [{ targetId: 'brand' }],
      profileAttributeIds: new Set(['flavor']),
    }));
    expect(result.status).toBe('passed');
  });

  it('blocks a non-universal proposal when there is no effective type', () => {
    const result = validateMemberLocalAttributes(localInput({
      effectiveTypeId: null,
      profileAttributeIds: null,
    }));
    expect(result.status).toBe('blocked');
    expect(result.findings.some(f => f.code === 'member_attribute_applicability')).toBe(true);
  });

  it('blocks a non-universal proposal under a legitimately EMPTY profile', () => {
    const result = validateMemberLocalAttributes(localInput({
      profileAttributeIds: new Set<string>(),
    }));
    expect(result.status).toBe('blocked');
    expect(result.findings.some(f => f.code === 'member_attribute_applicability')).toBe(true);
  });

  // ── PR9 review R1 (B4): conditional applicability re-validation ──────────

  it('blocks a profile-member attribute whose applicability condition is FALSE', () => {
    const result = validateMemberLocalAttributes(localInput({
      proposals: [{ targetId: 'flavor', proposedValue: 'Chicken' }],
      profileEntriesByAttributeId: new Map([[
        'flavor',
        { attributeId: 'flavor', cardinality: 'single', applicabilityConditions: [{ operator: 'equals', attributeId: 'species', value: 'cat' }] },
      ]]),
      reviewedFacts: [makeReviewedFact('species', 'dog')],
    }));
    expect(result.status).toBe('blocked');
    const finding = result.findings.find(f => f.code === 'member_attribute_applicability')!;
    expect(finding.message).toContain('flavor');
    expect(finding.message).toContain('NOT satisfied');
  });

  it('blocks a profile-member attribute whose applicability condition is UNRESOLVABLE (missing frozen fact — fail closed)', () => {
    const result = validateMemberLocalAttributes(localInput({
      proposals: [{ targetId: 'flavor', proposedValue: 'Chicken' }],
      profileEntriesByAttributeId: new Map([[
        'flavor',
        { attributeId: 'flavor', cardinality: 'single', applicabilityConditions: [{ operator: 'equals', attributeId: 'species', value: 'cat' }] },
      ]]),
      reviewedFacts: [],
    }));
    expect(result.status).toBe('blocked');
    const finding = result.findings.find(f => f.code === 'member_attribute_applicability')!;
    expect(finding.message).toContain('cannot be resolved');
  });

  it('passes a profile-member attribute whose applicability condition is SATISFIED', () => {
    const result = validateMemberLocalAttributes(localInput({
      proposals: [{ targetId: 'flavor', proposedValue: 'Chicken' }],
      profileEntriesByAttributeId: new Map([[
        'flavor',
        { attributeId: 'flavor', cardinality: 'single', applicabilityConditions: [{ operator: 'equals', attributeId: 'species', value: 'dog' }] },
      ]]),
      reviewedFacts: [makeReviewedFact('species', 'dog')],
    }));
    expect(result.status).toBe('passed');
  });

  it('records a cardinality finding for a single-cardinality attribute with >1 distinct values', () => {
    const result = validateMemberLocalAttributes(localInput({
      proposals: [
        { targetId: 'flavor', proposedValue: 'Chicken' },
        { targetId: 'flavor', proposedValue: 'Beef' },
      ],
    }));
    expect(result.status).toBe('blocked');
    const finding = result.findings.find(f => f.code === 'member_cardinality')!;
    expect(finding.message).toContain('flavor');
    expect(finding.message).toContain('2');
  });

  it('ignores identical retry duplicates (re-executed member accumulation)', () => {
    // A re-executed member (crash between pipeline completion and the atomic
    // commit) legitimately accumulates IDENTICAL proposals from earlier
    // attempts on the same child run — never a semantic breach.
    const result = validateMemberLocalAttributes(localInput({
      proposals: [
        { targetId: 'flavor', proposedValue: 'Chicken' },
        { targetId: 'flavor', proposedValue: 'Chicken' },
      ],
    }));
    expect(result.status).toBe('passed');
  });

  it('passes multiple distinct values for a multiple-cardinality attribute', () => {
    const result = validateMemberLocalAttributes(localInput({
      proposals: [
        { targetId: 'flavor', proposedValue: 'Chicken' },
        { targetId: 'flavor', proposedValue: 'Beef' },
      ],
      cardinalityByAttributeId: new Map<string, 'single' | 'multiple'>([['flavor', 'multiple']]),
    }));
    expect(result.status).toBe('passed');
  });

  // ── PR9 review R1 (B5): multi-value array cardinality ──────────────────────

  it('blocks a single-cardinality attribute carrying a MULTI-VALUE array in ONE proposal', () => {
    const result = validateMemberLocalAttributes(localInput({
      proposals: [{ targetId: 'flavor', proposedValue: ['Chicken', 'Beef'] }],
    }));
    expect(result.status).toBe('blocked');
    const finding = result.findings.find(f => f.code === 'member_cardinality')!;
    expect(finding.message).toContain('flavor');
    expect(finding.message).toContain('2');
  });

  it('passes duplicate array members (identical values are never a breach)', () => {
    const result = validateMemberLocalAttributes(localInput({
      proposals: [{ targetId: 'flavor', proposedValue: ['Chicken', 'Chicken', ''] }],
    }));
    expect(result.status).toBe('passed');
  });

  it('blocks a REVISED multi-value array on a single-cardinality attribute', () => {
    const result = validateMemberLocalAttributes(localInput({
      proposals: [{ targetId: 'flavor', proposedValue: 'Chicken', revisedValue: ['Chicken', 'Beef'], hasRevisedValue: true }],
    }));
    expect(result.status).toBe('blocked');
    const finding = result.findings.find(f => f.code === 'member_cardinality')!;
    expect(finding.message).toContain('flavor');
  });

  it('passes a multiple-cardinality attribute carrying a multi-value array', () => {
    const result = validateMemberLocalAttributes(localInput({
      proposals: [{ targetId: 'flavor', proposedValue: ['Chicken', 'Beef'] }],
      cardinalityByAttributeId: new Map<string, 'single' | 'multiple'>([['flavor', 'multiple']]),
    }));
    expect(result.status).toBe('passed');
  });
});

// ─── family_invariant: mutual Brand coherence ─────────────────────────────────

describe('validateCohortBrandCoherence — mutual Brand coherence', () => {
  it('passes when all members normalize to one canonical brand', () => {
    const result = validateCohortBrandCoherence([
      { sku: '100000000001', frozenBrandEvidence: ['Acme', 'Acme'] },
      { sku: '100000000002', frozenBrandEvidence: ['Acme', 'Acme'] },
      { sku: '100000000003', frozenBrandEvidence: ['Acme Inc.', 'Acme'] },
    ]);
    expect(result.status).toBe('passed');
  });

  it('blocks the minority member whose brand conflicts with the canonical brand', () => {
    const result = validateCohortBrandCoherence([
      { sku: '100000000001', frozenBrandEvidence: ['Acme', 'Acme'] },
      { sku: '100000000002', frozenBrandEvidence: ['Acme', 'Acme'] },
      { sku: '100000000003', frozenBrandEvidence: ['Generic', 'Generic'] },
    ]);
    expect(result.status).toBe('blocked');
    const finding = result.findings.find(f => f.code === 'family_brand')!;
    expect(finding.memberSku).toBe('100000000003');
    expect(finding.message).toContain('generic');
    expect(finding.message).toContain('acme');
    expect(result.findings).toHaveLength(1);
  });

  it('blocks every member on a brand-evidence tie and lists the tied brands', () => {
    const result = validateCohortBrandCoherence([
      { sku: '100000000001', frozenBrandEvidence: ['Acme'] },
      { sku: '100000000002', frozenBrandEvidence: ['Generic'] },
    ]);
    expect(result.status).toBe('blocked');
    expect(result.findings.every(f => f.code === 'family_brand')).toBe(true);
    expect(result.findings.some(f => f.memberSku === '100000000001')).toBe(true);
    expect(result.findings.some(f => f.memberSku === '100000000002')).toBe(true);
    expect(result.findings[0].message).toContain('acme');
    expect(result.findings[0].message).toContain('generic');
  });

  it('passes when no member carries brand evidence (nothing to compare)', () => {
    const result = validateCohortBrandCoherence([
      { sku: '100000000001', frozenBrandEvidence: [null, null] },
      { sku: '100000000002', frozenBrandEvidence: [undefined, ''] },
    ]);
    expect(result.status).toBe('passed');
  });

  it('singleton cohort follows the same architecture: self-coherent evidence passes', () => {
    const result = validateCohortBrandCoherence([
      { sku: '100000000001', frozenBrandEvidence: ['Acme', 'Acme Inc.'] },
    ]);
    expect(result.status).toBe('passed');
  });

  it('singleton cohort with internally conflicting brand evidence blocks', () => {
    const result = validateCohortBrandCoherence([
      { sku: '100000000001', frozenBrandEvidence: ['Acme', 'Generic'] },
    ]);
    expect(result.status).toBe('blocked');
    expect(result.findings.every(f => f.code === 'family_brand')).toBe(true);
  });

  it('tie ordering uses an explicit code-point comparator (non-ASCII normalized brands, PR9 review R1 SHOULD-FIX b)', () => {
    // é (U+00E9) sorts AFTER 'z' (U+007A) by code point but BEFORE it under
    // locale collation in most locales — the persisted tie list must be
    // deterministic across deployments, never ambient ICU behavior.
    const result = validateCohortBrandCoherence([
      { sku: '100000000001', frozenBrandEvidence: ['éclair'] },
      { sku: '100000000002', frozenBrandEvidence: ['Zoo'] },
    ]);
    expect(result.status).toBe('blocked');
    expect(result.findings).toHaveLength(2);
    const tieList = result.findings[0].message.match(/tied canonical brands: ([^)]+)/);
    expect(tieList![1]).toBe('zoo, éclair');
  });
});

// ─── family_invariant: canonical Brand identity (PR9 review R2, C) ────────────

describe('validateCohortBrandCoherence — canonical Brand identity via frozen configured brands (PR9 review R2, C)', () => {
  const HILLS_BRANDS = [
    { id: 'hills', name: "Hill's Science Diet", aliases: ['Science Diet'], oldIdAliases: [] },
  ];
  const ACME_PURINA = [
    { id: 'acme', name: 'Acme', aliases: [], oldIdAliases: [] },
    { id: 'purina', name: 'Purina', aliases: [], oldIdAliases: [] },
  ];

  it('R2 (C): alias coherence passes — raw texts resolving to the SAME canonical id are coherent', () => {
    const result = validateCohortBrandCoherence([
      { sku: '100000000001', frozenBrandEvidence: ["Hill's Science Diet"] },
      { sku: '100000000002', frozenBrandEvidence: ['Science Diet'] },
    ], { brands: HILLS_BRANDS });
    expect(result.status).toBe('passed');
    expect(result.findings).toEqual([]);
  });

  it('R2 (C): prefix match coherence passes (raw text resolves to the same canonical id via longest-prefix)', () => {
    const result = validateCohortBrandCoherence([
      { sku: '100000000001', frozenBrandEvidence: ['Acme'] },
      { sku: '100000000002', frozenBrandEvidence: ['Acme Dry Dog Food'] },
    ], { brands: [{ id: 'acme', name: 'Acme', aliases: [], oldIdAliases: [] }] });
    expect(result.status).toBe('passed');
  });

  it('R2 (C): two DISTINCT canonical ids block regardless of counts (NO majority forcing)', () => {
    // 3× Acme, 1× Purina — a deterministic majority would forgive Purina;
    // canonical identity does NOT.
    const result = validateCohortBrandCoherence([
      { sku: '100000000001', frozenBrandEvidence: ['Acme'] },
      { sku: '100000000002', frozenBrandEvidence: ['Acme'] },
      { sku: '100000000003', frozenBrandEvidence: ['Acme'] },
      { sku: '100000000004', frozenBrandEvidence: ['Purina'] },
    ], { brands: ACME_PURINA });
    expect(result.status).toBe('blocked');
    expect(result.findings.every(f => f.code === 'family_brand')).toBe(true);
    expect(result.findings).toHaveLength(4);
    expect(result.findings[0].message).toContain('acme');
    expect(result.findings[0].message).toContain('purina');
  });

  it('R2 (C): flags ONLY the member whose evidence resolves outside the cohort consensus', () => {
    const result = validateCohortBrandCoherence([
      { sku: '100000000001', frozenBrandEvidence: ['Acme', 'Acme'] },
      { sku: '100000000002', frozenBrandEvidence: ['Acme', 'Purina'] },
      { sku: '100000000003', frozenBrandEvidence: ['Acme', 'Acme'] },
    ], { brands: ACME_PURINA });
    expect(result.status).toBe('blocked');
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];
    expect(finding.memberSku).toBe('100000000002');
    expect(finding.message).toContain('acme');
    expect(finding.message).toContain('purina');
  });

  it('R2 (C): unresolved-text members are diagnostic-only — no member resolves → the validator ABSTAINS (no hard block)', () => {
    const result = validateCohortBrandCoherence([
      { sku: '100000000001', frozenBrandEvidence: ['Generic', 'Mystery Brand'] },
      { sku: '100000000002', frozenBrandEvidence: ['Unknown Co'] },
    ], { brands: HILLS_BRANDS });
    expect(result.status).toBe('passed');
    expect(result.findings).toEqual([]);
  });

  it('R2 (C): unresolved members never block when the resolved cohort is coherent (diagnostic-only)', () => {
    const result = validateCohortBrandCoherence([
      { sku: '100000000001', frozenBrandEvidence: ['Acme'] },
      { sku: '100000000002', frozenBrandEvidence: ['Acme'] },
      { sku: '100000000003', frozenBrandEvidence: ['Unresolvable Brand'] },
    ], { brands: [{ id: 'acme', name: 'Acme', aliases: [], oldIdAliases: [] }] });
    expect(result.status).toBe('passed');
    expect(result.findings).toEqual([]);
  });
});
