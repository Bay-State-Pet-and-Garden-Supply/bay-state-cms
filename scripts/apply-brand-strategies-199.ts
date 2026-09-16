#!/usr/bin/env bun
// Issue #199 — apply the 10 brand sourcing-strategy resolutions.
//
// Records each resolution through the guarded brand-sourcing-strategy
// approval flow (saveBrandStrategy): official_page brands commit their
// brand_sites mapping + approval atomically; distributor_record brands
// approve explicit Included pins with no mapping.
//
// Dry-run by default. Pass --apply to write. Idempotent: brands whose
// stored approved strategy already matches the spec are skipped.
// The OC brand needs --acknowledge-oc-identity (see runbook in
// docs/plans/brand-sourcing-strategies-199.md).
//
// Usage:
//   bun scripts/apply-brand-strategies-199.ts [--db=PATH] [--apply]
//     [--approved-by=NAME] [--skip-brands=oc,coop...] [--acknowledge-oc-identity]
import { getDb, initDb } from '../src/db/connection';
import { normalizeBrandKey } from '../src/db/repositories/brand-strategy-approval-repo';
import { runMigrations } from '../src/db/migrations';
import { requireServerSingletonWorkspace } from '../src/db/repositories/workspace-singleton';
import {
  computeBrandStrategyConfigurationToken,
  getBrandStrategyRow,
  saveBrandStrategy,
} from '../src/db/repositories/brand-strategy-approval-repo';
import { isSupportedDistributorId } from '../src/onboarding/sourcing/connector-registry';
import type { StrategySourceRef } from '../src/shared/schemas/brand-strategy';
import {
  BRAND_199_RESOLUTIONS,
  BRAND_199_TOTAL_ITEMS,
  brand199SaveInput,
  summarizeItemCoverage,
  type Brand199Resolution,
} from '../src/onboarding/brand-hub/brand-strategies-199';

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? '' : hit.slice(eq + 1);
}

function sameSources(a: StrategySourceRef[], b: StrategySourceRef[]): boolean {
  if (a.length !== b.length) return false;
  const key = (s: StrategySourceRef) =>
    s.kind === 'official_page' ? `official_page:${s.domain}` : `distributor_record:${s.distributorId}`;
  const sa = [...a].map(key).sort().join('|');
  const sb = [...b].map(key).sort().join('|');
  return sa === sb;
}

/**
 * Read-only live coverage check: groups non-duplicate onboarding items by
 * normalized brand_hint and compares against the 34-item inventory.
 * Warn-only (never blocks): spelling variance is resolved via the
 * assign-brand / assign-domain surfaces in the runbook.
 */
function reportItemCoverage(): void {
  let rows: Array<{ brand_hint: string | null }>;
  try {
    rows = getDb().query(
      'SELECT brand_hint FROM onboarding_items WHERE COALESCE(is_duplicate, 0) = 0',
    ).all() as Array<{ brand_hint: string | null }>;
  } catch {
    console.log('[apply-brand-strategies-199] coverage: onboarding_items unreadable — skipping live check');
    return;
  }
  const { perBrand, blankHints, unjoined } = summarizeItemCoverage(rows);
  for (const c of perBrand) {
    const forms = c.spellings.join(' / ');
    const verdict = c.matched ? 'OK' : `MISMATCH (spec ${c.expected})`;
    console.log(`[apply-brand-strategies-199] coverage: ${c.brand}: live=${c.live} ${verdict}${forms && forms !== c.brand ? ` spellings=[${forms}]` : ''}`);
  }
  for (const u of unjoined) {
    console.log(`[apply-brand-strategies-199] coverage: UNJOINED brand_hint=[${u.spelling}] items=${u.count} (no #199 strategy attaches — assign-brand or extend resolutions)`);
  }
  if (blankHints > 0) {
    console.log(`[apply-brand-strategies-199] coverage: ${blankHints} item(s) with blank brand_hint need assign-brand (no strategy can attach)`);
  }
}

