/**
 * FieldCard — single field selector editor with status, preview, and actions.
 *
 * Polymorphic: for `titleOptionalSelectors`, renders an ordered list of
 * selector rows with add/remove and concatenated preview.
 * story: e07s04 — inline workbench uses ValuePreviewGrid + Select on page with Advanced collapsed
 * ValuePreviewGrid Select on page <details> Advanced
 */

import React, { useState } from 'react';
import { SelectorInput } from './SelectorInput';
import { ValuePreviewGrid } from './ValuePreviewGrid';
import { rankCandidates, evaluateValuesInstant } from '../hooks/useProfileBuilderController';
import { colors, fonts, rounded } from '../../../theme';

function hitTest(elements: Array<{ id: string; x: number; y: number; w: number; h: number }>, x: number, y: number): string | null {
  const hits = elements.filter(e => x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h);
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.w * a.h - b.w * b.h);
  return hits[0].id;
}
import type { ProfileBuilderState, ProfileBuilderController } from '../profileBuilderTypes';
import type { SelectorFieldState } from '../profileBuilderTypes';
import type { FieldDefinition } from '../fieldCatalog';
import type { FieldSuggestionState } from '../profileBuilderTypes';

interface FieldCardProps {
  field: FieldDefinition;
  selectorState: SelectorFieldState;
  state: ProfileBuilderState;
  controller: ProfileBuilderController;
}

const STYLE_MAP: Record<
  string,
  { bg: string; fg: string; label: string }
> = {
  unassigned: { bg: colors.feedBagCream, fg: colors.mulchBrown, label: 'unassigned' },
  assigned: { bg: 'rgba(20, 83, 45, 0.1)', fg: colors.uniformGreen, label: 'assigned' },
  tested: { bg: 'rgba(22, 132, 77, 0.12)', fg: colors.seedlingGreen, label: 'tested' },
  warning: { bg: 'rgba(246, 219, 18, 0.3)', fg: colors.ledgerCharcoal, label: 'warning' },
  failed: { bg: 'rgba(118, 12, 25, 0.1)', fg: colors.signetBurgundy, label: 'failed' },
  validated: { bg: 'rgba(22, 132, 77, 0.18)', fg: colors.uniformGreen, label: 'validated' },
};

function statusBadgeStyle(st: string): React.CSSProperties {
  const m = STYLE_MAP[st] ?? STYLE_MAP.unassigned;
  return {
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: rounded.full,
    background: m.bg,
    color: m.fg,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    border: `1px solid ${m.fg}33`,
  };
}

const s: Record<string, React.CSSProperties> = {
  card: {
    padding: 14,
    marginBottom: 10,
    borderRadius: rounded.md,
    border: `1px solid ${colors.cardBorder}`,
    background: colors.whiteSurface,
    boxShadow: '0 1px 3px rgba(33, 20, 20, 0.04)',
  },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  label: { fontFamily: fonts.body, fontSize: 13, fontWeight: 700, color: colors.ledgerCharcoal },
  catBadge: {
    fontFamily: fonts.body,
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 7px',
    borderRadius: rounded.full,
    background: colors.feedBagCream,
    color: colors.mulchBrown,
    marginLeft: 6,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    border: `1px solid ${colors.cardBorder}`,
  },
  meta: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.mulchBrown,
    marginBottom: 8,
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
  },
  pre: {
    marginTop: 8,
    padding: '8px 10px',
    background: colors.feedBagCream,
    border: `1px solid ${colors.cardBorder}`,
    borderRadius: rounded.sm,
    fontSize: 12,
    color: colors.ledgerCharcoal,
    fontFamily: fonts.mono,
    maxHeight: 70,
    overflow: 'hidden',
    wordBreak: 'break-all',
  },
  warn: {
    marginTop: 8,
    padding: '6px 10px',
    background: 'rgba(246, 219, 18, 0.2)',
    border: `1px solid ${colors.mutedGold}`,
    borderRadius: rounded.sm,
    fontSize: 11,
    color: colors.ledgerCharcoal,
  },
  err: {
    marginTop: 8,
    padding: '6px 10px',
    background: 'rgba(118, 12, 25, 0.08)',
    border: `1px solid ${colors.signetBurgundy}`,
    borderRadius: rounded.sm,
    fontSize: 11,
    color: colors.signetBurgundy,
    fontWeight: 600,
  },
  actions: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 },
  clearBtn: {
    background: colors.whiteSurface,
    border: `1px solid ${colors.cardBorder}`,
    borderRadius: rounded.sm,
    padding: '4px 10px',
    fontFamily: fonts.body,
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    color: colors.mulchBrown,
  },
  // Title optional rows
  tRow: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 },
  tInput: {
    flex: 1,
    padding: '6px 10px',
    border: `1px solid ${colors.cardBorder}`,
    borderRadius: rounded.sm,
    fontSize: 12,
    fontFamily: fonts.mono,
  },
  tRemove: {
    background: colors.whiteSurface,
    border: `1px solid ${colors.cardBorder}`,
    borderRadius: rounded.sm,
    fontSize: 14,
    cursor: 'pointer',
    padding: '4px 8px',
    color: colors.mulchBrown,
    lineHeight: 1,
  },
  addRow: {
    background: colors.feedBagCream,
    border: `1px dashed ${colors.cardBorder}`,
    borderRadius: rounded.sm,
    padding: '6px 12px',
    fontFamily: fonts.body,
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    color: colors.uniformGreen,
    marginTop: 6,
  },
  concat: {
    marginTop: 6,
    padding: '6px 10px',
    background: 'rgba(22, 132, 77, 0.08)',
    border: `1px solid ${colors.seedlingGreen}`,
    borderRadius: rounded.sm,
    fontSize: 12,
    color: colors.uniformGreen,
    fontStyle: 'italic',
    wordBreak: 'break-all',
  },
};

