/**
 * Issue #214 — shared domain/version health evaluator (single definition of
 * reviewed health).
 *
 * ONE typed, read-only evaluator for a specific domain plus profile version.
 * Every entry point resolves health through it so "healthy" cannot drift:
 *
 * - activation (`POST /api/domains/:domain/profile/activate`) evaluates a
 *   CANDIDATE version via `evaluateCandidateVersionHealth` — no requirement
 *   that the candidate already be active (no circular dependence);
 * - automatic domain release (`getDomainReleaseHealth`, the worker sweep,
 *   the explicit release endpoint, and the activation-triggered release —
 *   all funnel through that one function) evaluates the ACTIVE version via
 *   `evaluateActiveVersionHealth` and additionally requires the active
 *   pointer to resolve to an existing version row (fail closed otherwise);
 * - retry preview (`GET profile-retry-preview/:domain`) surfaces the
 *   active-version verdict read-only (the deliberate retry itself stays
 *   ungated per #198 — display only, never a gate);
 * - health UI (`GET /api/domains/:domain/profile-state`) surfaces the same
 *   verdict as `reviewedHealth` (existing header fields untouched);
 * - telemetry records the verdict's `reason` via the release result's
 *   `healthReason` — no independent assembly exists there.
 *
 * The pure gate (`evaluateGate`) is unchanged — only the evidence assembly
 * (the `GateInput` construction previously duplicated in the activation
 * route and `getDomainReleaseHealth`) is consolidated here. Executable-
 * content binding (post-activation edits forcing re-evaluation) is issue
 * #217's seam and deliberately NOT added here.
 *
 * Read-only: this module performs zero writes. Fail-closed: any evaluation
 * error yields unhealthy (`health_check_failed`).
 */
import { getActiveVersion, getVersionById } from '../db/repositories/profile-version-repo';
import { hasValidWaiver } from '../db/repositories/waiver-repo';
import { getRepresentativeSuite } from '../db/repositories/representative-suite-repo';
import { getMatrixResult } from './profile-test-matrix';
import { evaluateGate, type GateInput, type GateResult } from './profile-activation-gate';
import { templateAwarePrefix } from './template-clustering';
import { getSuiteSuggestion } from './suite-suggestion-service';

/** Normalize a domain for comparison (lowercase, trim, strip leading `www.`). */
function normalizeHealthDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '').trim();
}

/** Read-only reviewed-health verdict for one domain plus profile version. */
export interface DomainVersionHealth {
  domain: string;
  /** Evaluated version id; null when no version resolved (unknown/active-missing). */
  versionId: string | null;
  healthy: boolean;
  /**
   * Machine-readable reason (`unknown_version`, `version_domain_mismatch`,
   * `no_active_version`, gate block reasons, …); null when healthy.
   */
  reason: string | null;
  /** Full gate verdict; null when evaluation stopped before the gate. */
  gate: GateResult | null;
}

/** Confirmed representative sample URLs via the suite repository (fail-closed to empty). */
function serverSampleIds(domain: string): string[] {
  try {
    return getRepresentativeSuite(domain);
  } catch { return []; }
}

/**
 * THE single assembly of gate inputs for a domain plus version.
 * Read-only; fail-closed (`health_check_failed`) on any evaluation error.
 */
export function evaluateDomainVersionHealth(domain: string, versionId: string): DomainVersionHealth {
  const normalized = normalizeHealthDomain(domain);
  try {
    const version = getVersionById(versionId);
    if (!version) {
      return { domain: normalized, versionId: null, healthy: false, reason: 'unknown_version', gate: null };
    }
    if (version.domain !== normalized) {
      return { domain: normalized, versionId: version.id, healthy: false, reason: 'version_domain_mismatch', gate: null };
    }
    const matrix = getMatrixResult(normalized, version.id);
    const sampleUrls = serverSampleIds(normalized);
    const clusterIds: string[] = (() => {
      try {
        const confirmedPrefixes = new Set(sampleUrls.map(u => templateAwarePrefix(u)));
        const suggestion = getSuiteSuggestion(normalized);
        const matched = suggestion.clusters.map(cl => cl.prefix).filter(p => confirmedPrefixes.has(p));
        if (matched.length > 0) return matched;
        return Array.from(confirmedPrefixes);
      } catch (_e) {
        return Array.from(new Set(sampleUrls.map(u => templateAwarePrefix(u))));
      }
    })();
    const requiredResults: GateInput['requiredResults'] = matrix
      ? matrix.rows.flatMap(r =>
        r.cells.map(cell => ({ field: cell.field, success: cell.success, provenance: cell.provenance, artifactHash: cell.artifactHash })),
      )
      : [];
    const wrongProduct = matrix ? matrix.rows.some(r => r.cells.some(c => (c.failureReason ?? '').includes('wrong_product'))) : false;
    const wrongVariant = matrix ? matrix.rows.some(r => r.cells.some(c => (c.failureReason ?? '').includes('wrong_variant'))) : false;
    const gate = evaluateGate({
      requiredResults,
      wrongProduct,
      wrongVariant,
      waiver: hasValidWaiver(normalized),
      confirmedCount: sampleUrls.length,
      imageRuleOk: (version.validationSummary as { imageRuleOk?: boolean } | null | undefined)?.imageRuleOk,
      matrixResult: matrix,
      expectedArtifactHashes: version.artifactHashes,
      sampleIds: sampleUrls,
      clusterIds,
    });
    if (!gate.allowed) {
      return { domain: normalized, versionId: version.id, healthy: false, reason: gate.blockReason ?? gate.reason ?? 'activation_gate_failed', gate };
    }
    return { domain: normalized, versionId: version.id, healthy: true, reason: null, gate };
  } catch (_e) {
    return { domain: normalized, versionId: null, healthy: false, reason: 'health_check_failed', gate: null };
  }
}

/**
 * Activation semantics (issue #214): evaluate a CANDIDATE version on its own
 * evidence. The candidate is NOT required to be active — otherwise no
 * version could ever activate (circular dependence).
 */
export function evaluateCandidateVersionHealth(domain: string, versionId: string): DomainVersionHealth {
  return evaluateDomainVersionHealth(domain, versionId);
}

/**
 * Release semantics (issue #214): the evaluated version must be the ACTIVE
 * one and must resolve to an existing version row. Anything else fails
 * closed — release refuses non-active versions.
 */
export function evaluateActiveVersionHealth(domain: string): DomainVersionHealth {
  const normalized = normalizeHealthDomain(domain);
  try {
    const active = getActiveVersion(normalized);
    if (!active) {
      return { domain: normalized, versionId: null, healthy: false, reason: 'no_active_version', gate: null };
    }
    return evaluateDomainVersionHealth(normalized, active.id);
  } catch (_e) {
    return { domain: normalized, versionId: null, healthy: false, reason: 'health_check_failed', gate: null };
  }
}
