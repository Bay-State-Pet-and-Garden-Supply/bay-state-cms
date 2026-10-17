// @vitest-environment jsdom
/**
 * Epic #46 review round — ReviewClassificationPanel clarity contract.
 *
 * The operator reported the Classification section was confusing: raw JSON
 * blobs, abstentions with meaningless Accept/Reject buttons, duplicated
 * attribute rows, and unlabeled confidence. These tests pin the new
 * presentation rules:
 * - abstentions are informational (never accept/reject affordances),
 * - values are humanized (product type label, no JSON),
 * - identical pending proposals merge into one row,
 * - confidence renders as a qualitative chip + percent.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import type { ClassificationProposal } from '../../shared/schemas/classification';
import { ReviewClassificationPanel } from '../../client/components/onboarding/review/ReviewClassificationPanel';
import type { ItemDetailResponse } from '../../client/onboarding-api';

let fixtureSeq = 0;

function proposal(partial: Partial<ClassificationProposal>): ClassificationProposal {
  fixtureSeq += 1;
  return {
    id: `p-${String(fixtureSeq).padStart(3, '0')}`,
    runId: 'run-1',
    productSku: 'SKU',
    proposalType: 'field_assignment',
    targetId: 'material',
    proposedValue: 'Nylon',
    confidence: 0.85,
    evidenceIds: [],
    status: 'pending',
    isBulkAcceptable: false,
    isStale: false,
    stalenessReason: null,
    snapshotHash: null,
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

async function renderWith(
  proposals: ClassificationProposal[],
  onDecision: (p: ClassificationProposal, d: 'accepted' | 'rejected') => Promise<void> = vi.fn(),
  classificationReadiness?: unknown,
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const detail = {
    item: {
      curationData: { classificationProposals: proposals, suggestedPages: [] },
    },
    classificationReadiness,
  } as unknown as ItemDetailResponse;
  await act(async () => {
    root.render(
      <ReviewClassificationPanel detail={detail} onDecision={onDecision} busyDecisionId={null} />,
    );
  });
  return {
    container,
    text: () => container.textContent ?? '',
    buttons: () => Array.from(container.querySelectorAll('button')).map(b => b.textContent ?? ''),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('ReviewClassificationPanel clarity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders abstentions as informational notes with NO accept/reject buttons', async () => {
    const abstention = proposal({
      proposalType: 'reviewable_abstention',
      targetId: 'primary-product-type',
      proposedValue: { reason: 'No title signals available from evidence.' },
      confidence: 0,
    });
    const r = await renderWith([abstention]);
    const text = r.text();
    expect(text).toContain('Nothing to propose');
    expect(text).toContain('No title signals available from evidence.');
    expect(r.buttons()).toEqual([]);
    r.unmount();
  });

  it('renders the canonical Category + Product Type pair as one reviewed Product Classification', async () => {
    const pair = proposal({
      proposalType: 'product_classification',
      targetId: 'poultry-feed',
      proposedValue: { categoryId: 'poultry', productTypeId: 'poultry-feed', matchedWords: [] },
      confidence: 0.35,
    });
    const r = await renderWith([pair]);
    const text = r.text();
    expect(text).toContain('Product Classification');
    expect(text).toContain('Poultry / Poultry Feed');
    expect(text).toContain('35%');
    expect(text).toContain('Low');
    expect(text).not.toContain('"productTypeId"');
    expect(text).not.toContain('{');
    expect(r.buttons()).toEqual(['Accept', 'Reject']);
    r.unmount();
  });
  it('shows the server-owned classification readiness and attribute outcomes', async () => {
    const r = await renderWith([], vi.fn(), {
      ok: false,
      code: 'required_values_missing',
      reason: 'Required classification value(s) unresolved: flavor.',
      details: {
        categoryId: 'dog-food',
        productTypeId: 'dry-food',
        profileId: 'food-profile',
        requiredValues: [
          { attributeId: 'flavor', catalogField: 'ProductField23', status: 'missing' },
          { attributeId: 'product-feature', catalogField: 'ProductField26', status: 'optional_unvalued' },
          { attributeId: 'life-stage', catalogField: 'ProductField18', status: 'not_applicable' },
          { attributeId: 'pet-size', catalogField: 'ProductField19', status: 'required_unknown' },
        ],
      },
    });
    expect(r.text()).toContain('Classification readiness');
    expect(r.text()).toContain('Not ready');
    expect(r.text()).toContain('Required classification value(s) unresolved: flavor.');
    expect(r.text()).toContain('Flavor');
    expect(r.text()).toContain('Missing');
    expect(r.text()).toContain('Product Feature');
    expect(r.text()).toContain('Optional — no value');
    expect(r.text()).toContain('Life Stage');
    expect(r.text()).toContain('Not applicable');
    expect(r.text()).toContain('Pet Size');
    expect(r.text()).toContain('Required — applicability unknown');
    r.unmount();
  });

  it('keeps legacy type-only proposals history-only instead of offering an active decision', async () => {
    const legacy = proposal({
      proposalType: 'primary_product_type',
      targetId: 'poultry-feed',
      proposedValue: { productTypeId: 'poultry-feed', matchedWords: [] },
      confidence: 0.35,
    });
    const r = await renderWith([legacy]);
    expect(r.text()).toContain('No current Product Classification or attribute proposals to review.');
    expect(r.text()).not.toContain('Poultry Feed');
    expect(r.buttons()).toEqual([]);
    r.unmount();
  });

  it('renders matched words as chips for keyword-grounded pair picks', async () => {
    const pair = proposal({
      proposalType: 'product_classification',
      targetId: 'dog-food-dry',
      proposedValue: { categoryId: 'dog-food', productTypeId: 'dog-food-dry', matchedWords: ['dog', 'kibble'] },
      confidence: 0.8,
    });
    const r = await renderWith([pair]);
    const text = r.text();
    expect(text).toContain('Dog Food / Dog Food Dry');
    expect(text).toContain('Keyword match');
    expect(text).toContain('dog');
    expect(text).toContain('kibble');
    expect(text).toContain('80%');
    r.unmount();
  });


  it('merges identical pending proposals into a single row and fans the decision out to EVERY underlying id', async () => {
    const a = proposal({
      proposalType: 'field_assignment',
      targetId: 'flavor',
      proposedValue: 'Savory Blend',
      confidence: 0.85,
    });
    const b = proposal({
      proposalType: 'field_assignment',
      targetId: 'material',
      proposedValue: 'Savory Blend',
      confidence: 0.85,
    });
    const onDecision = vi.fn(async (_p: ClassificationProposal, _d: 'accepted' | 'rejected') => {});
    const r = await renderWith([a, b], onDecision);
    const text = r.text();
    expect(text).toContain('Decisions needed (1)');
    expect(text).toContain('1 duplicate merged');
    expect(text).toContain('Flavor & Material');
    expect(r.buttons()).toEqual(['Accept', 'Reject']);

    // BLOCKER (review round 2): accepting the merged row must submit a
    // decision for BOTH underlying proposal ids — never just the visible one.
    const accept = r.container.querySelector('button.rv-btn-primary') as HTMLButtonElement;
    await act(async () => { accept.click(); });
    expect(onDecision).toHaveBeenCalledTimes(2);
    const calledIds = onDecision.mock.calls.map(c => (c[0] as ClassificationProposal).id).sort();
    expect(calledIds).toEqual([a.id, b.id].sort());
    for (const call of onDecision.mock.calls) expect(call[1]).toBe('accepted');
    r.unmount();
  });

  it('sanitizes abstention reasons (JSON blobs and unbounded text never render raw)', async () => {
    const jsonReason = proposal({
      proposalType: 'reviewable_abstention',
      targetId: 'category-pages',
      proposedValue: { reason: '{"internal":"trace-42"}' },
      confidence: 0,
    });
    const longReason = proposal({
      proposalType: 'reviewable_abstention',
      targetId: 'attributes',
      proposedValue: { reason: 'x'.repeat(500) },
      confidence: 0,
    });
    const r = await renderWith([jsonReason, longReason]);
    const text = r.text();
    expect(text).toContain('No evidence available.');
    expect(text).not.toContain('trace-42');
    expect(text).not.toContain('{');
    expect(text).toContain('\u2026');
    r.unmount();
  });

  it('labels canonical pair confidence for screen readers', async () => {
    const pair = proposal({
      proposalType: 'product_classification',
      targetId: 'dog-food-dry',
      proposedValue: { categoryId: 'dog-food', productTypeId: 'dog-food-dry', matchedWords: [] },
      confidence: 0.35,
    });
    const r = await renderWith([pair]);
    const chip = r.container.querySelector('[aria-label^="Proposal confidence"]');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute('aria-label')).toContain('35 percent, low');
    r.unmount();
  });

  it('keeps distinct pending proposals as separate decisions', async () => {
    const a = proposal({ targetId: 'flavor', proposedValue: 'Chicken', confidence: 0.85 });
    const b = proposal({ targetId: 'material', proposedValue: 'Nylon', confidence: 0.85 });
    const r = await renderWith([a, b]);
    const text = r.text();
    expect(text).toContain('Decisions needed (2)');
    expect(r.buttons()).toEqual(['Accept', 'Reject', 'Accept', 'Reject']);
    r.unmount();
  });
  it('shows the effective corrected target and value for an accepted correction', async () => {
    const corrected = proposal({
      targetId: 'flavor',
      proposedValue: 'Chicken',
      hasRevisedTargetId: true,
      revisedTargetId: 'material',
      hasRevisedValue: true,
      revisedValue: 'Nylon',
      status: 'accepted',
    });
    const r = await renderWith([corrected]);
    const text = r.text();
    expect(text).toContain('Settled decisions');
    expect(text).toContain('Accepted');
    expect(text).toContain('Material');
    expect(text).toContain('Nylon');
    expect(text).not.toContain('Flavor');
    expect(text).not.toContain('Chicken');
    r.unmount();
  });

  it('shows the effective corrected target on pending rows carrying a reviewer correction', async () => {
    const corrected = proposal({
      targetId: 'flavor',
      proposedValue: 'Chicken',
      hasRevisedTargetId: true,
      revisedTargetId: 'material',
      hasRevisedValue: true,
      revisedValue: 'Nylon',
      status: 'pending',
    });
    const r = await renderWith([corrected]);
    const text = r.text();
    expect(text).toContain('Material');
    expect(text).toContain('Nylon');
    expect(text).not.toContain('Flavor');
    r.unmount();
  });

  it('shows an explicit value clear as a removal with before and after', async () => {
    const cleared = proposal({
      targetId: 'material',
      proposedValue: 'Nylon',
      hasRevisedValue: true,
      revisedValue: null,
      status: 'pending',
    });
    const r = await renderWith([cleared]);
    const text = r.text();
    expect(text).toContain('Removal');
    expect(text).toContain('Before: Nylon → After: (cleared)');
    r.unmount();
  });

  it('shows an explicitly cleared target as cleared, never under the old label', async () => {
    const cleared = proposal({
      targetId: 'flavor',
      proposedValue: 'Chicken',
      hasRevisedTargetId: true,
      revisedTargetId: null,
      status: 'pending',
    });
    const r = await renderWith([cleared]);
    const text = r.text();
    expect(text).toContain('(cleared)');
    expect(text).not.toContain('Flavor');
    r.unmount();
  });

  it('keeps proposals with different effective corrections as separate rows', async () => {
    const corrected = proposal({
      targetId: 'flavor',
      proposedValue: 'Chicken',
      hasRevisedTargetId: true,
      revisedTargetId: 'material',
      hasRevisedValue: true,
      revisedValue: 'Nylon',
      confidence: 0.85,
    });
    const uncorrected = proposal({
      targetId: 'flavor',
      proposedValue: 'Chicken',
      confidence: 0.85,
    });
    const r = await renderWith([corrected, uncorrected]);
    const text = r.text();
    expect(text).toContain('Decisions needed (2)');
    expect(text).toContain('Material');
    r.unmount();
  });

  it('renders Type Invariant chip for product type invariants', async () => {
    const invariantProp = proposal({
      targetId: 'species',
      proposedValue: 'Dog',
      confidence: 1.0,
      derivation: {
        kind: 'product_type_invariant',
        productTypeId: 'dog-food-dry',
        productTypeSource: 'reviewed',
      },
    });
    const r = await renderWith([invariantProp]);
    const text = r.text();
    expect(text).toContain('Type Invariant');
    expect(text).toContain('Dog');
    r.unmount();
  });

  it('renders derived-attribute conflict beside the canonical Product Classification', async () => {
    const pair = proposal({
      proposalType: 'product_classification',
      targetId: 'dog-food-dry',
      proposedValue: { categoryId: 'dog-food', productTypeId: 'dog-food-dry', matchedWords: [] },
      confidence: 0.9,
    });
    const conflictingInvariant = proposal({
      targetId: 'species',
      proposedValue: 'Dog',
      confidence: 1.0,
      contradictingEvidenceIds: ['ev-cat-1'],
      derivation: {
        kind: 'product_type_invariant',
        productTypeId: 'dog-food-dry',
        productTypeSource: 'reviewed',
      },
    });
    const r = await renderWith([pair, conflictingInvariant]);
    const text = r.text();
    expect(text).toContain('Type conflict in derived attributes');
    expect(text).toContain('Product Classification');
    expect(text).toContain('⚠ Type conflict: Product Type implies this value, but extracted product evidence contains conflicting information.');
    r.unmount();
  });
});
