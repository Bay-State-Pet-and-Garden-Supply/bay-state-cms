/**
 * Domain profile governance service.
 *
 * Centralizes the business rules around AI-generated selector
 * profiles: backfilling the initial revision, validating across
 * confirmed (selected) product samples, applying structured
 * store-manager feedback, approving/rejecting per field, and
 * rolling back approved fields.
 *
 * # Hard product invariants enforced here
 *
 * 1. **AI-generated profiles are proposals only.** Promotion requires
 *    explicit per-field approval from a human operator. The
 *    promoter never auto-writes, regardless of confidence.
 *
 * 2. **Approval is per field.** Approving `titleSelector` does not
 *    approve `imagesSelector`. The promoter writes only the fields
 *    the operator explicitly set to `true`.
 *
 * 3. **Image-selector approval requires multi-product validation.**
 *    The service enforces that `imagesSelector` cannot be approved
 *    unless at least two same-domain samples passed and the operator
 *    attested to having reviewed the image previews.
 *
 * 4. **Text-selector approval with one sample gets a warning.** The
 *    service allows approval with a single sample (since some domains
 *    have only one known product URL) but flags the limited evidence
 *    in the validation summary so the operator knows.
 *
 * 5. **Validation samples are confirmed URLs only.** The service
 *    uses `listValidationSamplesByDomain` which only returns rows
 *    with `is_selected = 1` and exact/suffix domain matching. Random
 *    high-confidence but unselected URLs are excluded.
 *
 * 6. **Selector revisions are versioned.** A revision from operator
 *    feedback is a new row in `profile_generation_revisions` linked
 *    to its parent. Revisions are never overwritten.
 *
 * 7. **Approved field decisions carry `previous_selector`.** The
 *    service captures the prior active value before writing, so
 *    rollback can restore it.
 *
 * The service is the single source of truth for these rules. Routes
 * and UI call it; they do not re-implement the gates themselves.
 */

import { findProfileByDomain, listAllProfiles } from '../db/repositories/extractor-profile-repo';
import {
  findProfileGenerationById,
  listProfileGenerationsByDomain,
  updateProfileGenerationStatus,
  insertProfileGeneration,
} from '../db/repositories/profile-generation-repo';
import {
  insertProfileGenerationRevision,
  findProfileGenerationRevisionById,
  listRevisionsByGeneration,
  findLatestValidatedRevision,
  updateProfileGenerationRevisionStatus,
  updateRevisionSelectors,
  insertRevisionValidationResults,
  listValidationResultsByRevision,
} from '../db/repositories/profile-generation-revision-repo';
import {
  insertProfileFieldDecision,
  listFieldDecisionsByDomain,
  type ProfileGenerationFieldDecision as RepoProfileGenerationFieldDecision,
} from '../db/repositories/profile-generation-field-decision-repo';
import { listValidationSamplesByDomain } from '../db/repositories/onboarding-source-repo';
import { isPrivateOrLinkLocalHost, fetchPinned } from '../shared/ssrf';
import {
  promoteGeneratedProfile,
  rollbackProfileField,
  rollbackLatestApprovedField,
  SELECTOR_KEYS,
  type ApprovedSelectorFields,
  type PromotionResult,
  type RollbackResult,
  type SelectorKey,
} from './profile-promoter';
import {
  addImageSource,
  cleanAndDeduplicateImages,
  collectImageSourcesFromElement,
} from './image-utils';
import { isSupportedSelectorSyntax } from '../shared/selector-utils';
import type { GeneratedSelectorProfile } from './profile-generator';
import type {
  ProfileGenerationGeneration,
  ProfileGenerationRevision,
  ProfileGenerationValidationResult,
  ProfileGenerationFieldDecision,
  StructuredFeedback,
  DomainProfileGovernance,
  ExtractorProfile,
  ValidationSampleRef,
} from '../shared/schemas/onboarding';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum number of confirmed same-domain samples that must validate
 *  before `imagesSelector` can be approved. */
// fallow-ignore-next-line unused-export
export const MIN_IMAGE_APPROVAL_SAMPLES = 2;

/** Maximum number of samples the validation service will fetch per
 *  re-validation. Capped to keep a single revision validation bounded
 *  and to avoid a runaway request fan-out. */
// fallow-ignore-next-line unused-export
export const MAX_VALIDATION_SAMPLES = 10;

