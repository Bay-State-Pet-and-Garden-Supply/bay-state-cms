// @vitest-environment jsdom
// story: e10s04 — reviewer media picker in ReviewListingPanel (V2) +
// readiness interplay: a persisted/dirty primary designation clears
// `missing_primary_image` in the advisory readiness derivation.
import { describe, it, expect, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ReviewListingPanel } from '../../client/components/onboarding/review/ReviewListingPanel';
import { deriveReadiness } from '../../client/components/onboarding/review/review-readiness';
import type { OnboardingWorkState } from '../../shared/schemas/onboarding-work-state';
import type { ItemDetailResponse } from '../../client/onboarding-api';

const IMG_A = 'https://images.example/a.jpg';
const IMG_B = 'https://images.example/b.jpg';
const IMG_C = 'https://images.example/c.jpg';

function makeDetail(overrides: Record<string, unknown> = {}): ItemDetailResponse {
  return {
    item: {
      price: '19.99',
      quantity: null,
      sourceType: 'official_page',
      curationData: {},
      extractionData: null,
      ...overrides,
    },
    sources: [],
    extraction: {
      primaryImage: IMG_A,
      additionalImages: [IMG_B, IMG_C],
      ...(overrides.extraction as object | undefined),
    },
    consistencyWarnings: [],
    ...overrides,
  } as unknown as ItemDetailResponse;
}

const baseDraft = {
  curatedTitle: 'T',
  brandHint: '',
  curatedWeight: '',
  curatedDescription: '',
  searchKeywords: '',
  price: '19.99',
  quantity: '1',
};

function makeWorkState() {
  return {
    itemId: 'i1',
    name: 'Item',
    curatedTitle: '',
    imageUrl: null,
    sourceType: 'official_page',
    brand: 'Acme',
  } as unknown as OnboardingWorkState;
}

