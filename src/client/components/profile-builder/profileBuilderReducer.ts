/**
 * Profile builder — pure reducer for draft state management.
 *
 * All state transitions are pure functions. No API calls, no DOM
 * access, no mutation. This module can be tested independently
 * of React.
 *
 * Field status precedence (CRITICAL — do not reorder checks
 * without understanding the validation semantics):
 *
 *   1. Empty selector                → unassigned
 *   2. Any validation sample `fail`  → failed
 *   3. Any validation sample `warn`  → warning
 *   4. All validation samples `pass` → validated
 *   5. Local evaluation `failed`     → failed
 *   6. Local evaluation `warning`    → warning
 *   7. Preview exists                → tested
 *   8. Otherwise                     → assigned
 */

import type {
  ExtractorProfile,
  SnapshotResponse,
  GenerateSelectorResponse,
  ValidateResponse,
  ExtractorTestResult,
  GenerateSelectorsResponse,
} from './profileBuilderTypes';
import type { FieldCategory } from './profileBuilderTypes';
import type {
  ProfileBuilderState,
  ProfileDraft,
  ValidationSample,
  SelectorFieldState,
  FieldStatus,
  RequestState,
  SelectorGenerationState,
  FieldSuggestionState,
  GenerationStatus,
} from './profileBuilderTypes';
import type { SelectorEvaluationResult } from './selectorEvaluation';
import type { SelectorWarning } from '../../../shared/schemas/selector-generation';
import { createEmptyDraft } from './profileBuilderMapping';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createInitialGenerationState(): SelectorGenerationState {
  return {
    status: 'idle',
    fieldSuggestions: {},
    customFieldSuggestions: [],
    warnings: [],
  };
}

function initialRequestState(): RequestState {
  return { loading: false, error: null, success: undefined };
}

function createEmptyFieldState(key: string): SelectorFieldState {
  return { key, selector: '', status: 'unassigned', warnings: [] };
}

function buildInitialFields(): Record<string, SelectorFieldState> {
  const fieldKeys = [
    'titleSelector',
    'titleOptionalSelectors',
    'descriptionSelector',
    'imagesSelector',
  ];
  const fields: Record<string, SelectorFieldState> = {};
  for (const k of fieldKeys) {
    fields[k] = createEmptyFieldState(k);
  }
  return fields;
}

// ─── Initial State ───────────────────────────────────────────────────────────

export function createInitialState(args?: {
  initialDomain?: string;
  initialProductUrl?: string;
}): ProfileBuilderState {
  return {
    profiles: [],
    activeProfile: null,
    draft: createEmptyDraft({
      domain: args?.initialDomain,
      productUrl: args?.initialProductUrl,
    }),
    fields: buildInitialFields(),
    customFieldOrder: [],
    collapsedCategories: {
      identity: false,
      media: false,
      description: false,
      nutrition: true,
      details: true,
      variants: true,
    },
    generation: createInitialGenerationState(),
    snapshot: null,
    pageHtml: null,
    samples: [],
    imagePreviewsReviewed: false,
    validation: null,
    extractionPreview: null,
    dirty: false,
    lastSavedProfileId: null,
    requests: {
      loadProfiles: initialRequestState(),
      snapshot: initialRequestState(),
      fetchHtml: initialRequestState(),
      generateSelector: initialRequestState(),
      preview: initialRequestState(),
      validate: initialRequestState(),
      save: initialRequestState(),
    },
  };
}

// ─── Action Types ────────────────────────────────────────────────────────────

