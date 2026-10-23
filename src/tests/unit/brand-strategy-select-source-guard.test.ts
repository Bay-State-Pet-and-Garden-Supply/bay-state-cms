// Builder slice B2 — strategy-bound manual select-source guard (Bun; real app).
//
// The select-source handler is the manual mutation that can route a
// strategy-bound item to an unselected/unsupported official source. This
// suite proves the narrow fail-closed check at that existing boundary:
// approved official domains are admitted, non-official candidates are held
// with 409 strategy_source_not_approved, and legacy unbound rows keep their
// historical semantics (no check without an approved strategy).
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mock } from 'bun:test';
import { unlinkSync } from 'node:fs';
// The live route re-verifies through the guarded confirmation service (page
// fetch + identity). Guard tests stub the discovery fetch so the
// strategy-guard behavior — not page contents — is under test. The stub
// serves a product-detail page whose title matches the register name with
// structured GTIN proof for the seeded UPC, so attested confirmations pass
// the verifier and reach the strategy assertions below.
mock.module('../../onboarding/job-queue', () => ({
  createDiscoveryFetch: () => async () =>
    new Response(
      `<html><head><title>Guard Product</title><script type="application/ld+json">{"@context":"https://schema.org/","@type":"Product","name":"Guard Product","gtin12":"012345678905"}</script></head><body><h1>Guard Product</h1></body></html>`,
      { status: 200, headers: { 'Content-type': 'text/html' } },
    ),
}));
import path from 'node:path';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { findItemById, insertItems } from '../../db/repositories/onboarding-item-repo';
import { insertSources, listSourcesByItem } from '../../db/repositories/onboarding-source-repo';
import { listOfficialPageDecisions } from '../../db/repositories/official-page-decision-repo';
import { upsertBrandSite } from '../../db/repositories/brand-site-repo';
import { saveBrandStrategy } from '../../db/repositories/brand-strategy-approval-repo';
import { startSourcingGeneration } from '../../db/repositories/onboarding-evidence-repo';
import { captureGenerationStrategyBinding } from '../../db/repositories/brand-strategy-generation-repo';
import { createDistributor } from '../../db/repositories/distributor-repo';
import app from '../../server/app';

const testDbPath = path.resolve(import.meta.dirname, 'brand-strategy-guard-test.db');
const wsId = 'ws-strategy-guard';

function currentnessFor(_item: { updatedAt: string }, _source: { discoveryRunId?: string | null }) {
  // Attestation + currentness the live route requires. Guard tests stub the
  // verifier transport at the module level (see mock below); the candidate
  // page re-verifies through the guarded service, never a direct approval.
  return { expectedUpdatedAt: _item.updatedAt, expectedDiscoveryRunId: _source.discoveryRunId ?? null, attestedProductAndVariant: true };
}

function seedItem(brandHint: string | null) {
  const batch = createBatch({ workspaceId: wsId, name: 'b', fileName: 'b.csv', totalItems: 1 });
  const [item] = insertItems(
    batch.id,
    [{ upc: '012345678905', name: 'Guard Product', brandHint, rowNumber: 1, stage: 'discovery' }],
    'sourcing',
    1,
  );
  const [official, retailer] = insertSources(item.id, [
    { url: 'https://acme.com/products/1', domain: 'acme.com', confidence: 0.9, discoveryRunId: 'dr_guard_live' },
    { url: 'https://retailer.example.net/p/9', domain: 'retailer.example.net', confidence: 0.8, discoveryRunId: 'dr_guard_live' },
  ]);
  return { item: { ...item, updatedAt: findItemOrThrow(item.id).updatedAt }, official, retailer };
}

function findItemOrThrow(id: string) {
  const found = findItemById(id);
  if (!found) throw new Error(`seeded item missing: ${id}`);
  return found;
}

