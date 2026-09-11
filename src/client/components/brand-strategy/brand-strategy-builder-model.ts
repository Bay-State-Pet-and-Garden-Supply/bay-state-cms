/**
 * B3 — pure builder model for the shared brand strategy editor.
 *
 * Settings → Brands and Stage 1 Review strategy mount the same
 * BrandStrategyBuilder; this module owns every local transformation so both
 * surfaces produce the identical guarded command. No I/O, no React.
 */
import type {
  ApproveBrandStrategy,
  BrandStrategy,
  StrategyConfiguration,
  StrategySourceRef,
} from '../../../shared/schemas/brand-strategy';

/** Exact normalized-brand identity (trim/lowercase; no folding/merging). */
export function normalizeBrandKey(brand: string): string {
  return brand.trim().toLowerCase();
}

/** Canonical identity of one typed source reference. */
export function sourceKey(ref: StrategySourceRef): string {
  if (ref.kind === 'official_page') return `official_page:${(ref.domain ?? '').trim().toLowerCase()}`;
  return `distributor_record:${(ref.distributorId ?? '').trim()}`;
}

/** Normalize + dedupe by typed identity (first occurrence wins). */
export function canonicalizeSources(sources: ReadonlyArray<StrategySourceRef>): StrategySourceRef[] {
  const seen = new Set<string>();
  const out: StrategySourceRef[] = [];
  for (const s of sources) {
    const ref: StrategySourceRef =
      s.kind === 'official_page'
        ? { kind: 'official_page', domain: (s.domain ?? '').trim().toLowerCase() }
        : { kind: 'distributor_record', distributorId: (s.distributorId ?? '').trim() };
    const key = sourceKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/** Key-set equality (order-insensitive; boundary sameness, not display order). */
export function sourceSetsEqual(
  a: ReadonlyArray<StrategySourceRef>,
  b: ReadonlyArray<StrategySourceRef>,
): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(sourceKey));
  return b.every((s) => keys.has(sourceKey(s)));
}

/** Local edit state. Initialized from the APPROVED boundary, never the drifted proposal. */
export interface BuilderEdit {
  brand: string;
  included: StrategySourceRef[];
  officialDomains: string[];
  baseRevision: number;
  baseConfigurationToken: string | null;
  usedProposal: boolean;
}

function approvedBoundary(strategy: BrandStrategy | null): StrategySourceRef[] {
  if (!strategy?.approval?.approved) return [];
  return canonicalizeSources(strategy.approvedSources ?? []);
}

function currentRevision(strategy: BrandStrategy | null): number {
  return strategy?.approval?.revision ?? 0;
}

/** Initialize an edit from the approved boundary (drifted proposal shown separately). */
export function initEditFromApproved(strategy: BrandStrategy | null, brand: string): BuilderEdit {
  return {
    brand,
    included: approvedBoundary(strategy),
    officialDomains: (strategy?.officialDomains ?? []).map((d) => d.domain),
    baseRevision: currentRevision(strategy),
    baseConfigurationToken: strategy?.configurationToken ?? null,
    usedProposal: false,
  };
}

/** "Use current proposal" / "Save current proposal as new revision": local edit only, never a write. */
export function applyProposalToEdit(edit: BuilderEdit, strategy: BrandStrategy | null): BuilderEdit {
  return {
    ...edit,
    included: canonicalizeSources(strategy?.proposalSources ?? []),
    usedProposal: true,
  };
}

export interface BuilderEditSummary {
  approvedCount: number;
  includedCount: number;
  sourcesChanged: boolean;
  configChanged: boolean;
  proposalDiffersFromApproved: boolean;
  dirty: boolean;
}

/** What changed locally versus the stored approved boundary + editable configuration. */
export function summarizeEdit(edit: BuilderEdit, strategy: BrandStrategy | null): BuilderEditSummary {
  const approved = approvedBoundary(strategy);
  const sourcesChanged = !sourceSetsEqual(edit.included, approved);
  const configChanged =
    sourceSetsEqual(
      edit.officialDomains.map((d) => ({ kind: 'official_page' as const, domain: d })),
      (strategy?.officialDomains ?? []).map((d) => ({ kind: 'official_page' as const, domain: d.domain })),
    ) === false;
  const proposal = canonicalizeSources(strategy?.proposalSources ?? []);
  const proposalDiffersFromApproved = !sourceSetsEqual(approved, proposal);
  return {
    approvedCount: approved.length,
    includedCount: edit.included.length,
    sourcesChanged,
    configChanged,
    proposalDiffersFromApproved,
    dirty: edit.brand.trim() !== (strategy?.brandKey ?? edit.brand).trim() || sourcesChanged || configChanged || edit.usedProposal,
  };
}

