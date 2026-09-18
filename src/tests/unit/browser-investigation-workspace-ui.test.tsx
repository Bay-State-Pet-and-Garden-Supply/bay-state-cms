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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  isTrustedValidationEntry,
  launchCandidatesOf,
  reservedHoldoutsCovered,
  validationExpectationProblems,
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

function trustedEntry(url: string, role: 'representative' | 'holdout', name: string): ValidationSampleEntry {
  return {
    url,
    role,
    expectedName: name,
    expectedProductId: 'gid://shopify/Product/999001',
    expectedGtin: '810001234501',
    expectedSku: '',
    expectedPlatformVariantId: '',
    expectedVariantKey: '',
  };
}

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

  it('validate body carries trusted identity (parent productId + identifier), never verdicts or counts', () => {
    const body = buildValidateBody([
      trustedEntry(REP_A, 'representative', 'Alpha'),
      trustedEntry(HOLDOUT, 'holdout', 'Holdout One'),
    ]);
    expect(body.samples).toEqual([
      {
        url: REP_A,
        role: 'representative',
        expected: { name: 'Alpha', productId: 'gid://shopify/Product/999001', gtin: '810001234501' },
      },
      {
        url: HOLDOUT,
        role: 'holdout',
        expected: { name: 'Holdout One', productId: 'gid://shopify/Product/999001', gtin: '810001234501' },
      },
    ]);
    expect(body).not.toHaveProperty('status');
    expect(body).not.toHaveProperty('validationStatus');
    expect(body).not.toHaveProperty('holdouts');
    expect(body).not.toHaveProperty('holdoutPassedCount');
    expect(JSON.stringify(body)).not.toContain('passed');
  });

  it('validate body names the missing trusted field instead of sending a name-only sample', () => {
    const nameOnly: ValidationSampleEntry = {
      url: REP_A,
      role: 'representative',
      expectedName: 'Alpha',
      expectedProductId: '',
      expectedGtin: '',
      expectedSku: '',
      expectedPlatformVariantId: '',
      expectedVariantKey: '',
    };
    expect(validationExpectationProblems(nameOnly).join('; ')).toContain('parent productId');
    expect(validationExpectationProblems(nameOnly).join('; ')).toContain('trusted identifier');
    expect(isTrustedValidationEntry(nameOnly)).toBe(false);
    expect(() => buildValidateBody([nameOnly])).toThrow(/parent productId|trusted identifier/);
    const noIdentifier: ValidationSampleEntry = { ...trustedEntry(REP_A, 'representative', 'Alpha'), expectedGtin: '' };
    expect(() => buildValidateBody([noIdentifier])).toThrow(/trusted identifier/);
    const noProduct: ValidationSampleEntry = { ...trustedEntry(REP_A, 'representative', 'Alpha'), expectedProductId: '  ' };
    expect(() => buildValidateBody([noProduct])).toThrow(/parent productId/);
  });

  it('launch candidates exclude reserved holdouts; coverage requires every reserved holdout', () => {
    expect(launchCandidatesOf([REP_A, HOLDOUT], [HOLDOUT])).toEqual([REP_A]);
    expect(launchCandidatesOf([REP_A, `${HOLDOUT}/`], [HOLDOUT])).toEqual([REP_A]);
    expect(isReservedUrl(`${HOLDOUT}/`, [HOLDOUT])).toBe(true);
    expect(isReservedUrl(REP_A, [HOLDOUT])).toBe(false);
    expect(
      reservedHoldoutsCovered([trustedEntry(HOLDOUT, 'holdout', 'H')], [HOLDOUT]),
    ).toBe(true);
    expect(
      reservedHoldoutsCovered([trustedEntry(REP_A, 'representative', 'A')], [HOLDOUT]),
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

  it('validate posts trusted identity through the form (never verdicts)', async () => {
    const { container } = await openCompleted();
    vi.mocked(validateInvestigation).mockResolvedValue({ validation: { status: 'failed' } });
    const nameInputs = [...container.querySelectorAll('input[placeholder="Expected product name"]')] as HTMLInputElement[];
    const productInputs = [...container.querySelectorAll('input[placeholder="Parent product ID"]')] as HTMLInputElement[];
    const gtinInputs = [...container.querySelectorAll('input[placeholder="GTIN"]')] as HTMLInputElement[];
    expect(nameInputs.length).toBe(3);
    expect(productInputs.length).toBe(3);
    expect(gtinInputs.length).toBe(3);
    await act(async () => {
      setTextInput(nameInputs[0], 'Alpha');
      setTextInput(nameInputs[1], 'Beta');
      setTextInput(nameInputs[2], 'Holdout One');
      for (const input of productInputs) setTextInput(input, 'gid://shopify/Product/999001');
      for (const input of gtinInputs) setTextInput(input, '810001234501');
    });
    await act(async () => {
      clickButton(container, 'Run validation').click();
    });
    expect(validateInvestigation).toHaveBeenCalledTimes(1);
    const entries = vi.mocked(validateInvestigation).mock.calls[0][2] as ValidationSampleEntry[];
    expect(entries).toEqual([
      { url: REP_A, role: 'representative', expectedName: 'Alpha', expectedProductId: 'gid://shopify/Product/999001', expectedGtin: '810001234501', expectedSku: '', expectedPlatformVariantId: '', expectedVariantKey: '' },
      { url: REP_B, role: 'representative', expectedName: 'Beta', expectedProductId: 'gid://shopify/Product/999001', expectedGtin: '810001234501', expectedSku: '', expectedPlatformVariantId: '', expectedVariantKey: '' },
      { url: HOLDOUT, role: 'holdout', expectedName: 'Holdout One', expectedProductId: 'gid://shopify/Product/999001', expectedGtin: '810001234501', expectedSku: '', expectedPlatformVariantId: '', expectedVariantKey: '' },
    ]);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual([
        'expectedGtin',
        'expectedName',
        'expectedPlatformVariantId',
        'expectedProductId',
        'expectedSku',
        'expectedVariantKey',
        'role',
        'url',
      ]);
      expect(isTrustedValidationEntry(entry)).toBe(true);
    }
    // The wire body carries expectations/references only — never verdicts or counts.
    const wire = buildValidateBody(entries);
    expect(wire.samples[0].expected).toMatchObject({ name: 'Alpha', productId: 'gid://shopify/Product/999001', gtin: '810001234501' });
    expect(wire).not.toHaveProperty('status');
    expect(wire).not.toHaveProperty('holdouts');
  });

  it('a name-only sample names the missing field inline and never submits', async () => {
    const { container } = await openCompleted();
    vi.mocked(validateInvestigation).mockClear();
    const nameInputs = [...container.querySelectorAll('input[placeholder="Expected product name"]')] as HTMLInputElement[];
    await act(async () => {
      setTextInput(nameInputs[0], 'Alpha');
      setTextInput(nameInputs[1], 'Beta');
      setTextInput(nameInputs[2], 'Holdout One');
    });
    expect(container.textContent).toContain('parent productId');
    expect(container.textContent).toContain('trusted identifier');
    expect(clickButton(container, 'Run validation').disabled).toBe(true);
    expect(validateInvestigation).not.toHaveBeenCalled();
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

  it('validation stays unavailable until every sample carries its trusted identity', async () => {
    const { container } = await openCompleted();
    const runButton = clickButton(container, 'Run validation');
    expect(runButton.disabled).toBe(true);
    const nameInputs = [...container.querySelectorAll('input[placeholder="Expected product name"]')] as HTMLInputElement[];
    const productInputs = [...container.querySelectorAll('input[placeholder="Parent product ID"]')] as HTMLInputElement[];
    const gtinInputs = [...container.querySelectorAll('input[placeholder="GTIN"]')] as HTMLInputElement[];
    await act(async () => {
      setTextInput(nameInputs[0], 'Alpha');
      setTextInput(nameInputs[1], 'Beta');
      setTextInput(nameInputs[2], 'Holdout One');
    });
    // Names alone never unblock: the missing productId/identifier is named inline.
    expect(clickButton(container, 'Run validation').disabled).toBe(true);
    expect(container.textContent).toContain('parent productId');
    await act(async () => {
      for (const input of productInputs) setTextInput(input, 'gid://shopify/Product/999001');
    });
    // Product ID alone still blocks: a trusted identifier is required.
    expect(clickButton(container, 'Run validation').disabled).toBe(true);
    expect(container.textContent).toContain('trusted identifier');
    await act(async () => {
      for (const input of gtinInputs) setTextInput(input, '810001234501');
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

describe('#245 live watch and cancel for running investigations', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function queuedWorkspace(id: string): InvestigationWorkspaceView {
    return workspaceFixture({
      investigation: { id, domain: DOMAIN, mode: 'domain_onboarding', status: 'queued', provider: 'local_browser_harness' },
      proposal: { available: false, reason: 'investigation is queued; no proposal to preview' },
      validation: null,
      actions: {
        validate: { allowed: false, reason: 'only completed investigations can be validated (is queued)' },
        apply: { allowed: false, reason: 'only completed investigations can be applied (is queued)' },
        discard: { allowed: false, reason: 'only terminal investigations can be discarded (is queued)' },
      },
    });
  }

  function runningWorkspace(id: string): InvestigationWorkspaceView {
    return workspaceFixture({
      investigation: { id, domain: DOMAIN, mode: 'domain_onboarding', status: 'running', provider: 'local_browser_harness' },
      proposal: { available: false, reason: 'investigation is running; no proposal to preview' },
      validation: null,
      actions: {
        validate: { allowed: false, reason: 'only completed investigations can be validated (is running)' },
        apply: { allowed: false, reason: 'only completed investigations can be applied (is running)' },
        discard: { allowed: false, reason: 'only terminal investigations can be discarded (is running)' },
      },
    });
  }

  function cancelledWorkspace(id: string): InvestigationWorkspaceView {
    return workspaceFixture({
      investigation: { id, domain: DOMAIN, mode: 'domain_onboarding', status: 'cancelled', provider: 'local_browser_harness' },
      proposal: { available: false, reason: 'investigation is cancelled; no proposal to preview' },
      validation: null,
      actions: {
        validate: { allowed: false, reason: 'only completed investigations can be validated (is cancelled)' },
        apply: { allowed: false, reason: 'only completed investigations can be applied (is cancelled)' },
        discard: { allowed: true, reason: 'terminal investigations can be discarded; active versions, health, and items stay untouched' },
      },
    });
  }

  it('launch selects the queued investigation immediately with cancel available', async () => {
    vi.mocked(listInvestigations).mockResolvedValue([]);
    vi.mocked(launchInvestigation).mockResolvedValue({
      investigation: { id: 'binv_new', domain: DOMAIN, mode: 'domain_onboarding', status: 'queued', provider: 'local_browser_harness' },
    });
    vi.mocked(fetchInvestigationWorkspace).mockResolvedValue({ workspace: queuedWorkspace('binv_new') });
    const { container } = await renderPanel();
    await act(async () => {
      clickButton(container, 'Investigate Domain').click();
    });
    // The returned queued id is selected immediately: detail shows the
    // queued state before the run finishes, with cancel offered.
    expect(container.textContent).toContain('binv_new');
    expect(container.textContent).toContain('queued');
    expect(container.textContent).toContain('Cancel investigation');
  });

  it('status progresses queued -> running -> terminal via polling without a manual refresh', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(listInvestigations).mockResolvedValue([
        { id: 'binv_poll', domain: DOMAIN, mode: 'domain_onboarding', status: 'queued', provider: 'local_browser_harness' },
      ]);
      vi.mocked(fetchInvestigationWorkspace)
        .mockResolvedValueOnce({ workspace: queuedWorkspace('binv_poll') })
        .mockResolvedValueOnce({ workspace: runningWorkspace('binv_poll') })
        .mockResolvedValue({ workspace: workspaceFixture() });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(<InvestigationPanel domain={DOMAIN} suiteUrls={[REP_A]} />);
      });
      await act(async () => {
        clickButton(container, 'Open').click();
      });
      expect(container.textContent).toContain('queued');
      const callsAfterOpen = vi.mocked(fetchInvestigationWorkspace).mock.calls.length;
      // First poll tick moves queued -> running without any manual refresh.
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      await act(async () => {});
      expect(vi.mocked(fetchInvestigationWorkspace).mock.calls.length).toBeGreaterThan(callsAfterOpen);
      expect(container.textContent).toContain('running');
      // Second poll tick reaches the terminal completed state.
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      await act(async () => {});
      expect(container.textContent).toContain('completed');
      expect(container.textContent).toContain('binv_poll');
      await act(async () => {
        root.unmount();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel while running reflects cancelled and hides validate/apply', async () => {
    vi.mocked(listInvestigations).mockResolvedValue([
      { id: 'binv_run', domain: DOMAIN, mode: 'domain_onboarding', status: 'running', provider: 'local_browser_harness' },
    ]);
    vi.mocked(fetchInvestigationWorkspace).mockResolvedValue({ workspace: runningWorkspace('binv_run') });
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
    vi.mocked(fetchInvestigationWorkspace).mockResolvedValue({ workspace: cancelledWorkspace('binv_run') });
    await act(async () => {
      clickButton(container, 'Cancel investigation').click();
    });
    expect(cancelInvestigation).toHaveBeenCalledWith(DOMAIN, 'binv_run');
    expect(container.textContent).toContain('cancelled');
    // Cancel affordance is gone once terminal; validate/apply are not offered.
    expect(container.textContent).not.toContain('Cancel investigation');
    expect(container.textContent).not.toContain('Run validation');
    expect(container.textContent).not.toContain('Apply to Draft');
    expect(container.textContent).toContain('Discard investigation');
    const text = (container.textContent ?? '').toLowerCase();
    expect(text).not.toContain('activate');
    expect(text).not.toContain('release');
  });
});
