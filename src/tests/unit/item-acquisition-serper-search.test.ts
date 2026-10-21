import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import { SerperSearchError, searchSerperWeb } from '../../onboarding/serper-search';

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
});
