// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ReviewWorkspace } from '../../client/components/onboarding/review/ReviewWorkspace';
import { ReviewQueuePageSchema, ReviewQueueRowSchema, type ReviewQueueRow } from '../../shared/schemas/onboarding-review-queue';
import * as workApi from '../../client/onboarding-work-api';
import * as api from '../../client/onboarding-api';
import * as catalogApi from '../../client/api';
import { overrideOnboardingFeatureFlags, resetOnboardingFeatureFlags } from '../../client/onboarding-feature-flags';
import { readStageViewPreferences, writeStageViewPreferences } from '../../client/components/onboarding/workspace-view-state';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function row(id: string, state: 'unreviewed' | 'reviewed' | 'approved', overrides: Partial<ReviewQueueRow> = {}) {
  return ReviewQueueRowSchema.parse({
    itemId: id, upc: `UPC-${id}`, displayTitle: `Product ${id}`, brand: 'Acme',
    sortKey: id, updatedAt: '2026-10-01T12:00:00Z', reviewGateStatus: 'ready',
    reviewState: state, stage: state === 'approved' ? 'create_drafts' : 'review_listings',
    stageStatus: state === 'reviewed' ? 'completed' : 'pending',
    actions: { canEdit: state !== 'approved', canCompleteReview: state === 'unreviewed', canApprove: state === 'reviewed' },
    ...overrides,
  });
}

function page(rows: ReviewQueueRow[], overrides: Record<string, unknown> = {}) {
  return ReviewQueuePageSchema.parse({
    batchId: 'batch-review', rows, nextCursor: null,
    counts: { total: rows.length, reviewedTotal: rows.filter(r => r.reviewState !== 'unreviewed').length, unreviewedTotal: rows.filter(r => r.reviewState === 'unreviewed').length, readyCount: rows.length, blockedCount: 0, unknownCount: 0 },
    statusTotals: { unreviewed: 53, reviewed: 7, approved: 4 },
    progress: { total: 64, reviewed: 11, remaining: 53 },
    projectionHealth: { status: 'healthy', version: '1.1.0', computedAt: '2026-10-01T12:00:00Z', issues: [] },
    ...overrides,
  });
}

function detail(current: ReviewQueueRow) {
  return {
    item: { id: current.itemId, name: current.displayTitle, stage: current.stage, stageStatus: current.stageStatus,
      sourceType: 'official_page', price: '19.99', quantity: 2, brandHint: 'Acme',
      curationData: { curatedTitle: current.displayTitle, suggestedPages: ['Pet food'], classificationProposals: [{
        id: `proposal-${current.itemId}`, proposalType: 'primary_product_type', status: 'pending', proposedValue: { productTypeId: 'dog-food' }, confidence: 0.9,
      }] }, extractionData: { primaryImage: 'https://example.test/image.jpg' } },
    sources: [], extraction: { primaryImage: 'https://example.test/image.jpg' }, consistencyWarnings: [],
    completeness: { ready: true, blockers: [], warnings: [], notes: [] },
  } as any;
}

