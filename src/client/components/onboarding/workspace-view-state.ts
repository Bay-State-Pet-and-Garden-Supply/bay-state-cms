import { isStageV2String } from '../../../shared/onboarding-stage-vocabulary';
import {
  LINEAR_STAGE_URL_VERSION,
  parseWorkspaceSelection,
  resolveLegacyTabDestination,
  type LinearStageId,
  type StageSelection,
} from './linear-workspace-logic';

export interface WorkspaceViewScope {
  workspaceId: string;
  batchId: string;
}

export interface StageViewScope extends WorkspaceViewScope {
  stage: LinearStageId;
}

/** Preferences only: never pass product records, mutation selections, or edits. */
export interface StageViewPreferences {
  filters: Partial<Record<WorkspaceFilterName, string>>;
  q: string;
  /** Inspector context, not authorization to include this item in an action. */
  selectedId: string | null;
}

const FILTER_NAMES = [
  'category', 'reviewState', 'brand', 'sourceType', 'domain',
  'gateStatus', 'familyCohortId', 'kpiFilter', 'status', 'warningsOnly',
] as const;
export type WorkspaceFilterName = (typeof FILTER_NAMES)[number];

/** Inject localStorage to survive browser sessions, or null to disable storage. */
export type ViewPreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

function sessionPreferences(): ViewPreferenceStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function preferenceKey(scope: WorkspaceViewScope, stage?: LinearStageId): string | null {
  if (typeof scope.workspaceId !== 'string' || !scope.workspaceId
    || typeof scope.batchId !== 'string' || !scope.batchId
    || (stage !== undefined && !isStageV2String(stage))) return null;
  // JSON tuple boundaries prevent collisions when IDs themselves contain separators.
  return `baystate:onboarding:view:v1:${JSON.stringify([scope.workspaceId, scope.batchId, stage ?? 'last-stage'])}`;
}

function readPreference(key: string | null, storage: ViewPreferenceStorage | null): unknown {
  if (!key || !storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function writePreference(key: string | null, value: unknown, storage: ViewPreferenceStorage | null): void {
  if (!key || !storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode / quota failures must never prevent navigation or editing.
  }
}

export function readLastWorkspaceStage(
  scope: WorkspaceViewScope,
  storage: ViewPreferenceStorage | null = sessionPreferences(),
): LinearStageId | null {
  const value = readPreference(preferenceKey(scope), storage);
  return isStageV2String(value) ? value : null;
}

export function rememberWorkspaceStage(
  scope: WorkspaceViewScope,
  stage: LinearStageId,
  storage: ViewPreferenceStorage | null = sessionPreferences(),
): void {
  if (isStageV2String(stage)) writePreference(preferenceKey(scope), stage, storage);
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length <= maxLength ? value : null;
}

function sanitizePreferences(value: unknown): StageViewPreferences | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const filters: StageViewPreferences['filters'] = {};
  if (raw.filters && typeof raw.filters === 'object' && !Array.isArray(raw.filters)) {
    const rawFilters = raw.filters as Record<string, unknown>;
    for (const name of FILTER_NAMES) {
      const fact = boundedString(rawFilters[name], 256);
      if (fact !== null) filters[name] = fact;
    }
  }
  return {
    filters,
    q: boundedString(raw.q, 500) ?? '',
    selectedId: boundedString(raw.selectedId, 256) || null,
  };
}

export function readStageViewPreferences(
  scope: StageViewScope,
  storage: ViewPreferenceStorage | null = sessionPreferences(),
): StageViewPreferences | null {
  if (!isStageV2String(scope.stage)) return null;
  return sanitizePreferences(readPreference(preferenceKey(scope, scope.stage), storage));
}

/** Writes a complete preference snapshot; extra properties are dropped at runtime too. */
export function writeStageViewPreferences(
  scope: StageViewScope,
  preferences: StageViewPreferences,
  storage: ViewPreferenceStorage | null = sessionPreferences(),
): void {
  if (!isStageV2String(scope.stage)) return;
  const safe = sanitizePreferences(preferences);
  if (safe) writePreference(preferenceKey(scope, scope.stage), safe, storage);
}

export interface ResolvedWorkspaceViewSelection {
  selection: StageSelection;
  source: 'explicit' | 'remembered' | 'default' | 'new-batch' | 'unsupported';
}

/** Additive wrapper: the existing parser's unsupported-link behavior is preserved. */
export function resolveWorkspaceViewSelection(
  search: string,
  rememberedStage: unknown = null,
  newBatch = false,
): ResolvedWorkspaceViewSelection {
  if (newBatch) return { selection: { kind: 'stage', stage: 'route_sources' }, source: 'new-batch' };
  const selection = parseWorkspaceSelection(search);
  if (selection.kind === 'unsupported') return { selection, source: 'unsupported' };
  if (selection.kind === 'legacy' && selection.rawTab !== null) {
    return {
      selection,
      source: resolveLegacyTabDestination(selection.rawTab).kind === 'unsupported' ? 'unsupported' : 'explicit',
    };
  }
  if (selection.kind !== 'legacy') return { selection, source: 'explicit' };
  return isStageV2String(rememberedStage)
    ? { selection: { kind: 'stage', stage: rememberedStage }, source: 'remembered' }
    : { selection: { kind: 'stage', stage: 'route_sources' }, source: 'default' };
}

/** Clean the shell's selector namespace together on batch exit / batch changes. */
export function clearBatchWorkspaceParams(params: URLSearchParams): void {
  for (const name of ['batch', 'stage', 'stageVersion', 'wview', 'tab', 'board', 'attention', 'issue']) params.delete(name);
}

/**
 * Preserve explicit selectors only when they name this batch. Selecting a
 * different batch cannot inherit the previous batch's stage or legacy tab.
 * Unsupported direct links stay intact for the shell's actionable notice.
 */
export function batchWorkspaceUrl(
  current: URL,
  batchId: string,
  rememberedStage: unknown = null,
  newBatch = false,
): URL {
  const url = new URL(current.href);
  if (newBatch || url.searchParams.get('batch') !== batchId) clearBatchWorkspaceParams(url.searchParams);
  url.searchParams.set('view', 'onboarding');
  url.searchParams.set('batch', batchId);
  const { selection } = resolveWorkspaceViewSelection(url.search, rememberedStage, newBatch);
  if (selection.kind === 'stage') {
    url.searchParams.delete('tab');
    url.searchParams.delete('wview');
    url.searchParams.set('stage', selection.stage);
    url.searchParams.set('stageVersion', LINEAR_STAGE_URL_VERSION);
  } else if (selection.kind === 'legacy') {
    url.searchParams.delete('stageVersion');
  }
  return url;
}
