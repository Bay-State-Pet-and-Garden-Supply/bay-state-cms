// @vitest-environment jsdom
import React, { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Onboarding } from '../../client/components/Onboarding';
import { StageNavigation } from '../../client/components/onboarding/StageNavigation';
import { LINEAR_STAGE_ORDER, parseWorkspaceSelection } from '../../client/components/onboarding/linear-workspace-logic';
import {
  readLastWorkspaceStage,
  rememberWorkspaceStage,
} from '../../client/components/onboarding/workspace-view-state';
import type { OnboardingBatch } from '../../shared/schemas/onboarding';
import * as api from '../../client/onboarding-api';

vi.mock('@/client/onboarding-api', () => ({
  getBatches: vi.fn(), getBatch: vi.fn(), deleteBatch: vi.fn(),
  uploadSpreadsheet: vi.fn(), createBatch: vi.fn(), resolveBrandDomains: vi.fn(),
  getBrandSites: vi.fn(), getOnboardingCapabilities: vi.fn().mockResolvedValue({}),
}));
vi.mock('@/client/components/OnboardingSettings', () => ({ OnboardingSettings: () => null }));
vi.mock('@/client/components/WeeklyReportModal', () => ({ WeeklyReportModal: () => null }));
vi.mock('@/client/components/onboarding/BatchExecutionControls', () => ({ BatchExecutionControls: () => null }));

// The owned seam is Onboarding's entry/history coordination, not the working
// views. This shell stand-in reads URLs and emits the existing tab history
// contract, while exercising the real StageNavigation keyboard behavior.
vi.mock('@/client/components/onboarding/BatchWorkspace', () => ({
  BatchWorkspace: ({ batchId, batchName, onBack }: { batchId: string; batchName: string; onBack: () => void }) => {
    const [search, setSearch] = useState(window.location.search);
    useEffect(() => {
      const onPop = () => setSearch(window.location.search);
      window.addEventListener('popstate', onPop);
      return () => window.removeEventListener('popstate', onPop);
    }, []);
    const selection = parseWorkspaceSelection(search);
    const activeStage = selection.kind === 'stage' ? selection.stage : 'route_sources';
    return (
      <section data-testid="batch-workspace" data-batch={batchId}>
        <h2>{batchName}</h2>
        <button onClick={onBack}>Back to batches</button>
        <output>{selection.kind === 'stage' ? selection.stage : selection.kind === 'legacy' ? selection.rawTab : selection.kind}</output>
        <StageNavigation
          activeStage={activeStage}
          stageCounts={Object.fromEntries(LINEAR_STAGE_ORDER.map((stage) => [stage, 0])) as Record<typeof activeStage, number>}
          countsStale={false}
          onSelect={(stage) => {
            const url = new URL(window.location.href);
            url.searchParams.delete('tab');
            url.searchParams.delete('wview');
            url.searchParams.set('stage', stage);
            url.searchParams.set('stageVersion', '2');
            window.history.pushState(null, '', url);
            window.dispatchEvent(new PopStateEvent('popstate'));
          }}
        />
      </section>
    );
  },
}));

function batch(id: string, workspaceId = 'workspace-1'): OnboardingBatch {
  return {
    id, workspaceId, name: `Batch ${id}`, fileName: `${id}.csv`, status: 'active', executionState: 'draft',
    totalItems: 7, completedItems: 0, failedItems: 0, skippedItems: 0, columnMapping: null,
    createdAt: '2026-09-30T12:00:00Z', updatedAt: '2026-09-30T12:00:00Z',
  };
}

const scope = { workspaceId: 'workspace-1', batchId: 'b1' };

