// @vitest-environment jsdom
// story: e05s01 — gating and applicability rendering
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import type { ReactNode } from 'react';
import { ReviewClassificationPanel } from '../../client/components/onboarding/review/ReviewClassificationPanel';

async function renderWithCuration(curation: Record<string, unknown>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const detail = { item: { curationData: curation } } as any;
  await act(async () => {
    root.render(<ReviewClassificationPanel detail={detail} onDecision={vi.fn()} busyDecisionId={null} />);
  });
  return {
    container,
    text: () => container.textContent ?? '',
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('ReviewClassificationPanel e05s01 gating // story: e05s01', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows Needs reviewed Category + Product Type when page gating has no accepted pair', async () => {
    const r = await renderWithCuration({
      classificationProposals: [],
      suggestedPages: [],
      categoryPageGating: { needsReviewedType: true, needsVerifiedPages: false, verifiedPageCount: 3, reason: 'No reviewed Product Classification pair. Page assignment requires an accepted pair.', verifiedPageIdSet: [], snapshotHash: 'abc' },
      attributeApplicability: [],
      speciesGuardDropped: [],
    });
    expect(r.text()).toContain('Needs reviewed Category + Product Type');
    r.unmount();
  });

  it('shows No verified Catalog Pages when gating needsVerifiedPages', async () => {
    const r = await renderWithCuration({
      classificationProposals: [],
      suggestedPages: [],
      categoryPageGating: { needsReviewedType: false, needsVerifiedPages: true, verifiedPageCount: 0, reason: 'No verified store pages available. Page assignment requires a verified ShopSite Pages import.', verifiedPageIdSet: [], snapshotHash: null },
      attributeApplicability: [],
      speciesGuardDropped: [],
    });
    expect(r.text()).toContain('No verified Catalog Pages');
    r.unmount();
  });

  it('renders attribute applicability relative to the reviewed Product Classification pair', async () => {
    const r = await renderWithCuration({
      classificationProposals: [],
      suggestedPages: [],
      categoryPageGating: { needsReviewedType: false, needsVerifiedPages: false, verifiedPageCount: 2, reason: null, verifiedPageIdSet: [], snapshotHash: null },
      attributeApplicability: [
        { attributeId: 'flavor', state: 'unknown', reason: 'No reviewed Product Classification pair; profile-gated attributes are blocked until the pair is accepted.' },
        { attributeId: 'size', state: 'not_applicable', reason: 'Attribute is not in the selected pair’s Attribute Profile (dog-food-dry).' },
      ],
      speciesGuardDropped: [],
    });
    const text = r.text();
    expect(text).toContain('Attribute applicability');
    expect(text).toContain('Flavor');
    expect(text).toContain('unknown');
    expect(text).toContain('Size');
    expect(text).toContain('not_applicable');
    r.unmount();
  });

  it('renders species-guard dropped list', async () => {
    const r = await renderWithCuration({
      classificationProposals: [],
      suggestedPages: ['Dog Food Dry'],
      categoryPageGating: { needsReviewedType: false, needsVerifiedPages: false, verifiedPageCount: 2, reason: null, verifiedPageIdSet: ['p1'], snapshotHash: 'abc12345' },
      attributeApplicability: [],
      speciesGuardDropped: [{ pageName: 'Cat Food Wet', species: 'dog', reason: 'species_incompatible', matchedTerm: 'cat' }],
    });
    expect(r.text()).toContain('Filtered by species guard');
    expect(r.text()).toContain('Cat Food Wet');
    expect(r.text()).toContain('species_incompatible');
    r.unmount();
  });
});

// ─── e10s03: readiness checklist, approve gating, jump-to-fix, confirm step ──

import { ReviewReadinessPanel } from '../../client/components/onboarding/review/ReviewReadinessPanel';
import { ReviewActions } from '../../client/components/onboarding/review/ReviewActions';
import { ReviewConfirmStep, hasChangesToConfirm, shouldOpenConfirmStep } from '../../client/components/onboarding/review/ReviewConfirmStep';
import type { ReviewReadiness } from '../../client/components/onboarding/review/review-readiness';

const blockedReadiness = (): ReviewReadiness => ({
  ready: false,
  authoritative: true,
  blockers: ['missing_price', 'missing_brand'],
  warnings: ['keywords_empty'],
  notes: [],
});

