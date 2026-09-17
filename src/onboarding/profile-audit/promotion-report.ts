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
import { evaluateGateArithmetic, type FullGateArithmeticResult } from './gate-arithmetic';
import { formatPromotionRecommendation } from './promotion-eligibility';
// sanitizeCell: single source of truth in shared-metrics.ts (fix #9).
import { sanitizeCell } from './shared-metrics';

/**
 * Formats the holdout-gating note (Issue #196): contract promotion requires
 * an explicit holdout GO on every scope. Returns an empty string when the
 * overall verdict already agrees with the combined scopes (nothing gated).
 */
export function formatHoldoutGatingNote(gateResult: FullGateArithmeticResult): string {
  const combined = Object.values(gateResult.verdictsByScope);
  const holdouts = gateResult.holdoutVerdictsByScope ?? {};
  const allCombinedGo = combined.length > 0 && combined.every(v => v.verdict === 'GO');
  if (!allCombinedGo || gateResult.overallContractVerdict === 'GO') return '';

  const lines: string[] = [];
  lines.push('> **Holdout Gating (Issue #196):** Contract promotion requires an explicit holdout GO on every scope — strong tuning performance can never mask weak generalization.');
  const blocking = Object.entries(holdouts)
    .filter(([, v]) => v.verdict !== 'GO')
    .map(([scope, v]) => `\`${scope}\` holdout ${v.verdict}`);
  const missing = Object.keys(gateResult.verdictsByScope).filter(sk => !(sk in holdouts));
  const details = [...blocking, ...missing.map(sk => `\`${sk}\` has no holdout coverage`)];
  lines.push(`> Gating evidence: ${details.length > 0 ? details.join('; ') : 'no holdout verdicts recorded'}.`);
  lines.push('');
  return lines.join('\n');
}

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
export function formatScopePromotionTable(
  verdicts: Record<string, ScopePromotionVerdict>,
  title = 'Per-Scope Promotion Verdicts & Contract Recommendation',
): string {
  const lines: string[] = [];
  lines.push(`## ${title}`);
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
    const baseProv = v.costMetrics.byConfiguration?.current_extraction?.operatorMinutesProvenance ?? v.costMetrics.operatorMinutesProvenance ?? 'modeled';
    const hybProv = v.costMetrics.byConfiguration?.hybrid_identity_first?.operatorMinutesProvenance ?? v.costMetrics.operatorMinutesProvenance ?? 'modeled';
    const opMinsStr = `${v.costMetrics.baselineOperatorMinutes.toFixed(1)}m (${baseProv}) → ${v.costMetrics.hybridOperatorMinutes.toFixed(1)}m (${hybProv})`;
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

    const baseProv = c.byConfiguration?.current_extraction?.operatorMinutesProvenance ?? c.operatorMinutesProvenance ?? 'modeled';
    const hybProv = c.byConfiguration?.hybrid_identity_first?.operatorMinutesProvenance ?? c.operatorMinutesProvenance ?? 'modeled';
    const baseOpStr = `${c.baselineOperatorMinutes.toFixed(1)}m (${baseProv})`;
    const hybOpStr = `${c.hybridOperatorMinutes.toFixed(1)}m (${hybProv})`;

    lines.push(
      `| \`${scopeKey}\` | ${baseLatStr} | ${hybLatStr} | ${deltaMsStr} | ${baseReqStr} | ${hybReqStr} | ${baseOpStr} | ${hybOpStr} | **${c.operatorMinutesSaved.toFixed(1)}m** | ${boundedBadge} |`,
    );
  }

  // Domain Summary Row
  const d = domainMetrics;
  const dDeltaMs = Math.round((d.hybridLatencyMs - d.baselineLatencyMs) * 10) / 10;
  const dDeltaStr = dDeltaMs >= 0 ? `+${dDeltaMs.toFixed(0)}ms` : `${dDeltaMs.toFixed(0)}ms`;
  const dBoundedBadge = d.isMaintenanceBounded ? '✅ Bounded' : '⛔ Unbounded';
  const firstVerdict = Object.values(verdicts)[0];
  const dBaseProv = firstVerdict?.costMetrics.byConfiguration?.current_extraction?.operatorMinutesProvenance ?? 'modeled';
  const dHybProv = firstVerdict?.costMetrics.byConfiguration?.hybrid_identity_first?.operatorMinutesProvenance ?? 'modeled';
  const dBaseOpStr = `${d.baselineOperatorMinutes.toFixed(1)}m (${dBaseProv})`;
  const dHybOpStr = `${d.hybridOperatorMinutes.toFixed(1)}m (${dHybProv})`;

  lines.push(
    `| **DOMAIN TOTAL: \`${d.domain}\`** | **${d.baselineLatencyMs.toFixed(0)}ms** | **${d.hybridLatencyMs.toFixed(0)}ms** | **${dDeltaStr}** | **${d.baselineTotalRequests}** | **${d.hybridTotalRequests}** | **${dBaseOpStr}** | **${dHybOpStr}** | **${d.operatorMinutesSaved.toFixed(1)}m** | **${dBoundedBadge}** |`,
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
  mdParts.push(`**Domain:** \`${manifest.domain}\` | **Generated At:** ${manifest.generatedAt} | **Label Version:** \`${gateResult.labelVersion}\` | **Samples:** ${manifest.samples.length} | **Scopes:** ${Object.keys(gateResult.verdictsByScope).length}`);
  mdParts.push(`**Overall Contract Recommendation:** ${formatPromotionVerdictBadge(gateResult.overallContractVerdict)}`);
  mdParts.push('');

  // 0. Holdout Gating explainer (Issue #196): when the combined scopes read
  // GO but holdout evidence withholds or blocks promotion, say so explicitly
  // so strong tuning can never quietly mask weak generalization.
  mdParts.push(formatHoldoutGatingNote(gateResult));

  // 1. Executive Summary Table (Tuning / Combined Scopes)
  mdParts.push(formatScopePromotionTable(gateResult.verdictsByScope));

  // 1b. Holdout-Scoped Verdicts Table (Reported Separately per AC 3)
  const hasHoldouts = gateResult.holdoutVerdictsByScope && Object.keys(gateResult.holdoutVerdictsByScope).length > 0;
  if (hasHoldouts) {
    mdParts.push('## Holdout-Scoped Promotion Verdicts (Generalization Check)');
    mdParts.push('');
    mdParts.push('> **Holdout Results Reporting:** Entire product families are held out from tuning with holdout results reported separately to ensure verdicts generalize beyond head-domain and tuning-scoped pages.');
    mdParts.push('');
    mdParts.push(formatScopePromotionTable(gateResult.holdoutVerdictsByScope, 'Holdout Partition Verdicts'));
  }

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
    const baseProv = v.costMetrics.byConfiguration?.current_extraction?.operatorMinutesProvenance ?? v.costMetrics.operatorMinutesProvenance ?? 'modeled';
    const hybProv = v.costMetrics.byConfiguration?.hybrid_identity_first?.operatorMinutesProvenance ?? v.costMetrics.operatorMinutesProvenance ?? 'modeled';

    mdParts.push(`### Scope: \`${scopeKey}\` — Verdict: ${formatPromotionVerdictBadge(v.verdict)}`);
    mdParts.push(`- **Platform:** ${v.platform ?? 'generic'} | **Partition:** ${v.partition ?? 'all'} | **Label Version:** \`${v.labelVersion ?? gateResult.labelVersion}\` | **Samples Evaluated:** ${v.sampleCount}`);
    mdParts.push(`- **Served Rate:** ${(v.servedRate.value * 100).toFixed(1)}% (95% CI: [${(v.servedRate.confidenceInterval.lower * 100).toFixed(1)}%, ${(v.servedRate.confidenceInterval.upper * 100).toFixed(1)}%]) vs ${(v.baselineServedRate * 100).toFixed(1)}% baseline`);
    mdParts.push(`- **Identity Accuracy:** ${(v.identityAccuracy.value * 100).toFixed(1)}% (${v.acceptedIdentityErrors} accepted identity errors)`);
    mdParts.push(`- **Critical Field Regressions:** ${v.criticalFieldRegressions} on title/brand/price`);
    mdParts.push(`- **Image Precision:** ${(v.imagePrecision.value * 100).toFixed(1)}% vs ${(v.baselineImagePrecision * 100).toFixed(1)}% baseline`);
    mdParts.push(`- **Field Correctness:** ${(v.fieldCorrectness.value * 100).toFixed(1)}% vs ${(v.baselineFieldCorrectness * 100).toFixed(1)}% baseline`);
    mdParts.push(`- **Operator Maintenance Savings:** ${v.costMetrics.operatorMinutesSaved.toFixed(1)} minutes/domain (${v.costMetrics.hybridOperatorMinutes.toFixed(1)}m hybrid (${hybProv}) vs ${v.costMetrics.baselineOperatorMinutes.toFixed(1)}m baseline (${baseProv}))`);
    mdParts.push('- **Verdict Reasons:**');
    for (const r of v.promotabilityReasons) {
      mdParts.push(`  - ${r}`);
    }
    mdParts.push(`- **Recommendation:** ${formatPromotionRecommendation(v.verdict)}`);
    mdParts.push('');

    // Per-Sample Evidence, Label Provenance & Holdout Partition (Issue #188 / T2, #190 / T6)
    const scopeSamples = v.samples ?? manifest.samples.filter(s => (s.pageStructureScope || 'standard_pdp') === scopeKey);
    if (scopeSamples.length > 0) {
      mdParts.push('#### Per-Sample Evidence, Label Provenance & Holdout Partition');
      mdParts.push('');
      mdParts.push('| Sample ID | Inventory Status | Capture Freshness | Label Version | Label Provenance | Holdout Partition | Evidence Status |');
      mdParts.push('| :--- | :---: | :---: | :---: | :---: | :---: | :--- |');

      for (const s of scopeSamples) {
        const sId = `\`${s.sampleId}\``;
        let invStatus: string;
        if (s.sampleType === 'confirmed_profile_sample' || s.inventoryStatus === 'confirmed') {
          invStatus = 'Confirmed Profile Sample';
        } else if (s.isProfileBlocked || s.sampleType === 'profile_blocked') {
          invStatus = 'Profile Blocked';
        } else if (s.sampleType === 'failure_sample' || s.isFailureSample) {
          invStatus = 'Failure Sample';
        } else {
          invStatus = 'Unreviewed Candidate';
        }

        const freshness = s.captureFreshness ? `\`${s.captureFreshness}\`` : '`unknown`';
        const sampleLVersion = `\`${s.labelVersion ?? gateResult.labelVersion}\``;
        const isAutoDerived = s.groundTruthSource === 'auto-derived';
        const provBadge = s.groundTruthSource === 'independent'
          ? '`independent`'
          : (isAutoDerived ? '`auto-derived` (exploratory)' : 'unspecified');
        const holdoutBadge = s.isHoldout
          ? `Holdout (\`${s.holdoutFamilyName ?? 'unnamed'}\`)`
          : 'Tuning';

        const sRows = rows.filter(r => r.sampleId === s.sampleId);
        const hasGap = sRows.some(r => r.isEvidenceGap) || !s.artifactRef;
        let evidenceStatus: string;
        if (hasGap) {
          evidenceStatus = isAutoDerived
            ? 'Missing artifact (evidence gap) [EXPLORATORY]'
            : 'Missing artifact (evidence gap)';
        } else {
          evidenceStatus = isAutoDerived
            ? 'Complete observation pair [EXPLORATORY]'
            : 'Complete observation pair';
        }

        mdParts.push(`| ${sId} | ${invStatus} | ${freshness} | ${sampleLVersion} | ${provBadge} | ${holdoutBadge} | ${evidenceStatus} |`);
      }
      mdParts.push('');
    }
  }

  const markdown = mdParts.join('\n');

  return {
    domain: manifest.domain,
    generatedAt: manifest.generatedAt,
    labelVersion: gateResult.labelVersion,
    totalSamples: manifest.samples.length,
    totalScopes: Object.keys(gateResult.verdictsByScope).length,
    overallContractVerdict: gateResult.overallContractVerdict,
    verdictsByScope: gateResult.verdictsByScope,
    tuningVerdictsByScope: gateResult.tuningVerdictsByScope,
    holdoutVerdictsByScope: gateResult.holdoutVerdictsByScope,
    domainCostMetrics: gateResult.domainCostMetrics,
    markdown,
  };
}
