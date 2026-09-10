/**
 * Packaging-OCR golden dataset (packaging-OCR overhaul P3-T1).
 *
 * A versioned, content-addressed set of operator-curated packaging images
 * with hand labels (`expected` is a Partial of `PackagingOcrData`). The
 * dataset file is plain JSON stored in git at
 * `src/onboarding/ocr-eval/datasets/*.json`; its identity is the SHA-256
 * digest over the canonical JSON serialization of the parsed document
 * (`hashCanonicalJson`) so any label edit changes the digest and "freezes"
 * evaluation runs to an exact revision.
 *
 * Storage decision (documented in
 * docs/runbooks/packaging-ocr-model-rollout.md): JSON lives under `src/`
 * next to the harness code (versioned, reviewable diffs) while image bytes
 * live OUTSIDE the repo tree by convention (`data/ocr-eval/<dataset>/…`,
 * referenced by relative `imageRef`) — `data/` already holds local runtime
 * artifacts in this repo and images are too large/binary for `src/`.
 * `imageRef` may alternatively be an inline base64 payload
 * (`inline:<base64>`) for small fixtures.
 */

import { z } from 'zod';
import { hashCanonicalJson, isSha256Hex } from '../../shared/stable-id';

/** Bump when the entry shape changes in a breaking way. */
export const GOLDEN_DATASET_SCHEMA_VERSION = 1;

/**
 * Hand labels for one image. Field semantics mirror `PackagingOcrData`
 * (src/shared/schemas/onboarding.ts): UPC labels are digit-exact (8–14
 * digits), string labels compare case-folded + trimmed, array labels compare
 * as sets (see metrics.ts). `confidenceByField`/`metadata` are not labeled.
 *
 * PARTIAL semantics: every field is optional — an OMITTED key means "not
 * hand-labeled" and is skipped by scoring (fieldMatches returns null; the
 * hallucination denominator excludes it). This is different from an explicit
 * `null`, which asserts labeled ABSENCE. Arrays deliberately carry NO
 * `.default([])`: a defaulted empty array would silently turn every omission
 * into an asserted-absence label.
 */
export const GoldenOcrExpectedSchema = z.object({
  productName: z.string().nullable().optional(),
  brand: z.string().nullable().optional(),
  species: z.array(z.string()).optional(),
  upc: z.string().regex(/^\d{8,14}$/).nullable().optional(),
  flavorVariety: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  material: z.string().nullable().optional(),
  size: z.string().nullable().optional(),
  weight: z.string().nullable().optional(),
  count: z.string().nullable().optional(),
  lifeStage: z.string().nullable().optional(),
  breedSize: z.string().nullable().optional(),
  productForm: z.string().nullable().optional(),
  packagingType: z.string().nullable().optional(),
  npkRatio: z.string().nullable().optional(),
  guaranteedAnalysis: z.record(z.string(), z.string()).optional(),
  healthConcernFunction: z.array(z.string()).optional(),
  dietaryLabels: z.array(z.string()).optional(),
  ingredients: z.array(z.string()).optional(),
  ingredientKeywords: z.array(z.string()).optional(),
  claims: z.array(z.string()).optional(),
  visibleTextLines: z.array(z.string()).optional(),
});

export const GoldenOcrEntrySchema = z.object({
  id: z.string().min(1),
  /**
   * Path to the image file relative to the dataset directory, OR an inline
   * base64 payload prefixed with `inline:`. Paths must not escape the
   * dataset directory (`..` segments rejected).
   */
  imageRef: z.string().min(1),
  expected: GoldenOcrExpectedSchema,
  /** Optional provenance note (e.g. distributor, photo session id). */
  source: z.string().optional(),
});

export const GoldenOcrDatasetSchema = z.object({
  schemaVersion: z.number().int().gte(1),
  name: z.string().min(1),
  entries: z.array(GoldenOcrEntrySchema).min(1),
});

export type GoldenOcrExpected = z.infer<typeof GoldenOcrExpectedSchema>;
export type GoldenOcrEntry = z.infer<typeof GoldenOcrEntrySchema>;
export type GoldenOcrDatasetFile = z.infer<typeof GoldenOcrDatasetSchema>;

/** A validated dataset plus its content-addressed identity. */
export interface LoadedGoldenDataset {
  name: string;
  schemaVersion: number;
  /** sha256 over canonical JSON of the whole parsed document. */
  digest: string;
  entries: GoldenOcrEntry[];
}

/**
 * Canonical-JSON digest of a parsed dataset document. Two files with the
 * same entries but different key order/whitespace share a digest.
 */
export function computeGoldenDatasetDigest(dataset: GoldenOcrDatasetFile): string {
  return hashCanonicalJson(dataset);
}

/**
 * Parse + validate raw dataset file contents into a LoadedGoldenDataset.
 * Throws on schema violations (wrong schemaVersion, bad UPC labels, …) or a
 * duplicate entry id — fail closed before any model call.
 */
export function loadGoldenDatasetFromJson(raw: string): LoadedGoldenDataset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Golden OCR dataset is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const result = GoldenOcrDatasetSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Golden OCR dataset failed validation: ${result.error.message}`);
  }
  // Fail closed on UNKNOWN FUTURE schema majors: a dataset written by a newer
  // harness may carry label semantics this build cannot score faithfully —
  // evaluating it would produce silently wrong metrics. Older versions are
  // still accepted (the schema itself gates the floor).
  if (result.data.schemaVersion > GOLDEN_DATASET_SCHEMA_VERSION) {
    throw new Error(
      `Golden OCR dataset schemaVersion ${result.data.schemaVersion} is newer than the supported version ${GOLDEN_DATASET_SCHEMA_VERSION}; upgrade Bay State CMS before evaluating.`,
    );
  }
  const seen = new Set<string>();
  for (const entry of result.data.entries) {
    if (seen.has(entry.id)) {
      throw new Error(`Golden OCR dataset has duplicate entry id "${entry.id}".`);
    }
    seen.add(entry.id);
    if (!entry.imageRef.startsWith('inline:') && entry.imageRef.includes('..')) {
      throw new Error(`Golden OCR entry "${entry.id}" imageRef escapes the dataset directory.`);
    }
  }
  return {
    name: result.data.name,
    schemaVersion: result.data.schemaVersion,
    digest: computeGoldenDatasetDigest(result.data),
    entries: result.data.entries,
  };
}

/** Whether an entry's imageRef carries inline base64 bytes. */
export function isInlineImageRef(entry: Pick<GoldenOcrEntry, 'imageRef'>): boolean {
  return entry.imageRef.startsWith('inline:');
}

/**
 * Decode an inline base64 imageRef into bytes. Returns null when the ref is
 * not inline or the payload is not valid base64.
 */
export function decodeInlineImage(entry: Pick<GoldenOcrEntry, 'imageRef'>): Buffer | null {
  if (!isInlineImageRef(entry)) return null;
  const payload = entry.imageRef.slice('inline:'.length);
  const buf = Buffer.from(payload, 'base64');
  // Buffer.from is lenient; require round-trip equality to reject junk.
  if (buf.toString('base64').replace(/=+$/, '') !== payload.replace(/=+$/, '')) {
    return null;
  }
  return buf;
}

/** Sanity helper used by tests and the runbook freeze step. */
export function assertValidDatasetDigest(digest: string): void {
  if (!isSha256Hex(digest)) {
    throw new Error(`Golden dataset digest is not a sha256 hex string: ${digest}`);
  }
}
