/**
 * Release Authoring (P2) — deterministic candidate-release construction.
 *
 * Takes a source taxonomy release directory plus a declarative change-set and
 * produces a CANDIDATE release under the releases root with recomputed file
 * hashes, a bumped `sourceBaseline`, refreshed `bundleOrigin` provenance on
 * every focused file, and updated manifest counts. The candidate is validated
 * with `assertReleaseValidV4` before it is allowed to exist at its final path:
 * any ERROR finding refuses output entirely (temp dir removed, nothing
 * written). WARNING findings (e.g. P2 `retire_candidate` advisories) are
 * surfaced in the returned report but never block — otherwise every child of
 * bay-state-v4 would be unauthorable by construction.
 *
 * Hard boundaries (plan section F):
 *  - Ids are NEVER deleted or renamed. There is no delete-attribute operation;
 *    attribute edits cannot touch `id`. Retirement is declaration-level
 *    (`not_exported` + profile-membership revocation). This keeps
 *    ClassificationProposalSchema / PI bindings and oldIdAliases chains intact.
 *  - The tool NEVER writes to storage/catalog and NEVER touches workspace pins;
 *    activation remains exclusively the sanctioned release-routes channel.
 *
 * Pure core (`applyChangeSetToFiles`) is deterministic: identical source bytes
 * + identical change-set (+ fixed createdAt) ⇒ byte-identical candidate files,
 * hence identical manifest hashes. IO lives only in `authorCandidateRelease`.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  assertReleaseValidV4,
  isValidReleaseId,
  resolveReleaseDir,
  type ReleaseValidationReport,
} from './release-validation';
import { validateCanonicalValue } from './controlled-value-identity';

// ─── Change-set shape ──────────────────────────────────────────────────────────

/** Partial edit applied onto an EXISTING attribute. `id` is immutable. */
export interface AttributeEditChange {
  attributeId: string;
  name?: string;
  description?: string | null;
  exportDisposition?: { kind: 'shopsite'; catalogField: string } | { kind: 'not_exported' };
}

export interface MappingAddChange {
  attributeId: string;
  catalogField: string;
  serialization?: { kind: string } & Record<string, unknown>;
}

/** Grant one attribute membership in an existing facet profile. */
export interface ProfileMembershipGrantChange {
  profileId: string;
  attributeId: string;
  required?: boolean;
  cardinality?: 'single' | 'multi';
  applicabilityConditions?: unknown[];
}

export interface ProfileMembershipRevocationChange {
  profileId: string;
  attributeId: string;
}

/** Patch onto an EXISTING hierarchy node. `id`, `parentId` cycles and identity
 *  fields are immutable; only descriptive/scope fields may change. */
export interface HierarchyNodeEditChange {
  nodeId: string;
  label?: string;
  scope?: { animalDomain: string } | null;
}

/**
 * Append a value alias onto an EXISTING controlled attribute (issue #328).
 * `alias` must not already exist on the attribute and `mapsTo` must be an
 * exact `allowedValues` entry. Never renames or deletes — append-only.
 */
export interface ValueAliasAddChange {
  attributeId: string;
  alias: string;
  mapsTo: string;
}

/**
 * Declarative change-set for authoring a new immutable release from a source
 * release. Every operation either edits existing entries in place or appends
 * new ones — no id ever disappears.
 */
export interface ReleaseChangeSet {
  /** New release id (kebab-case); also becomes the candidate directory name. */
  newReleaseId: string;
  notes?: string[];
  /** Deterministic timestamp override (tests); default = wall clock. */
  createdAtOverride?: string;
  attributeEdits?: AttributeEditChange[];
  mappingAdds?: MappingAddChange[];
  /** Removes a mapping ROW; the attribute id itself always survives. */
  mappingRemoves?: Array<{ attributeId: string }>;
  profileMembershipGrants?: ProfileMembershipGrantChange[];
  profileMembershipRevocations?: ProfileMembershipRevocationChange[];
  hierarchyNodeEdits?: HierarchyNodeEditChange[];
  /** Append-only value-alias additions (issue #328 governed alias flow). */
  valueAliasAdds?: ValueAliasAddChange[];
}

