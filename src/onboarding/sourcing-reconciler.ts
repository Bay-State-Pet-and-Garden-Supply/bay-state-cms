import { createRequire } from 'node:module';
import type { EvidenceAttempt, ProductIdentityEvidence } from '../shared/schemas/distributor-evidence';
import { ProductIdentityEvidenceSchema } from '../shared/schemas/distributor-evidence';
import type { ConnectorVariantAxisDeclaration } from './sourcing/contracts';
import {
  isIdentityCriticalField,
  normalizeVariantAxis,
  isUnknownVariantAxis,
  normalizeDeclaredVariantAxis,
} from './sourcing/contracts';
import { normalizeIdentityValueForComparison, IDENTITY_NORMALIZATION_VERSION } from './normalization/identity';

/**
 * Lazy DB require (established pattern: `src/classification/catalog-evidence.ts`).
 * The pure evaluation path in this module must never pull the conflict
 * repository (or SQLite) into the module graph; the legacy reconciliation
 * export loads it lazily and stays SYNCHRONOUS so the worker's completion
 * contract (item transitions before poll() returns) is preserved.
 */
const lazyRequire = createRequire(import.meta.url);

export interface SourcingReconciliationResult {
  acceptedAttemptIds: string[];
  providerIds: string[];
  hardConflictCount: number;
  softConflictCount: number;
  hasHardIdentityConflict: boolean;
  /** True when a found record carries an unrecognized variant attribute (Amendment A). */
  hasUnknownVariantAxis: boolean;
  warnings: string[];
}

// ─── Pure evaluation API (Amendment A) ─────────────────────────────────────────

export interface EvaluationConflictCandidate {
  attemptId: string;
  providerId: string;
  value: string;
  rawValue: unknown;
}

export interface DistributorEvidenceEvaluationConflict {
  field: string;
  severity: 'hard' | 'soft';
  candidates: EvaluationConflictCandidate[];
}

export interface SourcingEvaluationOptions {
  /**
   * Connector-declared variant axes for the current generation (Amendment A).
   * Validated/normalized via `normalizeDeclaredVariantAxis`; declarations
   * join `IDENTITY_CRITICAL_FIELDS` as hard fields for this evaluation.
   */
  declaredVariantAxes?: readonly string[];
  /**
   * Durable raw-field → normalized-axis declarations (Amendment A). Raw
   * attribute keys listed here are treated as declared (never unknown), and
   * their normalized axes join the hard identity-field set.
   */
  variantAxisDeclarations?: readonly ConnectorVariantAxisDeclaration[];
}

export interface DistributorEvidenceEvaluation {
  acceptedAttemptIds: string[];
  providerIds: string[];
  hardConflictCount: number;
  softConflictCount: number;
  hasHardIdentityConflict: boolean;
  /**
   * True when any found record carries a variant-bearing attribute that is
   * neither a built-in axis nor a connector-declared axis. Such records are
   * INSUFFICIENT for Discovery-skip qualification (never silently soft).
   */
  hasUnknownVariantAxis: boolean;
  /** Disagreements only (coherent fields are not conflicts). */
  conflicts: DistributorEvidenceEvaluationConflict[];
  warnings: string[];
}

function formatWarningValue(val: string, maxLen = 50): string {
  const singleLine = val.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLen) return singleLine;
  return `${singleLine.slice(0, maxLen - 3)}...`;
}

function clampWarning(msg: string, maxLen = 480): string {
  if (msg.length <= maxLen) return msg;
  return `${msg.slice(0, maxLen - 3)}...`;
}

/**
 * Pure, side-effect-free evidence reconciliation (Amendment A).
 *
 * Returns conflict candidates (field → attempts/value pairs, including
 * flavor/formula and connector-declared axes as HARD), warnings, accepted
 * attempt inputs, and qualification inputs. Performs NO DB writes and never
 * consults confidence: the caller (worker or conflict-resolution flow) owns
 * persistence and routing. Unknown variant axes surface as an insufficiency
 * signal (`hasUnknownVariantAxis`) plus a warning, never as a silent soft
 * conflict.
 *
 * The identity of every found attempt is parsed with the strict
 * `ProductIdentityEvidenceSchema`; malformed identity evidence contributes
 * nothing and is never accepted blindly.
 */
