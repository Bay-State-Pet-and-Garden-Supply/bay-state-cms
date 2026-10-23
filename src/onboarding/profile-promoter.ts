/**
 * Promotion path for LLM-generated selector profiles.
 *
 * Separated from `profile-generator.ts` so the generation module can
 * stay a pure, DB-free module that tests run cleanly under vitest
 * (vitest cannot load `bun:sqlite`). The promoter is DB-dependent and
 * is exercised by tests that initialize a real SQLite database.
 *
 * # Hard product invariant (do not break)
 *
 * AI-generated profiles **never** auto-promote. Promotion always
 * requires an explicit, per-selector-field approval object passed by a
 * human operator (typically via a review UI). Even with perfect
 * confidence, even with high validation, even when a field is
 * structurally simple, no field is written to `extractor_profiles`
 * without that operator-supplied approval. Images are especially
 * uncertain and require explicit opt-in.
 *
 * Approval is per field. The same generation row can be approved for
 * the title selector and rejected for the images selector in separate
 * calls. Each call writes only the fields explicitly set to `true` in
 * the approval object.
 *
 * Every approved field and every rollback produces a row in
 * `profile_generation_field_decisions` so the governance UI can show a
 * full per-field history with rollback capability.
 */

import {
  findProfileGenerationById,
} from '../db/repositories/profile-generation-repo';
import {
  findProfileByDomain,
  upsertProfile,
} from '../db/repositories/extractor-profile-repo';
import {
  findLatestValidatedRevision,
  type ProfileGenerationRevision,
} from '../db/repositories/profile-generation-revision-repo';
import {
  insertProfileFieldDecision,
  findProfileFieldDecisionById,
  findLatestApprovedFieldDecision,
  type ProfileGenerationFieldDecision,
  type ProfileGenerationFieldDecisionType,
} from '../db/repositories/profile-generation-field-decision-repo';
import { PROMOTABLE_PROFILE_KEYS, getFieldByKey, hasDedicatedColumn } from '../shared/profile-fields';
import type { GeneratedSelectorProfile } from './profile-generator';

/**
 * The set of selector field keys that can be approved or rejected.
 *
 * This replaces the legacy SELECTOR_KEYS with the canonical field
 * catalog from src/shared/profile-fields.ts. Price selectors are excluded;
 * legacy DB columns remain available only for backward compatibility.
 */
export const SELECTOR_KEYS: readonly string[] = PROMOTABLE_PROFILE_KEYS;

export type SelectorKey = string;

/**
 * Per-selector-field approval. A value of `true` means the operator
 * approves writing that field to `extractor_profiles`. A value of
 * `false` (or omission) means the field is rejected and will not be
 * written. Omitted keys are treated as `false`.
 *
 * In addition to the standard keys (`titleSelector`, `descriptionSelector`,
 * `imagesSelector`), arbitrary custom field names can be approved and
 * will be written into the profile's `customSelectors` map.
 *
 * Example:
 *   { titleSelector: true, descriptionSelector: true, imagesSelector: false, Size: true, Flavor: false }
 */
export type ApprovedSelectorFields = Partial<Record<string, boolean>>;

/** Result of a `promoteGeneratedProfile` call. */
export interface PromotionResult {
  promoted: boolean;
  reason: string;
  domain: string;
  generationId: string;
  /** Field-level outcome: which keys were written, which were rejected. */
  approvedFields: string[];
  rejectedFields: string[];
  /**
   * IDs of the per-field `profile_generation_field_decisions` rows that
   * were inserted for this call. Approval IDs can be passed to
   * `rollbackProfileField` to revert a specific field.
   */
  approvalDecisionIds: string[];
  /**
   * IDs of the per-field decision rows recorded for explicit rejections.
   * Tracked separately from `approvalDecisionIds` so a UI can show
   * "Approved N, Rejected M" cleanly.
   */
  rejectionDecisionIds: string[];
}

function pickString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

/**
 * Dedicated DB column keys that have first-class storage in extractor_profiles.
 * Price is kept here only so legacy revisions are not mistaken for custom fields.
 */
