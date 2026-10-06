// @vitest-environment jsdom
/**
 * Linear shell integration mounts (BatchWorkspace, shellV2 ON).
 *
 * The shell now mounts stage views DIRECTLY (no placeholder screens, no
 * Batch-tools disclosure, no open-workspace buttons):
 * - review_listings -> ReviewWorkspace (entire batch)
 * - create_drafts   -> ReadyToExportView (entire batch)
 * - prepare_listing -> PrepareListingView (sectioned, refreshKey-aware)
 * - other stages    -> StageItemsView (real, server-filtered)
 * - needs-attention -> AttentionPanel overlay (queue <-> resolver), the
 *   working stage stays mounted underneath.
 *
 * These mounts stub ONLY the four direct views plus the two attention
 * views at their highest rendered seam. The stubs expose the props the
 * shell owns (batchId / workspaceId / refreshKey / itemId / action
 * callbacks) as data attributes and simulator buttons, so every assertion
 * below exercises real shell behavior: tab order, server-count badges,
 * legacy-URL canonicalization into stage scope + persisted preferences,
 * attention list->resolver->resolve refresh, Escape/focus restore, and
 * keep-visited hidden mounts preserving pending input.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/shared/schemas/onboarding-stage-read', () => ({
  STAGE_READ_LIMIT_DEFAULT: 50,
}));

vi.mock('@/client/components/onboarding/review/ReviewWorkspace', () => ({
  ReviewWorkspace: (props: { batchId: string; workspaceId?: string; onChanged?: () => void }) => (
    <div
      data-testid="review-workspace"
      data-batch={props.batchId}
      data-workspace={props.workspaceId ?? ''}
    >
      <span data-testid="review-scope">Entire batch review</span>
      <button type="button" data-testid="review-notify-changed" onClick={() => props.onChanged?.()}>
        Simulate review change
      </button>
    </div>
  ),
}));

vi.mock('@/client/components/onboarding/approved/ReadyToExportView', () => ({
  ReadyToExportView: (props: { batchId: string; workspaceId?: number | string; onChanged?: () => void }) => (
    <div
      data-testid="ready-to-export-view"
      data-batch={props.batchId}
      data-workspace={String(props.workspaceId ?? '')}
    >
      <span data-testid="draft-scope">Entire batch drafts</span>
      <button type="button" data-testid="draft-notify-changed" onClick={() => props.onChanged?.()}>
        Simulate draft change
      </button>
    </div>
  ),
}));

vi.mock('@/client/components/onboarding/PrepareListingView', () => ({
  PrepareListingView: (props: {
    batchId: string;
    workspaceId?: string;
    refreshKey?: number;
    onOpenAttentionItem?: (itemId: string) => void;
  }) => (
    <div
      data-testid="prepare-listing-view"
      data-batch={props.batchId}
      data-workspace={props.workspaceId ?? ''}
      data-refresh-key={String(props.refreshKey ?? 0)}
    >
      {/* Uncontrolled on purpose: the shell must keep this mounted (hidden)
          so typed input survives stage navigation and attention overlays. */}
      <input data-testid="prepare-filter-input" aria-label="Prepare filter" defaultValue="" />
      <button
        type="button"
        data-testid="prepare-open-attention"
        onClick={() => props.onOpenAttentionItem?.('item_p1')}
      >
        Open attention item
      </button>
    </div>
  ),
}));

vi.mock('@/client/components/onboarding/attention/AttentionQueueView', () => ({
  AttentionQueueView: (props: { batchId: string; onOpenItem?: (itemId: string) => void }) => (
    <div data-testid="attention-queue" data-batch={props.batchId}>
      <span data-testid="attention-queue-count">2 issues in entire batch</span>
      <button type="button" data-testid="attention-open-item-1" onClick={() => props.onOpenItem?.('item_1')}>
        Open issue item_1
      </button>
      <button type="button" data-testid="attention-open-item-2" onClick={() => props.onOpenItem?.('item_2')}>
        Open issue item_2
      </button>
    </div>
  ),
}));

