// T2 (#226) — proposal apply governance (Vitest, memory doubles).
//
// Proves the inactive blocked-draft path without a database: compilable
// proposals — even with failed or incomplete validation — publish a
// sanitized inactive shared draft with blockers preserved; unsupported
// executable primitives stay unappliable; saving never implies validation
// success, approval, health, activation, release, or image attestation.
// Workspace-private prompts and raw observations never leak into the shared
// draft. No DB, no network, no provider imports.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  INVESTIGATION_RESULT_VERSION,
  type InvestigationRecord,
} from '../../shared/schemas/browser-investigation';
import { isPolicyBindingIntact, POLICY_FIELDS } from '../../shared/schemas/browser-investigation-policy';
import {
  applyProposalToDraft,
  compileProposalForInvestigation,
  createMemoryProposalStore,
  InvestigationServiceError,
  type ApplyProposalResult,
  type DraftVersionCreator,
  type ProposalStore,
} from '../../onboarding/browser-investigation/apply';
import type { InvestigationStore } from '../../onboarding/browser-investigation/service';
import type { StoredInvestigationInsert } from '../../onboarding/browser-investigation/service';

const WS = 'ws-apply-governance';
const DOMAIN = 'shop.example.com';

const BUDGET = { maxPages: 5, maxReads: 20, maxModelCalls: 8, timeoutMs: 600000 };
const MODEL_POLICY = { allowCloudTextAnalysis: false, allowImageSharing: false };

function shopifyResult(overrides: Record<string, unknown> = {}) {
  return {
    version: INVESTIGATION_RESULT_VERSION,
    summary: 'Apply-governance fixture. Untrusted proposal evidence only.',
    observations: [
      {
        kind: 'shopify_json_observation',
        sourceUrl: 'https://shop.example.com/products/alpha',
        artifactHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        detail: 'CANARY-OBSERVATION-RAW-DETAIL workspace-private',
        incomplete: false,
      },
    ],
    evidenceRefs: ['evidence:shopify-product-json:alpha'],
    gaps: [],
    renderedBrowserRequired: false,
    platform: 'shopify',
    incompatibleStructureIds: [],
    structures: [
      {
        id: 'shopify-default',
        sampleUrls: ['https://shop.example.com/products/alpha'],
        platformSource: 'shopify_product_json',
      },
    ],
    fieldRecommendations: POLICY_FIELDS.map((field) => ({
      field,
      sources: ['shopify_product_json', 'json_ld'],
      structureId: 'shopify-default',
    })),
    identityRequirements: {
      productIdentity: ['gtin_exact', 'sku_exact'],
      variantIdentity: ['gtin_exact', 'operator_selection'],
      optionAxes: [],
    },
    ...overrides,
  };
}

function completedRecord(overrides: Partial<InvestigationRecord> = {}): InvestigationRecord {
  return {
    id: 'binv_apply_1',
    workspaceId: WS,
    domain: DOMAIN,
    mode: 'domain_onboarding',
    status: 'completed',
    provider: 'fake',
    runId: 'binvrun_apply_1',
    requestedModel: null,
    actualModel: { provider: 'fake', model: 'fake-deterministic-v1' },
    inputSnapshot: {
      domain: DOMAIN,
      mode: 'domain_onboarding',
      sampleUrls: ['https://shop.example.com/products/alpha'],
      budget: { ...BUDGET },
      modelPolicy: { ...MODEL_POLICY },
      knownContext: { operatorPrompt: 'CANARY-PROMPT workspace-private repair notes' },
      requestedAt: '2026-09-17T00:00:00.000Z',
    },
    inputHash: 'input-hash-apply-1-input-hash-apply-1',
    budget: { ...BUDGET },
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:01.000Z',
    startedAt: '2026-09-17T00:00:00.500Z',
    completedAt: '2026-09-17T00:00:01.000Z',
    usage: { modelCalls: 1, pagesVisited: 1, readsPerformed: 1, durationMs: 5, costBasis: 'unavailable' },
    failureCode: null,
    failureDetail: null,
    result: shopifyResult() as InvestigationRecord['result'],
    resultHash: 'result-hash-apply-1-result-hash-apply-1',
    discardedAt: null,
    discardActor: null,
    ...overrides,
  } as InvestigationRecord;
}

function memoryInvestigations(record: InvestigationRecord): InvestigationStore {
  return {
    insert(row: StoredInvestigationInsert) {
      throw new Error(`unexpected insert ${row.domain}`);
    },
    find: (workspaceId: string, id: string) =>
      workspaceId === record.workspaceId && id === record.id ? record : null,
    list: () => [record],
    findActive: () => null,
    existsInOtherWorkspace: (workspaceId: string, id: string) =>
      id === record.id && workspaceId !== record.workspaceId,
    update: () => null,
  };
}

