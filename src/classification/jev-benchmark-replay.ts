/**
 * Bounded development replay wiring for the user-approved representative
 * benchmark (`docs/audits/jev-representative-v1`, issue #302 follow-up).
 *
 * Boundaries (fail-closed, no LIVE calls from this module):
 * - DEV ONLY: loads explicit external manifest/gold/taxonomy inputs whose
 *   entries are all `split: 'dev'`. Private holdout custody is NEVER read —
 *   any holdout/private path or sealed-holdout content is denied before load.
 * - Gold-independent inputs: candidate option sets come from the frozen
 *   authority snapshot (bundle + verified pages), never from gold labels.
 * - Candidate-only live capture is gated behind explicit
 *   `--live-capture --model=<id>` + credential; the incumbent side stays
 *   `deterministic_floor` unless an explicit isolated-store incumbent route
 *   is provided. This module performs NO transport itself — it only
 *   preflights budgets and resolves routes so the existing capture seams
 *   (`buildQualificationPredictionsFromCode` /
 *   `captureQualificationPredictionsLive`) do the work.
 * - Single-Choice replay is an ISOLATED context approximation, never cohort
 *   qualification. Qualification stays blocked; candidate-only probability
 *   calibration is allowed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { hashCanonicalJson } from '../shared/stable-id';
import { assertGoldWithinFrozenTaxonomy } from './benchmark-exporter';
import { FrozenTaxonomySnapshotSchema, type FrozenTaxonomySnapshot } from '../shared/schemas/classification';
import { JevReplayBudgetSchema } from '../shared/schemas/jev-benchmark';
import {
  parseQualificationGoldOnly,
  buildQualificationCandidateQuestionSet,
  partitionCandidateQuestionsByPermittedEvidence,
  qualificationTaxonomiesFromFrozenSnapshot,
  withFrozenAuthorityDetails,
  JEV_MAX_ORDINARY_CHOICE_CANDIDATES,
  type FrozenAuthorityDetails,
  type QualificationGoldOnlyEntry,
} from './benchmark-prediction';

/** Default dev budget: max HTTP attempts before dispatch. */
export const DEV_REPLAY_DEFAULT_MAX_HTTP_ATTEMPTS = 600;
/** Max transport concurrency for dev replay. */
export const DEV_REPLAY_MAX_CONCURRENCY = 2;
export const DEV_REPLAY_DEFAULT_DEADLINE_MS = 300_000;
/** Representative authority dir (public docs only). */
export const REPRESENTATIVE_V1_DIR = 'docs/audits/jev-representative-v1';
/** Default representative inputs (dev gold + full taxonomy bundle + binding). */
export const REPRESENTATIVE_DEV_GOLD_PATH = `${REPRESENTATIVE_V1_DIR}/development-gold.json`;
export const REPRESENTATIVE_TAXONOMY_PATH = `${REPRESENTATIVE_V1_DIR}/taxonomy.json`;
export const REPRESENTATIVE_MANIFEST_PATH = `${REPRESENTATIVE_V1_DIR}/manifest.json`;

/** Path components that always denote holdout/custody/sealed payloads (never dev inputs). */
const PROTECTED_DEV_PATH_COMPONENTS = ['holdout', 'custody', 'sealed'] as const;
/** Legacy full-string markers for sealed private custody (kept for raw-string fast fail). */
const LEGACY_PRIVATE_CUSTODY_MARKERS = ['holdout-gold', 'holdout-adjudication', 'private-custody', 'private_custody', 'holdout-private', 'holdout_gold'] as const;
/** Expected dev-input filenames in the approved public artifact directory. */
export const KNOWN_PUBLIC_DEV_FILENAMES = ['manifest.json', 'development-gold.json', 'taxonomy.json'] as const;

/** Path scope for the component check: inside-cwd paths are judged relative (stable across machines). */
function devPathCheckTarget(candidatePath: string): string {
  const abs = path.resolve(candidatePath);
  const rel = path.relative(process.cwd(), abs);
  return rel.startsWith('..') || path.isAbsolute(rel) ? abs : rel;
}

/**
 * True when a path points at holdout/custody/sealed payloads (never readable
 * as a dev replay input). Checks the raw path AND its realpath target, so a
 * renamed copy, a custom-cased directory (e.g. `.../jev-representative-custody/
 * holdout-primary-private.json`), a bare `holdout.json`, or a symlink into a
 * protected location all fail. The public custody-metadata filename is NOT
 * exempt: it is never a replay input either. Missing files fall back to the
 * raw-path check (existence is proven later at bind time).
 */
export function isPrivateHoldoutPath(candidatePath: string): boolean {
  const lowered = candidatePath.toLowerCase();
  if (LEGACY_PRIVATE_CUSTODY_MARKERS.some(m => lowered.includes(m))) return true;
  const candidates = [devPathCheckTarget(candidatePath)];
  try {
    candidates.push(devPathCheckTarget(fs.realpathSync(path.resolve(candidatePath))));
  } catch {
    // Unresolvable here — bindDevReplayPaths fails closed on it explicitly.
  }
  return candidates.some(target =>
    target
      .split(path.sep)
      .map(c => c.toLowerCase())
      .some(component => PROTECTED_DEV_PATH_COMPONENTS.some(m => component.includes(m))),
  );
}

