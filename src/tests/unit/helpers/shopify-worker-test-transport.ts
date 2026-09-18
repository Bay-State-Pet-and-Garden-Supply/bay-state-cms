// Shared deterministic transport doubles for Shopify worker suites.
//
// The #216 endpoint-selection and T4 (#228) policy-execution suites drive
// `doStaticExtract` with the same injected DNS + page/endpoint routing:
// one definition here so the suites cannot drift. Pure (no DB, no
// network): Vitest-safe.

import { vi, type ExpectStatic } from 'vitest';

/** Public-IP DNS double (never resolves private/link-local destinations). */
export function publicTestLookup(): (hostname: string) => Promise<Array<{ address: string }>> {
  return async () => [{ address: '93.184.215.14' }];
}

/**
 * Routing fetch double: `.js` URLs serve the endpoint payload, everything
 * else serves the page HTML. Requested URLs append to `calls` for
 * endpoint-consultation assertions.
 */
export function routingTestTransport(html: string, js: string, calls: string[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith('.js')) return new Response(js, { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  });
}

/** Shared endpoint-resolution assertions (T4 + #216 suites must not drift). */
// fallow-ignore-next-line unused-export — shared by both Shopify worker suites
export function expectEndpointGtinResolved(
  expectFn: ExpectStatic,
  result: {
    failureCode?: unknown;
    selectedReceipt?: { matchedBy?: unknown } | null;
    matrixDecision?: { matchedBy?: unknown } | null;
  },
  calls: string[],
): void {
  expectFn(calls.some((u) => u.endsWith('.js'))).toBe(true);
  expectFn(result.failureCode).toBeFalsy();
  expectFn(result.selectedReceipt).toBeDefined();
  const matchedBy = result.selectedReceipt?.matchedBy ?? result.matrixDecision?.matchedBy;
  expectFn(matchedBy).toBe('gtin');
}
