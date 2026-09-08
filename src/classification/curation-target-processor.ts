/**
 * Curation target processor coordinator.
 *
 * Combines the resolver → matcher → ranker → proposal builder pipeline
 * for each target kind. This is the "glue" that the thin stage wrappers
 * delegate to, so stage files contain orchestration only — no duplication
 * of matching, ranking, or proposal construction logic.
 */
import type { StageContext, StageInput, CoordinatedPageMemberValue } from './types';
import { type ClassificationProposal, CanonicalBrandEvidenceValueSchema } from '../shared/schemas/classification';
import { CohortPageOutputSchema } from '../shared/schemas/cohorts';
import { loadClassificationConfig } from './config-loader';
import {
  resolveEnabledTargets,
  type ResolvedTarget,
} from './curation-target-resolver';
import {
  matchKeywordOptions,
  matchAttributeOptions,
} from './curation-target-matcher';
import {
  buildEvidenceTargetPacket,
  buildPageEvidencePacket,
  evidenceMatchesTarget,
  resolveCanonicalAssertion,
  tokenGroundingSupport,
  type EvidenceTargetPacket,
} from './evidence-targeting';
import { enrichProductDetails } from './detail-enrichment';
import { llmRankOptions } from './curation-target-ranker';
import { isCalibratedBulkAcceptable } from './proposal-safety';
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
  llmAssignCategoryPages,
  type PageAssignmentResult,
} from './page-assignment-llm';
import { coordinateCohortPagesOnce } from './cohort-page-proposal-engine';

// ─── Shared Target Constants ──────────────────────────────────────────────────

const KEYWORD_MATCH_MIN_CONFIDENCE = 0.7;

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
];