describe('select-source strategy guard', () => {
  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    const now = new Date().toISOString();
    insertWorkspace({
      id: wsId,
      name: 'Guard Workspace',
      workspacePath: '/tmp/ws-guard',
      gitPath: '/tmp/ws-guard/.git',
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: 'baseline-sha',
    });
    createDistributor({ id: 'dist_phillips', name: 'Phillips' });
    upsertBrandSite('Acana', 'acme.com');
    saveBrandStrategy(wsId, {
      brand: 'Acana',
      sources: [
        { kind: 'official_page', domain: 'acme.com' },
        { kind: 'distributor_record', distributorId: 'dist_phillips' },
      ],
      expectedRevision: 0,
    });
  });

  afterAll(() => {
    closeDb();
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(testDbPath + suffix); } catch { /* ok */ }
    }
  });

  it('admits an approved official domain for a strategy-bound item', async () => {
    const { item, official } = seedItem('Acana');
    const res = await app.request(`/api/onboarding/items/${item.id}/select-source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: official.id, ...currentnessFor(item, official) }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects a direct POST without currentness fields (fail closed, no confirm)', async () => {
    const { item, official } = seedItem('Acana');
    const res = await app.request(`/api/onboarding/items/${item.id}/select-source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: official.id }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('currentness_required');
    // No decision recorded and nothing selected on the fail-closed path.
    expect(listOfficialPageDecisions(item.id)).toHaveLength(0);
    expect(listSourcesByItem(item.id).find(s => s.id === official.id)?.isSelected).toBe(false);
  });

  it('records a run-bound official_page_decision on the manual path', async () => {
    const { item, official } = seedItem('Acana');
    const res = await app.request(`/api/onboarding/items/${item.id}/select-source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: official.id, ...currentnessFor(item, official) }),
    });
    expect(res.status).toBe(200);
    const decisions = listOfficialPageDecisions(item.id);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.sourceRunId).toBe('dr_guard_live');
    expect(decisions[0]?.evidenceKind).toBe('observed_gtin');
  });

  it('holds a non-official candidate with 409 strategy_source_not_approved', async () => {
    const { item, retailer } = seedItem('Acana');
    const res = await app.request(`/api/onboarding/items/${item.id}/select-source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: retailer.id, ...currentnessFor(item, retailer) }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('strategy_source_not_approved');
  });

  it('legacy unbound rows are explicitly unconfirmable with a re-run directive', async () => {
    const { item } = seedItem('UnbrandedCo');
    const [legacy] = insertSources(item.id, [
      { url: 'https://legacy.example/products/1', domain: 'legacy.example', confidence: 0.9 },
    ]);
    const fresh = findItemOrThrow(item.id);
    const res = await app.request(`/api/onboarding/items/${item.id}/select-source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // currentness present but the row predates run binding: the legacy
      // branch fires before the generic currentness rejection.
      body: JSON.stringify({ sourceId: legacy.id, expectedUpdatedAt: fresh.updatedAt, expectedDiscoveryRunId: 'dr_any', attestedProductAndVariant: true }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('legacy_run_unbound');
    expect(listOfficialPageDecisions(item.id)).toHaveLength(0);
  });

  it('confirmation without the explicit attestation fails closed', async () => {
    const { item, official } = seedItem('Acana');
    const res = await app.request(`/api/onboarding/items/${item.id}/select-source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: official.id, expectedUpdatedAt: item.updatedAt, expectedDiscoveryRunId: official.discoveryRunId ?? null }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe('attestation_required');
    expect(listOfficialPageDecisions(item.id)).toHaveLength(0);
  });

  it('frozen generation boundary wins over a later live approval edit', async () => {
    // Ticket #123: distributor-only rev1 pins the generation; rev2 later
    // adds the official domain to the LIVE approval — manual selection of
    // that domain must still hold (frozen authority, never live expansion).
    upsertBrandSite('Frozen', 'frozen-official.com');
    saveBrandStrategy(wsId, {
      brand: 'Frozen',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
      expectedRevision: 0,
    });
    const batch = createBatch({ workspaceId: wsId, name: 'frozen-b', fileName: 'frozen.csv', totalItems: 1 });
    const [item] = insertItems(
      batch.id,
      [{ upc: '012345678905', name: 'Frozen Product', brandHint: 'Frozen', rowNumber: 1, stage: 'discovery' }],
      'sourcing',
      1,
    );
    const freshFrozen = findItemOrThrow(item.id);
    const [official] = insertSources(item.id, [
      { url: 'https://frozen-official.com/products/1', domain: 'frozen-official.com', confidence: 0.9, discoveryRunId: 'dr_frozen_live' },
    ]);
    const generation = startSourcingGeneration(item.id);
    captureGenerationStrategyBinding({ workspaceId: wsId, itemId: item.id, generationId: generation.id });
    // Live approval now admits the domain — the frozen pin does not.
    saveBrandStrategy(wsId, {
      brand: 'Frozen',
      sources: [
        { kind: 'official_page', domain: 'frozen-official.com' },
        { kind: 'distributor_record', distributorId: 'dist_phillips' },
      ],
      expectedRevision: 1,
    });
    const res = await app.request(`/api/onboarding/items/${item.id}/select-source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: official.id, expectedUpdatedAt: freshFrozen.updatedAt, expectedDiscoveryRunId: 'dr_frozen_live', attestedProductAndVariant: true }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('strategy_source_not_approved');
  });
});
