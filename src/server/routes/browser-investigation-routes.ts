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
// GET  /api/domains/:domain/investigations/drift-context (T5: drift entry preview)
// GET  /api/domains/:domain/investigations/:id/workspace (T5: operator view)
// GET  /api/domains/:domain/investigations/:id/proposal (T2: compile only)
// POST /api/domains/:domain/investigations/:id/apply (T2: inactive draft)
// POST /api/domains/:domain/investigations/:id/validate (T4: worker validation)
// GET  /api/domains/:domain/investigations/:id/validation (T4: validation ref)
// GET  /api/domains/:domain/investigations/:id/telemetry (T6: runtime telemetry)
// GET  /api/domains/:domain/investigations/:id/drift-proposal (T6: smallest-change repair)
//
// All routes are workspace-scoped via getCurrentWorkspace. Foreign-workspace
// access is rejected without leaking cross-workspace state. No activation,
// release, or image-attestation routes ship here: apply publishes an
// inactive draft only and never touches the active pointer.

import { Hono } from 'hono';
import { z } from 'zod';
import {
  describeInvestigationBudget,
  normalizeInvestigationDomain,
  resolveInvestigationBudget,
  InvestigationBudgetInputSchema,
  InvestigationProviderIdSchema,
} from '../../shared/schemas/browser-investigation';
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
import { createSqliteInvestigationStore, createSqliteProposalStore, createSqliteValidationStore } from '../../onboarding/browser-investigation/store';
import { applyProposalToDraft, compileProposalForInvestigation, type ApplyProposalResult, type ApplyValidationInput } from '../../onboarding/browser-investigation/apply';
import {
  getProposalValidation,
  validateProposal,
  type PolicyWorkerResult,
  type PolicyWorkerRunner,
} from '../../onboarding/browser-investigation/validate';
import {
  attachDriftRepairContext,
  buildDriftRepairContext,
  describeInvestigationWorkspace,
  type DriftRepairContext,
} from '../../onboarding/browser-investigation/workspace';
import { getRepresentativeSuite } from '../../db/repositories/representative-suite-repo';
import { getActiveVersion } from '../../db/repositories/profile-version-repo';
import { getMatrixResult } from '../../onboarding/profile-test-matrix';
import { runProfileExtraction } from '../../onboarding/profile-runner-client';
import { createVersion, getVersionById } from '../../db/repositories/profile-version-repo';
import { compileInvestigationResult } from '../../onboarding/browser-investigation/compiler';
import { proposeDriftRepair } from '../../onboarding/browser-investigation/drift';
import { fakeInvestigationProvider, FakeInvestigationScenarioSchema } from '../../onboarding/browser-investigation/fake-provider';
import {
  describeInvestigationTelemetry,
  withCompileGapCount,
} from '../../onboarding/browser-investigation/telemetry';
import { extractionPolicyOfSelectors } from '../../shared/schemas/browser-investigation-policy';
import {
  getInvestigationProvider,
  registerInvestigationProvider,
} from '../../onboarding/browser-investigation/provider';
import { LocalBrowserHarnessProvider } from '../../onboarding/browser-investigation/local-harness';

export const browserInvestigationRoutes = new Hono();

