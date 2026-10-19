// D3 — durable manager-approved per-sample observations, version-bound.
//
// A manager-confirmed URL→item sample carries the FULL observed page
// values the manager reviewed (title, description, primary image,
// variant identity) plus the page content hash the approval was recorded
// against. Rows bind to the immutable draft version: a changed page or a
// changed executable rule invalidates prior approval instead of silently
// inheriting it. The matrix route refuses to run without a recorded
// observation for every sample; the health gate refuses versions whose
// approvals are stale or incomplete.
import { createHash } from 'node:crypto';

interface StatementResult {
  all: (...params: Array<string | null>) => ObservationRow[];
  get: (...params: Array<string | null>) => ObservationRow | undefined;
  run: (...params: Array<string | null>) => void;
}

interface DbHandle {
  exec: (sql: string) => void;
  query: (sql: string) => StatementResult;
}

// Lazy connection — avoid top-level bun:sqlite import under vitest node env
// (same pattern as profile-version-repo). Runtime-selected: the repository is
// imported by both Bun server code and Vitest suites without sqlite.
function db(): DbHandle | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- runtime-selected Bun/Vitest boundary
    const connection = require('../connection') as {
      getDb: () => DbHandle;
      isDbInitialized: () => boolean;
    };
    return connection.isDbInitialized() ? connection.getDb() : null;
  } catch {
    return null;
  }
}

function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '').trim();
}

/** Durable manager approval for one confirmed sample + draft version. */
export interface SampleObservation {
  id: string;
  domain: string;
  versionId: string;
  sampleUrl: string;
  sampleId: string | null;
  itemId: string | null;
  variantKey: string | null;
  expectedTitle: string;
  expectedDescription: string | null;
  expectedPrimaryImage: string | null;
  expectedImagesJson: string;
  contentHash: string | null;
  approver: string;
  approvedAt: string;
}

export interface RecordSampleObservationInput {
  domain: string;
  versionId: string;
  sampleUrl: string;
  sampleId?: string | null;
  /** Full manager-reviewed page title (required; never the register name/URL). */
  expectedTitle: string;
  expectedDescription?: string | null;
  expectedPrimaryImage?: string | string[] | null;
  expectedImages?: string[] | null;
  itemId?: string | null;
  variantKey?: string | null;
  contentHash?: string | null;
  approver: string;
}

interface ObservationRow {
  id: string;
  domain: string;
  version_id: string;
  sample_url: string;
  sample_id: string | null;
  item_id: string | null;
  variant_key: string | null;
  expected_title: string;
  expected_description: string | null;
  expected_primary_image: string | null;
  expected_images_json: string;
  content_hash: string | null;
  approver: string;
  approved_at: string;
}

