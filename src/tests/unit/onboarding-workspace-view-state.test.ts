import { describe, expect, it } from 'vitest';
import {
  batchWorkspaceUrl,
  clearBatchWorkspaceParams,
  readLastWorkspaceStage,
  readStageViewPreferences,
  rememberWorkspaceStage,
  resolveWorkspaceViewSelection,
  writeStageViewPreferences,
  type StageViewPreferences,
  type ViewPreferenceStorage,
} from '../../client/components/onboarding/workspace-view-state';

function memoryStorage() {
  const entries = new Map<string, string>();
  const storage: ViewPreferenceStorage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
  };
  return { storage, entries };
}

const scope = { workspaceId: 'workspace-1', batchId: 'batch-1' };
const viewScope = { ...scope, stage: 'review_listings' as const };

describe('scoped onboarding view preferences', () => {
  it('remembers independent stages for each workspace and batch', () => {
    const { storage } = memoryStorage();
    rememberWorkspaceStage(scope, 'review_listings', storage);
    rememberWorkspaceStage({ ...scope, batchId: 'batch-2' }, 'prepare_listing', storage);
    rememberWorkspaceStage({ ...scope, workspaceId: 'workspace-2' }, 'collect_details', storage);
    expect(readLastWorkspaceStage(scope, storage)).toBe('review_listings');
    expect(readLastWorkspaceStage({ ...scope, batchId: 'batch-2' }, storage)).toBe('prepare_listing');
    expect(readLastWorkspaceStage({ ...scope, workspaceId: 'workspace-2' }, storage)).toBe('collect_details');
    expect(readLastWorkspaceStage({ ...scope, batchId: 'new' }, storage)).toBeNull();
  });

  it('keeps stage filters, search, and inspector context separate without colliding separator-containing IDs', () => {
    const { storage } = memoryStorage();
    const preferences = { filters: { reviewState: 'reviewed', brand: 'Acme' }, q: 'seed', selectedId: 'item-1' };
    writeStageViewPreferences(viewScope, preferences, storage);
    expect(readStageViewPreferences(viewScope, storage)).toEqual(preferences);
    expect(readStageViewPreferences({ ...viewScope, stage: 'create_drafts' }, storage)).toBeNull();
    expect(readStageViewPreferences({ ...viewScope, batchId: 'batch-2' }, storage)).toBeNull();
    expect(readStageViewPreferences({ ...viewScope, workspaceId: 'workspace-2' }, storage)).toBeNull();
    rememberWorkspaceStage({ workspaceId: 'a:b', batchId: 'c' }, 'review_listings', storage);
    expect(readLastWorkspaceStage({ workspaceId: 'a', batchId: 'b:c' }, storage)).toBeNull();
  });

  it('drops records, pending edits, mutation selections, credentials, and unknown filter keys at runtime', () => {
    const { storage, entries } = memoryStorage();
    writeStageViewPreferences(viewScope, {
      filters: { reviewState: 'reviewed', token: 'test-only-secret', edits: { title: 'pending' } },
      q: 'seed', selectedId: 'item-1',
      records: [{ title: 'product record' }], draft: { description: 'pending edit' }, selectedIds: ['item-2'],
      password: 'test-only-secret',
    } as unknown as StageViewPreferences, storage);
    expect(readStageViewPreferences(viewScope, storage)).toEqual({
      filters: { reviewState: 'reviewed' }, q: 'seed', selectedId: 'item-1',
    });
    expect([...entries.values()].join('')).not.toMatch(/test-only-secret|pending|product record|item-2/);
  });

  it('sanitizes corrupt, obsolete, nested, and oversized preference facts', () => {
    const { storage, entries } = memoryStorage();
    rememberWorkspaceStage(scope, 'review_listings', storage);
    const stageKey = [...entries.keys()][0];
    for (const corrupt of ['{bad', '"promotion"', '{}', 'null']) {
      entries.set(stageKey, corrupt);
      expect(readLastWorkspaceStage(scope, storage)).toBeNull();
    }
    writeStageViewPreferences(viewScope, {
      filters: { category: 'x'.repeat(257), reviewState: { record: 'ignored' }, brand: 'Acme' },
      q: 'x'.repeat(501), selectedId: 'x'.repeat(257),
    } as unknown as StageViewPreferences, storage);
    expect(readStageViewPreferences(viewScope, storage)).toEqual({ filters: { brand: 'Acme' }, q: '', selectedId: null });
    const viewKey = [...entries.keys()].find((key) => key !== stageKey)!;
    for (const corrupt of ['{bad', '[]', '"record"', 'null']) {
      entries.set(viewKey, corrupt);
      expect(readStageViewPreferences(viewScope, storage)).toBeNull();
    }
  });

  it('degrades safely when storage is absent, blocked, or full, and never persists under a missing scope', () => {
    const { storage, entries } = memoryStorage();
    rememberWorkspaceStage({ ...scope, workspaceId: '' }, 'review_listings', storage);
    writeStageViewPreferences({ ...viewScope, batchId: '' }, { filters: {}, q: '', selectedId: null }, storage);
    expect(entries.size).toBe(0);
    const unavailable: ViewPreferenceStorage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('full'); },
    };
    for (const target of [null, unavailable]) {
      expect(readLastWorkspaceStage(scope, target)).toBeNull();
      expect(readStageViewPreferences(viewScope, target)).toBeNull();
      expect(() => rememberWorkspaceStage(scope, 'review_listings', target)).not.toThrow();
      expect(() => writeStageViewPreferences(viewScope, { filters: {}, q: '', selectedId: null }, target)).not.toThrow();
    }
  });
});

