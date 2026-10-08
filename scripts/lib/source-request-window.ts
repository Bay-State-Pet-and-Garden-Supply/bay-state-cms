/**
 * Immutable bounded source-request window for prospective product-source capture.
 *
 * One owned window (max 1200) is shared by every collector invocation and by the
 * separately scoped enrichment runner. Every actual HTTP request — sitemap, feed,
 * page, enrich, each redirect hop, each retry, each network error — MUST reserve
 * a numbered seq BEFORE transport. Reservations are conservatively spent: a crash
 * between reserve and outcome still counts. Total reservations across all runs,
 * workers, processes and resumes can never exceed the allocation.
 *
 * Private: windowDir holds raw URLs (reservations/outcomes). Public receipts
 * derived via buildPublicWindowLedger/buildPublicSourceReceipt carry URL SHA-256
 * only, never raw held URLs.
 *
 * No network, no credentials, no private-custody reads. Fail closed on corrupt /
 * malformed receipts, allocation disagreement, exhaustion and symlink / public-doc
 * window paths.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Approved upper bound for one owned source window (owner decision). */
export const SOURCE_WINDOW_MAX = 1200;

/** Every request kind shares the same window; no side channels. */
export const SOURCE_REQUEST_KINDS = ['sitemap', 'feed', 'page', 'enrich'] as const;
export type SourceRequestKind = (typeof SOURCE_REQUEST_KINDS)[number];

const ALLOCATION_VERSION = 'source-request-window/v1';
const HEX64_RE = /^[0-9a-f]{64}$/;
const SEQ_FILE_RE = /^(\d{6})\.json$/;

export class SourceWindowExhaustedError extends Error {
  readonly code = 'source_window_exhausted';
  readonly spent: number;
  readonly max: number;
  constructor(spent: number, max: number) {
    super(`source_window_exhausted: window spent ${spent}/${max}; refusing before transport (no refund)`);
    this.name = 'SourceWindowExhaustedError';
    this.spent = spent;
    this.max = max;
  }
}

export interface CreateSourceWindowOptions {
  windowDir: string;
  ownerDecisionSha256: string;
  authorityHash: string;
  maxHttpAttempts?: number;
  windowId?: string;
}

export interface OpenSourceWindowOptions {
  windowDir: string;
  expectedOwnerDecisionSha256: string;
  expectedAuthorityHash: string;
  expectedMaxHttpAttempts: number;
}

export interface SourceWindowHandle {
  windowDir: string;
  windowId: string;
  maxHttpAttempts: number;
  ownerDecisionSha256: string;
  authorityHash: string;
}

export interface ReserveSourceRequestOptions {
  url: string;
  kind: SourceRequestKind;
  worker?: string;
}

export interface SourceReservationReceipt {
  seq: number;
  urlSha256: string;
}

export interface RecordSourceOutcomeOptions {
  status: number | string;
  finalUrl?: string;
  error?: string;
  bytes?: number;
}

export interface SourceWindowUsage {
  spent: number;
  remaining: number;
  max: number;
  windowId: string;
  ownerDecisionSha256: string;
  authorityHash: string;
}

export interface PublicSourceReceipt {
  seq: number;
  urlSha256: string;
  kind: SourceRequestKind;
  worker: string | null;
  at: string;
  status: number | string | null;
  finalUrlSha256: string | null;
  error: string | null;
  bytes: number | null;
  outcomeMissing: boolean;
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

function assertHex64(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HEX64_RE.test(value)) {
    fail('source_window_corrupt', `${field} must be 64-char lowercase hex`);
  }
  return value as string;
}

function rejectPublicDocsWindow(resolvedWindowDir: string): void {
  const docsRoot = path.resolve('docs');
  if (resolvedWindowDir === docsRoot || resolvedWindowDir.startsWith(`${docsRoot}${path.sep}`)) {
    fail('source_window_private_path_required', 'windowDir holds raw URLs and must not live under public docs/');
  }
}