function capturingCreator() {
  const created: Array<Record<string, unknown>> = [];
  const creator: DraftVersionCreator = {
    createVersion: (input) => {
      created.push(input as unknown as Record<string, unknown>);
      return { id: 'ver_blocked_1', domain: input.domain, version: 7 };
    },
  };
  return { created, creator };
}

interface ApplyHarness {
  record: InvestigationRecord;
  created: Array<Record<string, unknown>>;
  invoke: (opts?: { actor?: string; validation?: unknown; workspaceId?: string }) => Promise<ApplyProposalResult>;
  deps: Parameters<typeof applyProposalToDraft>[0];
}

/** Memory-backed apply harness: one completed record plus capturing version creator. */
function setupApply(recordOverrides: Partial<InvestigationRecord> = {}): ApplyHarness {
  const record = completedRecord(recordOverrides);
  const { created, creator } = capturingCreator();
  const deps: Parameters<typeof applyProposalToDraft>[0] = {
    investigations: memoryInvestigations(record),
    proposals: createMemoryProposalStore(),
    createVersion: creator.createVersion,
  };
  return {
    record,
    created,
    deps,
    invoke: (opts = {}) =>
      applyProposalToDraft(deps, {
        workspaceId: opts.workspaceId ?? WS,
        investigationId: record.id,
        actor: opts.actor ?? 'operator-1',
        ...(opts.validation !== undefined ? { validation: opts.validation } : {}),
      }),
  };
}