export type ProfileBuilderAction =
  // Profile loading
  | { type: 'profiles/loadStarted' }
  | { type: 'profiles/loadSucceeded'; profiles: ExtractorProfile[] }
  | { type: 'profiles/loadFailed'; error: string }

  // Domain / active profile
  | { type: 'domain/set'; domain: string }
  | { type: 'activeProfile/set'; profile: ExtractorProfile | null }
  | { type: 'draft/hydrateFromProfile'; profile: ExtractorProfile }
  | { type: 'draft/reset' }

  // Runtime
  | { type: 'runtime/set'; runtime: 'static' | 'rendered' }

  // Product URL
  | { type: 'productUrl/set'; url: string }

  // Snapshot
  | { type: 'snapshot/start' }
  | { type: 'snapshot/succeeded'; snapshot: SnapshotResponse }
  | { type: 'snapshot/failed'; error: string }

  // Page HTML
  | { type: 'pageHtml/set'; html: string }

  // Field editing
  | { type: 'field/selectorChanged'; key: string; selector: string }
  | { type: 'field/selectorEvaluated'; key: string; result: SelectorEvaluationResult }
  | { type: 'field/generateStarted'; key: string }
  | { type: 'field/generateSucceeded'; key: string; result: GenerateSelectorResponse }
  | { type: 'field/generateFailed'; key: string; error: string }

  // titleOptionalSelectors
  | { type: 'titleOptional/add'; selector?: string }
  | { type: 'titleOptional/update'; index: number; selector: string }
  | { type: 'titleOptional/remove'; index: number }

  // Custom fields
  | { type: 'customField/add'; key: string; label?: string }
  | { type: 'customField/remove'; key: string }

  // Preview
  | { type: 'preview/start' }
  | { type: 'preview/succeeded'; extracted: ExtractorTestResult }
  | { type: 'preview/failed'; error: string }

  // Samples
  | { type: 'sample/add'; sample: ValidationSample }
  | { type: 'samples/set'; samples: ValidationSample[] }
  | { type: 'sampleCaptures/set'; sampleCaptures: Record<string, { html: string; dom: string }> }
  | { type: 'sample/update'; id: string; patch: Partial<ValidationSample> }
  | { type: 'sample/remove'; id: string }

  // Image review attestation
  | { type: 'imageReview/set'; reviewed: boolean }

  // Validation
  | { type: 'validation/start' }
  | { type: 'validation/succeeded'; validation: ValidateResponse }
  | { type: 'validation/failed'; error: string }

  // Save
  | { type: 'save/start' }
  | { type: 'save/succeeded'; profile: ExtractorProfile }
  | { type: 'save/failed'; error: string }

  // Selector generation
  | { type: 'selectorGenerationStarted'; payload: { htmlRef: string; requestedFieldKeys: string[] } }
  | { type: 'selectorGenerationSucceeded'; payload: GenerateSelectorsResponse }
  | { type: 'selectorGenerationFailed'; payload: { code: string; message: string; retryable: boolean } }
  | { type: 'selectorSuggestionAccepted'; payload: { fieldKey: string } }
  | { type: 'selectorSuggestionRejected'; payload: { fieldKey: string } }
  | { type: 'customFieldSuggestionAccepted'; payload: { key: string } }
  | { type: 'customFieldSuggestionRejected'; payload: { key: string } }
  | { type: 'selectorSuggestionsCleared'; payload?: { reason: 'new_snapshot' | 'manual_clear' | 'profile_reset' } }

  // UI state
  | { type: 'category/toggle'; category: FieldCategory };

// ─── Pure Reducer ───────────────────────────────────────────────────────────

