/**
 * Epic #46 Phase 4 — Official Site resolution workspace.
 *
 * ONE continuous operator workflow combining URL verification and extractor
 * setup (epic UX workstream 3). Rendered by the Batch Workspace shell inside
 * a modal drawer for a single itemId:
 *
 *   identity panel (sticky) → candidate URL decision → extractor status →
 *   domain-level release → done
 *
 * Also handles the other attention reasons: source conflicts (distributor
 * evidence decision) and processing failures (retry). Every mutation shows
 * explicit saving/success/error states; nothing is ever silently swallowed.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import type { DomainReleaseResponse } from '../../../../shared/schemas/onboarding-work-state';
import type { OnboardingEvidenceConflict } from '../../../../shared/schemas/distributor';
import type { OnboardingSource, OnboardingItem } from '../../../../shared/schemas/onboarding';
import {
  assignItemBrand,
  assignItemDomain,
  continueWithOfficialDiscovery,
  getItemConflicts,
  getItemDetail,
  resolveItemConflict,
  resolveSourcingAction,
  retryItem,
  selectSource,
  setItemUrl,
} from '../../../onboarding-api';
import { getItemWorkState } from '../../../onboarding-work-api';
import { CandidateUrlPanel } from './CandidateUrlPanel';
import { ExtractorStatusPanel } from './ExtractorStatusPanel';
import { SemanticConflictPanel } from './SemanticConflictPanel';
import { ChooseVariantPanel } from './ChooseVariantPanel';
import { ManualEvidencePanel } from './ManualEvidencePanel';
import { selectVariant } from '../../../onboarding-api';
import { domainFromUrl, getAttentionConsequence } from './attention-logic';
import './attention.css';
import './semantic-conflict.css';

interface OfficialSiteResolutionWorkspaceProps {
  batchId: string;
  itemId: string;
  /** Called when the blocker is resolved so the shell can close the drawer. */
  onResolved?: () => void;
}

type Phase =
  | 'loading'
  | 'load-error'
  | 'url' // candidate decision / manual URL
  | 'variant' // choose_variant matrix
  | 'extractor' // extractor status after URL confirmation (or directly)
  | 'manual' // parent #101: operator manual evidence for family-page-only brands
  | 'conflicts' // distributor evidence conflict decision
  | 'semantic' // Curation blocked by semantic validation findings
  | 'retry' // processing failure
  | 'done'; // blocker resolved — close when ready

function parseValue(valueJson: string): string {
  try {
    const parsed = JSON.parse(valueJson) as unknown;
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      // Distributor evidence values are stored as { value } or { valueJson }.
      const v = record.value ?? record.valueJson ?? record.name ?? record.label;
      if (typeof v === 'string') return v;
      return JSON.stringify(parsed);
    }
    return String(parsed);
  } catch {
    return valueJson;
  }
}

