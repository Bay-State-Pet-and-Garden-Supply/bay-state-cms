// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingWorkState } from '../../shared/schemas/onboarding-work-state';
import type { PreparationSummary } from '../../shared/schemas/onboarding-preparation';
import type { StageReadCountsResponse, StageReadItemsResponse } from '../../shared/schemas/onboarding-stage-read';
import type { CohortListResponse, CurationCohortView } from '../../shared/schemas/cohorts';
import type { CurationData } from '../../shared/schemas/onboarding';
import type { ItemDetailResponse, PreparationGapView } from '../../client/onboarding-api';

vi.mock('../../client/onboarding-stage-api', () => ({ getStageReadItems: vi.fn(), getStageReadCounts: vi.fn() }));
vi.mock('../../client/onboarding-work-api', () => ({
  subscribeBatchEvents: vi.fn(() => () => {}), getItemWorkState: vi.fn(), getBatchWorkStateItems: vi.fn(),
}));
vi.mock('../../client/onboarding-api', () => ({
  getItemDetail: vi.fn(), getBatchCohorts: vi.fn(), getPreparationGap: vi.fn(), submitGapCorrection: vi.fn(),
  generateGapIdempotencyKey: () => 'correction-key', OnboardingApiError: class extends Error {},
}));
import { getStageReadItems, getStageReadCounts } from '../../client/onboarding-stage-api';
import { getItemWorkState, getBatchWorkStateItems } from '../../client/onboarding-work-api';
import { getItemDetail, getBatchCohorts, getPreparationGap, submitGapCorrection, OnboardingApiError } from '../../client/onboarding-api';
import { PrepareListingView, type PrepareListingViewProps } from '../../client/components/onboarding/PrepareListingView';
import { writeStageViewPreferences, readStageViewPreferences } from '../../client/components/onboarding/workspace-view-state';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const healthy = { status: 'healthy' as const, version: '1', computedAt: '2026-10-01T12:00:00Z', issues: [] };
function row(id = 'p1', overrides: Partial<OnboardingWorkState> = {}): OnboardingWorkState {
  return {
    itemId: id, category: 'processing', activity: 'curation', label: 'Curating listing', detail: null,
    attentionReason: null, attentionAction: null, variantResolution: null, variantDisposition: null,
    findingCode: null, findingSummary: null, conflictingValues: null, suggestedAction: null, findingDetails: null,
    family: null, reviewState: 'not_ready', stage: 'prepare_listing', stageStatus: 'in_progress',
    upc: id === 'p1' ? '111111111111' : '222222222222', name: `Original ${id}`, brand: 'Acme', sourceType: 'official_page',
    domain: 'acme.example', curatedTitle: `Curated ${id}`, imageUrl: null, description: null, weight: null, ...overrides,
  };
}
function summary(overrides: Partial<PreparationSummary> = {}): PreparationSummary {
  return {
    schemaVersion: 1,
    sections: [
      { key: 'ocr_evidence', title: 'Packaging OCR evidence', state: 'available', reason: 'Packaging evidence was recorded.' },
      { key: 'family_cohort', title: 'Family/cohort grouping & readiness', state: 'not_started_or_unknown', reason: 'No family reported.' },
      { key: 'names', title: 'Name curation', state: 'proposed', reason: 'A curated name was proposed.' },
      { key: 'product_type', title: 'Product type assignment', state: 'proposed', reason: 'A type was proposed.' },
      { key: 'field_classification', title: 'Field classification', state: 'pending_or_proposed', reason: 'Pending review.' },
    ], ...overrides,
  };
}
function page(items = [row()], preparation = Object.fromEntries(items.map(item => [item.itemId, summary()])), nextCursor: string | null = null, batchId = 'b1'): StageReadItemsResponse {
  return { schemaVersion: 2, stageVocabularyVersion: 2, batchId, filterFingerprint: 'a'.repeat(32), projectionHealth: healthy,
    items, preparationByItem: preparation, nextCursor, scannedRows: 50, queryCount: 2 };
}
function counts(total = 104, categories: Partial<StageReadCountsResponse['counts']> = {}): StageReadCountsResponse {
  const zero = { pending: 0, in_progress: 0, completed: 0, failed: 0, needs_input: 0, skipped: 0 };
  return { schemaVersion: 2, stageVocabularyVersion: 2, batchId: 'b1', filterFingerprint: 'a'.repeat(32), projectionHealth: healthy,
    matchingTotal: total, counts: { processing: total === 104 ? 100 : total, waiting_on_family: total === 104 ? 3 : 0, needs_attention: total === 104 ? 1 : 0, ready_for_review: 0, approved: 0, ready_to_export: 0, completed: 0, skipped: 0, ...categories },
    stageStatusMatrix: { route_sources: zero, find_product_page: zero, collect_details: zero, prepare_listing: { ...zero, pending: total }, review_listings: zero, create_drafts: zero } };
}
function detail(item = row(), runId = 'run-current', batchId = 'b1'): ItemDetailResponse {
  const evidence = { id: 'ev-current', runId, productSku: item.upc, stageName: 'evidence_extraction', source: 'visual_product_evidence', reliability: 'high', snippet: `Package text for ${item.itemId}`, value: 'Chicken', capturedAt: '2026-10-01T12:00:00Z' };
  const proposal = { id: 'type-current', runId, productSku: item.upc, proposalType: 'primary_product_type', targetId: 'dog-food', proposedValue: 'dog-food', status: 'pending', evidenceIds: ['ev-current'], confidence: 0.9, isBulkAcceptable: false, isStale: false, stalenessReason: null, createdAt: '2026-10-01T12:00:00Z' };
  const curation = {
    classificationRunId: runId, curatedTitle: `Effective title ${item.itemId}`, titleSource: 'llm_cohort', suggestedPages: ['Dog Food'],
    effectiveProductType: { id: 'dog-food', source: 'execution' }, pageDecisionStatus: { status: 'assigned' },
    classificationEvidence: [evidence, { ...evidence, id: 'ev-old', runId: 'run-old', snippet: 'OLD RUN PACKAGE' }],
    classificationProposals: [proposal,
      { ...proposal, id: 'field-current', proposalType: 'field_assignment', targetId: 'flavor', proposedValue: 'Chicken', status: 'accepted', currentDecisionId: 'd1', hasRevisedValue: true, revisedValue: 'Turkey', derivation: { kind: 'evidence_match' } },
      { ...proposal, id: 'page-current', proposalType: 'category_page', targetId: 'dog-food-page', proposedValue: 'Dog Food' },
      { ...proposal, id: 'old', runId: 'run-old', proposedValue: 'OLD RUN TYPE' },
      { ...proposal, id: 'foreign-sku', productSku: '999999999999', proposedValue: 'OTHER PRODUCT TYPE' }],
    classificationDecisions: [{ id: 'd1', proposalId: 'field-current', decision: 'accepted', decisionOrigin: 'human_review', hasRevisedValue: true, revisedValue: 'Turkey', supersededAt: null, createdAt: '2026-10-01T12:00:00Z' }],
  } as unknown as CurationData;
  return { item: { id: item.itemId, batchId, upc: item.upc, name: item.name, curationData: curation, extractionData: null } as ItemDetailResponse['item'],
    sources: [], extraction: null, consistencyWarnings: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function familyView(members: Array<{ id: string; state: 'ready' | 'waiting' | 'blocked' }> = [
  { id: 'p1', state: 'ready' }, { id: 's-ready', state: 'ready' }, { id: 's-wait', state: 'waiting' }, { id: 's-block', state: 'blocked' },
]): CurationCohortView {
  return { cohort: { id: 'family-1', batchId: 'b1', workspaceId: 'ws1', groupKey: 'family', groupLabel: 'Actual Chicken Family', status: 'waiting', groupingVersion: 'v1', membershipHash: 'hash', blockedReason: null, createdAt: '2026-10-01', updatedAt: '2026-10-01', supersededAt: null },
    status: 'waiting', state: members.some(m => m.state === 'blocked') ? 'blocked' : 'waiting', blockedReason: 'A family member needs help.',
    memberCount: members.length, readyCount: members.filter(m => m.state === 'ready').length,
    members: members.map((m, index) => ({ onboardingItemId: m.id, productSku: m.id, normalizedBrand: 'Acme', normalizedNameStem: 'chicken', ordinal: index, extractionHash: m.state === 'ready' ? 'hash' : null,
      item: { id: m.id, upc: `000000000${index}`, name: `Actual ${m.id}` }, state: m.state, ready: m.state === 'ready', blockedReason: m.state === 'blocked' ? 'Extractor profile required.' : null, waitingOn: [] })),
    // Deliberate overlap: blocked member must retain its blocker reason/action.
    waitingOn: members.filter(m => m.state !== 'ready').map(m => ({ itemId: m.id, upc: m.id, name: `Actual ${m.id}` })),
  };
}
const family = { cohortId: 'family-1', label: 'Actual Chicken Family', memberCount: 4, readyCount: 2, blockedCount: 1, waitingOnItemIds: ['s-wait'] };

describe('product-first preparation', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.resetAllMocks();
    window.sessionStorage.clear();
    vi.mocked(getStageReadItems).mockResolvedValue(page());
    vi.mocked(getStageReadCounts).mockResolvedValue(counts());
    vi.mocked(getItemDetail).mockImplementation(async id => detail(row(id)));
    vi.mocked(getItemWorkState).mockImplementation(async id => ({ workState: row(id) }));
    vi.mocked(getBatchCohorts).mockResolvedValue({ cohorts: [familyView()], shadowObservations: [] });
    vi.mocked(getBatchWorkStateItems).mockResolvedValue({ batchId: 'b1', projectionHealth: healthy,
      items: [row('s-wait', { category: 'processing', stage: 'collect_details', family, label: 'Collecting details' }),
        row('s-block', { category: 'needs_attention', stage: 'collect_details', family, label: 'Set up extractor profile', detail: 'Profile configuration needed.' })],
      nextCursor: null, scannedRows: 25, queryCount: 2 });
    vi.mocked(getPreparationGap).mockResolvedValue({ gap: null });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });
  async function render(props: Partial<PrepareListingViewProps> = {}) {
    await act(async () => { root.render(<PrepareListingView batchId="b1" workspaceId="ws1" {...props} />); });
  }
  function button(text: string) {
    const found = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent?.startsWith(text));
    expect(found, `button ${text}`).toBeDefined();
    return found!;
  }
  async function click(text: string) { await act(async () => { button(text).click(); }); }
  async function searchFor(q: string) {
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('#preparation-search')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, q);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  }

  it('shows actual effective-run evidence and all five groups, without turning proposals into approval', async () => {
    await render();
    expect(container.textContent).toContain('104 products in this preparation scope');
    expect(container.textContent).toContain('Package text for p1');
    expect(container.textContent).toContain('Effective title p1');
    expect(container.textContent).toContain('run-current');
    expect(container.textContent).toContain('Proposed value: dog-food');
    expect(container.textContent).toContain('Proposed value: Chicken');
    expect(container.textContent).toContain('Revised value: Turkey');
    expect(container.textContent).toContain('Accepted assignment — listing approval is separate');
    expect(container.textContent).not.toMatch(/OLD RUN|OTHER PRODUCT/);
    for (const key of ['ocr_evidence', 'family_cohort', 'names', 'product_type', 'field_classification']) {
      expect(container.querySelector(`[data-testid="prepare-section-${key}"]`)).not.toBeNull();
    }
    expect(container.querySelector('[data-testid="prepare-page-placement-subrow"]')?.textContent).toContain('Draft readiness unavailable');
    expect(getStageReadItems).toHaveBeenCalledExactlyOnceWith('b1', { stage: 'prepare_listing', limit: 50 });
    expect(getItemDetail).toHaveBeenCalledExactlyOnceWith('p1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('uses consistently scoped count calls and does not drain the list cursor', async () => {
    vi.mocked(getStageReadItems).mockImplementation(async (_batch, query) => page([query?.category === 'needs_attention'
      ? row('p1', { category: 'needs_attention', label: 'Retry preparation' }) : row()], undefined, 'page-2'));
    vi.mocked(getStageReadCounts).mockImplementation(async (_batch, query) => query?.category === 'needs_attention'
      ? counts(1, { processing: 0, needs_attention: 1 }) : counts());
    await render();
    expect(getStageReadItems).toHaveBeenCalledTimes(1);
    expect(button('Preparing (100)').textContent).toBe('Preparing (100)');
    await searchFor('Acme');
    await click('Needs attention');
    expect(getStageReadItems).toHaveBeenLastCalledWith('b1', { stage: 'prepare_listing', q: 'Acme', category: 'needs_attention', limit: 50 });
    expect(getStageReadCounts).toHaveBeenCalledWith('b1', { stage: 'prepare_listing', q: 'Acme', category: 'needs_attention' });
    expect(getStageReadCounts).toHaveBeenCalledWith('b1', { stage: 'prepare_listing', q: 'Acme' });
    expect(container.textContent).toContain('1 product in this preparation scope');
    expect(button('Preparing (100)').textContent).toBe('Preparing (100)');
  });

  it('distinguishes an unavailable gap, a confirmed clear gap, and a corrupt projection', async () => {
    const items = [row(), row('p2'), row('p3')];
    vi.mocked(getStageReadItems).mockResolvedValue(page(items, { p1: summary(), p2: summary({ gap: null }), p3: { schemaVersion: 99 } as unknown as PreparationSummary }));
    await render();
    expect(container.textContent).toContain('Listing gap state unavailable');
    expect(getPreparationGap).not.toHaveBeenCalled();
    await click('Curated p2');
    expect(container.textContent).toContain('No open listing gap reported for this product');
    await click('Curated p3');
    expect(container.textContent).toContain('Listing gap state unavailable');
    expect(container.querySelector('[data-testid="prepare-section-state-ocr_evidence"]')?.textContent).toContain('Unavailable');
    expect(container.textContent).not.toContain('No open listing gap reported');
  });

  it('records a real gap correction, refreshes its projection, and clears it only after validated re-preparation', async () => {
    const open = { missingFields: ['title'], reason: 'A product name is missing.', evidenceHash: 'hash', updatedAt: '2026-10-01T12:00:00Z', correctionRevision: 0, correctionStatus: 'none' as const };
    const gap = { itemId: 'p1', ...open, status: 'open', correctionEnvelope: null } as unknown as PreparationGapView;
    vi.mocked(getStageReadItems).mockResolvedValue(page([row()], { p1: summary({ gap: open }) }));
    vi.mocked(getPreparationGap).mockResolvedValue({ gap });
    vi.mocked(submitGapCorrection).mockImplementation(async () => {
      vi.mocked(getStageReadItems).mockResolvedValue(page([row()], { p1: summary({ gap: { ...open, correctionRevision: 1, correctionStatus: 'preparing' } }) }));
      return { gap: { ...gap, correctionRevision: 1 }, envelope: { revision: 1, values: { title: 'Operator product name' }, actor: 'operator', status: 'preparing' }, receiptId: 'receipt-p1', replay: false };
    });
    await render();
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('#gap-p1-title')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Operator product name');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { container.querySelector('[aria-label="Correct listing information for Original p1"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(submitGapCorrection).toHaveBeenCalledWith('p1', { values: { title: 'Operator product name' }, expectedEvidenceHash: 'hash', expectedUpdatedAt: open.updatedAt }, { idempotencyKey: 'correction-key' });
    expect(container.textContent).toContain('Correction revision 1 · preparing');
    expect(container.textContent).not.toContain('No open listing gap reported');
    vi.mocked(getStageReadItems).mockResolvedValue(page([row()], { p1: summary({ gap: null }) }));
    await click('Refresh preparation');
    expect(container.textContent).toContain('No open listing gap reported for this product');
    expect(container.querySelector('[data-testid="gap-panel-p1"]')).toBeNull();
  });

  it('preserves selected context across product pages and restores a saved off-page selection', async () => {
    const p1 = row(); const p2 = row('p2');
    vi.mocked(getStageReadItems).mockImplementation(async (_batch, query) => query?.q === p1.upc
      ? page([p1]) : query?.cursor ? page([p2]) : page([p1], undefined, 'page-2'));
    await render();
    await click('Next products');
    expect(container.textContent).toContain('Read page 2');
    expect(container.querySelector('[data-testid="preparation-details-p1"]')).not.toBeNull();
    expect(container.textContent).toContain('Selected product context from another read page');
    expect(container.textContent).toContain('104 products in this preparation scope');
    await click('Curated p2');
    expect(readStageViewPreferences({ workspaceId: 'ws1', batchId: 'b1', stage: 'prepare_listing' })?.selectedId).toBe('p2');
    vi.mocked(getStageReadItems).mockImplementation(async (_batch, query) => query?.q === p2.upc ? page([p2]) : page([p1], undefined, 'page-2'));
    await render({ workspaceId: 'another-workspace' });
    await render();
    expect(container.querySelector('[data-testid="preparation-details-p2"]')).not.toBeNull();
    expect(getStageReadItems).toHaveBeenCalledWith('b1', { stage: 'prepare_listing', q: p2.upc, limit: 50 });
  });

  it('guards product and filter changes while a preparation correction is unsaved', async () => {
    const open = { missingFields: ['description'], reason: 'Description is missing.', evidenceHash: 'hash', updatedAt: 'now', correctionRevision: 0, correctionStatus: 'none' as const };
    const gap = { itemId: 'p1', ...open, status: 'open', correctionEnvelope: null } as unknown as PreparationGapView;
    vi.mocked(getStageReadItems).mockResolvedValue(page([row(), row('p2')], { p1: summary({ gap: open }), p2: summary({ gap: null }) }));
    vi.mocked(getPreparationGap).mockResolvedValue({ gap });
    await render();
    await act(async () => {
      const input = container.querySelector<HTMLTextAreaElement>('#gap-p1-description')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Pending description');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await click('Curated p2');
    await click('Waiting on family');
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="preparation-details-p1"]')).not.toBeNull();
    expect((container.querySelector('#gap-p1-description') as HTMLTextAreaElement).value).toBe('Pending description');
    expect(button('All products').getAttribute('aria-pressed')).toBe('true');
    confirm.mockReturnValue(true);
    await click('Curated p2');
    expect(container.querySelector('[data-testid="preparation-details-p2"]')).not.toBeNull();
    expect(container.querySelector('[data-onboarding-dirty="true"]')).toBeNull();
  });

  it('retains pending correction values when background facts change until explicit discard', async () => {
    const open = { missingFields: ['description'], reason: 'Description is missing.', evidenceHash: 'hash', updatedAt: 'old', correctionRevision: 0, correctionStatus: 'none' as const };
    const gap = { itemId: 'p1', ...open, status: 'open', correctionEnvelope: null } as unknown as PreparationGapView;
    vi.mocked(getStageReadItems).mockResolvedValue(page([row()], { p1: summary({ gap: open }) }));
    vi.mocked(getPreparationGap).mockResolvedValue({ gap });
    await render();
    await act(async () => {
      const input = container.querySelector<HTMLTextAreaElement>('#gap-p1-description')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Pending description');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const changed = { ...open, updatedAt: 'new', evidenceHash: 'new-hash' };
    vi.mocked(getStageReadItems).mockResolvedValue(page([row()], { p1: summary({ gap: changed }) }));
    await render({ refreshKey: 1 });
    expect((container.querySelector('#gap-p1-description') as HTMLTextAreaElement).value).toBe('Pending description');
    expect(container.textContent).toContain('Your pending correction is retained');
    expect(getPreparationGap).toHaveBeenCalledTimes(1);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(getPreparationGap).mockResolvedValue({ gap: { ...gap, ...changed } });
    await click('Discard pending correction');
    expect((container.querySelector('#gap-p1-description') as HTMLTextAreaElement).value).toBe('');
    expect(container.querySelector('[data-onboarding-dirty="true"]')).toBeNull();
  });

  it('refreshes preparation context after an explicitly accepted stale-request reload', async () => {
    const open = { missingFields: ['description'], reason: 'Description is missing.', evidenceHash: 'hash', updatedAt: 'old', correctionRevision: 0, correctionStatus: 'none' as const };
    const changed = { ...open, evidenceHash: 'new-hash', updatedAt: 'new' };
    const gap = { itemId: 'p1', ...open, status: 'open', correctionEnvelope: null } as unknown as PreparationGapView;
    vi.mocked(getStageReadItems).mockResolvedValue(page([row()], { p1: summary({ gap: open }) }));
    vi.mocked(getPreparationGap).mockResolvedValue({ gap });
    vi.mocked(submitGapCorrection).mockImplementation(async () => {
      vi.mocked(getStageReadItems).mockResolvedValue(page([row()], { p1: summary({ gap: changed }) }));
      vi.mocked(getPreparationGap).mockResolvedValue({ gap: { ...gap, ...changed } });
      throw Object.assign(new OnboardingApiError('Changed request', 409, 'stale_gap'), { code: 'stale_gap' });
    });
    await render();
    await act(async () => {
      const input = container.querySelector<HTMLTextAreaElement>('#gap-p1-description')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Pending description');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { container.querySelector('[aria-label="Correct listing information for Original p1"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await click('Reload latest request');
    expect(getStageReadItems).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Last updated new');
    const input = container.querySelector<HTMLTextAreaElement>('#gap-p1-description')!;
    expect(input.value).toBe('');
    expect(input.closest('fieldset')!.disabled).toBe(false);
    expect(container.querySelector('[data-onboarding-dirty="true"]')).toBeNull();
  });

  it('restores q/category/selectedId in the exact workspace and batch scope', async () => {
    writeStageViewPreferences({ workspaceId: 'ws1', batchId: 'b1', stage: 'prepare_listing' }, { q: 'Acme', filters: { category: 'waiting_on_family' }, selectedId: 'p2' });
    vi.mocked(getStageReadItems).mockResolvedValue(page([row('p1', { category: 'waiting_on_family', family }), row('p2', { category: 'waiting_on_family', family })]));
    vi.mocked(getStageReadCounts).mockImplementation(async (_batch, query) => query?.category === 'waiting_on_family'
      ? counts(3, { processing: 0, waiting_on_family: 3 }) : counts());
    await render();
    expect(container.querySelector<HTMLInputElement>('#preparation-search')!.value).toBe('Acme');
    expect(button('Waiting on family').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-testid="preparation-details-p2"]')).not.toBeNull();
    expect(getStageReadItems).toHaveBeenCalledWith('b1', { stage: 'prepare_listing', q: 'Acme', category: 'waiting_on_family', limit: 50 });
    await render({ workspaceId: 'ws2' });
    expect(container.querySelector<HTMLInputElement>('#preparation-search')!.value).toBe('');
    expect(button('All products').getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the selected product when an already-applied filter is clicked again', async () => {
    vi.mocked(getStageReadItems).mockResolvedValue(page([row(), row('p2')]));
    await render();
    await click('Curated p2');
    await click('All products');
    await searchFor('');
    expect(container.querySelector('[data-testid="preparation-details-p2"]')).not.toBeNull();
    expect(readStageViewPreferences({ workspaceId: 'ws1', batchId: 'b1', stage: 'prepare_listing' })?.selectedId).toBe('p2');
    expect(getStageReadItems).toHaveBeenCalledTimes(1);
  });

  it('continues a sparse zero-row page using its cursor', async () => {
    vi.mocked(getStageReadItems).mockImplementation(async (_batch, query) => query?.cursor ? page([row()]) : page([], {}, 'sparse-next'));
    await render();
    expect(container.textContent).toContain('No matching products in this read page');
    expect(button('Next products').disabled).toBe(false);
    await click('Next products');
    expect(getStageReadItems).toHaveBeenLastCalledWith('b1', { stage: 'prepare_listing', limit: 50, cursor: 'sparse-next' });
    expect(container.textContent).toContain('Effective title p1');
  });

  it('does not discard remembered selection when a sparse identity lookup has a continuation', async () => {
    const selected = row('p2');
    writeStageViewPreferences({ workspaceId: 'ws1', batchId: 'b1', stage: 'prepare_listing' }, { q: '', filters: {}, selectedId: 'p2' });
    vi.mocked(getStageReadItems).mockImplementation(async (_batch, query) => query?.q === selected.upc
      ? query.cursor ? page([selected]) : page([], {}, 'selected-next') : page([row()]));
    await render();
    expect(readStageViewPreferences({ workspaceId: 'ws1', batchId: 'b1', stage: 'prepare_listing' })?.selectedId).toBe('p2');
    expect(container.textContent).toContain('not been reached in this bounded context read');
    expect(getStageReadItems).toHaveBeenCalledTimes(2);
    await click('Continue selected product lookup');
    expect(getStageReadItems).toHaveBeenLastCalledWith('b1', { stage: 'prepare_listing', q: selected.upc, cursor: 'selected-next', limit: 50 });
    expect(container.querySelector('[data-testid="preparation-details-p2"]')).not.toBeNull();
    expect(container.textContent).toContain('104 products in this preparation scope');
  });

  it('rejects late detail responses after changing selected products', async () => {
    const old = deferred<ItemDetailResponse>();
    vi.mocked(getStageReadItems).mockResolvedValue(page([row(), row('p2')]));
    vi.mocked(getItemDetail).mockImplementation(id => id === 'p1' ? old.promise : Promise.resolve(detail(row('p2'), 'run-p2')));
    await render();
    await click('Curated p2');
    await act(async () => { old.resolve(detail(row(), 'run-p1-late')); });
    const selected = container.querySelector('[aria-label="Selected product preparation"]')!;
    expect(selected.textContent).toContain('Effective title p2');
    expect(selected.textContent).toContain('run-p2');
    expect(selected.textContent).not.toMatch(/run-p1-late|Effective title p1|Package text for p1/);
  });

  it('ignores late list responses after a filter change', async () => {
    const late = deferred<StageReadItemsResponse>();
    vi.mocked(getStageReadItems).mockImplementation((_batch, query) => query?.category ? Promise.resolve(page([row('p2')])) : late.promise);
    await render();
    await click('Needs attention');
    await act(async () => { late.resolve(page([row()])); });
    expect(container.querySelector('[data-testid="preparation-details-p2"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="preparation-details-p1"]')).toBeNull();
  });

  it('does not use a failed refresh or count read as an empty/zero result', async () => {
    await render();
    vi.mocked(getStageReadItems).mockRejectedValue(new Error('Preparation read failed'));
    vi.mocked(getStageReadCounts).mockRejectedValue(new Error('Count read failed'));
    await click('Refresh preparation');
    expect(container.textContent).toContain('Preparation read failed');
    expect(container.textContent).toContain('Last reported products are shown below');
    expect(container.textContent).toContain('Product counts are unavailable');
    expect(container.textContent).toContain('Curated p1');
    expect(container.textContent).not.toContain('0 products in this preparation scope');
    vi.mocked(getStageReadItems).mockResolvedValue(page());
    vi.mocked(getStageReadCounts).mockResolvedValue(counts());
    await click('Refresh preparation');
    expect(container.textContent).not.toContain('Preparation read failed');
  });

  it('revalidates a selected product after stage movement', async () => {
    await render();
    vi.mocked(getStageReadItems).mockResolvedValue(page([], {}));
    vi.mocked(getItemWorkState).mockResolvedValue({ workState: row('p1', { stage: 'review_listings', category: 'ready_for_review' }) });
    await click('Refresh preparation');
    expect(container.textContent).toContain('no longer in this preparation scope');
    expect(container.querySelector('[data-testid="preparation-details-p1"]')).toBeNull();
    expect(readStageViewPreferences({ workspaceId: 'ws1', batchId: 'b1', stage: 'prepare_listing' })?.selectedId).toBeNull();
  });

  it('shows actual family readiness, opens the blocking sibling, and refreshes without losing initiating context', async () => {
    const attention = vi.fn(); const operation = vi.fn();
    const selected = row('p1', { category: 'waiting_on_family', family });
    vi.mocked(getStageReadItems).mockResolvedValue(page([selected]));
    vi.mocked(getStageReadCounts).mockResolvedValue(counts(1, { processing: 0, waiting_on_family: 1 }));
    await render({ onOpenAttentionItem: attention, onOpenOperation: operation });
    expect(container.textContent).toContain('2 / 4 products ready');
    expect(container.textContent).toContain('2 ready · 1 still processing · 1 blocked');
    expect(container.textContent).toContain('Actual s-ready');
    expect(container.textContent).toContain('Actual s-wait');
    expect(container.textContent).toContain('Profile configuration needed');
    expect(container.textContent).toContain('1 product in this preparation scope');
    await click('View blocker');
    expect(attention).toHaveBeenCalledExactlyOnceWith('s-block');
    expect(operation).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="preparation-details-p1"]')).not.toBeNull();
    expect(readStageViewPreferences({ workspaceId: 'ws1', batchId: 'b1', stage: 'prepare_listing' })?.selectedId).toBe('p1');
    vi.mocked(getBatchCohorts).mockResolvedValue({ cohorts: [familyView([{ id: 'p1', state: 'ready' }, { id: 's-ready', state: 'ready' }, { id: 's-wait', state: 'waiting' }])], shadowObservations: [] });
    await render({ onOpenAttentionItem: attention, refreshKey: 1 });
    expect(container.textContent).toContain('2 / 3 products ready');
    expect(container.textContent).not.toContain('Actual s-block');
    expect(container.querySelector('[data-testid="preparation-details-p1"]')).not.toBeNull();
    expect(getBatchWorkStateItems).toHaveBeenCalledWith('b1', { cohortId: 'family-1', limit: 25 });
    expect(vi.mocked(getItemDetail).mock.calls.every(([id]) => id === 'p1')).toBe(true);
  });

  it('does not offer inert attention navigation or call an old full-batch fallback', async () => {
    const operation = vi.fn();
    vi.mocked(getStageReadItems).mockResolvedValue(page([row('p1', { category: 'waiting_on_family', family })]));
    await render({ onOpenOperation: operation });
    expect(Array.from(container.querySelectorAll('button')).some(b => b.textContent === 'View blocker')).toBe(false);
    expect(container.textContent).not.toContain('entire-batch');
    expect(operation).not.toHaveBeenCalled();
  });

  it('does not show all-ready for changed, superseded, or foreign-workspace family membership', async () => {
    vi.mocked(getStageReadItems).mockResolvedValue(page([row('p1', { family })]));
    for (const [index, invalid] of [
      { ...familyView(), status: 'superseded' },
      { ...familyView(), cohort: { ...familyView().cohort, workspaceId: 'another-workspace' } },
      familyView([{ id: 'another-product', state: 'ready' }]),
    ].entries()) {
      vi.mocked(getBatchCohorts).mockResolvedValue({ cohorts: [invalid], shadowObservations: [] } as CohortListResponse);
      await render({ refreshKey: index + 1 });
      expect(container.textContent).toContain('family membership is unavailable or has changed');
      expect(container.querySelector('.fw-fraction')).toBeNull();
    }
  });

  it('bounds large family rendering and follows sparse sibling-task cursors without detail fan-out', async () => {
    const members = [{ id: 'p1', state: 'ready' as const }, ...Array.from({ length: 54 }, (_, i) => ({ id: `s-${i}`, state: 'waiting' as const }))];
    vi.mocked(getStageReadItems).mockResolvedValue(page([row('p1', { family })]));
    vi.mocked(getBatchCohorts).mockResolvedValue({ cohorts: [familyView(members)], shadowObservations: [] });
    vi.mocked(getBatchWorkStateItems).mockResolvedValue({ batchId: 'b1', projectionHealth: healthy, items: [], nextCursor: 'task-next', scannedRows: 25, queryCount: 2 });
    await render();
    expect(container.querySelectorAll('.fw-member')).toHaveLength(25);
    expect(container.textContent).toContain('1 / 55 products ready');
    await click('Next family members');
    expect(container.querySelectorAll('.fw-member')).toHaveLength(25);
    await click('Next sibling task page');
    expect(getBatchWorkStateItems).toHaveBeenLastCalledWith('b1', { cohortId: 'family-1', limit: 25, cursor: 'task-next' });
    expect(getItemDetail).toHaveBeenCalledTimes(1);
  });

  it('rejects family results belonging to a previously selected product', async () => {
    const late = deferred<CohortListResponse>();
    vi.mocked(getStageReadItems).mockResolvedValue(page([row('p1', { family }), row('p2')]));
    vi.mocked(getBatchCohorts).mockReturnValue(late.promise);
    await render();
    await click('Curated p2');
    await act(async () => { late.resolve({ cohorts: [familyView()], shadowObservations: [] }); });
    const selected = container.querySelector('[aria-label="Selected product preparation"]')!;
    expect(selected.textContent).not.toContain('Actual Chicken Family');
    expect(selected.textContent).not.toContain('Actual s-block');
    expect(selected.textContent).toContain('Effective title p2');
  });

  it('reports unavailable family reads instead of fabricating readiness or an empty family', async () => {
    vi.mocked(getStageReadItems).mockResolvedValue(page([row('p1', { family })]));
    vi.mocked(getBatchCohorts).mockRejectedValue(new Error('Family read failed'));
    await render();
    expect(container.textContent).toContain('Family membership and readiness are unavailable');
    expect(container.querySelector('.fw-fraction')).toBeNull();
    vi.mocked(getBatchCohorts).mockResolvedValue({ cohorts: [familyView()], shadowObservations: [] });
    await click('Retry family details');
    expect(container.textContent).toContain('2 / 4 products ready');
  });

  it('rejects another product’s detail payload and pauses correction actions', async () => {
    const open = { missingFields: ['title'], reason: 'Supply a product name.', evidenceHash: 'hash', updatedAt: '2026-10-01T12:00:00Z', correctionRevision: 0, correctionStatus: 'none' as const };
    vi.mocked(getStageReadItems).mockResolvedValue(page([row()], { p1: summary({ gap: open }) }));
    vi.mocked(getItemDetail).mockResolvedValue(detail(row('p2')));
    await render();
    expect(container.textContent).toContain('Preparation evidence does not belong to the selected product');
    expect(container.textContent).not.toContain('Package text for p2');
    expect(container.querySelector('fieldset')?.disabled).toBe(true);
    vi.mocked(getItemDetail).mockResolvedValue(detail(row()));
    await click('Retry product evidence');
    expect(container.textContent).toContain('Package text for p1');
  });

  it('binds refreshed classifications to the new effective run and keeps stale/cleared decisions explicit', async () => {
    await render();
    const next = detail(row(), 'run-next');
    next.item.curationData!.classificationProposals[1] = { ...next.item.curationData!.classificationProposals[1], revisedValue: null, isStale: true, stalenessReason: 'Evidence changed.' };
    next.item.curationData!.classificationDecisions[0] = { ...next.item.curationData!.classificationDecisions[0], revisedValue: null };
    vi.mocked(getItemDetail).mockResolvedValue(next);
    await click('Refresh preparation');
    expect(container.textContent).toContain('run-next');
    expect(container.textContent).not.toContain('run-current');
    expect(container.textContent).toContain('Stale proposal');
    expect(container.textContent).toContain('Revised value: Cleared');
    expect(container.textContent).toContain('Evidence changed.');
  });

  it('does not apply a late gap correction response to a newly selected product', async () => {
    const pending = deferred<Awaited<ReturnType<typeof submitGapCorrection>>>();
    const open = { missingFields: ['title'], reason: 'Supply the missing product name.', evidenceHash: 'hash', updatedAt: '2026-10-01T12:00:00Z', correctionRevision: 0, correctionStatus: 'none' as const };
    const gap: PreparationGapView = { id: 'gap-p1', batchId: 'b1', itemId: 'p1', ...open, status: 'open', correctionEnvelope: null };
    vi.mocked(getStageReadItems).mockResolvedValue(page([row(), row('p2')], { p1: summary({ gap: open }), p2: summary({ gap: null }) }));
    vi.mocked(getPreparationGap).mockResolvedValue({ gap });
    vi.mocked(submitGapCorrection).mockReturnValue(pending.promise);
    await render();
    await act(async () => { container.querySelector('[aria-label="Correct listing information for Original p1"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await click('Curated p2');
    await act(async () => { pending.resolve({ gap, replay: false, receiptId: 'receipt-p1', envelope: null }); });
    expect(container.querySelector('[data-testid="preparation-details-p2"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="gap-panel-accepted-p1"]')).toBeNull();
    expect(container.textContent).toContain('No open listing gap reported for this product');
    expect(getStageReadItems).toHaveBeenCalledTimes(1);
  });

  it.each(['failed', 'superseded'] as const)('keeps a %s correction visible and actionable instead of clear', async correctionStatus => {
    const open = { missingFields: ['title'], reason: 'Supply a product name.', evidenceHash: 'hash', updatedAt: '2026-10-01T12:00:00Z', correctionRevision: 2, correctionStatus };
    vi.mocked(getStageReadItems).mockResolvedValue(page([row()], { p1: summary({ gap: open }) }));
    vi.mocked(getPreparationGap).mockResolvedValue({ gap: { id: 'gap-p1', batchId: 'b1', itemId: 'p1', ...open, status: 'open', correctionEnvelope: null } });
    await render();
    expect(container.textContent).toContain(`Correction revision 2 · ${correctionStatus}`);
    expect(container.querySelector('[data-testid="gap-panel-submit-p1"]')).not.toBeNull();
    expect(container.textContent).not.toContain('No open listing gap reported');
  });
});
