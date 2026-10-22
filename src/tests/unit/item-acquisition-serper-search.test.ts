import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import { Database } from 'bun:sqlite';
import { PaidEffectBudgetCoordinator, PaidEffectBudgetError, createPaidEffectBudgetClient, createPaidEffectIdempotencyKey, withQualificationPaidEffectScope, withRequiredQualificationPaidEffectScope } from '../../ai/paid-effect-budget';
import { paidEffectBillingTermsHash, PaidEffectAuthorizationSchema, VerifiedPaidEffectBillingContractSchema } from '../../shared/schemas/paid-effect';
import { hashCanonicalJson } from '../../shared/stable-id';
import type { PaidEffectAttemptDescriptor } from '../../shared/schemas/paid-effect';
import { searchSerperWeb, SerperSearchError } from '../../onboarding/serper-search';

let tempDir: string;

describe('Serper Search adapter', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'item-acquisition-serper-'));
    initDb(path.join(tempDir, 'fixture.sqlite'));
    runMigrations();
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('sends the documented bounded POST to the fixed Serper origin and returns complete results', async () => {
    upsertApiKey('serper_search', 'disposable-test-token');
    let requestUrl: URL | null = null;
    let requestInit: RequestInit | undefined;
    const captureFetch: typeof fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      requestUrl = input instanceof URL ? input : new URL(String(input));
      requestInit = init as RequestInit | undefined;
      return new Response(JSON.stringify({ organic: [{
        link: 'https://manufacturer.example/products/item', title: 'Item', snippet: 'Discovery clue only',
      }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const result = await searchSerperWeb('Acme exact product', {
      count: 4,
      fetchImpl: captureFetch,
    });
    if (!requestUrl) throw new Error('expected request URL');
    const capturedUrl: URL = requestUrl;
    expect(capturedUrl.origin).toBe('https://google.serper.dev');
    expect(capturedUrl.pathname).toBe('/search');
    expect(requestInit?.method).toBe('POST');
    expect((requestInit?.headers as Record<string, string>)['X-API-KEY']).toBe('disposable-test-token');
    expect(JSON.parse(String(requestInit?.body))).toEqual({ q: 'Acme exact product', num: 4 });
    expect(requestInit?.redirect).toBe('error');
    expect(result.results).toEqual([{
      url: 'https://manufacturer.example/products/item', title: 'Item', description: 'Discovery clue only',
    }]);
    expect(result.complete).toBe(true);
    expect(typeof result.responseBytes).toBe('number');
    expect(result.responseBytes > 0).toBe(true);
  });

  it('fails without a server credential and never calls the provider', async () => {
    let called = false;
    await expect(searchSerperWeb('product', { fetchImpl: (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch })).rejects.toMatchObject({ code: 'credential_missing' });
    expect(called).toBe(false);
  });

  it('rejects malformed, overfull and non-public result responses without clipping', async () => {
    upsertApiKey('serper_search', 'disposable-test-token');
    const malformed = async () => searchSerperWeb('product', {
      fetchImpl: (async () => new Response(JSON.stringify({ organic: [{ link: 'javascript:alert(1)', title: 'x', snippet: 'x' }] }))) as unknown as typeof fetch,
    });
    await expect(malformed()).rejects.toBeInstanceOf(SerperSearchError);
    const overfullFetch = (async () => new Response(JSON.stringify({ organic: [
      { link: 'https://a.example', title: 'a', snippet: 'a' },
      { link: 'https://b.example', title: 'b', snippet: 'b' },
    ] }))) as unknown as typeof fetch;
    await expect(searchSerperWeb('product', { count: 1, fetchImpl: overfullFetch })).rejects.toMatchObject({ code: 'malformed_response' });
  });

  it('rejects overlong queries and invalid count before credentials or network', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch;
    await expect(searchSerperWeb('word '.repeat(76), { fetchImpl })).rejects.toMatchObject({ code: 'invalid_query' });
    await expect(searchSerperWeb('valid', { count: 21, fetchImpl })).rejects.toMatchObject({ code: 'invalid_query' });
    expect(called).toBe(false);
  });

  it('gates each physical Serper POST against a frozen contract and denies an unknown price or lost coordinator before fetch', async () => {
    upsertApiKey('serper_search', 'disposable-test-token');
    const db = new Database(':memory:');
    const terms = {
      schemaVersion: 1 as const,
      contractId: 'test-serper-contract',
      provider: 'serper_search',
      model: 'web',
      dimensions: [{ name: 'requests', unit: 'request', maxUnits: 1, priceMicros: 1, priceUnits: 1 }],
      attemptOverheadMicros: 0,
      maxChargeMicros: 1,
      authoritativeUsageSource: 'none' as const,
    };
    const contract = VerifiedPaidEffectBillingContractSchema.parse({
      ...terms, verifiedTermsHash: paidEffectBillingTermsHash(terms),
      verifiedEvidenceHash: 'a'.repeat(64), verifiedEvidenceRef: 'unit-fixture-contract',
      verifiedBy: 'unit-test', verifiedAt: '2026-10-22T00:00:00.000Z',
    });
    const authorization = PaidEffectAuthorizationSchema.parse({
      schemaVersion: 1, authorizationId: 'serper-test-authorization', qualificationRunId: 'serper-test-run',
      approvedCeilingMicros: 3, arms: ['candidate'], billingContracts: [contract],
    });
    const coordinator = new PaidEffectBudgetCoordinator(db, authorization);
    const client = createPaidEffectBudgetClient(request => coordinator.handleRequest(request), new AbortController().signal);
    const paidScope = {
      qualificationRunId: authorization.qualificationRunId, authorizationId: authorization.authorizationId,
      arm: 'candidate' as const, outputId: 'serper-test-output', beneficiaries: [{ kind: 'item' as const, id: 'test-item' }],
    };
    const descriptor = (): PaidEffectAttemptDescriptor => ({
      idempotencyKey: createPaidEffectIdempotencyKey(),
      logicalEffectId: 'serper-search:test-item:test-run',
      provider: contract.provider, model: contract.model, effect: 'serper-search-post',
      billingContractId: contract.contractId, billingContractHash: hashCanonicalJson(contract),
      requestedUnits: { requests: 1 },
    });
    const fakeFetch: typeof fetch = (async () => new Response(JSON.stringify({ organic: [] }), { status: 200 })) as unknown as typeof fetch;
    let calls = 0;
    const countedFetch: typeof fetch = (async (...args) => { calls++; return fakeFetch(...args); }) as unknown as typeof fetch;
    try {
      await withRequiredQualificationPaidEffectScope(() => withQualificationPaidEffectScope({
        scope: paidScope, client, body: async () => {
          await searchSerperWeb('test item', { fetchImpl: countedFetch });
        },
      })).then(() => { throw new Error('unknown contract must deny'); }, error => expect(error).toMatchObject({ code: 'contract_unverified' }));
      expect(calls).toBe(0);

      await withRequiredQualificationPaidEffectScope(() => withQualificationPaidEffectScope({
        scope: paidScope, client, body: async () => {
          await searchSerperWeb('test item', { fetchImpl: countedFetch, paidEffectDescriptor: descriptor() });
          await searchSerperWeb('test item', { fetchImpl: countedFetch, paidEffectDescriptor: descriptor() });
        },
      }));
      expect(calls).toBe(2);
      expect(coordinator.snapshot(paidScope).uniqueEffects).toBe(2);
      const beforeDispatchAbort = new AbortController();
      beforeDispatchAbort.abort();
      await expect(searchSerperWeb('test item', {
        signal: beforeDispatchAbort.signal, fetchImpl: countedFetch, paidEffectDescriptor: descriptor(),
      })).rejects.toMatchObject({ code: 'cancelled' });
      expect(calls).toBe(2);

      const afterDispatchAbort = new AbortController();
      const abortingFetch: typeof fetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
        calls++;
        afterDispatchAbort.abort();
        if (init?.signal?.aborted) throw new Error('request aborted after dispatch');
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('request aborted after dispatch')), { once: true });
        });
      }) as unknown as typeof fetch;
      await expect(searchSerperWeb('test item', {
        signal: afterDispatchAbort.signal, fetchImpl: abortingFetch, paidEffectDescriptor: descriptor(),
      })).rejects.toBeDefined();
      expect(calls).toBe(3);
      expect(coordinator.snapshot(paidScope).unknownLiabilitiesMicros).toBe(2);

      const lostClient = createPaidEffectBudgetClient(() => { throw new PaidEffectBudgetError('coordinator_disconnected'); }, new AbortController().signal);
      await withRequiredQualificationPaidEffectScope(() => withQualificationPaidEffectScope({
        scope: paidScope, client: lostClient, body: async () => searchSerperWeb('test item', {
          fetchImpl: countedFetch, paidEffectDescriptor: descriptor(),
        }),
      })).then(() => { throw new Error('lost coordinator must deny'); }, error => expect(error).toMatchObject({ code: 'coordinator_disconnected' }));
      expect(calls).toBe(3);
    } finally {
      db.close();
    }
  });
});
