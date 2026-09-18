// #238 — stateful controller for the browser-investigation panel.
//
// Every piece of panel state and every server call lives here, split into
// small hooks so the panel component itself stays a thin composition:
//
// - list + selection + workspace polling (watch);
// - launch controls (representative selection pruned of reserved holdouts,
//   explicit launch, cancel) plus the read-only budget preview and drift
//   availability check;
// - validation controls (reserved holdouts always run);
// - apply / discard controls (operator name only — the server binds the
//   stored validation by hash, #234).
//
// No automatic step exists beyond the three explicit actions: nothing here
// activates a profile or releases anything.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  isReservedUrl,
  isTrustedValidationEntry,
  launchCandidatesOf,
  reservedHoldoutsCovered,
  validationExpectationProblems,
  type InvestigationAppliedView,
  type InvestigationDriftContextView,
  type InvestigationWorkspaceView,
  type ValidationExpectationField,
  type ValidationSampleEntry,
} from './investigation-contracts';
import {
  applyInvestigationToDraft,
  cancelInvestigation,
  discardInvestigation,
  fetchDriftContext,
  fetchInvestigationWorkspace,
  launchInvestigation,
  listInvestigations,
  previewInvestigationBudgets,
  validateInvestigation,
  type BudgetRow,
  type InvestigationListItem,
  type InvestigationMode,
} from '../../investigation-api';

const POLL_INTERVAL_MS = 3000;
const MAX_LAUNCH_SELECTION = 5;
const DEFAULT_LAUNCH_SELECTION = 3;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sampleKey(entry: { role: string; url: string }): string {
  return `${entry.role}:${entry.url}`;
}

/** Running/queued investigations are watched by polling the workspace. */
function isActiveStatus(status: string | null): boolean {
  return status === 'queued' || status === 'running';
}

interface ListControls {
  investigations: InvestigationListItem[];
  listLoading: boolean;
  listError: string | null;
  refreshList: () => Promise<void>;
}

