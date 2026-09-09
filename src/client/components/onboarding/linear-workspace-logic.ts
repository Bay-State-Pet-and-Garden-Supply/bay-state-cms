/**
 * Slice 2 — Linear workspace pure logic (council plan §3, §6 Slice 2, §7.1).
 *
 * DOM-free derivations for the flag-gated six-stage navigation inside
 * BatchWorkspace. Components consume these helpers; the exhaustive §7.1 mount
 * matrix test runs `resolveLinearShell` against the checked-in ledger
 * fixture without a DOM.
 *
 * URL contract (pre-retirement phase):
 * - Linear stage selection: `?stage=<v2stage>&stageVersion=2`. Absent `stage`
 *   ⇒ default Stage 1 (`route_sources`). A present `stage` with a missing or
 *   unknown `stageVersion`, or an unknown stage value, renders an actionable
 *   unsupported-link state (safe default Stage 1, no mutation) — never a
 *   silent guess at the first stage.
 * - Step 0 brand-setup slot: legacy `?wview=brand-setup` links redirect into
 *   Stage 1 (`stage=route_sources&stageVersion=2`). The Step 0 Brand setup
 *   view is retired and absorbed into Stage 1 ("Identify & Route Sources").
 * - Legacy `?tab=<T>` (with no `stage=`/`wview=` present): resolves to the
 *   secondary operation/outcome destination per Table C — no stage is
 *   inferred from a work-state category.
 * - Conflicting explicit selectors (`stage=` together with `tab=` or
 *   `wview=`, or `wview=` together with `tab=`) are rejected as unsupported
 *   navigation rather than guessed.
 * - Diagnostics `?board=pipeline` is evaluated in Onboarding.tsx before any
 *   of this; this module never mounts PipelineBoard.
 */
import {
  STAGE_ORDER_V2,
  STAGE_V2_LABELS,
  STEP_ZERO_VIEW_ID,
  isStageV2String,
  type StageV2,
} from '../../../shared/onboarding-stage-vocabulary';

// ─── Six execution stages (bijective order, plan §2) ──────────────────────────

export type LinearStageId = StageV2;

export const LINEAR_STAGE_ORDER: readonly LinearStageId[] = STAGE_ORDER_V2;

export const LINEAR_STAGE_LABELS: Readonly<Record<LinearStageId, string>> = STAGE_V2_LABELS;

export interface LinearStageDef {
  id: LinearStageId;
  label: string;
  /** One-line operator guidance. Stage 1 is neutral triage, not a supplier-first instruction. */
  description: string;
}

/**
 * Exactly six primary tabs in execution order. Step 0 (`brand-setup`) is a
 * view slot and is NOT a member of this array — assert length 6 in tests.
 */
export const LINEAR_STAGES: readonly LinearStageDef[] = [
  {
    id: 'route_sources',
    label: 'Identify & Route Sources',
    description:
      'Intake gate: identify products, assign brands, and route each source — official product page as the main source, qualified supplier records as the fast path.',
  },
  {
    id: 'find_product_page',
    label: 'Find product page',
    description: 'Official-source authority and product/variant URL discovery.',
  },
  {
    id: 'collect_details',
    label: 'Collect details',
    description: 'Official-page extraction or null-URL distributor materialization.',
  },
  {
    id: 'prepare_listing',
    label: 'Prepare listing',
    description: 'Cohort-aware cleanup and classification — one stage, one sectioned view.',
  },
  {
    id: 'review_listings',
    label: 'Review listings',
    description: 'Human review. Approval remains an explicit separate action.',
  },
  {
    id: 'create_drafts',
    label: 'Create drafts',
    description: 'CMS draft and release area. Creating a draft never claims publishing.',
  },
];

/** Stage-1 fast-path annotation (secondary, never the headline). */
export const STAGE_ONE_FAST_PATH_NOTE =
  'Qualified distributor record can provide an alternate path that skips product-page discovery.';

/** Explicit vocabulary version carried on stage URLs. */
export const LINEAR_STAGE_URL_VERSION = '2' as const;
export const LINEAR_STAGE_VERSION_PARAM = 'stageVersion' as const;
export const LINEAR_STAGE_PARAM = 'stage' as const;
/**
 * Shell view selector param. Deliberately NOT `view`: the app shell owns
 * `view` for top-level routing (`?view=onboarding&batch=…` is present on
 * every production batch URL), so sharing the name made every batch page
 * parse as conflicting/unknown and broke stage + legacy-tab resolution.
 */
