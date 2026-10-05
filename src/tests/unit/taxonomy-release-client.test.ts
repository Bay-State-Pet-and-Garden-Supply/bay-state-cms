/**
 * Taxonomy release client routing — the server mounts the release router at
 * `/api/settings/taxonomy-release`, NOT under `/api/onboarding`. Guards the
 * API-base fix: taxonomy status/pin calls hit the `/api` root while every
 * other onboarding call keeps the `/api/onboarding` base. Taxonomy calls use
 * the same configured bearer-token headers as the main API client.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getBatches,
  getTaxonomyReleaseStatus,
  pinTaxonomyRelease,
} from '../../client/onboarding-api';

function stubFetch(payload: unknown, status = 200) {
  const mock = vi.fn(async () => new Response(JSON.stringify(payload), { status }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('taxonomy release client routing', () => {
  it('fetches status from the /api root (server mount point)', async () => {
    const mock = stubFetch({ activeRevision: 'bay-state-v7', availableRevisions: [] });
    await getTaxonomyReleaseStatus();
    expect(mock).toHaveBeenCalledOnce();
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/settings/taxonomy-release');
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('pins through the /api root with JSON body and content-type', async () => {
    const mock = stubFetch({ success: true, activeRevision: 'bay-state-v7', updatedAt: 'x' });
    await pinTaxonomyRelease('bay-state-v7');
    expect(mock).toHaveBeenCalledOnce();
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/settings/taxonomy-release/pin');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ revision: 'bay-state-v7' }));
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('authenticates activation with the injected browser token', async () => {
    vi.stubGlobal('window', { __BAYSTATE_TOKEN__: 'test-only-injected-token' });
    const mock = stubFetch({ success: true, activeRevision: 'bay-state-v7', updatedAt: 'x' });
    await pinTaxonomyRelease('bay-state-v7');
    const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-only-injected-token');
  });

  it('authenticates status with the configured storage token when no token is injected', async () => {
    vi.stubGlobal('window', {});
    const getItem = vi.fn(() => 'test-only-storage-token');
    vi.stubGlobal('localStorage', { getItem });
    const mock = stubFetch({ activeRevision: 'bay-state-v7', availableRevisions: [] });
    await getTaxonomyReleaseStatus();
    const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(getItem).toHaveBeenCalledWith('baystate_cms_api_token');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-only-storage-token');
  });

  it('does not invent authorization when no browser token is configured', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: () => null });
    const mock = stubFetch({ success: true, activeRevision: 'bay-state-v7', updatedAt: 'x' });
    await pinTaxonomyRelease('bay-state-v7');
    const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('leaves all other onboarding APIs on /api/onboarding', async () => {
    const mock = stubFetch({ batches: [], workStateCounts: {} });
    await getBatches();
    const [url] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/onboarding/batches');
  });

  it('surfaces server error bodies unchanged', async () => {
    stubFetch({ error: 'Release "bay-state-v6" is invalid; pin unchanged.', code: 'release_invalid' }, 422);
    await expect(getTaxonomyReleaseStatus()).rejects.toMatchObject({ status: 422, code: 'release_invalid' });
  });
});