/** Domain investigation list plus its refresh action. */
function useInvestigationList(domain: string): ListControls {
  const [investigations, setInvestigations] = useState<InvestigationListItem[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const refreshList = useCallback(async (): Promise<void> => {
    setListLoading(true);
    setListError(null);
    try {
      setInvestigations(await listInvestigations(domain));
    } catch (error) {
      setListError(messageOf(error));
    } finally {
      setListLoading(false);
    }
  }, [domain]);
  return { investigations, listLoading, listError, refreshList };
}

interface WorkspaceControls {
  workspace: InvestigationWorkspaceView | null;
  wsLoading: boolean;
  wsError: string | null;
  setWsError: (message: string | null) => void;
  refreshWorkspace: (id: string) => Promise<void>;
}

/** One investigation's workspace view, refreshed on demand. */
function useInvestigationWorkspace(domain: string): WorkspaceControls {
  const [workspace, setWorkspace] = useState<InvestigationWorkspaceView | null>(null);
  const [wsLoading, setWsLoading] = useState(false);
  const [wsError, setWsError] = useState<string | null>(null);
  const refreshWorkspace = useCallback(
    async (id: string): Promise<void> => {
      setWsLoading(true);
      setWsError(null);
      try {
        const body = await fetchInvestigationWorkspace(domain, id);
        setWorkspace(body.workspace);
      } catch (error) {
        setWsError(messageOf(error));
        setWorkspace(null);
      } finally {
        setWsLoading(false);
      }
    },
    [domain],
  );
  return { workspace, wsLoading, wsError, setWsError, refreshWorkspace };
}

interface SelectionControls {
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  selectedStatus: string | null;
  isActive: boolean;
}

/** Selection state: which investigation is open, and its status. */
function useSelection(
  investigations: InvestigationListItem[],
  workspace: InvestigationWorkspaceView | null,
  refreshWorkspace: (id: string) => Promise<void>,
): SelectionControls {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedStatus: string | null =
    (workspace?.investigation?.status as string | undefined) ??
    investigations.find((i) => i.id === selectedId)?.status ??
    null;
  const isActive = isActiveStatus(selectedStatus);
  useEffect(() => {
    if (!selectedId || !isActive) return;
    const timer = setInterval(() => {
      void refreshWorkspace(selectedId);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [selectedId, isActive, refreshWorkspace]);
  return { selectedId, setSelectedId, selectedStatus, isActive };
}

/** Reserved holdouts for the open investigation (never launchable). */
function useReservedHoldouts(workspace: InvestigationWorkspaceView | null): string[] {
  return useMemo(() => workspace?.holdouts?.reserved ?? [], [workspace]);
}

/**
 * Prune reserved holdouts out of the selection as soon as they are known, so
 * a pre-selected URL cannot leak into a later launch payload (holdout
 * blindness). The launch handler filters again as defense in depth.
 */
type SelectionUpdater = React.Dispatch<React.SetStateAction<string[]>>;

function useReservedHoldoutPruning(reservedUrls: string[]): [string[], (url: string) => void, SelectionUpdater] {
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    setSelected((previous) => {
      const next = launchCandidatesOf(previous, reservedUrls);
      const unchanged = next.length === previous.length && next.every((url, index) => url === previous[index]);
      return unchanged ? previous : next;
    });
  }, [reservedUrls]);
  const toggle = useCallback((url: string): void => {
    setSelected((previous) =>
      previous.includes(url)
        ? previous.filter((existing) => existing !== url)
        : [...previous, url].slice(0, MAX_LAUNCH_SELECTION),
    );
  }, []);
  return [selected, toggle, setSelected];
}

interface LaunchControls {
  launchSelected: string[];
  toggleLaunchUrl: (url: string) => void;
  customUrl: string;
  setCustomUrl: (value: string) => void;
  addCustomUrl: () => void;
  launchError: string | null;
  launching: InvestigationMode | null;
  launch: (mode: InvestigationMode) => Promise<void>;
  cancel: () => Promise<void>;
  cancelling: boolean;
  budgetRows: BudgetRow[] | null;
  previewBudgets: () => Promise<void>;
  previewLoading: boolean;
  previewError: string | null;
  driftPreview: InvestigationDriftContextView | null;
  checkDriftEntry: () => Promise<void>;
  driftLoading: boolean;
  driftError: string | null;
}

/** Representative selection + the custom-URL entry (pruned of reserved holdouts). */
function useLaunchSelection(suiteUrls: string[], reservedUrls: string[]) {
  const [launchSelected, toggleLaunchUrl, setLaunchSelected] = useReservedHoldoutPruning(reservedUrls);
  const [customUrl, setCustomUrl] = useState('');
  const [launchError, setLaunchError] = useState<string | null>(null);

  // Default the selection to the first few suite samples; re-default only
  // when the suite itself changes (never on every render).
  const suiteKey = suiteUrls.join('|');
  useEffect(() => {
    setLaunchSelected(launchCandidatesOf(suiteUrls, reservedUrls).slice(0, DEFAULT_LAUNCH_SELECTION));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- suite identity is the joined key
  }, [suiteKey, reservedUrls, setLaunchSelected]);

  const addCustomUrl = useCallback((): void => {
    const url = customUrl.trim();
    const refusal = customUrlRefusal(url, reservedUrls);
    if (refusal) {
      setLaunchError(refusal);
      return;
    }
    setLaunchError(null);
    setLaunchSelected((previous) =>
      previous.includes(url) ? previous : [...previous, url].slice(0, MAX_LAUNCH_SELECTION),
    );
    setCustomUrl('');
  }, [customUrl, reservedUrls, setLaunchSelected]);

  return { launchSelected, toggleLaunchUrl, setLaunchSelected, customUrl, setCustomUrl, addCustomUrl, launchError, setLaunchError };
}

/** Read-only budget preview over the same pruned candidate set a launch sends. */
function useBudgetPreview(domain: string, launchSelected: string[], reservedUrls: string[]) {
  const [budgetRows, setBudgetRows] = useState<BudgetRow[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewBudgets = useCallback(async (): Promise<void> => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      // Reserved holdouts never reach even the read-only preview payload.
      const urls = launchCandidatesOf(launchSelected, reservedUrls);
      if (urls.length === 0) {
        setPreviewError('Selected URLs are all reserved holdouts — pick a representative page.');
        return;
      }
      setBudgetRows(await previewInvestigationBudgets(domain, urls));
    } catch (error) {
      setPreviewError(messageOf(error));
    } finally {
      setPreviewLoading(false);
    }
  }, [domain, launchSelected, reservedUrls]);
  return { budgetRows, setBudgetRows, previewBudgets, previewLoading, previewError };
}

/** Read-only drift-entry availability check for the domain's active version. */
function useDriftPreview(domain: string) {
  const [driftPreview, setDriftPreview] = useState<InvestigationDriftContextView | null>(null);
  const [driftLoading, setDriftLoading] = useState(false);
  const [driftError, setDriftError] = useState<string | null>(null);
  const checkDriftEntry = useCallback(async (): Promise<void> => {
    setDriftLoading(true);
    setDriftError(null);
    try {
      setDriftPreview((await fetchDriftContext(domain)).driftContext);
    } catch (error) {
      setDriftError(messageOf(error));
    } finally {
      setDriftLoading(false);
    }
  }, [domain]);
  return { driftPreview, checkDriftEntry, driftLoading, driftError };
}

/** Explicit launch: representatives only, then refresh the list and open the run. */
function useLaunchRun(args: {
  domain: string;
  selection: ReturnType<typeof useLaunchSelection>;
  reservedUrls: string[];
  refreshList: () => Promise<void>;
  select: (id: string) => void;
  setBudgetRows: (rows: BudgetRow[] | null) => void;
}) {
  const { domain, selection, reservedUrls, refreshList, select, setBudgetRows } = args;
  const [launching, setLaunching] = useState<InvestigationMode | null>(null);
  const launch = useCallback(
    async (mode: InvestigationMode): Promise<void> => {
      setLaunching(mode);
      selection.setLaunchError(null);
      try {
        const urls = launchCandidatesOf(selection.launchSelected, reservedUrls);
        if (urls.length === 0) {
          selection.setLaunchError('Selected URLs are all reserved holdouts — pick a representative page.');
          return;
        }
        const launched = await launchInvestigation(domain, mode, urls);
        if (launched.budgets) setBudgetRows(launched.budgets);
        await refreshList();
        select(launched.investigation.id);
      } catch (error) {
        selection.setLaunchError(messageOf(error));
      } finally {
        setLaunching(null);
      }
    },
    [domain, selection, reservedUrls, refreshList, select, setBudgetRows],
  );
  return { launching, launch };
}

/** Explicit cancel for the open investigation (queued/running only). */
function useCancellation(args: {
  domain: string;
  selectedId: string | null;
  refreshList: () => Promise<void>;
  refreshWorkspace: (id: string) => Promise<void>;
  setWsError: (message: string | null) => void;
}) {
  const { domain, selectedId, refreshList, refreshWorkspace, setWsError } = args;
  const [cancelling, setCancelling] = useState(false);
  const cancel = useCallback(async (): Promise<void> => {
    if (!selectedId) return;
    setCancelling(true);
    setWsError(null);
    try {
      await cancelInvestigation(domain, selectedId);
      await refreshList();
      await refreshWorkspace(selectedId);
    } catch (error) {
      setWsError(messageOf(error));
    } finally {
      setCancelling(false);
    }
  }, [domain, selectedId, refreshList, refreshWorkspace, setWsError]);
  return { cancelling, cancel };
}

/** Launch, cancel, budget-preview, and drift-entry controls for one domain. */
function useLaunchControls(args: {
  domain: string;
  suiteUrls: string[];
  reservedUrls: string[];
  selectedId: string | null;
  refreshList: () => Promise<void>;
  refreshWorkspace: (id: string) => Promise<void>;
  select: (id: string) => void;
  setWsError: (message: string | null) => void;
}): LaunchControls {
  const { domain, suiteUrls, reservedUrls, selectedId, refreshList, refreshWorkspace, select, setWsError } = args;
  const selection = useLaunchSelection(suiteUrls, reservedUrls);
  const budgets = useBudgetPreview(domain, selection.launchSelected, reservedUrls);
  const drift = useDriftPreview(domain);
  const run = useLaunchRun({ domain, selection, reservedUrls, refreshList, select, setBudgetRows: budgets.setBudgetRows });
  const cancellation = useCancellation({ domain, selectedId, refreshList, refreshWorkspace, setWsError });
  return {
    launchSelected: selection.launchSelected,
    toggleLaunchUrl: selection.toggleLaunchUrl,
    customUrl: selection.customUrl,
    setCustomUrl: selection.setCustomUrl,
    addCustomUrl: selection.addCustomUrl,
    launchError: selection.launchError,
    ...budgets,
    ...drift,
    ...run,
    ...cancellation,
  };
}

/** Refusal reason for a custom launch URL (never a silent drop). */
function customUrlRefusal(url: string, reservedUrls: string[]): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Custom URL is not a valid URL.';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Custom URL must be http(s).';
  if (isReservedUrl(url, reservedUrls)) {
    return 'That URL is a reserved holdout — it can never be sent to the investigator.';
  }
  return null;
}

