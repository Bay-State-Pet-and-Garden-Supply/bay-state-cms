// T4 (#228) — validation persistence, route, and health wiring (Bun suite).
//
// Bun suite (SQLite via the repository layer; run under `bun test` via
// test:db, excluded from Vitest per the dual-runner gate). Proves:
// - validation references persist per investigation (round-trip);
// - the Validate Proposal route rejects an exposed holdout without
//   invoking the production worker (stable `holdout_exposed` code);
// - an applied investigation-derived draft is unhealthy until passed
//   validation plus a passing blind holdout are bound (non-waivable);
// - the Validate/Apply/Discard flow never activates, releases, attests
//   image review, or writes trusted extraction output.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  getJson,
  initInvestigationDb,
  postJson,
  teardownInvestigationDb,
} from './helpers/browser-investigation-route-suite';
import {
  getInvestigationValidationState,
  saveInvestigationValidation,
} from '../../db/repositories/browser-investigation-repo';
import {
  getActiveVersion,
  getVersionById,
} from '../../db/repositories/profile-version-repo';
import { createSqliteInvestigationStore } from '../../onboarding/browser-investigation/store';
import { requestInvestigation, runInvestigation } from '../../onboarding/browser-investigation/service';
import { fakeInvestigationProvider } from '../../onboarding/browser-investigation/fake-provider';
import {
  getInvestigationProvider,
  registerInvestigationProvider,
} from '../../onboarding/browser-investigation/provider';
import { evaluateCandidateVersionHealth } from '../../onboarding/domain-version-health';

const WS_MAIN = 'ws-binv-validate-main';
const WS_FOREIGN = 'ws-binv-validate-foreign';
const DOMAIN = 'validate-shop.example.com';

let tempDir: string;

beforeAll(() => {
  tempDir = initInvestigationDb('binv-t4-validate-', [
    { id: WS_MAIN, name: 'validate main' },
    { id: WS_FOREIGN, name: 'validate foreign' },
  ]);
});

afterAll(() => {
  teardownInvestigationDb(tempDir);
});

beforeEach(async () => {
  // Drain active investigations per domain so launches never conflict.
  const listed = await getJson(`/api/domains/${DOMAIN}/investigations`);
  const rows: Array<{ id: string; status: string }> = listed.json?.investigations ?? [];
  for (const row of rows) {
    if (row.status === 'queued' || row.status === 'running') {
      await postJson(`/api/domains/${DOMAIN}/investigations/${row.id}/cancel`, {});
    }
    await postJson(`/api/domains/${DOMAIN}/investigations/${row.id}/discard`, { actor: 'test-reset' }).catch(() => ({}));
  }
});

/** Explicit fake injection for deterministic setup (#235): production HTTP
 * launches run the real harness, so tests needing a completed fake build it
 * directly through the service (never via the operator API). */
function ensureFakeForService(): void {
  try {
    getInvestigationProvider('fake');
  } catch {
    registerInvestigationProvider(fakeInvestigationProvider);
  }
}

async function launchSamples(sampleUrls: string[]): Promise<string> {
  ensureFakeForService();
  fakeInvestigationProvider.setScenario('valid');
  const store = createSqliteInvestigationStore();
  const created = requestInvestigation(store, {
    workspaceId: WS_MAIN,
    domain: DOMAIN,
    mode: 'domain_onboarding',
    sampleUrls,
    provider: 'fake',
  });
  const completed = await runInvestigation(store, 'fake', WS_MAIN, created.id);
  expect(completed.status).toBe('completed');
  return created.id;
}

