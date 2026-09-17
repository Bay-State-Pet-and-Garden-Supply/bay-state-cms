// Constrained local browser-harness provider (T3).
//
// Investigation-only `local_browser_harness` implementation of the
// provider-neutral seam. It executes a fixed application-authored read plan
// over broker-mediated captures — bounded selector queries, attribute/meta
// reads, strict script-JSON parsing, captured network-response inspection,
// and own-property JSON-pointer reads — and returns a versioned UNTRUSTED
// typed result. There are no clicks, typing, form submissions, logins,
// carts, downloads, service workers, WebSockets, authentication/CAPTCHA
// workflows, or executable code paths anywhere in this module: the ONLY
// network call available is `broker.fetch` (pinned by the containment
// suite), and the grammar parser rejects everything else.
//
// Gating (all fail closed):
// - single local-investigation slot (serialized runs);
// - isolation available (explicit enablement + reachable Docker runtime);
// - monetary ceilings the harness cannot enforce (`maxCostUsd`);
// - container posture asserted before any read;
// - deterministic teardown on success, failure, timeout, and cancellation.

import * as cheerio from 'cheerio';
import type { InvestigationBudget } from '../../shared/schemas/browser-investigation';
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
import {
  INSPECTION_GRAMMAR_VERSION,
  GrammarError,
  capObservationText,
  certifyFieldAbsence,
  mintArtifactRef,
  mintElementRef,
  mintResponseRef,
  parseInspectionOp,
  parseScopedRef,
  assertRefScope,
  parseStrictScriptJson,
  readOwnJsonPointer,
  type InspectionOp,
  type ScriptJsonLimits,
} from './grammar';
import {
  assertContainerPosture,
  buildInvestigationContainerSpec,
  checkIsolationAvailable,
  containerNameForRun,
  releaseInvestigationSlot,
  tryAcquireInvestigationSlot,
  withIsolatedRun,
  type ContainerRunner,
  type IsolationProbe,
} from './isolation';

export interface LocalHarnessDeps {
  isolationProbe?: IsolationProbe;
  brokerDeps?: BrokerDeps;
  containerRunner?: ContainerRunner;
  clock?: () => number;
}

interface HarnessObservation {
  kind: string;
  sourceUrl: string;
  artifactHash: string;
  detail?: string;
  incomplete: boolean;
  artifactRef: string;
}

/** DOM evidence signals: what the static reads actually found (drives the rendering-need flag). */
interface DomEvidenceSignals {
  title: boolean;
  meta: boolean;
  jsonLd: boolean;
  images: boolean;
}

/** One indexed DOM element: text plus attributes, resolved via opaque ref. */
interface IndexedElement {
  text: string;
  attrs: Record<string, string>;
}

/** Surface-reader context: the gate, the element table, and the observation writer travel together. */
interface SurfaceReader {
  $: cheerio.CheerioAPI;
  push: (kind: string, detail: string) => void;
  exec: <T extends InspectionOp['op']>(kind: T, raw: unknown) => Extract<InspectionOp, { op: T }>;
  mintEl: (index: number, text: string, attrs: Record<string, string>) => string;
  resolveEl: (ref: string) => IndexedElement;
}

/** Per-page capture context threaded through the grammar-gated read plan. */
interface CaptureArgs {
  budget: InvestigationBudget;
  investigationId: string;
  pageIndex: number;
  body: Buffer;
  contentType: string;
  pageUrl: string;
  artifactHash: string;
  artifactRef: string;
  responseRef: string;
  observations: HarnessObservation[];
  gaps: string[];
  platformSignals: Set<string>;
  domSignals: DomEvidenceSignals;
  chargeRead: () => void;
}

