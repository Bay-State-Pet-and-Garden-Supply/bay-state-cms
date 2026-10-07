/**
 * Bounded development replay boundary tests (issue #302 follow-up).
 *
 * Public-boundary only: the dev loader reads the approved representative
 * inputs (`docs/audits/jev-representative-v1`) and never touches private
 * holdout custody. No LIVE calls, no production writes, no fabricated
 * predictions — deterministic floor + blocked sides only.
 */

import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bindDevReplayPaths,
  loadDevReplayInputs,
  convertRepresentativeToFrozenSnapshot,
  createDevAttemptGuard,
  dryRunBudgetPreflight,
  assertLiveCaptureAllowed,  assertNoHoldoutAccess,
  isLiveRuntimeGuardWired,
  isPrivateHoldoutPath,
  planDevReplayBudget,
  resolveBaselineRoute,
  assertIsolatedBaselineStore,
  resolveDevCaptureMode,
  DEV_REPLAY_UNSUPPORTED_CAPABILITIES,
  REPLAY_CONTEXT_ISOLATED_SINGLE_CHOICE,
  REPLAY_CONTEXT_END_TO_END_COHORT,
  REPRESENTATIVE_DEV_GOLD_PATH,
  REPRESENTATIVE_MANIFEST_PATH,
  REPRESENTATIVE_TAXONOMY_PATH,
  INCUMBENT_DETERMINISTIC_FLOOR_LABEL,
} from '../../classification/jev-benchmark-replay';
import { captureGuardedJevForTest } from '../helpers/qualification-capture';
import {
  assertQualificationArtifactIntegrity,
  attachFrozenAuthorityDetails,
  buildQualificationCandidateQuestionSet,
  buildQualificationPredictionsFromCode,
  hashDevReplaySourceInputs,
  partitionCandidateQuestionsByPermittedEvidence,
  permittedEvidenceForQualificationTarget,
  qualificationEvidenceForBoundary,
  qualificationTaxonomiesFromFrozenSnapshot,
  resolveQualificationAttributeTarget,
  frozenAuthorityDetailsHash,
  validateFrozenAuthorityDetails,
  withFrozenAuthorityDetails,
  type FrozenAuthorityDetails,
  type QualificationGoldOnlyEntry,
  type QualificationTaxonomies,
} from '../../classification/benchmark-prediction';
import { extractFrozenAuthorityDetails } from '../../classification/jev-benchmark-replay';
import { executeSystemOne, TYPESAFE_EVALUATED_MODEL } from '../../ai/systemone-transport';
import type { ProviderConnection } from '../../ai/provider-connections';
import { hashCanonicalJson } from '../../shared/stable-id';

const DEV_INPUTS = {
  manifestPath: REPRESENTATIVE_MANIFEST_PATH,
  goldPath: REPRESENTATIVE_DEV_GOLD_PATH,
  taxonomyPath: REPRESENTATIVE_TAXONOMY_PATH,
};

const DEV_AUTHORITY = 'c0af5c1c555a2b11d8e1157625ef1af2e3fea98af6ab97d130a90060f3c4c34a';
const V2_AUTHORITY = '2310c06a9e92ef55b91dc96b03fa6b31e19656b0adfead653f7c572040713577';
const REPRESENTATIVE_V1_DIR = 'docs/audits/jev-representative-v1';

