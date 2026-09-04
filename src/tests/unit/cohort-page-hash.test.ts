import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import {
  buildCohortPageAuthorityBundle,
  computeCohortPageInputHash,
  pageAuthorityFromProjectionMember,
  pageAuthorityMemberToSnapshot,
  PAGE_AUTHORITY_TRUNCATION,
  normalizePageAuthorityString,
} from '../../onboarding/cohort-page-hash';
import { buildPrompt, coordinateCohortPagesCore } from '../../classification/cohort-page-coordinator';
import { buildModelExecutionPlan, buildRuntimeRuleVersions } from '../../classification/model-operation-registry';
import type { RuntimeClassificationSnapshot } from '../../classification/runtime-snapshot';
import { titleExecutionTypeAuthorityFromRun } from '../../onboarding/cohort-title-hash';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import type {
  CohortRun,
  ExecutionEvidenceProjectionV1,
  ExecutionEvidenceProjectionMemberV1,
  ExecutionEvidenceProjectionMemberV2,
} from '../../shared/schemas/cohorts';

/**
 * PR7 C2 (issue #30): the canonical Page input hash — PURE, over the frozen
 * Page authority ONLY.
 *
 * Every frozen-page field must be significant; every excluded field must be
 * inert; membership + execution type (incl. NULL vs value) + the
 * operation-specific model authority must participate; the hash must be
 * deterministic and member-order-stable (sorted by sku); page and
 * species/healthConcern order must be normalized; truncation parity
 * (hardening-D) must hold against the rendered authority slice.
 */

const mocks = {
  getLlmConfigForTask: () => null as Record<string, string> | null,
};

/** The exact prompt strings the mocked transport received — the parent path's
 *  transport call (`coordinateCohortPagesCore`) passes the real prompt string
 *  it would send to the model, so the captured text is the ACTUAL transport
 *  prompt (review R1 B2/T5). */
let capturedTransportPrompts: string[] = [];

