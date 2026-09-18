// @vitest-environment jsdom
// #238 — Profile Workspace investigation operator UI.
//
// Pins the acceptance criteria at the UI seam:
// - launch / watch / cancel without touching API payloads (forms only);
// - holdout coverage shown as reserved, never offered as launch candidates;
// - Validate / Apply / Discard as separate actions; failed validation still
//   applies as a blocked draft with blockers visible;
// - no affordance with the banned labels anywhere in the investigation view;
// - apply sends the operator name only (server-authoritative apply, #234).
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

vi.mock('../../client/investigation-api', () => ({
  listInvestigations: vi.fn(),
  previewInvestigationBudgets: vi.fn(),
  launchInvestigation: vi.fn(),
  fetchInvestigationWorkspace: vi.fn(),
  fetchDriftContext: vi.fn(),
  cancelInvestigation: vi.fn(),
  validateInvestigation: vi.fn(),
  applyInvestigationToDraft: vi.fn(),
  discardInvestigation: vi.fn(),
}));

import {
  buildApplyBody,
  buildLaunchBody,
  buildValidateBody,
  isReservedUrl,
  launchCandidatesOf,
  reservedHoldoutsCovered,
  type InvestigationWorkspaceView,
  type ValidationSampleEntry,
} from '../../client/components/profile-workspace/investigation-contracts';
import { InvestigationPanel } from '../../client/components/profile-workspace/InvestigationPanel';
import {
  applyInvestigationToDraft,
  cancelInvestigation,
  fetchInvestigationWorkspace,
  launchInvestigation,
  listInvestigations,
  validateInvestigation,
} from '../../client/investigation-api';

function setTextInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const DOMAIN = 'shop.example.com';
const REP_A = 'https://shop.example.com/products/alpha';
const REP_B = 'https://shop.example.com/products/beta';
const HOLDOUT = 'https://shop.example.com/products/holdout-1';

function workspaceFixture(
  overrides: Partial<InvestigationWorkspaceView> = {},
): InvestigationWorkspaceView {
  return {
    investigation: { id: 'binv_1', domain: DOMAIN, mode: 'domain_onboarding', status: 'completed', provider: 'local_browser_harness' },
    representatives: { confirmed: [REP_A, REP_B], investigated: [REP_A, REP_B] },
    holdouts: {
      required: 1,
      passed: 0,
      reserved: [HOLDOUT],
      suggestion: { preferred: [REP_A], gaps: [] },
      validationStatus: 'failed',
    },
    budgets: [{ key: 'maxPages', label: 'Product pages', value: 'up to 5' }],
    evidence: {
      platform: 'shopify',
      provider: 'local_browser_harness',
      requestedModel: 'local/qwen',
      actualModel: 'local/qwen',
      usage: { modelCalls: 2, pagesVisited: 2, readsPerformed: 4, costDisplay: 'unavailable' },
      structures: [{ id: 'shopify-default', platformSource: 'shopify_product_json' }],
      fieldRecommendations: [{ field: 'title', sources: ['shopify_product_json'] }],
      identity: { productIdentity: ['gtin_exact'], variantIdentity: ['sku_exact'], optionAxes: [] },
      gaps: ['unresolved:availability has no supported source'],
      codeAdapterNeeded: null,
      renderedBrowser: { required: false, reason: null },
      evidenceLinks: ['artifact:alpha'],
      failure: null,
    },
    proposal: {
      available: true,
      status: 'proposal',
      proposalHash: 'p'.repeat(64),
      policyHash: 'q'.repeat(64),
      structuresCount: 1,
      fieldsCount: 1,
      gaps: [],
      capability: null,
    },
    validation: {
      validationId: 'vval_1',
      status: 'failed',
      holdouts: { required: 1, passed: 0, sampleIds: [HOLDOUT] },
      blockers: ['holdout_failed:no blind holdout passed'],
      samples: [],
    },
    actions: {
      validate: { allowed: true, reason: 'completed investigation with a typed result' },
      apply: { allowed: true, reason: 'compilable proposal; publishes a sanitized inactive shared draft' },
      discard: { allowed: true, reason: 'terminal investigations can be discarded' },
    },
    ...overrides,
  };
}

async function renderPanel(suiteUrls: string[] = [REP_A, REP_B]): Promise<{ container: HTMLElement }> {
  vi.mocked(listInvestigations).mockResolvedValue([]);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<InvestigationPanel domain={DOMAIN} suiteUrls={suiteUrls} />);
  });
  return { container };
}

function clickButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(label),
  ) as HTMLButtonElement | undefined;
  if (!button) throw new Error(`button "${label}" not found in: ${container.textContent?.slice(0, 400)}`);
  return button;
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('request contracts (server-authoritative apply)', () => {
  it('launch body carries sample URLs only — no provider or scenario keys', () => {
    expect(buildLaunchBody([REP_A])).toEqual({ sampleUrls: [REP_A] });
    expect(Object.keys(buildLaunchBody([REP_A])).sort()).toEqual(['sampleUrls']);
  });

  it('apply body is exactly { actor } — never verdicts or holdout counts', () => {
    expect(buildApplyBody('operator-1')).toEqual({ actor: 'operator-1' });
    expect(Object.keys(buildApplyBody('operator-1'))).toEqual(['actor']);
    expect(() => buildApplyBody('  ')).toThrow(/actor required/);
  });

  it('validate body carries references (URL + role + expected name), never counts', () => {
    const body = buildValidateBody([
      { url: REP_A, role: 'representative', expectedName: 'Alpha' },
      { url: HOLDOUT, role: 'holdout', expectedName: 'Holdout One' },
    ]);
    expect(body.samples).toEqual([
      { url: REP_A, role: 'representative', expected: { name: 'Alpha' } },
      { url: HOLDOUT, role: 'holdout', expected: { name: 'Holdout One' } },
    ]);
    expect(body).not.toHaveProperty('status');
    expect(body).not.toHaveProperty('holdouts');
  });

  it('launch candidates exclude reserved holdouts; coverage requires every reserved holdout', () => {
    expect(launchCandidatesOf([REP_A, HOLDOUT], [HOLDOUT])).toEqual([REP_A]);
    expect(launchCandidatesOf([REP_A, `${HOLDOUT}/`], [HOLDOUT])).toEqual([REP_A]);
    expect(isReservedUrl(`${HOLDOUT}/`, [HOLDOUT])).toBe(true);
    expect(isReservedUrl(REP_A, [HOLDOUT])).toBe(false);
    expect(
      reservedHoldoutsCovered([{ url: HOLDOUT, role: 'holdout', expectedName: 'H' }], [HOLDOUT]),
    ).toBe(true);
    expect(
      reservedHoldoutsCovered([{ url: REP_A, role: 'representative', expectedName: 'A' }], [HOLDOUT]),
    ).toBe(false);
  });
});

describe('launch, watch, and cancel without touching API payloads', () => {
  it('renders Investigate Domain / Investigate Drift launch actions for the suite', async () => {
    const { container } = await renderPanel();
    expect(container.textContent).toContain('Investigate Domain');
    expect(container.textContent).toContain('Investigate Drift');
    expect(container.textContent).toContain('Preview budgets');
  });

  it('launch sends sample URLs only through the form selection', async () => {
    vi.mocked(listInvestigations).mockResolvedValue([]);
    vi.mocked(launchInvestigation).mockResolvedValue({
      investigation: { id: 'binv_new', domain: DOMAIN, mode: 'domain_onboarding', status: 'queued', provider: 'local_browser_harness' },
    });
    vi.mocked(fetchInvestigationWorkspace).mockResolvedValue({ workspace: workspaceFixture() });
    const { container } = await renderPanel();
    await act(async () => {
      clickButton(container, 'Investigate Domain').click();
    });
    expect(launchInvestigation).toHaveBeenCalledWith(DOMAIN, 'domain_onboarding', [REP_A, REP_B]);
    const body = vi.mocked(launchInvestigation).mock.calls[0][2];
    expect(body.length).toBeLessThanOrEqual(5);
  });

  it('cancel is offered for running investigations and refreshes the view', async () => {
    vi.mocked(listInvestigations).mockResolvedValue([
      { id: 'binv_run', domain: DOMAIN, mode: 'domain_onboarding', status: 'running', provider: 'local_browser_harness' },
    ]);
    const running = workspaceFixture({
      investigation: { id: 'binv_run', domain: DOMAIN, mode: 'domain_onboarding', status: 'running', provider: 'local_browser_harness' },
    });
    vi.mocked(fetchInvestigationWorkspace).mockResolvedValue({ workspace: running });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<InvestigationPanel domain={DOMAIN} suiteUrls={[REP_A]} />);
    });
    await act(async () => {
      clickButton(container, 'Open').click();
    });
    expect(container.textContent).toContain('Cancel investigation');
    vi.mocked(cancelInvestigation).mockResolvedValue({
      investigation: { id: 'binv_run', domain: DOMAIN, mode: 'domain_onboarding', status: 'cancelled', provider: 'local_browser_harness' },
    });
    await act(async () => {
      clickButton(container, 'Cancel investigation').click();
    });
    expect(cancelInvestigation).toHaveBeenCalledWith(DOMAIN, 'binv_run');
  });
});

