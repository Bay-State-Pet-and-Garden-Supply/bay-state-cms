/**
 * Representative Jev benchmark preparation (#302 steps 2/3).
 *
 * Pure, side-effect-free preparation helpers. Default posture is dry-run:
 * no model calls, no DB writes, no routing changes. Snapshot authority comes
 * from the caller's `loadRuntimeConfigAuthority` bundle + `captureVerifiedPageSnapshot`
 * seam values passed in — this module never calls `buildRuntimeSnapshot`
 * (which reads reviewed facts / VLM credentials) and never touches gold or
 * input-snapshot payload columns. All SQL lives in the repositories; this
 * module only consumes their typed results.
 */
import { hashCanonicalJson } from '../shared/stable-id';
import {
  findForbiddenSourceFields,
  JevSourceCandidateSchema,
  type JevDryRunSummary,
  type JevManifestEntry,
  type JevSourceCandidate,
  type JevWriteResult,
} from '../shared/schemas/jev-benchmark';
import type { RuntimeConfigAuthority } from './config-loader';
import type { VerifiedPageSnapshot } from './page-snapshot';
import { splitForFamily, verifyFamilySeparation } from './benchmark-exporter';

// ─── Frozen authority view ───────────────────────────────────────────────────

/**
 * Live-source dependencies for a coherent authority capture. The CLI supplies
 * the real loaders (runtime config authority + verified page seam + workspace
 * pin + catalog commit); tests supply fakes. Nothing here opens a database.
 */
export interface AuthorityCaptureDeps {
  workspaceId: string;
  loadAuthority: () => RuntimeConfigAuthority;
  capturePages: (workspaceId: string) => VerifiedPageSnapshot;
  readReleasePin: () => string | null;
  readCatalogCommit: () => string;
}

export interface PreparationAuthorityBinding {
  workspaceId: string;
  release: string;
  catalogGitCommit: string;
  configHash: string;
  capturedAt: string;
  pageImportId: string;
  pageImportHash: string;
}

export interface PreparationAuthorityView {
  authorityHash: string;
  binding: PreparationAuthorityBinding;
  counts: { productTypes: number; attributes: number; pages: number };
  pageIds: string[];
  /** Full frozen snapshot payload (validated bundle + verified pages). */
  payload: Record<string, unknown>;
}

function bundleOf(authority: RuntimeConfigAuthority): Record<string, unknown> {
  const raw = (authority.kind === 'v2' ? authority.bundle : authority.config) as unknown as Record<string, unknown>;
  if (!raw || typeof raw !== 'object') throw new Error('incomplete_authority: config bundle is not an object');
  return raw;
}

function requireCompleteBundle(bundle: Record<string, unknown>): void {
  // Freeze the EXISTING validated config fields — never invented flat bags.
  // Nested profile conditions/cardinality, attribute aliases/invariants,
  // guidance, mappings, curation targets, and evidence/model policies ride
  // inside these structures as the validators shaped them.
  const listFields = [
    'productTypes',
    'attributes',
    'attributeProfiles',
    'attributeMappings',
    'curationTargets',
    'brands',
    'guidance',
  ] as const;
  for (const field of listFields) {
    if (!Array.isArray(bundle[field])) {
      throw new Error(`incomplete_authority: "${field}" must be an array`);
    }
  }
  for (const policy of ['modelPolicy', 'dataSharing'] as const) {
    const value = bundle[policy];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`incomplete_authority: "${policy}" must be an object`);
    }
  }
  if ((bundle.productTypes as unknown[]).length === 0) {
    throw new Error('incomplete_authority: no product types');
  }
  if ((bundle.attributes as unknown[]).length === 0) {
    throw new Error('incomplete_authority: no attributes');
  }
}

/**
 * Freeze one coherent authority capture: validated config bundle +
 * bijectively-verified pages, hashed canonically (hashCanonicalJson, never
 * insertion-order JSON). Fails closed on missing release pin, missing page
 * catalog, or page identity drift.
 */
