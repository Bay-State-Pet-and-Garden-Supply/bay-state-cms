// Tier 1 validating forward proxy (#237).
//
// Host-side egress gate for the render container: the container's proxy env
// points here, and this proxy validates EVERY request through the broker
// policy (approved hosts, path policy, public DNS per hop, content types,
// byte budgets) before forwarding it via `broker.fetch`. The proxy adds no
// policy of its own — one validation path, two entry shapes (direct
// broker.fetch for Tier 0, proxy-form GET for the render container).
//
// HTTPS through the boundary (validating CONNECT interception): Chromium
// carries HTTPS through an HTTP proxy via CONNECT, which cannot be refused
// outright without breaking real https:// navigation — yet an opaque tunnel
// would hide method/path/body from validation and is never sufficient.
// CONNECT is therefore intercepted, not relayed: the target must be an
// approved host on port 443 (exact broker-scope match, nothing else), the
// proxy answers 200 and terminates the tunnel with a per-run credential,
// then validates every inner request through the broker policy and fulfills
// via `broker.fetch`. Off-scope hosts, non-443 ports, and malformed
// authorities are refused without a tunnel; inner non-GET methods and
// non-origin-form targets are denied; broker failures relay as 502 with the
// broker code only. The tunnel is never opaque and never bypasses the
// broker — byte-budget overruns stop the relay mid-stream (broker ceiling)
// and surface as 502 response_too_large.
//
// Trust model for the interception: the browser accepts the per-run
// credential because the render worker launches it with certificate errors
// ignored — scoped to the in-container worker only (host code never imports
// it). Upstream TLS is still genuinely validated: the proxy's sole upstream
// is `broker.fetch`, which validates DNS per hop and enforces content-type
// and byte policy. The per-run credential is generated at proxy start via
// the host `openssl` CLI; when generation fails the proxy still relays
// plain-HTTP GETs but reports `mitmAvailable: false` and refuses CONNECT
// as opaque_tunnel_refused (fail closed, current behavior preserved).
//
// Denials (all fail closed, operator-safe codes, no upstream detail leaks):
// - opaque CONNECT tunnels refused (mirrors the broker: tunnels hide
//   method/path/body from validation — never sufficient);
// - non-GET methods refused; absolute-form target required;
// - broker validation failures relayed as 502 with the broker code only;
// - byte-budget overruns stop the relay mid-stream (broker ceiling) and
//   surface as 502 response_too_large.
//
// Lifecycle: `startRenderProxy` binds 127.0.0.1 on an ephemeral port and
// returns the proxy URL for the render spec plus `close()`. One proxy per
// render run; the harness closes it in a finally (no cross-run proxy).
//
// Network-surface note for the containment audit: this module plus
// `broker.ts` are the ONLY investigation modules with network surface. This
// proxy's sole upstream is `broker.fetch(` (asserted statically); its
// `node:http` surface is the inbound server socket (createServer) plus the
// inbound tunnel listener, never a direct upstream client. The `openssl`
// subprocess generates a local credential only (no network).

import * as http from 'node:http';
import * as tls from 'node:tls';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { InvestigationBroker, scopeFromSampleUrls, type BrokerDeps } from './broker';
import { BudgetLedger } from './budgets';
import type { InvestigationBudget } from '../../shared/schemas/browser-investigation';

interface RenderProxyOptions {
  investigationId: string;
  workspaceId: string;
  sampleUrls: string[];
  budget: InvestigationBudget;
  ledger: BudgetLedger;
  brokerDeps?: BrokerDeps;
  /**
   * Interface to bind. Default 127.0.0.1 (hermetic, test-friendly). The
   * harness binds the wildcard interface so the render container can
   * reach the proxy via the host-gateway alias — validation stays the
   * boundary (every request is broker-scoped and budgeted), not the bind.
   */
  bindHost?: string;
  /**
   * Host name advertised in the proxy URL. Default is the bind host. The
   * harness advertises `host.docker.internal` (argv carries the matching
   * `--add-host` alias); direct test callers keep the loopback default.
   */
  advertiseHost?: string;
}

export interface RunningRenderProxy {
  /** Proxy URL for the render spec env (advertised host + ephemeral port). */
  url: string;
  /**
   * True when the per-run intercepting credential was generated and
   * CONNECT to approved hosts is intercepted (HTTPS works through the
   * boundary). False when generation failed: plain-HTTP relay still
   * works, CONNECT is refused outright (fail closed).
   */
  mitmAvailable: boolean;
  close(): Promise<void>;
}

