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
 *   Distributor record / Ready to Route) derived from loaded rows plus
 *   batch brand-domain blocker reads.
 * - Unmapped brand resolution drawer: inline domain entry per unmapped
 *   brand, saved through `assignBatchBrandDomain` (Brand Hub stays the
 *   brand→domain authority per ADR 0017 — never ad-hoc local state).
 * - Enhanced bulk brand bar: multiselect, canonical-brand autocomplete,
 *   live domain/profile preview, inline quick-add for unmapped brands.
 * - Enriched row columns: Brand (inline combobox + Missing Brand badge),
 *   Domain (domain + Profile Ready / Profile Required link /
 *   Missing Domain quick-add / distributor-exempt note), Strategy (compact
 *   readiness status + Review dialog trigger), and pipeline Status.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { colors, fonts, rounded } from '../../theme';
import { assignBrandGroup, assignItemBrand, getBrandSites, getExtractorProfiles } from '../../onboarding-api';
import { assignBatchBrandDomain, getBrandDomainBlockers } from '../../onboarding-work-api';
import { BrandStrategyBuilder } from '../brand-strategy/BrandStrategyBuilder';
import { GapCorrectionPanel } from './GapCorrectionPanel';
import { BrandCombobox } from './BrandCombobox';
import { getBrandOptions, registerBrandOption, resetBrandOptionsCache, resolveCanonicalBrand } from './brand-combobox-logic';
import {
  getStageReadItems,
  StageReadApiError,
} from '../../onboarding-stage-api';
import { STAGE_READ_LIMIT_DEFAULT } from '../../../shared/schemas/onboarding-stage-read';
import type { CollectionReadiness } from '../../../shared/schemas/onboarding-stage-read';
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
 * Ticket #125 (F1, decided): no dedicated awaiting_approval/setup_attention
 * chips — the five legacy chips stay, but they read the same per-item
 * server decisions as the table (collectionFactsFor over
 * collectionByItem, with the brand-level fallback), and the server
 * collectionReadiness/collectionPath filters narrow items + counts from
 * those same facts. Non-approved rows surface under 'all' with their
 * exact server label instead of a legacy bucket.
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
  // Ticket #125: approved distributor strategies are first-class — the
  // distributor chip names the record path, never a second-class exception.
  all: 'All Products',
  'missing-brand': 'Missing Brand',
  'missing-domain': 'Missing Domain',
  distributor: 'Distributor record',
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
  /** Collection underway for the bound generation (server fact, when known). */
  underway?: boolean;
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
  /** Persistent Ready explanation (null unless ready/ready_partial). */
  explanation: string | null;
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
  loadError = false,
): RowStrategyReadiness {
  // Ticket #125 copy ladder (exact): textual, never color-only. A failed
  // read never renders as loading; unknown data is never readiness success.
  if (loadError) {
    return { label: 'Collection readiness unavailable · Retry', explanation: null, strategyLabel: strategySummaryLabel(view), suppressMissingDomain: false, canCollect: false };
  }
  if (!loaded) {
    return { label: 'Loading collection readiness…', explanation: null, strategyLabel: 'Suggested sources', suppressMissingDomain: false, canCollect: false };
  }
  if (!view || !view.approved) {
    return { label: 'Awaiting approval', explanation: null, strategyLabel: strategySummaryLabel(view), suppressMissingDomain: false, canCollect: false };
  }
  if (view.underway === true) {
    return {
      label: `Underway · Collecting approved revision ${view.revision}`,
      explanation: null,
      strategyLabel: strategySummaryLabel(view),
      suppressMissingDomain: true,
      canCollect: false,
    };
  }
  const available = view.availability.filter((s) => s.available);
  const officialPlanned = view.sources.some((s) => s.kind === 'official_page');
  // Ticket #125 (F3): suppression is about boundary scope, not current
  // usability. An approved distributor-only boundary plans no official
  // collection, so its rows never demand domain/profile work — even while
  // every distributor leg is down (the actionable remediation is the
  // distributor connection, and the Review strategy dialog names it).
  // Official-planned boundaries keep the profile/domain surface.
  const suppressMissingDomain = !officialPlanned;
  const strategyLabel = strategySummaryLabel(view);
  if (view.readiness === 'setup_attention' || available.length === 0) {
    return { label: 'Setup attention · No usable sources', explanation: null, strategyLabel, suppressMissingDomain, canCollect: false };
  }
  // Persistent explanation: Ready never promises a match, evidence, or a listing.
  const explanation = 'Ready means collection can run. It does not guarantee a match, collected evidence, or sufficient listing information.';
  if (available.length === view.availability.length) {
    const n = available.length;
    return { label: `Ready · ${n} source${n === 1 ? '' : 's'} available`, explanation, strategyLabel, suppressMissingDomain, canCollect: true };
  }
  const n = available.length;
  return {
    label: `Ready — partial · ${n} source${n === 1 ? '' : 's'} available; website needs setup`,
    explanation,
    strategyLabel,
    suppressMissingDomain,
    canCollect: true,
  };
}

