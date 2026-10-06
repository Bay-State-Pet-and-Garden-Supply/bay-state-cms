// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

vi.mock('../../shared/schemas/onboarding-stage-read', () => ({ STAGE_READ_LIMIT_DEFAULT: 50 }));
vi.mock('../../client/onboarding-api', () => ({
  assignItemBrand: vi.fn(), assignBrandGroup: vi.fn(), getBrandSites: vi.fn(), getExtractorProfiles: vi.fn(),
  getBrandStrategyDetail: vi.fn(), saveBrandStrategy: vi.fn(),
}));
vi.mock('../../client/onboarding-work-api', () => ({ assignBatchBrandDomain: vi.fn() }));

import { StageItemsView, type StageItemsViewProps } from '../../client/components/onboarding/StageItemsView';
import { assignItemBrand, assignBrandGroup, getBrandSites, getExtractorProfiles, getBrandStrategyDetail } from '../../client/onboarding-api';
import { assignBatchBrandDomain } from '../../client/onboarding-work-api';
import { resetBrandOptionsCache } from '../../client/components/onboarding/brand-combobox-logic';
import { readStageViewPreferences } from '../../client/components/onboarding/workspace-view-state';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function row(i: number, overrides: Record<string, unknown> = {}) {
  return {
    itemId: `item_${i}`, category: 'processing', activity: null, label: 'Working', detail: null,
    attentionReason: null, attentionAction: null, variantResolution: null, findingCode: null,
    findingSummary: null, conflictingValues: null, suggestedAction: null, findingDetails: null, family: null,
    reviewState: 'unreviewed', stage: 'sourcing', stageStatus: 'pending', upc: `0000000000${i}`,
    name: `Product ${i}`, brand: 'Acme', sourceType: 'official_page', domain: 'acme.com',
    curatedTitle: null, imageUrl: null, description: null, weight: null, ...overrides,
  };
}
const SOLO = {
  normalizedBrand: 'solo', approval: { approved: true, revision: 1 }, proposalSources: [],
  approvedSources: [{ kind: 'distributor_record', distributorId: 'Phillips' }],
  sourceAvailability: [{ kind: 'distributor_record', ref: 'Phillips', available: false, reason: 'Distributor connection not enabled' }],
  collectionReadiness: 'setup_attention',
};
function collection(overrides: Record<string, unknown> = {}) {
  return {
    itemId: 'item_9', path: 'approved_strategy', readiness: 'setup_attention', canCollect: false,
    canExecuteNow: false, effectiveRevision: 1, reasons: ['Approved strategy revision 1 has no usable sources'],
    requires: 'explicit_retry', effectiveSources: [],
    sourceAvailability: [{ kind: 'distributor_record', ref: 'Phillips', usable: false, reason: 'Distributor connection not enabled' }],
    label: 'Setup attention · No usable sources', explanation: null, strategyLabel: 'Phillips', ...overrides,
  };
}
function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('#284 selected-product source setup', () => {
  let container: HTMLDivElement;
  let root: Root;
  let rows: ReturnType<typeof row>[];
  let strategies: unknown[];
  let collectionByItem: Record<string, unknown>;
  let urls: string[];
  const scope = { workspaceId: 'w1', batchId: 'b1', stage: 'route_sources' as const };

  function payload(items = rows) {
    return {
      schemaVersion: 2, stageVocabularyVersion: 2, batchId: 'b1', filterFingerprint: 'a'.repeat(32),
      projectionHealth: { status: 'healthy', version: '1.0.0', computedAt: new Date().toISOString(), issues: [] },
      items, collectionByItem, nextCursor: null, scannedRows: items.length, queryCount: 3,
    };
  }
  async function settle(ms = 20) { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); }
  async function mount(props: Partial<StageItemsViewProps> = {}) {
    await act(async () => { root.render(<StageItemsView {...scope} {...props} />); });
    await settle();
  }
  function get<T extends Element = HTMLButtonElement>(id: string): T {
    const el = container.querySelector<T>(`[data-testid="${id}"]`);
    expect(el, id).not.toBeNull();
    return el!;
  }
  async function click(id: string) { await act(async () => { get<HTMLButtonElement>(id).click(); }); }
  async function details(id: string) {
    const button = container.querySelector<HTMLButtonElement>(`[data-testid="intake-details-${id}"]`) ?? get<HTMLButtonElement>(`intake-next-action-${id}`);
    await act(async () => { button.click(); });
  }

  beforeEach(() => {
    vi.clearAllMocks(); sessionStorage.clear(); resetBrandOptionsCache();
    rows = [row(1, { brand: null, domain: null }), row(2), row(3, { brand: 'Beta', domain: null }), row(4, { brand: 'Gamma', domain: null, sourceType: 'distributor_record' })];
    strategies = []; collectionByItem = {}; urls = [];
    vi.mocked(assignItemBrand).mockResolvedValue({ success: true } as never);
    vi.mocked(assignBrandGroup).mockResolvedValue({ success: true } as never);
    vi.mocked(assignBatchBrandDomain).mockResolvedValue({ success: true } as never);
    vi.mocked(getBrandSites).mockResolvedValue({ brandSites: [{ brandName: 'Acme', domain: 'acme.com' }], catalogBrands: ['Acme', 'Beta', 'Gamma'] } as never);
    vi.mocked(getExtractorProfiles).mockResolvedValue({ extractorProfiles: [{ domain: 'acme.com' }] } as never);
    vi.mocked(getBrandStrategyDetail).mockResolvedValue({ strategy: SOLO } as never);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input); urls.push(url);
      const query = new URL(url, 'http://localhost').searchParams.get('q');
      return { ok: true, status: 200, json: async () => url.includes('/brands/strategy') ? { strategies } : payload(query ? rows.filter((r) => r.name.includes(query)) : rows) } as Response;
    });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); document.body.innerHTML = '';
    window.history.replaceState(null, '', '/');
  });

  it('shows the five intake columns, quick brands, and no advanced editors or duplicate unmapped section', async () => {
    await mount();
    expect(Array.from(container.querySelectorAll('th')).map((th) => th.textContent?.trim())).toEqual(['Product', 'Brand', 'Source', 'Status', 'Next action']);
    expect(container.querySelectorAll('input[role="combobox"]')).toHaveLength(4);
    expect(container.querySelector('[data-testid="source-item-detail"]')).toBeNull();
    expect(container.querySelector('[data-testid="unmapped-brand-drawer"]')).toBeNull();
    expect(container.querySelector('[data-testid^="intake-domain-input-"]')).toBeNull();
    expect(container.querySelector('[data-testid="stage-bulk-bar"]')).toBeNull();
    expect(get('intake-kpi-strip').textContent).toMatch(/Loaded products:.*All Products \(4\).*Missing Brand \(1\).*Missing Domain \(1\).*Distributor record \(1\).*Ready to Route \(2\)/);
  });

  it('keeps individual canonical brand assignment fast and submits the originating brand', async () => {
    await mount();
    await act(async () => { setInput(get<HTMLInputElement>('stage-brand-input-item_1'), 'acme'); });
    await act(async () => { get('stage-brand-input-item_1').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(assignItemBrand).toHaveBeenCalledWith('item_1', 'Acme', undefined);
    expect(urls.filter((url) => url.includes('/stage-work-state/items')).length).toBeGreaterThan(1);
  });

  it('contextual bulk assignment previews mapped brands and supports an optional Brand Hub domain', async () => {
    await mount(); await click('stage-select-item_1');
    await act(async () => { setInput(get<HTMLInputElement>('stage-bulk-brand-input'), 'acme'); });
    expect(get('stage-bulk-domain-preview').textContent).toContain('acme.com · Active in Brand Hub (Profile Ready)');
    await click('stage-bulk-assign');
    expect(assignBrandGroup).toHaveBeenCalledWith('b1', ['item_1'], 'Acme');
    expect(assignBatchBrandDomain).not.toHaveBeenCalled();
    await click('stage-select-item_3');
    await act(async () => { setInput(get<HTMLInputElement>('stage-bulk-brand-input'), 'Beta'); });
    await act(async () => { setInput(get<HTMLInputElement>('stage-bulk-domain-input'), 'beta.com'); });
    await click('stage-bulk-assign');
    expect(assignBrandGroup).toHaveBeenCalledWith('b1', ['item_3'], 'Beta');
    expect(assignBatchBrandDomain).toHaveBeenCalledWith('b1', 'Beta', 'beta.com');
  });

  it('domain exception opens one selected-product editor; failed saves keep input and protect context', async () => {
    vi.mocked(assignBatchBrandDomain).mockRejectedValueOnce(new Error('hub refused'));
    await mount();
    expect(get('intake-next-action-item_3').textContent).toBe('Add domain');
    await click('intake-next-action-item_3');
    expect(container.querySelectorAll('[data-testid="source-item-detail"]')).toHaveLength(1);
    expect(get('source-item-detail').getAttribute('aria-label')).toContain('Product 3');
    await act(async () => { setInput(get<HTMLInputElement>('intake-domain-input-item_3'), 'beta.com'); });
    await details('item_2');
    expect(get('source-item-detail').textContent).toContain('Product 3');
    expect(container.querySelector<HTMLInputElement>('input[type="search"]')?.disabled).toBe(true);
    await click('intake-domain-save-item_3');
    expect(assignBatchBrandDomain).toHaveBeenCalledWith('b1', 'Beta', 'beta.com');
    expect(get('intake-domain-error-item_3').textContent).toContain('hub refused');
    expect(get<HTMLInputElement>('intake-domain-input-item_3').value).toBe('beta.com');
  });

  it('successful selected domain save refreshes Brand Hub, rather than marking setup locally complete', async () => {
    await mount(); await click('intake-next-action-item_3');
    await act(async () => { setInput(get<HTMLInputElement>('intake-domain-input-item_3'), 'beta.com'); });
    const before = vi.mocked(getBrandSites).mock.calls.length;
    await click('intake-domain-save-item_3'); await settle();
    expect(vi.mocked(getBrandSites).mock.calls.length).toBeGreaterThan(before);
    expect(get<HTMLInputElement>('intake-domain-input-item_3').value).toBe('');
    expect(get('intake-missing-domain-item_3').textContent).toContain('Missing Domain');
  });

  it('profile exception opens its relevant detail; specialist callback receives the product domain', async () => {
    vi.mocked(getExtractorProfiles).mockResolvedValue({ extractorProfiles: [] } as never);
    const onOpenProfileBuilder = vi.fn();
    await mount({ onOpenProfileBuilder });
    expect(container.querySelector('[data-testid="intake-profile-required-item_2"]')).toBeNull();
    expect(get('intake-next-action-item_2').textContent).toBe('Set up profile');
    await click('intake-next-action-item_2');
    expect(document.activeElement).toBe(get('intake-domain-item_2'));
    await click('intake-profile-required-item_2');
    expect(onOpenProfileBuilder).toHaveBeenCalledWith('acme.com');
    expect(readStageViewPreferences(scope)?.selectedId).toBe('item_2');
  });

  it('external profile link preserves batch URL, product preference, seed URL, and failure context', async () => {
    vi.mocked(getExtractorProfiles).mockResolvedValue({ extractorProfiles: [] } as never);
    rows = [row(2, { sourceUrl: 'https://acme.com/product', detail: 'Missing title selector' })];
    window.history.replaceState(null, '', '/?view=onboarding&batch=b1&stage=route_sources&stageVersion=2');
    const returnPath = `${location.pathname}${location.search}`;
    await mount(); await click('intake-next-action-item_2'); await click('intake-profile-required-item_2');
    expect(location.pathname).toBe('/settings/domains/acme.com/profile');
    const params = new URLSearchParams(location.search);
    expect(params.get('return')).toBe(returnPath);
    expect(params.get('seedUrl')).toBe('https://acme.com/product');
    expect(params.get('failureReason')).toBe('Missing title selector');
    expect(readStageViewPreferences(scope)?.selectedId).toBe('item_2');
  });

  it('qualified distributor records remain domain/profile-free in the selected panel', async () => {
    await mount(); await details('item_4');
    expect(get('intake-domain-item_4').textContent).toMatch(/No domain needed; no profile needed/);
    expect(container.querySelector('[data-testid="intake-profile-required-item_4"]')).toBeNull();
    expect(container.querySelector('[data-testid="intake-domain-input-item_4"]')).toBeNull();
  });

  it('approved distributor-only decisions stay exempt while unavailable, with the real availability reason', async () => {
    rows = [row(9, { brand: 'Solo', domain: null })]; strategies = [SOLO]; collectionByItem = { item_9: collection() };
    vi.mocked(getBrandSites).mockResolvedValue({ brandSites: [{ brandName: 'Solo', domain: 'solo.example' }], catalogBrands: ['Solo'] } as never);
    await mount(); await details('item_9');
    expect(get('intake-readiness-item_9').textContent).toBe('Setup attention · No usable sources');
    expect(get('source-item-detail').textContent).toContain('Phillips · Unavailable — Distributor connection not enabled');
    expect(get('intake-distributor-only-item_9').textContent).toContain('no profile needed');
    expect(container.querySelector('[data-testid="intake-profile-required-item_9"]')).toBeNull();
    expect(container.querySelector('[data-testid="intake-domain-input-item_9"]')).toBeNull();
    await click('intake-kpi-missing-domain');
    expect(container.querySelector('[data-testid="stage-select-item_9"]')).toBeNull();
  });

  it('strategy exceptions open the existing dialog directly from Next action', async () => {
    rows = [row(9, { brand: 'Solo', domain: null })]; strategies = [SOLO]; collectionByItem = { item_9: collection() };
    await mount();
    expect(get('intake-next-action-item_9').textContent).toBe('Review strategy');
    await click('intake-next-action-item_9');
    expect(container.querySelector('[data-testid="intake-strategy-dialog"]')).not.toBeNull();
    expect(getBrandStrategyDetail).toHaveBeenCalledWith('Solo');
    expect(readStageViewPreferences(scope)?.selectedId).toBe('item_9');
  });

  it('per-item blocked decisions never borrow the brand-level Ready or invent new setup gates', async () => {
    rows = [row(9, { brand: 'Solo', domain: null })];
    strategies = [{ ...SOLO, sourceAvailability: [{ kind: 'distributor_record', ref: 'Phillips', available: true, reason: 'ready' }], collectionReadiness: 'ready' }];
    collectionByItem = { item_9: collection({ path: 'blocked', readiness: 'unknown', label: 'Generation retired' }) };
    await mount();
    expect(get('intake-readiness-item_9').textContent).toBe('Generation retired');
    expect(get('intake-next-action-item_9').textContent).toBe('Details');
    expect(get('intake-kpi-ready').textContent).toContain('(0)');
    await click('intake-kpi-ready');
    expect(container.querySelector('[data-testid="stage-select-item_9"]')).toBeNull();
  });

  it('failed profile and strategy reads are unavailable, never readiness success or endless Loading', async () => {
    vi.mocked(getExtractorProfiles).mockRejectedValue(new Error('profile read failed'));
    vi.mocked(fetch).mockImplementation(async (input) => ({ ok: !String(input).includes('/brands/strategy'), status: 500, json: async () => payload() } as Response));
    await mount();
    expect(get('intake-readiness-item_2').textContent).toBe('Collection readiness unavailable · Retry');
    await details('item_2');
    expect(get('source-item-detail').textContent).toContain('Profile checks unavailable');
    expect(container.querySelector('[data-testid="intake-profile-required-item_2"]')).toBeNull();
    expect(get('intake-kpi-ready').textContent).toContain('(1)'); // only the qualified distributor fallback
  });

  it('pages one bounded read at a time and keeps quick filter counts in the explicit loaded scope', async () => {
    const allRows = Array.from({ length: 130 }, (_, i) => row(i + 1, { brand: i < 50 ? null : 'Acme' }));
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      const start = Number(url.searchParams.get('cursor') ?? 0);
      return { ok: true, status: 200, json: async () => url.pathname.includes('/brands/strategy') ? { strategies: [] } : { ...payload(allRows.slice(start, start + 50)), nextCursor: start + 50 < allRows.length ? String(start + 50) : null } } as Response;
    });
    await mount();
    // One bounded page initially (fixture limit 50), with explicit loaded scope.
    expect(get('stage-scope-label').textContent).toContain('50 loaded products');
    expect(get('stage-scope-label').textContent).toContain('more available');
    expect(get('intake-kpi-strip').textContent).toMatch(/Loaded products:.*All Products \(50\).*Missing Brand \(50\)/);
    // Load more drains the requested cursor; scope stays explicit as it grows.
    await act(async () => { Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Load more')?.click(); });
    await settle();
    expect(get('stage-scope-label').textContent).toContain('100 loaded products');
    await act(async () => { Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Load more')?.click(); });
    await settle();
    expect(get('stage-scope-label').textContent).toContain('130 loaded products');
    expect(get('stage-scope-label').textContent).not.toContain('more available');
    expect(get('intake-kpi-strip').textContent).toMatch(/Loaded products:.*All Products \(130\).*Missing Brand \(50\).*Ready to Route \(80\)/);
    await click('intake-kpi-missing-brand');
    expect(container.querySelectorAll('[data-testid^="stage-select-item_"]')).toHaveLength(50);
  });

  it('restores only preferences on remount and prunes a moved product after fresh rows', async () => {
    await mount(); await details('item_3');
    await click('intake-kpi-missing-domain');
    await act(async () => { setInput(container.querySelector<HTMLInputElement>('input[type="search"]')!, 'Product'); });
    await settle(320);
    await click('stage-select-item_3');
    expect(readStageViewPreferences(scope)).toEqual({ q: 'Product', filters: { kpiFilter: 'missing-domain' }, selectedId: 'item_3' });
    act(() => root.unmount()); root = createRoot(container); await mount();
    expect(container.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe('Product');
    expect(get('intake-kpi-missing-domain').getAttribute('aria-pressed')).toBe('true');
    expect(get('source-item-detail').textContent).toContain('Product 3');
    expect(get<HTMLInputElement>('stage-select-item_3').checked).toBe(false);
    expect(container.querySelector('[data-testid="stage-bulk-bar"]')).toBeNull();
    rows = rows.filter((r) => r.itemId !== 'item_3');
    act(() => root.unmount()); root = createRoot(container); await mount();
    expect(container.querySelector('[data-testid="source-item-detail"]')).toBeNull();
    expect(readStageViewPreferences(scope)?.selectedId).toBeNull();
  });

  it('refreshes the loaded pages without losing a valid later-page inspector or bulk selection', async () => {
    let allRows = Array.from({ length: 100 }, (_, i) => row(i + 1));
    vi.mocked(fetch).mockImplementation(async input => {
      const url = new URL(String(input), 'http://localhost');
      const start = Number(url.searchParams.get('cursor') ?? 0);
      return { ok: true, status: 200, json: async () => url.pathname.includes('/brands/strategy') ? { strategies: [] }
        : { ...payload(allRows.slice(start, start + 50)), nextCursor: start + 50 < allRows.length ? String(start + 50) : null } } as Response;
    });
    await mount({ refreshKey: 0 });
    await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Load more')!.click(); });
    await settle();
    await details('item_75');
    await click('stage-select-item_75');
    await mount({ refreshKey: 1 });
    expect(get('stage-scope-label').textContent).toContain('100 loaded products');
    expect(get('source-item-detail').textContent).toContain('Product 75');
    expect(get<HTMLInputElement>('stage-select-item_75').checked).toBe(true);
    allRows = allRows.filter(item => item.itemId !== 'item_75');
    await mount({ refreshKey: 2 });
    expect(container.querySelector('[data-testid="source-item-detail"]')).toBeNull();
    expect(container.querySelector('[data-testid="stage-select-item_75"]')).toBeNull();
  });

  it('coalesces worker refreshes instead of continuously cancelling an outstanding multi-page refresh', async () => {
    const allRows = Array.from({ length: 100 }, (_, i) => row(i + 1));
    const held = deferred<Omit<ReturnType<typeof payload>, 'nextCursor'> & { nextCursor: string | null }>();
    let hold = false;
    let itemReads = 0;
    vi.mocked(fetch).mockImplementation(async input => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.includes('/brands/strategy')) return { ok: true, status: 200, json: async () => ({ strategies: [] }) } as Response;
      itemReads += 1;
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const response = { ...payload(allRows.slice(start, start + 50)), nextCursor: start === 0 ? '50' : null };
      if (hold && start === 0) {
        hold = false;
        return { ok: true, status: 200, json: () => held.promise } as Response;
      }
      return { ok: true, status: 200, json: async () => response } as Response;
    });
    await mount({ refreshKey: 0 });
    await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Load more')!.click(); });
    await settle();
    await details('item_75');
    hold = true;
    await mount({ refreshKey: 1 });
    await mount({ refreshKey: 2 });
    expect(itemReads).toBe(3);
    await act(async () => { held.resolve({ ...payload(allRows.slice(0, 50)), nextCursor: '50' }); });
    await settle();
    expect(itemReads).toBe(6);
    expect(get('stage-scope-label').textContent).toContain('100 loaded products');
    expect(get('source-item-detail').textContent).toContain('Product 75');
  });

  it('late domain-save completion cannot refresh or alter a new batch', async () => {
    const save = deferred<any>(); vi.mocked(assignBatchBrandDomain).mockImplementationOnce(() => save.promise);
    await mount(); await click('intake-next-action-item_3');
    await act(async () => { setInput(get<HTMLInputElement>('intake-domain-input-item_3'), 'beta.com'); });
    await click('intake-domain-save-item_3');
    await mount({ batchId: 'b2' });
    const count = urls.filter((u) => u.includes('/batches/b2/')).length;
    await act(async () => { save.resolve({ success: true }); }); await settle();
    expect(urls.filter((u) => u.includes('/batches/b2/'))).toHaveLength(count);
    expect(container.textContent).not.toContain('beta.com');
    expect(readStageViewPreferences({ ...scope, batchId: 'b2' })?.selectedId).toBeNull();
  });

  it('late intake reference responses cannot replace a different batch’s current setup facts', async () => {
    const old = deferred<any>(); vi.mocked(getExtractorProfiles).mockImplementationOnce(() => old.promise);
    await mount();
    vi.mocked(getExtractorProfiles).mockResolvedValue({ extractorProfiles: [] } as never);
    await mount({ batchId: 'b2' });
    expect(get('intake-next-action-item_2').textContent).toBe('Set up profile');
    await act(async () => { old.resolve({ extractorProfiles: [{ domain: 'acme.com' }] }); });
    expect(get('intake-next-action-item_2').textContent).toBe('Set up profile');
  });
});
