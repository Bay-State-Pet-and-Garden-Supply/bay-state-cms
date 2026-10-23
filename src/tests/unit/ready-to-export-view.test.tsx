// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ReadyToExportView } from '../../client/components/onboarding/approved/ReadyToExportView';
import * as workApi from '../../client/onboarding-work-api';
import * as stageApi from '../../client/onboarding-stage-api';
import * as catalogApi from '../../client/api';
import type { OnboardingWorkState, WorkStateCategory } from '../../shared/schemas/onboarding-work-state';
import { OnboardingWorkStateSchema } from '../../shared/schemas/onboarding-work-state';
import {
  emptyStageStatusMatrix, emptyWorkStateCounts, StageReadCountsResponseSchema, StageReadItemsResponseSchema,
} from '../../shared/schemas/onboarding-stage-read';
import { readStageViewPreferences, writeStageViewPreferences } from '../../client/components/onboarding/workspace-view-state';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeItem(i: number, overrides: Partial<OnboardingWorkState> = {}): OnboardingWorkState {
  return OnboardingWorkStateSchema.parse({
    itemId: `item_${i}`, category: 'approved', activity: 'approval', label: 'Approved',
    reviewState: 'approved', stage: 'create_drafts', stageStatus: 'pending',
    upc: `01780000000${i}`, name: `RAW_INTAKE_VALUE_${i}`, brand: 'Purina Pro Plan',
    sourceType: 'official_page', domain: 'purina.com',
    curatedTitle: `Purina Chicken & Rice - ${i * 5} lb Bag`,
    imageUrl: `https://example.com/images/product-${i}.jpg`, description: `Listing copy for ${i}.`,
    weight: `${i * 5} lbs`, ...overrides,
  });
}
const health = { status: 'healthy' as const, version: '1.0.0', computedAt: '2026-10-01T12:00:00Z', issues: [] };
const envelope = (batchId: string) => ({ schemaVersion: 2, stageVocabularyVersion: 2, batchId, filterFingerprint: 'a'.repeat(32), projectionHealth: health });
const itemPage = (batchId: string, items: OnboardingWorkState[], nextCursor: string | null = null) => StageReadItemsResponseSchema.parse({
  ...envelope(batchId), items, nextCursor, scannedRows: 50, queryCount: 3,
});
function countsResponse(batchId: string, counts: Partial<ReturnType<typeof emptyWorkStateCounts>>) {
  const totals = { ...emptyWorkStateCounts(), ...counts };
  const stageStatusMatrix = emptyStageStatusMatrix();
  stageStatusMatrix.create_drafts.pending = totals.approved;
  stageStatusMatrix.create_drafts.completed = totals.ready_to_export + totals.completed;
  stageStatusMatrix.find_product_page.skipped = totals.skipped;
  return StageReadCountsResponseSchema.parse({ ...envelope(batchId), counts: totals,
    matchingTotal: Object.values(totals).reduce((sum, value) => sum + value, 0), stageStatusMatrix });
}
function persistedSet(id: string, items: OnboardingWorkState[]) {
  return {
    changeSet: { id, workspaceId: '7', title: 'Onboarding batch', status: 'draft', baseCommit: '0'.repeat(40), approvedCommit: null, createdAt: '', updatedAt: '' },
    items: items.map(item => ({ id: `draft-${item.itemId}`, changeSetId: id, sku: item.upc, operation: 'create', draftJson: JSON.stringify({ itemId: item.itemId, upc: item.upc }), baseJson: null, validationStatus: 'pending' })),
    linkedManifest: null,
    linkedStatus: 'none' as const,
    linkedComplete: false,
  };
}
function receipt(created: string[], rejected: Array<{ itemId: string; reason: string }> = [], changeSetId: string | null = 'cs-persisted'): workApi.CreateExportDraftsResponse {
  return { created, rejected, createdCount: created.length, rejectedCount: rejected.length, changeSetId,
    results: [...created.map(itemId => ({ itemId, status: 'created', reason: null })), ...rejected.map(row => ({ ...row, status: 'rejected' }))],
    audited: true, receiptId: `receipt-${created.join('-')}`, principal: 'test-operator',
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('direct CMS draft creation and batch outcomes (#285)', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let rows: Partial<Record<WorkStateCategory, OnboardingWorkState[]>>;
  let totals: Partial<ReturnType<typeof emptyWorkStateCounts>>;
  let onEvent: ((event: { type: string; data: unknown }) => void) | undefined;
  let itemsRead: MockInstance<typeof stageApi.getStageReadItems>;
  let countsRead: MockInstance<typeof stageApi.getStageReadCounts>;

  beforeEach(() => {
    window.sessionStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    rows = { approved: [makeItem(1)] };
    totals = {};
    vi.spyOn(workApi, 'subscribeBatchEvents').mockImplementation((_id, listener) => { onEvent = listener; return () => {}; });
    let key = 0;
    vi.spyOn(workApi, 'createIdempotencyKey').mockImplementation(() => `draft-key-${++key}`);
    itemsRead = vi.spyOn(stageApi, 'getStageReadItems').mockImplementation(async (batchId, query) => {
      const items = rows[query?.category ?? 'approved'] ?? [];
      const q = query?.q?.toLowerCase() ?? '';
      return itemPage(batchId, items.filter(item => [item.name, item.brand, item.upc].some(value => value?.toLowerCase().includes(q))));
    });
    countsRead = vi.spyOn(stageApi, 'getStageReadCounts').mockImplementation(async (batchId, query) => {
      const q = query?.q?.toLowerCase() ?? '';
      const counts = Object.fromEntries(Object.entries(rows).map(([category, items]) => [category,
        items.filter(item => [item.name, item.brand, item.upc].some(value => value?.toLowerCase().includes(q))).length]));
      return countsResponse(batchId, { ...counts, ...(!q ? totals : {}) });
    });
    vi.spyOn(catalogApi, 'getProduct').mockRejectedValue(new Error('No active CMS draft link available'));
    vi.spyOn(catalogApi, 'getChangeSet').mockResolvedValue(persistedSet('cs-persisted', [makeItem(1)]));
    vi.spyOn(workApi, 'createExportDrafts').mockResolvedValue(receipt(['item_1']));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });
  const render = async (batchId = 'batch-1', workspaceId: number | string = 7, onChanged?: () => void) => {
    await act(async () => root.render(<ReadyToExportView batchId={batchId} workspaceId={workspaceId} onChanged={onChanged} />));
  };
  function button(text: string): HTMLButtonElement {
    const element = [...container.querySelectorAll<HTMLButtonElement>('button')].find(row => row.textContent?.includes(text) || row.getAttribute('aria-label') === text);
    expect(element, `button: ${text}`).toBeDefined();
    return element!;
  }
  const click = async (text: string) => { await act(async () => button(text).click()); };
  const select = async (id = 'item_1') => {
    const index = Number(id.split('_')[1]);
    const checkbox = container.querySelector<HTMLInputElement>(`input[aria-label="Select ${makeItem(index).curatedTitle}"]`);
    expect(checkbox).not.toBeNull();
    await act(async () => checkbox!.click());
  };
  const search = async (value: string) => {
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('opens the task directly with full-batch totals larger than loaded pages and explicit selected-ID scope', async () => {
    totals = { approved: 241, ready_to_export: 89, completed: 65, skipped: 33 };
    itemsRead.mockImplementation(async (batchId, query) => itemPage(batchId, rows[query?.category ?? 'approved'] ?? [], `${query?.category}-next`));
    await render();
    expect(container.querySelector('[data-testid="create-drafts-workspace"]')).not.toBeNull();
    expect(button('Awaiting CMS drafts').textContent).toContain('241');
    expect(button('CMS drafts created').textContent).toContain('89');
    expect(button('Export verified').textContent).toContain('65');
    expect(button('Skipped · all stages').textContent).toContain('33');
    expect(container.textContent).toContain('428 products in draft creation and outcomes');
    expect(container.textContent).toContain('241 matching · 1 loaded');
    expect(itemsRead).toHaveBeenCalledTimes(4);
    expect(itemsRead.mock.calls.every(([, query]) => query?.limit === 50 && !query.stage && !query.cursor)).toBe(true);
    await click('Select loaded awaiting (1)');
    await click('Create CMS drafts for selected (1)');
    expect(workApi.createExportDrafts).toHaveBeenCalledWith('batch-1', ['item_1'], { idempotencyKey: 'draft-key-1' });
    expect(container.textContent).toContain('never selects the entire eligible batch');
  });

  it('reads skipped products across earlier stages and exposes no terminal mutation action', async () => {
    rows.skipped = [makeItem(2, { category: 'skipped', stage: 'find_product_page', stageStatus: 'skipped', reviewState: 'not_ready' })];
    rows.completed = [makeItem(3, { category: 'completed', stageStatus: 'completed' })];
    await render();
    await click('Skipped · all stages');
    expect(container.textContent).toContain('Purina Chicken & Rice - 10 lb Bag');
    expect(container.textContent).toContain('Skipped · find_product_page');
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(container.textContent).not.toContain('Create CMS drafts for selected');
    expect(itemsRead).toHaveBeenCalledWith('batch-1', { category: 'skipped', limit: 50 });
    await click('Export verified');
    expect(container.textContent).toContain('downstream export operation succeeded and was verified by the server');
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('replaces bounded pages and prunes selection instead of silently widening a bulk action', async () => {
    const second = makeItem(2);
    totals.approved = 251;
    itemsRead.mockImplementation(async (batchId, query) => query?.category === 'approved'
      ? itemPage(batchId, query.cursor ? [second] : [makeItem(1)], query.cursor ? null : 'cursor-2') : itemPage(batchId, []));
    await render();
    await select();
    await click('Next Approved · awaiting CMS drafts page');
    expect(container.textContent).not.toContain('Purina Chicken & Rice - 5 lb Bag');
    expect(container.textContent).toContain('Purina Chicken & Rice - 10 lb Bag');
    expect(button('Create CMS drafts for selected (0)').disabled).toBe(true);
    expect(button('Awaiting CMS drafts').textContent).toContain('251');
    expect(itemsRead).toHaveBeenCalledWith('batch-1', { category: 'approved', limit: 50, cursor: 'cursor-2' });
    await click('Previous Approved · awaiting CMS drafts page');
    expect(container.textContent).toContain('Purina Chicken & Rice - 5 lb Bag');
    expect(itemsRead.mock.calls.filter(([, query]) => query?.category === 'approved')).toHaveLength(3);
  });

  it('keeps curated listings, intake comparison, image inspection and table presentation usable', async () => {
    await render();
    expect(container.textContent).toContain('Purina Chicken & Rice - 5 lb Bag');
    expect(container.textContent).toContain('Intake:RAW_INTAKE_VALUE_1');
    expect(container.querySelector<HTMLImageElement>('img.ow-card-thumb-img')?.src).toBe('https://example.com/images/product-1.jpg');
    await click('Inspect listing');
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Listing copy for 1.');
    await click('Close drawer');
    await click('Verify Packaging');
    expect(container.querySelector('[data-testid="packaging-inspector-modal"]')).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('.ow-pi-close-btn')!.click());
    await click('Table');
    expect(container.querySelector('.ow-dense-table')).not.toBeNull();
  });

  it('reports partial failure, actual persisted draft links and retries only still-eligible failed IDs with a new receipt key', async () => {
    const first = makeItem(1);
    const second = makeItem(2);
    rows.approved = [first, second];
    const changed = vi.fn();
    vi.mocked(workApi.createExportDrafts).mockImplementationOnce(async () => {
      rows.approved = [second]; rows.ready_to_export = [{ ...first, category: 'ready_to_export', stageStatus: 'completed' }];
      return receipt(['item_1'], [{ itemId: 'item_2', reason: 'not_approved' }]);
    }).mockImplementationOnce(async () => {
      rows.approved = [];
      return receipt(['item_2'], [], 'cs-second');
    });
    vi.mocked(catalogApi.getChangeSet).mockImplementation(async id => persistedSet(id, id === 'cs-second' ? [second] : [first]));
    await render('batch-1', 7, changed);
    await click('Select loaded awaiting (2)');
    await click('Create CMS drafts for selected (2)');
    expect(container.textContent).toContain('1 created, 1 rejected');
    expect(container.textContent).toContain('item_2: rejected — not_approved');
    expect(container.textContent).toContain('receipt-item_1');
    expect(container.querySelector('a[href="/api/change-sets/cs-persisted"]')?.textContent).toBe('cs-persisted');
    expect(container.querySelector('a[href="?view=catalog&product=017800000001"]')).not.toBeNull();
    expect(container.textContent).toContain('draft-item_1');
    expect(button('Create CMS drafts for selected (1)').disabled).toBe(false);
    await click('Create CMS drafts for selected (1)');
    expect(vi.mocked(workApi.createExportDrafts).mock.calls.map(([, ids, options]) => ({ ids, key: options?.idempotencyKey }))).toEqual([
      { ids: ['item_1', 'item_2'], key: 'draft-key-1' }, { ids: ['item_2'], key: 'draft-key-2' },
    ]);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('preserves the original payload and idempotency key after an uncertain request even if refresh moves a selected item', async () => {
    vi.mocked(workApi.createExportDrafts).mockRejectedValueOnce(new Error('Connection interrupted')).mockResolvedValueOnce(receipt(['item_1']));
    await render();
    await select();
    await click('Create CMS drafts for selected (1)');
    expect(container.textContent).toContain('outcome is unconfirmed');
    rows.approved = [];
    rows.ready_to_export = [makeItem(1, { category: 'ready_to_export', stageStatus: 'completed' })];
    await act(async () => onEvent?.({ type: 'item:status', data: {} }));
    expect(button('Create CMS drafts for selected (0)').disabled).toBe(true);
    await click('Retry draft request');
    expect(vi.mocked(workApi.createExportDrafts).mock.calls).toEqual([
      ['batch-1', ['item_1'], { idempotencyKey: 'draft-key-1' }],
      ['batch-1', ['item_1'], { idempotencyKey: 'draft-key-1' }],
    ]);
    expect(container.textContent).toContain('receipt-item_1');
    expect(container.querySelector('a[href="?view=catalog&product=017800000001"]')).not.toBeNull();
  });

  it('does not resubmit receipt-confirmed successes when the projection still shows them approved', async () => {
    await render(); await select(); await click('Create CMS drafts for selected (1)');
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.disabled).toBe(true);
    await click('Select loaded awaiting (0)');
    expect(button('Create CMS drafts for selected (0)').disabled).toBe(true);
    expect(workApi.createExportDrafts).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('CMS draft receipt recorded');
  });

  it('finds links for an existing created draft from persisted product and change-set records, never the generic workspace link', async () => {
    const item = makeItem(1, { category: 'ready_to_export', stageStatus: 'completed' });
    rows = { ready_to_export: [item] };
    vi.mocked(catalogApi.getProduct).mockResolvedValue({ hasDraft: true, changeSetId: 'cs-persisted', draft: {}, approved: null, product: {} });
    await render(); await click('CMS drafts created'); await click('Inspect CMS draft links');
    const drawer = container.querySelector('[role="dialog"]')!;
    expect(drawer.querySelector('a[href="/api/change-sets/cs-persisted"]')).not.toBeNull();
    expect(drawer.querySelector('a[href="?view=catalog&product=017800000001"]')).not.toBeNull();
    expect(drawer.textContent).toContain('draft-item_1');
    expect(drawer.textContent).not.toContain('Select for Draft Creation');
    expect(catalogApi.getProduct).toHaveBeenCalledTimes(1);
  });

  it('shows unavailable linkage honestly when a created draft is no longer in the active product overlay', async () => {
    rows = { ready_to_export: [makeItem(1, { category: 'ready_to_export', stageStatus: 'completed' })] };
    vi.mocked(catalogApi.getProduct).mockResolvedValue({ hasDraft: false, changeSetId: null, draft: null, approved: {}, product: {} });
    await render(); await click('CMS drafts created'); await click('Inspect CMS draft links');
    const drawer = container.querySelector('[role="dialog"]')!;
    expect(drawer.textContent).toContain('No active CMS draft link is available');
    expect(drawer.querySelector('a')).toBeNull();
    expect(catalogApi.getChangeSet).not.toHaveBeenCalled();
    expect(button('CMS drafts created').textContent).toContain('1');
  });

  it('drops late persisted-link reads after the inspector moves to another product', async () => {
    rows = { ready_to_export: [makeItem(1, { category: 'ready_to_export' }), makeItem(2, { category: 'ready_to_export' })] };
    const lateProduct = deferred<catalogApi.ProductDetail>();
    vi.mocked(catalogApi.getProduct).mockReturnValueOnce(lateProduct.promise).mockResolvedValueOnce({ hasDraft: true, changeSetId: 'cs-second', draft: {}, approved: null, product: {} });
    vi.mocked(catalogApi.getChangeSet).mockResolvedValue(persistedSet('cs-second', [makeItem(2)]));
    await render(); await click('CMS drafts created'); await click('Inspect CMS draft links'); await click('Close drawer');
    await act(async () => {
      const links = [...container.querySelectorAll<HTMLButtonElement>('button')].filter(row => row.textContent?.includes('Inspect CMS draft links'));
      links[1].click();
    });
    await act(async () => lateProduct.resolve({ hasDraft: true, changeSetId: 'cs-old', draft: {}, approved: null, product: {} }));
    const drawer = container.querySelector('[role="dialog"]')!;
    expect(drawer.textContent).toContain('draft-item_2');
    expect(drawer.textContent).not.toContain('cs-old');
    expect(catalogApi.getChangeSet).toHaveBeenCalledTimes(1);
  });

  it('locks same-tick duplicate commands and does not mistake a parent refresh failure for an uncertain draft request', async () => {
    const pending = deferred<workApi.CreateExportDraftsResponse>();
    vi.mocked(workApi.createExportDrafts).mockReturnValueOnce(pending.promise);
    await render('batch-1', 7, () => { throw new Error('Summary unavailable'); });
    await select();
    await act(async () => { const submit = button('Create CMS drafts for selected (1)'); submit.click(); submit.click(); });
    expect(workApi.createExportDrafts).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(receipt(['item_1'])));
    expect(container.textContent).toContain('1 created, 0 rejected');
    expect(container.textContent).toContain('batch summary refresh failed');
    expect(container.textContent).not.toContain('Retry draft request');
  });

  it('retains confirmed receipts on failed linkage reads and retries reads without repeating draft creation', async () => {
    vi.mocked(catalogApi.getChangeSet).mockRejectedValueOnce(new Error('Record unavailable'));
    await render(); await select(); await click('Create CMS drafts for selected (1)');
    expect(container.textContent).toContain('1 created, 0 rejected');
    expect(container.textContent).toContain('Draft record lookup failed');
    expect(container.querySelector('a[href="?view=catalog&product=017800000001"]')).toBeNull();
    await click('Retry draft record lookup');
    expect(container.querySelector('a[href="?view=catalog&product=017800000001"]')).not.toBeNull();
    expect(workApi.createExportDrafts).toHaveBeenCalledTimes(1);
  });

  it('keeps server counts stable during full-batch search and stores only stage preferences, never mutation selection or draft records', async () => {
    rows.approved = [makeItem(1), makeItem(2)]; totals.approved = 221;
    await render(); await select(); await search('VALUE_2');
    expect(itemsRead).toHaveBeenCalledWith('batch-1', { category: 'approved', limit: 50, q: 'VALUE_2' });
    expect(countsRead).toHaveBeenCalledWith('batch-1', { q: 'VALUE_2' });
    expect(button('Awaiting CMS drafts').textContent).toContain('221');
    expect(container.textContent).toContain('1 matching · 1 loaded');
    expect(button('Create CMS drafts for selected (0)').disabled).toBe(true);
    await click('Inspect listing');
    const scope = { workspaceId: '7', batchId: 'batch-1', stage: 'create_drafts' as const };
    expect(readStageViewPreferences(scope)).toEqual({ filters: { category: 'approved' }, q: 'VALUE_2', selectedId: 'item_2' });
    const saved = window.sessionStorage.getItem(window.sessionStorage.key(0)!);
    expect(saved).not.toContain('selectedIds'); expect(saved).not.toContain('curatedTitle'); expect(saved).not.toContain('draftJson');
    await act(async () => root.render(null));
    await render();
    expect(container.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe('VALUE_2');
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(button('Create CMS drafts for selected (0)').disabled).toBe(true);
  });

  it('restores the remembered outcome filter and clears an ineligible selected-product preference', async () => {
    writeStageViewPreferences({ workspaceId: '7', batchId: 'batch-1', stage: 'create_drafts' }, {
      filters: { category: 'skipped' }, q: '', selectedId: 'gone',
    });
    rows.skipped = [makeItem(2, { category: 'skipped', stageStatus: 'skipped', stage: 'collect_details' })];
    await render();
    expect(button('Skipped · all stages').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(readStageViewPreferences({ workspaceId: '7', batchId: 'batch-1', stage: 'create_drafts' })?.selectedId).toBeNull();
  });

  it('fails closed on degraded counts at first load, retains stale rows on a failed refresh, and recovers only after a healthy refresh', async () => {
    countsRead.mockResolvedValueOnce({ ...countsResponse('batch-1', { approved: 10 }), projectionHealth: { ...health, status: 'degraded' } });
    await render();
    expect(container.textContent).toContain('Projection degraded');
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
    await click('Refresh draft status'); await select();
    countsRead.mockRejectedValueOnce(new Error('Counts unavailable'));
    await click('Refresh draft status');
    expect(container.textContent).toContain('Showing stale draft status');
    expect(container.textContent).toContain('Purina Chicken & Rice - 5 lb Bag');
    expect(button('Create CMS drafts for selected (1)').disabled).toBe(true);
    await click('Refresh draft status');
    expect(button('Create CMS drafts for selected (1)').disabled).toBe(false);
  });

  it('does not mistake unavailable counts or invalid contracts for an empty batch', async () => {
    countsRead.mockResolvedValueOnce({ batchId: 'batch-1' } as never);
    await render();
    expect(container.textContent).toContain('Draft status unavailable');
    expect(container.textContent).not.toContain('No draft creation or outcomes yet');
    await click('Retry');
    expect(container.textContent).toContain('Purina Chicken & Rice - 5 lb Bag');
  });

  it('ignores older refreshes after product movement and prunes current eligibility', async () => {
    await render(); await select();
    const stale = deferred<ReturnType<typeof countsResponse>>();
    countsRead.mockReturnValueOnce(stale.promise);
    await act(async () => onEvent?.({ type: 'batch:progress', data: {} }));
    rows.approved = []; rows.skipped = [makeItem(1, { category: 'skipped', stageStatus: 'skipped' })];
    await act(async () => onEvent?.({ type: 'item:status', data: {} }));
    await act(async () => stale.resolve(countsResponse('batch-1', { approved: 99 })));
    expect(button('Awaiting CMS drafts').textContent).toContain('0');
    expect(button('Create CMS drafts for selected (0)').disabled).toBe(true);
    await click('Skipped · all stages');
    expect(container.textContent).toContain('Purina Chicken & Rice - 5 lb Bag');
  });

  it('isolates late batch reads and late command results from a newly mounted workspace', async () => {
    const lateCounts = deferred<ReturnType<typeof countsResponse>>();
    countsRead.mockReturnValueOnce(lateCounts.promise);
    await render('batch-old'); await render('batch-new');
    await act(async () => lateCounts.resolve(countsResponse('batch-old', { approved: 777 })));
    expect(button('Awaiting CMS drafts').textContent).not.toContain('777');
    const lateCommand = deferred<workApi.CreateExportDraftsResponse>();
    vi.mocked(workApi.createExportDrafts).mockReturnValueOnce(lateCommand.promise);
    const changed = vi.fn();
    await render('batch-new', 7, changed); await select();
    await act(async () => button('Create CMS drafts for selected (1)').click());
    await render('batch-other', 8);
    await act(async () => lateCommand.resolve(receipt(['item_1'])));
    expect(container.textContent).not.toContain('receipt-item_1');
    expect(changed).not.toHaveBeenCalled();
    expect(readStageViewPreferences({ workspaceId: '8', batchId: 'batch-other', stage: 'create_drafts' })?.q).toBe('');
  });
});
