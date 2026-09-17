// T3 (#227) — fetch-broker enforcement (Vitest; deterministic fakes + live TLS/DNS).
//
// The broker is the authoritative network boundary: method, path, headers,
// public DNS/IP destinations, redirect hops, body sizes, and content types
// are enforced here with upstream TLS verification intact. Opaque CONNECT
// tunnels are refused. DNS validation binds to the connection destination
// and every redirect hop revalidates.

import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  BROKER_USER_AGENT,
  InvestigationBroker,
  BrokerError,
  nodeBrokerTransport,
  scopeFromSampleUrls,
  type BrokerErrorCode,
  type BrokerFetchOptions,
  type BrokerResponse,
  type BrokerScope,
  type BrokerTransport,
  type BrokerTransportRequest,
  type BrokerTransportResponse,
} from '../../onboarding/browser-investigation/broker';
import { resolveInvestigationBudget } from '../../shared/schemas/browser-investigation';
import { BudgetLedger } from '../../onboarding/browser-investigation/budgets';

const INV = 'binv_1';
const WS = 'ws_1';
const GOOD = 'https://brand.example/products/alpha';

function scopeFor(...urls: string[]): BrokerScope {
  return scopeFromSampleUrls(INV, WS, urls);
}

function lookupFor(map: Record<string, string[] | Error>): (host: string) => Promise<string[]> {
  return async (host: string) => {
    const entry = map[host.toLowerCase()];
    if (entry instanceof Error) throw entry;
    if (!entry) throw new Error(`unexpected lookup: ${host}`);
    return entry;
  };
}

function canned(
  handler: (req: BrokerTransportRequest) => { status: number; headers?: Record<string, string>; body?: string | Buffer },
): { transport: BrokerTransport; calls: BrokerTransportRequest[] } {
  const calls: BrokerTransportRequest[] = [];
  const transport: BrokerTransport = async (req) => {
    calls.push(req);
    const res = handler(req);
    const body = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body ?? 'ok', 'utf8');
    const headers: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(res.headers ?? { 'content-type': 'text/html' })) {
      headers[k.toLowerCase()] = v;
    }
    const response: BrokerTransportResponse = {
      status: res.status,
      headers,
      body,
      connectedIp: req.validatedAddresses[0] ?? null,
    };
    return response;
  };
  return { transport, calls };
}

const PUBLIC_IP = '93.184.216.34';

function brokerFor(
  scopeHosts: string[],
  opts: {
    lookup?: (host: string) => Promise<string[]>;
    transport?: BrokerTransport;
    budget?: Parameters<typeof resolveInvestigationBudget>[0];
    ledger?: BudgetLedger;
  } = {},
): InvestigationBroker {
  const budget = resolveInvestigationBudget(opts.budget);
  const scope = scopeFor(...scopeHosts);
  return new InvestigationBroker(scope, budget, {
    lookup: opts.lookup ?? lookupFor({ 'brand.example': [PUBLIC_IP], 'cdn.example': [PUBLIC_IP] }),
    transport: opts.transport ?? canned(() => ({ status: 200 })).transport,
  }, opts.ledger);
}