/** Deny private holdout access before any read (throws fail-closed). */
export function assertNoHoldoutAccess(candidatePath: string): void {
  if (isPrivateHoldoutPath(candidatePath)) {
    throw new Error(`holdout_sealed: dev replay must never read holdout/custody/sealed payloads ("${candidatePath}").`);
  }
}

export interface BoundDevReplayPaths {
  manifestReal: string;
  goldReal: string;
  taxonomyReal: string;
  dir: string;
}

/**
 * Bind the three dev inputs to ONE public artifact directory BEFORE any file
 * bytes are read (realpathSync stats, never readFileSync). Fails closed on:
 * protected components in the raw path or the symlink-resolved realpath, an
 * unresolvable path, or inputs that do not share a single directory. A
 * renamed private copy elsewhere cannot be read without a same-directory
 * public manifest commitment (see verifyManifestDeclaredInputs).
 */
export function bindDevReplayPaths(args: {
  manifestPath: string;
  goldPath: string;
  taxonomyPath: string;
}): BoundDevReplayPaths {
  const raws = [args.manifestPath, args.goldPath, args.taxonomyPath] as const;
  const reals = raws.map(raw => {
    assertNoHoldoutAccess(raw);
    let real: string;
    try {
      real = fs.realpathSync(path.resolve(raw));
    } catch {
      throw new Error(`dev_replay_unresolvable_path: cannot resolve "${raw}" (missing or dangling symlink).`);
    }
    assertNoHoldoutAccess(real);
    return real;
  });
  const dirs = new Set(reals.map(p => path.dirname(p)));
  if (dirs.size !== 1) {
    throw new Error(
      `dev_replay_unbound_inputs: manifest/gold/taxonomy must resolve to the SAME public artifact directory (got ${[...dirs].join(', ')}).`,
    );
  }
  const [manifestReal, goldReal, taxonomyReal] = reals;
  return { manifestReal, goldReal, taxonomyReal, dir: [...dirs][0] };
}

/** One manifest-declared file record: basename + optional sha256 commitment. */
interface ManifestDeclaredFile {
  basename: string;
  sha256: string | null;
}

/** Collect `{path, sha256?}` + `{XxxPath, XxxHash?}` declarations from a manifest (metadata only). */
function collectManifestDeclaredFiles(manifest: unknown): ManifestDeclaredFile[] {
  const out: ManifestDeclaredFile[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.path === 'string') {
      const sha = typeof record.sha256 === 'string' ? record.sha256 : null;
      out.push({ basename: path.basename(record.path), sha256: sha });
    }
    for (const [key, keyValue] of Object.entries(record)) {
      if (key.endsWith('Path') && typeof keyValue === 'string') {
        const stem = key.slice(0, -'Path'.length);
        const hashValue = record[`${stem}Hash`];
        out.push({
          basename: path.basename(keyValue),
          sha256: typeof hashValue === 'string' ? hashValue : null,
        });
      }
      if (keyValue && typeof keyValue === 'object') visit(keyValue);
    }
  };
  visit(manifest);
  return out;
}

/**
 * Verify the manifest's public source commitment BEFORE gold/taxonomy labels
 * are read: gold + taxonomy basenames must be expected public filenames or
 * manifest-declared paths, and every declared sha256 for an in-directory file
 * must match its bytes. Byte reads here are hash verification of
 * allowlisted/committed files only — labels are parsed afterwards.
 */
export function verifyManifestDeclaredInputs(bound: BoundDevReplayPaths, manifest: unknown): void {
  const declared = collectManifestDeclaredFiles(manifest);
  const committed = new Set<string>([
    ...KNOWN_PUBLIC_DEV_FILENAMES,
    ...declared.map(d => d.basename),
  ]);
  for (const [label, real] of [['gold', bound.goldReal], ['taxonomy', bound.taxonomyReal]] as const) {
    if (!committed.has(path.basename(real))) {
      throw new Error(`dev_replay_undeclared_input: ${label} "${path.basename(real)}" is neither an expected public filename nor manifest-declared.`);
    }
  }
  for (const file of declared) {
    if (!file.sha256) continue;
    const abs = path.resolve(bound.dir, file.basename);
    if (path.dirname(abs) !== bound.dir || !fs.existsSync(abs)) continue;
    const actual = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    if (actual !== file.sha256.toLowerCase()) {
      throw new Error(`dev_replay_hash_mismatch: "${file.basename}" does not match the manifest-declared sha256.`);
    }
  }
}

export interface DevReplayInputs {
  manifestPath: string;
  goldPath: string;
  taxonomyPath: string;
  authorityHash: string;
  goldEntries: QualificationGoldOnlyEntry[];
  frozenSnapshot: FrozenTaxonomySnapshot;
  /** Frozen grounding details the snapshot schema has no slot for (aliases, catalog fields, claim flags). */
  authorityDetails: FrozenAuthorityDetails;
  entryCount: number;
  familyCount: number;
}

/**
 * Extract frozen grounding details from the approved bundle (metadata for
 * permission/grounding parity — never labels): per-target catalog-field
 * mapping from curation targets + per-attribute aliases/claim/composition/
 * visual-eligibility flags. Unknown shapes are skipped (stub behavior
 * downstream), never invented.
 */