// Register investigation providers exactly once. The fake stays for
// deterministic fixtures; the T3 local harness is registered with default
// (production) dependencies and fails closed with `isolation_unavailable`
// when isolation is not enabled — missing isolation never falls back.
try {
  getInvestigationProvider('fake');
} catch {
  registerInvestigationProvider(fakeInvestigationProvider);
}
try {
  getInvestigationProvider('local_browser_harness');
} catch {
  registerInvestigationProvider(new LocalBrowserHarnessProvider());
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
  holdout_exposed: 422,
  reserved_holdout_dropped: 422,
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
  // T3: explicit provider choice. Default stays `fake` so existing callers
  // keep deterministic fixtures; `local_browser_harness` runs the isolated
  // harness and fails closed without isolation. Unknown/cloud ids rejected.
  provider: InvestigationProviderIdSchema.optional(),
  modelPolicy: z
    .object({
      allowCloudTextAnalysis: z.boolean().optional(),
      allowImageSharing: z.boolean().optional(),
    })
    .optional(),
  knownContext: z.record(z.string(), z.unknown()).optional(),
  // Test-only seam: deterministic fake scenario for this launch (defaults to
  // `valid`). Lets route-level tests drive failure paths deterministically.
  // Only honored when `provider` is `fake` (the default).
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
  const provider = parsed.data.provider ?? 'fake';
  if (provider === 'fake') fakeInvestigationProvider.setScenario(parsed.data.scenario ?? 'valid');
  // T5 drift/failure entry: pre-attach the frozen last-healthy baseline
  // (policy, artifact hashes, failing extraction, provenance, failure
  // codes, affected fields) so repair starts from evidence. The driftRepair
  // key is server-owned; launch-payload values are replaced, never merged.
  const driftContext: DriftRepairContext | null =
    mode === 'drift_repair' ? productionDriftContext(domain) : null;
  const input = {
    domain,
    mode,
    sampleUrls: parsed.data.sampleUrls,
    budget: parsed.data.budget,
    modelPolicy: parsed.data.modelPolicy,
    knownContext: driftContext
      ? attachDriftRepairContext(parsed.data.knownContext, driftContext)
      : parsed.data.knownContext,
    provider,
  };
  // Budgets are shown at launch: the resolved caps travel with the response
  // so the operator sees action/byte/token/image/artifact/request budgets
  // before (and after) the bounded run. Enforcement lives at the
  // broker/capture/dispatch layers, not in this preview.
  const budgets = describeInvestigationBudget(resolveInvestigationBudget(parsed.data.budget));
  // requestAndRun returns the failed/cancelled record instead of throwing
  // for terminal provider outcomes; throws here mean validation/conflict.
  return withInvestigationScope(c, 201, async (workspaceId, store) => ({
    budgets,
    ...(driftContext ? { driftContext } : {}),
    investigation: parsed.data.queueOnly
      ? requestInvestigation(store, { ...input, workspaceId })
      : await requestAndRunInvestigation(store, { ...input, workspaceId }),
  }));
}

/**
 * T5 production adapter for the drift-repair entry context: the frozen
 * last-healthy baseline (active version) plus current matrix failures.
 * Fail-closed to an explicit unavailable marker — never throws, never
 * fabricates baseline evidence.
 */
function productionDriftContext(domain: string): DriftRepairContext {
  try {
    const active = getActiveVersion(domain);
    if (!active) {
      return buildDriftRepairContext(domain, { activeVersion: null, matrix: null });
    }
    return buildDriftRepairContext(domain, {
      activeVersion: { id: active.id, selectors: active.selectors, artifactHashes: active.artifactHashes },
      matrix: getMatrixResult(domain, active.id),
    });
  } catch {
    return { available: false, reason: 'context_unavailable:drift baseline could not be read' };
  }
}

/** Confirmed representative suite URLs, fail-closed to empty (shared suite, read-only). */
function productionRepresentatives(domain: string): string[] {
  try {
    return getRepresentativeSuite(domain);
  } catch {
    return [];
  }
}

const BudgetPreviewBodySchema = z.object({
  sampleUrls: z.array(z.string().url()).min(1).max(5).optional(),
  budget: InvestigationBudgetInputSchema.optional(),
});

/**
 * POST /api/domains/:domain/investigations/preview — resolve and SHOW the
 * full budget (action, byte, token, image, artifact, request-attempt caps)
 * without creating a run. Registered before `:id` routes so the static
 * segment wins over the param match.
 */
async function handleBudgetPreview(c: RouteContext): Promise<Response> {
  const raw = await c.req.json().catch(() => ({}));
  const parsed = BudgetPreviewBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid budget preview payload', details: parsed.error.format() }, 400);
  }
  const budgets = describeInvestigationBudget(resolveInvestigationBudget(parsed.data.budget));
  return c.json({ budgets }, 200);
}

browserInvestigationRoutes.post('/domains/:domain/investigations', (c) =>
  handleLaunch(c as never, 'domain_onboarding'),
);

browserInvestigationRoutes.post('/domains/:domain/investigations/drift-repair', (c) =>
  handleLaunch(c as never, 'drift_repair'),
);

browserInvestigationRoutes.post('/domains/:domain/investigations/preview', (c) =>
  handleBudgetPreview(c as never),
);

