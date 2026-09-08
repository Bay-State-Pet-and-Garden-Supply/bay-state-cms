/**
 * Slice 3 — Step 0 Brand setup view logic (pure, DOM-free, unit-testable).
 *
 * Council plan §6 Slice 3 composition contract: every brand authority stays
 * server-owned. This module only formats and classifies what the server
 * already derived — preflight readiness/held IDs, brand-domain blocker rows,
 * and bounded stage-read item rows. It never infers authority in the
 * browser: no provisional domains, no retailer-source taxonomy, no alias
 * inference, no new `brand_status`/`source_policy` fields.
 *
 * Empty-then-healthy is forbidden: an EMPTY brand-blocker response never
 * proves healthy mappings. Failed or still-loading reads render
 * loading/error/UNKNOWN — never healthy.
 */
import type {
  BatchPreflightResponse,
  PreflightBrandGroup,
  PreflightDomainBlocker,
} from '../../../shared/schemas/onboarding';
import type {
  BrandDomainSetupResponse,
  OnboardingWorkState,
} from '../../../shared/schemas/onboarding-work-state';

// ─── Top health: preflight coverage × blocker availability ────────────────────

export type BrandGateHealthState =
  | 'loading'
  | 'error'
  | 'unknown'
  | 'attention'
  | 'measured';

export interface BrandGateHealth {
  state: BrandGateHealthState;
  /** One-line operator headline (server values only, never inferred). */
  headline: string;
  /** Advisory detail: what is covered, what is still unknown, and why. */
  detail: string;
  /** Server-owned readiness IDs; null while unreadable. */
  readyCount: number | null;
  heldCount: number | null;
  totalItems: number | null;
  /**
   * True when the server reports ready items while siblings are still held:
   * ready items continue through the existing controlled-release flow
   * despite blocked siblings (mixed batch, no batch-wide gate).
   */
  readyCanContinue: boolean;
  /**
   * True when the parked-item (brand-domain blocker) check could not be
   * measured — the view must label it unknown, never healthy.
   */
  parkedCheckUnknown: boolean;
}

export interface BrandGateReadInputs {
  preflight: BatchPreflightResponse | null;
  preflightError: string | null;
  preflightLoading: boolean;
  blockers: BrandDomainSetupResponse | null;
  blockersError: string | null;
  blockersLoading: boolean;
}

/**
 * Derive the top-of-view brand health from server reads.
 *
 * Empty/error matrix (all server-owned, never inferred):
 * - still loading with no data yet ⇒ loading
 * - both reads failed ⇒ error
 * - blockers `[]` + preflight error/loading ⇒ unknown, never healthy
 * - failed blocker read + valid preflight ⇒ preflight's measured coverage
 *   only, parked-item check unknown
 * - blockers `[]` + successful preflight with missing mappings ⇒ mapping
 *   warning (attention), never all-green
 * - both succeed with complete coverage ⇒ measured mapping coverage —
 *   explicitly NOT worker/source-authority approval
 */