describe('isolated incumbent evaluation storage', () => {
  it('requires an explicit credential reference rather than treating a store path as credentials', () => {
    expect(resolveBaselineRoute({ provider: 'ollama', model: 'evaluation-model', isolatedStore: '/tmp/evaluation.db' }).route).toBeNull();
    expect(resolveBaselineRoute({ provider: 'ollama', model: 'evaluation-model', isolatedStore: '/tmp/evaluation.db', credentialRef: ' ' }).route).toBeNull();
  });

  it('rejects operational paths, symlinks and hard links before database initialization', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-isolation-'));
    try {
      const root = path.join(dir, 'workspace');
      fs.mkdirSync(root);
      const production = path.join(root, 'app.db');
      fs.writeFileSync(production, 'test-only database fixture');
      const options = { repositoryRoot: root, productionStorePaths: [production] };
      const symbolic = path.join(dir, 'symbolic.db');
      const hard = path.join(dir, 'hard.db');
      fs.symlinkSync(production, symbolic);
      fs.linkSync(production, hard);
      for (const candidate of [production, symbolic, hard]) {
        expect(() => assertIsolatedBaselineStore(candidate, options)).toThrow('baseline_store_not_isolated');
      }
      expect(() => assertIsolatedBaselineStore(dir, options)).toThrow('baseline_store_not_isolated');
      const isolated = path.join(dir, 'isolated.db');
      fs.writeFileSync(isolated, 'separate test-only database fixture');
      expect(assertIsolatedBaselineStore(isolated, options)).toBe(fs.realpathSync(isolated));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Controlled temporary fixture dir (never the actual private custody). */
function makeReplayDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `jev-replay-${label}-`));
}

/** Minimal convertible taxonomy (producer-domain hash computed, never dummy hex). */
function minimalFakeTaxonomy(): { bundle: unknown; pages: unknown; binding: Record<string, unknown> } {
  return {
    bundle: {
      productTypes: [{ id: 'grooming', name: 'Grooming', attributeProfileId: 'p-groom', invariantAttributes: {} }],
      attributes: [{
        id: 'species', name: 'Species', valueMode: 'controlled', allowedValues: ['Dog', 'Cat'],
        valueAliases: [], isClaim: false, isCompositionAttribute: false,
      }],
      attributeProfiles: [{
        id: 'p-groom', productTypeId: 'grooming',
        attributes: [{ attributeId: 'species', cardinality: 'single', required: false, applicabilityConditions: [] }],
      }],
      attributeMappings: [],
      curationTargets: [{ id: 't-species', attributeId: 'species', catalogField: null, label: 'Species' }],
      brands: [],
      guidance: [],
      modelPolicy: {},
      dataSharing: {},
    },
    pages: [{ pageId: 'pg-1', pageName: 'P' }],
    binding: { workspaceId: '00000000-0000-4000-8000-000000000000' },
  };
}

/** Valid control gold entry inside the minimal pool. */
function minimalValidGoldEntry() {
  return {
    sku: 'FAKE:contained:1',
    familyId: 'family-fake-contained',
    split: 'dev',
    assortment: 'test',
    evidence: [{ source: 'official_product_page', snippet: 'Fake', reliability: 'high', attributeId: null }],
    gold: {
      productType: { kind: 'known-type', typeId: 'grooming' },
      fieldAssignments: [{ targetId: 'species', state: 'known', value: 'Dog' }],
      categoryPages: {
        state: 'known', completeness: 'complete', pageIds: ['pg-1'],
        pageAssignments: [{ pageId: 'pg-1', pageName: 'P' }],
      },
    },
  };
}

/**
 * Write a same-directory fake trio whose authority hashes are ACTUAL
 * producer-domain hashes (hashCanonicalJson over the taxonomy bytes), never
 * dummy repeated hex. Overrides allow declared-mismatch and tamper cases.
 */
async function writeFakeTrio(
  dir: string,
  opts: {
    goldEntries?: unknown[];
    taxonomy?: { bundle: unknown; pages: unknown; binding: Record<string, unknown> };
    manifestAuthority?: string;
    goldAuthority?: string;
    manifestExtra?: Record<string, unknown>;
  } = {},
): Promise<{ manifest: string; gold: string; taxonomy: string; authority: string }> {
  const taxonomy = opts.taxonomy ?? minimalFakeTaxonomy();
  const { capturedAt: _drop, ...bindingIdentity } = taxonomy.binding;
  const authority = hashCanonicalJson({ bundle: taxonomy.bundle, pages: taxonomy.pages, binding: bindingIdentity });
  const manifest = `${dir}/manifest.json`;
  const gold = `${dir}/development-gold.json`;
  const taxonomyPath = `${dir}/taxonomy.json`;
  await Bun.write(manifest, JSON.stringify({ authorityHash: opts.manifestAuthority ?? authority, ...(opts.manifestExtra ?? {}) }));
  await Bun.write(gold, JSON.stringify({ authorityHash: opts.goldAuthority ?? authority, entries: opts.goldEntries ?? [minimalValidGoldEntry()] }));
  await Bun.write(taxonomyPath, JSON.stringify(taxonomy));
  return { manifest, gold, taxonomy: taxonomyPath, authority };
}

function loadTrio(trio: { manifest: string; gold: string; taxonomy: string }) {
  return loadDevReplayInputs({ manifestPath: trio.manifest, goldPath: trio.gold, taxonomyPath: trio.taxonomy });
}

/** Count fs.readFileSync calls during fn (rethrows fn errors to the caller). */
function countFileReads(fn: () => void): { calls: number; error: unknown } {
  const probe = spyOn(fs, 'readFileSync');
  let error: unknown = null;
  try {
    fn();
  } catch (err) {
    error = err;
  } finally {
    probe.mockRestore();
  }
  return { calls: (probe as unknown as { mock: { calls: unknown[] } }).mock.calls.length, error };
}

describe('dev replay public boundary', () => {
  it('loads the approved dev inputs (25 entries / 24 families, authority-bound)', () => {
    const loaded = loadDevReplayInputs(DEV_INPUTS);
    expect(loaded.entryCount).toBe(25);
    expect(loaded.familyCount).toBe(24);
    expect(loaded.authorityHash).toBe('c0af5c1c555a2b11d8e1157625ef1af2e3fea98af6ab97d130a90060f3c4c34a');
    for (const entry of loaded.goldEntries) expect(entry.split).toBe('dev');
  });

  it('dev never reads holdout/custody/sealed payloads (denied before any read)', () => {
    expect(isPrivateHoldoutPath('private-custody:holdout-gold-private.json')).toBe(true);
    // Even the public custody-metadata filename is protected by name: it is
    // never a replay input (metadata stays readable via direct fs, not the loader).
    expect(isPrivateHoldoutPath('docs/audits/jev-representative-v1/holdout-custody.json')).toBe(true);
    expect(isPrivateHoldoutPath('holdout.json')).toBe(true);
    expect(isPrivateHoldoutPath('/tmp/x/jev-representative-custody/holdout-primary-private.json')).toBe(true);
    expect(isPrivateHoldoutPath(REPRESENTATIVE_DEV_GOLD_PATH)).toBe(false);
    expect(isPrivateHoldoutPath(REPRESENTATIVE_TAXONOMY_PATH)).toBe(false);
    expect(isPrivateHoldoutPath(REPRESENTATIVE_MANIFEST_PATH)).toBe(false);
    expect(() => assertNoHoldoutAccess('private-custody:holdout-gold-private.json')).toThrow('holdout_sealed');
    expect(() => assertNoHoldoutAccess('sealed/holdout-private-labels.json')).toThrow('holdout_sealed');
    expect(() =>
      loadDevReplayInputs({ ...DEV_INPUTS, goldPath: 'private-custody:holdout-gold-private.json' }),
    ).toThrow('holdout_sealed');
  });

  it('malformed gold and authority drift deny before dispatch (never false-empty)', async () => {
    expect(() =>
      loadDevReplayInputs({ ...DEV_INPUTS, goldPath: 'docs/audits/jev-representative-v1/support.json' }),
    ).toThrow();
    // Drift: same-directory trio whose manifest authority is a REAL computed
    // hash that disagrees with gold (no dummy hex anywhere).
    const driftDir = makeReplayDir('drift');
    const driftTrio = await writeFakeTrio(driftDir, {
      manifestAuthority: hashCanonicalJson({ other: 'drift-domain' }),
    });
    expect(() => loadTrio(driftTrio)).toThrow('authority_hash_drift');
    // Malformed: a known-marker violation throws via the shared parser (never false-empty).
    const badDir = makeReplayDir('malformed');
    const badTrio = await writeFakeTrio(badDir, {
      goldEntries: [{ sku: 'X', familyId: 'f', split: 'dev', gold: { productType: { kind: 'bogus' } }, evidence: [] }],
    });
    expect(() => loadTrio(badTrio)).toThrow();
  });

  it('candidate-overbudget denies before dispatch; within-budget allows dry-run', () => {
    const denied = dryRunBudgetPreflight({ entryCount: 25, plannedHttpAttempts: 601 });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toMatch('candidate_overbudget');
    const allowed = dryRunBudgetPreflight({ entryCount: 25, plannedHttpAttempts: 25 });
    expect(allowed.allowed).toBe(true);
    const wide = dryRunBudgetPreflight({ entryCount: 25, plannedHttpAttempts: 25, budget: { maxConcurrency: 8 } });
    expect(wide.allowed).toBe(false);
    expect(wide.reason).toMatch('concurrency_exceeded');
  });

  it('inputs are gold-independent (frozen pool from authority, never gold labels)', () => {
    const loaded = loadDevReplayInputs(DEV_INPUTS);
    // Full controlled pool (74 types) dwarfs the dev gold known-type subset —
    // the pool cannot have been derived from gold.
    expect(loaded.frozenSnapshot.productTypes.length).toBe(74);
    const knownGoldTypes = new Set(
      loaded.goldEntries.map(e => e.gold.productType.typeId).filter((t): t is string => !!t),
    );
    expect(knownGoldTypes.size).toBeLessThan(loaded.frozenSnapshot.productTypes.length);
    // Per-target gold outcomes preserved (not normalized to empty).
    const states = new Set(loaded.goldEntries.flatMap(e => e.gold.fieldAssignments.map(f => f.state)));
    expect(states.has('known')).toBe(true);
    expect(states.has('insufficient-evidence')).toBe(true);
  });

  it('source-configured controlled memberships ride the frozen snapshot', () => {
    const loaded = loadDevReplayInputs(DEV_INPUTS);
    expect(loaded.frozenSnapshot.attributeTargets.length).toBeGreaterThan(0);
    for (const target of loaded.frozenSnapshot.attributeTargets) {
      expect(target.options.length).toBeGreaterThan(0);
    }
    expect(loaded.frozenSnapshot.attributeProfiles?.length).toBeGreaterThan(0);
    expect(loaded.frozenSnapshot.universalAttributeIds?.length).toBeGreaterThan(0);
    expect(loaded.frozenSnapshot.pages.length).toBe(212);
  });

  it('deterministic-floor capture over dev gold is isolated single-Choice, never cohort qualification', () => {
    const loaded = loadDevReplayInputs(DEV_INPUTS);
    const artifact = buildQualificationPredictionsFromCode(loaded.goldEntries, loaded.frozenSnapshot);
    expect(artifact.captureMode).toBe('deterministic_floor');
    expect(artifact.taxonomySource).toBe('frozen_snapshot');
    expect(artifact.entryCount).toBe(25);
    expect(REPLAY_CONTEXT_ISOLATED_SINGLE_CHOICE).toMatch('NOT cohort qualification');
    expect(REPLAY_CONTEXT_END_TO_END_COHORT).toMatch('not implemented in dev replay');
    expect(DEV_REPLAY_UNSUPPORTED_CAPABILITIES.length).toBeGreaterThan(0);
    expect(INCUMBENT_DETERMINISTIC_FLOOR_LABEL).toMatch('deterministic_floor');
  });

  it('live capture is blocked without a bound guard; baselines need isolated stores', () => {
    expect(() =>
      assertLiveCaptureAllowed({ liveCapture: true, model: 'jev-1.13.0', credentialRef: 'TYPESAFE_API_KEY' }),
    ).toThrow('live_runtime_guard_unwired');
    const guard = createDevAttemptGuard({ maxHttpAttempts: 600 });
    try {
      assertLiveCaptureAllowed({ liveCapture: true, model: 'jev-1.13.0', credentialRef: 'TYPESAFE_API_KEY', guard });
    } finally {
      guard.dispose();
    }
    const blocked = resolveBaselineRoute({ provider: 'ollama', model: 'llama3' });
    expect(blocked.route).toBeNull();
    expect(blocked.blockedReason).toMatch('baseline_live_requires_isolated_store');
    const unrequested = resolveBaselineRoute({});
    expect(unrequested.route).toBeNull();
    expect(unrequested.blockedReason).toBeNull();
  });

  it('converter reports gaps instead of inventing semantics', () => {
    expect(() => convertRepresentativeToFrozenSnapshot({}, [])).toThrow('incomplete_authority');
    expect(() =>
      convertRepresentativeToFrozenSnapshot({ productTypes: [], attributes: [], attributeProfiles: [] }, []),
    ).toThrow('incomplete_authority');
  });

  it('ambient credential alone never implies live (explicit flag + wired guard required)', () => {
    expect(resolveDevCaptureMode({ liveCaptureRequested: false, credentialPresent: true, guardWired: true })).toBe(
      'deterministic_floor',
    );
    expect(resolveDevCaptureMode({ liveCaptureRequested: true, credentialPresent: true, guardWired: false })).toBe(
      'deterministic_floor',
    );
    expect(resolveDevCaptureMode({ liveCaptureRequested: true, credentialPresent: false, guardWired: true })).toBe(
      'deterministic_floor',
    );
    expect(resolveDevCaptureMode({ liveCaptureRequested: true, credentialPresent: true, guardWired: true })).toBe(
      'live_captured',
    );
  });

  it('exact 600-combined-budget plan fits the 25-case pilot (questions/batches + max retry)', () => {
    const loaded = loadDevReplayInputs(DEV_INPUTS);
    const plan = planDevReplayBudget(loaded.goldEntries, loaded.frozenSnapshot);
    expect(plan.entryCount).toBe(25);
    expect(plan.totalQuestions).toBeGreaterThan(0);
    expect(plan.dispatchBatches).toBeGreaterThan(0);
    expect(plan.plannedHttpAttempts).toBeLessThanOrEqual(600);
    const preflight = dryRunBudgetPreflight({
      entryCount: plan.entryCount,
      plannedHttpAttempts: plan.plannedHttpAttempts,
    });
    expect(preflight.allowed).toBe(true);
  });

  it('guard wiring is the bound guard itself, never a global flag', () => {
    const guard = createDevAttemptGuard({ maxHttpAttempts: 5 });
    try {
      expect(isLiveRuntimeGuardWired(guard)).toBe(true);
    } finally {
      guard.dispose();
    }
    expect(isLiveRuntimeGuardWired(null)).toBe(false);
    expect(isLiveRuntimeGuardWired({})).toBe(false);
    expect(isLiveRuntimeGuardWired({ tryConsumeAttempt: () => true })).toBe(false);
    expect(() => createDevAttemptGuard({ maxHttpAttempts: 600, maxConcurrency: 8 })).toThrow(
      'concurrency_exceeded',
    );
  });
});

const GUARD_CONN: ProviderConnection = {
  id: 'typesafe-jev',
  label: 'TypeSafe Jev (Cloud)',
  transport: 'systemone',
  baseUrl: 'https://api.typesafe.ai/v1',
  credential: 'fixturekey-guard-test',
  trustZone: 'cloud',
  approvedHost: 'api.typesafe.ai',
  approvedPort: 443,
  enabled: true,
  connectTimeoutMs: 2000,
  inferenceTimeoutMs: 5000,
};

const GUARD_QUESTION = {
  kind: {
    type: 'choice' as const,
    instructions: 'Which kind?',
    criteria: { alpha: 'First option', beta: 'Second option' },
  },
};

function guardChoiceBody() {
  return {
    model: 'jev-1.13.0',
    answers: {
      kind: {
        type: 'choice',
        choice: 'alpha',
        probabilities: { alpha: 0.9, beta: 0.1 },
        confidence: 0.8,
      },
    },
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function guardJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('dev replay runtime guard (HTTP boundary)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('counts every attempt including the 429 retry; audit carries no secrets', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1 ? guardJsonResponse({ detail: 'slow down' }, 429) : guardJsonResponse(guardChoiceBody());
    }) as unknown as typeof fetch;
    const guard = createDevAttemptGuard({ maxHttpAttempts: 10 });
    try {
      const result = await executeSystemOne(GUARD_CONN, TYPESAFE_EVALUATED_MODEL, GUARD_QUESTION, 'state', {
        attemptBudget: { tryConsumeAttempt: () => guard.tryConsumeAttempt() },
      });
      expect(result.attempts).toBe(2);
      expect(result.retried).toBe(true);
      expect(calls).toBe(2);
      const audit = guard.audit();
      expect(audit.consumed).toBe(2);
      expect(audit.rejected).toBe(0);
      expect(JSON.stringify(audit)).not.toMatch('fixturekey');
    } finally {
      guard.dispose();
    }
  });

  it('denies the retry when the budget is exhausted — no later request', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return guardJsonResponse({ detail: 'slow down' }, 429);
    }) as unknown as typeof fetch;
    const guard = createDevAttemptGuard({ maxHttpAttempts: 1 });
    try {
      await expect(
        executeSystemOne(GUARD_CONN, TYPESAFE_EVALUATED_MODEL, GUARD_QUESTION, 'state', {
          attemptBudget: { tryConsumeAttempt: () => guard.tryConsumeAttempt() },
        }),
      ).rejects.toThrow('budget exhausted');
      expect(calls).toBe(1);
      expect(guard.audit().rejected).toBe(1);
    } finally {
      guard.dispose();
    }
  });

  it('second call with a spent budget sends no request', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return guardJsonResponse(guardChoiceBody());
    }) as unknown as typeof fetch;
    const guard = createDevAttemptGuard({ maxHttpAttempts: 1 });
    try {
      const first = await executeSystemOne(GUARD_CONN, TYPESAFE_EVALUATED_MODEL, GUARD_QUESTION, 'state', {
        attemptBudget: { tryConsumeAttempt: () => guard.tryConsumeAttempt() },
      });
      expect(first.attempts).toBe(1);
      await expect(
        executeSystemOne(GUARD_CONN, TYPESAFE_EVALUATED_MODEL, GUARD_QUESTION, 'state', {
          attemptBudget: { tryConsumeAttempt: () => guard.tryConsumeAttempt() },
        }),
      ).rejects.toThrow('budget exhausted');
      expect(calls).toBe(1);
    } finally {
      guard.dispose();
    }
  });

  it('deadline abort cancels before any request (never retries)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return guardJsonResponse(guardChoiceBody());
    }) as unknown as typeof fetch;
    const guard = createDevAttemptGuard({ maxHttpAttempts: 10, hardDeadlineMs: 1 });
    await new Promise(resolve => setTimeout(resolve, 10));
    try {
      await expect(
        executeSystemOne(GUARD_CONN, TYPESAFE_EVALUATED_MODEL, GUARD_QUESTION, 'state', {
          attemptBudget: { tryConsumeAttempt: () => guard.tryConsumeAttempt() },
          signal: guard.signal,
        }),
      ).rejects.toThrow('cancelled');
      expect(calls).toBe(0);
      expect(guard.audit().deadlineFired).toBe(true);
    } finally {
      guard.dispose();
    }
  });

  it('deterministic floor performs zero fetches (default dry run is network-free)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return guardJsonResponse(guardChoiceBody());
    }) as unknown as typeof fetch;
    const loaded = loadDevReplayInputs(DEV_INPUTS);
    const artifact = buildQualificationPredictionsFromCode(loaded.goldEntries, loaded.frozenSnapshot);
    expect(artifact.entryCount).toBe(25);
    expect(calls).toBe(0);
  });
});

