import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import { getCurrentWorkspace } from '../services/workspace-service';
import { syncFieldRegistryFromProductIndex } from '../services/workspace-service';
import { indexProductPageAssignments, getActivePageImportHash } from '../../db/repositories/page-repo';
import { getChangeSetDetail, loadApprovedLinkedExport } from '../services/change-set-service';
import { findLinkedManifest, listConflictingDraftChangeSets } from '../../db/repositories/change-set-repo';
import { comparisonHashForProduct } from '../../shopsite/catalog-comparison';
import { assertNoPreservedCorruption, ShopSiteProductCodec } from '../../shopsite/product-codec';
import { buildUploadMultipart, extractDbmakeQuery, redactCredentials, isDbmakeSuccessful } from '../../shopsite/multipart-upload';
import { publishStore } from '../../shopsite/publish';
import { buildCgiScriptUrl } from '../../shopsite/url-utils';
import {
  planFamilyPushSet, encodeFamilyPushXml, buildFamilyPushMultipart, expectedCensusRecordFor,
  checkRequiredRemoteMembers, reconcileFamilyPushImport, checkFamilyPushStalenessFiles, liveCensusSkusOf,
} from '../../shopsite/family-push-operation';
import type { FamilyPushReconciliation, FamilyPushSetPlan } from '../../shopsite/family-push-operation';
import type { LinkedManifest } from '../../shared/schemas/change-set';
import type { BackfillCensusRecord } from '../../shopsite/backfill-preflight';
import { GitClient } from '../../git/git-client';
import type { SyncJobRow, SyncJobEventRow } from '../../db/repositories/sync-job-repo';
import { createSyncJob, completeSyncJob, addSyncJobEvent, listSyncJobs, findSyncJobById, listSyncJobEvents } from '../../db/repositories/sync-job-repo';
import { updateProductIndex, insertProductIndex, findProductBySku } from '../../db/repositories/product-index-repo';
import { findConnection } from '../../db/repositories/connection-repo';
import { hasBlockingDriftForSku } from '../../db/repositories/drift-repo';
import { addAuditLog } from '../../db/repositories/audit-log-repo';
import { sha256Hex } from '../../shared/stable-id';
import { skuToProductFilePath } from '../../git/product-file-path';
import { getDb } from '../../db/connection';
import { createImagesZip } from '../../shopsite/zip-generator';
import { ShopSiteHttpClient } from '../../shopsite/shopsite-http-client';
import { preflightPagesSync, reconcileProductsToActivePages } from '../../shopsite/page-sync-preflight';
import { parseBackfillCensusXml, preflightBackfill } from '../../shopsite/backfill-preflight';
import { reconcileBackfillImport } from '../../shopsite/backfill-reconcile';
import type { Product } from '../../shared/types';
import { findCurationDataJsonById } from '../../db/repositories/onboarding-item-repo';
import { draftListingEvidenceHashes, draftVariantFactsFor, currentSourceAuthority } from '../../classification/listing-evidence-currentness';
import { evaluateListingEvidenceGate } from '../../classification/listing-evidence-gate';
/**
 * Slice-A-local workspace-scoped item lookup (issue #363 restore): latest
 * item id for a workspace + SKU, newest row first through the owning batch.
 * Single inline-SQL owner; throws on DB failure so callers fail closed.
 */
function findLatestItemIdByWorkspaceAndUpc(workspaceId: string, upc: string): string | null {
  const row = getDb()
    .query(
      `SELECT i.id AS id FROM onboarding_items i JOIN onboarding_batches b ON b.id = i.batch_id
       WHERE b.workspace_id = ? AND i.upc = ? ORDER BY i.created_at DESC LIMIT 1`,
    )
    .get(workspaceId, upc) as { id: string } | undefined;
  return row?.id ?? null;
}

const route = new Hono();

/**
 * Standalone/linked draft listing-evidence refusal (issue #366 gap 1):
 * interpret the persisted record against the frozen draft being released
 * (draft title/description + shared draft-variant projection over the live
 * bundle with live policy context). Returns the refusal message, or null
 * when the draft may release. Lookup/parse failure refuses closed.
 */
function refuseDraftEvidence(product: Product, workspacePath: string, workspaceId: string): string | null {
  const rawSku: unknown = product.sku;
  if (typeof rawSku !== 'string' || !rawSku) return null;
  const sku: string = rawSku;
  let itemId: string | null;
  try {
    itemId = findLatestItemIdByWorkspaceAndUpc(workspaceId, sku);
  } catch {
    return `Listing-evidence check could not complete for SKU "${sku}". Resolve before push.`;
  }
  let rawCuration: string | null;
  try {
    rawCuration = itemId ? findCurationDataJsonById(itemId) : null;
  } catch {
    return `Listing-evidence check could not complete for SKU "${sku}". Resolve before push.`;
  }
  let parsedCuration: Record<string, unknown> | null;
  try {
    parsedCuration = rawCuration ? (JSON.parse(String(rawCuration)) as Record<string, unknown>) : null;
  } catch {
    return `SKU ${sku}: listing-evidence curation is unreadable (listing_evidence_malformed). Resolve before push.`;
  }
  if (!parsedCuration || parsedCuration.listingEvidenceValidation === undefined || parsedCuration.listingEvidenceValidation === null) return null;
  if (!itemId) return null;
  const draftWeight = product.core?.weight && typeof product.core.weight === 'string' && product.core.weight.trim() ? product.core.weight.trim() : null;
  const draftHashes = draftListingEvidenceHashes(
    itemId,
    { title: product.core?.name ?? null, description: product.core?.description ?? null, variantFacts: draftVariantFactsFor(itemId, draftWeight) },
    { workspacePath, workspaceId },
  );
  const gate = evaluateListingEvidenceGate({
    curationData: parsedCuration,
    currentListingHash: draftHashes.listingHash,
    currentEvidenceHash: draftHashes.evidenceHash,
    currentModelPolicyDigest: draftHashes.modelPolicyDigest,
    currentRequiredFields: draftHashes.requiredFields,
    currentSourceAuthority: currentSourceAuthority(itemId),
  });
  if (!gate.ok) return `SKU ${sku}: listing-evidence check refuses push (${gate.code}): ${gate.reason}`;
  return null;
}
interface ConnectionConfig {
  cgiBaseUrl: string;
  merchantId: string;
  password: string;
}

interface UploadResult {
  success: boolean;
  dbmakeQuery: string;
  rawResponse: string;
  cookieHeader?: string;
  error?: string;
}

interface DbmakeResult {
  success: boolean;
  response: string;
  cookieHeader?: string;
  error?: string;
}

function getConnectionConfig(workspaceId: string): ConnectionConfig | null {
  const row = findConnection(workspaceId);
  if (!row?.cgiBaseUrl || !row.merchantId || !row.passwordSecretRef) return null;
  return {
    cgiBaseUrl: row.cgiBaseUrl,
    merchantId: row.merchantId,
    password: row.passwordSecretRef,
  };
}

function authHeader(config: ConnectionConfig): string {
  return `Basic ${Buffer.from(`${config.merchantId}:${config.password}`).toString('base64')}`;
}

function extractCookieHeader(response: Response): string | undefined {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') {
    const cookies = headers
      .getSetCookie()
      .map(cookie => cookie.split(';', 1)[0]?.trim())
      .filter(Boolean);
    if (cookies.length > 0) return cookies.join('; ');
  }

  const rawSetCookie = response.headers.get('set-cookie');
  if (!rawSetCookie) return undefined;
  return rawSetCookie
    .split(/,(?=[^;,]+=)/)
    .map(cookie => cookie.split(';', 1)[0]?.trim())
    .filter(Boolean)
    .join('; ');
}


function ensureNoOpenDrift(workspaceId: string, items: Array<{ sku: string }>): string | null {
  for (const item of items) {
    if (hasBlockingDriftForSku(workspaceId, item.sku)) {
      return item.sku;
    }
  }
  return null;
}

/**
 * Push-time staleness verdict over worktree-vs-commit bytes (issue #373).
 * Thin route adapter over checkFamilyPushStalenessFiles: git supplies the
 * commit bytes, fs supplies the worktree bytes.
 */
