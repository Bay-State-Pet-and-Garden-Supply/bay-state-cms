// Browser Investigation fetch broker (T3).
//
// The authoritative network boundary for investigation reads. It lives
// OUTSIDE the browser process: every permitted HTTP(S) request traverses
// this broker, which enforces method, path, headers, public DNS/IP
// destinations, redirect hops, body sizes, and content types with upstream
// TLS verification intact.
//
// - Only GET to approved hosts; cart/action/admin/CGI paths forbidden.
// - DNS is resolved at the broker, EVERY returned address must be public,
//   and the connection binds to a validated address (no second unchecked
//   lookup). Every redirect hop re-resolves and revalidates.
// - Opaque HTTPS CONNECT tunnels are refused; ws/wss (WebSocket), UDP, and
//   non-HTTP schemes are unsupported channels.
// - Upstream TLS verification is always on; there is no insecure override.
// - Two-layer byte enforcement: every attempt carries a streaming ceiling
//   (tightest remaining cap) so the transport aborts oversized downloads
//   mid-stream, and the ledger is charged post-hoc for exact accounting.
//   Content-Length is never trusted. Oversized downloads stop with
//   `response_too_large`, never with a silent budget increase.
// - The broker requests `Accept-Encoding: identity` so transfer and
//   decompressed bytes coincide; both ledgers are charged identically.
//
// Browser interception (Playwright routing, CDP) is defense-in-depth only:
// disabling it must not create direct egress, because no egress path exists
// outside this broker. The harness performs no fetch except through here
// (pinned by the containment suite).

import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { lookup as dnsLookup } from 'node:dns/promises';
import { sha256 } from '../../shared/hash';
import { classifyIp } from '../../shared/ssrf';
import type { InvestigationBudget } from '../../shared/schemas/browser-investigation';
import { BudgetLedger } from './budgets';

export const BROKER_USER_AGENT =
  'BayStateCMS-Investigation/1 (+local-bounded-read; investigation-only)';

export type BrokerErrorCode =
  | 'invalid_url'
  | 'method_forbidden'
  | 'header_forbidden'
  | 'path_forbidden'
  | 'host_not_approved'
  | 'private_destination'
  | 'dns_failed'
  | 'redirect_to_private'
  | 'too_many_redirects'
  | 'opaque_tunnel_refused'
  | 'unsupported_channel'
  | 'tls_validation_failed'
  | 'response_too_large'
  | 'content_type_forbidden'
  | 'request_budget_exhausted'
  | 'fetch_failed'
  | 'timeout';

export class BrokerError extends Error {
  readonly code: BrokerErrorCode;
  constructor(code: BrokerErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'BrokerError';
    this.code = code;
  }
}

/** Immutable investigation scope. Approved hosts derive from the sample URLs. */
export interface BrokerScope {
  investigationId: string;
  workspaceId: string;
  /** Lowercase approved hostnames (exact match; subdomains are NOT implied). */
  approvedHosts: string[];
}

export interface BrokerResponse {
  requestUrl: string;
  finalUrl: string;
  redirectChain: string[];
  status: number;
  contentType: string;
  byteLength: number;
  /** SHA-256 of the FULL retained body. Clipped bodies never produce this — oversized downloads throw. */
  bodyHash: string;
  body: Buffer;
  connectedIp: string | null;
}

export interface BrokerFetchOptions {
  /** Only 'GET' is permitted; any other value (including 'CONNECT') is refused. */
  method?: string;
  /** Caller-supplied headers are refused outright (header_forbidden). */
  headers?: Record<string, string>;
  /** Per-request timeout. Defaults to 15s. */
  timeoutMs?: number;
  /** Refuse to follow redirects (default follows, revalidating every hop). */
  followRedirects?: boolean;
}

export interface BrokerDeps {
  lookup?: (host: string) => Promise<string[]>;
  /** Injectable transport for tests. Production uses the validating Node transport. */
  transport?: BrokerTransport;
}

export interface BrokerTransportRequest {
  url: string;
  timeoutMs: number;
  /** Validated public addresses the connection MUST use (DNS binding). */
  validatedAddresses: string[];
  /**
   * Streaming body ceiling for this attempt. Transports MUST abort the
   * download past this many bytes (never buffer unbounded, never trust
   * Content-Length). The broker also charges the ledger post-hoc, so
   * injected/test transports that ignore the ceiling stay budgeted.
   */
  maxBodyBytes: number;
}