function assertNotSymlink(p: string, what: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    fail('source_window_missing', `${what} does not exist: ${p}`);
  }
  if ((st as fs.Stats).isSymbolicLink()) {
    fail('source_window_symlink_rejected', `${what} must not be a symlink: ${p}`);
  }
}

function readJsonFile(p: string, what: string): unknown {
  assertNotSymlink(p, what);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (e) {
    fail('source_window_missing', `cannot read ${what}: ${p}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return JSON.parse(raw as string);
  } catch (e) {
    fail('source_window_corrupt', `cannot parse ${what}: ${p}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function writeExclusiveJson(p: string, value: unknown): void {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  try {
    fs.writeFileSync(p, bytes, { flag: 'wx', mode: 0o600 });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST') {
      fail('source_window_immutable', `refusing to overwrite sealed receipt: ${p}`);
    }
    throw e;
  }
}

function seqFileName(seq: number): string {
  return `${String(seq).padStart(6, '0')}.json`;
}

function sleepMs(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* fallback spin */ }
  }
}

function withWindowLock<T>(windowDir: string, fn: () => T): T {
  const lockDir = path.join(windowDir, '.lock');
  const STALE_MS = 30_000;
  const ATTEMPTS = 400;
  let acquired = false;
  for (let i = 0; i < ATTEMPTS && !acquired; i++) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      acquired = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > STALE_MS) {
          try { fs.rmdirSync(lockDir); } catch { /* raced with a live holder; retry */ }
        }
      } catch { /* lock vanished between stat and use; retry */ }
      if (i < ATTEMPTS - 1) sleepMs(5);
    }
  }
  if (!acquired) {
    fail('source_window_lock_busy', `could not acquire window lock after ${ATTEMPTS} tries: ${lockDir}`);
  }
  try {
    return fn();
  } finally {
    try { fs.rmdirSync(lockDir); } catch { /* best-effort release */ }
  }
}

function listSeqFiles(dir: string, what: string): number[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    fail('source_window_corrupt', `cannot list ${what}: ${dir}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const seqs: number[] = [];
  for (const name of names as string[]) {
    const m = SEQ_FILE_RE.exec(name);
    if (!m) {
      fail('source_window_corrupt', `unexpected file in ${what}: ${dir}/${name}`);
    }
    const full = path.join(dir, name);
    try {
      if (fs.lstatSync(full).isSymbolicLink()) {
        fail('source_window_symlink_rejected', `${what} receipt must not be a symlink: ${full}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('source_window_')) throw e;
      fail('source_window_corrupt', `cannot stat ${what} receipt: ${full}`);
    }
    seqs.push(Number(m[1]));
  }
  seqs.sort((a, b) => a - b);
  return seqs;
}

function validateReservationFile(window: SourceWindowHandle, file: string, seq: number): { urlSha256: string; kind: SourceRequestKind; worker: string | null; at: string } {
  const parsed = readJsonFile(file, 'reservation receipt') as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('source_window_corrupt', `reservation ${seq} is not an object: ${file}`);
  }
  if (parsed.seq !== seq) fail('source_window_corrupt', `reservation seq mismatch in ${file}`);
  if (parsed.windowId !== window.windowId) fail('source_window_corrupt', `reservation ${seq} windowId mismatch: ${file}`);
  if (typeof parsed.url !== 'string' || !parsed.url.startsWith('https://')) {
    fail('source_window_corrupt', `reservation ${seq} url must be https: ${file}`);
  }
  const urlSha256 = assertHex64(parsed.urlSha256, `reservation ${seq} urlSha256`);
  if (hashSourceUrlForReceipt(parsed.url) !== urlSha256) {
    fail('source_window_corrupt', `reservation ${seq} urlSha256 does not match url: ${file}`);
  }
  if (!SOURCE_REQUEST_KINDS.includes(parsed.kind as SourceRequestKind)) {
    fail('source_window_corrupt', `reservation ${seq} has unknown kind: ${file}`);
  }
  if (typeof parsed.at !== 'string' || !parsed.at) {
    fail('source_window_corrupt', `reservation ${seq} lacks at timestamp: ${file}`);
  }
  const worker = parsed.worker == null ? null : String(parsed.worker);
  return { urlSha256, kind: parsed.kind as SourceRequestKind, worker, at: String(parsed.at) };
}

