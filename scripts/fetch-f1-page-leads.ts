/**
 * F1 MANUAL food page-lead fetch runner (G1 §4 + §10.4; Option A per
 * docs/audits/jev-batch3/f1-fetch-mechanism-decision.json).
 *
 * Main-owned sidecar (enrichment-runner precedent — NOT a collector edit, NOT a
 * collector bypass). Fetches the EXACT curated URLs in the immutable lead list
 * through the collector's own proof + gate seams and the shared window API:
 *
 *   proof/gates (imported, never re-implemented):
 *     candidateFromPageHtml + isExcludedProductUrl + loadPublicExclusion
 *     (+ canonicalProductUrlKey, isAllowedSourceUrl, normalizeDeniedHost)
 *   transport (fetchOnce-identical):
 *     5-hop same-site, per-hop reserve+record kind=page, denial set,
 *     manual redirect, 30s timeout.
 *
 * Contract (every bullet binding):
 *   - Exact curated URLs only; lead list immutable once fetching starts
 *     (lead-file SHA-256 recorded in every output).
 *   - Pre-fetch canonical exclusion gate costs ZERO attempts;
 *     post-redirect-alias gate burns hops already reserved (rev2 F4).
 *   - Pilot gate: 15-page-attempt pilot on the first domain; 0 proof-pass
 *     ⇒ PAUSE the whole F1 block + return to reviewer (exit 2).
 *   - Per-domain sub-cap 30 page attempts; pause a domain after 15
 *     consecutive failed page fetches; abandon a domain after 30 page
 *     attempts with 0 kept rows. Block abandonment is reviewer-called only.
 *   - F1 hard cap 120 attempts (clamped over --attempt-cap, never above).
 *   - Seal guard: --out must not be a symlink; refusing to overwrite any
 *     existing output file (wx); new dirs 0700, files 0600.
 *   - --dry-run is planning-only: validates the lead list + exclusion gates
 *     with ZERO fetching and ZERO window spend.
 *
 * NO-CAPTURE: fetching runs require --write (planning-only otherwise) and
 * reviewer code-review of THIS script before first fetch.
 *
 * Usage:
 *   bun scripts/fetch-f1-page-leads.ts --dry-run \
 *     [--leads docs/audits/jev-batch3/f1-page-leads.json] \
 *     [--exclude-bank <public-bank.json> ...] \
 *     [--source-window <dir> --owner-decisions <file>] [--attempt-cap <n>]
 *   bun scripts/fetch-f1-page-leads.ts --write \
 *     --source-window <WINDOW-DIR> --owner-decisions <owner-approved-decisions.json> \
 *     --out <NEW-EMPTY-DIR> \
 *     [--leads <file>] [--attempt-cap <n<=remaining, clamped to 120>] \
 *     [--exclude-bank <bank> ...] [--pilot-only] [--worker <name>]
 *     [--taxonomy <taxonomy.json> | --authority-hash <hex>]
 *
 * Exit codes: 0 completed/capped; 2 paused (pilot 0-pass ⇒ reviewer call);
 * 1 error (fail closed, nothing written on fetch runs).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import {
  buildPublicSourceReceipt,
  computeOwnerDecisionSha256,
  getSourceWindowUsage,
  openSourceWindow,
  parseInvocationCap,
  recordSourceOutcome,
  reserveSourceRequest,
  SOURCE_WINDOW_MAX,
  SourceWindowExhaustedError,
  type SourceWindowHandle,
} from './lib/source-request-window';
import {
  candidateFromPageHtml,
  canonicalProductUrlKey,
  deriveAuthorityHash,
  isAllowedSourceUrl,
  isExcludedProductUrl,
  loadPublicExclusion,
  normalizeDeniedHost,
  type Candidate,
  type Seed,
  type SourceExclusion,
} from './collect-jev-v3-sources';
import { JevSourceCandidateSchema } from '../src/shared/schemas/jev-benchmark';

const UA = 'BayStateCMS-JevBenchmark/1.0 (+research source collection; public pages only)';

/** F1 hard cap: ≤100 leads + ~20 redirect-hop headroom (G1 §4.1/§4.3). */
const F1_HARD_CAP = 120;
/** Max curated page leads (list size ≤100; fetches + hop headroom = 120). */
const MAX_LEADS = 100;
/** Pilot: page attempts on the first domain before the go/pause verdict. */
const PILOT_PAGE_ATTEMPTS = 15;
/** Per-domain sub-cap on page attempts (4 × 30 = 120). */
const DOMAIN_SUB_CAP = 30;
/** Pause a domain after this many consecutive failed page fetches. */
const DOMAIN_PAUSE_CONSEC_FAILS = 15;
/** Fetch hops per page URL (fetchOnce-identical). */
const MAX_HOPS = 5;
/** Per-hop timeout ms (fetchOnce-identical). */
const HOP_TIMEOUT_MS = 30000;

