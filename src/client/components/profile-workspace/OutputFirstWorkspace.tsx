/**
 * Output-First Profile Workspace View (#191)
 *
 * Implements the output-first workflow:
 * 1. URL ingest renders resolved product and variant, per-field values with sources,
 *    and the gallery with the primary flagged, without authoring selectors first.
 * 2. The Exception Queue holds ONLY: missing, conflicted, unknown-membership, and vague-identity items.
 *    Each item is deep-resolvable. Item-level failures deep-link into the workspace as seed samples.
 * 3. Sibling-URL validation must pass before approval.
 *    Drafting stays proposal-only until sibling validation + reviewer approval.
 *    Fail-closed extraction behavior and existing readiness vocabulary are preserved.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { colors, fonts, rounded } from '../../theme';
import type {
  OutputFirstInspectionResult,
  ExceptionQueueItem,
  SiblingValidationResult,
  ExceptionResolutionOption,
} from '../../../shared/profile-workspace/inspection';
import { applyExceptionResolution } from '../../../shared/profile-workspace/inspection';

interface OutputFirstWorkspaceProps {
  domain: string;
  initialUrl?: string | null;
  seedUrl?: string | null;
  seedFailureReason?: string | null;
  suiteUrls: string[];
  draftVersionId?: string | null;
  onSelectOnPage?: (field: string) => void;
  onActivateProfile?: () => Promise<void>;
  onProfileUpdated?: (versionId: string) => void;
}

export function OutputFirstWorkspace({
  domain,
  initialUrl,
  seedUrl,
  seedFailureReason,
  suiteUrls,
  draftVersionId,
  onSelectOnPage,
  onActivateProfile,
  onProfileUpdated,
}: OutputFirstWorkspaceProps): React.ReactElement {
  const [urlInput, setUrlInput] = useState<string>(seedUrl || initialUrl || suiteUrls[0] || '');
  const [inspection, setInspection] = useState<OutputFirstInspectionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [activeCategoryFilter, setActiveCategoryFilter] = useState<string>('all');
  const [manualInputs, setManualInputs] = useState<Record<string, string>>({});
  const [selectorInputs, setSelectorInputs] = useState<Record<string, string>>({});

  const [siblingValidation, setSiblingValidation] = useState<SiblingValidationResult | null>(null);
  const [validatingSiblings, setValidatingSiblings] = useState(false);
  const [siblingError, setSiblingError] = useState<string | null>(null);

  const [approving, setApproving] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  // Ingest and inspect URL
  const runInspect = useCallback(
    async (targetUrl: string) => {
      if (!targetUrl) return;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/domains/${encodeURIComponent(domain)}/profile/inspect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: targetUrl,
            versionId: draftVersionId || undefined,
            runtime: 'rendered',
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || `Inspection failed (HTTP ${res.status})`);
        }
        setInspection(data as OutputFirstInspectionResult);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [domain, draftVersionId],
  );

  // Auto-inspect on initial load if seedUrl or initialUrl is provided
  useEffect(() => {
    const target = seedUrl || initialUrl || suiteUrls[0];
    if (target && !inspection && !loading) {
      void runInspect(target);
    }
  }, [seedUrl, initialUrl, suiteUrls, inspection, loading, runInspect]);

  // Deep-resolve an exception queue item
  const handleResolveException = useCallback(
    (
      exceptionId: string,
      resolution: { action: string; value?: string; selectedVariantKey?: string },
    ) => {
      if (!inspection) return;
      const updated = applyExceptionResolution(inspection, exceptionId, resolution);
      setInspection(updated);
    },
    [inspection],
  );

  // Sibling-URL validation
  const handleValidateSiblings = useCallback(async () => {
    setValidatingSiblings(true);
    setSiblingError(null);
    try {
      const res = await fetch(
        `/api/domains/${encodeURIComponent(domain)}/profile/validate-siblings`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            versionId: draftVersionId || undefined,
            siblingUrls: suiteUrls,
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Sibling validation failed (HTTP ${res.status})`);
      }
      setSiblingValidation(data as SiblingValidationResult);
    } catch (err) {
      setSiblingError(err instanceof Error ? err.message : String(err));
    } finally {
      setValidatingSiblings(false);
    }
  }, [domain, draftVersionId, suiteUrls]);

  // Reviewer Approval
  const handleApprove = useCallback(async () => {
    if (!siblingValidation?.canApprove) return;
    setApproving(true);
    setApprovalError(null);
    try {
      if (onActivateProfile) {
        await onActivateProfile();
      }
    } catch (err) {
      setApprovalError(err instanceof Error ? err.message : String(err));
    } finally {
      setApproving(false);
    }
  }, [siblingValidation, onActivateProfile]);

  // Filter exception queue
  const exceptions: ExceptionQueueItem[] = inspection?.exceptionQueue ?? [];
  const filteredExceptions: ExceptionQueueItem[] =
    activeCategoryFilter === 'all'
      ? exceptions
      : exceptions.filter((e: ExceptionQueueItem) => e.category === activeCategoryFilter);

  const missingCount = exceptions.filter((e: ExceptionQueueItem) => e.category === 'missing').length;
  const conflictedCount = exceptions.filter((e: ExceptionQueueItem) => e.category === 'conflicted').length;
  const unknownMembershipCount = exceptions.filter((e: ExceptionQueueItem) => e.category === 'unknown-membership').length;
  const vagueIdentityCount = exceptions.filter((e: ExceptionQueueItem) => e.category === 'vague-identity').length;

  const hasCriticalExceptions = exceptions.some((e: ExceptionQueueItem) => e.severity === 'critical');
  const siblingPass = siblingValidation?.ok ?? false;
  const canApprove = !hasCriticalExceptions && siblingPass;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* 1. URL Ingest & Seed Banner */}
      <div
        style={{
          background: colors.whiteSurface,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: rounded.lg,
          padding: 16,
          boxShadow: '0 1px 3px rgba(33, 20, 20, 0.04)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h3
            style={{
              margin: 0,
              fontFamily: fonts.display,
              fontSize: '1rem',
              fontWeight: 700,
              color: colors.ledgerCharcoal,
            }}
          >
            Output-First URL Ingest
          </h3>
          <span style={{ fontSize: 11, color: colors.mulchBrown, fontFamily: fonts.mono }}>
            Inspects product, variant, fields & gallery without authoring selectors
          </span>
        </div>

        {seedUrl && (
          <div
            style={{
              background: '#fef3c7',
              border: '1px solid #fcd34d',
              borderRadius: rounded.sm,
              padding: '8px 12px',
              marginBottom: 12,
              fontSize: 12,
              color: '#92400e',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span style={{ fontWeight: 700 }}>Seed Sample:</span>
            <span style={{ fontFamily: fonts.mono, wordBreak: 'break-all' }}>{seedUrl}</span>
            {seedFailureReason && (
              <span
                style={{
                  marginLeft: 'auto',
                  background: '#b45309',
                  color: colors.whiteSurface,
                  padding: '2px 6px',
                  borderRadius: rounded.sm,
                  fontSize: 10,
                  fontWeight: 700,
                }}
              >
                Failure: {seedFailureReason}
              </span>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <input
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="Paste product page URL to inspect output..."
            style={{
              flex: 1,
              padding: '9px 12px',
              fontSize: 13,
              fontFamily: fonts.mono,
              border: `1px solid ${colors.cardBorder}`,
              borderRadius: rounded.sm,
              background: colors.feedBagCream,
              color: colors.ledgerCharcoal,
            }}
          />
          <button
            type="button"
            onClick={() => void runInspect(urlInput)}
            disabled={loading || !urlInput}
            style={{
              padding: '9px 20px',
              background: colors.uniformGreen,
              color: colors.feedBagCream,
              border: 'none',
              borderRadius: rounded.sm,
              fontFamily: fonts.body,
              fontSize: 12,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              cursor: loading || !urlInput ? 'not-allowed' : 'pointer',
              opacity: loading || !urlInput ? 0.6 : 1,
            }}
          >
            {loading ? 'Inspecting…' : 'Inspect Output'}
          </button>
        </div>

        {error && (
          <div
            style={{
              marginTop: 10,
              padding: '8px 12px',
              background: 'rgba(118, 12, 25, 0.08)',
              border: `1px solid ${colors.signetBurgundy}`,
              borderRadius: rounded.sm,
              color: colors.signetBurgundy,
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {error}
          </div>
        )}
      </div>

      {inspection && (
        <>
          {/* 2. Resolved Product & Variant Identity Card */}
          <div
            style={{
              background: colors.whiteSurface,
              border: `1px solid ${colors.cardBorder}`,
              borderRadius: rounded.lg,
              padding: 16,
              boxShadow: '0 1px 3px rgba(33, 20, 20, 0.04)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <h4
                  style={{
                    margin: 0,
                    fontFamily: fonts.display,
                    fontSize: '0.9375rem',
                    fontWeight: 700,
                    color: colors.ledgerCharcoal,
                  }}
                >
                  Resolved Product &amp; Variant Identity
                </h4>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: rounded.full,
                    backgroundColor: inspection.identity.isVague ? '#fee2e2' : '#e8f3ec',
                    color: inspection.identity.isVague ? colors.signetBurgundy : colors.uniformGreen,
                    border: `1px solid ${inspection.identity.isVague ? colors.signetBurgundy : colors.seedlingGreen}`,
                  }}
                >
                  {inspection.identity.status.replace(/_/g, ' ').toUpperCase()}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    fontFamily: fonts.mono,
                    padding: '2px 6px',
                    borderRadius: rounded.sm,
                    background: colors.feedBagCream,
                    color: colors.mulchBrown,
                  }}
                >
                  Verdict: {inspection.identity.verdict}
                </span>
              </div>
              <div style={{ fontSize: 11, color: colors.mulchBrown }}>
                Variant Key: <strong>{inspection.identity.selectedVariantKey || 'single'}</strong>
              </div>
            </div>

            {inspection.identity.confusionDetected && (
              <div
                style={{
                  padding: '8px 12px',
                  background: 'rgba(245, 158, 11, 0.1)',
                  border: '1px solid #f59e0b',
                  borderRadius: rounded.sm,
                  color: '#92400e',
                  fontSize: 12,
                  marginBottom: 12,
                }}
              >
                ⚠️ <strong>Confusion Detected ({inspection.identity.confusionType}):</strong>{' '}
                {inspection.identity.confusionDetails}
              </div>
            )}

            <div style={{ fontSize: 15, fontWeight: 700, color: colors.ledgerCharcoal, marginBottom: 4 }}>
              {inspection.fields.title?.value || 'Untitled Product'}
            </div>
            <div style={{ fontSize: 12, color: colors.mulchBrown }}>
              Brand: <strong>{inspection.fields.brand?.value || 'None'}</strong> | Price:{' '}
              <strong>{inspection.fields.price?.value ? `$${inspection.fields.price.value}` : 'None'}</strong> | SKU:{' '}
              <strong>{inspection.fields.sku?.value || 'None'}</strong> | GTIN:{' '}
              <strong>{inspection.fields.gtin?.value || 'None'}</strong>
            </div>
          </div>

          {/* 3. Per-Field Values with Provenance Sources */}
          <div
            style={{
              background: colors.whiteSurface,
              border: `1px solid ${colors.cardBorder}`,
              borderRadius: rounded.lg,
              padding: 16,
              boxShadow: '0 1px 3px rgba(33, 20, 20, 0.04)',
            }}
          >
            <h4
              style={{
                margin: '0 0 12px',
                fontFamily: fonts.display,
                fontSize: '0.9375rem',
                fontWeight: 700,
                color: colors.ledgerCharcoal,
              }}
            >
              Extracted Fields &amp; Provenance Sources
            </h4>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
              {Object.entries(inspection.fields).map(([field, item]: [string, { value: string | null; source: string; status: 'extracted' | 'missing' | 'conflicted'; conflict?: any }]) => {
                const isMissing = item.status === 'missing';
                const isConflicted = item.status === 'conflicted';
                return (
                  <div
                    key={field}
                    data-field={field}
                    style={{
                      border: `1px solid ${isMissing ? colors.signetBurgundy : isConflicted ? '#f59e0b' : colors.cardBorder}`,
                      borderRadius: rounded.sm,
                      padding: 10,
                      background: isMissing ? 'rgba(118, 12, 25, 0.03)' : isConflicted ? 'rgba(245, 158, 11, 0.03)' : colors.feedBagCream,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: colors.mulchBrown, textTransform: 'uppercase' }}>
                        {field}
                      </span>
                      <span
                        style={{
                          fontSize: 9,
                          fontFamily: fonts.mono,
                          padding: '1px 5px',
                          borderRadius: rounded.sm,
                          backgroundColor: item.source === 'custom-selector' ? '#dbeafe' : item.source === 'manual-override' ? '#fef3c7' : '#e0e7ff',
                          color: colors.ledgerCharcoal,
                          border: '1px solid rgba(0,0,0,0.08)',
                        }}
                      >
                        {item.source}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: item.value ? 600 : 400,
                        color: item.value ? colors.ledgerCharcoal : colors.signetBurgundy,
                        fontStyle: item.value ? 'normal' : 'italic',
                        wordBreak: 'break-word',
                      }}
                    >
                      {item.value || 'Missing from page'}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 4. Gallery with Primary Flagged */}
          <div
            style={{
              background: colors.whiteSurface,
              border: `1px solid ${colors.cardBorder}`,
              borderRadius: rounded.lg,
              padding: 16,
              boxShadow: '0 1px 3px rgba(33, 20, 20, 0.04)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h4
                style={{
                  margin: 0,
                  fontFamily: fonts.display,
                  fontSize: '0.9375rem',
                  fontWeight: 700,
                  color: colors.ledgerCharcoal,
                }}
              >
                Gallery ({inspection.gallery.admittedImages.length} Admitted, {inspection.gallery.rejectedImages.length} Filtered)
              </h4>
              <span style={{ fontSize: 11, color: colors.mulchBrown }}>
                Primary image flagged; unknown-membership images queued below
              </span>
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {inspection.gallery.admittedImages.map((imgUrl: string, i: number) => {
                const isPrimary = imgUrl === inspection.gallery.primaryImage;
                return (
                  <div
                    key={i}
                    style={{
                      position: 'relative',
                      border: `2px solid ${isPrimary ? colors.uniformGreen : colors.cardBorder}`,
                      borderRadius: rounded.sm,
                      overflow: 'hidden',
                      width: 90,
                      height: 90,
                      background: colors.feedBagCream,
                    }}
                  >
                    <img
                      src={imgUrl}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                    {isPrimary && (
                      <span
                        style={{
                          position: 'absolute',
                          top: 2,
                          left: 2,
                          background: colors.uniformGreen,
                          color: colors.feedBagCream,
                          fontSize: 8,
                          fontWeight: 700,
                          padding: '1px 4px',
                          borderRadius: rounded.sm,
                        }}
                      >
                        ⭐ PRIMARY
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 5. The Exception Queue (ONLY missing, conflicted, unknown-membership, vague-identity) */}
          <div
            style={{
              background: colors.whiteSurface,
              border: `1px solid ${exceptions.length > 0 ? '#f59e0b' : colors.seedlingGreen}`,
              borderRadius: rounded.lg,
              padding: 16,
              boxShadow: '0 1px 3px rgba(33, 20, 20, 0.04)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <h4
                  style={{
                    margin: 0,
                    fontFamily: fonts.display,
                    fontSize: '1rem',
                    fontWeight: 700,
                    color: colors.ledgerCharcoal,
                  }}
                >
                  The Exception Queue
                </h4>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: rounded.full,
                    backgroundColor: exceptions.length > 0 ? '#fef3c7' : '#e8f3ec',
                    color: exceptions.length > 0 ? '#92400e' : colors.uniformGreen,
                    border: `1px solid ${exceptions.length > 0 ? '#fcd34d' : colors.seedlingGreen}`,
                  }}
                >
                  {exceptions.length} {exceptions.length === 1 ? 'Exception' : 'Exceptions'}
                </span>
              </div>

              {/* Filter pills */}
              <div style={{ display: 'flex', gap: 6 }}>
                {[
                  { id: 'all', label: `All (${exceptions.length})` },
                  { id: 'missing', label: `Missing (${missingCount})` },
                  { id: 'conflicted', label: `Conflicted (${conflictedCount})` },
                  { id: 'unknown-membership', label: `Unknown Images (${unknownMembershipCount})` },
                  { id: 'vague-identity', label: `Vague Identity (${vagueIdentityCount})` },
                ].map((pill) => (
                  <button
                    key={pill.id}
                    type="button"
                    onClick={() => setActiveCategoryFilter(pill.id)}
                    style={{
                      background: activeCategoryFilter === pill.id ? colors.uniformGreen : colors.feedBagCream,
                      color: activeCategoryFilter === pill.id ? colors.feedBagCream : colors.ledgerCharcoal,
                      border: `1px solid ${colors.cardBorder}`,
                      borderRadius: rounded.sm,
                      padding: '4px 10px',
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {pill.label}
                  </button>
                ))}
              </div>
            </div>

            {exceptions.length === 0 ? (
              <div
                style={{
                  padding: '14px 18px',
                  background: '#e8f3ec',
                  border: `1px solid ${colors.seedlingGreen}`,
                  borderRadius: rounded.sm,
                  color: colors.uniformGreen,
                  fontSize: 13,
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span>✓</span>
                <span>Exception queue is clean. All fields and variant identities are deterministically resolved.</span>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {filteredExceptions.map((exc: ExceptionQueueItem) => {
                  const mInput = manualInputs[exc.id] || '';
                  const sInput = selectorInputs[exc.id] || '';
                  return (
                    <div
                      key={exc.id}
                      style={{
                        border: `1px solid ${exc.severity === 'critical' ? colors.signetBurgundy : '#f59e0b'}`,
                        borderRadius: rounded.sm,
                        padding: 12,
                        background: colors.whiteSurface,
                        boxShadow: '0 1px 2px rgba(0,0,0,0.02)',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              padding: '2px 6px',
                              borderRadius: rounded.sm,
                              backgroundColor: exc.severity === 'critical' ? '#fee2e2' : '#fef3c7',
                              color: exc.severity === 'critical' ? colors.signetBurgundy : '#92400e',
                            }}
                          >
                            {exc.category}
                          </span>
                          <span style={{ fontSize: 13, fontWeight: 700, color: colors.ledgerCharcoal }}>
                            {exc.title}
                          </span>
                        </div>
                        <span style={{ fontSize: 10, color: colors.mulchBrown, fontFamily: fonts.mono }}>
                          Severity: {exc.severity}
                        </span>
                      </div>

                      <div style={{ fontSize: 12, color: colors.mulchBrown, marginBottom: 10 }}>
                        {exc.description}
                      </div>

                      {/* Deep-resolution action controls */}
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        {exc.resolutions.map((res: ExceptionResolutionOption, i: number) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => {
                              if (res.action === 'manual_pick' && exc.field && onSelectOnPage) {
                                onSelectOnPage(exc.field);
                              } else {
                                handleResolveException(exc.id, {
                                  action: res.action,
                                  value: res.value,
                                });
                              }
                            }}
                            style={{
                              padding: '5px 12px',
                              borderRadius: rounded.sm,
                              border: `1px solid ${colors.uniformGreen}`,
                              background: colors.whiteSurface,
                              color: colors.uniformGreen,
                              fontFamily: fonts.body,
                              fontSize: 11,
                              fontWeight: 700,
                              cursor: 'pointer',
                            }}
                          >
                            {res.label}
                          </button>
                        ))}

                        {/* Inline manual value input if applicable */}
                        {(exc.category === 'missing' || exc.category === 'conflicted' || exc.category === 'vague-identity') && (
                          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                            <input
                              type="text"
                              placeholder="Enter value override..."
                              value={mInput}
                              onChange={(e) => setManualInputs({ ...manualInputs, [exc.id]: e.target.value })}
                              style={{
                                padding: '4px 8px',
                                fontSize: 11,
                                border: `1px solid ${colors.cardBorder}`,
                                borderRadius: rounded.sm,
                                width: 160,
                              }}
                            />
                            <button
                              type="button"
                              disabled={!mInput.trim()}
                              onClick={() => {
                                handleResolveException(exc.id, {
                                  action: 'manual_value',
                                  value: mInput.trim(),
                                });
                              }}
                              style={{
                                padding: '4px 10px',
                                background: colors.uniformGreen,
                                color: colors.feedBagCream,
                                border: 'none',
                                borderRadius: rounded.sm,
                                fontSize: 11,
                                fontWeight: 700,
                                cursor: mInput.trim() ? 'pointer' : 'not-allowed',
                                opacity: mInput.trim() ? 1 : 0.6,
                              }}
                            >
                              Apply Value
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 6. Sibling-URL Validation */}
          <div
            style={{
              background: colors.whiteSurface,
              border: `1px solid ${colors.cardBorder}`,
              borderRadius: rounded.lg,
              padding: 16,
              boxShadow: '0 1px 3px rgba(33, 20, 20, 0.04)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div>
                <h4
                  style={{
                    margin: 0,
                    fontFamily: fonts.display,
                    fontSize: '0.9375rem',
                    fontWeight: 700,
                    color: colors.ledgerCharcoal,
                  }}
                >
                  Sibling-URL Validation ({suiteUrls.length} Representative URLs)
                </h4>
                <span style={{ fontSize: 11, color: colors.mulchBrown }}>
                  Draft must pass validation on sibling pages before approval can be granted
                </span>
              </div>

              <button
                type="button"
                onClick={() => void handleValidateSiblings()}
                disabled={validatingSiblings || suiteUrls.length === 0}
                style={{
                  padding: '7px 16px',
                  background: colors.uniformGreen,
                  color: colors.feedBagCream,
                  border: 'none',
                  borderRadius: rounded.sm,
                  fontFamily: fonts.body,
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  cursor: validatingSiblings || suiteUrls.length === 0 ? 'not-allowed' : 'pointer',
                  opacity: validatingSiblings || suiteUrls.length === 0 ? 0.6 : 1,
                }}
              >
                {validatingSiblings ? 'Validating…' : 'Validate Sibling URLs'}
              </button>
            </div>

            {siblingError && (
              <div
                style={{
                  padding: '8px 12px',
                  background: 'rgba(118, 12, 25, 0.08)',
                  border: `1px solid ${colors.signetBurgundy}`,
                  borderRadius: rounded.sm,
                  color: colors.signetBurgundy,
                  fontSize: 12,
                  marginBottom: 10,
                }}
              >
                {siblingError}
              </div>
            )}

            {siblingValidation && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    background: siblingValidation.ok ? '#e8f3ec' : '#fee2e2',
                    border: `1px solid ${siblingValidation.ok ? colors.seedlingGreen : colors.signetBurgundy}`,
                    borderRadius: rounded.sm,
                    color: siblingValidation.ok ? colors.uniformGreen : colors.signetBurgundy,
                    fontWeight: 700,
                    fontSize: 12,
                  }}
                >
                  <span>
                    Sibling Pass Rate: {siblingValidation.passedCount}/{siblingValidation.totalSiblings} (
                    {Math.round(siblingValidation.passRate * 100)}%)
                  </span>
                  <span>{siblingValidation.ok ? '✓ Sibling Validation Passed' : '⚠ Sibling Validation Failed'}</span>
                </div>

                {siblingValidation.results.map((res: any, i: number) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '6px 10px',
                      background: colors.feedBagCream,
                      border: `1px solid ${colors.cardBorder}`,
                      borderRadius: rounded.sm,
                      fontSize: 11,
                    }}
                  >
                    <span style={{ fontFamily: fonts.mono, color: colors.ledgerCharcoal, wordBreak: 'break-all' }}>
                      {res.url}
                    </span>
                    <span
                      style={{
                        fontWeight: 700,
                        color: res.success ? colors.uniformGreen : colors.signetBurgundy,
                      }}
                    >
                      {res.success ? 'PASS' : `FAIL: ${res.failureReasons.join(', ')}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 7. Reviewer Approval & Promotion Bar */}
          <div
            style={{
              padding: '14px 18px',
              background: colors.whiteSurface,
              border: `1px solid ${canApprove ? colors.seedlingGreen : colors.cardBorder}`,
              borderRadius: rounded.lg,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: canApprove ? colors.uniformGreen : colors.ledgerCharcoal }}>
                {canApprove
                  ? '✓ Ready for Reviewer Approval (Sibling validation passed, queue clean)'
                  : 'Drafting is proposal-only until sibling validation passes and queue is resolved'}
              </div>
              <div style={{ fontSize: 11, color: colors.mulchBrown }}>
                Metrics: Time to first working profile: {inspection.metrics.timeToFirstWorkingProfileMs}ms | Manual corrections:{' '}
                {inspection.metrics.manualCorrectionsCount} | Sibling pass rate:{' '}
                {siblingValidation ? `${Math.round(siblingValidation.passRate * 100)}%` : 'Unvalidated'}
              </div>
            </div>

            <button
              type="button"
              disabled={!canApprove || approving}
              onClick={() => void handleApprove()}
              style={{
                padding: '10px 24px',
                borderRadius: rounded.sm,
                border: 'none',
                background: canApprove ? colors.uniformGreen : colors.feedBagCream,
                color: canApprove ? colors.feedBagCream : colors.mulchBrown,
                fontFamily: fonts.body,
                fontSize: 13,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                cursor: canApprove && !approving ? 'pointer' : 'not-allowed',
                opacity: approving ? 0.7 : 1,
              }}
            >
              {approving ? 'Approving…' : 'Approve Profile Draft'}
            </button>
          </div>

          {approvalError && (
            <div
              style={{
                padding: '8px 12px',
                background: 'rgba(118, 12, 25, 0.08)',
                border: `1px solid ${colors.signetBurgundy}`,
                borderRadius: rounded.sm,
                color: colors.signetBurgundy,
                fontSize: 12,
              }}
            >
              Approval blocked: {approvalError}
            </div>
          )}
        </>
      )}
    </div>
  );
}
