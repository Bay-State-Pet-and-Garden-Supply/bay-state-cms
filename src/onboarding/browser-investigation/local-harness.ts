// Constrained local browser-harness provider (T3, containerized in #236, Tier 1 in #237, deferred by default in #246).
//
// Investigation-only `local_browser_harness` implementation of the
// provider-neutral seam. Tier 0 runs always: a fixed application-authored
// read plan as host-side broker fetch plus in-container analysis (page
// bytes captured + retained on the host, analyzed in-container, typed
// observations out; the host never parses page bytes).
//
// Tier 1 engages conditionally on top of the Tier 0 base:
// - Rendered investigation (#246: DEFERRED by default): only when Tier 0
//   reports no DOM evidence (`renderedBrowserRequired`) AND the explicit
//   non-default switch (`allowTier1Render` / BAYSTATE_INVESTIGATION_ALLOW_RENDER)
//   is set. Without the switch the default path refuses with
//   `render_deferred` and performs no render attempt. With the switch,
//   rendered reads execute inside the render container (proxy-only egress
//   to the validating forward proxy) and merge as `page_rendered`
//   observations anchored to host-retained artifacts. The switch is
//   diagnostics/tests only — not production-valid until #237 lands with
//   render-navigation proof (HTTPS requires CONNECT; the proxy refuses it).
// - Bounded model reasoning: only when the operator opts in
//   (`modelPolicy.allowCloudTextAnalysis`) AND a reasoner is configured.
//   One bounded call over the redacted, holdout-blind context; advisory
//   output only (strategy prose + gaps — never identity, fields,
//   structures, or platform, so the compiler gate is unchanged). No model
//   configured is a visible gap; deterministic Tier 0 stands. An
//   engaged-but-failed call fails the run closed with a stable code.
//
// Usage reports what actually ran: ledger charges (including model
// input/output bytes) plus the counted model calls and the acting model
// identity — never hardcoded zeros.
//
// Gating (all fail closed):
// - single local-investigation slot (serialized runs);
// - isolation available (explicit enablement + reachable Docker runtime);
// - monetary ceilings the harness cannot enforce (`maxCostUsd`);
// - container posture asserted before any read, image verified at start;
// - deterministic teardown on success, failure, timeout, and cancellation.

import {
  INVESTIGATION_RESULT_VERSION,
  MAX_RESULT_OBSERVATION_DETAIL_CHARS,
} from '../../shared/schemas/browser-investigation';
import {
  InvestigationProviderError,
  type InvestigationProvider,
  type InvestigationProviderCompletion,
  type InvestigationProviderRequest,
} from './provider';
import { InvestigationBroker, scopeFromSampleUrls, BrokerError, type BrokerDeps } from './broker';
import { BudgetLedger, InvestigationBudgetError } from './budgets';
import { createArtifactStore } from './artifacts';
import { mintArtifactRef, mintResponseRef } from './grammar';
import {
  assertContainerPosture,
  buildInvestigationContainerSpec,
  buildRenderContainerSpec,
  checkIsolationAvailable,
  releaseInvestigationSlot,
  tryAcquireInvestigationSlot,
  withIsolatedRun,
  type IsolationProbe,
} from './isolation';
import {
  ContainerRunnerError,
  DockerTier0ContainerRunner,
  tier0BudgetCapsOf,
  type Tier0AnalysisCapture,
  type Tier0AnalysisObservation,
  type Tier0AnalysisResult,
  type Tier0ContainerRunner,
} from './container-runner';
import {
  DockerRenderContainerRunner,
  RenderRunnerError,
  tier1RenderRequestOf,
  type Tier1RenderedObservation,
  type Tier1RenderRunner,
} from './render-runner';
import { startRenderProxy } from './render-proxy';
import {
  ModelContextError,
  ReasonCallError,
  buildTier1ModelContext,
  reasonWithBudget,
  type Tier1ExcludedHoldout,
  type Tier1ModelReasoner,
} from './model-context';