export function FieldCardComponent({ field, selectorState, state, controller }: FieldCardProps) {
  const { key, label, category, deprecated } = field;
  const { selector, status, extractedPreview, matchCount, warnings, stability, error } = selectorState;

  // ── Special rendering for titleOptionalSelectors ──────────────────────
  if (key === 'titleOptionalSelectors') {
    return <TitleOptionalCard state={state} controller={controller} />;
  }

  const isAssigned = Boolean(selector && selector.trim());

  return (
    <div style={s.card}>
      <div style={s.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={s.label}>{label}</span>
          <span style={s.catBadge}>{category}</span>
          {deprecated && (
            <span style={{ ...s.catBadge, background: '#fee2e2', color: '#991b1b' }}>
              deprecated
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isAssigned && (
            <span style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.uniformGreen, background: 'rgba(22,132,77,0.08)', padding: '2px 8px', borderRadius: rounded.sm, border: `1px solid rgba(22,132,77,0.2)` }}>
              Active: {selector}
            </span>
          )}
          <span style={statusBadgeStyle(status)}>{STYLE_MAP[status]?.label ?? status}</span>
        </div>
      </div>

      {(state.snapshot as any)?.dom && (
        <FieldCardPreview
          fieldKey={key}
          label={label}
          selector={selector}
          snapshot={state.snapshot as any}
          sampleCaptures={state.sampleCaptures}
          samples={state.samples.length > 0 ? state.samples : [{ id: 'preview', url: state.draft.productUrl || '' }]}
          controller={controller}
        />
      )}

      {error && <div style={s.err}>{error}</div>}

      {/* ── Suggestion display ── */}
      {renderFieldSuggestion(field.key, state.generation.fieldSuggestions[field.key], controller)}

      <details style={{ marginTop: 8 }}>
        <summary style={{ fontSize: 11, color: colors.mulchBrown, cursor: 'pointer', fontFamily: fonts.body, fontWeight: 600 }}>
          Advanced (Manual Selector Input)
        </summary>
        <div style={{ marginTop: 6 }}>
          <SelectorInput
            value={selector}
            onChange={(val) => controller.updateSelector(key, val)}
            placeholder={`e.g. ${key}`}
            error={error}
          />
        </div>
      </details>

      <div style={s.actions}>
        {selector && (
          <button type="button" style={s.clearBtn} onClick={() => controller.updateSelector(key, '')}>
            Clear Selector
          </button>
        )}
      </div>
    </div>
  );
}