describe('Onboarding workspace entry, restoration, and history', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    vi.mocked(api.getOnboardingCapabilities).mockResolvedValue({} as Awaited<ReturnType<typeof api.getOnboardingCapabilities>>);
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/?view=onboarding');
    vi.mocked(api.getBatches).mockResolvedValue({
      batches: [batch('b1'), batch('b2')],
      workStateCounts: {
        b1: { processing: 0, needs_attention: 7, ready_for_review: 0, approved: 0, ready_to_export: 0, completed: 0, skipped: 0 },
      },
    });
    vi.mocked(api.getBatch).mockImplementation(async (id) => ({ batch: batch(id) }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function mount(search = '?view=onboarding') {
    window.history.replaceState(null, '', `/${search}`);
    await act(async () => root.render(<Onboarding />));
  }

  function button(text: string): HTMLButtonElement {
    const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent?.trim() === text);
    if (!found) throw new Error(`Missing button: ${text}`);
    return found;
  }

  async function click(text: string) {
    await act(async () => button(text).click());
  }

  async function selectStage(stage: string) {
    await act(async () => container.querySelector<HTMLButtonElement>(`#bws-stage-tab-${stage}`)!.click());
  }

  async function navigate(search: string) {
    await act(async () => {
      window.history.pushState(null, '', `/${search}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
  }

  function selectedStage() {
    return container.querySelector('output')?.textContent;
  }

  it('opens an unremembered batch at the first stage despite attention counts, then restores its selected stage', async () => {
    await mount();
    await click('Batch b1');
    expect(selectedStage()).toBe('route_sources');
    expect(new URLSearchParams(window.location.search).has('tab')).toBe(false);
    expect(api.getBatch).toHaveBeenCalledTimes(1); // Button clicks do not bubble into a second row request.
    await selectStage('collect_details');
    expect(readLastWorkspaceStage(scope)).toBe('collect_details');
    await click('Back to batches');
    for (const key of ['batch', 'stage', 'stageVersion', 'wview', 'tab']) {
      expect(new URLSearchParams(window.location.search).has(key)).toBe(false);
    }
    await click('Batch b1');
    expect(selectedStage()).toBe('collect_details');
    expect(new URLSearchParams(window.location.search).get('stageVersion')).toBe('2');
  });

  it('restores only the target batch and its authoritative workspace scope', async () => {
    rememberWorkspaceStage(scope, 'review_listings');
    rememberWorkspaceStage({ ...scope, batchId: 'b2' }, 'create_drafts');
    rememberWorkspaceStage({ ...scope, workspaceId: 'another-workspace' }, 'prepare_listing');
    await mount();
    await click('Batch b2');
    expect(selectedStage()).toBe('create_drafts');
    await click('Back to batches');
    await click('Batch b1');
    expect(selectedStage()).toBe('review_listings');
  });

  it.each([
    ['stage=collect_details&stageVersion=2', 'collect_details'],
    ['tab=needs_attention', 'needs_attention'],
    ['tab=review', 'review'],
    ['tab=completed', 'completed'],
    ['stage=review_listings&stageVersion=7', 'unsupported'],
  ])('honors direct navigation over remembered stage: %s', async (selector, expected) => {
    rememberWorkspaceStage(scope, 'create_drafts');
    await mount(`?view=onboarding&batch=b1&${selector}`);
    expect(selectedStage()).toBe(expected);
    expect(readLastWorkspaceStage(scope)).toBe(expected === 'collect_details' ? 'collect_details' : 'create_drafts');
  });

  it('replaces a bare same-batch history entry with its remembered stage, and honors actual back/forward', async () => {
    await mount('?view=onboarding&batch=b1');
    await selectStage('prepare_listing');
    await selectStage('review_listings');
    await act(async () => {
      const popped = new Promise<void>((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }));
      window.history.back();
      await popped;
    });
    expect(selectedStage()).toBe('prepare_listing');
    expect(readLastWorkspaceStage(scope)).toBe('prepare_listing');
    await act(async () => {
      const popped = new Promise<void>((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }));
      window.history.forward();
      await popped;
    });
    expect(selectedStage()).toBe('review_listings');
    await navigate('?view=onboarding&batch=b1');
    expect(selectedStage()).toBe('review_listings');
    expect(new URLSearchParams(window.location.search).get('stage')).toBe('review_listings');
  });

  it.each(['success', 'failure'])('ignores a late batch response after navigation to another batch (%s)', async (result) => {
    let resolveOld!: (value: { batch: OnboardingBatch }) => void;
    let rejectOld!: (reason: Error) => void;
    vi.mocked(api.getBatch).mockImplementation((id) => id === 'b1'
      ? new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; })
      : Promise.resolve({ batch: batch(id) }));
    await mount('?view=onboarding&batch=b1&stage=prepare_listing&stageVersion=2');
    await navigate('?view=onboarding&batch=b2&stage=create_drafts&stageVersion=2');
    await act(async () => {
      if (result === 'success') resolveOld({ batch: batch('b1') });
      else rejectOld(new Error('old batch unavailable'));
    });
    expect(container.querySelector('[data-testid="batch-workspace"]')?.getAttribute('data-batch')).toBe('b2');
    expect(container.querySelector('h2')?.textContent).toBe('Batch b2');
    expect(selectedStage()).toBe('create_drafts');
    expect(new URLSearchParams(window.location.search).get('batch')).toBe('b2');
    expect(readLastWorkspaceStage(scope)).toBeNull();
  });

  it('ignores late completion after browser navigation to the batch list', async () => {
    let resolveOld!: (value: { batch: OnboardingBatch }) => void;
    vi.mocked(api.getBatch).mockImplementation(() => new Promise((resolve) => { resolveOld = resolve; }));
    await mount('?view=onboarding&batch=b1');
    await navigate('?view=onboarding');
    await act(async () => resolveOld({ batch: batch('b1') }));
    expect(container.querySelector('[data-testid="batch-workspace"]')).toBeNull();
    expect(new URLSearchParams(window.location.search).has('batch')).toBe(false);
    expect(readLastWorkspaceStage(scope)).toBeNull();
  });

  it('cleans all batch selectors after a failed batch entry', async () => {
    vi.mocked(api.getBatch).mockRejectedValue(new Error('Batch unavailable'));
    await mount('?view=onboarding&batch=b1&stage=review_listings&stageVersion=2&wview=brand-setup&tab=review&board=pipeline');
    for (const key of ['batch', 'stage', 'stageVersion', 'wview', 'tab', 'board']) {
      expect(new URLSearchParams(window.location.search).has(key)).toBe(false);
    }
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Batch unavailable');
  });

  it('cleans stale selectors when browser navigation returns to the batch list', async () => {
    await mount('?view=onboarding&batch=b1&stage=review_listings&stageVersion=2');
    await navigate('?view=onboarding&stage=collect_details&stageVersion=2&wview=brand-setup&tab=review&board=pipeline');
    for (const key of ['batch', 'stage', 'stageVersion', 'wview', 'tab', 'board']) {
      expect(new URLSearchParams(window.location.search).has(key)).toBe(false);
    }
    expect(readLastWorkspaceStage(scope)).toBe('review_listings');
    await click('Batch b1');
    expect(selectedStage()).toBe('review_listings');
  });

  it('does not reclaim another app view’s URL or tab during navigation', async () => {
    await mount('?view=onboarding&batch=b1&stage=review_listings&stageVersion=2');
    await navigate('?view=settings&batch=b1&tab=ai');
    expect(new URLSearchParams(window.location.search).get('view')).toBe('settings');
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('ai');
    expect(new URLSearchParams(window.location.search).has('stage')).toBe(false);
    expect(readLastWorkspaceStage(scope)).toBe('review_listings');
  });

  it('leaves specialist route history and return context intact', async () => {
    await mount('?view=onboarding&batch=b1&stage=review_listings&stageVersion=2');
    const returnPath = window.location.pathname + window.location.search;
    const path = `/settings/domains/example.com/profile?return=${encodeURIComponent(returnPath)}`;
    await act(async () => {
      window.history.pushState({ specialist: true }, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(window.location.pathname).toBe('/settings/domains/example.com/profile');
    expect(new URLSearchParams(window.location.search).get('return')).toBe(returnPath);
    expect(window.history.state).toEqual({ specialist: true });
    expect(readLastWorkspaceStage(scope)).toBe('review_listings');
  });

  it('can reenter the same batch when specialist navigation cancels its pending load', async () => {
    let resolveOld!: (value: { batch: OnboardingBatch }) => void;
    vi.mocked(api.getBatch).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    await mount('?view=onboarding&batch=b1');
    await navigate('?view=settings&tab=ai');
    await navigate('?view=onboarding&batch=b1&stage=collect_details&stageVersion=2');
    await act(async () => resolveOld({ batch: batch('b1') }));
    expect(api.getBatch).toHaveBeenCalledTimes(2);
    expect(selectedStage()).toBe('collect_details');
    expect(readLastWorkspaceStage(scope)).toBe('collect_details');
  });

  it('newly created batches force the first stage even when a prior preference or stale link exists', async () => {
    rememberWorkspaceStage(scope, 'create_drafts');
    vi.mocked(api.uploadSpreadsheet).mockResolvedValue({
      fileName: 'products.csv', headers: ['upc', 'name'], mapping: { upc: 'upc', name: 'name' },
      tempRows: [{ upc: '123456789012', name: 'Seed' }], rowsCount: 1,
    });
    vi.mocked(api.getBrandSites).mockResolvedValue({ brandSites: [] });
    vi.mocked(api.createBatch).mockResolvedValue({ batch: batch('b1'), validationErrors: [] });
    await mount('?view=onboarding&tab=needs_attention&stageVersion=2');
    await click('Upload Weekly Spreadsheet');
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('#file-upload-input')!;
      Object.defineProperty(input, 'files', { value: [new File([''], 'products.csv', { type: 'text/csv' })] });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click('Next →');
    await click('Create Batch');
    expect(api.createBatch).toHaveBeenCalledTimes(1);
    expect(selectedStage()).toBe('route_sources');
    expect(readLastWorkspaceStage(scope)).toBe('route_sources');
    expect(new URLSearchParams(window.location.search).has('tab')).toBe(false);
  });

  it('stage tabs use one tab stop and support wrapping arrows, Home, and End', async () => {
    await mount('?view=onboarding&batch=b1');
    const first = container.querySelector<HTMLButtonElement>('#bws-stage-tab-route_sources')!;
    first.focus();
    for (const [key, expected] of [['ArrowLeft', 'create_drafts'], ['Home', 'route_sources'], ['End', 'create_drafts'], ['ArrowRight', 'route_sources']]) {
      await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
      expect(selectedStage()).toBe(expected);
      expect(document.activeElement?.id).toBe(`bws-stage-tab-${expected}`);
      expect([...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
      expect(container.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe(`bws-stage-tab-${expected}`);
    }
  });
});
