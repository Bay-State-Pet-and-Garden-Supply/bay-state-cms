// story: e06s04, e07s01, e07s04 — evidence-gated + cluster-aware activation (fail-closed)
import type { MatrixResult } from './profile-test-matrix';
import { templateAwarePrefix } from './template-clustering';

export interface GateInput {
  requiredResults: Array<{ field: string; success: boolean; provenance?: string; artifactHash?: string }>;
  wrongProduct: boolean;
  wrongVariant: boolean;
  waiver: boolean;
  confirmedCount: number;
  imageRuleOk?: boolean;
  // e07s01 evidence (optional for backward compat; when supplied, fail-closed)
  matrixResult?: MatrixResult | null;
  expectedArtifactHashes?: string[] | null;
  sampleIds?: string[];
  clusterIds?: string[];
}

export interface GateResult {
  allowed: boolean;
  blockReason: string | null;
  reviseAction: string | null;
  reason: string | null;
}

/**
 * Issue #218 — the reviewed-health gate enforces its documented contract
 * and fails closed. Any caller that legitimately needs a weaker check
 * (e.g. an evidence-only preview without image attestation) must name
 * and justify its OWN gate function — this gate is never reused loosely.
 */
/** True when the caller opts into e07s01 evidence gating. */
function hasEvidenceFields(input: GateInput): boolean {
  return 'matrixResult' in input || 'expectedArtifactHashes' in input || 'sampleIds' in input;
}

/** Refusal when evidence is gated but no matrix ran, else null. */
function missingMatrixRefusal(input: GateInput): GateResult | null {
  if (!hasEvidenceFields(input)) return null;
  if (input.matrixResult !== null && input.matrixResult !== undefined) return null;
  return { allowed: false, blockReason: 'missing_matrix', reviseAction: 'Run test matrix against all confirmed samples', reason: 'missing_matrix' };
}

/**
 * Refusal on an empty expected-hash set, else null. Issue #218: empty
 * sets fail rather than skipping comparison — misconfiguration must
 * never masquerade as agreement.
 */
function missingHashesRefusal(input: GateInput): GateResult | null {
  if (!('expectedArtifactHashes' in input)) return null;
  if (input.expectedArtifactHashes && input.expectedArtifactHashes.length > 0) return null;
  return { allowed: false, blockReason: 'missing_expected_hashes', reviseAction: 'Record expected artifact hashes for the confirmed samples', reason: 'missing_expected_hashes: expected artifact hash set is empty' };
}

/** Refusal when the matrix skips confirmed samples, else null. */
function missingSamplesRefusal(input: GateInput): GateResult | null {
  if (!input.sampleIds || input.sampleIds.length === 0) return null;
  const seen = new Set(input.matrixResult!.rows.map(r => r.sampleId));
  const missing = input.sampleIds.filter(id => !seen.has(id));
  if (missing.length === 0) return null;
  return { allowed: false, blockReason: 'missing_samples', reviseAction: `Run matrix against missing samples: ${missing.join(', ')}`, reason: `missing_samples: ${missing.join(', ')}` };
}

/** e07s01 evidence checks composed: first refusal wins, else null. */
function evidenceGateResult(input: GateInput): GateResult | null {
  return (
    missingMatrixRefusal(input) ??
    missingHashesRefusal(input) ??
    artifactHashGateResult(input) ??
    missingSamplesRefusal(input) ??
    clusterGateResult(input)
  );
}

/** Artifact-hash comparison: refusal on mismatch, else null. */
function artifactHashGateResult(input: GateInput): GateResult | null {
  if (!input.expectedArtifactHashes || input.expectedArtifactHashes.length === 0) return null;
  const expected = [...input.expectedArtifactHashes].sort();
  const actual = [...new Set(input.matrixResult!.rows.flatMap(r => r.cells.map(c => c.artifactHash)))].sort();
  const mismatch = expected.length !== actual.length || expected.some((h, i) => h !== actual[i]);
  if (!mismatch) return null;
  return { allowed: false, blockReason: 'artifact_mismatch', reviseAction: 'Revise captures — artifact hashes do not match expected set', reason: `artifact_mismatch expected=${expected.join(',')} actual=${actual.join(',')}` };
}

