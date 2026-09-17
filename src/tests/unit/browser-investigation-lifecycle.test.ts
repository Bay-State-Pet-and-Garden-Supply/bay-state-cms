// T1 (#225) — Browser Investigation lifecycle over SQLite + routes.
//
// Bun suite (bun:sqlite via the repository layer; run under `bun test` via
// test:db, excluded from Vitest per the dual-runner gate). Proves the
// workspace-scoped persistence contract end to end: explicit investigate /
// drift-repair routes are the only provider callers, investigations persist
// with the full envelope, foreign-workspace access is rejected, and stale /
// replayed completions cannot mutate terminal state.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  getJson,
  initInvestigationDb,
  postJson,
  teardownInvestigationDb,
} from './helpers/browser-investigation-route-suite';
import {
  findActiveInvestigation,
  findInvestigationById,
  insertInvestigation,
} from '../../db/repositories/browser-investigation-repo';
import { createSqliteInvestigationStore } from '../../onboarding/browser-investigation/store';
import { fakeInvestigationProvider } from '../../onboarding/browser-investigation/fake-provider';
import { getDomainDiagnosticsResponse } from '../../onboarding/domain-diagnostics-service';
import {
  getInvestigationProviderCallCount,
  resetInvestigationProviderCalls,
} from '../../onboarding/browser-investigation/provider';
import { acceptCompletion,
  getInvestigation,
  requestInvestigation,
} from '../../onboarding/browser-investigation/service';
const WS_MAIN = 'ws-binv-lifecycle-main';
const WS_FOREIGN = 'ws-binv-lifecycle-foreign';

let tempDir: string;