export function extractFrozenAuthorityDetails(bundle: Record<string, unknown>): FrozenAuthorityDetails {
  const catalogFieldByTarget: Record<string, string | null> = {};
  const attributeConfigByTarget: NonNullable<FrozenAuthorityDetails['attributeConfigByTarget']> = {};
  const attributeNameByTarget: Record<string, string> = {};
  const attributeDescriptionByTarget: Record<string, string | null> = {};
  const targetLabelByTarget: Record<string, string> = {};
  const attributes = bundle.attributes;
  if (Array.isArray(attributes)) {
    for (const raw of attributes) {
      if (!raw || typeof raw !== 'object') continue;
      const attr = raw as Record<string, unknown>;
      if (typeof attr.id !== 'string') continue;
      const aliases = Array.isArray(attr.valueAliases)
        ? attr.valueAliases.filter(
          (a): a is { alias: string; mapsTo: string } =>
            !!a && typeof a === 'object' && typeof (a as { alias?: unknown }).alias === 'string' && typeof (a as { mapsTo?: unknown }).mapsTo === 'string',
        ).map(a => ({ alias: a.alias, mapsTo: a.mapsTo }))
        : [];
      attributeConfigByTarget[attr.id] = {
        valueAliases: aliases,
        isClaim: attr.isClaim === true,
        isCompositionAttribute: attr.isCompositionAttribute === true,
        visualEvidenceEligibility: attr.visualEvidenceEligibility === 'ineligible' ? 'ineligible' : 'eligible',
      };
      // REAL configured meaning (never opaque ids, never invented): name +
      // explicit definition (null = explicitly empty) from the bundle.
      if (typeof attr.name === 'string' && attr.name.length > 0) {
        attributeNameByTarget[attr.id] = attr.name;
      }
      if (attr.description === null || attr.description === undefined) {
        attributeDescriptionByTarget[attr.id] = null;
      } else if (typeof attr.description === 'string') {
        attributeDescriptionByTarget[attr.id] = attr.description;
      }
    }
  }
  const targets = bundle.curationTargets;
  if (Array.isArray(targets)) {
    for (const raw of targets) {
      if (!raw || typeof raw !== 'object') continue;
      const target = raw as Record<string, unknown>;
      if (typeof target.attributeId !== 'string') continue;
      catalogFieldByTarget[target.attributeId] =
        typeof target.catalogField === 'string' ? target.catalogField : null;
      // REAL configured target label (model-visible question text).
      if (typeof target.label === 'string' && target.label.length > 0) {
        targetLabelByTarget[target.attributeId] = target.label;
      }
    }
  }
  return { catalogFieldByTarget, attributeConfigByTarget, attributeNameByTarget, attributeDescriptionByTarget, targetLabelByTarget };
}

/**
 * Recompute the EXACT producer-domain authority hash from raw taxonomy bytes:
 * hashCanonicalJson over {bundle, pages, binding-minus-capturedAt} — the same
 * domain `capturePreparationAuthority` binds (capturedAt is observation
 * metadata, never identity). Reuses the shared canonical hash, no invented
 * domain. Throws before any conversion/capture surface on shape gaps.
 */
export function recomputeTaxonomyAuthorityHash(taxonomyRaw: {
  bundle?: unknown;
  pages?: unknown;
  binding?: unknown;
}): string {
  const { bundle, pages, binding } = taxonomyRaw;
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new Error('incomplete_authority: taxonomy file must carry {bundle, pages, binding} before authority recomputation.');
  }
  if (!Array.isArray(pages)) {
    throw new Error('incomplete_authority: taxonomy file must carry {bundle, pages, binding} before authority recomputation.');
  }
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    throw new Error('incomplete_authority: taxonomy file must carry {bundle, pages, binding} before authority recomputation.');
  }
  const { capturedAt: _observedAt, ...bindingIdentity } = binding as Record<string, unknown>;
  return hashCanonicalJson({ bundle, pages, binding: bindingIdentity });
}

/**
 * Load explicit external manifest/gold/taxonomy inputs for a DEV replay.
 * Path facts first (realpaths, protected-component denial incl. symlink
 * targets, same-directory binding — zero readFileSync), then manifest
 * metadata (declared paths + hashes), then the producer-domain authority
 * RECOMPUTED from raw taxonomy bytes (declared strings alone never suffice),
 * then labels. Fails closed on:
 * holdout/custody/sealed paths, unbound directories, undeclared inputs,
 * hash mismatch, authority-hash drift (declared OR recomputed), non-dev
 * splits, malformed gold (via the shared `parseQualificationGoldOnly` —
 * string shape only, never authority containment), gold outside the frozen
 * pool (via the EXISTING `assertGoldWithinFrozenTaxonomy` — every known
 * type/target/value/page id must sit within the converted snapshot), or
 * frozen-snapshot validation failure. Per-target outcomes are preserved
 * byte-for-byte by the shared parser (never normalized to empty).
 */
