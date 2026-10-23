/**
 * Milestone 5 (P1-B) — Lossless imported identity with versioned envelopes.
 *
 * Envelopes are Zod-validated, size-bounded, canonical JSON.
 * Raw captures exact mapped fragments before any trim/normalize.
 * Normalized captures operational values + ordered transformations.
 * Provenance is hash of canonical raw+normalized.
 */
import { z } from 'zod';
import type { ColumnMapping } from '../shared/schemas/onboarding';
import { normalizeImportedProductName, splitGluedSizeBeforeBrand, moveTrailingBrandToFront } from './spreadsheet-parser';
import { canonicalJsonStringify, hashCanonicalJson, sha256Hex } from '../shared/stable-id';
export const IDENTITY_NORMALIZER_VERSION = 1;
export const RAW_IDENTITY_VERSION = 1;
export const NORMALIZED_IDENTITY_VERSION = 1;
export const IMPORTED_IDENTITY_ENVELOPE_VERSION = 1;

// Bounded fragment
export const RawFragmentSchema = z.object({
  column: z.string().max(100),
  value: z.string().max(2000),
  boundary: z.enum(['none', 'space', 'concatenated']).default('none'),
});
export type RawFragment = z.infer<typeof RawFragmentSchema>;

// Raw envelope V1
export const RawIdentityEnvelopeV1Schema = z.object({
  version: z.union([z.literal(0), z.literal(1)]),
  upc: z.string().max(100),
  nameFragments: z.array(RawFragmentSchema).max(2),
  brandHint: z.string().max(500).nullable(),
  departmentHint: z.string().max(500).nullable(),
  price: z.string().max(100).nullable(),
  quantity: z.string().max(100).nullable(),
  sourceUrl: z.string().max(2000).nullable(),
  rowNumber: z.number().int().min(1).max(1000000),
  mappingHash: z.string().regex(/^[0-9a-f]{64}$/),
  parserProvenance: z.object({
    source: z.enum(['spreadsheet', 'legacy_operational_backfill']),
    parserVersion: z.number().int(),
  }),
});
export type RawIdentityEnvelopeV1 = z.infer<typeof RawIdentityEnvelopeV1Schema>;

// Normalized transformation
export const TransformationSchema = z.object({
  code: z.string().max(50),
  beforeHash: z.string().regex(/^[0-9a-f]{64}$/),
  afterHash: z.string().regex(/^[0-9a-f]{64}$/),
  version: z.number().int(),
});
export type Transformation = z.infer<typeof TransformationSchema>;

// Normalized envelope V1
export const NormalizedIdentityEnvelopeV1Schema = z.object({
  version: z.union([z.literal(0), z.literal(1)]),
  upc: z.string().max(100),
  name: z.string().max(2000),
  brandHint: z.string().max(500).nullable(),
  departmentHint: z.string().max(500).nullable(),
  price: z.string().max(100).nullable(),
  quantity: z.string().max(100).nullable(),
  sourceUrl: z.string().max(2000).nullable(),
  rowNumber: z.number().int().min(1).max(1000000),
  mappingHash: z.string().regex(/^[0-9a-f]{64}$/),
  transformations: z.array(TransformationSchema).max(10),
  parserProvenance: z.object({
    source: z.enum(['spreadsheet', 'legacy_operational_backfill']),
    parserVersion: z.number().int(),
  }),
});
export type NormalizedIdentityEnvelopeV1 = z.infer<typeof NormalizedIdentityEnvelopeV1Schema>;