describe('dev replay path binding (realpaths before bytes)', () => {
  it('bare holdout.json is denied with zero file reads', async () => {
    const dir = makeReplayDir('bare');
    await Bun.write(`${dir}/manifest.json`, JSON.stringify({ authorityHash: DEV_AUTHORITY }));
    await Bun.write(`${dir}/holdout.json`, JSON.stringify({ forged: true }));
    await Bun.write(`${dir}/taxonomy.json`, JSON.stringify({}));
    const { calls, error } = countFileReads(() =>
      bindDevReplayPaths({
        manifestPath: `${dir}/manifest.json`,
        goldPath: `${dir}/holdout.json`,
        taxonomyPath: `${dir}/taxonomy.json`,
      }),
    );
    expect(String((error as Error)?.message ?? error)).toMatch('holdout_sealed');
    expect(calls).toBe(0);
  });

  it('custom custody directory is denied with zero file reads', async () => {
    const root = makeReplayDir('custody');
    const dir = `${root}-jev-representative-custody`;
    fs.mkdirSync(dir, { recursive: true });
    await Bun.write(`${dir}/manifest.json`, JSON.stringify({ authorityHash: DEV_AUTHORITY }));
    await Bun.write(`${dir}/holdout-primary-private.json`, JSON.stringify({ forged: true }));
    await Bun.write(`${dir}/taxonomy.json`, JSON.stringify({}));
    const { calls, error } = countFileReads(() =>
      bindDevReplayPaths({
        manifestPath: `${dir}/manifest.json`,
        goldPath: `${dir}/holdout-primary-private.json`,
        taxonomyPath: `${dir}/taxonomy.json`,
      }),
    );
    expect(String((error as Error)?.message ?? error)).toMatch('holdout_sealed');
    expect(calls).toBe(0);
  });

  it('symlink into a protected realpath is denied with zero file reads', async () => {
    const root = makeReplayDir('link');
    const vault = `${root}-vault-custody`;
    fs.mkdirSync(vault, { recursive: true });
    await Bun.write(`${vault}/real-manifest.json`, JSON.stringify({ authorityHash: DEV_AUTHORITY }));
    const clean = makeReplayDir('clean');
    fs.symlinkSync(`${vault}/real-manifest.json`, `${clean}/manifest.json`);
    await Bun.write(`${clean}/development-gold.json`, JSON.stringify({}));
    await Bun.write(`${clean}/taxonomy.json`, JSON.stringify({}));
    const { calls, error } = countFileReads(() =>
      bindDevReplayPaths({
        manifestPath: `${clean}/manifest.json`,
        goldPath: `${clean}/development-gold.json`,
        taxonomyPath: `${clean}/taxonomy.json`,
      }),
    );
    expect(String((error as Error)?.message ?? error)).toMatch('holdout_sealed');
    expect(calls).toBe(0);
  });

  it('public dev inputs in one folder with correct manifest hash succeed', () => {
    const loaded = loadDevReplayInputs(DEV_INPUTS);
    expect(loaded.entryCount).toBe(25);
    expect(loaded.familyCount).toBe(24);
    expect(path.dirname(loaded.goldPath)).toBe(path.dirname(loaded.manifestPath));
    expect(path.dirname(loaded.taxonomyPath)).toBe(path.dirname(loaded.manifestPath));
  });

  it('external gold outside the manifest directory fails with no dispatch', async () => {
    const dirA = makeReplayDir('exta');
    const dirB = makeReplayDir('extb');
    await Bun.write(`${dirA}/manifest.json`, JSON.stringify({ authorityHash: DEV_AUTHORITY }));
    await Bun.write(
      `${dirA}/development-gold.json`,
      JSON.stringify({ authorityHash: DEV_AUTHORITY, entries: [minimalValidGoldEntry()] }),
    );
    await Bun.write(`${dirB}/taxonomy.json`, JSON.stringify({}));
    const { calls, error } = countFileReads(() =>
      loadDevReplayInputs({
        manifestPath: `${dirA}/manifest.json`,
        goldPath: `${dirA}/development-gold.json`,
        taxonomyPath: `${dirB}/taxonomy.json`,
      }),
    );
    expect(String((error as Error)?.message ?? error)).toMatch('dev_replay_unbound_inputs');
    expect(calls).toBe(0);
  });

  it('manifest-declared hash mismatch fails before labels are parsed', async () => {
    const dir = makeReplayDir('hash');
    const trio = await writeFakeTrio(dir, {
      manifestExtra: { records: [{ path: 'development-gold.json', sha256: hashCanonicalJson({ forged: true }) }] },
    });
    let error: unknown = null;
    try {
      loadTrio(trio);
    } catch (err) {
      error = err;
    }
    expect(String((error as Error)?.message ?? error)).toMatch('dev_replay_hash_mismatch');
  });

  it('undeclared custom gold basename fails', async () => {
    const dir = makeReplayDir('undeclared');
    const taxonomy = minimalFakeTaxonomy();
    const { capturedAt: _drop, ...bindingIdentity } = taxonomy.binding;
    const authority = hashCanonicalJson({ bundle: taxonomy.bundle, pages: taxonomy.pages, binding: bindingIdentity });
    await Bun.write(`${dir}/manifest.json`, JSON.stringify({ authorityHash: authority }));
    await Bun.write(`${dir}/custom-gold.json`, JSON.stringify({ authorityHash: authority, entries: [minimalValidGoldEntry()] }));
    await Bun.write(`${dir}/taxonomy.json`, JSON.stringify(taxonomy));
    let error: unknown = null;
    try {
      loadDevReplayInputs({
        manifestPath: `${dir}/manifest.json`,
        goldPath: `${dir}/custom-gold.json`,
        taxonomyPath: `${dir}/taxonomy.json`,
      });
    } catch (err) {
      error = err;
    }
    expect(String((error as Error)?.message ?? error)).toMatch('dev_replay_undeclared_input');
  });
});