describe('explicit selection versus batch entry fallback', () => {
  it('reports valid versioned stages and legacy destinations as explicit, even with a remembered stage', () => {
    expect(resolveWorkspaceViewSelection('?stage=collect_details&stageVersion=2', 'review_listings')).toEqual({
      selection: { kind: 'stage', stage: 'collect_details' }, source: 'explicit',
    });
    expect(resolveWorkspaceViewSelection('?tab=needs_attention', 'review_listings')).toEqual({
      selection: { kind: 'legacy', rawTab: 'needs_attention' }, source: 'explicit',
    });
    expect(resolveWorkspaceViewSelection('?wview=brand-setup', 'review_listings')).toEqual({
      selection: { kind: 'stage', stage: 'route_sources' }, source: 'explicit',
    });
  });

  it('distinguishes remembered, default, and forced new-batch first-stage selection', () => {
    expect(resolveWorkspaceViewSelection('?view=onboarding&batch=batch-1', 'review_listings')).toEqual({
      selection: { kind: 'stage', stage: 'review_listings' }, source: 'remembered',
    });
    expect(resolveWorkspaceViewSelection('', 'promotion')).toEqual({
      selection: { kind: 'stage', stage: 'route_sources' }, source: 'default',
    });
    expect(resolveWorkspaceViewSelection('?tab=needs_attention', 'review_listings', true)).toEqual({
      selection: { kind: 'stage', stage: 'route_sources' }, source: 'new-batch',
    });
  });

  it.each(['?stage=review_listings', '?stage=promotion&stageVersion=2', '?stage=review_listings&stageVersion=7', '?tab=nope', '?stage=review_listings&stageVersion=2&tab=review'])('keeps an unsupported explicit link visible: %s', (search) => {
    const result = resolveWorkspaceViewSelection(search, 'create_drafts');
    expect(result.source).toBe('unsupported');
    expect(result.selection.kind === 'unsupported' || result.selection.kind === 'legacy').toBe(true);
  });
});

describe('batch entry and exit URLs', () => {
  it('restores the target batch and removes another batch’s stale selector namespace', () => {
    const current = new URL('https://cms.example/?view=onboarding&batch=old&stage=find_product_page&stageVersion=2&wview=brand-setup&tab=needs_attention&board=pipeline&settingsTab=curation#context');
    const url = batchWorkspaceUrl(current, 'batch-1', 'review_listings');
    expect(url.searchParams.get('batch')).toBe('batch-1');
    expect(url.searchParams.get('stage')).toBe('review_listings');
    expect(url.searchParams.get('stageVersion')).toBe('2');
    for (const key of ['wview', 'tab', 'board']) expect(url.searchParams.has(key)).toBe(false);
    expect(url.searchParams.get('settingsTab')).toBe('curation');
    expect(url.hash).toBe('#context');
    expect(current.searchParams.get('batch')).toBe('old');
  });

  it('does not turn a plain/new batch into an attention destination', () => {
    const url = batchWorkspaceUrl(new URL('https://cms.example/?view=onboarding&tab=needs_attention'), 'new', 'create_drafts', true);
    expect(url.searchParams.get('stage')).toBe('route_sources');
    expect(url.searchParams.get('stageVersion')).toBe('2');
    expect(url.searchParams.has('tab')).toBe(false);
  });

  it('preserves direct stage, operation, outcome, and unsupported links for the same batch', () => {
    for (const selector of ['stage=collect_details&stageVersion=2', 'tab=review', 'tab=completed', 'stage=unknown&stageVersion=2', 'tab=invalid']) {
      const current = new URL(`https://cms.example/?view=onboarding&batch=batch-1&${selector}`);
      expect(batchWorkspaceUrl(current, 'batch-1', 'prepare_listing').search).toBe(current.search);
    }
  });

  it('clears orphan stage versions on legacy entry, and all batch selectors on exit', () => {
    const url = batchWorkspaceUrl(new URL('https://cms.example/?view=onboarding&batch=batch-1&tab=review&stageVersion=2'), 'batch-1', 'prepare_listing');
    expect(url.searchParams.get('tab')).toBe('review');
    expect(url.searchParams.has('stageVersion')).toBe(false);
    const params = new URLSearchParams('view=onboarding&batch=b&stage=review_listings&stageVersion=2&wview=brand-setup&tab=review&board=pipeline&settingsTab=curation');
    clearBatchWorkspaceParams(params);
    expect(params.toString()).toBe('view=onboarding&settingsTab=curation');
  });
});