function checkFamilyPushStaleness(
  workspacePath: string,
  commitHash: string,
  manifest: LinkedManifest,
): { ok: true } | { ok: false; error: string } {
  const git = new GitClient(workspacePath);
  return checkFamilyPushStalenessFiles(
    manifest,
    (filePath) => git.readFileAtCommit(commitHash, filePath),
    (filePath) => {
      try {
        const full = path.join(workspacePath, filePath);
        if (!fs.existsSync(full)) return null;
        return fs.readFileSync(full, 'utf-8');
      } catch {
        return null;
      }
    },
  );
}
/**
 * Recover a family push job's pre-upload census baseline (issue #373): the
 * SKU scope recorded in the job's events when the push captured its
 * pre-upload census (`baselineSkus` details).
 *
 * Scoping rule: the baseline must come from the SAME change set's push jobs
 * (prefer the explicit jobId — the failed push being reconciled — else scan
 * only that change set's push_publish/upload_only jobs). It is NEVER borrowed
 * from another change set's store state, and reconcile refuses as unknowable
 * when no same-change-set baseline exists.
 */
function originJobInScope(job: SyncJobRow, workspaceId: string, changeSetId: string): boolean {
  return job.workspaceId === workspaceId && job.changeSetId === changeSetId && (job.kind === 'push_publish' || job.kind === 'upload_only');
}

/**
 * Originating reconciled payload identity (issue #373): the exact upload
 * bytes hash plus the Pages import hash the push reconciled against, read
 * back from the originating push job's plan event. Recovery (resume and
 * reconcile) replays or verifies ONLY these bytes — never freshly drifted
 * state. Explicit jobIds are ownership-checked; the scan takes the latest
 * same-change-set push job carrying a payload record.
 *
 * Durability rule: only a terminally recorded origin binds recovery. A
 * failed (refused) resume must never promote its moved-on payload into the
 * origin: during scan matching, jobs that recorded a resume refusal are
 * skipped so the durable originating job keeps binding later attempts.
 */
interface OriginPushPayload {
  payloadHash: string;
  pagesSourceHash: string;
}
function readOriginPayloadFromEvents(id: string): OriginPushPayload | null {
  let events: SyncJobEventRow[];
  try {
    events = listSyncJobEvents(id);
  } catch {
    return null;
  }
  for (const event of events) {
    if (!event.detailsJson) continue;
    try {
      const parsed = JSON.parse(event.detailsJson) as { pushPayloadHash?: unknown; pagesSourceHash?: unknown };
      if (typeof parsed.pushPayloadHash === 'string' && typeof parsed.pagesSourceHash === 'string') {
        return { payloadHash: parsed.pushPayloadHash, pagesSourceHash: parsed.pagesSourceHash };
      }
    } catch {
      continue;
    }
  }
  return null;
}
function findOriginPushPayload(workspaceId: string, changeSetId: string, jobId: string | null, excludeJobId?: string): OriginPushPayload | null {
  if (jobId) {
    const job = findSyncJobById(jobId);
    if (!job || !originJobInScope(job, workspaceId, changeSetId)) return null;
    return readOriginPayloadFromEvents(jobId);
  }
  let jobs: SyncJobRow[];
  try {
    jobs = listSyncJobs(workspaceId);
  } catch {
    return null;
  }
  // Prefer the DURABLE originating job: the earliest same-change-set
  // push job carrying a payload record (the first attempt). Later jobs —
  // including refused resumes that recorded moved-on bytes before their
  // identity check — never displace it. Defense in depth on the refusal
  // marker: match case-insensitively AND on the redacted-or-unredacted
  // form, since the recorded message passes through redactCredentials.
  const ordered = [...jobs].reverse();
  for (const job of ordered) {
    if (job.id === excludeJobId) continue;
    if (!originJobInScope(job, workspaceId, changeSetId)) continue;
    let refusedResume = false;
    try {
      for (const event of listSyncJobEvents(job.id)) {
        if (event.level === 'error' && /resume refused/i.test(event.message)) { refusedResume = true; break; }
      }
    } catch {
      refusedResume = false;
    }
    if (refusedResume) continue;
    const origin = readOriginPayloadFromEvents(job.id);
    if (origin) return origin;
  }
  return null;
}
function findFamilyPushBaseline(workspaceId: string, changeSetId: string, jobId: string | null): string[] | null {
   const pickFromEvents = (id: string): string[] | null => {
     let events: SyncJobEventRow[];
     try {
       events = listSyncJobEvents(id);
     } catch {
       return null;
     }
     for (const event of events) {
       if (!event.detailsJson) continue;
       try {
         const parsed = JSON.parse(event.detailsJson) as { baselineSkus?: unknown };
         if (Array.isArray(parsed.baselineSkus) && parsed.baselineSkus.every((sku): sku is string => typeof sku === 'string')) {
           return [...parsed.baselineSkus].sort();
         }
       } catch {
         continue;
       }
     }
     return null;
   };
   if (jobId) {
    // Explicit jobIds are ownership-checked first: a job from another
    // workspace, change set, or kind can never supply this change set's
    // baseline, even when it carries one.
    const job = findSyncJobById(jobId);
    if (!job || !originJobInScope(job, workspaceId, changeSetId)) return null;
     const fromJob = pickFromEvents(jobId);
     if (fromJob) return fromJob;
     // An explicit jobId that carries no baseline is unknowable — never fall
     // through to a different attempt's store state.
     return null;
   }
  // Bind the SAME durable originating job as findOriginPushPayload above:
  // the earliest same-change-set push job carrying a baseline record (the
  // first attempt). Scanning latest-first would scope the verdict against a
  // later attempt's store state while the payload identity binds the
  // origin — an incoherent mixed scope. (Refused resumes record no
  // baseline — the check throws before the census — so no refusal skip is
  // needed here.)
  let jobs: SyncJobRow[];
  try {
    jobs = listSyncJobs(workspaceId);
  } catch {
    return null;
  }
  const orderedJobs = [...jobs].reverse();
  for (const job of orderedJobs) {
    if (!originJobInScope(job, workspaceId, changeSetId)) continue;
    const fromJob = pickFromEvents(job.id);
    if (fromJob) return fromJob;
  }
  return null;
}
/**
 * Snapshot redacted CGI evidence for a family push job (issue #373
 * recovery evidence). Same artifact shape as backfill jobs so operators
 * and the resume path inspect the actual adapter outcome. Credentials are
 * redacted before anything touches disk; failures here never mask the
 * push outcome itself.
 */
function snapshotFamilyPushEvidence(
  workspacePath: string,
  jobId: string,
  uploadRawResponse: string,
  dbmakeBody: string | null,
  generateBody: string | null,
): void {
  try {
    const jobDir = path.join(workspacePath, 'exports', jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(
      path.join(jobDir, 'dbupload.cgi.redacted.txt'),
      redactCredentials(uploadRawResponse),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(jobDir, 'dbmake.cgi.redacted.txt'),
      redactCredentials(dbmakeBody ?? 'dbmake skipped: upload reported success immediately; no dbmake request occurred.'),
      'utf-8',
    );
    if (generateBody !== null) {
      fs.writeFileSync(
        path.join(jobDir, 'generate.cgi.redacted.txt'),
        redactCredentials(generateBody),
        'utf-8',
      );
    }
  } catch {
    // Evidence snapshot best-effort; the job events carry the verdict.
  }
}

async function directUpload(xml: string, config: ConnectionConfig, backfillMode = false): Promise<UploadResult> {
  // Issue #373: family pushes always use the operation module's wire shape
  // (SKU match, new-records yes so new children are created, exact token
  // replay). Backfill mode keeps its legacy update-only gate separately.
  const multipart = backfillMode
    ? buildUploadMultipart(xml, { newRecords: 'no', uniqueName: 'SKU' })
    : buildFamilyPushMultipart(xml);

  const url = buildCgiScriptUrl(config.cgiBaseUrl, 'dbupload.cgi');
  const headers: Record<string, string> = {
    Authorization: authHeader(config),
    'User-Agent': 'BaystateCMS/0.1.0',
    'Content-Type': multipart.contentType,
    'Content-Length': String(multipart.contentLength),
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: multipart.body as unknown as BodyInit,
      signal: AbortSignal.timeout(180_000),
    });

    const rawResponse = await response.text();
    const cookieHeader = extractCookieHeader(response);

    if (!response.ok) {
      return {
        success: false,
        dbmakeQuery: '',
        rawResponse,
        cookieHeader,
        error: `HTTP ${response.status}: ${redactCredentials(rawResponse.slice(0, 300))}`,
      };
    }

    const dbmakeQuery = extractDbmakeQuery(rawResponse);
    if (dbmakeQuery === null) {
      return {
        success: false,
        dbmakeQuery: '',
        rawResponse,
        cookieHeader,
        error: `ShopSite upload did not return a dbmake return string or success indicator: ${redactCredentials(rawResponse.slice(0, 300))}`,
      };
    }

    return { success: true, dbmakeQuery, rawResponse, cookieHeader };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, dbmakeQuery: '', rawResponse: '', error: msg };
  }
}

