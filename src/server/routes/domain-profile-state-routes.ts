// story: e06s01 — Hono GET /api/domains/:domain/profile-state (server-derived header/readiness source)
import { Hono } from 'hono';
import { getDomainProfileState } from '../../db/repositories/domain-profile-state-repo';
import { getDomainReleaseHealth } from '../../onboarding/domain-release';

export const domainProfileStateRoutes = new Hono();

domainProfileStateRoutes.get('/domains/:domain/profile-state', (c) => {
  const raw = c.req.param('domain') ?? '';
  const state = getDomainProfileState(raw);
  // Issue #214: reviewed health from the shared domain/version evaluator
  // (active-version verdict, read-only). Existing header fields untouched.
  let reviewedHealth: { healthy: boolean; reason: string | null; versionId: string | null };
  try {
    const verdict = getDomainReleaseHealth(state.normalizedDomain || raw);
    reviewedHealth = { ...verdict, versionId: state.activeVersion };
  } catch {
    reviewedHealth = { healthy: false, reason: 'health_check_failed', versionId: state.activeVersion };
  }
  return c.json({ ...state, reviewedHealth });
});
