import { describe, it, expect } from 'bun:test';
import {
  computeCohortTitleInputHash,
  computeCohortTitleInputHashForFormatRules,
  titleAuthorityFromProjectionMember,
} from '../../onboarding/cohort-curation/titles';
import { titleExecutionTypeAuthorityFromRun } from '../../classification/cohort-decision-authority';
import type { CohortTitleAuthorityMember } from '../../onboarding/cohort-curation/titles';
import { buildCohortPrompt, FORMAT_RULES } from '../../onboarding/title-prompt-template';
import type { CohortSiblingInput } from '../../onboarding/title-prompt-template';
import { PROMPT_TEMPLATE_VERSIONS, RULE_VERSIONS } from '../../classification/model-operation-registry';
import type { ModelExecutionPlanEntry } from '../../classification/model-operation-registry';
import type {
  CohortRun,
  ExecutionEvidenceProjectionV1,
  ExecutionEvidenceProjectionMemberV1,
  ExecutionEvidenceProjectionMemberV2,
} from '../../shared/schemas/cohorts';
import { ExecutionEvidenceProjectionMemberV2Schema } from '../../shared/schemas/cohorts';
import { hashCanonicalJson } from '../../shared/stable-id';

/**
 * PR6 C2 (issue #30): the canonical title input hash — PURE, over the frozen
 * title authority ONLY.
 *
 * Every frozen-title field must be significant; every excluded field must be
 * inert; membership + execution type (incl. NULL vs value) must participate;
 * the model-execution authority slice must participate with the registry
 * fallback being stable; the hash must be deterministic and
 * member-order-stable (sorted by onboardingItemId by construction).
 */

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeMember(overrides: Partial<ExecutionEvidenceProjectionMemberV1> = {}): ExecutionEvidenceProjectionMemberV1 {
  return {
    onboardingItemId: 'item-1',
    ordinal: 0,
    productSku: 'SKU-1',
    extractionComplete: true as const,
    sourceUrl: 'https://brand.example/p1',
    extractionSourceUrl: 'https://brand.example/p1',
    sourcingDecision: null,
    spreadsheetIdentity: {
      name: 'RAW CHKN 5LB',
      expectedName: 'Chicken 5 lb',
      brandHint: 'PawCo',
      departmentHint: 'Food',
      price: '19.99',
      quantity: 1,
      rowNumber: 2,
      upc: 'SKU-1',
    },
    extraction: {
      title: 'PawCo Chicken Recipe 5 lb',
      description: 'A long description that must never enter the title hash',
      brand: 'PawCo',
      weight: '5 lb',
      bulletPoints: ['Bullet 1'],
      searchKeywords: 'chicken',
      primaryImage: 'https://img.example/p1.jpg',
      additionalImages: ['https://img.example/p1b.jpg'],
      customFields: { flavor: 'chicken' },
      fieldProvenance: { flavor: 'web' },
      manualEvidenceAttestationId: null,
      manualReferenceUrl: null,
      packagingTitle: 'PawCo Chicken 5 lb Pouch',
      ocr: {
        outcome: null,
        packagingOcrData: {
          productName: 'PawCo Chicken Recipe',
          brand: 'PawCo',
          species: [],
          upc: null,
          flavorVariety: 'Chicken',
          color: null,
          material: null,
          size: null,
          weight: '5 lb',
          count: null,
          lifeStage: null,
          breedSize: null,
          productForm: null,
          packagingType: null,
          npkRatio: null,
          guaranteedAnalysis: {},
          healthConcernFunction: [],
          dietaryLabels: [],
          ingredients: [],
          ingredientKeywords: [],
          claims: [],
          visibleTextLines: [],
          confidenceByField: {},
          metadata: {
            imageSourceUrl: null,
            imageLocalPath: null,
            model: null,
            extractedAt: null,
            parser: null,
            rawResponseExcerpt: null,
          },
        },
        ocrInputHash: 'ocr-input-hash-1',
        ocrExecutionDigest: 'ocr-exec-digest-1',
      },
      piEvidence: [],
      piImportComplete: true as const,
    },
    evidenceHash: 'member-evidence-hash-1',
    ...overrides,
  };
}

