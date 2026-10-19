// story: e08 Test slice — durable matrix (DB + Map fallback)
import { randomUUID } from 'node:crypto';

function getDbSafe(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../db/connection').getDb();
  } catch { throw new Error('DB not available'); }
}
function isDbInitializedSafe(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../db/connection').isDbInitialized();
  } catch { return false; }
}

export interface MatrixSample {
  id: string;
  url: string;
  expectedTitle: string;
  /** Manager-approved full-page observation (D3): expected values the runner return is compared against. */
  observation?: {
    title: string;
    description: string | null;
    primaryImage: string | null;
    variantKey: string | null;
    contentHash: string | null;
  };
  expectedVariantKey?: string | null;
  expectedContentHash?: string | null;
}

export interface MatrixCell {
  field: string;
  extracted: string | null;
  expected: string;
  provenance: string;
  artifactHash: string;
  success: boolean;
  failureReason: string | null;
}

export interface ExtractedProductPreview {
  title?: string | null;
  brand?: string | null;
  price?: string | null;
  description?: string | null;
  images?: string[];
  customFields?: Record<string, string>;
}

export interface MatrixRow {
  sampleId: string;
  sampleUrl: string;
  cells: MatrixCell[];
  extractedProduct?: ExtractedProductPreview | null;
}

export interface MatrixResult {
  domain: string;
  draftVersion: string;
  rows: MatrixRow[];
  createdAt: string;
}

const store = new Map<string, MatrixResult>();

function keyFor(domain: string, version: string): string {
  return `${domain.toLowerCase().replace(/^www\./, '').trim()}::${version}`;
}

function normalizeDomain(d: string): string {
  return d.toLowerCase().replace(/^www\./, '').trim();
}

function useDb(): boolean {
  return isDbInitializedSafe();
}

/**
 * Expand one runner return against the sample's manager-approved observation
 * into per-field cells. Description/image compare verbatim (missing or
 * different fails); variant compares only when the observation pins one —
 * a mismatch reports `wrong_variant` so the health gate's identity refusal
 * fires. Title keeps the runner's own success verdict.
 */
function cellsFromObservation(
  s: MatrixSample,
  r: {
    extractedTitle: string | null;
    provenance: string;
    artifactHash: string;
    success: boolean;
    failureReason?: string | null;
    extractedVariantKey?: string | null;
    extractedProduct?: (ExtractedProductPreview & { primaryImage?: string | null; variantKey?: string | null }) | null;
  },
): MatrixCell[] {
  const obs = s.observation!;
  // Title compares against the approved observation (not runner truthiness):
  // a different nonempty title is a wrong-product failure. Runner failure
  // stays an additional refusal.
  const titleOk = r.success && r.extractedTitle !== null && r.extractedTitle === obs.title;
  const cells: MatrixCell[] = [{
    field: 'title',
    extracted: r.extractedTitle,
    expected: obs.title,
    provenance: r.provenance,
    artifactHash: r.artifactHash,
    success: titleOk,
    failureReason: titleOk ? null : (!r.success ? (r.failureReason ?? 'title missing') : 'wrong_product'),
  }];
  if (obs.description !== null) {
    const extracted = r.extractedProduct?.description ?? null;
    const ok = extracted !== null && extracted === obs.description;
    cells.push({
      field: 'description',
      extracted,
      expected: obs.description,
      provenance: r.provenance,
      artifactHash: r.artifactHash,
      success: ok,
      failureReason: ok ? null : 'description mismatch',
    });
  }
  if (obs.primaryImage !== null) {
    const extracted = r.extractedProduct?.primaryImage
      ?? r.extractedProduct?.images?.[0] ?? null;
    const ok = extracted !== null && extracted === obs.primaryImage;
    cells.push({
      field: 'primary_image',
      extracted,
      expected: obs.primaryImage,
      provenance: r.provenance,
      artifactHash: r.artifactHash,
      success: ok,
      failureReason: ok ? null : 'primary_image mismatch',
    });
  }
  const expectedVariant = s.expectedVariantKey ?? obs.variantKey;
  if (expectedVariant !== null && expectedVariant !== undefined) {
    const extractedVariant = r.extractedVariantKey
      ?? r.extractedProduct?.variantKey ?? null;
    const ok = extractedVariant === expectedVariant;
    cells.push({
      field: 'variant',
      extracted: extractedVariant,
      expected: expectedVariant,
      provenance: r.provenance,
      artifactHash: r.artifactHash,
      success: ok,
      failureReason: ok ? null : 'wrong_variant',
    });
  }
  return cells;
}