browserInvestigationRoutes.get('/domains/:domain/investigations', (c) => {
  const ctx = c as never as RouteContext;
  const domain = normalizeInvestigationDomain(ctx.req.param('domain') ?? '');
  return withInvestigationScope(ctx, 200, (workspaceId, store) => ({
    investigations: listInvestigations(store, workspaceId, domain),
  }));
});

// T5 drift entry preview: the frozen last-healthy baseline the
// drift-repair launch would pre-attach. Static segment registered before
// `:id` routes so it never parses as an investigation id.
browserInvestigationRoutes.get('/domains/:domain/investigations/drift-context', (c) => {
  const ctx = c as never as RouteContext;
  const domain = normalizeInvestigationDomain(ctx.req.param('domain') ?? '');
  return withInvestigationScope(ctx, 200, () => ({
    driftContext: productionDriftContext(domain),
  }));
});

browserInvestigationRoutes.get('/domains/:domain/investigations/:id', (c) => {
  const ctx = c as never as RouteContext;
  const id = ctx.req.param('id') ?? '';
  return withInvestigationScope(ctx, 200, (workspaceId, store) => ({
    investigation: getInvestigation(store, workspaceId, id),
  }));
});

// ─── T5: Profile Workspace operator view ────────────────────────────────
// GET /api/domains/:domain/investigations/:id/workspace — representative
// selection with visible holdout coverage and budgets, evidence-rich
// results, proposal preview, stored validation, and separate Validate /
// Apply / Discard affordances. Read-only: offers no activation or release
// action, computes no health verdict (see the shared evaluator).
browserInvestigationRoutes.get('/domains/:domain/investigations/:id/workspace', (c) => {
  const ctx = c as never as RouteContext;
  const id = ctx.req.param('id') ?? '';
  return withInvestigationScope(ctx, 200, (workspaceId, store) => {
    const record = getInvestigation(store, workspaceId, id);
    const domain = normalizeInvestigationDomain(ctx.req.param('domain') ?? record.domain);
    const representatives = productionRepresentatives(domain);
    const validations = createSqliteValidationStore();
    const validation = getProposalValidation({ investigations: store, validations }, workspaceId, id);
    const reservedUrls = validation && validation.samples.length > 0 ? validation.holdouts.sampleIds : [];
    return {
      workspace: describeInvestigationWorkspace({
        record,
        budget: record.budget,
        representatives,
        corpusUrls: representatives,
        reservedUrls,
        validation,
      }),
    };
  });
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
      // T4: validation-to-proposal binding plus blind-holdout evidence.
      policyHash: z.string().length(64).optional(),
      holdouts: z
        .object({
          passed: z.number().int().min(0),
          required: z.number().int().min(0),
          sampleIds: z.array(z.string().min(1).max(2048)).max(10).default([]),
        })
        .optional(),
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

// ─── T4: representative validation ─────────────────────────────────────────
// POST /api/domains/:domain/investigations/:id/validate — execute the
// compiled proposal through the production worker on frozen representative
// samples plus reserved blind holdouts. Persists the validation reference
// for the apply path. Creates no versions, activates nothing.
// GET  /api/domains/:domain/investigations/:id/validation — read the
// persisted validation reference.

const ValidateBodySchema = z.object({
  baselineVersionId: z.string().min(1).max(256).optional(),
  samples: z
    .array(
      z.object({
        url: z.string().url(),
        role: z.enum(['representative', 'holdout']),
        expected: z.object({
          name: z.string().min(1).max(512),
          brandHint: z.string().max(256).nullable().optional(),
          price: z.string().max(64).nullable().optional(),
          gtin: z.string().max(32).nullable().optional(),
          sku: z.string().max(512).nullable().optional(),
          platformVariantId: z.string().max(256).nullable().optional(),
          variantKey: z.string().max(256).nullable().optional(),
          productId: z.string().max(256).nullable().optional(),
        }),
        artifactRef: z.string().min(1).max(500).optional(),
      }),
    )
    .min(1)
    .max(10),
});

/** Production worker seam for validation: compiled draft profile through the profile runner. */
function buildRunnerExpected(expected: {
  name: string;
  brandHint?: string | null;
  price?: string | null;
  upc?: string;
  sku?: string;
  platformVariantId?: string;
}): { name: string; brandHint: string | null; price: string | null; upc?: string; sku?: string; platformVariantId?: string } {
  return {
    name: expected.name,
    brandHint: expected.brandHint ?? null,
    price: expected.price ?? null,
    ...(expected.upc ? { upc: expected.upc } : {}),
    ...(expected.sku ? { sku: expected.sku } : {}),
    ...(expected.platformVariantId ? { platformVariantId: expected.platformVariantId } : {}),
  };
}

type PolicyRunnerFailure = {
  ok: false;
  error: string;
  failureCode: string | null;
  matrixDecision: { status: string; selectedVariantKey: string | null; matchedBy?: string; reasonCodes?: string[] } | null;
  selectedReceipt: { selectedVariantKey?: string } | null;
};

function mapRunnerFailure(res: {
  error: string;
  failureCode?: string | null;
  matrixDecision?: unknown;
  selectedReceipt?: unknown;
}): PolicyRunnerFailure {
  return {
    ok: false,
    error: res.error,
    failureCode: res.failureCode ?? null,
    matrixDecision: (res.matrixDecision ?? null) as PolicyRunnerFailure['matrixDecision'],
    selectedReceipt: (res.selectedReceipt ?? null) as PolicyRunnerFailure['selectedReceipt'],
  };
}

function runnerImagesOf(data: Record<string, unknown>): string[] {
  if (Array.isArray((data as { images?: unknown }).images)) {
    return (data as { images: unknown[] }).images.filter((u): u is string => typeof u === 'string');
  }
  const primary = (data as { primaryImage?: unknown }).primaryImage;
  const additional = ((data as { additionalImages?: unknown }).additionalImages as unknown[] | undefined) ?? [];
  return [primary, ...additional].filter((u): u is string => typeof u === 'string');
}

function runnerDataOf(
  data: Record<string, unknown>,
  images: string[],
  fieldProvenance: Record<string, string>,
): NonNullable<Extract<PolicyWorkerResult, { ok: true }>['data']> {
  return {
    title: (data.title as string | null) ?? null,
    brand: (data.brand as string | null) ?? null,
    description: (data.description as string | null) ?? null,
    price: (data.price as string | null) ?? null,
    primaryImage: images[0] ?? null,
    additionalImages: images.slice(1),
    customFields: ((data.customFields as Record<string, string> | undefined) ?? {}) as Record<string, string>,
    fieldProvenance,
  } as never;
}

function mapRunnerSuccess(
  res: Record<string, unknown> & {
    data: Record<string, unknown>;
    fieldProvenance?: Record<string, string>;
    matrixDecision?: unknown;
    selectedReceipt?: unknown;
    sourceContentHash?: string | null;
  },
): PolicyWorkerResult {
  const data = res.data;
  const images = runnerImagesOf(data);
  return {
    ok: true,
    data: runnerDataOf(data, images, (res.fieldProvenance ?? {}) as Record<string, string>),
    matrixDecision: (res.matrixDecision ?? null) as never,
    selectedReceipt: (res.selectedReceipt ?? null) as never,
    parentProductId: ((res as { parentProductId?: unknown }).parentProductId as string | undefined) ?? null,
    sourceContentHash: res.sourceContentHash ?? null,
  };
}

const productionPolicyRunner: PolicyWorkerRunner = {
  run: async ({ profile, sampleUrl, expected }) => {
    const res = await runProfileExtraction({ sourceUrl: sampleUrl, profile, expected: buildRunnerExpected(expected) });
    if (!res.ok) return mapRunnerFailure(res);
    return mapRunnerSuccess({
      ...(res as unknown as Record<string, unknown>),
      data: res.data as unknown as Record<string, unknown>,
    });
  },
};

browserInvestigationRoutes.post('/domains/:domain/investigations/:id/validate', async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const parsed = ValidateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid validation payload', details: parsed.error.format() }, 400);
  }
  return withInvestigationScope(c as never, 200, async (workspaceId, store) => ({
    validation: await validateProposal(
      {
        investigations: store,
        proposals: createSqliteProposalStore(),
        validations: createSqliteValidationStore(),
        runner: productionPolicyRunner,
      },
      {
        workspaceId,
        investigationId: (c as never as RouteContext).req.param('id') ?? '',
        samples: parsed.data.samples.map((s) => ({
          url: s.url,
          role: s.role,
          expected: {
            name: s.expected.name,
            brandHint: s.expected.brandHint ?? null,
            price: s.expected.price ?? null,
            gtin: s.expected.gtin ?? null,
            sku: s.expected.sku ?? null,
            platformVariantId: s.expected.platformVariantId ?? null,
            variantKey: s.expected.variantKey ?? null,
            productId: s.expected.productId ?? null,
          },
          ...(s.artifactRef ? { artifactRef: s.artifactRef } : {}),
        })),
        ...(parsed.data.baselineVersionId ? { baselineVersionId: parsed.data.baselineVersionId } : {}),
      },
    ),
  }));
});

