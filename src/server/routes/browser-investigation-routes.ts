// Browser Investigation routes (T1) — the ONLY HTTP entrypoints that may
// invoke the investigation provider seam.
//
// POST /api/domains/:domain/investigations            (domain_onboarding)
// POST /api/domains/:domain/investigations/drift-repair (drift_repair)
// GET  /api/domains/:domain/investigations
// GET  /api/domains/:domain/investigations/:id
// GET  /api/domains/:domain/investigations/:id/status
// POST /api/domains/:domain/investigations/:id/cancel
// POST /api/domains/:domain/investigations/:id/discard
// GET  /api/domains/:domain/investigations/:id/proposal (T2: compile only)
// POST /api/domains/:domain/investigations/:id/apply (T2: inactive draft)
//
// All routes are workspace-scoped via getCurrentWorkspace. Foreign-workspace
// access is rejected without leaking cross-workspace state. No activation,
// release, or image-attestation routes ship here: apply publishes an
// inactive draft only and never touches the active pointer.

import { Hono } from 'hono';
import { z } from 'zod';
import { normalizeInvestigationDomain, InvestigationBudgetInputSchema } from '../../shared/schemas/browser-investigation';
import {
  cancelInvestigation,
  discardInvestigation,
  getInvestigation,
  getInvestigationStatus,
  listInvestigations,
  requestAndRunInvestigation,
  requestInvestigation,
  InvestigationServiceError,
  type InvestigationStore,
} from '../../onboarding/browser-investigation/service';
import { createSqliteInvestigationStore, createSqliteProposalStore } from '../../onboarding/browser-investigation/store';
import { applyProposalToDraft, compileProposalForInvestigation, type ApplyProposalResult, type ApplyValidationInput } from '../../onboarding/browser-investigation/apply';
import { createVersion, getVersionById } from '../../db/repositories/profile-version-repo';
import { fakeInvestigationProvider, FakeInvestigationScenarioSchema } from '../../onboarding/browser-investigation/fake-provider';
import {
  getInvestigationProvider,
  registerInvestigationProvider,
} from '../../onboarding/browser-investigation/provider';

export const browserInvestigationRoutes = new Hono();

// Register the deterministic fake provider exactly once. The local harness
// intentionally stays UNREGISTERED in T1: dispatching to it fails closed
// with `isolation_unavailable` until T3 proves container isolation.
try {
  getInvestigationProvider('fake');
} catch {
  registerInvestigationProvider(fakeInvestigationProvider);
}

function getWorkspaceId(): string {
  // Lazy import keeps route collection free of hard workspace boot failures.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const svc = require('../services/workspace-service') as {
    getCurrentWorkspace: () => { id: string } | null;
  };
  const ws = svc.getCurrentWorkspace();
  if (!ws) throw new InvestigationServiceError('invalid_input', 'workspace not initialized');
  return ws.id;
}

type InvestigationHttpStatus = 400 | 403 | 404 | 409 | 422 | 500 | 502;

/** Operator-safe failure code → HTTP status. Terminal provider outcomes
 * (timeout/error/isolation) surface as 502; validation and replay
 * rejections as 400/409/403. Unknown codes fail closed as 400. */
const INVESTIGATION_HTTP_STATUS: Readonly<Record<string, InvestigationHttpStatus>> = {
  not_found: 404,
  workspace_mismatch: 403,
  conflict_active_investigation: 409,
  already_applied: 409,
  stale_proposal: 409,
  stale_completion: 409,
  replay_rejected: 409,
  cancelled: 409,
  unappliable_proposal: 422,
  timeout: 502,
  provider_error: 502,
  isolation_unavailable: 502,
  cloud_disabled: 502,
};

function toHttpStatus(err: unknown): InvestigationHttpStatus {
  if (err instanceof InvestigationServiceError) {
    return INVESTIGATION_HTTP_STATUS[err.code] ?? 400;
  }
  return 500;
}

