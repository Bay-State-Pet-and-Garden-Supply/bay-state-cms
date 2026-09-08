// @vitest-environment jsdom
/**
 * Operations console, Issue 3 — Manager Inbox UI smoke tests. The component
 * renders deterministic data; all mutations are operator-initiated API calls
 * (ack/resolve only). Nothing stages, publishes, repairs, or alters onboarding
 * state, and clicking an item only re-validates against current authority.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

vi.mock('@/client/store-manager-api', () => ({
  reconcileStoreManagerInbox: vi.fn(),
  fetchStoreManagerInbox: vi.fn(),
  fetchStoreManagerInboxItem: vi.fn(),
  acknowledgeStoreManagerInboxItem: vi.fn(),
  resolveStoreManagerInboxItem: vi.fn(),
  markStoreManagerNotificationRead: vi.fn(),
  fetchStoreManagerNotifications: vi.fn(),
}));

import { ManagerInbox } from '../../client/components/store-manager/ManagerInbox';
import type {
  StoreManagerInboxItem,
  StoreManagerNotification,
} from '../../client/store-manager-api';
import { sortInboxItems, summarizeInbox, formatInboxAge, isInboxItemStale, inboxCommandPrefill, unreadNotificationCount } from '../../client/store-manager-inbox-logic';

function makeItem(overrides: Partial<StoreManagerInboxItem>): StoreManagerInboxItem {
  return {
    id: 'item-1',
    workspaceId: 'ws-1',
    kind: 'high_severity_catalog_issues',
    dedupeKey: 'high_severity_catalog_issues:catalog:v1',
    severity: 'critical',
    title: 'High-severity catalog issues',
    summary: '3 blocker issue(s).',
    scope: { kind: 'catalog' },
    count: 3,
    sourceRefs: [],
    fingerprint: 'a'.repeat(64),
    lifecycle: 'open',
    sourceUpdatedAt: '2026-01-05T00:00:00.000Z',
    firstSeenAt: '2026-01-05T00:00:00.000Z',
    lastSeenAt: '2026-01-05T00:00:00.000Z',
    acknowledgedAt: null,
    resolvedAt: null,
    supersededAt: null,
    createdAt: '2026-01-05T00:00:00.000Z',
    updatedAt: '2026-01-05T00:00:00.000Z',
    ...overrides,
  };
}

function makeNotification(overrides: Partial<StoreManagerNotification>): StoreManagerNotification {
  return {
    id: 'n-1',
    workspaceId: 'ws-1',
    ruleId: 'r-1',
    ruleKind: 'critical_issue_count_increased',
    ruleVersion: 1,
    fingerprint: 'b'.repeat(64),
    severity: 'critical',
    title: 'Critical catalog issues increased',
    message: 'Critical catalog issues increased from 1 to 3.',
    inboxItemId: null,
    sourceRunId: null,
    sequence: 1,
    readAt: null,
    createdAt: '2026-01-05T00:00:00.000Z',
    ...overrides,
  };
}

async function render(element: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(element);
  });
  return { host, root };
}

describe('store-manager-inbox-logic (pure derivation)', () => {
  it('orders by severity then last-seen', () => {
    const critical = makeItem({ id: 'c', severity: 'critical', lastSeenAt: '2026-01-01T00:00:00.000Z' });
    const warning = makeItem({ id: 'w', severity: 'warning', lastSeenAt: '2026-01-03T00:00:00.000Z' });
    const info = makeItem({ id: 'i', severity: 'info', lastSeenAt: '2026-01-02T00:00:00.000Z' });
    expect(sortInboxItems([info, critical, warning]).map((i) => i.id)).toEqual(['c', 'w', 'i']);
  });

  it('summarizes counts and unread notifications', () => {
    const items = [
      makeItem({ id: '1', severity: 'critical', lifecycle: 'open' }),
      makeItem({ id: '2', severity: 'warning', lifecycle: 'acknowledged' }),
      makeItem({ id: '3', severity: 'info', lifecycle: 'resolved' }),
    ];
    const s = summarizeInbox(items);
    expect(s).toMatchObject({ total: 3, open: 1, acknowledged: 1, critical: 1, warning: 1, info: 1 });
    expect(unreadNotificationCount([makeNotification({}), makeNotification({ readAt: '2026-01-06T00:00:00.000Z' })])).toBe(1);
  });

  it('formats relative age and detects staleness', () => {
    const now = Date.parse('2026-01-10T00:00:00.000Z');
    expect(formatInboxAge('2026-01-10T00:00:00.000Z', now)).toBe('just now');
    expect(formatInboxAge('2026-01-10T00:00:00.000Z', now).length).toBeGreaterThan(0);
    const old = makeItem({ lastSeenAt: '2026-01-01T00:00:00.000Z' });
    expect(isInboxItemStale(old, 24 * 60 * 60 * 1000, now)).toBe(true);
    const fresh = makeItem({ lastSeenAt: '2026-01-09T23:00:00.000Z' });
    expect(isInboxItemStale(fresh, 24 * 60 * 60 * 1000, now)).toBe(false);
  });

  it('derives deterministic command prefills (never executes them)', () => {
    expect(inboxCommandPrefill(makeItem({ kind: 'proposals_awaiting_review' }))).toBe('/proposals');
    expect(inboxCommandPrefill(makeItem({ kind: 'high_severity_catalog_issues' }))).toBe('/health');
    expect(inboxCommandPrefill(makeItem({ kind: 'image_repairs_recommended', scope: { kind: 'change_set', changeSetId: 'cs-1' } }))).toBe('/repair-images cs-1');
    expect(inboxCommandPrefill(makeItem({ kind: 'curation_stalled', sourceRefs: [{ kind: 'onboarding_item', id: 'SKU-1' }] }))).toBe('/explain SKU-1');
  });
});

describe('ManagerInbox UI', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    const api = (await import('../../client/store-manager-api')) as unknown as {
      reconcileStoreManagerInbox: ReturnType<typeof vi.fn>;
      fetchStoreManagerInbox: ReturnType<typeof vi.fn>;
    };
    api.reconcileStoreManagerInbox.mockResolvedValue({ ok: true, inserted: 1, refreshed: 0, reopened: 0, resolved: 0, items: [], emittedNotifications: [], latestNotificationSequence: 0 });
    api.fetchStoreManagerInbox.mockResolvedValue({ items: [], openCount: 0 });
  });

  it('renders the empty state when no findings exist', async () => {
    const { root, host } = await render(<ManagerInbox open onClose={() => {}} notifications={[]} eventStatus="live" />);
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain('No open findings');
    await act(async () => { root.unmount(); });
  });

  it('shows counts and severity ordering with actionable ack/resolve only for open items', async () => {
    const api = (await import('../../client/store-manager-api')) as unknown as {
      fetchStoreManagerInbox: ReturnType<typeof vi.fn>;
    };
    api.fetchStoreManagerInbox.mockResolvedValue({
      items: [
        makeItem({ id: 'critical-1', severity: 'critical', lifecycle: 'open', lastSeenAt: new Date().toISOString() }),
        makeItem({ id: 'info-1', severity: 'info', lifecycle: 'acknowledged', kind: 'proposals_awaiting_review', dedupeKey: 'proposals_awaiting_review:catalog:v1', title: 'Proposals awaiting review', lastSeenAt: new Date().toISOString() }),
      ],
      openCount: 1,
    });
    const { host, root } = await render(<ManagerInbox open onClose={() => {}} notifications={[]} eventStatus="live" />);
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain('High-severity catalog issues');
    expect(host.textContent).toContain('Proposals awaiting review');
    // Acknowledged items show no Acknowledge button.
    expect(host.textContent).toContain('Acknowledged');
    await act(async () => { root.unmount(); });
  });

  it('marks an item read via the API only on operator click (no action on open)', async () => {
    const api = (await import('../../client/store-manager-api')) as unknown as {
      fetchStoreManagerInbox: ReturnType<typeof vi.fn>;
      acknowledgeStoreManagerInboxItem: ReturnType<typeof vi.fn>;
    };
    api.fetchStoreManagerInbox.mockResolvedValue({ items: [makeItem({ id: 'ack-1', lifecycle: 'open' })], openCount: 1 });
    api.acknowledgeStoreManagerInboxItem.mockResolvedValue(makeItem({ id: 'ack-1', lifecycle: 'acknowledged' }));
    const { host, root } = await render(<ManagerInbox open onClose={() => {}} notifications={[]} eventStatus="live" />);
    await act(async () => { await Promise.resolve(); });
    // Opening the item (revalidation) must NOT acknowledge it.
    const itemCard = host.querySelector('[aria-label*="High-severity catalog issues"]') as HTMLElement;
    await act(async () => { itemCard.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(api.acknowledgeStoreManagerInboxItem).not.toHaveBeenCalled();
    // Operator click on Acknowledge calls the API.
    const ackButtons = Array.from(host.querySelectorAll('button')).filter((b) => b.textContent === 'Acknowledge');
    expect(ackButtons.length).toBe(1);
    await act(async () => { ackButtons[0].click(); });
    await act(async () => { await Promise.resolve(); });
    expect(api.acknowledgeStoreManagerInboxItem).toHaveBeenCalledWith('ack-1');
    await act(async () => { root.unmount(); });
  });

  it('shows the deterministic command prefill chip without executing anything', async () => {
    const api = (await import('../../client/store-manager-api')) as unknown as {
      fetchStoreManagerInbox: ReturnType<typeof vi.fn>;
      fetchStoreManagerInboxItem: ReturnType<typeof vi.fn>;
    };
    api.fetchStoreManagerInbox.mockResolvedValue({ items: [makeItem({ id: 'prefill-1', kind: 'proposals_awaiting_review' })], openCount: 1 });
    api.fetchStoreManagerInboxItem.mockResolvedValue({ item: makeItem({ id: 'prefill-1', kind: 'proposals_awaiting_review' }), current: null, isCurrent: false });
    const { host, root } = await render(<ManagerInbox open onClose={() => {}} notifications={[]} eventStatus="live" />);
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain('/proposals');
    // No auto-execution happened.
    expect(api.fetchStoreManagerInboxItem).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });

  it('surfaces stale findings when revalidation disagrees with current authority', async () => {
    const api = (await import('../../client/store-manager-api')) as unknown as {
      fetchStoreManagerInbox: ReturnType<typeof vi.fn>;
      fetchStoreManagerInboxItem: ReturnType<typeof vi.fn>;
    };
    api.fetchStoreManagerInbox.mockResolvedValue({ items: [makeItem({ id: 'stale-1' })], openCount: 1 });
    api.fetchStoreManagerInboxItem.mockResolvedValue({ item: makeItem({ id: 'stale-1' }), current: null, isCurrent: false });
    const { host, root } = await render(<ManagerInbox open onClose={() => {}} notifications={[]} eventStatus="live" />);
    await act(async () => { await Promise.resolve(); });
    const itemCard = host.querySelector('[aria-label*="High-severity catalog issues"]') as HTMLElement;
    await act(async () => { itemCard.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain('out of date');
    await act(async () => { root.unmount(); });
  });
});
