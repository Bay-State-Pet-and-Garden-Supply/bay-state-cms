/**
 * Slice 2 — stage-scoped item list over server-filtered v2 stage reads.
 *
 * Server-authoritative: every filter (stage, stageStatus, category,
 * reviewState, sourceType, q) is sent to
 * GET /api/onboarding/v2/batches/:id/stage-work-state/items via
 * `src/client/onboarding-stage-api.ts`. The client sends limit 50 explicitly
 * and follows cursors; it never derives totals from fetched-page lengths.
 *
 * Stage 1 ("Identify & Route Sources", issues #116–#119) is the unified
 * intake surface absorbing Step 0 brand-setup:
 * - Intake KPI & quick-filter strip (All / Missing Brand / Missing Domain /
 *   Distributor Fast-Path / Ready to Route) derived from loaded rows plus
 *   batch brand-domain blocker reads.
 * - Unmapped brand resolution drawer: inline domain entry per unmapped
 *   brand, saved through `assignBatchBrandDomain` (Brand Hub stays the
 *   brand→domain authority per ADR 0017 — never ad-hoc local state).
 * - Enhanced bulk brand bar: multiselect, canonical-brand autocomplete,
 *   live domain/profile preview, inline quick-add for unmapped brands.
 * - Enriched row columns: Brand (inline combobox + Missing Brand badge),
 *   Domain & Profile (domain + Profile Ready / Profile Required link /
 *   Missing Domain quick-add / distributor-exempt note), Source Route
 *   (Distributor Fast-Path / Official Site Discovery / Needs Brand-Domain),
 *   and pipeline Status.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { colors, fonts, rounded } from '../../theme';
import { assignBrandGroup, assignItemBrand, getBrandSites, getExtractorProfiles } from '../../onboarding-api';
import { assignBatchBrandDomain, getBrandDomainBlockers } from '../../onboarding-work-api';
import { BrandStrategyBuilder } from '../brand-strategy/BrandStrategyBuilder';
import { BrandCombobox } from './BrandCombobox';
import { getBrandOptions, registerBrandOption, resetBrandOptionsCache, resolveCanonicalBrand } from './brand-combobox-logic';
import {
  getStageReadItems,
  StageReadApiError,
} from '../../onboarding-stage-api';
import { STAGE_READ_LIMIT_DEFAULT } from '../../../shared/schemas/onboarding-stage-read';
import type { OnboardingWorkState } from '../../../shared/schemas/onboarding-work-state';
import type { BrandDomainSetupResponse } from '../../../shared/schemas/onboarding-work-state';
import type { StageReadQuery } from '../../onboarding-stage-api';
import type { LinearStageId } from './linear-workspace-logic';
import { LINEAR_STAGE_LABELS } from './linear-workspace-logic';
import {
  DEFAULT_REVIEW_LIST_FACET,
  REVIEW_LIST_FACETS,
  REVIEW_LIST_FACET_LABELS,
  reviewStateLabel,
  sourceTypeLabel,
  formatCount,
  type ReviewListFacet,
} from './batch-workspace-logic';
import { getProfileWorkspacePath } from '../profile-workspace/route';

export interface StageItemsViewProps {
  batchId: string;
  stage: LinearStageId;
  /** Compact mode hides the explainer (used inside PrepareListingView). */
  compact?: boolean;
  onOpenFullBatchReview?: () => void;
  /** Oracle slice: batch-wide export workspace entry inside Create drafts. */
  onOpenReadyToExportWorkspace?: () => void;
  /** Opens Settings (Profile Builder) for a domain missing an extractor profile. */
  onOpenSettings?: (domain?: string) => void;
  /** Direct hook to open Profile Builder for the specified domain. */
  onOpenProfileBuilder?: (domain: string) => void;
}

type Facet = { category?: string; reviewState?: ReviewListFacet };

/** Stage 1 quick-filter selected from the Intake KPI strip (#116).
 *
 * Follow-up gap (spec #120): strategy readiness states (awaiting_approval,
 * setup_attention) have no dedicated chip/filter yet — strategy status is
 * visible per row (Brand strategy / Collection readiness columns) but not
 * quick-filterable. See the todo test in stage-one-strategy-readiness.test.ts.
 */
export type IntakeKpiFilter = 'all' | 'missing-brand' | 'missing-domain' | 'distributor' | 'ready';

export const INTAKE_KPI_FILTERS: readonly IntakeKpiFilter[] = [
  'all',
  'missing-brand',
  'missing-domain',
  'distributor',
  'ready',
];

export const INTAKE_KPI_LABELS: Record<IntakeKpiFilter, string> = {
  all: 'All Products',
  'missing-brand': 'Missing Brand',
  'missing-domain': 'Missing Domain',
  distributor: 'Distributor Fast-Path',
  ready: 'Ready to Route',
};

const brandKeyOf = (brand: string): string => brand.trim().toLowerCase();
const domainKeyOf = (domain: string): string => domain.trim().toLowerCase();

/** Per-row intake derivations for Stage 1 (#116/#119). Pure and unit-testable. */
export interface IntakeRowFlags {
  missingBrand: boolean;
  /** Distributor-record items are exempt from brand-domain requirements. */
  distributorExempt: boolean;
  /** Mapped official domain for the row brand (null when unmapped/unbranded). */
  mappedDomain: string | null;
  missingDomain: boolean;
  /** Whether the mapped domain has an extractor profile configured. */
  profileReady: boolean;
  /** Routable now: distributor-exempt, or (branded + mapped domain + profile ready). */
  ready: boolean;
}

/**
 * Derive one row's intake state from server-owned values only: the row's
 * recorded brand/sourceType plus the Brand Hub brand→domain map (authority)
 * and the extractor-profile domain set.
 * Fail-closed while the map loads: branded rows read as missing-domain
 * until the server map arrives (the KPI strip shows a loading notice).
 * An official page row requires a configured extractor profile for its
 * mapped domain to be considered ready to route.
 */
export function deriveIntakeFlags(
  item: Pick<OnboardingWorkState, 'brand' | 'sourceType' | 'domain'>,
  domainMap: ReadonlyMap<string, string>,
  profileDomains?: ReadonlySet<string>,
): IntakeRowFlags {
  const brand = item.brand?.trim() ? item.brand.trim() : null;
  const distributorExempt = item.sourceType === 'distributor_record' && !item.domain;
  if (!brand) {
    return {
      missingBrand: true,
      distributorExempt,
      mappedDomain: null,
      missingDomain: false,
      profileReady: false,
      ready: distributorExempt,
    };
  }
  const key = brandKeyOf(brand);
  const mappedDomain = domainMap.get(key) ?? null;
  const missingDomain = !distributorExempt && mappedDomain === null;
  const profileReady = Boolean(
    mappedDomain && profileDomains && profileDomains.has(domainKeyOf(mappedDomain)),
  );
  return {
    missingBrand: false,
    distributorExempt,
    mappedDomain,
    missingDomain,
    profileReady,
    ready: distributorExempt || (!missingDomain && profileReady),
  };
}

/** Spec #120: strategy-driven collection readiness for one row (pure, unit-testable).
 *
 * "Ready" means collection can run within the approved strategy — never that
 * a product matched, evidence was collected, or a listing is complete.
 * A distributor-only approved strategy suppresses the universal Missing
 * Domain warning: no official website is required for those brands.
 */
export interface StrategyReadinessView {
  approved: boolean;
  revision: number;
  /** Effective sources: the approved boundary when approved, else the live proposal. */
  sources: Array<{ kind: 'official_page' | 'distributor_record'; distributorId?: string; domain?: string }>;
  /** Live proposal sources (for diffing against the approved boundary). */
  proposalSources?: Array<{ kind: 'official_page' | 'distributor_record'; distributorId?: string; domain?: string }>;
  /** Stored approved boundary (absent when never approved / legacy). */
  approvedSources?: Array<{ kind: 'official_page' | 'distributor_record'; distributorId?: string; domain?: string }>;
  availability: Array<{ kind: 'official_page' | 'distributor_record'; ref: string; available: boolean; reason: string }>;
  readiness: 'awaiting_approval' | 'setup_attention' | 'ready' | 'ready_partial' | 'unknown';
}