/** Reviewed page-context attribute ids (records with explicit attributeId). */
const PAGE_CONTEXT_ATTRIBUTE_IDS = ['species'];

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
export function processProductTypeTarget(
  target: ResolvedTarget,
  input: StageInput,
  context: StageContext,
): Promise<TargetProcessResult> {
  return processTargetInternal(target, input, context, {
    kind: 'product_type',
    buildProposal: (value, confidence, evidence, modelCallIds) =>
      buildProductTypeProposal({
        runId: context.runId,
        sku: input.sku,
        productTypeId: value,
        confidence,
        evidenceIds: evidence.evidenceIds,
        ...(evidence.supportingEvidenceIds?.length
          ? { supportingEvidenceIds: evidence.supportingEvidenceIds }
          : {}),
        ...(evidence.contradictingEvidenceIds?.length
          ? { contradictingEvidenceIds: evidence.contradictingEvidenceIds }
          : {}),
        snapshotHash: context.snapshot?.snapshotHash ?? null,
        ...(modelCallIds?.length ? { modelCallIds } : {}),
      }),
    task: 'product_type_classification',
  });
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
  const options2 = targetOptions;
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

    // PR (epic #46 review round): a freeText/measured value is ONLY
    // acceptable when grounded in the target's OWN evidence (its attribute
    // id or catalog field). Unrelated general text (title/description) must
    // never become an attribute value — the previous `?? text` fallback let
    // the whole description be proposed as "Brand" / "Product Type".
    // Abstain (no proposals) when the field has no evidence.
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
  if (!options2 || options2.length === 0) {
    return { proposals: [], message: `No options available for "${targetConfig.label}".` };
  }

  // Brand assertions that disagreed in the shortcut pre-pass (visible conflict).
  let brandConflictEvidenceIds: string[] = [];

  // ── Brand shortcut: if this target looks like a brand field AND resolved
  // brand evidence exists, use it directly instead of keyword/LLM matching.
  const targetLabel = targetConfig.label.toLowerCase();
  const targetId = (targetConfig.attributeId ?? targetConfig.id).toLowerCase();
  const isBrandField = targetLabel.includes('brand') || targetId.includes('brand');

  if (isBrandField) {
    // Evaluate EVERY reviewed brand assertion, never `.find()` first: a
    // disagreement between brand statements is a visible conflict that must
    // force individual review, not a silent first-wins shortcut. This covers
    // resolved-brand evidence, ordinary `sourceField='brand'` scalar
    // assertions, and any record with the brand attribute id. Agreement uses
    // EXACT canonical/alias identity — never case folding ('Blue Buffalo'
    // and 'BLUE BUFFALO' are distinct identities).
    const brandAttributeId = targetConfig.attributeId ?? targetConfig.id;
    const brandEvidence = input.evidence.filter(
      e =>
        e.sourceField === 'resolved_brand'
        || e.sourceField === 'brand'
        || e.attributeId === brandAttributeId
        || e.attributeId === 'brand',
    );
    if (brandEvidence.length > 0) {
      const parsedBrands: Array<{ id: string; brandName: string }> = [];
      for (const record of brandEvidence) {
        const parsed = CanonicalBrandEvidenceValueSchema.safeParse(record.value);
        let name: unknown = parsed.success
          ? parsed.data.brandName
          : ((record.value as any)?.brandName ?? (record.value as any)?.name);
        // Scalar brand assertions: a plain string value IS the brand name.
        if (typeof name !== 'string' && typeof record.value === 'string') {
          name = record.value;
        }
        const canonicalName = resolveCanonicalAssertion(name, attribute?.valueAliases ?? []);
        if (canonicalName !== null) {
          parsedBrands.push({ id: record.id, brandName: canonicalName });
        }
      }
      if (parsedBrands.length > 0) {
        const uniqueBrands = [...new Set(parsedBrands.map(p => p.brandName))];
        const allBrandIds = parsedBrands.map(p => p.id).filter(Boolean);
        if (uniqueBrands.length === 1) {
          // All assertions agree on the exact canonical identity: shortcut is
          // safe, and every assertion is supporting (not just the first one).
          const brandName = uniqueBrands[0];
          const matchedOption = options2.find(o =>
            resolveCanonicalAssertion(o.label, attribute?.valueAliases ?? []) === brandName,
          );
          const value = matchedOption?.label ?? brandName;
          const proposal = buildFieldAssignmentProposal({
            runId: context.runId,
            sku: input.sku,
            attributeId: brandAttributeId,
            value,
            confidence: 0.9,
            evidenceIds: allBrandIds,
            supportingEvidenceIds: allBrandIds,
            isMultiple: false,
            isBulkAcceptable: false, // Guardrail: requires manual review until Issue #10 lands
            snapshotHash,
          });
          return {
            proposals: [proposal],
            message: `Brand: "${brandName}" (resolved, 90%)`,
          };
        }
        // Disagreement between brand assertions: fall through to the normal
        // matching path and mark the conflict so the resulting proposal is
        // never bulk-acceptable and the disagreeing assertions are visible as
        // contradicting evidence.
        brandConflictEvidenceIds = allBrandIds;
      }
    }
  }

  // Bounded target-specific packet: the LLM prompt and proposal evidence are
  // selected by attributeId + the reviewed catalog-field mapping, never a
  // run-wide union and never the attribute id used as a source field. Brand
  // targets additionally accept the reviewed `brand`/`resolved_brand` source
  // fields so ordinary brand assertions remain target-relevant.
  const attrId = targetConfig.attributeId ?? targetConfig.id;
  const catalogField = targetConfig.catalogField ?? null;
  const brandSourceFields = isBrandField ? ['brand', 'resolved_brand'] : [];
  const packetSourceFields = catalogField
    ? [...new Set([catalogField, ...brandSourceFields])]
    : brandSourceFields.length
      ? brandSourceFields
      : null;
  const fieldPacket = buildEvidenceTargetPacket(input.evidence, {
    attributeId: attrId,
    sourceField: catalogField,
    sourceFields: packetSourceFields,
    selectionMode,
    aliases: attribute?.valueAliases ?? [],
    isGroundingSupport: tokenGroundingSupport,
  });
  const text = fieldPacket.promptText;
  if (!text) {
    return { proposals: [], message: `No evidence text for "${targetConfig.label}".` };
  }

  const optionStrings = options2.map(o => o.label);

  // Try deterministic alias/exact matching first
  const aliasMatches = attribute
    ? matchAttributeOptions(attribute, text, optionStrings, selectionMode)
    : [];

  let values: string[] = [];
  let confidence = 0;
  let llmModelCallIds: string[] | undefined;

  if (aliasMatches.length > 0) {
    values = aliasMatches.map(m => m.value);
    confidence = Math.max(...aliasMatches.map(m => m.confidence));
  }

  // Fall back to deterministic detail enrichment
  if (values.length === 0 && attribute) {
    const attrId = targetConfig.attributeId ?? targetConfig.id;
    const enrichmentParams = {
      evidenceText: text,
      packagingOcrData: null as any,
      curatedTitle: null,
      allowedValues: optionStrings,
      aliases: attribute.valueAliases ?? [],
    };
    const enrichmentCandidates = enrichProductDetails(enrichmentParams);
    const matching = enrichmentCandidates.filter(
      c => c.attributeId === attrId || c.attributeId === 'all',
    );
    if (matching.length > 0) {
      values = [...new Set(matching.map(m => m.value))].slice(
        0, selectionMode === 'multiple' ? 10 : 1,
      );
      confidence = Math.max(...matching.map(m => m.confidence));
    }
  }

  // Fall back to LLM ranker if no deterministic match
  if (values.length === 0) {
    const llmResult = await llmRankOptions({
      targetLabel: targetConfig.label,
      options: options2,
      selectionMode,
      evidenceText: text,
      task: 'attribute_value_classification',
      modelPolicy: context.snapshot
        ? modelPolicyViewFromConfig(
            context.snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
            context.snapshot.snapshotHash,
          )
        : null,
      protectedOperation: 'attribute_ranking',
      ...(context.snapshot
        ? {
            modelCall: buildModelCallContext(context.snapshot, context.runId, 'attribute_ranking', 1),
            snapshot: context.snapshot,
          }
        : {}),
    });

    if (llmResult && llmResult.values.length > 0) {
      values = llmResult.values;
      confidence = llmResult.confidence;
      llmModelCallIds = llmResult.modelCallIds;
    }
  }

  if (values.length === 0) {
    return { proposals: [], message: `No value match found for "${targetConfig.label}".` };
  }

  // Rebuild the packet with the SELECTED value so target-matching evidence is
  // grounded into supporting/contradicting roles and single-cardinality
  // assertion conflicts are detected (never resolved by source order).
  const rolePacket = buildEvidenceTargetPacket(input.evidence, {
    attributeId: attrId,
    sourceField: catalogField,
    sourceFields: packetSourceFields,
    selectionMode,
    proposedValue: selectionMode === 'multiple' ? values : values[0],
    aliases: attribute?.valueAliases ?? [],
    isGroundingSupport: tokenGroundingSupport,
  });
  let contradictingEvidenceIds = rolePacket.contradictingEvidenceIds;
  let supportingEvidenceIds = rolePacket.supportingEvidenceIds;
  let hasConflict = rolePacket.hasConflict;
  if (brandConflictEvidenceIds.length > 0) {
    // Disagreeing brand assertions are visible contradicting evidence and the
    // proposal is forced to individual review. The role sets MUST remain
    // pairwise disjoint: any assertion participating in the brand conflict is
    // removed from supporting (it cannot be both supporting and
    // contradicting), and the visible conflict shows ONLY contradicting ids.
    const conflictSet = new Set(brandConflictEvidenceIds);
    supportingEvidenceIds = supportingEvidenceIds.filter(id => !conflictSet.has(id));
    contradictingEvidenceIds = [...new Set([...contradictingEvidenceIds, ...brandConflictEvidenceIds])];
    hasConflict = true;
  }

  // P3 calibrated bulk acceptance (plan B.P3.4): with calibrated thresholds
  // present AND no conflicting evidence, a high-confidence plain field
  // assignment may be marked bulk-acceptable through the Issue #10 machinery;
  // the uncalibrated fallback reproduces legacy byte-identically (false).
  // Claims/composition and conflicts can never pass — enforced inside
  // isCalibratedBulkAcceptable AND by validateProposalSafety.
  const proposal = buildFieldAssignmentProposal({
    runId: context.runId,
    sku: input.sku,
    attributeId: targetConfig.attributeId ?? targetConfig.id,
    value: selectionMode === 'multiple' ? values : values[0],
    confidence,
    evidenceIds: [...new Set([...supportingEvidenceIds, ...contradictingEvidenceIds, ...rolePacket.context.map(r => r.id).filter(Boolean)])],
    supportingEvidenceIds,
    contradictingEvidenceIds,
    isMultiple: selectionMode === 'multiple',
    isBulkAcceptable: hasConflict
      ? false
      : isCalibratedBulkAcceptable(
          { proposalType: 'field_assignment', confidence, contradictingEvidenceIds },
          target.attribute ?? null,
          options.calibratedThresholds ?? null,
        ),
    snapshotHash,
    ...(llmModelCallIds?.length ? { modelCallIds: llmModelCallIds } : {}),
  });

  return { proposals: [proposal], message: `"${targetConfig.label}": ${values.join(', ')} (${(confidence * 100).toFixed(0)}%)${hasConflict ? ' [conflicting evidence]' : ''}` };
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
  let llmResult: PageAssignmentResult | null;
  let assignmentSource = 'LLM';

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
      modelPolicy: context.snapshot
        ? modelPolicyViewFromConfig(
            context.snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
            context.snapshot.snapshotHash,
          )
        : null,
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
    llmResult = { pages: member.pages, modelCallIds: member.modelCallIds };
    assignmentSource = 'cohort LLM';
  } else {
    llmResult = await llmAssignCategoryPages({
      productName: productContext.productName,
      productDescription: productContext.productDescription,
      ocrSummary: productContext.ocrSummary,
      productType: productContext.productType,
      pages: pageHierarchy,
      selectionMode,
      maxPages,
      modelPolicy: context.snapshot
        ? modelPolicyViewFromConfig(
            context.snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
            context.snapshot.snapshotHash,
          )
        : null,
      ...(context.snapshot
        ? {
            modelCall: buildModelCallContext(context.snapshot, context.runId, 'page_assignment', 1),
            snapshot: context.snapshot,
          }
        : {}),
    });
  }

  if (!llmResult || llmResult.pages.length === 0) {
    return {
      proposals: [],
      message: `No page assignment from ${assignmentSource}. Evidence length: ${input.evidence.length} records, ${pagePacket.evidenceIds.length} linked.`,
    };
  }

  // ── Build proposals from LLM results ───────────────────────────────────
  // Verified identity is stamped only for pageIds present in the frozen
  // verified snapshot (never inferred from a name or a mutable DB read).
  const verifiedPageIdSet = new Set(
    context.snapshot?.pages.state === 'verified'
      ? context.snapshot.pages.records.map(r => r.pageId)
      : [],
  );
  const proposals = llmResult.pages.map((p: any) =>
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
      isBulkAcceptable: (p.isBrandShortcut || p.pageName.startsWith('Brand -')) ? false : undefined,
      snapshotHash,
      ...(llmResult.modelCallIds?.length ? { modelCallIds: llmResult.modelCallIds } : {}),
    }),
  );

  const pageNames = llmResult.pages.map(p => p.pageName);
  return {
    proposals,
    message: `${pageNames.join(', ')} (${assignmentSource}, ${(llmResult.pages[0].confidence * 100).toFixed(0)}%)`,
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
    }),
  );

  const pageNames = output.pages.map(page => page.pageName);
  return {
    proposals,
    message: `${pageNames.join(', ')} (Cohort page assignment materialized from parent coordination (cohort LLM), ${(output.pages[0].confidence * 100).toFixed(0)}%)`,
  };
}