/**
 * Request a governed domain profile proposal for an unprofiled domain.
 *
 * Enforces:
 * 1. Domain normalization.
 * 2. Active profile deduplication: skips if an approved profile already exists.
 * 3. Open proposal deduplication: skips if an active, non-terminal proposal exists.
 * 4. 24-hour cooldown: skips if a proposal attempt was created in the last 24h.
 */
export function requestDomainProfileProposal(
  domain: string,
  options: {
    sourceUrl?: string;
    expectedName?: string | null;
    brandHint?: string | null;
  } = {},
): { created: boolean; generationId?: string; reason?: string } {
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '').trim();
  if (!normalizedDomain) return { created: false, reason: 'invalid_domain' };

  // 1. Check existing approved profile
  const existingProfile = findProfileByDomain(normalizedDomain);
  if (existingProfile) {
    return { created: false, reason: 'profile_already_exists' };
  }

  // 2. Check open / recent generation records (cooldown + deduplication)
  const recentGenerations = listProfileGenerationsByDomain(normalizedDomain, {
    orderBy: 'created_at',
    orderDirection: 'DESC',
    limit: 5,
  });

  const active = recentGenerations.find((g) => g.status !== 'rejected' && g.status !== 'failed');
  if (active) {
    return { created: false, generationId: active.id, reason: 'open_proposal_exists' };
  }

  const latest = recentGenerations[0];
  if (latest) {
    const ageMs = Date.now() - new Date(latest.createdAt).getTime();
    if (ageMs < 24 * 60 * 60 * 1000) {
      return { created: false, generationId: latest.id, reason: 'cooldown_active' };
    }
  }

  // 3. Create proposed generation record
  const record = insertProfileGeneration({
    domain: normalizedDomain,
    sourceUrl: options.sourceUrl ?? `https://${normalizedDomain}`,
    expectedName: options.expectedName ?? null,
    brandHint: options.brandHint ?? null,
    selectors: {},
    status: 'proposed',
    confidence: 0,
  });

  return { created: true, generationId: record.id };
}

// ─── Domain governance summary ────────────────────────────────────────────────

/**
 * Aggregate the data needed by the domain-level governance UI: the
 * active extractor profile, all generations for the domain, all
 * revisions across those generations, all field decisions, and the
 * number of confirmed validation samples.
 */
export function listDomainProfileGovernance(domain: string): DomainProfileGovernance {
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '').trim();

  const activeProfile = findProfileByDomain(normalizedDomain);
  const generations = listProfileGenerationsByDomain(normalizedDomain) as unknown as ProfileGenerationGeneration[];
  const generationIds = new Set(generations.map((g) => g.id));
  const revisions: ProfileGenerationRevision[] = [];
  for (const g of generations) {
    const revs = listRevisionsByGeneration(g.id);
    for (const r of revs) revisions.push(r as unknown as ProfileGenerationRevision);
  }
  const rawDecisions = listFieldDecisionsByDomain(normalizedDomain) as unknown as RepoProfileGenerationFieldDecision[];
  const fieldDecisions: ProfileGenerationFieldDecision[] = rawDecisions.map((d) => ({
    id: d.id,
    generationId: d.generationId,
    revisionId: d.revisionId,
    domain: d.domain,
    selectorField: d.selectorField as ProfileGenerationFieldDecision['selectorField'],
    decision: d.decision as ProfileGenerationFieldDecision['decision'],
    previousSelector: d.previousSelector,
    proposedSelector: d.proposedSelector,
    approvedSelector: d.approvedSelector,
    feedback: d.feedback as Record<string, unknown> | null,
    validationResultIds: d.validationResultIds,
    decidedAt: d.decidedAt,
    decidedBy: d.decidedBy,
    notes: d.notes,
  }));
  const validationSamples = listValidationSamplesByDomain(normalizedDomain, MAX_VALIDATION_SAMPLES);

  return {
    domain: normalizedDomain,
    activeProfile: (activeProfile as ExtractorProfile | null) ?? null,
    generations,
    revisions,
    fieldDecisions,
    validationSampleCount: validationSamples.length,
    validationSamples: validationSamples.map((s) => ({
      url: s.url,
      expectedName: s.expectedName,
      brandHint: s.brandHint,
      itemId: s.itemId,
      confirmed: true,
    })),
  };
}

// ─── Backfill: initial revision for legacy generations ───────────────────────

/**
 * For a `profile_generations` row that predates the revision table,
 * synthesize revision 1 from the legacy `selectors_json` payload. This
 * keeps the per-field-decision table referentially consistent. Safe
 * to call multiple times — returns the existing revision on a second
 * call.
 */