function validateOutcomeFile(window: SourceWindowHandle, file: string, seq: number, expectedUrlSha256: string): { status: number | string; finalUrlSha256: string | null; error: string | null; bytes: number | null } {
  const parsed = readJsonFile(file, 'outcome receipt') as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('source_window_corrupt', `outcome ${seq} is not an object: ${file}`);
  }
  if (parsed.seq !== seq) fail('source_window_corrupt', `outcome seq mismatch in ${file}`);
  if (parsed.windowId !== window.windowId) fail('source_window_corrupt', `outcome ${seq} windowId mismatch: ${file}`);
  if (parsed.urlSha256 !== expectedUrlSha256) {
    fail('source_window_corrupt', `outcome ${seq} urlSha256 does not match reservation: ${file}`);
  }
  const status = parsed.status;
  if (typeof status !== 'number' && typeof status !== 'string') {
    fail('source_window_corrupt', `outcome ${seq} lacks a numeric/string status: ${file}`);
  }
  let finalUrlSha256: string | null = null;
  if (parsed.finalUrlSha256 != null) {
    finalUrlSha256 = assertHex64(parsed.finalUrlSha256, `outcome ${seq} finalUrlSha256`);
  }
  const error = parsed.error == null ? null : String(parsed.error);
  const bytes = parsed.bytes == null ? null : Number(parsed.bytes);
  if (bytes != null && (!Number.isSafeInteger(bytes) || bytes < 0)) {
    fail('source_window_corrupt', `outcome ${seq} has invalid bytes: ${file}`);
  }
  return { status: status as number | string, finalUrlSha256, error, bytes };
}

/** SHA-256 hex of a source URL for sanitized public receipts (never the raw URL). */
export function hashSourceUrlForReceipt(url: string): string {
  return crypto.createHash('sha256').update(url, 'utf8').digest('hex');
}