/** Observation writer: caps detail at the per-operation budget, marking clips incomplete. */
function makeObservationPusher(args: CaptureArgs): (kind: string, detail: string) => void {
  return (kind: string, detail: string): void => {
    const capped = capObservationText(detail, args.budget.maxObservationBytesPerOperation);
    args.observations.push({
      kind,
      sourceUrl: args.pageUrl,
      artifactHash: args.artifactHash,
      ...(capped.text ? { detail: capped.text } : {}),
      incomplete: capped.clipped,
      artifactRef: args.artifactRef,
    });
  };
}

/** Parse an opaque ref and bind it to the running investigation (fail closed). */
function scopedRef(rawRef: string, investigationId: string): void {
  assertRefScope(parseScopedRef(rawRef), investigationId);
}

/**
 * Bound a parsed selector query to the investigation caps: over-length
 * selectors fail closed, and match counts clamp to the budget maximum.
 */
function boundSelectorQuery(
  selector: string,
  requestedMaxMatches: number,
  budget: InvestigationBudget,
): { selector: string; maxMatches: number } {
  if (selector.length > budget.maxSelectorLength) {
    throw new GrammarError('invalid_params', 'selector exceeds investigation length cap');
  }
  return { selector, maxMatches: Math.min(requestedMaxMatches, budget.maxSelectorMatches) };
}

const DEFAULT_CONTAINER_RUNNER: ContainerRunner = {
  async teardown(runId: string): Promise<void> {
    // The investigation browser container is `--rm` (always-remove); the
    // daemon reaps it. Best-effort explicit removal of the same deterministic
    // name for the fresh-state guarantee (idempotent: missing names are fine).
    try {
      const bun = (globalThis as { Bun?: { spawn: (cmd: string[], opts?: unknown) => { exited: Promise<unknown> } } }).Bun;
      if (!bun) return;
      await bun.spawn(['docker', 'rm', '-f', containerNameForRun(runId)], {
        stdout: 'ignore',
        stderr: 'ignore',
      }).exited;
    } catch {
      // Idempotent best-effort; never masks the run outcome.
    }
  },
};

export class LocalBrowserHarnessProvider implements InvestigationProvider {
  readonly id = 'local_browser_harness' as const;

  constructor(private readonly deps: LocalHarnessDeps = {}) {}

  async invoke(request: InvestigationProviderRequest): Promise<InvestigationProviderCompletion> {
    if (!tryAcquireInvestigationSlot()) {
      throw new InvestigationProviderError('provider_error', 'provider_error: another local investigation is running');
    }
    try {
      return await withIsolatedRun(
        request.runId,
        this.deps.containerRunner ?? DEFAULT_CONTAINER_RUNNER,
        () => this.runScoped(request),
      );
    } finally {
      releaseInvestigationSlot();
    }
  }

  private async runScoped(request: InvestigationProviderRequest): Promise<InvestigationProviderCompletion> {
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

    // Posture asserted before any read: a spec deviation fails the run here.
    assertContainerPosture(buildInvestigationContainerSpec(sanitizeRunId(request.runId)));

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

    const reads = await this.readSamplePages(request, pages, broker, artifacts, assertLive);
    if (reads.observations.length === 0) {
      throw new InvestigationProviderError('provider_error', 'provider_error: no observations captured within budget');
    }
    return this.assembleCompletion(request, pages, ledger, elapsed(), reads);
  }