export const LINEAR_VIEW_PARAM = 'wview' as const;
export { STEP_ZERO_VIEW_ID };

/** The ten legacy `?tab=` cases in Table C (plus absent). */
export const LEGACY_TAB_CASES = [
  'absent',
  'needs_attention',
  'processing',
  'waiting_on_family',
  'review',
  'approved',
  'ready_to_export',
  'completed',
  'skipped',
  'invalid',
] as const;

export type LegacyTabCase = (typeof LEGACY_TAB_CASES)[number];

export type OperationViewId =
  | 'attention'
  | 'processing'
  | 'family'
  | 'review'
  | 'approved'
  | 'export';

export type OutcomeCategory = 'completed' | 'skipped';

/**
 * Legacy `?tab=` destination in linear content (Table C, linear column).
 * - operation: mount the EXISTING frozen full-batch view, labeled
 *   'entire batch', with stage filters cleared/hidden while open.
 * - outcome: server-filtered OutcomeItemsView (`category=`), no new decisions.
 * - stage: default Stage 1 (absent tab, or unsupported tab falls back here
 *   WITH an unsupported-link notice — never a silent guess).
 */
export type LegacyTabDestination =
  | { kind: 'operation'; view: OperationViewId }
  | { kind: 'outcome'; outcome: OutcomeCategory }
  | { kind: 'stage'; stage: LinearStageId }
  | { kind: 'unsupported'; reportedTab: string };

export function resolveLegacyTabDestination(rawTab: string | null): LegacyTabDestination {
  if (rawTab === null) return { kind: 'stage', stage: 'route_sources' };
  switch (rawTab) {
    case 'needs_attention':
      return { kind: 'operation', view: 'attention' };
    case 'processing':
      return { kind: 'operation', view: 'processing' };
    case 'waiting_on_family':
      return { kind: 'operation', view: 'family' };
    case 'review':
      return { kind: 'operation', view: 'review' };
    case 'approved':
      return { kind: 'operation', view: 'approved' };
    case 'ready_to_export':
      return { kind: 'operation', view: 'export' };
    case 'completed':
      return { kind: 'outcome', outcome: 'completed' };
    case 'skipped':
      return { kind: 'outcome', outcome: 'skipped' };
    default:
      return { kind: 'unsupported', reportedTab: rawTab };
  }
}

/** Classic grace destination for `?tab=` (Table C, classic column). */
export type ClassicTabDestination =
  | { kind: 'operation'; view: OperationViewId }
  | { kind: 'outcome'; outcome: OutcomeCategory }
  | { kind: 'default' }
  | { kind: 'unsupported'; reportedTab: string };

export function resolveClassicTabDestination(rawTab: string | null): ClassicTabDestination {
  if (rawTab === null) return { kind: 'default' };
  const linear = resolveLegacyTabDestination(rawTab);
  if (linear.kind === 'unsupported') return linear;
  if (linear.kind === 'stage') return { kind: 'default' };
  return linear;
}

// ─── Stage URL parsing ─────────────────────────────────────────────────────────

export type StageSelection =
  | { kind: 'stage'; stage: LinearStageId }
  | { kind: 'brand-setup' }
  | { kind: 'legacy'; rawTab: string | null }
  | { kind: 'unsupported'; reason: string };

/**
 * Legacy Step 0 redirect target: retired `wview=brand-setup` links land on
 * Stage 1 ("Identify & Route Sources") with the canonical stage version.
 * Callers that need the URL string can build it with
 * `serializeStageSelection('route_sources')`.
 */
export const BRAND_SETUP_REDIRECT_STAGE: LinearStageId = 'route_sources';

/**
 * Parse the workspace content selectors from a query string. Diagnostics
 * (`board=pipeline`) is NOT handled here — Onboarding.tsx resolves Table A
 * before BatchWorkspace mounts.
 */
