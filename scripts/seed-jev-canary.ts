/**
 * Seed development fixtures after normal Settings setup. Never changes
 * credentials, taxonomy pins, sharing policy, or freeze flags. Synthetic
 * fixtures do not provide real extraction provenance and cannot qualify the
 * production worker/promotion path. Holdout entries are never seeded here.
 * Usage: bun scripts/seed-jev-canary.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { initDb } from '../src/db/connection';
import { findWorkspace } from '../src/db/repositories/workspace-repo';
import { createBatch, listBatches } from '../src/db/repositories/onboarding-batch-repo';
import { insertItems, listItemsByBatch, updateItemExtractionData } from '../src/db/repositories/onboarding-item-repo';
import { refreshCandidateCohorts } from '../src/onboarding/curation-cohort-service';
import { loadRuntimeConfigAuthority } from '../src/classification/config-loader';
import { ExtractionDataSchema } from '../src/shared/schemas/onboarding';
import goldset from '../src/tests/fixtures/benchmark-jev-qualification-goldset.json';

const BATCH_NAME = 'Jev Canary — goldset-16';

async function main(): Promise<void> {
  const databasePath = path.resolve('storage/catalog/.shopsite-cms/app.db');
  if (!fs.existsSync(databasePath)) throw new Error('Set up an existing workspace and its approved classification policy first.');
  initDb(databasePath);
  const workspace = findWorkspace();
  if (!workspace) throw new Error('No active workspace.');
  const authority = loadRuntimeConfigAuthority(workspace.workspacePath);
  const config = authority.kind === 'v2' ? authority.bundle : authority.config;
  if (authority.kind !== 'v2') throw new Error('Activate a reviewed v2/release-based taxonomy through Settings.');
  for (const stage of ['primary_product_type_proposal', 'product_attribute_proposals', 'category_page_proposals']) {
    const route = config.modelPolicy.stageOverrides[stage];
    if (!route?.provider || !route.model) throw new Error(`Configure an approved ${stage} route through Settings before seeding.`);
  }
  const entries = goldset.entries.filter(entry => entry.split === 'dev');
  const batch = listBatches(workspace.id).find(batch => batch.name === BATCH_NAME)
    ?? createBatch({ workspaceId: workspace.id, name: BATCH_NAME, fileName: 'development-fixtures', totalItems: entries.length });
  const existing = new Set(listItemsByBatch(batch.id).map(item => item.upc));
  const missing = entries.filter(entry => !existing.has(entry.sku));
  const inserted = insertItems(batch.id, missing.map((entry, index) => ({
    upc: entry.sku, name: entry.evidence[0]?.snippet ?? entry.sku, rowNumber: existing.size + index + 1,
    stage: 'prepare_listing', stageStatus: 'pending',
    isHeld: true, heldReason: 'Synthetic development fixture; evaluate through the frozen benchmark, not production dispatch.',
  })));
  for (const item of inserted) {
    const entry = missing.find(entry => entry.sku === item.upc)!;
    const extraction = ExtractionDataSchema.parse({ title: entry.evidence[0]?.snippet ?? null,
      description: entry.evidence.slice(1).map(evidence => evidence.snippet).join('\n\n') || null,
      brand: null, primaryImage: null, sourceType: 'official_page' });
    updateItemExtractionData(item.id, JSON.stringify(extraction));
  }
  console.log(`[seed-jev-canary] ${inserted.length} development fixtures added; holdout data, policy and existing decisions preserved.`);
  const cohorts = refreshCandidateCohorts(workspace.id, batch.id);
  console.log(`[seed-jev-canary] ${cohorts.filter(cohort => cohort.status !== 'ready').length} cohorts lack production source/extraction readiness. No worker dispatch or readiness bypass was performed.`);
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