describe('Direct Review workspace decisions (#280)', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let records: ReviewQueueRow[];
  let refreshOverrides: Record<string, unknown>;
  let event: () => void;

  beforeEach(() => {
    overrideOnboardingFeatureFlags({ reviewUiV2: true });
    records = [row('needs', 'unreviewed'), row('reviewed', 'reviewed'), row('approved', 'approved')];
    refreshOverrides = {};
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.spyOn(workApi, 'subscribeBatchEvents').mockImplementation((_batchId, callback) => {
      event = () => callback({ type: 'batch:progress' } as any);
      return () => {};
    });
    vi.spyOn(workApi, 'getBatchReviewQueue').mockImplementation(async (_batch, filters) => page(records.filter(r => filters?.reviewStates?.includes(r.reviewState!)), refreshOverrides));
    vi.spyOn(workApi, 'getBatchFilenamePreview').mockResolvedValue({ items: [] } as any);
    vi.spyOn(workApi, 'getBatchWorkStateCounts').mockResolvedValue({
      projectionHealth: { status: 'healthy', version: '1', computedAt: 'now', issues: [] },
    } as any);
    vi.spyOn(workApi, 'getBatchWorkState').mockResolvedValue({ items: [], total: 0 } as any);
    vi.spyOn(api, 'getItemDetail').mockImplementation(async id => detail(records.find(r => r.itemId === id)!));
    vi.spyOn(catalogApi, 'listPages').mockResolvedValue({ pages: [] } as any);
    vi.spyOn(catalogApi, 'listVerifiedPageOptionSummaries').mockResolvedValue({ pages: [], activeImportHash: null } as any);
    vi.spyOn(api, 'completeReviewStage').mockImplementation(async ids => {
      records = records.map(r => ids.includes(r.itemId) ? row(r.itemId, 'reviewed') : r);
      return { success: true, count: ids.length };
    });
    vi.spyOn(api, 'moveToPreviousStage').mockResolvedValue({ moved: 1 } as any);
    vi.spyOn(api, 'promoteBatchItems').mockResolvedValue({ count: 0, changeSetId: null });
    vi.spyOn(workApi, 'approveItems').mockResolvedValue({ approvedCount: 0, rejectedCount: 0, results: [], rejected: [], audited: true });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetOnboardingFeatureFlags();
  });

  function button(text: string) {
    const result = [...container.querySelectorAll('button')].find(b => b.textContent?.startsWith(text));
    expect(result, `button ${text}`).toBeDefined();
    return result!;
  }
  async function click(element: HTMLElement) {
    await act(async () => { element.click(); });
  }
  async function mount(onChanged?: () => void) {
    await act(async () => { root.render(<ReviewWorkspace batchId="batch-review" onChanged={onChanged} />); });
  }
  async function select(id: string) {
    const checkbox = container.querySelector(`#${id} input[type="checkbox"]`) as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    await click(checkbox);
  }

  it('opens Needs review directly, with server status totals and batch progress independent of the page/filter', async () => {
    await mount();
    expect(button('Needs review (53)').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[aria-label="Review progress"]')?.textContent).toContain('Reviewed 11 / 64');
    expect(container.querySelector('#needs')).not.toBeNull();
    expect(container.querySelector('#reviewed')).toBeNull();
    await click(button('Reviewed (7)'));
    expect(container.querySelector('#reviewed')).not.toBeNull();
    expect(container.querySelector('#rv-edit-title')).not.toBeNull();
    expect(container.querySelector('[aria-label="Review progress"]')?.textContent).toContain('Reviewed 11 / 64');
    expect(workApi.approveItems).not.toHaveBeenCalled();
    expect(workApi.getBatchWorkState).not.toHaveBeenCalled();
  });

  it('restores a valid later-page product from bounded server context without replacing its queue page', async () => {
    const remembered = row('later-page', 'unreviewed');
    records.push(remembered);
    writeStageViewPreferences({ workspaceId: 'w1', batchId: 'batch-review', stage: 'review_listings' }, {
      q: '', filters: { reviewState: 'unreviewed' }, selectedId: remembered.itemId,
    });
    vi.mocked(workApi.getBatchReviewQueue).mockImplementation(async (_batch, filters) => page([records[0]], {
      nextCursor: 'next', selectedRow: records.find(record => record.itemId === filters?.selectedItemId) ?? null,
    }));
    await act(async () => { root.render(<ReviewWorkspace batchId="batch-review" workspaceId="w1" />); });
    expect(container.querySelector('#later-page')).toBeNull();
    expect((container.querySelector('#rv-edit-title') as HTMLInputElement).value).toBe('Product later-page');
    expect(readStageViewPreferences({ workspaceId: 'w1', batchId: 'batch-review', stage: 'review_listings' })?.selectedId).toBe('later-page');
    expect(workApi.getBatchReviewQueue).toHaveBeenCalledWith('batch-review', expect.objectContaining({ selectedItemId: 'later-page', limit: 50 }));
  });

  it('replaces remembered selection only after the server proves it left the review scope', async () => {
    writeStageViewPreferences({ workspaceId: 'w1', batchId: 'batch-review', stage: 'review_listings' }, {
      q: '', filters: { reviewState: 'unreviewed' }, selectedId: 'gone',
    });
    vi.mocked(workApi.getBatchReviewQueue).mockResolvedValue(page([records[0]], { selectedRow: null }));
    await act(async () => { root.render(<ReviewWorkspace batchId="batch-review" workspaceId="w1" />); });
    expect((container.querySelector('#rv-edit-title') as HTMLInputElement).value).toBe('Product needs');
    expect(readStageViewPreferences({ workspaceId: 'w1', batchId: 'batch-review', stage: 'review_listings' })?.selectedId).toBe('needs');
  });

  it('retains keyboard Looks Good & Next and requires a separate approval in Reviewed', async () => {
    const changed = vi.fn();
    await mount(changed);
    const first = container.querySelector('#needs') as HTMLElement;
    await act(async () => { first.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true })); });
    expect(api.completeReviewStage).toHaveBeenCalledWith(['needs'], undefined);
    expect(workApi.approveItems).not.toHaveBeenCalled();
    await click(button('Reviewed (7)'));
    await select('needs');
    vi.mocked(workApi.approveItems).mockImplementationOnce(async (_batch, ids) => {
      records = records.map(r => ids.includes(r.itemId) ? row(r.itemId, 'approved') : r);
      return { approvedCount: 1, rejectedCount: 0, results: [{ itemId: 'needs', status: 'approved', reason: null }], rejected: [], audited: true, receiptId: 'receipt-1' };
    });
    await click(button('Approve selected reviewed (1)'));
    expect(workApi.approveItems).toHaveBeenCalledWith('batch-review', ['needs'], { idempotencyKey: expect.any(String) });
    expect(container.textContent).toContain('needs: approved');
    expect(container.textContent).toContain('receipt-1');
    expect(container.querySelector('#needs')).toBeNull();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(api.promoteBatchItems).not.toHaveBeenCalled();
    await click(button('Approved (4)'));
    expect(container.querySelector('#needs')).not.toBeNull();
  });

  function filenamePreview(id: string, catalogCollision = false) {
    return { itemId: id, title: `Product ${id}`, upc: `UPC-${id}`, fileName: 'product-2.html', baseFileName: 'product.html', warnings: [{
      code: catalogCollision ? 'filename_collision_catalog' : 'filename_collision_batch',
      message: 'Filename already owned', conflicts: [], fileName: 'product.html',
    }], allowedResolutions: catalogCollision ? ['retitle', 'defer'] : ['accept', 'retitle', 'defer'] } as any;
  }

  it('keeps explicit filename Accept/Defer for completion, with keyboard unable to bypass the decision', async () => {
    vi.mocked(workApi.getBatchFilenamePreview).mockResolvedValue({ items: [filenamePreview('needs')] } as any);
    await mount();
    expect(button('Looks Good & Next').disabled).toBe(true);
    await act(async () => { container.querySelector('#needs')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true })); });
    expect(api.completeReviewStage).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Filename warning needs an explicit decision');
    await click(button('Accept filename & mark reviewed'));
    expect(api.completeReviewStage).toHaveBeenCalledWith(['needs'], { filenameDecisions: { needs: 'accept' } });
    expect(workApi.approveItems).not.toHaveBeenCalled();
  });

  it('defers a catalog collision without recording reviewed or offering Accept', async () => {
    vi.mocked(workApi.getBatchFilenamePreview).mockResolvedValue({ items: [filenamePreview('needs', true)] } as any);
    vi.mocked(api.completeReviewStage).mockResolvedValue({ success: true, count: 0 });
    await mount();
    expect([...container.querySelectorAll('button')].some(b => b.textContent?.startsWith('Accept filename'))).toBe(false);
    await click(button('Defer'));
    expect(api.completeReviewStage).toHaveBeenCalledWith(['needs'], { filenameDecisions: { needs: 'defer' } });
    expect(workApi.approveItems).not.toHaveBeenCalled();
  });

  it('passes explicit approval filename decisions to the existing command and rotates receipt keys when they change', async () => {
    vi.mocked(workApi.getBatchFilenamePreview).mockResolvedValue({ items: [filenamePreview('reviewed')] } as any);
    vi.mocked(workApi.approveItems).mockRejectedValue(new Error('Lost response'));
    await mount();
    await click(button('Reviewed (7)'));
    await select('reviewed');
    const decision = container.querySelector('[aria-label="Approve reviewed selection"] select') as HTMLSelectElement;
    expect(decision).not.toBeNull();
    await act(async () => { decision.value = 'accept'; decision.dispatchEvent(new Event('change', { bubbles: true })); });
    await click(button('Approve selected reviewed (1)'));
    const firstKey = vi.mocked(workApi.approveItems).mock.calls[0][2]?.idempotencyKey;
    expect(workApi.approveItems).toHaveBeenLastCalledWith('batch-review', ['reviewed'], { idempotencyKey: firstKey, filenameDecisions: { reviewed: 'accept' } });
    await act(async () => { decision.value = 'defer'; decision.dispatchEvent(new Event('change', { bubbles: true })); });
    await click(button('Approve selected reviewed (1)'));
    const next = vi.mocked(workApi.approveItems).mock.calls[1];
    expect(next[2]?.filenameDecisions).toEqual({ reviewed: 'defer' });
    expect(next[2]?.idempotencyKey).not.toBe(firstKey);
  });

  it('inspects Approved pending Create drafts without edit, completion, decision, or send-back controls', async () => {
    await mount();
    await click(button('Approved (4)'));
    expect(container.querySelector('#approved[aria-selected="true"]')).not.toBeNull();
    expect(container.querySelector('#rv-edit-title')).toBeNull();
    expect(container.querySelector('#approved input[type="checkbox"]')).toBeNull();
    const labels = [...container.querySelectorAll('button')].map(b => b.textContent);
    expect(labels).not.toContain('Looks Good & Next');
    expect(labels).not.toContain('Accept');
    expect(labels.some(label => label?.includes('Send to Curation'))).toBe(false);
    expect(button('Next →')).toBeDefined();
    await act(async () => { container.querySelector('#approved')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true })); });
    expect(api.completeReviewStage).not.toHaveBeenCalled();
    expect(api.moveToPreviousStage).not.toHaveBeenCalled();
  });

  it('restricts a queue row when selected detail has since become terminal', async () => {
    vi.mocked(api.getItemDetail).mockImplementation(async id => ({ ...detail(records.find(r => r.itemId === id)!), item: { ...detail(records.find(r => r.itemId === id)!).item, stageStatus: 'skipped' } }));
    await mount();
    expect(container.querySelector('#rv-edit-title')).toBeNull();
    expect(container.querySelector('#needs input[type="checkbox"]')).toBeNull();
    expect(container.textContent).toContain('Inspection only');
    expect([...container.querySelectorAll('button')].some(b => b.textContent === 'Looks Good & Next')).toBe(false);
  });

  it('reports exact partial approval outcomes and refreshes without sweeping unselected or unseen IDs', async () => {
    records.push(row('failed', 'reviewed'));
    await mount();
    await click(button('Reviewed (7)'));
    await select('reviewed');
    await select('failed');
    vi.mocked(workApi.approveItems).mockImplementationOnce(async () => {
      records = records.map(r => r.itemId === 'reviewed' ? row(r.itemId, 'approved') : r);
      return { approvedCount: 1, rejectedCount: 1, results: [{ itemId: 'reviewed', status: 'approved', reason: null }, { itemId: 'failed', status: 'rejected', reason: 'semantic_validation_blocked' }], rejected: [{ itemId: 'failed', status: 'rejected', reason: 'semantic_validation_blocked' }], audited: true };
    });
    await click(button('Approve selected reviewed (2)'));
    expect(vi.mocked(workApi.approveItems).mock.calls[0][1]).toEqual(['failed', 'reviewed']);
    expect(container.textContent).toContain('1 approved · 1 rejected');
    expect(container.textContent).toContain('failed: rejected — semantic_validation_blocked');
    expect(container.querySelector('#failed')).not.toBeNull();
    expect(container.querySelector('#reviewed')).toBeNull();
  });

  it('reuses an idempotency key after transport failure, and rotates it when selection changes', async () => {
    records.push(row('other', 'reviewed'));
    await mount();
    await click(button('Reviewed (7)'));
    await select('reviewed');
    vi.mocked(workApi.approveItems).mockRejectedValue(new Error('Connection lost'));
    await click(button('Approve selected reviewed (1)'));
    await click(button('Approve selected reviewed (1)'));
    const calls = vi.mocked(workApi.approveItems).mock.calls;
    expect(calls[0][2]?.idempotencyKey).toBe(calls[1][2]?.idempotencyKey);
    await select('other');
    await click(button('Approve selected reviewed (2)'));
    expect(calls[2][2]?.idempotencyKey).not.toBe(calls[0][2]?.idempotencyKey);
    expect(container.textContent).toContain('Connection lost');
  });

  it.each(['blocked', 'unknown'] as const)('blocks approval of selected %s readiness', async gate => {
    records[1] = row('reviewed', 'reviewed', { reviewGateStatus: gate });
    await mount();
    await click(button('Reviewed (7)'));
    await select('reviewed');
    expect(button('Approve selected reviewed (1)').disabled).toBe(true);
    expect(container.textContent).toContain('blocked or unavailable readiness');
    expect(workApi.approveItems).not.toHaveBeenCalled();
  });

  it('disables approval when projection health is degraded and prunes eligibility after movement', async () => {
    vi.useFakeTimers();
    await mount();
    await click(button('Reviewed (7)'));
    await select('reviewed');
    refreshOverrides = { projectionHealth: { status: 'degraded', version: '1.1.0', computedAt: 'now', issues: [{ source: 'review_state', code: 'unavailable', affectedCount: 1 }] } };
    await act(async () => { event(); await vi.advanceTimersByTimeAsync(901); });
    expect(button('Approve selected reviewed (1)').disabled).toBe(true);
    refreshOverrides = {};
    records = records.map(r => r.itemId === 'reviewed' ? row(r.itemId, 'approved') : r);
    await act(async () => { event(); await vi.advanceTimersByTimeAsync(901); });
    expect(button('Approve selected reviewed (0)').disabled).toBe(true);
    expect(container.querySelector('#reviewed')).toBeNull();
  });

  it('keeps a failed refresh visibly stale and forbids approval until retry', async () => {
    vi.useFakeTimers();
    await mount();
    await click(button('Reviewed (7)'));
    await select('reviewed');
    vi.mocked(workApi.getBatchReviewQueue).mockRejectedValueOnce(new Error('Queue unavailable'));
    await act(async () => { event(); await vi.advanceTimersByTimeAsync(901); });
    expect(container.textContent).toContain('Queue unavailable');
    expect(button('Approve selected reviewed (1)').disabled).toBe(true);
    await click(button('Retry queue'));
    expect(container.textContent).not.toContain('Queue unavailable');
  });

  it.each(['degraded', 'unavailable'] as const)('fails closed when approval work-state projection health is %s', async status => {
    if (status === 'degraded') vi.mocked(workApi.getBatchWorkStateCounts).mockResolvedValue({ projectionHealth: { status: 'degraded' } } as any);
    else vi.mocked(workApi.getBatchWorkStateCounts).mockRejectedValue(new Error('Health read failed'));
    await mount();
    await click(button('Reviewed (7)'));
    await select('reviewed');
    expect(button('Approve selected reviewed (1)').disabled).toBe(true);
    expect(container.textContent).toContain(status === 'degraded' ? 'Approval projection degraded' : 'Approval projection health unavailable');
    expect(workApi.approveItems).not.toHaveBeenCalled();
    vi.mocked(workApi.getBatchWorkStateCounts).mockResolvedValue({ projectionHealth: { status: 'healthy' } } as any);
    await click(button('Retry approval health'));
    expect(button('Approve selected reviewed (1)').disabled).toBe(false);
  });

  it('honors selected detail completeness blockers even when an older queue row reported ready', async () => {
    vi.mocked(api.getItemDetail).mockImplementation(async id => ({ ...detail(records.find(r => r.itemId === id)!), completeness: { ready: false, blockers: ['missing_pages'], warnings: [], notes: [] } }));
    await mount();
    await click(button('Reviewed (7)'));
    await select('reviewed');
    expect(button('Approve selected reviewed (1)').disabled).toBe(true);
    expect(workApi.approveItems).not.toHaveBeenCalled();
  });

  it('protects dirty edits when a status filter would navigate to another product', async () => {
    await mount();
    const title = container.querySelector('#rv-edit-title') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, 'Unsaved listing title');
      title.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await click(button('Reviewed (7)'));
    expect(confirm).toHaveBeenCalledWith('Discard unsaved listing changes for this product?');
    expect(button('Needs review (53)').getAttribute('aria-pressed')).toBe('true');
    expect((container.querySelector('#rv-edit-title') as HTMLInputElement).value).toBe('Unsaved listing title');
    expect(api.completeReviewStage).not.toHaveBeenCalled();
    expect(workApi.approveItems).not.toHaveBeenCalled();
  });

  it('ignores an old load-more response after switching review status', async () => {
    let resolveMore!: (value: ReturnType<typeof page>) => void;
    const more = new Promise<ReturnType<typeof page>>(resolve => { resolveMore = resolve; });
    vi.mocked(workApi.getBatchReviewQueue).mockImplementation(async (_batch, filters) => {
      if (filters?.cursor) return more;
      const visible = records.filter(r => filters?.reviewStates?.includes(r.reviewState!));
      return page(visible, { nextCursor: filters?.reviewStates?.includes('unreviewed') ? 'old-cursor' : null });
    });
    await mount();
    await click(button('Load more'));
    await click(button('Reviewed (7)'));
    await act(async () => { resolveMore(page([row('late-old-page', 'unreviewed')])); });
    expect(container.querySelector('#late-old-page')).toBeNull();
    expect(container.querySelector('#reviewed')).not.toBeNull();
    expect(button('Reviewed (7)').getAttribute('aria-pressed')).toBe('true');
  });
});
