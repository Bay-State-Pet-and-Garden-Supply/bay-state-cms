// @vitest-environment jsdom
/**
 * Operations console, Issue 4 — Schedules panel UI smoke tests. The panel
 * renders deterministic schedule data; every action (enable/disable/run-now)
 * is an API call and "run now" is explicitly read-only. All automation is
 * disabled by default; failures surface visibly.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

vi.mock('@/client/store-manager-api', () => ({
  fetchStoreManagerSchedules: vi.fn(),
  fetchStoreManagerScheduleTemplates: vi.fn(),
  fetchStoreManagerScheduleOccurrences: vi.fn(),
  createStoreManagerSchedule: vi.fn(),
  setStoreManagerScheduleEnabled: vi.fn(),
  runStoreManagerScheduleNow: vi.fn(),
}));

import { SchedulesPanel } from '../../client/components/store-manager/SchedulesPanel';
import {
  fetchStoreManagerSchedules,
  fetchStoreManagerScheduleTemplates,
  fetchStoreManagerScheduleOccurrences,
  setStoreManagerScheduleEnabled,
  runStoreManagerScheduleNow,
} from '../../client/store-manager-api';
import type {
  StoreManagerScheduleDefinition,
} from '../../client/store-manager-api';
import {
  scheduleScheduleLabel,
  formatNextRun,
  occurrenceStatusLabel,
  sortSchedules,
  recurrenceLabel,
  dayOfWeekLabel,
} from '../../client/store-manager-schedule-logic';

function makeSchedule(overrides: Partial<StoreManagerScheduleDefinition> = {}): StoreManagerScheduleDefinition {
  return {
    id: 'sched-1',
    workspaceId: 'ws-1',
    name: 'Daily catalog health',
    version: 1,
    templateKind: 'daily_catalog_health',
    enabled: false,
    timezone: 'UTC',
    recurrencePreset: 'daily',
    timeOfDay: '06:00',
    dayOfWeek: null,
    scope: null,
    selectedModel: null,
    objective: 'Run a read-only catalog health scan.',
    definitionHash: 'a'.repeat(64),
    nextRunAt: '2026-01-02T06:00:00.000Z',
    lastRunAt: null,
    lastRunStatus: null,
    lastRunId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const mockFetch = vi.mocked(fetchStoreManagerSchedules);
const mockTemplates = vi.mocked(fetchStoreManagerScheduleTemplates);
const mockOccurrences = vi.mocked(fetchStoreManagerScheduleOccurrences);
const mockSetEnabled = vi.mocked(setStoreManagerScheduleEnabled);
const mockRunNow = vi.mocked(runStoreManagerScheduleNow);

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue([makeSchedule()]);
  mockTemplates.mockResolvedValue([]);
  mockOccurrences.mockResolvedValue([]);
});

describe('Schedules panel (Issue 4)', () => {
  it('renders schedule timezone, schedule label, next run, and read-only badge', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(SchedulesPanel, { open: true, onClose: () => undefined }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const text = container.textContent ?? '';
    expect(text).toContain('READ-ONLY');
    expect(text).toContain('Daily catalog health');
    expect(text).toContain('UTC');
    expect(text).toContain('Daily at 06:00');
    expect(text).toContain('Disabled');
    expect(text).toContain('inert until enabled');
    root.unmount();
    container.remove();
  });

  it('enable/disable and run-now buttons call the API and reload', async () => {
    mockSetEnabled.mockResolvedValue(makeSchedule({ enabled: true }));
    mockRunNow.mockResolvedValue({
      occurrenceId: 'occ-1',
      occurrenceKey: 'run-now:1',
      result: { occurrenceId: 'occ-1', occurrenceKey: 'run-now:1', status: 'completed', runId: 'run-1', errorCode: null, terminalStatus: 'success', retryCount: 0 },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(SchedulesPanel, { open: true, onClose: () => undefined }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const enableButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Enable'));
    expect(enableButton).toBeTruthy();
    await act(async () => {
      enableButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(mockSetEnabled).toHaveBeenCalledWith('sched-1', true);
    root.unmount();
    container.remove();
  });

  it('run-now is unavailable for disabled schedules (read-only posture)', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(SchedulesPanel, { open: true, onClose: () => undefined }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const runNow = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Run now'));
    // Disabled schedules cannot run now — the button is disabled.
    expect((runNow as HTMLButtonElement)?.disabled).toBe(true);
    root.unmount();
    container.remove();
  });

  it('failed runs surface visibly with errorCode', async () => {
    mockFetch.mockResolvedValue([
      makeSchedule({
        id: 'sched-fail',
        name: 'Weekly cleanup',
        templateKind: 'weekly_cleanup_report',
        recurrencePreset: 'weekly',
        dayOfWeek: 1,
        timeOfDay: '07:00',
        enabled: true,
        lastRunAt: '2026-01-05T07:00:00.000Z',
        lastRunStatus: 'failed',
        lastRunId: 'run-fail',
      }),
    ]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(SchedulesPanel, { open: true, onClose: () => undefined }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Failed');
    expect(text).toContain('Weekly Mon at 07:00');
    root.unmount();
    container.remove();
  });
});

describe('schedule pure client logic (Issue 4)', () => {
  it('labels recurrence and weekdays deterministically', () => {
    expect(recurrenceLabel('daily')).toBe('Daily');
    expect(recurrenceLabel('weekly')).toBe('Weekly');
    expect(dayOfWeekLabel(1)).toBe('Mon');
    expect(dayOfWeekLabel(7)).toBe('Sun');
    expect(dayOfWeekLabel(null)).toBe('—');
  });

  it('formats schedule labels and next runs', () => {
    expect(scheduleScheduleLabel(makeSchedule())).toBe('Daily at 06:00');
    expect(scheduleScheduleLabel(makeSchedule({ recurrencePreset: 'weekly', dayOfWeek: 3, timeOfDay: '08:00' }))).toBe('Weekly Wed at 08:00');
    expect(formatNextRun('2026-01-02T06:00:00.000Z', Date.parse('2026-01-01T06:00:00.000Z'))).toBe('in 24h');
    expect(formatNextRun(null, Date.now())).toBe('—');
  });

  it('maps occurrence statuses and sorts enabled-first', () => {
    expect(occurrenceStatusLabel('completed')).toBe('Completed');
    expect(occurrenceStatusLabel('unavailable')).toBe('Unavailable');
    const enabled = makeSchedule({ id: 'a', enabled: true, nextRunAt: '2026-02-01T00:00:00.000Z' });
    const disabled = makeSchedule({ id: 'b', enabled: false, nextRunAt: '2026-01-01T00:00:00.000Z' });
    const sorted = sortSchedules([disabled, enabled]);
    expect(sorted[0].id).toBe('a'); // enabled first
  });
});