/** Per-cluster coverage: refusal on missing/failing clusters, else null. */
function clusterGateResult(input: GateInput): GateResult | null {
  if (!input.clusterIds || input.clusterIds.length === 0) return null;
  for (const cid of input.clusterIds) {
    const rowsForCluster = input.matrixResult!.rows.filter(r => templateAwarePrefix(r.sampleUrl) === cid);
    if (rowsForCluster.length === 0) {
      return { allowed: false, blockReason: 'missing_cluster', reviseAction: `Revise <field> selector for cluster ${cid}`, reason: `missing_cluster ${cid} expected vs actual: no sample for ${cid}` };
    }
    const failing = rowsForCluster.flatMap(r => r.cells.filter(c => !c.success));
    if (failing.length > 0) {
      const f = failing[0];
      return { allowed: false, blockReason: `${f.field} failed in cluster ${cid}`, reviseAction: `Revise ${f.field} selector for cluster ${cid}`, reason: `${f.field} failed in cluster ${cid} expected=${f.expected ?? ''} actual=${f.extracted ?? ''} provenance=${f.provenance} artifact=${f.artifactHash}` };
    }
  }
  return null;
}

/** Refusal on wrong-product/variant signals, else null. */
function identityRefusal(input: GateInput): GateResult | null {
  if (input.wrongProduct) return { allowed: false, blockReason: 'wrong_product', reviseAction: 'Revise selectors to avoid wrong_product', reason: 'wrong_product detected' };
  if (input.wrongVariant) return { allowed: false, blockReason: 'wrong_variant', reviseAction: 'Revise selectors to avoid wrong_variant', reason: 'wrong_variant detected' };
  return null;
}

/**
 * Refusal when image attestation is failed or absent, else null.
 * Issue #218: absent image evidence is never read as approval.
 */
function imageAttestationRefusal(input: GateInput): GateResult | null {
  if (input.imageRuleOk === false) return { allowed: false, blockReason: 'image rule failed', reviseAction: 'Revise image selectors per two-sample rule', reason: 'image rule failed' };
  if (input.imageRuleOk !== true) return { allowed: false, blockReason: 'missing_image_attestation', reviseAction: 'Attest image-preview review for the confirmed samples', reason: 'missing_image_attestation: image rule attestation is absent' };
  return null;
}

/** Refusal when a required cell failed, else null. */
function failingCellRefusal(input: GateInput): GateResult | null {
  const failing = input.requiredResults.filter(r => !r.success);
  if (failing.length === 0) return null;
  const f = failing[0];
  const r = f as Record<string, unknown> & { field: string; expected?: unknown; extracted?: unknown; provenance?: unknown; artifactHash?: unknown };
  return { allowed: false, blockReason: `${r.field} failed on 1 of ${input.requiredResults.length}`, reviseAction: `Revise ${r.field} selector`, reason: `${r.field} failed expected=${String(r.expected ?? '')} actual=${String(r.extracted ?? '')} provenance=${String(r.provenance ?? '')} artifact=${String(r.artifactHash ?? '')}` };
}

/**
 * The contract's minimum bar: a non-empty result set containing at least
 * one successful title, plus no failing cells. Returns a refusal, or null
 * when the bar passes. Issue #218: a waiver excuses only the confirmation
 * count — never this bar.
 */
function resultsBarRefusal(input: GateInput): GateResult | null {
  if (!input.requiredResults || input.requiredResults.length === 0) return { allowed: false, blockReason: 'missing_results', reviseAction: 'Run test matrix against all confirmed samples', reason: 'missing_results: no required results to evaluate' };
  if (!input.requiredResults.some(r => r.field === 'title' && r.success)) return { allowed: false, blockReason: 'missing_title', reviseAction: 'Revise title selector', reason: 'missing_title: no successful title result' };
  return failingCellRefusal(input);
}

/** Signal bar composed: first refusal wins, else null. */
function signalGateResult(input: GateInput): GateResult | null {
  return (
    identityRefusal(input) ??
    imageAttestationRefusal(input) ??
    resultsBarRefusal(input)
  );
}

export function evaluateGate(input: GateInput): GateResult {
  return (
    evidenceGateResult(input) ??
    signalGateResult(input) ??
    (input.confirmedCount < 3 && !input.waiver
      ? { allowed: false, blockReason: 'needs_waiver: <3 confirmed products without audited waiver', reviseAction: null, reason: 'needs_waiver' }
      : null) ??
    { allowed: true, blockReason: null, reviseAction: null, reason: null }
  );
}

export function canActivateVersion(input: { draftVersion: string; passingVersion: string | null }): boolean {
  if (!input.passingVersion) return false;
  return input.draftVersion === input.passingVersion;
}
