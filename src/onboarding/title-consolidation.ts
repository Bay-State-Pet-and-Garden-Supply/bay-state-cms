/**
 * Shared title consolidation logic used by both the legacy and modular curation paths.
 *
 * Synthesizes the optimal store product title from all available name signals:
 * spreadsheet name, web-extracted title, packaging OCR title, and brand hint.
 *
 * Exported as a standalone helper so it can be reused by the modular
 * name-consolidation classification stage without duplicating LLM prompts.
 */
import { getLlmConfigForTask, callLlmForTaskWithProvenance } from './llm-client';
import { redactTransportText } from '../classification/model-policy-gateway';
import { MODEL_CALL_STATUS } from '../classification/model-operation-registry';
import { recordTerminalPreflight } from '../db/repositories/classification-model-call-repo';
import { buildPerItemPrompt, ensureBrandInTitle, ensureVariantTokensInTitle, knownVariantTokens, ensureColorInTitle, knownColorsAcross, resolveOwnColor } from './title-prompt-template';
import { formatDeterministicTitle } from './cohort-name-coordinator';
export interface TitleSignals {
  /** Original name from the spreadsheet import (always available) */
  name: string;
  /**
   * Raw unabbreviated register name from the spreadsheet import.
   * This is the authoritative source of truth for size/weight/count/flavor
   * tokens that the expected name should never lose. When the cleaned
   * `name` (expected_name) has already dropped details like "2.64OZ",
   * this field preserves the original signal.
   */
  rawRegisterName?: string | null;
  /** Brand hint from the spreadsheet import */
  brandHint?: string | null;
  /** Title extracted from the brand's official product page */
  webTitle?: string | null;
  /** Title extracted from packaging image OCR */
  ocrTitle?: string | null;
  /**
   * Operator-transcribed per-SKU title (parent #101, ticket #104).
   * Eligible as a deterministic title source when no packaging OCR truth
   * exists; also fed to the LLM prompt as an operator-verified signal.
   */
  manualTitle?: string | null;
  /** Weight extracted from VLM packaging OCR (e.g. "2 oz / 56.7 g") */
  ocrWeight?: string | null;
  /** Size extracted from VLM packaging OCR (e.g. "2 oz") */
  ocrSize?: string | null;
  /** Count extracted from VLM packaging OCR (e.g. "20-PIECE VALUE PACK", "6 Pack") */
  ocrCount?: string | null;
  /** Color extracted from VLM packaging OCR (issue #112, e.g. "Red") */
  ocrColor?: string | null;
  /** Optional product-line sibling context for variant-consistent naming */
  siblingContext?: {
    groupLabel: string;
    siblingNames: string[];
    siblingWebTitles: string[];
    siblingOcrTitles: string[];
    siblingSkus: string[];
  };
  /** Title signals from distributor evidence, in confidence/provider order. */
  distributorTitles?: Array<{
    title: string;
    providerId: string;
    attemptId: string;
    confidence: number;
  }>;
  /** Brand signals from distributor evidence, in confidence/provider order.
   *  Passed alongside distributorTitles so the LLM can cross-reference
   *  provider-specific brand names. */
  distributorBrands?: Array<{
    brand: string;
    providerId: string;
    attemptId: string;
    confidence: number;
  }>;
  /**
   * Variant signals from distributor evidence (issue #111): size, capacity
   * (volume), weight, count/pack-count from merchandising fields below the
   * distributor title. Joins the merged known-variant set for the prompt
   * and the deterministic restore guard.
   */
  distributorVariants?: Array<{
    field: string;
    value: string;
    providerId: string;
    attemptId?: string;
    confidence?: number;
  }>;
  /** Weight from official-page extraction evidence (issue #111). */
  extractionWeight?: string | null;
  /** Colors from labeled distributor specs lines (issue #112) — own colors. */
  labeledColors?: string[];
}

export interface TitleResult {
  title: string;
  source: 'web' | 'ocr' | 'llm' | 'manual';
  /** Durable model-call IDs that produced this title (issue #17 E). */
  modelCallIds?: string[];
  /** Resolved brand ensured exactly once in the title (issue #108). */
  brandApplied?: string | null;
  /**
   * True when no brand existed in any evidence, so the brand could not be
   * guaranteed. Callers must hold the item for a manual title (issue #108).
   */
  brandUnverified?: boolean;
  /**
   * Color ensured in the title for a multi-color family (issue #112), or
   * null when the item is single-color/unknown (untouched, never a hold).
   */
  colorApplied?: string | null;
  /**
   * Normalized variant tokens ensured as final tokens (issue #111), from
   * the merged known-variant set. Empty when no size/capacity is evidenced
   * anywhere — pairs with sizeUnverified for the member hold.
   */
  sizeApplied?: string[];
  /**
   * True when no size/capacity/weight/count is evidenced in any origin, so
   * no variant token could be guaranteed. Callers must hold the item
   * (issue #111, mirrors brandUnverified).
   */
  sizeUnverified?: boolean;
}

