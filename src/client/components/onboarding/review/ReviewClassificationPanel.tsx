/**
 * Epic #46 — Review classification panel (Phase 6).
 *
 * Renders classification proposals (Product Type, Category Pages, attribute
 * assignments) with accept/reject affordances for pending proposals.
 *
 * Clarity rules (epic #46 review round, operator feedback):
 * - Abstentions are INFORMATIONAL, never decisions: the review-complete
 *   route auto-accepts remaining pending proposals, so an abstention row
 *   with Accept/Reject buttons was pure noise ("I have no idea what I am
 *   accepting"). They render as plain "nothing to propose" notes.
 * - Proposal values are humanized (product type labels, matched-word chips,
 *   evidence counts) — raw JSON blobs never appear.
 * - Identical pending proposals (same type + effective value + confidence +
 *   effective reviewer correction) collapse into one row.
 * - Confidence renders as a qualitative chip + percent.
 */
import { useState } from 'react';
import type { ItemDetailResponse } from '../../../onboarding-api';
import type { ClassificationProposal } from '../../../../shared/schemas/classification';
import { CanonicalClassificationReadiness } from '../../CanonicalClassificationReadiness';
import type { CurationData } from '../../../../shared/schemas/onboarding';

/** e09 round-3 FIX 1 (adjudication #10): correction payload written alongside
 *  suggestedPages when the added page resolves to a VERIFIED Page ID. */
export interface CategoryPageCorrection {
  pageId: string;
  activePageImportHash: string;
}

export interface ReviewClassificationPanelProps {
  detail: ItemDetailResponse | null;
  onDecision: (proposal: ClassificationProposal, decision: 'accepted' | 'rejected') => Promise<void>;
  /** Item id currently performing a decision write (disables row buttons). */
  busyDecisionId: string | null;
  readOnly?: boolean;
}

export const PROPOSAL_TYPE_LABELS: Record<string, string> = {
  product_classification: 'Product Classification',
  category_page: 'Category Page',
  field_assignment: 'Attribute',
  configuration_gap: 'Configuration gap',
  reviewable_abstention: 'Reviewable abstention',
};

// ─── Humanization helpers ─────────────────────────────────────────────────────

function humanizeId(id: string): string {
  return id
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase())
    .trim();
}

function confidenceTier(confidence: number): { label: string; cls: string } {
  if (confidence >= 0.85) return { label: 'High', cls: 'rv-conf-high' };
  if (confidence >= 0.5) return { label: 'Moderate', cls: 'rv-conf-moderate' };
  return { label: 'Low', cls: 'rv-conf-low' };
}

/** Row identity for collapsing: original shape plus the effective correction.
 * Proposals with different reviewer corrections never share a row. */
function proposalRowKey(p: ClassificationProposal): string {
  const revisedTarget = p.hasRevisedTargetId === true ? JSON.stringify(p.revisedTargetId ?? null) : '∅';
  const revisedValue = p.hasRevisedValue === true ? JSON.stringify(p.revisedValue ?? null) : '∅';
  return `${p.proposalType}|${JSON.stringify(p.proposedValue)}|${p.confidence}|${revisedTarget}|${revisedValue}`;
}

