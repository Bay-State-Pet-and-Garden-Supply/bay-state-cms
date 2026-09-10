/**
 * Provider Connections & Trust Zones for Bay State AI Infrastructure.
 *
 * Implements the ProviderConnection abstraction, AiTrustZone governance,
 * connection-addressed ModelTarget definitions, and inherited workload routing.
 */

export type AiTrustZone = 'this_device' | 'trusted_lan' | 'cloud';
export type AiTransport = 'openai-compatible' | 'ollama-native';
export type DataSharingPolicy = 'this_device_only' | 'trusted_lan_allowed' | 'cloud_allowed';

export interface ProviderConnection {
  id: string;
  label: string;
  transport: AiTransport;
  baseUrl: string;
  credential?: string | null;
  trustZone: AiTrustZone;
  /** Exact operator-approved hostname or IP (anti-SSRF / DNS rebinding guard). */
  approvedHost?: string;
  /** Exact operator-approved port (anti-SSRF guard). */
  approvedPort?: number;
  enabled: boolean;
  /** Fast connect timeout for reachability probes (default 2000ms). */
  connectTimeoutMs?: number;
  /** Total inference timeout (default 60000ms). */
  inferenceTimeoutMs?: number;
}

/** Sanitized connection view for client serialization (never exposes raw credentials). */
export interface ClientProviderConnection {
  id: string;
  label: string;
  transport: AiTransport;
  baseUrl: string;
  hasCredential: boolean;
  trustZone: AiTrustZone;
  approvedHost?: string;
  approvedPort?: number;
  enabled: boolean;
  connectTimeoutMs?: number;
  inferenceTimeoutMs?: number;
}

export function toClientProviderConnection(conn: ProviderConnection): ClientProviderConnection {
  return {
    id: conn.id,
    label: conn.label,
    transport: conn.transport,
    baseUrl: conn.baseUrl,
    hasCredential: Boolean(conn.credential && conn.credential.trim().length > 0),
    trustZone: conn.trustZone,
    approvedHost: conn.approvedHost,
    approvedPort: conn.approvedPort,
    enabled: conn.enabled,
    connectTimeoutMs: conn.connectTimeoutMs,
    inferenceTimeoutMs: conn.inferenceTimeoutMs,
  };
}

export interface ModelTarget {
  connectionId: string;
  modelId: string;
}

export type TerminalBehavior = 'heuristic' | 'defer' | 'fail_closed' | 'unavailable';

export interface WorkloadRoute {
  primary: ModelTarget | 'inherit';
  fallback?: ModelTarget | 'inherit' | null;
  textDataSharing?: DataSharingPolicy;
  imageDataSharing?: DataSharingPolicy;
  terminalBehavior: TerminalBehavior;
}

export interface ResolvedWorkloadRoute {
  primary: ModelTarget;
  fallback: ModelTarget | null;
  textDataSharing: DataSharingPolicy;
  imageDataSharing: DataSharingPolicy;
  terminalBehavior: TerminalBehavior;
}

export interface AiRoutingConfig {
  connections: Record<string, ProviderConnection>;
  defaults: {
    textDataSharing: DataSharingPolicy;
    imageDataSharing: DataSharingPolicy;
    catalogTarget: ModelTarget;
    catalogFallback?: ModelTarget | null;
  };
  workloads: {
    discovery: WorkloadRoute;
    curation: WorkloadRoute;
    visionOcr: WorkloadRoute;
    profileBuilder: WorkloadRoute;
    storeManager: WorkloadRoute;
  };
}

// ─── Trust Zone & IP Validation ───────────────────────────────────────────────

export class TrustZoneValidationError extends Error {
  readonly code: string;
  readonly connectionId?: string;

  constructor(message: string, code: string, connectionId?: string) {
    super(message);
    this.name = 'TrustZoneValidationError';
    this.code = code;
    this.connectionId = connectionId;
  }
}

/**
 * Checks if a hostname is a loopback address (this_device).
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return true;
  if (h.endsWith('.localhost')) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    return h.split('.').every(part => Number(part) <= 255);
  }
  return false;
}

/**
 * Checks if a hostname is a link-local, carrier-grade NAT, or cloud metadata IP.
 */
export function isLinkLocalOrMetadataHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)) return true; // IPv4 Link-Local & AWS/GCP Metadata
  if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(h)) return true; // CGNAT 100.64.0.0/10
  if (/^0\.0\.0\.0$/.test(h)) return true;
  if (/^\[?fe[89ab][0-9a-f]:/i.test(h)) return true; // IPv6 Link-Local
  return false;
}

/**
 * Checks if a hostname is an RFC1918 / RFC4193 private LAN address or .local domain.
 */
export function isPrivateLanHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (isLoopbackHost(h) || isLinkLocalOrMetadataHost(h)) return false;

  // .local mDNS hostname
  if (h.endsWith('.local')) return true;

  // IPv4 RFC1918 Private Ranges
  // 10.0.0.0/8
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    return h.split('.').every(p => Number(p) <= 255);
  }
  // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
  if (/^172\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    const parts = h.split('.').map(Number);
    return parts.every(p => p <= 255) && parts[1] >= 16 && parts[1] <= 31;
  }
  // 192.168.0.0/16
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) {
    return h.split('.').every(p => Number(p) <= 255);
  }

  // IPv6 Unique Local Address (fc00::/7 -> fc00:: or fd00::)
  if (/^\[?(?:fc|fd)[0-9a-f]{2}:/i.test(h)) {
    return true;
  }

  return false;
}

/**
 * Validates that a connection's baseUrl matches its declared trustZone and pinned host/port.
 * Enforces fail-closed invariants against SSRF and misconfiguration.
 */