export function deriveBrandGateHealth(inputs: BrandGateReadInputs): BrandGateHealth {
  const { preflight, preflightError, preflightLoading, blockers, blockersError, blockersLoading } = inputs;

  if ((preflightLoading || blockersLoading) && !preflight && !blockers) {
    return {
      state: 'loading',
      headline: 'Checking brand mappings…',
      detail: 'Loading preflight readiness and brand-domain checks from the server.',
      readyCount: null,
      heldCount: null,
      totalItems: null,
      readyCanContinue: false,
      parkedCheckUnknown: true,
    };
  }

  if (preflightError && blockersError) {
    return {
      state: 'error',
      headline: 'Brand checks unavailable',
      detail: `Preflight read failed (${preflightError}); brand-domain check failed (${blockersError}). Mapping health is unknown — nothing here is marked healthy.`,
      readyCount: null,
      heldCount: null,
      totalItems: null,
      readyCanContinue: false,
      parkedCheckUnknown: true,
    };
  }

  if (!preflight) {
    // Blockers `[]` (or any blocker state) + preflight error/loading ⇒
    // unknown. An empty blocker list alone never proves healthy mappings.
    return {
      state: 'unknown',
      headline: 'Brand mapping health unknown',
      detail: preflightError
        ? `Preflight readiness could not be read (${preflightError}). An empty blocker list alone never proves mappings are healthy.`
        : 'Preflight readiness is still loading. An empty blocker list alone never proves mappings are healthy.',
      readyCount: null,
      heldCount: null,
      totalItems: null,
      readyCanContinue: false,
      parkedCheckUnknown: true,
    };
  }

  const readyCanContinue = preflight.readyCount > 0 && preflight.heldCount > 0;
  const base = {
    readyCount: preflight.readyCount,
    heldCount: preflight.heldCount,
    totalItems: preflight.totalItems,
    readyCanContinue,
  };

  if (blockersError || !blockers) {
    // Failed blocker read + valid preflight ⇒ only preflight's measured
    // coverage is displayed; the parked-item check stays unknown.
    return {
      ...base,
      state: 'attention',
      headline: `Preflight: ${preflight.readyCount} of ${preflight.totalItems} ready — parked-item check unknown`,
      detail: blockersError
        ? `Brand-domain check failed (${blockersError}), so parked items cannot be measured. Showing only the server's measured preflight coverage.`
        : 'Brand-domain check is still loading, so parked items cannot be measured yet. Showing only the server\'s measured preflight coverage.',
      parkedCheckUnknown: true,
    };
  }

  const needsBrand = preflight.blockers.needsBrandGroups.length;
  const missingDomain = preflight.blockers.missingDomainBrands.length;
  const parked = blockers.blockers.length;

  if (needsBrand === 0 && missingDomain === 0 && parked === 0) {
    return {
      ...base,
      state: 'measured',
      headline: `Measured mapping coverage: ${preflight.readyCount} of ${preflight.totalItems} ready`,
      detail: 'Both server checks succeeded with no reported gaps. This is measured mapping coverage — not worker or source-authority approval.',
      parkedCheckUnknown: false,
    };
  }

  const gaps: string[] = [];
  if (needsBrand > 0) gaps.push(`${needsBrand} brand-assignment group${needsBrand === 1 ? '' : 's'}`);
  if (missingDomain > 0) gaps.push(`${missingDomain} brand${missingDomain === 1 ? '' : 's'} missing an official domain`);
  if (parked > 0) gaps.push(`${parked} parked brand-domain group${parked === 1 ? '' : 's'}`);
  return {
    ...base,
    state: 'attention',
    headline: `Brand attention needed: ${gaps.join('; ')}`,
    detail: readyCanContinue
      ? `${preflight.readyCount} ready item${preflight.readyCount === 1 ? '' : 's'} can still continue through the existing controlled-release flow despite ${preflight.heldCount} held.`
      : 'Resolve the groups below; every fix re-reads the server before anything is marked unblocked.',
    parkedCheckUnknown: false,
  };
}

// ─── Per-item rows: server values presented, never inferred ───────────────────

export type BrandRowKind =
  | 'mapped_official'
  | 'missing_brand'
  | 'unmapped_brand'
  | 'mismatched_authority'
  | 'distributor_exempt';

export const BRAND_ROW_KIND_LABELS: Record<BrandRowKind, string> = {
  mapped_official: 'Official domain mapped',
  missing_brand: 'Missing brand',
  unmapped_brand: 'Brand assigned, domain unmapped',
  mismatched_authority: 'Official authority uncertain',
  distributor_exempt: 'Distributor path — no official domain needed',
};

export const BRAND_ROW_KIND_ADVICE: Record<BrandRowKind, string> = {
  mapped_official: 'Server reports a mapped official domain for this brand. No brand fix needed here.',
  missing_brand: 'No brand is recorded. Assigning a brand re-runs distributor lookups and official-site discovery automatically.',
  unmapped_brand: 'The brand is recorded but the server reports no mapped official domain. Map the domain (or fix it in Settings, the mapping authority).',
  mismatched_authority: 'The server reports uncertain official authority for this product, which still blocks official auto-accept. Use the frozen resolution flow — this view does not re-judge authority.',
  distributor_exempt: 'Supplier-qualified path: with no official domain and a null source URL this item stays extraction-eligible and profile-free. It is never forced through an official domain.',
};