async function finalizeDbmake(queryString: string, config: ConnectionConfig, cookieHeader?: string): Promise<DbmakeResult> {
  const url = buildCgiScriptUrl(config.cgiBaseUrl, 'dbmake.cgi');
  const headers: Record<string, string> = {
    Authorization: authHeader(config),
    'User-Agent': 'BaystateCMS/0.1.0',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (cookieHeader) headers.Cookie = cookieHeader;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: queryString,
      signal: AbortSignal.timeout(60_000),
    });

    const responseText = await response.text();
    const responseCookie = extractCookieHeader(response) ?? cookieHeader;

    if (!response.ok) {
      return {
        success: false,
        response: responseText,
        cookieHeader: responseCookie,
        error: `HTTP ${response.status}: ${redactCredentials(responseText.slice(0, 300))}`,
      };
    }

    if (!isDbmakeSuccessful(responseText)) {
      return {
        success: false,
        response: responseText,
        cookieHeader: responseCookie,
        error: `dbmake responded with error body: ${redactCredentials(responseText.slice(0, 300))}`,
      };
    }

    return { success: true, response: responseText, cookieHeader: responseCookie };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, response: '', cookieHeader, error: msg };
  }
}

async function runDirectSync(options: {
  workspaceId: string;
  workspacePath: string;
  changeSetId: string;
  publish: boolean;
  backfillMode?: boolean;
  resumedFrom?: boolean;
}): Promise<ResponseInit & { body: Record<string, unknown> }> {
  const config = getConnectionConfig(options.workspaceId);
  if (!config) {
    return { status: 400, body: { error: 'ShopSite connection not configured. Use Export Package instead.' } };
  }

  const { changeSet, items } = getChangeSetDetail(options.changeSetId);
  if (!changeSet) return { status: 400, body: { error: 'Change set not found.' } };
  if (changeSet.status !== 'approved') {
    return { status: 400, body: { error: `Change set must be approved first (status: ${changeSet.status}).` } };
  }
  if (items.length === 0) return { status: 400, body: { error: 'Change set has no items.' } };

  // Standalone sets (no linked manifest) push exactly as before: draft items
  // straight through, no linked-manifest gate. Only linked sets route through
  // the immutable commit binding below.
  const standaloneManifestRow = (() => { try { return findLinkedManifest(options.changeSetId); } catch { return null; } })();
  const linked = standaloneManifestRow ? loadApprovedLinkedExport(options.changeSetId, options.workspacePath) : null;
  if (linked && !linked.ok) {
    return { status: linked.incomplete ? 409 : 400, body: { error: linked.error } };
  }
  if (linked) {
    // Linked push path: gates run over the immutable approved load.
    for (const product of linked.load.products) {
      const refusal = refuseDraftEvidence(product, options.workspacePath, options.workspaceId);
      if (refusal) return { status: 409, body: { error: refusal } };
    }
    const familySkus = [...linked.load.manifest.writes.map((w) => w.sku), ...linked.load.manifest.reads.map((r) => r.sku)];
    const driftSku = ensureNoOpenDrift(options.workspaceId, familySkus.map((sku) => ({ sku })));
    if (driftSku) {
      return { status: 409, body: { error: `Cannot push SKU "${driftSku}": unresolved remote drift exists. Resolve drift first.` } };
    }
    // Publication-time competing-draft recheck (#373): another draft for a
    // write or read SKU created after approval leaves committed files
    // unchanged, so approval-time validation cannot see it. Reuse the
    // repository conflict query over the complete manifest SKU scope before
    // the operation proceeds.
    try {
      const conflictScope: Record<string, true> = {};
      for (const sku of familySkus) conflictScope[sku] = true;
      const conflicts = listConflictingDraftChangeSets(options.workspaceId, Object.keys(conflictScope).sort(), options.changeSetId);
      if (conflicts.length > 0) {
        const first = conflicts[0]!;
        return { status: 409, body: { error: `Cannot push SKU "${first.sku}": also staged in change set ${first.changeSetId.slice(0, 8)} (status "${first.status}"); resolve the competing draft before publishing.` } };
      }
    } catch (err) {
      return { status: 409, body: { error: `Competing-draft check could not complete (${err instanceof Error ? err.message : String(err)}); resolve before pushing.` } };
    }
    const staleness = checkFamilyPushStaleness(options.workspacePath, linked.load.commitHash, linked.load.manifest);
    if (!staleness.ok) {
      return { status: 409, body: { error: staleness.error, stale: true } };
    }
  } else {
    // Standalone push path (gap 1): the same listing-evidence evaluator
    // runs over each frozen draft artifact before dispatch — an approved
    // standalone set whose evidence became stale/blocked refuses here.
    for (const item of items) {
      let product: Product;
      try {
        product = JSON.parse(item.draftJson) as Product;
      } catch {
        return { status: 400, body: { error: `Failed to parse product data for SKU "${item.sku}"` } };
      }
      const refusal = refuseDraftEvidence(product, options.workspacePath, options.workspaceId);
      if (refusal) return { status: 409, body: { error: refusal } };
    }
    const driftSku = ensureNoOpenDrift(options.workspaceId, items);
    if (driftSku) {
      return { status: 409, body: { error: `Cannot push SKU "${driftSku}": unresolved remote drift exists. Resolve drift first.` } };
    }
    // Publication-time competing-draft recheck (#373) for the standalone
    // path too: a foreign draft created after approval blocks publication.
    try {
      const standaloneScope: Record<string, true> = {};
      for (const item of items) standaloneScope[item.sku] = true;
      const conflicts = listConflictingDraftChangeSets(options.workspaceId, Object.keys(standaloneScope).sort(), options.changeSetId);
      if (conflicts.length > 0) {
        const first = conflicts[0]!;
        return { status: 409, body: { error: `Cannot push SKU "${first.sku}": also staged in change set ${first.changeSetId.slice(0, 8)} (status "${first.status}"); resolve the competing draft before publishing.` } };
      }
    } catch (err) {
      return { status: 409, body: { error: `Competing-draft check could not complete (${err instanceof Error ? err.message : String(err)}); resolve before pushing.` } };
    }
  }

  const kind = options.publish ? 'push_publish' : 'upload_only';
  const job = createSyncJob({
    workspaceId: options.workspaceId,
    changeSetId: options.changeSetId,
    kind,
    metadataJson: options.resumedFrom ? JSON.stringify({ resumed: true }) : undefined,
  });
  addSyncJobEvent({
    syncJobId: job.id,
    level: 'info',
    message: options.resumedFrom
      ? `Resuming family push for change set "${changeSet.title}" with the exact approved payload (no replacement SKUs or parents)`
      : options.publish
        ? `Starting direct push and publish for change set "${changeSet.title}"`
        : `Starting upload-only for change set "${changeSet.title}"`,
  });

  try {
    // 1. Pages preflight — verify and reconcile category catalog before pushing products
    addSyncJobEvent({
      syncJobId: job.id,
      level: 'info',
      message: 'Running ShopSite Pages preflight verification...',
    });

    const client = new ShopSiteHttpClient({
      cgiBaseUrl: config.cgiBaseUrl,
      merchantId: config.merchantId,
      password: config.password,
    });

    const preflight = await preflightPagesSync({
      workspaceId: options.workspaceId,
      client,
      activatedBy: `sync-job-${job.id}`,
    });


    addSyncJobEvent({
      syncJobId: job.id,
      level: 'info',
      message: preflight.message,
    });

    // Products resolve from the immutable linked load when present,
    // otherwise straight from the approved draft items (standalone path).
    const approvedProducts: Product[] = linked ? linked.load.products : items.map((item) => {
      try {
        return JSON.parse(item.draftJson) as Product;
      } catch {
        throw new Error(`Failed to parse product data for SKU "${item.sku}"`);
      }
    });
    const approvedManifest = linked ? linked.load.manifest : null;
    let pushPlan: { skus: string[]; requiredRemoteSkus: string[]; newSkus: string[]; updateSkus: string[]; payloadHash: string };
    try {
      if (approvedManifest) {
        pushPlan = planFamilyPushSet(approvedProducts, approvedManifest);
      } else {
        const skus = approvedProducts.map((p) => p.sku).sort();
        pushPlan = { skus, requiredRemoteSkus: [], newSkus: skus, updateSkus: [], payloadHash: '' };
      }
    } catch (planErr) {
      throw new Error(planErr instanceof Error ? planErr.message : String(planErr), { cause: planErr });
    }
    const products = reconcileProductsToActivePages(
      options.workspaceId,
      preflight.sourceHash,
      approvedProducts,
    );
    // Fail closed: corrupted preserved data must never reach dbupload (a
    // full-record import would overwrite live blocks with "[object Object]").
    assertNoPreservedCorruption(products);
    const xml = approvedManifest ? encodeFamilyPushXml(products, pushPlan) : ShopSiteProductCodec.encodeMany(products).xml;
    // The payload identity: hash of the exact reconciled upload bytes.
    // Resume determinism holds per live Pages state: identical Pages state
    // reproduces byte-identical XML; a Pages change between attempts moves
    // the active import, and page reconciliation fails closed (refuses)
    // instead of transmitting a moved-on payload.
    const payloadHash = sha256Hex(xml);
    pushPlan = { ...pushPlan, payloadHash };
    addSyncJobEvent({ syncJobId: job.id, level: 'info', message: `Generated XML for ${products.length} product(s)` });
    addSyncJobEvent({
      syncJobId: job.id,
      level: 'info',
      message: `Family push plan: ${pushPlan.skus.length} record(s) in one complete set (payload ${pushPlan.payloadHash.slice(0, 12)}).`,
      detailsJson: JSON.stringify({ skus: pushPlan.skus, newSkus: pushPlan.newSkus, requiredRemoteSkus: pushPlan.requiredRemoteSkus, pushPayloadHash: pushPlan.payloadHash, pagesSourceHash: preflight.sourceHash }),
    });
    // Resume binds to the originating payload identity: when this run is a
    // resume, the originating payload is verified BEFORE any upload. The
    // plan event above records this attempt's identity, but a refused
    // resume's error event makes the origin scan skip it, so a refused
    // resume never promotes itself into the origin for later attempts.
    //
    // Pages-identity comparison (issue #373): the resume must refuse when
    // the live Pages catalog moved since the originating push. The
    // preflight above already reconciled the live catalog (activating a new
    // import when the download moved), so comparing the import it observed
    // against the origin catches the live-download-move case below. A
    // direct-table move the download never observes is NOT caught by that
    // comparison — the post-preflight active import always matches the
    // preflight's observation, so it passes by construction there; the
    // payload-bytes identity (byte-identical XML requires identical Pages
    // state) is the backstop instead. Both refuse before any upload.
    if (options.resumedFrom === true) {
      const prior = findOriginPushPayload(options.workspaceId, options.changeSetId, null, job.id);
      // Live-download move: the preflight above reconciled the live catalog,
      // so a genuinely new active import refuses here before any upload.
      // (Direct-table moves invisible to the download fall through to the
      // payload-bytes identity below.)
      if (prior !== null && preflight.sourceHash !== prior.pagesSourceHash) {
        throw new Error(`Resume refused: ShopSite Pages changed since the originating push (import ${prior.pagesSourceHash.slice(0, 12)} -> ${preflight.sourceHash.slice(0, 12)}); re-approve the group instead of retransmitting moved-on bytes.`);
      }
      if (prior !== null) {
        if (payloadHash !== prior.payloadHash) {
          throw new Error(`Resume refused: recomputed payload ${payloadHash.slice(0, 12)} differs from the originating push ${prior.payloadHash.slice(0, 12)}; the approved catalog moved on — re-approve instead of retransmitting.`);
        }
      }
    }
    // Backfill mode (Milestone 1): census the live catalog BEFORE upload,
    // refuse whole-record overwrite of changed live fields, and upload
    // update-only (newRecords=no).
    const backfillMode = options.backfillMode === true;
    // Issue #373: unchanged referenced remote members need verified
    // existence/currentness or inclusion. Expectations resolve from the
    // immutable approved commit (never mutable workspace), and a fresh live
    // census verifies them BEFORE upload. Later related edits stale the
    // group: they refuse here instead of rewriting the payload.
    // Gap 1: every non-backfill push also snapshots a pre-upload census
    // baseline (SKU scope) so the post-import reconcile flags only SKUs that
    // appeared because of this push — never pre-existing store SKUs outside
    // the pushed set. The baseline rides the same live XML already fetched
    // for remote verification, so the push-time remote-member path keeps its
    // exact call shape (no added round trip).
    let liveCensusXml: string | null = null;
    let baselineSkus: string[] | null = null;
    if (!backfillMode && pushPlan.requiredRemoteSkus.length === 0) {
      const liveRes = await client.fetchProductsXml();
      if (!liveRes.success || !liveRes.data) {
        throw new Error(`Family push pre-upload census failed: ${(liveRes.errors ?? []).join('; ') || 'no live XML'}. The approved operation stays pending; refetch and retry.`);
      }
      liveCensusXml = liveRes.data;
      baselineSkus = liveCensusSkusOf(liveRes.data);
      if (baselineSkus === null) {
        throw new Error('Family push pre-upload census is malformed or unreadable; the approved operation stays pending — refetch and retry.');
      }
      addSyncJobEvent({
        syncJobId: job.id,
        level: 'info',
        message: `Family push pre-upload census captured (${baselineSkus.length} live SKU(s) in scope).`,
        detailsJson: JSON.stringify({ baselineSkus }),
      });
    }
    if (!backfillMode && pushPlan.requiredRemoteSkus.length > 0) {
      const liveRes = await client.fetchProductsXml();
      if (!liveRes.success || !liveRes.data) {
        throw new Error(`Family push remote verification failed: ${(liveRes.errors ?? []).join('; ') || 'no live XML'}. Required unchanged member(s) ${pushPlan.requiredRemoteSkus.join(', ')} are unverified — refetch and retry.`);
      }
      liveCensusXml = liveRes.data;
      const git = new GitClient(options.workspacePath);
      const expectedBySku: Record<string, BackfillCensusRecord> = {};
      const manifestReads = approvedManifest ? approvedManifest.reads : (linked ? linked.load.manifest.reads : []);
      const commitAnchor = linked ? linked.load.commitHash : '';
      for (const sku of pushPlan.requiredRemoteSkus) {
        const read = manifestReads.find((r) => r.sku === sku);
        if (!read) {
          throw new Error(`Family push remote verification failed: unchanged member "${sku}" has no manifest read entry; re-approve the group.`);
        }
        const atCommit = git.readFileAtCommit(commitAnchor, read.filePath);
        if (!atCommit) {
          throw new Error(`Family push remote verification failed: unchanged member "${sku}" is missing at approved commit ${commitAnchor.slice(0, 12)}; the group is stale — re-approve.`);
        }
        let commitProduct: Product;
        try {
          commitProduct = JSON.parse(atCommit);
        } catch {
          throw new Error(`Family push remote verification failed: unchanged member "${sku}" is unreadable at the approved commit; the group is stale — re-approve.`);
        }
        const expected = expectedCensusRecordFor(commitProduct);
        if (!expected) {
          throw new Error(`Family push remote verification failed: unchanged member "${sku}" does not encode to one census record at the approved commit; re-approve.`);
        }
        expectedBySku[sku] = expected;
      }
      const remoteChecks = checkRequiredRemoteMembers(pushPlan.requiredRemoteSkus, liveCensusXml, expectedBySku);
      // same document, no added round trip. Reconcile later flags only SKUs
      // outside this scope, so pre-existing store SKUs never fail the push.
      baselineSkus = liveCensusSkusOf(liveCensusXml);
      if (baselineSkus === null) {
        throw new Error('Family push remote verification census is malformed or unreadable; the approved operation stays pending — refetch and retry.');
      }
      const remoteBlockers = remoteChecks.filter((check) => !check.ok);
      addSyncJobEvent({
        syncJobId: job.id,
        level: remoteBlockers.length > 0 ? 'warning' : 'info',
        message: remoteBlockers.length > 0
          ? `Family push remote verification blocked: ${remoteBlockers.map((b) => b.reason).join('; ')}`
          : `Family push remote verification passed for ${remoteChecks.length} unchanged member(s).`,
        detailsJson: JSON.stringify({ remoteChecks, baselineSkus }),
      });
      if (remoteBlockers.length > 0) {
        throw new Error(`Family push refused: ${remoteBlockers.map((b) => b.reason).join('; ')}`);
      }
    }
    if (backfillMode) {
      const liveRes = await client.fetchProductsXml();
      if (!liveRes.success || !liveRes.data) {
        throw new Error(`Backfill live census failed: ${(liveRes.errors ?? []).join('; ') || 'no live XML'}`);
      }
      const gate = preflightBackfill({
        workspaceId: options.workspaceId,
        items,
        liveXml: liveRes.data,
        outgoingXml: xml,
      });
      if (!gate.ok) {
        const first = gate.issues[0];
        throw new Error(
          `Backfill preflight refused ${gate.issues.length} record(s); first: ${first.sku}/${first.field} ${first.reason}`,
        );
      }
      addSyncJobEvent({ syncJobId: job.id, level: 'info', message: 'Backfill preflight passed (census 1:1, run-bound decisions).' });
    }

    // Generate brand-organized images ZIP
    let zipPath: string | null = null;
    try {
      const exportsDir = path.join(options.workspacePath, 'exports', options.changeSetId);
      if (!fs.existsSync(exportsDir)) {
        fs.mkdirSync(exportsDir, { recursive: true });
      }
      zipPath = path.join(exportsDir, 'shopsite-images.zip');
      await createImagesZip(options.workspacePath, products, zipPath);
      addSyncJobEvent({ syncJobId: job.id, level: 'info', message: 'Images ZIP generated.' });
    } catch (zipErr) {
      const zipMsg = zipErr instanceof Error ? zipErr.message : String(zipErr);
      addSyncJobEvent({ syncJobId: job.id, level: 'warning', message: `Images ZIP generation failed: ${zipMsg}` });
      zipPath = null;
    }

    const uploadResult = await directUpload(xml, config, backfillMode);
    addSyncJobEvent({
      syncJobId: job.id,
      level: 'info',
      message: 'Upload response received.',
      detailsJson: JSON.stringify({ responsePreview: redactCredentials(uploadResult.rawResponse.slice(0, 300)) }),
    });

    if (!uploadResult.success) throw new Error(`Upload failed: ${uploadResult.error}`);

    let cookieHeader = uploadResult.cookieHeader;
    let dbmakeBody: string | null = null;
    if (uploadResult.dbmakeQuery) {
      const dbmakeResult = await finalizeDbmake(uploadResult.dbmakeQuery, config, cookieHeader);
      if (!dbmakeResult.success) throw new Error(`dbmake finalization failed: ${dbmakeResult.error}`);
      cookieHeader = dbmakeResult.cookieHeader ?? cookieHeader;
      dbmakeBody = dbmakeResult.response;
      addSyncJobEvent({ syncJobId: job.id, level: 'info', message: 'dbmake finalization completed.' });
    } else {
      addSyncJobEvent({ syncJobId: job.id, level: 'info', message: 'Upload reported success immediately; no dbmake needed.' });
    }

    // Publish runs ONLY after the reconcile verdict (issue #373): a partial
    // or unknown import is never already regenerated/published when the
    // route reports it. Backfill keeps its legacy order (publish timing
    // unchanged there), but every non-backfill family push publishes only
    // on a reconciled success.
    let publishCompleted = false;
    let publishBody: string | null = null;
    const runPublish = async (): Promise<void> => {
      if (!options.publish) return;
      const publishResult = await publishStore(
        buildCgiScriptUrl(config.cgiBaseUrl, 'generate.cgi'),
        authHeader(config),
        undefined,
        cookieHeader,
      );
      publishCompleted = publishResult.success;
      publishBody = publishResult.success
        ? String(publishResult.data ?? '')
        : [publishResult.error, ...(publishResult.errors ?? [])].filter(Boolean).join(' | ');
      if (!publishResult.success) {
        addSyncJobEvent({
          syncJobId: job.id,
          level: 'warning',
          message: `Import reconciled but storefront generation is pending retry. ${publishResult.error ?? ''}`,
        });
      } else {
        addSyncJobEvent({ syncJobId: job.id, level: 'info', message: 'Storefront generation completed.' });
      }
    };
    // Backfill mode: publish (legacy order), then re-census live, reconcile
    // the import, snapshot redacted CGI artifacts under exports/<jobId>, and
    // mark SKUs import_reconciled (never published/skipped vocabulary — the
    // publish state is explicit). Family mode below publishes only AFTER its
    // reconcile verdict.
    let importReconciled = false;
    let publishState = options.publish ? 'pending' : 'skipped';
    let publishVerified = false;
    let familyReconciliation: FamilyPushReconciliation | null = null;
    const needsFamilyReconcile = !backfillMode;
    // Backfill mode keeps its legacy order (publish before its reconcile) —
    // the publish-after-reconcile change applies to family pushes only.
    if (backfillMode && options.publish) {
      await runPublish();
      publishState = publishCompleted ? 'published_verified' : 'pending';
      publishVerified = publishCompleted;
    }
    if (backfillMode) {
      const freshRes = await client.fetchProductsXml();
      if (!freshRes.success || !freshRes.data) {
        throw new Error(`Backfill post-import census failed: ${(freshRes.errors ?? []).join('; ') || 'no live XML'}`);
      }
      const reconciliation = reconcileBackfillImport({
        attemptedSkus: products.map(p => p.sku),
        outgoingXml: xml,
        freshLiveXml: freshRes.data,
      });
      importReconciled = reconciliation.ok
        && reconciliation.imported.length === products.length
        && reconciliation.skipped.length === 0
        && reconciliation.duplicate.length === 0
        && reconciliation.mismatched.length === 0
        && reconciliation.unexpectedNew.length === 0;
      if (!importReconciled) {
        throw new Error(
          `Backfill import not reconciled: imported=${reconciliation.imported.length}/${products.length} ` +
          `skipped=${reconciliation.skipped.length} duplicate=${reconciliation.duplicate.length} ` +
          `mismatched=${reconciliation.mismatched.length} unexpected=${reconciliation.unexpectedNew.length}`,
        );
      }
      const jobDir = path.join(options.workspacePath, 'exports', job.id);
      fs.mkdirSync(jobDir, { recursive: true });
      fs.writeFileSync(
        path.join(jobDir, 'dbupload.cgi.redacted.txt'),
        redactCredentials(uploadResult.rawResponse),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(jobDir, 'dbmake.cgi.redacted.txt'),
        redactCredentials(dbmakeBody ?? 'dbmake skipped: upload reported success immediately; no dbmake request occurred.'),
        'utf-8',
      );
      if (options.publish) {
        fs.writeFileSync(
          path.join(jobDir, 'generate.cgi.redacted.txt'),
          redactCredentials(publishBody ?? 'generate.cgi was not called.'),
          'utf-8',
        );
      }
      addSyncJobEvent({
        syncJobId: job.id,
        level: 'info',
        message: `Backfill import reconciled ${reconciliation.imported.length}/${products.length}; publish ${publishState}.`,
      });
    }
    if (needsFamilyReconcile) {
      const freshRes = await client.fetchProductsXml();
      if (!freshRes.success || !freshRes.data) {
        addSyncJobEvent({
          syncJobId: job.id,
          level: 'warning',
          message: 'Family import outcome is UNKNOWN: fresh live census failed after dbmake. The approved operation stays pending; publish did not run; reconcile before any synced marking.',
        });
        snapshotFamilyPushEvidence(options.workspacePath, job.id, uploadResult.rawResponse, dbmakeBody, null);
        throw new Error('Family import outcome unknown: fresh live census failed after dbmake; the approved operation is retained with unsynced state — reconcile (resume) with the exact approved payload.');
      }
      // Final unchanged-member recheck (#373): an unchanged child deleted or
      // diverged after preflight/pre-upload verification must fail the
      // verdict — matching parent bytes alone never permit synced marking
      // with a dangling family reference. Re-verify the required remote
      // members against the same fresh census the verdict consumes.
      if (pushPlan.requiredRemoteSkus.length > 0) {
        const git = new GitClient(options.workspacePath);
        const expectedBySku: Record<string, BackfillCensusRecord> = {};
        const manifestReads = approvedManifest ? approvedManifest.reads : (linked ? linked.load.manifest.reads : []);
        const commitAnchor = linked ? linked.load.commitHash : '';
        for (const sku of pushPlan.requiredRemoteSkus) {
          const read = manifestReads.find((r) => r.sku === sku);
          if (!read) throw new Error(`Family import not reconciled: unchanged member "${sku}" has no manifest read entry; re-approve the group.`);
          const atCommit = git.readFileAtCommit(commitAnchor, read.filePath);
          if (!atCommit) throw new Error(`Family import not reconciled: unchanged member "${sku}" is missing at approved commit ${commitAnchor.slice(0, 12)}; the group is stale — re-approve.`);
          const commitProduct: Product = JSON.parse(atCommit);
          const expected = expectedCensusRecordFor(commitProduct);
          if (!expected) throw new Error(`Family import not reconciled: unchanged member "${sku}" does not encode to one census record at the approved commit; re-approve.`);
          expectedBySku[sku] = expected;
        }
        const finalRemote = checkRequiredRemoteMembers(pushPlan.requiredRemoteSkus, freshRes.data, expectedBySku).filter((check) => !check.ok);
        if (finalRemote.length > 0) {
          addSyncJobEvent({
            syncJobId: job.id,
            level: 'warning',
            message: `Family import partial: unchanged member(s) failed final verification: ${finalRemote.map((b) => b.reason).join('; ')}. The approved operation stays pending; publish did not run; no SKU is marked synced.`,
            detailsJson: JSON.stringify({ finalRemote }),
          });
          snapshotFamilyPushEvidence(options.workspacePath, job.id, uploadResult.rawResponse, dbmakeBody, null);
          throw new Error(`Family import not reconciled: ${finalRemote.map((b) => b.reason).join('; ')}. The complete approved operation is retained with unsynced state — resolve, then resume with the exact approved payload.`);
        }
      }
      familyReconciliation = reconcileFamilyPushImport({
        attemptedSkus: pushPlan.skus,
        outgoingXml: xml,
        freshLiveXml: freshRes.data,
        baselineSkus,
      });
      if (!familyReconciliation.ok) {
        snapshotFamilyPushEvidence(options.workspacePath, job.id, uploadResult.rawResponse, dbmakeBody, options.publish ? publishBody : null);
        addSyncJobEvent({
          syncJobId: job.id,
          level: 'warning',
          message: `Family import NOT reconciled: ${familyReconciliation.summary}. The complete approved operation stays unsynced — resolve, then resume with the exact approved payload.`,
          detailsJson: JSON.stringify({ imported: familyReconciliation.imported, skipped: familyReconciliation.skipped, duplicate: familyReconciliation.duplicate, mismatched: familyReconciliation.mismatched, unexpectedNew: familyReconciliation.unexpectedNew }),
        });
        throw new Error(`Family import not reconciled: ${familyReconciliation.summary}. The complete approved operation is retained with unsynced state — resolve, then resume with the exact approved payload.`);
      }
      // Publish runs AFTER the reconcile verdict: only a fully reconciled
      // complete set publishes (a partial/unknown import never regenerates
      // the storefront). Unknown-verdict throws below gate publish too.
      if (familyReconciliation.ok) {
        await runPublish();
      }
      publishState = options.publish ? (publishCompleted ? 'published_verified' : 'pending') : 'skipped';
      snapshotFamilyPushEvidence(options.workspacePath, job.id, uploadResult.rawResponse, dbmakeBody, options.publish ? publishBody : null);
      addSyncJobEvent({
        syncJobId: job.id,
        level: 'info',
        message: `Family import reconciled ${familyReconciliation.imported.length}/${pushPlan.skus.length}; publish ${publishState}.`,
        detailsJson: JSON.stringify({ imported: familyReconciliation.imported }),
      });
    }
    // Synced marking is gated on the reconcile verdict: only a fully
    // reconciled complete set advances sync pointers. Family mode marks
    // `synced` for exactly the reconciled set (which equals the complete
    // approved set by construction); anything else leaves every pointer
    // untouched. Unrelated fields/prices/inventory/rights/enablement change
    // only through their owning approved operation — this path writes sync
    // pointers and nothing else.
    const syncedAt = new Date().toISOString();
    // The synced pointer IS the census verdict content: parse the reconciled
    // upload bytes through the same backfill census parser the verdict used,
    // so the pointer equals what the census literally verified live. If the
    // bytes do not parse to exactly one record per pushed SKU (impossible —
    // the verdict just verified them), refuse synced marking instead of
    // falling back to a different canonicalization.
    const syncedCensusSkus: Record<string, true> = {};
    if (needsFamilyReconcile && familyReconciliation) {
      const census = parseBackfillCensusXml(xml);
      if (census.ok) {
        for (const record of census.records) {
          if (record.sku) syncedCensusSkus[record.sku] = true;
        }
      }
      if ([...familyReconciliation.imported].sort().join('\0') !== Object.keys(syncedCensusSkus).sort().join('\0')) {
        throw new Error('Family import reconciled but the synced-pointer census no longer resolves; the approved operation stays unsynced — reconcile again before any synced marking.');
      }
    }
    for (const product of products) {
      // Canonical comparison value owned by the import/check slice (#252,
      // integrated here for #256): a successful push means the live store now
      // matches the approved catalog, so the remote-observation pointer
      // (lastPulledRemoteHash), the successful-sync pointer
      // (lastSyncedRemoteHash), and the cached comparison (productHash) all
      // speak the same canonical language drift checking reads. This is a
      // genuine successful sync (not an approval-only local change), so
      // advancing both pointers here is correct. Backfill mode marks
      // import_reconciled instead of synced (publish state stays explicit).
      const canonicalHash = comparisonHashForProduct(product);
      if (needsFamilyReconcile && !syncedCensusSkus[product.sku]) continue;
      updateProductIndex({
        sku: product.sku,
        productHash: canonicalHash,
        syncStatus: backfillMode ? 'import_reconciled' : 'synced',
        lastSyncedAt: syncedAt,
        lastSyncedRemoteHash: canonicalHash,
        lastPulledRemoteHash: canonicalHash,
      });
    }
    addSyncJobEvent({ syncJobId: job.id, level: 'info', message: `Marked ${products.length} product(s) as ${backfillMode ? 'import_reconciled' : 'synced'}.` });

    completeSyncJob(job.id, backfillMode ? 'import_reconciled' : 'succeeded', { productCount: products.length });

    addAuditLog({
      workspaceId: options.workspaceId,
      entityType: 'change_set',
      entityId: options.changeSetId,
      action: options.publish ? 'push_publish' : 'upload_only',
      message: `${options.publish ? 'Direct push & publish' : 'Upload-only'} completed for ${products.length} product(s)`,
      detailsJson: JSON.stringify({
        productSkus: products.map(p => p.sku),
        publishStatus: options.publish ? (publishCompleted ? 'published' : 'imported_only') : 'skipped',
        pushPayloadHash: pushPlan.payloadHash,
        pushSkus: pushPlan.skus,
        ...(familyReconciliation ? { familyReconciliation: familyReconciliation.summary } : {}),
      }),
    });

    return {
      status: 200,
      body: {
        success: true,
        jobId: job.id,
        productCount: products.length,
        publishCompleted,
        zipPath,
        pushPayloadHash: pushPlan.payloadHash,
        pushSkus: pushPlan.skus,
        ...(familyReconciliation ? { familyReconciled: familyReconciliation.ok, familyReconciliation: familyReconciliation.summary } : {}),
        warnings: options.publish && !publishCompleted ? ['Storefront generation may need retry.'] : [],
        ...(backfillMode ? { importReconciled, publishState, publishVerified } : {}),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addSyncJobEvent({ syncJobId: job.id, level: 'error', message: redactCredentials(msg) });
    completeSyncJob(job.id, 'failed', { errorSummary: redactCredentials(msg) });
    return { status: 500, body: { error: redactCredentials(msg), jobId: job.id } };
  }
}

/**
 * POST /api/sync/push-publish
 * Directly push an approved change set: dbupload -> dbmake -> reconcile
 * census -> generate.cgi only on a reconciled success (family mode).
 */
route.post('/sync/push-publish', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const body = await c.req.json().catch(() => ({})) as { changeSetId?: string; backfillMode?: boolean };
  if (!body.changeSetId) return c.json({ error: 'changeSetId is required.' }, 400);

  const result = await runDirectSync({
    workspaceId: workspace.id,
    workspacePath: workspace.workspacePath,
    changeSetId: body.changeSetId,
    publish: true,
    backfillMode: body.backfillMode === true,
  });
  return c.json(result.body, result.status as 200 | 400 | 409 | 500);
});

/**
 * POST /api/sync/upload-only
 * Upload and dbmake only, skip generate.cgi.
 */
route.post('/sync/upload-only', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const body = await c.req.json().catch(() => ({})) as { changeSetId?: string; backfillMode?: boolean };
  if (!body.changeSetId) return c.json({ error: 'changeSetId is required.' }, 400);

  const result = await runDirectSync({
    workspaceId: workspace.id,
    workspacePath: workspace.workspacePath,
    changeSetId: body.changeSetId,
    publish: false,
    backfillMode: body.backfillMode === true,
  });

  if (result.status === 200) {
    result.body.warning = 'Products imported. Changes may not be visible until storefront is published/regenerated.';
  }
  return c.json(result.body, result.status as 200 | 400 | 409 | 500);
});