interface ValidationControls {
  entries: ValidationSampleEntry[];
  setExpectedField: (entry: ValidationSampleEntry, field: ValidationExpectationField, value: string) => void;
  problemsByKey: Record<string, string[]>;
  allTrusted: boolean;
  coverageMet: boolean;
  validate: () => Promise<void>;
  validating: boolean;
  validateError: string | null;
}

/** Validate-proposal controls: every sample needs a trusted identity and every reserved holdout must run. */
function useValidationControls(args: {
  domain: string;
  selectedId: string | null;
  workspace: InvestigationWorkspaceView | null;
  reservedUrls: string[];
  refreshWorkspace: (id: string) => Promise<void>;
}): ValidationControls {
  const { domain, selectedId, workspace, reservedUrls, refreshWorkspace } = args;
  const [edits, setEdits] = useState<Record<string, Partial<Record<ValidationExpectationField, string>>>>({});
  const [validating, setValidating] = useState(false);
  const [validateError, setValidateError] = useState<string | null>(null);

  const entries = useMemo(
    () =>
      validationEntries(workspace, reservedUrls).map((entry) => ({
        ...entry,
        ...(edits[sampleKey(entry)] as Partial<ValidationSampleEntry> | undefined),
      })),
    [workspace, reservedUrls, edits],
  );
  const setExpectedField = useCallback(
    (entry: ValidationSampleEntry, field: ValidationExpectationField, value: string): void => {
      const key = sampleKey(entry);
      setEdits((previous) => ({ ...previous, [key]: { ...previous[key], [field]: value } }));
    },
    [],
  );
  const problemsByKey = useMemo(() => {
    const problems: Record<string, string[]> = {};
    for (const entry of entries) {
      problems[sampleKey(entry)] = validationExpectationProblems(entry);
    }
    return problems;
  }, [entries]);
  const allTrusted = useMemo(
    () => entries.length > 0 && entries.every((entry) => isTrustedValidationEntry(entry)),
    [entries],
  );
  const trustedEntries = useMemo(() => entries.filter((entry) => isTrustedValidationEntry(entry)), [entries]);
  const coverageMet = reservedUrls.length === 0 || reservedHoldoutsCovered(trustedEntries, reservedUrls);

  const validate = useCallback(async (): Promise<void> => {
    if (!selectedId) return;
    if (entries.length === 0) {
      setValidateError('No validation samples — confirm representatives or reserve a holdout first.');
      return;
    }
    for (const entry of entries) {
      const problems = validationExpectationProblems(entry);
      if (problems.length > 0) {
        setValidateError(problems[0]);
        return;
      }
    }
    if (!reservedHoldoutsCovered(entries, reservedUrls)) {
      setValidateError('Every reserved holdout must run — fill in the trusted identity for each holdout row.');
      return;
    }
    setValidating(true);
    setValidateError(null);
    try {
      await validateInvestigation(domain, selectedId, entries);
      await refreshWorkspace(selectedId);
    } catch (error) {
      setValidateError(messageOf(error));
    } finally {
      setValidating(false);
    }
  }, [domain, selectedId, entries, reservedUrls, refreshWorkspace]);

  return { entries, setExpectedField, problemsByKey, allTrusted, coverageMet, validate, validating, validateError };
}

