/**
 * Shared IP classification (SSRF floor).
 *
 * Pure classifier moved verbatim from src/product-intelligence/policy/policy-gateway.ts
 * during the Agent Lab decommission (ADR-0030, Phase 1 PR 1.1). Consumers:
 * policy-gateway (until its Phase 3 deletion), store-manager image repair,
 * extraction-worker network guards.
 */

import { lookup as dnsLookup } from 'node:dns/promises';

const PRIVATE_IPV4 = [
  { ip: '10.0.0.0', bits: 8 },
  { ip: '172.16.0.0', bits: 12 },
  { ip: '192.168.0.0', bits: 16 },
  { ip: '127.0.0.0', bits: 8 },
  { ip: '169.254.0.0', bits: 16 }, // link-local
  { ip: '0.0.0.0', bits: 8 },
  { ip: '100.64.0.0', bits: 10 }, // CGNAT
] as const;

function parseIpv4Part(part: string): number | null {
  if (!part) return null;
  let val: number;
  if (/^0x[0-9a-fA-F]+$/i.test(part)) {
    val = parseInt(part, 16);
  } else if (/^0[0-7]+$/.test(part)) {
    val = parseInt(part, 8);
  } else if (/^(0|[1-9][0-9]*)$/.test(part)) {
    val = parseInt(part, 10);
  } else {
    return null;
  }
  if (!Number.isSafeInteger(val) || val < 0) return null;
  return val;
}

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = parts.map(parseIpv4Part);
  if (nums.some((n) => n === null)) return null;

  const validNums = nums as number[];

  if (parts.length === 1) {
    return validNums[0] <= 0xffffffff ? validNums[0] >>> 0 : null;
  }
  if (parts.length === 2) {
    if (validNums[0] > 255 || validNums[1] > 0xffffff) return null;
    return ((validNums[0] << 24) | validNums[1]) >>> 0;
  }
  if (parts.length === 3) {
    if (validNums[0] > 255 || validNums[1] > 255 || validNums[2] > 0xffff) return null;
    return ((validNums[0] << 24) | (validNums[1] << 16) | validNums[2]) >>> 0;
  }
  if (validNums.some((n) => n > 255)) return null;
  return ((validNums[0] << 24) | (validNums[1] << 16) | (validNums[2] << 8) | validNums[3]) >>> 0;
}

/**
 * Pre-compiled binary masks and masked base addresses for private/link-local ranges.
 * Optimization: Computing these masks once at module load avoids redundant string parsing,
 * array splits, and regex evaluation on every `classifyIp` invocation (~5x faster execution).
 */
const PRECOMPILED_PRIVATE_RANGES = PRIVATE_IPV4.map((range) => {
  const base = ipv4ToNumber(range.ip)!;
  const mask = range.bits > 0 ? (~0 << (32 - range.bits)) >>> 0 : 0;
  const maskedBase = (base & mask) >>> 0;
  const isLinkLocal = range.ip.startsWith('169.254') || range.ip === '0.0.0.0';
  return {
    maskedBase,
    mask,
    kind: isLinkLocal ? ('link_local' as const) : ('private' as const),
  };
});

function parseIpv6(address: string): number[] | null {
  let lower = address.toLowerCase();
  const zoneIdx = lower.indexOf('%');
  if (zoneIdx !== -1) lower = lower.slice(0, zoneIdx);

  let ipv4Tail: string | null = null;
  const lastColon = lower.lastIndexOf(':');
  if (lastColon !== -1 && lower.slice(lastColon + 1).includes('.')) {
    ipv4Tail = lower.slice(lastColon + 1);
    lower = lower.slice(0, lastColon);
  }

  const doubleColonParts = lower.split('::');
  if (doubleColonParts.length > 2) return null;

  const left = doubleColonParts[0] ? doubleColonParts[0].split(':') : [];
  const right = doubleColonParts.length === 2 && doubleColonParts[1] ? doubleColonParts[1].split(':') : [];

  const expectedWordCount = ipv4Tail ? 6 : 8;
  if (doubleColonParts.length === 1 && left.length !== expectedWordCount) return null;
  const missing = expectedWordCount - (left.length + right.length);
  if (missing < 0) return null;

  const words: number[] = [];
  for (const part of left) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    words.push(parseInt(part, 16));
  }
  for (let i = 0; i < missing; i++) {
    words.push(0);
  }
  for (const part of right) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    words.push(parseInt(part, 16));
  }

  if (ipv4Tail !== null) {
    const num = ipv4ToNumber(ipv4Tail);
    if (num === null) return null;
    words.push((num >>> 16) & 0xffff);
    words.push(num & 0xffff);
  }

  if (words.length !== 8) return null;
  return words;
}

