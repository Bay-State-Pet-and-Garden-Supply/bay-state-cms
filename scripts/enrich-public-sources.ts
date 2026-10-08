/**
 * Main-owned enrichment refetch runner (Batch3 stage E; NOT a collector bypass).
 *
 * Refetches exact already-public packet URLs for the 64 retained
 * insufficient-type rows, at most one new resolving excerpt per row, under the
 * shared 1200-attempt source window (ledger kind exactly "enrich"). Same gates
 * as the collector: policy + denial BEFORE reservation (refused hops spend
 * nothing), reserve-before-request on every hop, immutable outcome after.
 * The window is opened, never created here — Main creates it once after
 * planner + reviewer approval, before any capture.
 *
 * Usage:
 *   bun scripts/enrich-public-sources.ts --write --source-window <dir> --owner-decisions <file>
 *     [--packet <insufficient-type-enrichment-targets.json>] [--out <dir>]
 *     [--attempt-cap <n<=remaining>] [--worker <name>] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { extractPublicProductEvidence } from './lib/jev-public-source-enrichment';
import {
  SOURCE_WINDOW_MAX,
  SourceWindowExhaustedError,
  buildPublicSourceReceipt,
  computeOwnerDecisionSha256,
  getSourceWindowUsage,
  openSourceWindow,
  parseInvocationCap,
  recordSourceOutcome,
  reserveSourceRequest,
  type SourceWindowHandle,
} from './lib/source-request-window';
import { assertPublicSourceUrl } from '../src/shared/schemas/jev-benchmark';

const UA = 'BayStateCMS-JevBenchmark/1.0 (+research source collection; public pages only)';

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const flags = (name: string): boolean => process.argv.includes(name);

const PacketRowSchema = z.object({
  sku: z.string().min(1).max(120),
  bank: z.string().min(1),
  canonicalUrl: z.string().min(1),
  title: z.string().min(1),
  brand: z.string().min(1),
  identityIssues: z.array(z.string()).default([]),
  explicitAlreadyPublic: z.literal(true),
  newIndependentSupport: z.literal(false),
}).passthrough();
const PacketSchema = z.object({ rows: z.array(PacketRowSchema).min(1).max(64) }).passthrough();
type PacketRow = z.infer<typeof PacketRowSchema>;

function siteRoot(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}
function sameSite(a: string, b: string): boolean {
  try {
    return siteRoot(new URL(a).hostname) === siteRoot(new URL(b).hostname);
  } catch {
    return false;
  }
}
function isAllowedSourceUrl(url: string): boolean {
  try {
    assertPublicSourceUrl(url);
    return true;
  } catch {
    return false;
  }
}

/** One exact-URL refetch: gates → reserve → fetch per hop, like fetchOnce. */
async function refetchExact(
  window: SourceWindowHandle,
  row: PacketRow,
  worker: string | null,
  denied: Set<string>,
  spentSeqs: number[],
  cap: number,
): Promise<{ finalUrl: string; html: string } | null> {
  let current = row.canonicalUrl;
  for (let hop = 0; hop < 5; hop++) {
    if (spentSeqs.length >= cap) return null;
    if (!isAllowedSourceUrl(current)) return null;
    try {
      if (denied.has(siteRoot(new URL(current).hostname))) return null;
    } catch {
      return null;
    }
    let reservation: { seq: number; urlSha256: string };
    try {
      reservation = reserveSourceRequest(window, { url: current, kind: 'enrich', ...(worker ? { worker } : {}) });
    } catch (e) {
      if (e instanceof SourceWindowExhaustedError) return null;
      throw e;
    }
    spentSeqs.push(reservation.seq);
    const seq = reservation.seq;
    let response: Response;
    try {
      response = await fetch(current, { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    } catch (e) {
      recordSourceOutcome(window, seq, { status: `fetch-error:${String(e).slice(0, 80)}`, bytes: 0 });
      return null;
    }
    if ([401, 403, 429, 451].includes(response.status)) {
      recordSourceOutcome(window, seq, { status: response.status, bytes: 0, error: 'host-denied' });
      try {
        denied.add(siteRoot(new URL(current).hostname));
      } catch { /* stay denied for the current host */ }
      return null;
    }
    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers.get('location');
      if (!loc) {
        recordSourceOutcome(window, seq, { status: response.status, error: 'redirect-without-location' });
        return null;
      }
      const next = new URL(loc, current);
      recordSourceOutcome(window, seq, { status: response.status, ...(next.protocol === 'https:' ? { finalUrl: next.toString() } : {}), error: 'redirect-hop' });
      if (next.protocol !== 'https:' || !sameSite(next.toString(), current)) return null;
      current = next.toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      recordSourceOutcome(window, seq, { status: response.status, bytes: 0 });
      return null;
    }
    const html = await response.text();
    recordSourceOutcome(window, seq, { status: response.status, finalUrl: current, bytes: html.length });
    return { finalUrl: current, html };
  }
  return null;
}

async function main(): Promise<void> {
  const dryRun = flags('--dry-run');
  const write = flags('--write');
  const windowDir = arg('--source-window');
  const ownerDecisionsPath = arg('--owner-decisions');
  if (windowDir === null || ownerDecisionsPath === null) {
    throw new Error('source_window_required: enrichment requires --source-window <dir> (Main-created) and --owner-decisions <owner-approved-decisions.json>');
  }
  const packetPath = arg('--packet') ?? 'docs/audits/jev-expansion-v2/insufficient-type-enrichment-targets.json';
  const packet = PacketSchema.parse(JSON.parse(fs.readFileSync(packetPath, 'utf-8')));
  const ownerDecisionSha256 = computeOwnerDecisionSha256(ownerDecisionsPath);
  const window = openSourceWindow({
    windowDir,
    expectedOwnerDecisionSha256: ownerDecisionSha256,
    expectedAuthorityHash: 'ff17dc313076c4657e87fa557ae7fa182796ddfcb53ce385f7525ebc03a33026',
    expectedMaxHttpAttempts: SOURCE_WINDOW_MAX,
  });
  const usageBefore = getSourceWindowUsage(window);
  const cap = parseInvocationCap(arg('--attempt-cap'), usageBefore.remaining);
  const worker = arg('--worker');
  if (dryRun || !write) {
    console.log(JSON.stringify({
      artifactKind: 'approved-source-window-enrichment-plan',
      mode: dryRun ? 'dry-run' : 'no-write',
      fetchPlan: { wouldFetch: false, reason: 'planning-only: no HTTP requests, no window spend' },
      sourceWindow: { windowId: usageBefore.windowId, max: usageBefore.max, spent: usageBefore.spent, remaining: usageBefore.remaining, invocationCap: cap },
      rows: packet.rows.length,
    }, null, 2));
    return;
  }
  const outDir = arg('--out') ?? 'docs/audits/jev-batch3/enrichment';
  if (fs.existsSync(outDir) && fs.lstatSync(outDir).isSymbolicLink()) {
    throw new Error(`symlink_output_rejected: --out must not be a symlink: ${outDir}`);
  }
  for (const name of ['enrichment-evidence.json', 'enrichment-receipts.json']) {
    if (fs.existsSync(path.join(outDir, name))) {
      throw new Error(`sealed_artifacts_exist: refusing to overwrite: ${path.join(outDir, name)}`);
    }
  }
  const denied = new Set<string>();
  const outcomes: Array<Record<string, unknown>> = [];
  const spentSeqs: number[] = [];
  for (const row of packet.rows) {
    if (spentSeqs.length >= cap) break;
    const spentBefore = spentSeqs.length;
    const fetched = await refetchExact(window, row, worker, denied, spentSeqs, cap);
    const attempts = spentSeqs.length - spentBefore;
    if (!fetched) {
      outcomes.push({ sku: row.sku, bank: row.bank, canonicalUrl: row.canonicalUrl, enriched: false, attempts });
      continue;
    }
    const evidence = extractPublicProductEvidence(fetched.html, fetched.finalUrl, {
      canonicalUrl: row.canonicalUrl,
      title: row.title,
      brand: row.brand,
    });
    if (!evidence) {
      outcomes.push({ sku: row.sku, bank: row.bank, canonicalUrl: row.canonicalUrl, enriched: false, attempts, reason: 'identity-proof-failed' });
      continue;
    }
    // At most ONE new excerpt trait per row is retained downstream; keep the full
    // primary-only evidence here with locator provenance for adjudication choice.
    outcomes.push({
      sku: row.sku,
      bank: row.bank,
      canonicalUrl: row.canonicalUrl,
      enriched: true,
      attempts,
      title: evidence.title,
      brand: evidence.brand,
      sourceHash: evidence.sourceHash,
      retrievedAt: new Date().toISOString(),
      excerpts: evidence.excerpts,
      resolvesIdentityIssues: row.identityIssues,
    });
  }
  const usageAfter = getSourceWindowUsage(window);
  const receipts = buildPublicSourceReceipt(window, spentSeqs);
  fs.mkdirSync(outDir, { recursive: true });
  const writeExclusive = (name: string, value: unknown): string => {
    const file = path.join(outDir, name);
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  };
  const evidenceHash = writeExclusive('enrichment-evidence.json', {
    artifactKind: 'already-public-enrichment-evidence',
    scope: 'same exact public URLs only; never new independent support or held candidacy',
    packetPath,
    windowId: usageAfter.windowId,
    rows: outcomes,
  });
  const receiptsHash = writeExclusive('enrichment-receipts.json', {
    artifactKind: 'enrichment-window-receipts',
    windowId: usageAfter.windowId,
    spentBefore: usageBefore.spent,
    spentAfter: usageAfter.spent,
    receipts,
  });
  console.log(JSON.stringify({
    artifactKind: 'approved-source-window-enrichment-summary',
    enriched: outcomes.filter(o => o.enriched).length,
    rows: outcomes.length,
    windowSpend: usageAfter.spent - usageBefore.spent,
    remaining: usageAfter.remaining,
    commitments: { evidenceHash, receiptsHash },
  }, null, 2));
}

if (import.meta.main) {
  await main();
}
