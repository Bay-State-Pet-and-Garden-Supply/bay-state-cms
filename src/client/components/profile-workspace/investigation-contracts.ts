// #238 — Profile Workspace investigation contracts (client-side, pure).
//
// Single place where the operator UI shapes investigation request bodies.
// The UI never touches raw API payloads: forms call these builders and the
// api module sends exactly what they return.
//
// Server-authoritative apply (#234): Apply sends `{ actor }` ONLY. Client-
// submitted validation status and holdout counts/identities are rejected as
// `validation_untrusted` credentials — so this module exposes no builder
// that could produce them, and `buildApplyBody` returns exactly one key.
// Validation sends sample references (URL + role + trusted expected name),
// never verdicts or holdout counts. Launch sends sample URLs only (never a
// provider id or test scenario knob); reserved holdouts are excluded from
// launch candidates so blind-holdout material is never exposed to the
// investigator through the UI.

interface LaunchBody {
  sampleUrls: string[];
}

type ValidationSampleRole = 'representative' | 'holdout';

export interface ValidationSampleEntry {
  url: string;
  role: ValidationSampleRole;
  expectedName: string;
}

interface ValidateBody {
  samples: Array<{
    url: string;
    role: ValidationSampleRole;
    expected: { name: string };
  }>;
  baselineVersionId?: string;
}

interface ApplyBody {
  actor: string;
}

interface DiscardBody {
  actor: string;
}