export interface BrokerTransportResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  connectedIp: string | null;
}

export type BrokerTransport = (req: BrokerTransportRequest) => Promise<BrokerTransportResponse>;

const BLOCKED_PATH_RE =
  /\/(cart|basket|checkout|check-out|account|login|signin|sign-in|signup|sign-up|register|admin|wp-admin|wp-login|cgi-bin|dbupload|db_xml|dbmake|generate\.cgi)/i;

const ALLOWED_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'application/json',
  'application/ld+json',
  'application/xml',
  'text/xml',
  'text/plain',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/svg+xml',
];

function defaultLookup(host: string): Promise<string[]> {
  return dnsLookup(host, { all: true }).then((records) => records.map((r) => r.address));
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}

/** Derive the broker scope from sample URLs: approved hosts are exact-match only. */
// fallow-ignore-next-line unused-export — harness + tests
export function scopeFromSampleUrls(
  investigationId: string,
  workspaceId: string,
  sampleUrls: string[],
): BrokerScope {
  const hosts = new Set<string>();
  for (const raw of sampleUrls) {
    const url = new URL(raw);
    hosts.add(normalizeHost(url.hostname));
  }
  return { investigationId, workspaceId, approvedHosts: [...hosts].sort() };
}

export class InvestigationBroker {
  private readonly ledger: BudgetLedger;
  private readonly lookup: (host: string) => Promise<string[]>;
  private readonly transport: BrokerTransport;
  private readonly maxRedirectHops: number;
  private readonly perRequestTimeoutMs: number;

  constructor(
    private readonly scope: BrokerScope,
    private readonly budget: InvestigationBudget,
    deps?: BrokerDeps,
    ledger?: BudgetLedger,
  ) {
    this.ledger = ledger ?? new BudgetLedger(budget);
    this.lookup = deps?.lookup ?? defaultLookup;
    this.transport = deps?.transport ?? nodeBrokerTransport;
    this.maxRedirectHops = budget.maxRedirectHops;
    this.perRequestTimeoutMs = Math.min(15_000, budget.timeoutMs);
  }

  getScope(): BrokerScope {
    return { ...this.scope, approvedHosts: [...this.scope.approvedHosts] };
  }

  getLedger(): BudgetLedger {
    return this.ledger;
  }

  /**
   * Broker-mediated GET. Every attempt (including denied ones and redirect
   * hops) consumes one request-attempt from the ledger first.
   */
  async fetch(rawUrl: string, opts?: BrokerFetchOptions): Promise<BrokerResponse> {
    assertReadMethod(opts);
    const followRedirects = opts?.followRedirects ?? true;
    const timeoutMs = opts?.timeoutMs ?? this.perRequestTimeoutMs;

    const redirectChain: string[] = [];
    let current = rawUrl;
    for (let hop = 0; hop <= this.maxRedirectHops; hop += 1) {
      // Every hop — validation, denied requests, redirects, retries —
      // consumes one attempt BEFORE any work, so chains cannot fan out past
      // the budget and denied requests cannot be retried for free.
      try {
        this.ledger.chargeRequestAttempt();
      } catch {
        throw new BrokerError('request_budget_exhausted', 'broker request attempts exhausted');
      }
      const validated = await this.validateDestination(current);
      const res = await this.attemptOnce(validated.normalizedUrl, validated.addresses, timeoutMs);
      if (isRedirect(res.status)) {
        current = this.followRedirect(validated.normalizedUrl, res, followRedirects, hop, redirectChain);
        continue;
      }
      return assembleSuccess(rawUrl, validated.normalizedUrl, res, redirectChain);
    }
    throw new BrokerError('too_many_redirects', `redirect hops exceed ${this.maxRedirectHops}`);
  }

