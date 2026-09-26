/**
 * Curation target processor coordinator.
 *
 * Combines the resolver → matcher → ranker → proposal builder pipeline
 * for each target kind. This is the "glue" that the thin stage wrappers
 * delegate to, so stage files contain orchestration only — no duplication
 * of matching, ranking, or proposal construction logic.
 */
import type { StageContext, StageInput, CoordinatedPageMemberValue } from './types';
import type { ClassificationProposal } from '../shared/schemas/classification';
import { CohortPageOutputSchema } from '../shared/schemas/cohorts';
import { loadClassificationConfig } from './config-loader';
import {
  resolveEnabledTargets,
  type ResolvedTarget,
} from './curation-target-resolver';
import {
  buildEvidenceTargetPacket,
  buildPageEvidencePacket,
  evidenceMatchesTarget,
  tokenGroundingSupport,
} from './evidence-targeting';
import type { CalibratedThresholds } from './confidence-calibrator';
import { buildModelCallContext } from './runtime-snapshot';
import { modelPolicyViewFromConfig } from '../onboarding/model-policy-snapshot';
import type { ModelPolicyConfigV2 } from '../shared/schemas/classification';
import {
  buildProductTypeProposal,
  buildFieldAssignmentProposal,
  buildCategoryPageProposal,
} from './curation-target-proposal';
import {
  buildPageHierarchy,
  extractProductContext,
} from './page-assignment-llm';
import { coordinateCohortPagesOnce } from './cohort-page-proposal-engine';
import {
  resolveAttributeDecision,
  batchResolveAttributeDecisions,
  buildProposalFromAttributeDecision,
} from './attribute-decision';
import {
  resolvePageDecision,
  buildProposalsFromPageDecision,
} from './page-decision';

// ─── Shared Target Constants ──────────────────────────────────────────────────

/**
 * Reviewed page-context source fields (issue #17 H): the Page stage uses only
 * identity/species/type/category context. Cross-species evidence is a
 * contradiction/rejection signal, never hidden concatenated text.
 */
const PAGE_CONTEXT_SOURCE_FIELDS = [
  'name',
  'title',
  'description',
  'page_name',
  'category',
  'species',
  'productForm',
  'productType',
  'brand',
  'resolved_brand',
];

/** Reviewed page-context attribute ids (records with explicit attributeId). */
const PAGE_CONTEXT_ATTRIBUTE_IDS = ['species', 'brand'];

/**
 * Reviewed species value for cross-species page-context detection. Uses a
 * REVIEWED fact (accepted decision carried in the snapshot), never
 * first-evidence order: reversing evidence order must not change which
 * species is labeled contradictory. Without a reviewed fact, no species
 * contradiction can be labeled.
 */
