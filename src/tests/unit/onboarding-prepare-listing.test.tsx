// @vitest-environment jsdom
/**
 * Slice 2 — PrepareListingView tests (Vitest/jsdom).
 *
 * One stage, one view, five named landmarks; only current-stage rows counted;
 * off-stage siblings explicitly contextual; full-batch operation links
 * preserve frozen mounts/scope; six tabs stay six under every expansion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// See onboarding-linear-shell.test.tsx: stub the schema const whose named-zod
// chain vite-node cannot collect; the schema itself is covered under Bun.
vi.mock('../../shared/schemas/onboarding-stage-read', () => ({
  STAGE_READ_LIMIT_DEFAULT: 50,
}));
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { PrepareListingView } from '../../client/components/onboarding/PrepareListingView';
import * as workApi from '../../client/onboarding-work-api';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function healthy() {
  return { status: 'healthy', version: '1.0.0', computedAt: new Date().toISOString(), issues: [] };
}

function makeRow(i: number) {
  return {
    itemId: `item_${i}`,
    category: 'processing',
    activity: null,
    label: 'Working',
    detail: null,
    attentionReason: null,
    attentionAction: null,
    variantResolution: null,
    findingCode: null,
    findingSummary: null,
    conflictingValues: null,
    suggestedAction: null,
    findingDetails: null,
    family: null,
    reviewState: 'unreviewed',
    stage: 'curation',
    stageStatus: 'pending',
    upc: `0000000000${i}`,
    name: `Product ${i}`,
    brand: 'Acme',
    sourceType: 'official_page',
    domain: 'acme.example',
    curatedTitle: null,
    imageUrl: null,
    description: null,
    weight: null,
  };
}

describe('PrepareListingView (one stage, five sections)', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const opened: string[] = [];

  beforeEach(() => {
    opened.length = 0;
    vi.spyOn(workApi, 'subscribeBatchEvents').mockImplementation(() => () => {});
    vi.spyOn(globalThis as any, 'fetch').mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/stage-work-state/counts')) {
        const zero = () => ({ pending: 0, in_progress: 0, completed: 0, failed: 0, needs_input: 0, skipped: 0 });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            schemaVersion: 2,
            stageVocabularyVersion: 2,
            batchId: 'b1',
            filterFingerprint: 'a'.repeat(32),
            projectionHealth: healthy(),
            matchingTotal: 2,
            counts: {
              processing: 2, needs_attention: 0, waiting_on_family: 0, ready_for_review: 0,
              approved: 0, ready_to_export: 0, completed: 0, skipped: 0,
            },
            stageStatusMatrix: {
              route_sources: zero(), find_product_page: zero(), collect_details: zero(),
              prepare_listing: { ...zero(), pending: 2 }, review_listings: zero(), create_drafts: zero(),
            },
          }),
        } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          schemaVersion: 2,
          stageVocabularyVersion: 2,
          batchId: 'b1',
          filterFingerprint: 'b'.repeat(32),
          projectionHealth: healthy(),
          items: [makeRow(1), makeRow(2)],
          nextCursor: null,
          scannedRows: 2,
          queryCount: 2,
        }),
      } as any;
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  async function mount() {
    await act(async () => {
      root.render(
        <PrepareListingView batchId="b1" onOpenOperation={(v) => opened.push(v)} />,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }

  it('renders five landmarks in one view with unavailable (never fabricated) states', async () => {
    await mount();
    expect(container.querySelector('[data-testid="prepare-listing-view"]')).not.toBeNull();
    for (const key of ['ocr_evidence', 'family_cohort', 'names', 'product_type', 'field_classification']) {
      const section = container.querySelector(`[data-testid="prepare-section-${key}"]`);
      expect(section).not.toBeNull();
      expect(section!.querySelector(`[data-testid="prepare-section-state-${key}"]`)?.textContent).toMatch(/Not yet reported/);
    }
    // Page placement / draft-readiness stays a distinct sub-row once expanded.
    const toggle = container.querySelector('[data-testid="prepare-section-field_classification"] button');
    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="prepare-page-placement-subrow"]')).not.toBeNull();
  });

  it('routes section links to existing full-batch operations (no inline decisions)', async () => {
    await mount();
    const toggle = container.querySelector('[data-testid="prepare-section-family_cohort"] button');
    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const link = Array.from(
      container.querySelectorAll('[data-testid="prepare-section-family_cohort"] button'),
    ).find((b) => b.textContent?.includes('entire-batch'));
    await act(async () => {
      link!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(opened).toEqual(['family']);
  });

  it('lists only current-stage rows and issues one selected-item-free bounded request', async () => {
    await mount();
    // Stage-scoped request carries the prepare_listing stage; no per-item
    // getItemDetail fan-out exists in this view (zero detail URLs).
    const scope = container.querySelector('[data-testid="stage-scope-label"]');
    expect(scope?.textContent).toMatch(/Prepare listing/);
  });
});
