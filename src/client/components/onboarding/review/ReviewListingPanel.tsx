import { useEffect, useMemo, useRef, useState } from 'react';
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import type { ReviewQueueRow } from '../../../../shared/schemas/onboarding-review-queue';
import type { MediaSelectionRequest, SourceType } from '../../../../shared/schemas/onboarding';
import type { ItemDetailResponse } from '../../../onboarding-api';
import { distributorApprovedImages } from './review-logic';
import type { ReviewDraft } from './review-types';
import {
  fieldEditability,
  listingFactValues,
  QUANTITY_READONLY_NOTE,
} from './review-editability';
import { gateMessageId } from './review-readiness';

export interface ReviewListingPanelProps {
  workState?: ReviewQueueRow | OnboardingWorkState | null;
  detail: ItemDetailResponse | null;
  editing: boolean;
  draft: ReviewDraft;
  onDraftChange: (draft: ReviewDraft) => void;
  onSaveEdit: () => Promise<void>;
  onCancelEdit: () => void;
  /** V2 always-editable: show Save/Cancel only when the draft is dirty. */
  showSaveActions?: boolean;
  saving: boolean;
  saveError: string | null;
  onOpenLightbox?: (url: string, caption: string) => void;
  /** e10s02 full-field review form. Price is read-only; quantity remains
   * editable only for official-page items. */
  v2?: boolean;
  /**
   * e10s03 a11y wiring — jump-target id → blocking gate codes for that
   * input. Drives aria-invalid + aria-describedby → readiness message
   * nodes (SC 3.3.1/3.3.3). Undefined ⇒ no error state (flag-off parity).
   */
  blockedCodesByField?: Record<string, string[]>;
  /**
   * e10s04 — persist handler for the reviewer media selection (primary /
   * reorder / suppression). Provided only when V2 is on; omitted ⇒ the
   * media carousel stays display-only (flag-off parity).
   */
  onSaveMedia?: (selection: MediaSelectionRequest) => Promise<void>;
  /** e10s04 — media save in flight. */
  savingMedia?: boolean;
}

