// @vitest-environment jsdom
/**
 * Slice 2 — linear shell MOUNT tests (council plan §3 composition).
 *
 * Mounts BatchWorkspace for the mandatory edges: six tabs/order/server
 * badges, scope labels, outcome separation, legacy destinations,
 * unsupported-link state, and fallback edges. The full 650-case §7.1 ledger
 * lives in onboarding-shell-matrix.test.ts (pure, runnable now); these
 * mounts additionally require the vite-node/zod toolchain repair (see the
 * packet) because the frozen Review/attention chain cannot be collected
 * until named-zod evaluation works under Vitest again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Toolchain note (pre-existing vite-node/zod breakage, also failing the
// untouched review-workspace suites on this tree): modules that evaluate a
// named `import { z } from 'zod'` chain (frozen Review/attention views via
// shared/schemas/classification, the v2 stage-read schema) cannot be
// collected under Vitest. These composition tests stub the FROZEN operation
// views and the schema const so the NEW shell code stays under test; the
// frozen implementations themselves are protected by the regression suites
// once the toolchain is repaired (documented as a baseline failure).
vi.mock('@/shared/schemas/onboarding-stage-read', () => ({
  STAGE_READ_LIMIT_DEFAULT: 50,
}));
vi.mock('@/client/components/onboarding/attention/AttentionQueueView', () => ({
  AttentionQueueView: () => null,
}));
vi.mock('@/client/components/onboarding/attention/OfficialSiteResolutionWorkspace', () => ({
  OfficialSiteResolutionWorkspace: () => null,
}));
vi.mock('@/client/components/onboarding/processing/ProcessingView', () => ({
  ProcessingView: () => null,
}));
vi.mock('@/client/components/onboarding/families/FamilyWaitingView', () => ({
  FamilyWaitingView: () => null,
}));
vi.mock('@/client/components/onboarding/review/ReviewWorkspace', () => ({
  ReviewWorkspace: () => null,
}));
vi.mock('@/client/components/onboarding/approved/ApprovedView', () => ({
  ApprovedView: () => null,
}));
vi.mock('@/client/components/onboarding/approved/ReadyToExportView', () => ({
  ReadyToExportView: () => null,
}));
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { LINEAR_STAGES } from '../../client/components/onboarding/linear-workspace-logic';
import { BatchWorkspace } from '../../client/components/onboarding/BatchWorkspace';
import {
  overrideOnboardingFeatureFlags,
  resetOnboardingFeatureFlags,
} from '../../client/onboarding-feature-flags';
import * as workApi from '../../client/onboarding-work-api';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Mount tests ───────────────────────────────────────────────────────────────

function makeRow(i: number, overrides: Record<string, unknown> = {}) {
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
    stage: 'sourcing',
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
    ...overrides,
  };
}

function countsPayload(matrixOverrides: Record<string, Record<string, number>> = {}) {
  const zero = () => ({ pending: 0, in_progress: 0, completed: 0, failed: 0, needs_input: 0, skipped: 0 });
  const stageStatusMatrix: Record<string, Record<string, number>> = {
    route_sources: { ...zero(), pending: 7 },
    find_product_page: zero(),
    collect_details: zero(),
    prepare_listing: zero(),
    review_listings: { ...zero(), pending: 3 },
    create_drafts: zero(),
    ...matrixOverrides,
  };
  return {
    schemaVersion: 2,
    stageVocabularyVersion: 2,
    batchId: 'b1',
    filterFingerprint: 'a'.repeat(32),
    projectionHealth: { status: 'healthy', version: '1.0.0', computedAt: new Date().toISOString(), issues: [] },
    matchingTotal: 10,
    counts: {
      processing: 7, needs_attention: 0, waiting_on_family: 0, ready_for_review: 3,
      approved: 0, ready_to_export: 0, completed: 0, skipped: 0,
    },
    stageStatusMatrix,
  };
}

function itemsPayload(rows: unknown[]) {
  return {
    schemaVersion: 2,
    stageVocabularyVersion: 2,
    batchId: 'b1',
    filterFingerprint: 'b'.repeat(32),
    projectionHealth: { status: 'healthy', version: '1.0.0', computedAt: new Date().toISOString(), issues: [] },
    items: rows,
    nextCursor: null,
    scannedRows: rows.length,
    queryCount: 3,
  };
}

describe('linear shell mounts (BatchWorkspace, shellV2 ON)', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const seenUrls: string[] = [];

  function installFetch(itemsForStage: (url: string) => unknown[]) {
    seenUrls.length = 0;
    vi.spyOn(globalThis as any, 'fetch').mockImplementation(async (url: unknown) => {
      const u = String(url);
      seenUrls.push(u);
      if (u.includes('/stage-work-state/counts')) {
        return { ok: true, status: 200, json: async () => countsPayload() } as any;
      }
      if (u.includes('/stage-work-state/items')) {
        return { ok: true, status: 200, json: async () => itemsPayload(itemsForStage(u)) } as any;
      }
      return { ok: true, status: 200, json: async () => ({}) } as any;
    });
  }

  function setUrl(search: string) {
    window.history.replaceState(null, '', `/${search}`);
  }

  async function mount() {
    await act(async () => {
      root.render(
        <BatchWorkspace batchId="b1" batchName="Batch One" onBack={() => {}} />,
      );
    });
    // Flush pending fetch promises.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }

  beforeEach(() => {
    // Slice 6: the strip now defaults ON; pin it OFF here so these
    // composition mounts stay focused (the strip owns
    // onboarding-execution-strip.test.tsx with its EventSource harness).
    // One dedicated test below re-enables it with a stubbed EventSource.
    overrideOnboardingFeatureFlags({ shellV2Enabled: true, brandGateV2Enabled: false, executionStripV2Enabled: false });
    vi.spyOn(workApi, 'subscribeBatchEvents').mockImplementation(() => () => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    setUrl('?batch=b1');
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    resetOnboardingFeatureFlags();
    document.body.innerHTML = '';
    setUrl('');
  });

  it('renders exactly six stage tabs in order with server-count badges (never page lengths)', async () => {
    installFetch(() => [makeRow(1), makeRow(2)]); // page has 2 rows; badge must show 7
    setUrl('?batch=b1');
    await mount();
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')).map((t) => t.textContent ?? '');
    const stageTabs = tabs.filter((t) => /Identify & Route Sources|Find product page|Collect details|Prepare listing|Review listings|Create drafts/.test(t));
    expect(stageTabs.length).toBe(6);
    const labels = LINEAR_STAGES.map((s) => s.label);
    expect(labels).toEqual([
      'Identify & Route Sources',
      'Find product page',
      'Collect details',
      'Prepare listing',
      'Review listings',
      'Create drafts',
    ]);
    // Order in DOM matches execution order.
    const domOrder = Array.from(container.querySelectorAll('.bws-stage-tab')).map((t) => t.textContent ?? '');
    for (let i = 0; i < labels.length; i += 1) {
      expect(domOrder[i]).toContain(labels[i]!);
    }
    // Badge for Stage 1 shows the server matrix total (7), not the 2-row page.
    expect(domOrder[0]).toContain('7');
    // Stage-one flow note: official URL main, distributor skip secondary.
    const note = container.querySelector('[data-testid="stage-one-flow-note"]');
    expect(note?.textContent).toMatch(/official product page/i);
    expect(note?.textContent).toMatch(/alternate path/i);
    // Scope label present.
    expect(container.querySelector('[data-testid="stage-scope-label"]')?.textContent).toMatch(/server-filtered/i);
    // Oracle slice: no Operations strip beneath the stage; batch-wide entry
    // lives in the single header disclosure (grouped links, never a tablist).
    expect(container.querySelector('[data-testid="linear-secondary-nav"]')).toBeNull();
    expect(container.querySelector('[data-testid="batch-tools-disclosure"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="batch-tools-disclosure"] [role="tablist"]')).toBeNull();
  });

  it('Review-listings stage defaults to Unreviewed with Reviewed/Not-ready separated', async () => {
    installFetch((u) => {
      if (u.includes('reviewState=reviewed')) return [makeRow(9, { reviewState: 'reviewed' })];
      if (u.includes('reviewState=not_ready')) return [];
      return [makeRow(1), makeRow(2), makeRow(3)];
    });
    setUrl('?batch=b1&stage=review_listings&stageVersion=2');
    await mount();
    const facetRow = container.querySelector('[data-testid="review-facet-row"]');
    expect(facetRow).not.toBeNull();
    const pressed = facetRow!.querySelector('[aria-pressed="true"]');
    expect(pressed?.textContent).toMatch(/Unreviewed/);
    const calls = seenUrls.filter((u) => u.includes('/stage-work-state/items'));
    expect(calls.some((u) => u.includes('reviewState=unreviewed'))).toBe(true);
  });

  it('legacy ?tab=skipped renders the Skipped outcome with no Approved destination or export action', async () => {
    installFetch(() => [makeRow(5, { category: 'skipped' })]);
    setUrl('?batch=b1&tab=skipped');
    await mount();
    const outcome = container.querySelector('[data-testid="outcome-items-skipped"]');
    expect(outcome).not.toBeNull();
    expect(container.querySelector('[data-testid="outcome-scope-label"]')?.textContent).toMatch(/category=skipped/);
    expect(container.querySelector('[data-testid="linear-scope-banner"]')?.textContent).toMatch(/Skipped outcome/);
    // No Approved view, no export buttons anywhere in the outcome.
    expect(container.querySelector('[data-testid="approved-view"]')).toBeNull();
    expect(outcome!.textContent).not.toMatch(/Create export drafts/i);
    // Oracle slice: outcome destinations carry no Operations strip.
    expect(container.querySelector('[data-testid="linear-secondary-nav"]')).toBeNull();
    expect(container.querySelector('[data-testid="batch-tools-disclosure"]')).not.toBeNull();
  });

  it('legacy ?tab=completed renders Completed with no Ready-to-Export membership or export action', async () => {
    installFetch(() => [makeRow(6, { category: 'completed' })]);
    setUrl('?batch=b1&tab=completed');
    await mount();
    expect(container.querySelector('[data-testid="outcome-items-completed"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="ready-to-export-view"]')).toBeNull();
    expect(container.textContent).not.toMatch(/Create export drafts/i);
  });

  it('legacy ?tab=review mounts the entire-batch Review workspace with a scope banner', async () => {
    installFetch(() => []);
    setUrl('?batch=b1&tab=review');
    await mount();
    expect(container.querySelector('[data-testid="linear-operation-review"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="linear-scope-banner"]')?.textContent).toMatch(/Entire batch/);
    // Stage filters are hidden while the full-batch view is open.
    expect(container.querySelector('[data-testid="stage-scope-label"]')).toBeNull();
    // Oracle slice: operation destinations carry no secondary strip either.
    expect(container.querySelector('[data-testid="linear-secondary-nav"]')).toBeNull();
  });

  it('unknown stage versions render an unsupported-link state with a safe default (no mutation)', async () => {
    installFetch(() => [makeRow(1)]);
    setUrl('?batch=b1&stage=sourcing&stageVersion=1');
    await mount();
    const notice = container.querySelector('[data-testid="unsupported-link-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toMatch(/Unsupported link/i);
    // Oracle slice: unsupported selections carry no Operations strip.
    expect(container.querySelector('[data-testid="linear-secondary-nav"]')).toBeNull();
  });

  it('Prepare listing is one view with five internal sections (not five stages)', async () => {
    installFetch(() => [makeRow(1, { stage: 'curation' })]);
    setUrl('?batch=b1&stage=prepare_listing&stageVersion=2');
    await mount();
    expect(container.querySelector('[data-testid="prepare-listing-view"]')).not.toBeNull();
    for (const key of ['ocr_evidence', 'family_cohort', 'names', 'product_type', 'field_classification']) {
      expect(container.querySelector(`[data-testid="prepare-section-${key}"]`)).not.toBeNull();
    }
    // Still six stage tabs — sections never become tabs.
    expect(container.querySelectorAll('.bws-stage-tab').length).toBe(6);
  });

  it('shell-OFF+brand-ON shows no brand view (disabled-content state, never the new brand view)', async () => {
    resetOnboardingFeatureFlags();
    overrideOnboardingFeatureFlags({ shellV2Enabled: false, brandGateV2Enabled: true });
    installFetch(() => []);
    setUrl('?batch=b1&view=brand-setup');
    // Slice 7 disabled-content state: no brand view, no stage navigation.
    await mount();
    expect(container.querySelector('[data-testid="brand-setup-placeholder"]')).toBeNull();
    expect(container.querySelector('[data-testid="shell-disabled-notice"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="linear-shell"]')).toBeNull();
  });

  it('Slice 6 default-on: the execution strip mounts with shell+strip flags on (stubbed EventSource)', async () => {
    resetOnboardingFeatureFlags();
    overrideOnboardingFeatureFlags({ shellV2Enabled: true, executionStripV2Enabled: true });
    const factory = vi.fn(() => ({
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
    }));
    (globalThis as any).EventSource = factory;
    try {
      installFetch(() => [makeRow(1)]);
      setUrl('?batch=b1');
      await mount();
      expect(container.querySelector('[data-testid="linear-shell"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="execution-strip"]')).not.toBeNull();
    } finally {
      delete (globalThis as any).EventSource;
    }
  });

  it('Slice 7: shell-OFF renders the disabled-content state inside the sole shell (no classic navigation)', async () => {    resetOnboardingFeatureFlags();
    overrideOnboardingFeatureFlags({ shellV2Enabled: false });
    installFetch(() => []);
    setUrl('?batch=b1');
    await mount();
    // Emergency kill-switch state: header + rollback instruction only.
    expect(container.querySelector('[data-testid="shell-disabled-notice"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="shell-disabled-notice"]')?.textContent).toMatch(/archived matching bridge client/i);
    expect(container.querySelector('[data-testid="workspace-grace-fallback"]')).toBeNull();
    expect(container.querySelector('[data-testid="linear-shell"]')).toBeNull();
    // No brand view, no strip, no stage tabs in the disabled state.
    expect(container.querySelector('[data-testid="execution-strip"]')).toBeNull();
    expect(container.querySelectorAll('.bws-stage-tab').length).toBe(0);
  });

  it('oracle: header Batch tools disclosure groups batch-wide links with counts and an attention urgency indicator', async () => {
    installFetch(() => [makeRow(1)]);
    setUrl('?batch=b1');
    await mount();
    const disclosure = container.querySelector('[data-testid="batch-tools-disclosure"]');
    expect(disclosure).not.toBeNull();
    // Grouped navigation links — never another tablist (no false Ready-to-Export selection).
    expect(disclosure!.querySelector('[role="tablist"]')).toBeNull();
    const nav = disclosure!.querySelector('nav[aria-label="Batch tools, entire batch"]');
    expect(nav).not.toBeNull();
    for (const group of ['Resolve and monitor', 'Review and approval', 'Drafts and outcomes']) {
      expect(nav!.textContent).toMatch(new RegExp(group));
    }
    for (const testId of ['batch-tool-attention', 'batch-tool-processing', 'batch-tool-family', 'batch-tool-review', 'batch-tool-approved', 'batch-tool-export', 'batch-tool-completed', 'batch-tool-skipped']) {
      expect(container.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
    }
    expect(container.querySelector('[data-testid="batch-tool-review"]')?.textContent).toMatch(/Full-batch review workspace/);
    // Batch counts stay inside the disclosure (processing badge shows the server count 7).
    expect(container.querySelector('[data-testid="batch-tool-processing"]')?.textContent).toMatch(/7/);
    // Clearly labeled urgency indicator on the trigger.
    const urgency = container.querySelector('[data-testid="batch-attention-urgency"]');
    expect(urgency).not.toBeNull();
    expect(urgency?.getAttribute('aria-label')).toMatch(/Batch attention/i);
  });

  it('oracle: Create drafts offers the entire-batch ready-to-export workspace action', async () => {
    installFetch(() => [makeRow(1)]);
    setUrl('?batch=b1&stage=create_drafts&stageVersion=2');
    await mount();
    const action = container.querySelector('[data-testid="open-ready-to-export-workspace"]');
    expect(action).not.toBeNull();
    expect(action?.textContent).toMatch(/Open ready-to-export workspace, entire batch/);
    await act(async () => {
      (action as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.querySelector('[data-testid="linear-operation-export"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="linear-scope-banner"]')?.textContent).toMatch(/Entire batch/);
    expect(container.querySelector('[data-testid="stage-scope-label"]')).toBeNull();
  });

  it('oracle: operation scope banner returns to the entering stage instead of resetting to route_sources', async () => {
    installFetch(() => [makeRow(1)]);
    setUrl('?batch=b1&stage=collect_details&stageVersion=2');
    await mount();
    const reviewLink = container.querySelector('[data-testid="batch-tool-review"]');
    expect(reviewLink).not.toBeNull();
    await act(async () => {
      (reviewLink as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.querySelector('[data-testid="linear-operation-review"]')).not.toBeNull();
    // Return preserves the entering stage (Collect details), never route_sources.
    expect(container.querySelector('[data-testid="linear-scope-banner"]')?.textContent).toMatch(/Back to Collect details/);
    expect(container.querySelector('[data-testid="linear-scope-banner"]')?.textContent).not.toMatch(/Identify & Route Sources/);
  });
});

