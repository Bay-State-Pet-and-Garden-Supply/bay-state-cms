// T2 (#226) — policy drafts over SQLite + routes.
//
// Bun suite (SQLite via the repository layer; run under `bun test` via
// test:db, excluded from Vitest per the dual-runner gate). Proves the
// blocked-draft path end to end: apply publishes a sanitized inactive
// shared draft without touching the active pointer and without leaking
// workspace-private prompts or raw observations; policy content
// participates in immutable version binding and drift comparison;
// unappliable outcomes create no versions; discard leaves active versions,
// health, and items untouched.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  getJson,
  initInvestigationDb,
  postJson,
  teardownInvestigationDb,
} from './helpers/browser-investigation-route-suite';
import {
  createVersion,
  getActiveVersion,
  getVersionById,
  listVersions,
} from '../../db/repositories/profile-version-repo';
import { createSqliteInvestigationStore } from '../../onboarding/browser-investigation/store';
import { acceptCompletion, requestInvestigation, runInvestigation } from '../../onboarding/browser-investigation/service';
import { fakeInvestigationProvider } from '../../onboarding/browser-investigation/fake-provider';
import {
  getInvestigationProvider,
  registerInvestigationProvider,
} from '../../onboarding/browser-investigation/provider';
import { evaluateCandidateVersionHealth, evaluateActiveVersionHealth } from '../../onboarding/domain-version-health';
import { INVESTIGATION_RESULT_VERSION } from '../../shared/schemas/browser-investigation';
const WS_MAIN = 'ws-binv-apply-main';
const WS_FOREIGN = 'ws-binv-apply-foreign';

let tempDir: string;

/** Explicit fake injection for deterministic setup (#235): production launches
 * run the real harness, so tests needing a completed fake build it directly
 * through the service with `provider: 'fake'` (never via the operator API). */
function ensureFakeForService(): void {
  try {
    getInvestigationProvider('fake');
  } catch {
    registerInvestigationProvider(fakeInvestigationProvider);
  }
}

async function launchCompletedFake(
  domain: string,
  launchBody?: Record<string, unknown>,
): Promise<string> {
  ensureFakeForService();
  fakeInvestigationProvider.setScenario('valid');
  const store = createSqliteInvestigationStore();
  const created = requestInvestigation(store, {
    workspaceId: WS_MAIN,
    domain,
    mode: 'domain_onboarding',
    sampleUrls: (launchBody?.sampleUrls as string[] | undefined) ?? [`https://${domain}/products/alpha`],
    ...(launchBody?.knownContext !== undefined ? { knownContext: launchBody.knownContext as Record<string, unknown> } : {}),
    provider: 'fake',
  });
  const completed = await runInvestigation(store, 'fake', WS_MAIN, created.id);
  expect(completed.status).toBe('completed');
  return created.id;
}

/** Launch an investigation and apply its proposal; returns ids plus raw responses. */
async function launchAndApply(
  domain: string,
  applyBody: Record<string, unknown>,
  launchBody?: Record<string, unknown>,
): Promise<{ id: string; applied: { status: number; json: any } }> {
  const id = await launchCompletedFake(domain, launchBody);
  const applied = await postJson(`/api/domains/${domain}/investigations/${id}/apply`, applyBody);
  return { id, applied };
}