export function profileBuilderReducer(
  state: ProfileBuilderState,
  action: ProfileBuilderAction,
): ProfileBuilderState {
  switch (action.type) {
    // ── Profile loading ─────────────────────────────────────────────────
    case 'profiles/loadStarted':
      return {
        ...state,
        requests: {
          ...state.requests,
          loadProfiles: { loading: true, error: null, success: undefined },
        },
      };

    case 'profiles/loadSucceeded':
      return {
        ...state,
        profiles: action.profiles,
        requests: {
          ...state.requests,
          loadProfiles: { loading: false, error: null, success: true },
        },
      };

    case 'profiles/loadFailed':
      return {
        ...state,
        requests: {
          ...state.requests,
          loadProfiles: { loading: false, error: action.error, success: false },
        },
      };

    // ── Domain ───────────────────────────────────────────────────────────
    case 'domain/set':
      return {
        ...state,
        draft: { ...state.draft, domain: action.domain },
        dirty: true,
      };

    case 'activeProfile/set':
      return {
        ...state,
        activeProfile: action.profile,
      };

    case 'draft/hydrateFromProfile': {
      const p = action.profile;
      const draft: ProfileDraft = {
        domain: p.domain,
        runtime: p.runtime ?? 'rendered',
        productUrl: state.draft.productUrl,
        titleSelector: p.titleSelector,
        titleOptionalSelectors: p.titleOptionalSelectors ?? [],
        brandSelector: p.brandSelector,
        descriptionSelector: p.descriptionSelector,
        imagesSelector: p.imagesSelector,
        priceSelector: p.priceSelector,
        customSelectors: p.customSelectors ?? {},
        sitemapProductUrlPattern: p.sitemapProductUrlPattern,
        shopifyJSONPath: p.shopifyJSONPath ?? false,
        variantSelectionStrategy: p.variantSelectionStrategy,
        customSelectorMetadata: p.customSelectorMetadata ?? {},
      };

      // Rebuild fields mapping from the hydrated selectors
      const fields = buildInitialFields();

      if (p.titleSelector) {
        fields['titleSelector'] = {
          ...fields['titleSelector'],
          selector: p.titleSelector,
          status: 'assigned',
        };
      }
      if (p.descriptionSelector) {
        fields['descriptionSelector'] = {
          ...fields['descriptionSelector'],
          selector: p.descriptionSelector,
          status: 'assigned',
        };
      }
      if (p.imagesSelector) {
        fields['imagesSelector'] = {
          ...fields['imagesSelector'],
          selector: p.imagesSelector,
          status: 'assigned',
        };
      }

      // Add custom fields
      const customFieldOrder: string[] = [];
      if (p.customSelectors) {
        for (const [key, selector] of Object.entries(p.customSelectors)) {
          customFieldOrder.push(key);
          fields[key] = {
            ...(fields[key] ?? createEmptyFieldState(key)),
            selector: selector || '',
            status: selector ? 'assigned' : 'unassigned',
          };
        }
      }

      return {
        ...state,
        draft,
        fields,
        customFieldOrder,
        // Fresh profile scope needs fresh image attestation (fail-closed).
        imagePreviewsReviewed: false,
        dirty: false,
      };
    }

    case 'draft/reset':
      return {
        ...state,
        draft: createEmptyDraft({ domain: state.draft.domain }),
        fields: buildInitialFields(),
        customFieldOrder: [],
        snapshot: null,
        pageHtml: null,
        samples: [],
        imagePreviewsReviewed: false,
        validation: null,
        extractionPreview: null,
        dirty: false,
        requests: {
          ...state.requests,
          snapshot: initialRequestState(),
          preview: initialRequestState(),
          validate: initialRequestState(),
        },
      };

    // ── Runtime ──────────────────────────────────────────────────────────
    case 'runtime/set':
      return {
        ...state,
        draft: { ...state.draft, runtime: action.runtime },
        extractionPreview: null,
        validation: null,
        dirty: true,
      };

    // ── Product URL ──────────────────────────────────────────────────────
    case 'productUrl/set':
      return {
        ...state,
        draft: { ...state.draft, productUrl: action.url },
        snapshot: null,
        pageHtml: null,
        extractionPreview: null,
        validation: null,
        requests: {
          ...state.requests,
          snapshot: initialRequestState(),
          fetchHtml: initialRequestState(),
          preview: initialRequestState(),
          validate: initialRequestState(),
        },
      };

    // ── Snapshot ─────────────────────────────────────────────────────────
    case 'snapshot/start':
      return {
        ...state,
        requests: {
          ...state.requests,
          snapshot: { loading: true, error: null, success: undefined },
        },
      };

    case 'snapshot/succeeded':
      return {
        ...state,
        snapshot: action.snapshot,
        // Clear pending suggestions when a new snapshot is captured
        generation: {
          ...state.generation,
          status: 'idle',
          fieldSuggestions: {},
          customFieldSuggestions: [],
        },
        requests: {
          ...state.requests,
          snapshot: { loading: false, error: null, success: true },
        },
      };

    case 'snapshot/failed':
      return {
        ...state,
        requests: {
          ...state.requests,
          snapshot: { loading: false, error: action.error, success: false },
        },
      };

    // ── Selector Generation ───────────────────────────────────────────────
    case 'selectorGenerationStarted': {
      return {
        ...state,
        generation: {
          ...state.generation,
          status: 'generating',
          snapshotRef: action.payload.htmlRef,
          startedAt: Date.now(),
          error: undefined,
        },
      };
    }

    case 'selectorGenerationSucceeded': {
      const resp = action.payload;
      const fieldSuggestions: Record<string, FieldSuggestionState> = {};
      for (const [fieldKey, suggestion] of Object.entries(resp.fields)) {
        fieldSuggestions[fieldKey] = {
          fieldKey,
          selector: suggestion.selector,
          resultStatus: suggestion.status,
          decision: 'pending',
          quality: suggestion.quality,
          validation: suggestion.validation,
          warnings: suggestion.warnings,
          explanation: suggestion.explanation,
          preview: suggestion.preview,
        };
      }
      const customFieldSuggestions = (resp.customFields ?? []).map((cf) => ({
        fieldKey: cf.fieldKey,
        key: cf.key,
        label: cf.label,
        valueType: cf.valueType,
        selector: cf.selector,
        resultStatus: cf.status,
        decision: 'pending' as const,
        quality: cf.quality,
        validation: cf.validation,
        warnings: cf.warnings,
        explanation: cf.explanation,
        preview: cf.preview,
        addedToDraft: false,
      }));
      return {
        ...state,
        generation: {
          ...state.generation,
          status: 'completed',
          requestId: resp.requestId,
          completedAt: Date.now(),
          fieldSuggestions,
          customFieldSuggestions,
          warnings: resp.warnings,
          error: undefined,
        },
      };
    }

    case 'selectorGenerationFailed': {
      return {
        ...state,
        generation: {
          ...state.generation,
          status: 'failed',
          error: action.payload,
        },
      };
    }

    case 'selectorSuggestionAccepted': {
      const { fieldKey } = action.payload;
      const suggestion = state.generation.fieldSuggestions[fieldKey];
      if (!suggestion || suggestion.resultStatus !== 'suggested' || !suggestion.selector) {
        return state;
      }
      const updatedFields = {
        ...state.fields,
        [fieldKey]: {
          ...(state.fields[fieldKey] ?? createEmptyFieldState(fieldKey)),
          selector: suggestion.selector,
          status: 'assigned' as const,
          warnings: [],
          error: undefined,
          lastTestedAt: undefined,
        },
      };
      return {
        ...state,
        draft: updateDraftSelector(state.draft, fieldKey, suggestion.selector),
        fields: updatedFields,
        generation: {
          ...state.generation,
          fieldSuggestions: {
            ...state.generation.fieldSuggestions,
            [fieldKey]: { ...suggestion, decision: 'accepted' },
          },
        },
        dirty: true,
      };
    }

    case 'selectorSuggestionRejected': {
      const { fieldKey } = action.payload;
      const suggestion = state.generation.fieldSuggestions[fieldKey];
      if (!suggestion) return state;
      return {
        ...state,
        generation: {
          ...state.generation,
          fieldSuggestions: {
            ...state.generation.fieldSuggestions,
            [fieldKey]: { ...suggestion, decision: 'rejected' },
          },
        },
      };
    }

    case 'customFieldSuggestionAccepted': {
      const { key } = action.payload;
      const suggestion = state.generation.customFieldSuggestions.find((s) => s.key === key);
      if (!suggestion || suggestion.resultStatus !== 'suggested' || !suggestion.selector) {
        return state;
      }
      if (state.customFieldOrder.includes(suggestion.key)) {
        return state;
      }
      const updatedFields = {
        ...state.fields,
        [suggestion.key]: {
          ...(state.fields[suggestion.key] ?? createEmptyFieldState(suggestion.key)),
          selector: suggestion.selector,
          status: 'assigned' as const,
          warnings: [],
          error: undefined,
          lastTestedAt: undefined,
        },
      };
      return {
        ...state,
        customFieldOrder: [...state.customFieldOrder, suggestion.key],
        draft: {
          ...state.draft,
          customSelectors: {
            ...state.draft.customSelectors,
            [suggestion.key]: suggestion.selector,
          },
        },
        fields: updatedFields,
        generation: {
          ...state.generation,
          customFieldSuggestions: state.generation.customFieldSuggestions.map(
            (s) => s.key === key ? { ...s, decision: 'accepted' as const, addedToDraft: true } : s,
          ),
        },
        dirty: true,
      };
    }

    case 'customFieldSuggestionRejected': {
      const { key } = action.payload;
      return {
        ...state,
        generation: {
          ...state.generation,
          customFieldSuggestions: state.generation.customFieldSuggestions.map(
            (s) => s.key === key ? { ...s, decision: 'rejected' as const } : s,
          ),
        },
      };
    }

    case 'selectorSuggestionsCleared': {
      return {
        ...state,
        generation: {
          ...state.generation,
          status: 'idle',
          fieldSuggestions: {},
          customFieldSuggestions: [],
        },
      };
    }

    // ── Page HTML ────────────────────────────────────────────────────────
    case 'pageHtml/set':
      return {
        ...state,
        pageHtml: action.html,
        requests: {
          ...state.requests,
          fetchHtml: { loading: false, error: null, success: true },
        },
      };

    // ── Field selector changed ───────────────────────────────────────────
    case 'field/selectorChanged': {
      const { key, selector } = action;
      // Update the appropriate field in the draft.
      const updatedDraft = updateDraftSelector(state.draft, key, selector);

      // Update field state.
      const newStatus: FieldStatus = selector.trim() ? 'assigned' : 'unassigned';
      const updatedFields = {
        ...state.fields,
        [key]: {
          ...(state.fields[key] ?? createEmptyFieldState(key)),
          selector,
          status: newStatus,
          warnings: [],
          error: undefined,
          lastTestedAt: undefined,
        },
      };

      return {
        ...state,
        draft: updatedDraft,
        fields: updatedFields,
        // The attestation covers image previews produced by the images
        // selector — a selector change voids it (fail-closed).
        imagePreviewsReviewed: key === 'imagesSelector' ? false : state.imagePreviewsReviewed,
        dirty: true,
      };
    }

    // ── Field selector evaluated locally ─────────────────────────────────
    case 'field/selectorEvaluated': {
      const { key, result } = action;
      const existing = state.fields[key] ?? createEmptyFieldState(key);
      return {
        ...state,
        fields: {
          ...state.fields,
          [key]: {
            ...existing,
            status: result.status === 'unassigned'
              ? (existing.selector.trim() ? 'assigned' : 'unassigned')
              : result.status,
            extractedPreview: result.extractedPreview,
            matchCount: result.matchCount,
            warnings: result.warnings,
            error: result.error,
          },
        },
      };
    }

    // ── Generate selector ────────────────────────────────────────────────
    case 'field/generateStarted': {
      const { key } = action;
      return {
        ...state,
        requests: {
          ...state.requests,
          generateSelector: { loading: true, error: null, success: undefined },
        },
      };
    }

    case 'field/generateSucceeded': {
      const { key, result } = action;
      const updatedDraft = updateDraftSelector(state.draft, key, result.selector);
      const existing = state.fields[key] ?? createEmptyFieldState(key);
      return {
        ...state,
        draft: updatedDraft,
        fields: {
          ...state.fields,
          [key]: {
            ...existing,
            selector: result.selector,
            status: 'assigned',
            extractedPreview: result.extractedText
              ? result.extractedText
              : result.extractedImages.length > 0
                ? result.extractedImages
                : existing.extractedPreview,
            matchCount: result.matchCount,
            stability: result.stability,
            warnings: result.warnings,
            error: undefined,
          },
        },
        dirty: true,
        requests: {
          ...state.requests,
          generateSelector: { loading: false, error: null, success: true },
        },
      };
    }

    case 'field/generateFailed': {
      return {
        ...state,
        requests: {
          ...state.requests,
          generateSelector: { loading: false, error: action.error, success: false },
        },
      };
    }

    // ── titleOptionalSelectors ────────────────────────────────────────────
    case 'titleOptional/add': {
      const newSelector = action.selector ?? '';
      return {
        ...state,
        draft: {
          ...state.draft,
          titleOptionalSelectors: [
            ...state.draft.titleOptionalSelectors,
            newSelector,
          ],
        },
        dirty: true,
      };
    }

    case 'titleOptional/update': {
      const { index, selector } = action;
      const updated = [...state.draft.titleOptionalSelectors];
      if (index >= 0 && index < updated.length) {
        updated[index] = selector;
      }
      return {
        ...state,
        draft: { ...state.draft, titleOptionalSelectors: updated },
        dirty: true,
      };
    }

    case 'titleOptional/remove': {
      const { index } = action;
      const updated = state.draft.titleOptionalSelectors.filter(
        (_, i) => i !== index,
      );
      return {
        ...state,
        draft: { ...state.draft, titleOptionalSelectors: updated },
        dirty: true,
      };
    }

    // ── Custom fields ─────────────────────────────────────────────────────
    case 'customField/add': {
      const { key } = action;
      if (state.customFieldOrder.includes(key)) {
        // Already present — no-op.
        return state;
      }
      return {
        ...state,
        customFieldOrder: [...state.customFieldOrder, key],
        draft: {
          ...state.draft,
          customSelectors: {
            ...state.draft.customSelectors,
            [key]: '',
          },
        },
        fields: {
          ...state.fields,
          [key]: createEmptyFieldState(key),
        },
        dirty: true,
      };
    }

    case 'customField/remove': {
      const { key } = action;
      const { [key]: removed, ...rest } = state.draft.customSelectors;
      return {
        ...state,
        customFieldOrder: state.customFieldOrder.filter((k) => k !== key),
        draft: {
          ...state.draft,
          customSelectors: rest,
        },
        dirty: true,
      };
    }

    // ── Preview ──────────────────────────────────────────────────────────
    case 'preview/start':
      return {
        ...state,
        extractionPreview: null,
        requests: {
          ...state.requests,
          preview: { loading: true, error: null, success: undefined },
        },
      };

    case 'preview/succeeded':
      return {
        ...state,
        extractionPreview: action.extracted,
        requests: {
          ...state.requests,
          preview: { loading: false, error: null, success: true },
        },
      };

    case 'preview/failed':
      return {
        ...state,
        // Preserve existing preview if any; don't destroy selectors.
        requests: {
          ...state.requests,
          preview: { loading: false, error: action.error, success: false },
        },
      };

    // ── Samples ──────────────────────────────────────────────────────────
    // The image attestation covers the confirmed sample set — any sample
    // change voids it (fail-closed; the operator re-attests for the set).
    case 'sample/add': {
      const exists = state.samples.some((s) => s.id === action.sample.id);
      if (exists) return state;
      return {
        ...state,
        samples: [...state.samples, action.sample],
        // Validated results are stale once samples change.
        validation: null,
        imagePreviewsReviewed: false,
      };
    }

    case 'samples/set': {
      return {
        ...state,
        samples: action.samples,
        validation: null,
        imagePreviewsReviewed: false,
      };
    }

    case 'sampleCaptures/set':
      return {
        ...state,
        sampleCaptures: { ...(state.sampleCaptures ?? {}), ...action.sampleCaptures },
      };

    case 'sample/update': {
      const samples = state.samples.map((s) =>
        s.id === action.id ? { ...s, ...action.patch } : s,
      );
      return {
        ...state,
        samples,
        validation: null,
        imagePreviewsReviewed: false,
      };
    }

    case 'sample/remove': {
      return {
        ...state,
        samples: state.samples.filter((s) => s.id !== action.id),
        validation: null,
        imagePreviewsReviewed: false,
      };
    }

    // ── Image review attestation ─────────────────────────────────────────
    case 'imageReview/set': {
      return {
        ...state,
        imagePreviewsReviewed: action.reviewed,
        dirty: true,
      };
    }

    // ── Validation ───────────────────────────────────────────────────────
    case 'validation/start':
      return {
        ...state,
        requests: {
          ...state.requests,
          validate: { loading: true, error: null, success: undefined },
        },
      };

    case 'validation/succeeded':
      return {
        ...state,
        validation: action.validation,
        requests: {
          ...state.requests,
          validate: { loading: false, error: null, success: true },
        },
      };

    case 'validation/failed':
      return {
        ...state,
        // Preserve the PREVIOUS validation result so the matrix doesn't
        // disappear on a transient failure.
        requests: {
          ...state.requests,
          validate: { loading: false, error: action.error, success: false },
        },
      };

    // ── Save ─────────────────────────────────────────────────────────────
    case 'save/start':
      return {
        ...state,
        requests: {
          ...state.requests,
          save: { loading: true, error: null, success: undefined },
        },
      };

    case 'save/succeeded': {
      const saved = action.profile;
      // Replace the profile in the profiles list.
      const profiles = state.profiles.map((p) =>
        p.id === saved.id ? saved : p,
      );
      // If it's a new profile (no match by id), append.
      const profilesUpdated = profiles.length === state.profiles.length
        ? [...state.profiles, saved]
        : profiles;

      return {
        ...state,
        profiles: profilesUpdated,
        activeProfile: saved,
        lastSavedProfileId: saved.id,
        dirty: false,
        requests: {
          ...state.requests,
          save: { loading: false, error: null, success: true },
        },
      };
    }

    case 'save/failed':
      return {
        ...state,
        // Keep draft dirty so the operator can retry.
        requests: {
          ...state.requests,
          save: { loading: false, error: action.error, success: false },
        },
      };

    // ── UI state ─────────────────────────────────────────────────────────
    case 'category/toggle': {
      const { category } = action;
      return {
        ...state,
        collapsedCategories: {
          ...state.collapsedCategories,
          [category]: !state.collapsedCategories[category],
        },
      };
    }

    default:
      return state;
  }
}

