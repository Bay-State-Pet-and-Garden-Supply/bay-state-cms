// #239 — production broker transport under the PRODUCTION runtime (bun test).
//
// Bun suite: the Bun API server is the production runtime, and Bun's
// node:https does NOT implement the per-request `lookup` callback contract
// (it assumes the `all: true` array form and fails the connect). The
// transport therefore binds the socket with `createConnection` and dials the
// broker-validated address directly. This suite pins that binding under Bun
// itself, which the Vitest suites cannot do (they run under Node).
//
// No external network: a loopback server stands in for the destination, and
// the hostname (`localhost`) never resolves to the bound address — a
// transport that ignored the validated address, or that resolved the
// hostname itself, cannot pass.

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { nodeBrokerTransport } from '../../onboarding/browser-investigation/broker';

const servers: http.Server[] = [];

async function withServer(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

describe('broker transport binding under Bun (#239)', () => {
  it('reaches only the broker-validated address, not a runtime-resolved hostname', async () => {
    const port = await withServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>validated destination</html>');
    });
    const res = await nodeBrokerTransport({
      // `localhost` may resolve to ::1 first on this machine; the validated
      // address is the IPv4 loopback the server actually listens on.
      url: `http://localhost:${port}/`,
      timeoutMs: 5000,
      validatedAddresses: ['127.0.0.1'],
      maxBodyBytes: 1024 * 1024,
    });
    expect(res.status).toBe(200);
    expect(res.body.toString('utf8')).toContain('validated destination');
    expect(res.connectedIp).toBe('127.0.0.1');
  });

  it('surfaces a refused bound destination as a transport failure (never a silent fallback)', async () => {    // Nothing listens on the (validated) alternate loopback address.
    await expect(
      nodeBrokerTransport({
        url: 'http://localhost:9/',
        timeoutMs: 3000,
        validatedAddresses: ['127.0.0.2'],
        maxBodyBytes: 1024,
      }),
    ).rejects.toThrowError(/fetch_failed/);
  });

  it('binds the socket with createConnection, never a per-request lookup override', () => {
    // Bun's node:https does not implement the `lookup` callback contract and
    // fails the connect; this is the exact regression the suite exists for.
    const source = fs.readFileSync(
      new URL('../../onboarding/browser-investigation/broker.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('createConnection:');
    expect(source).not.toMatch(/^\s*lookup:\s*\(/m);
  });
});