export function capturePreparationAuthority(deps: AuthorityCaptureDeps): PreparationAuthorityView {
  const release = deps.readReleasePin();
  if (!release) throw new Error('incomplete_authority: workspace has no active taxonomy release pin');
  const authority = deps.loadAuthority();
  const bundle = bundleOf(authority);
  requireCompleteBundle(bundle);
  const snapshot = deps.capturePages(deps.workspaceId);
  if (!snapshot.pageImportId || !snapshot.pageImportHash || snapshot.records.length === 0) {
    throw new Error('no_verified_page_catalog: cannot prepare without an active verified page import');
  }
  const verified = new Set(snapshot.verifiedPageIds);
  for (const record of snapshot.records) {
    if (!verified.has(record.pageId)) {
      throw new Error(`page_identity_mismatch: page "${record.pageId}" is not a verified page id`);
    }
    if (record.sourceHash !== snapshot.pageImportHash) {
      throw new Error(`page_identity_mismatch: source hash drift for page "${record.pageId}"`);
    }
  }
  if (verified.size !== snapshot.records.length) {
    throw new Error('page_identity_mismatch: verified id set and page records diverge');
  }
  const binding: PreparationAuthorityBinding = {
    workspaceId: deps.workspaceId,
    release,
    catalogGitCommit: deps.readCatalogCommit(),
    configHash: hashCanonicalJson(bundle),
    capturedAt: new Date().toISOString(),
    pageImportId: snapshot.pageImportId,
    pageImportHash: snapshot.pageImportHash,
  };
  const payload: Record<string, unknown> = {
    bundle,
    pages: snapshot.records,
    binding,
  };
  // capturedAt is observation metadata, not authority identity: excluded from
  // the hash domain so coherent recaptures compare equal.
  const { capturedAt: _observedAt, ...bindingIdentity } = binding;
  return {
    authorityHash: hashCanonicalJson({ bundle, pages: snapshot.records, binding: bindingIdentity }),
    binding,
    counts: {
      productTypes: (bundle.productTypes as unknown[]).length,
      attributes: (bundle.attributes as unknown[]).length,
      pages: snapshot.records.length,
    },
    pageIds: snapshot.records.map(record => record.pageId),
    payload,
  };
}

/**
 * Revalidate against a freshly reloaded capture: reload the actual config +
 * page import under a coherent capture and require identical canonical hashes.
 */
export function revalidatePreparationAuthority(view: PreparationAuthorityView, deps: AuthorityCaptureDeps): void {
  const fresh = capturePreparationAuthority(deps);
  if (fresh.authorityHash !== view.authorityHash) {
    throw new Error('authority_hash_drift: reloaded authority does not match frozen hash');
  }
  if (fresh.binding.configHash !== view.binding.configHash) {
    throw new Error('config_drift: config hash mismatch');
  }
  if (fresh.binding.pageImportHash !== view.binding.pageImportHash) {
    throw new Error('page_identity_mismatch: page import hash mismatch');
  }
}

// ─── Source candidates + family-locked manifests ─────────────────────────────

export function validateSourceCandidates(candidates: unknown[]): JevSourceCandidate[] {
  const parsed = candidates.map((candidate, index) => {
    const forbidden = findForbiddenSourceFields(candidate);
    if (forbidden.length > 0) {
      throw new Error(`forbidden_source_field: row ${index}: ${forbidden.join(', ')}`);
    }
    const result = JevSourceCandidateSchema.safeParse(candidate);
    if (!result.success) {
      const missingProvenance =
        candidate !== null &&
        typeof candidate === 'object' &&
        (!('sourceHash' in candidate) || !('sourceLocator' in candidate) || !('canonicalUrl' in candidate));
      if (missingProvenance) {
        throw new Error(`omitted_source_provenance: row ${index} lacks source hash/locator/url`);
      }
      throw new Error(`invalid_source_candidate: row ${index}: ${result.error.issues[0]?.message ?? 'invalid'}`);
    }
    return result.data;
  });
  // Collision checks: no duplicated SKU. A shared canonical URL is valid
  // ONLY for coherent size/flavor variants of one manufacturer page: same
  // family, same product identity, same source locator and source hash.
  // Cross-family or contradictory-identity URL sharing fails closed.
  const skus = new Set<string>();
  const urls = new Map<string, JevSourceCandidate>();
  for (const row of parsed) {
    if (skus.has(row.sku)) throw new Error(`duplicate_source_sku: "${row.sku}" appears twice`);
    skus.add(row.sku);
    const owner = urls.get(row.canonicalUrl);
    if (owner !== undefined) {
      assertVariantCoherentUrl(owner, row);
    } else {
      urls.set(row.canonicalUrl, row);
    }
  }
  return parsed;
}

