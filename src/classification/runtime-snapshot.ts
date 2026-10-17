/**
 * Immutable Runtime Snapshot
 *
 * A classification run consumes exactly one deeply frozen, persisted runtime
 * snapshot. The snapshot resolves everything a stage may read — validated
 * configuration, focused-file hashes, catalog evidence hash, product types,
 * attributes, profiles, mappings, guidance, model/data policies, pre-resolved
 * field options, reviewed facts, page state, and the source product/evidence
 * hash — once, before the run is created.
 *
 * Stages MUST consume the snapshot through `context.snapshot` instead of
 * reloading workspace configuration files or querying mutable caches, so that
 * mutating config, cache, Page rows, or model settings during a run cannot
 * change stage output.
 */
import { randomUUID } from 'node:crypto';
import { canonicalJsonStringify, hashCanonicalJson } from '../shared/stable-id';
import { getDb } from '../db/connection';
import type {
  ClassificationConfig,
  ClassificationConfigSnapshotRef,
  CurationTargetConfig,
  ClassificationConfigBundleV2,
  CanonicalClassificationOutputBindingV2,
  ProductTypeConfigV2,
} from '../shared/schemas/classification';
import type { RuntimeConfigAuthority } from './config-loader';
import type { ResolvedTargetOption } from './curation-target-resolver';
import { getExplicitCurationTargets, resolveAttributeAllowedValues } from './curation-targets';
import { configHashMatches } from '../db/repositories/classification-config-repo';
import {
  collectReviewedFacts,
  normalizeAbsentHash,
  type ReviewedFact,
} from './reviewed-facts';
import { buildModelPolicyView } from './model-policy-gateway';
import { getVlmConfig } from '../onboarding/vlm-client';
import {
  buildModelExecutionPlan,
  buildRuntimeRuleVersions,
  MODEL_OPERATION_REGISTRY_VERSION,
  OPERATION_TO_STAGE,
  PROMPT_TEMPLATE_VERSIONS,
  RULE_VERSIONS,
  verifyModelExecutionPlanIntegrity,
  verifyRuntimeRuleVersionsIntegrity,
  type ModelCallContext,
  type ModelExecutionPlan,
  type ModelExecutionPlanEntry,
  type ProtectedOperation,
  type RuntimeRuleVersions,
} from './model-operation-registry';

const now = () => new Date().toISOString();

export type RuntimeClassificationProductType =
  ClassificationConfig['productTypes'][number]
  & Pick<Partial<ProductTypeConfigV2>, 'categoryId' | 'websiteValues' | 'invariantAttributes' | 'departmentId'>;

export interface PageSnapshotRecord {
  pageId: string;
  pageName: string;
  /** False until a real ShopSite Pages export verifies the identity. */
  verified: boolean;
  /** Verified records only: parent Page ID/name from the frozen import. */
  parentPageId?: string | null;
  parentPageName?: string | null;
  /** Verified records only: exported identity kind/key from the active import. */
  identityKind?: string;
  identityKey?: string;
  /** Verified records only: source hash of the page_index row/import. */
  sourceHash?: string | null;
}

export type PageSnapshotState =
  | {
      /** No verified ShopSite Pages export exists; names are review context only. */
      state: 'no_verified_page_catalog';
      nameOnlyRecords: PageSnapshotRecord[];
    }
  | {
      state: 'verified';
      records: PageSnapshotRecord[];
    };

/**
 * Point-in-time input for one classification run. Everything that can affect
 * stage output is resolved here and frozen into the snapshot.
 */
export interface RuntimeSnapshotInput {
  workspaceId: string;
  workspacePath: string;
  productSku: string;
  /**
   * The loaded runtime config authority (v1 transitional or ACTIVE v2).
   * Preferred over the legacy `config` field.
   */
  authority?: RuntimeConfigAuthority;
  /** Legacy v1 config input; used by tests and v1 transitional callers. */
  config?: ClassificationConfig;
  configSnapshotRef: ClassificationConfigSnapshotRef;
  focusedFileHashes?: Record<string, string>;
  catalogEvidenceHash?: string | null;
  pages?: PageSnapshotState;
  /** Canonical product/evidence hash; null/empty means absent (onboarding). */
  sourceProductHash: string | null;
  searchKeywords?: string | null;
  /** The product's OWN ProductOnPages observations — never every store Page. */
  productPageNames?: string[];
  pageImportId?: string | null;
  pageImportHash?: string | null;
  /**
   * Pre-resolved product-field option lists, frozen ONCE at cohort freeze
   * (issue #30 PR3 M2, D7) and injected into every member's runtime snapshot
   * so the per-member snapshots share the exact same field options. When
   * absent (legacy path) the options are computed from the config at build
   * time.
   */
  fieldOptions?: Record<string, ResolvedTargetOption[]>;
  createdAt?: string;
}