export interface LocalHarnessDeps {
  isolationProbe?: IsolationProbe;
  brokerDeps?: BrokerDeps;
  containerRunner?: Tier0ContainerRunner;
  /** Tier 1 rendered-execution seam. Default is the real Docker render runner (fail-closed without the image). */
  renderRunner?: Tier1RenderRunner;
  /**
   * #246 Tier 1 rendered deferral: rendered investigation is DEFERRED by
   * default. The render container's sole egress (validating forward proxy)
   * refuses CONNECT as an opaque tunnel, while Chromium carries HTTPS
   * through an HTTP proxy via CONNECT — so real https navigation cannot
   * load. The default path refuses rendered-required work with
   * `render_deferred` and performs no render attempt (no proxy, no
   * container, no rendered observations). Set to true ONLY for
   * diagnostics/tests; it is not production-valid until #237 lands with
   * render-navigation proof. `BAYSTATE_INVESTIGATION_ALLOW_RENDER=1` is the
   * equivalent env switch for out-of-process diagnostics (also non-default).
   */
  allowTier1Render?: boolean;
  /**
   * Tier 1 model-reasoning seam. Default is unconfigured: deterministic
   * Tier 0 stands and a gap records the missing model. Tests inject a
   * stub; a future operator-configured endpoint injects here (never a
   * default that could silently spend or leak).
   */
  modelReasoner?: Tier1ModelReasoner;
  /** Reserved blind holdouts the Tier 1 context must stay blind to (empty when none reserved). */
  excludedHoldouts?: Tier1ExcludedHoldout[];
  clock?: () => number;
}

/** Merged Tier 1 outcome: rendered evidence + advisory reasoning over the Tier 0 base. */
interface Tier1Outcome {
  extraObservations: Tier0AnalysisObservation[];
  extraEvidenceRefs: string[];
  extraGaps: string[];
  strategy: string | null;
  /** Actually performed model calls this run (0 or 1) — reported truthfully, never hardcoded. */
  modelCalls: number;
  /** Rendered reads performed in-container (0 when Tier 1 render did not engage). */
  renderReads: number;
  actualModel: { provider: string; model: string };
}

export class LocalBrowserHarnessProvider implements InvestigationProvider {
  readonly id = 'local_browser_harness' as const;

  constructor(private readonly deps: LocalHarnessDeps = {}) {}

  private runner(): Tier0ContainerRunner {
    // Production always executes analysis in-container. Tests inject a
    // double explicitly; a runner that cannot execute analysis fails the
    // run closed below — it never falls back to host-side analysis.
    return this.deps.containerRunner ?? new DockerTier0ContainerRunner();
  }

  private renderRunner(): Tier1RenderRunner {
    // Production always renders in-container behind the validating proxy.
    // Tests inject a double explicitly; without the render image the real
    // runner fails closed (recorded as a gap, never host-side rendering).
    return this.deps.renderRunner ?? new DockerRenderContainerRunner();
  }

  async invoke(request: InvestigationProviderRequest): Promise<InvestigationProviderCompletion> {
    if (!tryAcquireInvestigationSlot()) {
      throw new InvestigationProviderError('provider_error', 'provider_error: another local investigation is running');
    }
    try {
      const runner = this.runner();
      return await withIsolatedRun(request.runId, runner, () => this.runScoped(request, runner));
    } finally {
      releaseInvestigationSlot();
    }
  }

  private async runScoped(
    request: InvestigationProviderRequest,
    runner: Tier0ContainerRunner,
  ): Promise<InvestigationProviderCompletion> {
    const clock = this.deps.clock ?? Date.now;
    const startedAt = clock();
    throwIfHarnessCancelled(request.signal);

    const isolation = await checkIsolationAvailable(this.deps.isolationProbe);
    if (!isolation.available) {
      throw new InvestigationProviderError('isolation_unavailable', `isolation_unavailable: ${isolation.reason}`);
    }
    if (request.budget.maxCostUsd !== undefined) {
      throw new InvestigationProviderError(
        'budget_not_enforceable',
        'budget_not_enforceable: local harness cannot enforce a billing cap',
      );
    }
    if (typeof runner.runAnalysis !== 'function' || typeof runner.start !== 'function') {
      throw new InvestigationProviderError(
        'isolation_unavailable',
        'isolation_unavailable: container runner cannot execute in-container analysis',
      );
    }

    // Posture asserted before any read: a spec deviation fails the run here.
    const spec = buildInvestigationContainerSpec(sanitizeRunId(request.runId));
    assertContainerPosture(spec);
    // Image verified before any fetch: a missing image fails here, never
    // after page bytes have moved.
    await this.startContainer(runner, spec);
    throwIfHarnessCancelled(request.signal);

    const elapsed = (): number => clock() - startedAt;
    const assertLive = (): void => {
      if (elapsed() > request.budget.timeoutMs) {
        throw new InvestigationProviderError('timeout', 'timeout: investigation exceeded its time budget');
      }
    };

    const scope = scopeFromSampleUrls(request.investigationId, request.workspaceId, request.sampleUrls);
    const ledger = new BudgetLedger(request.budget);
    // Image permission is separate from text (design-doc model policy): the
    // dispatch layer only charges image attachments when explicitly allowed.
    ledger.setImageSharingAllowed(request.modelPolicy.allowImageSharing);
    const broker = new InvestigationBroker(scope, request.budget, this.deps.brokerDeps, ledger);
    const artifacts = createArtifactStore(ledger);
    const pages = request.sampleUrls.slice(0, request.budget.maxPages);

    // Host-side broker fetch only: page bytes are captured and retained
    // here, then handed to the container for analysis.
    const captured = await this.captureSamplePages(request, pages, broker, artifacts, assertLive);
    assertLive();
    throwIfHarnessCancelled(request.signal);
    const analysis = await this.analyzeInContainer(runner, spec, request, captured.captures, elapsed);
    throwIfHarnessCancelled(request.signal);
    // Tier 1 (#237) engages on top of the Tier 0 base: conditional
    // rendered investigation plus conditional bounded model reasoning.
    const tier1 = await this.runTier1(request, pages, artifacts, ledger, captured, analysis, elapsed);
    throwIfHarnessCancelled(request.signal);
    const mergedObservations = [...analysis.observations, ...tier1.extraObservations];
    if (mergedObservations.length === 0) {
      throw new InvestigationProviderError('provider_error', 'provider_error: no observations captured within budget');
    }
    return this.assembleCompletion(request, pages, ledger, elapsed(), captured, analysis, tier1);
  }