  /** One validated attempt: bound transport call + streaming byte charge. */
  private async attemptOnce(
    normalizedUrl: string,
    validatedAddresses: string[],
    timeoutMs: number,
  ): Promise<BrokerTransportResponse> {
    let res: BrokerTransportResponse;
    try {
      // Streaming ceiling = tightest remaining cap, so the transport aborts
      // oversized downloads mid-stream instead of buffering them. The
      // post-hoc ledger charge below keeps injected transports budgeted too.
      res = await this.transport({
        url: normalizedUrl,
        timeoutMs,
        validatedAddresses,
        maxBodyBytes: this.remainingBodyCeiling(),
      });
    } catch (err) {
      // Stable operator-safe codes only: raw transport failures never leak
      // sockets, headers, or bodies.
      if (err instanceof BrokerError) throw err;
      throw new BrokerError('fetch_failed', 'broker transport failed');
    }
    this.chargeBody(res);
    return res;
  }

  /** Tightest remaining body cap across per-response and both totals. */
  private remainingBodyCeiling(): number {
    const consumed = this.ledger.snapshot();
    return Math.max(
      0,
      Math.min(
        this.budget.maxResponseBytesPerResponse,
        this.budget.maxTotalResponseBytesTransferred - consumed.responseBytesTransferred,
        this.budget.maxTotalResponseBytesDecompressed - consumed.responseBytesDecompressed,
      ),
    );
  }

  /** Revalidate-and-advance for one redirect hop (every hop revalidates). */
  private followRedirect(
    baseUrl: string,
    res: BrokerTransportResponse,
    followRedirects: boolean,
    hop: number,
    redirectChain: string[],
  ): string {
    if (!followRedirects) {
      throw new BrokerError('fetch_failed', 'redirects disabled for this read');
    }
    if (hop === this.maxRedirectHops) {
      throw new BrokerError('too_many_redirects', `redirect hops exceed ${this.maxRedirectHops}`);
    }
    const location = firstHeader(res.headers['location']);
    if (!location) throw new BrokerError('fetch_failed', 'redirect without Location');
    const next = new URL(location, baseUrl).toString();
    redirectChain.push(next);
    return next;
  }

  private chargeBody(res: BrokerTransportResponse): void {
    try {
      this.ledger.assertDeclaredLengthOk(res.body.length);
      this.ledger.chargeResponseBytes(res.body.length);
    } catch {
      throw new BrokerError(
        'response_too_large',
        'response body exceeds the investigation byte budget; download stopped',
      );
    }
  }

  /**
   * Full destination validation for one hop: scheme, credentials, port,
   * approval, path policy, DNS resolution with public-IP enforcement.
   * Throws a BrokerError whose detail is operator-safe (no headers/bodies).
   */
  private async validateDestination(rawUrl: string): Promise<{ normalizedUrl: string; addresses: string[] }> {
    const url = parseDestinationUrl(rawUrl);
    const host = normalizeHost(url.hostname);
    if (!host) throw new BrokerError('invalid_url', 'destination host is empty');
    assertHostApproved(this.scope.approvedHosts, host);
    assertPathAllowed(url.pathname);
    const addresses = await this.resolvePublicAddresses(host);
    return { normalizedUrl: url.toString(), addresses };
  }

