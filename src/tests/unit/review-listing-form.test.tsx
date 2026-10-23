// @vitest-environment jsdom
// story: e10s02 — ReviewListingPanel full-field form rendering per source type
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ReviewListingPanel } from '../../client/components/onboarding/review/ReviewListingPanel';
import type { ReviewDraft } from '../../client/components/onboarding/review/review-types';

function makeDetail(overrides: Record<string, unknown> = {}) {
  return {
    item: {
      price: ' $24.99 ',
      quantity: null,
      sourceType: 'official_page',
      curationData: {},
      extractionData: null,
      ...overrides,
    },
    sources: [],
    extraction: {
      title: 'Extraction Title',
      bulletPoints: ['High protein'],
      customFields: {},
      primaryImage: 'https://img.example/a.jpg',
      additionalImages: [],
      ...(overrides.extraction as object | undefined),
    },
    consistencyWarnings: [],
    ...overrides,
  } as any;
}

const baseDraft = (): ReviewDraft => ({
  curatedTitle: 'T',
  brandHint: '',
  curatedWeight: '',
  curatedDescription: '',
  quantity: '4',
  searchKeywords: '',
});

async function renderPanel(props: Record<string, unknown>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ReviewListingPanel
        detail={makeDetail()}
        editing
        draft={baseDraft()}
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
    input: (id: string) => container.querySelector<HTMLInputElement>(`#${id}`),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ReviewListingPanel V2 form // e10s02', () => {
  it('shows the onboarding price unchanged and read-only', async () => {
    const r = await renderPanel({ detail: makeDetail(), v2: true });
    const price = r.container.querySelector('#rv-edit-price');
    expect(price?.tagName).toBe('DIV');
    expect(price?.textContent).toBe(' $24.99 ');
    expect(r.input('rv-edit-price')?.getAttribute('aria-readonly')).toBe('true');
    expect(r.input('rv-edit-quantity')?.disabled).toBe(false);
    r.unmount();
  });

  it('shows the immutable price for distributor records while quantity stays read-only', async () => {
    const r = await renderPanel({
      detail: makeDetail({ sourceType: 'distributor_record' }),
      v2: true,
    });
    expect(r.container.querySelector('#rv-edit-price')?.textContent).toBe(' $24.99 ');
    expect(r.input('rv-edit-price')?.getAttribute('aria-readonly')).toBe('true');
    expect(r.input('rv-edit-quantity')?.disabled).toBe(true);
    expect(r.text()).toContain('manage inventory upstream');
    r.unmount();
  });

  it('distributor_record: quantity readonly with note', async () => {
    const r = await renderPanel({
      detail: makeDetail({ sourceType: 'distributor_record' }),
      v2: true,
    });
    expect(r.input('rv-edit-quantity')?.disabled).toBe(true);
    expect(r.text()).toContain('manage inventory upstream');
    r.unmount();
  });

  it('weight input carries the lbs unit label under V2', async () => {
    const r = await renderPanel({ detail: makeDetail(), v2: true });
    const label = r.container.querySelector('label[for="rv-edit-weight"]');
    expect(label?.textContent).toContain('(lbs)');
    r.unmount();
  });

  it('blocked fields carry aria-invalid + aria-describedby → readiness message nodes (SC 3.3.1/3.3.3)', async () => {
    const r = await renderPanel({
      detail: makeDetail(),
      v2: true,
      blockedCodesByField: {
        'rv-edit-title': ['missing_name'],
        'rv-edit-price': ['missing_price'],
      },
    });
    const title = r.input('rv-edit-title');
    expect(title?.getAttribute('aria-invalid')).toBe('true');
    expect(title?.getAttribute('aria-describedby')).toBe('rv-gate-msg-missing_name');
    expect(r.input('rv-edit-price')?.getAttribute('aria-invalid')).toBe('true');
    // unblocked inputs stay clean
    expect(r.input('rv-edit-brand')?.getAttribute('aria-invalid')).toBeNull();
    expect(r.input('rv-edit-brand')?.getAttribute('aria-describedby')).toBeNull();
    r.unmount();
  });

  it('V1 (flag off): no price/quantity inputs, unchanged tree', async () => {
    const r = await renderPanel({ detail: makeDetail(), editing: false, v2: false });
    expect(r.input('rv-edit-price')).toBeNull();
    expect(r.input('rv-edit-quantity')).toBeNull();
    expect(r.container.querySelector('.rv-listing-facts')).toBeNull();
    // legacy RO sections still present
    expect(r.text()).toContain('Specs / highlights');
    r.unmount();
  });

  it('unknown passthrough extraction keys never crash or invent editors', async () => {
    const detail = makeDetail();
    (detail.item as Record<string, unknown>).mysteryKey = { nested: true };
    detail.extraction.mysteryScalar = 'weird';
    detail.extraction.dimensions = '10 in';
    const r = await renderPanel({ detail, v2: true });
    // known fact renders; unknown keys are ignored silently
    expect(r.container.querySelector('#rv-listing-media')).not.toBeNull();
    r.unmount();
  });

  it('RO mode under V2 shows provenance badges and Listing facts group', async () => {
    const detail = makeDetail({
      curationData: {
        titleSource: 'ocr',
        curationMethod: 'manual',
        packagingOcrTitle: 'ATLAS 15LB',
      },
    });
    detail.extraction.manufacturerPartNumber = 'MPN-1';
    const r = await renderPanel({ detail, editing: false, v2: true });
    expect(r.text()).toContain('Title source: ocr');
    expect(r.text()).toContain('Curation: manual');
    expect(r.text()).toContain('OCR title: ATLAS 15LB');
    const facts = r.container.querySelector<HTMLDivElement>('.rv-listing-facts');
    expect(facts).not.toBeNull();
    // collapsible: closed by default so facts stay out of the scan path
    act(() => {
      facts!.querySelector('summary')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(r.text()).toContain('MPN-1');
    r.unmount();
  });

  it('media region carries the jump-to-fix anchor id under V2', async () => {
    const r = await renderPanel({ detail: makeDetail(), editing: false, v2: true });
    expect(document.getElementById('rv-listing-media')).not.toBeNull();
    r.unmount();
  });
});

describe('always-editable save bar // post-critique UX pass', () => {
  it('hides Save/Cancel when showSaveActions is false (clean draft under V2)', async () => {
    const p = await renderPanel({ v2: true, showSaveActions: false });
    expect(p.text()).not.toContain('Save edits');
    expect(p.text()).not.toContain('Cancel');
    // Fields remain live inputs — always-editable contract.
    expect(p.input('rv-edit-keywords')).toBeTruthy();
    p.unmount();
  });

  it('shows Save/Cancel when dirty (showSaveActions true, the default)', async () => {
    const p = await renderPanel({ v2: true });
    expect(p.text()).toContain('Save edits');
    expect(p.text()).toContain('Cancel');
    p.unmount();
  });
});
