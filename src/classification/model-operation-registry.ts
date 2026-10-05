/**
 * Model operation registry (issue #17 work item E).
 *
 * Stable, versioned identifiers for every protected classification/onboarding
 * LLM operation: prompt-template versions, rule versions, deterministic
 * parameter defaults, and the stage each operation belongs to. The registry is
 * the single source of truth that runtime snapshots freeze into
 * `modelExecutionPlan` / `runtimeRuleVersions`, so a run's model-call
 * provenance can be traced to an exact prompt-template/rule version and a
 * model-call row can be verified against the run's snapshot plan.
 *
 * Fail-closed invariant: a new model call from a snapshot without a
 * compatible plan (legacy v1 snapshot, or a plan missing the operation) fails
 * closed — it is never routed against an unfrozen rule set.
 */
import type { ProtectedOperation, ModelPolicyView, ProviderLocality } from './model-policy-gateway';
import type { ClassificationStageName } from './types';
import { hashCanonicalJson } from '../shared/stable-id';
import { SHOP_SITE_BUILT_IN_OUTPUT_POLICY_VERSION } from '../shopsite/built-in-output-policy';

export type { ProtectedOperation };

/** Category Page correctness validator version (e09 B2 P1-P12) — single source of truth lives in
 *  category-page-correctness.ts (consumed by cohort-page-hash for the P-hash); re-exported here so
 *  registry consumers reference one constant instead of a drifting copy. */
export { CATEGORY_PAGE_CORRECTNESS_VERSION } from './category-page-correctness';

/** Bump ONLY when the operation→rule/prompt/parameter contract changes. */
export const MODEL_OPERATION_REGISTRY_VERSION = 3;

/**
 * Built-in ShopSite output policy version participating in runs. Single
 * source of truth lives in `src/shopsite/built-in-output-policy.ts`; bump the
 * policy there and this value follows automatically.
 */
const OUTPUT_POLICY_VERSION = SHOP_SITE_BUILT_IN_OUTPUT_POLICY_VERSION;

/**
 * Prompt-template version per protected operation. Bump a version whenever
 * the prompt text or its construction rules change for that operation; the
 * bump must land in the same change as the prompt edit so snapshots built
 * before the change keep the old version binding.
 */
export const PROMPT_TEMPLATE_VERSIONS: Readonly<Record<ProtectedOperation, string>> = {
  evidence_extraction: 'evidence-extraction-prompt-v1',
  product_type_ranking: 'product-type-ranking-prompt-v2-grounded-neighbors',
  attribute_ranking: 'attribute-ranking-prompt-v1',
  page_assignment: 'page-assignment-prompt-v2',
  cohort_page_assignment: 'cohort-page-assignment-prompt-v2',
  cohort_page_assignment_parent: 'cohort-page-assignment-parent-prompt-v3',
  title_consolidation: 'title-consolidation-prompt-v1',
  cohort_title_consolidation: 'cohort-title-consolidation-prompt-v1',
  distributor_copy_consolidation: 'distributor-copy-consolidation-prompt-v1',
  discovery_name_consolidation: 'discovery-name-consolidation-prompt-v1',
  sitemap_selection: 'sitemap-selection-prompt-v1',
  value_gap_resolution: 'value-gap-resolution-prompt-v1',
};

/**
 * Deterministic rule version per protected operation. Bump when the
 * deterministic post-processing rules (JSON repair, value normalization,
 * token guards, abstention rules) for that operation change.
 */
export const RULE_VERSIONS: Readonly<Record<ProtectedOperation, string>> = {
  evidence_extraction: 'evidence-extraction-rules-v2',
  product_type_ranking: 'product-type-ranking-rules-v2-grounded-neighbors',
  attribute_ranking: 'attribute-ranking-rules-v2',
  page_assignment: 'page-assignment-rules-v2',
  cohort_page_assignment: 'cohort-page-assignment-rules-v2',
  cohort_page_assignment_parent: 'cohort-page-assignment-parent-rules-v3',
  title_consolidation: 'title-consolidation-rules-v1',
  cohort_title_consolidation: 'cohort-title-consolidation-rules-v2', // B1 family-title consistency (T2-T7) + title-lint — FAMILY_TITLE_CONSISTENCY_VERSION v2
  distributor_copy_consolidation: 'distributor-copy-consolidation-rules-v1',
  discovery_name_consolidation: 'discovery-name-consolidation-rules-v1',
  sitemap_selection: 'sitemap-selection-rules-v1',
  value_gap_resolution: 'value-gap-resolution-rules-v1',
};