  /** Assemble the untrusted typed result + usage from the completed reads. */
  private assembleCompletion(
    request: InvestigationProviderRequest,
    pages: string[],
    ledger: BudgetLedger,
    elapsedMs: number,
    reads: {
      observations: HarnessObservation[];
      evidenceRefs: string[];
      gaps: string[];
      platformSignals: Set<string>;
      domSignals: DomEvidenceSignals;
      readsPerformed: number;
    },
  ): InvestigationProviderCompletion {
    const { observations, evidenceRefs, gaps, platformSignals, domSignals, readsPerformed } = reads;
    const platform = platformSignals.has('shopify') ? 'shopify' : undefined;
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
      renderedBrowserReason: domEvidence
        ? 'static broker-mediated read produced DOM evidence; per-field rendering need assessed at compile time'
        : 'static reads yielded no DOM evidence; a rendered browser may be required for this page',
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

  /** Bounded read over every sample page: broker fetch, artifact retain, grammar reads. */
  private async readSamplePages(
    request: InvestigationProviderRequest,
    pages: string[],
    broker: InvestigationBroker,
    artifacts: ReturnType<typeof createArtifactStore>,
    assertLive: () => void,
  ): Promise<{
    observations: HarnessObservation[];
    evidenceRefs: string[];
    gaps: string[];
    platformSignals: Set<string>;
    domSignals: DomEvidenceSignals;
    readsPerformed: number;
  }> {
    const observations: HarnessObservation[] = [];
    const evidenceRefs: string[] = [];
    const gaps: string[] = [];
    const platformSignals = new Set<string>();
    const domSignals: DomEvidenceSignals = { title: false, meta: false, jsonLd: false, images: false };
    let readsPerformed = 0;
    const chargeRead = (): void => {
      readsPerformed += 1;
      if (readsPerformed > request.budget.maxReads) {
        throw new InvestigationBudgetError(`reads would exceed maxReads ${request.budget.maxReads}`);
      }
    };
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      assertLive();
      const pageUrl = pages[pageIndex]!;
      const captured = await this.capturePage(request, broker, artifacts, pageUrl, pageIndex, evidenceRefs, gaps);
      if (!captured) continue;
      try {
        this.readCapture({
          budget: request.budget,
          investigationId: request.investigationId,
          pageIndex,
          body: captured.body,
          contentType: captured.contentType,
          pageUrl: captured.finalUrl,
          artifactHash: captured.artifactHash,
          artifactRef: captured.artifactRef,
          responseRef: captured.responseRef,
          observations,
          gaps,
          platformSignals,
          domSignals,
          chargeRead,
        });
      } catch (err) {
        if (err instanceof InvestigationBudgetError) {
          throw new InvestigationProviderError('budget_exhausted', err.message);
        }
        gaps.push(`page ${pageIndex + 1} (${truncateUrl(pageUrl)}): read failed (${readFailureReason(err)})`);
      }
    }
    return { observations, evidenceRefs, gaps, platformSignals, domSignals, readsPerformed };
  }

  /** One broker-mediated capture + artifact retain. Null on denied/failed pages (gap recorded). */
  private async capturePage(
    request: InvestigationProviderRequest,
    broker: InvestigationBroker,
    artifacts: ReturnType<typeof createArtifactStore>,
    pageUrl: string,
    pageIndex: number,
    evidenceRefs: string[],
    gaps: string[],
  ): Promise<{
    body: Buffer;
    contentType: string;
    finalUrl: string;
    artifactHash: string;
    artifactRef: string;
    responseRef: string;
  } | null> {
    try {
      const res = await broker.fetch(pageUrl);
      const artifact = artifacts.retain(res.body, { contentType: res.contentType, sourceUrl: res.finalUrl });
      const artifactRef = mintArtifactRef(request.investigationId, `p${pageIndex}`);
      evidenceRefs.push(artifactRef);
      return {
        body: res.body,
        contentType: res.contentType,
        finalUrl: res.finalUrl,
        artifactHash: artifact.sha256,
        artifactRef,
        responseRef: mintResponseRef(request.investigationId, `p${pageIndex}`),
      };
    } catch (err) {
      gaps.push(`page ${pageIndex + 1} (${truncateUrl(pageUrl)}): ${brokerFailureReason(err)}`);
      return null;
    }
  }