export function OfficialSiteResolutionWorkspace({
  batchId,
  itemId,
  onResolved,
}: OfficialSiteResolutionWorkspaceProps): React.ReactElement {
  const [phase, setPhase] = useState<Phase>('loading');
  const [workState, setWorkState] = useState<OnboardingWorkState | null>(null);
  const [item, setItem] = useState<OnboardingItem | null>(null);
  const [sources, setSources] = useState<OnboardingSource[]>([]);
  const [qualificationView, setQualificationView] = useState<{
    qualified: boolean;
    reasonCodes: string[];
    acceptedEvidenceAttemptIds: string[];
    providerIds: string[];
    evidenceHash: string | null;
  } | null>(null);
  const [evidenceAttemptCount, setEvidenceAttemptCount] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmedUrl, setConfirmedUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<
    | 'select-source'
    | 'set-url'
    | 'retry'
    | 'conflict'
    | 'sourcing-route'
    | 'rerun-cohort'
    | 'assign-brand'
    | 'assign-domain'
    | null
  >(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [releaseResult, setReleaseResult] = useState<DomainReleaseResponse | null>(null);
  /** Honest resolution note rendered in the done phase (semantic re-run etc.). */
  const [resolutionNote, setResolutionNote] = useState<string | null>(null);
  const [variantDetail, setVariantDetail] = useState<any | null>(null);

  // Conflict state (source_conflict flow)
  const [conflicts, setConflicts] = useState<OnboardingEvidenceConflict[] | null>(null);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});

  const containerRef = useRef<HTMLDivElement>(null);

  const loadDetail = useCallback(async () => {
    setLoadError(null);
    try {
      const [detail, ws] = await Promise.all([getItemDetail(itemId), getItemWorkState(itemId)]);
      setItem(detail.item);
      setSources(detail.sources ?? []);
      setWorkState(ws.workState);
      setQualificationView(detail.sourcingQualificationView ?? null);
      setEvidenceAttemptCount(detail.evidenceAttempts?.length ?? 0);
      setResolutionNote(null);
      // load variant resolution if present
      try { const vd = (detail as any).variantResolution; if (vd) setVariantDetail(vd); else setVariantDetail(null); } catch {}
      const reason = ws.workState.attentionReason;
      if (reason === 'choose_variant') {
        setPhase('variant');
      } else if (reason === 'source_conflict') {
        setPhase('conflicts');
      } else if (reason === 'semantic_validation_blocked') {
        setPhase('semantic');
      } else if (reason === 'processing_failed') {
        setPhase('retry');
      } else if (reason === 'manual_evidence_available') {
        setPhase('manual');
      } else if (
        reason === 'extractor_profile_required' ||
        reason === 'extraction_profile_failed'
      ) {
        setPhase('extractor');
      } else {
        setPhase('url');
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load this product');
      setPhase('load-error');
    }
  }, [itemId]);

  useEffect(() => {
    void loadDetail();
    // Focus the workspace on mount so keyboard operation starts here.
    containerRef.current?.focus();
  }, [loadDetail]);

  // Esc closes the drawer (focus is trapped by the shell's dialog).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onResolved?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onResolved]);

  const loadConflicts = useCallback(async () => {
    setConflictError(null);
    try {
      const res = await getItemConflicts(itemId);
      setConflicts(res.conflicts);
      // Only HARD open conflicts gate advancement: the server completes
      // sourcing when the last open HARD conflict is resolved (soft
      // discrepancies are informational and never block).
      const open = res.conflicts.filter((c) => c.status === 'open' && c.severity === 'hard');
      if (open.length === 0) {
        // Every open hard conflict resolved — sourcing completes automatically.
        const ws = await getItemWorkState(itemId).catch(() => null);
        if (ws && ws.workState.category !== 'needs_attention') {
          onResolved?.();
          return;
        }
      }
    } catch (err) {
      setConflictError(err instanceof Error ? err.message : 'Could not load conflicts');
    }
  }, [itemId, onResolved]);

  // Load conflicts when entering the conflicts phase.
  useEffect(() => {
    if (phase === 'conflicts') void loadConflicts();
  }, [phase, loadConflicts]);

  // ── URL decision ────────────────────────────────────────────────────────

  const handleConfirmCandidate = async (source: OnboardingSource) => {
    setBusy('select-source');
    setMutationError(null);
    try {
      await selectSource(itemId, source.id);
      setConfirmedUrl(source.url);
      setPhase('extractor');
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Could not confirm this page');
    } finally {
      setBusy(null);
    }
  };

  const handleManualUrl = async (url: string) => {
    setBusy('set-url');
    setMutationError(null);
    try {
      await setItemUrl(itemId, url);
      setConfirmedUrl(url);
      setPhase('extractor');
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Could not save that URL');
      throw err; // surfaced by the manual input
    } finally {
      setBusy(null);
    }
  };

  // ── Brand / official-domain assignment (ADR 0017 commitment 4) ────────

  const [brandInput, setBrandInput] = useState('');
  const [domainInput, setDomainInput] = useState('');

  // Prefill the inputs ONCE per item (ADR 0017 review fix): a ref tracking
  // the last-prefilled item id means an intentional clear is never
  // repopulated by a later item reload, while the `prev || …` guard still
  // never clobbers in-progress typing during the first prefill.
  const lastPrefilledItemId = useRef<string | null>(null);
  useEffect(() => {
    if (!item || lastPrefilledItemId.current === itemId) return;
    lastPrefilledItemId.current = itemId;
    setBrandInput((prev) => prev || (item.brandHint ?? ''));
    const prefillDomain = item.sourceUrl ? domainFromUrl(item.sourceUrl) : null;
    if (prefillDomain) setDomainInput((prev) => prev || prefillDomain);
  }, [item, itemId]);

  const handleAssignBrand = async () => {
    const brand = brandInput.trim();
    if (!brand) {
      setMutationError('Enter a brand name first.');
      return;
    }
    setBusy('assign-brand');
    setMutationError(null);
    try {
      await assignItemBrand(itemId, brand);
      setMutationError(null); // a previously seen error must not persist after success
      setResolutionNote(
        `Brand set to “${brand}”. Official site discovery re-queued — this product re-searches the brand's official site automatically.`,
      );
      setPhase('done');
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Could not assign the brand');
    } finally {
      setBusy(null);
    }
  };

  const handleAssignDomain = async () => {
    const domain = domainInput.trim();
    if (!domain) {
      setMutationError('Enter an official brand domain first.');
      return;
    }
    setBusy('assign-domain');
    setMutationError(null);
    try {
      await assignItemDomain(itemId, domain);
      setMutationError(null); // a previously seen error must not persist after success
      setResolutionNote(
        `Official domain mapped: ${domain
          .replace(/^https?:\/\//i, '')
          .replace(/\/.*$/, '')}. Discovery re-queued — this product re-searches the mapped domain automatically.`,
      );
      setPhase('done');
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Could not map the domain');
    } finally {
      setBusy(null);
    }
  };

  const hasBrand = Boolean(workState?.brand || item?.brandHint);

  const suggestedBrandFromName = useMemo(() => {
    const name = workState?.name ?? item?.name ?? '';
    if (!name) return null;
    const firstWord = name.split(/\s+/)[0]?.trim();
    return firstWord && firstWord.length > 1 ? firstWord : null;
  }, [workState?.name, item?.name]);

  const renderBrandSection = () => (
    <section
      className="attn-section"
      aria-label="Brand and official domain"
      style={!hasBrand ? { border: '2px solid var(--color-card-border)', background: 'var(--color-white-surface)' } : undefined}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <h3 className="attn-section-title" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
          🏷️ {hasBrand ? 'Brand & official domain' : 'Brand Assignment Required'}
        </h3>
        {!hasBrand && (
          <span
            className="attn-badge attn-badge-danger"
            style={{ background: '#fee2e2', color: '#991b1b', fontSize: '0.75rem', padding: '2px 8px' }}
          >
            Action Required
          </span>
        )}
      </div>
      <div className="attn-section-body">
        <p style={{ margin: 0, fontFamily: 'var(--font-body)', fontSize: '0.8125rem', color: 'var(--color-mulch-brown)' }}>
          {hasBrand
            ? 'Assigning the official domain re-runs discovery scoped to it — the next search targets the brand site and can auto-confirm only mapped domains.'
            : 'This product has no brand assigned yet. Assign a brand so discovery can target the brand’s official site, then map its official domain.'}
        </p>

        {!hasBrand && suggestedBrandFromName && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--color-mulch-brown)' }}>Suggested from product title:</span>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              style={{ padding: '2px 8px', fontSize: '0.75rem', borderColor: '#14532d', color: '#14532d', fontWeight: 600 }}
              onClick={() => setBrandInput(suggestedBrandFromName)}
            >
              + Use "{suggestedBrandFromName}"
            </button>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <label htmlFor="attn-brand" className="text-label" style={{ color: 'var(--color-mulch-brown)', fontWeight: 600 }}>
            Brand name
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input
              id="attn-brand"
              className="input"
              placeholder="e.g. ACANA, Fromm, Nulo"
              value={brandInput}
              onChange={(e) => setBrandInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAssignBrand();
              }}
              disabled={busy !== null}
            />
            <button
              type="button"
              className="btn btn-outline"
              style={{
                flexShrink: 0,
                background: !hasBrand ? '#14532d' : undefined,
                color: !hasBrand ? '#fff' : undefined,
                borderColor: !hasBrand ? '#14532d' : undefined,
                fontWeight: 600,
              }}
              onClick={() => void handleAssignBrand()}
              disabled={busy !== null || brandInput.trim().length === 0}
            >
              {busy === 'assign-brand' ? 'Assigning…' : 'Assign Brand & Re-search'}
            </button>
          </div>
          <label htmlFor="attn-domain" className="text-label" style={{ color: 'var(--color-mulch-brown)' }}>
            Official domain (optional)
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input
              id="attn-domain"
              className="input"
              placeholder="e.g. frommfamily.com"
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAssignDomain();
              }}
              disabled={busy !== null}
            />
            <button
              type="button"
              className="btn btn-outline"
              style={{ flexShrink: 0 }}
              onClick={() => void handleAssignDomain()}
              disabled={busy !== null || domainInput.trim().length === 0}
            >
              {busy === 'assign-domain' ? 'Mapping…' : 'Map Domain & Re-search'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );

  // ── Conflict resolution ──────────────────────────────────────────────────

  const handleResolveConflict = async (conflictId: string, body: Parameters<typeof resolveItemConflict>[2]) => {
    setBusy('conflict');
    setMutationError(null);
    try {
      await resolveItemConflict(itemId, conflictId, body);
      await loadConflicts();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Could not resolve that conflict');
    } finally {
      setBusy(null);
    }
  };

  const handleSourcingRoute = async (action: 'use_distributor_record' | 'fallback_to_discovery') => {
    setBusy('sourcing-route');
    setMutationError(null);
    try {
      await resolveSourcingAction(itemId, action);
      onResolved?.();
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Could not apply that decision');
    } finally {
      setBusy(null);
    }
  };

  // ── Retry (processing failure) ───────────────────────────────────────────

  const handleRetry = async () => {
    setBusy('retry');
    setMutationError(null);
    try {
      await retryItem(itemId);
      setResolutionNote(
        reason === 'semantic_validation_blocked'
          ? 'Curation re-queued — this product re-runs automatically; it returns to Review once the findings are resolved.'
          : null,
      );
      setPhase('done');
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setBusy(null);
    }
  };

  const handleContinueOfficial = async () => {
    setBusy('retry');
    setMutationError(null);
    try {
      await continueWithOfficialDiscovery(itemId);
      setPhase('done');
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Could not switch to official site discovery');
    } finally {
      setBusy(null);
    }
  };

  // ── Semantic conflict (Curation blocked) ────────────────────────────────

  /**
   * Re-run the whole family's Curation via the canonical cohort re-run
   * endpoint (POST /api/onboarding/cohorts/:id/re-run). Cohort-owned
   * resolution: members reset to curation/pending in one cohort-atomic
   * transaction, then the cohort claims and re-freezes automatically.
   */
  const handleReRunCohort = async () => {
    if (!family?.cohortId) return;
    setBusy('rerun-cohort');
    setMutationError(null);
    try {
      const res = await fetch(
        `/api/onboarding/cohorts/${encodeURIComponent(family.cohortId)}/re-run`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: unknown };
      if (!res.ok) {
        const errMsg =
          typeof data.error === 'string' ? data.error : 'Could not re-run family curation';
        throw new Error(errMsg);
      }
      // The cohort re-run supersedes the old run and resets the members; the
      // worker claims the cohort automatically. Stay honest: resolution is
      // pending re-curation, not a guaranteed pass.
      setResolutionNote(
        'Family Curation re-queued — all members re-run automatically, and this product returns to Review once the findings are resolved.',
      );
      setPhase('done');
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Could not re-run family curation');
    } finally {
      setBusy(null);
    }
  };

  // ── Derived context ──────────────────────────────────────────────────────

  const domain = workState?.domain ?? domainFromUrl(item?.sourceUrl) ?? domainFromUrl(confirmedUrl);
  const isDistributor = (workState?.sourceType ?? item?.sourceType) === 'distributor_record';
  const reason = workState?.attentionReason ?? null;
  const consequence = getAttentionConsequence(reason, workState?.detail);
  const family = workState?.family ?? null;
  // Curation-semantic findings from the committed curation payload. The
  // projection only maps to semantic_validation_blocked when status is
  // 'blocked', so findings are authoritative here (deterministic messages).
  const semanticValidation = item?.curationData?.semanticValidation ?? null;
  const semanticFindings =
    semanticValidation && semanticValidation.status === 'blocked' && Array.isArray(semanticValidation.findings)
      ? semanticValidation.findings
      : [];

  if (phase === 'loading') {
    return (
      <div className="attn-workspace" role="status" aria-label="Loading product">
        <div className="attn-skeleton">
          <div className="attn-skeleton-line" style={{ width: '45%' }} />
          <div className="attn-skeleton-line" style={{ width: '80%' }} />
          <div className="attn-skeleton-line" style={{ width: '60%' }} />
        </div>
      </div>
    );
  }

  if (phase === 'load-error') {
    return (
      <div className="attn-workspace">
        <div className="attn-error" role="alert">
          <div style={{ marginBottom: 12 }}>{loadError ?? 'Could not load this product.'}</div>
          <button type="button" className="btn btn-outline" onClick={() => void loadDetail()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Resolution decisions are required only for HARD identity conflicts.
  // Soft discrepancies (distributorSku/name/copy variants) never gate
  // advancement; legacy soft rows render as informational only.
  const hardOpenConflicts = (conflicts ?? []).filter((c) => c.status === 'open' && c.severity === 'hard');
  const softOpenConflicts = (conflicts ?? []).filter((c) => c.status === 'open' && c.severity === 'soft');

  return (
    <div
      className="attn-workspace"
      ref={containerRef}
      tabIndex={-1}
      style={{ outline: 'none', height: '100%' }}
      aria-label="Resolve product"
    >
      {/* ── Sticky identity panel ─────────────────────────────────────── */}
      <div className="attn-identity">
        <div className="attn-identity-name">{workState?.name ?? item?.name ?? ''}</div>
        <div className="attn-identity-meta">
          <span>UPC {workState?.upc ?? item?.upc ?? ''}</span>
          {workState?.brand || item?.brandHint ? <span>{workState?.brand ?? item?.brandHint}</span> : null}
          {item?.expectedName && item.expectedName !== item?.name ? <span>imported as “{item.expectedName}”</span> : null}
          <span
            className="badge"
            style={{
              background: isDistributor ? 'var(--color-warning-bg)' : 'var(--color-feed-bag-cream)',
              color: isDistributor ? 'var(--color-warning-text)' : 'var(--color-ledger-charcoal)',
              border: '1px solid var(--color-card-border)',
            }}
          >
            {isDistributor ? 'Distributor record' : 'Official page'}
          </span>
        </div>
        {family ? (
          <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.8125rem', color: 'var(--color-mulch-brown)' }}>
            Family: <strong>{family.label}</strong> — {family.readyCount} / {family.memberCount} members ready
            {family.waitingOnItemIds.length > 0 ? ` (waiting on ${family.waitingOnItemIds.length} sibling${family.waitingOnItemIds.length === 1 ? '' : 's'})` : ''}
          </div>
        ) : null}
        {isDistributor && qualificationView ? (
          <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.8125rem', color: 'var(--color-mulch-brown)' }}>
            Distributor evidence: {qualificationView.acceptedEvidenceAttemptIds.length} accepted record
            {qualificationView.acceptedEvidenceAttemptIds.length === 1 ? '' : 's'}
            {qualificationView.providerIds.length > 0
              ? ` from ${qualificationView.providerIds.join(', ')}`
              : ''}
            {qualificationView.qualified ? ' · qualified' : ' · needs decision'}
          </div>
        ) : isDistributor && evidenceAttemptCount > 0 ? (
          <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.8125rem', color: 'var(--color-mulch-brown)' }}>
            {evidenceAttemptCount} distributor evidence attempt{evidenceAttemptCount === 1 ? '' : 's'} recorded
          </div>
        ) : null}
      </div>

      {/* ── Body ──────────────────────────────────────────────────────── */}
      <div className="attn-workspace-body">
        {mutationError ? (
          <div className="attn-error" role="alert">
            {mutationError}
          </div>
        ) : null}

        {phase === 'variant' && variantDetail ? (
          <ChooseVariantPanel
            resolutionId={variantDetail.id}
            identityMatrixHash={variantDetail.identityMatrixHash}
            candidates={variantDetail.candidates.map((c:any)=>({ variantKey:c.variantKey, title:c.title, sku:c.identifiers?.find((i:any)=>i.kind==='sku')?.value ?? null, gtin:c.identifiers?.find((i:any)=>i.kind==='gtin')?.value ?? null, price:c.price ?? null, available:c.available, image:c.images?.[0]?.url ?? null, options:c.options }))}
            onSelect={async (key)=>{ await selectVariant(itemId, { resolutionId: variantDetail.id, identityMatrixHash: variantDetail.identityMatrixHash, variantKey: key }); setResolutionNote(`Variant selected — extraction re-queued.`); setPhase('done'); }}
          />
        ) : null}

        {phase === 'url' ? (
          <>
            {!hasBrand && renderBrandSection()}
            <CandidateUrlPanel
              candidates={sources}
              itemName={workState?.name ?? item?.name ?? ''}
              expectedName={item?.expectedName}
              upc={workState?.upc ?? item?.upc ?? ''}
              busy={busy === 'select-source' || busy === 'set-url' ? (busy as 'confirming' | 'saving-url') : null}
              onConfirm={(source) => void handleConfirmCandidate(source)}
              onUseManualUrl={handleManualUrl}
            />
            {hasBrand && renderBrandSection()}
          </>
        ) : null}

        {phase === 'extractor' && domain ? (
          <ExtractorStatusPanel
            domain={domain}
            attentionReason={reason}
            seedItem={
              item
                ? { expectedName: item.expectedName, upc: item.upc, brandHint: item.brandHint }
                : null
            }
            onRetry={() => void handleRetry()}
            onReleaseResult={(result) => {
              setReleaseResult(result);
              setPhase('done');
            }}
          />
        ) : null}

        {phase === 'manual' ? (
          <ManualEvidencePanel
            itemId={itemId}
            defaultTitle={workState?.name ?? item?.name ?? ''}
            defaultBrand={workState?.brand ?? item?.brandHint ?? null}
            onSubmitted={() => {
              setResolutionNote('Manual evidence submitted — extraction complete, item returns to Review.');
              setPhase('done');
            }}
          />
        ) : null}

        {phase === 'conflicts' ? (
          <section className="attn-section" aria-label="Distributor match conflict">
            <h3 className="attn-section-title">Distributor match — decide the correct value</h3>
            <div className="attn-section-body">
              {conflictError ? (
                <div className="attn-error" style={{ padding: 8, fontSize: '0.75rem' }} role="alert">
                  {conflictError}
                </div>
              ) : null}
              {conflicts === null ? (
                <span className="attn-mutating">
                  <span className="attn-spinner" aria-hidden="true" /> Loading conflicts…
                </span>
              ) : hardOpenConflicts.length === 0 ? (
                <>
                  <p style={{ margin: 0, fontFamily: 'var(--font-body)', fontSize: '0.8125rem' }}>
                    No open identity conflicts. Choose how to proceed:
                  </p>
                  {softOpenConflicts.length > 0 ? (
                    <p
                      style={{
                        margin: '8px 0 0',
                        fontFamily: 'var(--font-body)',
                        fontSize: '0.8125rem',
                        color: 'var(--color-mulch-brown)',
                      }}
                    >
                      Remaining discrepancies are informational and don&apos;t block progress.
                    </p>
                  ) : null}
                </>
              ) : (
                hardOpenConflicts.map((conflict) => (
                  <div className="attn-conflict" key={conflict.id}>
                    <div className="attn-conflict-field">{conflict.field}</div>
                    {conflict.candidates.map((candidate) => (
                      <div className="attn-conflict-candidate" key={candidate.id}>
                        <span style={{ overflowWrap: 'anywhere' }}>{parseValue(candidate.valueJson)}</span>
                        <button
                          type="button"
                          className="btn btn-outline"
                          style={{ height: '2rem', padding: '0 0.75rem', flexShrink: 0 }}
                          onClick={() => void handleResolveConflict(conflict.id, { action: 'resolve_candidate', candidateId: candidate.id })}
                          disabled={busy !== null}
                        >
                          Use This Value
                        </button>
                      </div>
                    ))}
                    <div className="attn-candidate-actions">
                      <input
                        className="input"
                        style={{ maxWidth: 260, height: '2rem' }}
                        placeholder="Custom value…"
                        value={customValues[conflict.id] ?? ''}
                        onChange={(e) => setCustomValues((prev) => ({ ...prev, [conflict.id]: e.target.value }))}
                        disabled={busy !== null}
                      />
                      <button
                        type="button"
                        className="btn btn-outline"
                        style={{ height: '2rem', padding: '0 0.75rem' }}
                        onClick={() => {
                          const value = (customValues[conflict.id] ?? '').trim();
                          if (value) void handleResolveConflict(conflict.id, { action: 'custom_value', customValue: value });
                        }}
                        disabled={busy !== null || (customValues[conflict.id] ?? '').trim().length === 0}
                      >
                        Use Custom Value
                      </button>
                      <button
                        type="button"
                        className="btn btn-outline"
                        style={{ height: '2rem', padding: '0 0.75rem', borderColor: 'var(--color-card-border)', color: 'var(--color-mulch-brown)' }}
                        onClick={() => void handleResolveConflict(conflict.id, { action: 'dismiss' })}
                        disabled={busy !== null}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                ))
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void handleSourcingRoute('use_distributor_record')}
                  disabled={busy !== null}
                >
                  Use distributor record
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => void handleSourcingRoute('fallback_to_discovery')}
                  disabled={busy !== null}
                >
                  Continue to official site
                </button>
              </div>
            </div>
          </section>
        ) : null}

        {phase === 'semantic' && workState ? (
          <SemanticConflictPanel item={workState} batchId={batchId} onActionComplete={onResolved} />
        ) : null}

        {phase === 'retry' ? (
          <section className="attn-section" aria-label="Processing failure">
            <h3 className="attn-section-title">Processing failure</h3>
            <div className="attn-section-body">
              <p style={{ margin: 0, fontFamily: 'var(--font-body)', fontSize: '0.8125rem', color: 'var(--color-ledger-charcoal)' }}>
                {workState?.detail ?? 'Automation could not continue for this product.'}
              </p>
              <div className="attn-candidate-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void handleRetry()}
                  disabled={busy !== null}
                >
                  {busy === 'retry' ? 'Retrying…' : 'Retry'}
                </button>
                {isDistributor ? (
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => void handleContinueOfficial()}
                    disabled={busy !== null}
                  >
                    Continue with official site discovery
                  </button>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}

        {phase === 'done' ? (
          <div className="attn-profile-banner attn-profile-ready" role="status">
            ✓ Resolved.{' '}
            {resolutionNote
              ? resolutionNote
              : releaseResult
                ? releaseResult.count === 0
                  ? 'No blocked products on this domain needed a release (they may already be running, or none were blocked).'
                  : `Released ${releaseResult.count} blocked product${releaseResult.count === 1 ? '' : 's'} on ${releaseResult.domain}.`
                : 'Extraction resumes automatically.'}
          </div>
        ) : null}

        {/* ── Consequence bar ────────────────────────────────────────── */}
        <div className="attn-consequence">
          <span className="attn-consequence-icon" aria-hidden="true">→</span>
          <span>{consequence}</span>
        </div>
      </div>

      {/* ── Footer actions ───────────────────────────────────────────── */}
      <div className="attn-candidate-actions" style={{ paddingTop: 4 }}>
        {phase === 'done' ? (
          <button type="button" className="btn btn-primary" onClick={onResolved}>
            Close
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-outline" onClick={onResolved}>
              Close
            </button>
            {busy ? (
              <span className="attn-mutating">
                <span className="attn-spinner" aria-hidden="true" /> Saving…
              </span>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
