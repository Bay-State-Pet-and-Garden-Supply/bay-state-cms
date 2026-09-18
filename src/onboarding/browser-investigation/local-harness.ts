// Constrained local browser-harness provider (T3, containerized in #236).
//
// Investigation-only `local_browser_harness` implementation of the
// provider-neutral seam. It runs a fixed application-authored read plan as
// host-side broker fetch plus in-container analysis:
//
// - the host performs ONLY broker-mediated captures (bounded GET over
//   approved hosts) and artifact retention (hashing);
// - the Tier 0 analyzer executes INSIDE the investigation container built
//   from the posture-spec argv, reading captures on stdin and returning
//   typed observations on stdout;
// - the host assembles the versioned UNTRUSTED typed result from those
//   observations and never parses page bytes itself (no DOM library here).
//
// The container launches zero fetches of its own: every page byte it sees
// arrived as a broker-approved capture. Missing or unavailable isolation —
// including a runner that cannot execute analysis — fails closed with
// `isolation_unavailable` and never falls back to host-side analysis.
//
// Gating (all fail closed):
// - single local-investigation slot (serialized runs);
// - isolation available (explicit enablement + reachable Docker runtime);
// - monetary ceilings the harness cannot enforce (`maxCostUsd`);
// - container posture asserted before any read, image verified at start;
// - deterministic teardown on success, failure, timeout, and cancellation.

import { INVESTIGATION_RESULT_VERSION } from '../../shared/schemas/browser-investigation';
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
  type Tier0AnalysisResult,
  type Tier0ContainerRunner,
} from './container-runner';

export interface LocalHarnessDeps {
  isolationProbe?: IsolationProbe;
  brokerDeps?: BrokerDeps;
  containerRunner?: Tier0ContainerRunner;
  clock?: () => number;
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
    const analysis = await this.analyzeInContainer(runner, spec, request, captured.captures, elapsed);
    if (analysis.observations.length === 0) {
      throw new InvestigationProviderError('provider_error', 'provider_error: no observations captured within budget');
    }
    return this.assembleCompletion(request, pages, ledger, elapsed(), captured, analysis);
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
    const remaining = Math.max(1, request.budget.timeoutMs - elapsed());
    try {
      return await runner.runAnalysis(
        spec,
        {
          investigationId: request.investigationId,
          budget: tier0BudgetCapsOf(request.budget),
          captures,
        },
        { timeoutMs: remaining },
      );
    } catch (err) {
      throw this.mapRunnerError(err);
    }
  }

  private mapRunnerError(err: unknown): InvestigationProviderError {
    if (err instanceof InvestigationProviderError) return err;
    if (err instanceof ContainerRunnerError) {
      return new InvestigationProviderError(err.code, err.message);
    }
    if (err instanceof Error) return new InvestigationProviderError('provider_error', err.message.slice(0, 500));
    return new InvestigationProviderError('provider_error', String(err).slice(0, 500));
  }

  /** Assemble the untrusted typed result + usage from the container analysis. */
  private assembleCompletion(
    request: InvestigationProviderRequest,
    pages: string[],
    ledger: BudgetLedger,
    elapsedMs: number,
    captured: { evidenceRefs: string[]; gaps: string[] },
    analysis: Tier0AnalysisResult,
  ): InvestigationProviderCompletion {
    const { evidenceRefs, gaps: captureGaps } = captured;
    const { observations, gaps: analysisGaps, platformSignals, domSignals, readsPerformed } = analysis;
    const gaps = [...captureGaps, ...analysisGaps];
    const platform = platformSignals.includes('shopify') ? 'shopify' : undefined;
    // This slice performs static broker-mediated reads only (no browser
    // rendering process). When fetched pages yield no DOM evidence, that is
    // reported as a rendering need — not papered over as sufficiency.
    const domEvidence = domSignals.title || domSignals.meta || domSignals.jsonLd || domSignals.images;
    const result = {
      version: INVESTIGATION_RESULT_VERSION,
      summary: `Local harness investigation of ${request.domain} (${request.mode}): ${observations.length} observations from ${pages.length} pages via static broker-mediated reads (no browser rendering in this slice). Untrusted proposal evidence only.`,
      observations: observations.map(({ artifactRef: _ref, ...rest }) => rest),
      evidenceRefs,
      gaps,
      renderedBrowserRequired: !domEvidence,
      renderedBrowserReason: domEvidenceString(domEvidence),
      ...(platform ? { platform } : {}),
      structures: [
        {
          id: 'harness-static-read',
          sampleUrls: pages,
          description: 'Single static-read structure (broker-mediated GET, no interaction).',
          ...(platform === 'shopify' ? { platformSource: 'shopify_product_json' } : {}),
        },
      ],
      fieldRecommendations: this.fieldRecommendations(observations, evidenceRefs),
      identityRequirements: {
        productIdentity: [],
        variantIdentity: [],
        optionAxes: [],
      },
    };
    const ledgerUsage = ledger.toUsage();
    return {
      investigationId: request.investigationId,
      runId: request.runId,
      provider: this.id,
      inputHash: request.inputHash,
      result,
      usage: {
        ...ledgerUsage,
        modelCalls: 0,
        pagesVisited: pages.length,
        readsPerformed,
        durationMs: elapsedMs,
        costUsd: null,
        costBasis: 'unavailable',
      },
      actualModel: { provider: 'local_browser_harness', model: 'app-authored-read-plan-v1' },
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

  private fieldRecommendations(
    observations: Array<{ kind: string; incomplete: boolean }>,
    evidenceRefs: string[],
  ): Array<{ field: string; sources: string[]; structureId: string; evidenceRef?: string }> {
    const has = (kind: string): { kind: string; incomplete: boolean } | undefined =>
      observations.find((o) => o.kind === kind && !o.incomplete);
    const ref = evidenceRefs[0];
    const out: Array<{ field: string; sources: string[]; structureId: string; evidenceRef?: string }> = [];
    if (has('page_title')) {
      out.push({ field: 'title', sources: ['meta', 'selector'], structureId: 'harness-static-read', ...(ref ? { evidenceRef: ref } : {}) });
    }
    if (has('page_meta')) {
      out.push({ field: 'description', sources: ['meta'], structureId: 'harness-static-read', ...(ref ? { evidenceRef: ref } : {}) });
    }
    if (has('page_images')) {
      out.push({ field: 'images', sources: ['selector'], structureId: 'harness-static-read', ...(ref ? { evidenceRef: ref } : {}) });
    }
    if (has('page_json_ld')) {
      out.push({ field: 'brand', sources: ['json_ld', 'meta'], structureId: 'harness-static-read', ...(ref ? { evidenceRef: ref } : {}) });
    }
    return out;
  }
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

function truncateUrl(url: string): string {
  return url.length > 120 ? `${url.slice(0, 120)}…` : url;
}

function brokerFailureReason(err: unknown): string {
  if (err instanceof BrokerError) return err.message.slice(0, 200);
  if (err instanceof InvestigationBudgetError) return 'byte budget exhausted; download stopped';
  if (err instanceof InvestigationProviderError) return err.message.slice(0, 200);
  return 'read failed';
}