export interface RuntimeClassificationSnapshot {
  /** 1 = legacy (no frozen model-execution plan); 2 = additive plan/rule versions. */
  schemaVersion: 1 | 2;
  snapshotHash: string;
  createdAt: string;
  workspaceId: string;
  workspacePath: string;
  productSku: string;
  /** Which config authority this snapshot was built from. */
  configAuthorityKind: 'v1' | 'v2';
  /** The pre-activation nested catalog commit recorded by an active v2 manifest. */
  sourceCatalogCommit: string | null;
  config: ClassificationConfig;
  configSnapshotRef: ClassificationConfigSnapshotRef;
  focusedFileHashes: Record<string, string>;
  catalogEvidenceHash: string | null;
  productTypes: RuntimeClassificationProductType[];
  /**
   * Canonical Categories frozen for the run (issue #350). V1 configs carry
   * no categories (empty); v2 bundles carry the approved set. The snapshot
   * hash covers this field, so old snapshots stay pinned to their authority.
   */
  categories: Array<{ id: string; name: string }>;
  attributes: ClassificationConfig['attributes'];
  attributeProfiles: ClassificationConfig['attributeProfiles'];
  /** Pair-role destinations are frozen independently of ordinary attribute mappings. */
  classificationOutputBindings?: CanonicalClassificationOutputBindingV2[];
  attributeMappings: ClassificationConfig['attributeMappings'];
  guidance: ClassificationConfig['guidance'];
  brands: ClassificationConfig['brands'];
  modelPolicy: ClassificationConfig['modelPolicy'];
  dataSharing: ClassificationConfig['dataSharing'];
  curationTargets: CurationTargetConfig[];
  /**
   * Pre-resolved product-field option lists keyed by curation target ID.
   * Live-store values are captured once at build time so stage resolution
   * stays pure over the snapshot.
   */
  fieldOptions: Record<string, ResolvedTargetOption[]>;
  reviewedFacts: ReviewedFact[];
  pages: PageSnapshotState;
  sourceProductHash: string | null;
  searchKeywords: string | null;
  productPageNames: string[];
  pageImportId: string | null;
  pageImportHash: string | null;
  /**
   * Page context is name-only review context until a verified ShopSite Pages
   * export exists. It never supports claims or composition.
   */
  pageContextReliability: 'low';
  /**
   * Schema-v2 only: frozen model-execution plan (operation → stage →
   * provider/model/locality + prompt-template/rule versions + digest). Absent
   * on legacy schema-v1 snapshots; a new model call from a snapshot without a
   * compatible plan fails closed.
   */
  modelExecutionPlan?: ModelExecutionPlan;
  /** Schema-v2 only: versioned prompt/rule/output-policy versions + digest. */
  runtimeRuleVersions?: RuntimeRuleVersions;
}

/** Effective curation targets: enabled targets plus mandatory targets. */
function listEffectiveCurationTargets(config: ClassificationConfig): CurationTargetConfig[] {
  const enabled = getExplicitCurationTargets(config);
  const all = [...enabled];
  for (const target of config.curationTargets ?? []) {
    if (target.mandatory === true && !all.some(existing => existing.id === target.id)) {
      all.push(target);
    }
  }
  return all;
}

/**
 * Pre-resolve product-field option lists at snapshot build time. This is the
 * only point where live-store values are read; stages consume the frozen lists.
 * Exported so the cohort freeze engine can resolve the options ONCE and inject
 * them into every member's runtime snapshot (PR3 M2 D7).
 */