export function loadDevReplayInputs(args: {
  manifestPath: string;
  goldPath: string;
  taxonomyPath: string;
}): DevReplayInputs {
  const bound = bindDevReplayPaths(args);
  const manifest = JSON.parse(fs.readFileSync(bound.manifestReal, 'utf8')) as { authorityHash?: unknown; binding?: unknown };
  verifyManifestDeclaredInputs(bound, manifest);
  const goldRaw = JSON.parse(fs.readFileSync(bound.goldReal, 'utf8'));
  const taxonomyRaw = JSON.parse(fs.readFileSync(bound.taxonomyReal, 'utf8')) as {
    bundle?: unknown;
    pages?: unknown;
    binding?: unknown;
    authorityHash?: unknown;
  };
  const authorityHash = typeof (goldRaw as { authorityHash?: unknown }).authorityHash === 'string'
    ? (goldRaw as { authorityHash: string }).authorityHash
    : null;
  if (!authorityHash) throw new Error('dev_replay_authority_missing: development gold carries no authorityHash.');
  for (const [label, value] of [
    ['manifest', (manifest as { authorityHash?: unknown }).authorityHash],
    ['taxonomy', taxonomyRaw.authorityHash],
  ] as const) {
    if (typeof value === 'string' && value !== authorityHash) {
      throw new Error(`authority_hash_drift: ${label} authority does not match dev gold authority.`);
    }
  }
  // Producer-domain recomputation BEFORE conversion/capture: tampered bundle,
  // pages, or binding bytes with an unchanged declared string still fail.
  const recomputedAuthorityHash = recomputeTaxonomyAuthorityHash(taxonomyRaw);
  if (recomputedAuthorityHash !== authorityHash) {
    throw new Error(
      `authority_hash_drift: recomputed producer-domain hash ${recomputedAuthorityHash.slice(0, 12)}… does not match declared dev gold authority ${authorityHash.slice(0, 12)}… (raw taxonomy bytes drifted; refusing conversion/capture).`,
    );
  }
  const goldEntries = parseQualificationGoldOnly(goldRaw);
  if (goldEntries.length === 0) throw new Error('dev_replay_empty: development gold has no entries.');
  const nonDev = goldEntries.filter(e => (e as { split?: unknown }).split !== 'dev');
  if (nonDev.length > 0) throw new Error(`split_violation: dev replay gold must be all split=dev (${nonDev.length} non-dev entries).`);
  if (!taxonomyRaw.bundle || !taxonomyRaw.pages || !taxonomyRaw.binding) {
    throw new Error('incomplete_authority: taxonomy file must carry {bundle, pages, binding}.');
  }
  const frozenSnapshot = convertRepresentativeToFrozenSnapshot(
    taxonomyRaw.bundle as Record<string, unknown>,
    taxonomyRaw.pages as Array<Record<string, unknown>>,
  );
  // Authority containment BEFORE returning dev inputs: string-shaped gold
  // parsing is never pool membership — every known type/target/value/page id
  // must sit within the converted frozen snapshot (existing exporter seam).
  assertGoldWithinFrozenTaxonomy(goldEntries, frozenSnapshot);
  const details = extractFrozenAuthorityDetails(taxonomyRaw.bundle as Record<string, unknown>);
  // FULL canonical authority binding: the manifest/gold-agreed authority hash
  // rides the details sidecar into the artifact identity (strict-validated,
  // never invented — the loader proved agreement above).
  details.authorityHash = authorityHash;
  return {
    manifestPath: bound.manifestReal,
    goldPath: bound.goldReal,
    taxonomyPath: bound.taxonomyReal,
    authorityHash,
    goldEntries,
    frozenSnapshot,
    authorityDetails: details,
    entryCount: goldEntries.length,
    familyCount: new Set(goldEntries.map(e => e.familyId)).size,
  };
}

/** Gaps the snapshot schema cannot carry (reported, never invented). */
export const DEV_REPLAY_KNOWN_SNAPSHOT_GAPS = [
  'oldIdAliases ride in the source bundle only (FrozenTaxonomySnapshot has no alias slot; questions use canonical labels)',
  'guidance/evidencePolicy/modelPolicy/dataSharing ride in the source bundle only (no snapshot slot; shipped profile helpers enforce applicability at capture)',
  'page assignment policy advisory rides in the source bundle only (page Choice respects verified pageId pool + no_reviewed_product_type authority rule)',
  'frozen valueAliases/catalog fields/claim flags/attribute names/definitions/target labels ride the hashed validated sidecar (FrozenAuthorityDetails), not the strict snapshot schema',
] as const;

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Convert the full approved config (bundle) + public verified pages to the
 * existing FrozenTaxonomySnapshot runtime. Real profiles, per-profile
 * cardinality, applicability conditions, invariants, universals, and the
 * complete candidate pool ride through; gold labels are never an input.
 * Missing authority structures throw `incomplete_authority` with the gap
 * named (never invented). Known schema gaps are listed in
 * `DEV_REPLAY_KNOWN_SNAPSHOT_GAPS`.
 */