function extraction(detail: ItemDetailResponse | null) {
  return detail?.extraction ?? detail?.item.extractionData ?? null;
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function ReviewListingPanel({
  workState,
  detail,
  editing,
  draft,
  onDraftChange,
  onSaveEdit,
  onCancelEdit,
  showSaveActions = true,
  saving,
  saveError,
  onOpenLightbox,
  v2 = false,
  blockedCodesByField,
  onSaveMedia,
  savingMedia = false,
}: ReviewListingPanelProps) {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);

  const ext = extraction(detail);
  const curation = detail?.item.curationData ?? null;
  const approved = distributorApprovedImages(ext);
  const sourceType: SourceType =
    detail?.item.sourceType === 'distributor_record'
      ? 'distributor_record'
      : ((workState?.sourceType as SourceType) ?? 'official_page');
  const quantityEditable = fieldEditability(sourceType, 'quantity') === 'editable';
  const primary = ext?.primaryImage ?? approved?.primary ?? workState?.imageUrl ?? null;
  const additional = (ext?.additionalImages ?? []).filter(url => url !== primary);
  for (const url of approved?.additional ?? []) {
    if (url !== primary && !additional.includes(url)) additional.push(url);
  }

  // ── e10s04 reviewer media picker (V2 only) ─────────────────────────────
  // Candidate universe mirrors the server route: extraction ∪ previously
  // persisted reviewedMedia entries; distributor rows draw ONLY from the
  // approved display set. Explicit explicit-save semantics: saving is a
  // consequential edit and resets the item's durable review state.
  const interactiveMedia = Boolean(v2 && onSaveMedia);
  const priorMedia = (curation as { reviewedMedia?: { primaryImage?: string | null; orderedAdditional?: string[]; suppressed?: string[] } | null } | null | undefined)?.reviewedMedia ?? null;

  const baseImages = useMemo(() => {
    const list: string[] = [];
    const push = (url: unknown) => {
      if (typeof url === 'string' && url.length > 0 && !list.includes(url)) list.push(url);
    };
    if ((workState?.sourceType ?? sourceType) === 'distributor_record') {
      if (approved) {
        push(approved.primary);
        for (const url of approved.additional) push(url);
      }
      for (const url of priorMedia?.orderedAdditional ?? []) push(url);
      if (priorMedia?.primaryImage) push(priorMedia.primaryImage);
    } else {
      push(ext?.primaryImage);
      for (const url of ext?.additionalImages ?? []) push(url);
      for (const url of priorMedia?.orderedAdditional ?? []) push(url);
      if (priorMedia?.primaryImage) push(priorMedia.primaryImage);
    }
    if (list.length === 0 && workState?.imageUrl) push(workState.imageUrl);
    return list;
  }, [approved, ext, priorMedia, sourceType, workState?.imageUrl, workState?.sourceType]);

  const initialMedia = useMemo<{ primary: string | null; ordered: string[]; suppressed: string[] }>(() => {
    const suppressed = (priorMedia?.suppressed ?? []).filter(
      (u): u is string => typeof u === 'string' && baseImages.includes(u),
    );
    // Restore the reviewer's persisted ordering FIRST (promoter consumes
    // persisted order for commerce numbering); remaining unsuppressed
    // candidates append in extraction order so new images are never dropped.
    const savedOrder = (priorMedia?.orderedAdditional ?? []).filter(
      (u): u is string => !suppressed.includes(u) && baseImages.includes(u),
    );
    const designated =
      typeof priorMedia?.primaryImage === 'string' && priorMedia.primaryImage.trim() !== ''
        ? priorMedia.primaryImage
        : null;
    const rest = baseImages.filter((u) => !suppressed.includes(u) && !savedOrder.includes(u) && u !== designated);
    const ordered = [...(designated && !suppressed.includes(designated) ? [designated] : []), ...savedOrder, ...rest];
    return {
      primary: designated && ordered.includes(designated) ? designated : (ordered[0] ?? null),
      ordered,
      suppressed,
    };
  }, [baseImages, priorMedia]);

  const [mediaPick, setMediaPick] = useState(initialMedia);
  const [mediaDirty, setMediaDirty] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [newImageUrl, setNewImageUrl] = useState('');
  const [newImageError, setNewImageError] = useState<string | null>(null);

  // Adopt freshly loaded/saved server state unless the reviewer has unsaved edits.
  const lastInitRef = useRef(initialMedia);
  useEffect(() => {
    if (lastInitRef.current === initialMedia) return;
    lastInitRef.current = initialMedia;
    setMediaDirty(prevDirty => {
      if (!prevDirty) setMediaPick(initialMedia);
      return prevDirty;
    });
  }, [initialMedia]);

  const updateMedia = (patch: Partial<typeof mediaPick>) => {
    setMediaPick(prev => ({ ...prev, ...patch }));
    setMediaDirty(true);
  };
  const pickMediaPrimary = (url: string) => updateMedia({ primary: url });
  const suppressMedia = (url: string) => {
    const nextOrdered = mediaPick.ordered.filter(u => u !== url);
    const nextPrimary = mediaPick.primary === url ? (nextOrdered[0] ?? null) : mediaPick.primary;
    updateMedia({
      ordered: nextOrdered,
      suppressed: [...mediaPick.suppressed, url],
      primary: nextPrimary,
    });
    if (selectedImage === url) {
      setSelectedImage(nextPrimary);
    }
  };
  const restoreMedia = (url: string) =>
    updateMedia({ suppressed: mediaPick.suppressed.filter(u => u !== url), ordered: [...mediaPick.ordered, url] });
  const handleAddImage = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setNewImageError(null);
    const trimmed = newImageUrl.trim();
    if (!trimmed) {
      setNewImageError('Please enter an image URL.');
      return;
    }
    try {
      const parsed = new URL(trimmed);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        setNewImageError('URL must start with http:// or https://');
        return;
      }
    } catch {
      setNewImageError('Please enter a valid URL.');
      return;
    }

    if (mediaPick.ordered.includes(trimmed) || mediaPick.primary === trimmed) {
      setNewImageError('This image URL is already in the list.');
      return;
    }

    const nextSuppressed = mediaPick.suppressed.filter(u => u !== trimmed);
    const nextOrdered = [...mediaPick.ordered, trimmed];
    const nextPrimary = mediaPick.primary ? mediaPick.primary : trimmed;

    updateMedia({
      ordered: nextOrdered,
      suppressed: nextSuppressed,
      primary: nextPrimary,
    });
    setSelectedImage(trimmed);
    setNewImageUrl('');
    setNewImageError(null);
  };
  const moveMedia = (url: string, delta: -1 | 1) => {
    const idx = mediaPick.ordered.indexOf(url);
    const target = idx + delta;
    if (idx < 0 || target < 0 || target >= mediaPick.ordered.length) return;
    const ordered = [...mediaPick.ordered];
    [ordered[idx], ordered[target]] = [ordered[target], ordered[idx]];
    updateMedia({ ordered });
  };
  const saveMediaSelection = async () => {
    if (!onSaveMedia) return;
    setMediaError(null);
    try {
      await onSaveMedia({
        primaryImage: mediaPick.primary,
        orderedAdditional: mediaPick.ordered.filter(u => u !== mediaPick.primary),
        suppressed: mediaPick.suppressed,
      });
      setMediaDirty(false);
    } catch (err) {
      setMediaError(err instanceof Error ? err.message : String(err));
    }
  };

  // Display lists: picker state drives V2 media rendering; legacy chain unchanged.
  const displayPrimary = interactiveMedia ? mediaPick.primary : primary;
  const displayAdditional = interactiveMedia
    ? mediaPick.ordered.filter(url => url !== mediaPick.primary)
    : additional;

  const allImages = useMemo(() => {
    const list: string[] = [];
    if (displayPrimary) list.push(displayPrimary);
    for (const url of displayAdditional) {
      if (!list.includes(url)) list.push(url);
    }
    return list;
  }, [displayPrimary, displayAdditional]);

  const activeImage = selectedImage && allImages.includes(selectedImage) ? selectedImage : primary;

  const provenance =
    workState?.sourceType === 'distributor_record'
      ? 'Distributor record image'
      : 'Official page image';

  const title =
    curation?.curatedTitle ??
    ('curatedTitle' in (workState ?? {}) ? (workState as any).curatedTitle : null) ??
    ext?.title ??
    (('displayTitle' in (workState ?? {})) ? (workState as any).displayTitle : (workState as any)?.name) ??
    '';
  const brand = workState?.brand ?? detail?.item.brandHint ?? ext?.brand ?? null;
  const sizeAttr = (ext?.variantAttributes as Record<string, any> | undefined)?.size;
  const rawWeight =
    curation?.curatedWeight ??
    ext?.weight ??
    (typeof sizeAttr === 'string' && sizeAttr.trim().length > 0 ? sizeAttr.trim() : null) ??
    ('weight' in (workState ?? {}) ? (workState as any).weight : null) ??
    null;
  const weight =
    rawWeight != null && String(rawWeight).trim().length > 0
      ? /^\d+(\.\d+)?$/.test(String(rawWeight).trim())
        ? `${parseFloat(String(rawWeight).trim())} lbs`
        : String(rawWeight).trim()
      : null;

  const description =
    curation?.curatedDescription ??
    ext?.description ??
    ('description' in (workState ?? {}) ? (workState as any).description : null) ??
    null;
  const bullets = ext?.bulletPoints ?? [];
  const keywords = curation?.searchKeywords ?? ext?.searchKeywords ?? null;
  const customFields = ext?.customFields ?? {};
  // Price always comes from the product-add input; page extraction never
  // supplies it or overrides it.
  const price = detail?.item.price ?? null;
  const quantity = detail?.item.quantity;

  // e10s02: read-only "Listing facts" values (known keys) + provenance badges.
  const factRows = useMemo(
    () => (v2 ? listingFactValues((ext ?? null) as Record<string, unknown> | null) : []),
    [v2, ext],
  );
  const hasFactsContent =
    factRows.length > 0 || bullets.length > 0 || Object.keys(customFields).length > 0;

  // e10s03 SC 3.3.1/3.3.3: tie blocking gate codes to their inputs via
  // aria-invalid + aria-describedby pointing at the readiness checklist
  // message nodes.
  const invalidFor = (targetId: string): boolean =>
    (blockedCodesByField?.[targetId]?.length ?? 0) > 0;
  const describedByFor = (targetId: string, baseId?: string): string | undefined => {
    if (!v2) return baseId ? baseId : undefined;
    const ids = [...(baseId ? [baseId] : []), ...(blockedCodesByField?.[targetId] ?? []).map(gateMessageId)];
    return ids.length > 0 ? ids.join(' ') : undefined;
  };

  const handleImageClick = (url: string) => {
    if (onOpenLightbox) {
      const caption = `${provenance}${hostOf(url) ? ` — ${hostOf(url)}` : ''}`;
      onOpenLightbox(url, caption);
    }
  };

  return (
    <section className="rv-panel" aria-label="Product listing">
      <header className="rv-panel-head">Product Listing</header>
      <div className="rv-panel-body">
        {/* Top section: Media Carousel on left, short fields on right */}
        <div className="rv-listing-top">
          {/* Media Carousel */}
          <div
            className="rv-listing-media"
            {...(v2 ? { id: 'rv-listing-media', tabIndex: -1 as const } : {})}
          >
            {activeImage ? (
              <button
                type="button"
                className="rv-listing-media-main"
                onClick={() => handleImageClick(activeImage)}
                aria-label={`Zoom image for ${title || 'product'}`}
                title="Click to zoom image"
              >
                <img
                  src={activeImage}
                  alt={`${title || ('displayTitle' in (workState ?? {}) ? (workState as any).displayTitle : (workState as any)?.name) || 'Product'} primary image`}
                />
              </button>
            ) : (
              <div className="rv-listing-media-main" style={{ cursor: 'default' }}>
                <span className="rv-empty">No image</span>
              </div>
            )}

            {(allImages.length > 1 || (interactiveMedia && allImages.length > 0)) && (
              <div className="rv-listing-media-carousel" role="tablist" aria-label="Product image thumbnails">
                {allImages.map((url, idx) => (
                  <div key={`${url}-${idx}`} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <button
                      type="button"
                      className={`rv-listing-media-thumb${url === activeImage ? ' rv-thumb-active' : ''}`}
                      onClick={() => setSelectedImage(url)}
                      aria-label={`View image ${idx + 1}`}
                      title={`View image ${idx + 1}`}
                    >
                      <img src={url} alt="" />
                    </button>
                    {interactiveMedia && (
                      <div role="group" aria-label={`Actions for image ${idx + 1}`} style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                        {url !== displayPrimary && (
                          <button type="button" className="rv-mini-btn" onClick={() => pickMediaPrimary(url)} disabled={savingMedia}>
                            Set primary
                          </button>
                        )}
                        {allImages.length > 1 && (
                          <>
                            <button
                              type="button"
                              className="rv-mini-btn"
                              onClick={() => moveMedia(url, -1)}
                              disabled={savingMedia || idx === 0}
                              aria-label={`Move image ${idx + 1} earlier`}
                            >
                              ←
                            </button>
                            <button
                              type="button"
                              className="rv-mini-btn"
                              onClick={() => moveMedia(url, 1)}
                              disabled={savingMedia || idx === allImages.length - 1}
                              aria-label={`Move image ${idx + 1} later`}
                            >
                              →
                            </button>
                          </>
                        )}
                        {url !== displayPrimary && (
                          <button type="button" className="rv-mini-btn" onClick={() => suppressMedia(url)} disabled={savingMedia}>
                            Hide
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Add Image URL form */}
            {interactiveMedia && (
              <form
                noValidate
                onSubmit={handleAddImage}
                style={{ marginTop: '0.375rem', display: 'flex', flexDirection: 'column', gap: 4 }}
                aria-label="Add image URL form"
              >
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <input
                    type="url"
                    className="rv-input"
                    style={{ flex: 1, minHeight: 26, fontSize: '0.75rem', padding: '2px 6px' }}
                    placeholder="Add image URL (https://...)"
                    aria-label="Add image URL"
                    value={newImageUrl}
                    onChange={e => {
                      setNewImageUrl(e.target.value);
                      if (newImageError) setNewImageError(null);
                    }}
                    disabled={savingMedia}
                  />
                  <button
                    type="submit"
                    className="rv-mini-btn"
                    style={{ minHeight: 26, padding: '2px 8px', whiteSpace: 'nowrap' }}
                    disabled={savingMedia || !newImageUrl.trim()}
                    aria-label="Add Image"
                  >
                    Add Image
                  </button>
                </div>
                {newImageError && (
                  <span role="alert" style={{ color: 'var(--color-danger, #b00)', fontSize: '0.75rem' }}>
                    {newImageError}
                  </span>
                )}
              </form>
            )}

            {activeImage && (
              <div className="rv-provenance">
                {provenance}
                {hostOf(activeImage) ? ` from ${hostOf(activeImage)}` : ''}
              </div>
            )}

            {/* e10s04: hidden images (OVERWRITE suppression) — excluded from promotion until restored. */}
            {interactiveMedia && mediaPick.suppressed.length > 0 && (
              <div style={{ marginTop: '0.5rem' }}>
                <span className="rv-field-label">
                  Hidden ({mediaPick.suppressed.length}) — excluded from promotion
                </span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: '0.25rem' }}>
                  {mediaPick.suppressed.map((url, idx) => (
                    <button
                      key={`sup-${url}-${idx}`}
                      type="button"
                      className="rv-mini-btn"
                      onClick={() => restoreMedia(url)}
                      disabled={savingMedia}
                      aria-label={`Restore hidden image ${idx + 1}`}
                      style={{ opacity: 0.65, textDecoration: 'line-through' }}
                    >
                      img {idx + 1} · Restore
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* e10s04: explicit save (consequential edit — resets review state). */}
            {interactiveMedia && (
              <div style={{ marginTop: '0.6rem', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={saveMediaSelection}
                  disabled={!mediaDirty || savingMedia}
                  aria-label="Save media selection"
                >
                  {savingMedia ? 'Saving…' : 'Save media selection'}
                </button>
                {mediaDirty && (
                  <button
                    type="button"
                    onClick={() => {
                      setMediaPick(initialMedia);
                      setMediaDirty(false);
                      setMediaError(null);
                      setNewImageUrl('');
                      setNewImageError(null);
                    }}
                    disabled={savingMedia}
                  >
                    Cancel
                  </button>
                )}
                {mediaError && (
                  <span role="alert" style={{ color: 'var(--color-danger, #b00)' }}>
                    {mediaError}
                  </span>
                )}
                {mediaDirty && !mediaError && (
                  <span className="rv-provenance" aria-live="polite">
                    Saving resets this item's review/approval state.
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Right side: Shorter Fields (Name, Brand, Weight, Price, Quantity) */}
          <div className="rv-listing-fields">
            {editing ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div>
                  <label className="rv-field-label" htmlFor="rv-edit-title">
                    Name
                  </label>
                  <input
                    id="rv-edit-title"
                    className="rv-input"
                    aria-invalid={invalidFor('rv-edit-title') || undefined}
                    aria-describedby={describedByFor('rv-edit-title')}
                    value={draft.curatedTitle}
                    onChange={e => onDraftChange({ ...draft, curatedTitle: e.target.value })}
                  />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                  <div>
                    <label className="rv-field-label" htmlFor="rv-edit-brand">
                      Brand
                    </label>
                    <input
                      id="rv-edit-brand"
                      className="rv-input"
                      aria-invalid={invalidFor('rv-edit-brand') || undefined}
                      aria-describedby={describedByFor('rv-edit-brand')}
                      value={draft.brandHint}
                      onChange={e => onDraftChange({ ...draft, brandHint: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="rv-field-label" htmlFor="rv-edit-weight">
                      Weight{v2 ? ' (lbs)' : ''}
                    </label>
                    <input
                      id="rv-edit-weight"
                      className="rv-input"
                      placeholder="e.g. 15 lbs, 3 oz"
                      aria-invalid={invalidFor('rv-edit-weight') || undefined}
                      aria-describedby={describedByFor('rv-edit-weight', v2 ? 'rv-edit-weight-hint' : undefined)}
                      value={draft.curatedWeight}
                      onChange={e => onDraftChange({ ...draft, curatedWeight: e.target.value })}
                    />
                    {v2 && (
                      <div id="rv-edit-weight-hint" className="rv-lock-note">
                        Stored normalized as pounds.
                      </div>
                    )}
                  </div>
                </div>
                {v2 && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                    <div>
                      <label className="rv-field-label" htmlFor="rv-edit-price">
                        Price
                      </label>
                      <div
                        id="rv-edit-price"
                        tabIndex={-1}
                        className="rv-input"
                        role="status"
                        aria-readonly="true"
                        aria-invalid={invalidFor('rv-edit-price') || undefined}
                        aria-describedby={describedByFor('rv-edit-price')}
                      >
                        {detail?.item.price ?? 'No price entered'}
                      </div>
                      <div className="rv-lock-note" role="note">
                        {detail?.item.price != null && detail.item.price.trim() !== ''
                          ? 'Set when this product was added. It cannot be changed during review.'
                          : 'No price was entered when this product was added. It must be entered before review can continue.'}
                      </div>
                    </div>
                    <div>
                      <label className="rv-field-label" htmlFor="rv-edit-quantity">
                        Quantity
                      </label>
                      <input
                        id="rv-edit-quantity"
                        className="rv-input"
                        inputMode="numeric"
                        placeholder="e.g. 12"
                        disabled={!quantityEditable}
                        aria-disabled={!quantityEditable}
                        aria-invalid={invalidFor('rv-edit-quantity') || undefined}
                        aria-describedby={
                          !quantityEditable
                            ? 'rv-edit-quantity-note'
                            : describedByFor('rv-edit-quantity')
                        }
                        value={draft.quantity ?? ''}
                        onChange={e => onDraftChange({ ...draft, quantity: e.target.value })}
                      />
                      {!quantityEditable && (
                        <div id="rv-edit-quantity-note" className="rv-lock-note" role="note">
                          {QUANTITY_READONLY_NOTE}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="rv-field" style={{ marginBottom: 0 }}>
                  <div className="rv-field-label">Name</div>
                  <div className="rv-field-value" style={{ fontSize: '1.0625rem', fontWeight: 600, color: 'var(--color-ledger-charcoal)', lineHeight: 1.35 }}>
                    {title || '—'}
                  </div>
                </div>

                {v2 && (
                  <div className="rv-provenance-badges" role="list" aria-label="Curation provenance">
                    {curation?.titleSource && (
                      <span className="rv-badge rv-badge-source" role="listitem">
                        Title source: {curation.titleSource}
                      </span>
                    )}
                    {curation?.curationMethod && (
                      <span className="rv-badge rv-badge-source" role="listitem">
                        Curation: {curation.curationMethod}
                      </span>
                    )}
                    {curation?.packagingOcrTitle && (
                      <span
                        className="rv-badge rv-badge-source"
                        role="listitem"
                        title={`Packaging OCR read: ${curation.packagingOcrTitle}`}
                      >
                        OCR title: {curation.packagingOcrTitle}
                      </span>
                    )}
                  </div>
                )}

                <div className="rv-listing-specs-grid">
                  <div className="rv-field" style={{ marginBottom: 0 }}>
                    <div className="rv-field-label">Brand</div>
                    <div className="rv-field-value">{brand || '—'}</div>
                  </div>
                  <div className="rv-field" style={{ marginBottom: 0 }}>
                    <div className="rv-field-label">Weight</div>
                    <div className="rv-field-value">{weight || '—'}</div>
                  </div>
                  {price && (
                    <div className="rv-field" style={{ marginBottom: 0 }}>
                      <div className="rv-field-label">Price</div>
                      <div className="rv-field-value">{price}</div>
                    </div>
                  )}
                  {typeof quantity === 'number' && (
                    <div className="rv-field" style={{ marginBottom: 0 }}>
                      <div className="rv-field-label">Quantity</div>
                      <div className="rv-field-value">{quantity}</div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Bottom section: Longer Text Fields (Description, Bullets, Keywords, Custom Fields) */}
        <div className="rv-listing-bottom">
          {editing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div>
                <label className="rv-field-label" htmlFor="rv-edit-desc">
                  Description
                </label>
                <textarea
                  id="rv-edit-desc"
                  className="rv-textarea"
                  rows={4}
                  aria-invalid={invalidFor('rv-edit-desc') || undefined}
                  aria-describedby={describedByFor('rv-edit-desc')}
                  value={draft.curatedDescription}
                  onChange={e => onDraftChange({ ...draft, curatedDescription: e.target.value })}
                />
              </div>
              <div>
                <label className="rv-field-label" htmlFor="rv-edit-keywords">
                  Search keywords
                </label>
                <input
                  id="rv-edit-keywords"
                  className="rv-input"
                  aria-invalid={invalidFor('rv-edit-keywords') || undefined}
                  aria-describedby={describedByFor('rv-edit-keywords')}
                  value={draft.searchKeywords}
                  onChange={e => onDraftChange({ ...draft, searchKeywords: e.target.value })}
                />
              </div>
              <div className="rv-proposal-actions">
                {showSaveActions && (
                  <>
                    <button type="button" className="rv-btn rv-btn-primary" disabled={saving} onClick={() => void onSaveEdit()}>
                      {saving ? 'Saving…' : 'Save edits'}
                    </button>
                    <button type="button" className="rv-btn rv-btn-secondary" disabled={saving} onClick={onCancelEdit}>
                      Cancel
                    </button>
                  </>
                )}
              </div>
              {saveError && <div className="rv-error-banner">Could not save edits: {saveError}</div>}
            </div>
          ) : (
            <>
              <div className="rv-field" style={{ marginBottom: 0 }}>
                <div className="rv-field-label">Description</div>
                <div className="rv-field-value" style={{ lineHeight: 1.55 }}>{description || '—'}</div>
              </div>

              {bullets.length > 0 && !v2 && (
                <div className="rv-field" style={{ marginBottom: 0 }}>
                  <div className="rv-field-label">Specs / highlights</div>
                  <ul className="rv-list">
                    {bullets.map((b, idx) => (
                      <li key={idx}>{b}</li>
                    ))}
                  </ul>
                </div>
              )}

              {keywords && (
                <div className="rv-field" style={{ marginBottom: 0 }}>
                  <div className="rv-field-label">Search keywords</div>
                  <div className="rv-field-value">{keywords}</div>
                </div>
              )}

              {Object.keys(customFields).length > 0 && !v2 && (
                <div className="rv-field" style={{ marginBottom: 0 }}>
                  <div className="rv-field-label">Custom fields</div>
                  <ul className="rv-list">
                    {Object.entries(customFields).map(([key, value]) => (
                      <li key={key}>
                        <strong>{key}</strong>: {value}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {v2 && hasFactsContent && (
                <details className="rv-listing-facts">
                  <summary>Listing facts</summary>
                  <div className="rv-listing-facts-body">
                    {factRows.length > 0 && (
                      <div className="rv-listing-specs-grid">
                        {factRows.map(row => (
                          <div key={row.key} className="rv-field" style={{ marginBottom: 0 }}>
                            <div className="rv-field-label">{row.label}</div>
                            <div className="rv-field-value">{row.value}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    {bullets.length > 0 && (
                      <div className="rv-field" style={{ marginBottom: 0 }}>
                        <div className="rv-field-label">Specs / highlights</div>
                        <ul className="rv-list">
                          {bullets.map((b, idx) => (
                            <li key={idx}>{b}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {Object.keys(customFields).length > 0 && (
                      <div className="rv-field" style={{ marginBottom: 0 }}>
                        <div className="rv-field-label">Custom fields</div>
                        <ul className="rv-list">
                          {Object.entries(customFields).map(([key, value]) => (
                            <li key={key}>
                              <strong>{key}</strong>: {value}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </details>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