function ensureTable(handle: DbHandle): void {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS profile_sample_observations (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      version_id TEXT NOT NULL,
      sample_url TEXT NOT NULL,
      sample_id TEXT,
      item_id TEXT,
      variant_key TEXT,
      expected_title TEXT NOT NULL,
      expected_description TEXT,
      expected_primary_image TEXT,
      expected_images_json TEXT NOT NULL DEFAULT '[]',
      content_hash TEXT,
      approver TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      UNIQUE(version_id, sample_url)
    );
  `);
  handle.exec(
    `CREATE INDEX IF NOT EXISTS idx_profile_sample_observations_domain_version ON profile_sample_observations(domain, version_id);`,
  );
}

const fallbackRows = new Map<string, SampleObservation[]>();

function fallbackKey(domain: string, versionId: string): string {
  return `${normalizeDomain(domain)}::${versionId}`;
}

function approvedImages(input: RecordSampleObservationInput): string[] {
  const list: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed && !list.includes(trimmed)) list.push(trimmed);
  };
  if (Array.isArray(input.expectedImages)) input.expectedImages.forEach(collect);
  if (Array.isArray(input.expectedPrimaryImage)) input.expectedPrimaryImage.forEach(collect);
  else collect(input.expectedPrimaryImage);
  return list;
}

function toObservation(row: ObservationRow): SampleObservation {
  return {
    id: row.id,
    domain: row.domain,
    versionId: row.version_id,
    sampleUrl: row.sample_url,
    sampleId: row.sample_id,
    itemId: row.item_id,
    variantKey: row.variant_key,
    expectedTitle: row.expected_title,
    expectedDescription: row.expected_description,
    expectedPrimaryImage: row.expected_primary_image,
    expectedImagesJson: row.expected_images_json,
    contentHash: row.content_hash,
    approver: row.approver,
    approvedAt: row.approved_at,
  };
}

function buildRow(input: RecordSampleObservationInput): ObservationRow {
  const domain = normalizeDomain(input.domain);
  const images = approvedImages(input);
  return {
    id: createHash('sha256').update(`${domain}|${input.versionId}|${input.sampleUrl}`).digest('hex').slice(0, 32),
    domain,
    version_id: input.versionId,
    sample_url: input.sampleUrl,
    sample_id: input.sampleId ?? null,
    item_id: input.itemId ?? null,
    variant_key: input.variantKey ?? null,
    expected_title: (input.expectedTitle ?? '').trim(),
    expected_description: input.expectedDescription ?? null,
    expected_primary_image: images[0] ?? null,
    expected_images_json: JSON.stringify(images),
    content_hash: input.contentHash ?? null,
    approver: (input.approver ?? '').trim(),
    approved_at: new Date().toISOString(),
  };
}

/**
 * Record (upsert) the manager's approval for one sample + version. The
 * approval is immutable-bound: re-approving after a page/rule change
 * writes a fresh timestamp + content hash; editing a version's
 * executable rule does NOT carry observations forward (callers resolve
 * observations per version id only).
 */
export function recordSampleObservation(input: RecordSampleObservationInput): SampleObservation {
  if (!normalizeDomain(input.domain)) throw new Error('domain required');
  if (!input.versionId?.trim()) throw new Error('versionId required');
  if (!input.sampleUrl?.startsWith('http')) throw new Error(`invalid sample url ${input.sampleUrl}`);
  if (!(input.expectedTitle ?? '').trim()) throw new Error('expectedTitle (approved full page title) required');
  // The URL is an address, never an expectation — it MUST NOT double as
  // the approved title (the register name is likewise never acceptable;
  // the recording UI MUST supply the observed page title).
  if ((input.expectedTitle ?? '').trim() === input.sampleUrl.trim()) {
    throw new Error('expectedTitle must be the reviewed page title, not the URL');
  }
  const row = buildRow(input);
  const handle = db();
  if (!handle) {
    const key = fallbackKey(row.domain, row.version_id);
    const list = fallbackRows.get(key) ?? [];
    const obs = toObservation(row);
    const idx = list.findIndex((o) => o.sampleUrl === row.sample_url);
    if (idx >= 0) list[idx] = obs;
    else list.push(obs);
    fallbackRows.set(key, list);
    return obs;
  }
  ensureTable(handle);
  handle.query(`
    INSERT INTO profile_sample_observations
      (id, domain, version_id, sample_url, sample_id, item_id, variant_key,
       expected_title, expected_description, expected_primary_image,
       expected_images_json, content_hash, approver, approved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(version_id, sample_url) DO UPDATE SET
      sample_id = excluded.sample_id, item_id = excluded.item_id,
      variant_key = excluded.variant_key, expected_title = excluded.expected_title,
      expected_description = excluded.expected_description,
      expected_primary_image = excluded.expected_primary_image,
      expected_images_json = excluded.expected_images_json,
      content_hash = excluded.content_hash, approver = excluded.approver,
      approved_at = excluded.approved_at
  `).run(
    row.id, row.domain, row.version_id, row.sample_url, row.sample_id, row.item_id,
    row.variant_key, row.expected_title, row.expected_description,
    row.expected_primary_image, row.expected_images_json, row.content_hash,
    row.approver, row.approved_at,
  );
  return toObservation(row);
}

/** All recorded observations for one draft version (fail-closed to empty). */
export function listSampleObservations(domain: string, versionId: string): SampleObservation[] {
  const norm = normalizeDomain(domain);
  const handle = db();
  if (!handle) return [...(fallbackRows.get(fallbackKey(norm, versionId)) ?? [])];
  try {
    ensureTable(handle);
    return handle.query(
      'SELECT * FROM profile_sample_observations WHERE domain = ? AND version_id = ? ORDER BY sample_url',
    ).all(norm, versionId).map(toObservation);
  } catch { return []; }
}

/** One recorded observation by version + sample URL (null when unapproved). */
export function getSampleObservation(domain: string, versionId: string, sampleUrl: string): SampleObservation | null {
  const norm = normalizeDomain(domain);
  const handle = db();
  if (!handle) {
    return (fallbackRows.get(fallbackKey(norm, versionId)) ?? []).find((o) => o.sampleUrl === sampleUrl) ?? null;
  }
  try {
    ensureTable(handle);
    const row = handle.query(
      'SELECT * FROM profile_sample_observations WHERE domain = ? AND version_id = ? AND sample_url = ?',
    ).get(norm, versionId, sampleUrl);
    return row ? toObservation(row) : null;
  } catch { return null; }
}

/**
 * Freshness check: the recorded approval still covers the current page
 * content. Null content hashes abstain (unknown freshness, not proof of
 * staleness); mismatched hashes are stale and MUST force renewed review.
 */
export function isObservationFresh(observation: SampleObservation, currentContentHash: string | null | undefined): boolean {
  if (!observation.contentHash || !currentContentHash) return true;
  return observation.contentHash === currentContentHash;
}

export function resetSampleObservationsForTest(): void {
  fallbackRows.clear();
  const handle = db();
  if (!handle) return;
  try {
    ensureTable(handle);
    handle.exec('DELETE FROM profile_sample_observations');
  } catch { /* best-effort */ }
}
