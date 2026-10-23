/**
 * ProfileRevisionFeedbackForm.tsx — structured feedback form for
 * creating a new revision from operator input.
 *
 * Designed for non-technical store managers. The form does not
 * expose CSS or selectors. The operator can:
 *  - confirm the extracted value is correct (text)
 *  - type the correct value when it is not (text)
 *  - mark per-image thumbs as correct / exclude (images)
 *  - signal "ignore price for this domain" (price)
 *
 * The submit button creates a new revision via
 * `createRevisionFromFeedback`. The form never overwrites
 * existing revisions.
 *
 * Phase 4 (UI) consumer.
 */

import React, { useState, useEffect } from 'react';
import type { StructuredFeedback } from '../../shared/schemas/onboarding';
import { ImagePreviewGrid, type ImagePreview } from './ImagePreviewGrid';
import { generateSelectorFromElement, fetchPageHtml } from '../onboarding-api';
import { normalizeFieldLabel } from '../profile-review-utils';

/** Fields whose selectors typically target a price-like value. */
const PRICE_LIKE_FIELDS = new Set(['priceSelector', 'price', 'salePrice', 'cost']);

/** Fields whose selectors typically target image-containing elements. */
const IMAGE_LIKE_FIELDS = new Set(['imagesSelector', 'imageSelector', 'gallerySelector', 'mediaSelector']);

/** Detect if a field key looks like an image-type field. */
function isImageField(field: string): boolean {
  return IMAGE_LIKE_FIELDS.has(field) || field.toLowerCase().includes('image') || field.toLowerCase().includes('gallery') || field.toLowerCase().includes('media');
}

/** Detect if a field key looks like a price-type field. */
function isPriceField(field: string): boolean {
  return PRICE_LIKE_FIELDS.has(field) || field.toLowerCase().includes('price') || field.toLowerCase().includes('cost') || field.toLowerCase().includes('sale');
}

interface ProfileRevisionFeedbackFormProps {
  field: string;
  /** Human-readable label for this field (from normalizeFieldLabel). */
  fieldLabel?: string;
  /** Field category for context. */
  fieldCategory?: string;
  /** Value type hint: 'text', 'image', 'numeric', etc. */
  fieldValueType?: string;
  /** Latest extracted sample value for this field (pre-fills the correction input). */
  sampleValue?: string | null;
  /** Current extracted value, shown for context. */
  currentValue: string | null;
  /** For image fields: the previews to mark correct/exclude. */
  currentImages?: ImagePreview[];
  /** Submit handler. */
  onSubmit: (feedback: StructuredFeedback) => Promise<void> | void;
  /** Optional notes placeholder. */
  defaultNotes?: string;
  /** When true, the form is disabled. */
  busy?: boolean;
  /** The URL of the product page being reviewed (needed for paste-element flow). */
  sourcePageUrl?: string | null;
}

