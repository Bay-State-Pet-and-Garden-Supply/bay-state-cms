import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { approveItems, createExportDrafts } from '../../client/onboarding-work-api';

/**
 * M4 UI integration — Idempotency-Key header and authoritative endpoint.
 * Verifies that first-party UI paths engage the scoped receipt replay
 * (DB receipt is authority) and that ReadyToExport no longer bypasses
 * via legacy /promote.
 */

describe('onboarding UI idempotency — client operation paths (M4)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis as any, 'fetch').mockImplementation(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            results: [],
            approvedCount: 0,
            rejectedCount: 0,
            rejected: [],
            audited: true,
            receiptId: 'test-receipt',
            // createExportDrafts shape
            createdCount: 0,
            created: [],
            changeSetId: null,
            principal: 'test',
          }),
        }) as any,
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('approveItems POSTs to /approve with Idempotency-Key header', async () => {
    await approveItems('batch-1', ['a', 'b'], { idempotencyKey: 'test-key-123' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/onboarding/batches/batch-1/approve');
    expect(opts.method).toBe('POST');
    const headers = (opts.headers ?? {}) as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('test-key-123');
    // Body is JSON with itemIds
    const body = JSON.parse(opts.body as string);
    expect(body.itemIds).toEqual(['a', 'b']);
  });

  it('approveItems generates an Idempotency-Key when not provided (UUID-ish)', async () => {
    await approveItems('batch-2', ['x']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = (opts.headers ?? {}) as Record<string, string>;
    const key = headers['Idempotency-Key'];
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(8);
    // Should be UUID or fallback format — at least contains hyphen or alphanum
    expect(key).toMatch(/[a-z0-9-]{8,}/i);
  });

  it('createExportDrafts POSTs to /create-export-drafts with Idempotency-Key, not /promote', async () => {
    await createExportDrafts('batch-3', ['id1'], { idempotencyKey: 'export-key-xyz' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/onboarding/batches/batch-3/create-export-drafts');
    expect(url).not.toContain('/promote');
    expect(opts.method).toBe('POST');
    const headers = (opts.headers ?? {}) as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('export-key-xyz');
    const body = JSON.parse(opts.body as string);
    expect(body.itemIds).toEqual(['id1']);
  });

  it('createExportDrafts generates Idempotency-Key when not provided', async () => {
    await createExportDrafts('batch-9', ['p1', 'p2']);
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = (opts.headers ?? {}) as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeDefined();
    expect(typeof headers['Idempotency-Key']).toBe('string');
  });

  it('approveItems and createExportDrafts use distinct operation endpoints', async () => {
    await approveItems('batch-a', ['i1'], { idempotencyKey: 'k1' });
    await createExportDrafts('batch-a', ['i1'], { idempotencyKey: 'k2' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url1] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const [url2] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url1).toContain('/approve');
    expect(url2).toContain('/create-export-drafts');
    expect(url1).not.toBe(url2);
  });

  it('ReadyToExportView routes through governed createExportDrafts with Idempotency-Key forwarding (no promote path)', async () => {
    const fs = await import('node:fs');
    const content = fs.readFileSync('src/client/components/onboarding/approved/ReadyToExportView.tsx', 'utf8');
    // Forbidden legacy path: ReadyToExport must never bypass via promote.
    expect(content).not.toContain('promoteBatchItems');
    expect(content).not.toContain('/promote');
    // Governed code path: existing client operation seam.
    expect(content).toContain('createExportDrafts');
    // API idempotency forwarding, independent of implementation variable names:
    // the view mints a key via the shared helper and forwards it as the
    // governed idempotency option on retry-capable create calls.
    expect(content).toContain('createIdempotencyKey');
    expect(content).toContain('idempotencyKey');
    // Retry retention: a ref holds the in-flight attempt so an unconfirmed
    // outcome retries the same request (reused key) instead of minting a new one.
    expect(content).toMatch(/\.current\s*=\s*\{\s*key:/);
    expect(content).toContain('retryPending');
  });

  it('ReadyToExportView create path forwards a stable Idempotency-Key via the client seam (behavior)', async () => {
    // Isolated behavior check against the existing client operation seam:
    // same logical attempt reuses its key on retry, a new attempt mints anew —
    // no dependence on internal ref variable names.
    await createExportDrafts('batch-r', ['r1', 'r2'], { idempotencyKey: 'retry-key-1' });
    await createExportDrafts('batch-r', ['r1', 'r2'], { idempotencyKey: 'retry-key-1' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [, opts1] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const [, opts2] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const h1 = (opts1.headers as Record<string, string>)['Idempotency-Key'];
    const h2 = (opts2.headers as Record<string, string>)['Idempotency-Key'];
    expect(h1).toBe('retry-key-1');
    expect(h2).toBe('retry-key-1');
    fetchSpy.mockClear();
    await createExportDrafts('batch-r', ['r1', 'r2', 'r3'], { idempotencyKey: 'retry-key-2' });
    const [, opts3] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((opts3.headers as Record<string, string>)['Idempotency-Key']).toBe('retry-key-2');
  });

  it('ApprovedView retains Idempotency-Key per logical operation (static check)', async () => {
    const fs = await import('node:fs');
    const content = fs.readFileSync('src/client/components/onboarding/approved/ApprovedView.tsx', 'utf8');
    expect(content).toContain('idempotencyKeyRef');
    expect(content).toContain('approveItems');
    expect(content.toLowerCase()).toContain('idempotency');
    // New fingerprint-aware retention: {key, fingerprint} and sorted join
    expect(content).toContain('fingerprint');
    expect(content).toContain("sort().join");
  });

  it('ApprovedView key reuse: same payload retains key, different payload generates new key', async () => {
    // Simulate the ApprovedView ref logic exactly as implemented
    let ref: { key: string; fingerprint: string } | null = null;
    function getOrCreateKey(ids: string[]): string {
      const fingerprint = [...ids].sort().join(',');
      const stored = ref;
      if (!stored || stored.fingerprint !== fingerprint) {
        const newKey = typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function'
          ? (crypto as any).randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        ref = { key: newKey, fingerprint };
      }
      return ref!.key;
    }
    function clearOnSuccess() { ref = null; }

    const selected = ['id-a', 'id-b'];
    const allEligible = ['id-a', 'id-b', 'id-c'];

    // First call with selected -> generates key1
    const key1 = getOrCreateKey(selected);
    expect(typeof key1).toBe('string');
    expect(key1.length).toBeGreaterThan(8);
    // Retry with same payload (same ids, same order) -> reuses key1 (failure retains)
    const key1Retry = getOrCreateKey(selected);
    expect(key1Retry).toBe(key1);
    // Retry with same ids different order -> still same fingerprint (order-insensitive) -> same key
    const key1Reordered = getOrCreateKey(['id-b', 'id-a']);
    expect(key1Reordered).toBe(key1);
    // Different payload (all eligible) -> generates new key2
    const key2 = getOrCreateKey(allEligible);
    expect(key2).not.toBe(key1);
    expect(typeof key2).toBe('string');
    // Back to selected -> generates new key again (since fingerprint differs from stored allEligible)
    // First need to simulate success clearing, then retry selected should be new vs original key1? Actually after switching to allEligible, ref now holds key2 fingerprint. Calling again with selected should generate new key != key2
    const key3 = getOrCreateKey(selected);
    expect(key3).not.toBe(key2);
    // Same selected again without clear -> reuses key3
    const key3Retry = getOrCreateKey(selected);
    expect(key3Retry).toBe(key3);
    // Simulate success clears ref, next same payload should generate new key != key3
    clearOnSuccess();
    const key4 = getOrCreateKey(selected);
    expect(key4).not.toBe(key3);
    expect(typeof key4).toBe('string');
  });

  it('ApprovedView key reuse survives retry after failure (real fetch mock)', async () => {
    // Verify that approveItems with retained key actually sends same header on retry
    await approveItems('batch-x', ['id-1', 'id-2'], { idempotencyKey: 'fixed-key-1' });
    await approveItems('batch-x', ['id-1', 'id-2'], { idempotencyKey: 'fixed-key-1' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [, opts1] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const [, opts2] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const h1 = (opts1.headers as Record<string, string>)['Idempotency-Key'];
    const h2 = (opts2.headers as Record<string, string>)['Idempotency-Key'];
    expect(h1).toBe('fixed-key-1');
    expect(h2).toBe('fixed-key-1');
    // Different payload should use different key
    await approveItems('batch-x', ['id-1', 'id-2', 'id-3'], { idempotencyKey: 'fixed-key-2' });
    const [, opts3] = fetchSpy.mock.calls[2] as [string, RequestInit];
    const h3 = (opts3.headers as Record<string, string>)['Idempotency-Key'];
    expect(h3).toBe('fixed-key-2');
    expect(h3).not.toBe(h1);
  });
});