export async function runMatrix(input: {
  domain: string;
  draftVersion: string;
  samples: MatrixSample[];
  runner: (sample: MatrixSample) => Promise<{
    extractedTitle: string | null;
    provenance: string;
    artifactHash: string;
    success: boolean;
    failureReason?: string | null;
    extractedProduct?: ExtractedProductPreview | null;
    /**
     * Full cell override (T4 validation): when supplied, these cells are
     * recorded verbatim instead of the title-only default — field and
     * identity correctness (including explicit `wrong_product` /
     * `wrong_variant` failure reasons) through the same matrix evidence
     * path, never a second health definition.
     */
    cells?: MatrixCell[];
  }>;
}): Promise<MatrixResult> {
  const rows: MatrixRow[] = [];
  for (const s of input.samples) {
    const r = await input.runner(s);
    const runner = r as typeof r & {
      extractedVariantKey?: string | null;
      extractedProduct?: (ExtractedProductPreview & { primaryImage?: string | null; variantKey?: string | null }) | null;
    };
    // D3: when the sample carries a manager-approved observation, expand the
    // runner return into per-field cells (title/description/primary_image/
    // variant) so a wrong description, image, or variant fails the version
    // even when the title passes. Samples without an observation keep the
    // legacy title-only cell.
    const cells: MatrixCell[] = r.cells ?? (s.observation ? cellsFromObservation(s, runner) : [{
      field: 'title',
      extracted: r.extractedTitle,
      expected: s.expectedTitle,
      provenance: r.provenance,
      artifactHash: r.artifactHash,
      success: r.success,
      failureReason: r.failureReason ?? null,
    }]);
    rows.push({
      sampleId: s.id,
      sampleUrl: s.url,
      extractedProduct: r.extractedProduct ?? { title: r.extractedTitle },
      cells,
    });
  }
  const result: MatrixResult = { domain: normalizeDomain(input.domain), draftVersion: input.draftVersion, rows, createdAt: new Date().toISOString() };
  store.set(keyFor(input.domain, input.draftVersion), result);
  if (useDb()) persistResult(result);
  return result;
}

function persistResult(result: MatrixResult): void {
  try {
    const db = getDbSafe();
    const runId = randomUUID();
    const hashes = getMatrixArtifactHashes(result);
    db.transaction(() => {
      db.query('INSERT OR REPLACE INTO profile_matrix_runs (id, domain, version_id, created_at, artifact_hashes) VALUES (?, ?, ?, ?, ?)').run(runId, result.domain, result.draftVersion, result.createdAt, JSON.stringify(hashes));
      for (const row of result.rows) for (const cell of row.cells) {
        db.query('INSERT INTO profile_matrix_cells (id, run_id, sample_url, sample_id, field, extracted, expected, provenance, artifact_hash, success, failure_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), runId, row.sampleUrl, row.sampleId, cell.field, cell.extracted, cell.expected, cell.provenance, cell.artifactHash, cell.success ? 1 : 0, cell.failureReason);
      }
    })();
  } catch {}
}

export function getMatrixResult(domain: string, draftVersion: string): MatrixResult | null {
  const cached = store.get(keyFor(domain, draftVersion));
  if (cached) return cached;
  if (!useDb()) return null;
  try {
    const db = getDbSafe();
    const norm = normalizeDomain(domain);
    const run = db.query('SELECT * FROM profile_matrix_runs WHERE domain = ? AND version_id = ? ORDER BY created_at DESC LIMIT 1').get(norm, draftVersion) as { id: string; domain: string; version_id: string; created_at: string } | undefined;
    if (!run) return null;
    const cells = db.query('SELECT * FROM profile_matrix_cells WHERE run_id = ?').all(run.id) as Array<{ sample_url: string; sample_id: string; field: string; extracted: string | null; expected: string; provenance: string; artifact_hash: string; success: number; failure_reason: string | null; }>;
    const bySample = new Map<string, MatrixRow>();
    for (const c of cells) {
      let row = bySample.get(c.sample_id);
      if (!row) { row = { sampleId: c.sample_id, sampleUrl: c.sample_url, cells: [] }; bySample.set(c.sample_id, row); }
      row.cells.push({ field: c.field, extracted: c.extracted, expected: c.expected, provenance: c.provenance, artifactHash: c.artifact_hash, success: !!c.success, failureReason: c.failure_reason });
    }
    const result: MatrixResult = { domain: run.domain, draftVersion: run.version_id, rows: [...bySample.values()], createdAt: run.created_at };
    store.set(keyFor(domain, draftVersion), result);
    return result;
  } catch { return null; }
}

export function getMatrixArtifactHashes(result: MatrixResult): string[] {
  return [...new Set(result.rows.flatMap(r => r.cells.map(c => c.artifactHash)))].sort();
}

export function matrixCoversSamples(result: MatrixResult, sampleIds: string[]): boolean {
  const seen = new Set(result.rows.map(r => r.sampleId));
  return sampleIds.every(id => seen.has(id));
}

export function resetTestMatrixForTest(): void {
  store.clear();
  if (!useDb()) return;
  try { const db = getDbSafe(); db.exec('DELETE FROM profile_matrix_cells'); db.exec('DELETE FROM profile_matrix_runs'); } catch {}
}
