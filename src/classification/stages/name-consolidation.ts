/**
 * Name Consolidation Stage (modular replacement for curateItem's title synthesis).
 *
 * Builds title signals from accumulated evidence (spreadsheet name, web title,
 * packaging OCR title, brand hint) and calls the shared `consolidateProductTitle()`
 * helper to produce a store-ready curated title.
 *
 * This stage produces NO proposals and NO new evidence — it returns compatibility
 * metadata for the orchestrator to merge into `curation_data_json`.
 *
 * Dependencies: evidence_extraction (needs spreadsheet/web/OCR evidence signals)
 */
import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { consolidateProductTitle } from '../../onboarding/title-consolidation';
import { ensureBrandInTitle, titleContainsBrand, ensureVariantTokensInTitle, knownVariantTokens, variantTokenPresentInTitle } from '../../onboarding/title-prompt-template';
import { modelPolicyViewFromConfig } from '../../onboarding/model-policy-snapshot';
import { buildModelCallContext } from '../runtime-snapshot';
import type { ModelPolicyConfigV2 } from '../../shared/schemas/classification';

/**
 * Extract the best title signal from evidence of a given sourceField.
 */
function evidenceValue(
  evidence: StageInput['evidence'],
  sourceField: string,
  source?: string,
): string | null {
  const matches = evidence.filter(e => {
    if (e.sourceField !== sourceField) return false;
    if (source && e.source !== source) return false;
    return true;
  });
  if (matches.length === 0) return null;
  // Return the value of the first match, converted to string if needed
  const val = matches[0].value;
  if (typeof val === 'string' && val.trim().length > 0) return val.trim();
  if (val != null) return String(val).trim();
  return null;
}

// ─── Distributor signal collection ───────────────────────────────────────────

interface DistributorTitleSignal {
  title: string;
  providerId: string;
  attemptId: string;
  confidence: number;
}

interface DistributorBrandSignal {
  brand: string;
  providerId: string;
  attemptId: string;
  confidence: number;
}

/**
 * Variant attribute signal from distributor evidence (issue #111): size,
 * capacity (volume), weight, count/pack-count from merchandising fields
 * below the distributor title. Capacity is its own axis — never folded
 * into size text.
 */
interface DistributorVariantSignal {
  field: 'size' | 'capacity' | 'weight' | 'count' | 'packCount';
  value: string;
  providerId: string;
  attemptId: string;
  confidence: number;
}

/** Recognized variant-attribute evidence fields (issue #111). */
const DISTRIBUTOR_VARIANT_FIELDS = ['size', 'capacity', 'weight', 'count', 'packCount'] as const;

/**
 * Collect distributor variant-attribute signals from distributor_record
 * evidence. Only consolidated projection rows carry variants (one row per
 * field, source `distributor_record`); legacy third_party_page rows never
 * do, so only the former is read. Provider/confidence follow the same
 * consolidated semantics as the title/brand collector: per-field
 * provenance map, then accepted providers, authority confidence 1.0.
 */