/** Representative + reserved-holdout rows for the validate action. */
function validationEntries(
  workspace: InvestigationWorkspaceView | null,
  reservedUrls: string[],
): ValidationSampleEntry[] {
  if (!workspace) return [];
  const confirmed = (workspace.representatives?.confirmed ?? []).filter(
    (url) => !isReservedUrl(url, reservedUrls),
  );
  const representatives: ValidationSampleEntry[] = confirmed.map((url) => ({
    url,
    role: 'representative',
    expectedName: '',
    expectedProductId: '',
    expectedGtin: '',
    expectedSku: '',
    expectedPlatformVariantId: '',
    expectedVariantKey: '',
  }));
  const holdouts: ValidationSampleEntry[] = reservedUrls.map((url) => ({
    url,
    role: 'holdout',
    expectedName: '',
    expectedProductId: '',
    expectedGtin: '',
    expectedSku: '',
    expectedPlatformVariantId: '',
    expectedVariantKey: '',
  }));
  return [...representatives, ...holdouts];
}

interface ConfirmControls {
  actor: string;
  setActor: (value: string) => void;
  running: boolean;
  error: string | null;
  run: () => Promise<void>;
}

/** Apply-to-draft controls (operator name only; the server binds validation). */
function useApplyControls(args: {
  domain: string;
  selectedId: string | null;
  refreshList: () => Promise<void>;
  refreshWorkspace: (id: string) => Promise<void>;
}): ConfirmControls & { result: InvestigationAppliedView | null } {
  const { domain, selectedId, refreshList, refreshWorkspace } = args;
  const [actor, setActor] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InvestigationAppliedView | null>(null);
  const run = useCallback(async (): Promise<void> => {
    if (!selectedId) return;
    setRunning(true);
    setError(null);
    try {
      const applied = await applyInvestigationToDraft(domain, selectedId, actor);
      setResult(applied.applied);
      await refreshList();
      await refreshWorkspace(selectedId);
    } catch (applyError) {
      setError(messageOf(applyError));
    } finally {
      setRunning(false);
    }
  }, [domain, selectedId, actor, refreshList, refreshWorkspace]);
  return { actor, setActor, running, error, run, result };
}