function assertHttpUrl(url: string, label: string): string {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must be http(s): ${url}`);
  }
  return trimmed;
}

/** Launch body: 1–5 http(s) sample URLs, nothing else (no provider/scenario keys). */
export function buildLaunchBody(sampleUrls: string[]): LaunchBody {
  const cleaned = sampleUrls.map((u) => assertHttpUrl(u, 'sample URL'));
  if (cleaned.length < 1 || cleaned.length > 5) {
    throw new Error(`launch needs 1–5 sample URLs (got ${cleaned.length})`);
  }
  if (new Set(cleaned).size !== cleaned.length) {
    throw new Error('launch sample URLs must be unique');
  }
  return { sampleUrls: cleaned };
}

function canonicalUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Canonical holdout-membership check: trailing-slash variants neither
 * bypass nor false-trigger. Every UI comparison against reserved holdouts
 * (launch disable, launch pruning, validate roles) goes through here so
 * blind-holdout material is never exposed to the investigator.
 */
export function isReservedUrl(url: string, reservedUrls: string[]): boolean {
  const needle = canonicalUrl(url);
  return reservedUrls.some((reserved) => canonicalUrl(reserved) === needle);
}

/**
 * Launch candidates: confirmed representatives minus reserved holdouts.
 * Reserved holdout material is shown as reserved in the UI and never sent
 * to the investigator through a launch payload.
 */
export function launchCandidatesOf(suiteUrls: string[], reservedUrls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of suiteUrls) {
    const url = raw.trim();
    if (!url || seen.has(canonicalUrl(url))) continue;
    seen.add(canonicalUrl(url));
    if (!isReservedUrl(url, reservedUrls)) out.push(url);
  }
  return out;
}

/** True when every reserved holdout is present in the validation entries as a holdout. */
export function reservedHoldoutsCovered(
  entries: ValidationSampleEntry[],
  reservedUrls: string[],
): boolean {
  const holdouts = new Set(
    entries.filter((e) => e.role === 'holdout').map((e) => canonicalUrl(e.url)),
  );
  return reservedUrls.every((u) => holdouts.has(canonicalUrl(u)));
}

/**
 * Validate body: sample references (URL + role + trusted expected name).
 * Never carries verdicts, holdout counts, or validation status — the server
 * persists the validation reference and Apply binds it by hash.
 */
export function buildValidateBody(
  entries: ValidationSampleEntry[],
  baselineVersionId?: string | null,
): ValidateBody {
  if (entries.length < 1 || entries.length > 10) {
    throw new Error(`validation needs 1–10 samples (got ${entries.length})`);
  }
  const samples = entries.map((e) => {
    if (e.role !== 'representative' && e.role !== 'holdout') {
      throw new Error(`sample ${e.url} needs a representative/holdout role`);
    }
    const name = e.expectedName.trim();
    if (!name) throw new Error(`sample ${e.url} needs an expected product name`);
    return {
      url: assertHttpUrl(e.url, 'sample URL'),
      role: e.role,
      expected: { name: name.slice(0, 512) },
    };
  });
  const body: ValidateBody = { samples };
  const baseline = baselineVersionId?.trim();
  if (baseline) body.baselineVersionId = baseline.slice(0, 256);
  return body;
}

/**
 * Server-authoritative apply body (#234): exactly `{ actor }`. Any extra
 * key (validation, status, holdouts, counts, identities, hashes) is
 * rejected by the server as `validation_untrusted`.
 */
function buildActorBody(actor: string, label: 'apply' | 'discard'): { actor: string } {
  const name = actor.trim();
  if (!name) throw new Error(`${label} actor required`);
  return { actor: name };
}

export function buildApplyBody(actor: string): ApplyBody {
  return buildActorBody(actor, 'apply');
}

export function buildDiscardBody(actor: string): DiscardBody {
  return buildActorBody(actor, 'discard');
}

// ─── Workspace view shapes (client mirror of the server workspace view) ───
// Minimal structural types for exactly the fields this UI renders. Unknown
// server additions are ignored; absent sections render as unavailable.

interface InvestigationWorkspaceActionState {
  allowed: boolean;
  reason: string;
}

export interface InvestigationWorkspaceView {
  investigation?: {
    id: string;
    domain: string;
    mode: string;
    status: string;
    provider: string;
  } | null;
  representatives?: { confirmed: string[]; investigated: string[] } | null;
  holdouts?: {
    required: number;
    passed: number;
    reserved: string[];
    suggestion?: { preferred: string[]; gaps: string[] } | null;
    validationStatus: string;
  } | null;
  budgets?: Array<{ key: string; label: string; value: string }> | null;
  evidence?: {
    platform?: string;
    provider?: string;
    requestedModel?: string;
    actualModel?: string;
    usage?: {
      modelCalls?: number | null;
      pagesVisited?: number | null;
      readsPerformed?: number | null;
      costDisplay?: string;
    } | null;
    structures?: Array<{ id: string; platformSource?: string }>;
    fieldRecommendations?: Array<{ field: string; sources: string[]; evidenceRef?: string }>;
    identity?: {
      productIdentity: string[];
      variantIdentity: string[];
      optionAxes: string[];
    } | null;
    gaps?: string[];
    codeAdapterNeeded?: { capability: string; reason: string } | null;
    renderedBrowser?: { required: boolean; reason: string | null } | null;
    evidenceLinks?: string[];
    failure?: { code: string; detail: string | null } | null;
  } | null;
  proposal?: {
    available: boolean;
    reason?: string;
    status?: string;
    proposalHash?: string | null;
    policyHash?: string | null;
    structuresCount?: number;
    fieldsCount?: number;
    gaps?: string[];
    capability?: string | null;
  } | null;
  validation?: {
    validationId?: string;
    status?: string;
    holdouts?: { required: number; passed: number; sampleIds: string[] };
    blockers?: string[];
    samples?: Array<{
      url: string;
      role: string;
      status: string;
      identityOutcome?: string;
      failureReasons?: string[];
    }>;
  } | null;
  actions?: {
    validate: InvestigationWorkspaceActionState;
    apply: InvestigationWorkspaceActionState;
    discard: InvestigationWorkspaceActionState;
  } | null;
}

export interface InvestigationDriftContextView {
  available?: boolean;
  reason?: string;
  lastHealthyVersionId?: string;
  affectedFields?: string[];
  failureCodes?: string[];
}

export interface InvestigationAppliedView {
  appliedVersionId?: string;
  proposalHash?: string;
  policyHash?: string;
  blockers?: string[];
}