  private async startContainer(
    runner: Tier0ContainerRunner,
    spec: ReturnType<typeof buildInvestigationContainerSpec>,
  ): Promise<void> {
    try {
      await runner.start(spec);
    } catch (err) {
      throw this.mapRunnerError(err);
    }
  }

  private async analyzeInContainer(
    runner: Tier0ContainerRunner,
    spec: ReturnType<typeof buildInvestigationContainerSpec>,
    request: InvestigationProviderRequest,
    captures: Tier0AnalysisCapture[],
    elapsed: () => number,
  ): Promise<Tier0AnalysisResult> {
    throwIfHarnessCancelled(request.signal);
    const remaining = Math.max(1, request.budget.timeoutMs - elapsed());
    try {
      return await runner.runAnalysis(
        spec,
        {
          investigationId: request.investigationId,
          budget: tier0BudgetCapsOf(request.budget),
          captures,
        },
        { timeoutMs: remaining, signal: request.signal },
      );
    } catch (err) {
      throw this.mapRunnerError(err);
    }
  }

  private mapRunnerError(err: unknown): InvestigationProviderError {
    if (err instanceof InvestigationProviderError) return err;
    // A bare AbortError (e.g. an aborted wait) is always operator
    // cancellation on this path — never a generic provider failure.
    if (err instanceof Error && err.name === 'AbortError') {
      return new InvestigationProviderError('cancelled', 'cancelled: investigation aborted by operator');
    }
    if (err instanceof ContainerRunnerError) {
      return new InvestigationProviderError(err.code, err.message);
    }
    if (err instanceof RenderRunnerError) {
      return new InvestigationProviderError(err.code, err.message);
    }
    if (err instanceof ModelContextError) {
      const code = err.code === 'holdout_exposed' ? 'holdout_exposed' as const : err.code === 'budget_exhausted' ? 'budget_exhausted' as const : 'provider_error' as const;
      return new InvestigationProviderError(code, err.message);
    }
    if (err instanceof ReasonCallError) {
      return new InvestigationProviderError(err.code, err.message);
    }
    if (err instanceof Error) return new InvestigationProviderError('provider_error', err.message.slice(0, 500));
    return new InvestigationProviderError('provider_error', String(err).slice(0, 500));
  }