export function evaluateDistributorEvidence(
  itemId: string,
  attempts: EvidenceAttempt[],
  sourcingGenerationId: string | null = null,
  options: SourcingEvaluationOptions = {},
): DistributorEvidenceEvaluation {
  void itemId;
  void sourcingGenerationId;

  const foundAttempts = attempts.filter((a) => a.outcome === 'found');

  if (foundAttempts.length === 0) {
    return {
      acceptedAttemptIds: [],
      providerIds: [],
      hardConflictCount: 0,
      softConflictCount: 0,
      hasHardIdentityConflict: false,
      hasUnknownVariantAxis: false,
      conflicts: [],
      warnings: ['No distributor evidence found'],
    };
  }

  const declaredAxes = new Set<string>();
  for (const axis of options.declaredVariantAxes ?? []) {
    const normalized = normalizeDeclaredVariantAxis(axis);
    if (normalized) declaredAxes.add(normalized);
  }
  const rawDeclared = new Map<string, string>();
  for (const declaration of options.variantAxisDeclarations ?? []) {
    const normalized = normalizeDeclaredVariantAxis(declaration.normalizedAxis);
    if (!normalized) continue;
    declaredAxes.add(normalized);
    if (declaration.rawField && !rawDeclared.has(declaration.rawField)) {
      rawDeclared.set(declaration.rawField, normalized);
    }
  }
  const isHardField = (field: string) => isIdentityCriticalField(field) || declaredAxes.has(field);

  // Group candidate values by field across attempt objects. Variant
  // dimensions nested under `attributes` are FLATTENED and NORMALIZED into
  // their canonical axis names (size/count/packCount/flavor/formula) so
  // disagreements on identity-critical variant keys are hard conflicts,
  // never a soft 'attributes' blob. Unrecognized variant-bearing keys are
  // flagged as insufficiency signals.
  const candidatesByField = new Map<string, EvaluationConflictCandidate[]>();
  const attemptsWithCandidates = new Set<string>();
  const unknownVariantAxes = new Set<string>();

  const addCandidate = (attemptId: string, providerId: string, key: string, rawValue: unknown) => {
    if (rawValue === null || rawValue === undefined || rawValue === '') return;
    const strVal = typeof rawValue === 'object' ? JSON.stringify(rawValue) : String(rawValue).trim();
    if (!strVal) return;
    if (!candidatesByField.has(key)) {
      candidatesByField.set(key, []);
    }
    candidatesByField.get(key)!.push({ attemptId, providerId, value: strVal, rawValue });
    attemptsWithCandidates.add(attemptId);
  };

  for (const attempt of foundAttempts) {
    const identRaw = attempt.identityJson;
    if (!identRaw) continue;
    let identity: ProductIdentityEvidence;
    try {
      const parsed = ProductIdentityEvidenceSchema.safeParse(JSON.parse(identRaw) as unknown);
      if (!parsed.success) continue;
      identity = parsed.data;
    } catch {
      // Malformed identityJson on a single attempt is skipped, never fatal.
      continue;
    }
    for (const [key, val] of Object.entries(identity)) {
      if (key === 'attributes' && val !== null && typeof val === 'object' && !Array.isArray(val)) {
        for (const [attrKey, attrVal] of Object.entries(val as Record<string, string>)) {
          const axis = normalizeVariantAxis(attrKey);
          if (axis !== null) {
            addCandidate(attempt.id, attempt.providerId, axis, attrVal);
          } else {
            // Durable registry rawField match: declared, never unknown.
            const registeredAxis = rawDeclared.get(attrKey);
            if (registeredAxis) {
              addCandidate(attempt.id, attempt.providerId, registeredAxis, attrVal);
            } else {
              // Connector-declared custom axis: participates as a hard field.
              const declaredAxis = normalizeDeclaredVariantAxis(attrKey);
              if (declaredAxis && declaredAxes.has(declaredAxis)) {
                addCandidate(attempt.id, attempt.providerId, declaredAxis, attrVal);
              } else if (isUnknownVariantAxis(attrKey, options.declaredVariantAxes ?? [])) {
                unknownVariantAxes.add(attrKey);
              }
            }
          }
        }
        continue;
      }
      addCandidate(attempt.id, attempt.providerId, key, val);
    }
  }

  let hardConflictCount = 0;
  let softConflictCount = 0;
  let hasHardIdentityConflict = false;
  const warnings: string[] = [];
  const conflicts: DistributorEvidenceEvaluationConflict[] = [];
  const acceptedAttemptIds = new Set<string>();
  const providerIds = Array.from(new Set(foundAttempts.map((a) => a.providerId)));

  for (const [field, candidates] of candidatesByField.entries()) {
    // Identity fields compare on CANONICAL values — weight in pounds to two decimals,
    // brand case-folded, packCount integer-normalized.
    const comparisonValue = (c: EvaluationConflictCandidate): string => {
      const normalized = normalizeIdentityValueForComparison(field, c.value);
      return normalized.status === 'normalized' ? normalized.comparisonValue : c.value.toLowerCase();
    };
    const distinctValues = Array.from(new Set(candidates.map(comparisonValue)));

    if (distinctValues.length > 1) {
      // Ticket #123: an identity-critical disagreement SPANNING official
      // and distributor evidence is a trust conflict, not a taste
      // difference — it stays upstream (held, never blended). Same-kind
      // disagreements keep the established consensus auto-resolution
      // below (Amendment A behavior, covered by distributor e2e suites).
      const spansAuthorities = new Set(
        candidates.map((c) => (c.providerId.toLowerCase().startsWith('official_page:') ? 'official' : 'distributor')),
      );
      if (isHardField(field) && spansAuthorities.has('official') && spansAuthorities.has('distributor')) {
        hasHardIdentityConflict = true;
        hardConflictCount++;
        conflicts.push({ field, severity: 'hard', candidates });
        warnings.push(
          clampWarning(
            `Identity field '${field}' disagrees across official and distributor evidence ` +
              `(${candidates.map((c) => `${c.providerId}='${formatWarningValue(c.value)}'`).join(', ')}) — held for operator review`,
          ),
        );
        continue;
      }
      // Auto-resolve multi-distributor discrepancies:
      // 1. Calculate frequency of each normalized comparison value (consensus)
      const counts = new Map<string, number>();
      for (const c of candidates) {
        const comp = comparisonValue(c);
        counts.set(comp, (counts.get(comp) ?? 0) + 1);
      }
      let bestComp = comparisonValue(candidates[0]);
      let bestCount = counts.get(bestComp) ?? 0;
      for (const c of candidates) {
        const comp = comparisonValue(c);
        const count = counts.get(comp) ?? 0;
        if (count > bestCount) {
          bestCount = count;
          bestComp = comp;
        }
      }
      const winningCandidate = candidates.find((c) => comparisonValue(c) === bestComp) ?? candidates[0];

      softConflictCount++;
      warnings.push(
        clampWarning(
          `Identity field '${field}' auto-resolved to '${formatWarningValue(winningCandidate.value)}' from distributor '${winningCandidate.providerId}' ` +
            `(alternatives: ${candidates.filter((c) => c !== winningCandidate).map((c) => `${c.providerId}='${formatWarningValue(c.value)}'`).join(', ')})`,
        ),
      );

      conflicts.push({ field, severity: 'soft', candidates });

      for (const c of candidates) {
        acceptedAttemptIds.add(c.attemptId);
      }
    } else if (candidates.length > 0) {
      // Coherent value across providers contributes every agreeing attempt.
      const rawDistinct = Array.from(new Set(candidates.map((c) => c.value.toLowerCase())));
      if (rawDistinct.length > 1) {
        warnings.push(
          clampWarning(
            `Identity field '${field}' values agree after normalization (rule v${IDENTITY_NORMALIZATION_VERSION}): ` +
              `${candidates.map((c) => `${c.providerId}=${formatWarningValue(c.value)}`).join(', ')} → '${distinctValues[0]}'`,
          ),
        );
      }
      for (const c of candidates) {
        acceptedAttemptIds.add(c.attemptId);
      }
    }
  }

  for (const axis of unknownVariantAxes) {
    warnings.push(`Unknown variant attribute '${axis}' — record insufficient for Discovery-skip qualification`);
  }

  // Every found attempt that produced at least one parseable identity candidate
  // contributes to the accepted set.
  if (!hasHardIdentityConflict) {
    for (const a of foundAttempts) {
      if (attemptsWithCandidates.has(a.id)) {
        acceptedAttemptIds.add(a.id);
      }
    }
  } else {
    acceptedAttemptIds.clear();
  }

  return {
    acceptedAttemptIds: Array.from(acceptedAttemptIds),
    providerIds,
    hardConflictCount,
    softConflictCount,
    hasHardIdentityConflict,
    hasUnknownVariantAxis: unknownVariantAxes.size > 0,
    conflicts,
    warnings,
  };
}