async function renderPanel(props: Record<string, unknown>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ReviewListingPanel
        workState={makeWorkState()}
        detail={makeDetail()}
        editing={false}
        draft={baseDraft}
        onDraftChange={vi.fn()}
        onSaveEdit={vi.fn().mockResolvedValue(undefined)}
        onCancelEdit={vi.fn()}
        saving={false}
        saveError={null}
        {...props}
      />,
    );
  });
  return {
    container,
    text: () => container.textContent ?? '',
    button: (label: string) =>
      [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label),
    queryButton: (label: string) =>
      [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label) ?? null,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const saveMedia = vi.fn().mockResolvedValue(undefined);

describe('ReviewListingPanel media picker (e10s04, V2)', () => {
  it('hides picker controls when V2 is off (legacy display-only carousel)', async () => {
    const h = await renderPanel({ v2: false, onSaveMedia: saveMedia });
    expect(h.queryButton('Set primary')).toBeNull();
    expect(h.queryButton('Hide')).toBeNull();
    expect(h.queryButton('Save media selection')).toBeNull();
    h.unmount();
  });

  it('renders picker controls when V2 is on and saves an explicit selection payload', async () => {
    const onSaveMedia = vi.fn().mockResolvedValue(undefined);
    const h = await renderPanel({ v2: true, onSaveMedia });

    expect(h.button('Set primary')).toBeTruthy();
    expect(h.button('Save media selection')).toBeTruthy();

    // Designate the second candidate as primary, hide the third.
    const setPrimaryButtons = [...h.container.querySelectorAll('button')].filter(
      b => b.textContent?.trim() === 'Set primary',
    );
    expect(setPrimaryButtons.length).toBe(2);
    await act(async () => {
      setPrimaryButtons[0].click();
    });
    const hideButtons = [...h.container.querySelectorAll('button')].filter(
      b => b.textContent?.trim() === 'Hide',
    );
    await act(async () => {
      hideButtons[hideButtons.length - 1].click();
    });

    // Hidden strip appears; dirty state enables save.
    expect(h.text()).toContain('excluded from promotion');
    const saveBtn = h.button('Save media selection')!;
    expect(saveBtn.disabled).toBe(false);
    await act(async () => {
      saveBtn.click();
    });

    expect(onSaveMedia).toHaveBeenCalledTimes(1);
    const payload = onSaveMedia.mock.calls[0][0];
    expect(payload.primaryImage).toBe(IMG_B);
    expect(payload.orderedAdditional).toEqual([IMG_A]);
    expect(payload.suppressed).toEqual([IMG_C]);
    h.unmount();
  });

  it('keeps the designated primary visible while additionals are hidden', async () => {
    const onSaveMedia = vi.fn().mockResolvedValue(undefined);
    const h = await renderPanel({ v2: true, onSaveMedia });

    // Hide buttons exist ONLY for additional thumbnails — the primary has no
    // self-suppression affordance (it is changed via "Set primary", never
    // silently cleared), so the main image must stay visible.
    const hideAll = () =>
      [...h.container.querySelectorAll('button')].filter(b => b.textContent?.trim() === 'Hide');
    let buttons = hideAll();
    while (buttons.length > 0) {
      await act(async () => {
        buttons[0].click();
      });
      buttons = hideAll();
    }
    expect(h.text()).toContain('Hidden (2)');
    expect(h.queryButton('Set primary')).toBeNull(); // no additionals left to promote
    expect(h.container.querySelector('.rv-listing-media-main img')).toBeTruthy();
    h.unmount();
  });

  it('restore returns a hidden image to the ordered list', async () => {
    const onSaveMedia = vi.fn().mockResolvedValue(undefined);
    const h = await renderPanel({ v2: true, onSaveMedia });

    const hideButtons = [...h.container.querySelectorAll('button')].filter(
      b => b.textContent?.trim() === 'Hide',
    );
    await act(async () => {
      hideButtons[0].click();
    });
    expect(h.text()).toContain('Hidden (1)');
    const restore = h.button('img 1 · Restore');
    expect(restore).toBeTruthy();
    await act(async () => {
      restore!.click();
    });
    expect(h.text()).not.toContain('Hidden (1)');
    h.unmount();
  });

  it('cancel discards unsaved picker edits without calling the endpoint', async () => {
    const onSaveMedia = vi.fn().mockResolvedValue(undefined);
    const h = await renderPanel({ v2: true, onSaveMedia });

    const hideButtons = [...h.container.querySelectorAll('button')].filter(
      b => b.textContent?.trim() === 'Hide',
    );
    await act(async () => {
      hideButtons[0].click();
    });
    const cancel = h.button('Cancel')!;
    await act(async () => {
      cancel.click();
    });
    expect(onSaveMedia).not.toHaveBeenCalled();
    expect(h.text()).not.toContain('Hidden (1)');
    h.unmount();
  });

  it('allows adding a new image URL and saves the updated media selection', async () => {
    const onSaveMedia = vi.fn().mockResolvedValue(undefined);
    const h = await renderPanel({ v2: true, onSaveMedia });

    const input = h.container.querySelector('input[type="url"]') as HTMLInputElement;
    expect(input).toBeTruthy();

    const newUrl = 'https://cdn.example.com/custom-photo.jpg';
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    await act(async () => {
      nativeInputValueSetter.call(input, newUrl);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const addBtn = h.button('Add Image')!;
    expect(addBtn).toBeTruthy();
    await act(async () => {
      addBtn.click();
    });

    // Thumbnail for the new image appears and save is enabled
    const saveBtn = h.button('Save media selection')!;
    expect(saveBtn.disabled).toBe(false);
    await act(async () => {
      saveBtn.click();
    });

    expect(onSaveMedia).toHaveBeenCalledTimes(1);
    const payload = onSaveMedia.mock.calls[0][0];
    expect(payload.primaryImage).toBe(IMG_A);
    expect(payload.orderedAdditional).toContain(newUrl);
    h.unmount();
  });

  it('sets newly added image as primary when listing had no prior images', async () => {
    const onSaveMedia = vi.fn().mockResolvedValue(undefined);
    const detailWithoutImages = makeDetail({
      extraction: { primaryImage: null, additionalImages: [] },
    });
    const h = await renderPanel({ v2: true, detail: detailWithoutImages, onSaveMedia });

    const input = h.container.querySelector('input[type="url"]') as HTMLInputElement;
    const newUrl = 'https://cdn.example.com/first-photo.jpg';
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    await act(async () => {
      nativeInputValueSetter.call(input, newUrl);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const addBtn = h.button('Add Image')!;
    await act(async () => {
      addBtn.click();
    });

    const saveBtn = h.button('Save media selection')!;
    expect(saveBtn.disabled).toBe(false);
    await act(async () => {
      saveBtn.click();
    });

    expect(onSaveMedia).toHaveBeenCalledTimes(1);
    const payload = onSaveMedia.mock.calls[0][0];
    expect(payload.primaryImage).toBe(newUrl);
    expect(payload.orderedAdditional).toEqual([]);
    h.unmount();
  });

  it('shows error when adding an invalid URL', async () => {
    const onSaveMedia = vi.fn().mockResolvedValue(undefined);
    const h = await renderPanel({ v2: true, onSaveMedia });

    const input = h.container.querySelector('input[type="url"]') as HTMLInputElement;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    await act(async () => {
      nativeInputValueSetter.call(input, 'invalid-url-protocol');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const addBtn = h.button('Add Image')!;
    await act(async () => {
      addBtn.click();
    });

    expect(h.text()).toContain('valid URL');
    expect(onSaveMedia).not.toHaveBeenCalled();
    h.unmount();
  });
});

describe('readiness interplay (e10s04): reviewedMedia clears missing_primary_image', () => {
  it('advisory derivation honors curation_data.reviewedMedia.primaryImage', () => {
    // No extraction primary at all — legacy chain would block.
    const detail = makeDetail({
      extractionData: null,
      curationData: {
        reviewedMedia: { primaryImage: IMG_C, orderedAdditional: [IMG_A], suppressed: [] },
      },
    });
    detail.extraction = { title: 'x' } as ItemDetailResponse['extraction'];
    const readiness = deriveReadiness(detail);
    expect(readiness.blockers).not.toContain('missing_primary_image');
  });

  it('advisory derivation still blocks when no designation and no extraction primary exist', () => {
    const detail = makeDetail({ extractionData: null, curationData: {} });
    detail.extraction = { title: 'x' } as ItemDetailResponse['extraction'];
    const readiness = deriveReadiness(detail);
    expect(readiness.blockers).toContain('missing_primary_image');
  });

  it('distributor rows honor suppression of approved images in the advisory check', () => {
    const detail = makeDetail({
      item: {
        price: '10',
        quantity: null,
        sourceType: 'distributor_record',
        curationData: { reviewedMedia: { primaryImage: null, orderedAdditional: [], suppressed: [IMG_A] } },
        extractionData: null,
      },
      extraction: {
        distributorImageApprovals: [{ imageUrl: IMG_A }],
      },
    });
    const readiness = deriveReadiness(detail);
    expect(readiness.blockers).toContain('missing_primary_image');
  });
});

describe('readiness advisory naming warnings (issue #106)', () => {
  it('warns missing_size when the effective name carries no measurement', () => {
    const detail = makeDetail({
      brandHint: 'Acme',
      name: 'Acme Collar',
      curationData: { curatedTitle: 'Acme Collar' },
      extractionData: null,
    });
    detail.extraction = { title: 'Acme Collar' } as ItemDetailResponse['extraction'];
    const readiness = deriveReadiness(detail);
    expect(readiness.warnings).toContain('missing_size');
    expect(readiness.blockers).not.toContain('missing_size');
  });

  it('clears missing_size when the name carries measurement', () => {
    const detail = makeDetail({
      brandHint: 'Acme',
      name: 'Acme Collar 5 LB',
      curationData: { curatedTitle: 'Acme Collar 5 LB' },
      extractionData: null,
    });
    detail.extraction = { title: 'Acme Collar 5 LB' } as ItemDetailResponse['extraction'];
    const readiness = deriveReadiness(detail);
    expect(readiness.warnings).not.toContain('missing_size');
  });
});
