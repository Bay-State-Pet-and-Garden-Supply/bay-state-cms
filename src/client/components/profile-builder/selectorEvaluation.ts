/**
 * Local CSS selector evaluation for the profile builder.
 *
 * Uses the browser's `DOMParser` to evaluate selectors against
 * previously-fetched page HTML. This provides INSTANT feedback
 * when the operator types or pastes a selector, before any
 * round-trip to the extraction worker.
 *
 * IMPORTANT: Local evaluation is ADVISORY only.
 * Production-quality extraction confidence comes from the
 * `testExtractorProfile` (single URL) and `validateProfileDraft`
 * (multi-sample) APIs which run the selectors through the actual
 * extraction worker (Cheerio or Playwright).
 *
 * No Bun-only imports — safe for Vite/React frontend.
 */

import type { FieldDefinition } from './fieldCatalog';
import type { ProfileDraft } from './profileBuilderTypes';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SelectorEvaluationResult {
  status: 'unassigned' | 'assigned' | 'tested' | 'warning' | 'failed' | 'validated';
  extractedPreview: string | string[] | null;
  matchCount: number;
  warnings: string[];
  error?: string;
}

export interface TitleOptionalPartResult {
  selector: string;
  value: string | null;
  matchCount: number;
  warnings: string[];
}

export interface TitleOptionalEvaluationResult {
  parts: TitleOptionalPartResult[];
  concatenatedPreview: string | null;
  status: 'unassigned' | 'assigned' | 'warning' | 'failed';
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Image attributes to check when evaluating image selectors. */
const IMAGE_ATTRIBUTES = [
  'src',
  'data-src',
  'data-lazy-src',
  'data-original',
  'data-image',
  'data-zoom-image',
  'href',
];

/** Attributes that contain srcset-style candidate URLs. */
const SRCSET_ATTRIBUTES = ['srcset', 'data-srcset'];

/** Substrings that indicate unsupported selector syntax. */
const XPATH_PATTERNS = ['//', 'xpath:', '(/'];

const JS_EXPRESSION_PATTERNS = [
  'document.querySelector',
  '() =>',
  'function(',
  '=>',
];

// ─── Individual selector evaluation ─────────────────────────────────────────

/**
 * Evaluate a single CSS selector against HTML, returning immediate
 * status, extracted preview, match count, and warnings.
 *
 * Returns:
 *   - `unassigned` when selector is empty.
 *   - `failed` when syntax is unsupported or invalid.
 *   - `warning` when cardinality or validation hints are not met.
 *   - `assigned` when a reasonable match is found.
 */
export function evaluateSelectorLocally(
  html: string,
  selector: string,
  field: FieldDefinition,
): SelectorEvaluationResult {
  // Empty selector.
  if (!selector || !selector.trim()) {
    return {
      status: 'unassigned',
      extractedPreview: null,
      matchCount: 0,
      warnings: [],
    };
  }

  const trimmed = selector.trim();

  // Reject XPath.
  if (
    trimmed.startsWith('/') ||
    XPATH_PATTERNS.some((p) => trimmed.toLowerCase().includes(p))
  ) {
    return {
      status: 'failed',
      extractedPreview: null,
      matchCount: 0,
      warnings: [
        'Only CSS selectors are supported. XPath and JavaScript expressions are not supported.',
      ],
      error: 'Unsupported selector syntax',
    };
  }

  // Reject JavaScript expressions.
  if (
    JS_EXPRESSION_PATTERNS.some((p) => trimmed.includes(p))
  ) {
    return {
      status: 'failed',
      extractedPreview: null,
      matchCount: 0,
      warnings: [
        'Only CSS selectors are supported. JavaScript expressions are not supported.',
      ],
      error: 'Unsupported selector syntax',
    };
  }

  // Reject JSON-LD pseudo-selectors.
  if (trimmed.toLowerCase().startsWith('jsonld:')) {
    return {
      status: 'failed',
      extractedPreview: null,
      matchCount: 0,
      warnings: [
        'Only CSS selectors are supported. JSON-LD pseudo-selectors (jsonld:*) cannot be queried as CSS selectors in the DOM.',
      ],
      error: 'Unsupported selector syntax: jsonld:* is not a CSS selector',
    };
  }

  // Parse and evaluate.
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return {
      status: 'failed',
      extractedPreview: null,
      matchCount: 0,
      warnings: ['Failed to parse page HTML.'],
      error: 'HTML parse error',
    };
  }

  let nodes: Element[];
  try {
    nodes = Array.from(doc.querySelectorAll(trimmed));
  } catch (err) {
    return {
      status: 'failed',
      extractedPreview: null,
      matchCount: 0,
      warnings: [
        `Invalid CSS selector: ${err instanceof Error ? err.message : 'unknown error'}`,
      ],
      error: err instanceof Error ? err.message : 'Invalid CSS selector',
    };
  }

  if (nodes.length === 0) {
    return {
      status: 'failed',
      extractedPreview: null,
      matchCount: 0,
      warnings: ['Selector matched no elements on the page.'],
    };
  }

  // Extract previews.
  const previews: string[] = [];

