/**
 * Canary wave 2 seeder (#302 evaluation breadth).
 *
 * Wave 1 proved the workflow on one family (3x Acme dry kibble). #302 demands
 * family-separated evaluation across treats, toys, animal-care, pest control,
 * garden, confusing neighbors, unknown/no-fit types, and thin evidence — all
 * of which exist as dev-split entries in the frozen goldset fixture but were
 * never seeded (the batch holds only the kibble trio).
 *
 * Inserts the 9 dev-split, non-cohort gold entries into the existing
 * `Jev Canary — goldset-16` batch with the same gate scaffolding wave 1 used
 * (fixture price; no placeholder image; brand taken from the entry's own
 * evidence snippet where present, null otherwise — brands are inputs under
 * test only where the evidence states them). Holdout-split entries
 * (PEST-HOLDOUT, NEIGHBOR-SEED-HOLDOUT, FROMM pair) stay sealed: acceptance
 * policies must be published before holdout inspection.
 *
 * Holds newly inserted fixtures and reports readiness without dispatching
 * production work. Frozen benchmark evidence does not qualify extraction.
 * Review existing outputs with:
 *   bun scripts/review-canary.ts --batch "Jev Canary — goldset-16" --reviewer nick
 */

import { initDb } from '../src/db/connection';
import { runMigrations } from '../src/db/migrations';
import { findWorkspace } from '../src/db/repositories/workspace-repo';
import {
  listItemsByBatch,
  insertItems,
  updateItemExtractionData,
  type InsertItemData,
} from '../src/db/repositories/onboarding-item-repo';
import { refreshCandidateCohorts } from '../src/onboarding/curation-cohort-service';
import { listBatches } from '../src/db/repositories/onboarding-batch-repo';
import { ExtractionDataSchema } from '../src/shared/schemas/onboarding';
import goldset from '../src/tests/fixtures/benchmark-jev-qualification-goldset.json';

const BATCH_NAME = 'Jev Canary — goldset-16';

/** Wave-2 SKUs with gate scaffolding. Brand is taken from the entry's own
 *  snippet where present; null means "brand not under test for this item". */
const WAVE2: Array<{ sku: string; brand: string | null; price: string }> = [
  { sku: 'QUAL-CAT-TREAT-01', brand: 'Beacon', price: '8.99' },
  { sku: 'QUAL-DOG-CHEW-TOY-01', brand: 'Cowyard', price: '14.99' },
  { sku: 'QUAL-FLEA-01', brand: 'Beacon', price: '19.99' },
  { sku: 'QUAL-PEST-01', brand: 'GardenPro', price: '12.99' },
  { sku: 'QUAL-SOIL-01', brand: 'GardenPro', price: '9.99' },
  { sku: 'QUAL-NEIGHBOR-SUET-01', brand: null, price: '6.99' },
  { sku: 'QUAL-UNKNOWN-FOGGER-01', brand: 'MisterFog', price: '34.99' },
  { sku: 'QUAL-THIN-EVIDENCE-01', brand: null, price: '4.99' },
  { sku: 'QUAL-UNLABELED-PENDING-01', brand: null, price: '4.99' },
];

function fail(message: string): never {
  throw new Error(`[seed-wave2] ${message}`);
}

async function main(): Promise<void> {
  initDb('storage/catalog/.shopsite-cms/app.db');
  runMigrations();
  const workspace = findWorkspace();
  if (!workspace) fail('no workspace row found.');
  const batch = listBatches(workspace.id).find(batch => batch.name === BATCH_NAME);
  if (!batch) fail(`batch "${BATCH_NAME}" not found — run seed-jev-canary.ts first.`);

  const entries = (goldset as { entries: Array<{ sku: string; evidence: Array<{ snippet: string }> }> }).entries;
  const bySku = new Map(entries.map(e => [e.sku, e]));
  const existing = new Set(listItemsByBatch(batch.id).map(i => i.upc));

  const toInsert: InsertItemData[] = [];
  for (const spec of WAVE2) {
    if (existing.has(spec.sku)) {
      console.log(`[seed-wave2] ${spec.sku} already in batch; skipping.`);
      continue;
    }
    const entry = bySku.get(spec.sku) ?? fail(`goldset has no entry for ${spec.sku}.`);
    const snippets = entry.evidence.map(e => e.snippet).filter(Boolean);
    toInsert.push({
      upc: spec.sku,
      name: (snippets[0] ?? spec.sku).slice(0, 200),
      price: spec.price,
      brandHint: spec.brand,
      rowNumber: 100 + toInsert.length,
      stage: 'prepare_listing',
      stageStatus: 'pending',
      isHeld: true,
      heldReason: 'Synthetic development fixture; evaluate through the frozen benchmark, not production dispatch.',
    });
  }

  const inserted = insertItems(batch.id, toInsert);
  const byUpc = new Map(inserted.map(row => [row.upc, row.id]));
  for (const spec of WAVE2) {
    const itemId = byUpc.get(spec.sku);
    if (!itemId) continue;
    const entry = bySku.get(spec.sku) ?? fail(`goldset has no entry for ${spec.sku}.`);
    const snippets = entry.evidence.map(e => e.snippet).filter(Boolean);
    const extraction = {
      title: snippets[0] ?? null,
      brand: spec.brand,
      description: snippets.slice(1).join('\n\n') || null,
      primaryImage: null,
      sourceType: 'official_page',
    };
    const parsed = ExtractionDataSchema.safeParse(extraction);
    if (!parsed.success) fail(`extraction data invalid for ${spec.sku}.`);
    updateItemExtractionData(itemId, JSON.stringify(parsed.data));
  }
  console.log(`[seed-wave2] inserted ${inserted.length} item(s) with extraction data.`);

  const cohorts = refreshCandidateCohorts(workspace.id, batch.id);
  console.log(`[seed-wave2] ${cohorts.filter(cohort => cohort.status !== 'ready').length} cohorts lack real source/extraction readiness. No production worker was dispatched.`);
}

main().catch(err => {
  console.error(`[seed-wave2] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