const NOUL_MODEL = 'jev-1.13.0';

/** Minimal multi-value taxa: grooming → species (real 13 configured values) + one page. */
const REAL_SPECIES_OPTIONS = ['Dog', 'Cat', 'Bird', 'Horse', 'Poultry', 'Cattle', 'Goat', 'Sheep', 'Swine', 'Small Animal', 'Wildlife', 'Fish', 'Reptile'];

function makeNoulTaxa(opts: { compositionSpecies?: boolean } = {}): QualificationTaxonomies {
  const base: QualificationTaxonomies = {
    productTypes: [{ id: 'grooming', label: 'Grooming', attributeProfileId: 'p-groom' }],
    attributeTargets: [{ targetId: 'species', cardinality: 'multiple', options: REAL_SPECIES_OPTIONS }],
    pages: [{ pageId: 'pg-1', pageName: 'Test Page' }],
    typeAttributeProfiles: { grooming: 'p-groom' },
    attributeProfiles: [{
      id: 'p-groom',
      productTypeId: 'grooming',
      attributes: [{ attributeId: 'species', cardinality: 'multiple', required: false, applicabilityConditions: [] }],
    }],
    universalAttributeIds: [],
  };
  return attachFrozenAuthorityDetails(base, {
    catalogFieldByTarget: { species: 'ProductField17' },
    attributeConfigByTarget: {
      species: {
        valueAliases: [
          { alias: 'dogs', mapsTo: 'Dog' },
          { alias: 'cats', mapsTo: 'Cat' },
        ],
        isClaim: false,
        isCompositionAttribute: opts.compositionSpecies === true,
        visualEvidenceEligibility: 'eligible',
      },
    },
  });
}

function makeNoulEntry(
  evidence: Array<{ source: string; snippet: string; attributeId?: string | null }>,
): QualificationGoldOnlyEntry {
  return {
    sku: 'FAKE:noul:species',
    familyId: 'family-fake-noul',
    split: 'dev',
    assortment: 'test',
    gold: {
      productType: { kind: 'known-type', typeId: 'grooming' },
      fieldAssignments: [],
      categoryPages: {
        pageIds: ['pg-1'],
        pageAssignments: [{ pageId: 'pg-1', pageName: 'Test Page' }],
        state: 'known',
        completeness: 'complete',
      },
    },
    evidence: evidence.map(ev => ({
      source: ev.source,
      snippet: ev.snippet,
      reliability: 'high' as const,
      attributeId: ev.attributeId ?? null,
    })),
  };
}

/**
 * HTTP-boundary mock answering every dispatched question deterministically:
 * Noul P(yes) from the label map, Choice picks the first non-abstention key
 * with a closed distribution (or an explicit type vote for the product-type
 * question). No credentials, no network, no DB.
 */
