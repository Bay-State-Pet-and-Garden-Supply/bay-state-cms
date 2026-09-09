// @vitest-environment jsdom
// issue #109 — Review drawer filename preview + duplicate warnings
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import type { ReactNode } from 'react';
import { ReviewIdentityPanel } from '../../client/components/onboarding/review/ReviewIdentityPanel';
import { ReviewWarningsPanel } from '../../client/components/onboarding/review/ReviewWarningsPanel';
import { ReviewActions } from '../../client/components/onboarding/review/ReviewActions';

async function renderEl(node: ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return {
    container,
    text: () => container.textContent ?? '',
    query: (sel: string) => container.querySelector(sel),
    queryAll: (sel: string) => [...container.querySelectorAll<HTMLButtonElement>(sel)],
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const workState = { itemId: 'item-1', upc: 'UPC-1', displayTitle: 'Test Product' } as any;

const batchWarning = {
  code: 'filename_collision_batch',
  message: '"shared-name.html" is also the file name of UPC-2 ("Other Product"). Promotion will save this draft as "shared-name-2.html" — accept the suffixed names, retitle, or defer.',
  fileName: 'shared-name.html',
  conflictingUpcs: ['UPC-2'],
  conflictingTitles: ['Other Product'],
  catalogSku: null,
  catalogTitle: null,
};

const catalogWarning = {
  code: 'filename_collision_catalog',
  message: '"live-name.html" is already the file name of live catalog product SKU-9 ("Live Product"). Retitle this draft or defer — a catalog collision cannot be accepted.',
  fileName: 'live-name.html',
  conflictingUpcs: [],
  conflictingTitles: [],
  catalogSku: 'SKU-9',
  catalogTitle: 'Live Product',
};

describe('Review drawer filename preview (issue #109)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('identity panel renders the computed file name row', async () => {
    const r = await renderEl(
      <ReviewIdentityPanel workState={workState} detail={null} fileName="shared-name-2.html" />,
    );
    expect(r.text()).toContain('More-info file name');
    expect(r.text()).toContain('shared-name-2.html');
    r.unmount();
  });

  it('identity panel omits the row when no preview is loaded', async () => {
    const r = await renderEl(<ReviewIdentityPanel workState={workState} detail={null} />);
    expect(r.text()).not.toContain('More-info file name');
    r.unmount();
  });

  it('warnings panel names conflicting drafts for batch collisions', async () => {
    const r = await renderEl(<ReviewWarningsPanel detail={null} filenameWarnings={[batchWarning]} />);
    const text = r.text();
    expect(text).toContain('More-info file name needs a decision');
    expect(text).toContain('shared-name.html');
    expect(text).toContain('UPC-2');
    expect(text).toContain('Other Product');
    r.unmount();
  });

  it('warnings panel identifies the catalog product for catalog collisions', async () => {
    const r = await renderEl(<ReviewWarningsPanel detail={null} filenameWarnings={[catalogWarning]} />);
    const text = r.text();
    expect(text).toContain('SKU-9');
    expect(text).toContain('Live Product');
    r.unmount();
  });

  it('warned approval requires a decision: Looks-Good disabled, accept + defer offered', async () => {
    const onAccept = vi.fn();
    const onDefer = vi.fn();
    const r = await renderEl(
      <ReviewActions
        workState={workState}
        detail={null}
        busy={false}
        editing={false}
        allReviewed={false}
        filenameWarned
        filenameAcceptable
        onAcceptFilename={onAccept}
        onDeferFilename={onDefer}
        onLooksGood={vi.fn()}
        onPrevious={vi.fn()}
        onNext={vi.fn()}
      />,
    );
    const buttons = r.queryAll('button');
    const looksGood = buttons.find(b => b.textContent === 'Looks Good & Next');
    expect(looksGood?.disabled).toBe(true);
    expect(r.text()).toContain('Filename warning needs an explicit decision');
    await act(async () => {
      r.queryAll('button').find(b => b.textContent === 'Accept filename & approve')?.click();
    });
    expect(onAccept).toHaveBeenCalledTimes(1);
    await act(async () => {
      r.queryAll('button').find(b => b.textContent === 'Defer')?.click();
    });
    expect(onDefer).toHaveBeenCalledTimes(1);
    r.unmount();
  });

  it('catalog collisions never offer accept, only defer', async () => {
    const r = await renderEl(
      <ReviewActions
        workState={workState}
        detail={null}
        busy={false}
        editing={false}
        allReviewed={false}
        filenameWarned
        filenameAcceptable={false}
        onAcceptFilename={vi.fn()}
        onDeferFilename={vi.fn()}
        onLooksGood={vi.fn()}
        onPrevious={vi.fn()}
        onNext={vi.fn()}
      />,
    );
    const labels = r.queryAll('button').map(b => b.textContent);
    expect(labels).not.toContain('Accept filename & approve');
    expect(labels).toContain('Defer');
    expect(r.text()).toContain('not available for catalog collisions');
    r.unmount();
  });

  it('clean items keep plain Looks-Good with no decision buttons', async () => {
    const onLooksGood = vi.fn();
    const r = await renderEl(
      <ReviewActions
        workState={workState}
        detail={null}
        busy={false}
        editing={false}
        allReviewed={false}
        onLooksGood={onLooksGood}
        onPrevious={vi.fn()}
        onNext={vi.fn()}
      />,
    );
    const looksGood = r.queryAll('button').find(b => b.textContent === 'Looks Good & Next');
    expect(looksGood?.disabled).toBe(false);
    await act(async () => {
      looksGood?.click();
    });
    expect(onLooksGood).toHaveBeenCalledTimes(1);
    expect(r.text()).not.toContain('Filename warning needs an explicit decision');
    r.unmount();
  });
});