export interface BuilderValidation {
  ok: boolean;
  errors: string[];
}

/** Local validation summary. Server remains the authority; this only gates obvious mistakes. */
export function validateEdit(edit: BuilderEdit): BuilderValidation {
  const errors: string[] = [];
  if (!edit.brand.trim()) errors.push('Brand name is required.');
  const canonical = canonicalizeSources(edit.included);
  if (canonical.length !== edit.included.length) errors.push('Duplicate sources are not allowed.');
  if (canonical.length === 0) errors.push('Select at least one source — a strategy cannot be empty.');
  if (canonical.length > 25) errors.push('Select at most 25 sources.');
  const badOfficial = edit.included.filter(
    (s) => s.kind === 'official_page' && !(s.domain ?? '').trim(),
  );
  if (badOfficial.length > 0) errors.push('Official sources require a domain.');
  const badDistributor = edit.included.filter(
    (s) => s.kind === 'distributor_record' && !(s.distributorId ?? '').trim(),
  );
  if (badDistributor.length > 0) errors.push('Distributor sources require a distributor id.');
  if (edit.officialDomains.length > 25) errors.push('At most 25 official domains.');
  return { ok: errors.length === 0, errors };
}

/**
 * Build the single combined Save payload. Both surfaces ALWAYS send the full
 * editable configuration with its token (including save-current-proposal
 * shortcuts); source-only managers do not exist in the new UI.
 */
export function buildSavePayload(edit: BuilderEdit): ApproveBrandStrategy | { error: string } {
  const validation = validateEdit(edit);
  if (!validation.ok) return { error: validation.errors[0] };
  if (!edit.baseConfigurationToken) {
    return { error: 'Configuration token missing — refresh to get the latest strategy before saving.' };
  }
  const configuration: StrategyConfiguration = {
    officialDomains: [...edit.officialDomains],
  };
  return {
    brand: edit.brand.trim(),
    sources: canonicalizeSources(edit.included),
    expectedRevision: edit.baseRevision,
    configuration,
    expectedConfigurationToken: edit.baseConfigurationToken,
  };
}

/** Toggle one typed source in the included set (returns a new edit). */
export function toggleIncluded(edit: BuilderEdit, ref: StrategySourceRef): BuilderEdit {
  const key = sourceKey(ref);
  const has = edit.included.some((s) => sourceKey(s) === key);
  return {
    ...edit,
    included: has
      ? edit.included.filter((s) => sourceKey(s) !== key)
      : canonicalizeSources([...edit.included, ref]),
  };
}

/** Stage removal of this brand's mapping for one domain (also drops the matching included source). */
export function stageRemoveMapping(edit: BuilderEdit, domain: string): BuilderEdit {
  const host = domain.trim().toLowerCase();
  return {
    ...edit,
    officialDomains: edit.officialDomains.filter((d) => d.trim().toLowerCase() !== host),
    included: edit.included.filter(
      (s) => !(s.kind === 'official_page' && (s.domain ?? '').trim().toLowerCase() === host),
    ),
  };
}

/** Rebase local selections onto the latest projection after a 409 (operator-confirmed only). */
export function rebaseEditOntoLatest(edit: BuilderEdit, latest: BrandStrategy | null): BuilderEdit {
  return {
    ...edit,
    baseRevision: currentRevision(latest),
    baseConfigurationToken: latest?.configurationToken ?? null,
  };
}

/** Human-readable reason text for an option availability reason code. */
export function availabilityText(available: boolean, reason: string): string {
  if (available) return reason === 'ready' ? 'Ready' : `Available (${reason})`;
  const map: Record<string, string> = {
    no_profile: 'No extractor profile yet — open Profile Builder to create one.',
    profile_not_healthy: 'Extractor profile needs attention.',
    connection_disabled: 'Connector disabled — enable it in Distributors.',
    connection_not_configured: 'Connector not configured — finish setup in Distributors.',
    not_supported: 'Official collection is not supported yet — selectable, but never Ready.',
    unknown: 'Availability unknown — refresh to re-check.',
  };
  return map[reason] ?? `Unavailable (${reason})`;
}