// ─── Helpers to update draft selectors ───────────────────────────────────────

function updateDraftSelector(
  draft: ProfileDraft,
  key: string,
  selector: string,
): ProfileDraft {
  switch (key) {
    case 'titleSelector':
      return { ...draft, titleSelector: selector || null };
    case 'brandSelector':
      return { ...draft, brandSelector: selector || null };
    case 'descriptionSelector':
      return { ...draft, descriptionSelector: selector || null };
    case 'imagesSelector':
      return { ...draft, imagesSelector: selector || null };
    case 'priceSelector':
      return { ...draft, priceSelector: selector || null };
    default:
      // Custom field — update customSelectors map.
      return {
        ...draft,
        customSelectors: {
          ...draft.customSelectors,
          [key]: selector,
        },
      };
  }
}

// ─── Field Status Derivation ─────────────────────────────────────────────────

/**
 * Derive the current `FieldStatus` for a single selector field.
 *
 * PRIORITY (do not reorder):
 *   1. Empty selector                         → unassigned
 *   2. Any validation sample `fail`           → failed
 *   3. Any validation sample `warning`        → warning
 *   4. ALL validation samples `pass`          → validated
 *   5. Local evaluation returned `failed`     → failed
 *   6. Local evaluation returned `warning`    → warning
 *   7. A preview exists                       → tested
 *   8. Otherwise                              → assigned
 *
 * @note Validation statuses come from `ValidateResponse.results[].fieldResults[key].status`.
 *       A missing field in fieldResults is treated as 'not-run' and does not affect status.
 */