/**
 * POST /api/sync/resume-push
 * Idempotent resume for an interrupted family push (issue #373): replays
 * the EXACT approved payload/identity (same commit, same payload hash) by
 * running the normal push path again. The push plan is deterministic over
 * the immutable load plus current Pages state, so a resume under unchanged
 * Pages transmits byte-identical XML; the reconcile verdict then records the
 * actual remote outcome. Never invents replacement SKUs/parents; never marks
 * a subset synced.
 *
 * Backfill mode is refused here: a family resume uploads newRecords=yes
 * (new children must be creatable), while backfill uploads update-only
 * (newRecords=no) — resuming a family set in backfill mode would silently
 * drop new children.
 */
route.post('/sync/resume-push', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const body = await c.req.json().catch(() => ({})) as { changeSetId?: string; publish?: boolean; backfillMode?: boolean };
  if (!body.changeSetId) return c.json({ error: 'changeSetId is required.' }, 400);
  if (body.backfillMode === true) {
    return c.json({ error: 'resume-push refuses backfill mode: a family resume must upload newRecords=yes so new children are created (backfill update-only would silently drop them).' }, 400);
  }
  const result = await runDirectSync({
    workspaceId: workspace.id,
    workspacePath: workspace.workspacePath,
    changeSetId: body.changeSetId,
    publish: body.publish !== false,
    resumedFrom: true,
  });
  if (result.status === 200) {
    result.body.resumed = true;
  }
  return c.json(result.body, result.status as 200 | 400 | 409 | 500);
});

