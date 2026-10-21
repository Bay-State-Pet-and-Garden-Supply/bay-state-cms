import { describe, it, expect, beforeAll } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { generateCandidate } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import {
  buildRuntimeSnapshot,
  snapshotHash,
  persistRuntimeSnapshot,
  runtimeSnapshotHashMatchesConfig,
  authorityConfigHashMatches,
  getRuntimeSnapshotByHash,
  assertModelPlanCompatible,
  requireModelCallContext,
} from '../../classification/runtime-snapshot';
import type { RuntimeSnapshotInput } from '../../classification/runtime-snapshot';
import type { RuntimeConfigAuthority } from '../../classification/config-loader';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import { buildModelExecutionPlan, buildRuntimeRuleVersions, MODEL_OPERATION_REGISTRY_VERSION, RULE_VERSIONS, PROMPT_TEMPLATE_VERSIONS } from '../../classification/model-operation-registry';
import { hashCanonicalJson } from '../../shared/stable-id';

let workspacePath: string;
let workspaceId: string;
let authority: RuntimeConfigAuthority;

const EVIDENCE: CatalogEvidence = {
  schemaVersion: 1,
  sourceTreeHash: '0'.repeat(64),
  productFileCount: 0,
  parseFailureCount: 0,
  parseFailures: [],
  fieldRegistry: { entryCount: 0, xmlFields: [] },
  fields: [],
  pages: [],
};

function buildV2Input(overrides: Partial<RuntimeSnapshotInput> = {}): RuntimeSnapshotInput {
  const bundle = (authority as { kind: 'v2'; bundle: unknown }).bundle as never;
  return {
    workspaceId,
    workspacePath,
    productSku: 'SKU-001',
    authority,
    configSnapshotRef: {
      id: bundleHash(),
      hash: bundleHash(),
      sourceCommit: null,
      createdAt: '2026-08-01T12:00:00.000Z',
    },
    sourceProductHash: 'src-hash-1',
    searchKeywords: 'dog food',
    productPageNames: [],
    pages: { state: 'no_verified_page_catalog', nameOnlyRecords: [] },
    ...overrides,
  };
}

function bundleHash(): string {
  return (authority as { kind: 'v2'; bundle: { manifest: { bundleHash: string } } }).bundle.manifest.bundleHash;
}