const DEDICATED_COLUMN_KEYS = [
  'titleSelector',
  'titleOptionalSelectors',
  'priceSelector',
  'descriptionSelector',
  'brandSelector',
  'imagesSelector',
  'sitemapProductUrlPattern',
  'shopifyJSONPath',
];

function selectorsFromRevision(
  revision: ProfileGenerationRevision | null,
  fallback: Record<string, unknown> | null,
): GeneratedSelectorProfile & { customSelectors: Record<string, string> } {
  const source = revision?.selectors ?? fallback ?? {};
  const customSelectors: Record<string, string> = {};
  // Extract any keys that are not standard selector fields
  for (const [key, value] of Object.entries(source)) {
    if (!DEDICATED_COLUMN_KEYS.includes(key) && key !== 'variantSelectionStrategy') {
      const v = pickString(value);
      if (v) customSelectors[key] = v;
    }
  }
  return {
    titleSelector: pickString(source.titleSelector),
    descriptionSelector: pickString(source.descriptionSelector),
    brandSelector: pickString(source.brandSelector),
    imagesSelector: pickString(source.imagesSelector),
    sitemapProductUrlPattern: pickString(source.sitemapProductUrlPattern),
    shopifyJSONPath: (source.shopifyJSONPath as boolean) ?? false,
    variantSelectionStrategy: source.variantSelectionStrategy !== undefined
      ? (source.variantSelectionStrategy as unknown as GeneratedSelectorProfile['variantSelectionStrategy'])
      : null,
    customSelectors,
  };
}

/**
 * Resolve the selector candidates for a generation. Prefers the latest
 * validated revision (the actual current proposal under review), but
 * falls back to the legacy `profile_generations.selectors_json` payload
 * for rows that have not yet been migrated into revisions.
 */
function resolveSelectors(
  generationId: string,
  fallback: Record<string, unknown> | null,
): {
  selectors: GeneratedSelectorProfile;
  revisionId: string | null;
} {
  const revision = findLatestValidatedRevision(generationId);
  if (revision) {
    return { selectors: selectorsFromRevision(revision, null), revisionId: revision.id };
  }
  return { selectors: selectorsFromRevision(null, fallback), revisionId: null };
}

/**
 * Promote a validated profile generation by writing the **operator-
 * approved** selector fields into `extractor_profiles` and recording
 * per-field decision rows. The merge-style `upsertProfile` is used so
 * existing selectors that the caller did not approve are preserved.
 *
 * Safety guards (all must pass):
 *  1. The generation row must exist.
 *  2. `approvedFields` must be provided and must include at least one
 *     selector with value `true`. Otherwise the call is recorded as an
 *     approval-flow rejection and the row's status is preserved.
 *  3. Only selectors whose approval value is explicitly `true` are
 *     written. Anything else (false or omitted) is skipped.
 *  4. Only selectors that have a non-empty value in the resolved
 *     revision/generation payload are written. Approving a field that
 *     the generation never produced is a no-op (the operator is
 *     silently reclassified as a rejection so the UI stays honest).
 *  5. Per-field decision rows are written for every approved AND
 *     every rejected field. The `previous_selector` column captures
 *     the prior active profile value so rollback can restore it.
 *  6. The merge is `upsertProfile` (merge), never a full replacement
 *     — existing selectors that the caller did not approve are kept.
 *
 * On any failure the function returns `{ promoted: false, reason: ... }`
 * and per-field decision rows are still recorded for the audit trail.
 */