/** Order-sensitive equality of two source boundaries (proposal vs approved). */
export function strategySourcesEqual(
  a: ReadonlyArray<StrategyReadinessView['sources'][number]>,
  b: ReadonlyArray<StrategyReadinessView['sources'][number]>,
): boolean {
  if (a.length !== b.length) return false;
  return a.every((s, i) => {
    const o = b[i];
    return s.kind === o.kind
      && (s.distributorId ?? null) === (o.distributorId ?? null)
      && (s.domain ?? '').toLowerCase() === (o.domain ?? '').toLowerCase();
  });
}

export interface RowStrategyReadiness {
  /** Human-readable readiness label (text, never color-only). */
  label: string;
  /** Short strategy summary, e.g. "Phillips + BCI" or "Suggested sources". */
  strategyLabel: string;
  /** True when an approved distributor-only strategy excuses a missing domain. */
  suppressMissingDomain: boolean;
  /** True when at least one approved source can be collected from now. */
  canCollect: boolean;
}

export function strategySummaryLabel(view: StrategyReadinessView | null): string {
  if (!view) return 'Suggested sources';
  if (view.sources.length === 0) return 'Suggested sources';
  const names = view.sources.map((s) =>
    s.kind === 'official_page' ? 'Official website' : (s.distributorId ?? 'Distributor'),
  );
  return names.join(' + ');
}

export function deriveStrategyReadiness(
  view: StrategyReadinessView | null,
  loaded: boolean,
): RowStrategyReadiness {
  if (!loaded) {
    return { label: 'Loading strategy…', strategyLabel: 'Suggested sources', suppressMissingDomain: false, canCollect: false };
  }
  if (!view || !view.approved) {
    return { label: 'Awaiting strategy approval', strategyLabel: strategySummaryLabel(view), suppressMissingDomain: false, canCollect: false };
  }
  const available = view.availability.filter((s) => s.available);
  const unavailable = view.availability.filter((s) => !s.available);
  const officialPlanned = view.sources.some((s) => s.kind === 'official_page');
  const suppressMissingDomain = !officialPlanned && available.some((s) => s.kind === 'distributor_record');
  const strategyLabel = strategySummaryLabel(view);
  if (view.readiness === 'setup_attention' || available.length === 0) {
    return { label: 'Setup attention — no usable sources', strategyLabel, suppressMissingDomain, canCollect: false };
  }
  if (unavailable.length === 0) {
    const n = available.length;
    return { label: `Ready · ${n} source${n === 1 ? '' : 's'} available`, strategyLabel, suppressMissingDomain, canCollect: true };
  }
  const needsSetup = unavailable.map((s) => s.ref).join(', ');
  return {
    label: `Ready · ${available.length} available, ${needsSetup} needs setup`,
    strategyLabel,
    suppressMissingDomain,
    canCollect: true,
  };
}

/** Source-route badge kind for one row (#119). */
export type IntakeSourceRoute = 'distributor' | 'blocked' | 'discovery';

export function intakeSourceRoute(flags: IntakeRowFlags): IntakeSourceRoute {
  if (flags.distributorExempt) return 'distributor';
  if (flags.missingBrand || flags.missingDomain) return 'blocked';
  return 'discovery';
}

export interface IntakeKpiCounts {
  all: number;
  missingBrand: number;
  missingDomain: number;
  distributor: number;
  ready: number;
}

/** Aggregate KPI counts over loaded rows (#116). */
export function countIntakeKpis(
  items: ReadonlyArray<Pick<OnboardingWorkState, 'brand' | 'sourceType' | 'domain'>>,
  domainMap: ReadonlyMap<string, string>,
  profileDomains?: ReadonlySet<string>,
): IntakeKpiCounts {
  const counts: IntakeKpiCounts = { all: items.length, missingBrand: 0, missingDomain: 0, distributor: 0, ready: 0 };
  for (const item of items) {
    const flags = deriveIntakeFlags(item, domainMap, profileDomains);
    if (flags.missingBrand) counts.missingBrand += 1;
    if (flags.missingDomain) counts.missingDomain += 1;
    if (flags.distributorExempt) counts.distributor += 1;
    if (flags.ready) counts.ready += 1;
  }
  return counts;
}

/** Client-side quick filter over loaded rows (#116). */
export function matchesIntakeFilter(
  item: Pick<OnboardingWorkState, 'brand' | 'sourceType' | 'domain'>,
  filter: IntakeKpiFilter,
  domainMap: ReadonlyMap<string, string>,
  profileDomains?: ReadonlySet<string>,
): boolean {
  if (filter === 'all') return true;
  const flags = deriveIntakeFlags(item, domainMap, profileDomains);
  switch (filter) {
    case 'missing-brand': return flags.missingBrand;
    case 'missing-domain': return flags.missingDomain;
    case 'distributor': return flags.distributorExempt;
    case 'ready': return flags.ready;
  }
}