export function computeSnapshotFieldOptions(config: ClassificationConfig): Record<string, ResolvedTargetOption[]> {
  const result: Record<string, ResolvedTargetOption[]> = {};
  for (const target of listEffectiveCurationTargets(config)) {
    if (target.kind !== 'product_field') continue;
    const attribute = config.attributes.find(candidate => candidate.id === target.attributeId);
    if (!attribute) continue;
    // Model inference must see the complete frozen candidate authority. The
    // 250-value default is for UI retrieval only; truncating here could make
    // an oversized candidate set look valid instead of refusing dispatch.
    const allowed = resolveAttributeAllowedValues(config, attribute, target, Number.POSITIVE_INFINITY);
    result[target.id] = allowed.map(value => ({ value, label: value }));
  }
  return result;
}

/**
 * Resolve the snapshot-facing config view and resolved arrays from the runtime
 * authority. V2 bundles are carried as-is (typed as the legacy shape) so every
 * stage-visible v2 semantic (isUniversal, evidencePolicy, providerLocalities)
 * survives into the frozen snapshot.
 */
function resolveAuthorityFields(authority: RuntimeConfigAuthority): {
  config: ClassificationConfig;
  productTypes: RuntimeClassificationProductType[];
  categories: Array<{ id: string; name: string }>;
  attributes: ClassificationConfig['attributes'];
  attributeProfiles: ClassificationConfig['attributeProfiles'];
  attributeMappings: ClassificationConfig['attributeMappings'];
  classificationOutputBindings: CanonicalClassificationOutputBindingV2[];
  guidance: ClassificationConfig['guidance'];
  brands: ClassificationConfig['brands'];
  modelPolicy: ClassificationConfig['modelPolicy'];
  dataSharing: ClassificationConfig['dataSharing'];
  curationTargets: CurationTargetConfig[];
} {
  if (authority.kind === 'v1') {
    const config = authority.config;
    return {
      config,
      productTypes: config.productTypes,
      categories: [],
      attributes: config.attributes,
      attributeProfiles: config.attributeProfiles,
      attributeMappings: config.attributeMappings,
      classificationOutputBindings: [],
      guidance: config.guidance,
      brands: config.brands,
      modelPolicy: config.modelPolicy,
      dataSharing: config.dataSharing,
      curationTargets: config.curationTargets ?? [],
    };
  }
  const bundle = authority.bundle;
  return {
    config: bundle as unknown as ClassificationConfig,
    productTypes: bundle.productTypes,
    categories: (bundle.categories ?? []).map(category => ({ id: category.id, name: category.name })),
    attributes: bundle.attributes as unknown as ClassificationConfig['attributes'],
    attributeProfiles: bundle.attributeProfiles as unknown as ClassificationConfig['attributeProfiles'],
    attributeMappings: bundle.attributeMappings as unknown as ClassificationConfig['attributeMappings'],
    classificationOutputBindings: bundle.classificationOutputBindings ?? [],
    guidance: bundle.guidance as unknown as ClassificationConfig['guidance'],
    brands: bundle.brands as unknown as ClassificationConfig['brands'],
    modelPolicy: bundle.modelPolicy as unknown as ClassificationConfig['modelPolicy'],
    dataSharing: bundle.dataSharing as unknown as ClassificationConfig['dataSharing'],
    curationTargets: bundle.curationTargets as unknown as CurationTargetConfig[],
  };
}

/**
 * Build the runtime snapshot, freeze it, and compute its canonical hash.
 * The snapshot hash covers every stage-visible field; `createdAt` and the
 * hash field itself are excluded so identical inputs produce identical hashes.
 */
/**
 * Capture the configured local VLM endpoint ONCE at snapshot build time.
 * Returns null when the VLM is unconfigured/disabled so the plan entry
 * carries no frozen route and run-bound local VLM calls fail closed. The
 * captured base URL/model are the ONLY endpoint a run-bound local VLM call
 * may use — never mutable settings read mid-run. Exported so the cohort
 * freeze engine can compute the shared model-execution digest (H5) from the
 * same frozen inputs.
 */
export function captureLocalVlmConfig(): { baseUrl: string; model: string } | null {
  try {
    const config = getVlmConfig();
    if (!config || !config.enabled) return null;
    return { baseUrl: config.baseUrl, model: config.model };
  } catch {
    // No DB / unreadable settings at snapshot build: fail closed (no route).
    return null;
  }
}