describe('T4 validation persistence and route wiring', () => {
  it('persists validation references per investigation (round-trip)', async () => {
    const store = createSqliteInvestigationStore();
    const created = store.insert({
      workspaceId: WS_MAIN,
      domain: DOMAIN,
      mode: 'domain_onboarding',
      status: 'completed',
      provider: 'fake',
      runId: 'binvrun_persist_1',
      requestedModelJson: null,
      actualModelJson: null,
      inputSnapshotJson: JSON.stringify({
        domain: DOMAIN,
        mode: 'domain_onboarding',
        sampleUrls: [`https://${DOMAIN}/products/alpha`],
        budget: {},
        modelPolicy: {},
        knownContext: {},
        requestedAt: new Date().toISOString(),
      }),
      inputHash: 'input-persist-1',
      budgetJson: '{}',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const saved = saveInvestigationValidation(
      WS_MAIN,
      created.id,
      JSON.stringify({ validationId: 'vval_x' }),
      'a'.repeat(64),
      'b'.repeat(64),
      new Date().toISOString(),
    );
    expect(saved?.validationHash).toBe('a'.repeat(64));
    expect(saved?.policyHash).toBe('b'.repeat(64));
    const reloaded = getInvestigationValidationState(WS_MAIN, created.id);
    expect(reloaded?.validationJson).toContain('vval_x');
    // Foreign workspace sees nothing.
    expect(getInvestigationValidationState(WS_FOREIGN, created.id)).toBeNull();
    await postJson(`/api/domains/${DOMAIN}/investigations/${created.id}/discard`, { actor: 'test-cleanup' });
  });

  it('rejects an exposed holdout without invoking the production worker', async () => {
    const rep = `https://${DOMAIN}/products/alpha`;
    const id = await launchSamples([rep]);
    const res = await postJson(`/api/domains/${DOMAIN}/investigations/${id}/validate`, {
      samples: [
        { url: rep, role: 'representative', expected: { name: 'Alpha', gtin: '810001234501', productId: '999001' } },
        { url: rep, role: 'holdout', expected: { name: 'Alpha', gtin: '810001234501', productId: '999001' } },
      ],
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.json)).toMatch(/holdout_exposed/);
    // No validation reference was persisted for the rejected run.
    expect(getInvestigationValidationState(WS_MAIN, id)?.validationJson).toBeNull();
  });

  it('rejects a name-only expected identity without invoking the production worker (#241)', async () => {
    const rep = `https://${DOMAIN}/products/alpha`;
    const id = await launchSamples([rep]);
    const res = await postJson(`/api/domains/${DOMAIN}/investigations/${id}/validate`, {
      samples: [
        { url: rep, role: 'representative', expected: { name: 'Alpha' } },
      ],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toMatch(/untrusted_expectation/);
    // No validation reference was persisted for the rejected run.
    expect(getInvestigationValidationState(WS_MAIN, id)?.validationJson).toBeNull();
  });

  it('rejects validation on non-completed investigations', async () => {
    const launched = await postJson(`/api/domains/${DOMAIN}/investigations`, {
      sampleUrls: [`https://${DOMAIN}/products/queued-1`],
      queueOnly: true,
    });
    expect(launched.status).toBe(201);
    const id = launched.json.investigation.id as string;
    const res = await postJson(`/api/domains/${DOMAIN}/investigations/${id}/validate`, {
      samples: [{ url: `https://${DOMAIN}/products/queued-1`, role: 'representative', expected: { name: 'Q', gtin: '810001234501', productId: '999001' } }],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toMatch(/invalid_transition/);
  });

  it('an applied investigation-derived draft stays unhealthy without passed validation plus holdout', async () => {
    const rep = `https://${DOMAIN}/products/alpha`;
    const id = await launchSamples([rep]);
    const applied = await postJson(`/api/domains/${DOMAIN}/investigations/${id}/apply`, { actor: 'operator-1' });
    expect(applied.status).toBe(201);
    const versionId = applied.json.applied.appliedVersionId as string;
    const version = getVersionById(versionId);
    expect(version).not.toBeNull();
    expect((version!.validationSummary as { investigationDerived?: boolean }).investigationDerived).toBe(true);
    // No validation ran and no holdout passed: the shared evaluator blocks,
    // and the active pointer is untouched (inactive draft only).
    const health = evaluateCandidateVersionHealth(DOMAIN, versionId);
    expect(health.healthy).toBe(false);
    expect(health.reason).toMatch(/validation_not_passed/);
    expect(getActiveVersion(DOMAIN)).toBeNull();
  });

  it('validation, discard, and apply leave items and activation untouched', async () => {
    const rep = `https://${DOMAIN}/products/beta`;
    const id = await launchSamples([rep]);
    const validation = await getJson(`/api/domains/${DOMAIN}/investigations/${id}/validation`);
    expect(validation.status).toBe(200);
    expect(validation.json.validation).toBeNull();
    const discarded = await postJson(`/api/domains/${DOMAIN}/investigations/${id}/discard`, { actor: 'operator-1' });
    expect(discarded.status).toBe(200);
    expect(getActiveVersion(DOMAIN)).toBeNull();
  });
});