browserInvestigationRoutes.get('/domains/:domain/investigations/:id/validation', (c) => {
  const ctx = c as never as RouteContext;
  const id = ctx.req.param('id') ?? '';
  return withInvestigationScope(ctx, 200, (workspaceId, store) => ({
    validation: getProposalValidation(
      { investigations: store, validations: createSqliteValidationStore() },
      workspaceId,
      id,
    ),
  }));
});

/**
 * Pure re-compilation of a stored investigation result for read-only
 * routes (telemetry gap counts, drift proposals). No persistence, no
 * provider calls — the proposal route remains the persisting read path.
 */
function compileStoredResult(record: ReturnType<typeof getInvestigation>) {
  if (!record.result || !record.resultHash) return null;
  try {
    return compileInvestigationResult(record.result, {
      domain: record.domain,
      investigationId: record.id,
      runId: record.runId,
      inputHash: record.inputHash,
      resultHash: record.resultHash,
    });
  } catch {
    return null;
  }
}

// ─── T6: runtime telemetry ───────────────────────────────────────────────
// GET /api/domains/:domain/investigations/:id/telemetry — operator-visible
// telemetry derived from persisted investigation + validation state.
// Actual usage/cost or explicit unavailable (billed vs estimated never
// fabricated); wrong-product / wrong-variant signals included; keys,
// prompts, and page content never leave the workspace tables. Read-only.
browserInvestigationRoutes.get('/domains/:domain/investigations/:id/telemetry', (c) => {
  const ctx = c as never as RouteContext;
  const id = ctx.req.param('id') ?? '';
  return withInvestigationScope(ctx, 200, (workspaceId, store) => {
    const record = getInvestigation(store, workspaceId, id);
    const validation = getProposalValidation(
      { investigations: store, validations: createSqliteValidationStore() },
      workspaceId,
      id,
    );
    let telemetry = describeInvestigationTelemetry(record, validation);
    const outcome = compileStoredResult(record);
    if (outcome) {
      telemetry = withCompileGapCount(
        telemetry,
        outcome.status === 'proposal' ? outcome.gaps.length : null,
      );
    }
    return { telemetry };
  });
});