function stubNoulFetch(
  pyesByLabel: Record<string, number>,
  calls: { count: number },
  typeVote?: { key: 'no_match' | 'insufficient_evidence' | 'first'; prob: number },
): void {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    calls.count += 1;
    const body = JSON.parse(String((init as { body?: unknown } | undefined)?.body ?? '{}')) as {
      questions: Record<string, { type: string; criteria?: Record<string, string>; instructions?: string }>;
    };
    const answers: Record<string, unknown> = {};
    for (const [qid, q] of Object.entries(body.questions)) {
      if (q.type === 'noul') {
        const label = /value "([^"]+)"/.exec(q.instructions ?? '')?.[1] ?? '';
        answers[qid] = { type: 'noul', noul: pyesByLabel[label] ?? 0 };
      } else if (qid === 'primary_product_type' && typeVote && typeVote.key !== 'first') {
        const keys = Object.keys(q.criteria ?? {});
        const rest = keys.filter(k => k !== typeVote.key);
        const probabilities: Record<string, number> = { [typeVote.key]: typeVote.prob };
        for (const k of rest) probabilities[k] = (1 - typeVote.prob) / rest.length;
        answers[qid] = { type: 'choice', choice: typeVote.key, probabilities, confidence: 0.8 };
      } else {
        const keys = Object.keys(q.criteria ?? {});
        const eligible = keys.filter(k => k !== 'no_match' && k !== 'insufficient_evidence');
        const pick = eligible[0] ?? keys[0];
        const rest = keys.filter(k => k !== pick);
        const probabilities: Record<string, number> = { [pick]: 0.9 };
        for (const k of rest) probabilities[k] = 0.1 / rest.length;
        answers[qid] = { type: 'choice', choice: pick, probabilities, confidence: 0.85 };
      }
    }
    return new Response(
      JSON.stringify({ model: NOUL_MODEL, answers, usage: { input_tokens: 50, output_tokens: 10 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

/**
 * VERBATIM public V2 source clips (never paraphrased, never generated):
 * fourpaws 625ab eye-wipes pair + naturvet Aller-911 pair. Test fixtures use
 * these exact bytes; no fake invariant/authority payloads.
 */
const FOURPAWS_DUAL_EVIDENCE = [
  { source: 'official_product_page', snippet: 'Healthy Promise™ Cat & Dog Eye Wipes', attributeId: null },
  { source: 'official_product_page', snippet: 'these eye wipes for dogs and cats help eliminate tear & saliva stains, discoloration, and discharge.', attributeId: 'species' },
];

const NATURVET_DUAL_EVIDENCE = [
  { source: 'official_structured_catalog', snippet: 'Aller-911® Advanced Allergy Support Powder for Dogs and Cats', attributeId: null },
  { source: 'official_structured_catalog', snippet: 'Help your dog and cat fight allergies the easy way with Aller-911® Advanced Allergy Support Powder', attributeId: 'species' },
];

const FLAVOR_ONLY_EVIDENCE = [
  { source: 'official_product_page', snippet: 'Irresistible Chicken, Pork &amp; Salmon Flavor', attributeId: 'flavor' },
];

describe('candidate Noul permission/grounding (HTTP mocks, no live calls)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it.each([
    ['fourpaws eye-wipes pair', FOURPAWS_DUAL_EVIDENCE],
    ['naturvet Aller-911 pair', NATURVET_DUAL_EVIDENCE],
  ])('dual Dogs+Cats P(yes) resolves both with per-value proof + stable digest (%s)', async (_label, clips) => {
    const calls = { count: 0 };
    stubNoulFetch({ Dog: 0.9, Cat: 0.9 }, calls);
    const taxa = makeNoulTaxa();
    const entry = makeNoulEntry(clips);
    const first = await captureGuardedJevForTest(
      [entry],
      { jev: { apiKey: 'fixture-guard-key-1', model: NOUL_MODEL } },
      taxa,
    );
    expect(calls.count).toBeGreaterThan(0);
    const candidate = first.predictions[0].candidate;
    expect(candidate.source).toBe('live_captured');
    const species = candidate.fieldAssignments.find(f => f.targetId === 'species');
    expect(species?.outcome).toBe('predicted');
    expect(species?.values).toEqual(['Dog', 'Cat']);
    // Full 13-value actual P(yes) map: no third option passes, none renormalized.
    const expectedProbs: Record<string, number> = { Dog: 0.9, Cat: 0.9 };
    for (const option of REAL_SPECIES_OPTIONS) {
      if (!(option in expectedProbs)) expectedProbs[option] = 0;
    }
    expect(species?.candidateProbabilities).toEqual(expectedProbs);
    expect(species?.probabilityDigest).toMatch(/^[0-9a-f]{64}$/);
    const second = await captureGuardedJevForTest(
      [makeNoulEntry(clips)],
      { jev: { apiKey: 'fixture-guard-key-1', model: NOUL_MODEL } },
      taxa,
    );
    expect(second.predictions[0].candidate.fieldAssignments.find(f => f.targetId === 'species')?.probabilityDigest)
      .toBe(species?.probabilityDigest);
  });

  it('composition guard is not bypassed: no evidence stays unresolved, official evidence resolves', async () => {
    const calls = { count: 0 };
    stubNoulFetch({ Dog: 0.9, Cat: 0.9 }, calls);
    const taxa = makeNoulTaxa({ compositionSpecies: true });
    const empty = await captureGuardedJevForTest(
      [makeNoulEntry([])],
      { jev: { apiKey: 'fixture-guard-key-2', model: NOUL_MODEL } },
      taxa,
    );
    const blocked = empty.predictions[0].candidate.fieldAssignments.find(f => f.targetId === 'species');
    expect(blocked?.outcome).toBe('unresolved');
    expect(blocked?.values).toBeUndefined();
    expect(blocked?.abstentionCode).toBe('unsupported_claim');
    // Same claim attribute WITH canonical direct assertions resolves (guard intact, permission real).
    const supported = await captureGuardedJevForTest(
      [makeNoulEntry([
        { source: 'official_product_page', snippet: 'Dog', attributeId: 'species' },
        { source: 'official_structured_catalog', snippet: 'Cat', attributeId: 'species' },
      ])],
      { jev: { apiKey: 'fixture-guard-key-2', model: NOUL_MODEL } },
      taxa,
    );
    expect(supported.predictions[0].candidate.fieldAssignments.find(f => f.targetId === 'species')?.values)
      .toEqual(['Dog', 'Cat']);
  });

  it('unrelated-attribute clips never support the target', async () => {
    const calls = { count: 0 };
    stubNoulFetch({ Dog: 0.9, Cat: 0.9 }, calls);
    const taxa = makeNoulTaxa({ compositionSpecies: true });
    const entry = makeNoulEntry(FLAVOR_ONLY_EVIDENCE);
    const artifact = await captureGuardedJevForTest(
      [entry],
      { jev: { apiKey: 'fixture-guard-key-3', model: NOUL_MODEL } },
      taxa,
    );
    const species = artifact.predictions[0].candidate.fieldAssignments.find(f => f.targetId === 'species');
    expect(species?.outcome).toBe('unresolved');
    expect(species?.values).toBeUndefined();
  });

  it('single-value claim without direct grounding stays unresolved (production parity)', async () => {
    const calls = { count: 0 };
    stubNoulFetch({ Dog: 0.9, Cat: 0.9 }, calls);
    const base: QualificationTaxonomies = {
      productTypes: [{ id: 'grooming', label: 'Grooming', attributeProfileId: 'p-groom' }],
      attributeTargets: [{ targetId: 'species', cardinality: 'single', options: ['Dog', 'Cat'] }],
      pages: [],
      typeAttributeProfiles: { grooming: 'p-groom' },
      attributeProfiles: [{
        id: 'p-groom',
        productTypeId: 'grooming',
        attributes: [{ attributeId: 'species', cardinality: 'single', required: false, applicabilityConditions: [] }],
      }],
      universalAttributeIds: [],
    };
    const taxa = attachFrozenAuthorityDetails(base, {
      catalogFieldByTarget: { species: 'ProductField17' },
      attributeConfigByTarget: {
        species: {
          valueAliases: [],
          isClaim: true,
          isCompositionAttribute: false,
          visualEvidenceEligibility: 'eligible',
        },
      },
    });
    // Indirect-only grounding: the species clip names Dog but ships on a
    // non-direct source, so the claim guard must hold the Choice unresolved.
    const entry = makeNoulEntry([
      { source: 'third_party_page', snippet: 'Dog', attributeId: 'species' },
    ]);
    const artifact = await captureGuardedJevForTest(
      [entry],
      { jev: { apiKey: 'fixture-choice-claim', model: NOUL_MODEL } },
      taxa,
    );
    const species = artifact.predictions[0].candidate.fieldAssignments.find(f => f.targetId === 'species');
    expect(species?.outcome).toBe('unresolved');
    expect(species?.abstentionCode).toBe('unsupported_claim');
    expect(species?.value).toBeUndefined();
    // Same claim WITH a direct official clip resolves (guard intact, permission real).
    const supported = await captureGuardedJevForTest(
      [makeNoulEntry([
        { source: 'official_product_page', snippet: 'Dog', attributeId: 'species' },
      ])],
      { jev: { apiKey: 'fixture-choice-claim', model: NOUL_MODEL } },
      taxa,
    );
    expect(supported.predictions[0].candidate.fieldAssignments.find(f => f.targetId === 'species')?.value).toBe('Dog');
  });

  it('candidate dispatch partitions by target-permitted evidence state (no shared union)', async () => {
    const calls = { count: 0 };
    const seenStates: Array<{ productType: unknown; evidenceText: string }> = [];
    const outerFetch = globalThis.fetch;
    stubNoulFetch({ Dog: 0.9, Cat: 0.9 }, calls);
    const innerFetch = globalThis.fetch;
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String((init as { body?: unknown } | undefined)?.body ?? '{}')) as {
        state?: { productType?: unknown; evidenceText?: unknown };
      };
      if (typeof body.state?.evidenceText === 'string') {
        seenStates.push({ productType: body.state.productType, evidenceText: body.state.evidenceText });
      }
      return (innerFetch as typeof fetch)(url, init);
    }) as unknown as typeof fetch;
    const base: QualificationTaxonomies = {
      productTypes: [{ id: 'grooming', label: 'Grooming', attributeProfileId: 'p-groom' }],
      attributeTargets: [
        { targetId: 'species', cardinality: 'single', options: ['Dog', 'Cat'] },
        { targetId: 'flavor', cardinality: 'single', options: ['Chicken', 'Beef'] },
      ],
      pages: [],
      typeAttributeProfiles: { grooming: 'p-groom' },
      attributeProfiles: [{
        id: 'p-groom',
        productTypeId: 'grooming',
        attributes: [
          { attributeId: 'species', cardinality: 'single', required: false, applicabilityConditions: [] },
          { attributeId: 'flavor', cardinality: 'single', required: false, applicabilityConditions: [] },
        ],
      }],
      universalAttributeIds: [],
    };
    const taxa = attachFrozenAuthorityDetails(base, {
      catalogFieldByTarget: { species: 'ProductField17', flavor: 'ProductField18' },
      attributeConfigByTarget: {
        species: { valueAliases: [], isClaim: false, isCompositionAttribute: false, visualEvidenceEligibility: 'eligible' },
        flavor: { valueAliases: [], isClaim: false, isCompositionAttribute: false, visualEvidenceEligibility: 'eligible' },
      },
    });
    const entry = makeNoulEntry([
      { source: 'official_product_page', snippet: 'Dog', attributeId: 'species' },
      { source: 'official_product_page', snippet: 'Chicken', attributeId: 'flavor' },
    ]);
    // Pure partition proof (no credentials): per-target states never union.
    const questions = buildQualificationCandidateQuestionSet(entry, taxa, 'grooming');
    const groups = partitionCandidateQuestionsByPermittedEvidence(entry, questions, 'grooming');
    expect(groups.length).toBe(2);
    for (const group of groups) {
      expect(group.records.length).toBeGreaterThan(0);
      expect(group.targetIds.length).toBe(1);
      const [only] = group.targetIds;
      expect(group.state.evidenceText.toLowerCase()).toContain(only === 'species' ? 'dog' : 'chicken');
      expect(group.state.evidenceText.toLowerCase()).not.toContain(only === 'species' ? 'chicken' : 'dog');
    }
    // Live proof: the partitioned dispatch issues one state per group.
    try {
      await captureGuardedJevForTest(
        [entry],
        { jev: { apiKey: 'fixture-partition-key', model: NOUL_MODEL } },
        taxa,
      );
    } finally {
      globalThis.fetch = outerFetch;
    }
    expect(calls.count).toBeGreaterThan(1);
    const attributeStates = seenStates.filter(s => s.productType === 'grooming');
    expect(attributeStates.length).toBeGreaterThanOrEqual(2);
    for (const item of attributeStates) {
      const text = item.evidenceText.toLowerCase();
      expect(text.includes('dog') !== text.includes('chicken')).toBe(true);
    }
  });

  it('authority details ride the resolved target; stubs stay null/empty', () => {
    const taxa = makeNoulTaxa();
    const target = taxa.attributeTargets[0];
    const real = resolveQualificationAttributeTarget(target, taxa);
    expect(real.resolved.config.catalogField).toBe('ProductField17');
    expect(real.attribute.valueAliases).toContainEqual({ alias: 'dogs', mapsTo: 'Dog' });
    const bare: QualificationTaxonomies = {
      productTypes: [{ id: 'grooming', label: 'Grooming' }],
      attributeTargets: [{ targetId: 'species', cardinality: 'multiple', options: ['Dog'] }],
      pages: [],
    };
    const stubbed = resolveQualificationAttributeTarget(bare.attributeTargets[0], bare);
    expect(stubbed.resolved.config.catalogField).toBeNull();
    expect(stubbed.attribute.valueAliases).toEqual([]);
  });

  it('boundary converter normalizes sources without credibility boost; isolation holds', () => {
    const evidence = qualificationEvidenceForBoundary(
      makeNoulEntry(NATURVET_DUAL_EVIDENCE),
      'qual-test-run',
    );
    expect(evidence.find(e => (e.snippet ?? '').startsWith('Help your dog'))?.source).toBe('catalog_product');
    expect(evidence.find(e => (e.snippet ?? '').startsWith('Aller-911® Advanced'))?.source).toBe('catalog_product');
    expect(evidence.every(e => e.reliability === 'high')).toBe(true);
    const species = permittedEvidenceForQualificationTarget(evidence, { visualEvidenceEligibility: 'eligible' } as never, 'species');
    expect(species).toHaveLength(2);
    const visual = permittedEvidenceForQualificationTarget(
      [...evidence, { source: 'visual_product_evidence', snippet: 'v', attributeId: null } as never],
      { visualEvidenceEligibility: 'ineligible' } as never,
      'species',
    );
    expect(visual.some(e => e.source === 'visual_product_evidence')).toBe(false);
  });

  it('real bundle details carry the species catalog field + aliases (source-backed)', () => {
    const fsTaxonomy = JSON.parse(fs.readFileSync(REPRESENTATIVE_TAXONOMY_PATH, 'utf8')) as {
      bundle: Record<string, unknown>;
    };
    const details = extractFrozenAuthorityDetails(fsTaxonomy.bundle);
    expect(details.catalogFieldByTarget?.species).toBe('ProductField17');
    expect(details.attributeConfigByTarget?.species?.valueAliases).toContainEqual({ alias: 'dogs', mapsTo: 'Dog' });
    expect(details.attributeConfigByTarget?.species?.isClaim).toBe(false);
  });
});

