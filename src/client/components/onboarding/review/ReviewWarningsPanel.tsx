/**
 * Epic #46 — Review warnings / provenance panel (Phase 6).
 *
 * Surfaces blocking semantic validation, consistency warnings, evidence
 * summary, and source provenance. A blocked finding prevents Looks Good.
 */
import type { ItemDetailResponse } from '../../../onboarding-api';
import type { BatchFilenamePreviewItem } from '../../../onboarding-work-api';
import { warningInfoFromDetail } from './review-logic';

export interface ReviewWarningsPanelProps {
  detail: ItemDetailResponse | null;
  /** Filename warnings for this draft from the batch preview (issue #109). */
  filenameWarnings?: BatchFilenamePreviewItem['warnings'];
}

function evidenceSummary(detail: ItemDetailResponse | null): string[] {
  const lines: string[] = [];
  const ext = detail?.extraction ?? detail?.item.extractionData ?? null;
  if (!ext) return ['No extraction evidence yet.'];
  if (ext.distributorProviderIds && ext.distributorProviderIds.length > 0) {
    lines.push(`Distributor evidence: ${[...new Set(ext.distributorProviderIds)].join(', ')}`);
  }
  if (ext.sourceType === 'official_page') {
    lines.push(`Official page evidence${ext.sourceUrl ? ` from ${ext.sourceUrl}` : ''}`);
  }
  if (ext.distributorRecordProvenance) {
    lines.push(
      `Distributor record projection (${ext.distributorRecordProvenance.projectionVersion ?? 'v1'}) — evidence hash ${ext.distributorRecordProvenance.evidenceHash.slice(0, 10)}…`,
    );
  }
  const piEvidence = ext.productIntelligenceEvidence ?? [];
  if (piEvidence.length > 0) {
    // ADR-0030 Phase 4: PI import tables are dropped; this line is purely a
    // historical display for items that still carry imported-evidence arrays.
    lines.push(`Product Intelligence imports (historical): ${piEvidence.length}`);
  }
  if (lines.length === 0) lines.push('Extraction evidence present (provenance unknown).');
  return lines;
}

export function ReviewWarningsPanel({ detail, filenameWarnings }: ReviewWarningsPanelProps) {
  const info = warningInfoFromDetail(detail ?? {});
  const evidence = evidenceSummary(detail);
  const filenameItems = (filenameWarnings ?? []).filter(w => typeof w?.message === 'string' && w.message.length > 0);

  return (
    <section className="rv-panel" aria-label="Warnings and provenance">
      <header className="rv-panel-head">Warnings / provenance</header>
      <div className="rv-panel-body">
        {info.blocked ? (
          <div className="rv-blocked">
            <div className="rv-blocked-title">Review is blocked for this product</div>
            <ul className="rv-warn-list">
              {info.messages.map((message, idx) => (
                <li key={idx}>{message}</li>
              ))}
            </ul>
          </div>
        ) : info.messages.length > 0 ? (
          <ul className="rv-warn-list" style={{ marginBottom: '0.625rem' }}>
            {info.messages.map((message, idx) => (
              <li key={idx}>{message}</li>
            ))}
          </ul>
        ) : (
          <div className="rv-warn-ok">✓ No blocking warnings</div>
        )}

        {filenameItems.length > 0 && (
          <div className="rv-blocked">
            <div className="rv-blocked-title">More-info file name needs a decision</div>
            <ul className="rv-warn-list">
              {filenameItems.map((warning, idx) => (
                <li key={idx}>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{warning.fileName}</span>
                  {' — '}{warning.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="rv-field" style={{ marginTop: '0.875rem' }}>
          <div className="rv-field-label">Evidence summary</div>
          <ul className="rv-list" style={{ fontSize: '0.8125rem' }}>
            {evidence.map((line, idx) => (
              <li key={idx}>{line}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}