// @vitest-environment jsdom
/**
 * B3 — mounted BrandStrategyBuilder coverage (Vitest jsdom).
 *
 * Approved-first init, Use-current-proposal locality, single combined Save,
 * no-mutation Cancel, both stale variants with rebase/discard, uncertain
 * transport gating, and keyboard/a11y basics. Controlled promises pin the
 * 409/refresh and late-response paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { BrandStrategyBuilder } from '../../client/components/brand-strategy/BrandStrategyBuilder';
import type { BuilderApi } from '../../client/components/brand-strategy/use-brand-strategy-builder';
import { OnboardingApiError } from '../../client/onboarding-api';
import type { BrandStrategy } from '../../shared/schemas/brand-strategy';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function approvedStrategy(): BrandStrategy {
  return {
    brandKey: 'Acme',
    normalizedBrand: 'acme',
    officialDomains: [{ domain: 'acme.com', sitemap: { totalUrls: 5, freshCount: 5, lastRefreshAt: null, freshness: 'fresh' } }],
    proposalSources: [{ kind: 'distributor_record', distributorId: 'bci' }],
    sourceOptions: [
      { kind: 'official_page', ref: 'acme.com', displayName: 'acme.com', selectable: true, reason: 'mapped', available: false },
      { kind: 'distributor_record', ref: 'phillips', displayName: 'Phillips', selectable: true, reason: 'enabled', available: true },
      { kind: 'distributor_record', ref: 'bci', displayName: 'BCI', selectable: true, reason: 'enabled', available: true },
    ],
    configurationToken: 'tok-1',
    approval: { approved: true, revision: 2, approvedAt: '2026-01-01', approvedBy: 'op' },
    approvedSources: [
      { kind: 'official_page', domain: 'acme.com' },
      { kind: 'distributor_record', distributorId: 'phillips' },
    ],
    sourceAvailability: [
      { kind: 'official_page', ref: 'acme.com', available: false, reason: 'not_supported' },
      { kind: 'distributor_record', ref: 'phillips', available: true, reason: 'ready' },
    ],
    collectionReadiness: 'ready_partial',
    extractorReadiness: 'active',
    ambiguous: [],
    unmatched: false,
    possibleMatches: [],
  } as BrandStrategy;
}

function apiFor(strategy: BrandStrategy, saveImpl?: BuilderApi['save']): { api: BuilderApi; save: ReturnType<typeof vi.fn> } {
  const save = vi.fn(saveImpl ?? (async () => ({ strategy: { id: 'a1', workspaceId: 'w', brand: 'Acme', normalizedBrand: 'acme', sources: [], revision: 3, approved: true, approvedAt: 'x', approvedBy: null, createdAt: 'x', updatedAt: 'x' } })));
  return {
    save,
    api: {
      loadDetail: async () => ({ strategy }),
      save,
    },
  };
}

describe('BrandStrategyBuilder (mounted)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  async function renderBuilder(props: { api: BuilderApi; brand?: string; onSaved?: (r: number) => void; onCancel?: () => void }) {
    await act(async () => {
      root.render(<BrandStrategyBuilder brand={props.brand ?? 'Acme'} api={props.api} onSaved={props.onSaved} onCancel={props.onCancel} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }

  it('initializes from the approved boundary and shows the proposal separately', async () => {
    const { api } = apiFor(approvedStrategy());
    await renderBuilder({ api });
    expect(container.textContent).toMatch(/Approved revision 2/);
    // Included checkboxes: acme.com + phillips checked, bci unchecked.
    const boxes = Array.from(container.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    const states = boxes.map((b) => b.checked);
    expect(states).toContain(true);
    expect(container.textContent).toMatch(/Live proposal/);
    expect(container.textContent).toMatch(/Official collection is not available for this source/);
  });

  it('Use current proposal changes the edit only; Save emits exactly one combined request', async () => {
    const { api, save } = apiFor(approvedStrategy());
    const onSaved = vi.fn();
    await renderBuilder({ api, onSaved });
    const useProposal = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Use current proposal')!;
    await act(async () => {
      useProposal.click();
    });
    expect(save).not.toHaveBeenCalled();
    const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save strategy') as HTMLButtonElement;
    await act(async () => {
      saveBtn.click();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      brand: 'Acme',
      sources: [{ kind: 'distributor_record', distributorId: 'bci' }],
      expectedRevision: 2,
      configuration: {
        officialDomains: ['acme.com'],
      },
      expectedConfigurationToken: 'tok-1',
    });
    expect(onSaved).toHaveBeenCalledWith(3);
  });

  it('Cancel makes zero mutation calls and asks for discard confirmation when dirty', async () => {
    const { api, save } = apiFor(approvedStrategy());
    const onCancel = vi.fn();
    await renderBuilder({ api, onCancel });
    // Dirty the edit via Use current proposal.
    const useProposal = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Use current proposal')!;
    await act(async () => {
      useProposal.click();
    });
    const cancel = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Cancel') as HTMLButtonElement;
    await act(async () => {
      cancel.click();
    });
    expect(onCancel).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/Discard unsaved edits/);
    const discard = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Discard edits') as HTMLButtonElement;
    await act(async () => {
      discard.click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('stale_revision preserves edits, offers reload-discard and rebase-then-save', async () => {
    const latest = { ...approvedStrategy(), configurationToken: 'tok-2', approval: { approved: true, revision: 3, approvedAt: 'x', approvedBy: 'op' } };
    let saves = 0;
    const loadDetail = vi.fn(async () => ({ strategy: saves === 0 ? approvedStrategy() : latest }));
    const save = vi.fn(async () => {
      saves += 1;
      if (saves === 1) throw new OnboardingApiError('stale', 409, 'stale_revision', { error: 'stale_revision', code: 'stale_revision', revision: 3 });
      return { strategy: { id: 'a', workspaceId: 'w', brand: 'Acme', normalizedBrand: 'acme', sources: [], revision: 4, approved: true, approvedAt: 'x', approvedBy: null, createdAt: 'x', updatedAt: 'x' } };
    });
    await renderBuilder({ api: { loadDetail, save } });
    // Dirty the edit first.
    const useProposal = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Use current proposal')!;
    await act(async () => {
      useProposal.click();
    });
    await act(async () => {
      (Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save strategy') as HTMLButtonElement).click();
    });
    expect(container.textContent).toMatch(/changed while editing/);
    // Edits preserved: save payload used bci (proposal), still visible.
    expect(container.textContent).toMatch(/Live proposal/);
    // Rebase then save again explicitly — no automatic retry happened.
    expect(save).toHaveBeenCalledTimes(1);
    const rebase = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Review changes against latest')!;
    await act(async () => {
      rebase.click();
    });
    expect(container.textContent).toMatch(/Rebased onto the latest revision/);
    await act(async () => {
      (Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save strategy') as HTMLButtonElement).click();
    });
    expect(save).toHaveBeenCalledTimes(2);
    const secondCall = save.mock.calls[1] as unknown as Array<{ expectedRevision: number }>;
    expect(secondCall[0].expectedRevision).toBe(3);
  });

  it('stale_configuration shows the mapping-drift message and reload-discard resets the edit', async () => {
    const save = vi.fn(async () => {
      throw new OnboardingApiError('stale config', 409, 'stale_configuration', { error: 'stale_configuration', code: 'stale_configuration', revision: 2 });
    });
    const { api } = apiFor(approvedStrategy(), save);
    await renderBuilder({ api });
    const useProposal = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Use current proposal')!;
    await act(async () => {
      useProposal.click();
    });
    await act(async () => {
      (Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save strategy') as HTMLButtonElement).click();
    });
    expect(container.textContent).toMatch(/Mappings changed/);
    const reload = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Reload latest / discard edits')!;
    await act(async () => {
      reload.click();
    });
    // Edit reset to the approved boundary: phillips re-included.
    expect(container.textContent).not.toMatch(/Mappings changed/);
  });

  it('uncertain transport outcome disables resubmit until refresh', async () => {
    const save = vi.fn(async () => {
      throw new TypeError('network down');
    });
    const { api } = apiFor(approvedStrategy(), save);
    await renderBuilder({ api });
    await act(async () => {
      (Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save strategy') as HTMLButtonElement).click();
    });
    expect(container.textContent).toMatch(/outcome is uncertain/);
    const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save strategy') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    const refresh = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Refresh to resolve')!;
    await act(async () => {
      refresh.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect((Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save strategy') as HTMLButtonElement).disabled).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('empty selection disables Save with an explanation; control labels are keyboard-operable', async () => {
    const { api } = apiFor(approvedStrategy());
    await renderBuilder({ api });
    // Uncheck both included sources.
    const boxes = Array.from(container.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    for (const box of boxes.slice(0, 2)) {
      await act(async () => {
        box.click();
      });
    }
    expect(container.textContent).toMatch(/at least one source/);
    expect((Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save strategy') as HTMLButtonElement).disabled).toBe(true);
    // Fieldset legends + labelled controls exist for keyboard/AT users.
    // Included is the collection boundary; unapproved collection queries all
    // enabled connections until an Included set is approved.
    expect(container.querySelector('fieldset legend')?.textContent).toMatch(/Approved sources/);
    expect(container.querySelector('summary')).toBeNull();
    expect(container.textContent).not.toMatch(/Legacy settings/);
    expect(container.querySelector('input[aria-label="Add official domain"]')).not.toBeNull();
    expect(container.querySelector('input[aria-label="Aliases"]')).toBeNull();
    expect(container.querySelector('select[aria-label="Sourcing policy"]')).toBeNull();
    expect(container.textContent).toMatch(/queries every enabled distributor connection/);
  });
});
