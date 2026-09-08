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
 * Collect, deduplicate, and confidence-order distributor title and brand
 * signals from third_party_page evidence.
 *
 * Rules:
 * - Prefer per-attempt evidence (those with metadata.attemptId) over
 *   flattened ExtractionData-derived evidence to avoid double-counting
 *   the highest-ranked provider.
 * - Recognise both sourceField: 'name' and legacy 'title' for titles.
 * - Deduplicate provider/value pairs, keeping the highest confidence.
 * - Sort by confidence descending, then providerId, then attemptId.
 */
function collectDistributorSignals(evidence: StageInput['evidence']): {
  titles: DistributorTitleSignal[];
  brands: DistributorBrandSignal[];
} {
  const thirdPartyEvidence = evidence.filter(e => e.source === 'third_party_page');

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
              signalsUsed: { source: 'cohort_coordination', sourceType: source },
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

    // Gather title signals from accumulated evidence
    // Prefer expected_name (refined during discovery consolidation) over
    // the raw spreadsheet name, as it represents a more curated identity.
    const spreadsheetName =
      evidenceValue(input.evidence, 'expected_name', 'spreadsheet') ??
      evidenceValue(input.evidence, 'name', 'spreadsheet');

    // Always also capture the raw register name (the original unabbreviated
    // name from the spreadsheet import) so the title consolidation LLM has
    // the authoritative source of truth for size/weight/count/flavor tokens
    // that the expected_name might have lost.
    const rawRegisterName = evidenceValue(input.evidence, 'name', 'spreadsheet');
    // Log when the expected name dropped tokens the raw name had
    if (rawRegisterName && spreadsheetName && rawRegisterName !== spreadsheetName) {
      console.log(`[NameConsolidation] Raw register name differs from expected_name. Raw: "${rawRegisterName}", expected: "${spreadsheetName}"`);
    }

    const webTitle = evidenceValue(input.evidence, 'title', 'official_product_page');
    // Parent #101 (manual-evidence route, ticket #104): the
    // operator-transcribed per-SKU title is an eligible title signal with
    // source `manual`. It never bypasses synthesis or cohort validation —
    // it only participates as one more input to the shared consolidator.
    const manualTitle = evidenceValue(input.evidence, 'name', 'operator_manual');
    const ocrTitle = evidenceValue(input.evidence, 'name', 'visual_product_evidence');
    const ocrFlavor = evidenceValue(input.evidence, 'flavor', 'visual_product_evidence');
    const ocrProductForm = evidenceValue(input.evidence, 'productForm', 'visual_product_evidence')
      ?? evidenceValue(input.evidence, 'food-form', 'visual_product_evidence');
    const ocrSpecies = evidenceValue(input.evidence, 'species', 'visual_product_evidence');
    const ocrWeight = evidenceValue(input.evidence, 'weight', 'visual_product_evidence');
    const ocrSize = evidenceValue(input.evidence, 'size', 'visual_product_evidence');
    const ocrCount = evidenceValue(input.evidence, 'count', 'visual_product_evidence');

    // Collect distributor title and brand signals from third_party_page evidence
    const distributorSignals = collectDistributorSignals(input.evidence);

    // Brand hint: prefer spreadsheet → official page → highest-confidence distributor brand
    const brandHint = evidenceValue(input.evidence, 'brand', 'spreadsheet') ??
      evidenceValue(input.evidence, 'brand', 'official_product_page') ??
      distributorSignals.brands[0]?.brand ?? null;

    const fallbackName = spreadsheetName ?? webTitle ?? 'Unknown Product';

    // Consider distributor titles as valid signals for availability
    const hasDistributorTitles = distributorSignals.titles.length > 0;
    if (!spreadsheetName && !webTitle && !ocrTitle && !manualTitle && !hasDistributorTitles) {
      return {
        status: 'abstained',
        reason: 'No title signals available from evidence (no spreadsheet name, web title, OCR title, manual title, or distributor titles).',
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
          ocrFlavor: ocrFlavor ?? undefined,
          ocrProductForm: ocrProductForm ?? undefined,
          ocrSpecies: ocrSpecies ?? undefined,
          ocrWeight: ocrWeight ?? undefined,
          ocrSize: ocrSize ?? undefined,
          ocrCount: ocrCount ?? undefined,
          siblingContext,
          distributorTitles: distributorSignals.titles.length > 0 ? distributorSignals.titles : undefined,
          distributorBrands: distributorSignals.brands.length > 0 ? distributorSignals.brands : undefined,
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
      const bestDistributorTitle = distributorSignals.titles[0]?.title ?? null;
      const fallback = ocrTitle ?? webTitle ?? manualTitle ?? spreadsheetName ?? bestDistributorTitle ?? 'Unknown Product';
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
