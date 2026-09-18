// Browser Investigation blind-holdout governance (T5).
//
// Pure holdout discipline consumed by validation enforcement (validate.ts)
// and workspace coverage display (workspace.ts). No DB, no network, no
// provider calls — Vitest-safe.
//
// Two responsibilities, neither a second health definition:
//
// 1. Exposure: a holdout must stay out of ALL model-visible inputs — sample
//    URLs, captured artifacts, failure context, reports, and metadata — not
//    just the investigation sample list. An exposed sample loses holdout
//    status for that proposal: it becomes tuning evidence (re-supplied as a
//    representative) and must be replaced by a fresh holdout.
// 2. Preference: where the corpus permits, suite selection should seek one
//    holdout per discovered structure and at least two total. This is a
//    selection preference, never an unconditional numeric gate — the hard
//    activation minimum stays exactly one passing holdout
//    (profile-activation-gate.ts). Never reveal newly discovered structure
//    details from blind pages to the investigator to improve selection; this
//    module matches only investigated structure URLs and corpus prefixes.

import type { InvestigationRecord } from '../../shared/schemas/browser-investigation';

/** Model-visible surface through which a holdout can lose blind status. */
export type HoldoutExposureVia =
  | 'sample_url'
  | 'artifact'
  | 'failure_context'
  | 'report'
  | 'metadata';

/** One holdout sample that lost blind status, with the surface that exposed it. */
export interface HoldoutExposure {
  url: string;
  via: HoldoutExposureVia;
  detail: string;
}

/** A candidate blind holdout: URL plus optional captured-artifact reference. */
export interface HoldoutCandidate {
  url: string;
  artifactRef?: string | null;
}

/**
 * Canonical holdout URL identity: trimmed with trailing slashes stripped.
 * Shared by exposure and the validation no-drop rule so slash variants
 * can neither bypass nor false-trigger holdout governance.
 */