  /**
   * DNS resolution AT THE BROKER. Literal IPs never pass (even public ones
   * are not approved hostnames); every resolved address must be public.
   * Failure or empty fails closed. Re-resolved every hop (rebinding-safe).
   */
  private async resolvePublicAddresses(host: string): Promise<string[]> {
    assertNotLiteralIp(host);
    let addresses: string[];
    try {
      addresses = await this.lookup(host);
    } catch {
      throw new BrokerError('dns_failed', `DNS resolution failed for ${host}`);
    }
    if (!addresses || addresses.length === 0) {
      throw new BrokerError('dns_failed', `DNS returned no addresses for ${host}`);
    }
    for (const addr of addresses) {
      if (classifyIp(addr) !== 'public') {
        throw new BrokerError('private_destination', `DNS for ${host} resolves to a non-public address`);
      }
    }
    return addresses;
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Only broker-owned GET reads exist; tunnels, writes, and caller headers are refused. */
function assertReadMethod(opts?: BrokerFetchOptions): void {
  const method = (opts?.method ?? 'GET').toUpperCase();
  if (method === 'CONNECT') {
    // Opaque tunnels hide method/path/body from the broker — never sufficient.
    throw new BrokerError('opaque_tunnel_refused', 'CONNECT tunnels are not mediated requests');
  }
  if (method !== 'GET') {
    throw new BrokerError('method_forbidden', `method ${method} is not a permitted read`);
  }
  if (opts?.headers && Object.keys(opts.headers).length > 0) {
    throw new BrokerError('header_forbidden', 'caller-supplied headers are not permitted');
  }
}

/** Assemble the success projection: full-body hash, no raw-body bypass downstream. */
function assembleSuccess(
  requestUrl: string,
  finalUrl: string,
  res: BrokerTransportResponse,
  redirectChain: string[],
): BrokerResponse {
  if (res.status < 200 || res.status >= 300) {
    throw new BrokerError('fetch_failed', `unexpected status ${res.status}`);
  }
  const contentType = firstHeader(res.headers['content-type']) ?? 'application/octet-stream';
  assertAllowedContentType(contentType);
  return {
    requestUrl,
    finalUrl,
    redirectChain,
    status: res.status,
    contentType,
    byteLength: res.body.length,
    bodyHash: sha256(res.body),
    body: res.body,
    connectedIp: res.connectedIp,
  };
}

/** Parse + scheme/credential/port policy for one destination. */
function parseDestinationUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BrokerError('invalid_url', 'destination is not a valid URL');
  }
  assertMediatedScheme(url.protocol);
  if (url.username || url.password) {
    throw new BrokerError('invalid_url', 'credential-bearing URLs are not permitted');
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new BrokerError('invalid_url', 'non-standard ports are not permitted');
  }
  return url;
}

/** Only broker-mediated HTTP(S). WebSockets and other schemes are unsupported channels. */
function assertMediatedScheme(protocol: string): void {
  if (protocol === 'http:' || protocol === 'https:') return;
  if (protocol === 'ws:' || protocol === 'wss:') {
    throw new BrokerError('unsupported_channel', 'WebSockets are not a permitted read channel');
  }
  throw new BrokerError('unsupported_channel', `scheme ${protocol} is not mediated`);
}

/** Exact-match host approval: a matching hostname is not path permission. */
function assertHostApproved(approvedHosts: string[], host: string): void {
  if (!approvedHosts.includes(host)) {
    throw new BrokerError('host_not_approved', `host ${host} is outside the investigation scope`);
  }
}

/** Cart/action/admin/CGI paths stay forbidden on approved hosts. */
function assertPathAllowed(pathname: string): void {
  if (BLOCKED_PATH_RE.test(pathname)) {
    throw new BrokerError('path_forbidden', `path ${pathname} is not an approved read`);
  }
}

/**
 * Literal-IP destinations (including obfuscated forms) never pass: even a
 * public literal IP is not an approved hostname, and private ones are hostile.
 */
function assertNotLiteralIp(host: string): void {
  const literalKind = classifyIp(host);
  if (literalKind === 'private' || literalKind === 'link_local') {
    throw new BrokerError('private_destination', `literal private destination ${host}`);
  }
  if (literalKind === 'public') {
    throw new BrokerError('host_not_approved', `literal IP ${host} is outside the investigation scope`);
  }
  if (literalKind === 'unknown' && /^[0-9a-f:.]+$/i.test(host) && host.includes(':')) {
    // IPv6 literal that failed to parse — fail closed rather than resolving it as DNS.
    throw new BrokerError('private_destination', 'unparseable IP literal');
  }
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function assertAllowedContentType(contentType: string): void {
  const base = contentType.split(';')[0]!.trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.includes(base)) {
    throw new BrokerError('content_type_forbidden', `content type ${base} is not a permitted read`);
  }
}

/**
 * Default Node transport: binds the connection to a broker-validated address
 * by dialing it directly (`createConnection`; no second unchecked DNS lookup),
 * verifies upstream TLS (rejectUnauthorized, TLS ≥ 1.2, SNI against the
 * request host), sends only broker-controlled headers, and streams the body
 * with ledger-independent size sanity (the broker charges the ledger; this
 * layer additionally aborts absurd bodies).
 *
 * Exported so the TLS-validation suite can exercise a live handshake
 * directly; production callers go through `InvestigationBroker`.
 *
 * Aborts the response past `req.maxBodyBytes` instead of buffering
 * unbounded: the ceiling, not Content-Length, bounds memory.
 */
