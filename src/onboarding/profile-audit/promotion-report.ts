/**
 * Profile Extraction Audit Gate Promotion Report Generator (Issue #178 / Gate T5)
 *
 * Assembles the authoritative per-scope promotion report for contract work:
 * 1. Computes per-scope verdicts from scored rows with uncertainty reported.
 * 2. Displays derived baseline thresholds alongside verdicts.
 * 3. Conducts explicit abstention gaming audits to prevent false quality wins.
 * 4. Includes cost columns: latency, request counts, and operator minutes per domain.
 *
 * Delivers the go or no-go per scope for contract work.
 */

import type {
  AuditManifest,
  AuditScoredRow,
  ContractPromotionVerdict,
  DomainCostMetrics,
  PerScopePromotionReport,
  ScopePromotionVerdict,
} from '../../shared/schemas/profile-audit';
import type { GateArithmeticOptions } from './types';
import { evaluateGateArithmetic } from './gate-arithmetic';
// sanitizeCell: single source of truth in shared-metrics.ts (fix #9).
import { sanitizeCell } from './shared-metrics';

export function formatPromotionVerdictBadge(verdict: ContractPromotionVerdict): string {
  switch (verdict) {
    case 'GO':
      return '✅ **GO (PROMOTABLE)**';
    case 'NO_GO':
      return '⛔ **NO-GO (BLOCKED)**';
    case 'NEEDS_REVIEW':
      return '⚠️ **NEEDS REVIEW**';
  }
}

/**
 * Formats the Executive Per-Scope Promotion Table including cost columns.
 */