  /**
   * Fixed application-authored read plan, executed THROUGH the declarative
   * grammar gate: every read below is constructed as a grammar op literal,
   * parsed by `parseInspectionOp` (unknown ops/params fail closed), charged
   * against the read budget, and executed by the bounded dispatcher. The
   * grammar is the gate, not documentation: lowered budget caps tighten op
   * bounds here, and any op the gate rejects becomes a gap, never a bypass.
   */
  private readCapture(args: CaptureArgs): void {
    const { budget, body, contentType, pageUrl, artifactHash, responseRef } = args;
    const push = makeObservationPusher(args);
    const exec = <T extends InspectionOp['op']>(kind: T, raw: unknown): Extract<InspectionOp, { op: T }> =>
      this.execOp(args, raw, kind);

    // inspect_network_response: bounded sanitized projection of the
    // already-captured broker-approved response. Scope-bound: a foreign or
    // stale response ref fails closed and the page is skipped as a gap.
    try {
      const netOp = exec('inspect_network_response', {
        version: INSPECTION_GRAMMAR_VERSION,
        op: 'inspect_network_response',
        responseRef,
        maxBytes: Math.min(32 * 1024, budget.maxObservationBytesPerOperation),
      });
      scopedRef(netOp.responseRef, args.investigationId);
    } catch {
      args.gaps.push(`page (${truncateUrl(pageUrl)}): stale response reference; capture discarded`);
      return;
    }
    push(
      'network_response',
      `captured ${contentType} (${body.length} B, sha256 ${artifactHash}); projection is metadata only, never raw body bypass`,
    );

    const base = contentType.split(';')[0]!.trim().toLowerCase();
    if (base === 'application/json' || base === 'application/ld+json') {
      this.readJsonCapture(args, push, exec);
      return;
    }
    if (!base.startsWith('text/html') && base !== 'application/xhtml+xml') {
      push('network_body', `captured ${base} response (${body.length} B); DOM inspection not applicable`);
      return;
    }
    this.readHtmlCapture(args, push, exec);
  }

  /**
   * Parse one fixed-plan op through the grammar gate and charge the read
   * budget. Returns the narrowed op: the gate's bounds (not the caller's
   * wishes) flow into execution.
   */
  private execOp<T extends InspectionOp['op']>(args: CaptureArgs, raw: unknown, kind: T): Extract<InspectionOp, { op: T }> {
    const parsed = parseInspectionOp(raw);
    if (parsed.op !== kind) {
      throw new GrammarError('invalid_params', 'fixed-plan op mismatch');
    }
    args.chargeRead();
    return parsed as Extract<InspectionOp, { op: T }>;
  }

  /**
   * Execute a bounded `query_selector_all` through the gate and index the
   * matches as opaque element refs (text plus attributes). Shared by every
   * DOM surface so selector bounds (length + match count) are enforced once,
   * in one place. Element types flow from cheerio's own signatures.
   */
  private selectElements(
    args: CaptureArgs,
    reader: SurfaceReader,
    baseIndex: number,
    selector: string,
    requestedMax: number,
  ): string[] {
    const { $, exec, mintEl } = reader;
    const qOp = exec('query_selector_all', {
      version: INSPECTION_GRAMMAR_VERSION,
      op: 'query_selector_all',
      pageRef: args.artifactRef,
      selector,
      maxMatches: Math.min(requestedMax, args.budget.maxSelectorMatches),
    });
    scopedRef(qOp.pageRef, args.investigationId);
    const bounded = boundSelectorQuery(qOp.selector, qOp.maxMatches, args.budget);
    const refs: string[] = [];
    $(bounded.selector).slice(0, bounded.maxMatches).each((i, el) => {
      const attribs = (el as unknown as { attribs?: Record<string, string> }).attribs ?? {};
      refs.push(mintEl(baseIndex + i, $(el).text(), { ...attribs }));
      return undefined;
    });
    return refs;
  }