function FieldCardPreview({
  fieldKey,
  label,
  selector,
  snapshot,
  sampleCaptures,
  samples,
  controller,
}: {
  fieldKey: string;
  label: string;
  selector: string;
  snapshot: any;
  sampleCaptures?: Record<string, { html: string; dom: string }>;
  samples: Array<{ id: string; url: string }>;
  controller: any;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [clickedText, setClickedText] = useState<string | undefined>(undefined);
  const [isCollapsed, setIsCollapsed] = useState<boolean>(Boolean(selector && selector.trim()));

  const hasActiveSelector = Boolean(selector && selector.trim());

  const captures = React.useMemo(() => {
    const caps: Record<string, { html: string; dom: string }> = {};
    for (const s of samples) {
      const perSample = sampleCaptures?.[s.id] ?? sampleCaptures?.[s.url] ?? (snapshot as any)?.sampleCaptures?.[s.id];
      caps[s.id] = {
        html: perSample?.html ?? (snapshot?.dom as string) ?? '',
        dom: perSample?.dom ?? (snapshot?.dom as string) ?? '',
      };
    }
    return caps;
  }, [samples, sampleCaptures, snapshot?.dom]);

  const candidates = React.useMemo(() => {
    return rankCandidates(
      { dom: snapshot?.dom as string, html: snapshot?.dom as string },
      fieldKey,
      clickedText,
    );
  }, [snapshot?.dom, fieldKey, clickedText]);

  const values = React.useMemo(() => {
    const vals: Record<string, string | null> = {};
    for (const s of samples) {
      const cap = captures[s.id];
      const top = candidates[0];
      if (!top || !cap?.html) {
        vals[s.id] = null;
      } else {
        vals[s.id] = evaluateValuesInstant({ html: cap.html }, top.selector, fieldKey) ?? evaluateValuesInstant({ html: cap.html }, selector, fieldKey);
      }
    }
    return vals;
  }, [samples, captures, candidates, selector]);

  const previewSummary = React.useMemo(() => {
    if (!selector) return null;
    const firstSample = samples[0];
    if (!firstSample) return null;
    const cap = captures[firstSample.id];
    if (!cap?.html) return null;
    return evaluateValuesInstant({ html: cap.html }, selector, fieldKey);
  }, [selector, samples, captures, fieldKey]);

  const elements: Array<{ id: string; x: number; y: number; w: number; h: number; text: string; tag?: string }> = (snapshot.elements as Array<{ id: string; x: number; y: number; w: number; h: number; text: string; tag?: string }>) ?? [];
  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (elements.length === 0) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const scaleX = (snapshot.viewport?.w ?? rect.width) / rect.width;
    const scaleY = (snapshot.viewport?.h ?? rect.height) / rect.height;
    const hitId = hitTest(elements, x * scaleX, y * scaleY);
    if (!hitId) return;
    const el = elements.find(ee => ee.id === hitId);
    if (el?.text) {
      setClickedText(el.text);
      setPickerOpen(false);
      setIsCollapsed(false);
    }
  };

  return (
    <div style={{ marginTop: 6 }}>
      {/* ── Collapsed Compact View When Selector Active ── */}
      {hasActiveSelector && isCollapsed ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 10,
            padding: '8px 12px',
            background: 'rgba(20, 83, 45, 0.04)',
            border: `1px solid rgba(20, 83, 45, 0.2)`,
            borderRadius: rounded.md,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 220 }}>
            <span
              style={{
                fontFamily: fonts.mono,
                fontSize: 11,
                fontWeight: 700,
                color: colors.uniformGreen,
                background: 'rgba(20, 83, 45, 0.08)',
                padding: '2px 8px',
                borderRadius: rounded.sm,
                border: '1px solid rgba(20, 83, 45, 0.25)',
              }}
            >
              {selector}
            </span>
            {previewSummary && (
              <span
                style={{
                  fontSize: 11,
                  fontFamily: fonts.mono,
                  color: colors.ledgerCharcoal,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: 280,
                }}
                title={previewSummary}
              >
                "{previewSummary}"
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              onClick={() => setIsCollapsed(false)}
              style={{
                background: colors.whiteSurface,
                border: `1px solid ${colors.cardBorder}`,
                borderRadius: rounded.sm,
                padding: '4px 10px',
                fontFamily: fonts.body,
                fontSize: 11,
                fontWeight: 700,
                color: colors.uniformGreen,
                cursor: 'pointer',
              }}
            >
              ▼ Change / View Candidates ({candidates.length})
            </button>
            <button
              type="button"
              style={{
                background: colors.uniformGreen,
                color: colors.feedBagCream,
                border: 'none',
                borderRadius: rounded.sm,
                padding: '4px 10px',
                fontFamily: fonts.body,
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
              }}
              onClick={async () => { await controller.captureSnapshot(); setPickerOpen(true); }}
            >
              Select on page
            </button>
          </div>
        </div>
      ) : (
        /* ── Full Expanded Candidate Grid ── */
        <div>
          {hasActiveSelector && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
              <button
                type="button"
                onClick={() => setIsCollapsed(true)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: colors.mulchBrown,
                  fontFamily: fonts.body,
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                  padding: '2px 6px',
                }}
              >
                ▲ Collapse Candidates
              </button>
            </div>
          )}

          <ValuePreviewGrid
            samples={samples}
            candidates={candidates}
            values={values}
            fieldLabel={label}
            captures={captures}
            activeSelector={selector}
            onSelectCandidate={(sel) => {
              controller.updateSelector(fieldKey, sel);
            }}
          />

          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                type="button"
                style={{
                  background: colors.uniformGreen,
                  color: colors.feedBagCream,
                  border: 'none',
                  borderRadius: rounded.sm,
                  padding: '6px 12px',
                  fontFamily: fonts.body,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                  boxShadow: '0 1px 2px rgba(20,83,45,0.15)',
                }}
                onClick={async () => { await controller.captureSnapshot(); setPickerOpen(true); }}
              >
                Select on page
              </button>
              {clickedText && <span style={{ fontFamily: fonts.body, fontSize: 11, color: colors.mulchBrown }}>picked: “{clickedText.slice(0, 40)}”</span>}
            </div>

            {hasActiveSelector && (
              <button
                type="button"
                onClick={() => setIsCollapsed(true)}
                style={{
                  background: colors.feedBagCream,
                  border: `1px solid ${colors.cardBorder}`,
                  borderRadius: rounded.sm,
                  padding: '4px 10px',
                  fontFamily: fonts.body,
                  fontSize: 11,
                  fontWeight: 700,
                  color: colors.mulchBrown,
                  cursor: 'pointer',
                }}
              >
                ▲ Collapse
              </button>
            )}
          </div>
        </div>
      )}
      {pickerOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(33,20,20,0.65)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(2px)' }} onClick={() => setPickerOpen(false)}>
          <div style={{ background: colors.whiteSurface, borderRadius: rounded.lg, border: `1px solid ${colors.cardBorder}`, padding: 16, maxWidth: '90vw', maxHeight: '85vh', overflow: 'auto', boxShadow: '0 12px 32px rgba(33,20,20,0.2)' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, paddingBottom: 8, borderBottom: `1px solid ${colors.cardBorder}` }}>
              <strong style={{ fontFamily: fonts.display, fontSize: '1rem', color: colors.ledgerCharcoal }}>Click the {label} on the page</strong>
              <button type="button" style={{ border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.sm, padding: '4px 10px', background: colors.whiteSurface, fontFamily: fonts.body, fontSize: 11, fontWeight: 600, cursor: 'pointer' }} onClick={() => setPickerOpen(false)}>Close</button>
            </div>
            {snapshot.screenshotBase64 ? (
              <div style={{ position: 'relative', border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.sm, overflow: 'hidden' }} onClick={handleOverlayClick}>
                <img src={`data:image/png;base64,${snapshot.screenshotBase64}`} alt="capture" style={{ display: 'block', maxWidth: 760 }} />
                <div style={{ position: 'absolute', inset: 0 }} />
              </div>
            ) : (
              <div style={{ border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.sm, padding: 12, maxHeight: 400, overflow: 'auto', fontSize: 12, background: colors.feedBagCream }} onClick={handleOverlayClick}>
                <div style={{ color: colors.mulchBrown, marginBottom: 8, fontFamily: fonts.body, fontSize: 11 }}>Rendered screenshot unavailable — click is simulated via text list (static fallback)</div>
                {elements.length > 0 ? elements.slice(0, 40).map(el => (
                  <button key={el.id} type="button" style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.sm, background: colors.whiteSurface, marginBottom: 4, cursor: 'pointer', fontFamily: fonts.mono, fontSize: 11 }} onClick={() => { setClickedText(el.text); setPickerOpen(false); }}>{el.tag} — {el.text.slice(0, 60)}</button>
                )) : <div style={{ color: colors.mulchBrown, fontFamily: fonts.body, fontSize: 11 }}>No element map — using DOM parse fallback</div>}
              </div>
            )}
            <div style={{ marginTop: 10, fontSize: 11, color: colors.mulchBrown, fontFamily: fonts.body }}>Click maps via hitTest(elements) → candidate selectors updated.</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Field Suggestion Renderer ────────────────────────────────────────────