async function renderElement(node: ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return {
    container,
    text: () => container.textContent ?? '',
    click: (selector: string) =>
      act(async () => {
        container.querySelector<HTMLButtonElement>(selector)!.dispatchEvent(
          new MouseEvent('click', { bubbles: true }),
        );
      }),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('ReviewReadinessPanel // e10s03', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders each blocker and warning as named TEXT rows, never color-only', async () => {
    const r = await renderElement(<ReviewReadinessPanel detail={null} readiness={blockedReadiness()} />);
    const text = r.text();
    expect(text).toContain('Blocking — Price is empty');
    expect(text).toContain('Blocking — Brand is missing');
    expect(text).toContain('Warning — Search keywords are empty');
    expect(text).toContain('Fix');
    // e10s03 a11y: blocker message nodes carry deterministic ids so form
    // inputs can point aria-describedby at them (SC 3.3.1/3.3.3).
    expect(r.container.querySelector('#rv-gate-msg-missing_price')).not.toBeNull();
    expect(r.container.querySelector('#rv-gate-msg-missing_brand')).not.toBeNull();
    r.unmount();
  });

  it('ready items show a compact passing status', async () => {
    const r = await renderElement(
      <ReviewReadinessPanel
        detail={null}
        readiness={{ ready: true, blockers: [], warnings: [], notes: [], authoritative: true }}
      />,
    );
    expect(r.text()).toContain('Ready — all mandatory checks pass');
    r.unmount();
  });

  it('jump-to-fix: activating a blocker row requests the field target', async () => {
    const onJumpRequest = vi.fn();
    const r = await renderElement(
      <ReviewReadinessPanel detail={null} readiness={blockedReadiness()} onJumpRequest={onJumpRequest} />,
    );
    const buttons = [...r.container.querySelectorAll<HTMLButtonElement>('.rv-readiness-fix')];
    expect(buttons).toHaveLength(3); // 2 blockers + 1 warning
    await r.click('.rv-readiness-fix');
    expect(onJumpRequest).toHaveBeenCalledWith('rv-edit-price');
    r.unmount();
  });

  it('focus actually MOVES to the target element (not merely scrolling)', async () => {
    const input = document.createElement('input');
    input.id = 'rv-edit-price';
    document.body.appendChild(input);
    const { focusJumpTarget } = await import('../../client/components/onboarding/review/review-readiness');
    let focused = false;
    input.addEventListener('focus', () => { focused = true; });
    // jsdom does not implement scrollIntoView — stub it for the assertion.
    const originalScroll = (HTMLElement.prototype as any).scrollIntoView;
    const scrollSpy = vi.fn();
    (HTMLElement.prototype as any).scrollIntoView = scrollSpy;
    const moved = focusJumpTarget('rv-edit-price');
    expect(moved).toBe(true);
    expect(focused).toBe(true);
    expect(scrollSpy).toHaveBeenCalled();
    (HTMLElement.prototype as any).scrollIntoView = originalScroll;
    input.remove();
  });
});

describe('ReviewActions completeness gating // e10s03', () => {
  const baseProps = {
    workState: null,
    detail: null as any,
    busy: false,
    editing: false,
    allReviewed: false,
    onLooksGood: vi.fn(),
    onPrevious: vi.fn(),
    onNext: vi.fn(),
    onToggleEdit: vi.fn(),
  };

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('blockers disable Looks Good with an adjacent TEXT reason', async () => {
    const r = await renderElement(<ReviewActions {...baseProps} blockers={['missing_price']} />);
    const button = r.container.querySelector<HTMLButtonElement>('.rv-btn-primary')!;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(r.text()).toContain('Blocked — 1 mandatory check incomplete');
    r.unmount();
  });

  it('no blockers ⇒ Looks Good enabled and no reason rendered (flag-off parity)', async () => {
    const r = await renderElement(
      <ReviewActions {...baseProps} workState={{ itemId: 'i1' } as any} />,
    );
    expect(r.container.querySelector<HTMLButtonElement>('.rv-btn-primary')!.disabled).toBe(false);
    expect(r.container.querySelector('.rv-actions-blocked')).toBeNull();
    r.unmount();
  });

  it('editing still disables approval exactly as before V2', async () => {
    const r = await renderElement(<ReviewActions {...baseProps} editing />);
    expect(r.container.querySelector<HTMLButtonElement>('.rv-btn-primary')!.disabled).toBe(true);
    r.unmount();
  });
});

describe('ReviewConfirmStep // e10s03', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('clean pass short-circuits: no changes ⇒ nothing to confirm', () => {
    expect(hasChangesToConfirm([])).toBe(false);
  });

  it('edited values produce confirmable diff rows', () => {
    expect(
      hasChangesToConfirm([{ field: 'Name', previous: 'Old', current: 'New' }]),
    ).toBe(true);
  });

  it('renders the pre-edit vs current ledger plus warnings when open', async () => {
    const r = await renderElement(
      <ReviewConfirmStep
        open
        diffRows={[
          { field: 'Name', previous: 'Old title', current: 'New title' },
          { field: 'Price', previous: '(empty)', current: '9.99' },
        ]}
        warnings={['keywords_empty']}
        busy={false}
        onApprove={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const text = r.text();
    expect(text).toContain('Before edits');
    expect(text).toContain('Old title');
    expect(text).toContain('New title');
    expect(text).toContain('(empty)');
    expect(text).toContain('9.99');
    expect(text).toContain('Warning — Search keywords are empty');
    expect(text).toContain('Confirm & mark reviewed');
    r.unmount();
  });

  it('closed confirm step renders nothing', async () => {
    const r = await renderElement(
      <ReviewConfirmStep open={false} diffRows={[{ field: 'Name', previous: 'a', current: 'b' }]} warnings={[]} busy={false} onApprove={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(r.container.querySelector('.rv-confirm-modal')).toBeNull();
    r.unmount();
  });

  it('confirm gate opens ONLY for session-edited items with a real value change', () => {
    const edited = new Set(['a', 'b']);
    const changedRows = [{ field: 'Name' as const, previous: 'Old', current: 'New' }];
    // edited + changed ⇒ open (integration path in handleLooksGood)
    expect(shouldOpenConfirmStep('a', edited, changedRows)).toBe(true);
    // NOT edited ⇒ straight approve even with a diff
    expect(shouldOpenConfirmStep('z', edited, changedRows)).toBe(false);
    // edited but clean pass (no effective change) ⇒ short-circuit
    expect(shouldOpenConfirmStep('b', edited, [])).toBe(false);
    // empty selection set ⇒ never opens
    expect(shouldOpenConfirmStep('a', new Set(), changedRows)).toBe(false);
  });

});