describe('artifact identity domain (authority-bound, gold-free)', () => {
  it('binds the FULL canonical authority hash + versioned details hash', () => {
    const loaded = loadDevReplayInputs(DEV_INPUTS);
    expect(loaded.authorityDetails.authorityHash).toBe(DEV_AUTHORITY);
    const artifact = buildQualificationPredictionsFromCode(
      [loaded.goldEntries[0]],
      withFrozenAuthorityDetails(loaded.frozenSnapshot, loaded.authorityDetails),
    );
    expect(artifact.authorityHash).toBe(DEV_AUTHORITY);
    expect(artifact.authorityDetailsHash).toBe(frozenAuthorityDetailsHash(loaded.authorityDetails));
    expect(artifact.authorityDetailsHash).toMatch(/^[0-9a-f]{64}$/);
    const bare = buildQualificationPredictionsFromCode([loaded.goldEntries[0]], loaded.frozenSnapshot);
    expect(bare.authorityHash).toBeNull();
    expect(bare.authorityDetailsHash).toBeNull();
    expect(bare.artifactHash).not.toBe(artifact.artifactHash);
  });

  it('altered alias/claim/catalog permission changes the hash with identical predictions', () => {
    const loaded = loadDevReplayInputs(DEV_INPUTS);
    const entries = [loaded.goldEntries[0]];
    const base = buildQualificationPredictionsFromCode(
      entries,
      withFrozenAuthorityDetails(loaded.frozenSnapshot, loaded.authorityDetails),
    );
    const speciesFlags = loaded.authorityDetails.attributeConfigByTarget?.species;
    const variants: FrozenAuthorityDetails[] = [
      {
        ...loaded.authorityDetails,
        attributeConfigByTarget: {
          ...loaded.authorityDetails.attributeConfigByTarget,
          species: { ...speciesFlags!, valueAliases: [...speciesFlags!.valueAliases, { alias: 'doggo', mapsTo: 'Dog' }] },
        },
      },
      {
        ...loaded.authorityDetails,
        attributeConfigByTarget: {
          ...loaded.authorityDetails.attributeConfigByTarget,
          species: { ...speciesFlags!, isClaim: true },
        },
      },
      {
        ...loaded.authorityDetails,
        catalogFieldByTarget: { ...loaded.authorityDetails.catalogFieldByTarget, species: 'ProductField99' },
      },
    ];
    for (const details of variants) {
      const artifact = buildQualificationPredictionsFromCode(
        entries,
        withFrozenAuthorityDetails(loaded.frozenSnapshot, details),
      );
      expect(artifact.artifactHash).not.toBe(base.artifactHash);
      // Same semantic predictions (latencyMs is explicitly unhashed timing noise).
      const stripTiming = (predictions: typeof artifact.predictions) =>
        predictions.map(p => ({
          sku: p.sku,
          baseline: { ...p.baseline, latencyMs: 0 },
          candidate: { ...p.candidate, latencyMs: 0 },
        }));
      expect(stripTiming(artifact.predictions)).toEqual(stripTiming(base.predictions));
    }
  });

  it('changed gold labels alone leave the hash untouched (no gold leak)', () => {
    const loaded = loadDevReplayInputs(DEV_INPUTS);
    const snap = withFrozenAuthorityDetails(loaded.frozenSnapshot, loaded.authorityDetails);
    const base = buildQualificationPredictionsFromCode([loaded.goldEntries[0]], snap);
    const relabeled: QualificationGoldOnlyEntry = {
      ...loaded.goldEntries[0],
      gold: {
        ...loaded.goldEntries[0].gold,
        productType: { kind: 'known-type', typeId: 'changed-type-id' },
        fieldAssignments: [{ targetId: 'species', state: 'known', value: 'ChangedValue' }],
      },
    };
    const changed = buildQualificationPredictionsFromCode([relabeled], snap);
    expect(changed.artifactHash).toBe(base.artifactHash);
    expect(changed.sourceInputsHash).toBe(base.sourceInputsHash);
    const stripTiming = (predictions: typeof changed.predictions) =>
      predictions.map(p => ({
        sku: p.sku,
        baseline: { ...p.baseline, latencyMs: 0 },
        candidate: { ...p.candidate, latencyMs: 0 },
      }));
    expect(stripTiming(changed.predictions)).toEqual(stripTiming(base.predictions));
  });

  it('changed evidence changes the source-input commitment (finding 2)', () => {
    const loaded = loadDevReplayInputs(DEV_INPUTS);
    const snap = withFrozenAuthorityDetails(loaded.frozenSnapshot, loaded.authorityDetails);
    const base = buildQualificationPredictionsFromCode([loaded.goldEntries[0]], snap);
    const revised: QualificationGoldOnlyEntry = {
      ...loaded.goldEntries[0],
      evidence: [{ source: 'revised', snippet: 'changed evidence snippet', reliability: 'high', attributeId: null }],
    };
    const changed = buildQualificationPredictionsFromCode([revised], snap);
    expect(changed.sourceInputsHash).not.toBe(base.sourceInputsHash);
    expect(changed.sourceInputsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDevReplaySourceInputs([revised], loaded.frozenSnapshot, loaded.authorityDetails))
      .toBe(changed.sourceInputsHash!);
    expect(hashDevReplaySourceInputs(loaded.goldEntries.slice(0, 1), loaded.frozenSnapshot, loaded.authorityDetails))
      .toBe(base.sourceInputsHash!);
  });

  it('tampered predictions fail artifact integrity (finding 3)', () => {
    const loaded = loadDevReplayInputs(DEV_INPUTS);
    const snap = withFrozenAuthorityDetails(loaded.frozenSnapshot, loaded.authorityDetails);
    const artifact = buildQualificationPredictionsFromCode([loaded.goldEntries[0]], snap);
    expect(() => assertQualificationArtifactIntegrity(artifact, snap)).not.toThrow();
    const tampered = {
      ...artifact,
      predictions: artifact.predictions.map(prediction => ({
        ...prediction,
        candidate: { ...prediction.candidate, productType: 'tampered-type-id' },
      })),
    };
    expect(() => assertQualificationArtifactIntegrity(tampered, snap))
      .toThrow('artifact identity does not match its predictions');
  });
});