export function StageItemsView({
  batchId,
  stage,
  compact,
  onOpenFullBatchReview,
  onOpenReadyToExportWorkspace,
  onOpenSettings,
  onOpenProfileBuilder,
}: StageItemsViewProps) {
  const [items, setItems] = useState<OnboardingWorkState[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  // Review-listings defaults to Unreviewed; Reviewed / Not-ready are distinct
  // server-filtered lists. Not-ready is never folded into an awaiting count.
  const [facet, setFacet] = useState<Facet>(
    stage === 'review_listings' ? { reviewState: DEFAULT_REVIEW_LIST_FACET } : {},
  );
  const generation = useRef(0);
  // Inline brand assignment (route_sources only): per-row drafts mirroring
  // Step 0 BrandGateView BrandFixRow. The mutation path is the EXACT same
  // `assignItemBrand` call — no new endpoints; brand→domain mapping
  // authority stays in Brand Hub via assignBatchBrandDomain.
  const [drafts, setDrafts] = useState<Record<string, { brand: string; saving: boolean; error: string | null }>>({});
  const [refreshing, setRefreshing] = useState(false);
  // Checkbox multiselect (route_sources only): per-row selection driving a
  // bulk bar that calls the EXISTING assignBrandGroup(batchId, itemIds,
  // brand) client. Success flows through the existing refresh epoch below.
  const [selected, setSelected] = useState<Record<string, true>>({});
  const [bulkBrand, setBulkBrand] = useState('');
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  // Canonical brand pool for the comboboxes below (EXISTING getBrandSites
  // client: brandSites spellings + catalogBrands). Empty on failed reads —
  // inputs degrade to free-text entry, never a broken control.
  const [brandOptions, setBrandOptions] = useState<string[]>([]);
  const brandOptionsRef = useRef<string[]>([]);
  brandOptionsRef.current = brandOptions;
  // ── Stage 1 intake state (#116–#119) ─────────────────────────────────────
  // Batch brand-domain blockers (server-owned parked groups) power the
  // resolution drawer and the missing-domain fallback while brand_sites
  // loads. Brand Hub brand→domain map + extractor-profile domain set power
  // KPI counts, bulk preview, and the Domain & Profile column.
  const [blockers, setBlockers] = useState<BrandDomainSetupResponse['blockers']>([]);
  const [blockersError, setBlockersError] = useState<string | null>(null);
  const [brandDomainMap, setBrandDomainMap] = useState<ReadonlyMap<string, string>>(new Map());
  const [brandSitesLoaded, setBrandSitesLoaded] = useState(false);
  // Spec #120: approved brand strategies + per-source availability, keyed by
  // normalized brand. Same server facts back the table, chips, and details.
  const [strategyViews, setStrategyViews] = useState<ReadonlyMap<string, StrategyReadinessView>>(new Map());
  const [strategiesLoaded, setStrategiesLoaded] = useState(false);
  const [profileDomains, setProfileDomains] = useState<ReadonlySet<string>>(new Set());
  const [kpiFilter, setKpiFilter] = useState<IntakeKpiFilter>('all');
  // Bulk quick-add domain for unmapped brands (#118).
  const [bulkDomain, setBulkDomain] = useState('');
  // Resolution drawer per-brand inputs (#117).
  const [drawerInputs, setDrawerInputs] = useState<Record<string, string>>({});
  const [drawerSaving, setDrawerSaving] = useState<Record<string, boolean>>({});
  const [drawerErrors, setDrawerErrors] = useState<Record<string, string | null>>({});
  // B5 — shared strategy editor: at most one active editor per normalized
  // brand. Expanded state is brand-keyed so same-brand rows share one
  // revision; the builder mounts once in the brand's first visible row.
  const [expandedStrategyBrand, setExpandedStrategyBrand] = useState<string | null>(null);
  const [strategyFromProposal, setStrategyFromProposal] = useState(false);
  // Per-row "+ Add Domain" inline inputs (#119).
  const [rowDomainOpen, setRowDomainOpen] = useState<Record<string, boolean>>({});
  const [rowDomainInputs, setRowDomainInputs] = useState<Record<string, string>>({});
  const [rowDomainSaving, setRowDomainSaving] = useState<Record<string, boolean>>({});
  const [rowDomainErrors, setRowDomainErrors] = useState<Record<string, string | null>>({});

  useEffect(() => {
    setFacet(stage === 'review_listings' ? { reviewState: DEFAULT_REVIEW_LIST_FACET } : {});
    setQ('');
    setDebouncedQ('');
    setDrafts({});
    setRefreshing(false);
    setSelected({});
    setBulkBrand('');
    setBulkError(null);
    setBulkSaving(false);
    setBulkDomain('');
    setKpiFilter('all');
    setDrawerInputs({});
    setDrawerSaving({});
    setDrawerErrors({});
    setRowDomainOpen({});
    setRowDomainInputs({});
    setRowDomainSaving({});
    setRowDomainErrors({});
  }, [stage, batchId]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(
    async (cursor: string | null, currentFacet: Facet, query: string) => {
      const gen = generation.current;
      setLoading(true);
      try {
        let currentCursor: string | null = cursor;
        let isFirst = !cursor;
        let iter = 0;
        const maxIter = 50; // Drain up to 2500 items so batches are never artificially capped

        while (iter < maxIter) {
          iter++;
          const params: StageReadQuery = { stage, limit: STAGE_READ_LIMIT_DEFAULT };
          if (currentFacet.reviewState) params.reviewState = currentFacet.reviewState;
          if (query) params.q = query;
          if (currentCursor) params.cursor = currentCursor;
          const res = await getStageReadItems(batchId, params);
          if (generation.current !== gen) return; // batch/stage switch discards stale responses

          if (isFirst) {
            setItems(res.items);
            isFirst = false;
          } else {
            setItems((prev) => [...prev, ...res.items]);
          }
          setNextCursor(res.nextCursor);

          if (!res.nextCursor) {
            break;
          }
          currentCursor = res.nextCursor;
        }
        setError(null);
      } catch (err) {
        if (generation.current !== gen) return;
        const msg = err instanceof StageReadApiError ? `${err.message}${err.code ? ` (${err.code})` : ''}` : err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        if (generation.current === gen) setLoading(false);
      }
    },
    [batchId, stage],
  );

  useEffect(() => {
    generation.current += 1;
    setItems([]);
    setNextCursor(null);
    setError(null);
    void load(null, facet, debouncedQ);
    // Keyed on the serialized facet shape so object identity churn never
    // retriggers the fetch; only actual filter changes do.
  }, [load, JSON.stringify(facet), debouncedQ]);

  // Live mirrors of the current filter so the refresh epoch below always
  // re-reads the visible list (never a stale closure).
  const facetRef = useRef(facet);
  facetRef.current = facet;
  const queryRef = useRef(debouncedQ);
  queryRef.current = debouncedQ;

  /**
   * Intake reference reads (#116–#119): batch brand-domain blockers (drawer
   * + missing-domain signal), Brand Hub brand→domain map (KPI/preview/
   * column authority), and extractor-profile domain set (profile readiness).
   * Every read degrades to empty on failure — the table stays usable and
   * inputs degrade to free-text entry, never a broken control.
   */
  const loadIntakeRefs = useCallback(async () => {
    if (stage !== 'route_sources') return;
    try {
      const res = await getBrandDomainBlockers(batchId);
      setBlockers(Array.isArray(res?.blockers) ? res.blockers : []);
      setBlockersError(null);
    } catch (err) {
      setBlockers([]);
      setBlockersError(err instanceof Error ? err.message : String(err));
    }
    try {
      const loader = getBrandSites as unknown as (() => Promise<{ brandSites?: Array<{ brandName?: unknown; domain?: unknown }>; catalogBrands?: unknown }>) | undefined;
      if (typeof loader !== 'function') {
        setBrandDomainMap(new Map());
        setBrandSitesLoaded(false);
      } else {
        const res = await loader();
        const map = new Map<string, string>();
        for (const site of Array.isArray(res?.brandSites) ? res.brandSites : []) {
          const name = typeof site?.brandName === 'string' ? site.brandName.trim() : '';
          const domain = typeof site?.domain === 'string' ? site.domain.trim() : '';
          if (name && domain && !map.has(brandKeyOf(name))) map.set(brandKeyOf(name), domain);
        }
        setBrandDomainMap(map);
        setBrandSitesLoaded(true);
      }
    } catch {
      setBrandDomainMap(new Map());
      setBrandSitesLoaded(false);
    }
    try {
      const res = await fetch('/api/onboarding/brands/strategy');
      if (res.ok) {
        const body = await res.json() as { strategies?: Array<{
          normalizedBrand?: unknown; approval?: { approved?: unknown; revision?: unknown; approvedAt?: unknown; approvedBy?: unknown } | null;
          preferredDistributorIds?: unknown; officialDomains?: Array<{ domain?: unknown }>; fallbackTier?: unknown;
          proposalSources?: Array<{ kind?: unknown; distributorId?: unknown; domain?: unknown }>;
          approvedSources?: Array<{ kind?: unknown; distributorId?: unknown; domain?: unknown }>;
          sourceAvailability?: Array<{ kind?: unknown; ref?: unknown; available?: unknown; reason?: unknown }>;
          collectionReadiness?: unknown;
        }> };
        const map = new Map<string, StrategyReadinessView>();
        for (const s of Array.isArray(body?.strategies) ? body.strategies : []) {
          const key = typeof s?.normalizedBrand === 'string' ? s.normalizedBrand.trim().toLowerCase() : '';
          if (!key || map.has(key)) continue;
          // B5 — server-owned proposal boundary. Legacy rows without the
          // additive field fall back to the mapped-domain + preferred
          // reconstruction; the builder always reads its own detail.
          const proposalSources: StrategyReadinessView['sources'] = [];
          if (Array.isArray(s?.proposalSources)) {
            for (const p of s.proposalSources) {
              if (p?.kind === 'official_page' && typeof p?.domain === 'string' && p.domain.trim()) proposalSources.push({ kind: 'official_page', domain: p.domain.trim().toLowerCase() });
              else if (p?.kind === 'distributor_record' && typeof p?.distributorId === 'string' && p.distributorId.trim()) proposalSources.push({ kind: 'distributor_record', distributorId: p.distributorId.trim() });
            }
          } else {
          for (const d of Array.isArray(s?.officialDomains) ? s.officialDomains : []) {
            if (typeof d?.domain === 'string' && d.domain.trim()) proposalSources.push({ kind: 'official_page', domain: d.domain.trim().toLowerCase() });
          }
          for (const id of Array.isArray(s?.preferredDistributorIds) ? s.preferredDistributorIds : []) {
            if (typeof id === 'string' && id.trim()) proposalSources.push({ kind: 'distributor_record', distributorId: id.trim() });
          }
          }
          // Stored approved boundary (additive GET field; absent on legacy rows).
          const approvedSources: StrategyReadinessView['approvedSources'] = [];
          for (const a of Array.isArray(s?.approvedSources) ? s.approvedSources : []) {
            if (a?.kind === 'official_page' && typeof a?.domain === 'string' && a.domain.trim()) {
              approvedSources.push({ kind: 'official_page', domain: a.domain.trim().toLowerCase() });
            } else if (a?.kind === 'distributor_record' && typeof a?.distributorId === 'string' && a.distributorId.trim()) {
              approvedSources.push({ kind: 'distributor_record', distributorId: a.distributorId.trim() });
            }
          }
          const approved = s?.approval?.approved === true;
          const availability: StrategyReadinessView['availability'] = [];
          for (const a of Array.isArray(s?.sourceAvailability) ? s.sourceAvailability : []) {
            if ((a?.kind === 'official_page' || a?.kind === 'distributor_record') && typeof a?.ref === 'string') {
              availability.push({ kind: a.kind, ref: a.ref, available: a.available === true, reason: typeof a?.reason === 'string' ? a.reason : 'unknown' });
            }
          }
          const readiness = s?.collectionReadiness;
          map.set(key, {
            approved,
            revision: typeof s?.approval?.revision === 'number' ? s.approval.revision : 0,
            // Effective sources: the approved boundary when approved, else the proposal.
            sources: approved && approvedSources.length > 0 ? approvedSources : proposalSources,
            proposalSources,
            approvedSources,
            availability,
            readiness: readiness === 'ready' || readiness === 'ready_partial' || readiness === 'setup_attention' || readiness === 'unknown'
              ? readiness
              : 'awaiting_approval',
          });
        }
        setStrategyViews(map);
        setStrategiesLoaded(true);
      } else {
        setStrategyViews(new Map());
        setStrategiesLoaded(false);
      }
    } catch {
      setStrategyViews(new Map());
      setStrategiesLoaded(false);
    }
    try {
      const loader = getExtractorProfiles as unknown as (() => Promise<{ extractorProfiles?: Array<{ domain?: unknown }> }>) | undefined;
      if (typeof loader !== 'function') {
        setProfileDomains(new Set());
      } else {
        const res = await loader();
        const set = new Set<string>();
        for (const p of Array.isArray(res?.extractorProfiles) ? res.extractorProfiles : []) {
          if (typeof p?.domain === 'string' && p.domain.trim()) set.add(domainKeyOf(p.domain));
        }
        setProfileDomains(set);
      }
    } catch {
      setProfileDomains(new Set());
    }
  }, [batchId, stage]);

  useEffect(() => {
    if (stage !== 'route_sources') {
      setBlockers([]);
      setBlockersError(null);
      setBrandDomainMap(new Map());
      setBrandSitesLoaded(false);
      setProfileDomains(new Set());
      setStrategyViews(new Map());
      setStrategiesLoaded(false);
      return;
    }
    void loadIntakeRefs();
  }, [loadIntakeRefs, stage]);

  // Refresh epoch mirroring BrandGateView.refreshEpoch: success refetches
  // the stage list (plus intake references) from the server; rows keep
  // their server-reported state until the fresh response confirms the fix,
  // so counts/badges update.
  const refreshEpoch = useCallback(async () => {
    const gen = generation.current;
    setRefreshing(true);
    try {
      setItems([]);
      setNextCursor(null);
      setError(null);
      setDrafts({});
      setSelected({});
      setBulkError(null);
      setBulkDomain('');
      setRowDomainOpen({});
      setRowDomainErrors({});
      setRowDomainInputs({});
      await load(null, facetRef.current, queryRef.current);
      await loadIntakeRefs();
      resetBrandOptionsCache();
      const freshOpts = await getBrandOptions();
      if (generation.current === gen) setBrandOptions(freshOpts);
    } finally {
      if (generation.current === gen) setRefreshing(false);
    }
  }, [load, loadIntakeRefs]);

  const updateDraft = useCallback((itemId: string, patch: Partial<{ brand: string; saving: boolean; error: string | null }>) => {
    setDrafts((prev) => {
      const existing = prev[itemId] ?? { brand: '', saving: false, error: null };
      return { ...prev, [itemId]: { ...existing, ...patch } };
    });
  }, []);

  // One shared brand-pool read per route_sources mount (cached globally
  // in brand-combobox-logic; zero per-row requests).
  useEffect(() => {
    if (stage !== 'route_sources') {
      setBrandOptions([]);
      return;
    }
    let cancelled = false;
    void getBrandOptions().then((opts) => {
      if (!cancelled) setBrandOptions(opts);
    });
    return () => {
      cancelled = true;
    };
  }, [stage, batchId]);

  // Keep brandOptions synchronized with any brands present on visible items
  useEffect(() => {
    if (items.length === 0) return;
    const itemBrands = items
      .map((it) => it.brand?.trim())
      .filter((b): b is string => Boolean(b));
    if (itemBrands.length === 0) return;

    for (const b of itemBrands) {
      registerBrandOption(b);
    }
    setBrandOptions((prev) => {
      let changed = false;
      const next = [...prev];
      for (const b of itemBrands) {
        if (!next.some((o) => o.toLowerCase() === b.toLowerCase())) {
          next.push(b);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [items]);

  // EXACT Step 0 BrandGateView BrandFixRow mutation path: assignItemBrand,
  // then the refresh epoch above. Never locally marks an item fixed. The
  // value is canonicalized first so an existing brand typed with variant
  // casing still submits its stored brand_sites spelling (no ghost
  // brands); genuinely new brands pass through trimmed and untouched.
  const runBrandAssign = useCallback(
    async (itemId: string, value: string) => {
      const canonical = resolveCanonicalBrand(value, brandOptionsRef.current);
      if (!canonical || drafts[itemId]?.saving) return;
      updateDraft(itemId, { saving: true, error: null });
      try {
        await assignItemBrand(itemId, canonical);
        // Seed newly-coined brands into the local pool and in-memory cache:
        // assigning sets the item hint, and registering ensures all
        // comboboxes recognize the brand immediately without a "Create new brand" prompt.
        registerBrandOption(canonical);
        setBrandOptions((prev) =>
          prev.some((o) => o.toLowerCase() === canonical.toLowerCase()) ? prev : [...prev, canonical],
        );
        await refreshEpoch();
      } catch (err) {
        updateDraft(itemId, {
          saving: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [drafts, refreshEpoch, updateDraft, setBrandOptions],
  );

  // Brand Hub map is the single authority for KPI/table derivations. While
  // it loads, derivations are fail-closed (branded rows read as
  // missing-domain) and the KPI strip shows a loading notice.
  const kpiCounts = useMemo(
    () => (stage === 'route_sources' ? countIntakeKpis(items, brandDomainMap, profileDomains) : null),
    [stage, items, brandDomainMap, profileDomains],
  );

  const visibleItems = useMemo(
    () => (stage === 'route_sources' && kpiFilter !== 'all'
      ? items.filter((item) => matchesIntakeFilter(item, kpiFilter, brandDomainMap, profileDomains))
      : items),
    [stage, items, kpiFilter, brandDomainMap, profileDomains],
  );

  // B5 — first visible row per normalized brand: only that row mounts the
  // shared editor, so same-brand rows share one revision and one save.
  const firstItemIdForBrand = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of visibleItems) {
      if (!item.brand) continue;
      const key = brandKeyOf(item.brand);
      if (!map.has(key)) map.set(key, item.itemId);
    }
    return map;
  }, [visibleItems]);

  const toggleSelect = useCallback((itemId: string) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[itemId]) delete next[itemId];
      else next[itemId] = true;
      return next;
    });
    setBulkError(null);
  }, []);

  const toggleSelectAll = useCallback(() => {
    // Select-all covers the currently filtered (visible) rows (#118).
    const rows = visibleItems;
    setSelected((prev) => {
      const allSelected = rows.length > 0 && rows.every((item) => prev[item.itemId]);
      if (allSelected) return {};
      const next: Record<string, true> = {};
      for (const item of rows) next[item.itemId] = true;
      return next;
    });
    setBulkError(null);
  }, [visibleItems]);

  // Bulk brand target preview (#118): canonical spelling → Brand Hub domain
  // → extractor-profile readiness. New/unmapped brands reveal the inline
  // quick-add domain input instead of a preview badge.
  const bulkPreview = useMemo(() => {
    const trimmed = bulkBrand.trim();
    if (!trimmed) return null;
    const canonical = resolveCanonicalBrand(trimmed, brandOptionsRef.current);
    const domain = brandDomainMap.get(brandKeyOf(canonical)) ?? null;
    if (!domain) return { canonical, domain: null as string | null, profileReady: false };
    return { canonical, domain, profileReady: profileDomains.has(domainKeyOf(domain)) };
  }, [bulkBrand, brandDomainMap, profileDomains]);

  // Bulk path: the EXISTING assignBrandGroup(batchId, itemIds, brand)
  // client, then — when the operator supplied a quick-add domain — the
  // EXISTING assignBatchBrandDomain(batchId, brand, domain) client (Brand
  // Hub stays the mapping authority, ADR 0017). Ends in the refresh epoch,
  // which clears the selection. Never locally marks rows fixed.
  const runBulkAssign = useCallback(async (overrideValue?: string) => {
    const ids = Object.keys(selected);
    const canonical = resolveCanonicalBrand(overrideValue ?? bulkBrand, brandOptionsRef.current);
    if (!canonical || ids.length === 0 || bulkSaving) return;
    const domainToAdd = !brandDomainMap.has(brandKeyOf(canonical)) ? bulkDomain.trim() : '';
    setBulkSaving(true);
    setBulkError(null);
    try {
      await assignBrandGroup(batchId, ids, canonical);
      if (domainToAdd) {
        await assignBatchBrandDomain(batchId, canonical, domainToAdd);
      }
      // Same local-pool seeding as the per-row path (see runBrandAssign).
      registerBrandOption(canonical);
      setBrandOptions((prev) =>
        prev.some((o) => o.toLowerCase() === canonical.toLowerCase()) ? prev : [...prev, canonical],
      );
      setSelected({});
      setBulkBrand('');
      setBulkDomain('');
      await refreshEpoch();
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkSaving(false);
    }
  }, [selected, bulkBrand, bulkDomain, bulkSaving, batchId, refreshEpoch, brandDomainMap, setBrandOptions]);

  // Resolution drawer save (#117): persist one unmapped brand's domain to
  // Brand Hub, drop the resolved row, and refresh the stage view. Failures
  // keep the operator's input with an inline error.
  const runDrawerSave = useCallback(async (brand: string) => {
    const domain = (drawerInputs[brand] ?? '').trim();
    if (!domain || drawerSaving[brand]) return;
    setDrawerSaving((prev) => ({ ...prev, [brand]: true }));
    setDrawerErrors((prev) => ({ ...prev, [brand]: null }));
    try {
      await assignBatchBrandDomain(batchId, brand, domain);
      setDrawerInputs((prev) => {
        const next = { ...prev };
        delete next[brand];
        return next;
      });
      await refreshEpoch();
    } catch (err) {
      setDrawerErrors((prev) => ({ ...prev, [brand]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setDrawerSaving((prev) => ({ ...prev, [brand]: false }));
    }
  }, [drawerInputs, drawerSaving, batchId, refreshEpoch]);

  // Per-row "+ Add Domain" save (#119): same Brand Hub write path as the
  // drawer, scoped to the row's brand. Failures keep the input.
  const runRowDomainSave = useCallback(async (itemId: string, brand: string) => {
    const domain = (rowDomainInputs[itemId] ?? '').trim();
    if (!domain || rowDomainSaving[itemId]) return;
    setRowDomainSaving((prev) => ({ ...prev, [itemId]: true }));
    setRowDomainErrors((prev) => ({ ...prev, [itemId]: null }));
    try {
      await assignBatchBrandDomain(batchId, brand, domain);
      await refreshEpoch();
    } catch (err) {
      setRowDomainErrors((prev) => ({ ...prev, [itemId]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setRowDomainSaving((prev) => ({ ...prev, [itemId]: false }));
    }
  }, [rowDomainInputs, rowDomainSaving, batchId, refreshEpoch]);

  // B5 — Review strategy expander sharing the Settings builder and the same
  // guarded command. Viewing or expanding never writes; only the builder's
  // explicit Save strategy persists (one combined request). Successful Save
  // reloads intake references without requeue or recollection.
  const toggleStrategyEditor = useCallback((brand: string, fromProposal: boolean) => {
    const key = brandKeyOf(brand);
    setExpandedStrategyBrand((prev) => (prev === key && !fromProposal ? null : key));
    setStrategyFromProposal(fromProposal);
  }, []);

  const handleStrategySaved = useCallback(async () => {
    setExpandedStrategyBrand(null);
    setStrategyFromProposal(false);
    await loadIntakeRefs();
  }, [loadIntakeRefs]);

  const handleOpenProfileBuilder = useCallback(
    (domain: string) => {
      if (onOpenProfileBuilder) {
        onOpenProfileBuilder(domain);
      } else {
        const returnUrl = typeof window !== 'undefined' ? `${window.location.pathname}${window.location.search}` : '';
        const path = getProfileWorkspacePath(domain, returnUrl);
        if (typeof window !== 'undefined') {
          window.history.pushState(null, '', path);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }
      }
      onOpenSettings?.(domain);
    },
    [onOpenProfileBuilder, onOpenSettings],
  );

  const selectedCount = Object.keys(selected).length;

  const isRouteSourcesStage = stage === 'route_sources';

  const isReviewStage = stage === 'review_listings';
  const isDraftsStage = stage === 'create_drafts';

  return (
    <div id="bws-stage-panel" role="tabpanel" aria-labelledby={`bws-stage-tab-${stage}`} data-testid={`stage-items-${stage}`}>
      {!compact && stage === 'route_sources' && (
        <div className="bws-stage-flow-note" data-testid="stage-one-flow-note">
          <span><strong>Main flow:</strong> official product page.</span>{' '}
          <span className="bws-muted">Secondary fast path: qualified supplier record provides an alternate path skipping discovery.</span>
        </div>
      )}

      <div className="bws-muted" data-testid="stage-scope-label" style={{ margin: '0 0 6px 0', fontSize: '0.75rem' }}>
        <span>{LINEAR_STAGE_LABELS[stage]} · server-filtered · </span>
        <span>{loading && items.length === 0 ? 'loading…' : `${formatCount(items.length)} loaded row${items.length === 1 ? '' : 's'}`}</span>
        {nextCursor ? ' — more available' : ''}
        {refreshing ? ' · refreshing…' : ''}
      </div>

      {isRouteSourcesStage && kpiCounts && (
        <div
          className="bws-facet-row"
          role="group"
          aria-label="Intake summary and quick filters"
          data-testid="intake-kpi-strip"
          style={{ marginBottom: 8 }}
        >
          {INTAKE_KPI_FILTERS.map((filter) => {
            const active = kpiFilter === filter;
            const count = filter === 'all' ? kpiCounts.all
              : filter === 'missing-brand' ? kpiCounts.missingBrand
              : filter === 'missing-domain' ? kpiCounts.missingDomain
              : filter === 'distributor' ? kpiCounts.distributor
              : kpiCounts.ready;
            return (
              <button
                key={filter}
                type="button"
                aria-pressed={active}
                data-testid={`intake-kpi-${filter}`}
                className={`bws-chip${active ? ' bws-chip-active' : ''}`}
                onClick={() => setKpiFilter(active && filter !== 'all' ? 'all' : filter)}
                title={filter === 'all' ? 'Show all products' : `Filter to ${INTAKE_KPI_LABELS[filter]}`}
              >
                {INTAKE_KPI_LABELS[filter]} ({formatCount(count)})
              </button>
            );
          })}
          {!brandSitesLoaded && !blockersError && (
            <span className="bws-muted" data-testid="intake-kpi-domain-unknown" style={{ fontSize: '0.75rem' }}>
              Domain checks loading…
            </span>
          )}
        </div>
      )}

      {isRouteSourcesStage && blockersError && (
        <div role="status" data-testid="intake-blockers-unavailable" style={{ fontSize: '0.75rem', color: colors.mulchBrown, marginBottom: 8 }}>
          Brand-domain checks unavailable: {blockersError} — domain status below may be partial.
        </div>
      )}

      {isRouteSourcesStage && blockers.length > 0 && (
        <div
          data-testid="unmapped-brand-drawer"
          role="region"
          aria-label="Unmapped brand resolution"
          style={{
            backgroundColor: '#fffbeb',
            border: '1px solid #fcd34d',
            borderRadius: rounded.md,
            padding: '10px 12px',
            margin: '0 0 8px 0',
          }}
        >
          <p style={{ margin: '0 0 8px 0', fontSize: '0.8125rem', fontWeight: 700, color: colors.ledgerCharcoal }}>
            {blockers.length} brand{blockers.length === 1 ? '' : 's'} missing an official domain
          </p>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {blockers.map((blocker) => {
              const brand = blocker.brand;
              const saving = drawerSaving[brand] ?? false;
              const err = drawerErrors[brand] ?? null;
              const value = drawerInputs[brand] ?? '';
              return (
                <li
                  key={brand}
                  data-testid={`unmapped-brand-row-${brand}`}
                  style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}
                >
                  <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: colors.ledgerCharcoal }}>
                    {brand}
                    <span className="bws-muted" style={{ fontWeight: 400 }}>
                      {' '}· {formatCount(blocker.blockedItemCount)} product{blocker.blockedItemCount === 1 ? '' : 's'}
                    </span>
                  </span>
                  <label style={{ fontSize: '0.6875rem', fontWeight: 600, color: colors.mulchBrown }}>
                    Official domain / URL
                    <input
                      type="text"
                      data-testid={`unmapped-brand-input-${brand}`}
                      value={value}
                      disabled={saving}
                      placeholder="e.g. acme.com"
                      aria-label={`Official domain for ${brand}`}
                      onChange={(e) => {
                        const next = e.target.value;
                        setDrawerInputs((prev) => ({ ...prev, [brand]: next }));
                        setDrawerErrors((prev) => ({ ...prev, [brand]: null }));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void runDrawerSave(brand);
                      }}
                      style={{
                        display: 'block',
                        width: 220,
                        padding: '0.375rem 0.5rem',
                        border: `1px solid ${colors.cardBorder}`,
                        borderRadius: rounded.md,
                        fontSize: '0.8125rem',
                        fontFamily: fonts.body,
                        marginTop: 2,
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    data-testid={`unmapped-brand-save-${brand}`}
                    onClick={() => void runDrawerSave(brand)}
                    disabled={saving || !value.trim()}
                    style={{
                      backgroundColor: colors.uniformGreen,
                      border: 'none',
                      borderRadius: rounded.md,
                      padding: '0.375rem 0.75rem',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      color: colors.feedBagCream,
                      cursor: saving || !value.trim() ? 'not-allowed' : 'pointer',
                      opacity: saving || !value.trim() ? 0.6 : 1,
                      minHeight: 32,
                    }}
                  >
                    {saving ? 'Saving…' : 'Save domain'}
                  </button>
                  {err && (
                    <span role="alert" data-testid={`unmapped-brand-error-${brand}`} style={{ fontSize: '0.75rem', color: colors.signetBurgundy, flexBasis: '100%' }}>
                      {err} — nothing was saved; your entry is kept above.
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {isReviewStage && (
        <div className="bws-facet-row" role="group" aria-label="Review state filter" data-testid="review-facet-row">
          {REVIEW_LIST_FACETS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={facet.reviewState === f}
              className={`bws-chip${facet.reviewState === f ? ' bws-chip-active' : ''}`}
              onClick={() => setFacet({ reviewState: f })}
            >
              {REVIEW_LIST_FACET_LABELS[f]}
            </button>
          ))}
          {onOpenFullBatchReview && (
            <button
              type="button"
              className="bws-filter-input"
              style={{ cursor: 'pointer', fontWeight: 600, color: colors.uniformGreen }}
              onClick={onOpenFullBatchReview}
            >
              Open full-batch Review workspace
            </button>
          )}
        </div>
      )}

      {isDraftsStage && onOpenReadyToExportWorkspace && (
        <div className="bws-facet-row" role="group" aria-label="Export workspace" data-testid="drafts-export-row">
          <button
            type="button"
            data-testid="open-ready-to-export-workspace"
            className="bws-filter-input"
            style={{ cursor: 'pointer', fontWeight: 600, color: colors.uniformGreen }}
            onClick={onOpenReadyToExportWorkspace}
          >
            Open ready-to-export workspace, entire batch
          </button>
        </div>
      )}

      <div className="bws-filter-bar" role="search" aria-label={`Filter ${LINEAR_STAGE_LABELS[stage]}`}>
        <input
          type="search"
          className="bws-filter-input"
          placeholder="Search UPC, name, or brand…"
          aria-label="Search by UPC, name, or brand"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ flex: '1 1 240px', minWidth: 200 }}
        />
      </div>

      {isRouteSourcesStage && items.length > 0 && (
        <div
          data-testid="stage-bulk-bar"
          style={{
            display: selectedCount > 0 ? 'flex' : 'none',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
            backgroundColor: '#f0fdf4',
            border: '1px solid #16844D',
            borderRadius: rounded.md,
            padding: '6px 12px',
            margin: '0 0 8px 0',
            boxShadow: '0 1px 4px rgba(20, 83, 45, 0.1)',
            position: 'sticky',
            top: 0,
            zIndex: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              data-testid="stage-bulk-count"
              style={{
                fontSize: '0.75rem',
                fontWeight: 700,
                backgroundColor: colors.uniformGreen,
                color: colors.feedBagCream,
                borderRadius: rounded.full,
                padding: '2px 8px',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              {selectedCount === 0 ? 'No rows selected' : `${selectedCount} selected`}
            </span>
            {selectedCount > 0 && (
              <button
                type="button"
                onClick={() => setSelected({})}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: colors.mulchBrown,
                  fontSize: '0.75rem',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  padding: '2px 4px',
                }}
              >
                Clear
              </button>
            )}
          </div>
          <div style={{ width: 1, height: 18, backgroundColor: colors.cardBorder }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.75rem', fontWeight: 600, color: colors.ledgerCharcoal }}>
            <span>Brand for selected:</span>
            <span style={{ display: 'block', width: 200 }}>
              <BrandCombobox
                value={bulkBrand}
                onChange={(next) => { setBulkBrand(next); setBulkError(null); }}
                onCommit={(next) => void runBulkAssign(next)}
                options={brandOptions}
                disabled={bulkSaving}
                ariaLabel="Brand for selected rows"
                placeholder="Enter brand name"
                inputTestId="stage-bulk-brand-input"
                inputStyle={{
                  display: 'block',
                  width: 200,
                  padding: '0.3125rem 0.5rem',
                  border: `1px solid ${colors.cardBorder}`,
                  borderRadius: rounded.md,
                  fontSize: '0.8125rem',
                  fontFamily: fonts.body,
                  backgroundColor: colors.whiteSurface,
                }}
              />
            </span>
          </label>
          {bulkPreview && bulkPreview.domain && (
            <span
              data-testid="stage-bulk-domain-preview"
              role="status"
              style={{
                fontSize: '0.75rem',
                color: colors.ledgerCharcoal,
                backgroundColor: colors.whiteSurface,
                border: `1px solid ${colors.cardBorder}`,
                borderRadius: rounded.full,
                padding: '2px 8px',
                display: 'inline-flex',
                alignItems: 'center',
              }}
              title="Brand Hub domain mapping with extractor profile readiness"
            >
              🌐 {bulkPreview.domain} · Active in Brand Hub ({bulkPreview.profileReady ? 'Profile Ready' : 'Profile Required'})
            </span>
          )}
          {bulkPreview && !bulkPreview.domain && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.75rem', fontWeight: 600, color: colors.mulchBrown }}>
              <span>Official domain for “{bulkPreview.canonical}”:</span>
              <input
                type="text"
                data-testid="stage-bulk-domain-input"
                value={bulkDomain}
                disabled={bulkSaving}
                placeholder="e.g. acme.com"
                aria-label={`Official domain for ${bulkPreview.canonical}`}
                onChange={(e) => setBulkDomain(e.target.value)}
                style={{
                  display: 'block',
                  width: 180,
                  padding: '0.3125rem 0.5rem',
                  border: `1px solid ${colors.cardBorder}`,
                  borderRadius: rounded.md,
                  fontSize: '0.8125rem',
                  fontFamily: fonts.body,
                  backgroundColor: colors.whiteSurface,
                }}
              />
            </label>
          )}
          <button
            type="button"
            data-testid="stage-bulk-assign"
            onClick={() => void runBulkAssign()}
            disabled={bulkSaving || selectedCount === 0 || !bulkBrand.trim()}
            style={{
              backgroundColor: colors.uniformGreen,
              border: 'none',
              borderRadius: rounded.md,
              padding: '0.375rem 0.75rem',
              fontSize: '0.75rem',
              fontWeight: 600,
              color: colors.feedBagCream,
              cursor: bulkSaving || selectedCount === 0 || !bulkBrand.trim() ? 'not-allowed' : 'pointer',
              opacity: bulkSaving || selectedCount === 0 || !bulkBrand.trim() ? 0.6 : 1,
              minHeight: 28,
              marginLeft: 'auto',
            }}
          >
            {bulkSaving ? 'Assigning…' : 'Assign to selected'}
          </button>
          {bulkError && (
            <span role="alert" data-testid="stage-bulk-error" style={{ fontSize: '0.75rem', color: colors.signetBurgundy, flexBasis: '100%' }}>
              {bulkError} — list unchanged.
            </span>
          )}
        </div>
      )}

      {error && (
        <div role="alert" style={{ color: colors.signetBurgundy, padding: '0.75rem 0' }}>
          Failed to load stage items: {error}
        </div>
      )}
      {loading && items.length === 0 && !error && (
        <div className="bws-muted" style={{ padding: '1rem 0' }}>Loading stage items…</div>
      )}
      {!loading && !error && items.length === 0 && (
        <div className="bws-muted" style={{ padding: '2rem 1rem', textAlign: 'center' }} data-testid="stage-empty">
          No products in this stage match the current filters.
        </div>
      )}
      {isRouteSourcesStage && !loading && !error && items.length > 0 && visibleItems.length === 0 && (
        <div className="bws-muted" style={{ padding: '2rem 1rem', textAlign: 'center' }} data-testid="intake-filter-empty">
          No products match the {INTAKE_KPI_LABELS[kpiFilter]} filter.
        </div>
      )}
      {items.length > 0 && !isRouteSourcesStage && (
        <div className="bws-table-scroll">
        <table className="bws-results-table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Stage status</th>
              {isReviewStage && <th>Review</th>}
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.itemId}>
                <td>
                  <div style={{ fontWeight: 600, color: colors.ledgerCharcoal }}>{item.name || item.upc}</div>
                  <div className="bws-muted" style={{ fontSize: '0.75rem' }}>
                    {item.upc}
                    {item.brand ? ` · ${item.brand}` : ''}
                  </div>
                </td>
                <td>
                  <span className="bws-stage-badge" title={`Recorded pipeline state: ${item.stage} / ${item.stageStatus}`}>
                    {item.stage} / {item.stageStatus}
                  </span>
                  <div className="bws-muted" style={{ fontSize: '0.75rem' }}>{item.label}</div>
                </td>
                {isReviewStage && (
                  <td className="bws-muted" style={{ fontSize: '0.75rem' }}>
                    {item.reviewState ? reviewStateLabel(item.reviewState) : '—'}
                  </td>
                )}
                <td className="bws-muted" style={{ fontSize: '0.75rem' }}>
                  {sourceTypeLabel(item.sourceType)}
                  {item.domain ? <div style={{ fontSize: '0.6875rem' }}>{item.domain}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      {items.length > 0 && isRouteSourcesStage && (
        <div className="bws-table-scroll">
        <table className="bws-results-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  data-testid="stage-select-all"
                  aria-label="Select all filtered rows"
                  checked={visibleItems.length > 0 && visibleItems.every((item) => selected[item.itemId])}
                  onChange={toggleSelectAll}
                />
              </th>
              <th>Product</th>
              <th>Brand</th>
              <th>Brand strategy</th>
              <th>Collection readiness</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {visibleItems.map((item) => {
              const draft = drafts[item.itemId];
              const brandValue = draft?.brand ?? item.brand ?? '';
              const saving = draft?.saving ?? false;
              const flags = deriveIntakeFlags(item, brandDomainMap, profileDomains);
              const route = intakeSourceRoute(flags);
              const profileReady = flags.profileReady;
              // Spec #120: strategy-driven readiness from the same server
              // facts. A distributor-only approved strategy excuses Missing Domain.
              const strategyView = item.brand ? strategyViews.get(brandKeyOf(item.brand)) ?? null : null;
              const strategy = deriveStrategyReadiness(strategyView, strategiesLoaded);
              const showMissingDomain = flags.missingDomain && !strategy.suppressMissingDomain;
              const rowDomainErr = rowDomainErrors[item.itemId] ?? null;
              const savingRowDomain = rowDomainSaving[item.itemId] ?? false;
              return (
              <tr key={item.itemId}>
                <td>
                  <input
                    type="checkbox"
                    data-testid={`stage-select-${item.itemId}`}
                    aria-label={`Select ${item.name || item.upc}`}
                    checked={Boolean(selected[item.itemId])}
                    onChange={() => toggleSelect(item.itemId)}
                  />
                </td>
                <td>
                  <div style={{ fontWeight: 600, color: colors.ledgerCharcoal }}>{item.name || item.upc}</div>
                  <div className="bws-muted" style={{ fontSize: '0.75rem' }}>
                    {item.upc}
                    {item.weight ? ` · ${item.weight}` : ''}
                  </div>
                </td>
                <td>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 200 }}>
                    {flags.missingBrand && (
                      <span
                        data-testid={`intake-missing-brand-${item.itemId}`}
                        role="status"
                        style={{
                          display: 'inline-block',
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          color: '#fff',
                          backgroundColor: colors.signetBurgundy,
                          borderRadius: rounded.full,
                          padding: '2px 8px',
                          width: 'fit-content',
                        }}
                      >
                        ⚠️ Missing Brand
                      </span>
                    )}
                    <label style={{ fontSize: '0.6875rem', fontWeight: 600, color: colors.mulchBrown }}>
                      Brand
                      <span style={{ display: 'block', width: '100%', marginTop: 2 }}>
                        <BrandCombobox
                          value={brandValue}
                          onChange={(next) => updateDraft(item.itemId, { brand: next, error: null })}
                          onCommit={(next) => void runBrandAssign(item.itemId, next)}
                          options={brandOptions}
                          disabled={saving}
                          saving={saving}
                          commitOnBlur
                          ariaLabel={`Brand for ${item.name || item.upc}`}
                          placeholder="Enter brand name"
                          inputTestId={`stage-brand-input-${item.itemId}`}
                          inputStyle={{
                            display: 'block',
                            width: '100%',
                            paddingTop: '0.375rem',
                            paddingBottom: '0.375rem',
                            paddingLeft: '0.5rem',
                            paddingRight: saving ? '4.5rem' : '0.5rem',
                            border: `1px solid ${draft?.error ? colors.signetBurgundy : colors.cardBorder}`,
                            borderRadius: rounded.md,
                            fontSize: '0.8125rem',
                            fontFamily: fonts.body,
                          }}
                        />
                      </span>
                    </label>
                    {draft?.error && (
                      <span role="alert" style={{ fontSize: '0.75rem', color: colors.signetBurgundy }}>
                        {draft.error} — list unchanged.
                      </span>
                    )}
                  </div>
                </td>
                <td data-testid={`intake-domain-${item.itemId}`} style={{ fontSize: '0.75rem', minWidth: 180 }}>
                  <span
                    data-testid={`intake-strategy-${item.itemId}`}
                    title={strategyView?.approved ? `Approved strategy revision ${strategyView.revision}` : 'No approved strategy yet'}
                    style={{ display: 'block', fontWeight: 700, marginBottom: 4 }}
                  >
                    {strategy.strategyLabel}
                  </span>
                  {strategiesLoaded && item.brand && (() => {
                    // B5 — Review strategy expander sharing the Settings builder
                    // and the same guarded command. Rendered for every assigned
                    // brand: approved, drifted, new, or unavailable. The
                    // approved boundary stays label authority while editing;
                    // expanding never writes.
                    const brandName = item.brand as string;
                    const brandKey = brandKeyOf(brandName);
                    const approvedSources = strategyView?.approvedSources ?? [];
                    const proposalSources = strategyView?.proposalSources ?? strategyView?.sources ?? [];
                    const drifted = !!strategyView?.approved && approvedSources.length > 0
                      && !strategySourcesEqual(proposalSources, approvedSources);
                    const expanded = expandedStrategyBrand === brandKey;
                    const isFirstOfBrand = firstItemIdForBrand.get(brandKey) === item.itemId;
                    const unsupported = (strategyView?.availability ?? []).filter((a) => !a.available && a.reason === 'not_supported');
                    const editorId = `strategy-editor-${item.itemId}`;
                    return (
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 4 }}>
                      {strategyView?.approved && (
                        <span
                          data-testid={`intake-strategy-approved-${item.itemId}`}
                          title={`Approved revision ${strategyView.revision}`}
                          style={{ fontSize: '0.6875rem', color: colors.mulchBrown }}
                        >
                          Approved rev {strategyView.revision}: {strategySummaryLabel({ ...strategyView, sources: approvedSources })}{drifted ? ' — proposal differs' : ''}
                        </span>
                      )}
                      <button
                        type="button"
                        data-testid={`intake-strategy-review-${item.itemId}`}
                        aria-expanded={expanded}
                        aria-controls={editorId}
                        onClick={() => toggleStrategyEditor(brandName, false)}
                        style={{
                          fontSize: '0.75rem',
                          fontWeight: 600,
                          color: colors.uniformGreen,
                          backgroundColor: 'transparent',
                          border: `1px solid ${colors.uniformGreen}`,
                          borderRadius: rounded.md,
                          padding: '0.25rem 0.625rem',
                          cursor: 'pointer',
                          width: 'fit-content',
                          minHeight: 28,
                        }}
                      >
                        {expanded ? 'Close strategy editor' : 'Review strategy'}
                      </button>
                      {!strategyView?.approved && proposalSources.length > 0 && !expanded && (
                        <button
                          type="button"
                          data-testid={`intake-strategy-use-proposal-${item.itemId}`}
                          onClick={() => toggleStrategyEditor(brandName, true)}
                          title="Stages the live proposal locally — requires explicit Save to create a revision."
                          style={{
                            fontSize: '0.6875rem',
                            fontWeight: 400,
                            color: colors.mulchBrown,
                            backgroundColor: 'transparent',
                            border: 'none',
                            padding: 0,
                            cursor: 'pointer',
                            width: 'fit-content',
                            textDecoration: 'underline',
                          }}
                        >
                          Review proposal as new revision
                        </button>
                      )}
                      {unsupported.length > 0 && (
                        <span style={{ fontSize: '0.6875rem', color: colors.mulchBrown }}>
                          {unsupported.map((u) => u.ref).join(', ')}: official collection not yet supported — other sources still run
                        </span>
                      )}
                      {expanded && !isFirstOfBrand && (
                        <span style={{ fontSize: '0.6875rem', color: colors.mulchBrown }}>
                          Strategy editor open in this brand&apos;s first row — one editor per brand.
                        </span>
                      )}
                      {expanded && isFirstOfBrand && (
                        <span
                          id={editorId}
                          role="region"
                          aria-label={`Strategy editor for ${brandName}`}
                          data-testid={`intake-strategy-editor-${item.itemId}`}
                          style={{ display: 'block', border: `1px solid ${colors.uniformGreen}`, borderRadius: rounded.md, padding: '0.5rem', backgroundColor: '#fff' }}
                        >
                          <BrandStrategyBuilder
                            brand={brandName}
                            startFromProposal={strategyFromProposal}
                            onSaved={() => { void handleStrategySaved(); }}
                            onCancel={() => setExpandedStrategyBrand(null)}
                          />
                        </span>
                      )}
                    </span>
                    );
                  })()}
                  {flags.distributorExempt ? (
                    <span className="bws-muted">— (Distributor record)</span>
                  ) : flags.missingBrand ? (
                    <span className="bws-muted">—</span>
                  ) : flags.mappedDomain ? (
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span title="Official domain mapped in Brand Hub">🌐 {flags.mappedDomain}</span>
                      {profileReady ? (
                        <span
                          data-testid={`intake-profile-ready-${item.itemId}`}
                          role="status"
                          style={{
                            display: 'inline-block',
                            fontSize: '0.6875rem',
                            fontWeight: 700,
                            color: colors.uniformGreen,
                            backgroundColor: '#e8f3ec',
                            borderRadius: rounded.full,
                            padding: '2px 8px',
                            width: 'fit-content',
                          }}
                        >
                          Profile Ready
                        </span>
                      ) : (
                        <button
                          type="button"
                          data-testid={`intake-profile-required-${item.itemId}`}
                          onClick={() => {
                            if (flags.mappedDomain) {
                              handleOpenProfileBuilder(flags.mappedDomain);
                            } else {
                              onOpenSettings?.();
                            }
                          }}
                          title={flags.mappedDomain ? `Open Profile Builder for ${flags.mappedDomain}` : 'Open Profile Builder'}
                          style={{
                            fontSize: '0.6875rem',
                            fontWeight: 700,
                            color: '#92400e',
                            backgroundColor: '#fef3c7',
                            border: '1px solid #fcd34d',
                            borderRadius: rounded.full,
                            padding: '2px 8px',
                            cursor: 'pointer',
                            width: 'fit-content',
                          }}
                        >
                          Profile Required — open Profile Builder
                        </button>
                      )}
                    </span>
                  ) : showMissingDomain ? (
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span
                        data-testid={`intake-missing-domain-${item.itemId}`}
                        role="status"
                        style={{ fontSize: '0.75rem', fontWeight: 700, color: colors.signetBurgundy }}
                      >
                        ⚠️ Missing Domain
                      </span>
                      {!rowDomainOpen[item.itemId] ? (
                        <button
                          type="button"
                          data-testid={`intake-add-domain-${item.itemId}`}
                          onClick={() => {
                            setRowDomainOpen((prev) => ({ ...prev, [item.itemId]: true }));
                            setRowDomainErrors((prev) => ({ ...prev, [item.itemId]: null }));
                          }}
                          style={{
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            color: colors.uniformGreen,
                            backgroundColor: 'transparent',
                            border: 'none',
                            padding: 0,
                            cursor: 'pointer',
                            textAlign: 'left',
                            width: 'fit-content',
                          }}
                        >
                          + Add Domain
                        </button>
                      ) : (
                        <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <input
                            type="text"
                            data-testid={`intake-domain-input-${item.itemId}`}
                            value={rowDomainInputs[item.itemId] ?? ''}
                            disabled={savingRowDomain}
                            placeholder="e.g. acme.com"
                            aria-label={`Official domain for ${item.brand}`}
                            onChange={(e) => {
                              const next = e.target.value;
                              setRowDomainInputs((prev) => ({ ...prev, [item.itemId]: next }));
                              setRowDomainErrors((prev) => ({ ...prev, [item.itemId]: null }));
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && item.brand) void runRowDomainSave(item.itemId, item.brand);
                            }}
                            style={{
                              display: 'block',
                              width: 180,
                              padding: '0.375rem 0.5rem',
                              border: `1px solid ${colors.cardBorder}`,
                              borderRadius: rounded.md,
                              fontSize: '0.75rem',
                              fontFamily: fonts.body,
                            }}
                          />
                          <span style={{ display: 'flex', gap: 6 }}>
                            <button
                              type="button"
                              data-testid={`intake-domain-save-${item.itemId}`}
                              onClick={() => item.brand && void runRowDomainSave(item.itemId, item.brand)}
                              disabled={savingRowDomain || !(rowDomainInputs[item.itemId] ?? '').trim()}
                              style={{
                                backgroundColor: colors.uniformGreen,
                                border: 'none',
                                borderRadius: rounded.md,
                                padding: '0.25rem 0.625rem',
                                fontSize: '0.75rem',
                                fontWeight: 600,
                                color: colors.feedBagCream,
                                cursor: savingRowDomain || !(rowDomainInputs[item.itemId] ?? '').trim() ? 'not-allowed' : 'pointer',
                                opacity: savingRowDomain || !(rowDomainInputs[item.itemId] ?? '').trim() ? 0.6 : 1,
                                minHeight: 28,
                              }}
                            >
                              {savingRowDomain ? 'Saving…' : 'Save'}
                            </button>
                          </span>
                          {rowDomainErr && (
                            <span role="alert" style={{ fontSize: '0.75rem', color: colors.signetBurgundy }}>
                              {rowDomainErr} — entry kept.
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="bws-muted" title="Approved distributor-only strategy — no official website required">
                      Distributor-supported brand — no domain required
                    </span>
                  )}
                </td>
                <td data-testid={`intake-route-${item.itemId}`} style={{ fontSize: '0.75rem' }}>
                  <span
                    data-testid={`intake-readiness-${item.itemId}`}
                    role="status"
                    title="Collection readiness: whether collection can run within the approved strategy"
                    style={{ display: 'block', fontWeight: 700, marginBottom: 4 }}
                  >
                    {strategy.label}
                  </span>
                  {route === 'distributor' && (
                    <span title="Qualified distributor record — skips discovery to collect_details">📦 Distributor Fast-Path</span>
                  )}
                  {route === 'discovery' && (
                    <span title="Routed to official site discovery (find_product_page)">🌐 Official Site Discovery</span>
                  )}
                  {route === 'blocked' && !strategy.suppressMissingDomain && (
                    <span className="bws-muted" title="Parked in Stage 1 until brand/domain is resolved">⏳ Needs Brand/Domain</span>
                  )}
                </td>
                <td>
                  <span className="bws-stage-badge" title={`Recorded pipeline state: ${item.stage} / ${item.stageStatus}`}>
                    {item.stage} / {item.stageStatus}
                  </span>
                  <div className="bws-muted" style={{ fontSize: '0.75rem' }}>
                    {item.label}
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
      {nextCursor && (
        <button
          type="button"
          onClick={() => load(nextCursor, facet, debouncedQ)}
          disabled={loading}
          style={{
            marginTop: 12,
            backgroundColor: colors.whiteSurface,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: rounded.md,
            padding: '0.5rem 0.875rem',
            fontSize: '0.8125rem',
            fontWeight: 600,
            color: colors.uniformGreen,
            cursor: 'pointer',
            minHeight: 36,
          }}
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