const DEFAULT_LEADS = 'docs/audits/jev-batch3/f1-page-leads.json';
/** Batch3/4 authority pin (Batch4-era manifests); override via --taxonomy. */
const DEFAULT_AUTHORITY_HASH = 'ff17dc313076c4657e87fa557ae7fa182796ddfcb53ce385f7525ebc03a33026';
/** G1 §4.7 chained exclusion: Batch3 p1/p3/m2/m8-public + Batch4 b4-7-public. */
const DEFAULT_STAGE_BANKS: string[] = [
  'docs/audits/jev-batch3/p1-public/source-development.json',
  'docs/audits/jev-batch3/p1-public/source-development-supplemental.json',
  'docs/audits/jev-batch3/p3-public/source-development.json',
  'docs/audits/jev-batch3/p3-public/source-development-supplemental.json',
  'docs/audits/jev-batch3/m2-public/source-development.json',
  'docs/audits/jev-batch3/m2-public/source-development-supplemental.json',
  'docs/audits/jev-batch3/m8-public/source-development.json',
  'docs/audits/jev-batch3/m8-public/source-development-supplemental.json',
  'docs/audits/jev-batch3/b4-7-public/source-development.json',
  'docs/audits/jev-batch3/b4-7-public/source-development-supplemental.json',
];

const OUT_CANDIDATES = 'f1-page-candidates.json';
const OUT_RECEIPTS = 'f1-page-receipts.json';
const OUT_MANIFEST = 'f1-run-manifest.json';

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
function argsAll(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === name && i + 1 < process.argv.length) out.push(process.argv[i + 1]);
  }
  return out;
}
const flags = (name: string): boolean => process.argv.includes(name);

function siteRoot(host: string): string {
  return host.replace(/^www\./i, '').toLowerCase();
}
function sameSite(a: string, b: string): boolean {
  try {
    return siteRoot(new URL(a).hostname) === siteRoot(new URL(b).hostname);
  } catch { return false; }
}