export function promoteGeneratedProfile(
  generationId: string,
  approvedFields: ApprovedSelectorFields,
): PromotionResult {
  // Normalize the approval object up front. We do this BEFORE any DB
  // lookup so a malformed call cannot pollute the audit log with a
  // misleading rejection.
  const requestedApproved: SelectorKey[] = [];
  const requestedRejected: SelectorKey[] = [];
  /** Implicit rejections: standard catalog fields the operator did not
   *  mention in the approval payload. These are recorded in the audit
   *  trail but NOT reported in `rejectedFields` (which only contains
   *  explicitly-rejected fields). */
  const implicitRejected: string[] = [];

  /** Build the public rejectedFields list by excluding implicit rejections. */
  const publicRejected = (arr: string[]): string[] =>
    arr.filter(k => !implicitRejected.includes(k));
  const approvedCustom: string[] = [];
  const rejectedCustom: string[] = [];

  if (approvedFields && typeof approvedFields === 'object') {
    // First pass: classify all explicitly mentioned keys
    for (const [key, v] of Object.entries(approvedFields)) {
      if (v === true) {
        // Check if it looks like a standard known field or a custom field
        if (getFieldByKey(key) && hasDedicatedColumn(key)) {
          requestedApproved.push(key);
        } else if (key === 'titleOptionalSelectors' || key === 'sitemapProductUrlPattern') {
          requestedApproved.push(key);
        } else {
          approvedCustom.push(key);
        }
      } else {
        if (getFieldByKey(key) || key === 'titleOptionalSelectors' || key === 'sitemapProductUrlPattern') {
          requestedRejected.push(key);
        } else {
          rejectedCustom.push(key);
        }
      }
    }
    // When the operator explicitly approved at least one field, add
    // unmentioned standard fields as implicit rejections so the audit
    // trail records that they were considered and not approved.
    // If the operator didn't approve anything, we skip implicit rejections
    // to avoid polluting the audit with hundreds of decisions the operator
    // never acted on.
    const hasExplicitApproval = Object.values(approvedFields).some(v => v === true);
    if (hasExplicitApproval) {
      for (const key of PROMOTABLE_PROFILE_KEYS) {
        if (!(key in approvedFields)) {
          requestedRejected.push(key);
          implicitRejected.push(key);
        }
      }
      // Also add sitemapProductUrlPattern and titleOptionalSelectors if not mentioned
      if (!('sitemapProductUrlPattern' in approvedFields)) {
        requestedRejected.push('sitemapProductUrlPattern');
        implicitRejected.push('sitemapProductUrlPattern');
      }
      if (!('titleOptionalSelectors' in approvedFields)) {
        requestedRejected.push('titleOptionalSelectors');
        implicitRejected.push('titleOptionalSelectors');
      }
    }
  }

  const generation = findProfileGenerationById(generationId);
  if (!generation) {
    return {
      promoted: false,
      reason: 'Generation row not found',
      domain: '',
      generationId,
      approvedFields: [],
      rejectedFields: requestedApproved.concat(publicRejected(requestedRejected)),
      approvalDecisionIds: [],
      rejectionDecisionIds: [],
    };
  }

  // Structural gate: generations in `proposed`/`rejected`/`failed`
  // status cannot be promoted. We mark the row `rejected` here so
  // the audit is honest about why nothing was written.
  if (generation.status === 'proposed') {
    const rejectionIds = recordFieldDecisions({
      generation,
      revisionId: null,
      decisions: requestedApproved.map((field) => ({
        selectorField: field,
        decision: 'rejected' as const,
        previousSelector: currentSelectorForField(generation.domain, field),
        proposedSelector: null,
        approvedSelector: null,
        notes: 'Generation was never validated; cannot promote',
      })),
    }).rejectionIds;
    updateGenerationStatusBestEffort(generationId, 'rejected', 'Generation was never validated; cannot promote');
    return {
      promoted: false,
      reason: 'Generation was never validated; cannot promote',
      domain: generation.domain,
      generationId,
      approvedFields: [],
      rejectedFields: requestedApproved,
      approvalDecisionIds: [],
      rejectionDecisionIds: rejectionIds,
    };
  }

  if (generation.status === 'rejected' || generation.status === 'failed') {
    return {
      promoted: false,
      reason: `Generation status is ${generation.status}; not promotable`,
      domain: generation.domain,
      generationId,
      approvedFields: requestedApproved,
      rejectedFields: publicRejected(requestedRejected),
      approvalDecisionIds: [],
      rejectionDecisionIds: [],
    };
  }

  if (requestedApproved.length === 0) {
    // No fields approved. This is an approval-flow rejection: the
    // generation itself is still valid, the operator simply has not
    // made a decision yet. We must NOT poison the row's status with a
    // 'rejected' label because a subsequent call with a real approval
    // must still be able to promote. The promoter does not own the
    // row's status in the new normalized model; status transitions
    // are owned by the governance service. We only record the audit
    // decisions.
    const rejectionIds = recordFieldDecisions({
      generation,
      revisionId: null,
      decisions: requestedRejected.map((field) => ({
        selectorField: field,
        decision: 'rejected' as const,
        previousSelector: currentSelectorForField(generation.domain, field),
        proposedSelector: null,
        approvedSelector: null,
        notes: 'No approval provided for this field',
      })),
    }).rejectionIds;
    return {
      promoted: false,
      reason: 'No selector fields were approved. Pass an approval object with at least one field set to true.',
      domain: generation.domain,
      generationId,
      approvedFields: [],
      rejectedFields: publicRejected(requestedRejected),
      approvalDecisionIds: [],
      rejectionDecisionIds: rejectionIds,
    };
  }

  const { selectors, revisionId } = resolveSelectors(generationId, generation.selectors);

  // Structural gate: a generation without a title selector cannot be
  // promoted at all. The title is the only field the rest of the
  // extraction system treats as mandatory, so without it nothing
  // useful can be saved.
  if (!selectors.titleSelector) {
    const rejectionIds = recordFieldDecisions({
      generation,
      revisionId,
      decisions: requestedApproved.map((field) => ({
        selectorField: field,
        decision: 'rejected' as const,
        previousSelector: currentSelectorForField(generation.domain, field),
        proposedSelector: null,
        approvedSelector: null,
        notes: 'Generation has no titleSelector; cannot promote',
      })),
    }).rejectionIds;
    updateGenerationStatusBestEffort(generationId, 'rejected', 'Generation has no titleSelector; cannot promote');
    return {
      promoted: false,
      reason: 'Generation has no titleSelector; cannot promote',
      domain: generation.domain,
      generationId,
      approvedFields: requestedApproved,
      rejectedFields: publicRejected(requestedRejected),
      approvalDecisionIds: [],
      rejectionDecisionIds: rejectionIds,
    };
  }

  // Capture the previous (active) selectors for every approved field
  // BEFORE we write, so we can persist `previous_selector` in the
  // decision row. This is what rollback will use to restore.
  const previousActive = findProfileByDomain(generation.domain);
  const writeSelectors: Parameters<typeof upsertProfile>[1] = {};
  const customSelectorsAccum: Record<string, string> = {};
  const approvedFieldsWritten: SelectorKey[] = [];
  const customApprovedWritten: string[] = [];
  const fieldDecisions: Array<{
    selectorField: string;
    decision: ProfileGenerationFieldDecisionType;
    previousSelector: string | null;
    proposedSelector: string | null;
    approvedSelector: string | null;
    notes?: string;
  }> = [];

  // Handle standard fixed-key approvals
  for (const key of requestedApproved) {
    if (key === 'titleOptionalSelectors') {
      const proposed = selectors.titleOptionalSelectors ?? [];
      if (proposed.length > 0) {
        writeSelectors.titleOptionalSelectors = proposed;
        approvedFieldsWritten.push(key);
      } else {
        fieldDecisions.push({
          selectorField: key,
          decision: 'rejected',
          previousSelector: previousActive ? JSON.stringify(previousActive.titleOptionalSelectors) : null,
          proposedSelector: null,
          approvedSelector: null,
          notes: 'Title optional selectors approved but proposal produced empty array',
        });
      }
    } else if (key === 'sitemapProductUrlPattern') {
      const proposed = selectors.sitemapProductUrlPattern ?? null;
      if (proposed) {
        writeSelectors.sitemapProductUrlPattern = proposed;
        approvedFieldsWritten.push(key);
      } else {
        fieldDecisions.push({
          selectorField: key,
          decision: 'rejected',
          previousSelector: previousActive?.sitemapProductUrlPattern ?? null,
          proposedSelector: null,
          approvedSelector: null,
          notes: 'Sitemap pattern approved but proposal did not produce a value',
        });
      }
    } else {
      const selectorsRecord = selectors as unknown as Record<string, string | null>;
      const proposed = selectorsRecord[key];
      if (proposed) {
        // Use a type-safe approach: cast writeSelectors to a general record
        const writeRecord = writeSelectors as unknown as Record<string, string | string[] | boolean | null | undefined>;
        writeRecord[key] = proposed;
        approvedFieldsWritten.push(key);
      } else {
        fieldDecisions.push({
          selectorField: key,
          decision: 'rejected',
          previousSelector: previousActive
            ? (previousActive as unknown as Record<string, string | null>)[key] ?? null
            : null,
          proposedSelector: null,
          approvedSelector: null,
          notes: 'Operator approved the field but the proposal did not produce a value',
        });
      }
    }
  }

  // Handle custom field approvals
  for (const key of approvedCustom) {
    const proposed = selectors.customSelectors?.[key] ?? null;
    if (proposed) {
      customSelectorsAccum[key] = proposed;
      customApprovedWritten.push(key);
    } else {
      fieldDecisions.push({
        selectorField: key,
        decision: 'rejected',
        previousSelector: null,
        proposedSelector: null,
        approvedSelector: null,
        notes: 'Custom field approved but no selector value was found in the revision',
      });
    }
  }

  // Handle custom field rejections
  for (const key of rejectedCustom) {
    fieldDecisions.push({
      selectorField: key,
      decision: 'rejected',
      previousSelector: null,
      proposedSelector: null,
      approvedSelector: null,
      notes: 'Operator rejected this custom field',
    });
  }

  // Always include shopifyJSONPath when promoting
  writeSelectors.shopifyJSONPath = selectors.shopifyJSONPath;

  // Include custom selectors if any were approved
  if (Object.keys(customSelectorsAccum).length > 0) {
    writeSelectors.customSelectors = customSelectorsAccum;
  }

  // Record explicit rejections (fields the operator explicitly set to false)
  // AND implicit rejections (catalog fields not mentioned). Both are written
  // only when we actually wrote at least one field (to avoid polluting the
  // audit trail for empty approvals).
  for (const key of requestedRejected) {
    const isImplicit = implicitRejected.includes(key);
    fieldDecisions.push({
      selectorField: key,
      decision: 'rejected',
      previousSelector: previousActive ? ((previousActive as unknown as Record<string, string | null>)[key] ?? null) : null,
      proposedSelector: null,
      approvedSelector: null,
      notes: 'Operator did not approve this field',
    });
  }

  if (approvedFieldsWritten.length === 0 && customApprovedWritten.length === 0) {
    // Every approved field was a no-op. Record all the rejection
    // decisions and return without writing.
    const ids = recordFieldDecisions({
      generation,
      revisionId,
      decisions: fieldDecisions,
    }).rejectionIds;
    return {
      promoted: false,
      reason:
        'Approved fields did not include any that the generation produced. Nothing to write.',
      domain: generation.domain,
      generationId,
      approvedFields: [],
      rejectedFields: publicRejected(SELECTOR_KEYS.slice()),
      approvalDecisionIds: [],
      rejectionDecisionIds: ids,
    };
  }

  try {
    upsertProfile(generation.domain, writeSelectors);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Record the approvals as structural rejections so the audit trail
    // is honest about what we tried to do and why it failed.
    const ids = recordFieldDecisions({
      generation,
      revisionId,
      decisions: fieldDecisions.map((d) => ({
        ...d,
        decision: 'rejected' as const,
        notes: `upsertProfile threw: ${reason}`,
      })),
    }).rejectionIds;
    return {
      promoted: false,
      reason: `upsertProfile threw: ${reason}`,
      domain: generation.domain,
      generationId,
      approvedFields: [],
      rejectedFields: publicRejected(SELECTOR_KEYS.slice()),
      approvalDecisionIds: [],
      rejectionDecisionIds: ids,
    };
  }

  // Successful write: record approvals for the fields we wrote. The
  // rejection decisions were already collected above and should also
  // be persisted in the same atomic batch so the governance UI sees a
  // complete per-field picture for this operator action.
  const approvalDecisions = approvedFieldsWritten.map((field) => ({
    selectorField: field,
    decision: 'approved' as const,
    previousSelector: previousActive ? ((previousActive as unknown as Record<string, string | null>)[field] ?? null) : null,
    proposedSelector: (selectors as unknown as Record<string, string | null>)[field],
    approvedSelector: (selectors as unknown as Record<string, string | null>)[field],
  }));
  const allIds = recordFieldDecisions({
    generation,
    revisionId,
    decisions: [...approvalDecisions, ...fieldDecisions],
  });

  // Mark the parent generation row as promoted so the audit row
  // reflects that a promotion (partial or full) has happened. We do
  // this last so a failed write does not falsely mark the row.
  try {
    const { updateProfileGenerationStatus } = require('../db/repositories/profile-generation-repo');
    updateProfileGenerationStatus(generationId, 'promoted', {
      promotedAt: new Date().toISOString(),
    });
  } catch {
    /* profile was written; best-effort audit update */
  }

  return {
    promoted: true,
    reason: `Promoted ${approvedFieldsWritten.length} fixed field(s) and ${customApprovedWritten.length} custom field(s): ${[...approvedFieldsWritten, ...customApprovedWritten].join(', ')}`,
    domain: generation.domain,
    generationId,
    approvedFields: [...approvedFieldsWritten, ...customApprovedWritten],
    rejectedFields: [
      ...SELECTOR_KEYS.filter((k) => !approvedFieldsWritten.includes(k)),
      ...rejectedCustom,
    ],
    approvalDecisionIds: allIds.approvalIds,
    rejectionDecisionIds: allIds.rejectionIds,
  };
}

