/**
 * Epic #46 — Review identity panel (Phase 6).
 *
 * Imported identity vs curated output side by side, UPC, brand, variant/size,
 * family context, and source identity.
 */
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import type { ReviewQueueRow } from '../../../../shared/schemas/onboarding-review-queue';
import type { ItemDetailResponse } from '../../../onboarding-api';
import { sourceTypeLabel } from './review-logic';

export interface ReviewIdentityPanelProps {
  workState: ReviewQueueRow | OnboardingWorkState;
  detail: ItemDetailResponse | null;
  /** Computed more-information file name for this draft (issue #109). */
  fileName?: string | null;
}

function extraction(detail: ItemDetailResponse | null) {
  return detail?.extraction ?? detail?.item.extractionData ?? null;
}

export function ReviewIdentityPanel({ workState, detail, fileName }: ReviewIdentityPanelProps) {
  const ext = extraction(detail);

  return (
    <section className="rv-panel" aria-label="Product identification">
      <header className="rv-panel-head">Product Identification</header>
      <div className="rv-panel-body">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: '0.75rem 1.25rem',
          }}
        >
          <div className="rv-field" style={{ marginBottom: 0 }}>
            <div className="rv-field-label">UPC / GTIN</div>
            <div className="rv-field-value" style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
              {workState.upc || '—'}
            </div>
          </div>

          <div className="rv-field" style={{ marginBottom: 0 }}>
            <div className="rv-field-label">Register Name (Imported)</div>
            <div
              className="rv-field-value"
              style={{ fontWeight: 500 }}
              title={detail?.item.name ?? ('name' in workState ? (workState as any).name : workState.displayTitle)}
            >
              {(detail?.item.name ?? ('name' in workState ? (workState as any).name : workState.displayTitle)) || '—'}
            </div>
          </div>

          {fileName ? (
            <div className="rv-field" style={{ marginBottom: 0 }}>
              <div className="rv-field-label">More-info file name</div>
              <div className="rv-field-value" style={{ fontFamily: 'var(--font-mono)' }} title={fileName}>
                {fileName}
              </div>
            </div>
          ) : null}

          <div className="rv-field" style={{ marginBottom: 0 }}>
            <div className="rv-field-label">Source</div>
            <div className="rv-field-value">
              {sourceTypeLabel(workState.sourceType)}
              {'domain' in workState && workState.domain ? ` · ${workState.domain}` : ''}
              {ext?.distributorProviderId ? ` · ${ext.distributorProviderId}` : ''}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}