function reviewedSpeciesValue(context: StageContext): unknown {
  const facts = context.snapshot?.reviewedFacts ?? [];
  const speciesFact = facts.find(f => f.targetId === 'species');
  return speciesFact?.value ?? undefined;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TargetProcessResult {
  proposals: ClassificationProposal[];
  message: string;
}

// ─── Product Type Processing ──────────────────────────────────────────────────

/**
 * Process a product type curation target.
 *
 * Uses keyword matching against evidence first, then falls back to
 * the LLM ranker if no confident match is found.
 */
export async function processProductTypeTarget(
  target: ResolvedTarget,
  input: StageInput,
  context: StageContext,
): Promise<TargetProcessResult> {
  const modelPolicy = context.snapshot
    ? modelPolicyViewFromConfig(
        context.snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
        context.snapshot.snapshotHash,
      )
    : null;

  const { resolveProductTypeDecision } = await import('./product-type-decision');
  const decision = await resolveProductTypeDecision({
    target,
    evidence: input.evidence,
    sku: input.sku,
    runId: context.runId,
    snapshot: context.snapshot,
    modelPolicy,
    assertHeld: context.assertHeld,
  });

  if (decision.status === 'abstained' || !decision.productTypeId) {
    return {
      proposals: [],
      message:
        decision.abstentionReason ??
        `Abstained from proposing product type (${decision.abstentionCode ?? 'unresolved'}).`,
    };
  }

  const proposal = buildProductTypeProposal({
    runId: context.runId,
    sku: input.sku,
    productTypeId: decision.productTypeId,
    confidence: decision.confidence,
    evidenceIds: decision.evidenceIds,
    ...(decision.supportingEvidenceIds.length
      ? { supportingEvidenceIds: decision.supportingEvidenceIds }
      : {}),
    ...(decision.contradictingEvidenceIds.length
      ? { contradictingEvidenceIds: decision.contradictingEvidenceIds }
      : {}),
    snapshotHash: context.snapshot?.snapshotHash ?? null,
    ...(decision.modelCallIds.length ? { modelCallIds: decision.modelCallIds } : {}),
    derivation: decision.derivation,
  });

  const sourceLabel =
    decision.source === 'jev' ? 'TypeSafe Jev' : decision.source === 'llm' ? 'llm' : 'keyword';
  const label =
    target.options.find(o => o.value === decision.productTypeId)?.label ?? decision.productTypeId;
  return {
    proposals: [proposal],
    message: `${label} (${sourceLabel}, ${(decision.confidence * 100).toFixed(0)}%)`,
  };
}

// ─── Product Field Processing ─────────────────────────────────────────────────

/**
 * Process a product field (attribute) curation target.
 *
 * Uses alias + exact matching first, then LLM fallback.
 *
 * @param options.cardinality - Per-Product-Type cardinality from the accepted
 *   type's profile; overrides the global target selectionMode when supplied.
 * @param options.calibratedThresholds - P3 (plan B.P3.4): CALIBRATED review
 *   thresholds from a fitted calibration model. Absent/null (the default —
 *   no production fitted thresholds exist today) keeps bulk acceptance
 *   byte-identical to legacy: nothing becomes bulk-acceptable from
 *   confidence alone.
 */
export async function processProductFieldTarget(
  target: ResolvedTarget,
  input: StageInput,
  context: StageContext,
  options: { cardinality?: 'single' | 'multiple'; calibratedThresholds?: CalibratedThresholds | null } = {},
): Promise<TargetProcessResult> {
  const { config: targetConfig, options: targetOptions, attribute } = target;
  const selectionMode = options.cardinality ?? (targetConfig.selectionMode ?? 'single') as 'single' | 'multiple';
  const snapshotHash = context.snapshot?.snapshotHash ?? null;

  // ── Handle freeText and measured attributes (no controlled options required)
  if (attribute?.valueMode === 'freeText' || attribute?.valueMode === 'measured') {
    const attrId = targetConfig.attributeId ?? targetConfig.id;
    const catalogField = targetConfig.catalogField ?? null;
    // Evidence extraction stamps freeText values with the ATTRIBUTE id as
    // source_field ('brand'), while the curation target maps to a catalog
    // field (ProductField16) — accept BOTH shapes, plus explicit
    // attributeId-tagged records.
    const targetSourceFields = [catalogField, attrId].filter((f): f is string => Boolean(f));
    const fieldPacket = buildEvidenceTargetPacket(input.evidence, {
      attributeId: attrId,
      sourceField: null,
      sourceFields: targetSourceFields,
      selectionMode,
      aliases: attribute?.valueAliases ?? [],
      isGroundingSupport: tokenGroundingSupport,
    });
    const text = fieldPacket.promptText;
    if (!text || text.trim().length === 0) {
      return { proposals: [], message: `No evidence text for "${targetConfig.label}".` };
    }

    const grounded = input.evidence.find(
      e =>
        evidenceMatchesTarget(e, { attributeId: attrId, sourceField: null, sourceFields: targetSourceFields }) &&
        typeof e.value === 'string' &&
        e.value.trim().length > 0,
    );
    if (!grounded) {
      return {
        proposals: [],
        message: `No ${targetConfig.label} evidence on ${catalogField ?? attrId} — abstaining rather than inventing a value.`,
      };
    }
    const groundedValue = String(grounded.value);

    if (attribute.valueMode === 'freeText') {
      const extractedValue = groundedValue;
      const proposal = buildFieldAssignmentProposal({
        runId: context.runId,
        sku: input.sku,
        attributeId: targetConfig.attributeId ?? targetConfig.id,
        value: extractedValue,
        confidence: 0.85,
        evidenceIds: fieldPacket.evidenceIds,
        supportingEvidenceIds: fieldPacket.supportingEvidenceIds,
        contradictingEvidenceIds: fieldPacket.contradictingEvidenceIds,
        isMultiple: selectionMode === 'multiple',
        snapshotHash,
      });
      return { proposals: [proposal], message: `"${targetConfig.label}": ${extractedValue} (free-text, 85%)` };
    }

    // valueMode === 'measured'
    const rawVal = groundedValue;
    const valStr = String(rawVal).trim();
    const proposal = buildFieldAssignmentProposal({
      runId: context.runId,
      sku: input.sku,
      attributeId: targetConfig.attributeId ?? targetConfig.id,
      value: valStr,
      confidence: 0.85,
      evidenceIds: fieldPacket.evidenceIds,
      supportingEvidenceIds: fieldPacket.supportingEvidenceIds,
      contradictingEvidenceIds: fieldPacket.contradictingEvidenceIds,
      isMultiple: false,
      snapshotHash,
    });
    return { proposals: [proposal], message: `"${targetConfig.label}": ${valStr} (measured, 85%)` };
  }

  // ── Controlled attributes path (requires options list)
  if (!targetOptions || targetOptions.length === 0) {
    return { proposals: [], message: `No options available for "${targetConfig.label}".` };
  }

  const modelPolicy = context.snapshot
    ? modelPolicyViewFromConfig(
        context.snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
        context.snapshot.snapshotHash,
      )
    : null;

  const decision = await resolveAttributeDecision({
    target,
    cardinality: selectionMode,
    evidence: input.evidence,
    sku: input.sku,
    runId: context.runId,
    snapshot: context.snapshot,
    modelPolicy,
    assertHeld: context.assertHeld,
    productContext: {
      productType: context.cohortExecutionType?.id ?? null,
    },
  });

  const proposal = buildProposalFromAttributeDecision(
    decision,
    input.sku,
    context.runId,
    snapshotHash,
  );

  if (decision.status === 'abstained' || decision.status === 'failed' || (!decision.value && (!decision.values || decision.values.length === 0))) {
    return {
      proposals: [proposal],
      message: decision.abstentionReason ?? `Abstained from proposing attribute value (${decision.abstentionCode ?? 'unresolved'}).`,
    };
  }

  const sourceLabel =
    decision.source === 'jev'
      ? 'TypeSafe Jev'
      : decision.source === 'brand_resolved'
        ? 'resolved'
        : decision.source === 'keyword'
          ? 'keyword'
          : 'resolved';
  const displayVal = decision.values && decision.values.length > 0 ? decision.values.join(', ') : decision.value;
  return {
    proposals: [proposal],
    message: `"${targetConfig.label}": ${displayVal} (${sourceLabel}, ${(decision.confidence * 100).toFixed(0)}%)`,
  };
}

export interface ProcessProductFieldTargetsBatchResult {
  proposals: ClassificationProposal[];
  messages: string[];
}

/**
 * Process a batch of product field (attribute) curation targets.
 *
 * Dispatches via TypeSafe Jev System One when System One is active,
 * batching independent questions whose permitted evidence state is identical.
 * FreeText and measured attributes are handled directly.
 */
export async function processProductFieldTargetsBatch(
  items: Array<{ target: ResolvedTarget; cardinality?: 'single' | 'multiple' }>,
  input: StageInput,
  context: StageContext,
  options: { calibratedThresholds?: CalibratedThresholds | null } = {},
): Promise<ProcessProductFieldTargetsBatchResult> {
  if (items.length === 0) {
    return { proposals: [], messages: [] };
  }

  const modelPolicy = context.snapshot
    ? modelPolicyViewFromConfig(
        context.snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
        context.snapshot.snapshotHash,
      )
    : null;

  const allProposals: ClassificationProposal[] = [];
  const messages: string[] = [];
  const controlledItems: Array<{ target: ResolvedTarget; cardinality: 'single' | 'multiple' }> = [];

  for (const item of items) {
    const valMode = item.target.attribute?.valueMode;
    if (valMode === 'freeText' || valMode === 'measured') {
      const res = await processProductFieldTarget(item.target, input, context, {
        cardinality: item.cardinality,
        calibratedThresholds: options.calibratedThresholds,
      });
      allProposals.push(...res.proposals);
      if (res.message) messages.push(res.message);
    } else {
      controlledItems.push({
        target: item.target,
        cardinality: item.cardinality ?? (item.target.config.selectionMode as 'single' | 'multiple') ?? 'single',
      });
    }
  }

  if (controlledItems.length > 0) {
    const decisions = await batchResolveAttributeDecisions({
      items: controlledItems,
      evidence: input.evidence,
      sku: input.sku,
      runId: context.runId,
      snapshot: context.snapshot,
      modelPolicy,
      assertHeld: context.assertHeld,
      productContext: {
        productType: context.cohortExecutionType?.id ?? null,
      },
    });

    const snapshotHash = context.snapshot?.snapshotHash ?? null;
    for (const decision of decisions) {
      const targetItem = controlledItems.find(
        (ci) => (ci.target.config.attributeId ?? ci.target.config.id) === decision.targetId,
      );
      const targetLabel = targetItem?.target.config.label ?? decision.targetId;

      const proposal = buildProposalFromAttributeDecision(
        decision,
        input.sku,
        context.runId,
        snapshotHash,
      );
      allProposals.push(proposal);

      if (decision.status === 'resolved' && (decision.value !== null || (decision.values && decision.values.length > 0))) {
        const sourceLabel =
          decision.source === 'jev' ? 'TypeSafe Jev' : decision.source === 'brand_resolved' ? 'resolved' : 'keyword';
        const displayVal = decision.values && decision.values.length > 0 ? decision.values.join(', ') : decision.value;
        messages.push(`"${targetLabel}": ${displayVal} (${sourceLabel}, ${(decision.confidence * 100).toFixed(0)}%)`);
      } else {
        messages.push(decision.abstentionReason ?? `Abstained from proposing "${targetLabel}".`);
      }
    }
  }

  return { proposals: allProposals, messages };
}

// ─── Page Processing ──────────────────────────────────────────────────────────

/**
 * Process a category page curation target.
 *
 * Uses LLM-first page assignment with rich product context (VLM OCR data,
 * product type, web description, store page hierarchy). The LLM is given
 * structured product data and the full page tree so it can make informed
 * specificity- and species-aware decisions.
 *
 * Page options carry page ID as value and page name as label.
 * Both are passed to the proposal for identity-based promotion.
 */
export async function processPageTarget(
  target: ResolvedTarget,
  input: StageInput,
  context: StageContext,
): Promise<TargetProcessResult> {
  const { config: targetConfig, options } = target;
  const snapshotHash = context.snapshot?.snapshotHash ?? null;

  if (!options || options.length === 0) {
    return { proposals: [], message: `No options available for "${targetConfig.label}".` };
  }

  const selectionMode = (targetConfig.selectionMode ?? 'single') as 'single' | 'multiple';
  const maxPages = selectionMode === 'multiple' ? 5 : 1;

  // ── Build page hierarchy from FROZEN verified snapshot records ────────
  // Pure over the immutable Page snapshot; no DB reads during the stage.
  const pageHierarchy = buildPageHierarchy(
    options,
    context.snapshot?.pages.state === 'verified' ? context.snapshot.pages.records : [],
  );

  // ── Restricted page-evidence packet built ONCE before assignment: the full
  // run evidence never leaks into page context. Only identity/species/type/
  // category records (by source field OR explicit attribute id) enter; the
  // reviewed species value (never first evidence) drives cross-species
  // contradiction labeling.
  const speciesValue = reviewedSpeciesValue(context);
  const pagePacket = buildPageEvidencePacket(input.evidence, {
    pageContextSourceFields: PAGE_CONTEXT_SOURCE_FIELDS,
    pageContextAttributeIds: PAGE_CONTEXT_ATTRIBUTE_IDS,
    sourceField: null,
    speciesValue,
  });

  // ── Extract product context ONLY from the restricted packet records ────
  // The LLM prompt is built from the frozen packet (supporting/contradicting/
  // context), deterministically ordered by evidence id so reversing the input
  // evidence order cannot change the prompt content or species order, and a
  // row excluded from the page packet (e.g. healthConcern) can never reach
  // the prompt (issue #17 pass 5c).
  const pageContextEvidence = [
    ...pagePacket.supporting,
    ...pagePacket.contradicting,
    ...pagePacket.context,
  ].sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''));
  const productContext = extractProductContext(pageContextEvidence, input.allProposals);

  const groupedSkus = context.productLineContext?.siblingSkus ?? [];
  const isMultiItemGroup = groupedSkus.length >= 2;

  const modelPolicy = context.snapshot
    ? modelPolicyViewFromConfig(
        context.snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
        context.snapshot.snapshotHash,
      )
    : null;

  if (isMultiItemGroup) {
    const products = context.productLineItems ?? [];
    const productSkus = new Set(products.map(product => product.sku));
    if (products.length !== groupedSkus.length || groupedSkus.some(sku => !productSkus.has(sku))) {
      return {
        proposals: [],
        message: 'Cohort page coordination abstained: the frozen product-line snapshot is incomplete.',
      };
    }
    const coordinated = await coordinateCohortPagesOnce({
      groupId: context.productLineContext!.groupId,
      products,
      pages: pageHierarchy,
      selectionMode,
      maxPages,
      modelPolicy,
      ...(context.snapshot
        ? {
            modelCall: buildModelCallContext(context.snapshot, context.runId, 'cohort_page_assignment', 1),
            snapshot: context.snapshot,
          }
        : {}),
    });
    const member = coordinated.get(input.sku);
    if (!member || member.status === 'abstained') {
      return {
        proposals: [],
        message: `Cohort page coordination abstained: ${member?.reason ?? `missing result for SKU ${input.sku}`}`,
      };
    }
    const verifiedPageIdSet = new Set(
      context.snapshot?.pages.state === 'verified'
        ? context.snapshot.pages.records.map(r => r.pageId)
        : [],
    );
    const proposals = member.pages.map((p: any) =>
      buildCategoryPageProposal({
        runId: context.runId,
        sku: input.sku,
        pageId: p.pageId,
        pageName: p.pageName,
        confidence: p.confidence,
        evidenceIds: pagePacket.evidenceIds,
        ...(pagePacket.contradictingEvidenceIds.length
          ? { contradictingEvidenceIds: pagePacket.contradictingEvidenceIds }
          : {}),
        verifiedPageIdentity: verifiedPageIdSet.has(p.pageId),
        isBulkAcceptable: false,
        snapshotHash,
        ...(member.modelCallIds?.length ? { modelCallIds: member.modelCallIds } : {}),
      }),
    );
    const pageNames = member.pages.map(p => p.pageName);
    return {
      proposals,
      message: `${pageNames.join(', ')} (TypeSafe Jev, ${(member.pages[0].confidence * 100).toFixed(0)}%)`,
    };
  }

  const decision = await resolvePageDecision({
    target,
    evidence: input.evidence,
    sku: input.sku,
    runId: context.runId,
    snapshot: context.snapshot,
    modelPolicy,
    assertHeld: context.assertHeld,
    selectionMode,
    maxPages,
    productContext: {
      productName: productContext.productName,
      productDescription: productContext.productDescription,
      productType: productContext.productType,
      ocrSummary: productContext.ocrSummary,
    },
    reviewedProductTypeId: productContext.productType,
  });

  if (decision.status === 'abstained' || decision.status === 'failed' || decision.pages.length === 0) {
    const abstentionProposals = buildProposalsFromPageDecision(
      decision,
      input.sku,
      context.runId,
      snapshotHash,
    );
    return {
      proposals: abstentionProposals,
      message: decision.abstentionReason ?? `Abstained from proposing category pages (${decision.abstentionCode ?? 'unresolved'}).`,
    };
  }

  const proposals = buildProposalsFromPageDecision(
    decision,
    input.sku,
    context.runId,
    snapshotHash,
  );
  const pageNames = decision.pages.map(p => p.pageName);
  return {
    proposals,
    message: `${pageNames.join(', ')} (TypeSafe Jev, ${((decision.selectedProbability ?? decision.pages[0].confidence) * 100).toFixed(0)}%)`,
  };
}

