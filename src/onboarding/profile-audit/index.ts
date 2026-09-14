export * from './types';
export {
  REPLAY_CONFIGURATIONS,
  CONFIG_DISPLAY_NAMES,
  CRITICAL_FIELDS,
  // NOTE: computeWilsonScoreInterval + sanitizeCell also live in
  // shared-metrics.ts but are re-exported through operator-review.ts below
  // (same references) to avoid ambiguous barrel exports.
  resolveZForConfidence,
  isSampleServed,
  OPERATOR_MINUTE_COEFFICIENTS,
  MIN_SAMPLES_FOR_PROMOTE_DEFAULT,
  IMAGE_RECALL_FLOOR_FACTOR,
  FAMILY_BUCKET_COUNT,
  getFamilyBucket,
  getFreshnessBucket,
  getDeterministicScoredRowIdentity,
} from './shared-metrics';
export { applyStrictImageFilter, isRoleRejectedImage } from './strict-image-filter';
export { selectHybridFields } from './hybrid-field-selector';
export {
  buildAuditManifest,
  buildFullStratifiedManifest,
  detectPlatformFromHtmlOrUrl,
  detectPageStructureScope,
  detectVariantShape,
  deriveProductFamily,
  splitForFamily,
  normalizeFreshness,
  scanDomainSnapshots,
  isNonProductPath,
} from './manifest-builder';
export { replaySample } from './replay-runner';
export { scoreExtraction } from './scorer';
export {
  computeConfigurationSummaries,
  formatReviewableTable,
  formatReviewableManifest,
} from './reviewable-table';
export {
  computeWilsonScoreInterval,
  explainMissingField,
  buildSideBySideFieldEvidence,
  buildImageContactSheet,
  computeScopeSummaries,
  formatPerScopeSummaryTable,
  formatSideBySideFieldEvidenceTable,
  formatMissingFieldsSummary,
  formatImageContactSheetMarkdown,
  formatHtmlContactSheet,
  generateOperatorReviewReport,
} from './operator-review';
export { runPilotAudit } from './pilot-auditor';
export {
  computeContinuousMetricInterval,
  buildPromotionUncertainty,
  detectAbstentionGaming,
  computeScopeCostMetrics,
  computeDomainCostMetrics,
  deriveBaselineThresholds,
  evaluateScopeGate,
  evaluateGateArithmetic,
} from './gate-arithmetic';
export {
  formatPromotionVerdictBadge,
  formatScopePromotionTable,
  formatGateArithmeticThresholdsTable,
  formatAbstentionGamingAuditTable,
  formatCostAnalysisTable,
  generatePromotionReport,
} from './promotion-report';


