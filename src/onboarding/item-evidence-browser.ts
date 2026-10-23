import { runPaidEffect } from '../ai/paid-effect-budget';
import type { PaidEffectAttemptDescriptor } from '../shared/schemas/paid-effect';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { classifyIp } from '../shared/ssrf';
import type { InvestigationBudget } from '../shared/schemas/browser-investigation';
import { startRenderProxy, type RunningRenderProxy } from './browser-investigation/render-proxy';
import type { BudgetLedger } from './browser-investigation/budgets';
import {
  buildRenderContainerSpec,
  RENDER_CONTAINER_NETWORK,
} from './browser-investigation/isolation';
import {
  DockerRenderContainerRunner,
  RenderRunnerError,
  type Tier1RenderedObservation,
} from './browser-investigation/render-runner';

const execFileAsync = promisify(execFile);
export type ItemEvidenceBrowserActionKind = 'observe' | 'links' | 'variants' | 'accordion';

export interface ItemEvidenceBrowserCandidate {
  /** Caller-issued opaque ID; never an externally generated URL or selector. */
  id: string;
  url: string;
  /** Stable page hash from a prior complete observation. */
  pageId?: string;
  /** IDs enumerated for this page by a prior complete observation. */
  availableTargetIds?: readonly string[];
}

export interface ItemEvidenceBrowserAction {
  id: string;
  candidateId: string;
  kind: ItemEvidenceBrowserActionKind;
  /** Current enumerated action target: `accordion-N` or `variant-N-option-M`. */
  targetId?: string;
}

/** Cumulative caller-owned counters; caller may share these across item/batch runs. */
export interface ItemEvidenceBrowserResources {
  pages: number;
  actions: number;
  bytes: number;
  requestAttempts: number;
  redirects: number;
  responseBytesTransferred: number;
}

export interface ItemEvidenceBrowserInput {
  investigationId: string;
  workspaceId: string;
  candidates: readonly ItemEvidenceBrowserCandidate[];
  actions: readonly ItemEvidenceBrowserAction[];
  budget: InvestigationBudget;
  /** Shared item/batch budget ledger charged live by the validating broker. */
  ledger: BudgetLedger;
  resources: ItemEvidenceBrowserResources;
  signal?: AbortSignal;
  paidEffectDescriptor?: PaidEffectAttemptDescriptor;
  onDispatch?: () => void;
}

export interface ItemEvidenceBrowserObservation {
  pageId: string;
  availableTargetIds: string[];
  actionId: string;
  candidateId: string;
  sourceUrl: string;
  finalUrl: string;
  contentType: string;
  redirectChain: string[];
  authorityStatus: number;
  authorityContentType: string;
  authorityConnectedIp: string;
  authorityBodyHash: string;
  /** Complete content only. Oversized observations fail rather than silently clip. */
  content: string;
  artifactHash: string;
  complete: true;
}

export interface ItemEvidenceBrowserResult {
  observations: ItemEvidenceBrowserObservation[];
  usage: { pages: number; actions: number; bytes: number; requestAttempts: number; redirects: number; responseBytesTransferred: number };
}

export class ItemEvidenceBrowserError extends Error {
  readonly code: 'invalid_input' | 'budget_exhausted' | 'cancelled' | 'timeout' | 'isolation_unavailable' | 'unsupported_action' | 'provider_error' | 'contract_required';
  constructor(code: ItemEvidenceBrowserError['code'], message: string) {
    super(`${code}: ${message}`);
    this.name = 'ItemEvidenceBrowserError';
    this.code = code;
  }
}

async function ensureIsolatedRenderNetwork(): Promise<void> {
  const inspect = async (): Promise<void> => {
    const { stdout } = await execFileAsync('docker', [
      'network', 'inspect', '--format', '{{.Name}}|{{.Driver}}|{{.Internal}}', RENDER_CONTAINER_NETWORK,
    ], { timeout: 15_000 });
    if (stdout.trim() !== `${RENDER_CONTAINER_NETWORK}|bridge|true`) {
      throw new ItemEvidenceBrowserError('isolation_unavailable', 'render network is not an internal bridge network');
    }
  };
  try {
    await inspect();
  } catch (error) {
    if (error instanceof ItemEvidenceBrowserError) throw error;
    try {
      await execFileAsync('docker', ['network', 'create', '--internal', RENDER_CONTAINER_NETWORK], { timeout: 30_000 });
    } catch {
      // A concurrent creator is acceptable only if the exact internal posture verifies below.
    }
    try {
      await inspect();
    } catch {
      throw new ItemEvidenceBrowserError('isolation_unavailable', 'isolated render network is unavailable or has unsafe posture');
    }
  }
}