/**
 * Synthesizes the optimal store product title using all available name signals.
 *
 * When LLM is configured, delegates to the model for intelligent consolidation.
 * Otherwise uses a simple fallback: OCR title > web title > spreadsheet name.
 *
 * This is the shared implementation used by:
 * - Legacy `curateItem()` (imported directly)
 * - Modular `nameConsolidationStage` (imported directly)
 *
 * The LLM prompt rules have been updated from the original `finalizeTitle()`
 * to preserve variant attributes and enforce consistent formatting.
 */
export async function consolidateProductTitle(
  signals: TitleSignals,
  modelPolicy?: import('../classification/model-policy-gateway').ModelPolicyView | null,
  audit?: {
    modelCall?: import('../classification/model-operation-registry').ModelCallContext | null;
    snapshot?: import('../classification/runtime-snapshot').RuntimeClassificationSnapshot | null;
  },
): Promise<TitleResult> {
  // Protected route resolution can throw (missing credential, policy
  // denial). A denied attempt is still observable via exactly ONE durable
  // `policy_denied` row — never zero, and never double-counted with the
  // no-config `unavailable` row below (issue #17 pass 4c).
  let llmConfig: import('./llm-client').LlmConfig | null = null;
  let preflightRecorded = false;
  try {
    llmConfig = getLlmConfigForTask('product_curation', {
      allowFallback: true,
      modelPolicy,
      protectedOperation: 'title_consolidation',
    });
  } catch (err: any) {
    recordTerminalPreflight(
      audit?.modelCall,
      modelPolicy?.policyDigest ?? '',
      MODEL_CALL_STATUS.policyDenied,
      `Model policy denied title consolidation (${err?.code ?? err?.message ?? 'error'}).`,
    );
    preflightRecorded = true;
  }

  // Issue #108: the resolved brand authority for the deterministic
  // post-step. Every return below funnels through applyBrandGuarantee so
  // prompt guidance ("include the brand exactly once") is enforced by code.
  const brand = signals.brandHint?.trim() || null;

  // Issue #111: the merged known-variant set from EVERY evidence origin
  // (spreadsheet raw + expected names, web/OCR/manual titles, OCR
  // measurements, official weight, distributor titles + variant attributes).
  // Every return below funnels through applyVariantGuarantee so FORMAT_RULES
  // ("every numeric quantity is MANDATORY") is enforced by code.
  const variantSources = variantSourcesOf(signals);

  // Issue #112: color context for the deterministic post-step. Structured
  // colors (OCR color, distributor color attributes) are trusted as-is;
  // title texts and sibling names contribute vocabulary-scanned words.
  // The multi-color rule lives in ensureColorInTitle: fewer than two
  // distinct colors (or unknown own color) leaves the title untouched —
  // single-color items are unaffected and absence is never a hold.
  const structuredColors: Array<string | null | undefined> = [
    signals.ocrColor,
    ...(signals.distributorVariants ?? []).filter(v => v.field === 'color').map(v => v.value),
    ...(signals.labeledColors ?? []),
  ];
  const ownTitleTexts: Array<string | null | undefined> = [
    signals.name,
    signals.rawRegisterName,
    signals.webTitle,
    signals.ocrTitle,
    signals.manualTitle,
    ...(signals.distributorTitles ?? []).map(t => t.title),
  ];
  const ownColor = resolveOwnColor(structuredColors, ownTitleTexts);
  const familyColors = knownColorsAcross([
    ...structuredColors,
    ...ownTitleTexts,
    ...(signals.siblingContext?.siblingNames ?? []),
    ...(signals.siblingContext?.siblingWebTitles ?? []),
    ...(signals.siblingContext?.siblingOcrTitles ?? []),
  ]);

  // If LLM is not configured, prefer spreadsheet name (has variant tokens like LG, SM, YELLOW)
  // over web title which may strip them. OCR title still wins when available.
  // The attempted-but-unavailable call is still observable (durable row).
  if (!llmConfig) {
    if (!preflightRecorded) {
      recordTerminalPreflight(
        audit?.modelCall,
        modelPolicy?.policyDigest ?? '',
        MODEL_CALL_STATUS.unavailable,
        'No LLM config available for title consolidation.',
      );
    }
    if (signals.ocrTitle) {
      return applyVariantGuarantee(applyColorGuarantee(applyBrandGuarantee({ title: signals.ocrTitle, source: 'ocr' }, brand), ownColor, familyColors), variantSources);
    }
    // Parent #101 (manual-evidence route, ticket #104): the
    // operator-verified per-SKU title is deterministic truth — eligible
    // below packaging OCR visual truth, above the raw spreadsheet name.
    // Cohort semantic validation still applies downstream; this changes
    // only which signal wins, never whether validation runs.
    const manualTitle = signals.manualTitle?.trim() || null;
    if (manualTitle) {
      return applyVariantGuarantee(applyColorGuarantee(applyBrandGuarantee({ title: manualTitle, source: 'manual' }, brand), ownColor, familyColors), variantSources);
    }
    return applyVariantGuarantee(applyColorGuarantee(applyBrandGuarantee({ title: signals.name, source: 'web' }, brand), ownColor, familyColors), variantSources);
  }

  try {
    const prompt = buildPerItemPrompt({
      name: signals.name,
      rawRegisterName: signals.rawRegisterName,
      brandHint: signals.brandHint,
      webTitle: signals.webTitle,
      ocrTitle: signals.ocrTitle,
      manualTitle: signals.manualTitle ?? null,
      ocrWeight: signals.ocrWeight,
      ocrSize: signals.ocrSize,
      ocrCount: signals.ocrCount,
      ocrColor: signals.ocrColor,
      siblingContext: signals.siblingContext
        ? { groupLabel: signals.siblingContext.groupLabel, siblingNames: signals.siblingContext.siblingNames }
        : undefined,
      distributorTitles: signals.distributorTitles,
      distributorBrands: signals.distributorBrands,
      distributorVariants: signals.distributorVariants,
      extractionWeight: signals.extractionWeight,
      labeledColors: signals.labeledColors,
    });

    const auditedTitle = await callLlmForTaskWithProvenance('product_curation', prompt, 'You are a clean product taxonomy assistant.', {
      allowFallback: true,
      modelPolicy,
      protectedOperation: 'title_consolidation',
      ...(audit?.modelCall ? { modelCall: audit.modelCall, snapshot: audit.snapshot } : {}),
    });
    if (auditedTitle && auditedTitle.content.length > 2) {
      const cleanTitle = auditedTitle.content.trim();
      console.log(`[TitleConsolidation] LLM consolidated title: "${cleanTitle}"`);
      // story: e04s01, extended by issue #111 — variant preservation guard
      // over the MERGED known-variant set (not just the spreadsheet raw
      // name): distributor variant attributes, OCR measurements, and
      // official-page details below the title are restored exactly like
      // raw-register tokens instead of being silently dropped.
      // Issue #112: authorship order is brand → color → variant
      // (FORMAT_RULES size-final) — color before variant so the color
      // never lands after size. The wrappers below re-apply idempotently.
      const guardedTitle = ensureVariantTokensInTitle(
        ensureColorInTitle(
          brand ? ensureBrandInTitle(cleanTitle, brand) : cleanTitle,
          ownColor,
          familyColors,
        ),
        variantSources,
      );
      // If the LLM still produced an empty/whitespace title after guard, fail
      // closed to deterministic fallback so no invention occurs.
      if (!guardedTitle || guardedTitle.trim().length === 0) {
        const fallback = formatDeterministicTitle(signals.name, signals.brandHint ?? null);
        console.warn(`[TitleConsolidation] LLM title empty after guard; fallback deterministic: "${fallback}"`);
        return applyVariantGuarantee(applyColorGuarantee(applyBrandGuarantee({ title: fallback, source: 'llm', ...(auditedTitle.callId ? { modelCallIds: [auditedTitle.callId] } : {}) }, brand), ownColor, familyColors), variantSources);
      }
      // If guard restored tokens, keep llm source but with restored title —
      // the variant is preserved while provenance stays llm.
      if (guardedTitle !== cleanTitle) {
        console.log(`[TitleConsolidation] Restored variant tokens: "${guardedTitle}" (from merged ${variantSources.length} variant sources)`);
      }
      return applyVariantGuarantee(applyColorGuarantee(applyBrandGuarantee({
        title: guardedTitle,
        source: 'llm',
        ...(auditedTitle.callId ? { modelCallIds: [auditedTitle.callId] } : {}),
      }, brand), ownColor, familyColors), variantSources);
    }
  } catch (err: any) {
    console.warn(`[TitleConsolidation] LLM title consolidation failed: ${redactTransportText(err.message)}`);
  }

  // Fallback: spreadsheet name has the richest variant tokens
  return applyVariantGuarantee(applyColorGuarantee(applyBrandGuarantee({ title: signals.name, source: 'web' }, brand), ownColor, familyColors), variantSources);
}