const sug: Record<string, React.CSSProperties> = {
  wrapper: {
    marginTop: 8,
    padding: '10px 12px',
    background: colors.feedBagCream,
    borderRadius: rounded.sm,
    border: `1px solid ${colors.cardBorder}`,
  },
  header: { fontSize: 11, fontWeight: 700, color: colors.mulchBrown, marginBottom: 6, textTransform: 'uppercase' as const, letterSpacing: '0.04em' },
  selector: { fontSize: 12, fontFamily: fonts.mono, color: colors.ledgerCharcoal, wordBreak: 'break-all', marginBottom: 6, background: colors.whiteSurface, padding: '4px 8px', borderRadius: rounded.sm, border: `1px solid ${colors.cardBorder}` },
  meta: { fontSize: 11, color: colors.mulchBrown, marginBottom: 6, display: 'flex', gap: 8, flexWrap: 'wrap' },
  preview: { fontSize: 12, color: colors.ledgerCharcoal, marginBottom: 6, fontStyle: 'italic', wordBreak: 'break-all' },
  warn: { fontSize: 11, color: colors.ledgerCharcoal, background: 'rgba(246,219,18,0.2)', border: `1px solid ${colors.mutedGold}`, padding: '4px 8px', borderRadius: rounded.sm, marginBottom: 6 },
  err: { fontSize: 11, color: colors.signetBurgundy, background: 'rgba(118,12,25,0.08)', border: `1px solid ${colors.signetBurgundy}`, padding: '4px 8px', borderRadius: rounded.sm, marginBottom: 6 },
  actions: { display: 'flex', gap: 6, marginTop: 6 },
  acceptBtn: {
    background: colors.uniformGreen, color: colors.feedBagCream, border: 'none', borderRadius: rounded.sm,
    padding: '5px 12px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', cursor: 'pointer',
  },
  acceptLowBtn: {
    background: colors.mutedGold, color: colors.ledgerCharcoal, border: 'none', borderRadius: rounded.sm,
    padding: '5px 12px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', cursor: 'pointer',
  },
  rejectBtn: {
    background: colors.whiteSurface, color: colors.mulchBrown, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.sm,
    padding: '5px 12px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', cursor: 'pointer',
  },
  dismissBtn: {
    background: colors.whiteSurface, color: colors.mulchBrown, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.sm,
    padding: '4px 10px', fontSize: 11, cursor: 'pointer',
  },
  qualityBadge: { fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: rounded.full, textTransform: 'uppercase' as const, letterSpacing: '0.04em' },
  noSel: { fontSize: 12, color: colors.mulchBrown, fontStyle: 'italic', marginBottom: 4 },
};