export function buildRuntimeSnapshot(input: RuntimeSnapshotInput): RuntimeClassificationSnapshot {
  if (!input.authority && !input.config) {
    throw new Error('buildRuntimeSnapshot requires either a runtime config authority or a legacy v1 config.');
  }
  const authority: RuntimeConfigAuthority = input.authority
    ?? { kind: 'v1', config: input.config as ClassificationConfig };
  const fields = resolveAuthorityFields(authority);
  const config = fields.config;
  const isV2 = authority.kind === 'v2';
  const snapshot: RuntimeClassificationSnapshot = {
    schemaVersion: isV2 ? 2 : 1,
    snapshotHash: '',
    createdAt: input.createdAt ?? now(),
    workspaceId: input.workspaceId,
    workspacePath: input.workspacePath,
    productSku: input.productSku,
    configAuthorityKind: authority.kind,
    sourceCatalogCommit: authority.kind === 'v2' ? authority.bundle.manifest.sourceCatalogCommit : null,
    config,
    configSnapshotRef: input.configSnapshotRef,
    focusedFileHashes: input.focusedFileHashes ?? config.manifest.fileVersions ?? {},
    catalogEvidenceHash: input.catalogEvidenceHash ?? (
      authority.kind === 'v2' ? authority.bundle.manifest.catalogEvidenceHash : null
    ),
    productTypes: fields.productTypes,
    categories: fields.categories,
    attributes: fields.attributes,
    attributeProfiles: fields.attributeProfiles,
    attributeMappings: fields.attributeMappings,
    classificationOutputBindings: fields.classificationOutputBindings,
    guidance: fields.guidance,
    brands: fields.brands,
    modelPolicy: fields.modelPolicy,
    dataSharing: fields.dataSharing,
    curationTargets: fields.curationTargets,
    fieldOptions: input.fieldOptions ?? computeSnapshotFieldOptions(config),
    reviewedFacts: collectCompatibleReviewedFacts({
      workspaceId: input.workspaceId,
      productSku: input.productSku,
      authority,
      sourceProductHash: input.sourceProductHash,
    }),
    pages: input.pages ?? { state: 'no_verified_page_catalog', nameOnlyRecords: [] },
    sourceProductHash: normalizeSourceProductHash(input.sourceProductHash),
    searchKeywords: input.searchKeywords ?? null,
    productPageNames: input.productPageNames ?? [],
    pageImportId: input.pageImportId ?? null,
    pageImportHash: input.pageImportHash ?? null,
    pageContextReliability: 'low',
    // Schema-v2 only: freeze the model-execution plan + rule versions from the
    // v2 model policy. Legacy v1 snapshots carry no plan — a new model call
    // from them fails closed (no compatible plan). The local VLM endpoint is
    // captured ONCE at snapshot build time so a run-bound local VLM call
    // can never read mutable `ollama_vlm` settings mid-run, and the audit row
    // resolves locality from the ACTUAL base URL used (loopback ⇒ local).
    ...(isV2
      ? {
          modelExecutionPlan: buildModelExecutionPlan(
            buildModelPolicyView(fields.modelPolicy as Parameters<typeof buildModelPolicyView>[0]),
            captureLocalVlmConfig(),
          ),
          runtimeRuleVersions: buildRuntimeRuleVersions(),
        }
      : {}),
  };
  snapshot.snapshotHash = snapshotHash(snapshot);
  return deepFreeze(snapshot);
}

/**
 * Recursively freeze an object graph. Mutating any node throws in strict mode.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Reflect.ownKeys(value)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child !== null && typeof child === 'object') {
      deepFreeze(child);
    }
  }
  return Object.freeze(value);
}

/**
 * Canonical SHA-256 of every stage-visible snapshot field. Excludes the
 * embedded hash, the creation timestamp, and the config-snapshot reference's
 * creation timestamp so identical inputs produce identical hashes regardless
 * of wall-clock time.
 */
export function snapshotHash(snapshot: RuntimeClassificationSnapshot): string {
  const {
    snapshotHash: _embedded,
    createdAt: _createdAt,
    configSnapshotRef,
    ...rest
  } = snapshot;
  const { createdAt: _refCreatedAt, ...refRest } = configSnapshotRef;
  return hashCanonicalJson({ ...rest, configSnapshotRef: refRest });
}