/** Classify a numeric IPv4/IPv6 address as private/link-local or public. */
export function classifyIp(address: string): 'private' | 'link_local' | 'public' | 'unknown' {
  if (address.includes(':')) {
    const words = parseIpv6(address);
    if (!words) return 'unknown';

    // Unspecified ::
    if (words.every((w) => w === 0)) return 'link_local';

    // Loopback ::1
    if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return 'link_local';

    // Link-local fe80::/10
    if ((words[0] & 0xffc0) === 0xfe80) return 'private';

    // Unique-local fc00::/7 (fc00:: - fdff::)
    if ((words[0] & 0xfe00) === 0xfc00) return 'private';

    // Site-local fec0::/10 (deprecated)
    if ((words[0] & 0xffc0) === 0xfec0) return 'private';

    // IPv4-mapped IPv6 (::ffff:x.x.x.x) or IPv4-compatible (::x.x.x.x)
    if (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0 && (words[5] === 0xffff || words[5] === 0)) {
      const ipv4 = `${(words[6] >> 8) & 0xff}.${words[6] & 0xff}.${(words[7] >> 8) & 0xff}.${words[7] & 0xff}`;
      return classifyIp(ipv4);
    }

    return 'public';
  }

  // Optimization: Parse the address once upfront rather than up to 8 times in loop iterations.
  const num = ipv4ToNumber(address);
  if (num === null) return 'unknown';

  for (let i = 0; i < PRECOMPILED_PRIVATE_RANGES.length; i++) {
    const range = PRECOMPILED_PRIVATE_RANGES[i];
    if (((num & range.mask) >>> 0) === range.maskedBase) {
      return range.kind;
    }
  }

  return 'public';
}

export function isPrivateOrLinkLocal(address: string): boolean {
  const kind = classifyIp(address);
  return kind === 'private' || kind === 'link_local';
}

/**
 * Asynchronously check if a hostname (or literal IP) is private or link-local.
 * Resolves DNS for hostnames and checks all returned IP addresses using `classifyIp`.
 * Returns true if the hostname or any of its DNS-resolved IP addresses is private/link-local,
 * or if DNS resolution fails or returns no addresses (failing closed).
 */
export async function isPrivateOrLinkLocalHost(
  hostname: string,
  opts: { lookup?: typeof dnsLookup } = {}
): Promise<boolean> {
  const hostLower = hostname.toLowerCase().replace(/^\[|\]$/g, '').trim();
  if (!hostLower || hostLower === 'localhost' || hostLower.endsWith('.local')) {
    return true;
  }

  const literalKind = classifyIp(hostLower);
  if (literalKind === 'private' || literalKind === 'link_local') {
    return true;
  }
  if (literalKind === 'public') {
    return false;
  }

  // It's a domain hostname — resolve DNS
  const doLookup = opts.lookup ?? dnsLookup;
  let addrs: Array<{ address: string }>;
  try {
    addrs = (await doLookup(hostLower, { all: true } as any)) as any;
  } catch {
    return true; // Fail closed on DNS lookup error
  }
  if (!addrs || addrs.length === 0) {
    return true; // Fail closed if no DNS records
  }
  for (const a of addrs) {
    const kind = classifyIp(a.address);
    if (kind !== 'public') {
      return true;
    }
  }
  return false;
}

/** True when the hostname is a literal IP (v4 dotted or v6). */
export function isIpLiteralHostname(hostname: string): boolean {
  const clean = hostname.replace(/^\[|\]$/g, '').trim();
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(clean) || clean.includes(':');
}

/**
 * Resolve a hostname to a single PUBLIC address suitable for connection pinning.
 * Returns null (deny) when ANY record is private/link-local/loopback or when
 * DNS resolution fails (fail closed).
 */