export function parseWorkspaceSelection(search: string): StageSelection {
  const params = new URLSearchParams(search);
  const stageRaw = params.get(LINEAR_STAGE_PARAM);
  const versionRaw = params.get(LINEAR_STAGE_VERSION_PARAM);
  const viewRaw = params.get(LINEAR_VIEW_PARAM);
  const tabRaw = params.get('tab');

  const hasStage = stageRaw !== null;
  const hasView = viewRaw !== null;
  const hasTab = tabRaw !== null;

  if ((hasStage && hasTab) || (hasStage && hasView) || (hasView && hasTab)) {
    return {
      kind: 'unsupported',
      reason: 'Conflicting navigation selectors. Pick a stage, the brand-setup view, or one operation — not several at once.',
    };
  }
  if (hasView) {
    // Step 0 retired (#115): legacy `wview=brand-setup` links redirect
    // seamlessly into Stage 1. `parseWorkspaceSelection` performs the
    // redirect at the parse seam so every consumer (shell, deep links,
    // bookmarks) lands on `stage=route_sources` with stageVersion=2.
    if (viewRaw === STEP_ZERO_VIEW_ID) return { kind: 'stage', stage: BRAND_SETUP_REDIRECT_STAGE };
    return { kind: 'unsupported', reason: `Unknown view '${viewRaw ?? ''}'.` };
  }
  if (hasStage) {
    if (versionRaw !== LINEAR_STAGE_URL_VERSION) {
      return {
        kind: 'unsupported',
        reason: `Unsupported stage link version '${versionRaw ?? '(missing)'}'. This workspace reads stage links version 2.`,
      };
    }
    if (!isStageV2String(stageRaw)) {
      return {
        kind: 'unsupported',
        reason: `Unknown stage '${stageRaw ?? ''}'. Stages are the six execution steps, not work states.`,
      };
    }
    return { kind: 'stage', stage: stageRaw };
  }
  return { kind: 'legacy', rawTab: tabRaw };
}

/** Serialize a stage selection back to a query string (history updates). */
export function serializeStageSelection(stage: LinearStageId): string {
  const params = new URLSearchParams();
  params.set(LINEAR_STAGE_PARAM, stage);
  params.set(LINEAR_STAGE_VERSION_PARAM, LINEAR_STAGE_URL_VERSION);
  return `?${params.toString()}`;
}

// ─── §7.1 shell matrix resolver (pure, ledger-tested) ──────────────────────────

export interface ShellMatrixInput {
  /** W */ workspaceEnabled: boolean;
  /** S */ shellV2Enabled: boolean;
  /** B */ brandGateV2Enabled: boolean;
  /** E */ executionStripV2Enabled: boolean;
  /** D */ diagnosticsEnabled: boolean;
  /** Q */ boardQuery: boolean;
  /** T */ legacyTab: LegacyTabCase;
  /** wview=brand-setup selected */ brandSetupView: boolean;
  /** stage= selector present (with version 2) */ stageSelector: LinearStageId | null;
  /** unknown/unsupported stage or view selector present */ unsupportedSelector: boolean;
}

export interface ShellMatrixResult {
  /** Table A root (pre-retirement phase). */
  root: 'BatchWorkspace' | 'PipelineBoard' | 'Unavailable';
  notice: 'none' | 'diagnostics-disabled' | 'unavailable' | 'retired-diagnostics';
  /** Table B content inside BatchWorkspace. */
  content: 'linear' | 'classic' | 'none';
  brandSetupAvailable: boolean;
  /**
   * Slice 4: the ephemeral execution strip mounts when the shell flag AND
   * the strip flag are both on (Table B E=1 ⇒ mounted). Batch-wide scope;
   * strip requires shell, so S=0 never mounts regardless of E.
   */
  stripMounted: boolean;
  /** Table C destination when content is enabled. */
  destination:
    | { kind: 'stage'; stage: LinearStageId }
    | { kind: 'brand-setup'; mounted: boolean }
    | { kind: 'operation'; view: OperationViewId }
    | { kind: 'outcome'; outcome: OutcomeCategory }
    | { kind: 'default' }
    | { kind: 'unsupported'; fallback: 'stage' | 'default' };
}

/**
 * Pre-retirement (Slices 2–5b) truth tables A+B+C, factored. Diagnostics Q is
 * evaluated before T (Table A); Table B applies only when root is
 * BatchWorkspace; Table C only when content is enabled.
 */
export function resolveLinearShell(input: ShellMatrixInput): ShellMatrixResult {
  const {
    workspaceEnabled: W,
    diagnosticsEnabled: D,
    boardQuery: Q,
  } = input;

  // ── Table A: root and notice (pre-retirement) ──
  let root: ShellMatrixResult['root'];
  let notice: ShellMatrixResult['notice'] = 'none';
  if (!W && !D && !Q) {
    root = 'Unavailable';
  } else if (!W && !D && Q) {
    root = 'Unavailable';
    notice = 'diagnostics-disabled';
  } else if (!W && D && !Q) {
    // No implicit fallback: workspace OFF + diagnostics ON without the
    // explicit query never mounts PipelineBoard.
    root = 'Unavailable';
  } else if (!W && D && Q) {
    root = 'PipelineBoard';
  } else if (W && !D && !Q) {
    root = 'BatchWorkspace';
  } else if (W && !D && Q) {
    root = 'BatchWorkspace';
    notice = 'diagnostics-disabled';
  } else if (W && D && !Q) {
    root = 'BatchWorkspace';
  } else {
    root = 'PipelineBoard';
  }

  if (root !== 'BatchWorkspace') {
    return {
      root,
      notice,
      content: 'none',
      brandSetupAvailable: false,
      stripMounted: false,
      destination: { kind: 'unsupported', fallback: 'stage' },
    };
  }

  return finishBatchWorkspaceRoot(root, notice, input);
}