export interface AuthorCandidateOptions {
  /** Releases root override (tests use temp roots); default = src/classification/releases. */
  releasesRootOverride?: string;
}

export type AuthorCandidateResult =
  | { ok: true; candidateDir: string; report: ReleaseValidationReport }
  | { ok: false; reason: string; report: ReleaseValidationReport | null };

// ─── Serialization helpers ─────────────────────────────────────────────────────

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

type JsonRecord = Record<string, unknown>;

/** Refresh bundleOrigin provenance (kind:'release') to the candidate release. */
function rebindOrigin(file: JsonRecord, newReleaseId: string, createdAt: string): void {
  const origin = file.bundleOrigin;
  if (origin && typeof origin === 'object' && (origin as JsonRecord).kind === 'release') {
    (origin as JsonRecord).releaseId = newReleaseId;
    (origin as JsonRecord).createdAt = createdAt;
  }
}

const FOCUSED_V4_FILES = [
  'hierarchy.json',
  'facet-profiles.json',
  'legacy-mappings.json',
  'attributes.json',
  'export-mappings.json',
  'shopsite-projection.json',
  'guidance.json',
  'page-assignment-policy.json',
] as const;

// ─── Pure transformation ───────────────────────────────────────────────────────

/**
 * Apply a change-set to parsed source files. PURE: mutates only its inputs'
 * deep copies and returns the new file map; no fs access, fully deterministic.
 */