const PROXY_SERVER_TIMEOUT_MS = 30_000;

/** Per-run intercepting credential (self-signed, short-lived, never leaves the host). */
interface MitmCredential {
  keyPem: string;
  certPem: string;
}

/**
 * Generate one per-run credential via the host `openssl` CLI. Returns null
 * (never throws) when openssl is missing or generation fails — the caller
 * then refuses CONNECT outright instead of opening an opaque tunnel.
 */
async function generateMitmCredential(): Promise<MitmCredential | null> {
  const execFileAsync = promisify(execFile);
  let dir: string | null = null;
  try {
    await execFileAsync('openssl', ['version'], { timeout: 10_000 });
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'binv-mitm-'));
    const keyPath = path.join(dir, 'key.pem');
    const certPath = path.join(dir, 'cert.pem');
    await execFileAsync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath, '-out', certPath,
        '-days', '1', '-subj', '/CN=binv-validating-proxy/',
      ],
      { timeout: 30_000 },
    );
    const [keyPem, certPem] = await Promise.all([
      fs.readFile(keyPath, 'utf8'),
      fs.readFile(certPath, 'utf8'),
    ]);
    if (!keyPem.includes('PRIVATE KEY') || !certPem.includes('CERTIFICATE')) return null;
    return { keyPem, certPem };
  } catch {
    return null;
  } finally {
    if (dir) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup of the temp credential directory.
      }
    }
  }
}

/**
 * Start the per-run validating forward proxy. Resolves when bound; rejects
 * (never half-bound) when the loopback cannot be bound.
 */
export function startRenderProxy(opts: RenderProxyOptions): Promise<RunningRenderProxy> {
  const scope = scopeFromSampleUrls(opts.investigationId, opts.workspaceId, opts.sampleUrls);
  const broker = new InvestigationBroker(scope, opts.budget, opts.brokerDeps, opts.ledger);
  return generateMitmCredential().then(
    (mitm) =>
      new Promise<RunningRenderProxy>((resolve, reject) => {
        const server = http.createServer((req, res) => {
          void handleProxyRequest(req, res, broker).catch(() => {
            // handleProxyRequest always ends the response; this is a backstop.
            try {
              if (!res.writableEnded) {
                res.writeHead(502, { 'content-type': 'text/plain' });
                res.end('proxy_failed');
              }
            } catch {
              // Best-effort: never throw out of the request handler.
            }
          });
        });
        // CONNECT interception (HTTPS through the validating boundary):
        // approved host + 443 → intercepted tunnel; anything else refused
        // without a tunnel. Without a per-run credential every CONNECT is
        // refused as opaque (fail closed).
        server.on('connect', (req, socket: Duplex, head: Buffer) => {
          void handleConnect(req, socket, head, broker, mitm).catch(() => {
            try {
              socket.destroy();
            } catch {
              // Best-effort: never throw out of the tunnel handler.
            }
          });
        });
        server.timeout = PROXY_SERVER_TIMEOUT_MS;
        const bindHost = opts.bindHost ?? '127.0.0.1';
        const advertiseHost = opts.advertiseHost ?? bindHost;
        server.once('error', reject);
        server.listen(0, bindHost, () => {
          server.off('error', reject);
          const address = server.address() as AddressInfo | null;
          if (!address || typeof address.port !== 'number') {
            void closeServer(server).finally(() => {
              reject(new Error('proxy_failed: validating proxy bound without a port'));
            });
            return;
          }
          resolve({
            url: `http://${advertiseHost}:${address.port}`,
            mitmAvailable: mitm !== null,
            close: () => closeServer(server),
          });
        });
      }),
  );
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function handleProxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  broker: InvestigationBroker,
): Promise<void> {
  // Opaque tunnels hide method/path/body from the broker — refused outright.
  if ((req.method ?? '').toUpperCase() === 'CONNECT') {
    deny(res, 405, 'opaque_tunnel_refused');
    return;
  }
  if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
    deny(res, 405, 'method_forbidden');
    return;
  }
  // Forward-proxy form carries the absolute URI; origin-form without a Host
  // cannot be validated to an approved host.
  const target = (req.url ?? '').trim();
  if (!/^https?:\/\//i.test(target)) {
    deny(res, 400, 'invalid_url');
    return;
  }
  // Drain any request body (GETs should carry none; never parse it).
  req.resume();
  try {
    // The single upstream: broker-mediated GET (policy + budgets enforced).
    const fetched = await broker.fetch(target);
    res.writeHead(fetched.status, {
      'content-type': fetched.contentType,
      'content-length': fetched.body.length,
    });
    res.end(fetched.body);
  } catch (err) {
    deny(res, 502, proxyCodeOf(err));
  }
}