// ─── PR7 Materialized Page Processing (C5) ────────────────────────────────────

/**
 * PR7 C5 (issue #30): materialize the member's DURABLE parent page output
 * into the existing `category_page` proposal shape. Active cohort mode ONLY —
 * `context.coordinatedPages` (set by `ensureCohortPagesCoordinated` before the
 * member loop) carries every member's stored `coordinated_page` result; the
 * child stage NEVER calls the Page LLM and NEVER invents an assignment.
 *
 * - `assigned` → one `buildCategoryPageProposal` per STORED page
 *   (`pageId`/`pageName`/`confidence` FROM THE STORED ROW, verified identity
 *   only when the pageId is in the frozen verified snapshot records,
 *   `evidenceIds` from the SAME deterministic restricted page-evidence packet
 *   the legacy path builds — pure, no LLM — and `modelCallIds` = the stored
 *   audited parent `model_call_id`);
 * - `abstained` → `{proposals: [], message: <stored reason>}` (the stage
 *   abstains — no LLM, no fallback invention);
 * - a missing row for a member that should have one (no `pageCoordinationAbsent`
 *   expected-empty marker), or a corrupt stored payload → THROW (PR8
 *   DECISION-B: the member fails closed — pages NEVER invent an assignment;
 *   PR7's deterministic abstain for these two cases is replaced by the
 *   fail-closed member failure).
 */
