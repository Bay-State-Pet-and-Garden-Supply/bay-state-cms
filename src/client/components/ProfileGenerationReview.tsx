/**
 * ProfileGenerationReview.tsx — dynamic field-catalog-driven review workspace.
 *
 * Replaces the old static 3-field state machine with a per-field approval
 * flow that supports all standard and custom fields from the profile catalog.
 *
 * Phases:
 *   reviewing  → default, shows field cards with approve/reject toggles
 *   validating → spinner during validation
 *   validated  → validation results shown in field cards, promote active
 *   promoting  → spinner during promotion
 *   promoted   → success with list of approved fields
 *   feedback   → feedback form for a specific field
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  getProfileGenerationDetail,
  validateRevision,
  approveRevisionFields,
  createRevisionFromFeedback,
  rollbackProfileField,
  deleteProfileGeneration,
} from '../onboarding-api';
import type {
  ProfileGenerationGeneration,
  ProfileGenerationRevision,
  ProfileGenerationFieldDecision,
  StructuredFeedback,
  DomainProfileGovernance,
} from '../../shared/schemas/onboarding';
import type { ValidationRunSummary } from '../onboarding-api';
import {
  buildReviewFields,
  buildConfigRows,
  diffRevisionSelectors,
  normalizeFieldLabel,
  getCategoryLabel,
  getCategoryOrder,
  type ReviewFieldRow,
  type ConfigReviewRow,
  type RevisionDiffEntry,
} from '../profile-review-utils';
import { ProfileReviewFieldGroup } from './ProfileReviewFieldGroup';
import { ProfileConfigReviewCard } from './ProfileConfigReviewCard';
import { ProfileRevisionDiff } from './ProfileRevisionDiff';
import { ProfileRevisionFeedbackForm } from './ProfileRevisionFeedbackForm';
import { ProfileExtractionPreview } from './ProfileExtractionPreview';

// ─── Props ─────────────────────────────────────────────────────────────────

interface ProfileGenerationReviewProps {
  generationId: string;
  governance?: DomainProfileGovernance | null;
  onChange?: () => void;
  onClose?: () => void;
}

// ─── States ────────────────────────────────────────────────────────────────

type ReviewPhase = 'reviewing' | 'validating' | 'validated' | 'promoting' | 'promoted' | 'feedback';

// ─── Inline styles ──────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', gap: 16 },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  headerTitle: { margin: 0, fontSize: 16, fontWeight: 600 },
  headerSubtitle: { margin: '4px 0 0', fontSize: 12, color: '#6b7280' },
  headerActions: { display: 'flex', gap: 8 },
  closeBtn: {
    background: 'none',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    padding: '4px 12px',
    fontSize: 12,
    cursor: 'pointer',
    color: '#374151',
  },
  deleteBtn: {
    background: 'none',
    border: '1px solid #dc2626',
    color: '#dc2626',
    borderRadius: 6,
    padding: '4px 12px',
    fontSize: 12,
    cursor: 'pointer',
  },
  errorBanner: {
    color: '#dc2626',
    fontSize: 13,
    background: '#fef2f2',
    padding: 8,
    borderRadius: 4,
  },
  validateBtn: {
    background: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '10px 20px',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
  promoteBtn: {
    background: '#16a34a',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '10px 20px',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
  secondaryBtn: {
    background: '#6b7280',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  spinnerBox: {
    padding: 12,
    background: '#f3f4f6',
    borderRadius: 6,
    fontSize: 13,
    color: '#6b7280',
    margin: 0,
  },
  successBanner: {
    background: '#f0fdf4',
    border: '1px solid #86efac',
    borderRadius: 8,
    padding: 16,
  },
  successText: { color: '#166534', fontWeight: 600, margin: 0 },
  sectionTitle: { margin: '0 0 8px', fontSize: 14, fontWeight: 600 },
  emptyText: { fontSize: 12, color: '#9ca3af', fontStyle: 'italic', margin: 0 },
  collapseToggle: {
    background: 'none',
    border: 'none',
    color: '#2563eb',
    fontSize: 12,
    cursor: 'pointer',
    padding: 0,
    textDecoration: 'underline',
  },
  smallBtn: {
    padding: '2px 8px',
    fontSize: 11,
    border: '1px solid #d1d5db',
    borderRadius: 4,
    background: '#fff',
    cursor: 'pointer',
    color: '#374151',
  },
};

// ─── Component ──────────────────────────────────────────────────────────────

export function ProfileGenerationReview(
  props: ProfileGenerationReviewProps,
): React.ReactElement {
  const { generationId, onChange, onClose } = props;

  // ── Data state ──────────────────────────────────────────────────────────
  const [generation, setGeneration] = useState<ProfileGenerationGeneration | null>(null);
  const [revisions, setRevisions] = useState<ProfileGenerationRevision[]>([]);
  const [decisions, setDecisions] = useState<ProfileGenerationFieldDecision[]>([]);
  const [latestRevision, setLatestRevision] = useState<ProfileGenerationRevision | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // ── Review phase & UI state ─────────────────────────────────────────────
  const [phase, setPhase] = useState<ReviewPhase>('reviewing');
  const [validationResult, setValidationResult] = useState<ValidationRunSummary | null>(null);
  const [validationBusy, setValidationBusy] = useState(false);
  const [promoteBusy, setPromoteBusy] = useState(false);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [imagePreviewsReviewed, setImagePreviewsReviewed] = useState(false);
  const [feedbackField, setFeedbackField] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [showDecisions, setShowDecisions] = useState(false);

  // ── Per-field approval state ────────────────────────────────────────────
  // key → 'approved' | 'rejected' | null (no decision yet)
  const [approvals, setApprovals] = useState<Record<string, 'approved' | 'rejected' | null>>({});
  // Local editing overrides for selectors (key → new selector string)
  const [localEdits, setLocalEdits] = useState<Record<string, string | null>>({});

  // ── Data loading ────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const detail = await getProfileGenerationDetail(generationId);
      setGeneration(detail.generation);
      setRevisions(detail.revisions);
      setDecisions(detail.fieldDecisions);
      const latest = detail.revisions
        .slice()
        .sort((a, b) => b.revisionNumber - a.revisionNumber)[0] ?? null;
      setLatestRevision(latest);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [generationId]);

  useEffect(() => {
    load();
  }, [load]);

  // Reset approvals when revision changes
  useEffect(() => {
    setApprovals({});
    setLocalEdits({});
    setValidationResult(null);
    setPhase('reviewing');
  }, [latestRevision?.id]);

  // ── Derive review rows ─────────────────────────────────────────────────
  const activeProfile = props.governance?.activeProfile ?? null;
  const revisionSelectors = (latestRevision?.selectors ?? {}) as Record<string, unknown>;
  const fieldSamples = (latestRevision?.fieldSamples ?? null) as Record<string, unknown> | null;
  const validationSamples = validationResult?.samples ?? [];
  const byFieldTally = validationResult?.byField ?? {};

  const activeSelectorRecord: Record<string, string | null> = activeProfile
    ? {
        titleSelector: activeProfile.titleSelector ?? null,
        descriptionSelector: activeProfile.descriptionSelector ?? null,
        brandSelector: (activeProfile as any).brandSelector ?? null,
        imagesSelector: activeProfile.imagesSelector ?? null,
      }
    : {};
  const activeCustomSelectors = activeProfile?.customSelectors ?? {};
  const proposedCustomSelectors = (revisionSelectors.customSelectors ?? {}) as Record<string, string>;

  const reviewFields = buildReviewFields({
    revisionSelectors,
    activeProfileSelectors: activeSelectorRecord,
    fieldSamples,
    validationResults: validationSamples.map((s) => ({
      selectorField: s.field,
      status: s.status,
      extractedValue: s.extractedText,
      extractedImages: s.extractedImages,
      warnings: s.warnings,
      sampleUrl: s.sampleUrl,
    })),
    byFieldTally,
    activeCustomSelectors,
    proposedCustomSelectors,
  }).filter((row) => !/price|cost|sale/i.test(row.key));

  // Apply local edits to proposed selectors
  const editedFields = reviewFields.map((row) => {
    const override = localEdits[row.key];
    if (override !== undefined) {
      return { ...row, proposedSelector: override, changed: override !== row.activeSelector };
    }
    return row;
  });

  const configRows = buildConfigRows(revisionSelectors, activeProfile as unknown as Record<string, unknown> | null);

  // Revision diff
  const parentRevision = latestRevision?.parentRevisionId
    ? revisions.find((r) => r.id === latestRevision.parentRevisionId) ?? null
    : null;
  const parentSelectors = parentRevision?.selectors as Record<string, unknown> | null ?? null;
  const diffEntries: RevisionDiffEntry[] = parentSelectors
    ? diffRevisionSelectors(parentSelectors, revisionSelectors)
    : [];

  // ── Group fields by category ───────────────────────────────────────────
  const groupedFields: Record<string, ReviewFieldRow[]> = {};
  for (const row of editedFields) {
    const cat = row.category;
    if (!groupedFields[cat]) groupedFields[cat] = [];
    groupedFields[cat].push(row);
  }

  // Sort category keys
  const sortedCategories = Object.keys(groupedFields).sort((a, b) => {
    return getCategoryOrder(a) - getCategoryOrder(b);
  });

  // Derived boolean records from the ternary approvals state
const approvedFields: Record<string, boolean> = {};
const rejectedFields: Record<string, boolean> = {};
for (const [key, value] of Object.entries(approvals)) {
  if (value === 'approved') approvedFields[key] = true;
  else if (value === 'rejected') rejectedFields[key] = true;
}

const approvedCount = Object.keys(approvedFields).length;
  const hasApprovedFields = approvedCount > 0;

  // ── Seed preview from latest revision ──────────────────────────────────
  const seedPreview = fieldSamples?.seedPreview as {
  title: string | null;
  description: string | null;
  images: string[];
  variantOptions: string[];
  strategy: 'shopify-json' | 'css';
  variantSelectionStrategy: {
    containerSelector: string | null;
    optionType: string | null;
    detectedOptions: string[];
    optionFields: string[];
  } | null;
} | null ?? null;

  // Build field values for extraction preview
  const fieldValuesForPreview: Record<string, unknown> = {};
  for (const row of editedFields) {
    if (row.sampleValue) fieldValuesForPreview[row.key] = row.sampleValue;
  }

  // ── Handlers ──────────────────────────────────────────────────────────

  const handleToggleApprove = (key: string, approve: boolean) => {
    setApprovals((prev) => ({
      ...prev,
      [key]: approve ? 'approved' : 'rejected',
    }));
  };

  const handleEditSelector = (key: string, selector: string) => {
    setLocalEdits((prev) => ({ ...prev, [key]: selector }));
  };

  const handleValidate = async () => {
    if (!latestRevision) return;
    setPhase('validating');
    setValidationBusy(true);
    setError('');
    try {
      const res = await validateRevision(generationId, latestRevision.id, { sampleLimit: 5 });
      setValidationResult(res.result);
      setPhase('validated');
      await load();
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('reviewing');
    } finally {
      setValidationBusy(false);
    }
  };

  const handlePromote = async () => {
    if (!latestRevision || !validationResult) return;
    setPhase('promoting');
    setPromoteBusy(true);
    setError('');
    try {
      const approvedFields: Record<string, boolean> = {};
      let hasImageApproval = false;
      for (const [key, value] of Object.entries(approvals)) {
        if (value === 'approved') {
          approvedFields[key] = true;
          if (key === 'imagesSelector') hasImageApproval = true;
        }
      }

      const res = await approveRevisionFields(generationId, latestRevision.id, {
        approvedFields,
        imagePreviewsReviewed: hasImageApproval ? imagePreviewsReviewed : undefined,
      });

      if (hasImageApproval && !res.imageApprovalAccepted) {
        throw new Error(
          'Image approval requires at least 2 validated samples AND the "I reviewed the image previews" checkbox.',
        );
      }
      setPhase('promoted');
      await load();
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('validated');
    } finally {
      setPromoteBusy(false);
    }
  };

  const handleStartFeedback = (key: string) => {
    setFeedbackField(key);
    setPhase('feedback');
  };

  const handleCancelFeedback = () => {
    setFeedbackField(null);
    setPhase('reviewing');
  };

  const handleSubmitFeedback = async (feedback: StructuredFeedback) => {
    if (!latestRevision) return;
    setFeedbackBusy(true);
    setError('');
    try {
      await createRevisionFromFeedback(generationId, {
        parentRevisionId: latestRevision.id,
        feedback,
      });
      setFeedbackField(null);
      setPhase('reviewing');
      await load();
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFeedbackBusy(false);
    }
  };

  const handleRollback = async (decision: ProfileGenerationFieldDecision) => {
    if (!confirm(`Roll back ${decision.selectorField} on ${decision.domain}?`)) return;
    setError('');
    try {
      await rollbackProfileField(decision.id, { notes: 'Rolled back from review UI' });
      await load();
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async () => {
    if (
      !confirm(
        'Permanently delete this generation proposal? All revisions, validation results, and field decisions will be removed.',
      )
    )
      return;
    setError('');
    try {
      await deleteProfileGeneration(generationId);
      onChange?.();
      onClose?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // ── Early returns ──────────────────────────────────────────────────────

  if (loading) {
    return <p style={{ color: '#6b7280' }}>Loading review…</p>;
  }
  if (!generation) {
    return <p style={{ color: '#dc2626' }}>Generation not found.</p>;
  }
  if (!latestRevision) {
    return (
      <div style={s.container}>
        <p style={s.emptyText}>No revision available to review.</p>
      </div>
    );
  }

  const reviewedField = feedbackField
    ? editedFields.find((r) => r.key === feedbackField) ?? null
    : null;

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div style={s.container}>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={s.headerRow}>
        <div>
          <h3 style={s.headerTitle}>
            Profile Review
            <span style={{ marginLeft: 8, fontSize: 12, color: '#6b7280', fontWeight: 400 }}>
              {generationId.slice(0, 8)}
            </span>
          </h3>
          <p style={s.headerSubtitle}>
            {generation.domain} · {generation.sourceUrl?.slice(0, 80)}
            {generation.expectedName && (
              <span> · expected: {generation.expectedName}</span>
            )}
          </p>
        </div>
        {onClose && (
          <div style={s.headerActions}>
            <button type="button" onClick={onClose} style={s.closeBtn}>
              Close
            </button>
            <button type="button" onClick={handleDelete} style={s.deleteBtn}>
              Delete
            </button>
          </div>
        )}
      </div>

      {/* ── Error banner ──────────────────────────────────────────────── */}
      {error && <p style={s.errorBanner}>{error}</p>}

      {/* ── Extraction preview ────────────────────────────────────────── */}
      <ProfileExtractionPreview
        seedPreview={seedPreview}
        sourceUrl={generation.sourceUrl ?? ''}
        busy={loading}
      />

      {/* ── FEEDBACK PHASE ──────────────────────────────────────────────── */}
      {phase === 'feedback' && reviewedField && (
        <div
          style={{
            border: '1px solid #fde68a',
            borderRadius: 8,
            padding: 16,
            background: '#fffbeb',
          }}
        >
          <h4 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 600 }}>
            Feedback: {reviewedField.label}
          </h4>
          <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>
            What's wrong with the {reviewedField.label.toLowerCase()} selector?
          </p>
          <ProfileRevisionFeedbackForm
            field={reviewedField.key}
            currentValue={reviewedField.proposedSelector}
            sourcePageUrl={generation.sourceUrl ?? ''}
            onSubmit={handleSubmitFeedback}
            busy={feedbackBusy}
          />
          <button
            type="button"
            onClick={handleCancelFeedback}
            disabled={feedbackBusy}
            style={{ ...s.smallBtn, marginTop: 12 }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* ── REVIEW / VALIDATION PHASES ──────────────────────────────────── */}
      {(phase === 'reviewing' || phase === 'validating' || phase === 'validated') && (
        <>
          {/* Config rows */}
          {configRows.length > 0 && (
            <ProfileConfigReviewCard
              rows={configRows}
              approvedFields={approvedFields}
              onToggleApprove={
                phase === 'validated' ? undefined : (key, _approve) => handleToggleApprove(key, _approve)
              }
              disabled={phase !== 'reviewing'}
            />
          )}

          {/* Field groups */}
          {sortedCategories.length === 0 ? (
            <p style={s.emptyText}>No selector fields found in this revision.</p>
          ) : (
            sortedCategories.map((cat) => (
              <ProfileReviewFieldGroup
                key={cat}
                category={cat}
                rows={groupedFields[cat]}
                approvedFields={approvedFields}
                rejectedFields={rejectedFields}
                onToggleApprove={handleToggleApprove}
                onFeedback={handleStartFeedback}
                onEditSelector={handleEditSelector}
                disabled={phase !== 'reviewing'}
                imagePreviewsReviewed={imagePreviewsReviewed}
                onImageReviewToggle={setImagePreviewsReviewed}
                defaultExpanded={true}
              />
            ))
          )}

          {/* Validation / Promote actions */}
          {phase === 'reviewing' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                type="button"
                onClick={handleValidate}
                disabled={validationBusy}
                style={{
                  ...s.validateBtn,
                  opacity: validationBusy ? 0.6 : 1,
                  cursor: validationBusy ? 'not-allowed' : 'pointer',
                }}
              >
                {validationBusy ? 'Validating…' : 'Validate Across Samples'}
              </button>
            </div>
          )}

          {phase === 'validated' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                type="button"
                onClick={handlePromote}
                disabled={promoteBusy || !hasApprovedFields}
                style={{
                  ...s.promoteBtn,
                  opacity: promoteBusy || !hasApprovedFields ? 0.6 : 1,
                  cursor: promoteBusy || !hasApprovedFields ? 'not-allowed' : 'pointer',
                }}
              >
                {promoteBusy
                  ? 'Promoting…'
                  : `Promote ${approvedCount} Field${approvedCount !== 1 ? 's' : ''}`}
              </button>
              <button
                type="button"
                onClick={handleValidate}
                disabled={validationBusy}
                style={{ ...s.secondaryBtn, opacity: validationBusy ? 0.6 : 1 }}
              >
                Re-validate
              </button>
              <span style={{ fontSize: 12, color: '#6b7280' }}>
                {!hasApprovedFields
                  ? 'Approve at least one field to enable promotion'
                  : `${approvedCount} field${approvedCount !== 1 ? 's' : ''} ready to promote`}
              </span>
            </div>
          )}
        </>
      )}

      {/* ── VALIDATING PHASE ──────────────────────────────────────────────── */}
      {phase === 'validating' && (
        <p style={s.spinnerBox}>Validating across confirmed samples…</p>
      )}

      {/* ── PROMOTING PHASE ──────────────────────────────────────────────── */}
      {phase === 'promoting' && (
        <p style={s.spinnerBox}>Promoting selectors to extractor profile…</p>
      )}

      {/* ── PROMOTED PHASE ──────────────────────────────────────────────── */}
      {phase === 'promoted' && (
        <div style={s.successBanner}>
          <p style={s.successText}>
            ✓ Generation promoted successfully. {approvedCount} field{approvedCount !== 1 ? 's were' : ' was'} written to{' '}
            <code>extractor_profiles</code>.
          </p>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              style={{
                marginTop: 8,
                background: '#16a34a',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                padding: '6px 14px',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Close
            </button>
          )}
        </div>
      )}

      {/* ── BELOW THE FOLD ────────────────────────────────────────────────── */}

      {/* Revision diff */}
      {diffEntries.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowDiff(!showDiff)}
            style={s.collapseToggle}
          >
            {showDiff ? 'Hide revision changes' : `Show revision changes (${diffEntries.filter((e) => e.changeType !== 'unchanged').length} changes)`}
          </button>
          {showDiff && (
            <div style={{ marginTop: 8 }}>
              <ProfileRevisionDiff entries={diffEntries} />
            </div>
          )}
        </div>
      )}

      {/* Revision history */}
      <div>
        <h4 style={s.sectionTitle}>Revision history</h4>
        {revisions.length === 0 ? (
          <p style={s.emptyText}>No revisions yet.</p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {revisions
              .slice()
              .sort((a, b) => a.revisionNumber - b.revisionNumber)
              .map((r) => (
                <li
                  key={r.id}
                  style={{
                    borderLeft: '3px solid #d1d5db',
                    paddingLeft: 12,
                    marginBottom: 8,
                    fontSize: 12,
                    color: '#4b5563',
                  }}
                >
                  <strong>#{r.revisionNumber}</strong> · {r.source} · {r.status}
                  {' · '}
                  {new Date(r.createdAt).toLocaleString()}
                  {r.confidence != null && r.confidence > 0 ? (
                    <span> · conf {r.confidence.toFixed(2)}</span>
                  ) : null}
                </li>
              ))}
          </ul>
        )}
      </div>

      {/* Field decisions & rollback */}
      <div>
        <button
          type="button"
          onClick={() => setShowDecisions(!showDecisions)}
          style={s.collapseToggle}
        >
          {showDecisions ? 'Hide' : 'Show'} field decisions ({decisions.length})
        </button>
        {showDecisions && (
          <>
            {decisions.length === 0 ? (
              <p style={{ ...s.emptyText, marginTop: 8 }}>No field decisions yet.</p>
            ) : (
              <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none' }}>
                {decisions
                  .slice()
                  .sort(
                    (a, b) =>
                      new Date(b.decidedAt).getTime() - new Date(a.decidedAt).getTime(),
                  )
                  .map((d) => (
                    <li
                      key={d.id}
                      style={{
                        borderLeft: '3px solid #e5e7eb',
                        paddingLeft: 12,
                        marginBottom: 6,
                        fontSize: 12,
                        color: '#4b5563',
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        flexWrap: 'wrap',
                      }}
                    >
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          background:
                            d.decision === 'approved'
                              ? '#dcfce7'
                              : d.decision === 'rejected'
                                ? '#fee2e2'
                                : '#e0e7ff',
                          color:
                            d.decision === 'approved'
                              ? '#16a34a'
                              : d.decision === 'rejected'
                                ? '#dc2626'
                                : '#4338ca',
                          padding: '2px 6px',
                          borderRadius: 3,
                        }}
                      >
                        {d.decision}
                      </span>
                      <span style={{ fontWeight: 500 }}>{normalizeFieldLabel(d.selectorField)}</span>
                      <span style={{ color: '#9ca3af', fontSize: 11 }}>{d.selectorField}</span>
                      {d.previousSelector && (
                        <span style={{ color: '#9ca3af', fontSize: 11 }}>
                          was: <code>{d.previousSelector.slice(0, 40)}</code>
                        </span>
                      )}
                      {d.approvedSelector && (
                        <span style={{ fontSize: 11 }}>
                          now: <code>{d.approvedSelector.slice(0, 40)}</code>
                        </span>
                      )}
                      <span style={{ color: '#9ca3af', fontSize: 11 }}>
                        · {new Date(d.decidedAt).toLocaleString()}
                      </span>
                      {d.decision === 'approved' && (
                        <button
                          type="button"
                          onClick={() => handleRollback(d)}
                          style={s.smallBtn}
                        >
                          Rollback
                        </button>
                      )}
                    </li>
                  ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