export function applyChangeSetToFiles(
  sourceFiles: Readonly<Record<string, unknown>>,
  changeSet: ReleaseChangeSet,
): Record<string, string> {
  const createdAt = changeSet.createdAtOverride ?? new Date().toISOString();
  const files: Record<string, JsonRecord> = {};
  for (const fileName of FOCUSED_V4_FILES) {
    const raw = sourceFiles[fileName];
    if (raw === undefined) continue; // optional file absent in this generation
    files[fileName] = JSON.parse(JSON.stringify(raw)) as JsonRecord;
  }

  const attributesEnvelope = files['attributes.json'];
  const mappingsEnvelope = files['export-mappings.json'];
  const profilesEnvelope = files['facet-profiles.json'];
  const hierarchyEnvelope = files['hierarchy.json'];
  const attributes = (attributesEnvelope?.entries ?? []) as Array<JsonRecord & { id: string }>;
  const mappings = (mappingsEnvelope?.entries ?? []) as Array<JsonRecord>;
  const profiles = (profilesEnvelope?.entries ?? []) as Array<JsonRecord & { id: string; attributes: Array<JsonRecord> }>;
  const nodes = (hierarchyEnvelope?.entries ?? []) as Array<JsonRecord & { id: string }>;

  // ── Attribute edits (existing ids only; id itself immutable) ──
  for (const edit of changeSet.attributeEdits ?? []) {
    const attr = attributes.find(a => a.id === edit.attributeId);
    if (!attr) {
      throw new Error(`attributeEdits: unknown attribute id "${edit.attributeId}" (ids are immutable — no invention, no deletion).`);
    }
    if (edit.name !== undefined) attr.name = edit.name;
    if (edit.description !== undefined) attr.description = edit.description;
    if (edit.exportDisposition !== undefined) attr.exportDisposition = edit.exportDisposition;
  }

  // ── Export mapping adds/removes (rows are mutable; attribute ids are not) ──
  const remainingMappings = mappings.filter(m => {
    const attributeId = String(m.attributeId);
    return !(changeSet.mappingRemoves ?? []).some(r => r.attributeId === attributeId);
  });
  if ((changeSet.mappingRemoves ?? []).length > 0 && mappingsEnvelope) {
    mappingsEnvelope.entries = remainingMappings;
  }
  for (const add of changeSet.mappingAdds ?? []) {
    if (!attributes.some(a => a.id === add.attributeId)) {
      throw new Error(`mappingAdds: unknown attribute id "${add.attributeId}".`);
    }
    if (!mappingsEnvelope) throw new Error('Source release has no export-mappings.json envelope.');
    const existingForAttr = (mappingsEnvelope.entries as Array<JsonRecord>).filter(
      m => m.attributeId === add.attributeId,
    );
    if (existingForAttr.length > 0) {
      throw new Error(`mappingAdds: attribute "${add.attributeId}" already has an export mapping.`);
    }
    const entry: JsonRecord = {
      id: `${add.attributeId}-mapping`,
      attributeId: add.attributeId,
      catalogField: add.catalogField,
      isStale: false,
      serialization: add.serialization ?? { kind: 'scalar', prefix: '', suffix: '' },
    };
    (mappingsEnvelope.entries as Array<JsonRecord>).push(entry);
  }

  // ── Value-alias adds (append-only; issue #328 governed alias flow) ──
  for (const aliasAdd of changeSet.valueAliasAdds ?? []) {
    const attr = attributes.find(a => a.id === aliasAdd.attributeId) as
      | (JsonRecord & { id: string; allowedValues?: unknown; valueAliases?: Array<{ alias: string; mapsTo: string }> })
      | undefined;
    if (!attr) {
      throw new Error(`valueAliasAdds: unknown attribute id "${aliasAdd.attributeId}".`);
    }
    const allowed = Array.isArray(attr.allowedValues) ? (attr.allowedValues as unknown[]) : [];
    if (!allowed.includes(aliasAdd.mapsTo)) {
      throw new Error(`valueAliasAdds: mapsTo "${aliasAdd.mapsTo}" is not an allowed value of "${aliasAdd.attributeId}".`);
    }
    // ADR 0012 canonical identity: aliases are stored verbatim (never
    // silently rewritten), so a non-canonical alias is refused here rather
    // than normalized — repair the change-set before authoring.
    const canonical = validateCanonicalValue(aliasAdd.alias);
    if (!canonical.ok) {
      throw new Error(`valueAliasAdds: alias "${aliasAdd.alias}" is not canonical (${canonical.reason}); store the NFC-normalized, trimmed form.`);
    }
    if ((allowed as unknown[]).includes(aliasAdd.alias)) {
      throw new Error(`valueAliasAdds: alias "${aliasAdd.alias}" collides with an allowed value of "${aliasAdd.attributeId}".`);
    }
    const existing = (attr.valueAliases ?? []).map(a => a.alias);
    if (existing.includes(aliasAdd.alias)) {
      throw new Error(`valueAliasAdds: alias "${aliasAdd.alias}" already exists on "${aliasAdd.attributeId}".`);
    }
    attr.valueAliases = [...(attr.valueAliases ?? []), { alias: aliasAdd.alias, mapsTo: aliasAdd.mapsTo }];
  }

  // ── Facet-profile membership grants/revocations ──
  for (const grant of changeSet.profileMembershipGrants ?? []) {
    const profile = profiles.find(p => p.id === grant.profileId);
    if (!profile) throw new Error(`profileMembershipGrants: unknown facet profile id "${grant.profileId}".`);
    if (!attributes.some(a => a.id === grant.attributeId)) {
      throw new Error(`profileMembershipGrants: unknown attribute id "${grant.attributeId}".`);
    }
    if (profile.attributes.some(a => a.attributeId === grant.attributeId)) {
      throw new Error(`profileMembershipGrants: attribute "${grant.attributeId}" is already a member of "${grant.profileId}".`);
    }
    profile.attributes.push({
      attributeId: grant.attributeId,
      required: grant.required ?? false,
      cardinality: grant.cardinality ?? 'single',
      applicabilityConditions: grant.applicabilityConditions ?? [],
      constraints: {},
      confidenceThresholds: {},
      valueAliases: [],
    });
  }
  for (const revoke of changeSet.profileMembershipRevocations ?? []) {
    const profile = profiles.find(p => p.id === revoke.profileId);
    if (!profile) throw new Error(`profileMembershipRevocations: unknown facet profile id "${revoke.profileId}".`);
    const before = profile.attributes.length;
    profile.attributes = profile.attributes.filter(a => a.attributeId !== revoke.attributeId);
    if (profile.attributes.length === before) {
      throw new Error(`profileMembershipRevocations: attribute "${revoke.attributeId}" is not a member of "${revoke.profileId}".`);
    }
  }

  // ── Hierarchy node edits (descriptive/scope only; structure immutable) ──
  for (const nodeEdit of changeSet.hierarchyNodeEdits ?? []) {
    const node = nodes.find(n => n.id === nodeEdit.nodeId);
    if (!node) throw new Error(`hierarchyNodeEdits: unknown node id "${nodeEdit.nodeId}".`);
    if (nodeEdit.label !== undefined) node.label = nodeEdit.label;
    if (nodeEdit.scope !== undefined) node.scope = nodeEdit.scope;
  }

  // ── Provenance rebinding + serialization ──
  const out: Record<string, string> = {};
  for (const [fileName, file] of Object.entries(files)) {
    rebindOrigin(file, changeSet.newReleaseId, createdAt);
    out[fileName] = serializeJson(file);
  }
  return out;
}