describe('browser investigation lifecycle over SQLite (T1)', () => {
  beforeAll(() => {
    tempDir = initInvestigationDb('binv-lifecycle-test-', [
      { id: WS_MAIN, name: 'Investigation Lifecycle Workspace' },
      { id: WS_FOREIGN, name: 'Foreign Workspace' },
    ]);
  });

  afterAll(() => {
    fakeInvestigationProvider.setScenario('valid');
    teardownInvestigationDb(tempDir);
  });

  beforeEach(() => {
    fakeInvestigationProvider.setScenario('valid');
    resetInvestigationProviderCalls();
  });

  it('explicit investigate route persists a completed fake investigation with the full envelope', async () => {
    const domain = `investigate-${Date.now()}.example.com`;
    const { status, json } = await postJson(`/api/domains/${domain}/investigations`, {
      sampleUrls: [`https://${domain}/products/alpha`],
    });
    expect(status).toBe(201);
    const inv = json.investigation;
    expect(inv.workspaceId).toBe(WS_MAIN);
    expect(inv.domain).toBe(domain);
    expect(inv.mode).toBe('domain_onboarding');
    expect(inv.status).toBe('completed');
    expect(inv.provider).toBe('fake');
    expect(inv.runId).toBeTruthy();
    expect(inv.inputHash).toBeTruthy();
    expect(inv.inputSnapshot.sampleUrls).toEqual([`https://${domain}/products/alpha`]);
    expect(inv.budget.maxPages).toBe(5);
    expect(inv.result).not.toBeNull();
    expect(inv.resultHash).toBeTruthy();
    expect(inv.usage?.costBasis).toBe('unavailable');
    // Read-back is workspace-scoped and intact.
    const reread = findInvestigationById(WS_MAIN, inv.id);
    expect(reread?.id).toBe(inv.id);
    expect(reread?.resultHash).toBe(inv.resultHash);
  });

  it('drift-repair route persists mode drift_repair', async () => {
    const domain = `drift-${Date.now()}.example.com`;
    const { status, json } = await postJson(`/api/domains/${domain}/investigations/drift-repair`, {
      sampleUrls: [`https://${domain}/products/beta`],
      knownContext: { failureCodes: ['extraction_failed'] },
    });
    expect(status).toBe(201);
    expect(json.investigation.mode).toBe('drift_repair');
    expect(json.investigation.status).toBe('completed');
  });

  it('diagnostics reads make zero provider calls; only an explicit launch dispatches (negative invariant)', async () => {
    resetInvestigationProviderCalls();
    // Read-only diagnostics aggregation must never touch the provider seam.
    getDomainDiagnosticsResponse(new Date());
    expect(getInvestigationProviderCallCount()).toBe(0);
    const domain = `regression-${Date.now()}.example.com`;
    const launched = await postJson(`/api/domains/${domain}/investigations`, {
      sampleUrls: [`https://${domain}/products/alpha`],
    });
    expect(launched.status).toBe(201);
    expect(launched.json.investigation.status).toBe('completed');
    // Exactly one provider dispatch per explicit investigation run.
    expect(getInvestigationProviderCallCount()).toBe(1);
  });

  it('second active investigation for the same domain conflicts (409)', async () => {
    const domain = `conflict-${Date.now()}.example.com`;
    const first = await postJson(`/api/domains/${domain}/investigations`, {
      sampleUrls: [`https://${domain}/products/alpha`],
      queueOnly: true,
    });
    expect(first.status).toBe(201);
    expect(first.json.investigation.status).toBe('queued');
    const second = await postJson(`/api/domains/${domain}/investigations`, {
      sampleUrls: [`https://${domain}/products/alpha`],
      queueOnly: true,
    });
    expect(second.status).toBe(409);
    expect(String(second.json.error)).toMatch(/conflict_active_investigation/);
    // Cleanup: cancel the queued row so later tests stay isolated.
    const store = createSqliteInvestigationStore();
    const active = findActiveInvestigation(WS_MAIN, domain);
    expect(active).not.toBeNull();
    const cancel = await postJson(`/api/domains/${domain}/investigations/${first.json.investigation.id}/cancel`, {});
    expect(cancel.status).toBe(200);
    void store;
  });

  it('foreign-workspace reads are rejected without leaking state', async () => {
    const domain = `foreign-${Date.now()}.example.com`;
    const created = await postJson(`/api/domains/${domain}/investigations`, {
      sampleUrls: [`https://${domain}/products/alpha`],
    });
    expect(created.status).toBe(201);
    const id = created.json.investigation.id as string;
    // Same row under a foreign workspace id is invisible at the repo seam.
    expect(findInvestigationById(WS_FOREIGN, id)).toBeNull();
    // Service seam rejects with workspace_mismatch.
    const store = createSqliteInvestigationStore();
    expect(() => getInvestigation(store, WS_FOREIGN, id)).toThrowError(/workspace_mismatch/);
  });

  it('status, cancel, and discard routes enforce lifecycle transitions', async () => {
    const domain = `transitions-${Date.now()}.example.com`;
    const queued = await postJson(`/api/domains/${domain}/investigations`, {
      sampleUrls: [`https://${domain}/products/alpha`],
      queueOnly: true,
    });
    expect(queued.status).toBe(201);
    const id = queued.json.investigation.id as string;
    const status = await getJson(`/api/domains/${domain}/investigations/${id}/status`);
    expect(status.status).toBe(200);
    expect(status.json.status.status).toBe('queued');
    // Active investigations cannot be discarded.
    const badDiscard = await postJson(`/api/domains/${domain}/investigations/${id}/discard`, { actor: 'op' });
    expect(badDiscard.status).toBe(400);
    const cancel = await postJson(`/api/domains/${domain}/investigations/${id}/cancel`, {});
    expect(cancel.status).toBe(200);
    expect(cancel.json.investigation.status).toBe('cancelled');
    const discard = await postJson(`/api/domains/${domain}/investigations/${id}/discard`, { actor: 'op' });
    expect(discard.status).toBe(200);
    expect(discard.json.investigation.status).toBe('discarded');
  });

  it('malformed and evidence-missing provider output fail closed with stable codes', async () => {
    const malformedDomain = `malformed-${Date.now()}.example.com`;
    const malformed = await postJson(`/api/domains/${malformedDomain}/investigations`, {
      sampleUrls: [`https://${malformedDomain}/products/alpha`],
      scenario: 'malformed',
    });
    expect(malformed.status).toBe(201);
    expect(malformed.json.investigation.status).toBe('failed');
    expect(malformed.json.investigation.failureCode).toBe('malformed_result');

    const missingDomain = `missing-${Date.now()}.example.com`;
    const missing = await postJson(`/api/domains/${missingDomain}/investigations`, {
      sampleUrls: [`https://${missingDomain}/products/alpha`],
      scenario: 'evidence_missing',
    });
    expect(missing.status).toBe(201);
    expect(missing.json.investigation.status).toBe('failed');
    expect(missing.json.investigation.failureCode).toBe('evidence_missing');
  });

  it('replayed completions against terminal investigations are rejected', async () => {
    const store = createSqliteInvestigationStore();
    const domain = `replay-${Date.now()}.example.com`;
    const created = requestInvestigation(store, {
      workspaceId: WS_MAIN,
      domain,
      mode: 'domain_onboarding',
      sampleUrls: [`https://${domain}/products/alpha`],
    });
    // Drive to running, then accept a valid completion via the fake.
    const { runInvestigation } = await import('../../onboarding/browser-investigation/service');
    fakeInvestigationProvider.setScenario('valid');
    const completed = await runInvestigation(store, 'fake', WS_MAIN, created.id);
    expect(completed.status).toBe('completed');
    const replayed = fakeInvestigationProvider.replay();
    expect(() => acceptCompletion(store, WS_MAIN, created.id, replayed)).toThrowError(/replay_rejected/);
    expect(findInvestigationById(WS_MAIN, created.id)?.status).toBe('completed');
  });

  it('seeded foreign-workspace rows stay invisible to the requesting workspace', () => {
    const seeded = insertInvestigation({
      workspaceId: WS_FOREIGN,
      domain: 'seeded-foreign.example.com',
      mode: 'domain_onboarding',
      status: 'completed',
      provider: 'fake',
      runId: 'binvrun_seeded',
      requestedModelJson: null,
      actualModelJson: null,
      inputSnapshotJson: JSON.stringify({
        domain: 'seeded-foreign.example.com',
        mode: 'domain_onboarding',
        sampleUrls: ['https://seeded-foreign.example.com/p'],
        budget: { maxPages: 5, maxReads: 20, maxModelCalls: 8, timeoutMs: 600000 },
        modelPolicy: { allowCloudTextAnalysis: false, allowImageSharing: false },
        knownContext: {},
        requestedAt: new Date().toISOString(),
      }),
      inputHash: 'seeded-hash',
      budgetJson: JSON.stringify({ maxPages: 5, maxReads: 20, maxModelCalls: 8, timeoutMs: 600000 }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(findInvestigationById(WS_MAIN, seeded.id)).toBeNull();
    expect(findInvestigationById(WS_FOREIGN, seeded.id)?.id).toBe(seeded.id);
  });
});