describe('broker request mediation', () => {
  it('sends only the broker-owned investigation user agent (pinned contract)', () => {
    expect(BROKER_USER_AGENT).toMatch(/BayStateCMS-Investigation\/1/);
  });

  it('mediates a permitted GET and hashes the full body', async () => {
    const { transport, calls } = canned(() => ({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<html><title>t</title></html>',
    }));
    const broker = brokerFor([GOOD], { transport });
    expect(broker.getScope().approvedHosts).toEqual(['brand.example']);
    const res: BrokerResponse = await broker.fetch(GOOD);
    expect(res.status).toBe(200);
    expect(res.finalUrl).toBe(GOOD);
    expect(res.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.byteLength).toBe(res.body.length);
    expect(res.connectedIp).toBe(PUBLIC_IP);
    // The transport receives ONLY broker-validated public addresses (DNS binding).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.validatedAddresses).toEqual([PUBLIC_IP]);
    expect(calls[0]!.url).toBe(GOOD);
    expect(broker.getLedger().snapshot().requestAttempts).toBe(1);
  });

  it('refuses non-GET methods; CONNECT tunnels are refused as opaque', async () => {
    const broker = brokerFor([GOOD]);
    const opts: BrokerFetchOptions = { method: 'POST' };
    try {
      await broker.fetch(GOOD, opts);
      expect.unreachable('POST must be refused');
    } catch (err) {
      const code: BrokerErrorCode = (err as BrokerError).code;
      expect(code).toBe('method_forbidden');
    }
    await expect(broker.fetch(GOOD, { method: 'CONNECT' })).rejects.toThrowError(/opaque_tunnel_refused/);
    await expect(broker.fetch(GOOD, { method: 'DELETE' })).rejects.toThrowError(/method_forbidden/);
  });

  it('refuses caller-supplied headers (broker owns every header)', async () => {
    const broker = brokerFor([GOOD]);
    await expect(broker.fetch(GOOD, { headers: { 'X-Custom': '1' } })).rejects.toThrowError(/header_forbidden/);
    await expect(broker.fetch(GOOD, { headers: { Cookie: 'session=1' } })).rejects.toThrowError(/header_forbidden/);
  });

  it('refuses unsupported channels (WebSocket, non-HTTP schemes)', async () => {
    const broker = brokerFor([GOOD]);
    await expect(broker.fetch('wss://brand.example/socket')).rejects.toThrowError(/unsupported_channel/);
    await expect(broker.fetch('ws://brand.example/socket')).rejects.toThrowError(/unsupported_channel/);
    await expect(broker.fetch('ftp://brand.example/file')).rejects.toThrowError(/unsupported_channel/);
    await expect(broker.fetch('file:///etc/passwd')).rejects.toThrowError(/unsupported_channel/);
  });

  it('refuses credential-bearing URLs, non-standard ports, and invalid URLs', async () => {
    const broker = brokerFor([GOOD]);
    await expect(broker.fetch('https://user:pass@brand.example/products/alpha')).rejects.toThrowError(
      /invalid_url/,
    );
    await expect(broker.fetch('https://brand.example:8443/products/alpha')).rejects.toThrowError(/invalid_url/);
    await expect(broker.fetch('not a url')).rejects.toThrowError(/invalid_url/);
  });

  it('refuses hosts outside the immutable scope (approval is per-host, exact)', async () => {
    const broker = brokerFor([GOOD]);
    await expect(broker.fetch('https://evil.example/products/alpha')).rejects.toThrowError(/host_not_approved/);
    await expect(broker.fetch('https://sub.brand.example/products/alpha')).rejects.toThrowError(
      /host_not_approved/,
    );
  });

  it('refuses cart/action/admin/CGI paths even on approved hosts', async () => {
    const broker = brokerFor([GOOD]);
    for (const path of [
      '/cart/add',
      '/checkout',
      '/account/login',
      '/admin/products',
      '/cgi-bin/dbupload.cgi',
    ]) {
      await expect(broker.fetch(`https://brand.example${path}`), path).rejects.toThrowError(/path_forbidden/);
    }
  });

  it('refuses literal private IPs (including obfuscated forms)', async () => {
    const broker = brokerFor(['https://127.0.0.1/x', 'https://10.0.0.9/x', 'https://[::1]/x']);
    await expect(broker.fetch('https://127.0.0.1/x')).rejects.toThrowError(/private_destination/);
    await expect(broker.fetch('https://10.0.0.9/x')).rejects.toThrowError(/private_destination/);
    await expect(broker.fetch('https://0x7f.0x0.0x0.0x1/x')).rejects.toThrowError(
      /private_destination|host_not_approved/,
    );
  });

  it('fails closed when DNS fails or returns nothing', async () => {
    const failing = brokerFor([GOOD], { lookup: lookupFor({ 'brand.example': new Error('boom') }) });
    await expect(failing.fetch(GOOD)).rejects.toThrowError(/dns_failed/);
    const empty = brokerFor([GOOD], { lookup: lookupFor({ 'brand.example': [] }) });
    await expect(empty.fetch(GOOD)).rejects.toThrowError(/dns_failed/);
  });

  it('denies DNS answers containing non-public addresses', async () => {
    const broker = brokerFor([GOOD], { lookup: lookupFor({ 'brand.example': [PUBLIC_IP, '10.0.0.5'] }) });
    await expect(broker.fetch(GOOD)).rejects.toThrowError(/private_destination/);
  });

  it('fails closed over REAL DNS for loopback (no stubs)', async () => {
    const budget = resolveInvestigationBudget({});
    const broker = new InvestigationBroker(scopeFor('https://localhost/x'), budget, {
      transport: canned(() => ({ status: 200 })).transport,
    });
    await expect(broker.fetch('https://localhost/x')).rejects.toThrowError(/private_destination/);
  });
});