// ─── Candidate manifest ────────────────────────────────────────────────────────

/** Build the candidate manifest from serialized files. PURE. */
export function buildCandidateManifest(
  sourceManifest: Readonly<Record<string, unknown>>,
  changeSet: ReleaseChangeSet,
  candidateFiles: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const createdAt = changeSet.createdAtOverride ?? new Date().toISOString();
  const counts: JsonRecord = {};
  const countKeysByFile: Record<string, string> = {
    'hierarchy.json': 'nodes',
    'facet-profiles.json': 'facetProfiles',
    'attributes.json': 'attributes',
    'export-mappings.json': 'mappings',
    'shopsite-projection.json': 'pages',
  };
  const sourceCounts = (sourceManifest.counts ?? {}) as JsonRecord;
  for (const [fileName, countKey] of Object.entries(countKeysByFile)) {
    const text = candidateFiles[fileName];
    if (text === undefined) continue; // file not present in this generation
    try {
      const parsed = JSON.parse(text) as { entries?: unknown[] };
      counts[countKey] = Array.isArray(parsed.entries) ? parsed.entries.length : sourceCounts[countKey];
    } catch {
      counts[countKey] = sourceCounts[countKey];
    }
  }
  // Derived hierarchy counts.
  const hierarchyText = candidateFiles['hierarchy.json'];
  if (hierarchyText !== undefined) {
    try {
      const entries = (JSON.parse(hierarchyText) as { entries: Array<JsonRecord> }).entries;
      counts['departments'] = entries.filter(n => n.parentId === null).length;
      counts['types'] = entries.filter(n => n.classifiable === true).length;
      counts['nativeLeaves'] = entries.filter(
        n => n.classifiable === true && n.derivation === 'type_native',
      ).length;
    } catch {
      /* Rule-level validation reports malformed files */
    }
  }
  // Ensure every manifest count key exists even if a file was absent.
  for (const key of ['nodes', 'departments', 'types', 'nativeLeaves', 'attributes', 'facetProfiles', 'pages', 'mappings'] as const) {
    if (counts[key] === undefined) counts[key] = sourceCounts[key] ?? 0;
  }

  return {
    releaseId: changeSet.newReleaseId,
    revision: changeSet.newReleaseId,
    createdAt,
    schemaVersion: sourceManifest.schemaVersion,
    compatibilityVersion: sourceManifest.compatibilityVersion,
    lifecycle: 'release',
    sourceBaseline: sourceManifest.releaseId,
    fileVersions: Object.fromEntries(
      Object.entries(candidateFiles).map(([fileName, text]) => [fileName, sha256(text)]),
    ),
    counts,
    notes: [...((sourceManifest.notes ?? []) as string[]), ...(changeSet.notes ?? [])],
  };
}

// ─── IO orchestration ──────────────────────────────────────────────────────────

/**
 * Author a candidate release end-to-end. Reads the SOURCE release (which must
 * itself validate clean), applies the change-set purely, validates the
 * candidate inside a temp directory under the releases root (so sibling
 * baseline references still resolve), and only then moves it to its final
 * path. Refuses when: ids invalid, target exists, source invalid, or the
 * candidate has ANY error-severity validation finding (fail-closed; warnings
 * surface in the report without blocking).
 */
