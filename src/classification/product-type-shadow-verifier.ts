/**
 * Product Type Shadow Verifier (P2.1 / P2.3).
 *
 * Runs the deterministic Product Type verifier alongside pipeline execution
 * in shadow mode. Logs verification telemetry and divergence without altering
 * live classification proposals, decisions, or review state.
 */

import { getDb } from '../db/connection';
import { getTypeFirstCurationFlags } from './flags';
import {
  verifyProductTypeCandidate,
  type VerifyProductTypeInput,
  type ProductTypeVerificationResult,
} from './product-type-verifier';

export interface ProductTypeShadowObservation {
  runId: string;
  productSku: string;
  candidateProductTypeId: string;
  candidateConfidence: number;
  verdict: string;
  recommendedProductTypeId: string | null;
  verifierConfidence: number;
  reasonCode: string;
  evidenceStrength: string;
  disagreed: boolean;
  timestamp: string;
}

/**
 * Execute shadow verification for a candidate Product Type proposal.
 * Swallow errors fail-safe so shadow mode never crashes live pipeline execution.
 */
export function recordProductTypeShadowVerification(
  input: VerifyProductTypeInput & { runId: string },
): ProductTypeVerificationResult | null {
  const flags = getTypeFirstCurationFlags();
  // Tri-state mode owns deterministic verification; second-model shadow has its own switch.
  // Both off by default; shadow output is telemetry-only, never authoritative.
  if (flags.productTypeDeterministicVerifierMode === 'off' && !flags.productTypeSecondModelShadowEnabled && !flags.productTypeShadowEnabled && !flags.productTypeVerifierEnabled) {
    return null;
  }

  try {
    const result = verifyProductTypeCandidate(input);
    const disagreed = result.verdict !== 'pass_candidate' || result.recommendedProductTypeId !== input.candidateProductTypeId;

    const db = getDb();
    const now = new Date().toISOString();

    // Dedicated telemetry table — never classification_evidence (which review
    // hydrates and the verifier reads). Machine shadow output must not feed
    // back into evidence counts or appear as manager guidance.
    db.run(
      `CREATE TABLE IF NOT EXISTS classification_product_type_shadow (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, product_sku TEXT NOT NULL,
        candidate_product_type_id TEXT, candidate_confidence REAL,
        verdict TEXT NOT NULL, recommended_product_type_id TEXT,
        verifier_confidence REAL, reason_code TEXT, disagreed INTEGER NOT NULL,
        payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      )`,
    );
    db.query(
      `INSERT OR IGNORE INTO classification_product_type_shadow
       (id, run_id, product_sku, candidate_product_type_id, candidate_confidence,
        verdict, recommended_product_type_id, verifier_confidence, reason_code,
        disagreed, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `shadow-verif-${input.runId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      input.runId,
      input.sku ?? '',
      input.candidateProductTypeId,
      input.candidateConfidence,
      result.verdict,
      result.recommendedProductTypeId,
      result.confidence,
      result.reasonCode,
      disagreed ? 1 : 0,
      JSON.stringify({
        verdict: result.verdict,
        candidateProductTypeId: input.candidateProductTypeId,
        candidateConfidence: input.candidateConfidence,
        recommendedProductTypeId: result.recommendedProductTypeId,
        verifierConfidence: result.confidence,
        reasonCode: result.reasonCode,
        disagreed,
        evidenceSummary: result.evidenceSummary,
      }),
      now,
    );

    return result;
  } catch (_err) {
    // Fail-safe: shadow observations must never crash live processing
    return null;
  }
}
