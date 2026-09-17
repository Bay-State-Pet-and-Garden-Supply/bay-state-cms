/**
 * Profile Builder — shared types for the inline profile builder workspace.
 *
 * This file re-exports API types used by the feature and defines all
 * feature-local state, props, and controller interfaces.
 *
 * No Bun-only imports. Safe for Vite/React frontend.
 */

import type { ExtractorProfile } from '../../../shared/schemas/onboarding';
import type {
  SnapshotResponse,
  GenerateSelectorResponse,
  ValidateRequest,
  ValidateResponse,
} from '../../../shared/schemas/extraction-worker';
import type {
  ExtractorTestResult,
  SaveExtractorProfilePayload,
  TestExtractorProfileRequest,
} from '../../onboarding-api';

import type { SelectorWarning } from '../../../shared/schemas/selector-generation';
import type { GenerateSelectorsResponse } from '../../../shared/schemas/selector-generation';

export type {
  ExtractorProfile,
  SnapshotResponse,
  GenerateSelectorResponse,
  ValidateRequest,
  ValidateResponse,
  ExtractorTestResult,
  SaveExtractorProfilePayload,
  TestExtractorProfileRequest,
  SelectorWarning,
  GenerateSelectorsResponse,
};

// ─── Field Categories ───────────────────────────────────────────────────────

export type FieldCategory =
  | 'identity'
  | 'media'
  | 'description'
  | 'nutrition'
  | 'details'
  | 'variants';

// ─── Field Status ───────────────────────────────────────────────────────────

export type FieldStatus =
  | 'unassigned'
  | 'suggested'
  | 'assigned'
  | 'tested'
  | 'warning'
  | 'failed'
  | 'validated';

// ─── Selector Field State ───────────────────────────────────────────────────

export interface SelectorFieldState {
  key: string;
  selector: string;
  status: FieldStatus;
  extractedPreview?: string | string[] | null;
  matchCount?: number;
  stability?: 'high' | 'medium' | 'low';
  warnings: string[];
  error?: string;
  lastTestedAt?: string;
}

// ─── Profile Draft ──────────────────────────────────────────────────────────

export interface ProfileDraft {
  domain: string;
  runtime: 'static' | 'rendered';
  productUrl: string;
  titleSelector: string | null;
  titleOptionalSelectors: string[];
  brandSelector: string | null;
  descriptionSelector: string | null;
  imagesSelector: string | null;
  priceSelector: string | null;
  customSelectors: Record<string, string>;
  sitemapProductUrlPattern: string | null;
  shopifyJSONPath: boolean;
  variantSelectionStrategy: Record<string, unknown> | null;
  customSelectorMetadata: Record<string, unknown>;
}

// ─── Validation Sample ──────────────────────────────────────────────────────

export interface ValidationSample {
  id: string;
  url: string;
  confirmed: boolean;
  expectedName?: string;
}

// ─── Request State ──────────────────────────────────────────────────────────

export interface RequestState {
  loading: boolean;
  error: string | null;
  success?: boolean;
}

// ─── Selector Generation State ────────────────────────────────────────────

export type GenerationStatus = 'idle' | 'generating' | 'completed' | 'failed';

export interface FieldSuggestionState {
  fieldKey: string;
  selector: string | null;
  resultStatus: 'suggested' | 'not_found' | 'invalid';
  decision: 'pending' | 'accepted' | 'rejected';
  quality: 'high' | 'medium' | 'low' | 'unusable';
  validation: { syntaxValid: boolean; matchedCount: number; visibleMatchedCount?: number | null; unique: boolean };
  warnings: SelectorWarning[];
  explanation?: string | null;
  preview?: { text?: string | null; values?: string[] | null; imageUrls?: string[] | null } | null;
}

export interface CustomFieldSuggestionState extends FieldSuggestionState {
  key: string;
  label: string;
  valueType: 'text' | 'html' | 'url' | 'image' | 'list';
  addedToDraft: boolean;
}

