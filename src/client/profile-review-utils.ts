/**
 * Profile review UI utilities.
 *
 * Converts revision selectors, active profile, and validation results into
 * normalized rows for the dynamic review UI. Pure functions — no React deps.
 */

import {
  getFieldByKey,
  type ProfileFieldValueType,
} from '../shared/profile-fields';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single normalized row for the review field list. */
export interface ReviewFieldRow {
  key: string;
  label: string;
  category: string;
  valueType: ProfileFieldValueType;
  proposedSelector: string | null;
  activeSelector: string | null;
  changed: boolean;
  isCustom: boolean;
  sampleValue: string | null;
  sampleImages: string[];
  tally: { passing: number; failing: number; warning: number } | null;
  validationSamples: Array<{
    status: string;
    extractedValue: string | null;
    warnings: string[];
  }>;
  isImageField: boolean;
}

/** A non-selector config row (variant strategy, sitemap pattern, etc.). */
export interface ConfigReviewRow {
  key: string;
  label: string;
  value: unknown;
  displayValue: string;
  activeValue: unknown;
  changed: boolean;
  promotable: boolean;
}

/** Input for buildReviewFields(). */
export interface BuildReviewFieldsInput {
  revisionSelectors: Record<string, unknown>;
  activeProfileSelectors: Record<string, string | null>;
  fieldSamples: Record<string, unknown> | null;
  validationResults?: Array<{
    selectorField: string;
    status: string;
    extractedValue: string | null;
    extractedImages?: string[];
    warnings?: string[];
    sampleUrl?: string;
  }>;
  byFieldTally?: Record<
    string,
    { passing: number; failing: number; warning: number } | undefined
  >;
  activeCustomSelectors?: Record<string, string>;
  proposedCustomSelectors?: Record<string, string>;
}

