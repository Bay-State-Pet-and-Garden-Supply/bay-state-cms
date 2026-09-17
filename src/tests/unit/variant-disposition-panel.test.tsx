// @vitest-environment jsdom
/**
 * Issue #220 — VariantDispositionPanel unit tests.
 *
 * Board surfacing for the explicit unresolved variant-identity disposition:
 * unmarked variant-bearing blocked items offer a mark action; marked items
 * show the hold state (reason + who/when) with a clear action. Items whose
 * attention reason is unrelated render nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { VariantDispositionPanel } from '../../client/components/onboarding/attention/VariantDispositionPanel';
import * as workApi from '../../client/onboarding-work-api';
import type { OnboardingWorkState } from '../../shared/schemas/onboarding-work-state';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeWorkState(overrides: Partial<OnboardingWorkState> = {}): OnboardingWorkState {
  return {
    itemId: 'item-1',
    category: 'needs_attention',
    activity: null,
    label: 'Manual evidence available',
    detail: 'No extractor profile for example.com — profile required',
    attentionReason: 'manual_evidence_available',
    attentionAction: 'enter_manual_evidence',
    variantResolution: null,
    variantDisposition: null,
    findingCode: null,
    findingSummary: null,
    conflictingValues: null,
    suggestedAction: null,
    findingDetails: null,
    family: null,
    reviewState: 'not_ready',
    stage: 'collect_details',
    stageStatus: 'failed',
    upc: '018214822950',
    name: 'Nylabone Power Chew Groove Bone Dog Chew Toy Small',
    brand: 'Nylabone',
    sourceType: 'official_page',
    domain: 'nylabone.com',
    curatedTitle: null,
    imageUrl: null,
    description: null,
    weight: null,
    ...overrides,
  };
}

describe('VariantDispositionPanel', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('offers a mark action for unmarked variant-bearing blocked items', async () => {
    await act(async () => {
      root.render(<VariantDispositionPanel itemId="item-1" workState={makeWorkState()} />);
    });
    expect(container.textContent).toContain('Mark variant-bearing');
    expect(container.querySelector('input[aria-label="Variant-hold reason"]')).not.toBeNull();
  });

  it('marks through the API and shows the hold state with who/when', async () => {
    const onChanged = vi.fn();
    vi.spyOn(workApi, 'markVariantIdentityUnresolved').mockResolvedValue({
      itemId: 'item-1',
      disposition: {
        itemId: 'item-1',
        disposition: 'unresolved_variant_identity',
        reason: 'Size-specific row on no-matrix family page',
        markedBy: 'catalog_approver:abc',
        createdAt: '2026-09-17T00:00:00.000Z',
        updatedAt: '2026-09-17T00:00:00.000Z',
      },
    });
    await act(async () => {
      root.render(<VariantDispositionPanel itemId="item-1" workState={makeWorkState()} onChanged={onChanged} />);
    });
    const input = container.querySelector('input[aria-label="Variant-hold reason"]') as HTMLInputElement;
    // Controlled input under React needs the native setter so the change
    // tracker fires (direct `input.value =` bypasses React's onChange).
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      nativeSetter?.call(input, 'Size-specific row on no-matrix family page');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    const mark = buttons.find((b) => b.textContent?.includes('Mark variant-bearing')) as HTMLButtonElement;
    expect(mark.disabled).toBe(false);
    await act(async () => {
      mark.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(workApi.markVariantIdentityUnresolved).toHaveBeenCalledWith(
      'item-1',
      'Size-specific row on no-matrix family page',
    );
    expect(container.textContent).toContain('Variant hold: identity unproven');
    expect(container.textContent).toContain('variant_resolution_required');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('shows the recorded hold with reason and clear action when marked', async () => {
    const onChanged = vi.fn();
    vi.spyOn(workApi, 'clearVariantIdentityDisposition').mockResolvedValue({ itemId: 'item-1', disposition: null });
    await act(async () => {
      root.render(
        <VariantDispositionPanel
          itemId="item-1"
          workState={makeWorkState({
            variantDisposition: {
              disposition: 'unresolved_variant_identity',
              reason: 'Size-specific row on no-matrix family page',
              markedBy: 'catalog_approver:abc',
              updatedAt: '2026-09-17T00:00:00.000Z',
            },
          })}
          onChanged={onChanged}
        />,
      );
    });
    expect(container.textContent).toContain('Variant hold: identity unproven');
    expect(container.textContent).toContain('Size-specific row on no-matrix family page');
    expect(container.textContent).toContain('catalog_approver:abc');
    const buttons = Array.from(container.querySelectorAll('button'));
    const clear = buttons.find((b) => b.textContent?.includes('Clear hold')) as HTMLButtonElement;
    await act(async () => {
      clear.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(workApi.clearVariantIdentityDisposition).toHaveBeenCalledWith('item-1');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('renders nothing for unrelated attention reasons when unmarked', async () => {
    await act(async () => {
      root.render(
        <VariantDispositionPanel
          itemId="item-1"
          workState={makeWorkState({ attentionReason: 'brand_not_provided', attentionAction: 'assign_brand' })}
        />,
      );
    });
    expect(container.textContent).toBe('');
  });
});