export function formatScopePromotionTable(verdicts: Record<string, ScopePromotionVerdict>): string {
  const lines: string[] = [];
  lines.push('## Per-Scope Promotion Verdicts & Contract Recommendation');
  lines.push('');
  lines.push('> **Contract Recommendation:** Evaluates readiness for contract work per page-structure scope. A scope advances to contract work only with zero accepted identity errors, no critical-field regressions, improved image and completeness quality without abstention gaming, and bounded maintenance.');
  lines.push('');
  lines.push(
    '| Scope | Platform | Samples | Baseline Served Rate | Hybrid Served Rate | Delta | 95% CI | Latency (Base → Hyb) | Requests | Operator Mins (Base → Hyb) | Contract Verdict |',
  );
  lines.push(
    '| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |',
  );

  for (const v of Object.values(verdicts)) {
    const deltaStr = v.servedRateDelta >= 0
      ? `▲ +${(v.servedRateDelta * 100).toFixed(1)}%`
      : `▼ ${(v.servedRateDelta * 100).toFixed(1)}%`;

    const ciStr = `±${(v.servedRate.uncertainty * 100).toFixed(1)}%`;
    // Unmeasured cost columns (fix #5) render as "unmeasured" — never fiat.
    const latencyStr = v.costMetrics.latencyProvenance === 'unmeasured'
      ? 'unmeasured'
      : `${v.costMetrics.baselineLatencyMs.toFixed(0)}ms → ${v.costMetrics.hybridLatencyMs.toFixed(0)}ms`;
    const reqStr = v.costMetrics.requestsProvenance === 'unmeasured'
      ? 'unmeasured'
      : `${v.costMetrics.hybridRequestsPerSample.toFixed(1)}/sample`;
    const opMinsStr = `${v.costMetrics.baselineOperatorMinutes.toFixed(1)}m → ${v.costMetrics.hybridOperatorMinutes.toFixed(1)}m`;
    const verdictBadge = formatPromotionVerdictBadge(v.verdict);

    lines.push(
      `| **\`${v.scope}\`** | ${v.platform ?? 'generic'} | ${v.sampleCount} | ${(v.baselineServedRate * 100).toFixed(1)}% | **${(v.servedRate.value * 100).toFixed(1)}%** | ${deltaStr} | ${ciStr} | ${latencyStr} | ${reqStr} | ${opMinsStr} | ${verdictBadge} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Formats the Derived Baseline Thresholds & Gate Arithmetic Audit Table.
 */
export function formatGateArithmeticThresholdsTable(verdicts: Record<string, ScopePromotionVerdict>): string {
  const lines: string[] = [];
  lines.push('## Derived Baseline Thresholds & Gate Arithmetic Audit');
  lines.push('');
  lines.push('> **Audit Principle:** Targets are derived directly from baseline audit measurements rather than arbitrary fiat, grounding promotion requirements in observed catalog coverage.');
  lines.push('');
  lines.push(
    '| Scope | Dimension | Baseline Measured | Derived Target Threshold | Observed Hybrid | Uncertainty | Gate Rule | Status |',
  );
  lines.push(
    '| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |',
  );

  for (const [scopeKey, v] of Object.entries(verdicts)) {
    for (const t of v.thresholds) {
      const formatVal = (num: number, unit: string): string => {
        if (unit === 'rate') return `${(num * 100).toFixed(1)}%`;
        if (unit === 'minutes') return `${num.toFixed(1)}m`;
        return `${num}`;
      };

      const baseStr = formatVal(t.baselineValue, t.unit);
      const targetStr = formatVal(t.thresholdValue, t.unit);
      const actualStr = `**${formatVal(t.actualValue, t.unit)}**`;
      const uncStr = t.actualUncertainty !== undefined
        ? `±${(t.actualUncertainty * (t.unit === 'rate' ? 100 : 1)).toFixed(1)}${t.unit === 'rate' ? '%' : ''}`
        : '—';
      const statusBadge = t.passed ? '✅ PASS' : '⛔ FAIL';

      lines.push(
        `| \`${scopeKey}\` | ${sanitizeCell(t.name)} | ${baseStr} | ${targetStr} | ${actualStr} | ${uncStr} | \`${t.rule}\` | ${statusBadge} |`,
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Formats the Abstention Gaming Audit Table.
 */
export function formatAbstentionGamingAuditTable(verdicts: Record<string, ScopePromotionVerdict>): string {
  const lines: string[] = [];
  lines.push('## Abstention Gaming Audit');
  lines.push('');
  lines.push('> **Abstention Gaming Discipline:** Quality gains that hide failures fail the gate. A candidate cannot claim higher precision by dropping hard samples, refusing failing pages, or inflating evidence gaps.');
  lines.push('');
  lines.push(
    '| Scope | Evidence Gaps (Base → Hyb) | Attempted (Base → Hyb) | Served Rate (Base → Hyb) | Gaming Detected? | Audit Details |',
  );
  lines.push(
    '| :--- | :---: | :---: | :---: | :---: | :--- |',
  );

  for (const [scopeKey, v] of Object.entries(verdicts)) {
    const ag = v.abstentionGaming;
    const gapsStr = `${ag.baselineEvidenceGaps} → ${ag.hybridEvidenceGaps}`;
    const attStr = `${ag.baselineAttemptedCount} → ${ag.hybridAttemptedCount}`;
    const servedStr = `${(ag.baselineServedRate * 100).toFixed(1)}% → ${(ag.hybridServedRate * 100).toFixed(1)}%`;
    const detectedBadge = ag.gamingDetected ? '⛔ **YES (FAIL)**' : '✅ **NO (PASS)**';
    const details = ag.reasons.length > 0
      ? ag.reasons.map(r => sanitizeCell(r)).join('; ')
      : 'Clean: No gap inflation, refusal, or coverage trade-offs detected.';

    lines.push(
      `| \`${scopeKey}\` | ${gapsStr} | ${attStr} | ${servedStr} | ${detectedBadge} | ${details} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Formats the Execution Cost & Operator Maintenance Analysis Table.
 */
export function formatCostAnalysisTable(
  domainMetrics: DomainCostMetrics,
  verdicts: Record<string, ScopePromotionVerdict>,
): string {
  const lines: string[] = [];
  lines.push('## Execution Cost & Operator Maintenance Analysis');
  lines.push('');
  lines.push('> **Cost & Trade-off Principles:**');
  lines.push('> - **Operator Minutes:** Measures maintenance cost per domain so options are comparable.');
  lines.push('> - **Latency & Requests:** Verifies that a quality win is an informed trade that does not inflate fetch costs.');
  lines.push('> - **Bounded Maintenance:** Hybrid maintenance cost must not exceed baseline.');
  lines.push('');
  lines.push(
    '| Domain / Scope | Baseline Latency | Hybrid Latency | Latency Delta | Baseline Requests | Hybrid Requests | Baseline Operator Mins | Hybrid Operator Mins | Minutes Saved | Bounded? |',
  );
  lines.push(
    '| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |',
  );

  // Per-Scope Rows
  for (const [scopeKey, v] of Object.entries(verdicts)) {
    const c = v.costMetrics;
    // Unmeasured columns (fix #5) render as "unmeasured", never fiat numbers.
    const scopeUnmeasured = c.latencyProvenance === 'unmeasured';
    const baseLatStr = scopeUnmeasured ? 'unmeasured' : `${c.baselineLatencyMs.toFixed(0)}ms`;
    const hybLatStr = scopeUnmeasured ? 'unmeasured' : `${c.hybridLatencyMs.toFixed(0)}ms`;
    const deltaMsStr = scopeUnmeasured
      ? 'unmeasured'
      : (c.latencyDeltaMs >= 0 ? `+${c.latencyDeltaMs.toFixed(0)}ms` : `${c.latencyDeltaMs.toFixed(0)}ms`);
    const boundedBadge = c.isMaintenanceBounded ? '✅ Bounded' : '⛔ Unbounded';
    const baseReqStr = c.requestsProvenance === 'unmeasured'
      ? 'unmeasured'
      : `${c.baselineTotalRequests} (${c.baselineRequestsPerSample.toFixed(1)}/s)`;
    const hybReqStr = c.requestsProvenance === 'unmeasured'
      ? 'unmeasured'
      : `${c.hybridTotalRequests} (${c.hybridRequestsPerSample.toFixed(1)}/s)`;

    lines.push(
      `| \`${scopeKey}\` | ${baseLatStr} | ${hybLatStr} | ${deltaMsStr} | ${baseReqStr} | ${hybReqStr} | ${c.baselineOperatorMinutes.toFixed(1)}m | ${c.hybridOperatorMinutes.toFixed(1)}m | **${c.operatorMinutesSaved.toFixed(1)}m** | ${boundedBadge} |`,
    );
  }

  // Domain Summary Row
  const d = domainMetrics;
  const dDeltaMs = Math.round((d.hybridLatencyMs - d.baselineLatencyMs) * 10) / 10;
  const dDeltaStr = dDeltaMs >= 0 ? `+${dDeltaMs.toFixed(0)}ms` : `${dDeltaMs.toFixed(0)}ms`;
  const dBoundedBadge = d.isMaintenanceBounded ? '✅ Bounded' : '⛔ Unbounded';

  lines.push(
    `| **DOMAIN TOTAL: \`${d.domain}\`** | **${d.baselineLatencyMs.toFixed(0)}ms** | **${d.hybridLatencyMs.toFixed(0)}ms** | **${dDeltaStr}** | **${d.baselineTotalRequests}** | **${d.hybridTotalRequests}** | **${d.baselineOperatorMinutes.toFixed(1)}m** | **${d.hybridOperatorMinutes.toFixed(1)}m** | **${d.operatorMinutesSaved.toFixed(1)}m** | **${dBoundedBadge}** |`,
  );

  // Provenance footnotes (fixes #5/#6): like-for-like maintenance basis plus
  // unmeasured-column notes. Additive lines only — table headers above are
  // unchanged.
  const provenanceNotes = new Set<string>();
  for (const v of Object.values(verdicts)) {
    if (v.costMetrics.maintenanceComparisonNote) {
      provenanceNotes.add(`${v.scope}: ${v.costMetrics.maintenanceComparisonNote}`);
    }
    if (v.costMetrics.latencyProvenance === 'unmeasured') {
      provenanceNotes.add(`${v.scope}: latency unmeasured (no recorded timing; replay with recordLatency:true to measure)`);
    }
    if (v.costMetrics.requestsProvenance === 'unmeasured') {
      provenanceNotes.add(`${v.scope}: requests unmeasured (no recorded counts)`);
    }
  }
  if (domainMetrics.maintenanceComparisonNote) {
    provenanceNotes.add(`domain: ${domainMetrics.maintenanceComparisonNote}`);
  }
  if (provenanceNotes.size > 0) {
    lines.push('> **Measurement Provenance:** ' + Array.from(provenanceNotes).join('; '));
    lines.push('');
  }

  lines.push('');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Full Promotion Report Generator
// ─────────────────────────────────────────────────────────────────────────────

export function generatePromotionReport(args: {
  manifest: AuditManifest;
  rows: AuditScoredRow[];
  /** Flat gate options (preferred; fix #12 — replaces the confusing `{ options: { options } }` nesting). */
  gateOptions?: GateArithmeticOptions;
  /**
   * @deprecated Alias for gateOptions, kept for back-compat with existing
   * `{ manifest, rows, options }` callers.
   */
  options?: GateArithmeticOptions;
}): PerScopePromotionReport {
  const { manifest, rows } = args;
  const gateOpts = args.gateOptions ?? args.options;
  const gateResult = evaluateGateArithmetic(manifest.samples, rows, gateOpts);

  const mdParts: string[] = [];
  mdParts.push(`# Profile Extraction Audit Gate: Per-Scope Promotion Report`);
  mdParts.push(`**Domain:** \`${manifest.domain}\` | **Generated At:** ${manifest.generatedAt} | **Samples:** ${manifest.samples.length} | **Scopes:** ${Object.keys(gateResult.verdictsByScope).length}`);
  mdParts.push(`**Overall Contract Recommendation:** ${formatPromotionVerdictBadge(gateResult.overallContractVerdict)}`);
  mdParts.push('');

  // 1. Executive Summary Table
  mdParts.push(formatScopePromotionTable(gateResult.verdictsByScope));

  // 2. Derived Thresholds Table
  mdParts.push(formatGateArithmeticThresholdsTable(gateResult.verdictsByScope));

  // 3. Abstention Gaming Audit Table
  mdParts.push(formatAbstentionGamingAuditTable(gateResult.verdictsByScope));

  // 4. Execution Cost & Operator Maintenance Analysis Table
  mdParts.push(formatCostAnalysisTable(gateResult.domainCostMetrics, gateResult.verdictsByScope));

  // 5. Actionable Next Steps
  mdParts.push('## Actionable Scope Verdicts & Next Steps');
  mdParts.push('');
  for (const [scopeKey, v] of Object.entries(gateResult.verdictsByScope)) {
    mdParts.push(`### Scope: \`${scopeKey}\` — Verdict: ${formatPromotionVerdictBadge(v.verdict)}`);
    mdParts.push(`- **Platform:** ${v.platform ?? 'generic'} | **Samples Evaluated:** ${v.sampleCount}`);
    mdParts.push(`- **Served Rate:** ${(v.servedRate.value * 100).toFixed(1)}% (95% CI: [${(v.servedRate.confidenceInterval.lower * 100).toFixed(1)}%, ${(v.servedRate.confidenceInterval.upper * 100).toFixed(1)}%]) vs ${(v.baselineServedRate * 100).toFixed(1)}% baseline`);
    mdParts.push(`- **Identity Accuracy:** ${(v.identityAccuracy.value * 100).toFixed(1)}% (${v.acceptedIdentityErrors} accepted identity errors)`);
    mdParts.push(`- **Critical Field Regressions:** ${v.criticalFieldRegressions} on title/brand/price`);
    mdParts.push(`- **Image Precision:** ${(v.imagePrecision.value * 100).toFixed(1)}% vs ${(v.baselineImagePrecision * 100).toFixed(1)}% baseline`);
    mdParts.push(`- **Field Correctness:** ${(v.fieldCorrectness.value * 100).toFixed(1)}% vs ${(v.baselineFieldCorrectness * 100).toFixed(1)}% baseline`);
    mdParts.push(`- **Operator Maintenance Savings:** ${v.costMetrics.operatorMinutesSaved.toFixed(1)} minutes/domain (${v.costMetrics.hybridOperatorMinutes.toFixed(1)}m hybrid vs ${v.costMetrics.baselineOperatorMinutes.toFixed(1)}m baseline)`);
    mdParts.push('- **Verdict Reasons:**');
    for (const r of v.promotabilityReasons) {
      mdParts.push(`  - ${r}`);
    }
    if (v.verdict === 'GO') {
      mdParts.push('- **Recommendation:** **PROCEED TO CONTRACT WORK.** This scope has proven superior quality, zero identity errors, improved image filtering, and bounded maintenance. Ready for ladder-wiring ADR revision.');
    } else if (v.verdict === 'NO_GO') {
      mdParts.push('- **Recommendation:** **REMAIN SELECTOR-LED WITH SCOPED EXCEPTIONS.** Do not force into hybrid arm until blocking regressions and errors are resolved.');
    } else {
      mdParts.push('- **Recommendation:** **EXPAND STRATIFIED SAMPLE.** Increase sample size to achieve sufficient statistical confidence before triggering contract work.');
    }
    mdParts.push('');
  }

  const markdown = mdParts.join('\n');

  return {
    domain: manifest.domain,
    generatedAt: manifest.generatedAt,
    totalSamples: manifest.samples.length,
    totalScopes: Object.keys(gateResult.verdictsByScope).length,
    overallContractVerdict: gateResult.overallContractVerdict,
    verdictsByScope: gateResult.verdictsByScope,
    domainCostMetrics: gateResult.domainCostMetrics,
    markdown,
  };
}
