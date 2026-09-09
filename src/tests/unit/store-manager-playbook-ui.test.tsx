// @vitest-environment jsdom
/**
 * Operations console, Issue 6 — playbook panel/editor UI smoke tests. Version
 * history, risk badges, and activation visibility are rendered from
 * deterministic data; there is NO implicit activation and NO run button (the
 * runner is Issue 7). "Edit copy" never mutates a prior version.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

vi.mock('@/client/store-manager-api', () => ({
  fetchStoreManagerPlaybooks: vi.fn(),
  fetchStoreManagerPlaybookTemplates: vi.fn(),
  fetchStoreManagerPlaybookDetail: vi.fn(),
  createStoreManagerPlaybook: vi.fn(),
  saveStoreManagerPlaybookDraft: vi.fn(),
  activateStoreManagerPlaybook: vi.fn(),
}));

import { PlaybooksPanel } from '../../client/components/store-manager/PlaybooksPanel';
import {
  fetchStoreManagerPlaybooks,
  fetchStoreManagerPlaybookTemplates,
  fetchStoreManagerPlaybookDetail,
  activateStoreManagerPlaybook,
} from '../../client/store-manager-api';
import type { StoreManagerPlaybookSummary } from '../../client/store-manager-api';
import {
  stepKindLabel,
  riskClassLabel,
  playbookStatusLabel,
  stepSequence,
  staticRiskSummary,
} from '../../client/store-manager-playbook-logic';

function makePlaybook(overrides: Partial<StoreManagerPlaybookSummary> = {}): StoreManagerPlaybookSummary {
  return {
    id: 'pb-1',
    workspaceId: 'ws-1',
    name: 'Weekly taxonomy cleanup',
    templateKind: 'weekly_taxonomy_cleanup',
    currentVersion: 1,
    status: 'draft',
    activeVersion: null,
    activeHash: null,
    activatedAt: null,
    activatedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const mockFetch = vi.mocked(fetchStoreManagerPlaybooks);
const mockTemplates = vi.mocked(fetchStoreManagerPlaybookTemplates);
const mockDetail = vi.mocked(fetchStoreManagerPlaybookDetail);
const mockActivate = vi.mocked(activateStoreManagerPlaybook);

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue([makePlaybook()]);
  mockTemplates.mockResolvedValue([
    { kind: 'weekly_taxonomy_cleanup', name: 'Weekly taxonomy cleanup', description: 'Audit + cleanup', scopeAllowedKinds: ['product_field'], stepCount: 6 },
    { kind: 'launch_readiness_check', name: 'Launch readiness check', description: 'Read-only checklist', scopeAllowedKinds: [], stepCount: 4 },
  ]);
  mockDetail.mockResolvedValue({
    playbook: makePlaybook(),
    versions: [
      {
        id: 'ver-1',
        workspaceId: 'ws-1',
        name: 'Weekly taxonomy cleanup',
        templateKind: 'weekly_taxonomy_cleanup',
        version: 1,
        status: 'draft',
        scopeInput: { allowedKinds: ['product_field'], maxSkus: 200 },
        variables: [{ name: 'field', type: 'product_field', required: true }],
        steps: [
          { stepId: 'audit', kind: 'read', toolName: 'getProductFieldAudit', toolVersion: 1, inputTemplate: { field: '{{field}}' } },
          { stepId: 'summarize', kind: 'summarize', mode: 'deterministic' },
          { stepId: 'propose', kind: 'propose', mode: 'transient_preview' },
          { stepId: 'checkpoint', kind: 'approval_checkpoint', diffRequired: true },
          { stepId: 'store', kind: 'execute', toolName: 'store_product_field_normalization_proposals', toolVersion: 1, inputTemplate: { field: '{{field}}' }, declaredRiskClass: 'proposal_write' },
          { stepId: 'verify', kind: 'verify', toolNames: [{ toolName: 'listStoredProposals', toolVersion: 1 }] },
        ],
        definitionHash: 'a'.repeat(64),
        versionId: 'ver-1',
        activatedAt: null,
        activatedBy: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
});

describe('Playbooks panel + editor (Issue 6)', () => {
  it('renders playbook status, version, and template options without implicit activation', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(PlaybooksPanel, { open: true, onClose: () => undefined }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Playbooks');
    expect(text).toContain('Weekly taxonomy cleanup');
    expect(text).toContain('Draft (inert)');
    expect(text).toContain('Copy a starter template');
    root.unmount();
    container.remove();
  });

  it('shows step contracts and risk badges in the editor; activation is explicit', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(PlaybooksPanel, { open: true, onClose: () => undefined }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const editButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Edit draft'));
    expect(editButton).toBeTruthy();
    await act(async () => {
      editButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Step contracts');
    expect(text).toContain('Read');
    expect(text).toContain('Approval checkpoint');
    expect(text).toContain('Persistent proposal write');
    // Activation is a reviewed, explicit button — not an automatic toggle.
    expect(text).toContain('Review + activate this version');
    root.unmount();
    container.remove();
  });

  it('activation calls the API only on explicit click', async () => {
    mockActivate.mockResolvedValue(makePlaybook({ status: 'active', activeVersion: 1, activeHash: 'a'.repeat(64) }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(PlaybooksPanel, { open: true, onClose: () => undefined }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const editButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Edit draft'));
    await act(async () => {
      editButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    const activateButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Review + activate'));
    expect(activateButton).toBeTruthy();
    await act(async () => {
      activateButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(mockActivate).toHaveBeenCalledWith('pb-1', 1);
    root.unmount();
    container.remove();
  });

  it('has no run/publish action anywhere in the panel (execution is Issue 7)', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(PlaybooksPanel, { open: true, onClose: () => undefined }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => (b.textContent ?? '').toLowerCase());
    expect(buttons.some((t) => /run now|run-now|publish|trust this|execute all/i.test(t))).toBe(false);
    // Step-kind labels mention "Execute" as a DSL contract, which is fine — it
    // is not an action control. Assert no action button exists.
    expect(buttons.some((t) => /run|publish|trust/i.test(t))).toBe(false);
    root.unmount();
    container.remove();
  });
});

describe('playbook pure client logic (Issue 6)', () => {
  it('labels step kinds and risk classes deterministically', () => {
    expect(stepKindLabel('execute')).toBe('Execute');
    expect(stepKindLabel('approval_checkpoint')).toBe('Approval checkpoint');
    expect(riskClassLabel('catalog_mutation')).toBe('Catalog / Change Set mutation');
    expect(playbookStatusLabel('active')).toBe('Active');
    expect(playbookStatusLabel('draft')).toBe('Draft (inert)');
  });

  it('builds a step sequence and static risk summary', () => {
    expect(stepSequence([
      { stepId: 'a', kind: 'read', toolName: 'x', toolVersion: 1, inputTemplate: {} },
      { stepId: 'b', kind: 'approval_checkpoint', diffRequired: true },
      { stepId: 'c', kind: 'execute', toolName: 'y', toolVersion: 1, inputTemplate: {} },
    ])).toBe('Read → Approval checkpoint → Execute');
    expect(staticRiskSummary({
      riskClasses: ['read', 'proposal_write'],
      expectedApprovals: [{ toolName: 'y', toolVersion: 1 }],
      networkActivity: 'none',
      expectedDiffKinds: ['diff', 'verification_diff'],
      hasMutationStep: true,
      hasVerifyStep: true,
    })).toContain('1 approval checkpoint(s)');
  });
});