describe('broker redirect mediation', () => {
  it('follows in-scope redirects and preserves the chain', async () => {
    const { transport } = canned((req) =>
      req.url === GOOD
        ? { status: 302, headers: { location: 'https://brand.example/products/beta' } }
        : { status: 200, body: 'final' },
    );
    const broker = brokerFor([GOOD], { transport });
    const res = await broker.fetch(GOOD);
    expect(res.finalUrl).toBe('https://brand.example/products/beta');
    expect(res.redirectChain).toEqual(['https://brand.example/products/beta']);
  });

  it('revalidates every hop: off-scope redirect targets are refused', async () => {
    const { transport, calls } = canned(() => ({
      status: 302,
      headers: { location: 'https://evil.example/steal' },
    }));
    const broker = brokerFor([GOOD], { transport });
    await expect(broker.fetch(GOOD)).rejects.toThrowError(/host_not_approved/);
    expect(calls).toHaveLength(1);
  });

  it('revalidates every hop: DNS rebinding to private mid-chain is denied', async () => {
    let lookups = 0;
    const rebinding = async (host: string): Promise<string[]> => {
      void host;
      lookups += 1;
      return lookups === 1 ? [PUBLIC_IP] : ['169.254.169.254'];
    };
    const { transport } = canned((req) =>
      req.url === GOOD
        ? { status: 302, headers: { location: 'https://brand.example/products/beta' } }
        : { status: 200, body: 'rebound' },
    );
    const broker = brokerFor([GOOD], { lookup: rebinding, transport });
    await expect(broker.fetch(GOOD)).rejects.toThrowError(/private_destination/);
    expect(lookups).toBe(2);
  });

  it('denies redirected literal-private destinations in approved scopes', async () => {
    const lan = 'http://169.254.169.254/latest/meta-data/';
    const { transport } = canned(() => ({ status: 302, headers: { location: lan } }));
    const broker = brokerFor([GOOD, lan], { transport });
    await expect(broker.fetch(GOOD)).rejects.toThrowError(/private_destination/);
  });

  it('stops at the redirect-hop cap', async () => {
    const { transport } = canned(() => ({ status: 302, headers: { location: GOOD } }));
    const broker = brokerFor([GOOD], { transport, budget: { maxRedirectHops: 0 } });
    await expect(broker.fetch(GOOD)).rejects.toThrowError(/too_many_redirects/);
  });
});