  /** Captured-JSON path: own-property pointer read over the response value. */
  private readJsonCapture(
    args: CaptureArgs,
    push: (kind: string, detail: string) => void,
    exec: <T extends InspectionOp['op']>(kind: T, raw: unknown) => Extract<InspectionOp, { op: T }>,
  ): void {
    const { budget, investigationId, body } = args;
    const ptrOp = exec('read_json_pointer', {
      version: INSPECTION_GRAMMAR_VERSION,
      op: 'read_json_pointer',
      valueRef: args.responseRef,
      pointer: ['root'],
    });
    scopedRef(ptrOp.valueRef, investigationId);
    if (ptrOp.pointer.length > budget.maxJsonPointerDepth) {
      throw new GrammarError('invalid_params', 'pointer exceeds investigation depth cap');
    }
    const limits: ScriptJsonLimits = {
      maxBytes: budget.maxResponseBytesPerResponse,
      maxDepth: Math.min(budget.maxJsonPointerDepth, 32),
      maxNodes: budget.maxJsonNodesVisited,
    };
    const parsed = parseStrictScriptJson(body.toString('utf8'), limits);
    const projected = readOwnJsonPointer({ root: parsed.value }, ptrOp.pointer);
    void projected;
    push('network_json', `captured JSON response (${body.length} B, ${parsed.nodeCount} nodes)`);
  }

  /** Static-DOM path: bounded selector/meta/script/attribute reads over the capture. */
  private readHtmlCapture(
    args: CaptureArgs,
    push: (kind: string, detail: string) => void,
    exec: <T extends InspectionOp['op']>(kind: T, raw: unknown) => Extract<InspectionOp, { op: T }>,
  ): void {
    const { body, pageUrl, artifactHash, artifactRef, observations, gaps, platformSignals } = args;
    const html = body.toString('utf8');
    detectPlatformSignals(html, platformSignals);
    const $ = cheerio.load(html);
    const elements = new Map<string, IndexedElement>();
    const mintEl = (index: number, text: string, attrs: Record<string, string>): string => {
      const ref = mintElementRef(args.investigationId, args.pageIndex, index);
      elements.set(ref, { text, attrs });
      return ref;
    };
    const resolveEl = (ref: string): IndexedElement => {
      scopedRef(ref, args.investigationId);
      const found = elements.get(ref);
      if (!found) throw new GrammarError('invalid_params', 'unknown element reference');
      return found;
    };
    const reader: SurfaceReader = { $, push, exec, mintEl, resolveEl };

    // query_selector_all(title): bounded selector query, text only.
    const titleRefs = this.selectElements(args, reader, 0, 'title', 1);
    const titleText = titleRefs.length > 0 ? resolveEl(titleRefs[0]!).text.trim() : '';
    if (titleText) {
      args.domSignals.title = true;
      push('page_title', `title: ${titleText}`);
    } else {
      // Absence is certifiable only when nothing was clipped.
      try {
        certifyFieldAbsence(observations.filter((o) => o.sourceUrl === pageUrl));
        gaps.push('title not observed in captured document');
      } catch {
        gaps.push('title observation incomplete; absence uncertifiable within budget');
      }
    }

    // read_meta: bounded meta/link reads — observations, never trust grants.
    const mOp = exec('read_meta', {
      version: INSPECTION_GRAMMAR_VERSION,
      op: 'read_meta',
      pageRef: artifactRef,
      maxEntries: 100,
    });
    scopedRef(mOp.pageRef, args.investigationId);
    const metas: string[] = [];
    $(`meta[name], meta[property]`).slice(0, mOp.maxEntries).each((_i, el) => {
      // No pre-truncation: the observation byte cap is the single truncation
      // point, and it marks clipped output incomplete.
      const name = $(el).attr('name') ?? $(el).attr('property') ?? '';
      const content = $(el).attr('content') ?? '';
      if (name) metas.push(`${name}=${content}`);
      return undefined;
    });
    if (metas.length > 0) args.domSignals.meta = true;
    const cappedMeta = capObservationText(metas.join('\n'), args.budget.maxObservationBytesPerOperation);
    observations.push({
      kind: 'page_meta',
      sourceUrl: pageUrl,
      artifactHash,
      ...(cappedMeta.text ? { detail: cappedMeta.text } : {}),
      incomplete: cappedMeta.clipped,
      artifactRef,
    });

    this.readScriptSurface(args, reader);
    this.readImageSurface(args, reader);
  }

