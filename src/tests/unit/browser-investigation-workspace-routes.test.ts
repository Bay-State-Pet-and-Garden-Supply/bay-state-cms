// T5 (#229) — workspace operator flow routes (Bun suite).
//
// Bun suite (SQLite via the repository layer; run under `bun test` via
// test:db, excluded from Vitest per the dual-runner gate). Proves:
// - the workspace view returns representatives, holdout coverage, budgets,
//   evidence-rich results, proposal preview, and separate Validate / Apply /
//   Discard affordances — with no activation or release affordance and no
//   computed health verdict;
// - the drift/failure entry pre-attaches the last-healthy baseline context
//   (explicitly unavailable when no active version exists) and echoes it;
// - a validation that drops a reserved holdout is rejected with the stable
//   `reserved_holdout_dropped` code before any worker runs;
// - validate/apply/discard still never activate, release, attest image
//   review, or write trusted extraction output.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  getJson,
  initInvestigationDb,
  postJson,
  teardownInvestigationDb,
} from './helpers/browser-investigation-route-suite';
import { saveInvestigationValidation } from '../../db/repositories/browser-investigation-repo';
import { createSqliteInvestigationStore } from '../../onboarding/browser-investigation/store';
import { requestInvestigation, runInvestigation } from '../../onboarding/browser-investigation/service';
import { fakeInvestigationProvider } from '../../onboarding/browser-investigation/fake-provider';
import {
  getInvestigationProvider,
  registerInvestigationProvider,
} from '../../onboarding/browser-investigation/provider';
import {
  getActiveVersion,
  getVersionById,
} from '../../db/repositories/profile-version-repo';
import { evaluateCandidateVersionHealth } from '../../onboarding/domain-version-health';

const DOMAIN = 'workspace-shop.example.com';

let tempDir: string;

beforeAll(() => {
  tempDir = initInvestigationDb('binv-t5-workspace-', [
    { id: 'ws-binv-workspace-main', name: 'workspace main' },
    { id: 'ws-binv-workspace-foreign', name: 'workspace foreign' },
  ]);
});

afterAll(() => {
  teardownInvestigationDb(tempDir);
});

beforeEach(async () => {
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
    // First workspace row is the requesting workspace in these suites.
    workspaceId: 'ws-binv-workspace-main',
    domain: DOMAIN,
    mode: 'domain_onboarding',
    sampleUrls,
    provider: 'fake',
  });
  const completed = await runInvestigation(store, 'fake', 'ws-binv-workspace-main', created.id);
  expect(completed.status).toBe('completed');
  return created.id;
}

