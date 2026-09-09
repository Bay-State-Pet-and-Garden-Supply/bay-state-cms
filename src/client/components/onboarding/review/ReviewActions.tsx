/**
 * Epic #46 — Review actions bar (Phase 6).
 *
 * Primary rhythm: [Looks Good & Next] → durable reviewed → auto-advance to the
 * next unreviewed product. Previous/next, edit toggle, and disabled states for
 * blocked items are all guarded here.
 *
 * e10s03: when the V2 surface supplies completeness blockers, Looks Good is
 * disabled with a TEXT reason (aria-disabled semantics via the disabled
 * attribute plus an adjacent role=status explanation — never color-only).
 */
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import type { ReviewQueueRow } from '../../../../shared/schemas/onboarding-review-queue';
import type { ItemDetailResponse } from '../../../onboarding-api';
import type { ReviewCompletenessBlockerCode } from '../../../../shared/schemas/onboarding';
import { warningInfoFromDetail } from './review-logic';

export interface ReviewActionsProps {
  workState: ReviewQueueRow | OnboardingWorkState | null;
  detail: ItemDetailResponse | null;
  busy: boolean;
  editing: boolean;
  allReviewed: boolean;
  /** Preferred keyboard shortcut for Looks Good & Next (for the hint). */
  shortcutKey?: string;
  /**
   * e10s03 — completeness blocker codes for the current item (V2 only).
   * Undefined ⇒ pre-V2 behavior (warning-based blocking only).
   */
  blockers?: ReviewCompletenessBlockerCode[];
  /**
   * Issue #109 — filename-warning decision state for the current item.
   * When `filenameWarned` is true, plain Looks-Good stays disabled: the
   * reviewer must Accept (batch collisions only) or Defer explicitly, so a
   * warned approval without a recorded decision is impossible.
   */
  filenameWarned?: boolean;
  /** False when a catalog collision is present (accept is never offered). */
  filenameAcceptable?: boolean;
  onAcceptFilename?: () => void;
  onDeferFilename?: () => void;
  onLooksGood: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onToggleEdit?: () => void;
  onSendToCuration?: () => void;
}

export function ReviewActions({
  workState,
  detail,
  busy,
  editing,
  allReviewed,
  shortcutKey = 'G',
  blockers,
  filenameWarned = false,
  filenameAcceptable = false,
  onAcceptFilename,
  onDeferFilename,
  onLooksGood,
  onPrevious,
  onNext,
  onToggleEdit,
  onSendToCuration,
}: ReviewActionsProps) {
  const warningBlocked = workState ? warningInfoFromDetail(detail ?? {}).blocked : false;
  const hasBlockers = Array.isArray(blockers) && blockers.length > 0;
  const approveDisabled =
    !workState || busy || warningBlocked || editing || hasBlockers || filenameWarned;

  return (
    <div className="rv-actions">
      <button
        type="button"
        className="rv-btn rv-btn-primary"
        onClick={onLooksGood}
        disabled={approveDisabled}
        aria-disabled={approveDisabled}
        title={`Mark reviewed and open the next unreviewed product${
          hasBlockers ? ' (blocked — resolve mandatory checks first)' : warningBlocked ? ' (blocked — resolve warnings first)' : ''
        } (${shortcutKey})`}
      >
        {busy ? 'Saving…' : 'Looks Good & Next'}
      </button>

      {filenameWarned && (
        <span className="rv-actions-blocked" role="status">
          Filename warning needs an explicit decision — accept the suffixed name{filenameAcceptable ? '' : ' (not available for catalog collisions)'} or defer.
        </span>
      )}

      {filenameWarned && filenameAcceptable && onAcceptFilename && (
        <button
          type="button"
          className="rv-btn rv-btn-primary"
          onClick={onAcceptFilename}
          disabled={!workState || busy}
          title="Record filename accept and mark reviewed"
        >
          {busy ? 'Saving…' : 'Accept filename & approve'}
        </button>
      )}

      {filenameWarned && onDeferFilename && (
        <button
          type="button"
          className="rv-btn rv-btn-secondary"
          onClick={onDeferFilename}
          disabled={!workState || busy}
          title="Record filename defer and move on without marking reviewed"
        >
          Defer
        </button>
      )}

      {hasBlockers && (
        <span className="rv-actions-blocked" role="status">
          Blocked — {blockers!.length} mandatory check{blockers!.length === 1 ? '' : 's'} incomplete. See the readiness checklist to fix them.
        </span>
      )}

      <button
        type="button"
        className="rv-btn rv-btn-secondary"
        onClick={onPrevious}
        disabled={!workState || busy}
        title="Previous product (←)"
      >
        ← Prev
      </button>
      <button
        type="button"
        className="rv-btn rv-btn-secondary"
        onClick={onNext}
        disabled={!workState || busy}
        title="Next product (→)"
      >
        Next →
      </button>

      {onToggleEdit && (
        <button
          type="button"
          className="rv-btn rv-btn-secondary"
          onClick={onToggleEdit}
          disabled={!workState || busy}
          title={editing ? 'Cancel editing' : 'Edit listing fields'}
        >
          {editing ? 'Cancel edit' : 'Edit'}
        </button>
      )}

      {onSendToCuration && (
        <button
          type="button"
          className="rv-btn rv-btn-secondary"
          onClick={onSendToCuration}
          disabled={!workState || busy}
          title="Send this product back to Curation stage to re-process"
        >
          ↩ Send to Curation
        </button>
      )}

      {!workState && !allReviewed && (
        <span className="rv-shortcut-hint">Select a product to begin reviewing.</span>
      )}
      {allReviewed && (
        <span className="rv-shortcut-hint" role="status">
          All products reviewed — ready for bulk approval in the Approved tab.
        </span>
      )}
    </div>
  );
}