/**
 * Deterministic parameter defaults per protected operation. The transport
 * wrapper applies these when the caller does not override them, so a call's
 * parameters are reproducible from the registry version.
 */
export const OPERATION_PARAMETERS: Readonly<
  Record<ProtectedOperation, { temperature: number; maxTokens: number | null }>
> = {
  evidence_extraction: { temperature: 0.1, maxTokens: null },
  product_type_ranking: { temperature: 0.0, maxTokens: null },
  attribute_ranking: { temperature: 0.0, maxTokens: null },
  page_assignment: { temperature: 0.0, maxTokens: null },
  cohort_page_assignment: { temperature: 0.0, maxTokens: null },
  cohort_page_assignment_parent: { temperature: 0.0, maxTokens: null },
  title_consolidation: { temperature: 0.1, maxTokens: null },
  cohort_title_consolidation: { temperature: 0.1, maxTokens: null },
  distributor_copy_consolidation: { temperature: 0.1, maxTokens: null },
  discovery_name_consolidation: { temperature: 0.1, maxTokens: null },
  sitemap_selection: { temperature: 0.0, maxTokens: null },
  value_gap_resolution: { temperature: 0.0, maxTokens: null },
};

/**
 * Stable stage mapping per protected operation. `null` means the operation is
 * not tied to a classification stage (onboarding-only: brand inference,
 * sitemap selection) and is not part of a run's model-execution plan.
 */
export const OPERATION_TO_STAGE: Readonly<Record<ProtectedOperation, ClassificationStageName | null>> = {
  evidence_extraction: 'evidence_extraction',
  product_type_ranking: 'primary_product_type_proposal',
  attribute_ranking: 'product_attribute_proposals',
  page_assignment: 'category_page_proposals',
  cohort_page_assignment: 'category_page_proposals',
  cohort_page_assignment_parent: 'category_page_proposals',
  title_consolidation: 'name_consolidation',
  cohort_title_consolidation: 'name_consolidation',
  distributor_copy_consolidation: 'name_consolidation',
  discovery_name_consolidation: 'name_consolidation',
  sitemap_selection: null,
  value_gap_resolution: 'value_gap_abstain',
};

/** Run-bound protected operations (those mapped to a classification stage). */
const RUN_BOUND_OPERATIONS: readonly ProtectedOperation[] = (
  Object.keys(OPERATION_TO_STAGE) as ProtectedOperation[]
).filter(op => OPERATION_TO_STAGE[op] !== null);

/** Versioned rule set frozen into a runtime snapshot (v2+). */
export interface RuntimeRuleVersions {
  version: 1;
  registryVersion: number;
  promptTemplateVersions: Readonly<Record<ProtectedOperation, string>>;
  ruleVersions: Readonly<Record<ProtectedOperation, string>>;
  outputPolicyVersion: string;
  digest: string;
}

/** Frozen intent of one protected operation inside a run snapshot plan. */
export interface ModelExecutionPlanEntry {
  operation: ProtectedOperation;
  stage: ClassificationStageName;
  /** Resolved from the frozen policy: stage override or default. */
  provider: string;
  model: string;
  locality: ProviderLocality | null;
  /** True when provider/model came from a stage override. */
  fromOverride: boolean;
  promptTemplateVersion: string;
  ruleVersion: string;
  /**
   * Frozen local VLM endpoint (evidence_extraction local OCR only). Captured
   * once at snapshot build time so the local VLM transport never reads
   * mutable `ollama_vlm` settings mid-run; the audit row resolves locality
   * from the ACTUAL base URL used (loopback ⇒ local).
   */
  localVlmBaseUrl?: string | null;
  localVlmModel?: string | null;
}

/** Frozen model-execution plan of a run snapshot (v2+). */
export interface ModelExecutionPlan {
  version: 1;
  registryVersion: number;
  entries: ModelExecutionPlanEntry[];
  digest: string;
}

/** Stable model-call terminal statuses (see classification_model_calls). */
export const MODEL_CALL_STATUS = {
  started: 'started',
  success: 'success',
  failed: 'failed',
  policyDenied: 'policy_denied',
  unavailable: 'unavailable',
  cancelled: 'cancelled',
} as const;
export type ModelCallStatus = (typeof MODEL_CALL_STATUS)[keyof typeof MODEL_CALL_STATUS];

