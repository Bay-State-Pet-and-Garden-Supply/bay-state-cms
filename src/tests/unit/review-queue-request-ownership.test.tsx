// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useReviewQueue, type UseReviewQueueResult } from '../../client/components/onboarding/review/use-review-queue';
import { getBatchReviewQueue } from '../../client/onboarding-work-api';
import { ReviewQueueRowSchema, type ReviewQueuePage } from '../../shared/schemas/onboarding-review-queue';

vi.mock('../../client/onboarding-work-api', () => ({ getBatchReviewQueue: vi.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function page(id = 'first', nextCursor: string | null = 'next'): ReviewQueuePage {
  return { batchId: 'b1', rows: [ReviewQueueRowSchema.parse({ itemId: id, upc: id, displayTitle: id,
    reviewState: 'unreviewed', reviewGateStatus: 'ready', sortKey: id, updatedAt: 'now' })], nextCursor,
  counts: { total: 2, reviewedTotal: 0, unreviewedTotal: 2, readyCount: 2, blockedCount: 0, unknownCount: 0 },
  projectionHealth: { status: 'healthy', version: '1', computedAt: 'now', issues: [] } };
}
function deferred() {
  let resolve!: (value: ReviewQueuePage) => void;
  const promise = new Promise<ReviewQueuePage>(done => { resolve = done; });
  return { promise, resolve };
}
let root: Root;
let host: HTMLDivElement;
let queue: UseReviewQueueResult;
function Probe() { queue = useReviewQueue({ batchId: 'b1', pageSize: 1 }); return null; }
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.mocked(getBatchReviewQueue).mockReset().mockResolvedValue(page());
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
async function mount() { await act(async () => { root.render(<Probe />); }); }

it('clears obsolete pagination busy state when a silent refresh supersedes its request', async () => {
  const old = deferred();
  vi.mocked(getBatchReviewQueue).mockImplementation(async (_batch, query) => query?.cursor ? old.promise : page());
  await mount();
  let request!: Promise<void>;
  await act(async () => { request = queue.loadMore(); });
  expect(queue.loadingMore).toBe(true);
  await act(async () => { await queue.loadQueue({ silent: true }); });
  expect(queue.loadingMore).toBe(false);
  await act(async () => { old.resolve(page('obsolete', null)); await request; });
  expect(queue.loadingMore).toBe(false);
  expect(queue.rows.map(row => row.itemId)).toEqual(['first']);
  expect(queue.hasMore).toBe(true);
});

it('does not let an obsolete cursor response clear the busy state of a newer cursor request', async () => {
  const old = deferred(), newer = deferred();
  let cursorRequests = 0;
  vi.mocked(getBatchReviewQueue).mockImplementation(async (_batch, query) => !query?.cursor ? page()
    : ++cursorRequests === 1 ? old.promise : newer.promise);
  await mount();
  let oldRequest!: Promise<void>, newRequest!: Promise<void>;
  await act(async () => { oldRequest = queue.loadMore(); });
  await act(async () => { await queue.loadQueue({ silent: true }); });
  await act(async () => { newRequest = queue.loadMore(); });
  await act(async () => { old.resolve(page('obsolete', null)); await oldRequest; });
  expect(queue.loadingMore).toBe(true);
  await act(async () => { newer.resolve(page('second', null)); await newRequest; });
  expect(queue.loadingMore).toBe(false);
  expect(queue.rows.map(row => row.itemId)).toEqual(['first', 'second']);
});

it('coalesces repeated Load more commands before the busy state has rendered', async () => {
  const pending = deferred();
  vi.mocked(getBatchReviewQueue).mockImplementation(async (_batch, query) => query?.cursor ? pending.promise : page());
  await mount();
  let requests!: Promise<void>[];
  await act(async () => { requests = [queue.loadMore(), queue.loadMore()]; });
  expect(getBatchReviewQueue).toHaveBeenCalledTimes(2);
  await act(async () => { pending.resolve(page('second', null)); await Promise.all(requests); });
  expect(queue.rows.map(row => row.itemId)).toEqual(['first', 'second']);
});

it('does not start a cursor read against an outstanding replacement queue request', async () => {
  const replacement = deferred();
  await mount();
  vi.mocked(getBatchReviewQueue).mockReturnValueOnce(replacement.promise);
  let refresh!: Promise<void>;
  await act(async () => { refresh = queue.loadQueue({ silent: true }); });
  expect(queue.refreshing).toBe(true);
  await act(async () => { await queue.loadMore(); });
  expect(getBatchReviewQueue).toHaveBeenCalledTimes(2);
  await act(async () => { replacement.resolve(page()); await refresh; });
  expect(queue.refreshing).toBe(false);
  vi.mocked(getBatchReviewQueue).mockResolvedValueOnce(page('second', null));
  await act(async () => { await queue.loadMore(); });
  expect(queue.rows.map(row => row.itemId)).toEqual(['first', 'second']);
});