vi.mock('@/client/components/onboarding/attention/OfficialSiteResolutionWorkspace', () => ({
  OfficialSiteResolutionWorkspace: (props: { batchId: string; itemId: string; onResolved?: () => void }) => (
    <div data-testid="attention-resolver" data-batch={props.batchId} data-item={props.itemId}>
      <button type="button" data-testid="attention-resolve" onClick={() => props.onResolved?.()}>
        Mark issue resolved
      </button>
    </div>
  ),
}));

import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { LINEAR_STAGES } from '../../client/components/onboarding/linear-workspace-logic';
import { BatchWorkspace } from '../../client/components/onboarding/BatchWorkspace';
import {
  overrideOnboardingFeatureFlags,
  resetOnboardingFeatureFlags,
} from '../../client/onboarding-feature-flags';
import * as workApi from '../../client/onboarding-work-api';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeRow(i: number, overrides: Record<string, unknown> = {}) {
  return {
    itemId: `item_${i}`,
    category: 'processing',
    activity: null,
    label: 'Working',
    detail: null,
    attentionReason: null,
    attentionAction: null,
    variantResolution: null,
    findingCode: null,
    findingSummary: null,
    conflictingValues: null,
    suggestedAction: null,
    findingDetails: null,
    family: null,
    reviewState: 'unreviewed',
    stage: 'sourcing',
    stageStatus: 'pending',
    upc: `0000000000${i}`,
    name: `Product ${i}`,
    brand: 'Acme',
    sourceType: 'official_page',
    domain: 'acme.example',
    curatedTitle: null,
    imageUrl: null,
    description: null,
    weight: null,
    ...overrides,
  };
}

function countsPayload() {
  const zero = () => ({ pending: 0, in_progress: 0, completed: 0, failed: 0, needs_input: 0, skipped: 0 });
  return {
    schemaVersion: 2,
    stageVocabularyVersion: 2,
    batchId: 'b1',
    filterFingerprint: 'a'.repeat(32),
    projectionHealth: { status: 'healthy', version: '1.0.0', computedAt: new Date().toISOString(), issues: [] },
    matchingTotal: 10,
    counts: {
      processing: 7, needs_attention: 2, waiting_on_family: 0, ready_for_review: 3,
      approved: 0, ready_to_export: 0, completed: 0, skipped: 0,
    },
    stageStatusMatrix: {
      route_sources: { ...zero(), pending: 7 },
      find_product_page: zero(),
      collect_details: zero(),
      prepare_listing: zero(),
      review_listings: { ...zero(), pending: 3 },
      create_drafts: zero(),
    },
  };
}

function itemsPayload(rows: unknown[]) {
  return {
    schemaVersion: 2,
    stageVocabularyVersion: 2,
    batchId: 'b1',
    filterFingerprint: 'b'.repeat(32),
    projectionHealth: { status: 'healthy', version: '1.0.0', computedAt: new Date().toISOString(), issues: [] },
    items: rows,
    nextCursor: null,
    scannedRows: rows.length,
    queryCount: 3,
  };
}

function prefKey(workspaceId: string, batchId: string, stage: string) {
  return `baystate:onboarding:view:v1:${JSON.stringify([workspaceId, batchId, stage])}`;
}

function readPref(workspaceId: string, batchId: string, stage: string) {
  const raw = window.sessionStorage.getItem(prefKey(workspaceId, batchId, stage));
  return raw ? (JSON.parse(raw) as { q: string; selectedId: string | null; filters: Record<string, string> }) : null;
}