  /**
   * Tier 1 (#237, deferred by default in #246): conditional rendered
   * investigation + bounded model reasoning over the Tier 0 base. Tier 0
   * evidence is never rewritten — Tier 1 only appends
   * observations/evidence/gaps and advisory strategy.
   *
   * #246 deferral: when Tier 0 reports no DOM evidence over broker-approved
   * captures, the default path refuses with `render_deferred` and performs
   * NO render attempt (no proxy, no container, no rendered observations or
   * coverage claims). The render machinery stays reachable ONLY behind the
   * explicit non-default switch (`allowTier1Render` / env), which is not
   * production-valid until #237 lands with render-navigation proof.
   */
  private async runTier1(
    request: InvestigationProviderRequest,
    pages: string[],
    artifacts: ReturnType<typeof createArtifactStore>,
    ledger: BudgetLedger,
    captured: { captures: Tier0AnalysisCapture[]; evidenceRefs: string[]; gaps: string[] },
    analysis: Tier0AnalysisResult,
    elapsed: () => number,
  ): Promise<Tier1Outcome> {
    const outcome: Tier1Outcome = {
      extraObservations: [],
      extraEvidenceRefs: [],
      extraGaps: [],
      strategy: null,
      modelCalls: 0,
      renderReads: 0,
      actualModel: { provider: 'local_browser_harness', model: 'app-authored-read-plan-v1' },
    };
    // Rendered investigation runs only on Tier 0 rendering need (no DOM
    // evidence from static reads) — the same verdict the result reports.
    const domEvidence =
      analysis.domSignals.title || analysis.domSignals.meta || analysis.domSignals.jsonLd || analysis.domSignals.images;
    if (!domEvidence) {
      // #246: default path refuses rendered-required work before any render
      // machinery is touched. Real https pages cannot load in the render
      // container (HTTPS through an HTTP proxy requires CONNECT; the
      // validating proxy refuses CONNECT by design as opaque_tunnel_refused),
      // and the passing relay tests do not disprove that (manual
      // absolute-form HTTP GETs only). Fail closed with the stable deferred
      // code; the opt-in switch preserves the #237 machinery for
      // diagnostics/tests only.
      if (captured.captures.length > 0 && !isTier1RenderAllowed(this.deps)) {
        throw new InvestigationProviderError(
          'render_deferred',
          'render_deferred: Tier 1 rendered investigation deferred by default (#246): HTTPS through an HTTP proxy requires CONNECT, the validating forward proxy refuses CONNECT by design, and rendered navigation proof is outstanding in #237; no render attempted',
        );
      }
      await this.attemptTier1Render(request, artifacts, ledger, captured, elapsed, outcome);
    }
    await this.attemptTier1Reasoning(request, ledger, captured, analysis, outcome, elapsed);
    return outcome;
  }

  /**
   * Rendered investigation, only on Tier 0 rendering need AND the explicit
   * #246 opt-in switch (callers guarantee the switch; this method never runs
   * on the default path). An unavailable render container (image/network
   * missing) is a visible gap — the Tier 0 verdict stands. An engaged render
   * that fails (budget/time/worker) fails the run closed: need was claimed,
   * so Tier 0-only evidence must not silently stand in for it.
   */
  private async attemptTier1Render(
    request: InvestigationProviderRequest,
    artifacts: ReturnType<typeof createArtifactStore>,
    ledger: BudgetLedger,
    captured: { captures: Tier0AnalysisCapture[]; evidenceRefs: string[]; gaps: string[] },
    elapsed: () => number,
    outcome: Tier1Outcome,
  ): Promise<void> {
    throwIfHarnessCancelled(request.signal);
    if (captured.captures.length === 0) {
      outcome.extraGaps.push('rendered investigation skipped: no broker-approved captures to render');
      return;
    }
    const renderRunner = this.renderRunner();
    if (typeof renderRunner.runRender !== 'function' || typeof renderRunner.start !== 'function') {
      outcome.extraGaps.push('rendered investigation unavailable: render runner cannot execute in-container rendering');
      return;
    }
    const started = await this.startRenderAttempt(request, ledger, renderRunner);
    if ('gap' in started) {
      outcome.extraGaps.push(started.gap);
      return;
    }
    try {
      const remaining = Math.max(1, request.budget.timeoutMs - elapsed());
      const scopeHosts = scopeFromSampleUrls(request.investigationId, request.workspaceId, request.sampleUrls).approvedHosts;
      let rendered;
      try {
        throwIfHarnessCancelled(request.signal);
        rendered = await renderRunner.runRender(
          started.spec,
          tier1RenderRequestOf(
            request.investigationId,
            scopeHosts,
            captured.captures.map((c) => ({ pageIndex: c.pageIndex, url: c.pageUrl, artifactRef: c.artifactRef })),
            request.budget,
          ),
          { timeoutMs: remaining, signal: request.signal },
        );
      } finally {
        try {
          await renderRunner.teardown(started.renderRunId);
        } catch {
          // Deterministic teardown is best-effort; never masks the outcome.
        }
      }
      this.mergeRenderedObservations(rendered.observations, request.investigationId, artifacts, outcome);
      outcome.renderReads = rendered.readsPerformed;
      outcome.extraGaps.push(...rendered.gaps.map((g) => g.slice(0, 1000)));
    } catch (err) {
      throw this.mapRunnerError(err);
    } finally {
      await started.closeProxy();
    }
  }