// Scoped to THIS file; auto-restored after it completes (PR6 review round 2
// pattern) so co-running with llm-client suites never leaks.
mock.module('../../onboarding/llm-client', () => ({
  getLlmConfigForTask: () => mocks.getLlmConfigForTask(),
  callLlmForTaskWithProvenance: (_task: string, prompt: string) => {
    capturedTransportPrompts.push(prompt);
    return Promise.resolve({
      content: '{}',
      callId: 'permuted-call',
      provider: 'ollama',
      model: 'qwen2.5vl',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
  },
}));

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
      name: 'Acme Pate Chicken',
      expectedName: 'Chicken Pate',
      brandHint: 'Acme',
      departmentHint: 'Food',
      price: '19.99',
      quantity: 1,
      rowNumber: 2,
      upc: 'SKU-1',
    },
    extraction: {
      title: 'Acme Pate Chicken 5.5oz',
      description: 'Grain-free wet food for adult cats.',
      brand: 'Acme',
      weight: '5.5 oz',
      bulletPoints: ['Bullet 1'],
      searchKeywords: 'cat food',
      primaryImage: 'https://img.example/p1.jpg',
      additionalImages: [],
      customFields: {},
      fieldProvenance: {},
      manualEvidenceAttestationId: null,
      manualReferenceUrl: null,
      packagingTitle: 'Acme Pate Chicken Pouch',
      ocr: {
        outcome: null,
        packagingOcrData: {
          productName: 'Acme Pate Chicken',
          brand: 'Acme',
          species: ['Cat'],
          upc: null,
          flavorVariety: 'Chicken',
          color: null,
          material: null,
          size: null,
          weight: '5.5 oz',
          count: null,
          lifeStage: 'Adult',
          breedSize: null,
          productForm: 'Pate',
          healthConcernFunction: ['Hairball'],
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

const PAGE_PLAN = {
  pages: [
    { id: 'cat-wet', name: 'Cat Food Wet', parentName: 'Cat Food Shop All' },
    { id: 'cat-shop', name: 'Cat Food Shop All', parentName: null },
  ],
  selectionMode: 'multiple' as const,
  maxPages: 5,
};

type BuildBundleParams = Parameters<typeof buildCohortPageAuthorityBundle>[0];

function makeParams(
  overrides: Partial<BuildBundleParams> = {},
): BuildBundleParams {
  return {
    run: makeRun(),
    projection: makeProjection([makeMember()]),
    pagePlan: PAGE_PLAN,
    executionTypeAuthority: titleExecutionTypeAuthorityFromRun(makeRun(), LABEL_SOURCE),
    modelExecutionAuthority: {
      provider: 'ollama',
      model: 'qwen2.5vl',
      promptTemplateVersion: 'cohort-page-assignment-parent-prompt-v2',
      ruleVersion: 'cohort-page-assignment-parent-rules-v2',
    },
    ...overrides,
  };
}

/** Deep-clone params so tests can mutate a single field. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The frozen snapshot-shaped label source the parent op would read the
 *  Execution Product Type label from. The run's executionProductTypeId
 *  'type-1' resolves to 'Dry Dog Food'. */
const LABEL_SOURCE = {
  productTypes: [
    { id: 'type-1', name: 'Dry Dog Food' },
    { id: 'type-2', name: 'Wet Dog Food' },
  ],
};

// PR7 review R1 (B2): the P-hash consumes the canonical authority bundle — the
// SAME bundle the parent v2 prompt renders.
const hash = (params: BuildBundleParams): string =>
  computeCohortPageInputHash(buildCohortPageAuthorityBundle(params));

/** The ACTUAL v2 parent prompt (PR7 review R1 B2/T5): rendered from the
 *  canonical authority bundle exactly the way the parent transport does —
 *  bundle members → `ProductLineItemSnapshot[]`, bundle pages/selection, and
 *  the bundle's Execution Type authority as the v2 type context. */
function renderParentPrompt(params: BuildBundleParams): string {
  const bundle = buildCohortPageAuthorityBundle(params);
  return buildPrompt(
    {
      groupId: 'group-parity',
      products: bundle.members.map(pageAuthorityMemberToSnapshot),
      pages: bundle.pages,
      selectionMode: bundle.selection.selectionMode,
      maxPages: bundle.selection.maxPages,
    },
    { executionTypeContext: bundle.executionTypeAuthority },
  );
}

/** Drive the ACTUAL parent transport (`coordinateCohortPagesCore`) with the
 *  bundle-derived products + the bundle's Execution Type authority and return
 *  the exact prompt string the transport receives. */
async function transportPromptFor(params: BuildBundleParams): Promise<string> {
  const bundle = buildCohortPageAuthorityBundle(params);
  mocks.getLlmConfigForTask = () => ({
    provider: 'ollama',
    model: 'qwen2.5vl',
    apiKey: 'k',
    baseUrl: 'http://127.0.0.1:11434',
  });
  capturedTransportPrompts = [];
  await coordinateCohortPagesCore(
    {
      groupId: 'group-permutation',
      products: bundle.members.map(pageAuthorityMemberToSnapshot),
      pages: bundle.pages,
      selectionMode: bundle.selection.selectionMode,
      maxPages: bundle.selection.maxPages,
    },
    { executionTypeContext: bundle.executionTypeAuthority },
  );
  expect(capturedTransportPrompts).toHaveLength(1);
  return capturedTransportPrompts[0];
}

let workspacePath: string;

beforeAll(() => {
  workspacePath = path.join(os.tmpdir(), `baystate-cms-page-hash-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
});

afterAll(() => {
  closeDb();
  try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('computeCohortPageInputHash — determinism (PR7 C2)', () => {
  it('is deterministic: identical inputs produce the identical hash', () => {
    const base = makeParams();
    expect(hash(base)).toBe(hash(base));
    expect(hash(base)).toBe(hash(clone(base)));
    expect(hash(base).length).toBe(64); // sha256 hex
  });

  it('is stable regardless of input member order (sorted by sku)', () => {
    const m1 = makeMember({ productSku: 'SKU-A' });
    const m2 = makeMember({ productSku: 'SKU-B' });
    const forward = makeParams({ projection: makeProjection([m1, m2]) });
    const shuffled = makeParams({ projection: makeProjection([m2, m1]) });
    expect(hash(forward)).toBe(hash(shuffled));
  });

  it('normalizes species, healthConcern, and page order', () => {
    const base = makeParams();
    // Species content identical, array ORDER flipped.
    const speciesOrdered = clone(base);
    speciesOrdered.projection.members[0].extraction.ocr.packagingOcrData!.species = ['Cat', 'Dog'];
    const speciesReversed = clone(speciesOrdered);
    speciesReversed.projection.members[0].extraction.ocr.packagingOcrData!.species = ['Dog', 'Cat'];
    expect(hash(speciesReversed)).toBe(hash(speciesOrdered));
    // healthConcern content identical, array ORDER flipped.
    const healthOrdered = clone(base);
    healthOrdered.projection.members[0].extraction.ocr.packagingOcrData!.healthConcernFunction = ['Hairball', 'Skin'];
    const healthReversed = clone(healthOrdered);
    healthReversed.projection.members[0].extraction.ocr.packagingOcrData!.healthConcernFunction = ['Skin', 'Hairball'];
    expect(hash(healthReversed)).toBe(hash(healthOrdered));
    // Page list content identical, ORDER flipped (sorted by id by construction).
    const pagesReversed = makeParams({
      pagePlan: { ...PAGE_PLAN, pages: [...PAGE_PLAN.pages].reverse() },
    });
    expect(hash(pagesReversed)).toBe(hash(base));
  });
});

describe('computeCohortPageInputHash — every frozen-page field is significant (PR7 C2)', () => {
  it('spreadsheet name participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].spreadsheetIdentity.name = 'Acme Pate Salmon';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('webTitle (extraction.title) participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.title = 'Different Web Title';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('brand (spreadsheet brandHint) participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].spreadsheetIdentity.brandHint = 'OtherBrand';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('description participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.description = 'A different description';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('OCR species participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.ocr.packagingOcrData!.species = ['Dog'];
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('OCR flavor participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.ocr.packagingOcrData!.flavorVariety = 'Salmon';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('OCR life stage participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.ocr.packagingOcrData!.lifeStage = 'Kitten';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('OCR product form participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.ocr.packagingOcrData!.productForm = 'Gravy';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('OCR health concern participates', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.ocr.packagingOcrData!.healthConcernFunction = ['Skin'];
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('a NULL OCR signal hashes differently from a value', () => {
    const base = makeParams();
    const noOcr = clone(base);
    noOcr.projection.members[0].extraction.ocr.packagingOcrData = null;
    expect(hash(noOcr)).not.toBe(hash(base));
  });
});

describe('computeCohortPageInputHash — membership + page plan + execution type (PR7 C2)', () => {
  it('a different member SKU set changes the hash', () => {
    const base = makeParams();
    const otherMember = makeParams({ projection: makeProjection([makeMember({ productSku: 'SKU-OTHER' })]) });
    expect(hash(otherMember)).not.toBe(hash(base));
  });

  it('a NULL productSku member (empty-sku) changes the hash', () => {
    const base = makeParams();
    const nullSku = makeParams({ projection: makeProjection([makeMember({ productSku: null })]) });
    expect(hash(nullSku)).not.toBe(hash(base));
  });

  it('page list membership and parentName participate', () => {
    const base = makeParams();
    expect(hash(makeParams({
      pagePlan: { ...PAGE_PLAN, pages: [...PAGE_PLAN.pages, { id: 'cat-treats', name: 'Cat Treats', parentName: null }] },
    }))).not.toBe(hash(base));
    expect(hash(makeParams({
      pagePlan: { ...PAGE_PLAN, pages: PAGE_PLAN.pages.map(p => p.id === 'cat-wet' ? { ...p, parentName: 'Renamed Parent' } : p) },
    }))).not.toBe(hash(base));
  });

  it('selectionMode and maxPages participate', () => {
    const base = makeParams();
    expect(hash(makeParams({ pagePlan: { ...PAGE_PLAN, selectionMode: 'single' } }))).not.toBe(hash(base));
    expect(hash(makeParams({ pagePlan: { ...PAGE_PLAN, maxPages: 3 } }))).not.toBe(hash(base));
  });

  it('executionProductTypeId / confidence / outcome changes change the hash', () => {
    const base = makeParams();
    expect(hash(makeParams({ executionTypeAuthority: { id: 'type-2', label: 'Wet Dog Food', confidence: 0.9, outcome: 'coherent' } }))).not.toBe(hash(base));
    expect(hash(makeParams({ executionTypeAuthority: { id: 'type-1', label: 'Dry Dog Food', confidence: 0.5, outcome: 'coherent' } }))).not.toBe(hash(base));
    expect(hash(makeParams({ executionTypeAuthority: { id: 'type-1', label: 'Dry Dog Food', confidence: 0.95, outcome: 'coherent_with_abstentions' } }))).not.toBe(hash(base));
  });

  it('a NULL execution type (abstained/conflicted) hashes differently from a value', () => {
    const base = makeParams();
    expect(hash(makeParams({ executionTypeAuthority: null }))).not.toBe(hash(base));
    // The run-fallback path (absent authority → run fields) matches the
    // explicit null authority for an abstained run.
    const abstainedRun = makeRun({ executionProductTypeId: null, productTypeConfidence: null, productTypeOutcome: 'abstained' });
    const viaRun = makeParams({ run: abstainedRun, executionTypeAuthority: undefined });
    const viaNull = makeParams({ run: abstainedRun, executionTypeAuthority: null });
    expect(hash(viaRun)).toBe(hash(viaNull));
  });

  it('execution type label participates (the label is part of the hashed authority)', () => {
    const base = makeParams();
    expect(hash(makeParams({
      executionTypeAuthority: { id: 'type-1', label: 'Renamed Dry Dog Food', confidence: 0.95, outcome: 'coherent' },
    }))).not.toBe(hash(base));
  });
});

describe('computeCohortPageInputHash — model-EXECUTION authority participation (PR7 C2 / DECISION-B + review R2 F2c + round-3 P1)', () => {
  it('modelExecutionAuthority provider/model each participate; null hashes differently from a value', () => {
    const base = makeParams();
    expect(hash(makeParams({ modelExecutionAuthority: { provider: 'openai', model: 'gpt-4o-mini', promptTemplateVersion: 'cohort-page-assignment-parent-prompt-v2', ruleVersion: 'cohort-page-assignment-parent-rules-v2' } }))).not.toBe(hash(base));
    expect(hash(makeParams({ modelExecutionAuthority: { provider: 'ollama', model: 'gemma4:12b-mlx', promptTemplateVersion: 'cohort-page-assignment-parent-prompt-v2', ruleVersion: 'cohort-page-assignment-parent-rules-v2' } }))).not.toBe(hash(base));
    expect(hash(makeParams({ modelExecutionAuthority: null }))).not.toBe(hash(base));
  });

  it('the rule version participates (a different frozen rule version changes the hash)', () => {
    const base = makeParams();
    expect(hash(makeParams({ modelExecutionAuthority: { provider: 'ollama', model: 'qwen2.5vl', promptTemplateVersion: 'cohort-page-assignment-parent-prompt-v2', ruleVersion: 'cohort-page-assignment-parent-rules-v1' } }))).not.toBe(hash(base));
  });

  it('round-3 P1: the PROMPT-TEMPLATE version participates independently — a prompt bump changes the P-hash even when rules/provider/model are unchanged', () => {
    const base = makeParams();
    // The content-addressing invariant: any authority capable of changing the
    // Page decision (the prompt text) must change the P-hash. v2 -> v3 with
    // rules + provider + model unchanged MUST change the hash.
    expect(hash(makeParams({ modelExecutionAuthority: { provider: 'ollama', model: 'qwen2.5vl', promptTemplateVersion: 'cohort-page-assignment-parent-prompt-v3', ruleVersion: 'cohort-page-assignment-parent-rules-v2' } }))).not.toBe(hash(base));
  });
});

describe('computeCohortPageInputHash — exclusions: hash ONLY frozen page authority (PR7 C2)', () => {
  it('non-page projection fields do NOT change the hash', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.bulletPoints = ['Changed'];
    changed.projection.members[0].extraction.searchKeywords = 'different';
    changed.projection.members[0].extraction.customFields = { flavor: 'salmon' };
    changed.projection.members[0].extraction.fieldProvenance = { flavor: 'ocr' };
    changed.projection.members[0].extraction.primaryImage = 'https://img.example/other.jpg';
    changed.projection.members[0].extraction.weight = '10 lb';
    changed.projection.members[0].extraction.ocr.packagingOcrData!.dietaryLabels = ['Grain Free'];
    expect(hash(changed)).toBe(hash(base));
  });

  it('evidenceHash / ocrInputHash / ocrExecutionDigest / item id / rowNumber do NOT change the hash', () => {
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].evidenceHash = 'other-evidence-hash';
    changed.projection.members[0].extraction.ocr.ocrInputHash = 'different-ocr-input-hash';
    changed.projection.members[0].extraction.ocr.ocrExecutionDigest = 'different-ocr-exec-digest';
    changed.projection.members[0].onboardingItemId = 'item-999';
    changed.projection.members[0].spreadsheetIdentity.rowNumber = 12345;
    expect(hash(changed)).toBe(hash(base));
  });

  it('modelPolicyDigest is NOT part of the hash (operation-specific authority only)', () => {
    const base = makeParams();
    const changed = makeParams({ run: makeRun({ modelPolicyDigest: 'different-policy-digest' }) });
    expect(hash(changed)).toBe(hash(base));
  });
});

describe('computeCohortPageInputHash — PARITY: hash authority == rendered authority (PR7 C2 / hardening-D + review R1 B2)', () => {
  /** A two-member bundle so the rendered parent prompt is a realistic group
   *  prompt (the production group path always sends >= 2 products). */
  function twoMembers(overrides: Partial<BuildBundleParams> = {}): BuildBundleParams {
    const params = makeParams(overrides);
    params.projection = makeProjection([
      params.projection.members[0],
      makeMember({ onboardingItemId: 'item-2', productSku: 'SKU-2' }),
    ]);
    return params;
  }

  it('truncation parity: a suffix-only mutation BEYOND the 200/500/1500 cutoffs changes NEITHER the P-hash NOR the FULL rendered v2 parent prompt', () => {
    const base = twoMembers();

    // Brand cut at 200 chars.
    const longBrand = `Brand-${'x'.repeat(250)}`;
    const b1 = clone(base);
    b1.projection.members[0].spreadsheetIdentity.brandHint = longBrand;
    const b2 = clone(b1);
    b2.projection.members[0].spreadsheetIdentity.brandHint = `${longBrand.slice(0, 200)}-DIFFERENT-SUFFIX`;
    expect(hash(b2)).toBe(hash(b1));
    expect(renderParentPrompt(b2)).toBe(renderParentPrompt(b1));

    // Name cut at 500 chars.
    const longName = `Name-${'y'.repeat(550)}`;
    const n1 = clone(base);
    n1.projection.members[0].spreadsheetIdentity.name = longName;
    const n2 = clone(n1);
    n2.projection.members[0].spreadsheetIdentity.name = `${longName.slice(0, 500)}-DIFFERENT-SUFFIX`;
    expect(hash(n2)).toBe(hash(n1));
    expect(renderParentPrompt(n2)).toBe(renderParentPrompt(n1));

    // Web title cut at 500 chars.
    const longWebTitle = `Web-${'z'.repeat(550)}`;
    const w1 = clone(base);
    w1.projection.members[0].extraction.title = longWebTitle;
    const w2 = clone(w1);
    w2.projection.members[0].extraction.title = `${longWebTitle.slice(0, 500)}-DIFFERENT-SUFFIX`;
    expect(hash(w2)).toBe(hash(w1));
    expect(renderParentPrompt(w2)).toBe(renderParentPrompt(w1));

    // Description cut at 1500 chars.
    const longDescription = `Description-${'d'.repeat(1600)}`;
    const d1 = clone(base);
    d1.projection.members[0].extraction.description = longDescription;
    const d2 = clone(d1);
    d2.projection.members[0].extraction.description = `${longDescription.slice(0, 1500)}-DIFFERENT-SUFFIX`;
    expect(hash(d2)).toBe(hash(d1));
    expect(renderParentPrompt(d2)).toBe(renderParentPrompt(d1));
  });

  it('a within-cutoff mutation changes BOTH the P-hash AND the full rendered v2 prompt', () => {
    const base = twoMembers();
    const changed = clone(base);
    changed.projection.members[0].spreadsheetIdentity.brandHint = 'OtherBrand';
    expect(hash(changed)).not.toBe(hash(base));
    expect(renderParentPrompt(changed)).not.toBe(renderParentPrompt(base));
  });

  it('PERMUTATION parity (review R1 B2): member/page/OCR-array/species order changes NEITHER the P-hash NOR the actual transport prompt string', async () => {
    const memberA = makeMember({ onboardingItemId: 'item-A', productSku: 'SKU-A' });
    memberA.spreadsheetIdentity.name = 'Acme Pate Chicken';
    memberA.extraction.title = 'Acme Pate Chicken 5.5oz';
    memberA.extraction.description = 'Grain-free wet food for adult cats.';
    memberA.extraction.ocr.packagingOcrData!.species = ['Cat', 'Kitten'];
    memberA.extraction.ocr.packagingOcrData!.healthConcernFunction = ['Hairball', 'Skin'];
    const memberB = makeMember({ onboardingItemId: 'item-B', productSku: 'SKU-B' });
    memberB.spreadsheetIdentity.name = 'Acme Pate Salmon';
    memberB.extraction.title = 'Acme Pate Salmon 5.5oz';
    memberB.extraction.description = 'Salmon recipe wet food for adult cats.';
    memberB.extraction.ocr.packagingOcrData!.species = ['Kitten', 'Cat'];
    memberB.extraction.ocr.packagingOcrData!.healthConcernFunction = ['Skin', 'Hairball'];

    const base = makeParams({ projection: makeProjection([memberA, memberB]) });
    const baseHash = hash(base);
    const basePrompt = await transportPromptFor(makeParams({ projection: makeProjection([memberA, memberB]) }));
    expect(basePrompt).toContain('EXECUTION PRODUCT TYPE CONTEXT:');
    expect(basePrompt).toContain('SKU SKU-A');
    expect(basePrompt).toContain('SKU SKU-B');

    // Permute EVERYTHING: member order, page order, species array order, OCR
    // health-concern array order.
    const permutedMemberA = clone(memberA);
    permutedMemberA.extraction.ocr.packagingOcrData!.species = ['Kitten', 'Cat'];
    permutedMemberA.extraction.ocr.packagingOcrData!.healthConcernFunction = ['Skin', 'Hairball'];
    const permuted = makeParams({
      projection: makeProjection([clone(memberB), permutedMemberA]),
      pagePlan: { ...PAGE_PLAN, pages: [...PAGE_PLAN.pages].reverse() },
    });
    expect(hash(permuted)).toBe(baseHash);
    const permutedPrompt = await transportPromptFor(permuted);
    expect(permutedPrompt).toBe(basePrompt);
  });

  it('the shared truncation constants mirror the prompt cutoffs exactly', () => {
    expect(PAGE_AUTHORITY_TRUNCATION).toEqual({ name: 500, webTitle: 500, brand: 200, description: 1500 });
    expect(normalizePageAuthorityString(null, 500)).toBeNull();
    expect(normalizePageAuthorityString('short', 200)).toBe('short');
    expect(normalizePageAuthorityString('x'.repeat(201), 200)).toBe('x'.repeat(200));
  });
});

describe('pageAuthorityFromProjectionMember — the pure builder (PR7 C2)', () => {
  it('returns the exact frozen page-relevant slice (same derivation as the frozen ProductLineItemSnapshot)', () => {
    const member = makeMember();
    expect(pageAuthorityFromProjectionMember(member)).toEqual({
      sku: 'SKU-1',
      name: 'Acme Pate Chicken',
      webTitle: 'Acme Pate Chicken 5.5oz',
      brand: 'Acme',
      description: 'Grain-free wet food for adult cats.',
      species: ['Cat'],
      flavor: 'Chicken',
      lifeStage: 'Adult',
      productForm: 'Pate',
      healthConcern: ['Hairball'],
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

  it('nulls OCR signals and falls back to the empty string for sku/description when absent', () => {
    const member = makeMember();
    member.extraction.ocr.packagingOcrData = null;
    member.productSku = null;
    member.extraction.description = null;
    expect(pageAuthorityFromProjectionMember(member)).toEqual({
      sku: '',
      name: 'Acme Pate Chicken',
      webTitle: 'Acme Pate Chicken 5.5oz',
      brand: 'Acme',
      description: '',
      species: [],
      flavor: null,
      lifeStage: null,
      productForm: null,
      healthConcern: [],
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
});

describe('PR7 review R2 (F2c) — FROZEN-PLAN Page model authority (P1-C)', () => {
  /** A minimal schema-v2 runtime snapshot carrying a REAL frozen
   *  model-execution plan + rule versions (the plan entry is the authority
   *  source — never live credentials). */
  function frozenPlanSnapshot(overrides: Partial<RuntimeClassificationSnapshot> = {}): RuntimeClassificationSnapshot {
    const view = {
      defaultProvider: 'ollama',
      defaultModel: 'qwen2.5vl:latest',
      providerLocalities: { ollama: 'local' },
      stageOverrides: {},
      imageDataSharing: 'local_only',
      textDataSharing: 'local_only',
      mlFeatures: {},
    } as never;
    return {
      schemaVersion: 2,
      snapshotHash: 'snap-hash-frozen-plan',
      workspaceId: 'ws-1',
      workspacePath: '/tmp/ws',
      productSku: 'SKU-1',
      createdAt: '2026-08-01T12:00:00.000Z',
      config: {} as never,
      configSnapshotRef: { id: 'x', hash: 'y', sourceCommit: null, createdAt: '2026-08-01T12:00:00.000Z' },
      modelExecutionPlan: buildModelExecutionPlan(view, null),
      runtimeRuleVersions: buildRuntimeRuleVersions(),
      ...overrides,
    } as unknown as RuntimeClassificationSnapshot;
  }

  it('buildCohortPageAuthorityBundle derives modelExecutionAuthority from the frozen plan entry (never live config)', () => {
    mocks.getLlmConfigForTask = () => {
      throw new Error('live credential resolution must never run');
    };
    const bundle = buildCohortPageAuthorityBundle(makeParams({ snapshot: frozenPlanSnapshot(), modelExecutionAuthority: undefined }));
    // The plan entry's provider/model AND both semantic versions are the
    // hashed authority.
    expect(bundle.modelExecutionAuthority).toEqual({
      provider: 'ollama',
      model: 'qwen2.5vl:latest',
      promptTemplateVersion: 'cohort-page-assignment-parent-prompt-v2',
      ruleVersion: 'cohort-page-assignment-parent-rules-v2',
    });
  });

  it('P1-C: a live getLlmConfigForTask THROW (simulated credential removal) cannot flip the P-hash', () => {
    const hashBefore = hash(makeParams({ snapshot: frozenPlanSnapshot(), modelExecutionAuthority: undefined }));
    mocks.getLlmConfigForTask = () => {
      throw new Error('credential removed mid-flight');
    };
    // Re-entry computes the SAME hash — the parent op no longer touches live
    // resolution at all, so a committed decision is never needlessly
    // superseded by a credential lookup failure.
    expect(hash(makeParams({ snapshot: frozenPlanSnapshot(), modelExecutionAuthority: undefined }))).toBe(hashBefore);
  });

  it('the bundle modelExecutionAuthority participates in the P-hash (snapshot-derived)', () => {
    mocks.getLlmConfigForTask = () => null;
    const base = hash(makeParams({ snapshot: frozenPlanSnapshot(), modelExecutionAuthority: undefined }));
    // A different frozen plan (different model) must change the hash.
    const otherPlan = frozenPlanSnapshot();
    (otherPlan.modelExecutionPlan as unknown as { entries: Array<{ operation: string; provider: string; model: string }> }).entries = [
      ...(otherPlan.modelExecutionPlan as unknown as { entries: Array<{ operation: string; provider: string; model: string }> }).entries.map(entry => ({
        ...entry,
        ...(entry.operation === 'cohort_page_assignment_parent' ? { provider: 'openai', model: 'gpt-4o-mini' } : {}),
      })),
    ];
    expect(hash(makeParams({ snapshot: otherPlan, modelExecutionAuthority: undefined }))).not.toBe(base);
  });

  it('the hashed model-EXECUTION authority equals the plan entry authority; explicit overrides participate (the version authority — not a hash-local constant)', () => {
    mocks.getLlmConfigForTask = () => null;
    // The bundle carries the plan entry's full authority; an explicit
    // override participates and changes the hash.
    expect(hash(makeParams({ snapshot: frozenPlanSnapshot(), modelExecutionAuthority: undefined })))
      .toBe(hash(makeParams({ snapshot: frozenPlanSnapshot(), modelExecutionAuthority: { provider: 'ollama', model: 'qwen2.5vl:latest', promptTemplateVersion: 'cohort-page-assignment-parent-prompt-v2', ruleVersion: 'cohort-page-assignment-parent-rules-v2' } })));
    expect(hash(makeParams({ snapshot: frozenPlanSnapshot(), modelExecutionAuthority: { provider: 'ollama', model: 'qwen2.5vl:latest', promptTemplateVersion: 'cohort-page-assignment-parent-prompt-v2', ruleVersion: 'different-version' } })))
      .not.toBe(hash(makeParams({ snapshot: frozenPlanSnapshot(), modelExecutionAuthority: undefined })));
  });
});

describe('Milestone E — source-kind/provenance drift (page input identity)', () => {
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

  it('distributor provenance changes the P-hash vs the same member as official-page', () => {
    expect(hash(makeParams({ projection: projectionWithMembers([makeMember()]) })))
      .not.toBe(hash(makeParams({ projection: projectionWithMembers([distributorMember()]) })));
  });

  it('source-kind drift with identical page text still changes identity', () => {
    // makeMember() supplies identical page text; only the source kind differs.
    const official = makeParams({ projection: projectionWithMembers([makeMember()]) });
    const distributor = makeParams({ projection: projectionWithMembers([distributorMember()]) });
    expect(hash(distributor)).not.toBe(hash(official));
  });

  it('generation drift changes the P-hash for distributor members', () => {
    const g1 = makeParams({ projection: projectionWithMembers([distributorMember({ sourcingGenerationId: 'gen-1' })]) });
    const g2 = makeParams({ projection: projectionWithMembers([distributorMember({ sourcingGenerationId: 'gen-2' })]) });
    expect(hash(g2)).not.toBe(hash(g1));
  });

  it('accepted-attempt-set drift changes the P-hash for distributor members', () => {
    const a1 = makeParams({ projection: projectionWithMembers([distributorMember({ acceptedEvidenceAttemptIds: ['att-1'] })]) });
    const a2 = makeParams({ projection: projectionWithMembers([distributorMember({ acceptedEvidenceAttemptIds: ['att-1', 'att-2'] })]) });
    expect(hash(a2)).not.toBe(hash(a1));
  });

  it('distributor evidence-hash drift changes the P-hash for distributor members', () => {
    const h1 = makeParams({ projection: projectionWithMembers([distributorMember({ distributorEvidenceHash: 'a'.repeat(64) })]) });
    const h2 = makeParams({ projection: projectionWithMembers([distributorMember({ distributorEvidenceHash: 'b'.repeat(64) })]) });
    expect(hash(h2)).not.toBe(hash(h1));
  });

  it('a V1 member hashes identically to a normalized official-page V2 member', () => {
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
    expect(hash(v2Official)).toBe(hash(v1));
  });
});

describe('Amendment B merchandising fields and the page hash (M5b-1)', () => {
  it('P-hash CHANGES when the merchandising description changes (description is page authority)', () => {
    // The page authority slice includes `description`
    // (pageAuthorityFromProjectionMember) — a v2 merchandising description
    // change must invalidate a coordinated page output set (the page may
    // embed description-derived content). No stale reuse.
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.description = 'Changed merch description';
    expect(hash(changed)).not.toBe(hash(base));
  });

  it('P-hash is STABLE across non-page merchandising fields (features/ingredients/case-pack/UOM)', () => {
    // Only the page-authority slice participates; merchandising fields that
    // are not page identity (bullet points, ingredients, case pack, UOM)
    // must not invalidate a coordinated page output set.
    const base = makeParams();
    const changed = clone(base);
    changed.projection.members[0].extraction.bulletPoints = ['x', 'y'];
    (changed.projection.members[0].extraction as any).ingredients = 'Chicken';
    (changed.projection.members[0].extraction as any).casePack = '12';
    (changed.projection.members[0].extraction as any).unitOfMeasure = 'CT';
    expect(hash(changed)).toBe(hash(base));
  });
});