describe('holdout coverage, evidence, and separate actions', () => {
  async function openCompleted(): Promise<{ container: HTMLElement }> {
    vi.mocked(listInvestigations).mockResolvedValue([
      { id: 'binv_1', domain: DOMAIN, mode: 'domain_onboarding', status: 'completed', provider: 'local_browser_harness' },
    ]);
    vi.mocked(fetchInvestigationWorkspace).mockResolvedValue({ workspace: workspaceFixture() });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<InvestigationPanel domain={DOMAIN} suiteUrls={[REP_A, REP_B]} />);
    });
    await act(async () => {
      clickButton(container, 'Open').click();
    });
    return { container };
  }

  it('shows holdout coverage as reserved with evidence-rich results', async () => {
    const { container } = await openCompleted();
    expect(container.textContent).toContain('Reserved (1)');
    expect(container.textContent).toContain('never sent to the investigator');
    expect(container.textContent).toContain('shopify');
    expect(container.textContent).toContain('shopify-default');
    expect(container.textContent).toContain('gtin_exact');
    expect(container.textContent).toContain('unavailable');
    expect(container.textContent).toContain('proposal');
  });

  it('reserved holdouts are disabled for launch and excluded from the launch call', async () => {
    vi.mocked(listInvestigations).mockResolvedValue([
      { id: 'binv_1', domain: DOMAIN, mode: 'domain_onboarding', status: 'completed', provider: 'local_browser_harness' },
    ]);
    vi.mocked(fetchInvestigationWorkspace).mockResolvedValue({
      workspace: workspaceFixture({
        representatives: { confirmed: [REP_A, HOLDOUT], investigated: [REP_A] },
      }),
    });
    vi.mocked(launchInvestigation).mockResolvedValue({
      investigation: { id: 'binv_new', domain: DOMAIN, mode: 'domain_onboarding', status: 'queued', provider: 'local_browser_harness' },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<InvestigationPanel domain={DOMAIN} suiteUrls={[REP_A, HOLDOUT]} />);
    });
    await act(async () => {
      clickButton(container, 'Open').click();
    });
    const holdoutLabel = [...container.querySelectorAll('label')].find((l) =>
      l.textContent?.includes('Reserved holdout'),
    );
    expect(holdoutLabel?.textContent).toContain('holdout-1');
    const holdoutCheckbox = holdoutLabel?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(holdoutCheckbox?.disabled).toBe(true);
    await act(async () => {
      clickButton(container, 'Investigate Domain').click();
    });
    expect(launchInvestigation).toHaveBeenCalledWith(DOMAIN, 'domain_onboarding', [REP_A]);
    expect(vi.mocked(launchInvestigation).mock.calls[0][2]).not.toContain(HOLDOUT);
  });

  it('Validate, Apply to Draft, and Discard render as separate actions', async () => {
    const { container } = await openCompleted();
    expect(container.textContent).toContain('Validate proposal');
    expect(container.textContent).toContain('Apply to Draft');
    expect(container.textContent).toContain('Discard investigation');
    expect(() => clickButton(container, 'Run validation')).not.toThrow();
    expect(() => clickButton(container, 'Apply to Draft')).not.toThrow();
    expect(() => clickButton(container, 'Discard')).not.toThrow();
  });

  it('failed validation still applies as a blocked draft with blockers visible', async () => {
    vi.mocked(listInvestigations).mockResolvedValue([
      { id: 'binv_1', domain: DOMAIN, mode: 'domain_onboarding', status: 'completed', provider: 'local_browser_harness' },
    ]);
    vi.mocked(fetchInvestigationWorkspace).mockResolvedValue({ workspace: workspaceFixture() });
    vi.mocked(applyInvestigationToDraft).mockResolvedValue({
      applied: { appliedVersionId: 'ver_1', blockers: ['holdout_failed:no blind holdout passed', 'validation:failed'] },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<InvestigationPanel domain={DOMAIN} suiteUrls={[REP_A, REP_B]} />);
    });
    await act(async () => {
      clickButton(container, 'Open').click();
    });
    expect(container.textContent).toContain('still applies as a blocked draft');
    expect(container.textContent).toContain('holdout_failed:no blind holdout passed');
    const actorInputs = [...container.querySelectorAll('input[placeholder="Operator name"]')];
    expect(actorInputs.length).toBe(2);
    await act(async () => {
      const input = actorInputs[0] as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'operator-1');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.textContent).toContain('Apply to Draft');
  });

  it('validate posts sample references through the form (never verdicts)', async () => {
    const { container } = await openCompleted();
    vi.mocked(validateInvestigation).mockResolvedValue({ validation: { status: 'failed' } });
    const nameInputs = [...container.querySelectorAll('input[placeholder="Expected product name"]')] as HTMLInputElement[];
    expect(nameInputs.length).toBe(3);
    await act(async () => {
      setTextInput(nameInputs[0], 'Alpha');
      setTextInput(nameInputs[1], 'Beta');
      setTextInput(nameInputs[2], 'Holdout One');
    });
    await act(async () => {
      clickButton(container, 'Run validation').click();
    });
    expect(validateInvestigation).toHaveBeenCalledTimes(1);
    const entries = vi.mocked(validateInvestigation).mock.calls[0][2] as ValidationSampleEntry[];
    expect(entries).toEqual([
      { url: REP_A, role: 'representative', expectedName: 'Alpha' },
      { url: REP_B, role: 'representative', expectedName: 'Beta' },
      { url: HOLDOUT, role: 'holdout', expectedName: 'Holdout One' },
    ]);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(['expectedName', 'role', 'url']);
    }
  });

  it('rejects a reserved holdout as a custom launch URL', async () => {
    vi.mocked(listInvestigations).mockResolvedValue([
      { id: 'binv_1', domain: DOMAIN, mode: 'domain_onboarding', status: 'completed', provider: 'local_browser_harness' },
    ]);
    vi.mocked(fetchInvestigationWorkspace).mockResolvedValue({ workspace: workspaceFixture() });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<InvestigationPanel domain={DOMAIN} suiteUrls={[REP_A]} />);
    });
    await act(async () => {
      clickButton(container, 'Open').click();
    });
    const urlInput = container.querySelector('input[placeholder^="https://"]') as HTMLInputElement;
    await act(async () => {
      setTextInput(urlInput, HOLDOUT);
    });
    await act(async () => {
      clickButton(container, 'Add URL').click();
    });
    expect(container.textContent).toContain('reserved holdout');
    expect(launchInvestigation).not.toHaveBeenCalled();
  });

  it('budget preview sends the pruned candidate set, never reserved holdouts', async () => {
    const { previewInvestigationBudgets } = await import('../../client/investigation-api');
    vi.mocked(listInvestigations).mockResolvedValue([
      { id: 'binv_1', domain: DOMAIN, mode: 'domain_onboarding', status: 'completed', provider: 'local_browser_harness' },
    ]);
    vi.mocked(fetchInvestigationWorkspace).mockResolvedValue({
      workspace: workspaceFixture({
        representatives: { confirmed: [REP_A, HOLDOUT], investigated: [REP_A] },
      }),
    });
    vi.mocked(previewInvestigationBudgets).mockResolvedValue([
      { key: 'maxPages', label: 'Product pages', value: 'up to 5' },
    ]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<InvestigationPanel domain={DOMAIN} suiteUrls={[REP_A, HOLDOUT]} />);
    });
    await act(async () => {
      clickButton(container, 'Open').click();
    });
    await act(async () => {
      clickButton(container, 'Preview budgets').click();
    });
    expect(previewInvestigationBudgets).toHaveBeenCalledWith(DOMAIN, [REP_A]);
  });

  it('validation stays unavailable until every reserved holdout has an expected name', async () => {
    const { container } = await openCompleted();
    const runButton = clickButton(container, 'Run validation');
    expect(runButton.disabled).toBe(true);
    const nameInputs = [...container.querySelectorAll('input[placeholder="Expected product name"]')] as HTMLInputElement[];
    await act(async () => {
      setTextInput(nameInputs[0], 'Alpha');
      setTextInput(nameInputs[1], 'Beta');
    });
    expect(clickButton(container, 'Run validation').disabled).toBe(true);
    await act(async () => {
      setTextInput(nameInputs[2], 'Holdout One');
    });
    expect(clickButton(container, 'Run validation').disabled).toBe(false);
  });

  it('offers no banned affordance anywhere in the investigation view', async () => {
    const { container } = await openCompleted();
    const text = (container.textContent ?? '').toLowerCase();
    expect(text).not.toContain('activate');
    expect(text).not.toContain('release');
  });
});