export function convertRepresentativeToFrozenSnapshot(
  bundle: Record<string, unknown>,
  pages: Array<Record<string, unknown>>,
): FrozenTaxonomySnapshot {
  const productTypes = bundle.productTypes as Array<Record<string, unknown>> | undefined;
  const attributes = bundle.attributes as Array<Record<string, unknown>> | undefined;
  const attributeProfiles = bundle.attributeProfiles as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(productTypes) || productTypes.length === 0) {
    throw new Error('incomplete_authority: bundle.productTypes must be a non-empty array (gap: product-type pool unresolvable).');
  }
  if (!Array.isArray(attributes) || attributes.length === 0) {
    throw new Error('incomplete_authority: bundle.attributes must be a non-empty array (gap: attribute pool unresolvable).');
  }
  if (!Array.isArray(attributeProfiles) || attributeProfiles.length === 0) {
    throw new Error('incomplete_authority: bundle.attributeProfiles must be a non-empty array (gap: frozen applicability mapping absent; refusing to broaden).');
  }
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('no_verified_page_catalog: cannot replay without verified pages (gap: page candidate pool empty).');
  }
  const frozenProductTypes = productTypes.map(t => {
    if (typeof t.id !== 'string' || typeof t.name !== 'string') {
      throw new Error('incomplete_authority: bundle product type lacks id/name.');
    }
    const out: Record<string, unknown> = { id: t.id, label: t.name };
    if (t.attributeProfileId !== undefined) out.attributeProfileId = t.attributeProfileId;
    if (t.invariantAttributes !== undefined) out.invariantAttributes = t.invariantAttributes;
    // REAL configured definition: pass through actual NONEMPTY strings only;
    // absent/null stay omitted (legacy hashes stable); non-string
    // descriptions fail closed (never silently omitted, never invented).
    // The strict schema holds the slot, so safeParse carries it through.
    if (t.description !== null && t.description !== undefined) {
      if (typeof t.description !== 'string') {
        throw new Error(`incomplete_authority: bundle product type "${t.id}" has a malformed non-string description.`);
      }
      if (t.description.length > 0) {
        out.description = t.description;
      }
    }
    return out;
  });
  const frozenTargets = (attributes as Array<Record<string, unknown>>)
    .filter(a => a.valueMode === 'controlled' && Array.isArray(a.allowedValues))
    .map(a => ({
      targetId: a.id as string,
      cardinality: 'single' as const,
      options: [...new Set((a.allowedValues as unknown[]).map(String))].sort(),
      ...(a.isUniversal === true ? { isUniversal: true } : {}),
    }));
  if (frozenTargets.length === 0) {
    throw new Error('incomplete_authority: no controlled attribute targets with allowedValues (gap: attribute candidate pool empty).');
  }
  const frozenProfiles = attributeProfiles.map(p => {
    if (typeof p.id !== 'string' || typeof p.productTypeId !== 'string' || !Array.isArray(p.attributes)) {
      throw new Error('incomplete_authority: attribute profile lacks id/productTypeId/attributes.');
    }
    return {
      id: p.id,
      productTypeId: p.productTypeId,
      attributes: (p.attributes as Array<Record<string, unknown>>).map(a => {
        if (typeof a.attributeId !== 'string' || (a.cardinality !== 'single' && a.cardinality !== 'multiple')) {
          throw new Error('incomplete_authority: profile attribute lacks attributeId/cardinality.');
        }
        return {
          attributeId: a.attributeId,
          cardinality: a.cardinality,
          required: a.required === true,
          applicabilityConditions: Array.isArray(a.applicabilityConditions) ? a.applicabilityConditions : [],
        };
      }),
    };
  });
  const frozenPages = pages.map(p => {
    if (typeof p.pageId !== 'string' || typeof p.pageName !== 'string') {
      throw new Error('incomplete_authority: verified page lacks pageId/pageName.');
    }
    return { pageId: p.pageId, pageName: p.pageName };
  });
  const universalAttributeIds = (attributes as Array<Record<string, unknown>>)
    .filter(a => a.isUniversal === true && typeof a.id === 'string')
    .map(a => a.id as string)
    .sort();
  const core = {
    productTypes: [...frozenProductTypes].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    attributeTargets: [...frozenTargets].sort((a, b) => a.targetId.localeCompare(b.targetId)),
    pages: [...frozenPages].sort((a, b) => a.pageId.localeCompare(b.pageId)),
    attributeProfiles: frozenProfiles,
    universalAttributeIds,
  };
  const snapshot = {
    snapshotHash: stableHash(core),
    source: 'jev-representative-v1',
    capturedAt: new Date().toISOString(),
    ...core,
  };
  const parsed = FrozenTaxonomySnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new Error(`incomplete_authority: converted snapshot failed validation (${parsed.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}).`);
  }
  return parsed.data;
}

// ─── Budget preflight (dry-run before dispatch) ──────────────────────────────

export interface ReplayBudget {
  maxHttpAttempts: number;
  maxConcurrency: number;
  hardDeadlineMs: number | null;
}

export function defaultDevReplayBudget(overrides: Partial<ReplayBudget> = {}): ReplayBudget {
  const parsed = JevReplayBudgetSchema.safeParse({
    maxHttpAttempts: DEV_REPLAY_DEFAULT_MAX_HTTP_ATTEMPTS,
    maxConcurrency: DEV_REPLAY_MAX_CONCURRENCY,
    ...overrides,
    hardDeadlineMs: overrides.hardDeadlineMs ?? DEV_REPLAY_DEFAULT_DEADLINE_MS,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`invalid_replay_budget: ${issue.path.join('.')}: ${issue.message}`);
  }
  return parsed.data;
}

export interface BudgetPreflightResult {
  allowed: boolean;
  plannedHttpAttempts: number;
  entryCount: number;
  maxHttpAttempts: number;
  maxConcurrency: number;
  reason: string;
}