// ─── Internal Generic Processor ───────────────────────────────────────────────

interface TargetProposalBuilder {
  kind: string;
  buildProposal: (
    value: string,
    confidence: number,
    evidence: {
      evidenceIds: string[];
      supportingEvidenceIds?: string[];
      contradictingEvidenceIds?: string[];
    },
    modelCallIds?: string[],
  ) => ClassificationProposal;
  /** LLM task name for routing, or undefined to use 'category_classification' fallback */
  task?: string;
}

/**
 * Generic target processing pipeline shared by product type and page targets.
 * Product field targets use a separate path because they need alias matching.
 */
async function processTargetInternal(
  target: ResolvedTarget,
  input: StageInput,
  context: StageContext,
  builder: TargetProposalBuilder,
): Promise<TargetProcessResult> {
  const { config: targetConfig, options } = target;

  if (!options || options.length === 0) {
    return { proposals: [], message: `No options available for "${targetConfig.label}".` };
  }

  const selectionMode = (targetConfig.selectionMode ?? 'single') as 'single' | 'multiple';

  // Bounded target packet. General title/description evidence is context
  // unless the deterministic grounding rule links it to the selected value.
  const buildPacket = (proposedValue?: unknown): EvidenceTargetPacket =>
    buildEvidenceTargetPacket(input.evidence, {
      attributeId: targetConfig.attributeId ?? null,
      sourceField: targetConfig.catalogField ?? null,
      selectionMode,
      proposedValue,
      isGroundingSupport: tokenGroundingSupport,
      includeProductTypeContext: builder.kind === 'product_type',
    });
  const matchingPacket = buildPacket();
  const text = matchingPacket.promptText;
  if (!text || text.length < 3) {
    return { proposals: [], message: `Insufficient evidence text for "${targetConfig.label}".` };
  }

  // Try deterministic keyword/token matching first
  const keywordMatches = matchKeywordOptions({
    options,
    text,
    selectionMode,
  });

  if (keywordMatches.length > 0 && keywordMatches[0].confidence >= KEYWORD_MATCH_MIN_CONFIDENCE) {
    const proposals = keywordMatches.map(m => {
      const singlePacket = buildPacket(m.value);
      return builder.buildProposal(m.value, m.confidence, {
        evidenceIds: singlePacket.evidenceIds,
        supportingEvidenceIds: singlePacket.supportingEvidenceIds,
        contradictingEvidenceIds: singlePacket.contradictingEvidenceIds,
      });
    });
    const values = keywordMatches.map(m => m.label);
    return {
      proposals,
      message: `${values.join(', ')} (keyword, ${(keywordMatches[0].confidence * 100).toFixed(0)}%)`,
    };
  }

  // Fall back to LLM ranker
  const llmResult = await llmRankOptions({
    targetLabel: targetConfig.label,
    options,
    selectionMode,
    evidenceText: text,
    task: builder.task,
    modelPolicy: context.snapshot
      ? modelPolicyViewFromConfig(
          context.snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
          context.snapshot.snapshotHash,
        )
      : null,
    protectedOperation: builder.task === 'category_page_assignment' ? 'page_assignment' : 'product_type_ranking',
    ...(context.snapshot
      ? {
          modelCall: buildModelCallContext(
            context.snapshot,
            context.runId,
            builder.task === 'category_page_assignment' ? 'page_assignment' : 'product_type_ranking',
            1,
          ),
          snapshot: context.snapshot,
        }
      : {}),
  });

  if (!llmResult || llmResult.values.length === 0) {
    return { proposals: [], message: `No match found for "${targetConfig.label}".` };
  }

  const proposals = llmResult.values.map(v => {
    const opt = options.find(
      o => o.label.toLowerCase() === v.toLowerCase() || o.value.toLowerCase() === v.toLowerCase(),
    );
    const proposalValue = targetConfig.kind === 'product_type' ? (opt?.value ?? v) : v;
    const singlePacket = buildPacket(proposalValue);
    return builder.buildProposal(proposalValue, llmResult.confidence, {
      evidenceIds: singlePacket.evidenceIds,
      supportingEvidenceIds: singlePacket.supportingEvidenceIds,
      contradictingEvidenceIds: singlePacket.contradictingEvidenceIds,
    }, llmResult.modelCallIds);
  });

  return {
    proposals,
    message: `${llmResult.values.join(', ')} (LLM, ${(llmResult.confidence * 100).toFixed(0)}%)`,
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