export async function materializeCoordinatedPages(
  _target: ResolvedTarget,
  input: StageInput,
  context: StageContext,
): Promise<TargetProcessResult> {
  const snapshotHash = context.snapshot?.snapshotHash ?? null;

  // Look up the member's durable parent output. A missing row for a member
  // that should have one is a parent-op contract violation. PR8 DECISION-B:
  // unless the parent page op chose EXPECTED-EMPTY (pageCoordinationAbsent —
  // the stage-level guard in `categoryPageProposalsStage` handles that case
  // before delegating here), a missing row FAILS the member closed — PR7's
  // deterministic abstain + warning is replaced by the fail-closed throw.
  const stored = context.coordinatedPages?.get(input.sku) as
    | CoordinatedPageMemberValue
    | undefined;
  if (!stored) {
    if (context.pageCoordinationAbsent === true) {
      return { proposals: [], message: 'missing parent page output' };
    }
    throw new Error(
      `Member ${input.sku} (run ${context.runId}) has no parent page output row in active cohort mode (PR8 DECISION-B): ` +
        'a missing durable page output fails the member closed — pages never invent an assignment.',
    );
  }

  // PR8 DECISION-B: fail-closed parse — a corrupt stored payload never yields
  // proposals; the member FAILS (PR7's deterministic abstain is replaced by
  // the throw).
  const parsed = CohortPageOutputSchema.safeParse(stored.output);
  if (!parsed.success) {
    throw new Error(
      `Member ${input.sku} (run ${context.runId}) has a corrupt parent page output payload in active cohort mode (PR8 DECISION-B): ` +
        'failing closed — pages never invent an assignment.',
    );
  }
  const output = parsed.data;

  // Durable parent abstention (policy denied / model unavailable / unsafe or
  // invalid response): the stage abstains with the STORED reason. No LLM, no
  // fallback invention.
  if (output.status === 'abstained') {
    return { proposals: [], message: output.reason };
  }

  // PR8 review R1 (BLOCKER 2c): an `assigned` row with an EMPTY page list can
  // never be produced by any writer (the coordinator abstains instead of
  // emitting assigned-empty) — a row carrying one is corrupt. The schema also
  // rejects it, so this defensive throw is belt-and-suspenders: FAIL the
  // member closed, never emit a partial no-page draft. Abstained rows remain
  // complete results (handled above).
  if (output.pages.length === 0) {
    throw new Error(
      `Member ${input.sku} (run ${context.runId}) has an assigned parent page output with no pages in active cohort mode ` +
        '(PR8 review R1): failing closed — pages never invent an assignment.',
    );
  }

  // ── Restricted page-evidence packet (the SAME deterministic packet the
  // legacy path builds) — pure, no LLM. Only identity/species/type/category
  // records enter; the reviewed species value (never first evidence) drives
  // cross-species contradiction labeling.
  const speciesValue = reviewedSpeciesValue(context);
  const pagePacket = buildPageEvidencePacket(input.evidence, {
    pageContextSourceFields: PAGE_CONTEXT_SOURCE_FIELDS,
    pageContextAttributeIds: PAGE_CONTEXT_ATTRIBUTE_IDS,
    sourceField: null,
    speciesValue,
  });

  // Verified identity from the FROZEN verified snapshot records (never a
  // mutable DB read) — the parent only passed verified pages, so every stored
  // pageId is verified by construction.
  const verifiedPageIdSet = new Set(
    context.snapshot?.pages.state === 'verified'
      ? context.snapshot.pages.records.map(record => record.pageId)
      : [],
  );
  const modelCallIds = stored.modelCallId ? [stored.modelCallId] : undefined;
  const isJev = output.source === 'typesafe';
  const proposals = output.pages.map(page =>
    buildCategoryPageProposal({
      runId: context.runId,
      sku: input.sku,
      pageId: page.pageId,
      pageName: page.pageName,
      confidence: page.confidence,
      evidenceIds: pagePacket.evidenceIds,
      ...(pagePacket.contradictingEvidenceIds.length
        ? { contradictingEvidenceIds: pagePacket.contradictingEvidenceIds }
        : {}),
      verifiedPageIdentity: verifiedPageIdSet.has(page.pageId),
      snapshotHash,
      ...(modelCallIds?.length ? { modelCallIds } : {}),
      ...(isJev ? { isBulkAcceptable: false } : {}),
    }),
  );

  const pageNames = output.pages.map(page => page.pageName);
  const sourceLabel = isJev ? 'TypeSafe Jev' : 'cohort LLM';
  return {
    proposals,
    message: `${pageNames.join(', ')} (Cohort page assignment materialized from parent coordination (${sourceLabel}), ${(output.pages[0].confidence * 100).toFixed(0)}%)`,
  };
}

// ─── Convenience: Check if Product Type is an enabled target ──────────────────

/**
 * Check whether Product Type is an enabled curation target for the given workspace.
 * Returns false when no config exists or the target is disabled.
 */
// fallow-ignore-next-line unused-export — used by tests
export function isProductTypeTargetEnabled(workspacePath: string): boolean {
  const config = loadClassificationConfig(workspacePath);
  const resolved = resolveEnabledTargets(config, '');
  return resolved.productTypes.length > 0;
}

/**
 * Check whether any curation targets are enabled.
 */
// fallow-ignore-next-line unused-export — used by tests
export function hasAnyEnabledTarget(workspacePath: string): boolean {
  const config = loadClassificationConfig(workspacePath);
  const resolved = resolveEnabledTargets(config, '');
  return resolved.hasAny;
}
