/**
 * ReviewPagesPanel — the Category Pages field promoted into the main form.
 *
 * Pages are a PROMOTION REQUIREMENT (≥1 verified page assignment), so this
 * editor lives in the primary field stack rather than inside the Additional
 * Fields panel. Data flow is unchanged from the original implementation in
 * ReviewClassificationPanel: edits write curation_data.suggestedPages via
 * onUpdatePages, and adding a VERIFIED page additionally persists the
 * correctedCategoryPage provenance record (adjudication #10) so the review
 * completion gate can resolve an abstained durable decision.
 */
import { useEffect, useState } from 'react';
import type { ItemDetailResponse } from '../../../onboarding-api';
import type { CurationData } from '../../../../shared/schemas/onboarding';
import { listPages, listVerifiedPageOptionSummaries } from '../../../api';

export interface CategoryPageCorrection {
  pageId: string;
  activePageImportHash: string;
}

export interface ReviewPagesPanelProps {
  detail: ItemDetailResponse | null;
  onUpdatePages?: (suggestedPages: string[], correction?: CategoryPageCorrection) => Promise<void>;
}

export function ReviewPagesPanel({ detail, onUpdatePages }: ReviewPagesPanelProps) {
  const [availablePages, setAvailablePages] = useState<string[]>([]);
  // e09 round-3 FIX 1: verified options + active import hash for corrections.
  const [verifiedPages, setVerifiedPages] = useState<Array<{ id: string; name: string }>>([]);
  const [activeImportHash, setActiveImportHash] = useState<string | null>(null);
  const [isAddingPage, setIsAddingPage] = useState(false);
  const [pageSearch, setPageSearch] = useState('');
  const [savingPages, setSavingPages] = useState(false);

  useEffect(() => {
    let mounted = true;
    listPages()
      .then(res => {
        if (mounted && res?.pages) {
          const names = [...new Set(res.pages.map(p => p.name).filter(Boolean))].sort();
          setAvailablePages(names);
        }
      })
      .catch(() => {});
    listVerifiedPageOptionSummaries()
      .then(res => {
        if (!mounted) return;
        setVerifiedPages((res?.pages ?? []).map(p => ({ id: p.id, name: p.name })));
        setActiveImportHash(res?.activeImportHash ?? null);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  const curation = detail?.item.curationData as CurationData | null;
  const suggestedPages = curation?.suggestedPages ?? [];
  const gating = curation?.categoryPageGating ?? null;

  const handleRemovePage = async (pageToRemove: string) => {
    if (!onUpdatePages || savingPages) return;
    setSavingPages(true);
    try {
      const next = suggestedPages.filter(p => p !== pageToRemove);
      await onUpdatePages(next);
    } finally {
      setSavingPages(false);
    }
  };

  const handleAddPage = async (pageToAdd: string) => {
    if (!onUpdatePages || savingPages || suggestedPages.includes(pageToAdd)) return;
    setSavingPages(true);
    try {
      const next = [...suggestedPages, pageToAdd];
      // e09 round-3 FIX 1 (adjudication #10): when the added page resolves to
      // a VERIFIED identity of the ACTIVE import, persist the correction record.
      const verified = verifiedPages.find(p => p.name === pageToAdd);
      const correction =
        verified && activeImportHash
          ? { pageId: verified.id, activePageImportHash: activeImportHash }
          : undefined;
      await onUpdatePages(next, correction);
      setIsAddingPage(false);
      setPageSearch('');
    } finally {
      setSavingPages(false);
    }
  };

  const filteredPageOptions = availablePages.filter(
    p => !suggestedPages.includes(p) && p.toLowerCase().includes(pageSearch.toLowerCase()),
  );

  return (
    <section className="rv-panel" aria-label="Category Pages" id="rv-pages-panel" tabIndex={-1}>
      <header className="rv-panel-head">
        Category Pages
        <span
          className="rv-req-badge"
          title="Promotion requires at least one verified page assignment"
          style={{
            marginLeft: '0.5rem',
            fontSize: '0.6875rem',
            fontWeight: 600,
            padding: '0.0625rem 0.375rem',
            borderRadius: '9999px',
            background: '#fef3c7',
            color: '#92400e',
            verticalAlign: 'middle',
          }}
        >
          Required
        </span>
      </header>
      <div className="rv-panel-body">
        <div className="rv-field">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div className="rv-field-label">Assigned store pages</div>
            {onUpdatePages && (
              <button
                type="button"
                className="rv-btn rv-btn-secondary"
                style={{ fontSize: '0.75rem', padding: '0.125rem 0.5rem', height: 'auto' }}
                onClick={() => setIsAddingPage(prev => !prev)}
                disabled={savingPages}
              >
                {isAddingPage ? 'Done' : '+ Add Page'}
              </button>
            )}
          </div>
          {suggestedPages.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', marginTop: '0.25rem' }}>
              {suggestedPages.map(page => (
                <span
                  key={page}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '0.25rem 0.625rem',
                    borderRadius: '9999px',
                    fontSize: '0.8125rem',
                    fontWeight: 500,
                    background: '#eff6ff',
                    color: '#1d4ed8',
                    border: '1px solid #bfdbfe',
                  }}
                >
                  📁 {page}
                  {onUpdatePages && (
                    <button
                      type="button"
                      aria-label={`Remove ${page}`}
                      title={`Remove ${page}`}
                      disabled={savingPages}
                      onClick={() => void handleRemovePage(page)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#1d4ed8',
                        cursor: 'pointer',
                        fontWeight: 'bold',
                        marginLeft: '0.375rem',
                        padding: 0,
                        fontSize: '0.875rem',
                        lineHeight: 1,
                      }}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
            </div>
          ) : (
            <div className="rv-field-value" style={{ color: 'var(--text-muted, #64748b)', fontStyle: 'italic' }}>
              No category pages assigned yet.
            </div>
          )}

          {isAddingPage && onUpdatePages && (
            <div style={{ marginTop: '0.5rem', background: '#f8fafc', padding: '0.5rem', borderRadius: '4px', border: '1px solid #e2e8f0' }}>
              <input
                type="text"
                className="rv-input"
                style={{ fontSize: '0.8125rem', width: '100%', marginBottom: '0.375rem' }}
                placeholder="Search category pages to add..."
                value={pageSearch}
                onChange={e => setPageSearch(e.target.value)}
                autoFocus
              />
              <div style={{ maxHeight: '140px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {filteredPageOptions.slice(0, 20).map(page => (
                  <button
                    key={page}
                    type="button"
                    style={{
                      textAlign: 'left',
                      padding: '0.25rem 0.5rem',
                      background: '#fff',
                      border: '1px solid #cbd5e1',
                      borderRadius: '3px',
                      cursor: 'pointer',
                      fontSize: '0.8125rem',
                    }}
                    onClick={() => void handleAddPage(page)}
                  >
                    + {page}
                  </button>
                ))}
                {filteredPageOptions.length === 0 && (
                  <div style={{ fontSize: '0.75rem', color: '#64748b', padding: '0.25rem' }}>
                    {pageSearch ? 'No matching pages found.' : 'All store pages already added.'}
                  </div>
                )}
              </div>
            </div>
          )}
          {gating?.needsVerifiedPages && (
            <div className="rv-field-value" style={{ marginTop: '0.375rem', fontSize: '0.75rem', color: '#92400e' }}>
              {gating.needsReviewedType
                ? 'Needs reviewed Product Type — page assignment requires an accepted Product Type.'
                : `No verified Catalog Pages for import — ${gating.verifiedPageCount} verified page${gating.verifiedPageCount === 1 ? '' : 's'} in snapshot. Import ShopSite pages first.`}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