function deny(res: http.ServerResponse, status: number, code: string): void {
  try {
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(code);
  } catch {
    // Best-effort: the socket may already be gone.
  }
}

/** Operator-safe relay code only: broker codes pass through, anything else is a plain fetch failure. */
function proxyCodeOf(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && /^[a-z_]+$/.test(code) && code.length <= 40) return code;
  return 'fetch_failed';
}

// ─── Validating CONNECT interception (HTTPS through the boundary) ─────────
// Chromium carries HTTPS through an HTTP proxy via CONNECT. An opaque relay
// would hide method/path/body from the broker, so CONNECT is intercepted:
// the authority must name an approved host on port 443, the proxy answers
// 200 and terminates TLS with the per-run credential, and every inner
// request is validated + fulfilled through `broker.fetch` — the same single
// upstream as plain-HTTP relay. One request per tunnel (inner responses
// close the tunnel); clients open a fresh tunnel per request.

/** CONNECT authority parsed to an exact host + numeric port (null when malformed). */
function parseTunnelTarget(target: string): { host: string; port: number } | null {
  if (!target || target.length > 260 || /[\s/]/.test(target)) return null;
  const sep = target.lastIndexOf(':');
  if (sep <= 0 || sep === target.length - 1) return null;
  const host = target.slice(0, sep).toLowerCase().replace(/\.$/, '');
  const port = Number(target.slice(sep + 1));
  if (!host || !Number.isSafeInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

const TUNNEL_REASONS: Record<number, string> = {
  200: 'Connection Established',
  400: 'Bad Request',
  403: 'Forbidden',
  405: 'Method Not Allowed',
  502: 'Bad Gateway',
};

/** Refuse a CONNECT without opening a tunnel (flush the status, then close). */
function refuseTunnel(socket: Duplex, status: number, code: string): void {
  try {
    const body = Buffer.from(code, 'utf8');
    socket.end(
      `HTTP/1.1 ${status} ${TUNNEL_REASONS[status] ?? 'Error'}\r\n` +
        'content-type: text/plain\r\n' +
        `content-length: ${body.length}\r\n` +
        `connection: close\r\n\r\n${code}`,
    );
  } catch {
    try {
      socket.destroy();
    } catch {
      // Best-effort: the socket may already be gone.
    }
  }
}

async function handleConnect(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  broker: InvestigationBroker,
  mitm: MitmCredential | null,
): Promise<void> {
  const target = (req.url ?? '').trim();
  const parsed = parseTunnelTarget(target);
  if (!parsed) {
    refuseTunnel(socket, 400, 'invalid_tunnel_target');
    return;
  }
  if (parsed.port !== 443) {
    refuseTunnel(socket, 403, 'invalid_tunnel_port');
    return;
  }
  // Exact broker-scope match BEFORE any tunnel exists: literal IPs and
  // unlisted hosts never reach the handshake. The broker revalidates the
  // full inner URL per request — this gate only decides tunnel vs refusal.
  if (!broker.getScope().approvedHosts.includes(parsed.host)) {
    refuseTunnel(socket, 403, 'host_not_approved');
    return;
  }
  if (!mitm) {
    // No per-run credential: refuse rather than relay opaque bytes.
    refuseTunnel(socket, 405, 'opaque_tunnel_refused');
    return;
  }
  socket.write('HTTP/1.1 200 Connection Established\r\nproxy-agent: binv-validating-proxy\r\n\r\n');
  if (head?.length) socket.unshift(head);
  const secure = new tls.TLSSocket(socket, {
    isServer: true,
    key: mitm.keyPem,
    cert: mitm.certPem,
  });
  secure.setTimeout(PROXY_SERVER_TIMEOUT_MS);
  secure.on('timeout', () => secure.destroy());
  secure.on('error', () => secure.destroy());
  await serveTunnelRequest(secure, parsed.host, broker);
}

/** Inner request head (origin-form) parsed off the terminated tunnel. */
interface InnerRequest {
  method: string;
  target: string;
  contentLength: number;
}

function parseInnerHead(head: string): InnerRequest | null {
  const lines = head.split('\r\n');
  const [method, target, version] = (lines[0] ?? '').split(' ');
  if (!method || !target || !version?.startsWith('HTTP/')) return null;
  let contentLength = 0;
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const sep = line.indexOf(':');
    if (sep === -1) return null;
    const name = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (name === 'content-length') {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 0 || n > MAX_TUNNEL_BODY_BYTES) return null;
      contentLength = n;
    }
    if (name === 'transfer-encoding') return null;
  }
  return { method: method.toUpperCase(), target, contentLength };
}