function makeRun(overrides: Partial<CohortRun> = {}): CohortRun {
  return {
    id: 'run-1',
    workspaceId: 'ws-1',
    cohortId: 'cohort-1',
    candidateMembershipHash: 'candidate-membership-hash',
    finalMembershipHash: 'final-membership-hash',
    evidenceSnapshotHash: 'evidence-snapshot-hash',
    evidenceSnapshotId: null,
    configSnapshotId: null,
    configSnapshotHash: null,
    pageImportId: null,
    pageImportHash: null,
    modelPolicyDigest: 'model-policy-digest',
    executionProductTypeId: 'type-1',
    productTypeConfidence: 0.95,
    productTypeOutcome: 'coherent' as const,
    status: 'running' as const,
    claimedBy: 'worker-a',
    claimedAt: '2025-01-01T00:00:00.000Z',
    leaseExpiresAt: '2025-01-01T00:15:00.000Z',
    startedAt: '2025-01-01T00:00:00.000Z',
    completedAt: null,
    errorMessage: null,
    supersededAt: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeProjection(members: ExecutionEvidenceProjectionMemberV1[]): ExecutionEvidenceProjectionV1 {
  return {
    version: 'execution-evidence-v1',
    cohortId: 'cohort-1',
    batchId: 'batch-1',
    groupingVersion: 'product-family-v1',
    members,
  };
}

function makeParams(
  overrides: Partial<ParityParams> = {},
): ParityParams {
  return {
    run: makeRun(),
    projection: makeProjection([makeMember()]),
    modelPolicyDigest: 'policy-digest-1',
    typeLabelSource: LABEL_SOURCE,
    ...overrides,
  };
}

function makePlanEntry(overrides: Partial<ModelExecutionPlanEntry> = {}): ModelExecutionPlanEntry {
  return {
    operation: 'cohort_title_consolidation',
    stage: 'name_consolidation',
    provider: 'ollama',
    model: 'qwen2.5vl',
    locality: 'local',
    fromOverride: false,
    promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS.cohort_title_consolidation,
    ruleVersion: RULE_VERSIONS.cohort_title_consolidation,
    ...overrides,
  };
}

/** Deep-clone params so tests can mutate a single field. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The frozen snapshot-shaped label source the real parent op would read the
 * Execution Product Type label from (mirrors the ordinal-0 member snapshot's
 * `productTypes`). The run's executionProductTypeId 'type-1' resolves to
 * 'Dry Dog Food'.
 */
const LABEL_SOURCE = {
  productTypes: [
    { id: 'type-1', name: 'Dry Dog Food' },
    { id: 'type-2', name: 'Wet Dog Food' },
  ],
};

type CohortTitleHashParams = Parameters<typeof computeCohortTitleInputHash>[0];
/**
 * The hash params plus the test-only label source. The T-hash is computed
 * with the label RESOLVED THROUGH THE SHARED PRODUCTION BUILDER
 * (`titleExecutionTypeAuthorityFromRun`) — the same authority the prompt
 * consumes — so mutating either the run id or the label source moves the
 * hash AND the prompt together (no independent/duplicated authority).
 */
type ParityParams = CohortTitleHashParams & {
  /**
   * PR13 C1 (issue #30, DECISION-C): the broad H5 policy digest the
   * coordinator used to hash. KEPT as a TEST-ONLY field so the suite can
   * PROVE the hashed model authority is unchanged when ONLY this digest
   * differs (the production params no longer carry it — the operation-
   * specific plan entry is the entire model authority).
   */
  modelPolicyDigest?: string | null;
  typeLabelSource?: { productTypes: Array<{ id: string; name: string }> } | null;
};

/** Strip the test-only label source and resolve the T-hash's
 *  `executionTypeAuthority` through the SHARED production builder (the same
 *  resolution the parent op performs). PR13 C1: the test-only
 *  `modelPolicyDigest` is DROPPED — the hashed model-execution authority is
 *  the frozen plan entry alone, so a differing broad digest cannot change
 *  the T-hash. */
function resolveParams(params: ParityParams): CohortTitleHashParams {
  const { typeLabelSource, modelPolicyDigest: _broadPolicyDigest, ...rest } = params;
  void _broadPolicyDigest; // PR13 C1: the broad policy digest is NOT part of the T-hash.
  const authority = titleExecutionTypeAuthorityFromRun(rest.run, typeLabelSource ?? LABEL_SOURCE);
  return { ...rest, executionTypeAuthority: authority };
}

const hash = (params: ParityParams): string => computeCohortTitleInputHash(resolveParams(params));

/** The coordinator's sibling-input shape derived from the frozen member
 *  authority (mirrors `coordinateGroup`'s signals-ON mapping over the frozen
 *  item views, which are built from the same projection) — so the prompt side
 *  of the parity tests consumes exactly the authority the hash claims. */
function siblingFromAuthority(a: CohortTitleAuthorityMember): CohortSiblingInput {
  return {
    upc: a.productSku ?? '',
    name: a.spreadsheetName,
    expectedName: a.expectedName,
    webTitle: a.webTitle,
    ocrTitle: a.packagingOcrTitle,
    brand: a.brandHint,
    webBrand: a.webBrand,
    ocrWeight: a.ocrWeight,
    ocrFlavor: a.ocrFlavor,
  };
}

/** The cohort prompt the coordinator would build for these hash params — the
 *  Execution Product Type context comes from the SAME shared builder
 *  (`titleExecutionTypeAuthorityFromRun`) the hash resolves its label with. */
function promptForParams(params: ParityParams): string {
  const members = [...params.projection.members]
    .sort((a, b) => a.onboardingItemId.localeCompare(b.onboardingItemId));
  const authority = titleExecutionTypeAuthorityFromRun(params.run, params.typeLabelSource ?? LABEL_SOURCE);
  return buildCohortPrompt(
    members.map(m => siblingFromAuthority(titleAuthorityFromProjectionMember(m))),
    authority.id ? { id: authority.id, label: authority.label } : null,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('computeCohortTitleInputHash — determinism (PR6 C2)', () => {
  it('is deterministic: identical inputs produce the identical hash', () => {
    const base = makeParams();
    expect(hash(base)).toBe(hash(base));
    expect(hash(base)).toBe(hash(clone(base)));
    expect(hash(base).length).toBe(64); // sha256 hex
  });

  it('is stable regardless of input member order (sorted by onboardingItemId)', () => {
    const m1 = makeMember({ onboardingItemId: 'item-a', productSku: 'SKU-A' });
    const m2 = makeMember({ onboardingItemId: 'item-b', productSku: 'SKU-B' });
    const forward = makeParams({ projection: makeProjection([m1, m2]) });
    const shuffled = makeParams({ projection: makeProjection([m2, m1]) });
    expect(hash(forward)).toBe(hash(shuffled));
  });
});

describe('computeCohortTitleInputHash — every frozen-title field is significant (PR6 C2 / DECISION-Q)', () => {
  it('spreadsheetName participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].spreadsheetIdentity.name = 'RAW SALMON 10LB';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('expectedName participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].spreadsheetIdentity.expectedName = 'Salmon 10 lb';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('brandHint participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].spreadsheetIdentity.brandHint = 'OtherBrand';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('webTitle (extraction.title) participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.title = 'Different Web Title';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('webBrand (extraction.brand) participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.brand = 'OtherBrand';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('packagingOcrTitle participates via the packagingOcrData.productName path', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.ocr.packagingOcrData!.productName = 'Different OCR Name';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('packagingOcrTitle participates via the packagingTitle fallback path (no packagingOcrData)', () => {
    const base = makeParams();
    const noOcr = clone(base);
    noOcr.projection.members[0].extraction.ocr.packagingOcrData = null;
    const changed = clone(noOcr);
    changed.projection.members[0].extraction.packagingTitle = 'Different Pouch Title';
    expect(hash(changed)).not.toBe(hash(noOcr));
  });

  it('packagingTitle is inert while packagingOcrData.productName wins (productName ?? packagingTitle)', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.packagingTitle = 'Ignored Pouch Title';
    expect(hash(changed)).toBe(hash(base));
  });

  it('ocrWeight participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.ocr.packagingOcrData!.weight = '10 lb';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('ocrFlavor participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.ocr.packagingOcrData!.flavorVariety = 'Salmon';
    expect(hash(changed)).not.toBe(hash(base));
  });
});

describe('computeCohortTitleInputHash — membership + execution type (PR6 C2)', () => {
  it('a different finalMembershipHash changes the hash', () => {
    const base = makeParams();
    expect(hash(makeParams({ run: makeRun({ finalMembershipHash: 'other-membership-hash' }) }))).not.toBe(hash(base));
  });

  it('NULL finalMembershipHash hashes differently from a value', () => {
    const base = makeParams();
    expect(hash(makeParams({ run: makeRun({ finalMembershipHash: null }) }))).not.toBe(hash(base));
  });

  it('executionProductTypeId change changes the hash', () => {
    const base = makeParams();
    expect(hash(makeParams({ run: makeRun({ executionProductTypeId: 'type-2' }) }))).not.toBe(hash(base));
  });

  it('executionTypeAuthority label change changes the hash (the label is part of the hashed authority — PR6 hardening C)', () => {
    const base = makeParams();
    const labelChanged = clone(base);
    labelChanged.typeLabelSource = { productTypes: [{ id: 'type-1', name: 'Renamed Dry Dog Food' }] };
    expect(hash(labelChanged)).not.toBe(hash(base));
  });

  it('productTypeConfidence change changes the hash', () => {
    const base = makeParams();
    expect(hash(makeParams({ run: makeRun({ productTypeConfidence: 0.5 }) }))).not.toBe(hash(base));
  });

  it('productTypeOutcome change changes the hash', () => {
    const base = makeParams();
    expect(hash(makeParams({ run: makeRun({ productTypeOutcome: 'coherent_with_abstentions' }) }))).not.toBe(hash(base));
  });

  it('a NULL execution type (abstained/conflicted) hashes differently from a value', () => {
    const base = makeParams();
    const abstained = makeParams({
      run: makeRun({ executionProductTypeId: null, productTypeConfidence: null, productTypeOutcome: 'abstained' }),
    });
    expect(hash(abstained)).not.toBe(hash(base));
    expect(hash(makeParams({ run: makeRun({ executionProductTypeId: null }) }))).not.toBe(hash(base));
    expect(hash(makeParams({ run: makeRun({ productTypeOutcome: null }) }))).not.toBe(hash(base));
  });
});

describe('computeCohortTitleInputHash — format rules digest (PR6 C2)', () => {
  it('the FORMAT_RULES digest participates (parameterized internal)', () => {
    const base = makeParams();
    const resolved = resolveParams(base);
    // The public entry point uses the module constant.
    expect(computeCohortTitleInputHashForFormatRules(resolved, FORMAT_RULES)).toBe(hash(base));
    // A simulated constant change alters the hash without mutating the module.
    expect(computeCohortTitleInputHashForFormatRules(resolved, `${FORMAT_RULES}\n- New rule line`)).not.toBe(hash(base));
    expect(computeCohortTitleInputHashForFormatRules(resolved, 'completely different rules')).not.toBe(hash(base));
  });

  it('the title-lint version participates (e09 T8, parameterized internal)', () => {
    const base = makeParams();
    const resolved = resolveParams(base);
    // The public entry point uses the single-sourced module constant.
    expect(computeCohortTitleInputHashForFormatRules(resolved, FORMAT_RULES)).toBe(hash(base));
    // A simulated lint-rule release alters the hash without mutating the module:
    // committed sets produced under a different lint version fail closed (T8).
    expect(
      computeCohortTitleInputHashForFormatRules(resolved, FORMAT_RULES, 'v999'),
    ).not.toBe(hash(base));
  });
});

describe('computeCohortTitleInputHash — model execution authority slice (PR6 C2 / DECISION-P, PR13 C1 / DECISION-C)', () => {
  it('PR13 C1: the broad policy digest does NOT participate — only the digest differs, the hash is UNCHANGED', () => {
    const base = makeParams();
    // The coordinator used to hash the frozen UNBOUND H5 policy digest; the
    // T-hash's model authority is now the frozen plan entry alone. A DIFFERENT
    // broad digest (provider/model/versions fixed) leaves the hash identical.
    expect(hash(makeParams({ modelPolicyDigest: 'other-policy-digest' }))).toBe(hash(base));
    expect(hash(makeParams({ modelPolicyDigest: null }))).toBe(hash(base));
    expect(hash(base).length).toBe(64);
  });

  it('PR13 review R2: the EXECUTED title parameter tuple participates — a temperature-only release changes the T-hash; maxTokens too', () => {
    const base = hash(makeParams());
    // The registry default tuple IS the executed authority (the transport
    // applies it when the caller supplies no override): passing it explicitly
    // must equal the default (identity of the executed authority).
    expect(hash(makeParams({ titleOperationParameters: { temperature: 0.1, maxTokens: null } }))).toBe(base);
    // A parameter-only release (temperature 0.1 → 0.0, prompt/rule/provider/
    // model unchanged) changes the T-hash → cross-parent reuse fails closed.
    expect(hash(makeParams({ titleOperationParameters: { temperature: 0.0, maxTokens: null } }))).not.toBe(base);
    expect(hash(makeParams({ titleOperationParameters: { temperature: 0.1, maxTokens: 200 } }))).not.toBe(base);
  });

  it('PR13 review R2: a parameter change for an UNRELATED operation never changes the title T-hash (only the title tuple is hashed)', () => {
    const base = hash(makeParams());
    // The payload contains ONLY the title operation's tuple and the title
    // op's frozen entry fields: a plan entry carrying a DIFFERENT operation
    // name (whatever that op's parameter contract is, it is never read) with
    // the SAME hashed fields leaves the title hash unchanged.
    const foreignEntry = makePlanEntry({
      operation: 'cohort_page_assignment_parent',
      // Same unrouted hashed fields as the absent fallback (provider/model
      // null via the `?? null` fallback; versions = registry consts) — only
      // the operation NAME differs, and the entry's operation name is never
      // hashed.
      provider: null as any,
      model: null as any,
    });
    expect(hash(makeParams({ titlePlanEntry: foreignEntry }))).toBe(base);
    // And the title tuple stays the only parameter input: an explicit title
    // tuple equal to the registry default is still identity-equal.
    expect(hash(makeParams({
      titlePlanEntry: foreignEntry,
      titleOperationParameters: { temperature: 0.1, maxTokens: null },
    }))).toBe(base);
  });

  it('PR13 review R1 (T2): a FIXED CANONICAL T-hash baseline — the digest-free composition is frozen', () => {
    // Hardcoded value computed once from the deterministic fixture below;
    // any accidental change to the hashed composition (a field entering or
    // leaving the canonical JSON) breaks this test — exactly what a baseline
    // is for. The fixtures above are fully deterministic (fixed strings,
    // no UUIDs), so this value is stable across runs and machines.
    // PR13 review R2: recomputed under the v2 payload (parameters included).
    // Milestone E: recomputed AGAIN under the v2 composition WITH the
    // `sourceProvenance` slice (official-page normalization for the V1-style
    // fixture member) — an intentional, reviewed composition change.
    // e09 B1 (T8): recomputed when `familyTitleConsistencyVersion` joined the
    // hashed composition — the title-consistency gate version now
    // participates in the durable title authority.
    // e09 title-lint (T8): recomputed when `titleLintVersion` joined the
    // hashed composition next to it — lint-rule bumps now invalidate
    // committed sets.
    const baseBaseline = '18c15514b3e421a28e52b5c03eb52cafa6898837ed7d09bb48a52de7659bf02c';
    expect(hash(makeParams())).toBe(baseBaseline);
    // PR6 exclusion doctrine: the BROAD model policy digest is dropped by
    // resolveParams (only the title-plan entry's narrow execution authority
    // participates), so overriding it must leave the frozen baseline unchanged.
    expect(hash(makeParams({ modelPolicyDigest: 'other-policy-digest' }))).toBe(baseBaseline);
  });

  it('the plan entry provider/model/promptTemplateVersion/ruleVersion each participate', () => {
    const base = makeParams();
    expect(hash(makeParams({ titlePlanEntry: makePlanEntry({ provider: 'openai' }) }))).not.toBe(hash(base));
    expect(hash(makeParams({ titlePlanEntry: makePlanEntry({ model: 'gpt-4o' }) }))).not.toBe(hash(base));
    expect(hash(makeParams({ titlePlanEntry: makePlanEntry({ promptTemplateVersion: 'cohort-title-consolidation-prompt-v2' }) }))).not.toBe(hash(base));
    expect(hash(makeParams({ titlePlanEntry: makePlanEntry({ ruleVersion: 'cohort-title-consolidation-rules-v2' }) }))).not.toBe(hash(base));
  });

  it('a titlePlanEntry present vs absent is stable when the entry carries no route (fallback consts)', () => {
    const absent = makeParams();
    // A present entry whose route fields are null (unrouted fallback state)
    // resolves identically to the absent fallback: the version fields come
    // from the registry consts and provider/model fall back to null via
    // `titlePlanEntry?.provider ?? null`.
    const unrouted = makeParams({
      titlePlanEntry: makePlanEntry({
        // The entry type requires string routes; the null-route state is a
        // synthetic edge case proving the `?? null` fallback is stable.
        provider: null as any,
        model: null as any,
      }),
    });
    expect(hash(unrouted)).toBe(hash(absent));
  });

  it('an unrelated plan-entry operation is never the authority (only the title slice fields are read)', () => {
    const titleOp = makeParams({ titlePlanEntry: makePlanEntry({ operation: 'cohort_title_consolidation' }) });
    const otherOp = makeParams({ titlePlanEntry: makePlanEntry({ operation: 'attribute_ranking' }) });
    // Same route + versions, different operation field → identical T-hash:
    // the operation is fixed ('cohort_title_consolidation') and the entry's
    // own operation value is never serialized.
    expect(hash(otherOp)).toBe(hash(titleOp));
  });
});

describe('computeCohortTitleInputHash — exclusions: hash ONLY frozen title authority (PR6 C2 / DECISION-P)', () => {
  it('description, primaryImage, and non-title extraction fields do NOT change the hash', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.description = 'A completely different description';
    changed.projection.members[0].extraction.primaryImage = 'https://img.example/other.jpg';
    changed.projection.members[0].extraction.bulletPoints = ['Changed', 'Bullets'];
    changed.projection.members[0].extraction.searchKeywords = 'different keywords';
    changed.projection.members[0].extraction.customFields = { flavor: 'salmon' };
    changed.projection.members[0].extraction.fieldProvenance = { flavor: 'ocr' };
    changed.projection.members[0].extraction.additionalImages = ['https://img.example/x.jpg'];
    expect(hash(changed)).toBe(hash(base));
  });

  it('evidenceHash (H2 member evidence identity) does NOT change the hash', () => {
    const base = makeParams();
    expect(hash(makeParams({ projection: makeProjection([makeMember({ evidenceHash: 'other-evidence-hash' })]) }))).toBe(hash(base));
  });

  it('ocrInputHash / ocrExecutionDigest (OCR provenance) do NOT change the hash', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.ocr.ocrInputHash = 'different-ocr-input-hash';
    changed.projection.members[0].extraction.ocr.ocrExecutionDigest = 'different-ocr-exec-digest';
    expect(hash(changed)).toBe(hash(base));
  });

  it('item id and rowNumber do NOT change the hash', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].onboardingItemId = 'item-999';
    changed.projection.members[0].spreadsheetIdentity.rowNumber = 12345;
    expect(hash(changed)).toBe(hash(base));
  });

  it('sourcing/ocr outcome and piEvidence do NOT change the hash', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].sourcingDecision = {
      route: 'bundle_to_curation',
      origin: 'automatic_policy',
      acceptedEvidenceAttemptIds: ['a'],
      providerIds: ['web'],
      conflicts: [],
      warnings: [],
      decidedAt: '2025-01-01T00:00:00.000Z',
    };
    changed.projection.members[0].extraction.ocr.outcome = { status: 'succeeded', model: 'qwen2.5vl', imageCount: 1 };
    changed.projection.members[0].extraction.piEvidence = [{ runId: 'r', resultHash: 'h', importRecordId: 'i' }];
    expect(hash(changed)).toBe(hash(base));
  });
});