const V2_INPUTS = {
  manifestPath: 'docs/audits/jev-representative-v2/manifest.json',
  goldPath: 'docs/audits/jev-representative-v2/development-gold.json',
  taxonomyPath: 'docs/audits/jev-representative-v2/taxonomy.json',
};

describe('configured attribute meaning parity (actual V2 bundle)', () => {
  it('exact source name/definition/target-label survive into candidate questions (grooming + supplements)', () => {
    const loaded = loadDevReplayInputs(V2_INPUTS);
    expect(loaded.entryCount).toBe(27);
    expect(loaded.authorityDetails.attributeNameByTarget?.species).toBe('Animal Species');
    expect(loaded.authorityDetails.attributeDescriptionByTarget?.species).toBe('Target animal species.');
    expect(loaded.authorityDetails.targetLabelByTarget?.species).toBe('Animal Species');
    const taxa = qualificationTaxonomiesFromFrozenSnapshot(
      withFrozenAuthorityDetails(loaded.frozenSnapshot, loaded.authorityDetails),
    );
    for (const typeId of ['grooming', 'supplements']) {
      const entry = loaded.goldEntries.find(
        e => (e.gold.productType as { typeId: string | null }).typeId === typeId,
      );
      expect(entry).toBeDefined();
      const qs = buildQualificationCandidateQuestionSet(entry!, taxa, typeId);
      const species = qs.attributePlans.find(p => p.targetId === 'species');
      expect(species).toBeDefined();
      expect(species?.resolved.attribute?.name).toBe('Animal Species');
      expect(species?.resolved.attribute?.description).toBe('Target animal species.');
      expect(species?.resolved.config.label).toBe('Animal Species');
      expect(species?.resolved.config.catalogField).toBe('ProductField17');
      const texts = (species?.noulPlans ?? []).map(p => `${p.instructions} ${p.criteria.true ?? ''} ${p.criteria.false ?? ''}`);
      expect(texts.length).toBeGreaterThan(0);
      for (const text of texts) {
        expect(text).toContain('"Animal Species"');
        expect(text).not.toContain('"species"');
      }
    }
  });

  it('name/definition change alters identity; gold change does not', () => {
    const loaded = loadDevReplayInputs(V2_INPUTS);
    const entries = [loaded.goldEntries[0]];
    const snap = withFrozenAuthorityDetails(loaded.frozenSnapshot, loaded.authorityDetails);
    const base = buildQualificationPredictionsFromCode(entries, snap);
    const renamed: FrozenAuthorityDetails = {
      ...loaded.authorityDetails,
      attributeNameByTarget: { ...loaded.authorityDetails.attributeNameByTarget, species: 'Renamed Species' },
    };
    const redefined: FrozenAuthorityDetails = {
      ...loaded.authorityDetails,
      attributeDescriptionByTarget: { ...loaded.authorityDetails.attributeDescriptionByTarget, species: 'Changed definition.' },
    };
    const stripTiming = (predictions: typeof base.predictions) =>
      predictions.map(p => ({
        sku: p.sku,
        baseline: { ...p.baseline, latencyMs: 0 },
        candidate: { ...p.candidate, latencyMs: 0 },
      }));
    for (const details of [renamed, redefined]) {
      const artifact = buildQualificationPredictionsFromCode(entries, withFrozenAuthorityDetails(loaded.frozenSnapshot, details));
      expect(artifact.artifactHash).not.toBe(base.artifactHash);
      expect(stripTiming(artifact.predictions)).toEqual(stripTiming(base.predictions));
    }
    const relabeled: QualificationGoldOnlyEntry = {
      ...entries[0],
      gold: { ...entries[0].gold, productType: { kind: 'known-type', typeId: 'changed-type' } },
    };
    expect(buildQualificationPredictionsFromCode([relabeled], snap).artifactHash).toBe(base.artifactHash);
  });

  it('malformed name/definition/label sidecars fail closed', () => {
    const good = loadDevReplayInputs(V2_INPUTS).authorityDetails;
    const bad: FrozenAuthorityDetails[] = [
      { ...good, attributeNameByTarget: { species: '' } },
      { ...good, attributeDescriptionByTarget: { species: 42 as never } },
      { ...good, targetLabelByTarget: { '': 'Label' } },
    ];
    for (const details of bad) {
      expect(() => validateFrozenAuthorityDetails(details)).toThrow('frozen_authority_malformed');
      expect(() => withFrozenAuthorityDetails(loadDevReplayInputs(V2_INPUTS).frozenSnapshot, details)).toThrow();
    }
  });
});

describe('producer-domain authority + frozen containment (loader regressions)', () => {
  it('legitimate full sources v1 (25) and v2 (27) are accepted with recomputed authority', () => {
    const v1 = loadDevReplayInputs(DEV_INPUTS);
    expect(v1.entryCount).toBe(25);
    expect(v1.authorityHash).toBe(DEV_AUTHORITY);
    expect(v1.authorityDetails.authorityHash).toBe(DEV_AUTHORITY);
    const v2 = loadDevReplayInputs(V2_INPUTS);
    expect(v2.entryCount).toBe(27);
    expect(v2.authorityHash).toBe(V2_AUTHORITY);
  });

  it.each([
    ['guidance text', (t: { bundle: { guidance: unknown[] } }) => { t.bundle.guidance.push({ note: 'forged' }); }],
    ['attribute name', (t: { bundle: { attributes: Array<{ id: string; name: string }> } }) => {
      t.bundle.attributes.find(a => a.id === 'species')!.name = 'Forged Species';
    }],
    ['binding commit', (t: { binding: Record<string, unknown> }) => { t.binding.catalogGitCommit = '0'.repeat(40); }],
  ])('tampered %s with unchanged declared hash is rejected before conversion', async (_label, tamper) => {
    const dir = makeReplayDir('tamper');
    for (const file of ['manifest.json', 'development-gold.json', 'taxonomy.json'] as const) {
      await Bun.write(`${dir}/${file}`, await Bun.file(`${REPRESENTATIVE_V1_DIR}/${file}`).text());
    }
    const taxonomyPath = `${dir}/taxonomy.json`;
    const raw = JSON.parse(await Bun.file(taxonomyPath).text()) as {
      bundle: { guidance: unknown[]; attributes: Array<{ id: string; name: string }> };
      binding: Record<string, unknown>;
    };
    (tamper as (t: typeof raw) => void)(raw);
    await Bun.write(taxonomyPath, JSON.stringify(raw));
    expect(() => loadTrio({ manifest: `${dir}/manifest.json`, gold: `${dir}/development-gold.json`, taxonomy: taxonomyPath }))
      .toThrow('authority_hash_drift');
  });

  it('minimal consistent trio loads (positive control)', async () => {
    const trio = await writeFakeTrio(makeReplayDir('control'));
    const loaded = loadTrio(trio);
    expect(loaded.entryCount).toBe(1);
    expect(loaded.authorityDetails.authorityHash).toBe(trio.authority);
  });

  it.each([
    ['unknown known-type', { productType: { kind: 'known-type', typeId: 'caged-bird-toys' } }, 'type'],
    ['unknown target', { fieldAssignments: [{ targetId: 'nope-target', state: 'known', value: 'Dog' }] }, 'target'],
    ['unknown value', { fieldAssignments: [{ targetId: 'species', state: 'known', value: 'Dragon' }] }, 'value'],
    ['unknown page', { categoryPages: { state: 'known', completeness: 'complete', pageIds: ['pg-nope'], pageAssignments: [] } }, 'page'],
  ])('gold outside the frozen pool is rejected before any dispatch (%s)', async (_label, goldPatch, _kind) => {
    const dir = makeReplayDir('contained');
    const entry = { ...minimalValidGoldEntry(), gold: { ...minimalValidGoldEntry().gold, ...(goldPatch as object) } };
    const trio = await writeFakeTrio(dir, { goldEntries: [entry] });
    expect(() => loadTrio(trio)).toThrow('Gold outside frozen taxonomy');
  });
});

