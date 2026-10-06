/** Stage-scoped server reads, quick intake assignment, and selected-product source setup. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { colors, fonts, rounded } from '../../theme';
import { assignBrandGroup, assignItemBrand, getBrandSites, getExtractorProfiles } from '../../onboarding-api';
import { assignBatchBrandDomain } from '../../onboarding-work-api';
import { BrandStrategyBuilder } from '../brand-strategy/BrandStrategyBuilder';
import { GapCorrectionPanel } from './GapCorrectionPanel';
import { BrandCombobox } from './BrandCombobox';
import { SourceItemDetail, type SourceDetailSection } from './SourceItemDetail';
import { getBrandOptions, registerBrandOption, resetBrandOptionsCache, resolveCanonicalBrand } from './brand-combobox-logic';
import { getStageReadItems, StageReadApiError, type StageReadQuery } from '../../onboarding-stage-api';
import { STAGE_READ_LIMIT_DEFAULT, type CollectionReadiness } from '../../../shared/schemas/onboarding-stage-read';
import type { OnboardingWorkState } from '../../../shared/schemas/onboarding-work-state';
import { LINEAR_STAGE_LABELS, type LinearStageId } from './linear-workspace-logic';
import {
  DEFAULT_REVIEW_LIST_FACET, REVIEW_LIST_FACETS, REVIEW_LIST_FACET_LABELS,
  sourceTypeLabel, reviewStateLabel, formatCount, type ReviewListFacet,
} from './batch-workspace-logic';
import { getAttentionActionLabel, getAttentionGroupLabel, getActivityBadgeLabel } from './attention/attention-logic';
import { getProfileWorkspacePath } from '../profile-workspace/route';
import { readStageViewPreferences, writeStageViewPreferences } from './workspace-view-state';

export interface StageItemsViewProps {
  batchId: string;
  stage: LinearStageId;
  workspaceId?: string;
  refreshKey?: number;
  /** Shell-owned resolver; preserves the stage and selected-product context underneath. */
  onOpenAttentionItem?: (itemId: string) => void;
  compact?: boolean;
  /** Compatibility only: the shell now mounts the actual review/draft workspaces. */
  onOpenFullBatchReview?: () => void;
  onOpenReadyToExportWorkspace?: () => void;
  onOpenSettings?: (domain?: string) => void;
  onOpenProfileBuilder?: (domain: string) => void;
}

type Facet = { category?: string; reviewState?: ReviewListFacet };
export type IntakeKpiFilter = 'all' | 'missing-brand' | 'missing-domain' | 'distributor' | 'ready';
export const INTAKE_KPI_FILTERS: readonly IntakeKpiFilter[] = ['all', 'missing-brand', 'missing-domain', 'distributor', 'ready'];
export const INTAKE_KPI_LABELS: Record<IntakeKpiFilter, string> = {
  all: 'All Products', 'missing-brand': 'Missing Brand', 'missing-domain': 'Missing Domain', distributor: 'Distributor record', ready: 'Ready to Route',
};
const brandKeyOf = (brand: string): string => brand.trim().toLowerCase();
const domainKeyOf = (domain: string): string => domain.trim().toLowerCase();

export interface IntakeRowFlags {
  missingBrand: boolean;
  distributorExempt: boolean;
  mappedDomain: string | null;
  missingDomain: boolean;
  profileReady: boolean;
  ready: boolean;
}

/** Legacy fallback only; an item collection decision takes precedence over these flags. */
export function deriveIntakeFlags(
  item: Pick<OnboardingWorkState, 'brand' | 'sourceType' | 'domain'>,
  domainMap: ReadonlyMap<string, string>,
  profileDomains?: ReadonlySet<string>,
): IntakeRowFlags {
  const brand = item.brand?.trim() ? item.brand.trim() : null;
  const distributorExempt = item.sourceType === 'distributor_record' && !item.domain;
  if (!brand) return { missingBrand: true, distributorExempt, mappedDomain: null, missingDomain: false, profileReady: false, ready: distributorExempt };
  const mappedDomain = domainMap.get(brandKeyOf(brand)) ?? null;
  const missingDomain = !distributorExempt && mappedDomain === null;
  const profileReady = Boolean(mappedDomain && profileDomains?.has(domainKeyOf(mappedDomain)));
  return { missingBrand: false, distributorExempt, mappedDomain, missingDomain, profileReady, ready: distributorExempt || (!missingDomain && profileReady) };
}

export interface StrategyReadinessView {
  approved: boolean;
  revision: number;
  underway?: boolean;
  sources: Array<{ kind: 'official_page' | 'distributor_record'; distributorId?: string; domain?: string }>;
  proposalSources?: Array<{ kind: 'official_page' | 'distributor_record'; distributorId?: string; domain?: string }>;
  approvedSources?: Array<{ kind: 'official_page' | 'distributor_record'; distributorId?: string; domain?: string }>;
  availability: Array<{ kind: 'official_page' | 'distributor_record'; ref: string; available: boolean; reason: string }>;
  readiness: 'awaiting_approval' | 'setup_attention' | 'ready' | 'ready_partial' | 'unknown';
}

export function strategySourcesEqual(a: ReadonlyArray<StrategyReadinessView['sources'][number]>, b: ReadonlyArray<StrategyReadinessView['sources'][number]>): boolean {
  return a.length === b.length && a.every((s, i) => s.kind === b[i].kind
    && (s.distributorId ?? null) === (b[i].distributorId ?? null)
    && (s.domain ?? '').toLowerCase() === (b[i].domain ?? '').toLowerCase());
}

export interface RowStrategyReadiness {
  label: string;
  explanation: string | null;
  strategyLabel: string;
  suppressMissingDomain: boolean;
  canCollect: boolean;
}

export function strategySummaryLabel(view: StrategyReadinessView | null): string {
  if (!view || view.sources.length === 0) return 'Suggested sources';
  return view.sources.map((s) => s.kind === 'official_page' ? 'Official website' : (s.distributorId ?? 'Distributor')).join(' + ');
}

export function deriveStrategyReadiness(view: StrategyReadinessView | null, loaded: boolean, loadError = false): RowStrategyReadiness {
  const strategyLabel = strategySummaryLabel(view);
  if (loadError) return { label: 'Collection readiness unavailable · Retry', explanation: null, strategyLabel, suppressMissingDomain: false, canCollect: false };
  if (!loaded) return { label: 'Loading collection readiness…', explanation: null, strategyLabel: 'Suggested sources', suppressMissingDomain: false, canCollect: false };
  if (!view || !view.approved) return { label: 'Awaiting approval', explanation: null, strategyLabel, suppressMissingDomain: false, canCollect: false };
  if (view.underway === true) return { label: `Underway · Collecting approved revision ${view.revision}`, explanation: null, strategyLabel, suppressMissingDomain: true, canCollect: false };
  const available = view.availability.filter((s) => s.available);
  const suppressMissingDomain = !view.sources.some((s) => s.kind === 'official_page');
  if (view.readiness === 'setup_attention' || available.length === 0) return { label: 'Setup attention · No usable sources', explanation: null, strategyLabel, suppressMissingDomain, canCollect: false };
  const explanation = 'Ready means collection can run. It does not guarantee a match, collected evidence, or sufficient listing information.';
  const n = available.length;
  const label = available.length === view.availability.length
    ? `Ready · ${n} source${n === 1 ? '' : 's'} available`
    : `Ready — partial · ${n} source${n === 1 ? '' : 's'} available; website needs setup`;
  return { label, explanation, strategyLabel, suppressMissingDomain, canCollect: true };
}