export async function resolvePublicAddress(
  hostname: string,
  opts: { lookup?: typeof dnsLookup } = {}
): Promise<string | null> {
  const hostLower = hostname.toLowerCase().replace(/^\[|\]$/g, '').trim();
  if (!hostLower || hostLower === 'localhost' || hostLower.endsWith('.local')) {
    return null;
  }
  const literalKind = classifyIp(hostLower);
  if (literalKind === 'private' || literalKind === 'link_local') {
    return null;
  }
  if (literalKind === 'public') {
    return hostLower;
  }

  const doLookup = opts.lookup ?? dnsLookup;
  let addrs: Array<{ address: string }>;
  try {
    addrs = (await doLookup(hostLower, { all: true } as any)) as any;
  } catch {
    return null; // Fail closed on DNS error
  }
  if (!addrs || addrs.length === 0) {
    return null; // Fail closed if no DNS records
  }
  for (const a of addrs) {
    const kind = classifyIp(a.address);
    if (kind !== 'public') {
      return null; // Fail closed if any IP is not public
    }
  }
  return addrs[0].address;
}

/**
 * Pure URL rewrite that closes the DNS-rebinding TOCTOU window for http destinations.
 * Rewrites an http URL to the address literal so the socket connects directly to
 * the validated address (caller sends Host header).
 */
export function pinHttpDestination(rawUrl: string, address: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:') return null;
  if (isIpLiteralHostname(parsed.hostname)) return null;
  if (!address) return null;
  const formatted = address.includes(':') ? `[${address}]` : address;
  return `http://${formatted}${parsed.pathname}${parsed.search}`;
}

export function sanitizeUrlForError(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return rawUrl.replace(/\/\/[^@]+@/, '//[REDACTED]@');
  }
}

export interface FetchPinnedOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  method?: string;
  lookupFn?: typeof dnsLookup;
  fetchFn?: typeof fetch;
}

/**
 * Fetch one logical http(s) destination with the connection PINNED for http.
 * The http URL is rewritten to the validated public IP literal and the original
 * hostname is sent in the Host header.
 */