function installStorage() {
  // This jsdom setup ships without sessionStorage; the shell's preference
  // layer treats missing storage as "persistence disabled", which would
  // silently void the legacy-mapping preference assertions below. A fresh
  // in-memory store per test keeps them meaningful.
  const store = new Map<string, string>();
  Object.defineProperty(window, 'sessionStorage', {
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
      get length() { return store.size; },
      key: (i: number) => [...store.keys()][i] ?? null,
    },
    configurable: true,
    writable: true,
  });
}

describe('linear shell mounts (BatchWorkspace, shellV2 ON)', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const countsUrls: string[] = [];
  let countsShouldFail = false;

  function installFetch() {
    countsUrls.length = 0;
    vi.spyOn(globalThis as any, 'fetch').mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/stage-work-state/counts')) {
        countsUrls.push(u);
        if (countsShouldFail) return { ok: false, status: 500, json: async () => ({}) } as any;
        return { ok: true, status: 200, json: async () => countsPayload() } as any;
      }
      if (u.includes('/stage-work-state/items')) {
        return { ok: true, status: 200, json: async () => itemsPayload([makeRow(1), makeRow(2)]) } as any;
      }
      if (u.includes('/api/onboarding/batches/b1') && !u.includes('stage-work-state')) {
        return {
          ok: true, status: 200,
          json: async () => ({ batch: { id: 'b1', workspaceId: 'ws1', executionState: 'idle', name: 'Batch One' } }),
        } as any;
      }
      return { ok: true, status: 200, json: async () => ({}) } as any;
    });
  }

  function setUrl(search: string) {
    window.history.replaceState(null, '', `/${search}`);
  }

  async function mount(extraProps: Record<string, unknown> = {}) {
    await act(async () => {
      root.render(
        <BatchWorkspace batchId="b1" batchName="Batch One" workspaceId="ws1" onBack={() => {}} {...extraProps} />,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }

  function tabLabels() {
    return Array.from(container.querySelectorAll('.bws-stage-tab')).map((t) => t.textContent ?? '');
  }

  beforeEach(() => {
    overrideOnboardingFeatureFlags({ shellV2Enabled: true, brandGateV2Enabled: false, executionStripV2Enabled: false });
    vi.spyOn(workApi, 'subscribeBatchEvents').mockImplementation(() => () => {});
    countsShouldFail = false;
    installFetch();
    installStorage();
    try { window.localStorage.clear(); } catch { /* storage-less jsdom */ }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    setUrl('?batch=b1');
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    resetOnboardingFeatureFlags();
    document.body.innerHTML = '';
    setUrl('');
  });

  it('renders exactly six stage tabs in order with server-count badges (never page lengths)', async () => {
    setUrl('?batch=b1');
    await mount();
    const labels = LINEAR_STAGES.map((s) => s.label);
    expect(labels).toEqual([
      'Identify & Route Sources',
      'Find product page',
      'Collect details',
      'Prepare listing',
      'Review listings',
      'Create drafts',
    ]);
    const domOrder = tabLabels();
    expect(domOrder.length).toBe(6);
    for (let i = 0; i < labels.length; i += 1) {
      expect(domOrder[i]).toContain(labels[i]!);
    }
    // Badge for Stage 1 shows the server matrix total (7), not the 2-row page.
    expect(domOrder[0]).toContain('7');
    expect(domOrder[4]).toContain('3');
    // Stage-one flow note: brand + source triage, distributor skip secondary.
    const note = container.querySelector('[data-testid="stage-one-flow-note"]');
    expect(note?.textContent).toMatch(/Identify the brand and source/i);
    expect(note?.textContent).toMatch(/skip page discovery/i);
    // Scope label present on the real stage view.
    expect(container.querySelector('[data-testid="stage-scope-label"]')?.textContent).toMatch(/server-filtered/i);
    // No placeholder screens, no Batch-tools disclosure, no open buttons.
    expect(container.querySelector('[data-testid="batch-tools-disclosure"]')).toBeNull();
    expect(container.querySelector('[data-testid="linear-secondary-nav"]')).toBeNull();
    expect(container.querySelector('[data-testid="open-ready-to-export-workspace"]')).toBeNull();
  });

  it('direct Review stage mounts ReviewWorkspace with shell-owned props (no open button, no Batch tools)', async () => {
    setUrl('?batch=b1&stage=review_listings&stageVersion=2');
    await mount();
    const review = container.querySelector('[data-testid="review-workspace"]');
    expect(review).not.toBeNull();
    expect(review?.getAttribute('data-batch')).toBe('b1');
    expect(review?.getAttribute('data-workspace')).toBe('ws1');
    expect(review?.querySelector('[data-testid="review-scope"]')?.textContent).toMatch(/Entire batch/);
    expect(container.querySelector('[data-testid="batch-tools-disclosure"]')).toBeNull();
    expect(container.querySelector('[data-testid="open-ready-to-export-workspace"]')).toBeNull();
    // Review change notification refreshes server counts.
    const before = countsUrls.length;
    await act(async () => {
      (review!.querySelector('[data-testid="review-notify-changed"]') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(countsUrls.length).toBeGreaterThan(before);
  });

  it('direct Draft stage mounts ReadyToExportView with shell-owned props (no open button)', async () => {
    setUrl('?batch=b1&stage=create_drafts&stageVersion=2');
    await mount();
    const drafts = container.querySelector('[data-testid="ready-to-export-view"]');
    expect(drafts).not.toBeNull();
    expect(drafts?.getAttribute('data-batch')).toBe('b1');
    expect(drafts?.getAttribute('data-workspace')).toBe('ws1');
    expect(drafts?.querySelector('[data-testid="draft-scope"]')?.textContent).toMatch(/Entire batch/);
    expect(container.querySelector('[data-testid="open-ready-to-export-workspace"]')).toBeNull();
    expect(container.querySelector('[data-testid="batch-tools-disclosure"]')).toBeNull();
  });

  it('legacy ?tab=review canonicalizes to the Review stage with an unreviewed preference', async () => {
    setUrl('?batch=b1&tab=review');
    await mount();
    expect(window.location.search).toContain('stage=review_listings');
    expect(window.location.search).not.toContain('tab=');
    expect(container.querySelector('[data-testid="review-workspace"]')).not.toBeNull();
    expect(readPref('ws1', 'b1', 'review_listings')?.filters.reviewState).toBe('unreviewed');
  });

  it('legacy ?tab=approved canonicalizes to the Review stage with a reviewed preference', async () => {
    setUrl('?batch=b1&tab=approved');
    await mount();
    expect(window.location.search).toContain('stage=review_listings');
    expect(window.location.search).not.toContain('tab=');
    expect(container.querySelector('[data-testid="review-workspace"]')).not.toBeNull();
    expect(readPref('ws1', 'b1', 'review_listings')?.filters.reviewState).toBe('reviewed');
  });

  it('legacy ?tab=ready_to_export canonicalizes to the Draft stage', async () => {
    setUrl('?batch=b1&tab=ready_to_export');
    await mount();
    expect(window.location.search).toContain('stage=create_drafts');
    expect(window.location.search).not.toContain('tab=');
    expect(container.querySelector('[data-testid="ready-to-export-view"]')).not.toBeNull();
  });

  it('legacy outcome tabs canonicalize to the Draft stage with matching category preferences', async () => {
    for (const outcome of ['completed', 'skipped'] as const) {
      setUrl(`?batch=b1&tab=${outcome}`);
      await mount();
      expect(window.location.search).toContain('stage=create_drafts');
      expect(container.querySelector('[data-testid="ready-to-export-view"]')).not.toBeNull();
      expect(readPref('ws1', 'b1', 'create_drafts')?.filters.category).toBe(outcome);
      act(() => root.unmount());
      container.remove();
      window.sessionStorage.clear();
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    }
  });

  it('unknown stage versions render an unsupported-link state with a safe default (no mutation)', async () => {
    setUrl('?batch=b1&stage=sourcing&stageVersion=1');
    await mount();
    const notice = container.querySelector('[data-testid="unsupported-link-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toMatch(/Unsupported link/i);
    // Safe default: the first stage tab stays selected.
    expect(container.querySelector('#bws-stage-tab-route_sources')?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-testid="batch-tools-disclosure"]')).toBeNull();
  });

  it('count failures surface a retry action and keep tabs server-driven once retried', async () => {
    countsShouldFail = true;
    setUrl('?batch=b1');
    await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/Could not load stage counts/);
    countsShouldFail = false;
    await act(async () => {
      (container.querySelector('[role="alert"] button') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(tabLabels().length).toBe(6);
    expect(tabLabels()[0]).toContain('7');
  });

  it('Needs-attention panel covers the entire batch, preserves stage + input, and resolve refreshes prep + counts', async () => {
    setUrl('?batch=b1&stage=prepare_listing&stageVersion=2');
    await mount();
    const prepInput = container.querySelector('[data-testid="prepare-filter-input"]') as HTMLInputElement;
    expect(prepInput).not.toBeNull();
    await act(async () => {
      prepInput.focus();
      // Uncontrolled input: set the DOM value the way a real keystroke would.
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(prepInput, 'oatmeal');
      prepInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Header trigger carries the entire-batch attention count (2).
    const trigger = container.querySelector('[data-testid="batch-attention-trigger"]') as HTMLButtonElement;
    expect(trigger?.textContent).toMatch(/Needs attention/);
    expect(trigger?.textContent).toContain('2');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('dialog');
    // Open the panel: working stage stays in place underneath.
    trigger.focus();
    await act(async () => {
      trigger.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    const panel = container.querySelector('[data-testid="batch-attention-panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('role')).toBe('dialog');
    expect(panel?.textContent).toMatch(/Entire batch/);
    expect(container.querySelector('[data-testid="prepare-listing-view"]')).not.toBeNull();
    expect((container.querySelector('[data-testid="prepare-filter-input"]') as HTMLInputElement).value).toBe('oatmeal');
    // List -> resolver -> back to all issues.
    await act(async () => {
      (container.querySelector('[data-testid="attention-open-item-1"]') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    const resolver = container.querySelector('[data-testid="attention-resolver"]');
    expect(resolver?.getAttribute('data-item')).toBe('item_1');
    await act(async () => {
      (container.querySelector('.bws-attention-body button') as HTMLButtonElement).click(); // ← All issues
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.querySelector('[data-testid="attention-queue"]')).not.toBeNull();
    await act(async () => {
      (container.querySelector('[data-testid="attention-open-item-2"]') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    // Resolve refreshes counts AND bumps the prep refreshKey; stage + input survive.
    const countsBefore = countsUrls.length;
    await act(async () => {
      (container.querySelector('[data-testid="attention-resolve"]') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.querySelector('[data-testid="attention-resolver"]')).toBeNull();
    expect(container.querySelector('[data-testid="attention-queue"]')).not.toBeNull();
    expect(countsUrls.length).toBeGreaterThan(countsBefore);
    expect(container.querySelector('[data-testid="prepare-listing-view"]')?.getAttribute('data-refresh-key')).toBe('1');
    // Escape closes and restores focus to the trigger; the stage never moved.
    await act(async () => {
      const close = container.querySelector('[aria-label="Close attention panel"]') as HTMLButtonElement;
      close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.querySelector('[data-testid="batch-attention-panel"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(container.querySelector('#bws-stage-tab-prepare_listing')?.getAttribute('aria-selected')).toBe('true');
    expect((container.querySelector('[data-testid="prepare-filter-input"]') as HTMLInputElement).value).toBe('oatmeal');
  });

  it('visited stages stay mounted hidden: pending prepare input survives navigation there and back', async () => {
    setUrl('?batch=b1&stage=route_sources&stageVersion=2');
    await mount();
    await act(async () => {
      (container.querySelector('#bws-stage-tab-prepare_listing') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    const prepInput = container.querySelector('[data-testid="prepare-listing-view"] [data-testid="prepare-filter-input"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(prepInput, 'salmon');
      prepInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector('#bws-stage-tab-collect_details') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    // Prepare stays mounted but hidden — no unmount, no false reset.
    const hiddenPanel = container.querySelector('[data-testid="working-stage-prepare_listing"]');
    expect(hiddenPanel?.hasAttribute('hidden')).toBe(true);
    expect((hiddenPanel!.querySelector('[data-testid="prepare-filter-input"]') as HTMLInputElement).value).toBe('salmon');
    await act(async () => {
      (container.querySelector('#bws-stage-tab-prepare_listing') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.querySelector('[data-testid="working-stage-prepare_listing"]')?.hasAttribute('hidden')).toBe(false);
    expect((container.querySelector('[data-testid="prepare-filter-input"]') as HTMLInputElement).value).toBe('salmon');
  });

  it('retired brand-setup links land on Identify & Route Sources (no brand view, no board mount)', async () => {
    setUrl('?batch=b1&wview=brand-setup');
    await mount();
    expect(container.querySelector('#bws-stage-tab-route_sources')?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-testid="unsupported-link-notice"]')).toBeNull();
    expect(container.querySelector('[data-testid="brand-setup-placeholder"]')).toBeNull();
    expect(container.querySelector('[data-testid="linear-shell"]')).not.toBeNull();
  });

  it('diagnostics board queries never mount a board (sole shell + stage tabs)', async () => {
    setUrl('?batch=b1&board=pipeline');
    await mount();
    expect(container.querySelector('[data-testid="linear-shell"]')).not.toBeNull();
    expect(tabLabels().length).toBe(6);
  });

  it('shell-OFF+brand-ON shows no brand view (disabled-content state, never the new brand view)', async () => {
    resetOnboardingFeatureFlags();
    overrideOnboardingFeatureFlags({ shellV2Enabled: false, brandGateV2Enabled: true });
    setUrl('?batch=b1&view=brand-setup');
    await mount();
    expect(container.querySelector('[data-testid="brand-setup-placeholder"]')).toBeNull();
    expect(container.querySelector('[data-testid="shell-disabled-notice"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="linear-shell"]')).toBeNull();
  });

  it('Slice 6 default-on: the execution strip mounts with shell+strip flags on (stubbed EventSource)', async () => {
    resetOnboardingFeatureFlags();
    overrideOnboardingFeatureFlags({ shellV2Enabled: true, executionStripV2Enabled: true });
    const factory = vi.fn(() => ({
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    }));
    (globalThis as any).EventSource = factory;
    try {
      setUrl('?batch=b1');
      await mount();
      expect(container.querySelector('[data-testid="linear-shell"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="execution-strip"]')).not.toBeNull();
    } finally {
      delete (globalThis as any).EventSource;
    }
  });

  it('Slice 7: shell-OFF renders the disabled-content state inside the sole shell (no classic navigation)', async () => {
    resetOnboardingFeatureFlags();
    overrideOnboardingFeatureFlags({ shellV2Enabled: false });
    setUrl('?batch=b1');
    await mount();
    expect(container.querySelector('[data-testid="shell-disabled-notice"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="shell-disabled-notice"]')?.textContent).toMatch(/archived matching bridge client/i);
    expect(container.querySelector('[data-testid="workspace-grace-fallback"]')).toBeNull();
    expect(container.querySelector('[data-testid="linear-shell"]')).toBeNull();
    expect(container.querySelector('[data-testid="execution-strip"]')).toBeNull();
    expect(container.querySelectorAll('.bws-stage-tab').length).toBe(0);
  });
});