const V1_SNAPSHOT_HASH = '7df8da0059ec8bf0e8365722d9910a5cd3d51efcc16cb7e98fc9208e72369553';
const V2_SNAPSHOT_HASH = 'd74ca8cdc9963d90aca87aa65e5b827ecc8782df49cb2b3f3c5236ffa22fa3fb';

describe('configured type-definition fidelity (v8 grooming/insect-control)', () => {
  it('legacy v1/v2 (absent/null descriptions) keep stable snapshot hashes', () => {
    expect(loadDevReplayInputs(DEV_INPUTS).frozenSnapshot.snapshotHash).toBe(V1_SNAPSHOT_HASH);
    expect(loadDevReplayInputs(V2_INPUTS).frozenSnapshot.snapshotHash).toBe(V2_SNAPSHOT_HASH);
  });

  it('non-string bundle descriptions fail closed (never silently omitted)', async () => {
    const dir = makeReplayDir('baddesc');
    const taxonomy = minimalFakeTaxonomy();
    (taxonomy.bundle as { productTypes: Array<Record<string, unknown>> }).productTypes[0].description = 42;
    const trio = await writeFakeTrio(dir, { taxonomy: taxonomy as never });
    expect(() => loadTrio(trio)).toThrow('incomplete_authority');
  });

  it('string bundle definitions pass straight into the validated snapshot', async () => {
    const dir = makeReplayDir('v8desc');
    const taxonomy = minimalFakeTaxonomy();
    const bundle = taxonomy.bundle as {
      productTypes: Array<Record<string, unknown>>;
    };
    bundle.productTypes[0].description = 'Real grooming definition.';
    const trio = await writeFakeTrio(dir, { taxonomy: taxonomy as never });
    const loaded = loadTrio(trio);
    const grooming = loaded.frozenSnapshot.productTypes.find(p => p.id === 'grooming');
    expect((grooming as unknown as { description?: unknown }).description).toBe('Real grooming definition.');
    expect(loaded.frozenSnapshot.snapshotHash).not.toBe(V1_SNAPSHOT_HASH);
  });

  it('reconstructed definitions reach model-visible question criteria; identity follows meaning', () => {
    const loaded = loadDevReplayInputs(V2_INPUTS);
    const described = {
      ...loaded.frozenSnapshot,
      productTypes: loaded.frozenSnapshot.productTypes.map(p =>
        p.id === 'grooming' ? { ...p, description: 'Real grooming definition.' } : p,
      ),
    } as unknown as Parameters<typeof qualificationTaxonomiesFromFrozenSnapshot>[0];
    const taxa = qualificationTaxonomiesFromFrozenSnapshot(described);
    const grooming = taxa.productTypes.find(p => p.id === 'grooming');
    expect(grooming?.description).toBe('Real grooming definition.');
    const plain = qualificationTaxonomiesFromFrozenSnapshot(loaded.frozenSnapshot);
    expect(plain.productTypes.find(p => p.id === 'grooming')?.description).toBeUndefined();
    const entry = loaded.goldEntries.find(e => e.gold.productType.typeId === 'grooming')!;
    const withDef = buildQualificationCandidateQuestionSet(entry, taxa, 'grooming');
    const withoutDef = buildQualificationCandidateQuestionSet(entry, plain, 'grooming');
    const withText = Object.values(withDef.productTypePlan.criteria).join(' ');
    const withoutText = Object.values(withoutDef.productTypePlan.criteria).join(' ');
    expect(withText).toContain('Grooming: Real grooming definition.');
    expect(withoutText).not.toContain('Real grooming definition.');
    // Identity: meaning change alters the artifact; gold relabel does not.
    const a = buildQualificationPredictionsFromCode([entry], described);
    const b = buildQualificationPredictionsFromCode([entry], loaded.frozenSnapshot);
    expect(a.artifactHash).not.toBe(b.artifactHash);
    const relabeled = { ...entry, gold: { ...entry.gold, productType: { kind: 'known-type' as const, typeId: 'changed' } } };
    expect(buildQualificationPredictionsFromCode([relabeled], described).artifactHash).toBe(a.artifactHash);
  });

  it('malformed snapshot-side definitions fail closed', () => {
    const loaded = loadDevReplayInputs(V2_INPUTS);
    const malformed = {
      ...loaded.frozenSnapshot,
      productTypes: loaded.frozenSnapshot.productTypes.map(p =>
        p.id === 'grooming' ? { ...p, description: 42 } : p,
      ),
    } as unknown as Parameters<typeof qualificationTaxonomiesFromFrozenSnapshot>[0];
    expect(() => qualificationTaxonomiesFromFrozenSnapshot(malformed)).toThrow('malformed non-string description');
  });
});

describe('candidate product-type probability persistence (HTTP mocks, no live calls)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function captureTypeVote(
    key: 'no_match' | 'insufficient_evidence' | 'first',
    prob: number,
    apiKey = 'fixture-type-key',
  ) {
    const calls = { count: 0 };
    stubNoulFetch({ Dog: 0.9, Cat: 0.9 }, calls, { key, prob });
    const artifact = await captureGuardedJevForTest(
      [makeNoulEntry(FOURPAWS_DUAL_EVIDENCE)],
      { jev: { apiKey, model: NOUL_MODEL } },
      makeNoulTaxa(),
    );
    return { artifact, candidate: artifact.predictions[0].candidate, calls };
  }

  it.each([
    ['no_fit', 'no_match' as const, 0.82],
    ['insufficient evidence', 'insufficient_evidence' as const, 0.76],
  ])('semantic abstention persists its REAL selected P (%s)', async (_label, key, prob) => {
    const { candidate } = await captureTypeVote(key, prob);
    expect(candidate.source).toBe('live_captured');
    expect(candidate.abstained).toBe(true);
    expect(candidate.abstentionCode).toBe(key);
    expect(candidate.typeProbability).toBe(prob);
    // Legacy floor placeholder stays untouched: confidence 0, real P separate.
    expect(candidate.confidence).toBe(0);
    // Full canonical Choice set retained (literals + the single option).
    expect(candidate.typeCandidateProbabilities?.[key]).toBe(prob);
    expect(candidate.typeCandidateProbabilities?.grooming).toBeCloseTo((1 - prob) / 2, 10);
    expect(Object.keys(candidate.typeCandidateProbabilities ?? {}).length).toBe(3);
    expect(candidate.typeProbabilityDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('same code with different Pyes hashes differently (honest identity change)', async () => {
    const high = await captureTypeVote('no_match', 0.82, 'fixture-type-key-a');
    const low = await captureTypeVote('no_match', 0.6, 'fixture-type-key-b');
    expect(low.candidate.abstentionCode).toBe('no_match');
    expect(low.candidate.typeProbability).toBe(0.6);
    expect(high.artifact.artifactHash).not.toBe(low.artifact.artifactHash);
    expect(high.candidate.typeProbabilityDigest).not.toBe(low.candidate.typeProbabilityDigest);
  });

  it('service failure acquires no semantic probability credit', async () => {
    globalThis.fetch = (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const artifact = await captureGuardedJevForTest(
      [makeNoulEntry(FOURPAWS_DUAL_EVIDENCE)],
      { jev: { apiKey: 'fixture-type-key-c', model: NOUL_MODEL } },
      makeNoulTaxa(),
    );
    const candidate = artifact.predictions[0].candidate;
    expect(candidate.source).toBe('blocked');
    expect(candidate.typeProbability ?? null).toBeNull();
    expect(candidate.typeCandidateProbabilities ?? null).toBeNull();
    expect(candidate.typeProbabilityDigest ?? null).toBeNull();
  });
});
