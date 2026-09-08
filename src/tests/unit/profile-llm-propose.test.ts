// story: e06s03 — LLM propose pipeline with provenance + deterministic discovery first
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db/repositories/llm-task-config-repo', () => ({
  getLlmTaskConfig: vi.fn(() => ({ provider: 'openai', model: 'gpt-4o-mini', baseUrlOverride: null, configId: 'cfg_123' })),
}));
vi.mock('@/db/repositories/api-key-repo', () => ({
  getApiKey: vi.fn(() => ({ api_key: 'sk-test', base_url: null, model: null })),
}));

import { suggestSelectorsForField, explainValidationFailure, reviseSelectorsFromFeedback, generateSelectorsFromSuite } from '../../server/services/profile-builder/generateSelectorsService';

describe('profile-llm-propose — task buttons', () => {
  const sampleHtml = '<html><body><h1 class="product-title">Chicken Dinner</h1></body></html>';

  function mockLlmPayload(fieldKey: string, selector: string, evidence: string) {
    return {
      pageAssessment: { pageType: 'product' as const, usable: true },
      fields: { [fieldKey]: { notFound: false, candidates: [{ selector, evidence }] } },
      customFields: [],
      warnings: [],
    };
  }

  it('suggestSelectorsForField reuses sanitize→LLM→parse→validate pipeline and records provenance', async () => {
    const payload = mockLlmPayload('titleSelector', 'h1.product-title', 'h1');
    // @ts-ignore
global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
      text: async () => '',
    } as any);
    const res = await suggestSelectorsForField({ fieldKey: 'titleSelector', htmlRefs: ['.baystate-cms/artifacts/a/page.html'], snapshotHtmls: [sampleHtml], sourceUrl: 'https://acme.com/p/1', runtime: 'rendered' } as any, { userId: 'u1', requestId: 'r1' });
    expect(res.provenance.provider).toBeDefined();
    expect(res.provenance.configId).toBeDefined();
    expect(res.provenance.promptHash).toBeDefined();
    expect(typeof res.provenance.htmlLeftMachine).toBe('boolean');
    expect(res.provenance.disclosureBadge).toMatch(/HTML sent|local only/i);
    expect(res.fields.titleSelector).toBeDefined();
  });

  it('explainValidationFailure returns expanded reason with expected vs actual, provenance, artifact', () => {
    const reason = explainValidationFailure('titleSelector', { validation: { matchedCount: 0 }, expected: 'Chicken', actual: null, provenance: { artifact: 'job-1/page.html' } } as any);
    expect(reason).toMatch(/expected/i);
    expect(reason).toMatch(/artifact/i);
  });

  it('reviseSelectorsFromFeedback reuses pipeline with structured feedback', async () => {
    const payload = mockLlmPayload('titleSelector', 'h1.new', 'revised');
    // @ts-ignore
global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
      text: async () => '',
    } as any);
    const res = await reviseSelectorsFromFeedback({ feedback: { kind: 'text', field: 'titleSelector', issue: 'too generic' }, htmlRefs: ['.baystate-cms/artifacts/a/page.html'], snapshotHtmls: [sampleHtml], sourceUrl: 'https://acme.com/p/1', runtime: 'rendered' } as any, { userId: 'u1', requestId: 'r1' });
    expect(res.fields.titleSelector.selector).toBeDefined();
    expect(res.provenance.promptHash).toBeDefined();
  });

  it('generateSelectorsFromSuite handles 3 confirmed snapshots and aggregates deterministic discovery', async () => {
    const payload = mockLlmPayload('titleSelector', 'h1.product-title', 'stable across 3');
    // @ts-ignore
global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
      text: async () => '',
    } as any);
    const htmlRef = 'a/page.html';
    // create dummy artifact file for generateSelectors dependency (resolver)
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const pathMod = await import('node:path');
    const fullPath = pathMod.join(process.cwd(), '.baystate-cms', 'artifacts', 'profile-builder', htmlRef);
    mkdirSync(pathMod.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, sampleHtml);
    const res = await generateSelectorsFromSuite({ htmlRefs: [htmlRef, htmlRef, htmlRef], snapshotHtmls: [sampleHtml, sampleHtml, sampleHtml], sourceUrl: 'https://acme.com/p/1', runtime: 'rendered', fields: [{ key: 'titleSelector', label: 'Title', origin: 'core', valueType: 'text', multiple: false }] } as any, { userId: 'u1', requestId: 'r1' });
    expect(res.meta.requestedFieldCount).toBe(1);
    expect(res.provenance.htmlLeftMachine).toBeDefined();
  });
});