/**
 * Legacy reconciliation entry point (kept for the current worker caller;
 * migrated to the pure API in Milestone C).
 *
 * Same field-aware hybrid reconciliation, plus durable persistence of every
 * hard/soft conflict through the generation-scoped conflict repository.
 * The repository module is loaded lazily so the pure evaluation path in this
 * module never pulls DB code into the graph; the function stays synchronous
 * so the worker's completion contract is unchanged.
 *
 * - Identity-critical contradictions (upc, gtin, manufacturerPartNumber,
 *   weight, size, count, packCount, brand, flavor, formula + declared axes)
 *   yield HARD conflicts persisted durably. Disagreements on non-identity
 *   fields (distributorSku/distributorUpc/name and merchandising copy) are
 *   NEVER persisted as conflict rows — the projection authority consolidates
 *   them (sorted picks + v2 merchandising provenance) so every accepted
 *   attempt's values still reach Curation without operator decisions.
 * - Confidence score alone NEVER overrides identity conflicts.
 * - Only CURRENT-generation attempts reach this function (the worker passes
 *   the current generation's attempts); conflicts are persisted generation-
 *   scoped so a retry's new generation never collides with stale ones.
 * - No decision/acceptance writes happen here — the worker routes based on
 *   the returned result.
 */
export function reconcileDistributorEvidence(
  itemId: string,
  attempts: EvidenceAttempt[],
  sourcingGenerationId: string | null = null,
  declaredVariantAxes: readonly string[] = [],
): SourcingReconciliationResult {
  const evaluation = evaluateDistributorEvidence(itemId, attempts, sourcingGenerationId, {
    declaredVariantAxes,
  });

  if (evaluation.conflicts.length > 0) {
    const { insertConflictWithCandidates } = lazyRequire(
      '../db/repositories/onboarding-conflict-repo',
    ) as typeof import('../db/repositories/onboarding-conflict-repo');
    // HARD-only persistence (Amendment B follow-up): disagreements on
    // non-identity reference fields (distributorSku/distributorUpc/name) and
    // merchandising copy are consolidated by the projection authority with
    // provenance — they are never operator decisions, so they never become
    // durable conflict rows. Only identity-critical contradictions persist.
    for (const conflict of evaluation.conflicts) {
      if (conflict.severity !== 'hard') continue;
      insertConflictWithCandidates(
        itemId,
        conflict.field,
        conflict.severity,
        conflict.candidates.map((c) => ({
          evidenceAttemptId: c.attemptId,
          valueJson: JSON.stringify(c.rawValue),
        })),
        sourcingGenerationId,
      );
    }
  }

  return {
    acceptedAttemptIds: evaluation.acceptedAttemptIds,
    providerIds: evaluation.providerIds,
    hardConflictCount: evaluation.hardConflictCount,
    softConflictCount: evaluation.softConflictCount,
    hasHardIdentityConflict: evaluation.hasHardIdentityConflict,
    hasUnknownVariantAxis: evaluation.hasUnknownVariantAxis,
    warnings: evaluation.warnings,
  };
}