export function createInitialRevisionForGeneration(
  generationId: string,
): ProfileGenerationRevision | null {
  const generation = findProfileGenerationById(generationId);
  if (!generation) return null;

  const existing = listRevisionsByGeneration(generationId);
  if (existing.length > 0) {
    return existing[0] as unknown as ProfileGenerationRevision;
  }

  const selectors = (generation.selectors ?? {}) as Record<string, unknown>;
  const status = generation.status === 'validated' || generation.status === 'promoted'
    ? 'validated'
    : 'draft';

  const inserted = insertProfileGenerationRevision({
    generationId,
    revisionNumber: 1,
    parentRevisionId: null,
    source: 'initial_generation',
    selectors,
    fieldSamples: (generation.fieldSamples ?? null) as Record<string, unknown> | null,
    validationSummary: (generation.validation ?? null) as Record<string, unknown> | null,
    status,
    confidence: generation.confidence,
    llmTask: null,
    llmProvider: generation.llmProvider ?? null,
    llmModel: generation.llmModel ?? null,
    errorMessage: generation.errorMessage ?? null,
  });

  return inserted as unknown as ProfileGenerationRevision;
}

// ─── Validation: across confirmed same-domain samples ────────────────────────

/**
 * Fetch a single product page using the page-extractor HTTP headers.
 * The validation service uses the same headers as the production
 * extractor so the validation mirrors what production will see. The
 * caller is responsible for the network budget; this helper is
 * private to the service.
 */