describe('T5 workspace view and drift entry routes', () => {
  it('returns representatives, holdout coverage, budgets, evidence, and separate actions', async () => {
    const rep = `https://${DOMAIN}/products/alpha`;
    const id = await launchSamples([rep]);
    const res = await getJson(`/api/domains/${DOMAIN}/investigations/${id}/workspace`);
    expect(res.status).toBe(200);
    const workspace = res.json.workspace;
    expect(workspace.investigation).toMatchObject({ id, domain: DOMAIN, status: 'completed' });
    expect(workspace.representatives.investigated).toEqual([rep]);
    expect(workspace.holdouts.required).toBe(1);
    expect(workspace.holdouts.validationStatus).toBe('not_run');
    expect(workspace.budgets.length).toBeGreaterThan(0);
    expect(workspace.budgets.some((row: { key: string }) => row.key === 'maxPages')).toBe(true);
    expect(workspace.evidence.investigationId).toBe(id);
    expect(workspace.evidence.usage.costDisplay).toBe('unavailable');
    expect(workspace.actions.validate.allowed).toBe(true);
    expect(workspace.actions.apply.allowed).toBe(true);
    expect(workspace.actions.discard.allowed).toBe(true);
    // No automatic activation or release affordance anywhere.
    expect(workspace.actions.automaticActivation).toBe(false);
    expect(workspace.actions.automaticRelease).toBe(false);
    expect(JSON.stringify(res.json)).not.toContain('activate');
    expect(JSON.stringify(res.json)).not.toContain('release');
    // No second health definition: the view computes no gate verdict.
    expect(workspace).not.toHaveProperty('healthy');
    expect(workspace).not.toHaveProperty('gate');
    expect(workspace.healthVerdict).toContain('shared domain-version-health evaluator');
  });

  it('returns 404 for unknown investigations without leaking state', async () => {
    const res = await getJson(`/api/domains/${DOMAIN}/investigations/binv_missing/workspace`);
    expect(res.status).toBe(404);
  });

  it('previews drift-repair entry context as explicitly unavailable without a baseline', async () => {
    const res = await getJson(`/api/domains/${DOMAIN}/investigations/drift-context`);
    expect(res.status).toBe(200);
    expect(res.json.driftContext.available).toBe(false);
    expect(res.json.driftContext.reason).toMatch(/no_active_version/);
  });

  it('drift-repair launch pre-attaches the entry context under the server-owned key', async () => {
    const rep = `https://${DOMAIN}/products/alpha`;
    const launched = await postJson(`/api/domains/${DOMAIN}/investigations/drift-repair`, {
      sampleUrls: [rep],
      knownContext: { operatorNote: 'price changed overnight' },
    });
    expect(launched.status).toBe(201);
    expect(launched.json.driftContext.available).toBe(false);
    const stored = launched.json.investigation.inputSnapshot.knownContext as Record<string, unknown>;
    expect(stored.operatorNote).toBe('price changed overnight');
    expect(stored.driftRepair).toEqual(launched.json.driftContext);
  });
});

describe('T5 holdout no-drop and apply governance routes', () => {

  it('rejects a validation that drops a reserved holdout without running the worker', async () => {
    const rep = `https://${DOMAIN}/products/alpha`;
    const holdout = `https://${DOMAIN}/products/holdout-1`;
    const id = await launchSamples([rep]);
    const seed = {
      validationId: 'vval_reserved_1',
      investigationId: id,
      domain: DOMAIN,
      status: 'failed',
      proposalHash: 'p'.repeat(64),
      policyHash: 'q'.repeat(64),
      baselineVersionId: null,
      samples: [{ url: rep, role: 'representative', status: 'pass' }],
      holdouts: { required: 1, passed: 0, sampleIds: [holdout] },
      blockers: ['holdout_failed:no blind holdout passed'],
      validatedAt: new Date().toISOString(),
      validationHash: 'r'.repeat(64),
    };
    saveInvestigationValidation('ws-binv-workspace-main', id, JSON.stringify(seed), 'r'.repeat(64), 'q'.repeat(64), seed.validatedAt);
    const res = await postJson(`/api/domains/${DOMAIN}/investigations/${id}/validate`, {
      samples: [{ url: rep, role: 'representative', expected: { name: 'Alpha' } }],
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.json)).toMatch(/reserved_holdout_dropped/);
    // Nothing was created, activated, or released by the rejected run.
    expect(getActiveVersion(DOMAIN)).toBeNull();
  });

  it('apply still publishes an inactive draft with image review pending and no activation', async () => {
    const rep = `https://${DOMAIN}/products/alpha`;
    const id = await launchSamples([rep]);
    const applied = await postJson(`/api/domains/${DOMAIN}/investigations/${id}/apply`, { actor: 'operator-1' });
    expect(applied.status).toBe(201);
    const versionId = applied.json.applied.appliedVersionId as string;
    const version = getVersionById(versionId);
    expect(version).not.toBeNull();
    expect((version!.validationSummary as { imageRuleOk?: boolean }).imageRuleOk).toBe(false);
    const health = evaluateCandidateVersionHealth(DOMAIN, versionId);
    expect(health.healthy).toBe(false);
    expect(getActiveVersion(DOMAIN)).toBeNull();
  });
});