/** A single entry in a revision diff. */
export interface RevisionDiffEntry {
  key: string;
  label: string;
  changeType: 'added' | 'removed' | 'changed' | 'unchanged';
  oldSelector: string | null;
  newSelector: string | null;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Category ordering for the review UI. */
const CATEGORY_ORDER: string[] = [
  'identity',
  'pricing',
  'media',
  'description',
  'nutrition',
  'details',
  'variants',
  'social',
];

const CATEGORY_LABELS: Record<string, string> = {
  identity: 'Identity',
  pricing: 'Pricing',
  media: 'Media',
  description: 'Description',
  nutrition: 'Nutrition',
  details: 'Details',
  variants: 'Variants',
  social: 'Social',
  uncategorized: 'Other Fields',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Return true if the key looks like a CSS selector field (ends in "Selector"). */
// fallow-ignore-next-line unused-export — used by tests
export function isSelectorKey(key: string): boolean {
  return /Selector$/i.test(key);
}

/**
 * Normalize a selector key into a human-readable label.
 * 1. Checks the field catalog first.
 * 2. Strips trailing "Selector" and converts camelCase/PascalCase to Title Case.
 */
export function normalizeFieldLabel(key: string): string {
  const catalog = getFieldByKey(key);
  if (catalog) return catalog.label;

  // Strip trailing "Selector" or "selectors"
  const name = key
    .replace(/Selectors?$/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/^[a-z]/, (c) => c.toUpperCase())
    .trim();

  return name || key;
}

/**
 * Get the category for a field key.
 * Uses the catalog if available; otherwise 'uncategorized'.
 */
// fallow-ignore-next-line unused-export — used by tests
export function getFieldCategory(key: string): string {
  const catalog = getFieldByKey(key);
  if (catalog) return catalog.category;
  return 'uncategorized';
}

/**
 * Get a human-readable category label.
 */
export function getCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

/**
 * Get the sort order for a category.
 */
export function getCategoryOrder(category: string): number {
  const idx = CATEGORY_ORDER.indexOf(category);
  return idx >= 0 ? idx : CATEGORY_ORDER.length;
}

/**
 * Get the value type for a key.
 */
// fallow-ignore-next-line unused-export — used by tests
export function getValueTypeForKey(key: string): ProfileFieldValueType {
  return getFieldByKey(key)?.valueType ?? 'text';
}

/**
 * Return true if the key is an image field.
 */
// fallow-ignore-next-line unused-export — used by tests
export function isImageField(key: string): boolean {
  return getFieldByKey(key)?.valueType === 'image';
}

// ─── Build review fields ────────────────────────────────────────────────────

/**
 * Build a flat list of ReviewFieldRow from all available data sources.
 *
 * Field keys are gathered from:
 *   1. revision selectors (proposed)
 *   2. active profile selectors (current)
 *   3. custom selectors (both sides)
 *   4. validation results
 *
 * Each row is enriched with the best available sample value, validation
 * tally, and change status.
 */
export function buildReviewFields(input: BuildReviewFieldsInput): ReviewFieldRow[] {
  const {
    revisionSelectors,
    activeProfileSelectors,
    fieldSamples,
    validationResults = [],
    byFieldTally = {},
    activeCustomSelectors = {},
    proposedCustomSelectors = {},
  } = input;

  // Gather all unique selector keys
  const allKeys = new Set<string>();

  // Revision selectors (only keys ending in Selector or titleOptionalSelectors)
  for (const key of Object.keys(revisionSelectors)) {
    if (isSelectorKey(key) || key === 'titleOptionalSelectors') {
      allKeys.add(key);
    }
  }

  // Active profile selectors
  for (const key of Object.keys(activeProfileSelectors)) {
    if (activeProfileSelectors[key] != null) {
      allKeys.add(key);
    }
  }

  // Custom selectors
  for (const key of Object.keys(activeCustomSelectors)) {
    allKeys.add(key);
  }
  for (const key of Object.keys(proposedCustomSelectors)) {
    allKeys.add(key);
  }

  // Validation results
  for (const vr of validationResults) {
    if (vr.selectorField) allKeys.add(vr.selectorField);
  }

  // Build rows
  const rows: ReviewFieldRow[] = [];

  for (const key of allKeys) {
    if (/(?:price|cost|sale)/i.test(key)) continue;
    // Determine the proposed selector
    let proposedSelector: string | null = null;
    if (revisionSelectors[key] && typeof revisionSelectors[key] === 'string') {
      proposedSelector = revisionSelectors[key] as string;
    } else if (proposedCustomSelectors[key]) {
      proposedSelector = proposedCustomSelectors[key];
    }

    // Determine the active selector
    let activeSelector: string | null = null;
    if (activeProfileSelectors[key] != null) {
      activeSelector = activeProfileSelectors[key];
    } else if (activeCustomSelectors[key]) {
      activeSelector = activeCustomSelectors[key];
    }

    // Determine if custom (not in the standard catalog)
    const isCustom = !getFieldByKey(key);

    // Get validation samples for this field
    const fieldValidationSamples = validationResults
      .filter((vr) => vr.selectorField === key)
      .map((vr) => ({
        status: vr.status,
        extractedValue: vr.extractedValue,
        warnings: vr.warnings ?? [],
      }));

    // Get tally
    const tally = byFieldTally[key] ?? null;

    // Get sample value from fieldSamples or validation results
    let sampleValue: string | null = null;
    let sampleImages: string[] = [];

    // Try validation results first
    const firstPass = fieldValidationSamples.find((s) => s.status === 'pass');
    if (firstPass?.extractedValue) {
      sampleValue = firstPass.extractedValue;
    }

    // Try fieldSamples
    if (!sampleValue && fieldSamples) {
      const raw = fieldSamples[key] ?? fieldSamples[normalizeFieldLabel(key)];
      if (typeof raw === 'string') {
        sampleValue = raw;
      }
    }

    // Try seedPreview fallback
    if (!sampleValue && fieldSamples) {
      const seed = fieldSamples.seedPreview as Record<string, unknown> | undefined;
      if (seed) {
        const seedMap: Record<string, string> = {
          titleSelector: 'title',
          descriptionSelector: 'description',
          brandSelector: 'brand',
        };
        const seedKey = seedMap[key];
        if (seedKey && typeof seed[seedKey] === 'string') {
          sampleValue = seed[seedKey] as string;
        }
        // Images
        if (key === 'imagesSelector' && Array.isArray(seed.images)) {
          sampleImages = seed.images as string[];
        }
      }
    }

    // Collect images from validation results
    const validationImages = validationResults
      .filter((vr) => vr.selectorField === key && vr.extractedImages?.length)
      .flatMap((vr) => vr.extractedImages ?? []);
    if (validationImages.length > 0) {
      sampleImages = validationImages;
    }

    const label = normalizeFieldLabel(key);
    const category = getFieldCategory(key);

    rows.push({
      key,
      label,
      category,
      valueType: getValueTypeForKey(key),
      proposedSelector,
      activeSelector,
      changed: proposedSelector !== activeSelector,
      isCustom,
      sampleValue,
      sampleImages,
      tally,
      validationSamples: fieldValidationSamples,
      isImageField: isImageField(key),
    });
  }

  // Sort by category order, then by catalog index, then alphabetically
  rows.sort((a, b) => {
    const catOrderA = getCategoryOrder(a.category);
    const catOrderB = getCategoryOrder(b.category);
    if (catOrderA !== catOrderB) return catOrderA - catOrderB;
    return a.label.localeCompare(b.label);
  });

  return rows;
}

// ─── Build config rows ──────────────────────────────────────────────────────

const CONFIG_ITEMS: Array<{
  key: string;
  label: string;
  promotable: boolean;
  displayFormatter: (value: unknown) => string;
}> = [
  {
    key: 'variantSelectionStrategy',
    label: 'Variant Strategy',
    promotable: false,
    displayFormatter: (value: unknown): string => {
      if (!value || typeof value !== 'object') return 'None';
      const v = value as Record<string, unknown>;
      const parts: string[] = [];
      if (v.containerSelector) parts.push(`container: ${v.containerSelector}`);
      if (v.optionType) parts.push(`type: ${v.optionType}`);
      if (Array.isArray(v.detectedOptions) && v.detectedOptions.length > 0) {
        parts.push(`options: ${v.detectedOptions.slice(0, 5).join(', ')}${v.detectedOptions.length > 5 ? '…' : ''}`);
      }
      if (Array.isArray(v.optionFields) && v.optionFields.length > 0) {
        parts.push(`fields: ${v.optionFields.join(', ')}`);
      }
      return parts.length > 0 ? parts.join(' · ') : 'Present';
    },
  },
  {
    key: 'sitemapProductUrlPattern',
    label: 'Sitemap URL Pattern',
    promotable: true,
    displayFormatter: (value: unknown): string =>
      typeof value === 'string' && value.trim() ? value.trim() : 'None',
  },
  {
    key: 'shopifyJSONPath',
    label: 'Shopify JSON',
    promotable: true,
    displayFormatter: (value: unknown): string =>
      value === true ? 'Enabled' : 'Disabled',
  },
  {
    key: 'runtime',
    label: 'Runtime',
    promotable: true,
    displayFormatter: (value: unknown): string =>
      typeof value === 'string' ? value : 'rendered',
  },
];

/**
 * Build non-selector config rows for the review UI.
 */
export function buildConfigRows(
  revisionSelectors: Record<string, unknown>,
  activeProfile?: Record<string, unknown> | null,
): ConfigReviewRow[] {
  const rows: ConfigReviewRow[] = [];

  for (const item of CONFIG_ITEMS) {
    const rawValue = revisionSelectors[item.key];
    // Skip if the revision does not include this key at all
    if (rawValue === undefined) continue;

    const activeValue = activeProfile?.[item.key] ?? null;
    const displayValue = item.displayFormatter(rawValue);
    const activeDisplay = activeValue !== null ? item.displayFormatter(activeValue) : 'None';
    const changed = displayValue !== activeDisplay;

    rows.push({
      key: item.key,
      label: item.label,
      value: rawValue,
      displayValue,
      activeValue,
      changed,
      promotable: item.promotable,
    });
  }

  return rows;
}

// ─── Revision diff ──────────────────────────────────────────────────────────

/**
 * Compare two revision selector sets and produce a list of changes.
 * Useful for showing what changed between parent and current revision.
 */
export function diffRevisionSelectors(
  parentSelectors: Record<string, unknown> | null,
  currentSelectors: Record<string, unknown>,
): RevisionDiffEntry[] {
  const allKeys = new Set<string>();

  if (parentSelectors) {
    for (const key of Object.keys(parentSelectors)) {
      allKeys.add(key);
    }
  }
  for (const key of Object.keys(currentSelectors)) {
    allKeys.add(key);
  }

  const entries: RevisionDiffEntry[] = [];

  for (const key of allKeys) {
    const parentVal = parentSelectors?.[key] ?? null;
    const currentVal = currentSelectors[key] ?? null;

    // Normalize to string for comparison
    const parentStr = typeof parentVal === 'string' ? parentVal : parentVal !== null ? JSON.stringify(parentVal) : null;
    const currentStr = typeof currentVal === 'string' ? currentVal : currentVal !== null ? JSON.stringify(currentVal) : null;

    let changeType: RevisionDiffEntry['changeType'];
    if (parentStr === null && currentStr !== null) changeType = 'added';
    else if (parentStr !== null && currentStr === null) changeType = 'removed';
    else if (parentStr !== currentStr) changeType = 'changed';
    else changeType = 'unchanged';

    // Only include meaningful entries (selectors + config keys)
    if (changeType === 'unchanged' && (parentStr === null && currentStr === null)) continue;

    entries.push({
      key,
      label: normalizeFieldLabel(key),
      changeType,
      oldSelector: parentStr,
      newSelector: currentStr,
    });
  }

  // Sort: added first, then changed, then removed, then unchanged
  const sortOrder: Record<string, number> = {
    added: 0,
    removed: 1,
    changed: 2,
    unchanged: 3,
  };
  entries.sort((a, b) => {
    const orderA = sortOrder[a.changeType] ?? 99;
    const orderB = sortOrder[b.changeType] ?? 99;
    if (orderA !== orderB) return orderA - orderB;
    return a.label.localeCompare(b.label);
  });

  return entries;
}
