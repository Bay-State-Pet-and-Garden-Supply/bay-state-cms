/**
 * Canonical profile field catalog for the Bay State CMS extraction system.
 *
 * This file is the single source of truth for ALL extractable product fields.
 * It defines:
 *   • The `ProfileField` interface — metadata for each extractable field
 *   • `STANDARD_PROFILE_FIELDS` — every standard field the system knows about
 *   • Utility functions to query fields by key, category, output target
 *   • `PROMOTABLE_PROFILE_KEYS` — the array of keys that can be promoted
 *     to `extractor_profiles` (replaces the old `SELECTOR_KEYS` / `SELECTOR_FIELDS`)
 *
 * How to add a new field:
 *   1. Add an entry to `STANDARD_PROFILE_FIELDS` with the correct key, label,
 *      outputTarget, valueType, cardinality, category, and validationHints.
 *   2. If the selector should be stored in a dedicated DB column (not custom),
 *      add the column to `extractor_profiles` table and update the repo.
 *   3. Add extraction support in the extraction worker's profile runner.
 *   4. Add field mapping in the profile promoter's `ApprovedSelectorFields` logic.
 *
 * This module has ZERO Bun-only imports — safe for both Bun server and
 * Node.js extraction worker.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type ProfileFieldCategory =
  | 'identity'
  | 'media'
  | 'description'
  | 'nutrition'
  | 'details'
  | 'variants';

export type ProfileFieldValueType = 'text' | 'image' | 'numeric' | 'array' | 'structured';

export type ProfileFieldCardinality = 'single' | 'multiple';

/**
 * Where the extracted value is placed in the final `ExtractionData` object.
 * - `'core'`: A typed first-class field in ExtractionData (e.g. `title`, `price`)
 * - `'customFields'`: Stored in `ExtractionData.customFields` as a string value
 */
export type ProfileFieldOutputTarget = 'core' | 'customFields';

export interface ProfileFieldValidationHints {
  /** Minimum text length to consider valid (for text fields). */
  minLength?: number;
  /** A regex pattern the extracted value should match (for structured fields). */
  pattern?: RegExp;
  /** Expected value type for the extracted text (e.g. 'currency', 'number', 'ingredient-list'). */
  expectedFormat?: string;
  /** Whether the selector should match at least N elements. */
  minMatchCount?: number;
}

export interface ProfileField {
  /** The selector key used in ExtractorProfile and GeneratedSelectorProfile.
   *  Always ends with 'Selector' (e.g. 'titleSelector', 'priceSelector'). */
  key: string;
  /** Human-readable label for the field. */
  label: string;
  /** Where the extracted value is placed in ExtractionData. */
  outputTarget: ProfileFieldOutputTarget;
  /** The type of value expected. */
  valueType: ProfileFieldValueType;
  /** Whether this field produces a single value or multiple values. */
  cardinality: ProfileFieldCardinality;
  /** The DB column or container where this field's selector is stored.
   *  'custom_selectors' means it's stored in `custom_selectors_json`.
   *  Otherwise it matches the dedicated column name (e.g. 'title_selector'). */
  selectorField: string;
  /** Optional validation hints for evaluating extracted values. */
  validationHints?: ProfileFieldValidationHints;
  /** Functional category grouping for UI organization. */
  category: ProfileFieldCategory;
  /** A short description of what this field extracts. */
  description?: string;
}

// ─── Standard field definitions ─────────────────────────────────────────────

/**
 * The complete list of all standard product fields the system can
 * discover, extract, and validate. This is the canonical catalog.
 *
 * When adding new fields, append them to this array and ensure
 * the key follows the `{name}Selector` convention.
 */