// fallow-ignore-next-line unused-export — TLS suite + broker default
export async function nodeBrokerTransport(req: BrokerTransportRequest): Promise<BrokerTransportResponse> {
  const url = new URL(req.url);
  const secure = url.protocol === 'https:';
  const lib = secure ? https : http;
  const port = url.port ? Number(url.port) : secure ? 443 : 80;
  // Deterministic binding: connect to the first validated address. The
  // broker validated ALL candidates, so any choice is policy-equal.
  const bound = req.validatedAddresses[0]!;
  // The socket is dialed directly at the validated address and the actual
  // peer is the evidence of where the bytes came from (falling back to the
  // bound address when the runtime does not expose remoteAddress, e.g. Bun).
  let connectedIp: string | null = bound;
  return new Promise((resolve, reject) => {
    const requestOptions: https.RequestOptions = {
        method: 'GET',
        // `createConnection` is honored only when no pooling agent is used:
        // every broker request gets its own bound socket.
        agent: false,
        headers: {
          'User-Agent': BROKER_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.1',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'identity',
          'Cache-Control': 'no-cache',
        },
        // Bind DNS validation to the connection destination: this socket
        // may only reach the broker-validated address (no second lookup, so
        // no rebinding between validation and connect). TLS SNI and
        // hostname verification stay bound to the request host, never the IP.
        createConnection: () => {
          const socket = createBoundSocket(secure, bound, url.hostname, port, req.timeoutMs);
          socket.once('connect', () => {
            connectedIp = (socket.remoteAddress as string | undefined) ?? bound;
          });
          return socket;
        },
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        timeout: req.timeoutMs,
    };
    const request = lib.request(
      req.url,
      requestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        // Streaming enforcement: abort past the broker's ceiling instead of
        // buffering unbounded (Content-Length is never trusted). The broker
        // charges the same bytes to the ledger post-hoc for accounting.
        const abortOversized = (): void => {
          request.destroy(
            new BrokerError('response_too_large', 'response body exceeds the investigation byte budget; download stopped'),
          );
        };
        res.on('data', (chunk: Buffer) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += buf.length;
          if (received > req.maxBodyBytes) {
            abortOversized();
            return;
          }
          chunks.push(buf);
        });
        res.on('end', () => {
          const headers: Record<string, string | string[] | undefined> = {};
          for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = v;
          resolve({
            status: res.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks),
            connectedIp,
          });
        });
        res.on('error', reject);
      },
    );
    request.on('timeout', () => {
      request.destroy(new BrokerError('timeout', 'broker request timed out'));
    });
    request.on('error', (err) => {
      reject(mapTransportError(err));
    });
    request.end();
  });
}

/**
 * Dial the broker-validated address directly.
 *
 * `createConnection` (with `agent: false`) is used instead of a per-request
 * `lookup` override because Bun's `node:https` does not implement the
 * `lookup` callback contract — it assumes the `all: true` array form and
 * fails the connect — and the Bun API server is the production runtime.
 * Both runtimes honor `createConnection`, which is the stronger binding in
 * any case: the socket can only reach this literal validated address, and
 * TLS verification (SNI + hostname) stays bound to the request host rather
 * than the IP.
 */
function createBoundSocket(
  secure: boolean,
  bound: string,
  hostname: string,
  port: number,
  timeoutMs: number,
): net.Socket | tls.TLSSocket {
  const socket = secure
    ? tls.connect({
        host: bound,
        port,
        servername: hostname,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
      })
    : net.connect({ host: bound, port, family: bound.includes(':') ? 6 : 4 });
  socket.setTimeout(timeoutMs);
  return socket;
}

/** Node TLS failure codes that prove upstream verification fired (never bypassed). */
const TLS_FAILURE_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function mapTransportError(err: unknown): Error {
  const code = (err as { code?: string }).code ?? '';
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof BrokerError) return err;
  // Upstream TLS validation intact: cert errors surface distinctly, never bypassed.
  if (TLS_FAILURE_CODES.has(code) || message.includes('certificate')) {
    return new BrokerError('tls_validation_failed', 'upstream TLS validation failed');
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new BrokerError('dns_failed', 'destination DNS failed at connect time');
  }
  return new BrokerError('fetch_failed', `transport failed (${code || 'unknown'})`);
}