/** Cap on a tunneled request body (GETs carry none; never parsed, only drained). */
const MAX_TUNNEL_BODY_BYTES = 8192;
/** Cap on a tunneled request head (method + target + headers). */
const MAX_TUNNEL_HEAD_BYTES = 65536;

const INNER_REASONS: Record<number, string> = {
  200: 'OK',
  400: 'Bad Request',
  405: 'Method Not Allowed',
  502: 'Bad Gateway',
};

function innerStatusReason(status: number): string {
  return INNER_REASONS[status] ?? 'Unknown';
}

/** Write one inner response and close the tunnel (one request per tunnel). */
function respondInner(secure: tls.TLSSocket, status: number, contentType: string, body: Buffer): void {
  try {
    secure.write(
      `HTTP/1.1 ${status} ${innerStatusReason(status)}\r\n` +
        `content-type: ${contentType}\r\n` +
        `content-length: ${body.length}\r\n` +
        'connection: close\r\n\r\n',
    );
    secure.end(body);
  } catch {
    try {
      secure.destroy();
    } catch {
      // Best-effort: the tunnel may already be gone.
    }
  }
}

/**
 * Serve one validated request off a terminated tunnel. Every inner request
 * goes through `broker.fetch` — full host/path/DNS/budget validation per
 * request, fulfilled from the broker transport. Never relays bytes the
 * broker has not approved.
 */
async function serveTunnelRequest(
  secure: tls.TLSSocket,
  tunnelHost: string,
  broker: InvestigationBroker,
): Promise<void> {
  let buf = Buffer.alloc(0);
  let done = false;
  const finish = (): void => {
    done = true;
    try {
      secure.destroy();
    } catch {
      // Best-effort: the tunnel is already closing.
    }
  };
  secure.on('data', (chunk: Buffer) => {
    if (done) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buf.length + incoming.length > MAX_TUNNEL_HEAD_BYTES + MAX_TUNNEL_BODY_BYTES) {
      finish();
      return;
    }
    buf = Buffer.concat([buf, incoming]);
    const end = buf.indexOf(Buffer.from('\r\n\r\n'));
    if (end === -1) return;
    const headText = buf.subarray(0, end).toString('utf8');
    const rest = buf.subarray(end + 4);
    const inner = parseInnerHead(headText);
    if (!inner) {
      // A response is already on the wire: seal (ignore the rest) and let
      // its FIN close the tunnel — destroying here would race the flush.
      respondInner(secure, 400, 'text/plain', Buffer.from('invalid_url', 'utf8'));
      done = true;
      return;
    }
    if (inner.method !== 'GET') {
      respondInner(secure, 405, 'text/plain', Buffer.from('method_forbidden', 'utf8'));
      done = true;
      return;
    }
    // Origin-form only inside the tunnel: the authority is the validated
    // CONNECT target, so absolute-form here would be a scope escape.
    if (!inner.target.startsWith('/')) {
      respondInner(secure, 400, 'text/plain', Buffer.from('invalid_url', 'utf8'));
      done = true;
      return;
    }
    if (rest.length < inner.contentLength) return;
    done = true;
    const url = `https://${tunnelHost}${inner.target}`;
    // Single-line broker call — the containment suite asserts every fetch
    // call site in this file is the broker-mediated one.
    broker.fetch(url).then((fetched) => {
      respondInner(secure, fetched.status, fetched.contentType, fetched.body);
    }).catch((err: unknown) => {
      respondInner(secure, 502, 'text/plain', Buffer.from(proxyCodeOf(err), 'utf8'));
    });
  });
  secure.on('end', () => finish());
  secure.on('close', () => {
    done = true;
  });
}