  if (field.valueType === 'image') {
    // Collect image sources from matched elements.
    const seen = new Set<string>();
    for (const node of nodes) {
      // If the node is an <img> or <source> itself, check direct attrs.
      const tag = node.tagName.toLowerCase();
      const isMedia = tag === 'img' || tag === 'source';

      const targets = isMedia ? [node] : Array.from(node.querySelectorAll('img,source'));

      for (const el of targets) {
        // Direct attributes.
        for (const attr of IMAGE_ATTRIBUTES) {
          const val = el.getAttribute(attr);
          if (val && val.trim() && !seen.has(val.trim())) {
            seen.add(val.trim());
            previews.push(val.trim());
          }
        }

        // Srcset-style attributes.
        for (const attr of SRCSET_ATTRIBUTES) {
          const srcset = el.getAttribute(attr);
          if (srcset) {
            for (const candidate of srcset.split(',')) {
              const url = candidate.trim().split(/\s+/)[0];
              if (url && !seen.has(url)) {
                seen.add(url);
                previews.push(url);
              }
            }
          }
        }
      }
    }

    // Deduplicate.
    const unique = [...new Set(previews)];
    return {
      status: unique.length > 0 ? 'assigned' : 'warning',
      extractedPreview: unique.length > 0 ? unique : null,
      matchCount: nodes.length,
      warnings:
        unique.length === 0
          ? ['Selector matched elements but no image sources were found.']
          : [],
    };
  }

  // Text fields.
  for (const node of nodes) {
    const text = node.textContent?.replace(/\s+/g, ' ').trim();
    if (text) {
      previews.push(text);
    }
  }

  const extractedPreview = previews.length <= 3 ? previews : previews.slice(0, 3);
  const warnings: string[] = [];

  // Cardinality warning.
  if (field.cardinality === 'single' && nodes.length > 1) {
    warnings.push(`Expected a single match but found ${nodes.length}.`);
  }

  // Min-length check.
  if (
    field.validationHints?.minLength != null &&
    extractedPreview.length > 0 &&
    extractedPreview[0].length < field.validationHints.minLength
  ) {
    warnings.push(`Extracted value (${extractedPreview[0].length} chars) may be too short.`);
  }

  return {
    status: warnings.length > 0 ? 'warning' : 'assigned',
    extractedPreview: extractedPreview.length === 1 ? extractedPreview[0] : extractedPreview,
    matchCount: nodes.length,
    warnings,
  };
}

// ─── Title optional selectors ────────────────────────────────────────────────

/**
 * Evaluate all titleOptionalSelector entries as an ordered list.
 *
 * Each selector is evaluated independently; the overall status
 * degrades to `failed` if any single row fails, or `warning`
 * if any row warns. The concatenated preview joins non-empty
 * values with ` — `.
 */
export function evaluateTitleOptionalSelectors(
  html: string,
  selectors: string[],
): TitleOptionalEvaluationResult {
  if (!selectors || selectors.length === 0) {
    return {
      parts: [],
      concatenatedPreview: null,
      status: 'unassigned',
    };
  }

  const parts: TitleOptionalPartResult[] = selectors.map((selector) => {
    if (!selector || !selector.trim()) {
      return {
        selector,
        value: null,
        matchCount: 0,
        warnings: [],
      };
    }

    const result = evaluateSelectorLocally(html, selector, {
      key: 'titleOptionalSelectors',
      label: 'Additional title parts',
      outputTarget: 'core',
      valueType: 'text',
      cardinality: 'single',
      category: 'identity',
    });

    return {
      selector,
      value: typeof result.extractedPreview === 'string' ? result.extractedPreview : null,
      matchCount: result.matchCount,
      warnings: result.warnings,
    };
  });

  const values = parts
    .map((p) => p.value)
    .filter((v): v is string => v !== null && v.length > 0);

  const hasFailure = parts.some((p) => p.matchCount === 0);
  const hasWarning = parts.some((p) => p.warnings.length > 0);

  return {
    parts,
    concatenatedPreview: values.length > 0 ? values.join(' — ') : null,
    status: hasFailure ? 'failed' : hasWarning ? 'warning' : values.length > 0 ? 'assigned' : 'unassigned',
  };
}

// ─── Bulk evaluation ─────────────────────────────────────────────────────────

/**
 * Evaluate all core + custom selector fields in a draft against the
 * given HTML. Returns a map of field key → evaluation result.
 *
 * Core fields are evaluated by their direct key (titleSelector, etc.).
 * Custom fields are evaluated by their custom selector key.
 * titleOptionalSelectors is handled separately via
 * `evaluateTitleOptionalSelectors`.
 */
export function evaluateAllSelectorsLocally(
  html: string,
  draft: ProfileDraft,
  fields: FieldDefinition[],
): Record<string, SelectorEvaluationResult> {
  const results: Record<string, SelectorEvaluationResult> = {};

  for (const field of fields) {
    // titleOptionalSelectors is evaluated as a group.
    if (field.key === 'titleOptionalSelectors') continue;

    const selectorValue = getSelectorValue(draft, field.key);
    results[field.key] = evaluateSelectorLocally(html, selectorValue ?? '', field);
  }

  return results;
}

/**
 * Get the current selector string for a given field key from the draft.
 */
function getSelectorValue(
  draft: ProfileDraft,
  key: string,
): string | null | undefined {
  if (/(?:price|cost|sale)/i.test(key)) return null;

  switch (key) {
    case 'titleSelector':
      return draft.titleSelector;
    case 'brandSelector':
      return draft.brandSelector;
    case 'descriptionSelector':
      return draft.descriptionSelector;
    case 'imagesSelector':
      return draft.imagesSelector;
    default:
      return draft.customSelectors[key];
  }
}