/** Curated page lead: intendedClass is intent-only, never binds adjudication. */
const LeadSchema = z.object({
  url: z.string().regex(/^https:\/\//, 'lead url must be an https URL'),
  domain: z.string().min(1).max(253),
  brand: z.string().min(1).max(200),
  productName: z.string().min(1).max(500),
  intendedClass: z.string().min(1).max(200),
  curatedAt: z.string().min(1).max(32),
}).passthrough();
type Lead = z.infer<typeof LeadSchema>;

/**
 * Load + validate the immutable lead list (zero cost, no fetch, no spend).
 * Rejects: >100 leads, duplicate canonical URL identity, https violations,
 * domain/URL-host mismatch (apex/www-insensitive).
 */
function parseLeadFile(leadsPath: string): { leads: Lead[]; leadSha256: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(leadsPath, 'utf-8');
  } catch (e) {
    throw new Error(`missing_leads_file: cannot read ${leadsPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const leadSha256 = crypto.createHash('sha256').update(raw).digest('hex');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`corrupt_leads_file: cannot parse ${leadsPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const leads = z.array(LeadSchema).min(1).max(MAX_LEADS).parse(parsed);
  const seen = new Set<string>();
  for (const [index, lead] of leads.entries()) {
    let host: string;
    try {
      host = new URL(lead.url).hostname;
    } catch {
      throw new Error(`invalid_lead_url: row ${index} has an unparseable url: ${lead.url}`);
    }
    if (siteRoot(host) !== siteRoot(lead.domain)) {
      throw new Error(`invalid_lead_domain: row ${index} domain "${lead.domain}" does not match url host "${host}"`);
    }
    if (!isAllowedSourceUrl(lead.url)) {
      throw new Error(`invalid_lead_url: row ${index} fails the public-source URL policy gate: ${lead.url}`);
    }
    const key = canonicalProductUrlKey(lead.url);
    if (key === null) throw new Error(`invalid_lead_url: row ${index} has no canonical identity: ${lead.url}`);
    if (seen.has(key)) throw new Error(`duplicate_lead_url: row ${index} re-curates an already-listed product identity: ${lead.url}`);
    seen.add(key);
  }
  return { leads, leadSha256 };
}


type FetchOutcome =
  | { kind: 'kept'; candidate: Candidate; seqs: number[]; finalUrl: string }
  | { kind: 'failed'; reason: string; seqs: number[] }
  | { kind: 'excluded-prefetch'; seqs: [] };

/**
 * One curated page URL: zero-cost pre-fetch exclusion gate → fetchOnce-identical
 * hop loop (kind=page, every hop reserve+record) → post-redirect-alias gate →
 * collector proof seam. Returns spent seqs so the caller ledgers per-URL cost.
 */
async function fetchLeadPage(
  window: SourceWindowHandle,
  lead: Lead,
  exclusion: SourceExclusion,
  worker: string | null,
  denied: Set<string>,
  spentSeqs: number[],
  cap: number,
  stats: Record<string, number>,
): Promise<FetchOutcome> {
  // Canonical pre-fetch admission gate: ZERO attempts (rev2 F4 semantics).
  if (isExcludedProductUrl(lead.url, exclusion)) {
    stats.excludedPriorUrl = (stats.excludedPriorUrl ?? 0) + 1;
    return { kind: 'excluded-prefetch', seqs: [] };
  }
  const seed: Seed = {
    domain: siteRoot(lead.domain),
    brand: lead.brand,
    stratum: 'food',
    sourceRule: 'F1 manual curation: exact curated official product page',
  };
  const seqs: number[] = [];
  let current = lead.url;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (spentSeqs.length >= cap) return { kind: 'failed', reason: 'invocation-cap-reached', seqs };
    // Gates run BEFORE reservation: refused hops spend nothing.
    if (!isAllowedSourceUrl(current)) return { kind: 'failed', reason: 'url-policy-refused', seqs };
    let host: string;
    try {
      host = new URL(current).hostname;
    } catch {
      return { kind: 'failed', reason: 'unparseable-url', seqs };
    }
    if (denied.has(normalizeDeniedHost(host))) return { kind: 'failed', reason: 'host-denied', seqs };
    let seq: number;
    try {
      const reservation = reserveSourceRequest(window, { url: current, kind: 'page', ...(worker ? { worker } : {}) });
      seq = reservation.seq;
    } catch (e) {
      if (e instanceof SourceWindowExhaustedError) return { kind: 'failed', reason: 'window-exhausted', seqs };
      throw e;
    }
    spentSeqs.push(seq);
    seqs.push(seq);
    let response: Response;
    try {
      response = await fetch(current, { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(HOP_TIMEOUT_MS) });
    } catch (e) {
      recordSourceOutcome(window, seq, { status: `fetch-error:${String(e).slice(0, 80)}`, bytes: 0 });
      return { kind: 'failed', reason: 'fetch-error', seqs };
    }
    if ([401, 403, 429, 451].includes(response.status)) {
      recordSourceOutcome(window, seq, { status: response.status, bytes: 0, error: 'host-denied' });
      denied.add(normalizeDeniedHost(host));
      return { kind: 'failed', reason: 'host-denied', seqs };
    }
    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers.get('location');
      if (!loc) {
        recordSourceOutcome(window, seq, { status: response.status, error: 'redirect-without-location' });
        return { kind: 'failed', reason: 'redirect-without-location', seqs };
      }
      const next = new URL(loc, current);
      recordSourceOutcome(window, seq, { status: response.status, ...(next.protocol === 'https:' ? { finalUrl: next.toString() } : {}), error: 'redirect-hop' });
      if (next.protocol !== 'https:' || !sameSite(next.toString(), current)) {
        return { kind: 'failed', reason: 'cross-site-redirect-refused', seqs };
      }
      current = next.toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      recordSourceOutcome(window, seq, { status: response.status, bytes: 0 });
      return { kind: 'failed', reason: `http-${response.status}`, seqs };
    }
    const html = await response.text();
    recordSourceOutcome(window, seq, { status: response.status, finalUrl: current, bytes: html.length });
    const finalUrl = current;
    // Redirect-alias gate: burns the hops already reserved (rev2 F4 semantics).
    if (isExcludedProductUrl(finalUrl, exclusion)) {
      stats.excludedPriorUrl = (stats.excludedPriorUrl ?? 0) + 1;
      return { kind: 'failed', reason: 'excluded-post-redirect-alias', seqs };
    }
    // Collector proof seam: exactly-one-Product JSON-LD + bodyText≥80 + excerpts.
    const candidate = candidateFromPageHtml(seed, lead.url, finalUrl, html, new Date().toISOString(), stats);
    if (!candidate) return { kind: 'failed', reason: 'identity-proof-failed', seqs };
    // Fail-closed row validation before the row is keepable (never sealed raw).
    try {
      JevSourceCandidateSchema.parse(candidate.row);
    } catch {
      stats.schemaInvalid = (stats.schemaInvalid ?? 0) + 1;
      return { kind: 'failed', reason: 'schema-invalid', seqs };
    }
    return { kind: 'kept', candidate, seqs, finalUrl };
  }
  return { kind: 'failed', reason: 'hop-limit-reached', seqs };
}

interface DomainState {
  domain: string;
  leads: Lead[];
  pageAttempts: number;
  proofPass: number;
  kept: number;
  consecFails: number;
  excludedPrefetch: number;
  spentHops: number;
  status: 'pending' | 'complete' | 'paused-proof-wall' | 'abandoned-zero-kept' | 'capped-sub-cap' | 'pilot-paused';
}

function resolveAuthorityHash(): { authorityHash: string; taxonomyPath: string | null; taxonomyFileHash: string | null } {
  const taxonomyPath = arg('--taxonomy');
  const override = arg('--authority-hash');
  if (taxonomyPath) {
    if (override) throw new Error('authority_conflict: pass exactly one of --taxonomy or --authority-hash');
    let raw: string;
    try {
      raw = fs.readFileSync(taxonomyPath, 'utf-8');
    } catch (e) {
      throw new Error(`unverifiable_taxonomy_authority: cannot read ${taxonomyPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return {
      authorityHash: deriveAuthorityHash(JSON.parse(raw)),
      taxonomyPath,
      taxonomyFileHash: crypto.createHash('sha256').update(raw).digest('hex'),
    };
  }
  return { authorityHash: override ?? DEFAULT_AUTHORITY_HASH, taxonomyPath: null, taxonomyFileHash: null };
}

async function main(): Promise<void> {
  const dryRun = flags('--dry-run');
  const write = flags('--write');
  const pilotOnly = flags('--pilot-only');
  const windowDir = arg('--source-window');
  const ownerDecisionsPath = arg('--owner-decisions');
  const outDir = arg('--out') ?? 'docs/audits/jev-batch3/f1-manual';
  const leadsPath = arg('--leads') ?? DEFAULT_LEADS;
  const attemptCapRaw = arg('--attempt-cap');
  const worker = arg('--worker');
  const extraBanks = argsAll('--exclude-bank');

  // Lead list + exclusion load are zero-cost: safe in every mode, including
  // --dry-run (no fetch, no reserve/record anywhere on the planning path).
  const { leads, leadSha256 } = parseLeadFile(leadsPath);
  const stageBanks = [...DEFAULT_STAGE_BANKS, ...extraBanks];
  const exclusion = loadPublicExclusion(stageBanks);

  // Zero-cost pre-fetch gate preview over the whole list (the exact gate the
  // fetch path applies per URL before any reservation).
  const gatePreview = leads.map((lead) => ({
    url: lead.url,
    domain: siteRoot(lead.domain),
    gate: isExcludedProductUrl(lead.url, exclusion) ? 'excluded-prior-url' : 'admitted-to-fetch',
  }));
  const gateExcluded = gatePreview.filter((g) => g.gate !== 'admitted-to-fetch').length;

  // Domain groups in first-seen lead order; the pilot runs on the first one.
  const domainOrder: string[] = [];
  const byDomain = new Map<string, Lead[]>();
  for (const lead of leads) {
    const d = siteRoot(lead.domain);
    if (!byDomain.has(d)) {
      byDomain.set(d, []);
      domainOrder.push(d);
    }
    byDomain.get(d)!.push(lead);
  }

  const { authorityHash, taxonomyPath, taxonomyFileHash } = resolveAuthorityHash();

  if (dryRun || !write) {
    // Planning only: no HTTP requests, no window spend. When window flags are
    // present the window is opened read-only (usage read spends nothing).
    let windowStatus: Record<string, unknown>;
    if (windowDir === null || ownerDecisionsPath === null) {
      windowStatus = { status: 'not-provided', note: 'fetching requires --source-window <dir> (Main-created) + --owner-decisions <owner-approved-decisions.json>' };
    } else if (!fs.existsSync(windowDir)) {
      windowStatus = { status: 'not-created-yet', windowDir, note: 'no capture authorized until Main creates this window after planner+reviewer' };
    } else {
      const planningOwnerSha = computeOwnerDecisionSha256(ownerDecisionsPath);
      const planningWindow = openSourceWindow({
        windowDir,
        expectedOwnerDecisionSha256: planningOwnerSha,
        expectedAuthorityHash: authorityHash,
        expectedMaxHttpAttempts: SOURCE_WINDOW_MAX,
      });
      const usage = getSourceWindowUsage(planningWindow);
      windowStatus = {
        status: 'open',
        windowId: usage.windowId,
        max: usage.max,
        spent: usage.spent,
        remaining: usage.remaining,
        invocationCap: parseInvocationCap(attemptCapRaw, usage.remaining),
        f1HardCap: F1_HARD_CAP,
        effectiveF1Cap: Math.min(parseInvocationCap(attemptCapRaw, usage.remaining), F1_HARD_CAP),
      };
    }
    console.log(JSON.stringify({
      artifactKind: 'f1-manual-page-fetch-plan',
      mode: dryRun ? 'dry-run' : 'no-write',
      fetchPlan: { wouldFetch: false, reason: 'planning-only: no HTTP requests, no window spend' },
      sourceWindow: windowStatus,
      leads: {
        leadsPath,
        leadSha256,
        count: leads.length,
        maxLeads: MAX_LEADS,
        domains: domainOrder.map((d) => ({ domain: d, leads: byDomain.get(d)!.length })),
        pilotDomain: domainOrder[0] ?? null,
        pilotPageAttempts: PILOT_PAGE_ATTEMPTS,
      },
      exclusionGates: {
        stageBanks,
        publicPriorFamilies: exclusion.publicFamilies,
        publicPriorUrls: exclusion.publicUrls,
        stagedFamilies: exclusion.stagedFamilies,
        stagedUrls: exclusion.stagedUrls,
        prefetchGatePreview: { admitted: leads.length - gateExcluded, excludedPriorUrl: gateExcluded },
        perLead: gatePreview,
        privateCustodyParsed: false,
      },
      runRules: {
        f1HardCap: F1_HARD_CAP,
        perDomainSubCap: DOMAIN_SUB_CAP,
        pauseAfterConsecFails: DOMAIN_PAUSE_CONSEC_FAILS,
        abandonAfterAttemptsWithZeroKept: DOMAIN_SUB_CAP,
        pilotOnly,
        outDir,
      },
      sealGuard: {
        outDir,
        outputs: [OUT_CANDIDATES, OUT_RECEIPTS, OUT_MANIFEST],
        clashes: [OUT_CANDIDATES, OUT_RECEIPTS, OUT_MANIFEST].filter((n) => fs.existsSync(path.join(outDir, n))).map((n) => path.join(outDir, n)),
      },
      authorityHash,
      taxonomyPath,
      taxonomyFileHash,
    }, null, 2));
    return;
  }

  // ---- Fetching run (requires --write; reviewer code-review before first fetch). ----
  if (windowDir === null || ownerDecisionsPath === null) {
    throw new Error('source_window_required: F1 fetching requires --source-window <dir> (Main-created) and --owner-decisions <owner-approved-decisions.json>');
  }
  // Seal guard BEFORE any spend: new-dirs-only, refuse overwrites (wx-precedent).
  if (fs.existsSync(outDir) && fs.lstatSync(outDir).isSymbolicLink()) {
    throw new Error(`symlink_output_rejected: --out must not be a symlink: ${outDir}`);
  }
  const clashFiles = [OUT_CANDIDATES, OUT_RECEIPTS, OUT_MANIFEST]
    .filter((n) => fs.existsSync(path.join(outDir, n)))
    .map((n) => path.join(outDir, n));
  if (clashFiles.length > 0) {
    throw new Error(`sealed_artifacts_exist: refusing to overwrite: ${clashFiles.join(', ')}`);
  }

  const ownerDecisionSha256 = computeOwnerDecisionSha256(ownerDecisionsPath);
  const window = openSourceWindow({
    windowDir,
    expectedOwnerDecisionSha256: ownerDecisionSha256,
    expectedAuthorityHash: authorityHash,
    expectedMaxHttpAttempts: SOURCE_WINDOW_MAX,
  });
  const windowBefore = getSourceWindowUsage(window);
  const invocationCap = parseInvocationCap(attemptCapRaw, windowBefore.remaining);
  // F1 hard cap clamps the invocation cap; never above it, never reset.
  const cap = Math.min(invocationCap, F1_HARD_CAP);

  const denied = new Set<string>();
  const spentSeqs: number[] = [];
  const stats: Record<string, number> = { excludedPriorUrl: 0, excludedThinEvidence: 0, excludedNonProduct: 0 };
  const keptRows: Array<{ lead: Lead; candidate: Candidate; finalUrl: string; seqs: number[] }> = [];
  const perLead: Array<Record<string, unknown>> = [];
  const domains: DomainState[] = domainOrder.map((domain) => ({
    domain,
    leads: byDomain.get(domain)!,
    pageAttempts: 0,
    proofPass: 0,
    kept: 0,
    consecFails: 0,
    excludedPrefetch: 0,
    spentHops: 0,
    status: 'pending',
  }));

  let blockStatus = 'complete';
  let pilotVerdict: Record<string, unknown> | null = null;

  for (const [di, ds] of domains.entries()) {
    if (spentSeqs.length >= cap) break;
    const isPilotDomain = di === 0;
    for (const lead of ds.leads) {
      if (spentSeqs.length >= cap) break;
      if (ds.pageAttempts >= DOMAIN_SUB_CAP) break;
      if (pilotOnly && !isPilotDomain) break;
      if (pilotOnly && isPilotDomain && ds.pageAttempts >= PILOT_PAGE_ATTEMPTS) break;
      const outcome = await fetchLeadPage(window, lead, exclusion, worker, denied, spentSeqs, cap, stats);
      if (outcome.kind === 'excluded-prefetch') {
        // Zero-cost gate: not a page attempt, no spend, logged only.
        ds.excludedPrefetch++;
        perLead.push({ url: lead.url, domain: ds.domain, gate: 'excluded-prior-url-prefetch', attempts: 0, spentHops: 0 });
        continue;
      }
      ds.pageAttempts++;
      ds.spentHops += outcome.seqs.length;
      if (outcome.kind === 'kept') {
        ds.proofPass++;
        ds.kept++;
        ds.consecFails = 0;
        keptRows.push({ lead, candidate: outcome.candidate, finalUrl: outcome.finalUrl, seqs: outcome.seqs });
        perLead.push({ url: lead.url, domain: ds.domain, kept: true, finalUrl: outcome.finalUrl, attempts: 1, spentHops: outcome.seqs.length, seqs: outcome.seqs });
      } else {
        ds.consecFails++;
        perLead.push({ url: lead.url, domain: ds.domain, kept: false, reason: outcome.reason, attempts: 1, spentHops: outcome.seqs.length, seqs: outcome.seqs });
      }
      // Pilot gate on the first domain: verdict at 15 page attempts (or
      // domain exhaustion when the pilot domain holds fewer fetchable leads).
      if (isPilotDomain && (ds.pageAttempts >= PILOT_PAGE_ATTEMPTS || ds.pageAttempts + ds.excludedPrefetch >= ds.leads.length)) {
        pilotVerdict = {
          domain: ds.domain,
          pageAttempts: ds.pageAttempts,
          proofPass: ds.proofPass,
          kept: ds.kept,
          verdict: ds.proofPass > 0 ? 'PROCEED' : 'PAUSE-return-to-reviewer',
        };
        if (ds.proofPass === 0) {
          ds.status = 'pilot-paused';
          blockStatus = 'pilot-paused';
          break;
        }
      }
      // Per-domain proof-wall pause (Batch4 food-gate precedent carried).
      if (ds.consecFails >= DOMAIN_PAUSE_CONSEC_FAILS) {
        ds.status = 'paused-proof-wall';
        break;
      }
    }
    if (blockStatus === 'pilot-paused') break;
    if (ds.status === 'pending') {
      if (ds.pageAttempts >= DOMAIN_SUB_CAP) {
        ds.status = ds.kept === 0 ? 'abandoned-zero-kept' : 'capped-sub-cap';
      } else {
        ds.status = 'complete';
      }
    }
    if (pilotOnly) break;
  }
  if (spentSeqs.length >= cap && blockStatus === 'complete') blockStatus = 'f1-cap-reached';

  const windowAfter = getSourceWindowUsage(window);
  const receipts = buildPublicSourceReceipt(window, spentSeqs);

  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(outDir).isSymbolicLink()) {
    throw new Error('symlink_output_rejected: output dir must not resolve through a symlink');
  }
  const writeExclusive = (name: string, value: unknown): string => {
    const file = path.join(outDir, name);
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  };
  const candidatesHash = writeExclusive(OUT_CANDIDATES, {
    artifactKind: 'f1-manual-page-candidates',
    scope: 'exact curated official product pages only; page proof via collector candidateFromPageHtml; intendedClass is intent-only and never binds adjudication',
    leadsPath,
    leadSha256,
    windowId: windowAfter.windowId,
    rows: keptRows.map((k) => ({
      lead: { url: k.lead.url, domain: k.lead.domain, brand: k.lead.brand, intendedClass: k.lead.intendedClass },
      stratum: k.candidate.stratum,
      sourceForm: k.candidate.sourceForm,
      row: k.candidate.row,
      finalUrl: k.finalUrl,
      seqs: k.seqs,
    })),
  });
  const receiptsHash = writeExclusive(OUT_RECEIPTS, {
    artifactKind: 'f1-manual-page-receipts-public',
    windowId: windowAfter.windowId,
    maxHttpAttempts: windowAfter.max,
    ownerDecisionSha256,
    authorityHash,
    urlIdentity: 'sha256-only: public receipts never carry raw held URLs',
    spentBefore: windowBefore.spent,
    spentAfter: windowAfter.spent,
    receipts,
  });
  const manifestHash = writeExclusive(OUT_MANIFEST, {
    artifactKind: 'f1-manual-page-run-manifest',
    status: blockStatus,
    leadsPath,
    leadSha256,
    leadCount: leads.length,
    ownerDecisionsPath,
    ownerDecisionSha256,
    authorityHash,
    taxonomyPath,
    taxonomyFileHash,
    sourceWindow: {
      windowDir: window.windowDir,
      windowId: window.windowId,
      windowSpentBefore: windowBefore.spent,
      thisInvocationSpent: spentSeqs.length,
      windowSpentAfter: windowAfter.spent,
      windowRemaining: windowAfter.remaining,
      invocationCap,
      f1HardCap: F1_HARD_CAP,
      effectiveCap: cap,
      invocationSeqs: [...spentSeqs],
    },
    exclusionLedger: {
      publicPriorFamilies: exclusion.publicFamilies,
      publicPriorUrls: exclusion.publicUrls,
      stagedFamilies: exclusion.stagedFamilies,
      stagedUrls: exclusion.stagedUrls,
      stagedBanks: exclusion.stagedBanks,
      privateCustodyParsed: false,
    },
    pilot: pilotVerdict ?? { verdict: 'not-evaluated', note: 'no page attempts spent on the first domain' },
    pilotOnly,
    domains: domains.map((ds) => ({
      domain: ds.domain,
      leads: ds.leads.length,
      pageAttempts: ds.pageAttempts,
      excludedPrefetch: ds.excludedPrefetch,
      proofPass: ds.proofPass,
      kept: ds.kept,
      spentHops: ds.spentHops,
      status: ds.status,
    })),
    perLead,
    kept: keptRows.length,
    deniedHosts: [...denied],
    stats,
    historicalAccounting: 'unverified: this run prints ONLY its approved window; no prior/global totals are claimed',
    commitments: { candidatesHash, receiptsHash },
  });

  console.log(JSON.stringify({
    artifactKind: 'f1-manual-page-run-summary',
    status: blockStatus,
    pilot: pilotVerdict,
    kept: keptRows.length,
    pageAttempts: perLead.filter((r) => (r.attempts as number) > 0).length,
    windowSpend: windowAfter.spent - windowBefore.spent,
    remaining: windowAfter.remaining,
    domains: domains.map((ds) => ({ domain: ds.domain, status: ds.status, pageAttempts: ds.pageAttempts, kept: ds.kept })),
    commitments: { candidatesHash, receiptsHash, manifestHash },
  }, null, 2));
  if (blockStatus === 'pilot-paused') {
    console.error('F1-PILOT-PAUSED: 0 proof-pass on the first-domain pilot — returning to reviewer before burning remaining F1 quota.');
    process.exit(2);
  }
}

if (import.meta.main) {
  await main();
}
