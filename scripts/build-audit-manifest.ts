#!/usr/bin/env bun
/**
 * CLI Runner for Profile Extraction Audit Gate T2 Full Stratified Sampling Manifest
 *
 * Usage:
 *   bun scripts/build-audit-manifest.ts [domain]
 *
 * Example:
 *   bun scripts/build-audit-manifest.ts earthbath.com
 *   bun scripts/build-audit-manifest.ts all
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { initDb, isDbInitialized } from '../src/db/connection';
import {
  buildFullStratifiedManifest,
  formatReviewableManifest,
} from '../src/onboarding/profile-audit';

/**
 * Local-dev fallback domain for ad-hoc manifest runs (NOT a production
 * default — pass the domain explicitly in CI/contract runs).
 */
const DEFAULT_AUDIT_DOMAIN = 'earthbath.com';

async function main() {
  const domainArg = process.argv[2] || DEFAULT_AUDIT_DOMAIN;
  const dbPath = resolve(process.cwd(), 'storage', 'catalog', '.shopsite-cms', 'app.db');

  if (existsSync(dbPath) && !isDbInitialized()) {
    try {
      initDb(dbPath);
    } catch (e) {
      console.warn(`[Audit Manifest] Warning: Could not initialize database at ${dbPath}:`, e);
    }
  }

  console.log(`[Audit Manifest] Building stratified audit manifest for: ${domainArg}...`);

  const manifest = await buildFullStratifiedManifest({
    domain: domainArg,
  });

  const reportsDir = resolve(process.cwd(), '.baystate-cms', 'audit-reports');
  mkdirSync(reportsDir, { recursive: true });

  const safeDomain = domainArg.replace(/[^a-zA-Z0-9.-]/g, '_');
  const jsonPath = join(reportsDir, `${safeDomain}-audit-manifest.json`);
  const mdPath = join(reportsDir, `${safeDomain}-audit-manifest.md`);

  writeFileSync(jsonPath, JSON.stringify(manifest, null, 2), 'utf8');
  const reviewableMd = formatReviewableManifest(manifest);
  writeFileSync(mdPath, reviewableMd, 'utf8');

  const meta = (manifest.metadata ?? {}) as Record<string, any>;
  const claimedStrata = (meta.claimedStrata as string[]) || [];
  const holdoutFamilies = (meta.holdoutFamilies as string[]) || [];

  console.log(`\n[Audit Manifest] Successfully generated stratified manifest:`);
  console.log(`  - Total Samples: ${manifest.samples.length}`);
  console.log(`  - Claimed Strata: ${claimedStrata.length}`);
  console.log(`  - Confirmed Profile Samples: ${meta.totalConfirmed ?? 0}`);
  console.log(`  - Unreviewed Candidates: ${meta.totalCandidates ?? 0}`);
  console.log(`  - Profile-Blocked Items: ${meta.totalBlocked ?? 0}`);
  console.log(`  - Excluded Distributor Records: ${meta.totalExcludedDistributorRecords ?? 0}`);
  console.log(`  - Holdout Families (untouched by tuning): ${holdoutFamilies.length}`);
  console.log(`\n[Audit Manifest] Manifest JSON saved to: ${jsonPath}`);
  console.log(`[Audit Manifest] Reviewable Markdown report saved to: ${mdPath}`);
}

main().catch(err => {
  console.error('[Audit Manifest] Fatal error:', err);
  process.exit(1);
});