/** Cost basis for a model call (never a guessed zero). */
export const COST_BASIS = {
  localZero: 'local_zero',
  unknown: 'unknown',
} as const;
export type CostBasis = (typeof COST_BASIS)[keyof typeof COST_BASIS];

export function buildRuntimeRuleVersions(): RuntimeRuleVersions {
  const payload = {
    version: 1 as const,
    registryVersion: MODEL_OPERATION_REGISTRY_VERSION,
    promptTemplateVersions: PROMPT_TEMPLATE_VERSIONS,
    ruleVersions: RULE_VERSIONS,
    outputPolicyVersion: OUTPUT_POLICY_VERSION,
  };
  return {
    ...payload,
    digest: hashCanonicalJson(payload),
  };
}

/**
 * Recompute a model-execution plan's content digest from its own fields and
 * compare it to the stored digest. A plan whose digest does not match its
 * entries has been tampered with (or was built incorrectly) and must never
 * authorize a model call.
 */
export function verifyModelExecutionPlanIntegrity(plan: ModelExecutionPlan): boolean {
  try {
    const recomputed = hashCanonicalJson({
      version: plan.version,
      registryVersion: plan.registryVersion,
      entries: plan.entries,
    });
    return recomputed === plan.digest;
  } catch {
    return false;
  }
}

/**
 * Recompute a runtime rule-versions digest from its own fields and compare it
 * to the stored digest. A tampered/missing digest can never be treated as the
 * frozen rule set.
 */
export function verifyRuntimeRuleVersionsIntegrity(rules: RuntimeRuleVersions): boolean {
  try {
    const recomputed = hashCanonicalJson({
      version: rules.version,
      registryVersion: rules.registryVersion,
      promptTemplateVersions: rules.promptTemplateVersions,
      ruleVersions: rules.ruleVersions,
      outputPolicyVersion: rules.outputPolicyVersion,
    });
    return recomputed === rules.digest;
  } catch {
    return false;
  }
}

/**
 * Build the frozen model-execution plan for a run snapshot from the frozen
 * model-policy view. Only run-bound operations are included; provider/model
 * come from the policy (stage override or default) and the declared locality
 * is recorded. The plan is a frozen intent — the gateway re-resolves the
 * route at call time and the call row records the actual provider/model.
 *
 * `localVlmConfig` (optional) freezes the local VLM endpoint/model for
 * evidence_extraction local OCR at snapshot build time; when absent the entry
 * carries no local route and run-bound local VLM calls fail closed.
 */
export function buildModelExecutionPlan(
  view: ModelPolicyView,
  localVlmConfig?: { baseUrl: string; model: string } | null,
): ModelExecutionPlan {
  const entries: ModelExecutionPlanEntry[] = RUN_BOUND_OPERATIONS.map(operation => {
    const stage = OPERATION_TO_STAGE[operation] as ClassificationStageName;
    const override = view.stageOverrides[stage];
    const fromOverride = Boolean(override?.provider ?? override?.model);
    const provider = override?.provider ?? view.defaultProvider;
    const model = override?.model ?? view.defaultModel;
    return {
      operation,
      stage,
      provider,
      model,
      locality: view.providerLocalities[provider] ?? null,
      fromOverride,
      promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS[operation],
      ruleVersion: RULE_VERSIONS[operation],
      ...(operation === 'evidence_extraction' && localVlmConfig
        ? { localVlmBaseUrl: localVlmConfig.baseUrl, localVlmModel: localVlmConfig.model }
        : {}),
    };
  });
  const payload = {
    version: 1 as const,
    registryVersion: MODEL_OPERATION_REGISTRY_VERSION,
    entries,
  };
  return {
    ...payload,
    digest: hashCanonicalJson(payload),
  };
}

/**
 * Deterministic prompt hashes for a call (system + user prompts). Only
 * hashes are stored/returned — never prompt bodies.
 */
export function computePromptHashes(systemPrompt: string, userPrompt: string): {
  systemPromptHash: string;
  userPromptHash: string;
} {
  return {
    systemPromptHash: hashCanonicalJson({ systemPrompt }),
    userPromptHash: hashCanonicalJson({ userPrompt }),
  };
}

/**
 * Model-call audit context threaded by protected call sites into the LLM
 * wrapper. Binds the call to a run snapshot, operation, stage, and attempt.
 */
export interface ModelCallContext {
  runId: string;
  snapshotHash: string;
  stage: ClassificationStageName | null;
  operation: ProtectedOperation;
  attempt: number;
  promptTemplateVersion: string;
  ruleVersion: string;
}