  /** read_script_json over indexed ld+json blocks: strict parse only, never evaluated. */
  private readScriptSurface(args: CaptureArgs, reader: SurfaceReader): void {
    const { budget } = args;
    const { $, push, exec, mintEl, resolveEl } = reader;
    const blocks = $(`script[type="application/ld+json"]`);
    const MAX_SCRIPT_BLOCKS = 20;
    if (blocks.length > MAX_SCRIPT_BLOCKS) {
      args.gaps.push(`only the first ${MAX_SCRIPT_BLOCKS} JSON-LD blocks examined within budget`);
    }
    blocks.slice(0, MAX_SCRIPT_BLOCKS).each((i, el) => {
      const ref = mintEl(1000 + i, $(el).html() ?? '', {});
      const sOp = exec('read_script_json', {
        version: INSPECTION_GRAMMAR_VERSION,
        op: 'read_script_json',
        elementRef: ref,
        maxNodes: budget.maxJsonNodesVisited,
        maxDepth: budget.maxJsonPointerDepth,
      });
      const entry = resolveEl(sOp.elementRef);
      try {
        const parsed = parseStrictScriptJson(entry.text, {
          maxBytes: budget.maxResponseBytesPerResponse,
          maxDepth: Math.min(sOp.maxDepth, budget.maxJsonPointerDepth),
          maxNodes: Math.min(sOp.maxNodes, budget.maxJsonNodesVisited),
        });
        args.domSignals.jsonLd = true;
        push('page_json_ld', `JSON-LD block (${parsed.nodeCount} nodes): ${entry.text}`);
      } catch {
        args.gaps.push('a JSON-LD block was not strict JSON or exceeded bounds; skipped without evaluation');
      }
      return undefined;
    });
  }

  /** query_selector_all + read_attribute over the image surface; URLs stay untrusted text. */
  private readImageSurface(args: CaptureArgs, reader: SurfaceReader): void {
    const { push, exec, resolveEl } = reader;
    const imgRefs = this.selectElements(args, reader, 2000, 'img[src]', 20);
    let withSrc = 0;
    for (const ref of imgRefs) {
      // read_attribute returns the URL as text only: a discovered URL gains
      // no fetch permission (the broker scope alone authorizes fetches).
      const aOp = exec('read_attribute', {
        version: INSPECTION_GRAMMAR_VERSION,
        op: 'read_attribute',
        elementRef: ref,
        attribute: 'src',
      });
      const entry = resolveEl(aOp.elementRef);
      if ((entry.attrs[aOp.attribute] ?? '').trim()) withSrc += 1;
    }
    if (imgRefs.length > 0) args.domSignals.images = true;
    push(
      'page_images',
      `image elements observed: ${imgRefs.length} (${withSrc} with sources; URLs untrusted; membership uncertified from this read)`,
    );
  }

  private fieldRecommendations(
    observations: HarnessObservation[],
    evidenceRefs: string[],
  ): Array<{ field: string; sources: string[]; structureId: string; evidenceRef?: string }> {
    const has = (kind: string): HarnessObservation | undefined =>
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

function detectPlatformSignals(html: string, signals: Set<string>): void {
  const lowered = html.slice(0, 200_000).toLowerCase();
  if (
    lowered.includes('cdn.shopify.com') ||
    lowered.includes('shopify.shop') ||
    lowered.includes('__shopify__') ||
    lowered.includes('shopify.checkout')
  ) {
    signals.add('shopify');
  }
  if (lowered.includes('woocommerce')) signals.add('woocommerce');
  if (lowered.includes('__next_data__') || lowered.includes('__next_f')) signals.add('nextjs');
  if (lowered.includes('__nuxt__')) signals.add('nuxt');
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

function readFailureReason(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}
