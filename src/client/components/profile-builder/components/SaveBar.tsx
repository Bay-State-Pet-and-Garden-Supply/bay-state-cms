/**
 * SaveBar — save controls with blocking errors, non-blocking warnings (General Store).
 */

import React from 'react';
import type { ProfileBuilderState, ProfileBuilderController } from '../profileBuilderTypes';
import { colors, fonts, rounded } from '../../../theme';

interface SaveBarProps {
  state: ProfileBuilderState;
  controller: ProfileBuilderController;
}

function dirtyBadgeStyle(dirty: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    fontWeight: 700,
    padding: '3px 10px',
    borderRadius: rounded.full,
    background: dirty ? 'rgba(246, 219, 18, 0.3)' : 'rgba(22, 132, 77, 0.12)',
    color: dirty ? colors.ledgerCharcoal : colors.seedlingGreen,
    border: `1px solid ${dirty ? colors.mutedGold : colors.seedlingGreen}44`,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  };
}

const s: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '12px 16px',
    background: colors.whiteSurface,
    borderRadius: rounded.lg,
    border: `1px solid ${colors.cardBorder}`,
    flexWrap: 'wrap',
    boxShadow: '0 1px 4px rgba(33, 20, 20, 0.05)',
  },
  left: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  saveBtn: {
    background: colors.uniformGreen,
    color: colors.feedBagCream,
    border: 'none',
    borderRadius: rounded.sm,
    padding: '8px 24px',
    fontFamily: fonts.body,
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    boxShadow: '0 1px 2px rgba(20, 83, 45, 0.2)',
  },
  saveBtnDisabled: {
    background: colors.feedBagCream,
    color: colors.mulchBrown,
    border: `1px solid ${colors.cardBorder}`,
    borderRadius: rounded.sm,
    padding: '8px 24px',
    fontFamily: fonts.body,
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    cursor: 'not-allowed',
    whiteSpace: 'nowrap',
    opacity: 0.6,
  },
  errorBox: {
    padding: '8px 12px',
    background: 'rgba(118, 12, 25, 0.08)',
    border: `1px solid ${colors.signetBurgundy}`,
    borderRadius: rounded.sm,
    color: colors.signetBurgundy,
    fontSize: 12,
    fontFamily: fonts.body,
    fontWeight: 600,
    flexBasis: '100%',
  },
  warningBox: {
    padding: '8px 12px',
    background: 'rgba(246, 219, 18, 0.2)',
    border: `1px solid ${colors.mutedGold}`,
    borderRadius: rounded.sm,
    color: colors.ledgerCharcoal,
    fontSize: 12,
    fontFamily: fonts.body,
    flexBasis: '100%',
  },
  warningList: { margin: '4px 0 0', paddingLeft: 16 },
  successMsg: { fontSize: 13, color: colors.seedlingGreen, fontWeight: 700, fontFamily: fonts.body },
};

export function SaveBar({ state, controller }: SaveBarProps) {
  const { dirty, requests, draft, validation, activeProfile } = state;
  const isSaving = requests.save.loading;
  const saveError = requests.save.error;
  const saveSuccess = requests.save.success;

  const blockingErrors: string[] = [];
  if (!draft.domain.trim()) blockingErrors.push('Domain is required.');

  const warnings: string[] = [];
  const hasValidationRun = validation !== null;
  if (!hasValidationRun) warnings.push('Validation has not been run.');
  if (hasValidationRun && validation?.summary && validation.summary.failingSamples > 0) {
    warnings.push(`Validation has ${validation.summary.failingSamples} failing sample(s).`);
  }
  if (!draft.imagesSelector) warnings.push('No image selector configured.');
  if (!draft.descriptionSelector) warnings.push('No description selector configured.');
  if (draft.runtime === 'static' && !draft.productUrl.includes('http')) {
    warnings.push('Runtime is "static" — dynamic content may not be captured.');
  }

  // Count warnings from accepted generated selectors
  const acceptedFieldWarnings = Object.values(state.generation.fieldSuggestions)
    .filter((s) => s.decision === 'accepted' && s.warnings.length > 0)
    .reduce((sum, s) => sum + s.warnings.length, 0);
  const acceptedCustomFieldWarnings = state.generation.customFieldSuggestions
    .filter((s) => s.addedToDraft && s.warnings.length > 0)
    .reduce((sum, s) => sum + s.warnings.length, 0);
  const totalSuggestionWarnings = acceptedFieldWarnings + acceptedCustomFieldWarnings;
  if (totalSuggestionWarnings > 0) {
    warnings.push(`${totalSuggestionWarnings} warning${totalSuggestionWarnings !== 1 ? 's' : ''} from generated selectors should be reviewed before saving.`);
  }

  // story: e06s03 — per-field governance blocks Save while any decision is pending/proposed
  const hasPendingFieldDecision = Object.values((state as any).generation?.fieldSuggestions ?? {}).some((s: any) => s?.decision === 'pending' || s?.decision === 'proposed');
  if (hasPendingFieldDecision) blockingErrors.push('Per-field decisions pending — accept/reject or mark unsupported before saving.');
  const canSave = blockingErrors.length === 0 && !isSaving && dirty;

  const handleSave = () => { if (canSave) controller.saveProfile(); };

  return (
    <div style={s.bar}>
      <div style={s.left}>
        <span style={dirtyBadgeStyle(dirty)}>
          {isSaving ? 'Saving…' : saveSuccess ? 'Saved' : dirty ? 'Unsaved changes' : 'No changes'}
        </span>
        {saveSuccess && activeProfile && (
          <span style={s.successMsg}>✓ Profile saved ({activeProfile.domain})</span>
        )}
      </div>

      <button type="button" style={canSave ? s.saveBtn : s.saveBtnDisabled}
        onClick={handleSave} disabled={!canSave}>
        {isSaving ? 'Saving…' : 'Save Profile'}
      </button>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: fonts.body, color: colors.ledgerCharcoal, flexBasis: '100%' }}>
        <input
          type="checkbox"
          checked={state.imagePreviewsReviewed}
          onChange={(e) => controller.setImageReviewed(e.target.checked)}
        />
        I reviewed the image previews for the confirmed samples — images show the actual product
      </label>

      {blockingErrors.length > 0 && (
        <div style={s.errorBox}>{blockingErrors.map((err, i) => <div key={i}>✗ {err}</div>)}</div>
      )}
      {saveError && !isSaving && <div style={s.errorBox}>✗ {saveError}</div>}

      {warnings.length > 0 && (
        <div style={s.warningBox}>
          <strong>Warnings:</strong>
          <ul style={s.warningList}>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

