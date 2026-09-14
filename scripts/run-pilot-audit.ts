#!/usr/bin/env bun
/**
 * CLI Runner for Profile Extraction Audit Gate T1 Pilot
 *
 * Usage:
 *   bun scripts/run-pilot-audit.ts [domain]
 *
 * Example:
 *   bun scripts/run-pilot-audit.ts earthbath.com
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { initDb, isDbInitialized } from '../src/db/connection';
import { runPilotAudit } from '../src/onboarding/profile-audit';

async function main() {
  const domain = process.argv[2] || 'earthbath.com';
  const dbPath = resolve(process.cwd(), 'storage', 'catalog', '.shopsite-cms', 'app.db');

  if (existsSync(dbPath) && !isDbInitialized()) {
    try {
      initDb(dbPath);
    } catch (e) {
      console.warn(`[Audit Pilot] Warning: Could not initialize database at ${dbPath}:`, e);
    }
  }

  console.log(`[Audit Pilot] Starting pilot replay & scoring for domain: ${domain}...`);

  const result = await runPilotAudit({
    domain,
    sampleLimit: 5,
  });

  const reportsDir = resolve(process.cwd(), '.baystate-cms', 'audit-reports');
  mkdirSync(reportsDir, { recursive: true });
  const reportPath = join(reportsDir, `${result.domain}-pilot-audit.md`);
  writeFileSync(reportPath, result.reviewableTable, 'utf8');

  if (result.operatorReviewReport) {
    const operatorReportPath = join(reportsDir, `${result.domain}-operator-review.md`);
    writeFileSync(operatorReportPath, result.operatorReviewReport, 'utf8');
    console.log(`[Audit Pilot] Operator review report written to: ${operatorReportPath}`);
  }

  if (result.promotionReport) {
    const promotionReportPath = join(reportsDir, `${result.domain}-promotion-report.md`);
    writeFileSync(promotionReportPath, result.promotionReport, 'utf8');
    console.log(`[Audit Pilot] Per-scope promotion report written to: ${promotionReportPath}`);
  }

  console.log(`\n[Audit Pilot] Successfully audited ${result.manifest.samples.length} samples across 4 configurations (${result.rows.length} scored rows).`);
  console.log(`[Audit Pilot] Reviewable audit report written to: ${reportPath}`);
}

main().catch(err => {
  console.error('[Audit Pilot] Fatal error:', err);
  process.exit(1);
});