// fallow-ignore-next-line unused-export — used by tests
export const STANDARD_PROFILE_FIELDS: readonly ProfileField[] = [
  // ── Identity ─────────────────────────────────────────────────────────────
  {
    key: 'titleSelector',
    label: 'Title',
    outputTarget: 'core',
    valueType: 'text',
    cardinality: 'single',
    selectorField: 'title_selector',
    category: 'identity',
    description: 'Primary product name/title',
    validationHints: { minLength: 3 },
  },
  {
    key: 'titleOptionalSelectors',
    label: 'Title (optional subtitle)',
    outputTarget: 'core',
    valueType: 'array',
    cardinality: 'multiple',
    selectorField: 'title_optional_selectors_json',
    category: 'identity',
    description: 'Additional title components appended with " — " separator',
  },
  {
    key: 'brandSelector',
    label: 'Brand',
    outputTarget: 'core',
    valueType: 'text',
    cardinality: 'single',
    selectorField: 'brand_selector',
    category: 'identity',
    description: 'Brand or manufacturer name',
    validationHints: { minLength: 1 },
  },
  // ── Pricing ──────────────────────────────────────────────────────────────
  // Deprecated: priceSelector is not generated or promoted.
  // The DB column still exists for backward compatibility with existing profiles.
  // ── Media ────────────────────────────────────────────────────────────────
  {
    key: 'imagesSelector',
    label: 'Images',
    outputTarget: 'core',
    valueType: 'image',
    cardinality: 'multiple',
    selectorField: 'images_selector',
    category: 'media',
    description: 'Product image gallery container selector',
    validationHints: { minMatchCount: 1 },
  },
  // ── Description ──────────────────────────────────────────────────────────
  {
    key: 'descriptionSelector',
    label: 'Description',
    outputTarget: 'core',
    valueType: 'text',
    cardinality: 'single',
    selectorField: 'description_selector',
    category: 'description',
    description: 'Product description text',
    validationHints: { minLength: 20 },
  },
  // ── Nutrition ────────────────────────────────────────────────────────────
  {
    key: 'ingredientsSelector',
    label: 'Ingredients',
    outputTarget: 'customFields',
    valueType: 'array',
    cardinality: 'single',
    selectorField: 'custom_selectors',
    category: 'nutrition',
    description: 'Full ingredient list as comma-separated text',
  },
  {
    key: 'guaranteedAnalysisSelector',
    label: 'Guaranteed Analysis',
    outputTarget: 'customFields',
    valueType: 'structured',
    cardinality: 'single',
    selectorField: 'custom_selectors',
    category: 'nutrition',
    description: 'Nutritional guaranteed analysis table (protein, fat, fiber, moisture)',
  },
  {
    key: 'caloriesSelector',
    label: 'Calories',
    outputTarget: 'customFields',
    valueType: 'numeric',
    cardinality: 'single',
    selectorField: 'custom_selectors',
    category: 'nutrition',
    description: 'Calorie content (kcal/kg or per serving)',
    validationHints: { pattern: /[\d.]+/ },
  },
  {
    key: 'dietaryLabelsSelector',
    label: 'Dietary Labels',
    outputTarget: 'customFields',
    valueType: 'array',
    cardinality: 'multiple',
    selectorField: 'custom_selectors',
    category: 'nutrition',
    description: 'Dietary claims (grain-free, no corn, no soy, etc.)',
  },
  // ── Details ──────────────────────────────────────────────────────────────
  {
    key: 'weightSelector',
    label: 'Weight',
    outputTarget: 'customFields',
    valueType: 'text',
    cardinality: 'single',
    selectorField: 'custom_selectors',
    category: 'details',
    description: 'Net weight / package size (e.g. "2.64 oz", "75 g")',
  },
  {
    key: 'dimensionsSelector',
    label: 'Dimensions',
    outputTarget: 'customFields',
    valueType: 'text',
    cardinality: 'single',
    selectorField: 'custom_selectors',
    category: 'details',
    description: 'Product dimensions (L x W x H)',
  },
  {
    key: 'flavorSelector',
    label: 'Flavor',
    outputTarget: 'customFields',
    valueType: 'text',
    cardinality: 'single',
    selectorField: 'custom_selectors',
    category: 'details',
    description: 'Flavor or variety name',
  },
  {
    key: 'lifeStageSelector',
    label: 'Life Stage',
    outputTarget: 'customFields',
    valueType: 'text',
    cardinality: 'single',
    selectorField: 'custom_selectors',
    category: 'details',
    description: 'Target life stage (all life stages, kitten, adult, senior)',
  },
  {
    key: 'speciesSelector',
    label: 'Species',
    outputTarget: 'customFields',
    valueType: 'text',
    cardinality: 'single',
    selectorField: 'custom_selectors',
    category: 'details',
    description: 'Target species (dog, cat, etc.)',
  },
  {
    key: 'healthConcernsSelector',
    label: 'Health Concerns',
    outputTarget: 'customFields',
    valueType: 'array',
    cardinality: 'multiple',
    selectorField: 'custom_selectors',
    category: 'details',
    description: 'Health concern / functional benefit claims',
  },
  // ── Social ───────────────────────────────────────────────────────────────
  // Deprecated: seller-specific fields (reviews) are not generated or promoted.
];

// ─── Indexed lookup ─────────────────────────────────────────────────────────