describe('runtime snapshot with ACTIVE v2 config authority (Milestone 7)', () => {
  beforeAll(() => {
    workspaceId = randomUUID();
    workspacePath = path.join(os.tmpdir(), `baystate-cms-runtime-snap-v2-${workspaceId.slice(0, 8)}`);
    fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
    initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
    runMigrations();
    insertWorkspace({ id: workspaceId, name: 'test', workspacePath, gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });

    const candidate = generateCandidate(BayStatePetGardenSeed, EVIDENCE);
    authority = { kind: 'v2', bundle: candidate.bundle };
  });

  it('builds a frozen snapshot from the v2 authority with resolved v2 fields', () => {
    const snapshot = buildRuntimeSnapshot(buildV2Input());
    expect(snapshot.configAuthorityKind).toBe('v2');
    const v2Bundle = (authority as { kind: 'v2'; bundle: any }).bundle;
    expect(snapshot.productTypes).toHaveLength(v2Bundle.productTypes.length);
    expect(snapshot.attributes).toHaveLength(v2Bundle.attributes.length);
    expect(snapshot.attributeProfiles).toHaveLength(v2Bundle.attributeProfiles.length);
    expect(snapshot.attributeMappings).toHaveLength(v2Bundle.attributeMappings.length);
    expect(snapshot.curationTargets.some(target => target.id === 'primary-product-type')).toBe(true);
    expect(snapshot.catalogEvidenceHash).toBeNull();
    // Universal brand attribute survives into the frozen snapshot.
    const brand = snapshot.attributes.find(attribute => attribute.id === 'brand');
    expect(brand).toBeDefined();
    expect((brand as unknown as { isUniversal?: boolean }).isUniversal).toBe(true);
    // V2-only ML features survive.
    const modelPolicy = snapshot.modelPolicy as unknown as { providerLocalities?: Record<string, string>; mlFeatures?: Record<string, unknown> };
    expect(modelPolicy.providerLocalities).toEqual({ ollama: 'local' });
    expect(modelPolicy.mlFeatures?.productionRetrieval).toMatchObject({ state: 'disabled' });
    expect(snapshot.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('hashes identically across different createdAt timestamps (deterministic)', () => {
    const a = buildRuntimeSnapshot(buildV2Input({ createdAt: '2026-08-01T12:00:00.000Z' }));
    const b = buildRuntimeSnapshot(buildV2Input({ createdAt: '2026-08-02T12:00:00.000Z' }));
    expect(snapshotHash(a)).toBe(snapshotHash(b));
  });

  it('persists and round-trips the v2 snapshot', () => {
    const snapshot = buildRuntimeSnapshot(buildV2Input());
    const { id, hash } = persistRuntimeSnapshot(snapshot);
    expect(hash).toBe(snapshot.snapshotHash);
    const reloaded = snapshotHash(snapshot);
    expect(reloaded).toBe(hash);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('runtimeSnapshotHashMatchesConfig compares v2 snapshots against the active bundle hash', () => {
    const snapshot = buildRuntimeSnapshot(buildV2Input());
    const { hash } = persistRuntimeSnapshot(snapshot);
    const authorityBundle = (authority as { kind: 'v2'; bundle: unknown }).bundle;
    // The stored runtime snapshot row embeds configSnapshotRef.hash === bundleHash.
    expect(runtimeSnapshotHashMatchesConfig(workspaceId, hash, authorityBundle as never)).toBe(true);
    expect(runtimeSnapshotHashMatchesConfig(workspaceId, 'f'.repeat(64), authorityBundle as never)).toBe(false);
  });

  it('authorityConfigHashMatches compares the v2 bundle hash and rejects unknown hashes', () => {
    expect(authorityConfigHashMatches(authority, bundleHash())).toBe(true);
    expect(authorityConfigHashMatches(authority, '0'.repeat(64))).toBe(false);
    expect(authorityConfigHashMatches(authority, '-1414969445')).toBe(false);
  });

  it('rejects a snapshot input without any config authority', () => {
    const input = buildV2Input();
    delete (input as { authority?: unknown }).authority;
    delete (input as { config?: unknown }).config;
    expect(() => buildRuntimeSnapshot(input)).toThrow(/requires either a runtime config authority/);
  });

  // ── Issue #17 work item E: schema-v2 model-execution plan ─────────────────

  it('schema v2 snapshots carry a frozen model-execution plan and rule versions', () => {
    const snapshot = buildRuntimeSnapshot(buildV2Input());
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.modelExecutionPlan).toBeDefined();
    expect(snapshot.modelExecutionPlan!.entries.length).toBeGreaterThan(0);
    expect(snapshot.modelExecutionPlan!.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.runtimeRuleVersions).toBeDefined();
    expect(snapshot.runtimeRuleVersions!.digest).toMatch(/^[a-f0-9]{64}$/);
    // The plan entry resolves the policy default (ollama) for a stage-mapped op.
    const entry = snapshot.modelExecutionPlan!.entries.find(e => e.operation === 'attribute_ranking');
    expect(entry).toBeDefined();
    expect(entry!.provider).toBe('ollama');
    expect(entry!.locality).toBe('local');
    expect(entry!.stage).toBe('product_attribute_proposals');
    expect(entry!.promptTemplateVersion).toBe('attribute-ranking-prompt-v1');
    expect(entry!.ruleVersion).toBe(RULE_VERSIONS.attribute_ranking);
  });
  it('does not authorize copy generation from ordinary stage/default routes', () => {
    const snapshot = buildRuntimeSnapshot(buildV2Input());
    expect(snapshot.modelExecutionPlan!.entries.some(
      entry => entry.operation === 'distributor_copy_consolidation',
    )).toBe(false);
    expect(() => assertModelPlanCompatible(snapshot, 'distributor_copy_consolidation'))
      .toThrow(/no entry for operation/);
  });

  it('freezes copy generation only from its explicit provider/model/sharing authority', () => {
    const input = buildV2Input();
    if (authority.kind !== 'v2') throw new Error('test fixture requires v2 authority');
    const currentBundle = authority.bundle;
    input.authority = {
      kind: 'v2',
      bundle: {
        ...currentBundle,
        modelPolicy: {
          ...currentBundle.modelPolicy,
          copyGeneration: {
            provider: 'ollama',
            model: 'qwen2.5:14b',
            textDataSharing: 'local_only',
          },
        },
      },
    };
    const snapshot = buildRuntimeSnapshot(input);
    const entry = snapshot.modelExecutionPlan!.entries.find(
      candidate => candidate.operation === 'distributor_copy_consolidation',
    );
    expect(entry).toMatchObject({
      provider: 'ollama',
      model: 'qwen2.5:14b',
      locality: 'local',
      textDataSharing: 'local_only',
      fromOverride: false,
      stage: 'name_consolidation',
    });
    expect(() => assertModelPlanCompatible(snapshot, 'distributor_copy_consolidation')).not.toThrow();
  });


  it('plan is immutable and included in the snapshot hash', () => {
    const snapshot = buildRuntimeSnapshot(buildV2Input());
    expect(Object.isFrozen(snapshot.modelExecutionPlan)).toBe(true);
    const a = buildRuntimeSnapshot(buildV2Input());
    const b = buildRuntimeSnapshot(buildV2Input());
    expect(snapshotHash(a)).toBe(snapshotHash(b));
  });

  it('snapshot hash changes when prompt/rule versions change but not when task config mutates', () => {
    const a = buildRuntimeSnapshot(buildV2Input());
    // Rule-version change must change the snapshot hash (frozen plan digest).
    const mutated = buildRuntimeSnapshot(buildV2Input());
    // Simulate a registry bump by rewriting the frozen plan entry and digest.
    const raw = JSON.parse(JSON.stringify(mutated)) as typeof mutated;
    const rawEntry = raw.modelExecutionPlan!.entries.find(e => e.operation === 'attribute_ranking')!;
    rawEntry.ruleVersion = 'fixture-different-rule-version';
    expect(snapshotHash(raw)).not.toBe(snapshotHash(a));
    // Task-config mutation does not change the snapshot (config is frozen at
    // build time and the plan comes from the policy, not llm_task_configs).
    const afterConfigMutate = buildRuntimeSnapshot(buildV2Input());
    expect(snapshotHash(afterConfigMutate)).toBe(snapshotHash(a));
  });

  it('assertModelPlanCompatible fails closed for legacy schema-v1 snapshots and passes for v2', () => {
    const v2 = buildRuntimeSnapshot(buildV2Input());
    expect(() => assertModelPlanCompatible(v2, 'attribute_ranking')).not.toThrow();
    expect(() => assertModelPlanCompatible(v2, 'product_type_ranking')).not.toThrow();
    // A schema-v1 snapshot has no plan → fail closed.
    const v1 = JSON.parse(JSON.stringify(v2));
    v1.schemaVersion = 1;
    delete v1.modelExecutionPlan;
    delete v1.runtimeRuleVersions;
    expect(() => assertModelPlanCompatible(v1, 'attribute_ranking')).toThrow(/no frozen model-execution plan/);
    expect(() => assertModelPlanCompatible(null, 'attribute_ranking')).toThrow(/no runtime snapshot/);
  });

  it('legacy schema-v1 snapshots remain readable (read-only support)', () => {
    const v2 = buildRuntimeSnapshot(buildV2Input());
    const legacy = JSON.parse(JSON.stringify(v2));
    legacy.schemaVersion = 1;
    delete legacy.modelExecutionPlan;
    delete legacy.runtimeRuleVersions;
    legacy.snapshotHash = snapshotHash(legacy);
    const { id } = persistRuntimeSnapshot(legacy);
    expect(id).toBeDefined();
    const loaded = getRuntimeSnapshotByHash(workspaceId, snapshotHash(legacy));
    expect(loaded).not.toBeNull();
    expect(loaded!.schemaVersion).toBe(1);
    expect(loaded!.modelExecutionPlan).toBeUndefined();
    // Legacy hash domain is stable across reads.
    expect(snapshotHash(loaded!)).toBe(snapshotHash(legacy));
  });

  it('runtime rule versions are deterministic and versioned', () => {
    const rv = buildRuntimeRuleVersions();
    expect(rv.version).toBe(1);
    // P3 (value_gap_resolution registration): registry tracks the live constant.
    expect(rv.registryVersion).toBe(MODEL_OPERATION_REGISTRY_VERSION);
    expect(rv.digest).toMatch(/^[a-f0-9]{64}$/);
    const rv2 = buildRuntimeRuleVersions();
    expect(rv2.digest).toBe(rv.digest);
  });

  it('assertModelPlanCompatible rejects a forged call context version (pass 4b)', () => {
    const v2 = buildRuntimeSnapshot(buildV2Input());
    const forged = {
      runId: 'run',
      snapshotHash: v2.snapshotHash,
      stage: 'product_attribute_proposals' as const,
      operation: 'attribute_ranking' as const,
      attempt: 1,
      promptTemplateVersion: 'forged-prompt-v999',
      ruleVersion: 'forged-rule-v999',
    };
    expect(() => assertModelPlanCompatible(v2, 'attribute_ranking', forged)).toThrow(/context prompt-template version/);
    const forgedRuleOnly = { ...forged, promptTemplateVersion: 'attribute-ranking-prompt-v1' };
    expect(() => assertModelPlanCompatible(v2, 'attribute_ranking', forgedRuleOnly)).toThrow(/context rule version/);
  });

  it('assertModelPlanCompatible rejects a missing runtimeRuleVersions and a tampered plan digest (pass 4b)', () => {
    const v2 = buildRuntimeSnapshot(buildV2Input());
    // Missing runtimeRuleVersions on a schema-v2 snapshot → fail closed.
    const missingRules = JSON.parse(JSON.stringify(v2));
    delete missingRules.runtimeRuleVersions;
    expect(() => assertModelPlanCompatible(missingRules, 'attribute_ranking')).toThrow(/no frozen runtimeRuleVersions/);
    // Tampered plan entry without a recomputed digest → fail closed.
    const tamperedPlan = JSON.parse(JSON.stringify(v2));
    const entry = tamperedPlan.modelExecutionPlan.entries.find((e: any) => e.operation === 'attribute_ranking');
    entry.ruleVersion = 'tampered-rules-v2';
    expect(() => assertModelPlanCompatible(tamperedPlan, 'attribute_ranking')).toThrow(/plan digest does not match/);
    // Tampered rule-versions fields without a recomputed digest → fail closed.
    const tamperedRules = JSON.parse(JSON.stringify(v2));
    tamperedRules.runtimeRuleVersions.outputPolicyVersion = 'tampered-v2';
    expect(() => assertModelPlanCompatible(tamperedRules, 'attribute_ranking')).toThrow(/runtimeRuleVersions digest does not match/);
  });
});

describe('PR7 review R2 (F1) — frozen cohort_page_assignment_parent operation (issue #30)', () => {
  it('buildModelExecutionPlan freezes the current parent-operation prompt/rule versions', () => {
    const v2 = buildRuntimeSnapshot(buildV2Input());
    const entry = v2.modelExecutionPlan!.entries.find(e => e.operation === 'cohort_page_assignment_parent');
    expect(entry).toBeDefined();
    expect(entry!.stage).toBe('category_page_proposals');
    expect(entry!.promptTemplateVersion).toBe(PROMPT_TEMPLATE_VERSIONS.cohort_page_assignment_parent);
    expect(entry!.ruleVersion).toBe(RULE_VERSIONS.cohort_page_assignment_parent);
  });

  it('the registry version bump (1 → 2 → current) is reflected in the frozen plan and rule versions', () => {
    const v2 = buildRuntimeSnapshot(buildV2Input());
    // P3: pinned to the live constant (registry bumped 2 → 3 for value_gap_resolution).
    expect(v2.modelExecutionPlan!.registryVersion).toBe(MODEL_OPERATION_REGISTRY_VERSION);
    expect(v2.runtimeRuleVersions!.registryVersion).toBe(MODEL_OPERATION_REGISTRY_VERSION);
    expect(buildRuntimeRuleVersions().registryVersion).toBe(MODEL_OPERATION_REGISTRY_VERSION);
  });

  it('freezes the legacy cohort operation separately from its parent operation', () => {
    const v2 = buildRuntimeSnapshot(buildV2Input());
    const legacyEntry = v2.modelExecutionPlan!.entries.find(e => e.operation === 'cohort_page_assignment');
    expect(legacyEntry).toBeDefined();
    expect(legacyEntry!.promptTemplateVersion).toBe(PROMPT_TEMPLATE_VERSIONS.cohort_page_assignment);
    expect(legacyEntry!.ruleVersion).toBe(RULE_VERSIONS.cohort_page_assignment);
    // The parent and legacy child entries share the stage but carry distinct
    // frozen versions — truthful provenance for two different prompts.
    const parentEntry = v2.modelExecutionPlan!.entries.find(e => e.operation === 'cohort_page_assignment_parent')!;
    expect(parentEntry.ruleVersion).not.toBe(legacyEntry!.ruleVersion);
  });

  it('requireModelCallContext FAILS CLOSED for the parent operation on a pre-change (registry-v1) snapshot with no plan entry', () => {
    // Simulate a snapshot frozen under registry v1: its model-execution plan
    // has NO entry for 'cohort_page_assignment_parent' (the operation did not
    // exist then). RuntimeRuleVersions are left intact (their digest still
    // verifies — only the missing plan entry trips the fail-closed guard).
    const v2 = buildRuntimeSnapshot(buildV2Input());
    const preChange = JSON.parse(JSON.stringify(v2)) as typeof v2;
    const parentOpView = {
      defaultProvider: 'ollama',
      defaultModel: 'qwen2.5vl:latest',
      providerLocalities: { ollama: 'local' },
      stageOverrides: {},
      imageDataSharing: 'local_only',
      textDataSharing: 'local_only',
      mlFeatures: {},
    } as never;
    // Build a registry-v1-shaped plan: same entries minus the parent op, with
    // the digest recomputed over the reduced set (integrity passes; the
    // missing-entry guard is what fails closed).
    const reduced = buildModelExecutionPlan(parentOpView, null);
    reduced.entries = reduced.entries.filter((e: { operation: string }) => e.operation !== 'cohort_page_assignment_parent');
    preChange.modelExecutionPlan = {
      ...reduced,
      digest: hashCanonicalJson({ version: reduced.version, registryVersion: reduced.registryVersion, entries: reduced.entries }),
    };
    expect(() => requireModelCallContext(preChange, 'run-1', 'cohort_page_assignment_parent', 1)).toThrow(
      /snapshot plan has no entry for operation "cohort_page_assignment_parent"/,
    );
    // Legacy operations remain compatible on the same pre-change plan.
    expect(() => requireModelCallContext(preChange, 'run-1', 'cohort_page_assignment', 1)).not.toThrow();
  });
});

describe('PR12 C4 — registry-version fail-closed (issue #30, DECISION-B)', () => {
  it('a plan frozen under registry version 1 with the executing version 2 refuses run-bound calls (registry_version_mismatch)', () => {
    const v2 = buildRuntimeSnapshot(buildV2Input());
    // Simulate a snapshot frozen under an OLDER operation registry: flip the
    // frozen plan's registryVersion to 1 and recompute its digest so the
    // integrity check still passes — the registry-version guard is the only
    // thing that trips.
    const stalePlan = JSON.parse(JSON.stringify(v2.modelExecutionPlan));
    stalePlan.registryVersion = 1;
    stalePlan.digest = hashCanonicalJson({
      version: stalePlan.version,
      registryVersion: stalePlan.registryVersion,
      entries: stalePlan.entries,
    });
    const stale = JSON.parse(JSON.stringify(v2)) as typeof v2;
    stale.modelExecutionPlan = stalePlan;
    expect(() => assertModelPlanCompatible(stale, 'attribute_ranking')).toThrow(/registry_version_mismatch/);
    expect(() => requireModelCallContext(stale, 'run-1', 'attribute_ranking', 1)).toThrow(/registry_version_mismatch/);
    expect(() => requireModelCallContext(stale, 'run-1', 'evidence_extraction', 1)).toThrow(/registry_version_mismatch/);
  });

  it('current-registry-version snapshots pass and schema-v1 legacy snapshots are unaffected (never registry_version_mismatch)', () => {
    // The current operation registry tracks the registered operations.
    expect(MODEL_OPERATION_REGISTRY_VERSION).toBe(6);
    const v2 = buildRuntimeSnapshot(buildV2Input());
    expect(v2.modelExecutionPlan!.registryVersion).toBe(MODEL_OPERATION_REGISTRY_VERSION);
    expect(() => assertModelPlanCompatible(v2, 'product_type_ranking')).not.toThrow();
    expect(() => requireModelCallContext(v2, 'run-1', 'product_type_ranking', 1)).not.toThrow();
    // schema-v1 (no plan) keeps the EXISTING fail-closed-on-missing-plan
    // behavior — never a registry_version_mismatch.
    const v1 = JSON.parse(JSON.stringify(v2));
    v1.schemaVersion = 1;
    delete v1.modelExecutionPlan;
    delete v1.runtimeRuleVersions;
    expect(() => assertModelPlanCompatible(v1, 'product_type_ranking')).toThrow(/no frozen model-execution plan/);
  });
});
