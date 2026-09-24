// fallow-ignore-file unused-export

/**
 * Shared run-start readiness assertion (issue #17 work item L).
 *
 * The ACTIVE v2 authority must pass classification readiness before a run
 * snapshot is persisted, a run row is created, or any model call is made.
 * Transitional v1 authorities have no lifecycle/provenance contract — the
 * legacy loader already validates them, so they pass through unasserted
 * (readiness is a v2-capability contract, and the UI never claims readiness
 * for them).
 */
import { evaluateClassificationReadiness } from './config-validation';
import type { ClassificationConfigValidationOptions, ClassificationReadinessReport } from './config-validation';
import type { RuntimeConfigAuthority } from './config-loader';
import { ClassificationReadinessReportSchema } from '../shared/schemas/classification';
import type { ClassificationReadinessReportDto } from '../shared/schemas/classification';

export class ClassificationNotReadyError extends Error {
  readonly code = 'classification_not_ready';
  readonly readiness: ClassificationReadinessReport;
  constructor(readiness: ClassificationReadinessReport, message?: string) {
    super(
      message ??
        `Classification is not ready: ${readiness.findings.map(f => f.code).join(', ') || 'no error findings'}`,
    );
    this.name = 'ClassificationNotReadyError';
    this.readiness = readiness;
  }
}

/**
 * Normalize a readiness report to the shared schema contract
 * (`reason: string | null` on every capability — the evaluator emits
 * `undefined` for runnable capabilities). Both the GET readiness route and the
 * catalog POST 409 must return the schema-validated shape.
 */
export function normalizeClassificationReadinessReport(
  report: ClassificationReadinessReport,
): ClassificationReadinessReportDto {
  const parsed = ClassificationReadinessReportSchema.safeParse({
    ...report,
    capabilities: {
      productType: { ...report.capabilities.productType, reason: report.capabilities.productType.reason ?? null },
      productFields: {
        ...report.capabilities.productFields,
        reason: report.capabilities.productFields.reason ?? null,
        multiValueSupported: report.capabilities.productFields.multiValueSupported ?? true,
      },
      categoryPages: { ...report.capabilities.categoryPages, reason: report.capabilities.categoryPages.reason ?? null },
    },
  });
  if (!parsed.success) {
    throw new Error('Readiness report failed schema validation: ' + JSON.stringify(parsed.error.issues));
  }
  return parsed.data;
}

/**
 * Assert the ACTIVE v2 configuration is ready for a run. Throws
 * {@link ClassificationNotReadyError} (carrying the full readiness report)
 * when the bundle is not ready; returns the report on success. Returns null
 * for transitional v1 authorities (not enforced, see header).
 */
export function assertClassificationReady(
  authority: RuntimeConfigAuthority,
  options: ClassificationConfigValidationOptions,
): ClassificationReadinessReport | null {
  if (authority.kind !== 'v2') return null;
  const report = evaluateClassificationReadiness(authority.bundle, { ...options, mode: 'active' });
  if (!report.isReady) {
    throw new ClassificationNotReadyError(report);
  }
  return report;
}