/**
 * POST /api/sync/reconcile-push
 * Re-check an interrupted/unknown family push WITHOUT retransmitting
 * (issue #373): fetches a fresh live census and replays the reconcile
 * verdict against the recorded outgoing payload. When the recorded outcome
 * already reconciles, marks exactly the reconciled complete set synced.
 * Read-only against the remote except the census fetch; never uploads.
 *
 * Gap 5: the push path's drift and staleness gates run here too — a worktree
 * edit or unresolved drift landing between the failed push and the reconcile
 * refuses instead of marking a moved-on catalog synced.
 * Gap 1: the verdict scopes `unexpectedNew` against the originating push
 * job's pre-upload census baseline (recorded in its job events), so
 * pre-existing store SKUs outside the pushed set never fail the reconcile.
 * Without a recorded baseline the outcome is unknowable — reconcile refuses
 * and the operator resumes (retransmit captures a fresh baseline).
 */
route.post('/sync/reconcile-push', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const body = await c.req.json().catch(() => ({})) as { changeSetId?: string; jobId?: string };
  if (!body.changeSetId) return c.json({ error: 'changeSetId is required.' }, 400);

  const config = getConnectionConfig(workspace.id);
  if (!config) {
    return c.json({ error: 'ShopSite connection not configured. Use Export Package instead.' }, 400);
  }
  const linked = loadApprovedLinkedExport(body.changeSetId, workspace.workspacePath);
  if (!linked.ok) {
    return c.json({ error: linked.error }, (linked.incomplete ? 409 : 400));
  }
  let pushPlan: FamilyPushSetPlan;
  try {
    pushPlan = planFamilyPushSet(linked.load.products, linked.load.manifest);
  } catch (planErr) {
    return c.json({ error: planErr instanceof Error ? planErr.message : String(planErr) }, 409);
  }
  // Gap 5: match the push path — unresolved drift or a worktree edit that
  // landed after the failed push refuses before any synced marking. Pages
  // state moved on is the same refusal: re-derive the page-reconciled bytes
  // against the CURRENT active import, and fail closed when the import moved.
  const reconcileDriftSku = ensureNoOpenDrift(workspace.id, [...linked.load.manifest.writes.map((w) => ({ sku: w.sku })), ...linked.load.manifest.reads.map((r) => ({ sku: r.sku }))]);
  if (reconcileDriftSku) {
    return c.json({ error: `Cannot reconcile SKU "${reconcileDriftSku}": unresolved remote drift exists. Resolve drift first.` }, 409);
  }
  // Publication-time competing-draft recheck: a foreign draft created after
  // the failed push leaves committed files unchanged, so reconciliation
  // reuses the same conflict query over the manifest SKU scope.
  try {
    const reconcileScope: Record<string, true> = {};
    for (const w of linked.load.manifest.writes) reconcileScope[w.sku] = true;
    for (const r of linked.load.manifest.reads) reconcileScope[r.sku] = true;
    const conflicts = listConflictingDraftChangeSets(workspace.id, Object.keys(reconcileScope).sort(), body.changeSetId);
    if (conflicts.length > 0) {
      const first = conflicts[0]!;
      return c.json({ error: `Cannot reconcile SKU "${first.sku}": also staged in change set ${first.changeSetId.slice(0, 8)} (status "${first.status}"); resolve the competing draft before reconciling.` }, 409);
    }
  } catch (err) {
    return c.json({ error: `Competing-draft check could not complete (${err instanceof Error ? err.message : String(err)}); resolve before reconciling.` }, 409);
  }
  const reconcileStaleness = checkFamilyPushStaleness(workspace.workspacePath, linked.load.commitHash, linked.load.manifest);
  if (!reconcileStaleness.ok) {
    return c.json({ error: reconcileStaleness.error, stale: true }, 409);
  }
  // Gap 1: recover the originating push job's pre-upload census baseline so
  // pre-existing store SKUs never fail the verdict. Scoped to the SAME change
  // set's push jobs (prefer the explicit jobId); without one the outcome is
  // unknowable — reconcile refuses and the operator resumes.
  const baselineSkus = findFamilyPushBaseline(workspace.id, body.changeSetId, body.jobId ?? null);
  if (baselineSkus === null) {
    return c.json({ error: 'Reconcile has no recorded pre-upload census baseline for this same change set; the outcome is unknowable on a populated store — resume-push to retransmit the exact approved payload (captures a fresh baseline).' }, 409);
  }
  // Recovery binds to the originating payload identity: reconcile verifies
  // ONLY the exact bytes the originating push uploaded (explicit jobId
  // ownership-checked, else the latest same-change-set push job). The Pages
  // import hash recorded at push must still be active — a stable-ID page
  // rename moves the import and changes the bytes, so reconcile refuses and
  // the operator resumes (fresh payload + fresh baseline) instead of
  // verifying moved-on bytes.
  const origin = findOriginPushPayload(workspace.id, body.changeSetId, body.jobId ?? null);
  if (origin === null) {
    return c.json({ error: 'Reconcile has no recorded originating payload for this same change set; the upload bytes are unknowable — resume-push to retransmit the exact approved payload (captures a fresh baseline).' }, 409);
  }
  const activePagesHash = getActivePageImportHash(workspace.id) ?? '__none__';
  if (activePagesHash !== origin.pagesSourceHash) {
    return c.json({ error: `Reconcile refused: ShopSite Pages changed since the originating push (import ${origin.pagesSourceHash.slice(0, 12)} -> ${activePagesHash.slice(0, 12)}); resume-push to retransmit the current approved payload instead of verifying moved-on bytes.` }, 409);
  }
  let reconciledProducts: typeof linked.load.products;
  try {
    reconciledProducts = reconcileProductsToActivePages(workspace.id, origin.pagesSourceHash, linked.load.products.map((p) => JSON.parse(JSON.stringify(p))));
  } catch (pagesErr) {
    return c.json({ error: pagesErr instanceof Error ? pagesErr.message : String(pagesErr) }, 409);
  }
  const xml = encodeFamilyPushXml(reconciledProducts, pushPlan);
  const reconciledHash = sha256Hex(xml);
  if (reconciledHash !== origin.payloadHash) {
    return c.json({ error: `Reconcile refused: recomputed payload ${reconciledHash.slice(0, 12)} differs from the originating push ${origin.payloadHash.slice(0, 12)}; the approved catalog moved on — resume-push to retransmit instead of verifying moved-on bytes.` }, 409);
  }
  const client = new ShopSiteHttpClient({
    cgiBaseUrl: config.cgiBaseUrl,
    merchantId: config.merchantId,
    password: config.password,
  });
  const freshRes = await client.fetchProductsXml();
  if (!freshRes.success || !freshRes.data) {
    return c.json({ error: `Reconcile census failed: ${(freshRes.errors ?? []).join('; ') || 'no live XML'}. The approved operation stays pending; retry reconcile.` }, 500);
  }
  // Final unchanged-member recheck in recovery too: validate the required
  // remote members against the same fresh census the verdict consumes, so a
  // child deleted or diverged after the failed push withholds synced
  // marking here as well as in the direct push path.
  if (pushPlan.requiredRemoteSkus.length > 0) {
    const readGit = new GitClient(workspace.workspacePath);
    const expectedBySku: Record<string, BackfillCensusRecord> = {};
    for (const sku of pushPlan.requiredRemoteSkus) {
      const read = linked.load.manifest.reads.find((r) => r.sku === sku);
      if (!read) return c.json({ error: `Reconcile refused: unchanged member "${sku}" has no manifest read entry; the approved operation is stale — re-approve.` }, 409);
      const atCommit = readGit.readFileAtCommit(linked.load.commitHash, read.filePath);
      if (!atCommit) return c.json({ error: `Reconcile refused: unchanged member "${sku}" is missing at approved commit ${linked.load.commitHash.slice(0, 12)}; the group is stale — re-approve.` }, 409);
      const commitProduct: Product = JSON.parse(atCommit);
      const expected = expectedCensusRecordFor(commitProduct);
      if (!expected) return c.json({ error: `Reconcile refused: unchanged member "${sku}" does not encode to one census record at the approved commit; re-approve.` }, 409);
      expectedBySku[sku] = expected;
    }
    const staleRemote = checkRequiredRemoteMembers(pushPlan.requiredRemoteSkus, freshRes.data, expectedBySku).filter((check) => !check.ok);
    if (staleRemote.length > 0) {
      return c.json({ error: `Reconcile refused: ${staleRemote.map((b) => b.reason).join('; ')}. The approved operation stays unsynced — resolve, then resume with the exact approved payload.` }, 409);
    }
  }
  const verdict = reconcileFamilyPushImport({
    attemptedSkus: pushPlan.skus,
    outgoingXml: xml,
    freshLiveXml: freshRes.data,
    baselineSkus,
  });
  const job = createSyncJob({
    workspaceId: workspace.id,
    changeSetId: body.changeSetId,
    kind: 'reconcile_push',
    metadataJson: JSON.stringify({ reconciledJobId: body.jobId ?? null, pushPayloadHash: reconciledHash }),
  });
  addSyncJobEvent({
    syncJobId: job.id,
    level: verdict.ok ? 'info' : 'warning',
    message: verdict.ok
      ? `Reconcile verified the complete family set (${verdict.imported.length}/${pushPlan.skus.length}).`
      : `Reconcile still pending: ${verdict.summary}. The approved operation stays unsynced; resume to retransmit.`,
    detailsJson: JSON.stringify({ ...verdict, pushPayloadHash: reconciledHash }),
  });
  if (!verdict.ok) {
    completeSyncJob(job.id, 'failed', { errorSummary: verdict.summary, productCount: pushPlan.skus.length });
    return c.json({ success: false, jobId: job.id, reconciled: false, summary: verdict.summary, verdict }, 409);
  }
  const syncedAt = new Date().toISOString();
  for (const sku of verdict.imported) {
    const product = reconciledProducts.find((p) => p.sku === sku);
    if (!product) continue;
    // Sync pointers advance from the reconciled representation the verdict
    // just verified — same canonical hash function as the direct push path.
    const canonicalHash = comparisonHashForProduct(product);
    updateProductIndex({
      sku,
      productHash: canonicalHash,
      syncStatus: 'synced',
      lastSyncedAt: syncedAt,
      lastSyncedRemoteHash: canonicalHash,
      lastPulledRemoteHash: canonicalHash,
    });
  }
  completeSyncJob(job.id, 'succeeded', { productCount: verdict.imported.length });
  addAuditLog({
    workspaceId: workspace.id,
    entityType: 'change_set',
    entityId: body.changeSetId,
    action: 'reconcile_push',
    message: `Reconcile verified the complete family set (${verdict.imported.length} product(s)) without retransmit`,
    detailsJson: JSON.stringify({ productSkus: verdict.imported, pushPayloadHash: reconciledHash }),
  });
  return c.json({ success: true, jobId: job.id, reconciled: true, summary: verdict.summary, verdict });
});