/**
 * Collect the merged known-variant sources from every evidence origin
 * (issue #111). Titles contribute their embedded tokens; measurements and
 * distributor variant attributes contribute structured values. The
 * deterministic guard restores from this merged set — never invents.
 */
function variantSourcesOf(signals: TitleSignals): Array<string | null | undefined> {
  return [
    signals.name,
    signals.rawRegisterName,
    signals.webTitle,
    signals.ocrTitle,
    signals.manualTitle,
    signals.ocrWeight,
    signals.ocrSize,
    signals.ocrCount,
    signals.extractionWeight,
    ...(signals.distributorTitles ?? []).map(t => t.title),
    ...(signals.distributorVariants ?? []).map(v => v.value),
  ];
}

/**
 * Deterministic variant post-step (issue #111).
 *
 * Appends evidenced variant tokens missing from the title as final tokens;
 * records the ensured set in sizeApplied. When no size/capacity/weight/count
 * is evidenced anywhere, marks sizeUnverified so the caller holds the item
 * instead of shipping a variant-less name (mirrors applyBrandGuarantee).
 *
 * Exported for tests: same rationale as applyBrandGuarantee — the live-LLM
 * returns share this exact wrapper.
 */
// fallow-ignore-next-line unused-export — used by tests
export function applyVariantGuarantee<T extends { title: string; source: TitleResult['source'] }>(
  result: T,
  sources: Array<string | null | undefined>,
): T & { sizeApplied?: string[]; sizeUnverified?: boolean } {
  const known = knownVariantTokens(sources);
  if (known.length === 0) {
    return { ...result, sizeApplied: [], sizeUnverified: true };
  }
  return { ...result, title: ensureVariantTokensInTitle(result.title, sources), sizeApplied: known };
}