const ACTION_KINDS: readonly ItemEvidenceBrowserActionKind[] = ['observe', 'links', 'variants', 'accordion'];

function validateInput(input: ItemEvidenceBrowserInput): Map<string, ItemEvidenceBrowserCandidate> {
  if (!input.investigationId || !input.workspaceId || !input.candidates.length || !input.actions.length) {
    throw new ItemEvidenceBrowserError('invalid_input', 'candidate, action, investigation and workspace scope required');
  }
  if (input.signal?.aborted) throw new ItemEvidenceBrowserError('cancelled', 'cancelled before browser collection');
  const candidates = new Map<string, ItemEvidenceBrowserCandidate>();
  for (const candidate of input.candidates) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(candidate.id) || candidates.has(candidate.id)) {
      throw new ItemEvidenceBrowserError('invalid_input', 'candidate IDs must be unique opaque identifiers');
    }
    let url: URL;
    try { url = new URL(candidate.url); } catch { throw new ItemEvidenceBrowserError('invalid_input', 'candidate URL is invalid'); }
    const host = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash ||
      (url.port !== '' && url.port !== '80' && url.port !== '443')) {
      throw new ItemEvidenceBrowserError('invalid_input', 'candidate must be credential-free HTTP(S) on a standard port');
    }
    if (classifyIp(host) !== 'unknown' || host.includes(':') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      throw new ItemEvidenceBrowserError('invalid_input', 'candidate must use a public DNS hostname, not a literal or local name');
    }
    if (candidate.pageId !== undefined && !/^[a-f0-9]{64}$/.test(candidate.pageId)) {
      throw new ItemEvidenceBrowserError('invalid_input', 'current page ID is malformed');
    }
    if (candidate.availableTargetIds !== undefined &&
      (!candidate.pageId || new Set(candidate.availableTargetIds).size !== candidate.availableTargetIds.length ||
        candidate.availableTargetIds.some((id) => !/^(accordion-[0-9]{1,2}|variant-[0-9]{1,2}-option-[0-9]{1,2})$/.test(id)))) {
      throw new ItemEvidenceBrowserError('invalid_input', 'page action IDs must come from a complete current-page observation');
    }
    candidates.set(candidate.id, { ...candidate, url: url.toString() });
  }
  const actionIds = new Set<string>();
  const actionCountByCandidate = new Map<string, number>();
  const interactiveCandidates = new Set<string>();
  for (const action of input.actions) {
    const candidate = candidates.get(action.candidateId);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(action.id) || actionIds.has(action.id) ||
      !candidate || !ACTION_KINDS.includes(action.kind)) {
      throw new ItemEvidenceBrowserError('invalid_input', 'actions must be unique supplied IDs bound to supplied candidates and supported reads');
    }
    if (action.targetId !== undefined) {
      const validTarget = action.kind === 'accordion'
        ? /^accordion-[0-9]{1,3}$/.test(action.targetId)
        : action.kind === 'variants' && /^variant-[0-9]{1,3}-option-[0-9]{1,3}$/.test(action.targetId);
      if (!validTarget || !candidate.pageId || !/^[a-f0-9]{64}$/.test(candidate.pageId) ||
        !candidate.availableTargetIds?.includes(action.targetId)) {
        throw new ItemEvidenceBrowserError('invalid_input', 'interactive targets require a supplied current page ID and enumerated target ID');
      }
      if (interactiveCandidates.has(candidate.id)) {
        throw new ItemEvidenceBrowserError('invalid_input', 'only one stateful read action may target a page per collection');
      }
      interactiveCandidates.add(candidate.id);
    }
    actionIds.add(action.id);
    const count = (actionCountByCandidate.get(action.candidateId) ?? 0) + 1;
    if (count > 4) throw new ItemEvidenceBrowserError('invalid_input', 'at most four code-owned read actions are supported per candidate');
    actionCountByCandidate.set(action.candidateId, count);
  }
  const selectedCandidateIds = new Set(input.actions.map((action) => action.candidateId));
  if (input.resources.pages + selectedCandidateIds.size > input.budget.maxPages ||
    input.resources.actions + input.actions.length > input.budget.maxReads ||
    // Each rendered page consumes one navigation read and one extraction read in the worker.
    selectedCandidateIds.size * 2 > input.budget.maxReads ||
    input.resources.requestAttempts > input.budget.maxRequestAttempts ||
    input.resources.responseBytesTransferred > input.budget.maxTotalResponseBytesTransferred ||
    input.resources.redirects > input.budget.maxRequestAttempts ||
    input.resources.bytes + input.actions.length * input.budget.maxObservationBytesPerOperation > input.budget.maxArtifactBytesTotal) {
    throw new ItemEvidenceBrowserError('budget_exhausted', 'caller-owned item/batch resource budget exhausted');
  }
  return candidates;
}