  /**
   * Start the per-run proxy and verify the render container: returns the
   * live spec or a visible gap. An unavailable render container (image or
   * network missing, proxy unstartable) is a gap — never host rendering.
   * Throws (fail-closed) only for unexpected startup failures.
   */
  private async startRenderAttempt(
    request: InvestigationProviderRequest,
    ledger: BudgetLedger,
    renderRunner: Tier1RenderRunner,
  ): Promise<
    | { spec: ReturnType<typeof buildRenderContainerSpec>; renderRunId: string; closeProxy: () => Promise<void> }
    | { gap: string }
  > {
    let proxyUrl: string;
    let closeProxy: () => Promise<void>;
    try {
      const proxy = await startRenderProxy({
        investigationId: request.investigationId,
        workspaceId: request.workspaceId,
        sampleUrls: request.sampleUrls,
        budget: request.budget,
        ledger,
        brokerDeps: this.deps.brokerDeps,
        bindHost: '0.0.0.0',
        advertiseHost: 'host.docker.internal',
      });
      proxyUrl = proxy.url;
      closeProxy = proxy.close;
    } catch {
      return { gap: 'rendered investigation unavailable: validating forward proxy could not start' };
    }
    const renderRunId = `${sanitizeRunId(request.runId)}-tier1`;
    const spec = buildRenderContainerSpec(renderRunId, proxyUrl);
    try {
      await renderRunner.start(spec);
    } catch (err) {
      await closeProxy();
      if (err instanceof RenderRunnerError && err.code === 'isolation_unavailable') {
        return {
          gap: `rendered investigation unavailable: render container missing (${err.message.slice(0, 160)}); static evidence stands`,
        };
      }
      throw this.mapRunnerError(err);
    }
    return { spec, renderRunId, closeProxy };
  }

  /**
   * Anchor each rendered observation to host-retained evidence: every
   * rendered record is retained under its OWN minted artifact ref (so each
   * evidence ref denotes exactly one retained artifact and the result hash
   * is that artifact's full hash — never a prefix, never another object's
   * hash), and the record itself carries the broker-capture ref for its URL
   * plus the worker's snapshot hash for provenance. Oversized records
   * refuse retention (fail closed) instead of truncating into a mismatch.
   */
  private mergeRenderedObservations(
    rendered: Tier1RenderedObservation[],
    investigationId: string,
    artifacts: ReturnType<typeof createArtifactStore>,
    outcome: Tier1Outcome,
  ): void {
    for (const obs of rendered.slice(0, 20)) {
      const artifactRef = mintArtifactRef(investigationId, `render-p${obs.pageIndex}`);
      const record = {
        kind: 'page_rendered',
        sourceUrl: obs.sourceUrl,
        workerSnapshotHash: obs.artifactHash,
        detail: typeof obs.detail === 'string' ? obs.detail.slice(0, 4000) : undefined,
        incomplete: obs.incomplete,
        pageIndex: obs.pageIndex,
        anchoredTo: obs.artifactRef,
      };
      const bytes = Buffer.from(JSON.stringify(record), 'utf8');
      try {
        const retained = artifacts.retain(bytes, { contentType: 'application/json', sourceUrl: obs.sourceUrl });
        outcome.extraObservations.push({
          kind: 'page_rendered',
          sourceUrl: obs.sourceUrl,
          artifactHash: retained.sha256,
          ...(record.detail ? { detail: record.detail } : {}),
          incomplete: obs.incomplete,
          artifactRef,
        });
        if (!outcome.extraEvidenceRefs.includes(artifactRef)) outcome.extraEvidenceRefs.push(artifactRef);
      } catch {
        outcome.extraGaps.push(
          `rendered observation for ${truncateUrl(obs.sourceUrl)} refused: retention budget exhausted`,
        );
      }
    }
  }

  /**
   * Bounded model reasoning, only on operator opt-in with a configured
   * reasoner. Unconfigured is a visible gap (deterministic Tier 0 stands);
   * an engaged call that fails (holdout/budget/time/worker) fails closed.
   */
  private async attemptTier1Reasoning(
    request: InvestigationProviderRequest,
    ledger: BudgetLedger,
    captured: { captures: Tier0AnalysisCapture[]; evidenceRefs: string[]; gaps: string[] },
    analysis: Tier0AnalysisResult,
    outcome: Tier1Outcome,
    elapsed: () => number,
  ): Promise<void> {
    throwIfHarnessCancelled(request.signal);
    if (!request.modelPolicy.allowCloudTextAnalysis) {
      outcome.extraGaps.push('Tier 1 model reasoning not requested (allowCloudTextAnalysis off); deterministic Tier 0 stands');
      return;
    }
    const reasoner = this.deps.modelReasoner;
    if (!reasoner) {
      outcome.extraGaps.push('Tier 1 model reasoning unavailable: no model configured; deterministic Tier 0 stands');
      return;
    }
    try {
      throwIfHarnessCancelled(request.signal);
      await this.reasonOnce(request, ledger, captured, analysis, outcome, elapsed, reasoner);
    } catch (err) {
      throw this.mapRunnerError(err);
    }
  }