// ─── T6: drift-repair proposal ───────────────────────────────────────────
// GET /api/domains/:domain/investigations/:id/drift-proposal — smallest
// supported deterministic change from the frozen last-healthy baseline to
// the freshly compiled proposal. Pure derivation over stored state: no
// provider calls, no automatic reruns, no auto-promotion. The returned
// proposal must still travel validate → human-review → governed-activation.
browserInvestigationRoutes.get('/domains/:domain/investigations/:id/drift-proposal', (c) => {
  const ctx = c as never as RouteContext;
  const id = ctx.req.param('id') ?? '';
  return withInvestigationScope(ctx, 200, (workspaceId, store) => {
    const record = getInvestigation(store, workspaceId, id);
    const domain = normalizeInvestigationDomain(ctx.req.param('domain') ?? record.domain);
    const outcome = compileStoredResult(record);
    if (!outcome) {
      return {
        driftProposal: proposeDriftRepair({
          baselinePolicy: null,
          outcome: { status: 'unresolved', gaps: [{ kind: 'missing_field_evidence', detail: 'investigation has no typed result to compile' }] },
          affectedFields: [],
          failureCodes: [],
        }),
      };
    }
    const driftContext = productionDriftContext(domain);
    const affectedFields = driftContext.available ? driftContext.affectedFields : [];
    const failureCodes = driftContext.available ? driftContext.failureCodes : [];
    const baselinePolicy: unknown = (() => {
      try {
        const active = getActiveVersion(domain);
        return active ? extractionPolicyOfSelectors(active.selectors) : null;
      } catch {
        return null;
      }
    })();
    return {
      driftProposal: proposeDriftRepair({ baselinePolicy, outcome, affectedFields, failureCodes }),
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