function serviceErrorBody(err: unknown): { error: string; code: string } {
  const e = err as InvestigationServiceError;
  return { error: e.message ?? String(err), code: (e as { code?: string }).code ?? 'provider_error' };
}

type RouteContext = {
  req: { param: (key: string) => string; json: () => Promise<unknown> };
  json: (body: unknown, status?: 200 | 201 | 400 | 403 | 404 | 409 | 422 | 500 | 502) => Response;
};

/**
 * Resolve the requesting workspace and run the scoped service call, mapping
 * service failures to operator-safe HTTP responses. Every handler flows
 * through here so workspace scoping cannot be skipped per-route.
 */
async function withInvestigationScope(
  c: RouteContext,
  status: 200 | 201,
  fn: (workspaceId: string, store: InvestigationStore) => Promise<unknown> | unknown,
): Promise<Response> {
  let workspaceId: string;
  try {
    workspaceId = getWorkspaceId();
  } catch (err) {
    return c.json(serviceErrorBody(err), toHttpStatus(err));
  }
  try {
    const body = await fn(workspaceId, createSqliteInvestigationStore());
    return c.json(body, status);
  } catch (err) {
    return c.json(serviceErrorBody(err), toHttpStatus(err));
  }
}

const LaunchBodySchema = z.object({
  sampleUrls: z.array(z.string().url()).min(1).max(5),
  // Single source of truth for caps lives in the shared budget schema;
  // routes accept partial overrides, never redeclare bounds.
  budget: InvestigationBudgetInputSchema.optional(),
  modelPolicy: z
    .object({
      allowCloudTextAnalysis: z.boolean().optional(),
      allowImageSharing: z.boolean().optional(),
    })
    .optional(),
  knownContext: z.record(z.string(), z.unknown()).optional(),
  // Test-only seam: deterministic fake scenario for this launch (defaults to
  // `valid`). Lets route-level tests drive failure paths deterministically;
  // removed when the real harness lands in T3.
  scenario: FakeInvestigationScenarioSchema.optional(),
  // Launch without running (queue only). Default runs immediately so one
  // explicit operator action produces a terminal fixture via the fake.
  queueOnly: z.boolean().optional(),
});

async function handleLaunch(
  c: RouteContext,
  mode: 'domain_onboarding' | 'drift_repair',
): Promise<Response> {
  const domain = normalizeInvestigationDomain(c.req.param('domain') ?? '');
  const raw = await c.req.json().catch(() => ({}));
  const parsed = LaunchBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid investigation payload', details: parsed.error.format() }, 400);
  }
  fakeInvestigationProvider.setScenario(parsed.data.scenario ?? 'valid');
  const input = {
    domain,
    mode,
    sampleUrls: parsed.data.sampleUrls,
    budget: parsed.data.budget,
    modelPolicy: parsed.data.modelPolicy,
    knownContext: parsed.data.knownContext,
    provider: 'fake' as const,
  };
  // requestAndRun returns the failed/cancelled record instead of throwing
  // for terminal provider outcomes; throws here mean validation/conflict.
  return withInvestigationScope(c, 201, async (workspaceId, store) => ({
    investigation: parsed.data.queueOnly
      ? requestInvestigation(store, { ...input, workspaceId })
      : await requestAndRunInvestigation(store, { ...input, workspaceId }),
  }));
}

browserInvestigationRoutes.post('/domains/:domain/investigations', (c) =>
  handleLaunch(c as never, 'domain_onboarding'),
);

browserInvestigationRoutes.post('/domains/:domain/investigations/drift-repair', (c) =>
  handleLaunch(c as never, 'drift_repair'),
);

browserInvestigationRoutes.get('/domains/:domain/investigations', (c) => {
  const ctx = c as never as RouteContext;
  const domain = normalizeInvestigationDomain(ctx.req.param('domain') ?? '');
  return withInvestigationScope(ctx, 200, (workspaceId, store) => ({
    investigations: listInvestigations(store, workspaceId, domain),
  }));
});