/** Collect code-owned read observations through the host validating proxy and isolated render container. */
export async function collectItemEvidenceBrowser(input: ItemEvidenceBrowserInput): Promise<ItemEvidenceBrowserResult> {
  const candidates = validateInput(input);
  if (!input.paidEffectDescriptor) {
    throw new ItemEvidenceBrowserError('contract_required', 'Browser render requires a verified billing contract; no unbounded session was started.');
  }
  const runner = new DockerRenderContainerRunner();
  const runId = `item-evidence-${randomUUID()}`;
  const ledgerBefore = input.ledger.snapshot();
  const reservedBytes = input.actions.length * input.budget.maxObservationBytesPerOperation;
  input.resources.bytes += reservedBytes;
  input.resources.pages += new Set(input.actions.map((action) => action.candidateId)).size;
  input.resources.actions += input.actions.length;
  let proxy: RunningRenderProxy;
  try {
    proxy = await startRenderProxy({
      investigationId: input.investigationId,
      workspaceId: input.workspaceId,
      sampleUrls: [...candidates.values()].map((candidate) => candidate.url),
      budget: input.budget,
      ledger: input.ledger,
      bindHost: '0.0.0.0',
      advertiseHost: 'host.docker.internal',
      signal: input.signal,
    });
  } catch (error) {
    const failedSnapshot = input.ledger.snapshot();
    input.resources.requestAttempts = failedSnapshot.requestAttempts;
    input.resources.redirects = failedSnapshot.redirects;
    input.resources.responseBytesTransferred = failedSnapshot.responseBytesTransferred;
    throw new ItemEvidenceBrowserError('isolation_unavailable', error instanceof Error ? error.message : 'validating proxy could not start');
  }
  let started = false;
  let result: ItemEvidenceBrowserResult | undefined;
  try {
    if (!proxy.mitmAvailable) throw new ItemEvidenceBrowserError('isolation_unavailable', 'validating HTTPS interception credential unavailable');
    await ensureIsolatedRenderNetwork();
    const spec = buildRenderContainerSpec(runId, proxy.url);
    const paidEffectDescriptor = input.paidEffectDescriptor;
    await runPaidEffect({
      descriptor: paidEffectDescriptor,
      signal: input.signal,
      execute: async signal => {
        if (signal.aborted) throw new ItemEvidenceBrowserError('cancelled', 'cancelled before isolated browser start');
        input.onDispatch?.();
        await runner.start(spec);
        started = true;
        return { value: undefined };
      },
    });
    if (input.signal?.aborted) throw new ItemEvidenceBrowserError('cancelled', 'cancelled before isolated browser start');
    const actionsByCandidate = new Map<string, ItemEvidenceBrowserAction[]>();
    for (const action of input.actions) actionsByCandidate.set(action.candidateId, [...(actionsByCandidate.get(action.candidateId) ?? []), action]);
    const selectedCandidates = [...candidates.values()].filter((candidate) => actionsByCandidate.has(candidate.id));
    const pages = selectedCandidates.map((candidate, pageIndex) => ({
      pageIndex,
      url: candidate.url,
      artifactRef: `item-evidence:${candidate.id}`,
      expectedPageId: candidate.pageId,
      actions: actionsByCandidate.get(candidate.id)!.map(({ id, kind, targetId }) => ({ id, kind, ...(targetId ? { targetId } : {}) })),
    }));
    const rendered = await runner.runRender(spec, {
      investigationId: input.investigationId,
      approvedHosts: [...new Set([...candidates.values()].map((candidate) => new URL(candidate.url).hostname.toLowerCase()))],
      pages,
      maxReads: input.budget.maxReads,
      maxObservationBytesPerOperation: input.budget.maxObservationBytesPerOperation,
    }, { timeoutMs: input.budget.timeoutMs, signal: input.signal });
    if (rendered.gaps.some((gap) => gap.includes('unsupported_action:'))) {
      throw new ItemEvidenceBrowserError('unsupported_action', 'the page does not expose the requested code-owned read action');
    }
    const candidateList = selectedCandidates;
    const actionById = new Map(input.actions.map((action) => [action.id, action]));
    const observations: ItemEvidenceBrowserObservation[] = [];
    const seenActionIds = new Set<string>();
    let bytesTotal = 0;
    const allowedHosts = new Set([...candidates.values()].map(({ url }) => new URL(url).hostname.toLowerCase()));
    const documentsByUrl = new Map<string, ReturnType<RunningRenderProxy['documentProvenance']>>();
    for (const document of proxy.documentProvenance()) {
      const requestUrl = new URL(document.requestUrl);
      requestUrl.hash = '';
      const key = requestUrl.toString();
      documentsByUrl.set(key, [...(documentsByUrl.get(key) ?? []), document]);
    }
    for (const raw of rendered.observations as Tier1RenderedObservation[]) {
      const action = raw.actionId ? actionById.get(raw.actionId) : undefined;
      if (!action || seenActionIds.has(action.id) || raw.actionKind !== action.kind) {
        throw new ItemEvidenceBrowserError('provider_error', 'isolated worker returned an unknown or duplicate action ID');
      }
      const candidate = candidateList[raw.pageIndex];
      if (!candidate || candidate.id !== action.candidateId) throw new ItemEvidenceBrowserError('provider_error', 'isolated worker action/candidate binding mismatch');
      if (candidate.url !== raw.sourceUrl) {
        throw new ItemEvidenceBrowserError('provider_error', 'isolated worker source URL does not match the selected candidate');
      }
      const requestedUrl = new URL(candidate.url);
      requestedUrl.hash = '';
      const documents = documentsByUrl.get(requestedUrl.toString()) ?? [];
      if (!documents.length || documents.some((document) =>
        document.finalUrl !== documents[0]!.finalUrl ||
        document.bodyHash !== documents[0]!.bodyHash ||
        JSON.stringify(document.redirectChain) !== JSON.stringify(documents[0]!.redirectChain))) {
        throw new ItemEvidenceBrowserError('provider_error', 'broker did not provide one unambiguous main-document provenance record');
      }
      const authority = documents[documents.length - 1]!;
      let finalUrl: URL;
      try { finalUrl = new URL(authority.finalUrl); } catch { throw new ItemEvidenceBrowserError('provider_error', 'broker returned an invalid final URL'); }
      const contentType = raw.contentType;
      const contentHash = typeof raw.content === 'string'
        ? createHash('sha256').update(raw.content, 'utf8').digest('hex')
        : '';
      const redirectChainValid = authority.redirectChain.length <= input.budget.maxRedirectHops &&
        authority.redirectChain.every((redirectUrl) => {
          try {
            const parsed = new URL(redirectUrl);
            return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password &&
              (parsed.port === '' || parsed.port === '80' || parsed.port === '443') &&
              allowedHosts.has(parsed.hostname.toLowerCase());
          } catch {
            return false;
          }
        });
      if (typeof raw.content !== 'string' ||
        (contentType !== 'text/plain' && contentType !== 'application/json') ||
        !/^[a-f0-9]{64}$/.test(raw.artifactHash ?? '') || raw.artifactHash !== contentHash ||
        typeof raw.pageId !== 'string' || !/^[a-f0-9]{64}$/.test(raw.pageId) ||
        !Array.isArray(raw.targetIds) || raw.targetIds.length > 100 || new Set(raw.targetIds).size !== raw.targetIds.length ||
        !raw.targetIds.every((id) => typeof id === 'string' &&
          /^(accordion-[0-9]{1,2}|variant-[0-9]{1,2}-option-[0-9]{1,2})$/.test(id)) ||
        (candidate.pageId && raw.pageId !== candidate.pageId) ||
        !/^[a-f0-9]{64}$/.test(authority.bodyHash) || !redirectChainValid ||
        !['http:', 'https:'].includes(finalUrl.protocol) || finalUrl.username || finalUrl.password ||
        (finalUrl.port !== '' && finalUrl.port !== '80' && finalUrl.port !== '443') ||
        !allowedHosts.has(finalUrl.hostname.toLowerCase())) {
        throw new ItemEvidenceBrowserError('provider_error', 'isolated worker returned an unknown or incomplete action observation');
      }
      seenActionIds.add(action.id);
      const bytes = Buffer.byteLength(raw.content, 'utf8');
      if (raw.incomplete || bytes > input.budget.maxObservationBytesPerOperation || bytesTotal + bytes > reservedBytes) {
        throw new ItemEvidenceBrowserError('budget_exhausted', 'complete observation exceeds caller-owned byte budget');
      }
      observations.push({
        pageId: raw.pageId,
        availableTargetIds: raw.targetIds,
        actionId: action.id,
        candidateId: candidate.id,
        sourceUrl: candidate.url,
        finalUrl: authority.finalUrl,
        contentType,
        redirectChain: [...authority.redirectChain],
        authorityStatus: authority.status,
        authorityContentType: authority.contentType,
        authorityConnectedIp: authority.connectedIp ?? '',
        authorityBodyHash: authority.bodyHash,
        content: raw.content,
        artifactHash: raw.artifactHash,
        complete: true,
      });
      bytesTotal += bytes;
    }
    if (observations.length !== input.actions.length) throw new ItemEvidenceBrowserError('provider_error', 'isolated worker omitted one or more requested action observations');
    input.resources.bytes -= reservedBytes - bytesTotal;
    result = { observations, usage: { pages: selectedCandidates.length, actions: input.actions.length, bytes: bytesTotal, requestAttempts: 0, redirects: 0, responseBytesTransferred: 0 } };
    return result;
  } catch (error) {
    if (input.signal?.aborted || error instanceof RenderRunnerError && error.code === 'cancelled') throw new ItemEvidenceBrowserError('cancelled', 'browser collection cancelled');
    if (error instanceof ItemEvidenceBrowserError) throw error;
    if (error instanceof RenderRunnerError && error.code === 'isolation_unavailable') throw new ItemEvidenceBrowserError('isolation_unavailable', error.message);
    if (error instanceof RenderRunnerError && error.code === 'budget_exhausted') throw new ItemEvidenceBrowserError('budget_exhausted', error.message);
    if (error instanceof RenderRunnerError && error.code === 'timeout') throw new ItemEvidenceBrowserError('timeout', error.message);
    throw new ItemEvidenceBrowserError('provider_error', error instanceof Error ? error.message : 'browser collection failed');
  } finally {
    try {
      await proxy.close();
    } finally {
      try {
        if (started) await runner.teardown(runId);
      } finally {
        const finalSnapshot = input.ledger.snapshot();
        input.resources.requestAttempts = finalSnapshot.requestAttempts;
        input.resources.redirects = finalSnapshot.redirects;
        input.resources.responseBytesTransferred = finalSnapshot.responseBytesTransferred;
        if (result) {
          result.usage.requestAttempts = finalSnapshot.requestAttempts - ledgerBefore.requestAttempts;
          result.usage.redirects = finalSnapshot.redirects - ledgerBefore.redirects;
          result.usage.responseBytesTransferred =
            finalSnapshot.responseBytesTransferred - ledgerBefore.responseBytesTransferred;
        }
      }
    }
  }
}
