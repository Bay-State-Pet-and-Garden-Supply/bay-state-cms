/**
 * Shared title consolidation logic used by both the legacy and modular curation paths.
 *
 * Synthesizes the optimal store product title from all available name signals:
 * spreadsheet name, web-extracted title, packaging OCR title, and brand hint.
 *
 * Exported as a standalone helper so it can be reused by the modular
 * name-consolidation classification stage without duplicating LLM prompts.
 */
import { getLlmConfigForTask, callLlmForTaskWithProvenance, verifyAndRestoreProtectedTokens } from './llm-client';
import { redactTransportText } from '../classification/model-policy-gateway';
import { MODEL_CALL_STATUS } from '../classification/model-operation-registry';
import { recordTerminalPreflight } from '../db/repositories/classification-model-call-repo';
import { buildPerItemPrompt, ensureBrandInTitle } from './title-prompt-template';
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
      return applyBrandGuarantee({ title: signals.ocrTitle, source: 'ocr' }, brand);
    }
    // Parent #101 (manual-evidence route, ticket #104): the
    // operator-verified per-SKU title is deterministic truth — eligible
    // below packaging OCR visual truth, above the raw spreadsheet name.
    // Cohort semantic validation still applies downstream; this changes
    // only which signal wins, never whether validation runs.
    const manualTitle = signals.manualTitle?.trim() || null;
    if (manualTitle) {
      return applyBrandGuarantee({ title: manualTitle, source: 'manual' }, brand);
    }
    return applyBrandGuarantee({ title: signals.name, source: 'web' }, brand);
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
      siblingContext: signals.siblingContext
        ? { groupLabel: signals.siblingContext.groupLabel, siblingNames: signals.siblingContext.siblingNames }
        : undefined,
      distributorTitles: signals.distributorTitles,
      distributorBrands: signals.distributorBrands,
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
      // story: e04s01 — variant preservation guard: if rawRegisterName carried
      // protected tokens (SM/LG/weight/count) that the LLM dropped, restore
      // them deterministically instead of losing the variant.
      const guardedTitle = signals.rawRegisterName
        ? verifyAndRestoreProtectedTokens(cleanTitle, signals.rawRegisterName)
        : cleanTitle;
      // If the LLM still produced an empty/whitespace title after guard, fail
      // closed to deterministic fallback so no invention occurs.
      if (!guardedTitle || guardedTitle.trim().length === 0) {
        const fallback = formatDeterministicTitle(signals.name, signals.brandHint ?? null);
        console.warn(`[TitleConsolidation] LLM title empty after guard; fallback deterministic: "${fallback}"`);
        return applyBrandGuarantee({ title: fallback, source: 'llm', ...(auditedTitle.callId ? { modelCallIds: [auditedTitle.callId] } : {}) }, brand);
      }
      // If guard restored tokens, keep llm source but with restored title —
      // the variant is preserved while provenance stays llm.
      if (guardedTitle !== cleanTitle) {
        console.log(`[TitleConsolidation] Restored variant tokens: "${guardedTitle}" (from raw "${signals.rawRegisterName}")`);
      }
      return applyBrandGuarantee({
        title: guardedTitle,
        source: 'llm',
        ...(auditedTitle.callId ? { modelCallIds: [auditedTitle.callId] } : {}),
      }, brand);
    }
  } catch (err: any) {
    console.warn(`[TitleConsolidation] LLM title consolidation failed: ${redactTransportText(err.message)}`);
  }

  // Fallback: spreadsheet name has the richest variant tokens
  return applyBrandGuarantee({ title: signals.name, source: 'web' }, brand);
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