function collectDistributorVariantSignals(
  evidence: StageInput['evidence'],
): DistributorVariantSignal[] {
  const out: DistributorVariantSignal[] = [];
  const seen = new Set<string>();
  const candidates = evidence.filter(
    (e): e is typeof e & { sourceField: string } => e.source === 'distributor_record'
      && typeof e.sourceField === 'string'
      && (DISTRIBUTOR_VARIANT_FIELDS as readonly string[]).includes(e.sourceField),
  );
  // Authority order first: consolidated rows (metadata.acceptedProviderIds)
  // outrank stray per-attempt rows. Within a rank, stable insertion
  // (evidence) order is kept — dedup below is first-wins on
  // field|provider|value, so the earliest row of each key survives.
  const rank = (e: StageInput['evidence'][number]): number =>
    (e.metadata as Record<string, unknown> | null)?.acceptedProviderIds ? 0 : 1;
  candidates.sort((a, b) => rank(a) - rank(b));
  for (const e of candidates) {
    if (typeof e.sourceField !== 'string') continue;
    const field = e.sourceField;
    const val = typeof e.value === 'string' ? e.value.trim() : null;
    if (!val) continue;
    const meta = (e.metadata ?? {}) as Record<string, unknown>;
    const fieldProv = meta.fieldProvenance as Record<string, unknown> | undefined;
    const acceptedProviders = meta.acceptedProviderIds as string[] | undefined;
    const providerId =
      (typeof fieldProv?.[field] === 'string' && (fieldProv[field] as string)) ||
      (typeof meta.providerId === 'string' ? meta.providerId : undefined) ||
      acceptedProviders?.[0] ||
      'unknown';
    const key = `${field}|${providerId}|${val.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      field: field as DistributorVariantSignal['field'],
      value: val,
      providerId,
      attemptId: (meta.attemptId as string) ?? '',
      confidence: typeof meta.confidence === 'number' ? meta.confidence : 1.0,
    });
  }
  return out;
}

/**
 * Collect, deduplicate, and confidence-order distributor title and brand
 * signals from distributor evidence.
 *
 * Reads BOTH `distributor_record` (the Amendment A/B label both the live
 * and frozen evidence-extraction paths emit) and legacy `third_party_page`
 * rows. Before this fix the collector read only `third_party_page`, so
 * qualified distributor-record brand/name evidence never reached title
 * synthesis (issue #110) — distributor drafts fell through to spreadsheet
 * names and brandless titles.
 *
 * Rules:
 * - Prefer per-attempt evidence (those with metadata.attemptId) over
 *   flattened ExtractionData-derived evidence to avoid double-counting
 *   the highest-ranked provider.
 * - Consolidated `distributor_record` rows (the reconciled projection pick,
 *   one row per field) are ALWAYS included: providerId comes from the
 *   per-field provenance map (`metadata.fieldProvenance[field]`), falling
 *   back to the first accepted provider; attemptId is '' (consolidated
 *   semantics — the contributing attempt ids live in evidence metadata);
 *   confidence is 1.0 (projection authority outranks raw per-attempt rows).
 * - Recognise both sourceField: 'name' and legacy 'title' for titles.
 * - Deduplicate provider/value pairs, keeping the highest confidence.
 * - Sort by confidence descending, then providerId, then attemptId.
 */
function collectDistributorSignals(evidence: StageInput['evidence']): {
  titles: DistributorTitleSignal[];
  brands: DistributorBrandSignal[];
} {
  const thirdPartyEvidence = evidence.filter(e => e.source === 'third_party_page');
  const distributorRecordEvidence = evidence.filter(e => e.source === 'distributor_record');

  // ── Per-attempt titles ────────────────────────────────────────────────
  const perAttemptTitles: DistributorTitleSignal[] = [];
  const perAttemptBrands: DistributorBrandSignal[] = [];
  const seenTitleKeys = new Set<string>();
  const seenBrandKeys = new Set<string>();

  // Collect per-attempt signals first (they carry immutable provenance)
  for (const e of thirdPartyEvidence) {
    const attemptId = e.metadata?.attemptId as string | undefined;
    if (!attemptId) continue; // skip flattened/legacy rows for now

    const providerId = (e.metadata?.providerId as string) ?? 'unknown';
    const confidence = typeof e.metadata?.confidence === 'number' ? e.metadata.confidence : 0.5;
    const val = typeof e.value === 'string' ? e.value.trim() : null;
    if (!val) continue;

    if (e.sourceField === 'name' || e.sourceField === 'title') {
      const key = `${providerId}|${val.toLowerCase()}`;
      if (!seenTitleKeys.has(key)) {
        seenTitleKeys.add(key);
        perAttemptTitles.push({ title: val, providerId, attemptId, confidence });
      }
    }

    if (e.sourceField === 'brand') {
      const key = `${providerId}|${val.toLowerCase()}`;
      if (!seenBrandKeys.has(key)) {
        seenBrandKeys.add(key);
        perAttemptBrands.push({ brand: val, providerId, attemptId, confidence });
      }
    }
  }

  // ── Backfill with flattened/legacy evidence when no per-attempt ────────
  if (perAttemptTitles.length === 0) {
    for (const e of thirdPartyEvidence) {
      if (e.sourceField !== 'name' && e.sourceField !== 'title') continue;
      const val = typeof e.value === 'string' ? e.value.trim() : null;
      if (!val) continue;
      const providerId = (e.metadata?.providerId as string) ?? (e.metadata?.distributorProvider as string) ?? 'unknown';
      const key = `${providerId}|${val.toLowerCase()}`;
      if (!seenTitleKeys.has(key)) {
        seenTitleKeys.add(key);
        perAttemptTitles.push({
          title: val,
          providerId,
          attemptId: '',
          confidence: 0.5,
        });
      }
    }
  }

  if (perAttemptBrands.length === 0) {
    for (const e of thirdPartyEvidence) {
      if (e.sourceField !== 'brand') continue;
      const val = typeof e.value === 'string' ? e.value.trim() : null;
      if (!val) continue;
      const providerId = (e.metadata?.providerId as string) ?? (e.metadata?.distributorProvider as string) ?? 'unknown';
      const key = `${providerId}|${val.toLowerCase()}`;
      if (!seenBrandKeys.has(key)) {
        seenBrandKeys.add(key);
        perAttemptBrands.push({
          brand: val,
          providerId,
          attemptId: '',
          confidence: 0.5,
        });
      }
    }
  }

  // ── Consolidated distributor_record rows (ALWAYS included) ──────────
  // One row per field holding the reconciled projection pick. These carry
  // no per-row attemptId (the contributing attempts live in evidence
  // metadata: acceptedEvidenceAttemptIds/acceptedProviderIds), so they join
  // with consolidated semantics: providerId from the per-field provenance
  // map, attemptId '', and authority confidence (outranks raw per-attempt
  // rows, which can only come from legacy third_party_page evidence).
  for (const e of distributorRecordEvidence) {
    const val = typeof e.value === 'string' ? e.value.trim() : null;
    if (!val) continue;
    if (e.sourceField !== 'name' && e.sourceField !== 'title' && e.sourceField !== 'brand') continue;
    const meta = (e.metadata ?? {}) as Record<string, unknown>;
    const fieldProv = meta.fieldProvenance as Record<string, unknown> | undefined;
    const acceptedProviders = meta.acceptedProviderIds as string[] | undefined;
    const providerId =
      (typeof fieldProv?.[e.sourceField] === 'string' && (fieldProv[e.sourceField] as string)) ||
      acceptedProviders?.[0] ||
      'unknown';
    if (e.sourceField === 'name' || e.sourceField === 'title') {
      const key = `${providerId}|${val.toLowerCase()}`;
      if (!seenTitleKeys.has(key)) {
        seenTitleKeys.add(key);
        perAttemptTitles.push({ title: val, providerId, attemptId: '', confidence: 1.0 });
      }
    }
    if (e.sourceField === 'brand') {
      const key = `${providerId}|${val.toLowerCase()}`;
      if (!seenBrandKeys.has(key)) {
        seenBrandKeys.add(key);
        perAttemptBrands.push({ brand: val, providerId, attemptId: '', confidence: 1.0 });
      }
    }
  }

  // Sort by confidence descending, then providerId, then attemptId
  const sortFn = (a: { confidence: number; providerId: string; attemptId: string }, b: { confidence: number; providerId: string; attemptId: string }) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.providerId < b.providerId) return -1;
    if (a.providerId > b.providerId) return 1;
    return a.attemptId < b.attemptId ? -1 : 1;
  };

  perAttemptTitles.sort(sortFn);
  perAttemptBrands.sort(sortFn);

  return { titles: perAttemptTitles, brands: perAttemptBrands };
}

/**
 * Name Consolidation Stage
 *
 * Reads evidence from the evidence_extraction stage and produces a curated
 * product title using the shared consolidateProductTitle() helper.
 *
 * Returns metadata (not proposals) for orchestrator compatibility:
 * - curatedTitle: the final consolidated title
 * - packagingOcrTitle: the raw OCR title (if available)
 * - titleSource: how the title was derived
 * - signalsUsed: which signals were available
 */
export const nameConsolidationStage: StageDefinition = {
  name: 'name_consolidation',
  requires: ['evidence_extraction'],
  evidenceFrom: ['evidence_extraction'],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    // Gather title signals from accumulated evidence
    // Prefer expected_name (refined during discovery consolidation) over
    // the raw spreadsheet name, as it represents a more curated identity.
    const spreadsheetName =
      evidenceValue(input.evidence, 'expected_name', 'spreadsheet') ??
      evidenceValue(input.evidence, 'name', 'spreadsheet');

    const webTitle = evidenceValue(input.evidence, 'title', 'official_product_page');
    // Parent #101 (manual-evidence route, ticket #104): the
    // operator-transcribed per-SKU title is an eligible title signal with
    // source `manual`. It never bypasses synthesis or cohort validation —
    // it only participates as one more input to the shared consolidator.
    const manualTitle = evidenceValue(input.evidence, 'name', 'operator_manual');
    const ocrTitle = evidenceValue(input.evidence, 'name', 'visual_product_evidence');

    // Collect distributor title and brand signals (distributor_record +
    // legacy third_party_page evidence)
    const distributorSignals = collectDistributorSignals(input.evidence);

    // Collect distributor variant attributes: size/capacity/weight/count
    // from merchandising fields below the distributor title (issue #111).
    const distributorVariants = collectDistributorVariantSignals(input.evidence);

    // Weight from official-page extraction evidence (issue #111): structured
    // measurement alongside the web title.
    const officialWeight = evidenceValue(input.evidence, 'weight', 'official_product_page');

    // Raw register name + OCR measurements are gathered here (before the
    // cohort branch) so BOTH the coordinated-title path and the per-item
    // path share one variant authority (issue #111, mirrors #108 brand).
    // Always also capture the raw register name (the original unabbreviated
    // name from the spreadsheet import) so size/weight/count/flavor tokens
    // the expected_name might have lost stay evidenced.
    const rawRegisterName = evidenceValue(input.evidence, 'name', 'spreadsheet');
    // Log when the expected name dropped tokens the raw name had
    if (rawRegisterName && spreadsheetName && rawRegisterName !== spreadsheetName) {
      console.log(`[NameConsolidation] Raw register name differs from expected_name. Raw: "${rawRegisterName}", expected: "${spreadsheetName}"`);
    }
    const ocrWeight = evidenceValue(input.evidence, 'weight', 'visual_product_evidence');
    const ocrSize = evidenceValue(input.evidence, 'size', 'visual_product_evidence');
    const ocrCount = evidenceValue(input.evidence, 'count', 'visual_product_evidence');

    // Merged known-variant sources from every origin (issue #111):
    // spreadsheet names, web/OCR/manual titles, OCR measurements, official
    // weight, distributor titles + variant attributes. Titles contribute
    // embedded tokens; structured values contribute measurements.
    const variantSources: Array<string | null | undefined> = [
      spreadsheetName, rawRegisterName, webTitle, manualTitle, ocrTitle,
      ocrWeight, ocrSize, ocrCount, officialWeight,
      ...distributorSignals.titles.map(t => t.title),
      ...distributorVariants.map(v => v.value),
    ];

    // Authorship-visible subset (issue #111): ONLY channels with a true
    // item-level counterpart the coordinator can read — spreadsheet names,
    // official/extraction titles, OCR payload fields, extraction weight.
    // Manual evidence has no item-level counterpart, and distributor
    // per-attempt titles/variant rows may carry stray values beyond the
    // materialized projection — the coordinator never sees those — so
    // manual-only and distributor-only sizes are a member evidence gap,
    // never a stale parent (see checkDurableSize below: hold, don't throw).
    const authoredVariantSources: Array<string | null | undefined> = [
      spreadsheetName, rawRegisterName, webTitle, ocrTitle,
      ocrWeight, ocrSize, ocrCount, officialWeight,
    ];

    // Brand hint: prefer spreadsheet → official page → highest-confidence distributor brand.
    // Computed FIRST (issue #108): every title path below either guarantees
    // this brand deterministically or abstains when no brand exists anywhere.
    // The author-visible channels are tracked separately: coordinated titles
    // are authored from item.brandHint (spreadsheet/official), so only those
    // channels can contradict a durable title (design B parent-defect check).
    const spreadsheetBrand = evidenceValue(input.evidence, 'brand', 'spreadsheet');
    const officialBrand = evidenceValue(input.evidence, 'brand', 'official_product_page');
    const brandHint = spreadsheetBrand ?? officialBrand ??
      distributorSignals.brands[0]?.brand ?? null;

    // ── Cohort coordination handling ─────────────────────────────────
    // If a pre-computed coordinated title was set by the cohort
    // coordinator, use it directly and skip the per-item LLM call.
    // The title was already validated and normalized by the coordinator,
    // including deterministic fallback on LLM failure.
    // A grouped item must never fall through to independent per-item LLM.
    //
    // PR8 review R1 (BLOCKER 2b): an EMPTY/whitespace `preComputedTitle` is a
    // corrupt coordinated title — NEVER a signal to re-enter per-item
    // synthesis (that would invent a child title). The check is an explicit
    // non-empty string test (truthiness would treat `''` as absent).
    if (typeof context.preComputedTitle === 'string') {
      const preComputedTitle = context.preComputedTitle.trim();
      if (preComputedTitle.length > 0) {
        const source = context.preComputedTitleSource ?? 'llm_cohort';
        // Issue #108 (design B): coordinated titles are consumed
        // BYTE-FOR-BYTE — the brand guarantee lives at authorship
        // (coordinator/fallback writers), never as a member-side mutation,
        // so durable correspondence (PR9 R2-B) always holds. No brand
        // anywhere → hold for a manual title.
        if (!brandHint) {
          return {
            status: 'abstained',
            reason: 'missing_brand: no brand in spreadsheet, official-page, or distributor evidence — supply an operator manual title/brand and re-run.',
          };
        }
        // Issue #111 (design B, mirrors brand): the durable title must
        // carry EVERY evidenced size/capacity token — the guarantee lives
        // at authorship, so the member never mutates it. Runs AFTER the
        // brand checks below (#108 authority order: brand first, then
        // variant). No size evidenced anywhere → hold; a token the
        // authorship could see but dropped → the parent output is stale or
        // corrupt, fail closed loudly; a token evidenced ONLY manually or
        // ONLY in distributor per-attempt rows (invisible to the
        // coordinator) → hold for review, since the parent could never
        // have healed it.
        const checkDurableSize = (): StageResult | null => {
          const knownSize = knownVariantTokens(variantSources);
          if (knownSize.length === 0) {
            return {
              status: 'abstained',
              reason: 'missing_size: no size/capacity/weight/count in spreadsheet, web/OCR/manual titles, measurements, or distributor variant attributes — supply an operator manual title/size and re-run.',
            };
          }
          const missing = knownSize.filter(t => !variantTokenPresentInTitle(preComputedTitle, t));
          if (missing.length === 0) return null;
          const authoredKnown = knownVariantTokens(authoredVariantSources);
          const authoredMissing = authoredKnown.filter(t => !variantTokenPresentInTitle(preComputedTitle, t));
          if (authoredMissing.length > 0) {
            throw new Error(
              `parent_defect_stale_title: member ${input.sku} (run ${context.runId}) durable coordinated title ` +
                `"${preComputedTitle}" is missing evidenced variant tokens (${authoredMissing.join(', ')}) — the parent title output is stale or corrupt; ` +
                're-run coordination. The member never mutates a durable title.',
            );
          }
          return {
            status: 'abstained',
            reason: `missing_size: durable coordinated title ("${preComputedTitle}") lacks the manually- or distributor-evidenced size (${missing.join(', ')}) invisible to coordination — re-run coordination or supply an operator manual title/size.`,
          };
        };
        if (!titleContainsBrand(preComputedTitle, brandHint)) {
          // The durable title lacks every known brand. When an
          // author-visible channel (spreadsheet/official — the authority
          // coordination authors from) contradicts it, the durable output
          // is stale or corrupt: fail closed loudly, same philosophy as the
          // PR8 empty-title throw below. A distributor-only brand against a
          // brandless durable title is the #110 wiring gap, not a parent
          // defect: abstain for operator confirmation instead of looping.
          const authorVisibleBrand = spreadsheetBrand ?? officialBrand;
          if (authorVisibleBrand && !titleContainsBrand(preComputedTitle, authorVisibleBrand)) {
            throw new Error(
              `parent_defect_stale_title: member ${input.sku} (run ${context.runId}) durable coordinated title ` +
                `("${preComputedTitle}") is missing its author-visible brand "${authorVisibleBrand}" — the parent title output is stale or corrupt; ` +
                're-run coordination. The member never mutates a durable title.',
            );
          }
          return {
            status: 'abstained',
            reason: 'missing_brand: distributor-only brand evidence against a brandless coordinated title needs operator confirmation (see #110) — supply an operator manual title/brand and re-run.',
          };
        }
        // Brand checks passed — now the variant check (#111, defined above).
        const sizeHold = checkDurableSize();
        if (sizeHold) return sizeHold;
        return {
          status: 'succeeded',
          output: {
            evidence: [],
            proposals: [],
            abstained: false,
            message: `Using pre-computed coordinated title (${source}): "${preComputedTitle}"`,
            metadata: {
              curatedTitle: preComputedTitle,
              titleSource: source,
              packagingOcrTitle: null,
              brandApplied: brandHint,
              signalsUsed: { source: 'cohort_coordination', sourceType: source, brandHint },
            },
          },
        };
      }
      // An empty coordinated title can never legitimately reach a member (the
      // parent op's writers always emit non-empty titles and the reuse path
      // fails corrupt/empty rows closed). A hand-built or pre-tightening
      // context carrying one must fail the member — never fall through to
      // per-item synthesis, which would invent a title for a corrupt parent
      // result.
      throw new Error(
        `Member ${input.sku} (run ${context.runId}) has an EMPTY coordinated title output in active cohort mode ` +
          '(PR8 review R1): failing closed — the member never synthesizes a replacement title.',
      );
    }

    // Remaining per-item signals were gathered above, before the cohort
    // branch, so every path shares one brand AND variant authority.
    const fallbackName = spreadsheetName ?? webTitle ?? 'Unknown Product';

    // Consider distributor titles as valid signals for availability
    const hasDistributorTitles = distributorSignals.titles.length > 0;
    if (!spreadsheetName && !webTitle && !ocrTitle && !manualTitle && !hasDistributorTitles) {
      return {
        status: 'abstained',
        reason: 'No title signals available from evidence (no spreadsheet name, web title, OCR title, manual title, or distributor titles).',
      };
    }

    // Issue #108: no brand in any evidence → hold for a manual title.
    // The guarantee cannot be verified, and inventing a brand is forbidden —
    // abstaining surfaces a reviewable_abstention with the coded reason
    // instead of shipping a brandless name. Skips the LLM call entirely.
    if (!brandHint) {
      return {
        status: 'abstained',
        reason: 'missing_brand: no brand in spreadsheet, official-page, or distributor evidence — supply an operator manual title/brand and re-run.',
      };
    }

    // Issue #111: no size/capacity/weight/count in any evidence → hold.
    // Same fail-closed shape as missing_brand: the variant guarantee cannot
    // be verified, and inventing a size is forbidden. Skips the LLM call.
    const knownSize = knownVariantTokens(variantSources);
    if (knownSize.length === 0) {
      return {
        status: 'abstained',
        reason: 'missing_size: no size/capacity/weight/count in spreadsheet, web/OCR/manual titles, measurements, or distributor variant attributes — supply an operator manual title/size and re-run.',
      };
    }

    // Check for product-line sibling context
    const productLine = context.productLineContext;
    const siblingContext = productLine && productLine.siblingNames.length > 0
      ? {
          groupLabel: productLine.groupLabel,
          siblingNames: productLine.siblingNames,
          siblingWebTitles: productLine.siblingWebTitles,
          siblingOcrTitles: productLine.siblingOcrTitles,
          siblingSkus: productLine.siblingSkus,
        }
      : undefined;

    try {
      const result = await consolidateProductTitle(
        {
          name: spreadsheetName ?? fallbackName,
          rawRegisterName: rawRegisterName ?? undefined,
          brandHint: brandHint ?? undefined,
          webTitle: webTitle ?? undefined,
          manualTitle: manualTitle ?? undefined,
          ocrTitle: ocrTitle ?? undefined,
          ocrWeight: ocrWeight ?? undefined,
          ocrSize: ocrSize ?? undefined,
          ocrCount: ocrCount ?? undefined,
          siblingContext,
          distributorTitles: distributorSignals.titles.length > 0 ? distributorSignals.titles : undefined,
          distributorBrands: distributorSignals.brands.length > 0 ? distributorSignals.brands : undefined,
          distributorVariants: distributorVariants.length > 0
            ? distributorVariants.map(v => ({ field: v.field, value: v.value, providerId: v.providerId, attemptId: v.attemptId, confidence: v.confidence }))
            : undefined,
          extractionWeight: officialWeight ?? undefined,
        },
        context.snapshot
          ? modelPolicyViewFromConfig(
              context.snapshot.modelPolicy as unknown as ModelPolicyConfigV2,
              context.snapshot.snapshotHash,
            )
          : null,
        context.snapshot
          ? {
              modelCall: buildModelCallContext(context.snapshot, context.runId, 'title_consolidation', 1),
              snapshot: context.snapshot,
            }
          : undefined,
      );

      // Defensive: the consolidator reports brandUnverified/sizeUnverified
      // when it somehow produced a title without brand/size evidence (e.g.
      // mocked consolidator in tests) — hold rather than ship it.
      if (result.brandUnverified) {
        return {
          status: 'abstained',
          reason: 'missing_brand: no brand in spreadsheet, official-page, or distributor evidence — supply an operator manual title/brand and re-run.',
        };
      }
      if (result.sizeUnverified) {
        return {
          status: 'abstained',
          reason: 'missing_size: no size/capacity/weight/count in spreadsheet, web/OCR/manual titles, measurements, or distributor variant attributes — supply an operator manual title/size and re-run.',
        };
      }

      return {
        status: 'succeeded',
        output: {
          evidence: [],
          proposals: [],
          abstained: false,
          message: siblingContext
            ? `Title consolidated via ${result.source} with sibling context (${siblingContext.siblingNames.length} siblings): "${result.title}"`
            : `Title consolidated via ${result.source}: "${result.title}"`,
          metadata: {
            curatedTitle: result.title,
            titleSource: result.source,
            brandApplied: result.brandApplied ?? brandHint,
            sizeApplied: result.sizeApplied ?? knownSize,
            // Durable model-call IDs that produced this title (issue #17 E):
            // carried in stage metadata so the run's provenance is complete.
            modelCallIds: result.modelCallIds ?? [],
            packagingOcrTitle: ocrTitle ?? null,
            signalsUsed: {
              spreadsheetName: spreadsheetName ?? null,
              rawRegisterName: rawRegisterName ?? null,
              webTitle: webTitle ?? null,
              manualTitle: manualTitle ?? null,
              ocrTitle: ocrTitle ?? null,
              ocrWeight: ocrWeight ?? null,
              ocrSize: ocrSize ?? null,
              ocrCount: ocrCount ?? null,
              brandHint: brandHint ?? null,
              officialWeight: officialWeight ?? null,
              distributorVariantCount: distributorVariants.length,
              groupId: productLine?.groupId ?? null,
              siblingCount: productLine?.siblingNames.length ?? 0,
              distributorTitleCount: distributorSignals.titles.length,
              distributorBrandCount: distributorSignals.brands.length,
            },
          },
        },
      };
    } catch (err: any) {
      console.error(`[NameConsolidation] Failed to consolidate title: ${err.message}`);

      // Fallback: use best available signal (including distributor titles
      // and the operator-verified manual title). Non-manual items carry no
      // manual signal, so their fallback order is byte-identical.
      // Issue #108: brandHint is non-null on this path (missing brand
      // abstains above), so the fallback gets the same brand guarantee.
      // Issue #111: knownSize is non-empty on this path (missing size
      // abstains above) — the fallback gets the variant guarantee too.
      const bestDistributorTitle = distributorSignals.titles[0]?.title ?? null;
      const rawFallback = ocrTitle ?? webTitle ?? manualTitle ?? spreadsheetName ?? bestDistributorTitle ?? 'Unknown Product';
      const fallback = ensureVariantTokensInTitle(ensureBrandInTitle(rawFallback, brandHint), variantSources);
      const fallbackSource = ocrTitle ? 'ocr' : (webTitle ? 'web' : (manualTitle ? 'manual' : (bestDistributorTitle ? 'web' : 'web')));

      return {
        status: 'succeeded',
        output: {
          evidence: [],
          proposals: [],
          abstained: false,
          message: siblingContext
            ? `Title consolidation failed (sibling context available), using fallback: "${fallback}"`
            : `Title consolidation failed, using fallback: "${fallback}"`,
          metadata: {
            curatedTitle: fallback,
            titleSource: fallbackSource,
            brandApplied: brandHint,
            sizeApplied: knownSize,
            packagingOcrTitle: ocrTitle ?? null,
            signalsUsed: {
              spreadsheetName: spreadsheetName ?? null,
              rawRegisterName: rawRegisterName ?? null,
              webTitle: webTitle ?? null,
              manualTitle: manualTitle ?? null,
              ocrTitle: ocrTitle ?? null,
              ocrWeight: ocrWeight ?? null,
              ocrSize: ocrSize ?? null,
              ocrCount: ocrCount ?? null,
              brandHint: brandHint ?? null,
              groupId: productLine?.groupId ?? null,
              siblingCount: productLine?.siblingNames.length ?? 0,
              distributorTitleCount: distributorSignals.titles.length,
              distributorBrandCount: distributorSignals.brands.length,
            },
          },
        },
      };
    }
  },
};