describe('computeCohortTitleInputHash — PARITY: hash authority == prompt authority (PR6 hardening B/C / P1-3)', () => {
  // Each parity test mutates ONE field of the frozen authority at a time and
  // proves BOTH the T-hash AND the prompt change. The prompt is derived from
  // the SAME authority the hash covers (`titleAuthorityFromProjectionMember`
  // for member fields + `titleExecutionTypeAuthorityFromRun` for the type) —
  // no independently-constructed test authority. The REAL coordinator mapping
  // (one field at a time, through the new-seam entry `ensureCohortTitles`)
  // is covered in cohort-curation-titles.test.ts (Slice 3 transfer).

  it('flavor-only mutation changes BOTH the T-hash AND the prompt content', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.ocr.packagingOcrData!.flavorVariety = 'Salmon';
    expect(hash(changed)).not.toBe(hash(base));
    const promptBase = promptForParams(base);
    const promptChanged = promptForParams(changed);
    expect(promptChanged).not.toBe(promptBase);
    expect(promptBase).toContain('OCR Flavor: "Chicken"');
    expect(promptChanged).toContain('OCR Flavor: "Salmon"');
    expect(promptChanged).not.toContain('OCR Flavor: "Chicken"');
  });

  it('weight-only mutation changes BOTH the T-hash AND the prompt content', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.ocr.packagingOcrData!.weight = '10 lb';
    expect(hash(changed)).not.toBe(hash(base));
    expect(promptForParams(base)).toContain('OCR Weight: "5 lb"');
    const promptChanged = promptForParams(changed);
    expect(promptChanged).not.toBe(promptForParams(base));
    expect(promptChanged).toContain('OCR Weight: "10 lb"');
  });

  it('webBrand-only mutation changes BOTH the T-hash AND the prompt content (PR6 hardening C)', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.brand = 'AnotherBrand';
    expect(hash(changed)).not.toBe(hash(base));
    const promptBase = promptForParams(base);
    const promptChanged = promptForParams(changed);
    expect(promptChanged).not.toBe(promptBase);
    expect(promptBase).toContain('Web Brand: "PawCo"');
    expect(promptChanged).toContain('Web Brand: "AnotherBrand"');
    expect(promptChanged).not.toContain('Web Brand: "PawCo"');
  });

  it('truncation parity: a suffix-only mutation BEYOND the prompt cutoffs changes NEITHER the T-hash NOR the prompt (PR6 hardening C)', () => {
    const base = makeParams();
    // webBrand is truncated at 200 chars in the prompt; the hash consumes the
    // SAME normalized value (titleAuthorityFromProjectionMember applies the
    // shared truncation) — so mutating chars 200+ must be inert for both.
    const longBrand = `Brand-${'x'.repeat(250)}`;
    const changed = makeParams();
    changed.projection.members[0].extraction.brand = longBrand;
    expect(hash(changed)).not.toBe(hash(base));
    // Suffix-only mutation beyond the 200-char cutoff (same first 200 chars):
    const suffixMutated = makeParams();
    suffixMutated.projection.members[0].extraction.brand = `${longBrand.slice(0, 200)}-DIFFERENT-SUFFIX`;
    expect(hash(suffixMutated)).toBe(hash(changed));
    expect(promptForParams(suffixMutated)).toBe(promptForParams(changed));
    // Same for an OCR signal (500-char cutoff):
    const longWeight = `${'1'.repeat(600)} lb`;
    const w1 = makeParams();
    w1.projection.members[0].extraction.ocr.packagingOcrData!.weight = longWeight;
    const w2 = makeParams();
    w2.projection.members[0].extraction.ocr.packagingOcrData!.weight = `${longWeight.slice(0, 500)}-DIFFERENT`;
    expect(hash(w2)).toBe(hash(w1));
    expect(promptForParams(w2)).toBe(promptForParams(w1));
  });

  it('id-only mutation changes BOTH the T-hash AND the prompt (the prompt renders the id + its derived label)', () => {
    const base = makeParams();
    const idMutated = makeParams({ run: makeRun({ executionProductTypeId: 'type-2' }) });
    expect(hash(idMutated)).not.toBe(hash(base));
    const promptBase = promptForParams(base);
    const promptChanged = promptForParams(idMutated);
    expect(promptChanged).not.toBe(promptBase);
    expect(promptBase).toContain('Product Type Context: "type-1 (Dry Dog Food)"');
    expect(promptChanged).toContain('Product Type Context: "type-2 (Wet Dog Food)"');
  });

  it('label-only mutation (same id, renamed option) changes BOTH the T-hash AND the prompt (PR6 hardening C)', () => {
    const base = makeParams();
    const labelMutated = clone(base);
    labelMutated.typeLabelSource = {
      productTypes: [
        { id: 'type-1', name: 'Dry Dog Food (Renamed)' },
        { id: 'type-2', name: 'Wet Dog Food' },
      ],
    };
    expect(hash(labelMutated)).not.toBe(hash(base));
    const promptBase = promptForParams(base);
    const promptChanged = promptForParams(labelMutated);
    expect(promptChanged).not.toBe(promptBase);
    expect(promptBase).toContain('Product Type Context: "type-1 (Dry Dog Food)"');
    expect(promptChanged).toContain('Product Type Context: "type-1 (Dry Dog Food (Renamed))"');
  });

  it('absent OCR weight/flavor renders NO prompt segments while still participating in the hash (NULL vs value)', () => {
    const noOcr = clone(makeParams());
    noOcr.projection.members[0].extraction.ocr.packagingOcrData = null;
    const prompt = promptForParams(noOcr);
    expect(prompt).not.toContain('OCR Weight:');
    expect(prompt).not.toContain('OCR Flavor:');
    // The hash changes (NULL hashes differently from a value) and the prompt
    // drops the segments — hash and prompt authority move together.
    expect(hash(noOcr)).not.toBe(hash(makeParams()));
  });
});