export function ProfileRevisionFeedbackForm(
  props: ProfileRevisionFeedbackFormProps,
): React.ReactElement {
  const { field, fieldLabel, fieldCategory, fieldValueType, sampleValue, currentValue, currentImages, onSubmit, defaultNotes, busy, sourcePageUrl } = props;
  const isImage = isImageField(field) || fieldValueType === 'image';
  const isPrice = isPriceField(field) || fieldValueType === 'price';
  const displayLabel = fieldLabel || normalizeFieldLabel(field);

  const [textCorrect, setTextCorrect] = useState<boolean>(true);
  const [expectedValue, setExpectedValue] = useState<string>('');
  const [notes, setNotes] = useState<string>(defaultNotes ?? '');
  const [perImage, setPerImage] = useState<Record<string, 'correct' | 'exclude' | 'include'>>({});
  const [looksLikeRecs, setLooksLikeRecs] = useState<boolean>(false);
  const [showAdvancedCss, setShowAdvancedCss] = useState<boolean>(false);
  const [manualSelectorHint, setManualSelectorHint] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);

  // ── Paste-element state ─────────────────────────────────────────────────
  const [pastedHtml, setPastedHtml] = useState<string>('');
  const [generatedSelector, setGeneratedSelector] = useState<string | null>(null);
  const [generatedStability, setGeneratedStability] = useState<string | null>(null);
  const [generatedText, setGeneratedText] = useState<string | null>(null);
  const [generatedMatchCount, setGeneratedMatchCount] = useState<number>(0);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState('');

  // ── Pre-fill expected value with sampleValue when field changes ───────────
  useEffect(() => {
    if (sampleValue && !textCorrect && !expectedValue) {
      setExpectedValue(sampleValue);
    }
  }, [field, sampleValue]);

  // ── Paste-element handler ──────────────────────────────────────────────
  const handleGenerateSelector = async () => {
    if (!pastedHtml.trim()) return;
    if (!sourcePageUrl) {
      setGenerateError('No source page URL available — enter it in the review panel first');
      return;
    }
    setGenerating(true);
    setGenerateError('');
    setGeneratedSelector(null);
    try {
      // Fetch page HTML server-side (avoids CORS)
      const htmlRes = await fetchPageHtml(sourcePageUrl);
      if (!htmlRes.ok || !htmlRes.html) {
        setGenerateError(htmlRes.error || 'Failed to fetch page HTML');
        return;
      }
      // Generate selector from pasted element
      const res = await generateSelectorFromElement({
        html: htmlRes.html,
        outerHTML: pastedHtml,
      });
      if (!res.ok || !res.data) {
        setGenerateError(res.error || 'Failed to generate selector');
        return;
      }
      const data = res.data;
      setGeneratedSelector(data.selector);
      setGeneratedStability(data.stability);
      setGeneratedText(data.extractedText);
      setGeneratedMatchCount(data.matchCount);
      // Pre-fill the manual selector hint
      setManualSelectorHint(data.selector);
      if (data.warnings.length > 0) {
        setGenerateError(data.warnings.join('; '));
      }
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const advancedNote = manualSelectorHint.trim()
        ? `Advanced selector hint: ${manualSelectorHint.trim()}`
        : '';
      const combinedNotes = [notes.trim(), advancedNote].filter(Boolean).join('\n\n') || undefined;
      let feedback: StructuredFeedback;
      if (isImage) {
        feedback = {
          kind: 'images',
          perImage,
          looksLikeRecommendations: looksLikeRecs || undefined,
          notes: combinedNotes,
        };
      } else {
        feedback = {
          kind: 'text',
          field,
          currentValueCorrect: textCorrect,
          expectedValue: textCorrect ? undefined : expectedValue || undefined,
          notes: combinedNotes,
        };
      }
      await onSubmit(feedback);
    } finally {
      setSubmitting(false);
    }
  };

  if (isPrice) {
    return (
      <p role="note">
        Prices are set during onboarding. This page does not change them.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {isImage && (
        <>
          <div>
            <p style={{ fontSize: 12, color: '#4b5563', margin: '0 0 8px' }}>
              For each image, mark it as <strong>correct</strong> (use it), <strong>exclude</strong>
              {' '}it, or <strong>include</strong> a new one.
              These choices help the system select the right product photos.
            </p>
            <ImagePreviewGrid
              previews={(currentImages ?? []).map((p) => ({
                ...p,
                verdict: perImage[p.url] ?? 'pending',
              }))}
              readOnly={busy}
              onChangeVerdict={(url, verdict) =>
                setPerImage((prev) => ({ ...prev, [url]: verdict }))
              }
            />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#4b5563' }}>
            <input
              type="checkbox"
              checked={looksLikeRecs}
              onChange={(e) => setLooksLikeRecs(e.target.checked)}
              disabled={busy}
            />
            <span>These look like recommendation / carousel images, not the product</span>
          </label>
        </>
      )}

      {!isImage && !isPrice && (
        <div>
          <p style={{ fontSize: 12, color: '#4b5563', margin: '0 0 8px' }}>
            Current extracted {displayLabel} value:
            <code style={{ marginLeft: 6, padding: '2px 6px', background: '#f3f4f6', borderRadius: 3 }}>
              {currentValue || '(empty)'}
            </code>
          </p>
          {sampleValue && sampleValue !== currentValue && (
            <p style={{ fontSize: 11, color: '#d97706', margin: '0 0 6px' }}>
              Latest sample: <em>{sampleValue.slice(0, 120)}</em>
            </p>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#4b5563', marginBottom: 6 }}>
            <input
              type="checkbox"
              checked={textCorrect}
              onChange={(e) => {
                setTextCorrect(e.target.checked);
                if (e.target.checked) setExpectedValue('');
              }}
              disabled={busy}
            />
            <span>This extracted value is correct</span>
          </label>
          {!textCorrect && (
            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#4b5563', marginBottom: 4 }}>
                The value should be:
              </label>
              <input
                type="text"
                value={expectedValue}
                onChange={(e) => setExpectedValue(e.target.value)}
                disabled={busy}
                placeholder={`e.g. WOOF Pupsicle Lavender Small`}
                style={{
                  width: '100%',
                  padding: '6px 10px',
                  border: '1px solid #d1d5db',
                  borderRadius: 4,
                  fontSize: 13,
                  boxSizing: 'border-box',
                }}
              />
            </div>
          )}
        </div>
      )}


      {/*** Paste-element to selector section ***/}
      {sourcePageUrl && (
        <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 12, marginTop: 4 }}>
          <p style={{ fontSize: 12, fontWeight: 600, color: '#374151', margin: '0 0 8px' }}>
            Paste element HTML to generate a selector
          </p>
          <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 6px' }}>
            Copy an element from your browser's DevTools (right-click → Copy → Copy outerHTML) and paste it below.
            The system generates a stable CSS selector from the real page element.
          </p>
          <textarea
            value={pastedHtml}
            onChange={(e) => setPastedHtml(e.target.value)}
            disabled={busy || generating}
            rows={3}
            placeholder={'<h1 class="product-title">Product Name</h1>'}
            style={{
              width: '100%',
              padding: '6px 10px',
              border: '1px solid #d1d5db',
              borderRadius: 4,
              fontSize: 12,
              fontFamily: 'monospace',
              boxSizing: 'border-box',
              resize: 'vertical',
              marginBottom: 6,
            }}
          />
          <button
            type="button"
            onClick={handleGenerateSelector}
            disabled={busy || generating || !pastedHtml.trim()}
            style={{
              background: busy || generating ? '#9ca3af' : '#7c3aed',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              padding: '4px 12px',
              fontSize: 12,
              fontWeight: 600,
              cursor: busy || generating ? 'not-allowed' : 'pointer',
            }}
          >
            {generating ? 'Generating…' : 'Generate Selector'}
          </button>
          {generateError && (
            <p style={{ fontSize: 11, color: '#dc2626', margin: '4px 0 0' }}>{generateError}</p>
          )}
          {generatedSelector && (
            <div style={{ marginTop: 8, padding: 8, background: '#faf5ff', borderRadius: 4, border: '1px solid #e9d5ff' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <code style={{ fontSize: 12, background: '#fff', padding: '2px 6px', borderRadius: 3, border: '1px solid #e5e7eb' }}>
                  {generatedSelector}
                </code>
                <span style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '1px 6px',
                  borderRadius: 999,
                  textTransform: 'uppercase',
                  background: generatedStability === 'high' ? '#dcfce7' : generatedStability === 'medium' ? '#fef3c7' : '#fee2e2',
                  color: generatedStability === 'high' ? '#16a34a' : generatedStability === 'medium' ? '#d97706' : '#dc2626',
                }}>
                  {generatedStability}
                </span>
                <span style={{ fontSize: 10, color: '#6b7280' }}>
                  {generatedMatchCount} match{generatedMatchCount !== 1 ? 'es' : ''}
                </span>
              </div>
              {generatedText && (
                <p style={{ fontSize: 11, color: '#4b5563', margin: '2px 0 0' }}>
                  Preview: <em>{generatedText.slice(0, 100)}</em>
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#4b5563', marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={showAdvancedCss}
            onChange={(e) => setShowAdvancedCss(e.target.checked)}
            disabled={busy}
          />
          <span>Advanced: I know the CSS selector the AI should consider</span>
        </label>
        {showAdvancedCss && (
          <input
            type="text"
            value={manualSelectorHint}
            onChange={(e) => setManualSelectorHint(e.target.value)}
            disabled={busy}
            placeholder="e.g. .product-media-gallery img"
            style={{
              width: '100%',
              padding: '6px 10px',
              border: '1px solid #d1d5db',
              borderRadius: 4,
              fontSize: 13,
              boxSizing: 'border-box',
              marginBottom: 10,
            }}
          />
        )}
        <label style={{ display: 'block', fontSize: 12, color: '#4b5563', marginBottom: 4 }}>
          Notes (optional)
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={busy}
          rows={2}
          style={{
            width: '100%',
            padding: '6px 10px',
            border: '1px solid #d1d5db',
            borderRadius: 4,
            fontSize: 13,
            boxSizing: 'border-box',
            resize: 'vertical',
          }}
          placeholder="Any extra context for the AI..."
        />
      </div>

      <div>
        <button
          type="submit"
          disabled={busy || submitting}
          style={{
            background: busy || submitting ? '#9ca3af' : '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '8px 16px',
            fontSize: 13,
            fontWeight: 600,
            cursor: busy || submitting ? 'not-allowed' : 'pointer',
          }}
        >
          {submitting ? 'Submitting...' : 'Submit feedback (creates a new revision)'}
        </button>
      </div>
    </form>
  );
}

// Re-export for convenience so callers do not need to import the
// SelectorField list separately.