/**
 * A carried fact is reusable only when the config it was accepted under still
 * matches the current config authority — either as a plain config hash
 * (canonical or historical signed-decimal, v1), as the active v2 bundle hash,
 * or as a persisted runtime snapshot whose embedded config reference matches.
 * Facts whose provenance cannot be verified fail closed (drift).
 */
function factConfigIsCompatible(
  fact: ReviewedFact,
  authority: RuntimeConfigAuthority,
  workspaceId: string,
): boolean {
  if (fact.configSnapshotHash === null) return false;
  if (authority.kind === 'v2') {
    if (fact.configSnapshotHash === authority.bundle.manifest.bundleHash) return true;
    return runtimeSnapshotHashMatchesConfig(workspaceId, fact.configSnapshotHash, authority.bundle);
  }
  if (configHashMatches(authority.config, fact.configSnapshotHash)) return true;
  return runtimeSnapshotHashMatchesConfig(workspaceId, fact.configSnapshotHash, authority.config);
}

/**
 * Collect reviewed facts and drop every fact whose config or source provenance
 * drifted from the current snapshot. Incompatible facts are never silently
 * reused: carry-forward preserves provenance and rejects drift.
 */
function collectCompatibleReviewedFacts(
  input: Pick<RuntimeSnapshotInput, 'workspaceId' | 'productSku' | 'authority' | 'sourceProductHash'>,
): ReviewedFact[] {
  const authority = input.authority as RuntimeConfigAuthority;
  const facts = collectReviewedFacts({ workspaceId: input.workspaceId, productSku: input.productSku });
  const currentSourceHash = normalizeAbsentHash(input.sourceProductHash);
  return facts.filter(
    fact =>
      factConfigIsCompatible(fact, authority, input.workspaceId) &&
      normalizeAbsentHash(fact.sourceHash) === currentSourceHash,
  );
}

/**
 * Normalize the source hash into a single persisted representation so
 * onboarding runs (empty string) and catalog runs (digest) compare cleanly.
 */
function normalizeSourceProductHash(value: string | null | undefined): string | null {
  return normalizeAbsentHash(value);
}

/**
 * Persist a frozen snapshot to the derived SQLite snapshot store and verify
 * the hash survives the round-trip. Fail closed on any mismatch.
 */