describe('titleAuthorityFromProjectionMember — the pure builder (PR6 C2)', () => {
  it('returns the exact frozen title-relevant slice', () => {
    const member = makeMember();
    expect(titleAuthorityFromProjectionMember(member)).toEqual({
      productSku: 'SKU-1',
      spreadsheetName: 'RAW CHKN 5LB',
      expectedName: 'Chicken 5 lb',
      brandHint: 'PawCo',
      webTitle: 'PawCo Chicken Recipe 5 lb',
      webBrand: 'PawCo',
      packagingOcrTitle: 'PawCo Chicken Recipe',
      ocrWeight: '5 lb',
      ocrFlavor: 'Chicken',
      // Milestone E: official-page provenance normalization for V1 members.
      sourceProvenance: {
        itemSourceType: 'official_page',
        sourceUrl: 'https://brand.example/p1',
        extractionSourceType: 'official_page',
        extractionSourceUrl: 'https://brand.example/p1',
        extractionMethod: '',
        sourcingGenerationId: null,
        acceptedEvidenceAttemptIds: [],
        providerIds: [],
        distributorEvidenceHash: null,
      },
    });
  });

  it('falls back to packagingTitle and nulls when OCR data is absent', () => {
    const member = makeMember();
    member.extraction.ocr.packagingOcrData = null;
    expect(titleAuthorityFromProjectionMember(member)).toEqual({
      productSku: 'SKU-1',
      spreadsheetName: 'RAW CHKN 5LB',
      expectedName: 'Chicken 5 lb',
      brandHint: 'PawCo',
      webTitle: 'PawCo Chicken Recipe 5 lb',
      webBrand: 'PawCo',
      packagingOcrTitle: 'PawCo Chicken 5 lb Pouch',
      ocrWeight: null,
      ocrFlavor: null,
      sourceProvenance: {
        itemSourceType: 'official_page',
        sourceUrl: 'https://brand.example/p1',
        extractionSourceType: 'official_page',
        extractionSourceUrl: 'https://brand.example/p1',
        extractionMethod: '',
        sourcingGenerationId: null,
        acceptedEvidenceAttemptIds: [],
        providerIds: [],
        distributorEvidenceHash: null,
      },
    });
  });
});

