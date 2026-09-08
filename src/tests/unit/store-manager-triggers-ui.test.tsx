// @vitest-environment jsdom
/**
 * Operations console, Issue 5 — Triggers panel UI smoke tests. The panel
 * renders deterministic trigger data; every action (enable/disable/run-now)
 * is an API call and "run now" is explicitly read-only. All automation is
 * disabled by default; `diagnostic` occurrences surface visibly with their
 * source reference and never carry "auto fix" wording.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

vi.mock('@/client/store-manager-api', () => ({
  fetchStoreManagerTriggers: vi.fn(),
  fetchStoreManagerTriggerTemplates: vi.fn(),
  fetchStoreManagerTriggerOccurrences: vi.fn(),
  createStoreManagerTrigger: vi.fn(),
  setStoreManagerTriggerEnabled: vi.fn(),
  runStoreManagerTriggerNow: vi.fn(),
}));

import { TriggersPanel } from '../../client/components/store-manager/TriggersPanel';
import {
  fetchStoreManagerTriggers,
  fetchStoreManagerTriggerTemplates,
  fetchStoreManagerTriggerOccurrences,
  setStoreManagerTriggerEnabled,
  runStoreManagerTriggerNow,
} from '../../client/store-manager-api';
import type {
  StoreManagerTriggerDefinition,
  StoreManagerTriggerOccurrence,
  StoreManagerTriggerConfig,
} from '../../client/store-manager-api';

function makeTrigger(overrides: Partial<StoreManagerTriggerDefinition> = {}): StoreManagerTriggerDefinition {
  return {
    id: 'trig-1',
    workspaceId: 'ws-1',
    name: 'Sync failed investigation',
    version: 1,
    kind: 'sync_failed',
    enabled: false,
    config: { kind: 'sync_failed' } as StoreManagerTriggerConfig,
    scope: null,
    selectedModel: null,
    objective: 'Investigate the recorded failure evidence of the failed sync job (read-only).',
    definitionHash: 'b'.repeat(64),
    lastScanAt: null,
    lastScanStatus: null,
    lastRunId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeOccurrence(overrides: Partial<StoreManagerTriggerOccurrence> = {}): StoreManagerTriggerOccurrence {
  return {
    id: 'occ-1',
    workspaceId: 'ws-1',
    triggerId: 'trig-1',
    triggerVersion: 1,
    occurrenceKey: 'sync_failed:job-1',
    sourceRef: { kind: 'sync_job', id: 'job-1' },
    scopeJson: null,
    scheduledAt: '2026-01-02T00:00:00.000Z',
    status: 'completed',
    runId: 'run-1',
    errorCode: null,
    retryCount: 0,
    claimedAt: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    completedAt: '2026-01-02T00:01:00.000Z',
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:01:00.000Z',
    ...overrides,
  };
}

const mockFetch = vi.mocked(fetchStoreManagerTriggers);
const mockTemplates = vi.mocked(fetchStoreManagerTriggerTemplates);
const mockOccurrences = vi.mocked(fetchStoreManagerTriggerOccurrences);
const mockSetEnabled = vi.mocked(setStoreManagerTriggerEnabled);
const mockRunNow = vi.mocked(runStoreManagerTriggerNow);

function renderPanel() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<TriggersPanel open onClose={() => {}} />);
  });
  return { host, root };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue([makeTrigger()]);
  mockTemplates.mockResolvedValue([]);
  mockOccurrences.mockResolvedValue([]);
});

describe('Triggers panel UI (Issue 5)', () => {
  it('renders triggers with a visible disabled-by-default posture', async () => {
    const { host, root } = renderPanel();
    await act(async () => {
      await Promise.resolve();
    });
    const text = host.textContent ?? '';
    expect(text).toContain('Event Triggers');
    expect(text).toContain('Disabled');
    expect(text).toContain('inert until enabled');
    // Read-only wording is explicit.
    expect(text).toContain('read-only');
    // No auto-fix wording anywhere.
    expect(text.toLowerCase()).not.toContain('auto fix');
    expect(text.toLowerCase()).not.toContain('auto-fix');
    act(() => root.unmount());
  });

  it('shows the trigger kind, config summary, and scope summary', async () => {
    mockFetch.mockResolvedValue([
      makeTrigger({ id: 'drift-1', name: 'Field drift', kind: 'product_field_drift', config: { kind: 'product_field_drift', threshold: 7 } }),
    ]);
    const { host, root } = renderPanel();
    await act(async () => {
      await Promise.resolve();
    });
    const text = host.textContent ?? '';
    expect(text).toContain('ProductField drift');
    expect(text).toContain('threshold 7');
    expect(text).toContain('ProductField');
    act(() => root.unmount());
  });

  it('surfaces diagnostic occurrences with their source reference and never a run id', async () => {
    mockFetch.mockResolvedValue([
      makeTrigger({ id: 'import-1', name: 'Import audit', kind: 'import_finished', config: { kind: 'import_finished', batchId: null } }),
    ]);
    mockOccurrences.mockResolvedValue([
      makeOccurrence({ status: 'diagnostic', errorCode: 'import_not_terminal', runId: null, sourceRef: { kind: 'onboarding_batch', id: 'batch-9' } }),
    ]);
    const { host, root } = renderPanel();
    await act(async () => {
      await Promise.resolve();
    });
    const text = host.textContent ?? '';
    expect(text).toContain('diagnostic');
    expect(text).toContain('import_not_terminal');
    expect(text).toContain('batch-9');
    act(() => root.unmount());
  });

  it('enable calls the API and reflects the enabled state', async () => {
    const { host, root } = renderPanel();
    await act(async () => {
      await Promise.resolve();
    });
    mockSetEnabled.mockResolvedValue(makeTrigger({ enabled: true }));
    const enableButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Enable');
    expect(enableButton).toBeTruthy();
    await act(async () => {
      enableButton!.click();
      await Promise.resolve();
    });
    expect(mockSetEnabled).toHaveBeenCalledWith('trig-1', true);
    const text = host.textContent ?? '';
    expect(text).toContain('Enabled');
    act(() => root.unmount());
  });

  it('run-now is disabled while the trigger is disabled (not an approval shortcut)', async () => {
    const { host, root } = renderPanel();
    await act(async () => {
      await Promise.resolve();
    });
    const runNowButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Run now'));
    expect(runNowButton).toBeTruthy();
    expect((runNowButton as HTMLButtonElement).disabled).toBe(true);
    act(() => root.unmount());
  });

  it('run-now fires the API for an enabled trigger and refreshes occurrences', async () => {
    mockFetch.mockResolvedValue([makeTrigger({ enabled: true })]);
    const { host, root } = renderPanel();
    await act(async () => {
      await Promise.resolve();
    });
    mockRunNow.mockResolvedValue({ occurrenceId: 'occ-new', occurrenceKey: 'k', result: { occurrenceId: 'occ-new', occurrenceKey: 'k', status: 'completed', runId: 'run-2', errorCode: null, terminalStatus: 'success', retryCount: 0 } });
    mockOccurrences.mockResolvedValue([makeOccurrence({ id: 'occ-new' })]);
    const runNowButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Run now'));
    await act(async () => {
      runNowButton!.click();
      await Promise.resolve();
    });
    expect(mockRunNow).toHaveBeenCalledWith('trig-1');
    act(() => root.unmount());
  });
});