const fieldByKey = new Map<string, ProfileField>(
  STANDARD_PROFILE_FIELDS.map((f) => [f.key, f]),
);

const fieldsByCategory = new Map<ProfileFieldCategory, ProfileField[]>();
for (const f of STANDARD_PROFILE_FIELDS) {
  const existing = fieldsByCategory.get(f.category) ?? [];
  existing.push(f);
  fieldsByCategory.set(f.category, existing);
}

// ─── Promotable keys ───────────────────────────────────────────────────────

/**
 * The set of selector field keys that can be written to `extractor_profiles`
 * through the governance promotion pipeline.
 *
 * This includes both dedicated-column fields (titleSelector, priceSelector,
 * etc.) and custom-selector fields (ingredientsSelector, flavorSelector, etc.)
 * that are stored in `custom_selectors_json`.
 *
 * This replaces the legacy `SELECTOR_KEYS` and `SELECTOR_FIELDS` constants.
 * Consumers that need only the "core" standard fields can filter by
 * `outputTarget === 'core'`.
 */
export const PROMOTABLE_PROFILE_KEYS: readonly string[] = Object.freeze(
  STANDARD_PROFILE_FIELDS.map((f) => f.key),
);

/**
 * Fields that have dedicated DB columns in `extractor_profiles`.
 * These are promoted using their own column name rather than
 * being merged into `custom_selectors_json`.
 */
// fallow-ignore-next-line unused-export — used by tests
export const CORE_PROFILE_KEYS: readonly string[] = Object.freeze(
  STANDARD_PROFILE_FIELDS
    .filter((f) => f.outputTarget === 'core')
    .map((f) => f.key),
);

// ─── Utility functions ──────────────────────────────────────────────────────

/**
 * Look up a field definition by its selector key.
 * Returns `undefined` if the key is not in the standard catalog.
 */
export function getFieldByKey(key: string): ProfileField | undefined {
  return fieldByKey.get(key);
}

/**
 * Get all field definitions in a given category.
 */
// fallow-ignore-next-line unused-export — used by tests
export function getFieldsByCategory(category: ProfileFieldCategory): ProfileField[] {
  return fieldsByCategory.get(category) ?? [];
}

/**
 * Get all fields whose extracted value lands in `ExtractionData` core fields.
 */
// fallow-ignore-next-line unused-export — used by tests
export function getCoreFields(): ProfileField[] {
  return STANDARD_PROFILE_FIELDS.filter((f) => f.outputTarget === 'core');
}

/**
 * Get all fields whose extracted value lands in `ExtractionData.customFields`.
 * These are the candidates for dynamic custom-selector extraction.
 */
// fallow-ignore-next-line unused-export — used by tests
export function getCustomFieldCandidates(): ProfileField[] {
  return STANDARD_PROFILE_FIELDS.filter((f) => f.outputTarget === 'customFields');
}

/**
 * Return `true` if the given key is a known promotable field.
 *
 * This does NOT check whether the field was actually proposed by a
 * generation — it only checks whether the key is in the canonical catalog.
 */
// fallow-ignore-next-line unused-export — used by tests
export function isPromotableField(key: string): boolean {
  return fieldByKey.has(key);
}

/**
 * Get the `outputTarget` for a given selector key.
 * Returns `'core'` by default for unknown keys (backward compat).
 */
// fallow-ignore-next-line unused-export — used by tests
export function getOutputTargetForKey(key: string): ProfileFieldOutputTarget {
  return fieldByKey.get(key)?.outputTarget ?? 'core';
}

/**
 * Get the `valueType` for a given selector key.
 * Returns `'text'` by default for unknown keys (backward compat).
 */
// fallow-ignore-next-line unused-export — used by tests
export function getValueTypeForKey(key: string): ProfileFieldValueType {
  return fieldByKey.get(key)?.valueType ?? 'text';
}

/**
 * Get the `cardinality` for a given selector key.
 * Returns `'single'` by default for unknown keys (backward compat).
 */
// fallow-ignore-next-line unused-export — used by tests
export function getCardinalityForKey(key: string): ProfileFieldCardinality {
  return fieldByKey.get(key)?.cardinality ?? 'single';
}

/**
 * Return `true` if a key belongs to a field that uses a dedicated DB column
 * (not `custom_selectors_json`).
 */
export function hasDedicatedColumn(key: string): boolean {
  const field = fieldByKey.get(key);
  return field ? field.selectorField !== 'custom_selectors' : false;
}