describe('broker body and content-type enforcement', () => {
  it('refuses forbidden content types', async () => {
    const { transport } = canned(() => ({
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body: 'binary',
    }));
    await expect(brokerFor([GOOD], { transport }).fetch(GOOD)).rejects.toThrowError(/content_type_forbidden/);
  });

  it('stops oversized downloads with response_too_large (never a budget increase)', async () => {
    const { transport } = canned(() => ({ status: 200, body: 'x'.repeat(4096) }));
    const broker = brokerFor([GOOD], { transport, budget: { maxResponseBytesPerResponse: 1024 } });
    await expect(broker.fetch(GOOD)).rejects.toThrowError(/response_too_large/);
  });

  it('counts denied requests and redirects against the attempt budget', async () => {
    const ledger = new BudgetLedger(resolveInvestigationBudget({ maxRequestAttempts: 2 }));
    const { transport } = canned(() => ({ status: 200, body: 'ok' }));
    const broker = brokerFor([GOOD], { transport, budget: { maxRequestAttempts: 2 }, ledger });
    await broker.fetch(GOOD);
    await expect(broker.fetch('https://evil.example/x')).rejects.toThrowError(/host_not_approved/);
    await expect(broker.fetch(GOOD)).rejects.toThrowError(/request_budget_exhausted/);
  });

  it('charges every redirect hop (chains cannot fan out past the budget)', async () => {
    const { transport, calls } = canned((req) =>
      req.url === GOOD
        ? { status: 302, headers: { location: 'https://brand.example/products/beta' } }
        : { status: 200, body: 'final' },
    );
    const broker = brokerFor([GOOD], { transport, budget: { maxRequestAttempts: 2 } });
    const res = await broker.fetch(GOOD);
    expect(res.finalUrl).toBe('https://brand.example/products/beta');
    expect(calls).toHaveLength(2);
    expect(broker.getLedger().snapshot().requestAttempts).toBe(2);
    await expect(broker.fetch(GOOD)).rejects.toThrowError(/request_budget_exhausted/);
  });

  it('hands each attempt a streaming ceiling at or below the tightest cap', async () => {
    const { transport, calls } = canned(() => ({ status: 200, body: 'ok' }));
    const broker = brokerFor([GOOD], { transport, budget: { maxResponseBytesPerResponse: 4096 } });
    await broker.fetch(GOOD);
    expect(calls[0]!.maxBodyBytes).toBeLessThanOrEqual(4096);
    expect(calls[0]!.maxBodyBytes).toBeGreaterThan(0);
  });

  it('wraps raw transport failures in stable codes', async () => {
    const failing: BrokerTransport = async () => {
      throw new Error('socket hangup');
    };
    await expect(brokerFor([GOOD], { transport: failing }).fetch(GOOD)).rejects.toThrowError(/fetch_failed/);
  });
});

describe('broker TLS validation (live handshake)', () => {
  it('refuses a self-signed upstream certificate over a real TLS handshake', async () => {
    let opensslOk = true;
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
    } catch {
      opensslOk = false;
    }
    if (!opensslOk) {
      console.warn('SKIP: openssl unavailable — self-signed TLS test skipped');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binv-tls-'));
    try {
      execFileSync(
        'openssl',
        ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
          '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')],
        { stdio: 'ignore' },
      );
      const server = https.createServer(
        { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) },
        (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<html></html>');
        },
      );
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      try {
        // Direct transport call with a validated loopback address: the ONLY
        // thing under test is upstream certificate verification.
        const tlsReq = {
          url: `https://localhost:${port}/`,
          timeoutMs: 5000,
          validatedAddresses: ['127.0.0.1'],
          maxBodyBytes: 1024 * 1024,
        };
        await expect(nodeBrokerTransport(tlsReq)).rejects.toThrowError(BrokerError);
        await expect(nodeBrokerTransport(tlsReq)).rejects.toThrowError(/tls_validation_failed/);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('aborts oversized downloads mid-stream over the real transport (no unbounded buffering)', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      // Lie about length AND stream past the ceiling: neither is trusted.
      res.write('x'.repeat(64 * 1024));
      res.write('y'.repeat(64 * 1024));
      res.end('z'.repeat(64 * 1024));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await expect(
        nodeBrokerTransport({
          url: `http://127.0.0.1:${port}/`,
          timeoutMs: 5000,
          validatedAddresses: ['127.0.0.1'],
          maxBodyBytes: 1024,
        }),
      ).rejects.toThrowError(/response_too_large/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('never ships an insecure override (static: verification cannot be disabled)', async () => {
    const source = fs.readFileSync(
      new URL('../../onboarding/browser-investigation/broker.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('rejectUnauthorized: true');
    expect(source).not.toContain('rejectUnauthorized: false');
    expect(source).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');
  });
});
