/**
 * Evidence-backed naming (issue #365): behavioral tests for candidate
 * construction, deterministic choice, conflict preservation, bounds, and
 * the persisted nameDecision record.
 *
 * Pure module tests (no DB, no network): the candidate builder and the
 * deterministic choice are fully deterministic functions of eligible input.
 */
import { describe, it, expect } from 'bun:test';
import {
  NAME_NORMALIZATION_VERSION,
  MAX_NAME_CANDIDATES,
  buildNameCandidates,
  deterministicNameChoice,
  type NameEvidenceText,
} from '../../classification/name-candidates';
import { hashNameInput } from '../../classification/name-decision';

const span = (channel: NameEvidenceText['channel'], text: string): NameEvidenceText => ({
  channel,
  span: text,
});

describe('buildNameCandidates', () => {
  it('builds a brand-first, quantity-last candidate from register evidence (zero calls)', () => {
    const outcome = buildNameCandidates({
      spans: [span('register', 'ACME Chicken Dinner 5LB')],
      brand: 'Acme',
    });
    if (outcome.kind !== 'candidates') throw new Error(`expected candidates, got ${outcome.kind}`);
    expect(outcome.candidates.length).toBeGreaterThan(0);
    const first = outcome.candidates[0].title;
    expect(first.startsWith('Acme')).toBe(true);
    expect(first.endsWith('5 lb')).toBe(true);
  });

  it('uses eligible official/distributor/OCR/manual spans for this SKU only', () => {
    const outcome = buildNameCandidates({
      spans: [
        span('register', 'ACME Dog Food'),
        span('official', 'Acme Premium Dog Food 10 lb'),
        span('ocr', 'Acme Premium Dog Food 10LB'),
        span('manual', 'Acme Premium Dog Food 10 lb'),
      ],
      brand: 'Acme',
    });
    if (outcome.kind !== 'candidates') throw new Error(`expected candidates, got ${outcome.kind}`);
    expect(outcome.candidates.some(c => c.title.includes('10 lb'))).toBe(true);
  });

  it('holds missing brand as actionable (never invents)', () => {
    const outcome = buildNameCandidates({
      spans: [span('register', 'Chicken Dinner 5LB')],
      brand: null,
    });
    if (outcome.kind !== 'missing') throw new Error(`expected missing, got ${outcome.kind}`);
    expect(outcome.reason.startsWith('missing_brand')).toBe(true);
  });

  it('allows a source-backed model-number name without universal quantity requirements', () => {
    const outcome = buildNameCandidates({
      spans: [span('register', 'Acme Model XR-4')],
      brand: 'Acme',
    });
    expect(outcome.kind).toBe('candidates');
    if (outcome.kind !== 'candidates') throw new Error('Expected a source-backed candidate');
    expect(outcome.candidates.some(candidate => candidate.title.includes('XR-4'))).toBe(true);
  });
  it('does not offer an attribute-only flavor as a complete product name', () => {
    const outcome = buildNameCandidates({
      spans: [
        { channel: 'official', span: 'Chicken', kind: 'flavor', evidenceId: 'flavor-only' },
        span('official', '12 oz'),
      ],
      brand: 'Acme',
    });
    expect(outcome.kind).toBe('missing');
  });

  it('carries supported flavor components onto genuine product-name candidates', () => {
    const outcome = buildNameCandidates({
      spans: [
        span('official', 'Acme Feeder'),
        { channel: 'official', span: 'Chicken', kind: 'flavor', evidenceId: 'flavor-fact' },
        span('official', '12 oz'),
      ],
      brand: 'Acme',
    });
    if (outcome.kind !== 'candidates') throw new Error(`expected candidates, got ${outcome.kind}`);
    expect(outcome.candidates.some(candidate => candidate.title.includes('Feeder') && candidate.title.includes('Chicken'))).toBe(true);
  });
  it('retains multiple applicable species without treating them as scalar conflicts', () => {
    const outcome = buildNameCandidates({
      spans: [
        span('official', 'Acme Multi-Species Food'),
        { channel: 'official', span: 'dog', kind: 'species', evidenceId: 'species-dog' },
        { channel: 'official', span: 'cat', kind: 'species', evidenceId: 'species-cat' },
      ],
      brand: 'Acme',
    });
    if (outcome.kind !== 'candidates') throw new Error(`expected candidates, got ${outcome.kind}`);
    expect(outcome.candidates.every(candidate => candidate.title.toLowerCase().includes('dog') && candidate.title.toLowerCase().includes('cat'))).toBe(true);
  });

  it('retains a numeric packCount as a typed pack component on every candidate', () => {
    const outcome = buildNameCandidates({
      spans: [
        span('register', 'Acme Dog Treats'),
        { channel: 'official', span: '6', kind: 'pack_count', evidenceId: 'pack-count' },
      ],
      brand: 'Acme',
    });
    if (outcome.kind !== 'candidates') throw new Error(`expected candidates, got ${outcome.kind}`);
    expect(outcome.candidates.every(candidate => candidate.title.includes('6 pack'))).toBe(true);
    expect(outcome.candidates.every(candidate => candidate.components.includes('6') && candidate.evidenceIds.includes('pack-count'))).toBe(true);
  });

  it('retains accepted strength as a mandatory, provenance-backed name component', () => {
    const outcome = buildNameCandidates({
      spans: [
        span('register', 'Acme Supplement'),
        { channel: 'official', span: '500 mg', kind: 'strength', evidenceId: 'strength-fact' },
      ],
      brand: 'Acme',
    });
    if (outcome.kind !== 'candidates') throw new Error(`expected candidates, got ${outcome.kind}`);
    expect(outcome.candidates.every(candidate => candidate.title.includes('500 mg'))).toBe(true);
    expect(outcome.candidates.every(candidate => candidate.components.includes('500 mg') && candidate.evidenceIds.includes('strength-fact'))).toBe(true);
  });



  it('never unions conflicting package sizes — conflict stays actionable', () => {
    const outcome = buildNameCandidates({
      spans: [
        span('register', 'ACME Dog Food 5LB'),
        span('official', 'Acme Dog Food 15 lb'),
      ],
      brand: 'Acme',
    });
    if (outcome.kind !== 'conflict') throw new Error(`expected conflict, got ${outcome.kind}`);
    expect(outcome.conflictingTokens.length).toBeGreaterThan(1);
  });

  it('never lets shipping weight replace net contents', () => {
    const outcome = buildNameCandidates({
      spans: [
        span('register', 'ACME Dog Food 5LB'),
        span('official', 'Shipping weight 12 lb'),
      ],
      brand: 'Acme',
    });
    if (outcome.kind !== 'candidates') throw new Error(`expected candidates, got ${outcome.kind}`);
    expect(outcome.candidates.every(c => !c.title.includes('12 lb'))).toBe(true);
    expect(outcome.candidates.some(c => c.title.includes('5 lb'))).toBe(true);
  });

  it('deduplicates formatting-equivalent candidates', () => {
    const outcome = buildNameCandidates({
      spans: [
        span('register', 'ACME Dog Food 5LB'),
        span('official', 'Acme Dog Food 5 lb'),
      ],
      brand: 'Acme',
    });
    if (outcome.kind !== 'candidates') throw new Error(`expected candidates, got ${outcome.kind}`);
    const titles = outcome.candidates.map(c => c.title.toLowerCase());
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('abstains visibly (overflow kind) beyond 16 candidates instead of clipping', () => {
    const spans: NameEvidenceText[] = [];
    for (let i = 0; i < 30; i++) {
      spans.push(span('distributor', `Acme Dog Food Recipe ${i} 5 lb`));
    }
    spans.push(span('register', 'ACME Dog Food 5LB'));
    const outcome = buildNameCandidates({ spans, brand: 'Acme' });
    if (outcome.kind !== 'overflow') throw new Error(`expected overflow, got ${outcome.kind}`);
    expect(outcome.candidateCount).toBeGreaterThan(MAX_NAME_CANDIDATES);
    expect(outcome.reason).toMatch(/overflow/i);
  });
});

describe('deterministicNameChoice', () => {
  it('resolves a single candidate with zero calls', () => {
    const picked = deterministicNameChoice([
      { title: 'Acme Dog Food 5 lb', components: ['ACME Dog Food 5LB'], evidenceIds: [] },
    ]);
    expect(picked?.title).toBe('Acme Dog Food 5 lb');
  });

  it('resolves stylistically-equivalent candidates with zero calls', () => {
    const picked = deterministicNameChoice([
      { title: 'Acme Dog Food 5 lb', components: ['a'], evidenceIds: [] },
      { title: 'Acme  Dog Food 5 LB', components: ['b'], evidenceIds: [] },
    ]);
    expect(picked).not.toBeNull();
  });

  it('returns null for semantically ambiguous candidates (typed Choice required)', () => {
    const picked = deterministicNameChoice([
      { title: 'Acme Chicken Dinner 5 lb', components: ['a'], evidenceIds: [] },
      { title: 'Acme Salmon Dinner 5 lb', components: ['b'], evidenceIds: [] },
    ]);
    expect(picked).toBeNull();
  });
});

describe('nameDecision provenance', () => {
  it('pins the normalization version', () => {
    expect(NAME_NORMALIZATION_VERSION).toBe('name-normalization-v2-applicable-variant');
    expect(MAX_NAME_CANDIDATES).toBe(16);
  });
});

describe('#365 follow-up — OCR species/form identity attributes', () => {
  it('treats a bare species span as attribute-only (never a candidate body)', () => {
    const outcome = buildNameCandidates({
      spans: [
        span('register', 'ACME DG 5LB'),
        { channel: 'ocr', span: 'Dog', kind: 'species' },
      ],
      brand: 'Acme',
    });
    if (outcome.kind !== 'candidates') throw new Error(`expected candidates, got ${outcome.kind}`);
    // The species span must not mint an 'Acme Dog …' body of its own.
    expect(outcome.candidates.every(c => !/^acme dog( |$)/i.test(c.title))).toBe(true);
  });

  it('treats a bare product-form span as attribute-only (never a candidate body)', () => {
    const outcome = buildNameCandidates({
      spans: [
        span('register', 'ACME DG 5LB'),
        { channel: 'ocr', span: 'Dry Kibble', kind: 'form' },
      ],
      brand: 'Acme',
    });
    if (outcome.kind !== 'candidates') throw new Error(`expected candidates, got ${outcome.kind}`);
    expect(outcome.candidates.every(c => !/dry kibble/i.test(c.title) || /dg/i.test(c.title))).toBe(true);
  });

  it('species/form spans join the hashed eligible bundle (drift invalidates reuse)', () => {
    const without = hashNameInput([span('register', 'ACME DG Food 5LB')]);
    const withSpecies = hashNameInput([
      span('register', 'ACME DG Food 5LB'),
      { channel: 'ocr', span: 'Dog', kind: 'species' },
    ]);
    expect(withSpecies).not.toBe(without);
  });
});

describe('#365 blockers — overflow, dimensions, per-candidate scoping', () => {
  it('abstains visibly (overflow kind) beyond 16 candidates instead of clipping', () => {
    const spans: NameEvidenceText[] = [];
    for (let i = 0; i < 30; i++) {
      spans.push(span('distributor', `Acme Dog Food Recipe ${i} 5 lb`));
    }
    spans.push(span('register', 'ACME Dog Food 5LB'));
    const outcome = buildNameCandidates({ spans, brand: 'Acme' });
    if (outcome.kind !== 'overflow') throw new Error(`expected overflow, got ${outcome.kind}`);
    expect(outcome.candidateCount).toBeGreaterThan(MAX_NAME_CANDIDATES);
    expect(outcome.reason).toMatch(/overflow/);
  });

  it('recognizes pt/ct/ea/pk as count dimensions', () => {
    const conflictFree = buildNameCandidates({
      spans: [span('register', 'ACME Dog Food 5LB 6 pt'), span('register', 'Acme Dog Food 5 lb')],
      brand: 'Acme',
    });
    // 6 pt (count) + 5 lb (weight) coexist; must not be a weight/weight conflict.
    if (conflictFree.kind === 'conflict') expect(conflictFree.reason).not.toMatch(/5 lb.*6|6.*5 lb/);
  });

  it('does not conflict on unit-converted equivalents (5 lb vs 80 oz)', () => {
    const outcome = buildNameCandidates({
      spans: [span('register', 'ACME Kibble 5 lb'), span('official', 'Acme Kibble 80 oz')],
      brand: 'Acme',
    });
    if (outcome.kind === 'conflict') throw new Error(`unexpected conflict: ${outcome.reason}`);
  });

  it('scopes per-candidate quantities (span A carries only its own quantity)', () => {
    const outcome = buildNameCandidates({
      spans: [span('register', 'Acme Chicken Dinner 5 lb')],
      brand: 'Acme',
    });
    if (outcome.kind !== 'candidates') throw new Error(`expected candidates, got ${outcome.kind}`);
    expect(outcome.candidates.length).toBeGreaterThan(0);
    expect(outcome.candidates.every(c => c.title.includes('5 lb'))).toBe(true);
  });

  it('offers only complete candidates (register name + separate measurement)', () => {
    const outcome = buildNameCandidates({
      spans: [
        { channel: 'register', span: 'Acme Chicken Dinner', evidenceId: 'ev-reg' },
        { channel: 'official', span: '5 lb', evidenceId: 'ev-meas' },
      ],
      brand: 'Acme',
    });
    if (outcome.kind !== 'candidates') throw new Error(`expected candidates, got ${outcome.kind}`);
    // No incomplete size-less offer: every candidate carries the union.
    expect(outcome.candidates.every(c => c.title.includes('5 lb'))).toBe(true);
    // Merged provenance names the measurement source (components + ids).
    const merged = outcome.candidates.find(c => c.components.length > 1);
    expect(merged).toBeDefined();
    expect(merged!.components).toContain('5 lb');
    expect(merged!.evidenceIds).toContain('ev-meas');
    expect(merged!.evidenceIds).toContain('ev-reg');
  });

  it('treats mass and volume as separate dimensions (16 fl oz vs 1 lb never unions)', () => {
    const outcome = buildNameCandidates({
      spans: [span('register', 'Acme Soup 16 fl oz'), span('official', 'Acme Soup 1 lb')],
      brand: 'Acme',
    });
    if (outcome.kind !== 'candidates') throw new Error(`expected candidates, got ${outcome.kind}`);
    // Both quantities survive (no cross-span union into one title).
    const titles = outcome.candidates.map(c => c.title);
    expect(titles.some(t => t.includes('16 fl oz'))).toBe(true);
    expect(titles.some(t => t.includes('1 lb'))).toBe(true);
  });

  it('treats volume equivalents as equal (1 gal vs 4 qt never conflicts)', () => {
    const outcome = buildNameCandidates({
      spans: [span('register', 'Acme Water 1 gal'), span('official', 'Acme Water 4 qt')],
      brand: 'Acme',
    });
    if (outcome.kind === 'conflict') throw new Error(`unexpected conflict: ${outcome.reason}`);
  });
});
