// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../client/onboarding-api', () => ({
  getBatch: vi.fn(), getPreparationGap: vi.fn(), submitGapCorrection: vi.fn(), generateGapIdempotencyKey: () => 'fixture-key',
  OnboardingApiError: class extends Error { code?: string; },
}));
vi.mock('../../client/onboarding-stage-api', () => ({ getStageReadCounts: vi.fn() }));
vi.mock('../../client/onboarding-work-api', () => ({ subscribeBatchEvents: vi.fn(() => () => {}) }));
vi.mock('../../client/components/onboarding/PrepareListingView', () => ({
  PrepareListingView: () => <GapCorrectionPanel itemId="p1" itemName="Fixture product" />,
}));
import { getBatch, getPreparationGap, submitGapCorrection, OnboardingApiError } from '../../client/onboarding-api';
import { getStageReadCounts } from '../../client/onboarding-stage-api';
import { GapCorrectionPanel } from '../../client/components/onboarding/GapCorrectionPanel';
import { BatchWorkspace } from '../../client/components/onboarding/BatchWorkspace';
import { overrideOnboardingFeatureFlags, resetOnboardingFeatureFlags } from '../../client/onboarding-feature-flags';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const gap = { status: 'open', missingFields: ['description'], reason: 'Missing description', evidenceHash: 'hash',
  updatedAt: 'now', correctionRevision: 0, correctionEnvelope: null };
beforeEach(() => {
  vi.resetAllMocks();
  overrideOnboardingFeatureFlags({ shellV2Enabled: true, executionStripV2Enabled: false });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.mocked(getPreparationGap).mockResolvedValue({ gap } as never);
  vi.mocked(getBatch).mockResolvedValue({ batch: { id: 'b1', workspaceId: 'w1', executionState: 'idle' } } as never);
  const zero = { pending: 0, in_progress: 0, completed: 0, failed: 0, needs_input: 0, skipped: 0 };
  vi.mocked(getStageReadCounts).mockResolvedValue({ stageStatusMatrix: Object.fromEntries(
    ['route_sources', 'find_product_page', 'collect_details', 'prepare_listing', 'review_listings', 'create_drafts'].map(stage => [stage, zero])),
  counts: { needs_attention: 0 }, projectionHealth: { status: 'healthy' } } as never);
  window.history.replaceState(null, '', '/?view=onboarding&batch=b1&stage=prepare_listing&stageVersion=2');
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); resetOnboardingFeatureFlags(); window.history.replaceState(null, '', '/'); });
async function edit() {
  await act(async () => {
    const input = host.querySelector<HTMLTextAreaElement>('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Pending operator correction');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('protects pending corrections when leaving the batch or opening Settings', async () => {
  const back = vi.fn(), settings = vi.fn();
  await act(async () => { root.render(<BatchWorkspace batchId="b1" workspaceId="w1" batchName="Fixture" onBack={back} onOpenSettings={settings} />); });
  await edit();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Back to batches"]')!.click(); });
  await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === 'Settings')!.click(); });
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(back).not.toHaveBeenCalled(); expect(settings).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Pending operator correction');
  confirm.mockReturnValue(true);
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Back to batches"]')!.click(); });
  expect(back).toHaveBeenCalledOnce();
});

it('clears edit protection only after correction submission is confirmed', async () => {
  const dirty = vi.fn();
  vi.mocked(submitGapCorrection).mockResolvedValue({ gap, replay: false } as never);
  await act(async () => { root.render(<GapCorrectionPanel itemId="p1" itemName="Fixture product" onDirtyChange={dirty} />); });
  await edit();
  expect(host.querySelector('[data-onboarding-dirty="true"]')).not.toBeNull();
  const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(dirty).toHaveBeenLastCalledWith(false);
  expect(host.querySelector('[data-onboarding-dirty="true"]')).toBeNull();
});

it('retains a stale submitted correction until the operator explicitly accepts reloading', async () => {
  const stale = new OnboardingApiError('Changed request', 409, 'stale_gap'); Object.assign(stale, { code: 'stale_gap' });
  vi.mocked(submitGapCorrection).mockRejectedValue(stale);
  await act(async () => { root.render(<GapCorrectionPanel itemId="p1" itemName="Fixture product" />); });
  await edit();
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Pending operator correction');
  expect(host.textContent).toContain('Your correction is kept');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === 'Reload latest request')!.click(); });
  expect(getPreparationGap).toHaveBeenCalledTimes(1);
  expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Pending operator correction');
  confirm.mockReturnValue(true);
  await act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === 'Reload latest request')!.click(); });
  expect(getPreparationGap).toHaveBeenCalledTimes(2);
  expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('');
});