export function normalizeHoldoutUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/** Every investigator-visible URL on a record: samples, structures, and captured observations. */
export function investigatedUrlsOf(record: InvestigationRecord): string[] {
  const urls = [...(record.inputSnapshot.sampleUrls ?? [])];
  const result = record.result;
  if (result) {
    urls.push(...structureUrlsOf(result));
    for (const observation of result.observations ?? []) {
      if (observation.sourceUrl) urls.push(observation.sourceUrl);
    }
  }
  return [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
}

function normHash(raw: string): string {
  return raw.trim().toLowerCase();
}

interface ModelVisibleSurfaces {
  sampleUrls: Set<string>;
  artifactHashes: Set<string>;
  failureText: string;
  reportText: string;
  metadataText: string;
}

function textOf(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * Collect every model-visible surface of a completed investigation: sample
 * URLs and structures (investigator inputs), observation artifact hashes
 * (captured content), failure detail (diagnostics), reports (summary,
 * evidence refs, gaps, strategy prose, observation detail), and metadata
 * (operator knownContext plus model identity). Budgets carry no page
 * content and are excluded.
 */
function structureUrlsOf(result: NonNullable<InvestigationRecord['result']>): string[] {
  return (result.structures ?? []).flatMap((s) => s.sampleUrls ?? []);
}

function observationReportParts(result: NonNullable<InvestigationRecord['result']>): string[] {
  return [
    ...(result.observations ?? []).map((o) => o.detail ?? ''),
    result.summary,
    result.recommendedStrategy ?? '',
    result.renderedBrowserReason ?? '',
    ...(result.evidenceRefs ?? []),
    ...(result.gaps ?? []),
    ...(result.fieldRecommendations ?? []).map((r) => r.evidenceRef ?? ''),
  ];
}

/** Captured observation surfaces: source URLs plus content hashes (empty fields skipped, never thrown on). */
function observationSurfaces(result: NonNullable<InvestigationRecord['result']>): { urls: string[]; hashes: string[] } {
  const urls: string[] = [];
  const hashes: string[] = [];
  for (const observation of result.observations ?? []) {
    if (observation.sourceUrl) urls.push(observation.sourceUrl);
    if (observation.artifactHash) hashes.push(observation.artifactHash);
  }
  return { urls, hashes };
}

function collectModelVisibleSurfaces(record: InvestigationRecord): ModelVisibleSurfaces {
  const result = record.result;
  const sampleUrls = new Set((record.inputSnapshot.sampleUrls ?? []).map(normalizeHoldoutUrl));
  const artifactHashes = new Set<string>();
  if (result) {
    const observed = observationSurfaces(result);
    for (const url of [...structureUrlsOf(result), ...observed.urls]) sampleUrls.add(normalizeHoldoutUrl(url));
    for (const hash of observed.hashes) artifactHashes.add(normHash(hash));
  }
  return {
    sampleUrls,
    artifactHashes,
    failureText: textOf(record.failureDetail),
    reportText: result ? observationReportParts(result).join('\n') : '',
    metadataText: [
      textOf(record.inputSnapshot.knownContext ?? {}),
      textOf(record.requestedModel),
      textOf(record.actualModel),
    ].join('\n'),
  };
}

/** One deterministic exposure probe: exact-set membership or text containment. */
interface ExposureProbe {
  via: HoldoutExposureVia;
  matches: (surfaces: ModelVisibleSurfaces, url: string, artifactRef: string | null) => boolean;
}

const EXPOSURE_PROBES: readonly ExposureProbe[] = [
  { via: 'sample_url', matches: (surfaces, url) => surfaces.sampleUrls.has(normalizeHoldoutUrl(url)) },
  { via: 'artifact', matches: (surfaces, _url, artifactRef) => !!artifactRef && surfaces.artifactHashes.has(artifactRef) },
  { via: 'failure_context', matches: (surfaces, url, artifactRef) => containsNeedle(surfaces.failureText, url, artifactRef) },
  { via: 'report', matches: (surfaces, url, artifactRef) => containsNeedle(surfaces.reportText, url, artifactRef) },
  { via: 'metadata', matches: (surfaces, url, artifactRef) => containsNeedle(surfaces.metadataText, url, artifactRef) },
];

function containsNeedle(haystack: string, url: string, artifactRef: string | null): boolean {
  // Both raw and canonical forms: a slash variant in diagnostics or
  // reports must not slip past (exposure fails closed — a false positive
  // only asks the operator for a replacement holdout).
  const needle = url.trim();
  if (needle && (haystack.includes(needle) || haystack.includes(normalizeHoldoutUrl(needle)))) return true;
  return !!artifactRef && haystack.includes(artifactRef);
}

/** First exposure surface for one holdout candidate, in deterministic probe order. */
function exposureOf(surfaces: ModelVisibleSurfaces, candidate: HoldoutCandidate): HoldoutExposureVia | null {
  const artifactRef = candidate.artifactRef?.trim() ? normHash(candidate.artifactRef) : null;
  return EXPOSURE_PROBES.find((probe) => probe.matches(surfaces, candidate.url, artifactRef))?.via ?? null;
}

const EXPOSURE_DETAIL: Readonly<Record<HoldoutExposureVia, string>> = {
  sample_url: 'the URL was an investigation sample or captured observation',
  artifact: 'its artifact was already captured during investigation',
  failure_context: 'it appears in recorded failure context',
  report: 'it appears in investigation reports or evidence refs',
  metadata: 'it appears in model-visible metadata or known context',
};

/**
 * Blindness check across ALL investigator-visible inputs. Returns one entry
 * per exposed holdout URL (empty when blind). Callers reject before any
 * worker call: exposed samples become tuning evidence and must be replaced.
 */
export function findExposedHoldouts(
  record: InvestigationRecord,
  candidates: HoldoutCandidate[],
): HoldoutExposure[] {
  const surfaces = collectModelVisibleSurfaces(record);
  const seen = new Set<string>();
  const exposures: HoldoutExposure[] = [];
  for (const candidate of candidates) {
    const url = candidate.url.trim();
    if (!url || seen.has(normalizeHoldoutUrl(url))) continue;
    seen.add(normalizeHoldoutUrl(url));
    const via = exposureOf(surfaces, candidate);
    if (via) exposures.push({ url, via, detail: EXPOSURE_DETAIL[via] });
  }
  return exposures;
}

/** One discovered extraction structure relevant to holdout preference. */
export interface HoldoutStructureInput {
  id: string;
  sampleUrls: string[];
}

export interface SuggestHoldoutCoverageInput {
  structures: HoldoutStructureInput[];
  /** Confirmed corpus URLs (representative suite). */
  corpusUrls: string[];
  /** URLs already investigated (cannot serve as blind holdouts). */
  investigatedUrls: string[];
  /** Already-reserved holdout URLs (covered; not re-suggested). */
  reservedUrls?: string[];
}

export interface HoldoutCoverageSuggestion {
  /** Preferred holdout URLs in deterministic selection order. */
  preferred: string[];
  /** Preferred holdouts grouped by discovered structure id. */
  perStructure: Record<string, string[]>;
  /** Honest coverage gaps (selection guidance, never a gate). */
  gaps: string[];
  structuresTotal: number;
  structuresCovered: number;
}

/** Coarse template prefix (origin + first path segment) for diversity selection. Local: no imports. */
function urlTemplatePrefix(raw: string): string {
  try {
    const url = new URL(raw.trim());
    const first = url.pathname.split('/').filter(Boolean)[0] ?? '';
    return `${url.origin}/${first}`;
  } catch {
    return raw.trim();
  }
}

/**
 * Holdout selection preference: one holdout per discovered structure and at
 * least two total where the corpus permits, selecting for structural and
 * template diversity rather than arbitrary extra pages. Returns a
 * preference plus gaps — never a verdict, never a gate.
 */
/** Fresh corpus candidates: confirmed but neither investigated nor already reserved. */
function freshHoldoutCandidates(input: SuggestHoldoutCoverageInput): string[] {
  const investigated = new Set(input.investigatedUrls.map(normalizeHoldoutUrl));
  const reserved = new Set((input.reservedUrls ?? []).map(normalizeHoldoutUrl));
  const seen = new Set<string>();
  return input.corpusUrls.map((u) => u.trim()).filter((url) => {
    const key = normalizeHoldoutUrl(url);
    if (!url || seen.has(key) || investigated.has(key) || reserved.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * One preferred holdout per discovered structure, else a gap. Matching is
 * by coarse template prefix only: a blind page's true structure is
 * unknowable without investigating it (which would expose it), so
 * per-structure entries are prefix-matched candidates, never confirmed
 * members. Honest preference, not proof of coverage.
 */
function preferPerStructure(
  structures: HoldoutStructureInput[],
  candidates: string[],
  used: Set<string>,
): { preferred: string[]; perStructure: Record<string, string[]>; gaps: string[] } {
  const preferred: string[] = [];
  const perStructure: Record<string, string[]> = {};
  const gaps: string[] = [];
  for (const structure of structures) {
    const prefixes = new Set((structure.sampleUrls ?? []).map(urlTemplatePrefix));
    const match = candidates.find((url) => !used.has(normalizeHoldoutUrl(url)) && prefixes.has(urlTemplatePrefix(url)));
    if (match) {
      used.add(normalizeHoldoutUrl(match));
      preferred.push(match);
      perStructure[structure.id] = [match];
    } else {
      perStructure[structure.id] = [];
      gaps.push(`no_holdout_candidate_for_structure:${structure.id}`);
    }
  }
  return { preferred, perStructure, gaps };
}

const NO_HOLDOUT_CORPUS_GAP = 'no_holdout_corpus:every confirmed sample was investigated or reserved';

/**
 * At least two total where the corpus permits: fill from unused
 * candidates, preferring template diversity over arbitrary extra pages.
 */
function fillHoldoutPair(preferred: string[], candidates: string[], used: Set<string>): void {
  if (preferred.length >= 2) return;
  const usedPrefixes = new Set(preferred.map(urlTemplatePrefix));
  const diverse = candidates.filter((url) => !used.has(normalizeHoldoutUrl(url)) && !usedPrefixes.has(urlTemplatePrefix(url)));
  const rest = candidates.filter((url) => !used.has(normalizeHoldoutUrl(url)) && usedPrefixes.has(urlTemplatePrefix(url)));
  for (const url of [...diverse, ...rest].slice(0, 2 - preferred.length)) {
    used.add(normalizeHoldoutUrl(url));
    preferred.push(url);
  }
}

export function suggestHoldoutCoverage(input: SuggestHoldoutCoverageInput): HoldoutCoverageSuggestion {
  const candidates = freshHoldoutCandidates(input);
  const used = new Set<string>();
  const { preferred, perStructure, gaps } = preferPerStructure(input.structures, candidates, used);
  fillHoldoutPair(preferred, candidates, used);
  if (preferred.length === 0 && candidates.length === 0) {
    gaps.push(NO_HOLDOUT_CORPUS_GAP);
  } else if (preferred.length < 2) {
    gaps.push(`single_holdout_only:corpus permits ${preferred.length} fresh holdout(s); prefer two where available`);
  }
  return {
    preferred,
    perStructure,
    gaps,
    structuresTotal: input.structures.length,
    structuresCovered: Object.values(perStructure).filter((urls) => urls.length > 0).length,
  };
}