/**
 * Dry-run budget preflight enforced BEFORE transport/chunks/retries using the
 * existing transport/capture seams. `plannedHttpAttempts` is the exact
 * derived plan (see `planDevReplayBudget`: entries × question batches × max
 * retry); when it exceeds `maxHttpAttempts` the replay is denied before
 * dispatch. Live mode additionally requires a bound runtime guard supplied
 * end to end through the real capture request path (see
 * `isLiveRuntimeGuardWired`) — never a global flag.
 */

/** In-memory audit for one bound guard (counts + outcomes only, never secrets). */
export interface DevAttemptGuardAudit {
  consumed: number;
  rejected: number;
  maxHttpAttempts: number;
  deadlineFired: boolean;
}

/** Bound runtime guard: per-attempt budget + hard-deadline abort for one replay. */
export interface DevAttemptGuard {
  tryConsumeAttempt: () => boolean;
  signal: AbortSignal;
  audit: () => DevAttemptGuardAudit;
  dispose: () => void;
}

/**
 * Create the bound runtime guard for one dev replay. The budget counts once
 * per HTTP attempt (primary + the single retry each consume); exhaustion
 * fails closed with no dispatch. The hard deadline aborts in-flight and
 * future attempts via the signal (cancellation propagates, never retries).
 * Concurrency >2 is rejected (capture runs sequentially, within limit).
 * Nothing is persisted; the audit is in-memory only.
 */