/** Human-readable proposal value (never raw JSON). */
function proposalValueText(proposal: ClassificationProposal): {
  text: string;
  matchedWords: string[];
} {
  const raw = proposal.hasRevisedValue === true ? proposal.revisedValue : proposal.proposedValue;
  if (raw === null || raw === undefined) return { text: '—', matchedWords: [] };

  if (proposal.proposalType === 'product_classification' && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const typeId = typeof obj.productTypeId === 'string' ? obj.productTypeId : null;
    const categoryId = typeof obj.categoryId === 'string' ? obj.categoryId : null;
    const words = Array.isArray(obj.matchedWords)
      ? (obj.matchedWords as unknown[]).filter((w): w is string => typeof w === 'string')
      : [];
    const text = categoryId && typeId
      ? `${humanizeId(categoryId)} / ${humanizeId(typeId)}`
      : typeId ? humanizeId(typeId) : '—';
    return { text, matchedWords: words };
  }

  if (typeof raw === 'string') return { text: raw, matchedWords: [] };
  if (typeof raw === 'number') return { text: String(raw), matchedWords: [] };

  if (Array.isArray(raw)) {
    const parts = raw.map(value => proposalValueText({ ...proposal, proposedValue: value, revisedValue: value }).text);
    return { text: parts.filter(Boolean).join(', '), matchedWords: [] };
  }

  const obj = raw as Record<string, unknown>;
  const label =
    obj.label ?? obj.name ?? obj.value ?? obj.pageName ?? obj.productTypeLabel ?? obj.fieldLabel;
  if (typeof label === 'string' && label) return { text: label, matchedWords: [] };
  const id = obj.id ?? obj.pageId ?? obj.typeId ?? obj.fieldId;
  if (typeof id === 'string') return { text: humanizeId(id), matchedWords: [] };
  return { text: '—', matchedWords: [] };
}

function abstentionReason(proposal: ClassificationProposal): string | null {
  const raw = proposal.proposedValue;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const reason = (raw as Record<string, unknown>).reason;
    if (typeof reason === 'string' && reason) return sanitizeReasonText(reason);
  }
  return null;
}

/**
 * Abstention reasons are system/model text — never render raw JSON blobs
 * or unbounded explanations (review round 2, MEDIUM-4).
 */
function sanitizeReasonText(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'No evidence available.';
  const singleLine = trimmed.replace(/\s+/g, ' ');
  return singleLine.length > 240 ? `${singleLine.slice(0, 237)}…` : singleLine;
}

function statusLabel(status: ClassificationProposal['status']): string {
  switch (status) {
    case 'pending':
      return 'Needs your decision';
    case 'accepted':
      return 'Accepted';
    case 'rejected':
      return 'Rejected';
    case 'stale':
      return 'Stale';
    default:
      return String(status);
  }
}

const STATUS_CLASS: Record<string, string> = {
  pending: 'rv-proposal-status-pending',
  accepted: 'rv-proposal-status-accepted',
  rejected: 'rv-proposal-status-rejected',
  stale: 'rv-proposal-status-stale',
};

// ─── Panel ────────────────────────────────────────────────────────────────────