function assertVariantCoherentUrl(first: JevSourceCandidate, second: JevSourceCandidate): void {
  const url = second.canonicalUrl;
  if (first.familyId !== second.familyId) {
    throw new Error(
      `duplicate_source_url: "${url}" shared across families "${first.familyId}" and "${second.familyId}"`,
    );
  }
  if (first.productIdentity !== second.productIdentity) {
    throw new Error(
      `duplicate_source_url: "${url}" claims contradictory identities "${first.productIdentity}" and "${second.productIdentity}"`,
    );
  }
  if (first.sourceLocator !== second.sourceLocator || first.sourceHash !== second.sourceHash) {
    throw new Error(`duplicate_source_url: "${url}" shares a page but not the record source`);
  }
}

export interface FamilySplitOptions {
  splitSeed: number;
  holdoutPercent?: number;
}

/**
 * Family-locked manifest using the EXISTING family grouping + splitForFamily.
 * Families are never invented to fill quota; the caller supplies familyId per
 * candidate and separation is proven with verifyFamilySeparation.
 */
export function assignFamilyManifest(
  candidates: JevSourceCandidate[],
  options: FamilySplitOptions,
): JevManifestEntry[] {
  const holdoutPercent = options.holdoutPercent ?? 20;
  const entries: JevManifestEntry[] = candidates.map(candidate => ({
    sku: candidate.sku,
    familyId: candidate.familyId,
    splitGroup: splitForFamily(candidate.familyId, options.splitSeed, holdoutPercent),
    sourceHash: candidate.sourceHash,
    canonicalUrl: candidate.canonicalUrl,
  }));
  if (entries.length === 0) return entries;
  const proof = verifyFamilySeparation(
    entries.map(e => ({ sku: e.sku, familyId: e.familyId, split: e.splitGroup })),
  );
  if (!proof.passed || proof.leakedFamilies.length > 0) {
    const names = proof.leakedFamilies.map(f => f.familyId).join(', ');
    throw new Error(`family_split_leakage: same family in both splits: ${names}`);
  }
  return entries;
}

/**
 * Explicit-write accounting for `--write` runs: mirrors the dry-run counts
 * but reports `dryRun: false` with the ACTUAL number of files written.
 * `dbWrites` is always 0 (database/routing writes never happen).
 */
export function buildWriteResult(args: {
  workspaceId: string;
  authority: PreparationAuthorityView;
  candidates: JevSourceCandidate[];
  manifest: JevManifestEntry[];
  filesWritten: number;
  outDir: string;
}): JevWriteResult {
  const splitDistribution = { train: 0, test: 0, holdout: 0 };
  for (const entry of args.manifest) splitDistribution[entry.splitGroup]++;
  return {
    dryRun: false,
    workspaceId: args.workspaceId,
    authorityHash: args.authority.authorityHash,
    candidateCount: args.candidates.length,
    familyCount: new Set(args.candidates.map(c => c.familyId)).size,
    splitDistribution,
    dbWrites: 0,
    filesWritten: args.filesWritten,
    outDir: args.outDir,
  };
}

export function buildDryRunSummary(args: {
  workspaceId: string;
  authority: PreparationAuthorityView;
  candidates: JevSourceCandidate[];
  manifest: JevManifestEntry[];
}): JevDryRunSummary {
  const splitDistribution = { train: 0, test: 0, holdout: 0 };
  for (const entry of args.manifest) splitDistribution[entry.splitGroup]++;
  return {
    dryRun: true,
    workspaceId: args.workspaceId,
    authorityHash: args.authority.authorityHash,
    candidateCount: args.candidates.length,
    familyCount: new Set(args.candidates.map(c => c.familyId)).size,
    splitDistribution,
    writes: 0,
  };
}