// Provenance envelope
export const ImportedIdentityProvenanceSchema = z.object({
  version: z.number().int(),
  source: z.enum(['spreadsheet', 'legacy_operational_backfill']),
  lossy: z.boolean(),
  parserVersion: z.number().int(),
  rawHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  normalizedHash: z.string().regex(/^[0-9a-f]{64}$/),
  provenanceHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ImportedIdentityProvenance = z.infer<typeof ImportedIdentityProvenanceSchema>;

export function computeMappingHash(mapping: ColumnMapping): string {
  const canonical = canonicalJsonStringify({
    upc: mapping.upc,
    name: mapping.name,
    nameMergeWith: mapping.nameMergeWith ?? null,
    price: mapping.price ?? null,
    quantity: mapping.quantity ?? null,
    brand: mapping.brand ?? null,
    department: mapping.department ?? null,
    sourceUrl: mapping.sourceUrl ?? null,
  });
  return sha256Hex(canonical);
}

export function hashValue(value: string): string {
  return sha256Hex(value);
}

export function computeIdentityProvenanceHash(rawJson: string | null, normalizedJson: string | null): string {
  const canonical = (value: string | null) => {
    if (value === null) return null;
    try {
      const parsed = JSON.parse(value);
      return canonicalJsonStringify(parsed);
    } catch {
      return value;
    }
  };
  const payload = canonicalJsonStringify({
    v: IDENTITY_NORMALIZER_VERSION,
    raw: canonical(rawJson),
    normalized: canonical(normalizedJson),
  });
  return sha256Hex(payload);
}

export function computeLegacyProvenanceHash(normalizedJson: string): string {
  const payload = canonicalJsonStringify({
    version: 0,
    normalized: normalizedJson,
    source: "legacy_operational_backfill",
    lossy: true,
    raw: null,
  });
  return sha256Hex(payload);
}

export interface CapturedIdentity {
  raw_identity_json: string | null;
  normalized_identity_json: string | null;
  identity_normalizer_version: number;
  identity_provenance_hash: string | null;
}

export function buildLegacyEnvelope(name: string, brandHint: string | null, rowNumber: number = 1): CapturedIdentity {
  const normalized = {
    version: 0,
    upc: '',
    name,
    brandHint: brandHint ?? null,
    departmentHint: null,
    price: null,
    quantity: null,
    sourceUrl: null,
    rowNumber,
    mappingHash: hashValue('legacy'),
    transformations: [],
    parserProvenance: { source: 'legacy_operational_backfill' as const, parserVersion: 0 },
  };
  const normalizedJson = canonicalJsonStringify(NormalizedIdentityEnvelopeV1Schema.parse(normalized));
  const legacyHash = computeLegacyProvenanceHash(normalizedJson);
  return {
    raw_identity_json: null,
    normalized_identity_json: normalizedJson,
    identity_normalizer_version: 0,
    identity_provenance_hash: legacyHash,
  };
}

/**
 * Capture raw cell values BEFORE any trim/normalize, then derive normalized.
 * Must be called with original raw row and mapping immediately after obtaining raw row.
 */

/**
 * Shared tuple validator for lossless identity (M5 round 3).
 * Fail-closed: validates version, envelopes, hash equality, canonical, lossy.
 */
export function validateIdentityTuple(input: {
  rawJson: string | null;
  normalizedJson: string | null;
  version: number | null;
  provenanceHash: string | null;
  lossy: boolean | null | undefined;
}): { ok: boolean; reason?: string } {
  const { rawJson, normalizedJson, version, provenanceHash, lossy } = input;
  const isCanonical = (json: string | null, schema: any) => {
    if (json === null) return true;
    try {
      const p = JSON.parse(json);
      const r = schema.safeParse(p);
      return r.success && canonicalJsonStringify(p) === json;
    } catch { return false; }
  };
  const hashOk = (h: string | null) => h === null || /^[a-f0-9]{64}$/.test(h);
  if (version === null || version === undefined) {
    if (rawJson !== null || normalizedJson !== null || provenanceHash !== null) return { ok: false, reason: 'version null requires all null' };
    if (lossy) return { ok: false, reason: 'version null lossy must be falsy' };
    return { ok: true };
  }
  if (version === 0) {
    if (rawJson !== null) return { ok: false, reason: 'v0 raw must be null' };
    if (normalizedJson === null) return { ok: false, reason: 'v0 normalized required' };
    if (!isCanonical(normalizedJson, NormalizedIdentityEnvelopeV1Schema)) return { ok: false, reason: 'v0 normalized not canonical' };
    if (!hashOk(provenanceHash) || provenanceHash === null) return { ok: false, reason: 'v0 hash required 64-hex' };
    const parsedNorm = JSON.parse(normalizedJson);
    // Explicit V0 inner invariants: version and source must be legacy
    if (parsedNorm.version !== 0) return { ok: false, reason: 'v0 normalized version must be 0' };
    if (parsedNorm.parserProvenance?.source !== 'legacy_operational_backfill') return { ok: false, reason: 'v0 source must be legacy_operational_backfill' };
    const expectedLegacy = computeLegacyProvenanceHash(normalizedJson);
    if (provenanceHash !== expectedLegacy) return { ok: false, reason: 'v0 hash mismatch' };
    // Infer lossy=true when undefined and version===0 for backward compat with legacy repo hydration
    const effectiveLossy = lossy === undefined ? true : lossy;
    if (effectiveLossy !== true) return { ok: false, reason: 'v0 lossy must be true' };
    return { ok: true };
  }
  if (version === 1) {
    if (rawJson === null || normalizedJson === null || provenanceHash === null) return { ok: false, reason: 'v1 requires all' };
    if (!isCanonical(rawJson, RawIdentityEnvelopeV1Schema)) return { ok: false, reason: 'v1 raw not canonical' };
    if (!isCanonical(normalizedJson, NormalizedIdentityEnvelopeV1Schema)) return { ok: false, reason: 'v1 normalized not canonical' };
    if (!hashOk(provenanceHash)) return { ok: false, reason: 'v1 hash 64-hex' };
    const expected = computeIdentityProvenanceHash(rawJson, normalizedJson);
    if (expected !== provenanceHash) return { ok: false, reason: 'v1 hash mismatch' };
    if (lossy) return { ok: false, reason: 'v1 lossy must be false' };
    // version inside envelopes must match outer version and source
    try {
      const rawP = JSON.parse(rawJson);
      const normP = JSON.parse(normalizedJson);
      if (rawP.version !== 1) return { ok: false, reason: 'raw version mismatch' };
      if (normP.version !== 1) return { ok: false, reason: 'normalized version mismatch' };
      // source check: both envelopes should have parserProvenance.source === 'spreadsheet'
      if (rawP.parserProvenance?.source !== 'spreadsheet') return { ok: false, reason: 'raw source mismatch' };
      if (normP.parserProvenance?.source !== 'spreadsheet') return { ok: false, reason: 'normalized source mismatch' };
      // mappingHash equality between raw and normalized should match
      if (rawP.mappingHash !== normP.mappingHash) return { ok: false, reason: 'mappingHash mismatch' };
      // hash equality already checked via provenanceHash
    } catch (e) { return { ok: false, reason: 'envelope parse failed' }; }
    return { ok: true };
  }
  return { ok: false, reason: 'invalid version' };
}

export function captureImportedIdentity(
  rawRow: Record<string, string>,
  mapping: ColumnMapping,
): CapturedIdentity {
  const mappingHash = computeMappingHash(mapping);
  const rowNumberRaw = rawRow['__rowNumber'] ? parseInt(rawRow['__rowNumber'], 10) : 2;
  const rowNumber = Number.isFinite(rowNumberRaw) && rowNumberRaw > 0 ? rowNumberRaw : 2;

  // Raw fragments before any trim/join/normalize
  const upcRaw = rawRow[mapping.upc] ?? '';
  const nameRaw = mapping.name ? (rawRow[mapping.name] ?? '') : '';
  const nameRawMerge = mapping.nameMergeWith ? (rawRow[mapping.nameMergeWith] ?? '') : '';
  const brandRaw = mapping.brand ? (rawRow[mapping.brand] ?? '') : '';
  const priceRaw = mapping.price ? (rawRow[mapping.price] ?? '') : '';
  const quantityRaw = mapping.quantity ? (rawRow[mapping.quantity] ?? '') : '';
  const departmentRaw = mapping.department ? (rawRow[mapping.department] ?? '') : '';
  const sourceUrlRaw = mapping.sourceUrl ? (rawRow[mapping.sourceUrl] ?? '') : '';

  // Determine boundary between name fragments
  let boundary: 'none' | 'space' | 'concatenated' = 'none';
  const nameFragments: RawFragment[] = [];
  if (mapping.nameMergeWith) {
    const hasBoundarySpace = nameRaw.endsWith(' ') || nameRawMerge.startsWith(' ') || nameRaw.endsWith('\t') || nameRawMerge.startsWith('\t');
    // Explicit boundary whitespace as one space; else concatenated preserving LAV+ENDER
    boundary = hasBoundarySpace ? 'space' : 'concatenated';
    nameFragments.push({ column: mapping.name, value: nameRaw, boundary: hasBoundarySpace ? 'space' : 'concatenated' });
    nameFragments.push({ column: mapping.nameMergeWith, value: nameRawMerge, boundary: 'none' });
  } else {
    nameFragments.push({ column: mapping.name, value: nameRaw, boundary: 'none' });
  }

  const rawEnvelope: RawIdentityEnvelopeV1 = RawIdentityEnvelopeV1Schema.parse({
    version: RAW_IDENTITY_VERSION,
    upc: upcRaw,
    nameFragments,
    brandHint: brandRaw || null,
    departmentHint: departmentRaw || null,
    price: priceRaw || null,
    quantity: quantityRaw || null,
    sourceUrl: sourceUrlRaw || null,
    rowNumber,
    mappingHash,
    parserProvenance: { source: 'spreadsheet', parserVersion: IDENTITY_NORMALIZER_VERSION },
  });

  // Derive operational normalized values from captured normalized envelope (do not duplicate normalization)
  // Join split fields with versioned boundary rule
  let joinedName = nameRaw;
  if (mapping.nameMergeWith) {
    if (boundary === 'space') {
      // Preserve explicit boundary whitespace as one space: trim each then join with single space
      joinedName = (nameRaw.trim() + ' ' + nameRawMerge.trim()).trim();
      // But if either had explicit multiple spaces, we still canonicalize to one space
    } else {
      // Concatenated preserving LAV+ENDER: direct concatenation after trimming each? For legacy behavior test expects "Test ProductExtra" when raw "Test Product" + " Extra" (explicit space would be space)
      // However for non-space case, we concatenate without space after trimming?
      // We need to preserve the test expectation: raw "Test Product" (no trailing space) + " Extra" (leading space) -> boundary is space -> above case
      // For non-space, we do direct concatenation of trimmed parts without added space
      const part1 = nameRaw.trim();
      const part2 = nameRawMerge.trim();
      joinedName = part2 ? part1 + part2 : part1;
    }
  } else {
    joinedName = nameRaw.trim();
  }

  const brandHint = brandRaw.trim() || null;
  // Record ordered transformations
  const transformations: Transformation[] = [];
  let current = joinedName;
  // Transformation 1: glue-split
  const beforeGlue = current;
  const afterGlue = splitGluedSizeBeforeBrand(current, brandHint);
  if (beforeGlue !== afterGlue) {
    transformations.push({
      code: 'split_glued_size',
      beforeHash: hashValue(beforeGlue),
      afterHash: hashValue(afterGlue),
      version: IDENTITY_NORMALIZER_VERSION,
    });
    current = afterGlue;
  }
  // Transformation 2: brand-move
  const beforeBrand = current;
  const afterBrand = moveTrailingBrandToFront(current, brandHint);
  if (beforeBrand !== afterBrand) {
    transformations.push({
      code: 'move_trailing_brand',
      beforeHash: hashValue(beforeBrand),
      afterHash: hashValue(afterBrand),
      version: IDENTITY_NORMALIZER_VERSION,
    });
    current = afterBrand;
  }

  const normalizedName = current;

  const normalizedEnvelope: NormalizedIdentityEnvelopeV1 = NormalizedIdentityEnvelopeV1Schema.parse({
    version: NORMALIZED_IDENTITY_VERSION,
    upc: upcRaw.trim(),
    name: normalizedName,
    brandHint,
    departmentHint: departmentRaw.trim() || null,
    price: priceRaw || null,
    quantity: quantityRaw.trim() || null,
    sourceUrl: sourceUrlRaw.trim() || null,
    rowNumber,
    mappingHash,
    transformations,
    parserProvenance: { source: 'spreadsheet', parserVersion: IDENTITY_NORMALIZER_VERSION },
  });

  const rawJson = canonicalJsonStringify(rawEnvelope);
  const normalizedJson = canonicalJsonStringify(normalizedEnvelope);
  const provenanceHash = computeIdentityProvenanceHash(rawJson, normalizedJson);

  return {
    raw_identity_json: rawJson,
    normalized_identity_json: normalizedJson,
    identity_normalizer_version: IDENTITY_NORMALIZER_VERSION,
    identity_provenance_hash: provenanceHash,
  };
}