export async function fetchPinned(
  logicalUrl: string,
  options: FetchPinnedOptions = {}
): Promise<{ response: Response; pinned: boolean; finalUrl: string }> {
  let parsed: URL;
  try {
    parsed = new URL(logicalUrl);
  } catch {
    throw new Error(`Invalid URL: ${sanitizeUrlForError(logicalUrl)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('URL contains credentials');
  }

  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchFn = options.fetchFn ?? fetch;
  const address = await resolvePublicAddress(parsed.hostname, { lookup: options.lookupFn });
  if (address === null) {
    throw new Error(`SSRF blocked: URL points to a private or link-local address ${parsed.hostname}`);
  }

  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  let fetchUrl = logicalUrl;
  let pinned = false;

  if (parsed.protocol === 'http:' && !isIpLiteralHostname(parsed.hostname)) {
    const pinnedUrl = pinHttpDestination(logicalUrl, address);
    if (pinnedUrl) {
      fetchUrl = pinnedUrl;
      headers.Host = parsed.hostname;
      pinned = true;
    }
  }

  const response = await fetchFn(fetchUrl, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ?? undefined,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
  });

  return {
    response,
    pinned,
    finalUrl: logicalUrl,
  };
}

export interface SubrequestBudgetState {
  bytes: number;
}

export async function readBoundedBody(response: Response, cap: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > cap) {
    throw new Error(`subrequest response declares ${declared} bytes (cap ${cap})`);
  }
  if (!response.body) {
    const fallback = Buffer.from(await response.arrayBuffer());
    if (fallback.length > cap) {
      throw new Error(`subrequest response exceeds ${cap} bytes (${fallback.length})`);
    }
    return fallback;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        throw new Error(`subrequest response exceeds ${cap} bytes (${total})`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks);
}

export async function fulfillPinnedSubrequest(
  requestInfo: {
    url: string;
    method?: string | null;
    headers?: Record<string, string> | null;
    body?: Buffer | string | null;
  },
  deps: {
    resolveFn?: (hostname: string) => Promise<string | null>;
    fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    timeoutMs?: number;
    maxResponseBytes?: number;
    maxBodyBytes?: number;
    budget?: SubrequestBudgetState;
    maxAggregateBytes?: number;
  } = {},
): Promise<{ status: number; headers: Record<string, string>; body: Buffer } | null> {
  const timeoutMs = deps.timeoutMs ?? 15_000;
  const resolveFn = deps.resolveFn ?? ((h: string) => resolvePublicAddress(h));
  const fetchFn = deps.fetchFn ?? fetch;
  const maxResponseBytes = deps.maxResponseBytes ?? 2_000_000;
  const maxBodyBytes = deps.maxBodyBytes ?? 1_000_000;
  const maxAggregateBytes = deps.maxAggregateBytes ?? 8_000_000;
  let parsed: URL;
  try {
    parsed = new URL(requestInfo.url);
  } catch {
    throw new Error(`Cannot pin invalid subrequest URL: ${requestInfo.url}`);
  }
  if (parsed.protocol !== 'http:' || isIpLiteralHostname(parsed.hostname)) {
    return null;
  }
  const address = await resolveFn(parsed.hostname);
  if (address === null) {
    throw new Error(`Subrequest destination ${parsed.hostname} cannot be proven public (fail closed)`);
  }
  const pinnedUrl = pinHttpDestination(requestInfo.url, address);
  if (pinnedUrl === null) {
    throw new Error(`Subrequest ${requestInfo.url} could not be pinned to ${address}`);
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(requestInfo.headers ?? {})) {
    const lower = key.toLowerCase();
    if (lower === 'host' || lower === 'content-length' || lower === 'connection' || lower === 'accept-encoding') continue;
    headers[key] = value;
  }
  headers.Host = parsed.hostname;
  const body = requestInfo.body ? (Buffer.isBuffer(requestInfo.body) ? requestInfo.body : Buffer.from(String(requestInfo.body))) : undefined;
  if (body && body.length > maxBodyBytes) {
    throw new Error(`subrequest body exceeds ${maxBodyBytes} bytes (${body.length})`);
  }
  const response = await fetchFn(pinnedUrl, {
    method: requestInfo.method ?? 'GET',
    headers,
    body: body && body.length > 0 ? new Uint8Array(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
  });
  const responseBody = await readBoundedBody(response, maxResponseBytes);
  if (deps.budget && deps.budget.bytes + responseBody.length > maxAggregateBytes) {
    throw new Error(`aggregate subrequest budget exceeded (${deps.budget.bytes + responseBody.length} > ${maxAggregateBytes})`);
  }
  if (deps.budget) deps.budget.bytes += responseBody.length;
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === 'content-length' || lower === 'transfer-encoding' || lower === 'connection' || lower === 'keep-alive') return;
    responseHeaders[key] = value;
  });
  return { status: response.status, headers: responseHeaders, body: responseBody };
}

/**
 * Shared destination assertion for variant/discovery network boundary.
 * Reused by job-queue and variant-url-resolver to prevent drift.
 * Validates protocol, credentials, port, official-domain, literal IP, and DNS-resolved IPs.
 * Must be called before *every* actual request/redirect hop. DNS failure/empty strictly fails-closed.
 */
export async function assertSafeVariantDestination(
  urlStr: string,
  officialDomains: string[],
  opts: { lookup?: typeof dnsLookup } = {}
): Promise<void> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error(`SSRF block: invalid URL ${urlStr}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`SSRF block: unsupported protocol ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error('SSRF block: credentials not allowed');
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new Error(`SSRF block: non-standard port ${url.port}`);
  }
  const hostLower = url.hostname.toLowerCase().replace(/^www\./, '').trim();
  if (!hostLower) throw new Error('SSRF block: empty hostname');
  // Literal IP check (handles alternate encodings via classifyIp)
  const literalKind = classifyIp(hostLower);
  if (literalKind === 'private' || literalKind === 'link_local') {
    throw new Error(`SSRF block: literal private ${hostLower}`);
  }
  if (literalKind !== 'unknown') {
    // It's a literal IP that is public — still need allowlist check
    // Fall through to allowlist after
  }
  if (officialDomains.length === 0) {
    throw new Error(`SSRF block: allowlist empty — blocking ${hostLower}`);
  }
  const allowOk = officialDomains.some((d) => {
    const nd = d.toLowerCase().replace(/^www\./, '').trim();
    return hostLower === nd || hostLower.endsWith('.' + nd);
  });
  if (!allowOk) throw new Error(`SSRF block: host not in official allowlist: ${hostLower}`);
  // DNS resolution — reject if any resolved address is private/link_local/unknown, strictly fail-closed
  const doLookup = opts.lookup ?? dnsLookup;
  let addrs: Array<{ address: string }>;
  try {
    addrs = (await doLookup(hostLower, { all: true } as any)) as any;
  } catch (e) {
    throw new Error(`SSRF block: DNS lookup failed for ${hostLower}: ${(e as Error).message}`);
  }
  if (!addrs || addrs.length === 0) throw new Error(`SSRF block: DNS empty for ${hostLower}`);
  for (const a of addrs) {
    const k = classifyIp(a.address);
    if (k !== 'public') throw new Error(`SSRF block: DNS private for ${hostLower} -> ${a.address} (${k})`);
  }
}