/** Read the currently active selector for a domain + field, if any. */
function currentSelectorForField(
  domain: string,
  selectorField: SelectorKey,
): string | null {
  const profile = findProfileByDomain(domain);
  if (!profile) return null;
  // Handle custom selectors (stored under customSelectors)
  if (getFieldByKey(selectorField) && !hasDedicatedColumn(selectorField)) {
    return profile.customSelectors[selectorField] ?? null;
  }
  // Handle dedicated column fields
  return (profile as unknown as Record<string, unknown>)[selectorField] as string | null ?? null;
}

/**
 * Best-effort helper to update the legacy `profile_generations` row's
 * status when a structural rejection happens. The normalized
 * `profile_generation_field_decisions` table is the source of truth
 * for per-field audit; the legacy status column is kept in sync for
 * backward compatibility with existing UIs/tests. The update is
 * performed via a dynamic require so this module can stay free of
 * circular import risk between repo and promoter.
 */
function updateGenerationStatusBestEffort(
  generationId: string,
  status: 'rejected' | 'promoted',
  errorMessage: string | null,
): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { updateProfileGenerationStatus } = require('../db/repositories/profile-generation-repo');
    updateProfileGenerationStatus(generationId, status, errorMessage ? { errorMessage } : {});
  } catch {
    /* best-effort; the normalized decisions are the source of truth */
  }
}