describe('Milestone E — source-kind/provenance drift (title input identity)', () => {
  /** A V2 member with distributor provenance (the exact V2 shape cohorts.ts adds). */
  function distributorMember(
    overrides: Partial<ExecutionEvidenceProjectionMemberV2> = {},
  ): ExecutionEvidenceProjectionMemberV2 {
    return {
      ...makeMember(),
      itemSourceType: 'distributor_record',
      extractionSourceType: 'distributor_record',
      extractionMethod: 'distributor_record_v1',
      sourcingGenerationId: 'gen-1',
      acceptedEvidenceAttemptIds: ['att-1'],
      acceptedProviderIds: ['phillips'],
      distributorEvidenceHash: 'a'.repeat(64),
      extraction: {
        ...makeMember().extraction,
        distributorSku: 'DSKU-1',
        manufacturerPartNumber: 'MPN-1',
        variantAttributes: { flavor: 'chicken' },
      },
      ...overrides,
    } as ExecutionEvidenceProjectionMemberV2;
  }

  function projectionWithMembers(members: Array<ExecutionEvidenceProjectionMemberV1 | ExecutionEvidenceProjectionMemberV2>) {
    return makeProjection(members as ExecutionEvidenceProjectionMemberV1[]);
  }

  it('distributor provenance changes the T-hash vs the same member as official-page', () => {
    const official = makeParams({ projection: projectionWithMembers([makeMember()]) });
    const distributor = makeParams({ projection: projectionWithMembers([distributorMember()]) });
    expect(computeCohortTitleInputHash(distributor)).not.toBe(computeCohortTitleInputHash(official));
  });

  it('source-kind drift (official vs distributor) with identical title text still changes identity', () => {
    const official = makeParams({ projection: projectionWithMembers([makeMember()]) });
    const distributorSameText = makeParams({
      projection: projectionWithMembers([distributorMember()]),
    });
    // The title text is identical (makeMember supplies it); only the source
    // kind differs — the hash MUST differ (ME input-identity rule).
    expect(computeCohortTitleInputHash(distributorSameText)).not.toBe(computeCohortTitleInputHash(official));
  });

  it('generation drift changes the T-hash for distributor members', () => {
    const g1 = makeParams({ projection: projectionWithMembers([distributorMember({ sourcingGenerationId: 'gen-1' })]) });
    const g2 = makeParams({ projection: projectionWithMembers([distributorMember({ sourcingGenerationId: 'gen-2' })]) });
    expect(computeCohortTitleInputHash(g2)).not.toBe(computeCohortTitleInputHash(g1));
  });

  it('accepted-attempt-set drift changes the T-hash for distributor members', () => {
    const a1 = makeParams({ projection: projectionWithMembers([distributorMember({ acceptedEvidenceAttemptIds: ['att-1'] })]) });
    const a2 = makeParams({ projection: projectionWithMembers([distributorMember({ acceptedEvidenceAttemptIds: ['att-1', 'att-2'] })]) });
    expect(computeCohortTitleInputHash(a2)).not.toBe(computeCohortTitleInputHash(a1));
  });

  it('distributor evidence-hash drift changes the T-hash for distributor members', () => {
    const h1 = makeParams({ projection: projectionWithMembers([distributorMember({ distributorEvidenceHash: 'a'.repeat(64) })]) });
    const h2 = makeParams({ projection: projectionWithMembers([distributorMember({ distributorEvidenceHash: 'b'.repeat(64) })]) });
    expect(computeCohortTitleInputHash(h2)).not.toBe(computeCohortTitleInputHash(h1));
  });

  it('a V1 member (no source fields) hashes identically to a normalized official-page V2 member', () => {
    // V1 normalize compatibility: the same member WITHOUT the V2 source fields
    // and a V2 member explicitly set to official_page with empty provenance
    // must hash identically (V1 adaptation contract).
    const v1 = makeParams({ projection: projectionWithMembers([makeMember()]) });
    const v2Official = makeParams({
      projection: projectionWithMembers([
        distributorMember({
          itemSourceType: 'official_page',
          extractionSourceType: 'official_page',
          extractionMethod: '',
          sourcingGenerationId: null,
          acceptedEvidenceAttemptIds: [],
          acceptedProviderIds: [],
          distributorEvidenceHash: null,
        }),
      ]),
    });
    expect(computeCohortTitleInputHash(v2Official)).toBe(computeCohortTitleInputHash(v1));
  });
});