export function createDevAttemptGuard(args: {
  maxHttpAttempts: number;
  maxConcurrency?: number;
  hardDeadlineMs?: number | null;
}): DevAttemptGuard {
  const budget = defaultDevReplayBudget({
    maxHttpAttempts: args.maxHttpAttempts,
    ...(args.maxConcurrency === undefined ? {} : { maxConcurrency: args.maxConcurrency }),
    hardDeadlineMs: args.hardDeadlineMs,
  });
  if (args.maxConcurrency !== undefined && args.maxConcurrency > DEV_REPLAY_MAX_CONCURRENCY) {
    throw new Error(`concurrency_exceeded: max ${args.maxConcurrency} exceeds dev cap ${DEV_REPLAY_MAX_CONCURRENCY}.`);
  }
  let consumed = 0;
  let rejected = 0;
  let deadlineFired = false;
  const controller = new AbortController();
  const deadlineMs = budget.hardDeadlineMs ?? DEV_REPLAY_DEFAULT_DEADLINE_MS;
  const deadlineAt = performance.now() + deadlineMs;
  const expire = () => {
    deadlineFired = true;
    controller.abort(new Error(`dev replay hard deadline exceeded after ${budget.hardDeadlineMs}ms`));
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (budget.hardDeadlineMs !== null) {
    timer = setTimeout(expire, budget.hardDeadlineMs);
    timer.unref?.();
  }
  return {
    tryConsumeAttempt: () => {
      // Timers can be delayed by synchronous preparation/JSON work. Check
      // monotonic elapsed time at the actual boundary as well as the signal.
      if (performance.now() >= deadlineAt) expire();
      if (controller.signal.aborted) {
        rejected += 1;
        return false;
      }
      if (consumed >= budget.maxHttpAttempts) {
        rejected += 1;
        return false;
      }
      consumed += 1;
      return true;
    },
    signal: controller.signal,
    audit: () => ({ consumed, rejected, maxHttpAttempts: budget.maxHttpAttempts, deadlineFired }),
    dispose: () => {
      if (timer) clearTimeout(timer);
      controller.abort(new Error('dev replay guard disposed'));
    },
  };
}

/**
 * True only when a bound guard is actually supplied end to end (object with
 * a `tryConsumeAttempt` function and an AbortSignal `signal`). Never a global
 * flag: unwired callers stay blocked even when every other credential is set.
 */
export function isLiveRuntimeGuardWired(guard: unknown): boolean {
  if (!guard || typeof guard !== 'object') return false;
  const g = guard as Record<string, unknown>;
  return typeof g.tryConsumeAttempt === 'function' && g.signal instanceof AbortSignal;
}

export function dryRunBudgetPreflight(args: {
  entryCount: number;
  plannedHttpAttempts: number;
  budget?: Partial<ReplayBudget>;
}): BudgetPreflightResult {
  const budget = defaultDevReplayBudget(args.budget);
  if (args.plannedHttpAttempts > budget.maxHttpAttempts) {
    return {
      allowed: false,
      plannedHttpAttempts: args.plannedHttpAttempts,
      entryCount: args.entryCount,
      maxHttpAttempts: budget.maxHttpAttempts,
      maxConcurrency: budget.maxConcurrency,
      reason: `candidate_overbudget: planned ${args.plannedHttpAttempts} HTTP attempts exceed max ${budget.maxHttpAttempts} (denied before dispatch).`,
    };
  }
  if (budget.maxConcurrency > DEV_REPLAY_MAX_CONCURRENCY) {
    return {
      allowed: false,
      plannedHttpAttempts: args.plannedHttpAttempts,
      entryCount: args.entryCount,
      maxHttpAttempts: budget.maxHttpAttempts,
      maxConcurrency: budget.maxConcurrency,
      reason: `concurrency_exceeded: max ${budget.maxConcurrency} exceeds dev cap ${DEV_REPLAY_MAX_CONCURRENCY}.`,
    };
  }
  return {
    allowed: true,
    plannedHttpAttempts: args.plannedHttpAttempts,
    entryCount: args.entryCount,
    maxHttpAttempts: budget.maxHttpAttempts,
    maxConcurrency: budget.maxConcurrency,
    reason: 'within_budget',
  };
}

/** Live-capture gate: explicit flags + credential + bound runtime guard, else blocked. */
export function assertLiveCaptureAllowed(args: {
  liveCapture: boolean;
  model: string | null;
  credentialRef: string | null;
  guard?: unknown;
}): void {
  if (!args.liveCapture) throw new Error('live_capture_not_requested: pass explicit --live-capture for dev candidate-only capture.');
  if (!args.model) throw new Error('live_capture_no_model: pass explicit --model=<id> (e.g. jev-1.13.0).');
  if (!args.credentialRef) throw new Error('live_capture_no_credential: no credential ref provisioned; candidate stays blocked (never simulated).');
  if (!isLiveRuntimeGuardWired(args.guard)) {
    throw new Error('live_runtime_guard_unwired: no bound attempt guard supplied through the capture request path — no live mode until the runtime guard is wired end to end.');
  }
}

/**
 * Exact worst-case HTTP plan for a dev replay: per entry, the real shipped
 * question builders run (type phase + attribute/page phase over the LIVE
 * applicable set per effective type — never gold), records batch into
 * transport chunks of 32, and every chunk may spend the single retry. No
 * candidate clipping: over-limit type stages dispatch zero type questions
 * (placeholder) while attributes/pages still capture. questions/batches +
 * max retry must fit the budget.
 */
export interface DevReplayPlan {
  entryCount: number;
  totalQuestions: number;
  dispatchBatches: number;
  plannedHttpAttempts: number;
}

export function planDevReplayBudget(
  entries: QualificationGoldOnlyEntry[],
  frozenSnapshot: FrozenTaxonomySnapshot,
  authorityDetails?: FrozenAuthorityDetails | null,
): DevReplayPlan {
  const CHUNK_SIZE = 32;
  const MAX_ATTEMPTS_PER_BATCH = 2;
  // Live parity: the same authority sidecar the capture path attaches
  // (`withFrozenAuthorityDetails` before `captureQualificationPredictionsLive`
  // in both scripts) rides planning, so visual-eligibility partitioning
  // matches the dispatcher exactly — never the weaker stub default.
  const taxa = qualificationTaxonomiesFromFrozenSnapshot(
    authorityDetails ? withFrozenAuthorityDetails(frozenSnapshot, authorityDetails) : frozenSnapshot,
  );
  let totalQuestions = 0;
  let dispatchBatches = 0;
  // Over-limit closed worlds dispatch zero type questions (placeholder carries
  // no usage); mirror the dispatcher so phase one never over-authorizes.
  const typeOverLimit = taxa.productTypes.length > JEV_MAX_ORDINARY_CHOICE_CANDIDATES;
  for (const entry of entries) {
    const phaseOne = typeOverLimit ? 0 : 1;
    // Phase-two bound FROM the live applicable set per entry: for every
    // frozen effective type the dispatcher could freeze (live capture
    // resolves the type from the model answer, so planning cannot know it),
    // build the same applicable question set + permitted-evidence partition
    // the dispatcher builds (`buildQualificationCandidateQuestionSet(entry,
    // taxa, effectiveTypeId)` + `partitionCandidateQuestionsByPermittedEvidence`
    // with the frozen type) and take the worst case. Profile cardinality flips
    // (single global target → multiple per-profile Noul plans) and authority
    // visual-eligibility splits change both record counts and group keys, so a
    // wiring-set superset argument cannot hold — only the per-type maximum is
    // conservative by construction. Entries whose gold type is known use the
    // single live set; unknown types fall back to the worst case over all
    // frozen types plus the abstained (universals-only, null-type) set.
    const knownTypeId = entry.gold.productType.kind === 'known-type' ? entry.gold.productType.typeId : null;
    const candidateTypeIds: Array<string | null> = knownTypeId !== null
      ? [knownTypeId]
      : [...taxa.productTypes.map(t => t.id), null];
    let phaseTwoQuestions = 0;
    let phaseTwoBatches = 0;
    for (const effectiveTypeId of candidateTypeIds) {
      const applicableQuestions = buildQualificationCandidateQuestionSet(entry, taxa, effectiveTypeId);
      const questionCount = applicableQuestions.attributePlans.reduce(
        (n, p) => n + (p.choicePlan ? 1 : 0) + (p.noulPlans?.length ?? 0),
        0,
      ) + (applicableQuestions.pagePlan ? 1 : 0);
      const groups = partitionCandidateQuestionsByPermittedEvidence(entry, applicableQuestions, effectiveTypeId);
      const batches = groups.reduce((n, group) => n + Math.ceil(group.records.length / CHUNK_SIZE), 0);
      if (questionCount > phaseTwoQuestions) phaseTwoQuestions = questionCount;
      if (batches > phaseTwoBatches) phaseTwoBatches = batches;
    }
    totalQuestions += phaseOne + phaseTwoQuestions;
    // Worst-case retries: every dispatched chunk may spend the single retry
    // (primary + retry each consume the bound guard) — authorized attempts
    // never undercount required requests.
    dispatchBatches += (typeOverLimit ? 0 : Math.ceil(phaseOne / CHUNK_SIZE)) + phaseTwoBatches;
  }
  return {
    entryCount: entries.length,
    totalQuestions,
    dispatchBatches,
    plannedHttpAttempts: dispatchBatches * MAX_ATTEMPTS_PER_BATCH,
  };
}

/**
 * Resolve the capture mode without side effects. An ambient credential alone
 * NEVER implies live: only an explicit `--live-capture` request with a wired
 * bound guard selects live; everything else is the deterministic floor.
 */
export function resolveDevCaptureMode(args: {
  liveCaptureRequested: boolean;
  credentialPresent: boolean;
  guardWired: boolean;
}): 'deterministic_floor' | 'live_captured' {
  if (args.liveCaptureRequested && args.credentialPresent && args.guardWired) return 'live_captured';
  return 'deterministic_floor';
}

// ─── Incumbent / context / capability labels ─────────────────────────────────

export const INCUMBENT_DETERMINISTIC_FLOOR_LABEL = 'deterministic_floor (lower bound, never candidate quality evidence)' as const;

/**
 * Resolve the baseline route. New live baselines require an isolated store +
 * credential ref with proper integration; anything else stays on the labeled
 * deterministic floor instead of routing a different provider or pretending
 * a live CurrentProvider. Returns null (floor) with the blocking reason.
 */
export function resolveBaselineRoute(args: {
  provider?: string | null;
  model?: string | null;
  isolatedStore?: string | null;
  credentialRef?: string | null;
}): { route: { provider: string; model: string; credentialRef: string; isolatedStore: string } | null; blockedReason: string | null } {
  if (!args.provider && !args.model) return { route: null, blockedReason: null };
  if (!args.provider || !args.model) {
    return { route: null, blockedReason: 'baseline_live_requires_isolated_store: provide both provider and model.' };
  }
  if (!args.isolatedStore?.trim() || !args.credentialRef?.trim()) {
    return {
      route: null,
      blockedReason: 'baseline_live_requires_isolated_store: new baseline live capture needs --isolated-store + credential ref; staying on deterministic_floor (never a substituted provider).',
    };
  }
  return { route: { provider: args.provider, model: args.model, credentialRef: args.credentialRef.trim(), isolatedStore: args.isolatedStore.trim() }, blockedReason: null };
}

/** Validate isolation before a baseline runner can initialize its database. */
export function assertIsolatedBaselineStore(
  storePath: string,
  options: { repositoryRoot: string; productionStorePaths: string[] },
): string {
  assertNoHoldoutAccess(storePath);
  const resolved = fs.realpathSync(storePath);
  assertNoHoldoutAccess(resolved);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error('baseline_store_not_isolated: expected an existing database file.');
  const root = fs.realpathSync(options.repositoryRoot);
  const roots = new Set([root]);
  if (fs.existsSync(path.join(root, '.git'))) {
    try {
      const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], {
        cwd: root, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const entry of worktrees.split('\0')) {
        if (!entry.startsWith('worktree ')) continue;
        const worktree = entry.slice('worktree '.length);
        if (fs.existsSync(worktree)) roots.add(fs.realpathSync(worktree));
      }
    } catch {
      throw new Error('baseline_store_not_isolated: repository worktree authority is unavailable.');
    }
  }
  const repositoryLocal = [...roots].some(repository => {
    const relative = path.relative(repository, resolved);
    return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
  });
  if (repositoryLocal || resolved.split(path.sep).includes('.shopsite-cms')) {
    throw new Error('baseline_store_not_isolated: workspace databases cannot be initialized for evaluation.');
  }
  const productionPaths = new Set([...options.productionStorePaths,
    ...[...roots].map(repository => path.join(repository, 'storage/catalog/.shopsite-cms/app.db'))]);
  for (const productionPath of productionPaths) {
    if (!fs.existsSync(productionPath)) continue;
    const production = fs.statSync(productionPath);
    if (production.dev === stat.dev && production.ino === stat.ino) {
      throw new Error('baseline_store_not_isolated: the evaluation path aliases an operational database.');
    }
  }
  return resolved;
}

