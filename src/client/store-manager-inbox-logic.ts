// ---------------------------------------------------------------------------
// Store Manager Inbox + notification client derivation (operations console,
// Issue 3). Pure functions only — no fetch, no hooks. All new derivation for
// the inbox lives here (the dirty store-manager-logic.ts is untouched).
// ---------------------------------------------------------------------------

import type {
  StoreManagerInboxItem,
  StoreManagerInboxLifecycle,
  StoreManagerNotification,
  StoreManagerSeverity,
} from './store-manager-api';

const SEVERITY_RANK: Record<StoreManagerSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** Sort items by severity (critical first) then last-seen (newest first). */
export function sortInboxItems(items: StoreManagerInboxItem[]): StoreManagerInboxItem[] {
  return [...items].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0),
  );
}

export function groupInboxBySeverity(items: StoreManagerInboxItem[]): Record<StoreManagerSeverity, StoreManagerInboxItem[]> {
  return {
    critical: items.filter((i) => i.severity === 'critical'),
    warning: items.filter((i) => i.severity === 'warning'),
    info: items.filter((i) => i.severity === 'info'),
  };
}

export interface InboxSummary {
  total: number;
  open: number;
  acknowledged: number;
  critical: number;
  warning: number;
  info: number;
}

export function summarizeInbox(items: StoreManagerInboxItem[]): InboxSummary {
  return {
    total: items.length,
    open: items.filter((i) => i.lifecycle === 'open').length,
    acknowledged: items.filter((i) => i.lifecycle === 'acknowledged').length,
    critical: items.filter((i) => i.severity === 'critical').length,
    warning: items.filter((i) => i.severity === 'warning').length,
    info: items.filter((i) => i.severity === 'info').length,
  };
}

/** Relative age label, e.g. "just now", "12m ago", "3h ago", "2d ago". */
export function formatInboxAge(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'unknown';
  const deltaMs = Math.max(0, now - then);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Stale display heuristic: the stored finding has not been seen for > threshold. */
export function isInboxItemStale(item: StoreManagerInboxItem, thresholdMs = 24 * 60 * 60 * 1000, now: number = Date.now()): boolean {
  const lastSeen = new Date(item.lastSeenAt).getTime();
  return Number.isFinite(lastSeen) && now - lastSeen > thresholdMs;
}

/** Deterministic command prefill per kind (never executes anything itself). */
export function inboxCommandPrefill(item: StoreManagerInboxItem): string {
  switch (item.kind) {
    case 'proposals_awaiting_review':
      return '/proposals';
    case 'high_severity_catalog_issues':
      return '/health';
    case 'failed_sync_jobs':
      return '/health';
    case 'image_repairs_recommended':
      return item.scope.kind === 'change_set' && item.scope.changeSetId
        ? `/repair-images ${item.scope.changeSetId}`
        : '/report';
    case 'curation_stalled':
      return item.sourceRefs[0] ? `/explain ${item.sourceRefs[0].id}` : '/report';
    default:
      return '';
  }
}

export function lifecycleLabel(lifecycle: StoreManagerInboxLifecycle): string {
  switch (lifecycle) {
    case 'open':
      return 'New';
    case 'acknowledged':
      return 'Seen';
    case 'resolved':
      return 'Handled';
    case 'superseded':
      return 'No longer current';
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export function sortNotifications(notifications: StoreManagerNotification[]): StoreManagerNotification[] {
  return [...notifications].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.sequence - a.sequence,
  );
}

export function unreadNotificationCount(notifications: StoreManagerNotification[]): number {
  return notifications.filter((n) => n.readAt === null).length;
}