interface RecordDecisionsArgs {
  generation: { id: string; domain: string };
  revisionId: string | null;
  decisions: Array<{
    selectorField: string;
    decision: ProfileGenerationFieldDecisionType;
    previousSelector: string | null;
    proposedSelector: string | null;
    approvedSelector: string | null;
    notes?: string;
  }>;
}

interface RecordDecisionsResult {
  approvalIds: string[];
  rejectionIds: string[];
}

function recordFieldDecisions(args: RecordDecisionsArgs): RecordDecisionsResult {
  const approvalIds: string[] = [];
  const rejectionIds: string[] = [];
  for (const d of args.decisions) {
    let inserted;
    try {
      inserted = insertProfileFieldDecision({
        generationId: args.generation.id,
        revisionId: args.revisionId,
        domain: args.generation.domain,
        selectorField: d.selectorField,
        decision: d.decision,
        previousSelector: d.previousSelector,
        proposedSelector: d.proposedSelector,
        approvedSelector: d.approvedSelector,
        notes: d.notes,
      });
    } catch {
      /* best-effort audit */
      continue;
    }
    if (d.decision === 'approved') approvalIds.push(inserted.id);
    else if (d.decision === 'rejected') rejectionIds.push(inserted.id);
    // rolled_back decisions are inserted by rollbackProfileField, not here
  }
  return { approvalIds, rejectionIds };
}