describe('Amendment B merchandising fields and the title hash (M5b-1)', () => {
  it('T-hash is STABLE across merchandising-field changes (documented title-authority-only design)', () => {
    // The T-hash deliberately excludes description/bulletPoints (cohort-title-
    // hash.ts module doc: "NO non-title projection fields: description,
    // bulletPoints ..."). A v2 merchandising change must NOT invalidate an
    // approved curated title.
    const base = makeParams();
    const changedDesc = clone(base);
    changedDesc.projection.members[0].extraction.description = 'Different merchandising description';
    changedDesc.projection.members[0].extraction.bulletPoints = ['A', 'B', 'C'];
    expect(hash(changedDesc)).toBe(hash(base));
  });

  it('the frozen V2 member schema parses pre-merchandising v2 bytes with safe defaults (historical snapshot parsing stable)', () => {
    const v2Member = {
      ...makeMember(),
      version: 'execution-evidence-v2',
      itemSourceType: 'distributor_record',
      extractionSourceType: 'distributor_record',
      extractionMethod: 'distributor_record_v2',
      sourcingGenerationId: 'gen-1',
      acceptedEvidenceAttemptIds: ['a1'],
      acceptedProviderIds: ['phillips'],
      distributorEvidenceHash: 'a'.repeat(64),
      extraction: {
        ...makeMember().extraction,
        distributorSku: 'DSKU-1',
        manufacturerPartNumber: 'MPN-1',
        variantAttributes: {},
        // NO merchandising fields — a pre-M5b-1 v2 snapshot
      },
    };
    const parsed = ExecutionEvidenceProjectionMemberV2Schema.parse(v2Member);
    expect(parsed.extraction.distributorCategory).toBeNull();
    expect(parsed.extraction.dimensions).toBeNull();
    expect(parsed.extraction.casePack).toBeNull();
    expect(parsed.extraction.unitOfMeasure).toBeNull();
    expect(parsed.extraction.ingredients).toBeNull();
    expect(parsed.extraction.merchandisingProvenance).toEqual({});
  });

  it('the cohort content-addressed member hash CHANGES when a v2 merchandising field changes', () => {
    // The member evidence hash (computeExtractionHash) covers the full
    // extractionData — including the Amendment B merchandising fields — so a
    // merchandising change produces a NEW cohort snapshot (no stale reuse).
    const baseMember = {
      ...makeMember(),
      version: 'execution-evidence-v2',
      itemSourceType: 'distributor_record',
      extractionSourceType: 'distributor_record',
      extractionMethod: 'distributor_record_v2',
      sourcingGenerationId: 'gen-1',
      acceptedEvidenceAttemptIds: ['a1'],
      acceptedProviderIds: ['phillips'],
      distributorEvidenceHash: 'a'.repeat(64),
      extraction: {
        ...makeMember().extraction,
        distributorSku: 'DSKU-1',
        manufacturerPartNumber: 'MPN-1',
        variantAttributes: {},
        distributorCategory: 'Dog Supplies',
        dimensions: '12 x 8 x 4 in',
        casePack: '6',
        unitOfMeasure: 'EA',
        ingredients: 'Chicken, rice',
        merchandisingProvenance: {},
      },
    };
    const withMerch = ExecutionEvidenceProjectionMemberV2Schema.parse(baseMember);
    const changed = ExecutionEvidenceProjectionMemberV2Schema.parse({
      ...baseMember,
      extraction: { ...baseMember.extraction, distributorCategory: 'Cat Supplies' },
    });
    expect(hashCanonicalJson(changed)).not.toBe(hashCanonicalJson(withMerch));
    expect(hashCanonicalJson(changed)).not.toBe(hashCanonicalJson(baseMember.extraction));
  });
});
