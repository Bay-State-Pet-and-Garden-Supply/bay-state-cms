import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import { BraveSearchError, searchBraveWeb } from '../../onboarding/brave-search';

let tempDir: string;

describe('Brave Search adapter', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'item-acquisition-brave-'));
    initDb(path.join(tempDir, 'fixture.sqlite'));
    runMigrations();
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('sends the documented bounded request to the fixed Brave origin and returns complete results', async () => {
    upsertApiKey('brave_search', 'disposable-test-token');
    let requestUrl: URL | null = null;
    let requestInit: RequestInit | undefined;
    const captureFetch: typeof fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      requestUrl = input instanceof URL ? input : new URL(String(input));
      requestInit = init as RequestInit | undefined;
      return new Response(JSON.stringify({ web: { results: [{
        url: 'https://manufacturer.example/products/item', title: 'Item', description: 'Discovery clue only',
      }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const result = await searchBraveWeb('Acme exact product', {
      count: 4,
      offset: 2,
      fetchImpl: captureFetch,
    });
    if (!requestUrl) throw new Error('expected request URL');
    const capturedUrl: URL = requestUrl;
    expect(capturedUrl.origin).toBe('https://api.search.brave.com');
    expect(capturedUrl.pathname).toBe('/res/v1/web/search');
    expect(capturedUrl.searchParams.get('q')).toBe('Acme exact product');
    expect(capturedUrl.searchParams.get('count')).toBe('4');
    expect(capturedUrl.searchParams.get('offset')).toBe('2');
    expect(capturedUrl.searchParams.get('spellcheck')).toBe('false');
    expect(capturedUrl.searchParams.get('text_decorations')).toBe('false');
    expect(capturedUrl.searchParams.get('result_filter')).toBe('web');
    expect((requestInit?.headers as Record<string, string>)['x-subscription-token']).toBe('disposable-test-token');
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
    await expect(searchBraveWeb('product', { fetchImpl: (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch })).rejects.toMatchObject({ code: 'credential_missing' });
    expect(called).toBe(false);
  });

  it('rejects malformed, overfull and non-HTTP result responses without clipping', async () => {
    upsertApiKey('brave_search', 'disposable-test-token');
    const malformed = async () => searchBraveWeb('product', {
      fetchImpl: (async () => new Response(JSON.stringify({ web: { results: [{ url: 'javascript:alert(1)', title: 'x', description: 'x' }] } }))) as unknown as typeof fetch,
    });
    await expect(malformed()).rejects.toBeInstanceOf(BraveSearchError);
    await expect(searchBraveWeb('product', { count: 1, fetchImpl: (async () => new Response(JSON.stringify({ web: { results: [
      { url: 'https://a.example', title: 'a', description: 'a' },
      { url: 'https://b.example', title: 'b', description: 'b' },
    ] } }))) as unknown as typeof fetch })).rejects.toMatchObject({ code: 'malformed_response' });
  });

  it('rejects overlong queries and invalid count/offset before credentials or network', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch;
    await expect(searchBraveWeb('word '.repeat(76), { fetchImpl })).rejects.toMatchObject({ code: 'invalid_query' });
    await expect(searchBraveWeb('valid', { count: 21, fetchImpl })).rejects.toMatchObject({ code: 'invalid_query' });
    await expect(searchBraveWeb('valid', { offset: 10, fetchImpl })).rejects.toMatchObject({ code: 'invalid_query' });
    expect(called).toBe(false);
  });
});
