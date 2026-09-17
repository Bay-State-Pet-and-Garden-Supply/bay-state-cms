// story: e06s01, #191 — dedicated workspace route helper (domain-scoped, return-context, seed sample deep-linking)
import { normalizeBrandHubDomain } from '../../../onboarding/brand-hub/normalizeDomain';

export interface ProfileWorkspaceRouteOptions {
  returnPath?: string;
  seedUrl?: string;
  sampleUrl?: string;
  failureReason?: string;
}

export function getProfileWorkspacePath(
  rawDomain: string,
  optionsOrReturnPath?: string | ProfileWorkspaceRouteOptions,
): string {
  const domain = normalizeBrandHubDomain(rawDomain);
  const base = `/settings/domains/${encodeURIComponent(domain)}/profile`;
  if (!optionsOrReturnPath) return base;

  const options: ProfileWorkspaceRouteOptions =
    typeof optionsOrReturnPath === 'string'
      ? { returnPath: optionsOrReturnPath }
      : optionsOrReturnPath;

  const params = new URLSearchParams();
  if (options.returnPath) params.set('return', options.returnPath);
  if (options.seedUrl) params.set('seedUrl', options.seedUrl);
  if (options.sampleUrl) params.set('sampleUrl', options.sampleUrl);
  if (options.failureReason) params.set('failureReason', options.failureReason);

  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

export function parseReturnPath(search: string): string | null {
  const params = new URLSearchParams(search);
  const v = params.get('return');
  return v ? decodeURIComponent(v) : null;
}

export function parseWorkspaceParams(search: string): ProfileWorkspaceRouteOptions {
  const params = new URLSearchParams(search);
  const res: ProfileWorkspaceRouteOptions = {};
  const ret = params.get('return');
  if (ret) res.returnPath = decodeURIComponent(ret);
  const seed = params.get('seedUrl');
  if (seed) res.seedUrl = decodeURIComponent(seed);
  const sample = params.get('sampleUrl');
  if (sample) res.sampleUrl = decodeURIComponent(sample);
  const reason = params.get('failureReason');
  if (reason) res.failureReason = decodeURIComponent(reason);
  return res;
}