describe('browser investigation policy drafts over SQLite (T2)', () => {
  beforeAll(() => {
    tempDir = initInvestigationDb('binv-apply-test-', [
      { id: WS_MAIN, name: 'Policy Draft Workspace' },
      { id: WS_FOREIGN, name: 'Foreign Workspace' },
    ]);
  });

  afterAll(() => {
    fakeInvestigationProvider.setScenario('valid');
    teardownInvestigationDb(tempDir);
  });

  beforeEach(() => {
    fakeInvestigationProvider.setScenario('valid');
  });

  it('apply publishes an inactive draft with blockers and no active-pointer touch', async () => {
    const domain = `apply-${Date.now()}.example.com`;
    const id = await launchCompletedFake(domain, {
      sampleUrls: [`https://${domain}/products/alpha`],
      knownContext: { operatorPrompt: 'CANARY-PROMPT-APPLY workspace-private notes' },
    });

    const activeBefore = getActiveVersion(domain);
    const versionsBefore = listVersions(domain).length;

    const proposal = await getJson(`/api/domains/${domain}/investigations/${id}/proposal`);
    expect(proposal.status).toBe(200);
    expect(proposal.json.outcome.status).toBe('proposal');

    const applied = await postJson(`/api/domains/${domain}/investigations/${id}/apply`, {
      actor: 'operator-1',
      validation: { status: 'failed', blockers: ['representative price mismatch'] },
    });
    expect(applied.status).toBe(201);
    const version = applied.json.version;
    expect(version?.id).toBe(applied.json.applied.appliedVersionId);
    // Inactive: active pointer untouched, exactly one version created.
    expect(getActiveVersion(domain)?.id ?? null).toBe(activeBefore?.id ?? null);
    expect(listVersions(domain).length).toBe(versionsBefore + 1);
    // Blockers preserved; image review never granted by saving.
    expect(version.validationSummary.imageRuleOk).toBe(false);
    expect(version.validationSummary.investigationDerived).toBe(true);
    expect(version.validationSummary.investigationId).toBe(id);
    expect(version.validationSummary.proposalHash).toBe(applied.json.applied.proposalHash);
    expect(version.validationSummary.policyHash).toBe(applied.json.applied.policyHash);
    expect(version.validationSummary.blockers).toContain('representative price mismatch');
    expect(version.validationSummary.blockers).toContain('validation:failed');
    // Sanitized: workspace-private prompt and raw observations never leak.
    const stored = getVersionById(version.id);
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain('CANARY-PROMPT-APPLY');
    // Adapter-first fake carries no selector exceptions.
    expect(version.selectors.shopifyJSONPath).toBe(true);
    expect(version.selectors.extractionPolicy.platform).toBe('shopify');
    expect(version.selectors.extractionPolicy.fields).toHaveLength(9);
  });

  it('a second apply is rejected without creating another version', async () => {
    const domain = `reapply-${Date.now()}.example.com`;
    const { id, applied: first } = await launchAndApply(domain, { actor: 'op' });
    expect(first.status).toBe(201);
    expect(listVersions(domain).length).toBe(1);
    const second = await postJson(`/api/domains/${domain}/investigations/${id}/apply`, { actor: 'op' });
    expect(second.status).toBe(409);
    expect(String(second.json.code ?? second.json.error)).toMatch(/already_applied/);
    expect(listVersions(domain).length).toBe(1);
  });

  it('requires_code_adapter completions are unappliable and create no versions', async () => {
    const store = createSqliteInvestigationStore();
    const domain = `adapter-${Date.now()}.example.com`;
    const created = requestInvestigation(store, {
      workspaceId: WS_MAIN,
      domain,
      mode: 'domain_onboarding',
      sampleUrls: [`https://${domain}/products/alpha`],
      provider: 'fake',
    });
    store.update(WS_MAIN, created.id, {
      status: 'running',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const versionsBefore = listVersions(domain).length;
    const completed = acceptCompletion(store, WS_MAIN, created.id, {
      investigationId: created.id,
      runId: created.runId,
      provider: 'fake',
      inputHash: created.inputHash,
      result: {
        version: INVESTIGATION_RESULT_VERSION,
        summary: 'Novel WooCommerce representation observed; no supported adapter.',
        observations: [
          {
            kind: 'woo_store_api_observation',
            sourceUrl: `https://${domain}/products/alpha`,
            artifactHash: 'b1b2c3d4e5f60718293a4b5c6d7e8f901',
            incomplete: false,
          },
        ],
        codeAdapterNeeded: {
          capability: 'woo_store_api_adapter',
          reason: 'WooCommerce Store API representation observed; no supported runtime adapter exists.',
        },
      },
    });
    expect(completed.status).toBe('completed');

    const proposal = await getJson(`/api/domains/${domain}/investigations/${created.id}/proposal`);
    expect(proposal.status).toBe(200);
    expect(proposal.json.outcome.status).toBe('requires_code_adapter');

    const applied = await postJson(`/api/domains/${domain}/investigations/${created.id}/apply`, { actor: 'op' });
    expect(applied.status).toBe(422);
    expect(String(applied.json.code ?? applied.json.error)).toMatch(/unappliable_proposal/);
    expect(listVersions(domain).length).toBe(versionsBefore);
  });

  it('policy edits invalidate prior validation while legacy versions keep semantics', async () => {
    const domain = `binding-${Date.now()}.example.com`;
    const { applied } = await launchAndApply(domain, { actor: 'op' });
    expect(applied.status).toBe(201);
    const version = getVersionById(applied.json.applied.appliedVersionId);
    expect(version?.validationSummary.policyHash).toBeTruthy();

    // Same validation summary, edited policy content → binding broken.
    const editedSelectors = JSON.parse(JSON.stringify(version!.selectors)) as Record<string, unknown>;
    const policy = editedSelectors.extractionPolicy as Record<string, unknown>;
    const fields = [...(policy.fields as Array<Record<string, unknown>>)];
    fields[0] = { ...fields[0], sources: ['json_ld', 'meta'] };
    (editedSelectors.extractionPolicy as Record<string, unknown>).fields = fields;
    const edited = createVersion({
      domain,
      selectors: editedSelectors,
      runtime: version!.runtime,
      sampleIds: [],
      artifactHashes: [],
      validationSummary: version!.validationSummary as Record<string, unknown>,
      provenance: { provider: 'test', model: 'test', configId: 'test' },
      approver: 'test',
      reason: 'binding-fixture-edit',
    });
    const editedVerdict = evaluateCandidateVersionHealth(domain, edited.id);
    expect(editedVerdict.healthy).toBe(false);
    expect(editedVerdict.reason).toBe('executable_content_changed');

    // Legacy version without policy content keeps prior behavior: no binding failure.
    const legacy = createVersion({
      domain: `legacy-${Date.now()}.example.com`,
      selectors: { titleSelector: 'h1' },
      runtime: 'rendered',
      sampleIds: [],
      artifactHashes: [],
      validationSummary: {},
      provenance: { provider: 'test', model: 'test', configId: 'test' },
      approver: 'test',
      reason: 'binding-fixture-legacy',
    });
    const legacyVerdict = evaluateCandidateVersionHealth(legacy.domain, legacy.id);
    expect(legacyVerdict.reason).not.toBe('executable_content_changed');
  });

  it('discard leaves active versions, health, and items untouched', async () => {
    const domain = `discard-${Date.now()}.example.com`;
    const { applied } = await launchAndApply(domain, { actor: 'op' });
    expect(applied.status).toBe(201);

    // A second investigation is discarded; the applied draft stays, and no
    // active pointer exists to disturb.
    const second = await postJson(`/api/domains/${domain}/investigations`, {
      sampleUrls: [`https://${domain}/products/beta`],
    });
    expect(second.status).toBe(201);
    const versionsBefore = listVersions(domain).map((v) => v.id);
    const healthBefore = evaluateActiveVersionHealth(domain);
    const discarded = await postJson(
      `/api/domains/${domain}/investigations/${second.json.investigation.id}/discard`,
      { actor: 'op' },
    );
    expect(discarded.status).toBe(200);
    expect(discarded.json.investigation.status).toBe('discarded');
    expect(listVersions(domain).map((v) => v.id)).toEqual(versionsBefore);
    expect(getActiveVersion(domain)).toBeNull();
    expect(evaluateActiveVersionHealth(domain)).toEqual(healthBefore);
  });
});