export function ReviewClassificationPanel({
  detail,
  onDecision,
  busyDecisionId,
  readOnly = false,
}: ReviewClassificationPanelProps) {
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const curation = detail?.item.curationData as CurationData | null;
  const proposals = curation?.classificationProposals ?? [];
  const currentProposals = proposals.filter(proposal => proposal.proposalType !== 'primary_product_type');
  const suggestedPages = curation?.suggestedPages ?? [];
  const suggestions = suggestedPages.length > 0;
  const withoutResults = currentProposals.length === 0 && !suggestions;
  // Surface applicability + gating provenance instead of silent emptiness.
  const applicability = curation?.attributeApplicability ?? [];
  const gating = curation?.categoryPageGating ?? null;
  const dropped = curation?.speciesGuardDropped ?? [];
  const provenance = curation?.taxonomyProvenance ?? null;

  const handleDecision = async (proposal: ClassificationProposal, decision: 'accepted' | 'rejected') => {
    if (readOnly) return;
    setDecisionError(null);
    try {
      await onDecision(proposal, decision);
    } catch (err) {
      setDecisionError(err instanceof Error ? err.message : String(err));
    }
  };

  const primary = currentProposals.find(p => p.proposalType === 'product_classification');
  const abstentions = currentProposals.filter(p => p.proposalType === 'reviewable_abstention');
  const reviewable = currentProposals.filter(
    p => p.proposalType !== 'reviewable_abstention' &&
      p.proposalType !== 'product_classification' &&
      p.status === 'pending',
  );
  const settled = currentProposals.filter(
    p => p.proposalType !== 'reviewable_abstention' &&
      p.proposalType !== 'product_classification' &&
      p.status !== 'pending',
  );

  // Collapse identical pending proposals (same type + value + confidence +
  // effective reviewer correction). Different effective targets/values never
  // share a row, so one Accept can never write two different changes.
  const dedupedReviewable = reviewable.reduce<ClassificationProposal[]>((acc, p) => {
    const key = proposalRowKey(p);
    const existing = acc.find(q => proposalRowKey(q) === key);
    if (!existing) acc.push(p);
    return acc;
  }, []);
  const dedupeCount = reviewable.length - dedupedReviewable.length;

  return (
    <section
      className="rv-panel"
      aria-label="Classification review"
      id="rv-classification-panel"
      tabIndex={-1}
    >
      <header className="rv-panel-head">Classification Review</header>
      <div className="rv-field-value" style={{ fontSize: '0.75rem', color: 'var(--text-muted, #64748b)', marginTop: '-0.25rem' }}>
        Review the Category + Product Type pair and configured Classification Attributes. Brand can inform classification but is never a classification output.
      </div>
      <CanonicalClassificationReadiness result={detail?.classificationReadiness} />
      <div className="rv-panel-body">
        {withoutResults && (
          <div className="rv-empty">
            {gating?.needsReviewedType
              ? 'Needs reviewed Category + Product Type — page assignment requires an accepted Product Classification above first.'
              : gating?.needsVerifiedPages
                ? `No verified Catalog Pages for import — ${gating.verifiedPageCount} verified page${gating.verifiedPageCount === 1 ? '' : 's'} in snapshot. Import ShopSite pages first.`
                : 'No current Product Classification or attribute proposals to review.'}
            {gating?.reason && !gating.needsReviewedType && !gating.needsVerifiedPages ? ` Reason: ${gating.reason}` : ''}
          </div>
        )}

        {primary && (
          <div className="rv-field">
            <div className="rv-field-label">Product Classification</div>
            {proposals.some(p => p.derivation?.kind === 'product_type_invariant' && (p.contradictingEvidenceIds?.length ?? 0) > 0) && (
              <div
                className="rv-conflict-banner"
                style={{
                  background: '#fef2f2',
                  border: '1px solid #fecaca',
                  color: '#991b1b',
                  padding: '0.375rem 0.5rem',
                  borderRadius: '4px',
                  fontSize: '0.75rem',
                  marginBottom: '0.5rem',
                }}
              >
                ⚠ Type conflict in derived attributes: One or more type invariants conflict with product evidence. Verify whether this Product Type is accurate.
              </div>
            )}
            <ReviewProposalRow proposal={primary} onDecision={handleDecision} busy={busyDecisionId} readOnly={readOnly} />
          </div>
        )}

        {dedupedReviewable.length > 0 && (
          <div className="rv-field">
            <div className="rv-field-label">
              Decisions needed ({dedupedReviewable.length})
              {dedupeCount > 0 ? ` · ${dedupeCount} duplicate${dedupeCount === 1 ? '' : 's'} merged` : ''}
            </div>
            {dedupedReviewable.map(proposal => (
              <ReviewProposalRow
                key={proposal.id}
                proposal={proposal}
                onDecision={handleDecision}
                busy={busyDecisionId}
                readOnly={readOnly}
                siblings={reviewable.filter(
                  q => q.id !== proposal.id && proposalRowKey(q) === proposalRowKey(proposal),
                )}
              />
            ))}
          </div>
        )}

        {abstentions.length > 0 && (
          <div className="rv-field">
            <div className="rv-field-label">Nothing to propose ({abstentions.length})</div>
            {abstentions.map(proposal => (
              <div key={proposal.id} className="rv-abstention">
                <span className="rv-abstention-target">{humanizeId(proposal.targetId ?? '')}</span>
                <span className="rv-abstention-reason">{abstentionReason(proposal) ?? 'No evidence available.'}</span>
              </div>
            ))}
            {gating && (gating.needsReviewedType || gating.needsVerifiedPages) && abstentions.some(a => String(a.targetId) === 'category_page_proposals') ? (
              <p className="rv-meta-note">
                {gating.needsReviewedType
                  ? 'Needs an accepted Product Classification — accept the Category + Product Type pair above to unlock page assignment.'
                  : `No verified Catalog Pages — ${gating.verifiedPageCount} verified in snapshot ${gating.snapshotHash ? `(${String(gating.snapshotHash).slice(0, 8)})` : ''}.`}
              </p>
            ) : (
              <p className="rv-meta-note">
                Informational only — abstentions are acknowledged automatically when you complete the
                review. You never need to accept or reject an abstention.
              </p>
            )}
          </div>
        )}

        {settled.length > 0 && (
          <div className="rv-field">
            <div className="rv-field-label">Settled decisions</div>
            {settled.map(proposal => (
              <ReviewProposalRow
                key={proposal.id}
                proposal={proposal}
                onDecision={handleDecision}
                busy={busyDecisionId}
              />
            ))}
          </div>
        )}

        {/* Collapsible Technical Provenance & Gating Details */}
        {(provenance || applicability.length > 0 || dropped.length > 0) && (
          <details
            className="rv-advanced-details"
            style={{
              marginTop: '1.25rem',
              padding: '0.625rem 0.875rem',
              background: 'var(--surface-muted, #f8fafc)',
              border: '1px solid var(--border-subtle, #e2e8f0)',
              borderRadius: '6px',
            }}
          >
            <summary style={{ cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 500, color: 'var(--text-muted, #64748b)' }}>
              Technical Provenance & Gating Details
            </summary>
            <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {/* e05s01: attribute applicability */}
              {applicability.length > 0 && (
                <div className="rv-field" aria-label="Attribute applicability" style={{ marginBottom: 0 }}>
                  <div className="rv-field-label">Attribute applicability ({applicability.length})</div>
                  {applicability.map(entry => (
                    <div key={entry.attributeId} className="rv-abstention">
                      <span className="rv-abstention-target">{humanizeId(entry.attributeId)}</span>
                      <span className={`rv-applicability-state rv-applicability-${entry.state}`}>{entry.state}</span>
                      <span className="rv-abstention-reason">
                        {entry.state === 'unknown'
                          ? entry.reason ?? 'Product Classification not reviewed'
                          : entry.state === 'not_applicable'
                            ? entry.reason ?? 'not in the selected profile'
                            : entry.reason ?? 'applicable'}
                      </span>
                    </div>
                  ))}
                  <p className="rv-meta-note">
                    Unknown means applicability cannot be resolved from reviewed facts; not_applicable means the attribute is not in the selected Attribute Profile.
                  </p>
                </div>
              )}

              {/* e05s02: taxonomy provenance — bundle/snapshot/verified identity, no invented IDs */}
              {provenance && (
                <div className="rv-field" aria-label="Taxonomy provenance" style={{ marginBottom: 0 }}>
                  <div className="rv-field-label">Taxonomy provenance</div>
                  <div className="rv-abstention">
                    <span className="rv-abstention-target">Bundle</span>
                    <span className="rv-abstention-reason" title={provenance.bundleHash ?? ''}>
                      {provenance.bundleVersion ? `${provenance.bundleVersion} · ${String(provenance.bundleHash).slice(0, 12)}` : provenance.bundleHash ?? '—'}
                    </span>
                  </div>
                  <div className="rv-abstention">
                    <span className="rv-abstention-target">Snapshot</span>
                    <span className="rv-abstention-reason" title={provenance.snapshotHash ?? ''}>
                      {provenance.snapshotHash ? `${String(provenance.snapshotHash).slice(0, 8)} · ${String(provenance.snapshotHash).slice(0, 12)}` : '—'}
                    </span>
                  </div>
                  <div className="rv-abstention">
                    <span className="rv-abstention-target">Verified pages</span>
                    <span className="rv-abstention-reason">
                      {(provenance.verifiedPageCount ?? 0).toString()} verified — IDs: {(provenance.verifiedPageIdSet ?? []).slice(0, 5).join(', ') || '—'}
                      {(provenance.verifiedPageIdSet ?? []).length > 5 ? ` +${(provenance.verifiedPageIdSet?.length ?? 0) - 5} more` : ''}
                    </span>
                  </div>
                  {provenance.attributeProfileId ? (
                    <div className="rv-abstention">
                      <span className="rv-abstention-target">Attribute profile</span>
                      <span className="rv-abstention-reason">{provenance.attributeProfileId}</span>
                    </div>
                  ) : null}
                  {provenance.classificationRunId ? (
                    <div className="rv-abstention">
                      <span className="rv-abstention-target">Run</span>
                      <span className="rv-abstention-reason">{String(provenance.classificationRunId).slice(0, 8)}</span>
                    </div>
                  ) : null}
                  <p className="rv-meta-note">SoT: store/classification/*.json → RuntimeClassificationSnapshot (snapshotHash) → verified Pages/Fields catalog → promotion. Non-technical UI is deferred; safe path is JSON-file edit + bundle release via config-store. No invented IDs (ADR 0012).</p>
                </div>
              )}

              {/* e05s01: species-guard dropped pages */}
              {dropped.length > 0 && (
                <div className="rv-field" aria-label="Filtered by species guard" style={{ marginBottom: 0 }}>
                  <div className="rv-field-label">Filtered by species guard ({dropped.length})</div>
                  {dropped.map(item => (
                    <div key={item.pageName} className="rv-abstention">
                      <span className="rv-abstention-target">{item.pageName}</span>
                      <span className="rv-abstention-reason">
                        species_incompatible — species &quot;{item.species}&quot; vs term &quot;{item.matchedTerm ?? ''}&quot;
                      </span>
                    </div>
                  ))}
                  <p className="rv-meta-note">Safety net — cross-species pages are dropped by curation. This list is provenance only.</p>
                </div>
              )}
            </div>
          </details>
        )}

        {decisionError && <div className="rv-error-banner" style={{ marginTop: '0.625rem' }}>{decisionError}</div>}
      </div>
    </section>
  );
}

// ─── Proposal row ─────────────────────────────────────────────────────────────

function ReviewProposalRow({
  proposal,
  onDecision,
  readOnly = false,
  busy,
  siblings = [],
}: {
  proposal: ClassificationProposal;
  onDecision: (proposal: ClassificationProposal, decision: 'accepted' | 'rejected') => Promise<void>;
  readOnly?: boolean;
  busy: string | null;
  /** Identical pending proposals merged into this row: same effective
   * correction (row key), never just the same original value. */
  siblings?: ClassificationProposal[];
}) {
  const { text, matchedWords } = proposalValueText(proposal);
  const isPending = proposal.status === 'pending' && !readOnly;
  const tier = typeof proposal.confidence === 'number' ? confidenceTier(proposal.confidence) : null;
  // Effective reviewer-corrected targets: presence wins, including explicit
  // null. An explicit null is a cleared target, never the old label.
  const targetLabels = [proposal, ...siblings].map(p => {
    if (p.hasRevisedTargetId === true) return p.revisedTargetId == null ? '(cleared)' : humanizeId(p.revisedTargetId);
    if (p.targetId == null) return null;
    return humanizeId(p.targetId);
  }).filter((label): label is string => label !== null && label !== '');
  const seenLabels: Record<string, true> = {};
  const uniqueLabels: string[] = [];
  for (const label of targetLabels) {
    if (!seenLabels[label]) {
      seenLabels[label] = true;
      uniqueLabels.push(label);
    }
  }
  // Explicit value clear: acceptance removes the value. Show the before value
  // as history and (cleared) as the new assignment — never the old value as
  // if it were still assigned.
  const isValueClear = proposal.hasRevisedValue === true && proposal.revisedValue === null;
  const beforeText = isValueClear ? proposalValueText({ ...proposal, hasRevisedValue: false }).text : null;

  return (
    <div className="rv-proposal">
      <div className="rv-proposal-head">
        <span className="rv-proposal-type">
          {PROPOSAL_TYPE_LABELS[proposal.proposalType] ?? proposal.proposalType}
          {isValueClear && (
            <span className="rv-conf-chip" style={{ background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca', marginLeft: 6 }} title="Reviewed removal: accepting clears this value (the before value is shown below)">
              Removal
            </span>
          )}
          {uniqueLabels.length > 0 && proposal.proposalType !== 'product_classification' && (
            <span className="rv-proposal-target"> · {uniqueLabels.join(' & ')}</span>
          )}
        </span>
        <span className={`rv-proposal-status ${STATUS_CLASS[proposal.status] ?? ''}`}>
          {statusLabel(proposal.status)}
        </span>
      </div>

      <div className="rv-proposal-value">
        {isValueClear ? (
          <span>Before: {beforeText} → After: (cleared)</span>
        ) : (
          text
        )}
        {proposal.derivation?.kind === 'product_type_invariant' && (
          <span
            className="rv-conf-chip"
            style={{ background: '#e0e7ff', color: '#3730a3', border: '1px solid #c7d2fe' }}
            title={`Type Invariant derived from Product Type: ${proposal.derivation.productTypeId} (source: ${proposal.derivation.productTypeSource})`}
          >
            Type Invariant
          </span>
        )}
        {typeof proposal.confidence === 'number' && isPending && tier && proposal.derivation?.kind !== 'product_type_invariant' && (
          <span
            className={`rv-conf-chip ${tier.cls}`}
            role="status"
            aria-label={`Proposal confidence: ${Math.round(proposal.confidence * 100)} percent, ${tier.label.toLowerCase()}`}
            title={`Confidence of the proposal: ${Math.round(proposal.confidence * 100)}% (${tier.label})`}
          >
            {Math.round(proposal.confidence * 100)}% · {tier.label}
          </span>
        )}
      </div>

      {(proposal.contradictingEvidenceIds?.length ?? 0) > 0 && (
        <div
          className="rv-conflict-banner"
          style={{
            background: '#fef2f2',
            border: '1px solid #fecaca',
            color: '#991b1b',
            padding: '0.375rem 0.5rem',
            borderRadius: '4px',
            fontSize: '0.75rem',
            marginTop: '0.375rem',
          }}
        >
          <strong>⚠ Type conflict:</strong> Product Type implies this value, but extracted product evidence contains conflicting information.
        </div>
      )}

      {matchedWords.length > 0 && (
        <div className="rv-matched-words">
          <span className="rv-matched-words-label">Keyword match:</span>
          {matchedWords.map(word => (
            <span key={word} className="rv-matched-word">{word}</span>
          ))}
        </div>
      )}
      {proposal.proposalType === 'product_classification' && matchedWords.length === 0 && isPending && (
        <div className="rv-meta-note">Model pick — no keyword evidence. Only accept if it's clearly right.</div>
      )}

      {isPending ? (
        <div className="rv-proposal-actions">
          <button
            type="button"
            className="rv-btn rv-btn-primary"
            disabled={busy === proposal.id}
            onClick={() => void decideAll(onDecision, [proposal, ...siblings], 'accepted')}
          >
            {busy === proposal.id ? 'Saving…' : 'Accept'}
          </button>
          <button
            type="button"
            className="rv-btn rv-btn-danger"
            disabled={busy === proposal.id}
            onClick={() => void decideAll(onDecision, [proposal, ...siblings], 'rejected')}
          >
            {busy === proposal.id ? 'Saving…' : 'Reject'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Review round 2 (BLOCKER): a merged row represents N proposals — the
 * decision MUST fan out to every underlying proposal id, never just the
 * visible representative. Otherwise hidden siblings stay pending and the
 * review drawer lies about its own state.
 */
function decideAll(
  onDecision: (proposal: ClassificationProposal, decision: 'accepted' | 'rejected') => Promise<void>,
  proposals: ClassificationProposal[],
  decision: 'accepted' | 'rejected',
): Promise<void[]> {
  return Promise.all(proposals.map(p => onDecision(p, decision)));
}