export function validateConnectionTrustZone(conn: ProviderConnection): void {
  if (!conn.baseUrl) {
    throw new TrustZoneValidationError('Base URL is missing', 'base_url_missing', conn.id);
  }

  let parsed: URL;
  try {
    parsed = new URL(conn.baseUrl);
  } catch {
    throw new TrustZoneValidationError(`Invalid Base URL: ${conn.baseUrl}`, 'invalid_url', conn.id);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TrustZoneValidationError(
      `Unsupported protocol "${parsed.protocol}"; only http: and https: are allowed.`,
      'unsupported_protocol',
      conn.id,
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);

  // Validate Host & Port against Operator Pinning (Anti-SSRF)
  if (conn.approvedHost) {
    const approvedHost = conn.approvedHost.trim().toLowerCase();
    if (hostname !== approvedHost) {
      throw new TrustZoneValidationError(
        `Connection host "${hostname}" does not match approved host "${approvedHost}".`,
        'unapproved_host',
        conn.id,
      );
    }
  }

  if (conn.approvedPort !== undefined && conn.approvedPort !== null) {
    if (port !== conn.approvedPort) {
      throw new TrustZoneValidationError(
        `Connection port "${port}" does not match approved port "${conn.approvedPort}".`,
        'unapproved_port',
        conn.id,
      );
    }
  }

  switch (conn.trustZone) {
    case 'this_device': {
      if (!isLoopbackHost(hostname)) {
        throw new TrustZoneValidationError(
          `Connection declared "this_device" but host "${hostname}" is not a loopback address.`,
          'trust_zone_mismatch_this_device',
          conn.id,
        );
      }
      break;
    }
    case 'trusted_lan': {
      if (isLoopbackHost(hostname)) {
        // Loopback is permitted under trusted_lan if operator configured it
        break;
      }
      if (isLinkLocalOrMetadataHost(hostname) || !isPrivateLanHost(hostname)) {
        throw new TrustZoneValidationError(
          `Connection declared "trusted_lan" but host "${hostname}" is not a private LAN IP/mDNS address.`,
          'trust_zone_mismatch_trusted_lan',
          conn.id,
        );
      }
      break;
    }
    case 'cloud': {
      // Cloud endpoints MUST use HTTPS to prevent cleartext credential/prompt leakage over public internet
      if (parsed.protocol !== 'https:') {
        throw new TrustZoneValidationError(
          `Cloud connection "${conn.label}" must use https: protocol, received "${parsed.protocol}".`,
          'cloud_requires_https',
          conn.id,
        );
      }
      // Cloud endpoints CANNOT target internal loopback, private LAN, link-local, or cloud metadata ranges
      if (isLoopbackHost(hostname) || isPrivateLanHost(hostname) || isLinkLocalOrMetadataHost(hostname)) {
        throw new TrustZoneValidationError(
          `Connection declared "cloud" cannot point to local/private/metadata address "${hostname}".`,
          'trust_zone_mismatch_cloud',
          conn.id,
        );
      }
      break;
    }
    default:
      throw new TrustZoneValidationError(
        `Unknown trust zone "${conn.trustZone}".`,
        'unknown_trust_zone',
        conn.id,
      );
  }
}

/**
 * Checks if a given destination trust zone is permitted by the data sharing policy.
 */
export function isTargetPermittedByPolicy(
  targetZone: AiTrustZone,
  policy: DataSharingPolicy,
): boolean {
  if (policy === 'this_device_only') {
    return targetZone === 'this_device';
  }
  if (policy === 'trusted_lan_allowed') {
    return targetZone === 'this_device' || targetZone === 'trusted_lan';
  }
  if (policy === 'cloud_allowed') {
    return true;
  }
  return false;
}

/**
 * True when a connection can actually serve an inference request: enabled,
 * and — for cloud connections — carrying a real credential (a cloud endpoint
 * without a key would send an inert bearer token and must never be resolved
 * or dispatched). Local/LAN servers need no credential.
 *
 * This is the single availability predicate for AI Compute routing across
 * the dispatcher, llm-client, the VLM client, and the Store Manager resolver;
 * bare `enabled` is never sufficient.
 */
export function isConnectionUsable(conn: ProviderConnection): boolean {
  if (!conn.enabled) return false;
  if (conn.trustZone === 'cloud') {
    return Boolean(conn.credential && conn.credential.trim().length > 0);
  }
  return true;
}

// ─── Built-in Default Connections ─────────────────────────────────────────────

export const DEFAULT_BUILTIN_CONNECTIONS: Record<string, ProviderConnection> = {
  'local-ollama': {
    id: 'local-ollama',
    label: 'Ollama (Local Mac)',
    transport: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    credential: null,
    trustZone: 'this_device',
    approvedHost: 'localhost',
    approvedPort: 11434,
    // Present but opt-in: nothing routes to it until the operator enables it.
    enabled: false,
    connectTimeoutMs: 2000,
    inferenceTimeoutMs: 60000,
  },
  'openai-cloud': {
    id: 'openai-cloud',
    label: 'OpenAI (Cloud)',
    transport: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    credential: null,
    trustZone: 'cloud',
    approvedHost: 'api.openai.com',
    approvedPort: 443,
    enabled: true,
    connectTimeoutMs: 5000,
    inferenceTimeoutMs: 60000,
  },
  'deepseek-cloud': {
    id: 'deepseek-cloud',
    label: 'DeepSeek (Cloud)',
    transport: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    credential: null,
    trustZone: 'cloud',
    approvedHost: 'api.deepseek.com',
    approvedPort: 443,
    enabled: true,
    connectTimeoutMs: 5000,
    inferenceTimeoutMs: 60000,
  },
};

/**
 * Resolves an effective workload route, inheriting from defaults where specified.
 */
export function resolveWorkloadRoute(
  workload: keyof AiRoutingConfig['workloads'],
  config: AiRoutingConfig,
): ResolvedWorkloadRoute {
  const route = config.workloads[workload];
  const primary = route.primary === 'inherit' ? config.defaults.catalogTarget : route.primary;
  const fallback = route.fallback === 'inherit'
    ? (config.defaults.catalogFallback ?? null)
    : (route.fallback ?? null);

  return {
    primary,
    fallback,
    textDataSharing: route.textDataSharing ?? config.defaults.textDataSharing,
    imageDataSharing: route.imageDataSharing ?? config.defaults.imageDataSharing,
    terminalBehavior: route.terminalBehavior,
  };
}