export interface BrandRowContext {
  /** Server-reported brands with no mapped official domain (preflight missingDomainBrands). */
  unmappedBrands: ReadonlySet<string>;
  /** Server-reported parked brands (brand-domain blocker list). */
  parkedBrands: ReadonlySet<string>;
}

/** Build the row context from the two server blocker lists (case-insensitive brand keys). */
export function buildBrandRowContext(
  missingDomainBrands: ReadonlyArray<PreflightDomainBlocker>,
  parkedBlockers: BrandDomainSetupResponse['blockers'],
): BrandRowContext {
  const key = (brand: string) => brand.trim().toLowerCase();
  return {
    unmappedBrands: new Set(missingDomainBrands.map((b) => key(b.brand))),
    parkedBrands: new Set(parkedBlockers.map((b) => key(b.brand))),
  };
}

export interface ClassifiedBrandRow {
  itemId: string;
  upc: string;
  name: string;
  brand: string | null;
  sourceType: string | null;
  domain: string | null;
  kind: BrandRowKind;
  /** Server attention reason when the server parked this item (null otherwise). */
  attentionReason: string | null;
  /** Advisory copy for this row; never a new authority claim. */
  advice: string;
}

/**
 * Classify one bounded stage-read row for the per-item fix list.
 *
 * All signals are server-owned row/blocker values:
 * - distributor_exempt: server sourceType is distributor_record with no
 *   domain (null source host by contract) — extraction-eligible,
 *   profile-free, policy-v0 unchanged. Never forced through a domain.
 * - mismatched_authority: server attention reason reports uncertain
 *   official authority (verify/choose/no official URL) — still blocks
 *   official auto-accept; resolution stays in the frozen flow.
 * - missing_brand: no recorded brand (or server brand_not_provided reason).
 * - unmapped_brand: recorded brand appears in a server unmapped/parked list.
 * - mapped_official: recorded brand + domain, absent from blocker lists.
 */
export function classifyBrandRow(row: OnboardingWorkState, ctx: BrandRowContext): ClassifiedBrandRow {
  const brand = row.brand?.trim() ? row.brand : null;
  const brandKey = brand ? brand.trim().toLowerCase() : null;

  let kind: BrandRowKind;
  if (row.sourceType === 'distributor_record' && !row.domain) {
    kind = 'distributor_exempt';
  } else if (
    row.attentionReason === 'verify_official_url' ||
    row.attentionReason === 'choose_official_url' ||
    row.attentionReason === 'no_official_url'
  ) {
    kind = 'mismatched_authority';
  } else if (!brand || row.attentionReason === 'brand_not_provided') {
    kind = 'missing_brand';
  } else if (
    (brandKey && ctx.unmappedBrands.has(brandKey)) ||
    (brandKey && ctx.parkedBrands.has(brandKey))
  ) {
    kind = 'unmapped_brand';
  } else {
    kind = 'mapped_official';
  }

  return {
    itemId: row.itemId,
    upc: row.upc,
    name: row.name,
    brand,
    sourceType: row.sourceType,
    domain: row.domain ?? null,
    kind,
    attentionReason: row.attentionReason,
    advice: BRAND_ROW_KIND_ADVICE[kind],
  };
}

/** Classify a bounded page of stage-read rows (no per-item detail fetch). */
export function classifyBrandRows(
  rows: ReadonlyArray<OnboardingWorkState>,
  ctx: BrandRowContext,
): ClassifiedBrandRow[] {
  return rows.map((row) => classifyBrandRow(row, ctx));
}

// ─── Group helpers (existing preflight groups, presented as-is) ───────────────

export interface BrandGateGroups {
  needsBrandGroups: ReadonlyArray<PreflightBrandGroup>;
  missingDomainBrands: ReadonlyArray<PreflightDomainBlocker>;
  totalHeld: number;
}

/** Pass through the server's existing groups; the view never regroups items itself. */
export function selectBrandGateGroups(preflight: BatchPreflightResponse | null): BrandGateGroups {
  return {
    needsBrandGroups: preflight?.blockers.needsBrandGroups ?? [],
    missingDomainBrands: preflight?.blockers.missingDomainBrands ?? [],
    totalHeld: preflight?.heldCount ?? 0,
  };
}