browserInvestigationRoutes.get('/domains/:domain/investigations/:id', (c) => {
  const ctx = c as never as RouteContext;
  const id = ctx.req.param('id') ?? '';
  return withInvestigationScope(ctx, 200, (workspaceId, store) => ({
    investigation: getInvestigation(store, workspaceId, id),
  }));
});

browserInvestigationRoutes.get('/domains/:domain/investigations/:id/status', (c) => {
  const ctx = c as never as RouteContext;
  const id = ctx.req.param('id') ?? '';
  return withInvestigationScope(ctx, 200, (workspaceId, store) => ({
    status: getInvestigationStatus(store, workspaceId, id),
  }));
});

browserInvestigationRoutes.post('/domains/:domain/investigations/:id/cancel', (c) => {
  const ctx = c as never as RouteContext;
  const id = ctx.req.param('id') ?? '';
  return withInvestigationScope(ctx, 200, async (workspaceId, store) => {
    await ctx.req.json().catch(() => ({}));
    return { investigation: cancelInvestigation(store, workspaceId, id) };
  });
});

const DiscardBodySchema = z.object({
  actor: z.string().min(1),
});

// ─── T2: proposal compile + blocked-draft apply ────────────────────────────
// GET  /api/domains/:domain/investigations/:id/proposal — deterministic
//      compile of the stored result; persists the immutable proposal
//      reference. Creates no versions.
// POST /api/domains/:domain/investigations/:id/apply — publish a compilable
//      proposal as a sanitized INACTIVE shared draft with blockers
//      preserved. Never touches the active pointer, never grants image
//      review, never implies validation success. Unappliable outcomes
//      (requires_code_adapter / unresolved) are rejected with 422 and
//      create no version.

const ApplyBodySchema = z.object({
  actor: z.string().min(1),
  validation: z
    .object({
      status: z.enum(['passed', 'failed', 'incomplete', 'not_run']),
      blockers: z.array(z.string().min(1).max(500)).max(50).optional(),
      validationRef: z.string().min(1).max(500).optional(),
    })
    .optional(),
});

browserInvestigationRoutes.get('/domains/:domain/investigations/:id/proposal', (c) => {
  const ctx = c as never as RouteContext;
  const id = ctx.req.param('id') ?? '';
  return withInvestigationScope(ctx, 200, async (workspaceId, store) => ({
    outcome: await compileProposalForInvestigation(
      { investigations: store, proposals: createSqliteProposalStore() },
      workspaceId,
      id,
    ),
  }));
});

browserInvestigationRoutes.post('/domains/:domain/investigations/:id/apply', async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const parsed = ApplyBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Apply actor required', details: parsed.error.format() }, 400);
  }
  return withInvestigationScope(c as never, 201, async (workspaceId, store) => {
    const validation: ApplyValidationInput | undefined = parsed.data.validation;
    const applied: ApplyProposalResult = await applyProposalToDraft(
      {
        investigations: store,
        proposals: createSqliteProposalStore(),
        createVersion: (input) => createVersion({ ...input, runtime: input.runtime as 'static' | 'rendered' }),
      },
      {
        workspaceId,
        investigationId: (c as never as RouteContext).req.param('id') ?? '',
        actor: parsed.data.actor,
        validation,
      },
    );
    return {
      applied,
      version: getVersionById(applied.appliedVersionId),
    };
  });
});

browserInvestigationRoutes.post('/domains/:domain/investigations/:id/discard', async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const parsed = DiscardBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Discard actor required', details: parsed.error.format() }, 400);
  }
  return withInvestigationScope(c as never, 200, (workspaceId, store) => ({
    investigation: discardInvestigation(
      store,
      workspaceId,
      (c as never as RouteContext).req.param('id') ?? '',
      parsed.data.actor,
    ),
  }));
});