  private async reasonOnce(
    request: InvestigationProviderRequest,
    ledger: BudgetLedger,
    captured: { captures: Tier0AnalysisCapture[]; evidenceRefs: string[]; gaps: string[] },
    analysis: Tier0AnalysisResult,
    outcome: Tier1Outcome,
    elapsed: () => number,
    reasoner: Tier1ModelReasoner,
  ): Promise<void> {
    const context = buildTier1ModelContext({
      investigationId: request.investigationId,
      domain: request.domain,
      observations: [...analysis.observations, ...outcome.extraObservations].map((o) => ({
        kind: o.kind,
        sourceUrl: o.sourceUrl,
        artifactHash: o.artifactHash,
        ...(o.detail ? { detail: o.detail } : {}),
        incomplete: o.incomplete,
      })),
      evidenceRefs: [...captured.evidenceRefs, ...outcome.extraEvidenceRefs],
      analysisGaps: [...captured.gaps, ...analysis.gaps],
      knownContextKeys: Object.keys(request.knownContext ?? {}).sort(),
      excludedHoldouts: this.deps.excludedHoldouts ?? [],
      budget: request.budget,
    });
    const remaining = Math.max(1, request.budget.timeoutMs - elapsed());
    const reasoning = await reasonWithBudget(reasoner, context, ledger, request.budget, { timeoutMs: remaining });
    outcome.modelCalls = 1;
    outcome.actualModel = { ...reasoning.model };
    if (reasoning.strategy) outcome.strategy = reasoning.strategy;
    outcome.extraGaps.push(...reasoning.gaps);
  }

  /** Assemble the untrusted typed result + usage from the container analyses. */
  private assembleCompletion(
    request: InvestigationProviderRequest,
    pages: string[],
    ledger: BudgetLedger,
    elapsedMs: number,
    captured: { evidenceRefs: string[]; gaps: string[] },
    analysis: Tier0AnalysisResult,
    tier1: Tier1Outcome,
  ): InvestigationProviderCompletion {
    const { evidenceRefs: captureRefs, gaps: captureGaps } = captured;
    const evidenceRefs = [...captureRefs, ...tier1.extraEvidenceRefs];
    const mergedObservations = [...analysis.observations, ...tier1.extraObservations];
    const { platformSignals, domSignals, readsPerformed, identity } = analysis;
    const gaps = completionGapsOf(captureGaps, analysis.gaps, identity, tier1.extraGaps);
    const platform = platformSignals.includes('shopify') ? 'shopify' : undefined;
    const verdict = renderVerdictOf(domSignals, tier1.extraObservations.length);
    const result = {
      version: INVESTIGATION_RESULT_VERSION,
      summary: `Local harness investigation of ${request.domain} (${request.mode}): ${mergedObservations.length} observations from ${pages.length} pages via static broker-mediated reads${verdict.rendered ? ' plus Tier 1 rendered reads through the validating proxy' : ''} (Tier 0 deterministic${tier1.modelCalls > 0 ? ' + one bounded Tier 1 model call' : ''}). Untrusted proposal evidence only.`,
      observations: mergedObservations
        .map(({ artifactRef: _ref, ...rest }) => rest)
        .map(boundObservationDetail),
      evidenceRefs,
      gaps,
      renderedBrowserRequired: verdict.required,
      renderedBrowserReason: verdict.reason,
      ...(tier1.strategy ? { recommendedStrategy: tier1.strategy } : {}),
      ...(platform ? { platform } : {}),
      structures: [
        {
          id: 'harness-static-read',
          sampleUrls: pages,
          description: 'Single static-read structure (broker-mediated GET, no interaction).',
          ...(platform === 'shopify' ? { platformSource: 'shopify_product_json' } : {}),
        },
      ],
      fieldRecommendations: [
        // Tier 1 is advisory-only: field recommendations stay Tier 0
        // deterministic (static + rendered observations), so model output
        // can never select executables through this path.
        ...this.fieldRecommendations(mergedObservations, evidenceRefs, platform),
        // Tier 0 (#233): identifier fields backed by in-container identity
        // evidence. Every entry carries the retained-artifact ref its
        // signals came from. On a proven Shopify platform the supported
        // Shopify adapter leads (adapter-first, as the deterministic fake
        // contract does): validation executes the adapter through the
        // production worker and fails closed when it cannot bind, so the
        // proposal never claims more than validation verifies.
        ...identity.fields.map((entry) => ({
          field: entry.field,
          sources:
            platform === 'shopify' ? adapterFirstSources(entry.sources) : [...entry.sources],
          structureId: 'harness-static-read',
          evidenceRef: entry.evidenceRef,
        })),
      ],
      // Absent identity is omitted (not empty): the service schema rejects
      // empty requirement lists as malformed, while the compiler refuses an
      // omitted identity with the typed missing_identity gap. The gate is
      // unchanged — Tier 0 only populates what captured evidence supports.
      ...(identity.productIdentity.length > 0 && identity.variantIdentity.length > 0
        ? {
            identityRequirements: {
              productIdentity: [...identity.productIdentity],
              variantIdentity: [...identity.variantIdentity],
              optionAxes: [...identity.optionAxes],
            },
          }
        : {}),
    };
    const ledgerUsage = ledger.toUsage();
    return {
      investigationId: request.investigationId,
      runId: request.runId,
      provider: this.id,
      inputHash: request.inputHash,
      result,
      usage: {
        // Truthful per-run accounting (#237): ledger charges (including
        // any Tier 1 model input/output bytes) plus the counted model
        // calls — 0 when deterministic Tier 0 stands alone, 1 after the
        // single bounded reasoning call. Never a hardcoded literal.
        ...ledgerUsage,
        modelCalls: tier1.modelCalls,
        pagesVisited: pages.length,
        readsPerformed: readsPerformed + tier1.renderReads,
        durationMs: elapsedMs,
        costUsd: null,
        costBasis: 'unavailable',
      },
      actualModel: { ...tier1.actualModel },
      durationMs: elapsedMs,
    };
  }

