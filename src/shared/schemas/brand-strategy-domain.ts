/**
 * Brand strategy builder domain validation (plan slice B1).
 *
 * Accepts a hostname or HTTP(S) URL and normalizes it to a canonical
 * lower-case host (leading `www.` stripped, subdomains preserved). Product
 * paths are stripped as display-input normalization only — a URL pattern is
 * never inferred or stored here. No DNS or network validation is performed.
 *
 * Returns the canonical host, or null when the input is not an acceptable
 * official-domain candidate.
 */
export function normalizeOfficialDomainInput(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 500) return null;
  if (/[\s\x7f]/.test(trimmed)) return null;
  for (const ch of trimmed) {
    const code = ch.codePointAt(0) as number;
    if (code < 0x20) return null;
  }

  let host: string;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    // Explicit scheme: only http/https accepted.
    if (!/^https?:\/\//i.test(trimmed)) return null;
    try {
      const url = new URL(trimmed);
      if (url.username || url.password) return null;
      if (url.port) return null;
      host = url.hostname;
    } catch {
      return null;
    }
  } else {
    // Bare hostname: reject anything that looks like a path/query/fragment
    // pseudo-host or carries userinfo/port/wildcard markers.
    if (trimmed.includes('/') || trimmed.includes('?') || trimmed.includes('#')) return null;
    if (trimmed.includes('@') || trimmed.includes(':') || trimmed.includes('*')) return null;
    host = trimmed;
  }

  host = host.toLowerCase().trim().replace(/\.$/, '');
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host || host.length > 253) return null;
  if (host.includes(':') || host.includes('/') || host.includes(' ') || host.includes('@') || host.includes('*')) return null;

  // Reject IP literals (v4 and v6).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  if (host.includes(':')) return null;

  // Reject non-routable / private-style hostnames.
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.test') ||
    host.endsWith('.example') ||
    host.endsWith('.invalid')
  ) return null;
  if (/^10\./.test(host) || /^127\./.test(host) || /^192\.168\./.test(host)) return null;
  const m172 = host.match(/^172\.(\d{1,3})\./);
  if (m172) {
    const second = Number(m172[1]);
    if (Number.isInteger(second) && second >= 16 && second <= 31) return null;
  }

  // Must contain at least one dot (no single-label intranet names).
  if (!host.includes('.')) return null;
  const labels = host.split('.');
  for (const label of labels) {
    if (!label || label.length > 63) return null;
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) return null;
  }
  return host;
}