export function authorCandidateRelease(
  sourceDirArg: string,
  changeSet: ReleaseChangeSet,
  options: AuthorCandidateOptions = {},
): AuthorCandidateResult {
  if (!isValidReleaseId(changeSet.newReleaseId)) {
    return { ok: false, reason: `newReleaseId "${changeSet.newReleaseId}" must match /^[a-z0-9]+(-[a-z0-9]+)*$/.`, report: null };
  }
  const releasesRoot = options.releasesRootOverride ?? path.resolve(__dirname, 'releases');
  const finalDir = path.join(releasesRoot, changeSet.newReleaseId);
  if (fs.existsSync(finalDir)) {
    return { ok: false, reason: `Candidate release directory already exists: ${finalDir}. Releases are immutable — pick a new id.`, report: null };
  }

  let sourceDir: string;
  try {
    sourceDir = resolveReleaseDir(sourceDirArg);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err), report: null };
  }
  if (!fs.existsSync(path.join(sourceDir, 'manifest.json'))) {
    return { ok: false, reason: `Source release has no manifest.json: ${sourceDir}`, report: null };
  }

  const sourceFiles: Record<string, unknown> = {};
  for (const fileName of FOCUSED_V4_FILES) {
    const filePath = path.join(sourceDir, fileName);
    if (fs.existsSync(filePath)) {
      sourceFiles[fileName] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  }
  const sourceManifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'manifest.json'), 'utf8')) as JsonRecord;

  let candidateFiles: Record<string, string>;
  try {
    candidateFiles = applyChangeSetToFiles(sourceFiles, changeSet);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err), report: null };
  }

  const manifest = buildCandidateManifest(sourceManifest, changeSet, candidateFiles);
  const allFiles: Record<string, string> = { ...candidateFiles, 'manifest.json': serializeJson(manifest) };

  // Stage in a temp subroot INSIDE the releases root so (a) the candidate's
  // directory basename equals its release id (Rule 12 binding) and (b)
  // sibling-baseline references (v3 fingerprint recomputation, retire_candidate
  // comparison) resolve identically to a real deployment.
  const stageSubroot = path.join(releasesRoot, `.authoring-tmp-${changeSet.newReleaseId}-${process.pid}`);
  const tempDir = path.join(stageSubroot, changeSet.newReleaseId);
  try {
    fs.rmSync(stageSubroot, { recursive: true, force: true });
    fs.mkdirSync(tempDir, { recursive: true });
    for (const [fileName, text] of Object.entries(allFiles)) {
      fs.writeFileSync(path.join(tempDir, fileName), text, 'utf8');
    }
    // Expose the real releases as siblings of the staged candidate so
    // baseline-relative validation rules see them (symlink; copy as fallback).
    for (const entry of fs.readdirSync(releasesRoot)) {
      if (!fs.statSync(path.join(releasesRoot, entry)).isDirectory()) continue;
      if (entry.startsWith('.authoring-tmp-')) continue;
      const linkPath = path.join(stageSubroot, entry);
      try {
        fs.symlinkSync(path.join(releasesRoot, entry), linkPath, 'dir');
      } catch {
        fs.cpSync(path.join(releasesRoot, entry), linkPath, { recursive: true });
      }
    }

    // Fail-closed gate: ANY error-severity finding refuses output. The temp
    // dir is removed below so the candidate never exists at its final path.
    let report: ReleaseValidationReport;
    try {
      report = assertReleaseValidV4(tempDir);
    } catch (err) {
      const maybeReport = err instanceof Error ? (err as unknown as { report?: ReleaseValidationReport }).report : undefined;
      if (maybeReport) {
        report = maybeReport;
        return { ok: false, reason: 'Candidate release failed validation — nothing was published.', report };
      }
      throw err;
    }
    fs.renameSync(tempDir, finalDir);
    return { ok: true, candidateDir: finalDir, report };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err), report: null };
  } finally {
    const stageSubrootCleanup = path.dirname(tempDir);
    if (path.basename(stageSubrootCleanup).startsWith('.authoring-tmp-')) {
      fs.rmSync(stageSubrootCleanup, { recursive: true, force: true });
    }
  }
}