/** Isolated single-Choice replay vs end-to-end cohort contexts (never conflated). */
export const REPLAY_CONTEXT_ISOLATED_SINGLE_CHOICE = 'isolated_single_choice_approximation (dev candidate-only; NOT cohort qualification)' as const;
export const REPLAY_CONTEXT_END_TO_END_COHORT = 'end_to_end_cohort (requires page Noul/cohort seams; not implemented in dev replay)' as const;

/** Explicit unsupported capabilities for frozen controlled profiles. */
export const DEV_REPLAY_UNSUPPORTED_CAPABILITIES = [
  'multi-value attribute coverage is limited to the frozen profiles represented in adjudicated development data',
  'no known-complete page gold in dev (page states are partial/unknown; qualification page scoring stays blocked)',
  'cohort/end-to-end qualification from single-Choice replay (isolated approximation only; must not be labeled cohort qualification)',
  'live baseline without an isolated store + credential ref (deterministic_floor instead)',
  'live candidate capture without explicit --live-capture --model + credential ref + bound attempt guard (blocked instead)',
] as const;

/** Candidate-only dev probability calibration note (qualification stays blocked). */
export const DEV_CALIBRATION_NOTE = 'candidate-only dev probability calibration allowed; qualification blocked (agent adjudication, NOT approval)' as const;