/**
 * Deterministic color post-step (issue #112).
 *
 * Applies `ensureColorInTitle` with the item's own color and the family
 * color set; records the ensured color in colorApplied (null when the
 * title was correctly left untouched). Unlike brand/size there is NO
 * unverified flag: a single known color — or no color at all — leaves the
 * title unchanged by design and never holds the item (mirrors the
 * applyBrandGuarantee shape for test parity).
 *
 * Exported for tests: the live-LLM returns share this exact wrapper.
 */
// fallow-ignore-next-line unused-export — used by tests
export function applyColorGuarantee<T extends { title: string; source: TitleResult['source'] }>(
  result: T,
  ownColor: string | null | undefined,
  familyColors: string[],
): T & { colorApplied?: string | null } {
  const cleanOwn = ownColor?.trim() || null;
  // Metadata contract mirrors the ensure gate: the carried color is
  // recorded whenever the multi-color rule engages (appended or already
  // present); single-color/unknown leaves colorApplied null.
  const distinct = [...new Set((familyColors ?? []).map(c => c?.trim()).filter(Boolean))] as string[];
  if (!cleanOwn || distinct.length < 2) return { ...result, colorApplied: null };
  return { ...result, title: ensureColorInTitle(result.title, cleanOwn, distinct), colorApplied: cleanOwn };
}

/**
 * Deterministic brand post-step (issue #108).
 *
 * Applies `ensureBrandInTitle` when a resolved brand exists; otherwise marks
 * the result unverified so the caller holds the item for a manual title
 * instead of shipping (or inventing) a brandless name.
 *
 * Exported for tests: the live-LLM returns share this exact wrapper, and a
 * run-bound LLM call cannot be fabricated outside the audited pipeline
 * (fail-closed plan compatibility), so the wrapper is pinned directly.
 */
// fallow-ignore-next-line unused-export — used by tests
export function applyBrandGuarantee<T extends { title: string; source: TitleResult['source'] }>(
  result: T,
  brand: string | null,
): T & { brandApplied?: string | null; brandUnverified?: boolean } {
  if (brand) {
    return { ...result, title: ensureBrandInTitle(result.title, brand), brandApplied: brand };
  }
  return { ...result, brandUnverified: true };
}
