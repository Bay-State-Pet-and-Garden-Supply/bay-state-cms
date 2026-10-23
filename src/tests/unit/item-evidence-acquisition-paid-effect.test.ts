import { describe, expect, it, mock } from 'bun:test';

const evidence = null;
const readiness = {
  evaluation: { status: 'needs_attention', requirements: [], reasons: [] },
  classificationReady: false,
  classificationReason: null,
  standard: null,
  evidence,
  nonWaivableFields: [],
  classificationSource: 'none',
} as const;

mock.module('../../onboarding/item-evidence', () => ({
  refreshItemEvidence: () => ({ status: 'ok', evidence }),
  admitItemEvidenceContribution: () => { throw new Error('unexpected_admission'); },
}));
mock.module('../../classification/item-listing-readiness', () => ({
  loadItemListingReadinessForRun: () => readiness,
}));
let serperDispatches = 0;
let browserDispatches = 0;
mock.module('../../onboarding/serper-search', () => ({
  SerperSearchError: class extends Error {},
  SERPER_SEARCH_MAX_RESPONSE_BYTES: 1_000_000,
  SERPER_SEARCH_TIMEOUT_MS: 10_000,
  searchSerperWeb: async () => { serperDispatches += 1; throw new Error('unexpected_serper_dispatch'); },
}));
mock.module('../../onboarding/item-evidence-browser', () => ({
  collectItemEvidenceBrowser: async () => { browserDispatches += 1; throw new Error('unexpected_browser_dispatch'); },
  ItemEvidenceBrowserError: class extends Error {},
}));
// Load after registering module fakes so this regression test can observe both dispatch seams.
const { runItemEvidenceAcquisition } = await import('../../onboarding/item-evidence-acquisition');

const input = {
  workspaceId: 'contract-free-workspace',
  itemId: 'contract-free-item',
  runId: 'contract-free-run',
  modelPolicy: null,
};
const contract = { contractId: 'unused-contract' } as never;
const client = { closedSignal: new AbortController().signal } as never;
const scope = {
  qualificationRunId: 'contract-free-run',
  authorizationId: 'contract-free-authorization',
  arm: 'candidate',
  outputId: 'contract-free-output',
  beneficiaries: [{ kind: 'item', id: 'contract-free-item' }],
} as never;

describe('item evidence acquisition paid-effect preflight', () => {
  it('denies contract-free Serper and browser paths before either dispatcher', async () => {
    const serperPath = await runItemEvidenceAcquisition({ ...input, paidEffect: { scope, client, browserSessionContract: contract } });
    const browserPath = await runItemEvidenceAcquisition({ ...input, paidEffect: { scope, client, serperSearchContract: contract } });

    expect(serperPath.status).toBe('unavailable');
    expect(browserPath.status).toBe('unavailable');
    expect(serperDispatches).toBe(0);
    expect(browserDispatches).toBe(0);
  });

  it('denies acquisition with no paid-effect scope before dispatch', async () => {
    const result = await runItemEvidenceAcquisition(input);

    expect(result.status).toBe('unavailable');
    expect(serperDispatches).toBe(0);
    expect(browserDispatches).toBe(0);
  });
});