  /**
   * Host-side broker fetch over every sample page: capture + retain, or a
   * visible gap. No page byte is parsed here; analysis happens in-container.
   */
  private async captureSamplePages(
    request: InvestigationProviderRequest,
    pages: string[],
    broker: InvestigationBroker,
    artifacts: ReturnType<typeof createArtifactStore>,
    assertLive: () => void,
  ): Promise<{ captures: Tier0AnalysisCapture[]; evidenceRefs: string[]; gaps: string[] }> {
    const captures: Tier0AnalysisCapture[] = [];
    const evidenceRefs: string[] = [];
    const gaps: string[] = [];
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      assertLive();
      throwIfHarnessCancelled(request.signal);
      const pageUrl = pages[pageIndex]!;
      try {
        const res = await broker.fetch(pageUrl);
        const artifact = artifacts.retain(res.body, { contentType: res.contentType, sourceUrl: res.finalUrl });
        const artifactRef = mintArtifactRef(request.investigationId, `p${pageIndex}`);
        evidenceRefs.push(artifactRef);
        captures.push({
          pageIndex,
          bodyBase64: res.body.toString('base64'),
          contentType: res.contentType,
          pageUrl: res.finalUrl,
          artifactHash: artifact.sha256,
          artifactRef,
          responseRef: mintResponseRef(request.investigationId, `p${pageIndex}`),
        });
      } catch (err) {
        gaps.push(`page ${pageIndex + 1} (${truncateUrl(pageUrl)}): ${brokerFailureReason(err)}`);
      }
    }
    return { captures, evidenceRefs, gaps };
  }

  /**
   * Field recommendations for the observed DOM surfaces. Only sources the
   * harness can actually back are listed: the read plan reads text through
   * fixed internal selectors, so it never claims a `selector` exception it
   * could not supply (the compiler would drop such a field). On a proven
   * Shopify platform the coded adapter leads — validation executes it through
   * the production worker and fails closed when it cannot bind.
   */
  private fieldRecommendations(
    observations: Array<{ kind: string; incomplete: boolean }>,
    evidenceRefs: string[],
    platform: string | undefined,
  ): Array<{ field: string; sources: string[]; structureId: string; evidenceRef?: string }> {
    const has = (kind: string): boolean => observations.some((o) => o.kind === kind && !o.incomplete);
    const ref = evidenceRefs[0];
    const sourcesFor = (sources: string[]): string[] => (platform === 'shopify' ? adapterFirstSources(sources) : sources);
    const recommendation = (field: string, sources: string[]): { field: string; sources: string[]; structureId: string; evidenceRef?: string } => ({
      field,
      sources: sourcesFor(sources),
      structureId: 'harness-static-read',
      ...(ref ? { evidenceRef: ref } : {}),
    });
    const out: Array<{ field: string; sources: string[]; structureId: string; evidenceRef?: string }> = [];
    if (has('page_title')) out.push(recommendation('title', ['meta']));
    if (has('page_meta')) out.push(recommendation('description', ['meta']));
    // DOM image presence proves the surface exists but carries no selector
    // exception: only a proven platform adapter can bind it here.
    if (has('page_images') && platform === 'shopify') out.push(recommendation('images', []));
    if (has('page_json_ld')) out.push(recommendation('brand', ['json_ld', 'meta']));
    return out;
  }
}

/**
 * #244 single cancellation check for the harness. One AbortSignal flows
 * from the lifecycle service into every phase: an aborted signal surfaces
 * the stable `cancelled` code (never timeout/provider_error), so the
 * service records terminal `cancelled` and the row stays cancelled.
 */
function throwIfHarnessCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new InvestigationProviderError('cancelled', 'cancelled: investigation aborted by operator');
  }
}

/**
 * Clamp one observation to the result schema's detail cap, marking it
 * incomplete when anything was dropped. The in-container analyzer caps at the
 * run's per-operation budget (up to 32 KiB), so a rich page would otherwise
 * produce a result the service rejects as malformed; clipping is honest
 * (incomplete) and never silently truncates.
 */
function boundObservationDetail<T extends { detail?: string; incomplete: boolean }>(observation: T): T {
  const detail = observation.detail;
  if (!detail || detail.length <= MAX_RESULT_OBSERVATION_DETAIL_CHARS) return observation;
  return {
    ...observation,
    detail: detail.slice(0, MAX_RESULT_OBSERVATION_DETAIL_CHARS),
    incomplete: true,
  };
}

/**
 * Adapter-first source order for a proven Shopify platform (#239 pilot):
 * the supported Shopify adapter leads so the production worker binds
 * identifier and merchandising fields through the coded runtime it
 * verifies; observed representations follow as fallbacks. Order only —
 * no source is claimed that the compiler does not support, and validation
 * fails closed when the adapter cannot bind.
 */
function adapterFirstSources(sources: readonly string[]): string[] {
  const out = ['shopify_product_json'];
  for (const s of sources) {
    if (s !== 'shopify_product_json' && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Merged gap list (schema-capped). Tier 0 identity notes stay verbatim —
 * conflicts visible, absence plain — and Tier 1 (#237) appends only:
 * rendered/worker gaps plus advisory model gaps. Tier 1 never rewrites
 * Tier 0 evidence, identity, or fields.
 */
function completionGapsOf(
  captureGaps: string[],
  analysisGaps: string[],
  identity: Tier0AnalysisResult['identity'],
  tier1Gaps: string[],
): string[] {
  return [
    ...captureGaps,
    ...analysisGaps,
    ...identity.conflicts,
    ...(identity.productIdentity.length === 0 || identity.variantIdentity.length === 0
      ? [
          'no product or variant identity signals in captured evidence; ' +
            'a proposal cannot compile until identity evidence is captured',
        ]
      : []),
    ...tier1Gaps,
  ].slice(0, 50);
}

/**
 * Rendering verdict. Static broker-mediated reads plus, when Tier 0 found
 * no DOM evidence, Tier 1 rendered reads through the validating proxy. A
 * successful render clears the need; an unavailable one leaves the Tier 0
 * verdict (plus its gap) standing — never papered over as sufficiency.
 */
function renderVerdictOf(
  domSignals: Tier0AnalysisResult['domSignals'],
  renderedCount: number,
): { required: boolean; rendered: boolean; reason: string } {
  const domEvidence = domSignals.title || domSignals.meta || domSignals.jsonLd || domSignals.images;
  const rendered = renderedCount > 0;
  return { required: !domEvidence && !rendered, rendered, reason: renderedReasonString(domEvidence, rendered) };
}

function renderedReasonString(staticEvidence: boolean, renderedEvidence: boolean): string {
  if (renderedEvidence) {
    return 'Tier 1 rendered investigation produced DOM evidence through the validating proxy; static reads alone were insufficient';
  }
  return domEvidenceString(staticEvidence);
}

function domEvidenceString(domEvidence: boolean): string {
  return domEvidence
    ? 'static broker-mediated read produced DOM evidence; per-field rendering need assessed at compile time'
    : 'static reads yielded no DOM evidence; a rendered browser may be required for this page';
}

function sanitizeRunId(runId: string): string {
  const cleaned = runId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  if (!cleaned) throw new InvestigationProviderError('provider_error', 'provider_error: invalid run identity');
  return cleaned;
}

/**
 * #246 explicit non-default switch for the Tier 1 render machinery.
 * Default (absent/false/any other value) defers: the render container is
 * never touched. `allowTier1Render: true` or
 * `BAYSTATE_INVESTIGATION_ALLOW_RENDER=1` opts diagnostics/tests into the
 * #237 machinery, which stays not production-valid until #237 lands.
 */
function isTier1RenderAllowed(deps: LocalHarnessDeps): boolean {
  if (deps.allowTier1Render === true) return true;
  return process.env.BAYSTATE_INVESTIGATION_ALLOW_RENDER === '1';
}

function truncateUrl(url: string): string {
  return url.length > 120 ? `${url.slice(0, 120)}…` : url;
}

function brokerFailureReason(err: unknown): string {
  if (err instanceof BrokerError) return err.message.slice(0, 200);
  if (err instanceof InvestigationBudgetError) return 'byte budget exhausted; download stopped';
  if (err instanceof InvestigationProviderError) return err.message.slice(0, 200);
  return 'read failed';
}