/**
 * Ticket #125: map one server-derived per-item collection decision to
 * the intake facts shape. ALWAYS non-null when a decision is present:
 * the server verdict is authoritative for the row (a retired/parked/
 * awaiting row never borrows a brand-level Ready). Approved-path rows
 * carry collect/suppress facts; any other path returns a non-approved
 * verdict with canCollect false (the row keeps its exact server label in
 * the table and contributes to no legacy KPI bucket). Null only when the
 * row has no decision (brand fallback, then legacy derivation).
 */
export function collectionFactsFor(
  decision: CollectionReadiness | undefined | null,
): IntakeStrategyFacts | null {
  if (!decision) return null;
  if (decision.path !== 'approved_strategy') {
    return { approved: false, canCollect: false, suppressMissingDomain: false };
  }
  const officialPlanned = decision.sourceAvailability.some((s) => s.kind === 'official_page');
  // Ticket #125 (F3): same boundary-scope rule as the brand-level
  // derivation — a distributor-only approved boundary never demands
  // domain/profile work, even with zero usable legs.
  return {
    approved: true,
    canCollect: decision.canCollect,
    suppressMissingDomain: !officialPlanned,
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

/**
 * Ticket #125: strategy-aware resolver for approved rows. When a row's
 * brand carries an approved strategy, the server-derived readiness governs
 * (the stale universal missing-domain/profile gate is retired for those
 * rows); all other rows keep the legacy intake derivation.
 */
export interface IntakeStrategyFacts {
  approved: boolean;
  canCollect: boolean;
  suppressMissingDomain: boolean;
}

/** Aggregate KPI counts over loaded rows (#116). */
export function countIntakeKpis(
  items: ReadonlyArray<Pick<OnboardingWorkState, 'brand' | 'sourceType' | 'domain'> & { itemId?: string }>,
  domainMap: ReadonlyMap<string, string>,
  profileDomains?: ReadonlySet<string>,
  strategyFor?: (brand: string | null) => IntakeStrategyFacts | null,
  // Ticket #125: per-item server collection decisions win over
  // brand-level facts when present (same facts as the table). Absent
  // entries fall back to strategyFor, then legacy derivation.
  collectionForItem?: (itemId: string) => IntakeStrategyFacts | null,
): IntakeKpiCounts {
  const counts: IntakeKpiCounts = { all: items.length, missingBrand: 0, missingDomain: 0, distributor: 0, ready: 0 };
  for (const item of items) {
    const perItem = item.itemId !== undefined ? (collectionForItem?.(item.itemId) ?? null) : null;
    if (perItem) {
      // A present server decision is authoritative: the row contributes
      // only to ready (via its own canCollect), never to legacy buckets
      // or a borrowed brand-level Ready.
      if (perItem.approved && perItem.canCollect) counts.ready += 1;
      continue;
    }
    const strategy = strategyFor?.(item.brand ?? null) ?? null;
    if (strategy?.approved) {
      if (strategy.canCollect) counts.ready += 1;
      continue;
    }
    const flags = deriveIntakeFlags(item, domainMap, profileDomains);
    if (flags.missingBrand) counts.missingBrand += 1;
    if (flags.missingDomain && !strategy?.suppressMissingDomain) counts.missingDomain += 1;
    if (flags.distributorExempt) counts.distributor += 1;
    if (flags.ready) counts.ready += 1;
  }
  return counts;
}

/** Client-side quick filter over loaded rows (#116). */
export function matchesIntakeFilter(
  item: Pick<OnboardingWorkState, 'brand' | 'sourceType' | 'domain'> & { itemId?: string },
  filter: IntakeKpiFilter,
  domainMap: ReadonlyMap<string, string>,
  profileDomains?: ReadonlySet<string>,
  strategyFor?: (brand: string | null) => IntakeStrategyFacts | null,
  // Ticket #125: per-item server collection decision (same facts as the
  // table) wins over brand-level facts when present for the row.
  collectionForItem?: (itemId: string) => IntakeStrategyFacts | null,
): boolean {
  if (filter === 'all') return true;
  const perItem = item.itemId !== undefined ? (collectionForItem?.(item.itemId) ?? null) : null;
  if (perItem) {
    // Authoritative server verdict: non-approved rows surface only under
    // 'all' (their exact label); approved rows follow the approved branch.
    if (!perItem.approved) return false;
    return filter === 'ready' ? perItem.canCollect : false;
  }
  const strategy = strategyFor?.(item.brand ?? null) ?? null;
  if (strategy?.approved) {
    switch (filter) {
      case 'missing-brand': return false;
      case 'missing-domain': return false;
      case 'distributor': return false;
      case 'ready': return strategy.canCollect;
    }
  }
  const flags = deriveIntakeFlags(item, domainMap, profileDomains);
  switch (filter) {
    case 'missing-brand': return flags.missingBrand;
    case 'missing-domain': return flags.missingDomain && !strategy?.suppressMissingDomain;
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
  // Ticket #125: a failed strategy read never renders as loading — rows
  // show the exact unavailable copy with a retry affordance (refresh epoch).
  const [strategiesError, setStrategiesError] = useState(false);
  const [profileDomains, setProfileDomains] = useState<ReadonlySet<string>>(new Set());
  const [kpiFilter, setKpiFilter] = useState<IntakeKpiFilter>('all');
  // Ticket #125: per-item server collection decisions keyed by item id,
  // merged across pages in load(). The Strategy column, KPI counts, and
  // quick filters prefer these over brand-level strategy views; per-item
  // blockers (corrupt/retired/query_all/zero-id/terminal) are invisible
  // to brand-level facts alone.
  const [collectionByItem, setCollectionByItem] = useState<Readonly<Record<string, CollectionReadiness>>>({});
  // Bulk quick-add domain for unmapped brands (#118).
  const [bulkDomain, setBulkDomain] = useState('');
  // Resolution drawer per-brand inputs (#117).
  const [drawerInputs, setDrawerInputs] = useState<Record<string, string>>({});
  const [drawerSaving, setDrawerSaving] = useState<Record<string, boolean>>({});
  const [drawerErrors, setDrawerErrors] = useState<Record<string, string | null>>({});
  // B5 — shared strategy editor in a modal dialog: at most one open editor
  // per normalized brand. Opening never writes; only the builder's explicit
  // Save strategy persists (one combined request). Successful Save closes
  // the dialog and reloads intake references without requeue or recollection.
  const [strategyDialog, setStrategyDialog] = useState<{ brand: string } | null>(null);
  const [strategyBuilderKey, setStrategyBuilderKey] = useState(0);
  const strategyDialogDirty = useRef(false);
  const strategyDialogLastFocus = useRef<HTMLElement | null>(null);
  const strategyDialogCardRef = useRef<HTMLDivElement | null>(null);
  // Ticket #124 — per-row gap-correction dialog for Prepare listing rows.
  // Opening never writes; only the panel's explicit submit records a
  // correction (gap clears on re-preparation validation, never on open).
  const [gapDialog, setGapDialog] = useState<{ itemId: string; itemName: string } | null>(null);
  const gapDialogLastFocus = useRef<HTMLElement | null>(null);
  const gapDialogCardRef = useRef<HTMLDivElement | null>(null);
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
    setCollectionByItem({});
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
            // Ticket #125: per-item server collection decisions ride the
            // same pages as the rows (same facts as the table). Absent on
            // older responses or non-route stages — brand-level fallback.
            setCollectionByItem(res.collectionByItem ?? {});
            isFirst = false;
          } else {
            setItems((prev) => [...prev, ...res.items]);
            if (res.collectionByItem) {
              const page = res.collectionByItem;
              setCollectionByItem((prev) => ({ ...prev, ...page }));
            }
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
  // Live mirror of loaded rows so assignment editors bind to the
  // originating brand even after re-renders (Ticket #125 epoch guard).
  const itemsRef = useRef(items);
  itemsRef.current = items;

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
          officialDomains?: Array<{ domain?: unknown }>;

          proposalSources?: Array<{ kind?: unknown; distributorId?: unknown; domain?: unknown }>;
          approvedSources?: Array<{ kind?: unknown; distributorId?: unknown; domain?: unknown }>;
          sourceAvailability?: Array<{ kind?: unknown; ref?: unknown; available?: unknown; reason?: unknown }>;
          collectionReadiness?: unknown;
        }> };
        const map = new Map<string, StrategyReadinessView>();
        for (const s of Array.isArray(body?.strategies) ? body.strategies : []) {
          const key = typeof s?.normalizedBrand === 'string' ? s.normalizedBrand.trim().toLowerCase() : '';
          if (!key || map.has(key)) continue;
          // B5 — server-owned proposal boundary. Missing proposal data
          // never authorizes a reconstructed boundary (issue #150 retired
          // the preferred-based reconstruction): the proposal stays empty
          // until the server derives one.
          const proposalSources: StrategyReadinessView['sources'] = [];
          if (Array.isArray(s?.proposalSources)) {
            for (const p of s.proposalSources) {
              if (p?.kind === 'official_page' && typeof p?.domain === 'string' && p.domain.trim()) proposalSources.push({ kind: 'official_page', domain: p.domain.trim().toLowerCase() });
              else if (p?.kind === 'distributor_record' && typeof p?.distributorId === 'string' && p.distributorId.trim()) proposalSources.push({ kind: 'distributor_record', distributorId: p.distributorId.trim() });
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
        setStrategiesError(false);
      } else {
        // Ticket #125 (F6): a non-OK strategies read is an explicit
        // failure, never an eternal Loading state.
        setStrategyViews(new Map());
        setStrategiesLoaded(false);
        setStrategiesError(true);
      }
    } catch {
      setStrategyViews(new Map());
      setStrategiesLoaded(false);
      setStrategiesError(true);
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
      // Ticket #125: request-epoch protection. The originating brand binds
      // this editor to its immutable context; late responses from another
      // batch/stage context are discarded, never applied.
      const gen = generation.current;
      const originatingBrand = itemsRef.current.find((it) => it.itemId === itemId)?.brand ?? null;
      updateDraft(itemId, { saving: true, error: null });
      try {
        await assignItemBrand(itemId, canonical, originatingBrand ?? undefined);
        if (generation.current !== gen) return;
        // Seed newly-coined brands into the local pool and in-memory cache:
        // assigning sets the item hint, and registering ensures all
        // comboboxes recognize the brand immediately without a "Create new brand" prompt.
        registerBrandOption(canonical);
        setBrandOptions((prev) =>
          prev.some((o) => o.toLowerCase() === canonical.toLowerCase()) ? prev : [...prev, canonical],
        );
        await refreshEpoch();
      } catch (err) {
        // Late failures from a discarded context never touch the new list.
        if (generation.current !== gen) return;
        updateDraft(itemId, {
          saving: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [drafts, refreshEpoch, updateDraft, setBrandOptions],
  );

  // Ticket #125: approved strategy rows are governed by the server-derived
  // strategy readiness (same facts as the table); all other rows keep the
  // legacy Brand Hub map derivation (fail-closed while loading).
  const strategyFactsFor = useCallback((brand: string | null): IntakeStrategyFacts | null => {
    if (!brand?.trim()) return null;
    const view = strategyViews.get(brandKeyOf(brand)) ?? null;
    if (!view?.approved) return null;
    const readiness = deriveStrategyReadiness(view, strategiesLoaded, strategiesError);
    return { approved: true, canCollect: readiness.canCollect, suppressMissingDomain: readiness.suppressMissingDomain };
  }, [strategyViews, strategiesLoaded, strategiesError]);

  // Ticket #125 (F1): per-item server decisions win over brand-level
  // facts. A row whose generation is corrupt/retired/query-all/parked
  // reads its own decision; rows without one keep the brand fallback.
  const collectionFactsForItem = useCallback((itemId: string): IntakeStrategyFacts | null => {
    if (stage !== 'route_sources') return null;
    return collectionFactsFor(collectionByItem[itemId] ?? null);
  }, [stage, collectionByItem]);

  // Brand Hub map is the single authority for KPI/table derivations. While
  // it loads, derivations are fail-closed (branded rows read as
  // missing-domain) and the KPI strip shows a loading notice.
  const kpiCounts = useMemo(
    () => (stage === 'route_sources' ? countIntakeKpis(items, brandDomainMap, profileDomains, strategyFactsFor, collectionFactsForItem) : null),
    [stage, items, brandDomainMap, profileDomains, strategyFactsFor, collectionFactsForItem],
  );

  const visibleItems = useMemo(
    () => (stage === 'route_sources' && kpiFilter !== 'all'
      ? items.filter((item) => matchesIntakeFilter(item, kpiFilter, brandDomainMap, profileDomains, strategyFactsFor, collectionFactsForItem))
      : items),
    [stage, items, kpiFilter, brandDomainMap, profileDomains, strategyFactsFor, collectionFactsForItem],
  );

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
      const groupResult = await assignBrandGroup(batchId, ids, canonical);
      // Ticket #125: worker-held rows keep their pins and are reported —
      // never silently skipped. They stay selected for an explicit retry.
      const skipped = groupResult.skippedBrandConflicts ?? [];
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
      if (skipped.length > 0) {
        const next: Record<string, true> = {};
        for (const s of skipped) next[s.itemId] = true;
        setSelected(next);
        setBulkError(`${skipped.length} item${skipped.length === 1 ? '' : 's'} collecting — brand unchanged; retry after the run settles.`);
      }
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

  // B5 — Review strategy dialog sharing the Settings builder and the same
  // guarded command. Viewing or opening never writes; only the builder's
  // explicit Save strategy persists (one combined request). Successful Save
  // closes the dialog and reloads intake references without requeue or
  // recollection. The open dialog is keyed by normalized brand so same-brand
  // rows share one revision.
  const openStrategyDialog = useCallback((brand: string, invoker?: HTMLElement | null) => {
    strategyDialogLastFocus.current = invoker ?? (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
    strategyDialogDirty.current = false;
    setStrategyBuilderKey((k) => k + 1);
    setStrategyDialog({ brand });
  }, []);

  const closeStrategyDialog = useCallback(() => {
    setStrategyDialog(null);
    strategyDialogDirty.current = false;
    strategyDialogLastFocus.current?.focus?.();
  }, []);

  // Ticket #125: the strategy Save stays disabled while any brand
  // assignment on this list is dirty/in-flight (the approval must pin a
  // settled brand, never a moving one).
  const strategyAssignmentHold = useMemo(() => {
    const rowBusy = Object.values(drafts).some((d) => d.saving);
    if (rowBusy || bulkSaving) {
      return { reason: 'Brand assignment in progress — Save strategy unlocks when it settles' };
    }
    return null;
  }, [drafts, bulkSaving]);

  /** Shell dismiss: refuse to discard dirty builder edits (use Cancel). */
  const requestCloseStrategyDialog = useCallback(() => {
    if (strategyDialogDirty.current) return;
    closeStrategyDialog();
  }, [closeStrategyDialog]);

  const handleStrategySaved = useCallback(async () => {
    setStrategyDialog(null);
    strategyDialogDirty.current = false;
    strategyDialogLastFocus.current?.focus?.();
    await loadIntakeRefs();
  }, [loadIntakeRefs]);

  // Escape closes the dialog (refused while the builder is dirty). The
  // overlay also handles Escape for pointer-focus parity with the Settings shell.
  useEffect(() => {
    if (!strategyDialog) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestCloseStrategyDialog();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [strategyDialog, requestCloseStrategyDialog]);

  // Move focus into the dialog on open for keyboard/screen-reader users.
  useEffect(() => {
    if (strategyDialog) strategyDialogCardRef.current?.focus?.();
  }, [strategyDialog, strategyBuilderKey]);

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
  const isPrepareStage = stage === 'prepare_listing';
  const openGapDialog = useCallback((itemId: string, itemName: string, invoker?: HTMLElement | null) => {
    gapDialogLastFocus.current = invoker ?? (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setGapDialog({ itemId, itemName });
  }, []);
  const closeGapDialog = useCallback(() => {
    setGapDialog(null);
    gapDialogLastFocus.current?.focus?.();
  }, []);
  useEffect(() => {
    if (!gapDialog) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeGapDialog();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [gapDialog, closeGapDialog]);
  useEffect(() => {
    if (gapDialog) gapDialogCardRef.current?.focus?.();
  }, [gapDialog]);

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
        <div
          className="bws-stage-flow-note"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
            backgroundColor: '#f0fdf4',
            border: '1px solid #bbf7d0',
            borderRadius: rounded.lg,
            padding: '12px 16px',
            marginBottom: 12,
          }}
          data-testid="drafts-export-row"
        >
          <div>
            <div style={{ fontWeight: 700, color: colors.uniformGreen, fontSize: '0.9375rem' }}>
              Create ShopSite Export Drafts
            </div>
            <div className="bws-muted" style={{ fontSize: '0.8125rem' }}>
              Inspect finalized products and generate draft records in a change set for the entire batch.
            </div>
          </div>
          <button
            type="button"
            data-testid="open-ready-to-export-workspace"
            className="bws-filter-input"
            style={{
              cursor: 'pointer',
              fontWeight: 600,
              color: '#ffffff',
              backgroundColor: colors.uniformGreen,
              border: `1px solid ${colors.shadowPine}`,
              borderRadius: rounded.md,
              padding: '6px 14px',
              fontSize: '0.8125rem',
            }}
            onClick={onOpenReadyToExportWorkspace}
          >
            Open ready-to-export workspace, entire batch →
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
              <th>{isDraftsStage ? 'Final product listing' : 'Product'}</th>
              <th>{isDraftsStage ? 'Draft status' : 'Stage status'}</th>
              {isReviewStage && <th>Review</th>}
              <th>Source</th>
              {isPrepareStage && <th>Listing help</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.itemId}>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {isDraftsStage && (
                      item.imageUrl ? (
                        <img
                          src={item.imageUrl}
                          alt={item.curatedTitle || item.name}
                          style={{
                            width: 44,
                            height: 44,
                            objectFit: 'contain',
                            borderRadius: rounded.md,
                            backgroundColor: colors.feedBagCream,
                            border: `1px solid ${colors.cardBorder}`,
                            padding: 2,
                            flexShrink: 0,
                          }}
                        />
                      ) : (
                        <div
                          style={{
                            width: 44,
                            height: 44,
                            borderRadius: rounded.md,
                            backgroundColor: colors.feedBagCream,
                            border: `1px solid ${colors.cardBorder}`,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: colors.mulchBrown,
                            fontSize: '0.625rem',
                            flexShrink: 0,
                          }}
                        >
                          No img
                        </div>
                      )
                    )}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, color: colors.ledgerCharcoal }}>
                        {isDraftsStage ? (item.curatedTitle || item.name || item.upc) : (item.name || item.upc)}
                      </div>
                      {isDraftsStage && Boolean(item.curatedTitle) && item.curatedTitle!.trim().toLowerCase() !== item.name.trim().toLowerCase() && (
                        <div
                          style={{
                            fontSize: '0.6875rem',
                            color: colors.mulchBrown,
                            display: 'flex',
                            gap: 4,
                            alignItems: 'baseline',
                            marginTop: 2,
                          }}
                          title="Original upload value before curation"
                        >
                          <span style={{ fontWeight: 700, color: '#64748b', fontSize: '0.625rem', textTransform: 'uppercase' }}>
                            Intake:
                          </span>
                          <span style={{ fontFamily: fonts.mono, color: '#334155' }}>
                            {item.name}
                          </span>
                        </div>
                      )}
                      <div className="bws-muted" style={{ fontSize: '0.75rem', marginTop: 1 }}>
                        {item.upc}
                        {item.brand ? ` · ${item.brand}` : ''}
                        {item.weight ? ` · ${item.weight}` : ''}
                      </div>
                    </div>
                  </div>
                </td>
                <td>
                  <span className="bws-stage-badge" title={`Recorded pipeline state: ${item.stage} / ${item.stageStatus}`}>
                    {isDraftsStage
                      ? (item.stageStatus === 'completed' ? 'Draft created' : 'Approved — ready for draft')
                      : `${item.stage} / ${item.stageStatus}`}
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
                {isPrepareStage && (
                  <td>
                    <button
                      type="button"
                      data-testid={`prepare-gap-open-${item.itemId}`}
                      aria-haspopup="dialog"
                      onClick={(e) => openGapDialog(item.itemId, item.name || item.upc, e.currentTarget)}
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
                      Resolve gap
                    </button>
                  </td>
                )}
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
              <th>Domain</th>
              <th>Strategy</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {visibleItems.map((item) => {
              const draft = drafts[item.itemId];
              const brandValue = draft?.brand ?? item.brand ?? '';
              const saving = draft?.saving ?? false;
              const flags = deriveIntakeFlags(item, brandDomainMap, profileDomains);
              const profileReady = flags.profileReady;
              // Spec #120: strategy-driven readiness from the same server
              // facts. A distributor-only approved strategy excuses Missing Domain.
              // Ticket #125 (F1): the row's own server decision wins when
              // present (per-item blockers are invisible to brand-level
              // facts); otherwise the brand-level derivation applies.
              const strategyView = item.brand ? strategyViews.get(brandKeyOf(item.brand)) ?? null : null;
              const collectionDecision = stage === 'route_sources' ? (collectionByItem[item.itemId] ?? null) : null;
              const perItemFacts = collectionFactsFor(collectionDecision);
              // The row's own decision always wins for display (its label
              // is exact even on non-approved paths: awaiting/underway/
              // parked rows never borrow a brand-level Ready). KPI/filter
              // gating uses perItemFacts (approved-path only) with the
              // brand fallback below it.
              const strategy = collectionDecision
                ? {
                    label: collectionDecision.label,
                    explanation: collectionDecision.explanation,
                    strategyLabel: collectionDecision.strategyLabel,
                    suppressMissingDomain: perItemFacts?.suppressMissingDomain ?? false,
                    canCollect: collectionDecision.canCollect,
                  }
                : deriveStrategyReadiness(strategyView, strategiesLoaded, strategiesError);
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
                  {flags.distributorExempt ? (
                    <span className="bws-muted">— (Distributor record)</span>
                  ) : flags.missingBrand ? (
                    <span className="bws-muted">—</span>
                  ) : flags.mappedDomain ? (
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span title="Official domain mapped in Brand Hub">🌐 {flags.mappedDomain}</span>
                      {strategy.suppressMissingDomain ? (
                        <span
                          data-testid={`intake-distributor-only-${item.itemId}`}
                          className="bws-muted"
                          title="Approved distributor-only strategy — official collection is out of scope, so no extractor profile is needed"
                          style={{ fontSize: '0.6875rem' }}
                        >
                          Distributor-only strategy — no profile needed
                        </span>
                      ) : profileReady ? (
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
                <td data-testid={`intake-strategy-${item.itemId}`} style={{ fontSize: '0.75rem', minWidth: 160 }}>
                  <span
                    data-testid={`intake-readiness-${item.itemId}`}
                    role="status"
                    title="Collection readiness: whether collection can run within the approved strategy"
                    style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}
                  >
                    {strategy.label}
                  </span>
                  {strategy.explanation && (
                    <span className="bws-muted" style={{ display: 'block', fontSize: '0.6875rem', marginBottom: 6 }}>
                      {strategy.explanation}
                    </span>
                  )}
                  {strategiesError && (
                    <button
                      type="button"
                      data-testid={`intake-readiness-retry-${item.itemId}`}
                      onClick={() => void refreshEpoch()}
                      style={{
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        backgroundColor: 'transparent',
                        border: `1px solid ${colors.uniformGreen}`,
                        borderRadius: rounded.md,
                        padding: '0.25rem 0.625rem',
                        cursor: 'pointer',
                        width: 'fit-content',
                        minHeight: 28,
                      }}
                    >
                      Retry
                    </button>
                  )}
                  {item.brand ? (
                    <button
                      type="button"
                      data-testid={`intake-strategy-review-${item.itemId}`}
                      aria-haspopup="dialog"
                      onClick={(e) => openStrategyDialog(item.brand as string, e.currentTarget)}
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
                      Review strategy
                    </button>
                  ) : (
                    <span className="bws-muted">—</span>
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
      {gapDialog && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Resolve listing gap — ${gapDialog.itemName}`}
          data-testid="prepare-gap-dialog"
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeGapDialog();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') closeGapDialog();
          }}
        >
          <div
            ref={gapDialogCardRef}
            tabIndex={-1}
            style={{ background: '#fff', borderRadius: 12, padding: 20, width: 560, maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 10px 30px rgba(0,0,0,0.15)', outline: 'none' }}
          >
            <GapCorrectionPanel
              itemId={gapDialog.itemId}
              itemName={gapDialog.itemName}
              onChanged={() => { void load(null, facet, debouncedQ); }}
            />
            <button type="button" onClick={closeGapDialog} style={{ marginTop: 12 }}>Close</button>
          </div>
        </div>
      )}
      {strategyDialog && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Review strategy — ${strategyDialog.brand}`}
          data-testid="intake-strategy-dialog"
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={(e) => {
            if (e.target === e.currentTarget) requestCloseStrategyDialog();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') requestCloseStrategyDialog();
          }}
        >
          <div
            ref={strategyDialogCardRef}
            tabIndex={-1}
            style={{ background: '#fff', borderRadius: 12, padding: 20, width: 640, maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 10px 30px rgba(0,0,0,0.15)', outline: 'none' }}
          >
            <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 600 }}>
              Review strategy — {strategyDialog.brand}
            </h3>
            <BrandStrategyBuilder
              key={`${brandKeyOf(strategyDialog.brand)}-${strategyBuilderKey}`}
              brand={strategyDialog.brand}
              onSaved={() => { void handleStrategySaved(); }}
              onCancel={closeStrategyDialog}
              onDirtyChange={(dirty) => { strategyDialogDirty.current = dirty; }}
              assignmentHold={strategyAssignmentHold}
            />
          </div>
        </div>
      )}
    </div>
  );
}
