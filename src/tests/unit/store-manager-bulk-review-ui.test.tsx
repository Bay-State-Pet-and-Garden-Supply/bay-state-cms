// @vitest-environment jsdom
/**
 * Operations console Issue 8 — Bulk Review panel UI smoke tests (jsdom).
 * The panel is a read/preview/deny surface: approve routes through the
 * Manager chat objective (approval stays in the runtime); deny records
 * per-item decisions; stale/decided batches are never actionable; no
 * "select all proposals" across groups; no applied/published/synced wording
 * on pending batches.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

vi.mock('@/client/store-manager-api', () => ({
  previewStoreManagerBulkReview: vi.fn(),
  fetchStoreManagerBulkReviewBatches: vi.fn(),
  fetchStoreManagerBulkReviewBatch: vi.fn(),
  denyStoreManagerBulkReviewBatch: vi.fn(),
}));

import { BulkReviewPanel } from '../../client/components/store-manager/BulkReviewPanel';
import type {
  StoreManagerBulkReviewBatch,
  StoreManagerBulkReviewItem,
  StoreManagerBulkReviewGroup,
} from '../../client/store-manager-api';
import {
  previewStoreManagerBulkReview,
  fetchStoreManagerBulkReviewBatches,
  fetchStoreManagerBulkReviewBatch,
  denyStoreManagerBulkReviewBatch,
} from '../../client/store-manager-api';
import {
  bulkReviewGroupTitle,
  bulkReviewDiffLine,
  bulkReviewExclusionSummary,
  renderBulkReviewItems,
  isBulkReviewBatchActionable,
  bulkReviewActionabilityNote,
  bulkReviewApproveObjective,
  bulkReviewBatchStatusLabel,
  bulkReviewBatchStatusActionLabel,
} from '../../client/store-manager-bulk-review-logic';

const mockedPreview = vi.mocked(previewStoreManagerBulkReview);
const mockedBatches = vi.mocked(fetchStoreManagerBulkReviewBatches);
const mockedDetail = vi.mocked(fetchStoreManagerBulkReviewBatch);
const mockedDeny = vi.mocked(denyStoreManagerBulkReviewBatch);

const BATCH: StoreManagerBulkReviewBatch = {
  id: 'batch-1',
  workspaceId: 'ws',
  field: 'ProductField24',
  normalizationKind: 'casing',
  ruleVersion: 'deterministic:casing:v1',
  evidenceKey: 'casing_normalization',
  groupKey: 'gk',
  status: 'pending',
  proposalCount: 2,
  distinctSkuCount: 2,
  diffHash: 'a'.repeat(64),
  createdBy: 'operator',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const ITEMS: StoreManagerBulkReviewItem[] = [
  { id: 'i1', workspaceId: 'ws', batchId: 'batch-1', proposalId: 'prop-1', field: 'ProductField24', oldValue: 'cat supplies', newValue: 'Cat Supplies', affectedSkus: ['SKU-1'], itemDigest: 'b'.repeat(64), decision: 'pending', decisionActor: null, changeSetItemRef: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  { id: 'i2', workspaceId: 'ws', batchId: 'batch-1', proposalId: 'prop-2', field: 'ProductField24', oldValue: 'CAT SUPPLIES', newValue: 'Cat Supplies', affectedSkus: ['SKU-2'], itemDigest: 'c'.repeat(64), decision: 'pending', decisionActor: null, changeSetItemRef: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
];

const GROUP: StoreManagerBulkReviewGroup = {
  workspaceId: 'ws',
  field: 'ProductField24',
  normalizationKind: 'casing',
  ruleVersion: 'deterministic:casing:v1',
  evidenceKey: 'casing_normalization',
  proposalCount: 2,
  distinctSkuCount: 2,
  beforeAfterSamples: [
    { oldValue: 'cat supplies', newValue: 'Cat Supplies', affectedCount: 1 },
    { oldValue: 'CAT SUPPLIES', newValue: 'Cat Supplies', affectedCount: 1 },
  ],
  exclusions: [
    { proposalId: 'prop-9', reason: 'typo correction requires review' },
    { proposalId: 'prop-10', reason: 'AI/confidence proposals never enter bulk review' },
  ],
  truncated: false,
  maxItems: 200,
};

async function renderPanel(props: { onRequestReview?: (objective: string) => void } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <BulkReviewPanel
        open
        onClose={() => undefined}
        onRequestReview={props.onRequestReview ?? (() => undefined)}
      />,
    );
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
        container.remove();
      });
    },
  };
}

function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  nativeInputValueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function submitForm(container: HTMLElement): void {
  const form = container.querySelector('form');
  expect(form).toBeTruthy();
  form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedBatches.mockResolvedValue([]);
});

describe('Bulk Review panel + pure derivation (Issue 8)', () => {
  it('renders a homogeneous group with exclusions and an exact-set diff', async () => {
    mockedBatches.mockResolvedValue([]);
    mockedPreview.mockResolvedValue({
      ok: true,
      batch: BATCH,
      items: ITEMS,
      group: GROUP,
      diffHash: 'a'.repeat(64),
      diffSummary: {
        affectedSkuCount: 2,
        proposalCount: 2,
        beforeAfterSamples: GROUP.beforeAfterSamples,
        filesTouched: ['products/SKU-1.json', 'products/SKU-2.json'],
        changeSetCurrentState: null,
        changeSetExpectedState: 'draft',
        networkActivity: 'none',
      },
    });
    const { container, unmount } = await renderPanel();
    try {
      // Enter a field + preview via a real form submit.
      const input = (container.querySelector('input[placeholder="ProductField16"]') || container.querySelector('input')) as HTMLInputElement;
      await act(async () => {
        setInputValue(input, 'ProductField24');
      });
      await act(async () => {
        submitForm(container);
      });
      const t = text(container);
      expect(t).toContain('ProductField24 · Casing · 2 proposals · 2 SKUs');
      expect(t).toContain('2 proposals affecting 2 distinct SKUs (no network activity)');
      expect(t).toContain('Excluded:');
      expect(t).toContain('typo');
      expect(t).toContain('AI/confidence');
      expect(t).toContain('Expected Change Set state');
      expect(t).toContain('draft');
    } finally {
      await unmount();
    }
  });

  it('opens a batch, shows per-item drill-down and stale note, and does NOT offer apply on a stale batch', async () => {
    mockedBatches.mockResolvedValue([
      { id: 'batch-1', field: 'ProductField24', normalizationKind: 'casing', status: 'pending', proposalCount: 2, distinctSkuCount: 2, createdAt: new Date().toISOString() },
    ]);
    mockedDetail.mockResolvedValue({
      ok: true,
      batch: BATCH,
      items: ITEMS,
      stale: true,
      staleReason: 'proposal prop-1 mapping changed',
      currentProposalCount: 1,
    });
    const { container, unmount } = await renderPanel();
    try {
      // Wait for the batch list then open.
      const openBtn = container.querySelector('button');
      await act(async () => {
        while (!container.textContent?.includes('Bulk Review')) {
          await new Promise((r) => setTimeout(r, 5));
        }
      });
      const open = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Open');
      expect(open).toBeTruthy();
      await act(async () => {
        open!.dispatchEvent(new Event('click', { bubbles: true }));
      });
      const t = text(container);
      expect(t).toContain('Stale: proposal prop-1 mapping changed');
      expect(t).toContain('Refresh preview');
      expect(t).not.toContain('Apply exact batch');
      // Per-item rows present with values.
      expect(t).toContain('cat supplies');
      expect(t).toContain('CAT SUPPLIES');
      expect(t).toContain('Cat Supplies');
    } finally {
      await unmount();
    }
  });

  it('sends the exact-batch objective to the Manager chat for approval (runtime flow)', async () => {
    mockedBatches.mockResolvedValue([
      { id: 'batch-1', field: 'ProductField24', normalizationKind: 'casing', status: 'pending', proposalCount: 2, distinctSkuCount: 2, createdAt: new Date().toISOString() },
    ]);
    mockedDetail.mockResolvedValue({
      ok: true,
      batch: BATCH,
      items: ITEMS,
      stale: false,
      staleReason: null,
      currentProposalCount: 2,
    });
    const objectives: string[] = [];
    const { container, unmount } = await renderPanel({ onRequestReview: (o) => objectives.push(o) });
    try {
      // The batch list is already loaded (mock before render).
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      const open = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Open');
      expect(open).toBeTruthy();
      await act(async () => {
        open!.dispatchEvent(new Event('click', { bubbles: true }));
      });
      const sendBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Send to Manager review');
      expect(sendBtn).toBeTruthy();
      await act(async () => {
        sendBtn!.dispatchEvent(new Event('click', { bubbles: true }));
      });
      expect(objectives.length).toBe(1);
      expect(objectives[0]).toContain('batch-1');
      expect(objectives[0]).toContain('ProductField24');
    } finally {
      await unmount();
    }
  });

  it('deny records per-item decisions with zero catalog effect wording', async () => {
    mockedBatches.mockResolvedValue([
      { id: 'batch-1', field: 'ProductField24', normalizationKind: 'casing', status: 'pending', proposalCount: 2, distinctSkuCount: 2, createdAt: new Date().toISOString() },
    ]);
    mockedDetail.mockResolvedValueOnce({
      ok: true,
      batch: BATCH,
      items: ITEMS,
      stale: false,
      staleReason: null,
      currentProposalCount: 2,
    });
    mockedDetail.mockResolvedValue({
      ok: true,
      batch: { ...BATCH, status: 'denied' },
      items: ITEMS.map((i) => ({ ...i, decision: 'denied', decisionActor: 'operator' })),
      stale: false,
      staleReason: null,
      currentProposalCount: 2,
    });
    mockedDeny.mockResolvedValue({ batchId: 'batch-1', status: 'denied', itemCount: 2 });
    const { container, unmount } = await renderPanel();
    try {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      const open = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Open');
      expect(open).toBeTruthy();
      await act(async () => {
        open!.dispatchEvent(new Event('click', { bubbles: true }));
      });
      const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const denyBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Deny exact batch');
      expect(denyBtn).toBeTruthy();
      await act(async () => {
        denyBtn!.dispatchEvent(new Event('click', { bubbles: true }));
      });
      expect(mockedDeny).toHaveBeenCalledWith('batch-1', expect.stringContaining('Denied by operator'));
      const t = text(container);
      expect(t).toContain('Denied');
      // No applied/published/synced wording anywhere.
      expect(t).not.toMatch(/published|synced/i);
      spy.mockRestore();
    } finally {
      await unmount();
    }
  });

  it('pure derivation: grouping titles, diff lines, actionability, statuses stay bounded and honest', () => {
    expect(bulkReviewGroupTitle({ field: 'ProductField24', normalizationKind: 'casing', proposalCount: 80, distinctSkuCount: 37 })).toBe('ProductField24 · Casing · 80 proposals · 37 SKUs');
    expect(bulkReviewDiffLine({ affectedSkuCount: 37, proposalCount: 80, networkActivity: 'none' })).toContain('no network activity');
    expect(bulkReviewExclusionSummary([{ reason: 'typo' }, { reason: 'typo' }, { reason: 'AI' }])).toContain('2× typo');
    expect(bulkReviewExclusionSummary([])).toBe('No exclusions.');
    const rows = renderBulkReviewItems(ITEMS);
    expect(rows).toHaveLength(2);
    expect(rows[0].skuSample).toEqual(['SKU-1']);
    expect(bulkReviewBatchStatusLabel('applied')).toBe('Applied (staged)');
    expect(bulkReviewBatchStatusLabel('denied')).toBe('Denied');
    expect(bulkReviewBatchStatusLabel('pending')).toBe('Pending review');
    expect(isBulkReviewBatchActionable({ ok: true, batch: BATCH, items: ITEMS, stale: false, staleReason: null, currentProposalCount: 2 })).toBe(true);
    expect(isBulkReviewBatchActionable({ ok: true, batch: BATCH, items: ITEMS, stale: true, staleReason: 'x', currentProposalCount: 2 })).toBe(false);
    expect(isBulkReviewBatchActionable({ ok: true, batch: { ...BATCH, status: 'denied' }, items: ITEMS, stale: false, staleReason: null, currentProposalCount: 2 })).toBe(false);
    expect(bulkReviewActionabilityNote({ ok: true, batch: BATCH, items: ITEMS, stale: true, staleReason: 'changed', currentProposalCount: 2 })).toContain('Stale');
    expect(bulkReviewActionabilityNote({ ok: true, batch: BATCH, items: ITEMS, stale: false, staleReason: null, currentProposalCount: 2 })).toBeNull();
    expect(bulkReviewBatchStatusActionLabel({ ok: true, batch: BATCH, items: ITEMS, stale: false, staleReason: null, currentProposalCount: 2 })).toBe('Send to Manager review');
    expect(bulkReviewBatchStatusActionLabel({ ok: true, batch: { ...BATCH, status: 'applied' }, items: ITEMS, stale: false, staleReason: null, currentProposalCount: 2 })).toBeNull();
    expect(bulkReviewApproveObjective('batch-1', 'ProductField24')).toContain('batch-1');
    expect(bulkReviewApproveObjective('batch-1', 'ProductField24')).not.toMatch(/publish|sync/i);
  });
});