export interface SelectorGenerationState {
  status: GenerationStatus;
  requestId?: string;
  snapshotRef?: string;
  startedAt?: number;
  completedAt?: number;
  fieldSuggestions: Record<string, FieldSuggestionState>;
  customFieldSuggestions: CustomFieldSuggestionState[];
  warnings: SelectorWarning[];
  error?: { code: string; message: string; retryable: boolean };
}

// ─── Full Builder State ─────────────────────────────────────────────────────

export interface ProfileBuilderState {
  profiles: ExtractorProfile[];
  activeProfile: ExtractorProfile | null;
  draft: ProfileDraft;
  fields: Record<string, SelectorFieldState>;
  customFieldOrder: string[];
  collapsedCategories: Record<FieldCategory, boolean>;
  snapshot: SnapshotResponse | null;
  pageHtml: string | null;
  samples: ValidationSample[];
  sampleCaptures?: Record<string, { html: string; dom: string }>;
  /**
   * Version-bound explicit image-review attestation: the operator confirms
   * they reviewed the image previews for the confirmed samples. Fed into
   * `draftToVersionPayload` on save — the ONLY save-path writer of
   * `validationSummary.imageRuleOk`. Default false stays blocked.
   */
  imagePreviewsReviewed: boolean;
  validation: ValidateResponse | null;
  extractionPreview: ExtractorTestResult | null;
  generation: SelectorGenerationState;
  dirty: boolean;
  lastSavedProfileId: string | null;
  requests: {
    loadProfiles: RequestState;
    snapshot: RequestState;
    fetchHtml: RequestState;
    generateSelector: RequestState;
    preview: RequestState;
    validate: RequestState;
    save: RequestState;
  };
}

// ─── Public Component Props ─────────────────────────────────────────────────

export interface CaptureArtifactLite {
  dom: string;
  screenshotBase64: string;
  runtime: string;
  hash: string;
  capturedAt: string;
  url: string;
}

export interface ProfileBuilderProps {
  initialDomain?: string;
  initialProductUrl?: string;
  initialCapture?: CaptureArtifactLite | null;
  validationSamples?: string[];
  mode?: 'inline' | 'modal';
  onSaved?: (profile: ExtractorProfile) => void;
  onCancel?: () => void;

  /**
   * Converts artifact refs (e.g. `.baystate-cms/artifacts/.../screenshot.png`)
   * into a browser-readable URL.
   *
   * If omitted or unresolved, ArtifactBrowser shows the ref path and
   * available diagnostics but does not fail the workflow.
   */
  artifactUrlResolver?: (artifactRef: string) => string | null;
}

// ─── Controller Interface ───────────────────────────────────────────────────

export interface ProfileBuilderController {
  state: ProfileBuilderState;

  setDomain(domain: string): void;
  setProductUrl(url: string): void;
  setRuntime(runtime: 'static' | 'rendered'): void;

  loadProfiles(): Promise<void>;
  captureSnapshot(): Promise<void>;

  updateSelector(key: string, selector: string): void;
  addTitleOptionalSelector(selector?: string): void;
  updateTitleOptionalSelector(index: number, selector: string): void;
  removeTitleOptionalSelector(index: number): void;

  // generateSelectorFromOuterHtml deleted (e07s03) — paste-outerHTML path removed; kept optional for type compat until callers fully removed
  generateSelectorFromOuterHtml?: (key: string, outerHTML: string) => Promise<void>;

  addCustomField(name: string): void;
  removeCustomField(key: string): void;

  runPreview(): Promise<void>;
  addSample(url: string): void;
  updateSample(id: string, patch: Partial<ValidationSample>): void;
  removeSample(id: string): void;
  runValidation(): Promise<void>;

  /** Set the explicit image-preview review attestation for the next save. */
  setImageReviewed(reviewed: boolean): void;

  generateSelectors(): Promise<void>;
  generateDraftFromSuite(suiteUrls: string[]): Promise<void>;
  acceptSelectorSuggestion(fieldKey: string): void;
  rejectSelectorSuggestion(fieldKey: string): void;
  acceptCustomFieldSuggestion(key: string): void;
  rejectCustomFieldSuggestion(key: string): void;

  saveProfile(): Promise<void>;
  resetDraft(): void;
  toggleCategory(category: FieldCategory): void;
}
