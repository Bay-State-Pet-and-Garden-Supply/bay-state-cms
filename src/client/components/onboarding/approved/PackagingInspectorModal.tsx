/**
 * PackagingInspectorModal.tsx
 *
 * High-Resolution Packaging Inspection & Name Verification Modal.
 *
 * Designed for Bay State CMS operators to inspect product packaging photography
 * at up to 500% zoom and 1:1 native pixel resolution, cross-referencing printed
 * brand names, formulas, flavors, and Net Wt statements directly against
 * the curated customer-facing title and distributor intake code.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import type { PackagingOcrData } from '../../../../shared/schemas/onboarding';
import { getItemDetail } from '../../../onboarding-api';

export interface PackagingInspectorModalProps {
  item: OnboardingWorkState;
  allItems?: OnboardingWorkState[];
  onClose: () => void;
  onNavigate?: (item: OnboardingWorkState) => void;
  onToggleSelection?: (itemId: string) => void;
  isSelected?: boolean;
}

export function PackagingInspectorModal({
  item,
  allItems = [],
  onClose,
  onNavigate,
  onToggleSelection,
  isSelected = false,
}: PackagingInspectorModalProps) {
  // Zoom & Pan State
  const [zoom, setZoom] = useState<number>(1.0);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [imageLoaded, setImageLoaded] = useState<boolean>(false);
  const [imageError, setImageError] = useState<boolean>(false);
  const [naturalDimensions, setNaturalDimensions] = useState<{ width: number; height: number } | null>(null);

  // Verification Checklist State
  const [checklist, setChecklist] = useState<Record<string, boolean>>({
    brand: false,
    formula: false,
    weight: false,
    quality: false,
  });

  // OCR Fact Extraction State
  const [ocrData, setOcrData] = useState<PackagingOcrData | null>(null);
  const [ocrLoading, setOcrLoading] = useState<boolean>(false);
  const [ocrTab, setOcrTab] = useState<'verification' | 'ocr'>('verification');
  const [showHint, setShowHint] = useState<boolean>(true);

  // DOM Refs
  const viewportRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const clampPan = useCallback((x: number, y: number, currentZoom: number) => {
    if (currentZoom <= 1.05) return { x: 0, y: 0 };
    const rect = viewportRef.current?.getBoundingClientRect();
    const maxPanX = rect ? (rect.width * (currentZoom - 0.5)) / 2 : 1200;
    const maxPanY = rect ? (rect.height * (currentZoom - 0.5)) / 2 : 1200;
    return {
      x: Math.max(-maxPanX, Math.min(maxPanX, x)),
      y: Math.max(-maxPanY, Math.min(maxPanY, y)),
    };
  }, []);

  // Reset zoom & checklist whenever the inspected item changes
  useEffect(() => {
    setZoom(1.0);
    setPan({ x: 0, y: 0 });
    setImageLoaded(false);
    setImageError(false);
    setNaturalDimensions(null);
    setChecklist({
      brand: false,
      formula: false,
      weight: false,
      quality: false,
    });
  }, [item.itemId]);

  // Lazily load OCR facts if available
  useEffect(() => {
    let active = true;
    setOcrData(null);
    setOcrLoading(true);

    try {
      getItemDetail(item.itemId)
        .then((res) => {
          if (!active) return;
          const extraction = res.item?.extractionData as any;
          if (extraction?.packagingOcrData) {
            setOcrData(extraction.packagingOcrData);
          }
        })
        .catch(() => {
          // Gracefully fall back if item detail cannot be retrieved
        })
        .finally(() => {
          if (active) setOcrLoading(false);
        });
    } catch {
      setOcrLoading(false);
    }

    return () => {
      active = false;
    };
  }, [item.itemId]);

  // Index in batch
  const currentIndex = useMemo(() => {
    return allItems.findIndex((it) => it.itemId === item.itemId);
  }, [allItems, item.itemId]);

  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < allItems.length - 1;

  const handlePrev = useCallback(() => {
    if (hasPrev && onNavigate) {
      onNavigate(allItems[currentIndex - 1]);
    }
  }, [hasPrev, currentIndex, allItems, onNavigate]);

  const handleNext = useCallback(() => {
    if (hasNext && onNavigate) {
      onNavigate(allItems[currentIndex + 1]);
    }
  }, [hasNext, currentIndex, allItems, onNavigate]);

  // Zoom controls
  const handleZoomIn = useCallback(() => {
    setZoom((prev) => Math.min(Number((prev + 0.5).toFixed(1)), 5.0));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((prev) => {
      const next = Math.max(Number((prev - 0.5).toFixed(1)), 1.0);
      if (next === 1.0) setPan({ x: 0, y: 0 });
      return next;
    });
  }, []);

  const handleResetZoom = useCallback(() => {
    setZoom(1.0);
    setPan({ x: 0, y: 0 });
  }, []);

  const handleActualSize = useCallback(() => {
    if (!naturalDimensions || !imgRef.current) {
      setZoom((z) => (z === 2.5 ? 1.0 : 2.5));
      return;
    }
    const renderedWidth = imgRef.current.clientWidth || 400;
    const ratio = naturalDimensions.width / renderedWidth;
    const targetZoom = Math.min(Math.max(Number(ratio.toFixed(1)), 1.0), 5.0);

    setZoom((prev) => (Math.abs(prev - targetZoom) < 0.2 ? 1.0 : targetZoom));
    setPan({ x: 0, y: 0 });
  }, [naturalDimensions]);

  // Wheel zoom centered on pointer
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.25 : -0.25;
    const rect = viewportRef.current?.getBoundingClientRect();

    setZoom((prevZoom) => {
      const nextZoom = Math.min(Math.max(Number((prevZoom + delta).toFixed(2)), 1.0), 5.0);
      if (nextZoom <= 1.05) {
        setPan({ x: 0, y: 0 });
        return 1.0;
      }

      if (rect) {
        const mouseX = e.clientX - rect.left - rect.width / 2;
        const mouseY = e.clientY - rect.top - rect.height / 2;
        const factor = nextZoom / prevZoom;
        setPan((prevPan) => {
          const nextX = Number((mouseX - (mouseX - prevPan.x) * factor).toFixed(1));
          const nextY = Number((mouseY - (mouseY - prevPan.y) * factor).toFixed(1));
          return clampPan(nextX, nextY, nextZoom);
        });
      }
      return nextZoom;
    });
  };

  // Drag to pan
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || zoom <= 1.0) return;
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    const rawX = e.clientX - dragStartRef.current.x;
    const rawY = e.clientY - dragStartRef.current.y;
    setPan(clampPan(rawX, rawY, zoom));
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Double click toggles between 1.0x and 2.5x
  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (zoom > 1.2) {
      handleResetZoom();
    } else {
      const rect = viewportRef.current?.getBoundingClientRect();
      if (rect) {
        const clickX = e.clientX - rect.left - rect.width / 2;
        const clickY = e.clientY - rect.top - rect.height / 2;
        setZoom(2.5);
        setPan({ x: -clickX * 1.2, y: -clickY * 1.2 });
      } else {
        setZoom(2.5);
      }
    }
  };

  // Image load handler
  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    setImageLoaded(true);
    setImageError(false);
    const img = e.currentTarget;
    setNaturalDimensions({
      width: img.naturalWidth,
      height: img.naturalHeight,
    });
  };

  // Keyboard navigation
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === '+' || e.key === '=') {
        handleZoomIn();
      } else if (e.key === '-' || e.key === '_') {
        handleZoomOut();
      } else if (e.key === '0') {
        handleResetZoom();
      } else if (e.key === '1') {
        handleActualSize();
      } else if (e.key === 'ArrowLeft') {
        handlePrev();
      } else if (e.key === 'ArrowRight') {
        handleNext();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, handleZoomIn, handleZoomOut, handleResetZoom, handleActualSize, handlePrev, handleNext]);

  const displayTitle = item.curatedTitle?.trim() || item.name;
  const hasRenamed =
    Boolean(item.curatedTitle) &&
    item.curatedTitle!.trim().toLowerCase() !== item.name.trim().toLowerCase();

  const toggleCheck = (key: string) => {
    setChecklist((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const allVerified = Object.values(checklist).every(Boolean);

  return (
    <div
      className="ow-pi-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Inspect Packaging: ${displayTitle}`}
      onClick={onClose}
      data-testid="packaging-inspector-modal"
    >
      <div className="ow-pi-modal" onClick={(e) => e.stopPropagation()}>
        {/* ── Top Bar ────────────────────────────────────────── */}
        <header className="ow-pi-header">
          <div className="ow-pi-header-left">
            <span className="ow-pi-badge">Packaging Verification Studio</span>
            {allItems.length > 0 && (
              <span className="ow-pi-counter">
                Product {currentIndex + 1} of {allItems.length}
              </span>
            )}
            {item.brand && <span className="ow-brand-pill">{item.brand}</span>}
          </div>

          <div className="ow-pi-header-right">
            {allItems.length > 1 && (
              <div className="ow-pi-nav-group" role="group" aria-label="Cycle products">
                <button
                  type="button"
                  className="btn btn-outline btn-sm ow-pi-nav-btn"
                  onClick={handlePrev}
                  disabled={!hasPrev}
                  title="Inspect previous product (Left Arrow)"
                  aria-label="Previous product"
                >
                  ← Prev
                </button>
                <button
                  type="button"
                  className="btn btn-outline btn-sm ow-pi-nav-btn"
                  onClick={handleNext}
                  disabled={!hasNext}
                  title="Inspect next product (Right Arrow)"
                  aria-label="Next product"
                >
                  Next →
                </button>
              </div>
            )}
            <button
              type="button"
              className="ow-pi-close-btn"
              onClick={onClose}
              aria-label="Close packaging inspection"
            >
              ✕
            </button>
          </div>
        </header>

        {/* ── Main Body: Split View (Viewport + Verification Dock) ── */}
        <div className="ow-pi-body">
          {/* Left / Center: Interactive Packaging Viewport */}
          <div className="ow-pi-viewport-container">
            <div
              ref={viewportRef}
              className={`ow-pi-viewport ${isDragging ? 'ow-pi-viewport--dragging' : ''}`}
              onWheel={handleWheel}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              onDoubleClick={handleDoubleClick}
              style={{
                cursor: zoom > 1.0 ? (isDragging ? 'grabbing' : 'grab') : 'zoom-in',
              }}
            >
              {item.imageUrl && !imageError ? (
                <div
                  className="ow-pi-canvas"
                  style={{
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                    transformOrigin: 'center center',
                    transition: isDragging ? 'none' : 'transform 0.12s cubic-bezier(0.2, 0, 0, 1)',
                  }}
                >
                  <img
                    ref={imgRef}
                    src={item.imageUrl}
                    alt={displayTitle}
                    className="ow-pi-img"
                    style={{
                      opacity: imageLoaded ? 1 : 0,
                      transition: 'opacity 0.2s ease',
                    }}
                    draggable={false}
                    onLoad={handleImageLoad}
                    onError={() => setImageError(true)}
                  />
                </div>
              ) : (
                <div className="ow-pi-no-img">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                    <line x1="12" y1="22.08" x2="12" y2="12" />
                  </svg>
                  <strong>No high-resolution packaging photo recorded</strong>
                  <span>Verify product attributes using the specification panel on the right.</span>
                </div>
              )}

              {/* Floating Zoom HUD */}
              {item.imageUrl && !imageError && (
                <div className="ow-pi-hud" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="ow-pi-hud-btn"
                    onClick={handleZoomOut}
                    disabled={zoom <= 1.0}
                    title="Zoom Out ( - )"
                    aria-label="Zoom Out"
                  >
                    −
                  </button>
                  <span className="ow-pi-hud-level" title="Current Zoom Level">
                    {Math.round(zoom * 100)}%
                  </span>
                  <button
                    type="button"
                    className="ow-pi-hud-btn"
                    onClick={handleZoomIn}
                    disabled={zoom >= 5.0}
                    title="Zoom In ( + )"
                    aria-label="Zoom In"
                  >
                    +
                  </button>

                  <div className="ow-pi-hud-divider" />

                  <button
                    type="button"
                    className="ow-pi-hud-btn ow-pi-hud-btn--text"
                    onClick={handleActualSize}
                    title="Toggle 1:1 Native Image Pixel Resolution (Key: 1)"
                  >
                    1:1 Actual
                  </button>

                  <button
                    type="button"
                    className="ow-pi-hud-btn ow-pi-hud-btn--text"
                    onClick={handleResetZoom}
                    disabled={zoom === 1.0 && pan.x === 0 && pan.y === 0}
                    title="Fit to Screen (Key: 0)"
                  >
                    Fit
                  </button>
                </div>
              )}
            </div>

            {/* Interaction Shortcuts Banner — outside the viewport to prevent layout shifting */}
            {showHint && (
              <div className="ow-pi-hint-banner">
                <span>
                  <strong>Shortcuts:</strong> Scroll to zoom • Drag to pan • Keys: [ + ] [ − ] [ 0 ] [ 1 ] [ ← ] [ → ]
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {naturalDimensions && (
                    <span className="ow-pi-dim-tag">
                      Native: {naturalDimensions.width} × {naturalDimensions.height} px
                    </span>
                  )}
                  <button
                    type="button"
                    className="ow-pi-hint-dismiss"
                    onClick={() => setShowHint(false)}
                    title="Dismiss shortcuts"
                    aria-label="Dismiss shortcuts"
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Right: Packaging Verification Dock */}
          <aside className="ow-pi-dock">
            <div className="ow-pi-dock-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={ocrTab === 'verification'}
                className={`ow-pi-dock-tab ${ocrTab === 'verification' ? 'ow-pi-dock-tab--active' : ''}`}
                onClick={() => setOcrTab('verification')}
              >
                Verification Cross-Check
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={ocrTab === 'ocr'}
                className={`ow-pi-dock-tab ${ocrTab === 'ocr' ? 'ow-pi-dock-tab--active' : ''}`}
                onClick={() => setOcrTab('ocr')}
              >
                Detected Package Text {ocrData ? '✓' : ''}
              </button>
            </div>

            <div className="ow-pi-dock-content">
              {ocrTab === 'verification' ? (
                <>
                  {/* Customer-Facing Product Title */}
                  <div className="ow-pi-card">
                    <div className="ow-pi-card-header">
                      <span className="ow-pi-card-label">Customer-Facing Title</span>
                      <span className="ow-chip ow-chip--success" style={{ fontSize: '0.6875rem' }}>
                        Approved for ShopSite
                      </span>
                    </div>
                    <h4 className="ow-pi-product-title">{displayTitle}</h4>

                    {/* Distributor Intake Code Comparison */}
                    {hasRenamed ? (
                      <div className="ow-pi-intake-box">
                        <div className="ow-pi-intake-label">Initial Distributor Upload Value:</div>
                        <code className="ow-sku-code ow-pi-intake-code">{item.name}</code>
                        <div className="ow-pi-intake-note">
                          Curated into full brand + formula + packaging size above.
                        </div>
                      </div>
                    ) : (
                      <div className="ow-pi-intake-box">
                        <div className="ow-pi-intake-label">Distributor Intake:</div>
                        <code className="ow-sku-code">{item.name}</code>
                      </div>
                    )}
                  </div>

                  {/* Physical Packaging Spec Sheet */}
                  <div className="ow-pi-card">
                    <span className="ow-pi-card-label">Packaging Attributes to Cross-Check</span>
                    <div className="ow-pi-specs-grid">
                      <div className="ow-pi-spec-item">
                        <span className="ow-pi-spec-label">Brand Name</span>
                        <strong className="ow-pi-spec-value">{item.brand || 'None assigned'}</strong>
                      </div>
                      <div className="ow-pi-spec-item">
                        <span className="ow-pi-spec-label">Net Wt / Size</span>
                        <strong className="ow-pi-spec-value ow-pi-spec-highlight">
                          {item.weight || 'None specified'}
                        </strong>
                      </div>
                      <div className="ow-pi-spec-item">
                        <span className="ow-pi-spec-label">UPC / Barcode</span>
                        <code className="ow-sku-code">{item.upc || 'No UPC'}</code>
                      </div>
                      <div className="ow-pi-spec-item">
                        <span className="ow-pi-spec-label">Packaging Type</span>
                        <span className="ow-pi-spec-value">
                          {ocrData?.packagingType || 'Retail packaging'}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Interactive Verification Checklist */}
                  <div className="ow-pi-card">
                    <div className="ow-pi-card-header">
                      <span className="ow-pi-card-label">Operator Verification Checklist</span>
                      {allVerified && (
                        <span className="ow-chip ow-chip--success" style={{ fontSize: '0.6875rem' }}>
                          All 4 Verified
                        </span>
                      )}
                    </div>
                    <div className="ow-pi-checklist">
                      <label className="ow-pi-check-item">
                        <input
                          type="checkbox"
                          checked={checklist.brand}
                          onChange={() => toggleCheck('brand')}
                        />
                        <span>
                          <strong>Brand typography</strong> matches packaging art (
                          <em>{item.brand || 'Brand'}</em>)
                        </span>
                      </label>

                      <label className="ow-pi-check-item">
                        <input
                          type="checkbox"
                          checked={checklist.formula}
                          onChange={() => toggleCheck('formula')}
                        />
                        <span>
                          <strong>Formula & flavor</strong> matches printed description
                        </span>
                      </label>

                      <label className="ow-pi-check-item">
                        <input
                          type="checkbox"
                          checked={checklist.weight}
                          onChange={() => toggleCheck('weight')}
                        />
                        <span>
                          <strong>Net weight / package size</strong> matches printed text (
                          <em>{item.weight || 'Net Wt'}</em>)
                        </span>
                      </label>

                      <label className="ow-pi-check-item">
                        <input
                          type="checkbox"
                          checked={checklist.quality}
                          onChange={() => toggleCheck('quality')}
                        />
                        <span>
                          <strong>Photo quality</strong> is sharp, accurate & catalog ready
                        </span>
                      </label>
                    </div>
                  </div>
                </>
              ) : (
                /* ── OCR Fact Sheet ────────────────────────── */
                <div className="ow-pi-card">
                  <div className="ow-pi-card-header">
                    <span className="ow-pi-card-label">Machine-Extracted Packaging Text</span>
                    {ocrLoading && <span className="ow-pi-dim-tag">Reading package…</span>}
                  </div>

                  {ocrData ? (
                    <div className="ow-pi-ocr-details">
                      {ocrData.productName && (
                        <div className="ow-pi-ocr-row">
                          <span className="ow-pi-spec-label">Detected Title:</span>
                          <strong>{ocrData.productName}</strong>
                        </div>
                      )}
                      {ocrData.flavorVariety && (
                        <div className="ow-pi-ocr-row">
                          <span className="ow-pi-spec-label">Detected Flavor / Variety:</span>
                          <span className="ow-pi-spec-highlight">{ocrData.flavorVariety}</span>
                        </div>
                      )}
                      {ocrData.weight && (
                        <div className="ow-pi-ocr-row">
                          <span className="ow-pi-spec-label">Detected Weight:</span>
                          <strong>{ocrData.weight}</strong>
                        </div>
                      )}
                      {ocrData.lifeStage && (
                        <div className="ow-pi-ocr-row">
                          <span className="ow-pi-spec-label">Life Stage:</span>
                          <span>{ocrData.lifeStage}</span>
                        </div>
                      )}

                      {/* Visible text lines detected on bag/box */}
                      {ocrData.visibleTextLines && ocrData.visibleTextLines.length > 0 && (
                        <div style={{ marginTop: 12 }}>
                          <span className="ow-pi-spec-label">Visible Text Lines on Package:</span>
                          <div className="ow-pi-ocr-lines">
                            {ocrData.visibleTextLines.map((line, idx) => (
                              <div key={idx} className="ow-pi-ocr-line">
                                {line}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : ocrLoading ? (
                    <div className="ow-detail" style={{ padding: '16px 0', textAlign: 'center' }}>
                      Inspecting package text facts…
                    </div>
                  ) : (
                    <div className="ow-detail" style={{ padding: '12px 0' }}>
                      No automated OCR facts were extracted for this distributor record. Use the zoom
                      controls on the left to visually verify the printed packaging copy.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── Dock Footer Actions ───────────────────────── */}
            <div className="ow-pi-dock-footer">
              {onToggleSelection && item.category === 'approved' && (
                <button
                  type="button"
                  className={`btn ${isSelected ? 'btn-secondary' : 'btn-primary'} btn-sm ow-pi-action-btn`}
                  onClick={() => onToggleSelection(item.itemId)}
                >
                  {isSelected ? '✓ Selected for Draft Creation' : 'Select for Draft Creation'}
                </button>
              )}

              {hasNext && (
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={handleNext}
                  title="Verify next product in batch (Right Arrow)"
                >
                  Next Product →
                </button>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