async function fetchSampleHtml(url: string): Promise<string | null> {
  try {
    let currentUrl = url;
    let response: Response | null = null;

    for (let hop = 0; hop < 5; hop++) {
      const hopResult = await fetchPinned(currentUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
        timeoutMs: 12_000,
      });

      response = hopResult.response;

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return null;
        try {
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        } catch {
          return null;
        }
      }
      break;
    }

    if (!response || !response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * Lightweight Cheerio-based selector evaluator. We do not need the
 * full extraction pipeline here — we just want to know whether a
 * selector returns a non-empty result and what that result looks
 * like. Imported lazily so the governance service can still be
 * statically analyzed in environments that do not have cheerio
 * installed at the time of the typecheck.
 */
interface SelectorSample {
  field: SelectorKey;
  sampleUrl: string;
  itemId: string | null;
  expectedName: string | null;
  brandHint: string | null;
  extractedText: string | null;
  extractedImages: string[];
  warnings: string[];
  status: 'pass' | 'warning' | 'fail';
}

async function evaluateSelectorOnSample(
  field: SelectorKey,
  selector: string | null,
  html: string,
  sampleUrl: string,
  itemId: string | null,
  expectedName: string | null,
  brandHint: string | null,
): Promise<SelectorSample> {
  const warnings: string[] = [];
  if (!selector) {
    return {
      field,
      sampleUrl,
      itemId,
      expectedName,
      brandHint,
      extractedText: null,
      extractedImages: [],
      warnings: ['No selector for this field'],
      status: 'fail',
    };
  }

  const cheerio = await import('cheerio');
  const $ = cheerio.load(html);
  const $el = $(selector).first();
  if ($el.length === 0) {
    return {
      field,
      sampleUrl,
      itemId,
      expectedName,
      brandHint,
      extractedText: null,
      extractedImages: [],
      warnings: ['Selector matched zero elements'],
      status: 'fail',
    };
  }

  if (field === 'imagesSelector') {
    // Collect raw candidate URLs using the shared extractor logic
    // (includes srcset/data-srcset, not just direct src attrs).
    const rawImages: string[] = [];
    const seenRaw = new Set<string>();
    $(selector).each((_, el) => {
      for (const src of collectImageSourcesFromElement($, el)) {
        addImageSource(src, seenRaw, rawImages);
      }
    });

    // Deduplicate and normalize the same way the production
    // extractor does, so governance previews match reality.
    const images = cleanAndDeduplicateImages(rawImages, sampleUrl);

    // Warn when raw candidates exceed deduped (carousel/thumbnail dupes).
    if (rawImages.length > images.length) {
      warnings.push(
        `Image selector returned ${rawImages.length} raw candidates; deduped to ${images.length}. May include duplicate or low-res carousel images.`,
      );
    }

    return {
      field,
      sampleUrl,
      itemId,
      expectedName,
      brandHint,
      extractedText: null,
      extractedImages: images,
      warnings,
      status: images.length > 0 ? 'pass' : 'fail',
    };
  }

  const text = $el.text().trim();
  if (!text) {
    return {
      field,
      sampleUrl,
      itemId,
      expectedName,
      brandHint,
      extractedText: '',
      extractedImages: [],
      warnings: ['Selector matched but extracted empty text'],
      status: 'fail',
    };
  }

  if (expectedName && field === 'titleSelector') {
    const expectedWords = expectedName
      .toLowerCase()
      .split(/[\s-]+/)
      .filter((w) => w.length > 2);
    const matchCount = expectedWords.filter((w) => text.toLowerCase().includes(w)).length;
    if (expectedWords.length > 0 && matchCount / expectedWords.length < 0.25) {
      warnings.push('Selector text has low expected-name overlap');
      return {
        field,
        sampleUrl,
        itemId,
        expectedName,
        brandHint,
        extractedText: text,
        extractedImages: [],
        warnings,
        status: 'warning',
      };
    }
  }

  return {
    field,
    sampleUrl,
    itemId,
    expectedName,
    brandHint,
    extractedText: text,
    extractedImages: [],
    warnings,
    status: 'pass',
  };
}

export interface ValidationRunResult {
  revisionId: string;
  sampleCount: number;
  passingSamples: number;
  failingSamples: number;
  warningSamples: number;
  byField: Record<string, { passing: number; failing: number; warning: number }>;
  /** Map of field -> per-sample selector samples (used by the UI to
   *  render the per-field validation table and image previews). */
  samples: SelectorSample[];
  /** True when at least `MIN_IMAGE_APPROVAL_SAMPLES` samples passed
   *  for `imagesSelector`. The UI uses this to gate the image
   *  approval checkbox. */
  readyForImageApproval: boolean;
  /** True when at least one text field has 2+ passing samples. */
  textFieldsHaveStrongEvidence: boolean;
  /** True when at least one text field has 1+ passing sample. */
  textFieldsHaveLimitedEvidence: boolean;
}

const EMPTY_FIELD_TALLY = {
  passing: 0,
  failing: 0,
  warning: 0,
};

function tally(): ValidationRunResult['byField'] {
  // Dynamic: build from the canonical field catalog.
  // Returns a flat map of fieldKey -> tally for all promotable fields.
  // The caller adds custom field entries as needed.
  return {};
}

/**
 * Validate a revision's selector set across the confirmed
 * same-domain samples. Writes one `profile_generation_validation_results`
 * row per (field, sample) pair. Returns a summary the UI can
 * consume to decide whether approval is unlocked for each field.
 */
export async function validateRevisionAcrossConfirmedSamples(
  revisionId: string,
  domain: string,
  options: { sampleLimit?: number } = {},
): Promise<ValidationRunResult> {
  const revision = findProfileGenerationRevisionById(revisionId);
  if (!revision) {
    return {
      revisionId,
      sampleCount: 0,
      passingSamples: 0,
      failingSamples: 0,
      warningSamples: 0,
      byField: tally(),
      samples: [],
      readyForImageApproval: false,
      textFieldsHaveStrongEvidence: false,
      textFieldsHaveLimitedEvidence: false,
    };
  }

  const limit = Math.max(1, Math.min(MAX_VALIDATION_SAMPLES, options.sampleLimit ?? 5));
  const samples = listValidationSamplesByDomain(domain, limit);

  if (samples.length === 0) {
    return {
      revisionId,
      sampleCount: 0,
      passingSamples: 0,
      failingSamples: 0,
      warningSamples: 0,
      byField: tally(),
      samples: [],
      readyForImageApproval: false,
      textFieldsHaveStrongEvidence: false,
      textFieldsHaveLimitedEvidence: false,
    };
  }

  const selectors = (revision.selectors ?? {}) as Record<string, unknown>;
  const fieldSamples: SelectorSample[] = [];
  const results: ValidationRunResult['byField'] = tally();

  // Build the set of fields to validate: use revision's actual selectors
  // so dynamic/custom fields are included automatically.
  const fieldsToValidate = new Set<string>();
  for (const key of Object.keys(selectors)) {
    const val = selectors[key];
    if (val !== null && val !== undefined && !['shopifyJSONPath', 'variantSelectionStrategy'].includes(key)) {
      fieldsToValidate.add(key);
    }
  }

  let passingSamples = 0;
  let failingSamples = 0;
  let warningSamples = 0;

  for (const sample of samples) {
    const html = await fetchSampleHtml(sample.url);
    if (!html) {
      failingSamples++;
      for (const field of fieldsToValidate) {
        if (!results[field]) results[field] = { passing: 0, failing: 0, warning: 0 };
        results[field].failing++;
        fieldSamples.push({
          field,
          sampleUrl: sample.url,
          itemId: sample.itemId,
          expectedName: sample.expectedName,
          brandHint: sample.brandHint,
          extractedText: null,
          extractedImages: [],
          warnings: ['Sample HTML could not be fetched'],
          status: 'fail',
        });
      }
      continue;
    }

    for (const field of fieldsToValidate) {
      if (!results[field]) results[field] = { passing: 0, failing: 0, warning: 0 };
      const selectorValue = typeof selectors[field] === 'string' ? selectors[field] as string : null;
      const result = await evaluateSelectorOnSample(
        field,
        selectorValue,
        html,
        sample.url,
        sample.itemId,
        sample.expectedName,
        sample.brandHint,
      );
      fieldSamples.push(result);
      if (result.status === 'pass') results[field].passing++;
      else if (result.status === 'warning') results[field].warning++;
      else results[field].failing++;
    }
  }

  // Use SELECTOR_KEYS for the broad classification; add custom field keys
  const allKeySet = new Set([...SELECTOR_KEYS, ...fieldsToValidate]);
  for (const field of allKeySet) {
    if (!results[field]) {
      results[field] = { passing: 0, failing: 0, warning: 0 };
      continue;
    }
    const tally = results[field];
    if (tally.passing > 0 && tally.failing === 0 && tally.warning === 0) passingSamples++;
    else if (tally.failing > 0) failingSamples++;
    else if (tally.warning > 0) warningSamples++;
  }

  // Persist the per-field/per-sample rows. Use a new revision's
  // `field_samples_json` plus the persistent validation_results
  // table for queryable evidence.
  insertRevisionValidationResults(
    revisionId,
    fieldSamples.map((s) => ({
      revisionId,
      selectorField: s.field,
      sampleUrl: s.sampleUrl,
      itemId: s.itemId,
      expectedName: s.expectedName,
      brandHint: s.brandHint,
      extractedValue: s.field === 'imagesSelector'
        ? { images: s.extractedImages }
        : { text: s.extractedText },
      imagePreviews: s.field === 'imagesSelector' ? s.extractedImages : null,
      warnings: s.warnings.length > 0 ? s.warnings : null,
      status: s.status,
    })),
  );

  updateProfileGenerationRevisionStatus(revisionId, 'validated', {
    validationSummary: {
      sampleCount: samples.length,
      passingSamples,
      failingSamples,
      warningSamples,
      byField: results,
    },
  });

  const readyForImageApproval =
    results.imagesSelector.passing >= MIN_IMAGE_APPROVAL_SAMPLES &&
    results.imagesSelector.failing === 0;
  const textFieldsHaveStrongEvidence = ['titleSelector', 'descriptionSelector'].some(
    (f) => results[f as SelectorKey].passing >= 2,
  );
  const textFieldsHaveLimitedEvidence = ['titleSelector', 'descriptionSelector'].some(
    (f) => results[f as SelectorKey].passing >= 1,
  );

  return {
    revisionId,
    sampleCount: samples.length,
    passingSamples,
    failingSamples,
    warningSamples,
    byField: results,
    samples: fieldSamples,
    readyForImageApproval,
    textFieldsHaveStrongEvidence,
    textFieldsHaveLimitedEvidence,
  };
}

// ─── Revise from structured store-manager feedback ──────────────────────────

/**
 * Apply structured store-manager feedback to a generation and create
 * a new revision. This is a UI-friendly path: the operator does not
 * need to know CSS. The service:
 *
 *  1. Loads the latest validated revision (or creates one from the
 *     legacy generation payload if none exists yet).
 *  2. Stores the operator's feedback verbatim in the new revision's
 *     `feedback_json` column.
 *  3. Increments the revision number and links the new row to the
 *     parent revision for history traversal.
 *  4. Leaves `selectors_json` unchanged for now; the next manual or
 *     LLM revision pass will rewrite it. Marking the new row
 *     `source = 'manager_feedback'` is enough for the UI to surface
 *     "feedback pending" in the review drawer.
 *
 * The service deliberately does **not** call the LLM here. A future
 * pass (or a follow-up route) will run `profile_revision` against
 * the new revision's feedback and replace its `selectors_json` with
 * the AI-revised selector set. Keeping the two steps split lets the
 * operator preview feedback without committing to a new model call.
 */
export function reviseProfileFromStructuredFeedback(input: {
  generationId: string;
  parentRevisionId?: string | null;
  feedback: StructuredFeedback;
  notes?: string | null;
}): ProfileGenerationRevision | null {
  const generation = findProfileGenerationById(input.generationId);
  if (!generation) return null;

  // Ensure the parent revision exists. If the generation was created
  // before revisions landed, synthesize revision 1 from the legacy
  // payload.
  const existing = listRevisionsByGeneration(input.generationId);
  let parentRevision: ProfileGenerationRevision | null = null;
  if (input.parentRevisionId) {
    const explicit = findProfileGenerationRevisionById(input.parentRevisionId);
    parentRevision = (explicit as unknown as ProfileGenerationRevision | null) ?? null;
  } else if (existing.length > 0) {
    const latest = findLatestValidatedRevision(input.generationId) ?? existing[0];
    parentRevision = latest as unknown as ProfileGenerationRevision;
  } else {
    const created = createInitialRevisionForGeneration(input.generationId);
    parentRevision = created;
  }
  if (!parentRevision) return null;

  const nextNumber = parentRevision.revisionNumber + 1;
  const inserted = insertProfileGenerationRevision({
    generationId: input.generationId,
    revisionNumber: nextNumber,
    parentRevisionId: parentRevision.id,
    source: 'manager_feedback',
    selectors: parentRevision.selectors,
    feedback: input.feedback as unknown as Record<string, unknown>,
    fieldSamples: null,
    validationSummary: null,
    status: 'draft',
    confidence: parentRevision.confidence,
    llmTask: null,
    llmProvider: null,
    llmModel: null,
    errorMessage: input.notes ?? null,
  });

  const result = inserted as unknown as ProfileGenerationRevision;

  // If the revision was created and the notes contain a manual selector
  // hint, apply it immediately to the revision's selectors_json.
  const notes = input.notes ?? '';
  const manualSelectorMatch = notes.match(/Advanced selector hint:\s*(.+)/);
  if (manualSelectorMatch && manualSelectorMatch[1]) {
    const manualSelector = manualSelectorMatch[1].trim();
    if (manualSelector && isSupportedSelectorSyntax(manualSelector)) {
      // Determine which field this revision targets from the feedback kind.
      let targetField: string | null = null;
      const feedback = input.feedback;
      if (feedback.kind === 'text' && 'field' in feedback) {
        targetField = (feedback as { field: string }).field;
      } else if (feedback.kind === 'images') {
        targetField = 'imagesSelector';
      }
      if (targetField) {
        const updatedSelectors = { ...(parentRevision.selectors ?? {}) };
        updatedSelectors[targetField] = manualSelector;
        // Update the DB row and the in-memory object
        updateRevisionSelectors(result.id, updatedSelectors, {
          status: 'draft',
        });
        result.selectors = updatedSelectors;
        result.source = 'manual_css';
      }
    }
  }

  return result;
}

// ─── Approve / reject / rollback ──────────────────────────────────────────────

export interface ApproveRevisionFieldsInput {
  generationId: string;
  approvedFields: ApprovedSelectorFields;
  notes?: string | null;
  decidedBy?: string | null;
  imagePreviewsReviewed?: boolean;
}

export interface ApproveRevisionFieldsResult {
  promotionResult: PromotionResult;
  /** True when the operator's image-approval request was honored
   *  (or images were not approved). False when the operator asked
   *  to approve `imagesSelector` without preview attestation or
   *  without at least two passing validation samples. */
  imageApprovalAccepted: boolean;
}

/**
 * Approve selected selector fields for a generation. This is the
 * single governance gate for writing selectors to `extractor_profiles`.
 *
 * The promoter (`promoteGeneratedProfile`) enforces per-field
 * approval and the merge-style upsert. This service adds two more
 * governance gates on top:
 *
 *   - If `imagesSelector` is set to `true`, the image approval is
 *     **rejected** (treated as a no-op) unless the operator checked
 *     `imagePreviewsReviewed` and the latest validated revision has
 *     at least `MIN_IMAGE_APPROVAL_SAMPLES` passing image results and
 *     zero failing image results. Other fields are still approved.
 *
 *   - Each approved field is also written to the
 *     `profile_generation_field_decisions` table with
 *     `validationResultIds` referencing the most recent
 *     `profile_generation_validation_results` for that field. The
 *     rollback service uses this history to restore the prior value.
 */
export function approveRevisionFields(
  input: ApproveRevisionFieldsInput,
): ApproveRevisionFieldsResult {
  const { generationId, approvedFields, imagePreviewsReviewed, notes, decidedBy } = input;

  const wantsImageApproval = approvedFields.imagesSelector === true;
  const latestRevision = findLatestValidatedRevision(generationId);
  const latestValidationResults = latestRevision
    ? listValidationResultsByRevision(latestRevision.id)
    : [];
  const imageResults = latestValidationResults.filter((r) => r.selectorField === 'imagesSelector');
  const passingImageSamples = imageResults.filter((r) => r.status === 'pass').length;
  const failingImageSamples = imageResults.filter((r) => r.status === 'fail').length;
  const hasEnoughImageEvidence =
    passingImageSamples >= MIN_IMAGE_APPROVAL_SAMPLES && failingImageSamples === 0;
  const imageApprovalAccepted = !wantsImageApproval || (
    imagePreviewsReviewed === true && hasEnoughImageEvidence
  );
  const safeApprovedFields: ApprovedSelectorFields = {
    ...approvedFields,
  };
  if (wantsImageApproval && !imageApprovalAccepted) {
    safeApprovedFields.imagesSelector = false;
  }

  const promotionResult = promoteGeneratedProfile(generationId, safeApprovedFields);

  // Capture validation result IDs per approved field for the audit
  // trail. Pull the most recent revision's most recent validation
  // results for that field. This is a best-effort join; the
  // promotion_result already records that a write happened.
  if (latestRevision && promotionResult.approvedFields.length > 0) {
    const idsByField = new Map<string, string[]>();
    for (const r of latestValidationResults) {
      if (!idsByField.has(r.selectorField)) idsByField.set(r.selectorField, []);
      idsByField.get(r.selectorField)!.push(r.id);
    }
    for (const field of promotionResult.approvedFields) {
      // The promoter already inserted an `approved` decision row.
      // We append a parallel `feedback` decision row that links the
      // field to its validation result IDs. This is a soft-link:
      // the promoter's decision is the source of truth for the
      // active profile write; the new row adds the validation
      // evidence so the governance UI can show "approved after
      // validated against N samples".
      const ids = idsByField.get(field) ?? null;
      if (ids && ids.length > 0) {
        try {
          insertProfileFieldDecision({
            generationId,
            revisionId: latestRevision.id,
            domain: promotionResult.domain,
            selectorField: field,
            decision: 'approved',
            previousSelector: null,
            proposedSelector: null,
            approvedSelector: null,
            feedback: { validationResultIds: ids, imagePreviewsReviewed: imagePreviewsReviewed === true },
            validationResultIds: ids,
            decidedBy: decidedBy ?? null,
            notes: notes ?? null,
          });
        } catch {
          /* best-effort audit */
        }
      }
    }
  }

  if (wantsImageApproval && !imageApprovalAccepted) {
    return {
      promotionResult: { ...promotionResult, rejectedFields: Array.from(new Set([...promotionResult.rejectedFields, 'imagesSelector'])) },
      imageApprovalAccepted: false,
    };
  }

  return { promotionResult, imageApprovalAccepted: true };
}

export interface RejectRevisionFieldsInput {
  generationId: string;
  rejectedFields: SelectorKey[];
  reason?: string | null;
  notes?: string | null;
  decidedBy?: string | null;
}

export interface RejectRevisionFieldsResult {
  rejectedFields: SelectorKey[];
  decisionIds: string[];
}

/**
 * Reject selected selector fields. Records a `rejected` decision row
 * for each field. Does **not** modify `extractor_profiles`.
 */
export function rejectRevisionFields(
  input: RejectRevisionFieldsInput,
): RejectRevisionFieldsResult {
  const generation = findProfileGenerationById(input.generationId);
  if (!generation) {
    return { rejectedFields: [], decisionIds: [] };
  }
  const decisionIds: string[] = [];
  for (const field of input.rejectedFields) {
    const decision = insertProfileFieldDecision({
      generationId: input.generationId,
      revisionId: null,
      domain: generation.domain,
      selectorField: field,
      decision: 'rejected',
      previousSelector: null,
      proposedSelector: null,
      approvedSelector: null,
      feedback: { reason: input.reason ?? null },
      validationResultIds: null,
      decidedBy: input.decidedBy ?? null,
      notes: input.notes ?? input.reason ?? null,
    });
    decisionIds.push(decision.id);
  }
  return {
    rejectedFields: input.rejectedFields.slice(),
    decisionIds,
  };
}

export interface RollbackProfileFieldInput {
  decisionId?: string;
  domain?: string;
  selectorField?: SelectorKey;
  notes?: string | null;
  decidedBy?: string | null;
}

export interface RollbackProfileFieldResult extends RollbackResult {}

/**
 * Roll back a previously approved field. The caller may supply either
 * a `decisionId` (the most common path: the UI knows which row to
 * undo) or a `domain + selectorField` pair (the convenience path
 * "rollback the latest approved title for this domain").
 */
export function rollbackProfileFieldBy(
  input: RollbackProfileFieldInput,
): RollbackProfileFieldResult {
  let result: RollbackResult;
  if (input.decisionId) {
    result = rollbackProfileField(input.decisionId);
  } else if (input.domain && input.selectorField) {
    result = rollbackLatestApprovedField(input.domain, input.selectorField);
  } else {
    return {
      rolledBack: false,
      reason: 'Provide either decisionId or domain + selectorField',
      domain: input.domain ?? '',
      selectorField: input.selectorField ?? '',
      decisionId: input.decisionId ?? '',
      restoredSelector: null,
    };
  }

  // Annotate the rollback decision with the operator's notes when
  // provided. The promoter already inserted the base `rolled_back`
  // decision row; we append an additional `feedback` decision row
  // to capture the operator's notes.
  if (result.rolledBack && (input.notes || input.decidedBy)) {
    try {
      insertProfileFieldDecision({
        generationId: '',
        revisionId: null,
        domain: result.domain,
        selectorField: result.selectorField as SelectorKey,
        decision: 'rolled_back',
        previousSelector: result.restoredSelector,
        proposedSelector: null,
        approvedSelector: null,
        feedback: { notes: input.notes ?? null },
        validationResultIds: null,
        decidedBy: input.decidedBy ?? null,
        notes: input.notes ?? null,
      });
    } catch {
      /* best-effort audit */
    }
  }

  return result;
}

// ─── Generation status transitions (governance service owns the lifecycle) ─

/**
 * Mark a generation as `validated`. Called after the operator (or the
 * page-extractor's in-memory audit path) has produced a proposal that
 * the service considers validated. The generation status is
 * independent of the `promoted` status — promotion is recorded on
 * the field-decision rows.
 */
function markGenerationValidated(
  generationId: string,
  options: { confidence?: number; errorMessage?: string | null } = {},
): void {
  updateProfileGenerationStatus(generationId, 'validated', {
    confidence: options.confidence,
    errorMessage: options.errorMessage ?? null,
  });
}

/**
 * Mark a generation as `rejected`. Called by the governance service
 * when validation explicitly fails or when the operator rejects
 * the proposal wholesale.
 */
function markGenerationRejected(
  generationId: string,
  errorMessage: string,
): void {
  updateProfileGenerationStatus(generationId, 'rejected', { errorMessage });
}

/** Re-export the list of all active profiles for the UI. */
// fallow-ignore-next-line unused-export
export function listAllActiveProfiles(): ExtractorProfile[] {
  return listAllProfiles() as ExtractorProfile[];
}

/** Re-export the per-generation decision history. */
export function listFieldDecisionsForGeneration(generationId: string): ProfileGenerationFieldDecision[] {
  const generation = findProfileGenerationById(generationId);
  if (!generation) return [];
  const raw = listFieldDecisionsByDomain(generation.domain) as unknown as RepoProfileGenerationFieldDecision[];
  return raw
    .filter((d) => d.generationId === generationId)
    .map((d) => ({
      id: d.id,
      generationId: d.generationId,
      revisionId: d.revisionId,
      domain: d.domain,
      selectorField: d.selectorField as ProfileGenerationFieldDecision['selectorField'],
      decision: d.decision as ProfileGenerationFieldDecision['decision'],
      previousSelector: d.previousSelector,
      proposedSelector: d.proposedSelector,
      approvedSelector: d.approvedSelector,
      feedback: d.feedback as Record<string, unknown> | null,
      validationResultIds: d.validationResultIds,
      decidedAt: d.decidedAt,
      decidedBy: d.decidedBy,
      notes: d.notes,
    }));
}

/** Re-export a per-revision view of validation results for the UI. */
export function listValidationResultsForRevision(revisionId: string): ProfileGenerationValidationResult[] {
  return listValidationResultsByRevision(revisionId) as unknown as ProfileGenerationValidationResult[];
}

// ─── Build-canvas per-field governance helpers (story: e06s03) ───────────────
// Re-export pure helpers to keep governance service as single authority.
export { isFieldDecisionPending, canSaveProfile } from './profile-governance-helpers';