function qualityBadgeStyle(quality: string): React.CSSProperties {
  switch (quality) {
    case 'high': return { ...sug.qualityBadge, background: 'rgba(22, 132, 77, 0.15)', color: colors.seedlingGreen, border: `1px solid ${colors.seedlingGreen}44` };
    case 'medium': return { ...sug.qualityBadge, background: 'rgba(20, 83, 45, 0.12)', color: colors.uniformGreen, border: `1px solid ${colors.uniformGreen}44` };
    case 'low': return { ...sug.qualityBadge, background: 'rgba(246, 219, 18, 0.3)', color: colors.ledgerCharcoal, border: `1px solid ${colors.mutedGold}` };
    default: return { ...sug.qualityBadge, background: 'rgba(118, 12, 25, 0.1)', color: colors.signetBurgundy, border: `1px solid ${colors.signetBurgundy}44` };
  }
}

function renderFieldSuggestion(
  fieldKey: string,
  suggestion: FieldSuggestionState | undefined,
  controller: ProfileBuilderController,
): React.ReactNode {
  if (!suggestion || suggestion.decision !== 'pending') return null;

  const { resultStatus, selector, quality, validation, warnings, explanation, preview } = suggestion;

  // ── not_found ──
  if (resultStatus === 'not_found') {
    return (
      <div style={sug.wrapper}>
        <div style={sug.header}>Generated</div>
        <div style={sug.noSel}>No reliable selector was found for this field.</div>
      </div>
    );
  }

  // ── invalid ──
  if (resultStatus === 'invalid') {
    return (
      <div style={sug.wrapper}>
        <div style={sug.header}>Generated selector could not be used</div>
        {selector && <div style={{ ...sug.err, wordBreak: 'break-all' }}>{selector}</div>}
        <div style={sug.err}>Invalid CSS selector syntax.</div>
        <div style={sug.actions}>
          <button type="button" style={sug.dismissBtn} onClick={() => controller.rejectSelectorSuggestion(fieldKey)}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  // ── suggested ──
  if (resultStatus === 'suggested' && selector) {
    const isLowQuality = quality === 'low' || quality === 'unusable';
    const warnList = warnings || [];

    return (
      <div style={sug.wrapper}>
        <div style={sug.header}>Suggested selector</div>
        <div style={sug.selector}>{selector}</div>
        <div style={sug.meta}>
          <span style={qualityBadgeStyle(quality)}>{quality}</span>
          <span>{validation.matchedCount} match{validation.matchedCount !== 1 ? 'es' : ''}</span>
          {validation.visibleMatchedCount != null && (
            <span>{validation.visibleMatchedCount} visible</span>
          )}
          {explanation && <span style={{ color: '#6b7280' }}>· {explanation}</span>}
        </div>
        {preview?.text && <div style={sug.preview}>Preview: {preview.text}</div>}
        {preview?.values && preview.values.length > 0 && (
          <div style={sug.preview}>Values: {preview.values.slice(0, 3).join(', ')}{preview.values.length > 3 ? ` +${preview.values.length - 3} more` : ''}</div>
        )}
        {preview?.imageUrls && preview.imageUrls.length > 0 && (
          <div style={sug.preview}>Images: {preview.imageUrls.length} found</div>
        )}
        {warnList.length > 0 && (
          <div style={sug.warn}>
            {warnList.map((w, i) => (
              <div key={i}>{w.message}</div>
            ))}
          </div>
        )}
        <div style={sug.actions}>
          <button
            type="button"
            style={isLowQuality ? sug.acceptLowBtn : sug.acceptBtn}
            onClick={() => controller.acceptSelectorSuggestion(fieldKey)}
          >
            {isLowQuality ? 'Accept anyway' : 'Accept ✓'}
          </button>
          <button
            type="button"
            style={sug.rejectBtn}
            onClick={() => controller.rejectSelectorSuggestion(fieldKey)}
          >
            Reject ✗
          </button>
        </div>
      </div>
    );
  }

  return null;
}

// ─── Title Optional Sub-component ──────────────────────────────────────────

interface TitleOptionalCardProps {
  state: ProfileBuilderState;
  controller: ProfileBuilderController;
}

function TitleOptionalCard({ state, controller }: TitleOptionalCardProps) {
  const selectors = state.draft.titleOptionalSelectors;
  const concatPreview = selectors.length > 0
    ? selectors.filter(Boolean).join(' — ')
    : null;

  return (
    <div style={s.card}>
      <div style={s.header}>
        <div>
          <span style={s.label}>Additional title parts</span>
          <span style={s.catBadge}>identity</span>
        </div>
        <span style={statusBadgeStyle(selectors.length > 0 ? 'assigned' : 'unassigned')}>
          {selectors.length > 0 ? 'assigned' : 'unassigned'}
        </span>
      </div>

      {selectors.map((sel, i) => (
        <div key={i} style={s.tRow}>
          <span style={{ fontSize: 11, color: '#9ca3af', minWidth: 20 }}>#{i + 1}</span>
          <input
            type="text"
            style={s.tInput}
            value={sel}
            onChange={(e) => controller.updateTitleOptionalSelector(i, e.target.value)}
            placeholder="e.g. .product-subtitle"
          />
          <button
            type="button"
            style={s.tRemove}
            onClick={() => controller.removeTitleOptionalSelector(i)}
            title="Remove"
          >
            ×
          </button>
        </div>
      ))}

      <button
        type="button"
        style={s.addRow}
        onClick={() => controller.addTitleOptionalSelector()}
      >
        + Add subtitle selector
      </button>

      {concatPreview && (
        <div style={s.concatPreview}>
          Concatenated: "{concatPreview}"
        </div>
      )}
    </div>
  );
}

export const FieldCard = React.memo(FieldCardComponent);
export const TitleOptionalCardMemo = React.memo(TitleOptionalCard);
