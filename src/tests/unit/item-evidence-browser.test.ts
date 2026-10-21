// Isolated runtime smoke (not run as part of deterministic unit coverage):
// build `baystate/investigation-render:1` with
// `docker build -t baystate/investigation-render:1 -f docker/investigation-render/Dockerfile .`,
// then run `bunx vitest run src/tests/unit/browser-investigation-tier1.test.ts -t "carries container HTTPS through the validating tunnel while direct egress stays denied"`.
// Requires Docker, openssl and the existing internal render network setup; the
// controlled HTTPS origin is broker-stubbed, while container DNS/egress and
// HTTPS CONNECT interception are exercised locally.
import { describe, expect, it } from 'vitest';
import { resolveInvestigationBudget } from '../../shared/schemas/browser-investigation';
import {
  collectItemEvidenceBrowser,
  type ItemEvidenceBrowserInput,
} from '../../onboarding/item-evidence-browser';
import { BudgetLedger } from '../../onboarding/browser-investigation/budgets';

function input(overrides: Partial<ItemEvidenceBrowserInput> = {}): ItemEvidenceBrowserInput {
  const budget = resolveInvestigationBudget({});
  return {
    investigationId: 'item-browser-test',
    workspaceId: 'workspace-test',
    candidates: [{ id: 'candidate-1', url: 'https://example.com/products/alpha' }],
    actions: [{ id: 'action-1', candidateId: 'candidate-1', kind: 'observe' }],
    budget,
    ledger: new BudgetLedger(budget),
    resources: { pages: 0, actions: 0, bytes: 0, requestAttempts: 0, redirects: 0, responseBytesTransferred: 0 },
    ...overrides,
  };
}

describe('item evidence browser collection preflight', () => {
  it('rejects private-address and local-name candidates before creating a proxy or browser', async () => {
    for (const url of ['https://127.0.0.1/private', 'https://service.local/item', 'https://localhost/item']) {
      await expect(collectItemEvidenceBrowser(input({
        candidates: [{ id: 'candidate-1', url }],
      }))).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });

  it('rejects an action that attempts to bind outside the supplied candidate IDs', async () => {
    await expect(collectItemEvidenceBrowser(input({
      actions: [{ id: 'action-1', candidateId: 'model-invented-candidate', kind: 'observe' }],
    }))).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects caller actions outside the static read vocabulary', async () => {
    await expect(collectItemEvidenceBrowser(input({
      actions: [{
        id: 'action-1',
        candidateId: 'candidate-1',
        kind: 'javascript',
      } as unknown as ItemEvidenceBrowserInput['actions'][number]],
    }))).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects interactive targets that were not enumerated for the current page', async () => {
    await expect(collectItemEvidenceBrowser(input({
      candidates: [{
        id: 'candidate-1',
        url: 'https://example.com/products/alpha',
        pageId: 'a'.repeat(64),
        availableTargetIds: ['accordion-0'],
      }],
      actions: [{
        id: 'action-1',
        candidateId: 'candidate-1',
        kind: 'accordion',
        targetId: 'accordion-1',
      }],
    }))).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects already-cancelled work before allocating network or container resources', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(collectItemEvidenceBrowser(input({ signal: controller.signal })))
      .rejects.toMatchObject({ code: 'cancelled' });
  });

  it('respects caller-reserved page and action budgets', async () => {
    const request = input({ resources: { pages: 5, actions: 0, bytes: 0, requestAttempts: 0, redirects: 0, responseBytesTransferred: 0 } });
    await expect(collectItemEvidenceBrowser(request)).rejects.toMatchObject({ code: 'budget_exhausted' });
  });
});