/**
 * GET /api/sync/jobs - List sync jobs.
 */
route.get('/sync/jobs', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const jobs = listSyncJobs(workspace.id);
  return c.json({ jobs });
});

/**
 * GET /api/sync/jobs/:id - Job detail with events.
 */
route.get('/sync/jobs/:id', (c) => {
  const id = c.req.param('id');
  const job = findSyncJobById(id);
  if (!job) return c.json({ error: 'Sync job not found.' }, 404);
  const events = listSyncJobEvents(id);
  return c.json({ job, events });
});

/**
 * POST /api/sync/full-reconcile - Maintenance full reconcile/rebuild.
 * Re-indexes from approved product files.
 */
route.post('/sync/full-reconcile', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const job = createSyncJob({ workspaceId: workspace.id, kind: 'full_reconcile' });
  addSyncJobEvent({ syncJobId: job.id, level: 'info', message: 'Starting full reconcile...' });

  try {
    const productDir = path.join(workspace.workspacePath, 'products');
    let reindexedCount = 0;
    const errors: string[] = [];

    // Clear existing index for full rebuild
    getDb().run('DELETE FROM product_index');
    getDb().run('DELETE FROM product_pages');

    if (fs.existsSync(productDir)) {
      const files = fs.readdirSync(productDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const content = fs.readFileSync(path.join(productDir, file), 'utf-8');
          const product = JSON.parse(content) as Product;
          // Canonical comparison value owned by the import/check slice (#256):
          // maintenance reindex rebuilds the cached comparison from approved
          // catalog files only. Historical remote equality is never inferred
          // from current local products, so reindexed rows stay in the
          // explicit unverified pending-recheck state (not_synced with null
          // remote/sync pointers) rather than a manufactured synced or
          // drifted status. The next drift check repopulates observation.
          const productHash = comparisonHashForProduct(product);
          const existing = findProductBySku(product.sku);
          const fields = {
            sku: product.sku,
            title: product.core.name,
            status: product.status,
            price: product.core.price,
            inventoryQuantity: product.core.inventory.quantityOnHand,
            primaryImage: product.core.media.primary,
            productHash,
            hasAdvancedBlocks: Object.keys(product.shopsite.preserved.advancedBlocks).length > 0 ? 1 : 0,
            hasWarnings: 0,
            syncStatus: 'not_synced',
            description: product.core.description,
            searchKeywords: product.core.seo.searchKeywords,
            customFields: product.customFields,
          };
          if (existing) {
            updateProductIndex(fields);
          } else {
            insertProductIndex({
              id: product.id,
              filePath: skuToProductFilePath(product.sku),
              lastApprovedCommit: null,
              lastPulledRemoteHash: null,
              lastSyncedRemoteHash: null,
              lastSyncedAt: null,
              createdAt: product.metadata.createdAt,
              updatedAt: product.metadata.updatedAt,
              ...fields,
            });
          }

          // Index ProductOnPages into product_pages so category page counts reflect real ShopSite data
          indexProductPageAssignments(product);

          reindexedCount++;
        } catch (err) {
          const msg = `Failed to reindex ${file}: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          addSyncJobEvent({ syncJobId: job.id, level: 'warning', message: msg });
        }
      }
    }

    completeSyncJob(job.id, 'succeeded', { productCount: reindexedCount });
    addSyncJobEvent({ syncJobId: job.id, level: 'info', message: `Full reconcile complete: ${reindexedCount} products reindexed.` });

    // Sync field_registry with any newly discovered ProductField keys.
    syncFieldRegistryFromProductIndex(workspace.id, workspace.workspacePath);

    return c.json({ success: true, jobId: job.id, reindexedCount, errors: errors.length > 0 ? errors : undefined });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addSyncJobEvent({ syncJobId: job.id, level: 'error', message: msg });
    completeSyncJob(job.id, 'failed', { errorSummary: msg });
    return c.json({ error: msg, jobId: job.id }, 500);
  }
});

/**
 * POST /api/sync/canonical-backfill - Rebuild stale comparison caches.
 * Body: { batchSize?, maxBatches? }
 *
 * Drift 3b (#256): resumable (loop until remaining is 0 and complete is
 * true) and repeat-safe (already-canonical rows are no-ops). Rebuilds
 * product_hash from pinned approved HEAD data only; stale rows move to the
 * explicit unverified pending-recheck state (not_synced, null sync
 * pointers) rather than manufactured synced/drifted. Missing sources stay
 * unverified. Never touches classification hashes.
 */
route.post('/sync/canonical-backfill', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const body = (await c.req.json().catch(() => ({}))) as {
    batchSize?: unknown;
    maxBatches?: unknown;
  };
  try {
    const { runCanonicalComparisonBackfill } = await import('../../shopsite/canonical-comparison-backfill');
    const result = runCanonicalComparisonBackfill(workspace.id, workspace.workspacePath, {
      batchSize: body.batchSize as number | undefined,
      maxBatches: body.maxBatches as number | undefined,
    });
    return c.json({ success: true, ...result });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, status as 400);
  }
});

/**
 * GET /api/sync/canonical-backfill - Backfill progress snapshot.
 */
route.get('/sync/canonical-backfill', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const { getCanonicalBackfillProgress } = await import('../../shopsite/canonical-comparison-backfill');
  return c.json({ success: true, ...getCanonicalBackfillProgress(workspace.id) });
});

export default route;