/** SHA-256 hex of the exact owner-decision file bytes (allocation binding). */
export function computeOwnerDecisionSha256(ownerDecisionsPath: string): string {
  assertNotSymlink(ownerDecisionsPath, 'owner decisions file');
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(ownerDecisionsPath);
  } catch (e) {
    fail('source_window_missing', `cannot read owner decisions: ${ownerDecisionsPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return crypto.createHash('sha256').update(bytes as Buffer).digest('hex');
}

/**
 * Per-invocation cap parsing: default = remaining window, never above remaining
 * and never above SOURCE_WINDOW_MAX. A second worker/process/resume opens the
 * same window and sees the same remaining — it can never reset the window.
 */
export function parseInvocationCap(raw: string | null, remaining: number): number {
  if (!Number.isSafeInteger(remaining) || remaining < 0 || remaining > SOURCE_WINDOW_MAX) {
    fail('source_window_corrupt', `remaining must be an integer in [0, ${SOURCE_WINDOW_MAX}]`);
  }
  if (remaining === 0) {
    throw new SourceWindowExhaustedError(SOURCE_WINDOW_MAX, SOURCE_WINDOW_MAX);
  }
  if (raw == null) return remaining;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`invalid_attempt_cap: "${raw}" must be a positive integer`);
  }
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1 || n > SOURCE_WINDOW_MAX) {
    throw new Error(`invalid_attempt_cap: "${raw}" must be an integer in [1, ${SOURCE_WINDOW_MAX}]`);
  }
  if (n > remaining) {
    throw new Error(`invalid_attempt_cap: "${raw}" exceeds remaining window ${remaining}`);
  }
  return n;
}

/**
 * Create one owned window exactly once (Main, after planner + reviewer, before any
 * capture). O_EXCL immutable: refusing to overwrite an existing allocation.
 */
export function createSourceWindow(options: CreateSourceWindowOptions): SourceWindowHandle {
  const maxHttpAttempts = options.maxHttpAttempts ?? SOURCE_WINDOW_MAX;
  if (!Number.isSafeInteger(maxHttpAttempts) || maxHttpAttempts < 1 || maxHttpAttempts > SOURCE_WINDOW_MAX) {
    fail('source_window_invalid_allocation', `maxHttpAttempts must be an integer in [1, ${SOURCE_WINDOW_MAX}]`);
  }
  const ownerDecisionSha256 = assertHex64(options.ownerDecisionSha256, 'ownerDecisionSha256');
  const authorityHash = assertHex64(options.authorityHash, 'authorityHash');
  if (typeof options.windowDir !== 'string' || !options.windowDir) {
    fail('source_window_invalid_allocation', 'windowDir must be a non-empty path');
  }
  const resolved = path.resolve(options.windowDir);
  rejectPublicDocsWindow(resolved);
  try {
    if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
      fail('source_window_symlink_rejected', `windowDir must not be a symlink: ${resolved}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('source_window_')) throw e;
    throw e;
  }
  const windowId = options.windowId ?? `srcwin-${ownerDecisionSha256.slice(0, 12)}-${authorityHash.slice(0, 12)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(windowId)) {
    fail('source_window_invalid_allocation', 'windowId must be [A-Za-z0-9_-]{1,128} starting alnum');
  }
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  assertNotSymlink(resolved, 'windowDir');
  const reservationsDir = path.join(resolved, 'reservations');
  const outcomesDir = path.join(resolved, 'outcomes');
  fs.mkdirSync(reservationsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(outcomesDir, { recursive: true, mode: 0o700 });
  assertNotSymlink(reservationsDir, 'reservations dir');
  assertNotSymlink(outcomesDir, 'outcomes dir');
  const allocationPath = path.join(resolved, 'allocation.json');
  if (fs.existsSync(allocationPath)) {
    fail('source_window_immutable', `allocation already sealed: ${allocationPath}`);
  }
  const allocation = {
    version: ALLOCATION_VERSION,
    windowId,
    maxHttpAttempts,
    ownerDecisionSha256,
    authorityHash,
    createdAt: new Date().toISOString(),
  };
  writeExclusiveJson(allocationPath, allocation);
  return { windowDir: resolved, windowId, maxHttpAttempts, ownerDecisionSha256, authorityHash };
}

/**
 * Open an existing window with exact immutable allocation agreement. Collector and
 * enrichment runner call this (never create). Any binding mismatch, corrupt /
 * malformed receipt, or symlink path fails closed.
 */
export function openSourceWindow(options: OpenSourceWindowOptions): SourceWindowHandle {
  if (typeof options.windowDir !== 'string' || !options.windowDir) {
    fail('source_window_missing', 'windowDir must be a non-empty path');
  }
  const resolved = path.resolve(options.windowDir);
  rejectPublicDocsWindow(resolved);
  assertNotSymlink(resolved, 'windowDir');
  let st: fs.Stats;
  try {
    st = fs.statSync(resolved);
  } catch {
    fail('source_window_missing', `windowDir does not exist: ${resolved}`);
  }
  if (!(st as fs.Stats).isDirectory()) fail('source_window_missing', `windowDir is not a directory: ${resolved}`);
  const allocationPath = path.join(resolved, 'allocation.json');
  const allocation = readJsonFile(allocationPath, 'allocation') as Record<string, unknown>;
  if (!allocation || typeof allocation !== 'object' || Array.isArray(allocation)) {
    fail('source_window_corrupt', `allocation is not an object: ${allocationPath}`);
  }
  if (allocation.version !== ALLOCATION_VERSION) {
    fail('source_window_corrupt', `allocation version must be ${ALLOCATION_VERSION}: ${allocationPath}`);
  }
  if (typeof allocation.windowId !== 'string' || !allocation.windowId) {
    fail('source_window_corrupt', `allocation lacks windowId: ${allocationPath}`);
  }
  if (!Number.isSafeInteger(allocation.maxHttpAttempts) || (allocation.maxHttpAttempts as number) < 1 || (allocation.maxHttpAttempts as number) > SOURCE_WINDOW_MAX) {
    fail('source_window_corrupt', `allocation maxHttpAttempts out of range: ${allocationPath}`);
  }
  const ownerDecisionSha256 = assertHex64(allocation.ownerDecisionSha256, 'allocation ownerDecisionSha256');
  const authorityHash = assertHex64(allocation.authorityHash, 'allocation authorityHash');
  if (ownerDecisionSha256 !== options.expectedOwnerDecisionSha256) {
    fail('source_window_allocation_mismatch', `ownerDecisionSha256 mismatch for ${allocationPath}`);
  }
  if (authorityHash !== options.expectedAuthorityHash) {
    fail('source_window_allocation_mismatch', `authorityHash mismatch for ${allocationPath}`);
  }
  if (allocation.maxHttpAttempts !== options.expectedMaxHttpAttempts) {
    fail('source_window_allocation_mismatch', `maxHttpAttempts mismatch for ${allocationPath}`);
  }
  const reservationsDir = path.join(resolved, 'reservations');
  const outcomesDir = path.join(resolved, 'outcomes');
  assertNotSymlink(reservationsDir, 'reservations dir');
  assertNotSymlink(outcomesDir, 'outcomes dir');
  const handle: SourceWindowHandle = {
    windowDir: resolved,
    windowId: String(allocation.windowId),
    maxHttpAttempts: Number(allocation.maxHttpAttempts),
    ownerDecisionSha256,
    authorityHash,
  };
  // Fail closed on any corrupt existing receipt at open (no silent shrink).
  void getSourceWindowUsage(handle);
  return handle;
}

/**
 * Atomically reserve the next numbered seq BEFORE transport. Cross-process safe
 * via an exclusive lock dir; conservatively spent on crash. Throws
 * SourceWindowExhaustedError at the cap — callers must refuse transport, with no
 * refund and no candidate clipping.
 */
export function reserveSourceRequest(window: SourceWindowHandle, options: ReserveSourceRequestOptions): SourceReservationReceipt {
  if (typeof options.url !== 'string' || !options.url.startsWith('https://')) {
    fail('source_window_invalid_request', 'reserve url must be an https URL');
  }
  if (!SOURCE_REQUEST_KINDS.includes(options.kind)) {
    fail('source_window_invalid_request', `unknown request kind: ${String(options.kind)}`);
  }
  if (options.worker != null && (typeof options.worker !== 'string' || !options.worker || options.worker.length > 200)) {
    fail('source_window_invalid_request', 'worker must be a non-empty string <= 200 chars');
  }
  return withWindowLock(window.windowDir, () => {
    const reservationsDir = path.join(window.windowDir, 'reservations');
    const seqs = listSeqFiles(reservationsDir, 'reservations');
    const spent = seqs.length;
    if (spent >= window.maxHttpAttempts) {
      throw new SourceWindowExhaustedError(spent, window.maxHttpAttempts);
    }
    // Contiguity: seqs must be exactly 1..spent (no deletions).
    for (let i = 0; i < seqs.length; i++) {
      if (seqs[i] !== i + 1) {
        fail('source_window_corrupt', `reservation ledger gap: expected seq ${i + 1}, found ${seqs[i]}`);
      }
    }
    const seq = spent + 1;
    const urlSha256 = hashSourceUrlForReceipt(options.url);
    const receipt = {
      version: ALLOCATION_VERSION,
      seq,
      windowId: window.windowId,
      url: options.url,
      urlSha256,
      kind: options.kind,
      worker: options.worker ?? null,
      at: new Date().toISOString(),
    };
    writeExclusiveJson(path.join(reservationsDir, seqFileName(seq)), receipt);
    return { seq, urlSha256 };
  });
}

/**
 * Record the immutable outcome for a reserved seq (O_EXCL; no overwrite). Missing
 * outcomes (crash) stay conservatively spent — there is no refund path.
 */
export function recordSourceOutcome(window: SourceWindowHandle, seq: number, options: RecordSourceOutcomeOptions): void {
  if (!Number.isSafeInteger(seq) || seq < 1 || seq > window.maxHttpAttempts) {
    fail('source_window_invalid_request', `seq must be an integer in [1, ${window.maxHttpAttempts}]`);
  }
  if (typeof options.status !== 'number' && typeof options.status !== 'string') {
    fail('source_window_invalid_request', 'outcome status must be a number or string');
  }
  if (options.finalUrl != null && (typeof options.finalUrl !== 'string' || !options.finalUrl.startsWith('https://'))) {
    fail('source_window_invalid_request', 'outcome finalUrl must be an https URL');
  }
  if (options.error != null && (typeof options.error !== 'string' || options.error.length > 2000)) {
    fail('source_window_invalid_request', 'outcome error must be a string <= 2000 chars');
  }
  if (options.bytes != null && (!Number.isSafeInteger(options.bytes) || options.bytes < 0)) {
    fail('source_window_invalid_request', 'outcome bytes must be a non-negative integer');
  }
  const reservationsDir = path.join(window.windowDir, 'reservations');
  const reservationFile = path.join(reservationsDir, seqFileName(seq));
  if (!fs.existsSync(reservationFile)) {
    fail('source_window_unreserved_seq', `cannot record outcome for unreserved seq ${seq}`);
  }
  const reservation = readJsonFile(reservationFile, 'reservation receipt') as Record<string, unknown>;
  if (reservation.windowId !== window.windowId || reservation.seq !== seq) {
    fail('source_window_corrupt', `reservation ${seq} does not belong to this window`);
  }
  const urlSha256 = assertHex64(reservation.urlSha256, `reservation ${seq} urlSha256`);
  const outcome = {
    version: ALLOCATION_VERSION,
    seq,
    windowId: window.windowId,
    urlSha256,
    status: options.status,
    finalUrl: options.finalUrl ?? null,
    finalUrlSha256: options.finalUrl ? hashSourceUrlForReceipt(options.finalUrl) : null,
    error: options.error ?? null,
    bytes: options.bytes ?? null,
    at: new Date().toISOString(),
  };
  writeExclusiveJson(path.join(window.windowDir, 'outcomes', seqFileName(seq)), outcome);
}

/** Current spend from the immutable reservation ledger (fail closed on corrupt). */
export function getSourceWindowUsage(window: SourceWindowHandle): SourceWindowUsage {
  const allocationPath = path.join(window.windowDir, 'allocation.json');
  const allocation = readJsonFile(allocationPath, 'allocation') as Record<string, unknown>;
  if (allocation.windowId !== window.windowId
    || allocation.maxHttpAttempts !== window.maxHttpAttempts
    || allocation.ownerDecisionSha256 !== window.ownerDecisionSha256
    || allocation.authorityHash !== window.authorityHash) {
    fail('source_window_corrupt', `allocation changed under open handle: ${allocationPath}`);
  }
  const reservationsDir = path.join(window.windowDir, 'reservations');
  const outcomesDir = path.join(window.windowDir, 'outcomes');
  assertNotSymlink(reservationsDir, 'reservations dir');
  assertNotSymlink(outcomesDir, 'outcomes dir');
  const seqs = listSeqFiles(reservationsDir, 'reservations');
  for (let i = 0; i < seqs.length; i++) {
    if (seqs[i] !== i + 1) {
      fail('source_window_corrupt', `reservation ledger gap: expected seq ${i + 1}, found ${seqs[i]}`);
    }
  }
  const reservationShas = new Map<number, string>();
  for (const seq of seqs) {
    const validated = validateReservationFile(window, path.join(reservationsDir, seqFileName(seq)), seq);
    reservationShas.set(seq, validated.urlSha256);
  }
  const outcomeSeqs = listSeqFiles(outcomesDir, 'outcomes');
  for (const seq of outcomeSeqs) {
    const expected = reservationShas.get(seq);
    if (expected == null) {
      fail('source_window_corrupt', `outcome without reservation for seq ${seq}`);
    }
    validateOutcomeFile(window, path.join(outcomesDir, seqFileName(seq)), seq, expected);
  }
  const spent = seqs.length;
  return {
    spent,
    remaining: window.maxHttpAttempts - spent,
    max: window.maxHttpAttempts,
    windowId: window.windowId,
    ownerDecisionSha256: window.ownerDecisionSha256,
    authorityHash: window.authorityHash,
  };
}

function sanitizedReceipt(
  window: SourceWindowHandle,
  seq: number,
  reservation: { urlSha256: string; kind: SourceRequestKind; worker: string | null; at: string },
): PublicSourceReceipt {
  const outcomeFile = path.join(window.windowDir, 'outcomes', seqFileName(seq));
  if (!fs.existsSync(outcomeFile)) {
    return {
      seq,
      urlSha256: reservation.urlSha256,
      kind: reservation.kind,
      worker: reservation.worker,
      at: reservation.at,
      status: null,
      finalUrlSha256: null,
      error: null,
      bytes: null,
      outcomeMissing: true,
    };
  }
  const outcome = validateOutcomeFile(window, outcomeFile, seq, reservation.urlSha256);
  return {
    seq,
    urlSha256: reservation.urlSha256,
    kind: reservation.kind,
    worker: reservation.worker,
    at: reservation.at,
    status: outcome.status,
    finalUrlSha256: outcome.finalUrlSha256,
    error: outcome.error,
    bytes: outcome.bytes,
    outcomeMissing: false,
  };
}

/** Sanitized SHA-only ledger for the whole window (no raw URLs anywhere). */
export function buildPublicWindowLedger(window: SourceWindowHandle): PublicSourceReceipt[] {
  const usage = getSourceWindowUsage(window);
  const reservationsDir = path.join(window.windowDir, 'reservations');
  const out: PublicSourceReceipt[] = [];
  for (let seq = 1; seq <= usage.spent; seq++) {
    const reservation = validateReservationFile(window, path.join(reservationsDir, seqFileName(seq)), seq);
    out.push(sanitizedReceipt(window, seq, reservation));
  }
  return out;
}

/** Sanitized SHA-only receipts for one invocation's seqs (public artifact). */
export function buildPublicSourceReceipt(window: SourceWindowHandle, seqs: number[]): PublicSourceReceipt[] {
  if (!Array.isArray(seqs) || seqs.some(s => !Number.isSafeInteger(s) || s < 1 || s > window.maxHttpAttempts)) {
    fail('source_window_invalid_request', 'seqs must be integers in [1, maxHttpAttempts]');
  }
  const usage = getSourceWindowUsage(window);
  const reservationsDir = path.join(window.windowDir, 'reservations');
  const sorted = [...new Set(seqs)].sort((a, b) => a - b);
  for (const seq of sorted) {
    if (seq > usage.spent) {
      fail('source_window_unreserved_seq', `cannot publish receipt for unreserved seq ${seq}`);
    }
  }
  return sorted.map(seq => {
    const reservation = validateReservationFile(window, path.join(reservationsDir, seqFileName(seq)), seq);
    return sanitizedReceipt(window, seq, reservation);
  });
}