export interface IntakeStrategyFacts { approved: boolean; canCollect: boolean; suppressMissingDomain: boolean }

/** A present per-item decision never borrows another generation's brand-level Ready. */
export function collectionFactsFor(decision: CollectionReadiness | undefined | null): IntakeStrategyFacts | null {
  if (!decision) return null;
  if (decision.path !== 'approved_strategy') return { approved: false, canCollect: false, suppressMissingDomain: false };
  return { approved: true, canCollect: decision.canCollect, suppressMissingDomain: !decision.sourceAvailability.some((s) => s.kind === 'official_page') };
}

export type IntakeSourceRoute = 'distributor' | 'blocked' | 'discovery';
export function intakeSourceRoute(flags: IntakeRowFlags): IntakeSourceRoute {
  if (flags.distributorExempt) return 'distributor';
  return flags.missingBrand || flags.missingDomain ? 'blocked' : 'discovery';
}
export interface IntakeKpiCounts { all: number; missingBrand: number; missingDomain: number; distributor: number; ready: number }

/** Loaded-product summaries, not whole-batch totals. Existing authority/fallback order is preserved. */
export function countIntakeKpis(
  items: ReadonlyArray<Pick<OnboardingWorkState, 'brand' | 'sourceType' | 'domain'> & { itemId?: string }>,
  domainMap: ReadonlyMap<string, string>, profileDomains?: ReadonlySet<string>,
  strategyFor?: (brand: string | null) => IntakeStrategyFacts | null,
  collectionForItem?: (itemId: string) => IntakeStrategyFacts | null,
): IntakeKpiCounts {
  const counts: IntakeKpiCounts = { all: items.length, missingBrand: 0, missingDomain: 0, distributor: 0, ready: 0 };
  for (const item of items) {
    const perItem = item.itemId !== undefined ? collectionForItem?.(item.itemId) ?? null : null;
    if (perItem) { if (perItem.approved && perItem.canCollect) counts.ready += 1; continue; }
    const strategy = strategyFor?.(item.brand ?? null) ?? null;
    if (strategy?.approved) { if (strategy.canCollect) counts.ready += 1; continue; }
    const flags = deriveIntakeFlags(item, domainMap, profileDomains);
    if (flags.missingBrand) counts.missingBrand += 1;
    if (flags.missingDomain && !strategy?.suppressMissingDomain) counts.missingDomain += 1;
    if (flags.distributorExempt) counts.distributor += 1;
    if (flags.ready) counts.ready += 1;
  }
  return counts;
}

export function matchesIntakeFilter(
  item: Pick<OnboardingWorkState, 'brand' | 'sourceType' | 'domain'> & { itemId?: string }, filter: IntakeKpiFilter,
  domainMap: ReadonlyMap<string, string>, profileDomains?: ReadonlySet<string>,
  strategyFor?: (brand: string | null) => IntakeStrategyFacts | null,
  collectionForItem?: (itemId: string) => IntakeStrategyFacts | null,
): boolean {
  if (filter === 'all') return true;
  const perItem = item.itemId !== undefined ? collectionForItem?.(item.itemId) ?? null : null;
  if (perItem) return perItem.approved && filter === 'ready' ? perItem.canCollect : false;
  const strategy = strategyFor?.(item.brand ?? null) ?? null;
  if (strategy?.approved) return filter === 'ready' ? strategy.canCollect : false;
  const flags = deriveIntakeFlags(item, domainMap, profileDomains);
  switch (filter) {
    case 'missing-brand': return flags.missingBrand;
    case 'missing-domain': return flags.missingDomain && !strategy?.suppressMissingDomain;
    case 'distributor': return flags.distributorExempt;
    case 'ready': return flags.ready;
  }
}

function initialPreferences(workspaceId: string | undefined, batchId: string, stage: LinearStageId) {
  const stored = workspaceId ? readStageViewPreferences({ workspaceId, batchId, stage }) : null;
  const reviewState = stored?.filters.reviewState;
  const category = stored?.filters.category;
  const facet: Facet = {};
  if (category === 'needs_attention' || category === 'processing' || category === 'waiting_on_family') facet.category = category;
  if (stage === 'review_listings') facet.reviewState = REVIEW_LIST_FACETS.includes(reviewState as ReviewListFacet) ? reviewState as ReviewListFacet : DEFAULT_REVIEW_LIST_FACET;
  return {
    q: stored?.q ?? '', facet, selectedId: stored?.selectedId ?? null,
    kpiFilter: INTAKE_KPI_FILTERS.includes(stored?.filters.kpiFilter as IntakeKpiFilter) ? stored!.filters.kpiFilter as IntakeKpiFilter : 'all' as IntakeKpiFilter,
  };
}

