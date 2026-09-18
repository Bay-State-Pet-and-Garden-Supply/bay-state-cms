// #238 — Profile Workspace browser-investigation operator UI.
//
// Operator launch / watch / cancel, representative selection with visible
// holdout coverage and budgets, evidence-rich per-investigation results,
// proposal preview with stored validation, and separate Validate, Apply to
// Draft, and Discard actions — built against the server-authoritative apply
// contract (`{ actor }` only, #234) and the existing
// investigate/validate/apply/discard/status/workspace/drift-context/preview
// routes. No new server routes. Forms shape bodies through
// investigation-contracts so the operator never touches API payloads, and
// this view offers no automatic step beyond the three explicit actions.
//
// Holdout discipline: reserved holdouts render as reserved and are excluded
// from launch candidates, so blind-holdout material is never exposed to the
// investigator through this UI. Validate entries carry reserved URLs as
// holdouts (every reserved holdout must run — the server rejects drops).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { colors, fonts, rounded } from '../../theme';
import {
  isReservedUrl,
  launchCandidatesOf,
  reservedHoldoutsCovered,
  type InvestigationAppliedView,
  type InvestigationDriftContextView,
  type InvestigationWorkspaceView,
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



function shortPath(url: string): string {
  try {
    const u = new URL(url);
    const path = u.hostname + u.pathname;
    return path.length > 56 ? `${path.slice(0, 56)}…` : path;
  } catch {
    return url.length > 56 ? `${url.slice(0, 56)}…` : url;
  }
}

function shortHash(hash: string | null | undefined): string {
  if (!hash) return '—';
  return hash.length > 16 ? `${hash.slice(0, 12)}…` : hash;
}

function statusColor(status: string): string {
  if (status === 'completed') return colors.seedlingGreen;
  if (status === 'failed') return colors.signetBurgundy;
  if (status === 'running' || status === 'queued') return colors.cornerCalloutGold;
  return colors.mulchBrown;
}

function modeLabel(mode: string): string {
  return mode === 'drift_repair' ? 'Drift' : 'Domain';
}

const card: React.CSSProperties = {
  background: colors.whiteSurface,
  border: `1px solid ${colors.cardBorder}`,
  borderRadius: rounded.lg,
  padding: 16,
  boxShadow: '0 1px 3px rgba(33, 20, 20, 0.04)',
};

const sectionTitle: React.CSSProperties = {
  margin: '0 0 10px',
  fontFamily: fonts.display,
  fontSize: '0.9375rem',
  fontWeight: 700,
  color: colors.ledgerCharcoal,
};

const hint: React.CSSProperties = {
  fontSize: 11,
  color: colors.mulchBrown,
};

const primaryButton = (disabled: boolean): React.CSSProperties => ({
  padding: '7px 16px',
  background: disabled ? colors.feedBagCream : colors.uniformGreen,
  color: disabled ? colors.mulchBrown : colors.feedBagCream,
  border: 'none',
  borderRadius: rounded.sm,
  fontFamily: fonts.body,
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.7 : 1,
});

const ghostButton: React.CSSProperties = {
  padding: '6px 12px',
  background: colors.whiteSurface,
  color: colors.uniformGreen,
  border: `1px solid ${colors.uniformGreen}`,
  borderRadius: rounded.sm,
  fontFamily: fonts.body,
  fontSize: 11,
  fontWeight: 700,
  cursor: 'pointer',
};

const errorBox: React.CSSProperties = {
  padding: '8px 12px',
  background: 'rgba(118, 12, 25, 0.08)',
  border: `1px solid ${colors.signetBurgundy}`,
  borderRadius: rounded.sm,
  color: colors.signetBurgundy,
  fontSize: 12,
  fontWeight: 600,
};

function reasonText(allowed: boolean, reason: string): string {
  return allowed ? reason : `Unavailable: ${reason}`;
}

export function InvestigationPanel({
  domain,
  suiteUrls,
}: {
  domain: string;
  suiteUrls: string[];
}): React.ReactElement {
  const [collapsed, setCollapsed] = useState(false);
  const [investigations, setInvestigations] = useState<InvestigationListItem[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<InvestigationWorkspaceView | null>(null);
  const [wsLoading, setWsLoading] = useState(false);
  const [wsError, setWsError] = useState<string | null>(null);

  const [launchSelected, setLaunchSelected] = useState<string[]>(() => suiteUrls.slice(0, 3));
  const [customUrl, setCustomUrl] = useState('');
  const [launching, setLaunching] = useState<InvestigationMode | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const [budgetRows, setBudgetRows] = useState<BudgetRow[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

   
  const [driftPreview, setDriftPreview] = useState<InvestigationDriftContextView | null>(null);
  const [driftLoading, setDriftLoading] = useState(false);
  const [driftError, setDriftError] = useState<string | null>(null);

  const [expectedNames, setExpectedNames] = useState<Record<string, string>>({});
  const [validating, setValidating] = useState(false);
  const [validateError, setValidateError] = useState<string | null>(null);

  const [applyActor, setApplyActor] = useState('');
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
   
  const [applyResult, setApplyResult] = useState<InvestigationAppliedView | null>(null);

  const [discardActor, setDiscardActor] = useState('');
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);

  const reservedUrls: string[] = useMemo(
    () => workspace?.holdouts?.reserved ?? [],
    [workspace],
  );

  // Reserved holdouts are never launchable: prune them from the selection
  // as soon as reservation state loads, so a pre-selected URL cannot leak
  // into a later launch payload (investigator blindness). The launch
  // handler filters again as defense in depth.
  useEffect(() => {
    setLaunchSelected((prev) => {
      const next = launchCandidatesOf(prev, reservedUrls);
      return next.length === prev.length && next.every((u, i) => u === prev[i]) ? prev : next;
    });
  }, [reservedUrls]);
  const refreshList = useCallback(async (): Promise<void> => {
    setListLoading(true);
    setListError(null);
    try {
      setInvestigations(await listInvestigations(domain));
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setListLoading(false);
    }
  }, [domain]);

  const refreshWorkspace = useCallback(
    async (id: string): Promise<void> => {
      setWsLoading(true);
      setWsError(null);
      try {
        const body = await fetchInvestigationWorkspace(domain, id);
        setWorkspace(body.workspace);
      } catch (e) {
        setWsError(e instanceof Error ? e.message : String(e));
        setWorkspace(null);
      } finally {
        setWsLoading(false);
      }
    },
    [domain],
  );

  useEffect(() => {
    setSelectedId(null);
    setWorkspace(null);
    setLaunchSelected(suiteUrls.slice(0, 3));
    void refreshList();
  }, [domain, refreshList, suiteUrls]);

  const selectedStatus: string | null =
    (workspace?.investigation?.status as string | undefined) ??
    investigations.find((i) => i.id === selectedId)?.status ??
    null;
  const isActive = selectedStatus === 'queued' || selectedStatus === 'running';

  useEffect(() => {
    if (!selectedId || !isActive) return;
    const timer = setInterval(() => {
      void refreshWorkspace(selectedId);
    }, 3000);
    return () => clearInterval(timer);
  }, [selectedId, isActive, refreshWorkspace]);

  const handleSelect = useCallback(
    (id: string): void => {
      setSelectedId(id);
      setApplyResult(null);
      setValidateError(null);
      setApplyError(null);
      setDiscardError(null);
      void refreshWorkspace(id);
    },
    [refreshWorkspace],
  );

  const toggleLaunchUrl = useCallback((url: string): void => {
    setLaunchSelected((prev) =>
      prev.includes(url) ? prev.filter((u) => u !== url) : [...prev, url].slice(0, 5),
    );
  }, []);

  const handleAddCustomUrl = useCallback((): void => {
    const url = customUrl.trim();
    if (!url) return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        setLaunchError('Custom URL must be http(s).');
        return;
      }
    } catch {
      setLaunchError('Custom URL is not a valid URL.');
      return;
    }
    if (isReservedUrl(url, reservedUrls)) {
      setLaunchError('That URL is a reserved holdout — it can never be sent to the investigator.');
      return;
    }
    setLaunchError(null);
    setLaunchSelected((prev) => (prev.includes(url) ? prev : [...prev, url].slice(0, 5)));
    setCustomUrl('');
  }, [customUrl, reservedUrls]);

  const handlePreviewBudgets = useCallback(async (): Promise<void> => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      // Preview the same pruned candidate set a launch would send, so
      // reserved holdouts never reach even the read-only preview payload.
      const urls = launchCandidatesOf(launchSelected, reservedUrls);
      if (urls.length === 0) {
        setPreviewError('Selected URLs are all reserved holdouts — pick a representative page.');
        return;
      }
      setBudgetRows(await previewInvestigationBudgets(domain, urls));
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewLoading(false);
    }
  }, [domain, launchSelected, reservedUrls]);

  const handleCheckDriftEntry = useCallback(async (): Promise<void> => {
    setDriftLoading(true);
    setDriftError(null);
    try {
      const body = await fetchDriftContext(domain);
      setDriftPreview(body.driftContext);
    } catch (e) {
      setDriftError(e instanceof Error ? e.message : String(e));
    } finally {
      setDriftLoading(false);
    }
  }, [domain]);

  const handleLaunch = useCallback(
    async (mode: InvestigationMode): Promise<void> => {
      setLaunching(mode);
      setLaunchError(null);
      try {
        const urls = launchCandidatesOf(launchSelected, reservedUrls);
        if (urls.length === 0) {
          setLaunchError('Selected URLs are all reserved holdouts — pick a representative page.');
          return;
        }
        const launched = await launchInvestigation(domain, mode, urls);
        if (launched.budgets) setBudgetRows(launched.budgets);
        await refreshList();
        handleSelect(launched.investigation.id);
      } catch (e) {
        setLaunchError(e instanceof Error ? e.message : String(e));
      } finally {
        setLaunching(null);
      }
    },
    [domain, launchSelected, refreshList, handleSelect],
  );

  const handleCancel = useCallback(async (): Promise<void> => {
    if (!selectedId) return;
    setCancelling(true);
    setWsError(null);
    try {
      await cancelInvestigation(domain, selectedId);
      await refreshList();
      await refreshWorkspace(selectedId);
    } catch (e) {
      setWsError(e instanceof Error ? e.message : String(e));
    } finally {
      setCancelling(false);
    }
  }, [domain, selectedId, refreshList, refreshWorkspace]);

  const validateEntries: ValidationSampleEntry[] = useMemo(() => {
    if (!workspace) return [];
    const confirmed = (workspace.representatives?.confirmed ?? []).filter(
      (u) => !isReservedUrl(u, reservedUrls),
    );
    const rows: ValidationSampleEntry[] = [
      ...confirmed.map((url) => ({
        url,
        role: 'representative' as const,
        expectedName: expectedNames[`representative:${url}`] ?? '',
      })),
      ...reservedUrls.map((url) => ({
        url,
        role: 'holdout' as const,
        expectedName: expectedNames[`holdout:${url}`] ?? '',
      })),
    ];
    return rows;
  }, [workspace, reservedUrls, expectedNames]);

  // Every reserved holdout must run: the action stays unavailable until
  // each holdout row has an expected name, and the handler refuses to
  // submit a partial-holdout set instead of leaving it to server rejection.
  const holdoutCoverageMet =
    reservedUrls.length === 0 ||
    reservedHoldoutsCovered(
      validateEntries.filter((e) => e.expectedName.trim()),
      reservedUrls,
    );

  const handleValidate = useCallback(async (): Promise<void> => {
    if (!selectedId) return;
    const entries = validateEntries.filter((e) => e.expectedName.trim());
    if (!reservedHoldoutsCovered(entries, reservedUrls)) {
      setValidateError('Every reserved holdout must run — fill in the expected name for each holdout row.');
      return;
    }
    setValidating(true);
    setValidateError(null);
    try {
      await validateInvestigation(domain, selectedId, entries);
      await refreshWorkspace(selectedId);
    } catch (e) {
      setValidateError(e instanceof Error ? e.message : String(e));
    } finally {
      setValidating(false);
    }
  }, [domain, selectedId, validateEntries, reservedUrls, refreshWorkspace]);

  const handleApply = useCallback(async (): Promise<void> => {
    if (!selectedId) return;
    setApplying(true);
    setApplyError(null);
    try {
      const result = await applyInvestigationToDraft(domain, selectedId, applyActor);
      setApplyResult(result.applied);
      await refreshList();
      await refreshWorkspace(selectedId);
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }, [domain, selectedId, applyActor, refreshList, refreshWorkspace]);

  const handleDiscard = useCallback(async (): Promise<void> => {
    if (!selectedId) return;
    setDiscarding(true);
    setDiscardError(null);
    try {
      await discardInvestigation(domain, selectedId, discardActor);
      await refreshList();
      await refreshWorkspace(selectedId);
    } catch (e) {
      setDiscardError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscarding(false);
    }
  }, [domain, selectedId, discardActor, refreshList, refreshWorkspace]);

  const evidence = workspace?.evidence;
  const proposal = workspace?.proposal;
  const storedValidation = workspace?.validation;
  const holdouts = workspace?.holdouts;
  const actions = workspace?.actions;

  const validationStatus: string | null = storedValidation?.status ?? null;

  return (
    <div
      style={{
        background: colors.whiteSurface,
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.lg,
        boxShadow: '0 1px 4px rgba(33,20,20,0.06)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          background: colors.uniformGreen,
          color: colors.feedBagCream,
          padding: '12px 18px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={() => setCollapsed((v) => !v)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: fonts.display, fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            4. Browser Investigation
          </span>
          <span
            style={{
              fontFamily: fonts.mono,
              fontSize: 11,
              background: investigations.length > 0 ? colors.seedlingGreen : colors.shadowPine,
              color: colors.feedBagCream,
              padding: '2px 8px',
              borderRadius: rounded.sm,
              border: '1px solid rgba(250,249,242,0.2)',
            }}
          >
            {investigations.length} investigation{investigations.length === 1 ? '' : 's'}
          </span>
        </div>
        <span
          style={{
            fontFamily: fonts.body,
            fontSize: 11,
            fontWeight: 700,
            color: colors.feedBagCream,
            background: 'rgba(250,249,242,0.15)',
            padding: '3px 8px',
            borderRadius: rounded.sm,
          }}
        >
          {collapsed ? '▼ Expand' : '▲ Collapse'}
        </span>
      </div>

      {!collapsed && (
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Launch */}
          <div style={card}>
            <h4 style={sectionTitle}>Launch investigation</h4>
            <div style={{ ...hint, marginBottom: 10 }}>
              Pick up to 5 representative product pages. Reserved holdouts are shown as
              reserved and are never sent to the investigator.
            </div>
            {suiteUrls.length === 0 ? (
              <div style={{ ...hint, marginBottom: 10 }}>
                No confirmed representatives yet — confirm suite samples above, or paste a
                product URL below.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                {suiteUrls.map((url) => {
                  const isReserved = isReservedUrl(url, reservedUrls);
                  const checked = launchSelected.includes(url);
                  return (
                    <label
                      key={url}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '6px 10px',
                        background: isReserved ? colors.feedBagCream : colors.whiteSurface,
                        border: `1px solid ${colors.cardBorder}`,
                        borderRadius: rounded.sm,
                        opacity: isReserved ? 0.65 : 1,
                        cursor: isReserved ? 'not-allowed' : 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isReserved}
                        onChange={() => toggleLaunchUrl(url)}
                        style={{ accentColor: colors.uniformGreen, width: 15, height: 15 }}
                      />
                      <span style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.ledgerCharcoal, wordBreak: 'break-all' }}>
                        {shortPath(url)}
                      </span>
                      {isReserved && (
                        <span
                          style={{
                            marginLeft: 'auto',
                            fontSize: 10,
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            padding: '2px 6px',
                            borderRadius: rounded.sm,
                            background: '#fef3c7',
                            color: '#92400e',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          Reserved holdout
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <input
                type="url"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                placeholder="https://… add a product page URL"
                style={{
                  flex: 1,
                  padding: '7px 10px',
                  fontSize: 12,
                  fontFamily: fonts.mono,
                  border: `1px solid ${colors.cardBorder}`,
                  borderRadius: rounded.sm,
                  background: colors.feedBagCream,
                  color: colors.ledgerCharcoal,
                }}
              />
              <button type="button" onClick={handleAddCustomUrl} style={ghostButton}>
                Add URL
              </button>
            </div>
            {launchSelected.length > 0 && (
              <div style={{ ...hint, marginBottom: 10 }}>
                Selected {launchSelected.length}/5: {launchSelected.map(shortPath).join(', ')}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => void handlePreviewBudgets()}
                disabled={previewLoading}
                style={ghostButton}
              >
                {previewLoading ? 'Previewing…' : 'Preview budgets'}
              </button>
              <button
                type="button"
                onClick={() => void handleCheckDriftEntry()}
                disabled={driftLoading}
                style={ghostButton}
              >
                {driftLoading ? 'Checking…' : 'Check drift entry'}
              </button>
              <button
                type="button"
                onClick={() => void handleLaunch('domain_onboarding')}
                disabled={launching !== null || launchSelected.length === 0}
                style={primaryButton(launching !== null || launchSelected.length === 0)}
              >
                {launching === 'domain_onboarding' ? 'Launching…' : 'Investigate Domain'}
              </button>
              <button
                type="button"
                onClick={() => void handleLaunch('drift_repair')}
                disabled={launching !== null || launchSelected.length === 0}
                style={primaryButton(launching !== null || launchSelected.length === 0)}
              >
                {launching === 'drift_repair' ? 'Launching…' : 'Investigate Drift'}
              </button>
            </div>
            {launchError && (
              <div role="alert" style={{ ...errorBox, marginTop: 10 }}>
                {launchError}
              </div>
            )}
            {previewError && (
              <div role="alert" style={{ ...errorBox, marginTop: 10 }}>
                {previewError}
              </div>
            )}
            {budgetRows && budgetRows.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: colors.ledgerCharcoal, marginBottom: 6 }}>
                  Budgets
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {budgetRows.map((row) => (
                    <div key={row.key} style={{ display: 'flex', gap: 8, fontSize: 12 }}>
                      <span style={{ color: colors.mulchBrown, minWidth: 220 }}>{row.label}</span>
                      <span style={{ fontFamily: fonts.mono, color: colors.ledgerCharcoal }}>{row.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {driftError && (
              <div role="alert" style={{ ...errorBox, marginTop: 10 }}>
                {driftError}
              </div>
            )}
            {driftPreview && (
              <div style={{ marginTop: 10, fontSize: 12, color: colors.ledgerCharcoal }}>
                {driftPreview.available === true ? (
                  <span>
                    Drift entry ready — last healthy {String(driftPreview.lastHealthyVersionId ?? 'version')}
                    {(Array.isArray(driftPreview.affectedFields) && driftPreview.affectedFields.length > 0)
                      ? `, affected: ${driftPreview.affectedFields.join(', ')}`
                      : ''}
                    {(Array.isArray(driftPreview.failureCodes) && driftPreview.failureCodes.length > 0)
                      ? `, failures: ${driftPreview.failureCodes.join(', ')}`
                      : ''}
                  </span>
                ) : (
                  <span style={hint}>
                    Drift entry unavailable: {String(driftPreview.reason ?? 'no baseline')}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Investigations list */}
          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <h4 style={{ ...sectionTitle, margin: 0 }}>Investigations</h4>
              <button
                type="button"
                onClick={() => void refreshList()}
                disabled={listLoading}
                style={ghostButton}
              >
                {listLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
            {listError && (
              <div role="alert" style={errorBox}>
                {listError}
              </div>
            )}
            {investigations.length === 0 && !listLoading ? (
              <div style={hint}>No investigations for this domain yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {investigations.map((inv) => (
                  <div
                    key={inv.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 12px',
                      background: selectedId === inv.id ? 'rgba(22, 132, 77, 0.08)' : colors.feedBagCream,
                      border: `1px solid ${selectedId === inv.id ? colors.seedlingGreen : colors.cardBorder}`,
                      borderRadius: rounded.sm,
                    }}
                  >
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        background: statusColor(inv.status),
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.ledgerCharcoal }}>
                      {inv.id}
                    </span>
                    <span style={{ fontSize: 11, color: colors.mulchBrown }}>
                      {modeLabel(inv.mode)} · {inv.status} · {inv.provider}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleSelect(inv.id)}
                      style={{ ...ghostButton, marginLeft: 'auto' }}
                    >
                      {selectedId === inv.id ? 'Selected' : 'Open'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Selected investigation */}
          {selectedId && (
            <div style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                <h4 style={{ ...sectionTitle, margin: 0 }}>
                  Investigation {selectedId}
                  {selectedStatus && (
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 11,
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: rounded.full,
                        background: statusColor(selectedStatus),
                        color: colors.feedBagCream,
                      }}
                    >
                      {selectedStatus}
                    </span>
                  )}
                </h4>
                {isActive && (
                  <button
                    type="button"
                    onClick={() => void handleCancel()}
                    disabled={cancelling}
                    style={primaryButton(cancelling)}
                  >
                    {cancelling ? 'Cancelling…' : 'Cancel investigation'}
                  </button>
                )}
              </div>
              {wsLoading && !workspace && <div style={hint}>Loading investigation…</div>}
              {wsError && (
                <div role="alert" style={errorBox}>
                  {wsError}
                </div>
              )}
              {workspace && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {/* Representatives + holdout coverage + budgets */}
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: colors.ledgerCharcoal, marginBottom: 6 }}>
                      Representatives & holdout coverage
                    </div>
                    <div style={{ fontSize: 12, color: colors.ledgerCharcoal, marginBottom: 4 }}>
                      Confirmed ({((workspace.representatives?.confirmed ?? []) as string[]).length}):{' '}
                      <span style={hint}>
                        {((workspace.representatives?.confirmed ?? []) as string[]).map(shortPath).join(', ') || 'none'}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: colors.ledgerCharcoal, marginBottom: 4 }}>
                      Investigated ({((workspace.representatives?.investigated ?? []) as string[]).length}):{' '}
                      <span style={hint}>
                        {((workspace.representatives?.investigated ?? []) as string[]).map(shortPath).join(', ') || 'none'}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: colors.ledgerCharcoal, marginBottom: 4 }}>
                      Holdouts — required {holdouts?.required ?? 1}, passed {holdouts?.passed ?? 0},
                      validation: {holdouts?.validationStatus ?? 'not_run'}
                    </div>
                    {reservedUrls.length > 0 ? (
                      <div style={{ fontSize: 12, color: colors.ledgerCharcoal }}>
                        Reserved ({reservedUrls.length}) — never sent to the investigator:{' '}
                        <span style={hint}>{reservedUrls.map(shortPath).join(', ')}</span>
                      </div>
                    ) : (
                      <div style={hint}>No reserved holdouts yet — reserve one before validating.</div>
                    )}
                    {holdouts?.suggestion && (
                      <div style={{ ...hint, marginTop: 4 }}>
                        Coverage suggestion: {((holdouts.suggestion.preferred ?? []) as string[]).length} preferred
                        {((holdouts.suggestion.gaps ?? []) as string[]).length > 0
                          ? `, gaps: ${((holdouts.suggestion.gaps ?? []) as string[]).join('; ')}`
                          : ', no gaps'}
                      </div>
                    )}
                    {Array.isArray(workspace.budgets) && workspace.budgets.length > 0 && (
                      <details style={{ marginTop: 6 }}>
                        <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 700, color: colors.uniformGreen }}>
                          Budgets ({(workspace.budgets as BudgetRow[]).length})
                        </summary>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                          {(workspace.budgets as BudgetRow[]).map((row) => (
                            <div key={row.key} style={{ display: 'flex', gap: 8, fontSize: 12 }}>
                              <span style={{ color: colors.mulchBrown, minWidth: 220 }}>{row.label}</span>
                              <span style={{ fontFamily: fonts.mono, color: colors.ledgerCharcoal }}>{row.value}</span>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>

                  {/* Evidence-rich results */}
                  {evidence && (
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: colors.ledgerCharcoal, marginBottom: 6 }}>
                        Evidence-rich results
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8, fontSize: 12 }}>
                        <div><span style={hint}>Platform: </span><strong>{evidence.platform ?? 'unknown'}</strong></div>
                        <div><span style={hint}>Provider: </span><strong>{evidence.provider ?? '—'}</strong></div>
                        <div><span style={hint}>Requested model: </span><strong>{evidence.requestedModel ?? 'unreported'}</strong></div>
                        <div><span style={hint}>Acting model: </span><strong>{evidence.actualModel ?? 'unreported'}</strong></div>
                        <div><span style={hint}>Usage: </span><strong>{evidence.usage ? `${evidence.usage.modelCalls ?? '—'} calls · ${evidence.usage.pagesVisited ?? '—'} pages · ${evidence.usage.readsPerformed ?? '—'} reads` : 'unavailable'}</strong></div>
                        <div><span style={hint}>Cost: </span><strong>{evidence.usage?.costDisplay ?? 'unavailable'}</strong></div>
                      </div>
                      {Array.isArray(evidence.structures) && evidence.structures.length > 0 && (
                        <div style={{ fontSize: 12, marginTop: 6 }}>
                          <span style={hint}>Structures ({evidence.structures.length}): </span>
                          {evidence.structures.map((s: { id: string; platformSource?: string }) => (
                            <span key={s.id} style={{ fontFamily: fonts.mono, marginRight: 8 }}>
                              {s.id}{s.platformSource ? ` (${s.platformSource})` : ''}
                            </span>
                          ))}
                        </div>
                      )}
                      {Array.isArray(evidence.fieldRecommendations) && evidence.fieldRecommendations.length > 0 && (
                        <details style={{ marginTop: 6 }}>
                          <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 700, color: colors.uniformGreen }}>
                            Field recommendations ({evidence.fieldRecommendations.length})
                          </summary>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                            {evidence.fieldRecommendations.map((r: { field: string; sources: string[]; evidenceRef?: string }) => (
                              <div key={r.field} style={{ fontSize: 12 }}>
                                <strong>{r.field}</strong>{' '}
                                <span style={hint}>from {(r.sources ?? []).join(', ')}{r.evidenceRef ? ` · ${r.evidenceRef}` : ''}</span>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                      {evidence.identity && (
                        <div style={{ fontSize: 12, marginTop: 6 }}>
                          <span style={hint}>Identity — product: </span>
                          {(evidence.identity.productIdentity ?? []).join(', ') || 'none'}
                          <span style={hint}> · variant: </span>
                          {(evidence.identity.variantIdentity ?? []).join(', ') || 'none'}
                          {(evidence.identity.optionAxes ?? []).length > 0 && (
                            <span><span style={hint}> · axes: </span>{(evidence.identity.optionAxes ?? []).join(', ')}</span>
                          )}
                        </div>
                      )}
                      {Array.isArray(evidence.gaps) && evidence.gaps.length > 0 && (
                        <div style={{ fontSize: 12, marginTop: 6 }}>
                          <span style={hint}>Gaps ({evidence.gaps.length}): </span>
                          {evidence.gaps.join('; ')}
                        </div>
                      )}
                      {evidence.codeAdapterNeeded && (
                        <div style={{ fontSize: 12, marginTop: 6 }}>
                          <span style={hint}>Code adapter needed: </span>
                          <strong>{evidence.codeAdapterNeeded.capability}</strong> — {evidence.codeAdapterNeeded.reason}
                        </div>
                      )}
                      {evidence.renderedBrowser && (
                        <div style={{ fontSize: 12, marginTop: 6 }}>
                          <span style={hint}>Rendered browser: </span>
                          {evidence.renderedBrowser.required ? `required — ${evidence.renderedBrowser.reason ?? ''}` : 'not required'}
                        </div>
                      )}
                      {Array.isArray(evidence.evidenceLinks) && evidence.evidenceLinks.length > 0 && (
                        <div style={{ fontSize: 12, marginTop: 6 }}>
                          <span style={hint}>Evidence refs ({evidence.evidenceLinks.length}): </span>
                          <span style={{ fontFamily: fonts.mono }}>{evidence.evidenceLinks.join(', ')}</span>
                        </div>
                      )}
                      {evidence.failure && (
                        <div role="alert" style={{ ...errorBox, marginTop: 6 }}>
                          {evidence.failure.code}{evidence.failure.detail ? `: ${evidence.failure.detail}` : ''}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Proposal preview + stored validation */}
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: colors.ledgerCharcoal, marginBottom: 6 }}>
                      Proposal preview & stored validation
                    </div>
                    {proposal?.available === true ? (
                      <div style={{ fontSize: 12, color: colors.ledgerCharcoal }}>
                        {proposal.status} · {proposal.structuresCount} structures · {proposal.fieldsCount} fields ·{' '}
                        proposal {shortHash(proposal.proposalHash)} · policy {shortHash(proposal.policyHash)}
                        {(proposal.gaps ?? []).length > 0 && (
                          <span style={hint}> · gaps: {(proposal.gaps as string[]).join('; ')}</span>
                        )}
                        {proposal.capability && (
                          <span style={hint}> · capability: {proposal.capability}</span>
                        )}
                      </div>
                    ) : (
                      <div style={hint}>
                        No proposal to preview{proposal?.reason ? `: ${proposal.reason}` : ''}.
                      </div>
                    )}
                    {storedValidation ? (
                      <div style={{ fontSize: 12, color: colors.ledgerCharcoal, marginTop: 6 }}>
                        Stored validation <strong>{storedValidation.validationId ?? ''}</strong> — status{' '}
                        <strong>{storedValidation.status}</strong> · holdouts {storedValidation.holdouts?.passed ?? 0}/
                        {storedValidation.holdouts?.required ?? 1}
                        {(storedValidation.blockers ?? []).length > 0 && (
                          <span> · blockers: {(storedValidation.blockers as string[]).join('; ')}</span>
                        )}
                        {Array.isArray(storedValidation.samples) && storedValidation.samples.length > 0 && (
                          <details style={{ marginTop: 4 }}>
                            <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 700, color: colors.uniformGreen }}>
                              Samples ({storedValidation.samples.length})
                            </summary>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                              {storedValidation.samples.map((s: { url: string; role: string; status: string; identityOutcome?: string; failureReasons?: string[] }) => (
                                <div key={`${s.role}:${s.url}`} style={{ fontSize: 12 }}>
                                  <span style={{ fontFamily: fonts.mono }}>{shortPath(s.url)}</span>{' '}
                                  <span style={hint}>{s.role} · {s.status}{s.identityOutcome ? ` · ${s.identityOutcome}` : ''}</span>
                                  {(s.failureReasons ?? []).length > 0 && (
                                    <span style={hint}> — {(s.failureReasons as string[]).join('; ')}</span>
                                  )}
                                </div>
                              ))}
                            </div>
                          </details>
                        )}
                      </div>
                    ) : (
                      <div style={{ ...hint, marginTop: 6 }}>No stored validation yet — validate the proposal below.</div>
                    )}
                  </div>

                  {/* Separate actions */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {/* Validate */}
                    <div style={{ border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.sm, padding: 12 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: colors.ledgerCharcoal, marginBottom: 4 }}>
                        Validate proposal
                      </div>
                      <div style={{ ...hint, marginBottom: 8 }}>
                        {actions ? reasonText(actions.validate.allowed, actions.validate.reason) : 'Load the workspace to see availability.'}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                        {validateEntries.map((entry) => (
                          <div key={`${entry.role}:${entry.url}`} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 700,
                                textTransform: 'uppercase',
                                padding: '2px 6px',
                                borderRadius: rounded.sm,
                                background: entry.role === 'holdout' ? '#fef3c7' : colors.feedBagCream,
                                color: entry.role === 'holdout' ? '#92400e' : colors.mulchBrown,
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {entry.role}
                            </span>
                            <span style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.ledgerCharcoal, minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={entry.url}>
                              {shortPath(entry.url)}
                            </span>
                            <input
                              type="text"
                              value={entry.expectedName}
                              onChange={(e) =>
                                setExpectedNames((prev) => ({ ...prev, [`${entry.role}:${entry.url}`]: e.target.value }))
                              }
                              placeholder="Expected product name"
                              style={{
                                width: 220,
                                padding: '5px 8px',
                                fontSize: 12,
                                border: `1px solid ${colors.cardBorder}`,
                                borderRadius: rounded.sm,
                              }}
                            />
                          </div>
                        ))}
                      </div>
                      {!holdoutCoverageMet && reservedUrls.length > 0 && (
                        <div style={{ ...hint, marginBottom: 8 }}>
                          Every reserved holdout must run — fill in the expected name for each holdout row.
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleValidate()}
                        disabled={validating || actions?.validate.allowed !== true || !holdoutCoverageMet}
                        style={primaryButton(validating || actions?.validate.allowed !== true || !holdoutCoverageMet)}
                      >
                        {validating ? 'Validating…' : 'Run validation'}
                      </button>
                      {validateError && (
                        <div role="alert" style={{ ...errorBox, marginTop: 8 }}>
                          {validateError}
                        </div>
                      )}
                    </div>

                    {/* Apply */}
                    <div style={{ border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.sm, padding: 12 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: colors.ledgerCharcoal, marginBottom: 4 }}>
                        Apply to Draft
                      </div>
                      <div style={{ ...hint, marginBottom: 8 }}>
                        {actions ? reasonText(actions.apply.allowed, actions.apply.reason) : 'Load the workspace to see availability.'}
                        {' '}Sends the operator name only — the server binds the stored validation by hash.
                      </div>
                      {(validationStatus === 'failed' || validationStatus === 'incomplete') && (
                        <div style={{ ...hint, marginBottom: 8 }}>
                          Failed or incomplete validation still applies as a blocked draft — blockers stay visible on the draft.
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          type="text"
                          value={applyActor}
                          onChange={(e) => setApplyActor(e.target.value)}
                          placeholder="Operator name"
                          style={{
                            width: 220,
                            padding: '5px 8px',
                            fontSize: 12,
                            border: `1px solid ${colors.cardBorder}`,
                            borderRadius: rounded.sm,
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => void handleApply()}
                          disabled={applying || actions?.apply.allowed !== true || !applyActor.trim()}
                          style={primaryButton(applying || actions?.apply.allowed !== true || !applyActor.trim())}
                        >
                          {applying ? 'Applying…' : 'Apply to Draft'}
                        </button>
                      </div>
                      {applyError && (
                        <div role="alert" style={{ ...errorBox, marginTop: 8 }}>
                          {applyError}
                        </div>
                      )}
                      {applyResult && (
                        <div role="status" style={{ fontSize: 12, color: colors.uniformGreen, marginTop: 8 }}>
                          Draft {String(applyResult.appliedVersionId ?? 'created')}
                          {Array.isArray(applyResult.blockers) && applyResult.blockers.length > 0
                            ? ` — blockers: ${(applyResult.blockers as string[]).join('; ')}`
                            : ' — no blockers'}
                        </div>
                      )}
                    </div>

                    {/* Discard */}
                    <div style={{ border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.sm, padding: 12 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: colors.ledgerCharcoal, marginBottom: 4 }}>
                        Discard investigation
                      </div>
                      <div style={{ ...hint, marginBottom: 8 }}>
                        {actions ? reasonText(actions.discard.allowed, actions.discard.reason) : 'Load the workspace to see availability.'}
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          type="text"
                          value={discardActor}
                          onChange={(e) => setDiscardActor(e.target.value)}
                          placeholder="Operator name"
                          style={{
                            width: 220,
                            padding: '5px 8px',
                            fontSize: 12,
                            border: `1px solid ${colors.cardBorder}`,
                            borderRadius: rounded.sm,
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => void handleDiscard()}
                          disabled={discarding || actions?.discard.allowed !== true || !discardActor.trim()}
                          style={ghostButton}
                        >
                          {discarding ? 'Discarding…' : 'Discard'}
                        </button>
                      </div>
                      {discardError && (
                        <div role="alert" style={{ ...errorBox, marginTop: 8 }}>
                          {discardError}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