async function main() {
  const dbPath =
    flag('db') || process.env.BAYSTATE_CMS_DB_PATH || process.env.DATABASE_PATH || './app.db';
  const apply = flag('apply') !== undefined;
  const approvedBy = flag('approved-by') || 'issue-199';
  const skip = new Set(
    (flag('skip-brands') ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const ackOc = flag('acknowledge-oc-identity') !== undefined;

  initDb(dbPath);
  runMigrations();
  // Touch the handle so minimal DBs fail fast before planning.
  getDb();
  const workspace = requireServerSingletonWorkspace();

  // Fail fast on invented distributor ids (the approval flow would reject
  // them per brand; checking up front keeps the plan atomic to review).
  for (const r of BRAND_199_RESOLUTIONS) {
    for (const id of r.distributorIds) {
      if (!isSupportedDistributorId(id)) {
        throw new Error(`[apply-brand-strategies-199] Unknown distributor '${id}' for brand '${r.brand}'`);
      }
    }
  }

  console.log(`[apply-brand-strategies-199] workspace=${workspace.id} db=${dbPath} mode=${apply ? 'APPLY' : 'dry-run'}`);
  console.log(`[apply-brand-strategies-199] inventory: ${BRAND_199_RESOLUTIONS.length} brands, ${BRAND_199_TOTAL_ITEMS} items`);
  reportItemCoverage();

  let planned = 0;
  let skipped = 0;
  let applied = 0;
  const failures: string[] = [];

  for (const r of BRAND_199_RESOLUTIONS) {
    const tag = `[${r.brand} (${r.itemCount} items, ${r.kind})]`;
    if (skip.has(normalizeBrandKey(r.brand))) {
      console.log(`${tag} skipped via --skip-brands`);
      skipped += 1;
      continue;
    }
    if (r.needsIdentityConfirmation && !ackOc) {
      const msg = `${tag} REFUSED: ${r.needsIdentityConfirmation} Re-run with --acknowledge-oc-identity (after verifying the item) or --skip-brands=oc.`;
      console.log(msg);
      failures.push(msg);
      continue;
    }

    const input = brand199SaveInput(r);
    const existing = getBrandStrategyRow(workspace.id, r.brand);
    if (existing?.approved && sameSources(existing.sources, input.sources)) {
      console.log(`${tag} already applied (rev ${existing.revision}, identical sources) — skipping`);
      skipped += 1;
      continue;
    }

    const expectedRevision = existing?.revision ?? 0;
    const describe = existing
      ? `re-approve rev ${existing.revision}→${existing.revision + 1}`
      : 'new approval rev 1';
    if (!apply) {
      console.log(`${tag} PLAN: ${describe} sources=${JSON.stringify(input.sources)}${input.configuration ? ` mappings=${JSON.stringify(input.configuration.officialDomains)}` : ''}`);
      planned += 1;
      continue;
    }

    try {
      const saved = saveBrandStrategy(workspace.id, {
        brand: (r as Brand199Resolution).brand,
        sources: input.sources,
        expectedRevision,
        ...(input.configuration
          ? {
              configuration: input.configuration,
              expectedConfigurationToken: computeBrandStrategyConfigurationToken(
                workspace.id,
                normalizeBrandKey(r.brand),
              ),
            }
          : {}),
        approvedBy,
      });
      console.log(`${tag} APPLIED rev ${saved.revision} sources=${JSON.stringify(saved.sources)}`);
      applied += 1;
    } catch (err) {
      const msg = `${tag} FAILED: ${err instanceof Error ? err.message : String(err)}`;
      console.log(msg);
      failures.push(msg);
    }
  }

  console.log(
    `[apply-brand-strategies-199] done: applied=${applied} planned=${planned} skipped=${skipped} failures=${failures.length}`,
  );
  if (!apply && planned > 0) {
    console.log('[apply-brand-strategies-199] Re-run with --apply to write. Item-level assignment (34 items via assign-brand / assign-domain surfaces) + #201 probe handoff are operator steps — see docs/plans/brand-sourcing-strategies-199.md.');
  }
  if (failures.length > 0 && apply) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[apply-brand-strategies-199] fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