export function StageItemsView({ batchId, stage, workspaceId, refreshKey = 0, compact, onOpenAttentionItem, onOpenSettings, onOpenProfileBuilder }: StageItemsViewProps) {
  const scopeKey = JSON.stringify([workspaceId, batchId, stage]);
  const initial = useMemo(() => initialPreferences(workspaceId, batchId, stage), [workspaceId, batchId, stage]);
  const [preferenceScope, setPreferenceScope] = useState(scopeKey);
  const [q, setQ] = useState(initial.q);
  const [debouncedQ, setDebouncedQ] = useState(initial.q.trim());
  const [facet, setFacet] = useState<Facet>(initial.facet);
  const [kpiFilter, setKpiFilter] = useState<IntakeKpiFilter>(initial.kpiFilter);
  const [selectedId, setSelectedId] = useState<string | null>(initial.selectedId);
  const [detailSection, setDetailSection] = useState<SourceDetailSection>('source');
  const [focusVersion, setFocusVersion] = useState(0);
  const detailLastFocus = useRef<HTMLElement | null>(null);
  const [items, setItems] = useState<OnboardingWorkState[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);
  const loadedPages = useRef(1);
  // Invalidate origins synchronously: even a retained handler cannot cross batch/stage/workspace boundaries.
  const context = useRef({ key: scopeKey });
  if (context.current.key !== scopeKey) { context.current = { key: scopeKey }; generation.current += 1; }
  const origin = context.current;
  const backgroundStateRef = useRef({ origin, running: false, queued: false });
  if (backgroundStateRef.current.origin !== origin) backgroundStateRef.current = { origin, running: false, queued: false };
  const backgroundState = backgroundStateRef.current;
  useEffect(() => {
    context.current = origin;
    return () => { context.current = { key: '' }; generation.current += 1; };
  }, [origin]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const facetRef = useRef(facet);
  facetRef.current = facet;
  const queryRef = useRef(debouncedQ);
  queryRef.current = debouncedQ;
  const [collectionByItem, setCollectionByItem] = useState<Readonly<Record<string, CollectionReadiness>>>({});
  const [drafts, setDrafts] = useState<Record<string, { brand: string; saving: boolean; error: string | null }>>({});
  const [selected, setSelected] = useState<Record<string, true>>({});
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [bulkBrand, setBulkBrand] = useState('');
  const [bulkDomain, setBulkDomain] = useState('');
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [brandOptions, setBrandOptions] = useState<string[]>([]);
  const brandOptionsRef = useRef(brandOptions);
  brandOptionsRef.current = brandOptions;
  const [brandDomainMap, setBrandDomainMap] = useState<ReadonlyMap<string, string>>(new Map());
  const [brandSitesLoaded, setBrandSitesLoaded] = useState(false);
  const [brandSitesLoading, setBrandSitesLoading] = useState(true);
  const [profileDomains, setProfileDomains] = useState<ReadonlySet<string>>(new Set());
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [strategyViews, setStrategyViews] = useState<ReadonlyMap<string, StrategyReadinessView>>(new Map());
  const [strategiesLoaded, setStrategiesLoaded] = useState(false);
  const [strategiesError, setStrategiesError] = useState(false);
  const refsGeneration = useRef(0);
  const [domainDraft, setDomainDraft] = useState({ itemId: '', brand: '', value: '', saving: false, error: null as string | null });
  const [strategyDialog, setStrategyDialog] = useState<{ brand: string; itemId: string; origin: typeof origin } | null>(null);
  const [strategyBuilderKey, setStrategyBuilderKey] = useState(0);
  const strategyDialogDirty = useRef(false);
  const strategyLastFocus = useRef<HTMLElement | null>(null);
  const strategyCard = useRef<HTMLDivElement | null>(null);
  const [gapDialog, setGapDialog] = useState<{ itemId: string; itemName: string } | null>(null);
  const gapLastFocus = useRef<HTMLElement | null>(null);
  const gapCard = useRef<HTMLDivElement | null>(null);
  const backgroundBlocked = loading || refreshing || domainDraft.saving || bulkSaving ||
    Boolean(domainDraft.value.trim() || bulkBrand.trim() || strategyDialog || gapDialog) || Object.values(drafts).some(draft => draft.saving);
  const backgroundBlockedRef = useRef(backgroundBlocked);
  backgroundBlockedRef.current = backgroundBlocked;

  useEffect(() => {
    setPreferenceScope(scopeKey);
    loadedPages.current = 1;
    setItems([]); setCollectionByItem({}); setNextCursor(null); setError(null); setLoading(true);
    setQ(initial.q); setDebouncedQ(initial.q.trim()); setFacet(initial.facet);
    setKpiFilter(initial.kpiFilter); setSelectedId(initial.selectedId);
    setDrafts({}); setSelected({}); setBulkBrand(''); setBulkDomain(''); setBulkError(null); setBulkSaving(false);
    setDomainDraft({ itemId: '', brand: '', value: '', saving: false, error: null });
    setRefreshing(false); setFocusVersion(0); setStrategyDialog(null); strategyDialogDirty.current = false; setGapDialog(null);
  }, [scopeKey, initial]);

  useEffect(() => {
    if (!workspaceId || preferenceScope !== scopeKey) return;
    writeStageViewPreferences({ workspaceId, batchId, stage }, { q, filters: { ...facet, kpiFilter }, selectedId });
  }, [workspaceId, batchId, stage, scopeKey, preferenceScope, q, facet, kpiFilter, selectedId]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const load = useCallback(async (cursor: string | null, currentFacet: Facet, query: string, preservePages = false) => {
    if (context.current !== origin) return;
    const gen = cursor ? generation.current : ++generation.current;
    setLoading(true);
    const fresh: OnboardingWorkState[] = [];
    let freshCollection: Record<string, CollectionReadiness> = {};
    let requestCursor = cursor;
    let pagesRead = 0;
    const pageCount = !cursor && preservePages ? loadedPages.current : 1;
    try {
      // Refresh only the pages the operator already loaded, using fresh cursors.
      // Commit them together so an intermediate first page never prunes context.
      for (let index = 0; index < pageCount; index += 1) {
        const params: StageReadQuery = { stage, limit: STAGE_READ_LIMIT_DEFAULT };
        if (currentFacet.category) params.category = currentFacet.category as StageReadQuery['category'];
        if (currentFacet.reviewState) params.reviewState = currentFacet.reviewState;
        if (query) params.q = query;
        if (requestCursor) params.cursor = requestCursor;
        const res = await getStageReadItems(batchId, params);
        if (context.current !== origin || generation.current !== gen) return;
        fresh.push(...res.items);
        freshCollection = { ...freshCollection, ...res.collectionByItem };
        pagesRead += 1;
        requestCursor = res.nextCursor;
        if (!requestCursor) break;
      }
      loadedPages.current = cursor ? loadedPages.current + pagesRead : pagesRead;
      setNextCursor(requestCursor);
      if (cursor) {
        setItems(previous => {
          const seen = new Set(previous.map(item => item.itemId));
          return [...previous, ...fresh.filter(item => !seen.has(item.itemId))];
        });
        setCollectionByItem(previous => ({ ...previous, ...freshCollection }));
      } else {
        setItems(fresh);
        setCollectionByItem(freshCollection);
      }
      if (!cursor) {
        const ids = new Set(fresh.map((item) => item.itemId));
        setSelectedId((id) => id && ids.has(id) ? id : null);
        setSelected((prev) => Object.fromEntries(Object.keys(prev).filter((id) => ids.has(id)).map((id) => [id, true as const])));
      }
      setError(null);
    } catch (err) {
      if (context.current !== origin || generation.current !== gen) return;
      setError(err instanceof StageReadApiError ? `${err.message}${err.code ? ` (${err.code})` : ''}` : err instanceof Error ? err.message : String(err));
    } finally { if (context.current === origin && generation.current === gen) setLoading(false); }
  }, [batchId, stage, origin]);

  useEffect(() => {
    if (preferenceScope !== scopeKey) return;
    loadedPages.current = 1;
    setItems([]); setNextCursor(null); setCollectionByItem({}); setError(null); setSelected({}); setDrafts({}); setBulkSaving(false);
    void load(null, facet, debouncedQ);
  }, [load, preferenceScope, scopeKey, facet, debouncedQ]);

  const refreshLoadedScope = useCallback(async () => {
    if (context.current !== origin) return;
    backgroundState.queued = true;
    if (backgroundState.running || backgroundBlockedRef.current) return;
    backgroundState.running = true;
    try {
      while (backgroundState.queued && !backgroundBlockedRef.current && context.current === origin) {
        backgroundState.queued = false;
        await load(null, facetRef.current, queryRef.current, true);
      }
    } finally { backgroundState.running = false; }
  }, [origin, backgroundState, load]);
  useEffect(() => {
    if (refreshKey > 0) void refreshLoadedScope();
  }, [refreshKey, refreshLoadedScope]);
  useEffect(() => {
    if (!backgroundBlocked && backgroundState.queued) void refreshLoadedScope();
  }, [backgroundBlocked, backgroundState, refreshLoadedScope]);

  const loadIntakeRefs = useCallback(async () => {
    if (stage !== 'route_sources' || context.current !== origin) return;
    const epoch = ++refsGeneration.current;
    const current = () => context.current === origin && refsGeneration.current === epoch;
    setBrandSitesLoading(true); setProfilesLoading(true);
    await Promise.all([
      (async () => {
        try {
          const res = await getBrandSites();
          if (!current()) return;
          const map = new Map<string, string>();
          for (const site of Array.isArray(res?.brandSites) ? res.brandSites : []) {
            const name = typeof site.brandName === 'string' ? site.brandName.trim() : '';
            const domain = typeof site.domain === 'string' ? site.domain.trim() : '';
            if (name && domain && !map.has(brandKeyOf(name))) map.set(brandKeyOf(name), domain);
          }
          setBrandDomainMap(map); setBrandSitesLoaded(true);
        } catch { if (current()) { setBrandDomainMap(new Map()); setBrandSitesLoaded(false); } }
        finally { if (current()) setBrandSitesLoading(false); }
      })(),
      (async () => {
        try {
          const res = await getExtractorProfiles();
          if (!current()) return;
          setProfileDomains(new Set((Array.isArray(res?.extractorProfiles) ? res.extractorProfiles : []).map((p) => domainKeyOf(p.domain))));
          setProfilesLoaded(true);
        } catch { if (current()) { setProfileDomains(new Set()); setProfilesLoaded(false); } }
        finally { if (current()) setProfilesLoading(false); }
      })(),
      (async () => {
        try {
          const res = await fetch('/api/onboarding/brands/strategy');
          if (!res.ok) throw new Error('Strategy read failed');
          const body = await res.json() as { strategies?: Array<{
            normalizedBrand?: string; approval?: { approved?: boolean; revision?: number };
            proposalSources?: StrategyReadinessView['sources']; approvedSources?: StrategyReadinessView['sources'];
            sourceAvailability?: StrategyReadinessView['availability']; collectionReadiness?: StrategyReadinessView['readiness'];
          }> };
          if (!current()) return;
          const map = new Map<string, StrategyReadinessView>();
          for (const s of Array.isArray(body.strategies) ? body.strategies : []) {
            const key = typeof s.normalizedBrand === 'string' ? brandKeyOf(s.normalizedBrand) : '';
            if (!key || map.has(key)) continue;
            const parseSources = (sources: StrategyReadinessView['sources'] | undefined): StrategyReadinessView['sources'] => (Array.isArray(sources) ? sources : []).flatMap<StrategyReadinessView['sources'][number]>((p) => {
              if (p.kind === 'official_page' && typeof p.domain === 'string' && p.domain.trim()) return [{ kind: 'official_page' as const, domain: domainKeyOf(p.domain) }];
              if (p.kind === 'distributor_record' && typeof p.distributorId === 'string' && p.distributorId.trim()) return [{ kind: 'distributor_record' as const, distributorId: p.distributorId.trim() }];
              return [];
            });
            const proposalSources = parseSources(s.proposalSources);
            const approvedSources = parseSources(s.approvedSources);
            const approved = s.approval?.approved === true;
            map.set(key, {
              approved, revision: typeof s.approval?.revision === 'number' ? s.approval.revision : 0,
              sources: approved && approvedSources.length > 0 ? approvedSources : proposalSources, proposalSources, approvedSources,
              availability: (Array.isArray(s.sourceAvailability) ? s.sourceAvailability : []).filter((a) => (a.kind === 'official_page' || a.kind === 'distributor_record') && typeof a.ref === 'string')
                .map((a) => ({ ...a, available: a.available === true, reason: typeof a.reason === 'string' ? a.reason : 'unknown' })),
              readiness: ['ready', 'ready_partial', 'setup_attention', 'unknown'].includes(s.collectionReadiness ?? '') ? s.collectionReadiness! : 'awaiting_approval',
            });
          }
          setStrategyViews(map); setStrategiesLoaded(true); setStrategiesError(false);
        } catch { if (current()) { setStrategyViews(new Map()); setStrategiesLoaded(false); setStrategiesError(true); } }
      })(),
    ]);
  }, [batchId, stage, origin]);

  useEffect(() => {
    setBrandDomainMap(new Map()); setBrandSitesLoaded(false); setBrandSitesLoading(true);
    setProfileDomains(new Set()); setProfilesLoaded(false); setProfilesLoading(true);
    setStrategyViews(new Map()); setStrategiesLoaded(false); setStrategiesError(false); setBrandOptions([]);
    if (stage !== 'route_sources') return;
    void loadIntakeRefs();
    void getBrandOptions().then((opts) => { if (context.current === origin) setBrandOptions(opts); });
  }, [stage, origin, loadIntakeRefs]);

  useEffect(() => {
    const brands = items.map((it) => it.brand?.trim()).filter((b): b is string => Boolean(b));
    brands.forEach(registerBrandOption);
    setBrandOptions((prev) => [...prev, ...brands.filter((b, i) => !prev.some((o) => brandKeyOf(o) === brandKeyOf(b)) && brands.indexOf(b) === i)]);
  }, [items]);

  const refreshEpoch = useCallback(async () => {
    if (context.current !== origin) return;
    setRefreshing(true); setSelected({}); setDrafts({}); setBulkError(null); setError(null);
    try {
      await load(null, facetRef.current, queryRef.current, true);
      if (context.current !== origin) return;
      await loadIntakeRefs();
      if (context.current !== origin) return;
      resetBrandOptionsCache();
      const options = await getBrandOptions();
      if (context.current === origin) setBrandOptions(options);
    } finally { if (context.current === origin) setRefreshing(false); }
  }, [load, loadIntakeRefs, origin]);

  const runBrandAssign = async (item: OnboardingWorkState, value: string) => {
    const canonical = resolveCanonicalBrand(value, brandOptionsRef.current);
    if (context.current !== origin || !canonical || domainDraft.value.trim() || domainDraft.saving || drafts[item.itemId]?.saving || !itemsRef.current.some((row) => row.itemId === item.itemId && row.brand === item.brand)) return;
    const gen = generation.current;
    setDrafts((prev) => ({ ...prev, [item.itemId]: { brand: value, saving: true, error: null } }));
    try {
      await assignItemBrand(item.itemId, canonical, item.brand ?? undefined);
      if (context.current !== origin || generation.current !== gen) return;
      registerBrandOption(canonical);
      await refreshEpoch();
    } catch (err) {
      if (context.current !== origin || generation.current !== gen) return;
      setDrafts((prev) => ({ ...prev, [item.itemId]: { brand: value, saving: false, error: err instanceof Error ? err.message : String(err) } }));
    }
  };

  const strategyFactsFor = useCallback((brand: string | null): IntakeStrategyFacts | null => {
    const view = brand?.trim() ? strategyViews.get(brandKeyOf(brand)) : null;
    if (!view?.approved) return null;
    const readiness = deriveStrategyReadiness(view, strategiesLoaded, strategiesError);
    return { approved: true, canCollect: readiness.canCollect, suppressMissingDomain: readiness.suppressMissingDomain };
  }, [strategyViews, strategiesLoaded, strategiesError]);
  const collectionFactsForItem = useCallback((itemId: string) => collectionFactsFor(collectionByItem[itemId]), [collectionByItem]);
  const kpiCounts = countIntakeKpis(items, brandDomainMap, profileDomains, strategyFactsFor, collectionFactsForItem);
  const visibleItems = useMemo(() => stage === 'route_sources'
    ? items.filter((item) => matchesIntakeFilter(item, kpiFilter, brandDomainMap, profileDomains, strategyFactsFor, collectionFactsForItem)) : items,
  [stage, items, kpiFilter, brandDomainMap, profileDomains, strategyFactsFor, collectionFactsForItem]);
  const visibleRef = useRef(visibleItems);
  visibleRef.current = visibleItems;
  useEffect(() => {
    // Mutation selection always names the current filtered, loaded rows; it is never persisted.
    const ids = new Set(visibleItems.map((item) => item.itemId));
    setSelected((prev) => Object.fromEntries(Object.keys(prev).filter((id) => ids.has(id)).map((id) => [id, true as const])));
    if (!loading && !error) setSelectedId((id) => id && ids.has(id) ? id : null);
  }, [visibleItems, loading, error]);
  const selectedCount = visibleItems.filter((item) => selected[item.itemId]).length;
  const bulkCanonical = resolveCanonicalBrand(bulkBrand, brandOptions);
  const bulkMappedDomain = bulkCanonical ? brandDomainMap.get(brandKeyOf(bulkCanonical)) ?? null : null;
  const bulkExempt = strategyFactsFor(bulkCanonical)?.suppressMissingDomain ?? false;
  const runBulkAssign = async (value = bulkBrand) => {
    const canonical = resolveCanonicalBrand(value, brandOptionsRef.current);
    const ids = visibleRef.current.filter((item) => selectedRef.current[item.itemId]).map((item) => item.itemId);
    if (context.current !== origin || !canonical || ids.length === 0 || bulkSaving || domainDraft.value.trim() || domainDraft.saving) return;
    const gen = generation.current;
    const current = () => context.current === origin && generation.current === gen;
    const domainToAdd = !brandDomainMap.has(brandKeyOf(canonical)) && !strategyFactsFor(canonical)?.suppressMissingDomain ? bulkDomain.trim() : '';
    setBulkSaving(true); setBulkError(null);
    try {
      const result = await assignBrandGroup(batchId, ids, canonical);
      if (!current()) return;
      if (domainToAdd) { await assignBatchBrandDomain(batchId, canonical, domainToAdd); if (!current()) return; }
      registerBrandOption(canonical);
      setBulkBrand(''); setBulkDomain('');
      await refreshEpoch();
      if (context.current !== origin) return;
      const skipped = (result.skippedBrandConflicts ?? []).filter((s) => visibleRef.current.some((item) => item.itemId === s.itemId));
      if (skipped.length > 0) {
        setSelected(Object.fromEntries(skipped.map((s) => [s.itemId, true as const])));
        setBulkError(`${skipped.length} item${skipped.length === 1 ? '' : 's'} collecting — brand unchanged; retry after the run settles.`);
      }
    } catch (err) { if (current()) setBulkError(err instanceof Error ? err.message : String(err)); }
    finally { if (context.current === origin) setBulkSaving(false); }
  };

  const intakeDetails = (item: OnboardingWorkState) => {
    const flags = deriveIntakeFlags(item, brandDomainMap, profileDomains);
    const view = item.brand ? strategyViews.get(brandKeyOf(item.brand)) ?? null : null;
    const decision = collectionByItem[item.itemId];
    const facts = collectionFactsFor(decision);
    const strategy: RowStrategyReadiness = decision ? {
      label: decision.label, explanation: decision.explanation, strategyLabel: decision.strategyLabel,
      suppressMissingDomain: facts?.suppressMissingDomain ?? false, canCollect: decision.canCollect,
    } : deriveStrategyReadiness(view, strategiesLoaded, strategiesError);
    return { flags, view, decision, strategy };
  };
  const selectedItem = visibleItems.find((item) => item.itemId === selectedId) ?? null;
  const selectedDetail = selectedItem ? intakeDetails(selectedItem) : null;
  const selectDetail = (item: OnboardingWorkState, section: SourceDetailSection, invoker: HTMLElement) => {
    if (context.current !== origin || strategyDialogDirty.current || domainDraft.saving || (domainDraft.value.trim() && domainDraft.itemId !== item.itemId)) return;
    detailLastFocus.current = invoker;
    setSelectedId(item.itemId); setDetailSection(section); setFocusVersion((v) => v + 1);
  };
  const closeDetail = () => {
    if (domainDraft.saving || domainDraft.value.trim()) return;
    setSelectedId(null); detailLastFocus.current?.focus();
  };
  const runDomainSave = async (item: OnboardingWorkState) => {
    const value = domainDraft.itemId === item.itemId && domainDraft.brand === item.brand ? domainDraft.value.trim() : '';
    if (context.current !== origin || !value || !item.brand || domainDraft.saving || !itemsRef.current.some((row) => row.itemId === item.itemId && row.brand === item.brand)) return;
    const gen = generation.current;
    setDomainDraft((prev) => ({ ...prev, saving: true, error: null }));
    try {
      await assignBatchBrandDomain(batchId, item.brand, value);
      if (context.current !== origin || generation.current !== gen) return;
      setDomainDraft({ itemId: '', brand: '', value: '', saving: false, error: null });
      await refreshEpoch();
    } catch (err) {
      if (context.current !== origin || generation.current !== gen) return;
      setDomainDraft((prev) => ({ ...prev, saving: false, error: err instanceof Error ? err.message : String(err) }));
    }
  };
  const openStrategy = (item: OnboardingWorkState, invoker: HTMLElement) => {
    if (context.current !== origin || !item.brand || strategyDialogDirty.current || domainDraft.value.trim() || domainDraft.saving) return;
    strategyLastFocus.current = invoker; strategyDialogDirty.current = false;
    setSelectedId(item.itemId); setDetailSection('strategy'); setStrategyBuilderKey((k) => k + 1);
    setStrategyDialog({ brand: item.brand, itemId: item.itemId, origin });
  };
  const closeStrategy = useCallback(() => {
    setStrategyDialog(null); strategyDialogDirty.current = false; strategyLastFocus.current?.focus();
  }, []);
  const requestCloseStrategy = useCallback(() => { if (!strategyDialogDirty.current) closeStrategy(); }, [closeStrategy]);
  const closeGap = useCallback(() => { setGapDialog(null); gapLastFocus.current?.focus(); }, []);
  useEffect(() => {
    if (!strategyDialog && !gapDialog) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (strategyDialog) requestCloseStrategy(); else closeGap(); } };
    window.addEventListener('keydown', onKey);
    if (strategyDialog) strategyCard.current?.focus(); else gapCard.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [strategyDialog, gapDialog, requestCloseStrategy, closeGap]);
  const strategyAssignmentHold = Object.values(drafts).some((d) => d.saving) || bulkSaving
    ? { reason: 'Brand assignment in progress — Save strategy unlocks when it settles' }
    : strategyDialog && !loading && !items.some((item) => item.itemId === strategyDialog.itemId && item.brand === strategyDialog.brand)
      ? { reason: 'Product or brand changed — close and reopen the current product strategy' } : null;
  const openProfile = (item: OnboardingWorkState, domain: string) => {
    if (context.current !== origin || strategyDialogDirty.current || domainDraft.value.trim() || domainDraft.saving) return;
    if (onOpenProfileBuilder) onOpenProfileBuilder(domain);
    else {
      const path = getProfileWorkspacePath(domain, {
        returnPath: `${window.location.pathname}${window.location.search}`,
        seedUrl: (item as OnboardingWorkState & { sourceUrl?: string }).sourceUrl,
        failureReason: item.attentionReason ?? item.detail ?? undefined,
      });
      window.history.pushState(null, '', path); window.dispatchEvent(new PopStateEvent('popstate'));
    }
    onOpenSettings?.(domain);
  };
  const isIntake = stage === 'route_sources';
  const isCollection = stage === 'find_product_page' || stage === 'collect_details';
  const hasPendingEdits = Boolean(domainDraft.value.trim() || domainDraft.saving || strategyDialogDirty.current);
  const rowAction = (item: OnboardingWorkState) => {
    const { flags, strategy, decision, view } = intakeDetails(item);
    if (flags.missingBrand) return { label: 'Assign brand', section: 'source' as const };
    if (!decision && strategiesError) return { label: 'Retry checks', section: 'strategy' as const };
    if (decision && (decision.readiness === 'underway' || decision.path === 'blocked')) return { label: 'Details', section: 'strategy' as const };
    if ((decision?.readiness === 'awaiting_approval' || decision?.readiness === 'setup_attention') || (view && !view.approved)) return { label: 'Review strategy', section: 'strategy' as const };
    if (flags.distributorExempt || strategy.suppressMissingDomain) return { label: strategy.canCollect || flags.distributorExempt ? 'Details' : 'Review strategy', section: 'strategy' as const };
    if (!brandSitesLoaded) return { label: 'Check source setup', section: 'domain' as const };
    if (flags.missingDomain) return { label: 'Add domain', section: 'domain' as const };
    if (!profilesLoaded) return { label: 'Check profile', section: 'profile' as const };
    if (!flags.profileReady) return { label: 'Set up profile', section: 'profile' as const };
    return { label: strategy.canCollect ? 'Details' : 'Review strategy', section: 'strategy' as const };
  };

  // A scope change must never render the previous batch's records with new command handlers.
  if (preferenceScope !== scopeKey) {
    return <div data-testid={`stage-items-${stage}`}><p className="bws-muted">Loading stage items…</p></div>;
  }

  return (
    <div data-testid={`stage-items-${stage}`} data-onboarding-dirty={domainDraft.value.trim() || bulkBrand.trim() || strategyDialogDirty.current ? 'true' : 'false'}>
      {!compact && isIntake && <p className="bws-stage-flow-note" data-testid="stage-one-flow-note">Identify the brand and source. Qualified distributor records skip page discovery and need no extractor profile.</p>}
      <div className="bws-muted" data-testid="stage-scope-label" style={{ marginBottom: 8, fontSize: '0.75rem' }}>
        {LINEAR_STAGE_LABELS[stage]} · server-filtered · {loading && items.length === 0 ? 'loading…' : `${formatCount(items.length)} loaded products`}{nextCursor ? ' — more available' : ''}{refreshing ? ' · refreshing…' : ''}
      </div>
      {isIntake && (
        <div className="bws-facet-row" role="group" aria-label="Loaded products — intake quick filters" data-testid="intake-kpi-strip" style={{ marginBottom: 8 }}>
          <span className="bws-muted" data-testid="intake-kpi-scope">Loaded products:</span>
          {INTAKE_KPI_FILTERS.map((filter) => {
            const count = filter === 'all' ? kpiCounts.all : filter === 'missing-brand' ? kpiCounts.missingBrand : filter === 'missing-domain' ? kpiCounts.missingDomain : filter === 'distributor' ? kpiCounts.distributor : kpiCounts.ready;
            return <button key={filter} type="button" aria-pressed={kpiFilter === filter} data-testid={`intake-kpi-${filter}`} className={`bws-chip${kpiFilter === filter ? ' bws-chip-active' : ''}`} disabled={hasPendingEdits} onClick={() => setKpiFilter(kpiFilter === filter && filter !== 'all' ? 'all' : filter)}>{INTAKE_KPI_LABELS[filter]} ({formatCount(count)})</button>;
          })}
          {!brandSitesLoaded && <span className="bws-muted" data-testid="intake-kpi-domain-unknown">{brandSitesLoading ? 'Loading domain checks…' : 'Domain checks unavailable — setup counts may be partial'}</span>}
        </div>
      )}
      {stage === 'review_listings' && <div className="bws-facet-row" role="group" aria-label="Review state filter" data-testid="review-facet-row">{REVIEW_LIST_FACETS.map((f) => <button key={f} type="button" aria-pressed={facet.reviewState === f} className="bws-chip" onClick={() => setFacet({ reviewState: f })}>{REVIEW_LIST_FACET_LABELS[f]}</button>)}</div>}
      <div className="bws-filter-bar" role="search" aria-label={`Filter ${LINEAR_STAGE_LABELS[stage]}`}>
        <input type="search" className="bws-filter-input" aria-label="Search by UPC, name, or brand" placeholder="Search UPC, name, or brand…" value={q} disabled={hasPendingEdits} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 240px', minWidth: 0 }} />
        {isCollection && <select className="bws-filter-input" aria-label="Product status filter" value={facet.category ?? ''} onChange={(e) => setFacet(e.target.value ? { category: e.target.value } : {})}><option value="">All statuses</option><option value="processing">Processing</option><option value="needs_attention">Needs attention</option></select>}
      </div>
      {hasPendingEdits && <p role="status" className="bws-muted">Save or clear the domain entry, or finish the strategy dialog, before changing product context.</p>}
      {isIntake && selectedCount > 0 && (
        <div data-testid="stage-bulk-bar" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, background: colors.feedBagCream, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, padding: 12, marginBottom: 12 }}>
          <span data-testid="stage-bulk-count">{selectedCount} selected</span>
          <span className="bws-muted" style={{ fontSize: '0.75rem' }}>Selected IDs from filtered, loaded products only — not the entire batch.</span>
          <button type="button" className="bws-filter-input" disabled={bulkSaving} onClick={() => setSelected({})}>Clear</button>
          <BrandCombobox value={bulkBrand} onChange={(value) => { setBulkBrand(value); setBulkDomain(''); setBulkError(null); }} onCommit={(value) => void runBulkAssign(value)} options={brandOptions} disabled={bulkSaving || loading} ariaLabel="Brand for selected rows" placeholder="Brand for selected products" inputTestId="stage-bulk-brand-input" inputStyle={{ width: 200, maxWidth: '100%', padding: '6px 8px', border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, fontFamily: fonts.body }} />
          {bulkMappedDomain && <span data-testid="stage-bulk-domain-preview" style={{ fontSize: '0.75rem' }}>{bulkMappedDomain} · Active in Brand Hub {bulkExempt ? '(no profile needed)' : profilesLoaded ? `(${profileDomains.has(domainKeyOf(bulkMappedDomain)) ? 'Profile Ready' : 'Profile Required'})` : '(profile checks unavailable)'}</span>}
          {bulkCanonical && !bulkMappedDomain && !bulkExempt && <label style={{ fontSize: '0.75rem' }}>Optional official domain for {bulkCanonical}<input type="text" className="bws-filter-input" data-testid="stage-bulk-domain-input" aria-label={`Official domain for ${bulkCanonical}`} value={bulkDomain} disabled={bulkSaving} onChange={(e) => setBulkDomain(e.target.value)} /></label>}
          <button type="button" className="bws-filter-input" data-testid="stage-bulk-assign" disabled={bulkSaving || loading || !bulkBrand.trim() || Boolean(domainDraft.value.trim()) || domainDraft.saving} onClick={() => void runBulkAssign()}>{bulkSaving ? 'Assigning…' : 'Assign to selected'}</button>
          {bulkError && <span role="alert" data-testid="stage-bulk-error" style={{ color: colors.signetBurgundy, flexBasis: '100%' }}>{bulkError}</span>}
        </div>
      )}
      {error && <div role="alert" style={{ color: colors.signetBurgundy, padding: '12px 0' }}>Failed to load stage items: {error}{items.length > 0 ? ' — showing previously loaded products.' : ''} <button type="button" className="bws-filter-input" onClick={() => void refreshEpoch()}>Retry</button></div>}
      {loading && items.length === 0 && !error && <p className="bws-muted">Loading stage items…</p>}
      {!loading && !error && items.length === 0 && <p className="bws-muted" data-testid="stage-empty">No products in this stage match the current filters.</p>}
      {isIntake && !loading && !error && items.length > 0 && visibleItems.length === 0 && <p className="bws-muted" data-testid="intake-filter-empty">No products match the {INTAKE_KPI_LABELS[kpiFilter]} filter.</p>}
      {items.length > 0 && isIntake && (
        <div className="bws-table-scroll">
          <table className="bws-results-table">
            <thead><tr>
              <th scope="col"><input type="checkbox" data-testid="stage-select-all" aria-label="Select all filtered loaded products" disabled={loading || bulkSaving} checked={visibleItems.length > 0 && visibleItems.every((item) => selected[item.itemId])} onChange={() => setSelected(visibleItems.every((item) => selected[item.itemId]) ? {} : Object.fromEntries(visibleItems.map((item) => [item.itemId, true as const])))} /> Product</th>
              <th scope="col">Brand</th><th scope="col">Source</th><th scope="col">Status</th><th scope="col">Next action</th>
            </tr></thead>
            <tbody>{visibleItems.map((item) => {
              const { flags, strategy } = intakeDetails(item);
              const draft = drafts[item.itemId];
              const action = rowAction(item);
              return <tr key={item.itemId} aria-selected={selectedId === item.itemId}>
                <td><div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}><input type="checkbox" data-testid={`stage-select-${item.itemId}`} aria-label={`Select ${item.name || item.upc}`} checked={Boolean(selected[item.itemId])} disabled={loading || bulkSaving} onChange={() => setSelected((prev) => { const next = { ...prev }; if (next[item.itemId]) delete next[item.itemId]; else next[item.itemId] = true; return next; })} /><div><strong>{item.name || item.upc}</strong><div className="bws-muted" style={{ fontSize: '0.75rem' }}>{item.upc}{item.weight ? ` · ${item.weight}` : ''}</div></div></div></td>
                <td style={{ minWidth: 180 }}>
                  {flags.missingBrand && <span data-testid={`intake-missing-brand-${item.itemId}`} style={{ color: colors.signetBurgundy, fontSize: '0.75rem' }}>Missing Brand</span>}
                  <BrandCombobox value={draft?.brand ?? item.brand ?? ''} onChange={(value) => setDrafts((prev) => ({ ...prev, [item.itemId]: { brand: value, saving: false, error: null } }))} onCommit={(value) => void runBrandAssign(item, value)} options={brandOptions} disabled={Boolean(draft?.saving) || refreshing || loading || Boolean(domainDraft.value.trim()) || domainDraft.saving} saving={draft?.saving} commitOnBlur ariaLabel={`Brand for ${item.name || item.upc}`} placeholder="Enter brand name" inputTestId={`stage-brand-input-${item.itemId}`} inputStyle={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', border: `1px solid ${draft?.error ? colors.signetBurgundy : colors.cardBorder}`, borderRadius: rounded.md, fontFamily: fonts.body }} />
                  {draft?.error && <span role="alert" style={{ color: colors.signetBurgundy }}>{draft.error} — list unchanged.</span>}
                </td>
                <td style={{ fontSize: '0.75rem' }}>{strategy.strategyLabel !== 'Suggested sources' ? strategy.strategyLabel : sourceTypeLabel(item.sourceType)}{flags.mappedDomain && <div className="bws-muted" style={{ overflowWrap: 'anywhere' }}>{flags.mappedDomain}</div>}</td>
                <td data-testid={`intake-strategy-${item.itemId}`}><span data-testid={`intake-readiness-${item.itemId}`} title={strategy.explanation ?? undefined}>{strategy.label}</span><div className="bws-muted" style={{ fontSize: '0.75rem' }}>{item.label}</div></td>
                <td>
                  <button type="button" className="bws-filter-input" data-testid={`intake-next-action-${item.itemId}`} aria-controls={`source-detail-${item.itemId}`} aria-expanded={selectedId === item.itemId} onClick={(e) => {
                    if (action.label === 'Assign brand') { e.currentTarget.closest('tr')?.querySelector<HTMLInputElement>('input[role="combobox"]')?.focus(); return; }
                    selectDetail(item, action.section, e.currentTarget);
                    if (action.label === 'Retry checks') void refreshEpoch();
                    if (action.label === 'Review strategy') openStrategy(item, e.currentTarget);
                  }}>{action.label}</button>
                  {action.label !== 'Details' && <button type="button" className="bws-filter-input" data-testid={`intake-details-${item.itemId}`} onClick={(e) => selectDetail(item, 'source', e.currentTarget)} style={{ marginLeft: 4 }}>Details</button>}
                </td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      )}
      {isIntake && selectedItem && selectedDetail && (
        <SourceItemDetail
          item={selectedItem} flags={selectedDetail.flags} strategy={selectedDetail.strategy} section={detailSection} focusVersion={focusVersion}
          domainValue={domainDraft.itemId === selectedItem.itemId && domainDraft.brand === selectedItem.brand ? domainDraft.value : ''}
          domainSaving={domainDraft.saving} domainError={domainDraft.error} domainAvailable={brandSitesLoaded} profilesAvailable={profilesLoaded}
          domainLoading={brandSitesLoading} profilesLoading={profilesLoading}
          sources={selectedDetail.decision ? selectedDetail.decision.sourceAvailability.map((s) => ({ ...s, available: s.usable })) : selectedDetail.view?.availability ?? []}
          reasons={selectedDetail.decision?.reasons ?? []} strategyUnavailable={strategiesError && !selectedDetail.decision}
          onDomainChange={(value) => setDomainDraft({ itemId: selectedItem.itemId, brand: selectedItem.brand ?? '', value, saving: false, error: null })}
          onSaveDomain={() => void runDomainSave(selectedItem)} onOpenProfile={() => selectedDetail.flags.mappedDomain && openProfile(selectedItem, selectedDetail.flags.mappedDomain)}
          onReviewStrategy={(invoker) => openStrategy(selectedItem, invoker)} onRetry={() => void refreshEpoch()} onClose={closeDetail}
        />
      )}
      {items.length > 0 && !isIntake && (
        <div className="bws-table-scroll"><table className="bws-results-table">
          <thead><tr><th scope="col">Product</th><th scope="col">Status</th><th scope="col">Source</th>{stage === 'review_listings' && <th scope="col">Review</th>}{(isCollection || stage === 'prepare_listing') && <th scope="col">Next action</th>}</tr></thead>
          <tbody>{items.map((item) => <tr key={item.itemId} aria-selected={selectedId === item.itemId}>
            <td><strong>{item.curatedTitle || item.name || item.upc}</strong><div className="bws-muted" style={{ fontSize: '0.75rem' }}>{item.upc}{item.brand ? ` · ${item.brand}` : ''}</div></td>
            <td><span className="bws-stage-badge">{item.attentionReason ? getAttentionGroupLabel(item.attentionReason) : item.activity ? getActivityBadgeLabel(item.activity) : item.label}</span>{item.detail && <div className="bws-muted" style={{ fontSize: '0.75rem' }}>{item.detail}</div>}</td>
            <td className="bws-muted">{sourceTypeLabel(item.sourceType)}{item.domain && <div style={{ fontSize: '0.75rem', overflowWrap: 'anywhere' }}>{item.domain}</div>}{item.sourceType === 'distributor_record' && <div style={{ fontSize: '0.75rem' }}>Materializes supplier details · no profile needed</div>}</td>
            {stage === 'review_listings' && <td>{item.reviewState ? reviewStateLabel(item.reviewState) : '—'}</td>}
            {isCollection && <td>{item.category === 'needs_attention' ? <button type="button" className="bws-filter-input" data-testid={`stage-next-action-${item.itemId}`} disabled={!onOpenAttentionItem || loading} title={!onOpenAttentionItem ? 'Resolver unavailable in this view' : undefined} onClick={() => { if (context.current === origin && itemsRef.current.some((row) => row.itemId === item.itemId && row.category === 'needs_attention')) { setSelectedId(item.itemId); onOpenAttentionItem?.(item.itemId); } }}>{getAttentionActionLabel(item.attentionAction)}</button> : <span className="bws-muted">{item.category === 'processing' ? 'Automatic processing' : 'No action required'}</span>}</td>}
            {stage === 'prepare_listing' && <td><button type="button" className="bws-filter-input" data-testid={`prepare-gap-open-${item.itemId}`} aria-haspopup="dialog" onClick={(e) => { gapLastFocus.current = e.currentTarget; setGapDialog({ itemId: item.itemId, itemName: item.name || item.upc }); }}>Resolve gap</button></td>}
          </tr>)}</tbody>
        </table></div>
      )}
      {nextCursor && <button type="button" className="bws-filter-input" disabled={loading} onClick={() => void load(nextCursor, facet, debouncedQ)} style={{ marginTop: 12 }}>{loading ? 'Loading…' : 'Load more'}</button>}
      {gapDialog && <div role="dialog" aria-modal="true" aria-label={`Resolve listing gap — ${gapDialog.itemName}`} data-testid="prepare-gap-dialog" style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) closeGap(); }}><div ref={gapCard} tabIndex={-1} style={dialogStyle}><GapCorrectionPanel itemId={gapDialog.itemId} itemName={gapDialog.itemName} onChanged={() => void load(null, facet, debouncedQ)} /><button type="button" onClick={closeGap}>Close</button></div></div>}
      {strategyDialog && strategyDialog.origin === origin && <div role="dialog" aria-modal="true" aria-label={`Review strategy — ${strategyDialog.brand}`} data-testid="intake-strategy-dialog" style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) requestCloseStrategy(); }}><div ref={strategyCard} tabIndex={-1} style={dialogStyle}>
        <h3 style={{ margin: '0 0 12px', fontSize: '1rem' }}>Review strategy — {strategyDialog.brand}</h3>
        <BrandStrategyBuilder key={`${brandKeyOf(strategyDialog.brand)}-${strategyBuilderKey}`} brand={strategyDialog.brand} onSaved={() => { if (context.current !== strategyDialog.origin) return; closeStrategy(); void loadIntakeRefs(); }} onCancel={closeStrategy} onDirtyChange={(dirty) => { strategyDialogDirty.current = dirty; }} assignmentHold={strategyAssignmentHold} />
      </div></div>}
    </div>
  );
}

const overlayStyle: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
const dialogStyle: React.CSSProperties = { background: colors.whiteSurface, borderRadius: rounded.lg, padding: 20, width: 640, maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto' };