describe('browser investigation apply governance (T2)', () => {
  it('publishes a sanitized inactive draft with blockers preserved and image review ungranted', async () => {
    const { record, created, deps } = setupApply();
    // Inactive by construction: the apply path has no active-pointer writer.
    expect('setActiveVersion' in deps).toBe(false);
    const out = await applyProposalToDraft(deps, {
      workspaceId: WS,
      investigationId: record.id,
      actor: 'operator-1',
      validation: { status: 'failed', blockers: ['representative price mismatch'] },
    });
    expect(created).toHaveLength(1);
    const input = created[0]!;
    expect(input.domain).toBe(DOMAIN);
    expect(input.sampleIds).toEqual([]);
    const summary = input.validationSummary as Record<string, unknown>;
    expect(summary.imageRuleOk).toBe(false);
    expect(summary.investigationDerived).toBe(true);
    expect(summary.investigationId).toBe(record.id);
    expect(summary.proposalHash).toBe(out.proposalHash);
    expect(summary.policyHash).toBe(out.policyHash);
    expect(summary.validationStatus).toBe('failed');
    expect(summary.blockers).toContain('representative price mismatch');
    expect(summary.blockers).toContain('validation:failed');
    const provenance = input.provenance as Record<string, unknown>;
    expect(provenance.provider).toBe('browser-investigation');
    expect(String(input.reason)).toContain(record.id);
    expect(out.appliedVersionId).toBe('ver_blocked_1');
  });

  it('applies compilable proposals with incomplete validation without implying success', async () => {
    const { created, invoke } = setupApply();
    const out = await invoke();
    const summary = (created[0]!.validationSummary as Record<string, unknown>);
    expect(summary.validationStatus).toBe('not_run');
    expect(summary.blockers).toContain('validation:not_run');
    expect(summary.imageRuleOk).toBe(false);
    expect(out.blockers).toContain('validation:not_run');
  });

  it('never leaks workspace-private prompts or raw observations into the shared draft', async () => {
    const { created, invoke } = setupApply();
    await invoke();
    const serialized = JSON.stringify(created[0]);
    expect(serialized).not.toContain('CANARY-PROMPT');
    expect(serialized).not.toContain('CANARY-OBSERVATION-RAW-DETAIL');
    // Workspace-scoped evidence pointers dangle outside the workspace, so
    // the shared draft keeps only self-validating content hashes — the
    // workspace UI reads evidence through the investigation/proposal.
    expect(serialized).not.toContain('evidence:shopify-product-json:alpha');
    expect(serialized).toContain('a1b2c3d4e5f60718293a4b5c6d7e8f90');
  });

  it('derives executable selectors only from validated exceptions, never from free text', async () => {
    const { created, invoke } = setupApply({
      result: shopifyResult({
        fieldRecommendations: POLICY_FIELDS.map((field) =>
          field === 'price'
            ? { field, sources: ['shopify_product_json', 'selector'], selector: '  .price__regular  ', structureId: 'shopify-default' }
            : { field, sources: ['shopify_product_json'], structureId: 'shopify-default' },
        ),
      }) as InvestigationRecord['result'],
    });
    await invoke();
    const selectors = created[0]!.selectors as Record<string, unknown>;
    expect(selectors.priceSelector).toBe('.price__regular');
    expect(selectors.titleSelector).toBeNull();
    expect((selectors.shopifyJSONPath as boolean)).toBe(true);
    const metadata = selectors.customSelectorMetadata as Record<string, unknown>;
    expect(metadata.priceSelector).toMatchObject({ source: 'browser-investigation', field: 'price' });
  });

  it('rejects requires_code_adapter outcomes as unappliable without creating a version', async () => {
    const { created, invoke } = setupApply({
      result: shopifyResult({
        codeAdapterNeeded: { capability: 'woo_store_api_adapter', reason: 'No supported runtime adapter exists.' },
      }) as InvestigationRecord['result'],
    });
    await expect(invoke()).rejects.toMatchObject({ code: 'unappliable_proposal' });
    expect(created).toHaveLength(0);
  });

  it('rejects unsupported-primitive-only results as unappliable without creating a version', async () => {
    const { created, invoke } = setupApply({
      result: shopifyResult({
        fieldRecommendations: POLICY_FIELDS.map((field) => ({
          field,
          sources: ['execute_js_click_flow'],
          structureId: 'shopify-default',
        })),
      }) as InvestigationRecord['result'],
    });
    await expect(invoke()).rejects.toMatchObject({ code: 'unappliable_proposal' });
    expect(created).toHaveLength(0);
  });

  it('rejects a second apply as already applied', async () => {
    const { record, deps, invoke } = setupApply();
    await applyProposalToDraft(deps, { workspaceId: WS, investigationId: record.id, actor: 'operator-1' });
    await expect(invoke()).rejects.toMatchObject({ code: 'already_applied' });
  });

  it('rejects non-completed investigations without creating a version', async () => {
    const { created, invoke } = setupApply({ status: 'failed', result: null, resultHash: null });
    await expect(invoke()).rejects.toMatchObject({ code: 'invalid_transition' });
    expect(created).toHaveLength(0);
  });

  it('rejects foreign-workspace applies without leaking state', async () => {
    const { created, invoke } = setupApply();
    await expect(invoke({ workspaceId: 'ws-foreign' })).rejects.toMatchObject({ code: 'workspace_mismatch' });
    expect(created).toHaveLength(0);
  });

  it('a rendered proposal round-trips its own version binding', async () => {
    const { created, invoke } = setupApply({
      result: shopifyResult({ renderedBrowserRequired: true }) as InvestigationRecord['result'],
    });
    const out = await invoke();
    const selectors = created[0]!.selectors as Record<string, unknown>;
    const summary = created[0]!.validationSummary as Record<string, unknown>;
    expect(summary.policyHash).toBe(out.policyHash);
    // A fresh draft satisfies its own binding with no edit.
    expect(isPolicyBindingIntact(selectors, summary)).toBe(true);
    // Flipping shared policy content breaks the binding (edits invalidate).
    const tampered = JSON.parse(JSON.stringify(selectors)) as Record<string, unknown>;
    (tampered.extractionPolicy as Record<string, unknown>).renderedBrowserRequired = false;
    expect(isPolicyBindingIntact(tampered, summary)).toBe(false);
  });

  it('compiles deterministically through the read path without creating versions', async () => {
    const record = completedRecord();
    const proposals: ProposalStore = createMemoryProposalStore();
    const outcome = await compileProposalForInvestigation(
      { investigations: memoryInvestigations(record), proposals },
      WS,
      record.id,
    );
    expect(outcome.status).toBe('proposal');
    // Compiling persists the immutable proposal reference for later apply binding.
    const stored = proposals.getProposal(WS, record.id);
    expect(stored?.proposalHash).toBeTruthy();
  });

  it('the apply module never imports activation, release, or attestation writers', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/onboarding/browser-investigation/apply.ts'),
      'utf8',
    );
    const importLines = source.split('\n').filter((l) => /import\s|require\(/.test(l));
    const importBlock = importLines.join('\n');
    for (const forbidden of [
      'setActiveVersion',
      'profile-activation-gate',
      'domain-release',
      'releaseDomainExtractionItems',
      'image-reuse-policy',
      'attestVersionImageReview',
      'invokeInvestigationProvider',
      'fakeInvestigationProvider',
    ]) {
      expect(importBlock.includes(forbidden), forbidden).toBe(false);
    }
    expect(InvestigationServiceError).toBeTruthy();
  });
});