export function deriveFieldStatus(args: {
  selector: string;
  localResult?: SelectorEvaluationResult;
  previewResult?: ExtractorTestResult | null;
  validation?: ValidateResponse | null;
  fieldKey: string;
  /** Pending generation suggestion state, if any */
  generationSuggestion?: FieldSuggestionState | null;
}): FieldStatus {
  const { selector, localResult, previewResult, validation, fieldKey, generationSuggestion } = args;

  // 1. Empty selector.
  if (!selector || !selector.trim()) {
    return 'unassigned';
  }

  // 2-4. Validation results.
  if (validation?.results && validation.results.length > 0) {
    const statuses = validation.results
      .map((r) => r.fieldResults?.[fieldKey]?.status)
      .filter(Boolean);

    if (statuses.length > 0) {
      if (statuses.includes('fail')) return 'failed';
      if (statuses.includes('warning')) return 'warning';
      if (statuses.every((s) => s === 'pass')) return 'validated';
    }
  }

  // 5-6. Local evaluation.
  if (localResult) {
    if (localResult.status === 'failed') return 'failed';
    if (localResult.status === 'warning') return 'warning';
  }

  // 7. Preview exists.
  if (previewResult) {
    // Check if this specific field has a value in the preview.
    const hasPreviewValue = fieldHasPreviewValue(previewResult, fieldKey);
    if (hasPreviewValue) return 'tested';
  }

  // 7b. Pending suggestion — only when field has no existing selector.
  if (generationSuggestion && generationSuggestion.decision === 'pending' && generationSuggestion.resultStatus === 'suggested') {
    if (!selector || !selector.trim()) {
      return 'suggested';
    }
  }

  // 8. Fallback.
  return 'assigned';
}

/**
 * Check whether an ExtractorTestResult has a value for the given field key.
 */
function fieldHasPreviewValue(
  preview: ExtractorTestResult,
  fieldKey: string,
): boolean {
  switch (fieldKey) {
    case 'titleSelector':
      return !!preview.title;
    case 'brandSelector':
      return !!preview.brand;
    case 'descriptionSelector':
      return !!preview.description;
    case 'imagesSelector':
      return !!(preview.images && preview.images.length > 0);
    case 'priceSelector':
      return !!preview.price;
    default: {
      // Custom fields are in customFields map.
      const customKey = fieldKey.replace(/Selector$/, '').toLowerCase();
      for (const [k, v] of Object.entries(preview.customFields ?? {})) {
        if (k.toLowerCase() === customKey || k === fieldKey) {
          return !!v;
        }
      }
      return false;
    }
  }
}