/** Discard-investigation controls. */
function useDiscardControls(args: {
  domain: string;
  selectedId: string | null;
  refreshList: () => Promise<void>;
  refreshWorkspace: (id: string) => Promise<void>;
}): ConfirmControls {
  const { domain, selectedId, refreshList, refreshWorkspace } = args;
  const [actor, setActor] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (): Promise<void> => {
    if (!selectedId) return;
    setRunning(true);
    setError(null);
    try {
      await discardInvestigation(domain, selectedId, actor);
      await refreshList();
      await refreshWorkspace(selectedId);
    } catch (discardError) {
      setError(messageOf(discardError));
    } finally {
      setRunning(false);
    }
  }, [domain, selectedId, actor, refreshList, refreshWorkspace]);
  return { actor, setActor, running, error, run };
}

export interface InvestigationPanelController {
  collapsed: boolean;
  toggleCollapsed: () => void;
  suiteUrls: string[];
  reservedUrls: string[];
  selectedId: string | null;
  selectedStatus: string | null;
  isActive: boolean;
  select: (id: string) => void;
  workspace: InvestigationWorkspaceView | null;
  list: ListControls;
  wsLoading: boolean;
  wsError: string | null;
  launch: LaunchControls;
  validation: ValidationControls;
  apply: ConfirmControls & { result: InvestigationAppliedView | null };
  discard: ConfirmControls;
}

/**
 * Assemble the panel controller. Selection resets per domain (which also
 * clears the per-investigation action state), the list refreshes on domain
 * change, and the workspace reloads on selection.
 */
export function useInvestigationPanel(domain: string, suiteUrls: string[]): InvestigationPanelController {
  const [collapsed, setCollapsed] = useState(false);
  const list = useInvestigationList(domain);
  const { refreshList } = list;
  const workspaceControls = useInvestigationWorkspace(domain);
  const { refreshWorkspace, setWsError } = workspaceControls;
  const selection = useSelection(list.investigations, workspaceControls.workspace, refreshWorkspace);
  const { selectedId, setSelectedId } = selection;
  const reservedUrls = useReservedHoldouts(workspaceControls.workspace);

  const select = useCallback(
    (id: string): void => {
      setSelectedId(id);
      void refreshWorkspace(id);
    },
    [setSelectedId, refreshWorkspace],
  );

  useEffect(() => {
    setSelectedId(null);
    void refreshList();
  }, [domain, refreshList, setSelectedId]);

  const launch = useLaunchControls({
    domain,
    suiteUrls,
    reservedUrls,
    selectedId,
    refreshList,
    refreshWorkspace,
    select,
    setWsError,
  });
  const validation = useValidationControls({
    domain,
    selectedId,
    workspace: workspaceControls.workspace,
    reservedUrls,
    refreshWorkspace,
  });
  const apply = useApplyControls({ domain, selectedId, refreshList, refreshWorkspace });
  const discard = useDiscardControls({ domain, selectedId, refreshList, refreshWorkspace });

  return {
    collapsed,
    toggleCollapsed: () => setCollapsed((previous) => !previous),
    suiteUrls,
    reservedUrls,
    selectedId,
    selectedStatus: selection.selectedStatus,
    isActive: selection.isActive,
    select,
    workspace: workspaceControls.workspace,
    list,
    wsLoading: workspaceControls.wsLoading,
    wsError: workspaceControls.wsError,
    launch,
    validation,
    apply,
    discard,
  };
}