/**
 * Roll back a previously approved field decision by:
 *   1. Looking up the `previous_selector` captured at approval time
 *      (or `null` if there was no prior active selector).
 *   2. Writing that value (or null) into `extractor_profiles` for the
 *      target field only. Other selectors are untouched.
 *   3. Inserting a `rolled_back` decision row that links back to the
 *      approval that was reverted, so the governance UI can show the
 *      full lifecycle.
 *
 * If the decision ID is unknown, already rolled back, or the field has
 * changed since approval, the function still writes a `rolled_back`
 * decision row so the audit trail is complete; the caller can then
 * inspect the result to confirm the active profile state.
 */
export interface RollbackResult {
  rolledBack: boolean;
  reason: string;
  domain: string;
  selectorField: string;
  decisionId: string;
  restoredSelector: string | null;
}

export function rollbackProfileField(decisionId: string): RollbackResult {
  const decision = findProfileFieldDecisionById(decisionId);
  if (!decision) {
    return {
      rolledBack: false,
      reason: 'Decision not found',
      domain: '',
      selectorField: '',
      decisionId,
      restoredSelector: null,
    };
  }

  if (decision.decision !== 'approved') {
    return {
      rolledBack: false,
      reason: `Decision ${decisionId} is not an approval (decision=${decision.decision})`,
      domain: decision.domain,
      selectorField: decision.selectorField,
      decisionId,
      restoredSelector: null,
    };
  }

  const restoreValue = decision.previousSelector;

  try {
    upsertProfile(decision.domain, {
      [decision.selectorField]: restoreValue,
    } as Parameters<typeof upsertProfile>[1]);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      rolledBack: false,
      reason: `upsertProfile threw: ${reason}`,
      domain: decision.domain,
      selectorField: decision.selectorField,
      decisionId,
      restoredSelector: null,
    };
  }

  // Record the rollback. The "previous_selector" of the rollback row
  // is the value we just removed (the approved selector), so future
  // rollbacks can be chained.
  let rolledBackDecision: ProfileGenerationFieldDecision | null = null;
  try {
    rolledBackDecision = insertProfileFieldDecision({
      generationId: decision.generationId,
      revisionId: decision.revisionId,
      domain: decision.domain,
      selectorField: decision.selectorField,
      decision: 'rolled_back',
      previousSelector: decision.approvedSelector,
      proposedSelector: decision.proposedSelector,
      approvedSelector: null,
      notes: `Rolled back decision ${decisionId}`,
    });
  } catch {
    /* best-effort audit; the profile was already restored */
  }

  // Best-effort: keep the latest approved-decision lookup consistent
  // by clearing the audit field on the source row. We do not need to
  // block on this; the governance UI is the source of truth.
  void rolledBackDecision;

  return {
    rolledBack: true,
    reason: `Restored ${decision.selectorField} on ${decision.domain} to previous value`,
    domain: decision.domain,
    selectorField: decision.selectorField,
    decisionId,
    restoredSelector: restoreValue,
  };
}

/**
 * Convenience helper: find the most recent `approved` field decision
 * for a domain+selector combination and roll it back. Used by the
 * governance UI's "Rollback latest approved" button.
 */
export function rollbackLatestApprovedField(
  domain: string,
  selectorField: string,
): RollbackResult {
  const decision = findLatestApprovedFieldDecision(domain, selectorField);
  if (!decision) {
    return {
      rolledBack: false,
      reason: `No approved decision found for ${selectorField} on ${domain}`,
      domain,
      selectorField,
      decisionId: '',
      restoredSelector: null,
    };
  }
  return rollbackProfileField(decision.id);
}
