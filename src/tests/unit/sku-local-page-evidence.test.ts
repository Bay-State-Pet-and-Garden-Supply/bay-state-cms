/**
 * Issue #351 slice C — SKU-local page evidence (TDD).
 *
 * Proves at the workflow seam (processPageTarget / materializeCoordinatedPages
 * → real proposals) that a misleading prior page assignment never becomes
 * evidence: no packet text in prompts, no page-context evidenceIds on
 * proposals. Prior placements remain removal/comparison context only
 * (backfill filter), never proof.
 *
 * Runs under bun test. Mocks only the leaf LLM transport
 * (`@/onboarding/llm-client`, the same leaf the cohort-page-hash suite
 * mocks — proven to coexist); the real `extractProductContext` and prompt
 * builder run, so the prompt-content assertion is honest. No live ShopSite
 * mutation.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { ClassificationEvidence } from '../../shared/schemas/classification';
import type { ResolvedTarget } from '../../classification/curation-target-resolver';
import type { StageContext, StageInput } from '../../classification/types';

let capturedPrompts: string[] = [];

// Registered per-test (not top-level): bun's mock.module is process-global,
// so a top-level registration leaks into co-running suites in the same
// `bun test` invocation. beforeEach/afterEach pairs registration with a full
// restore (same pattern as cohort-page-hash.test.ts).
function registerTransportMock(): void {
  mock.module('@/onboarding/llm-client', () => ({
    callLlmForTaskWithProvenance: (_task: string, prompt: string) => {
      capturedPrompts.push(prompt);
      return Promise.resolve({
        content: JSON.stringify({
          pages: [{ pageId: 'dog-dry', pageName: 'Dog Food Dry', confidence: 0.8 }],
        }),
        callId: 'call-1',
        provider: 'openai',
        model: 'test-model',
        usage: { promptTokens: null, completionTokens: null, totalTokens: null },
      });
    },
  }));
}

import {
  processPageTarget,
  materializeCoordinatedPages,
} from '../../classification/curation-target-processor';

function ev(id: string, source: string, sourceField: string | null, value: string): ClassificationEvidence {
  return {
    id, runId: 'run-SKU1', productSku: 'SKU1', stageName: 'evidence_extraction',
    attributeId: null, source, reliability: 'high', sourceUrl: null,
    sourceField, snippet: value, value,
    metadata: null, capturedAt: '2026-08-01T12:00:00.000Z',
  } as ClassificationEvidence;
}

// Own-SKU facts: a Dog kibble. The prior placement claims a Cat page —
// misleading and must never become proposal evidence.
const MISLEADING_PRIOR = ev('prior-cat-page', 'page_context', 'page_name', 'Cat Food Wet');
const OWN_NAME = ev('own-name', 'official_product_page', 'name', 'Acme Dog Kibble');
const OWN_FLAVOR = ev('own-flavor', 'official_product_page', 'flavor', 'Chicken');

const target = {
  config: { id: 'pages', kind: 'page', label: 'Pages', enabled: true, selectionMode: 'multiple' },
  options: [{ value: 'dog-dry', label: 'Dog Food Dry' }],
} as unknown as ResolvedTarget;

const baseContext = {
  workspacePath: '/tmp/workspace',
  workspaceId: 'workspace',
  runId: 'run-SKU1',
  configSnapshotRef: { id: 'snapshot', hash: 'hash', sourceCommit: null, createdAt: '' },
} as unknown as StageContext;

describe('SKU-local page evidence (issue #351)', () => {
  beforeEach(() => {
    registerTransportMock();
    capturedPrompts = [];
  });

  afterEach(() => {
    mock.restore();
  });

  it('processPageTarget: misleading prior placement never reaches the prompt or proposal evidence', async () => {
    const input: StageInput = {
      sku: 'SKU1',
      evidence: [MISLEADING_PRIOR, OWN_NAME, OWN_FLAVOR],
      acceptedProposals: [],
      allProposals: [],
    };
    const result = await processPageTarget(target, input, baseContext);

    // The real prompt carries own-SKU facts but no prior-placement text.
    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]).toContain('Acme Dog Kibble');
    expect(capturedPrompts[0]).not.toContain('Cat Food Wet');

    // Real proposals carry no page-context evidenceIds.
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].evidenceIds).not.toContain('prior-cat-page');
    expect(result.proposals[0].evidenceIds).toEqual([]);
    expect(result.proposals[0]).not.toHaveProperty('contradictingEvidenceIds');
  });

  it('materializeCoordinatedPages: coordinated proposals carry no page-context evidenceIds', async () => {
    const context = {
      ...baseContext,
      snapshot: {
        snapshotHash: 'snap-hash-1',
        pages: {
          state: 'verified',
          records: [{ pageId: 'dog-dry', pageName: 'Dog Food Dry', parentPageId: null, parentPageName: null, verified: true, identityKind: 'page_id', identityKey: 'dog-dry', sourceHash: 'h' }],
        },
      },
      coordinatedPages: new Map([
        ['SKU1', {
          output: { status: 'assigned', pages: [{ pageId: 'dog-dry', pageName: 'Dog Food Dry', confidence: 0.8 }], source: 'llm_cohort' },
          modelCallId: 'parent-call-1',
        }],
      ]),
    } as unknown as StageContext;
    const input: StageInput = {
      sku: 'SKU1',
      evidence: [MISLEADING_PRIOR, OWN_NAME],
      acceptedProposals: [],
      allProposals: [],
    };
    const result = await materializeCoordinatedPages({} as unknown as ResolvedTarget, input, context);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].evidenceIds).not.toContain('prior-cat-page');
    expect(result.proposals[0].evidenceIds).toEqual([]);
  });
});