/**
 * Slice 6 — mounts-retired phase (§7.1 Table A, "Mounts retired" column).
 *
 * All PipelineBoard mounts/imports are removed (including the
 * workspace-disabled fallback): BatchWorkspace is the sole shell, so the
 * root is ALWAYS BatchWorkspace. The retired `W` (workspace) and `D`
 * (diagnostics) switches are ignored — they can no longer create a hidden
 * mount, a dead screen, or an Unavailable state. An explicit
 * `?board=pipeline` query (`Q`) resolves to the current shell with a
 * `retired-diagnostics` notice. Tables B (content/features) and C (legacy
 * destinations) apply unchanged whenever the shell mounts.
 *
 * The pre-retirement `resolveLinearShell` above is retained for ledger
 * history; new code and the Slice 6 ledger use this resolver.
 */
export function resolveRetiredShell(input: ShellMatrixInput): ShellMatrixResult {
  const notice: ShellMatrixResult['notice'] = input.boardQuery ? 'retired-diagnostics' : 'none';
  return finishBatchWorkspaceRoot('BatchWorkspace', notice, input);
}

/** Shared Tables B+C tail: content/features + legacy destination inside BatchWorkspace. */
function finishBatchWorkspaceRoot(
  root: 'BatchWorkspace',
  notice: ShellMatrixResult['notice'],
  input: ShellMatrixInput,
): ShellMatrixResult {
  const {
    shellV2Enabled: S,
    brandGateV2Enabled: B,
    legacyTab: T,
    brandSetupView,
    stageSelector,
    unsupportedSelector,
  } = input;
  // ── Table B: content/features for every S×B×E row ──
  // Shell OFF + brand ON never mounts the new brand view.
  const brandSetupAvailable = S && B;
  const content: ShellMatrixResult['content'] = S ? 'linear' : 'classic';
  // Slice 4: the ephemeral execution strip mounts when the shell flag AND
  // the strip flag are both on (Table B E=1 ⇒ mounted). Strip requires
  // shell; S=0 never mounts regardless of E.
  const stripMounted = S && input.executionStripV2Enabled;

  // ── Table C: legacy destination (enabled content only) ──
  if (unsupportedSelector) {
    return {
      root,
      notice,
      content,
      brandSetupAvailable,
      stripMounted,
      destination: { kind: 'unsupported', fallback: S ? 'stage' : 'default' },
    };
  }
  if (brandSetupView) {
    return {
      root,
      notice,
      content,
      brandSetupAvailable,
      stripMounted,
      destination: { kind: 'brand-setup', mounted: brandSetupAvailable },
    };
  }
  if (stageSelector !== null) {
    return {
      root,
      notice,
      content,
      brandSetupAvailable,
      stripMounted,
      destination: S ? { kind: 'stage', stage: stageSelector } : { kind: 'unsupported', fallback: 'default' },
    };
  }
  if (!S) {
    const classic = resolveClassicTabDestination(T === 'absent' ? null : T === 'invalid' ? '__invalid__' : T);
    if (classic.kind === 'default') return { root, notice, content, brandSetupAvailable, stripMounted, destination: { kind: 'default' } };
    if (classic.kind === 'unsupported') {
      return { root, notice, content, brandSetupAvailable, stripMounted, destination: { kind: 'unsupported', fallback: 'default' } };
    }
    return { root, notice, content, brandSetupAvailable, stripMounted, destination: classic };
  }
  const rawTab = T === 'absent' ? null : T === 'invalid' ? '__invalid__' : T;
  const dest = resolveLegacyTabDestination(rawTab);
  if (dest.kind === 'unsupported') {
    return { root, notice, content, brandSetupAvailable, stripMounted, destination: { kind: 'unsupported', fallback: 'stage' } };
  }
  return { root, notice, content, brandSetupAvailable, stripMounted, destination: dest };
}