export function persistRuntimeSnapshot(
  snapshot: RuntimeClassificationSnapshot,
): { id: string; hash: string } {
  const expected = snapshotHash(snapshot);
  if (expected !== snapshot.snapshotHash) {
    throw new Error(
      `Runtime snapshot hash mismatch before persistence: computed ${expected}, embedded ${snapshot.snapshotHash}.`,
    );
  }

  const db = getDb();
  const existing = db.query(
    'SELECT id FROM classification_config_snapshots WHERE workspace_id = ? AND snapshot_hash = ?',
  ).get(snapshot.workspaceId, expected) as { id: string } | undefined;
  if (existing) {
    return { id: existing.id, hash: expected };
  }

  const id = randomUUID();
  const serialized = canonicalJsonStringify(snapshot);
  db.run(
    `INSERT INTO classification_config_snapshots
     (id, workspace_id, snapshot_hash, manifest_schema_version, compatibility_version, source_commit, config_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      snapshot.workspaceId,
      expected,
      1,
      1,
      snapshot.configSnapshotRef.sourceCommit,
      serialized,
      snapshot.createdAt,
    ],
  );

  // Recompute the hash after persistence and fail closed on mismatch.
  const stored = db.query('SELECT config_json FROM classification_config_snapshots WHERE id = ?').get(id) as
    | { config_json: string }
    | undefined;
  if (!stored) {
    throw new Error('Runtime snapshot persistence failed: no stored row.');
  }
  const rehydrated = JSON.parse(stored.config_json) as RuntimeClassificationSnapshot;
  const recomputed = snapshotHash(rehydrated);
  if (recomputed !== expected) {
    throw new Error(
      `Runtime snapshot hash verification failed after persistence: recomputed ${recomputed}, expected ${expected}.`,
    );
  }
  return { id, hash: expected };
}

/**
 * Read a persisted runtime snapshot by its canonical hash. Returns null when
 * no runtime snapshot (as opposed to a plain config snapshot) is stored.
 */
export function getRuntimeSnapshotByHash(workspaceId: string, hash: string): RuntimeClassificationSnapshot | null {
  const row = getDb()
    .query('SELECT config_json FROM classification_config_snapshots WHERE workspace_id = ? AND snapshot_hash = ?')
    .get(workspaceId, hash) as { config_json: string } | undefined;
  if (!row) return null;
  let parsed: Partial<RuntimeClassificationSnapshot>;
  try {
    parsed = JSON.parse(row.config_json) as Partial<RuntimeClassificationSnapshot>;
  } catch {
    // Malformed historical JSON is visible as snapshot_unavailable, never a
    // 500 — a corrupt snapshot cannot authorize a call or fake provenance.
    return null;
  }
  // Accept legacy schema-v1 and additive schema-v2 runtime snapshots; reject
  // plain config snapshots (no snapshotHash) and unknown schema versions.
  if (
    (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) ||
    typeof parsed.snapshotHash !== 'string' ||
    !parsed.config
  ) {
    return null;
  }
  return parsed as RuntimeClassificationSnapshot;
}

/**
 * Fail closed when a protected model call would run against a snapshot
 * without a compatible frozen model-execution plan entry: legacy schema-v1
 * snapshots (no plan), a plan whose content digest does not match its stored
 * digest, missing runtimeRuleVersions or a digest mismatch, a plan whose
 * frozen `registryVersion` differs from the EXECUTING
 * `MODEL_OPERATION_REGISTRY_VERSION` (PR12 C4, registry_version_mismatch — a
 * snapshot frozen under an older/newer operation registry never executes
 * run-bound calls), a plan that does not cover the operation with the
 * current registry's prompt-template/rule versions, or a supplied
 * ModelCallContext whose prompt/rule versions differ from the frozen plan
 * entry. A snapshot without a compatible plan can never route a new model
 * call.
 */
export function assertModelPlanCompatible(
  snapshot: RuntimeClassificationSnapshot | null | undefined,
  operation: ProtectedOperation,
  ctx?: ModelCallContext | null,
): void {
  if (!snapshot) {
    throw new Error(
      `Model plan incompatible: no runtime snapshot for model call operation "${operation}".`,
    );
  }
  if (snapshot.schemaVersion !== 2 || !snapshot.modelExecutionPlan) {
    throw new Error(
      `Model plan incompatible: snapshot schema ${snapshot.schemaVersion} has no frozen model-execution plan ` +
        `for operation "${operation}".`,
    );
  }
  // The frozen rule versions must be present AND digest-consistent: a missing
  // or tampered rule set cannot authorize a call.
  if (!snapshot.runtimeRuleVersions) {
    throw new Error(
      `Model plan incompatible: snapshot schema 2 has no frozen runtimeRuleVersions for operation "${operation}".`,
    );
  }
  if (!verifyModelExecutionPlanIntegrity(snapshot.modelExecutionPlan)) {
    throw new Error(
      `Model plan incompatible: snapshot model-execution plan digest does not match its entries (operation "${operation}").`,
    );
  }
  if (!verifyRuntimeRuleVersionsIntegrity(snapshot.runtimeRuleVersions)) {
    throw new Error(
      `Model plan incompatible: snapshot runtimeRuleVersions digest does not match its fields (operation "${operation}").`,
    );
  }
  // PR12 C4 (DECISION-B): the frozen operation-registry version is part of
  // the parameter contract. A v2 snapshot frozen under a DIFFERENT registry
  // version than the EXECUTING one refuses run-bound calls deterministically
  // (registry_version_mismatch) — a plan frozen under an older (or newer)
  // operation registry never executes. schema-v1 legacy snapshots (no plan)
  // keep their existing behavior (the no-plan fail-closed guard above).
  if (snapshot.modelExecutionPlan.registryVersion !== MODEL_OPERATION_REGISTRY_VERSION) {
    throw new Error(
      `Model plan incompatible: snapshot model-execution plan registry version ` +
        `${snapshot.modelExecutionPlan.registryVersion} differs from the executing registry version ` +
        `${MODEL_OPERATION_REGISTRY_VERSION} (registry_version_mismatch); the run is frozen under a ` +
        `different operation-registry contract and its run-bound calls refuse.`,
    );
  }
  const stage = OPERATION_TO_STAGE[operation];
  if (stage === null) {
    // Onboarding-only operations (brand inference, sitemap selection) are not
    // run-bound; they use the pre-run policy snapshot, not the run plan.
    return;
  }
  const entry = snapshot.modelExecutionPlan.entries.find(e => e.operation === operation);
  if (!entry) {
    throw new Error(
      `Model plan incompatible: snapshot plan has no entry for operation "${operation}".`,
    );
  }
  if (entry.promptTemplateVersion !== PROMPT_TEMPLATE_VERSIONS[operation]) {
    throw new Error(
      `Model plan incompatible: operation "${operation}" prompt-template version ${entry.promptTemplateVersion} ` +
        `differs from the current registry version ${PROMPT_TEMPLATE_VERSIONS[operation]}.`,
    );
  }
  if (entry.ruleVersion !== RULE_VERSIONS[operation]) {
    throw new Error(
      `Model plan incompatible: operation "${operation}" rule version ${entry.ruleVersion} ` +
        `differs from the current registry version ${RULE_VERSIONS[operation]}.`,
    );
  }
  // The supplied call context must be stamped with the frozen plan versions:
  // a forged/mismatched context can never be persisted as provenance.
  if (ctx) {
    if (ctx.promptTemplateVersion !== entry.promptTemplateVersion) {
      throw new Error(
        `Model plan incompatible: call context prompt-template version ${ctx.promptTemplateVersion} ` +
          `differs from the frozen plan entry ${entry.promptTemplateVersion} for operation "${operation}".`,
      );
    }
    if (ctx.ruleVersion !== entry.ruleVersion) {
      throw new Error(
        `Model plan incompatible: call context rule version ${ctx.ruleVersion} ` +
          `differs from the frozen plan entry ${entry.ruleVersion} for operation "${operation}".`,
      );
    }
  }
}

/** Plan entry lookup for run-detail reporting (never prompt bodies). */
export function getModelExecutionPlanEntry(
  snapshot: RuntimeClassificationSnapshot | null | undefined,
  operation: ProtectedOperation,
): ModelExecutionPlanEntry | null {
  if (!snapshot || snapshot.schemaVersion !== 2 || !snapshot.modelExecutionPlan) return null;
  return snapshot.modelExecutionPlan.entries.find(e => e.operation === operation) ?? null;
}

/** Strip URL credentials before hashing — an OCR authority digest never bakes
 *  credentials into even a digest. Deterministic for identical authorities. */
function sanitizeUrlForDigest(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    // Not a URL — hash the raw string (still a digest, no plaintext leak).
    return url;
  }
}

/**
 * OCR execution-authority digest (PR3 hardening, Commit A / R4 + A2):
 * - v2 snapshots: `hashCanonicalJson({planDigest, ruleVersionsDigest})` over
 *   the member snapshot's `evidence_extraction` model-execution-plan entry
 *   (provider, model, locality, prompt/rule versions, frozen local-VLM route
 *   WITHOUT credentials) plus `runtimeRuleVersions.digest`. The stored OCR is
 *   only reusable when this digest matches the CURRENT snapshot's authority —
 *   a model-policy / local-VLM-route change re-runs OCR under the new
 *   authority.
 * - v1 (legacy) snapshots: a deterministic legacy-authority digest,
 *   `hashCanonicalJson({authorityKind:'v1', snapshotHash})`, bound to the
 *   snapshot's content identity. A changed v1 config/evidence set changes the
 *   snapshot hash and therefore the digest — legacy OCR is NEVER "unbound":
 *   it is always executed under SOME authority digest (Commit A2 fail-closed).
 * Returns null only for an impossible v2 snapshot with a missing plan/rules
 * (the freeze fails closed on that); callers treat null as "never reuse".
 */
export function computeOcrExecutionDigest(snapshot: RuntimeClassificationSnapshot): string | null {
  if (snapshot.schemaVersion !== 2) {
    return hashCanonicalJson({ authorityKind: 'v1', snapshotHash: snapshot.snapshotHash });
  }
  const plan = snapshot.modelExecutionPlan;
  const rules = snapshot.runtimeRuleVersions;
  if (!plan || !rules) return null;
  const entry = plan.entries.find(e => e.operation === 'evidence_extraction');
  if (!entry) return null;
  const planDigest = hashCanonicalJson({
    operation: entry.operation,
    stage: entry.stage,
    provider: entry.provider,
    model: entry.model,
    locality: entry.locality,
    fromOverride: entry.fromOverride,
    promptTemplateVersion: entry.promptTemplateVersion,
    ruleVersion: entry.ruleVersion,
    localVlmBaseUrl: sanitizeUrlForDigest(entry.localVlmBaseUrl),
    localVlmModel: entry.localVlmModel ?? null,
  });
  return hashCanonicalJson({ planDigest, ruleVersionsDigest: rules.digest });
}

/**
 * Build the durable model-call audit context for a run-bound protected call
 * from the frozen snapshot plan, FAILING CLOSED when the snapshot has no
 * compatible plan entry (legacy schema-v1 snapshot, missing entry, version
 * drift). Returns null only for NON-run-bound callers (pre-run discovery,
 * no snapshot) so the legacy/no-plan path stays available there.
 */
export function requireModelCallContext(
  snapshot: RuntimeClassificationSnapshot | null | undefined,
  runId: string,
  operation: ProtectedOperation,
  attempt: number,
): ModelCallContext | null {
  if (!snapshot) return null;
  assertModelPlanCompatible(snapshot, operation);
  const ctx = buildModelCallContext(snapshot, runId, operation, attempt);
  if (!ctx) {
    throw new Error(
      `Model plan incompatible: run-bound ${operation} call has no compatible frozen plan ` +
        `(legacy/no-plan snapshot).`,
    );
  }
  return ctx;
}

/**
 * Build the durable model-call audit context for a run-bound protected call
 * from the frozen snapshot plan. Fails closed when the snapshot has no
 * compatible plan entry for the operation (callers wrap this at the transport
 * wrapper anyway; this helper produces the context only for schema-v2
 * snapshots and returns null otherwise).
 */
export function buildModelCallContext(
  snapshot: RuntimeClassificationSnapshot | null | undefined,
  runId: string,
  operation: ProtectedOperation,
  attempt: number,
): ModelCallContext | null {
  if (!snapshot || snapshot.schemaVersion !== 2 || !snapshot.modelExecutionPlan) return null;
  const entry = snapshot.modelExecutionPlan.entries.find(e => e.operation === operation);
  if (!entry) return null;
  return {
    runId,
    snapshotHash: snapshot.snapshotHash,
    stage: OPERATION_TO_STAGE[operation] ?? null,
    operation,
    attempt,
    promptTemplateVersion: entry.promptTemplateVersion,
    ruleVersion: entry.ruleVersion,
  };
}

/**
 * Drift check for catalog application: a stored hash matches the current
 * config either as a plain config hash (legacy compatibility), as the active
 * v2 bundle hash, or as a persisted runtime snapshot whose embedded config
 * reference still matches.
 */
export function runtimeSnapshotHashMatchesConfig(
  workspaceId: string,
  storedHash: string,
  config: ClassificationConfig | ClassificationConfigBundleV2,
): boolean {
  const snapshot = getRuntimeSnapshotByHash(workspaceId, storedHash);
  if (!snapshot) return false;
  if (snapshotHash(snapshot) !== storedHash) return false;
  const isV2 = (config as ClassificationConfigBundleV2).bundleOrigin !== undefined;
  const configHash = isV2
    ? (config as ClassificationConfigBundleV2).manifest.bundleHash
    : hashCanonicalJson(config as ClassificationConfig);
  return snapshot.configSnapshotRef.hash === configHash;
}

/**
 * True when a stored config hash matches the current runtime authority: v2
 * compares against the active bundle hash; v1 uses the canonical/legacy hash
 * compatibility helper.
 */
export function authorityConfigHashMatches(
  authority: RuntimeConfigAuthority,
  storedHash: string,
): boolean {
  if (authority.kind === 'v2') {
    return storedHash === authority.bundle.manifest.bundleHash;
  }
  return configHashMatches(authority.config, storedHash);
}
