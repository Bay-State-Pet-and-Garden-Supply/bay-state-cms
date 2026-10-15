// fallow-ignore-file unused-export

/**
 * Surgical edits to the ACTIVE v2 classification bundle's ShopSite field
 * mappings (the CMS mirror of ShopSite's Extra Fields configuration).
 *
 * Unlike full regeneration (`config-store` preview/activate), this editor
 * changes only `mappings.json` (and, when needed, `curation-targets.json`) of
 * the active bundle, re-validates under the fail-closed active contract,
 * re-binds manifest fileVersions/bundleHash, and refreshes the derived SQLite
 * cache (mirror tables + snapshots). It never touches any other file, never
 * writes approved catalog/ShopSite state, and never edits field metadata
 * (labels are owned exclusively by the field-metadata service).
 *
 * Invariants maintained here (mirrors of the generator/validator contract):
 * - one attribute maps to at most one Catalog Field, and vice versa;
 * - product_field curation targets stay in sync with their attribute's
 *   mapping field (target.catalogField === mapping.catalogField), and targets
 *   for unmapped attributes are removed;
 * - a mapping never references an attribute that does not exist in the bundle;
 * - the edited bundle passes active-mode validation before anything is written.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  ClassificationFocusedFileNames,
  ClassificationManifestV2Schema,
  SerializationConfigV2Schema,
  type AttributeMappingConfigV2,
  type ClassificationConfigBundleV2,
  type SerializationConfigV2,
} from '../shared/schemas/classification';
import { canonicalJsonFileString, sha256Hex } from '../shared/stable-id';
import { buildFocusedFiles } from './config-generator';
import {
  computeClassificationBundleHash,
  validateClassificationConfigBundle,
} from './config-validation';
import {
  checkedClassificationDirectory,
  checkedClassificationDirectoryForWrite,
  createRuntimeActivationContext,
  loadRuntimeConfigAuthority,
  type VerifiedActivationContext,
} from './config-loader';
import { commitClassificationScope } from './config-store';
import { isProtectedCatalogField } from './classification-ownership';
import {
  syncConfigToCache,
  upsertConfigSnapshot,
} from '../db/repositories/classification-config-repo';
import { assertTaxonomyMutable } from './taxonomy-freeze';

export class FieldMappingEditError extends Error {
  constructor(
    public readonly code:
      | 'v2_required'
      | 'invalid_edit'
      | 'unknown_attribute'
      | 'attribute_already_mapped'
      | 'collision'
      | 'validation_failed'
      | 'write_error',
    message: string,
  ) {
    super(message);
    this.name = 'FieldMappingEditError';
  }
}

/** One row edit from the CMS Extra Fields mirror UI. */
export const FieldMappingEditSchema = z.object({
  /** e.g. `ProductField24`. */
  catalogField: z.string().min(1),
  /** Configured attribute id, or null to unmap the field. */
  attributeId: z.string().min(1).nullable(),
  /** Optional serialization override; defaults to scalar when omitted. */
  serialization: SerializationConfigV2Schema.nullable().optional(),
}).strict();
export type FieldMappingEdit = z.infer<typeof FieldMappingEditSchema>;

export interface FieldMappingEditResult {
  bundleHash: string;
  commitHash: string | null;
  appliedFields: string[];
  removedFields: string[];
}

const DEFAULT_SERIALIZATION: SerializationConfigV2 = { kind: 'scalar', prefix: '', suffix: '' };

/**
 * Apply mapping edits to the active v2 bundle. Throws FieldMappingEditError on
 * any invalid edit or when the edited bundle fails active-mode validation
 * (nothing is written in either case).
 */
export function applyFieldMappingEdits(
  workspacePath: string,
  workspaceId: string,
  edits: FieldMappingEdit[],
  options: { gitEnabled?: boolean; gitMessage?: string } = {},
): FieldMappingEditResult {
  // P0 taxonomy freeze: field mapping edits mutate the active taxonomy and
  // must fail closed until a new immutable taxonomy release is deployed.
  assertTaxonomyMutable('field mapping edits');

  const activationContext = createRuntimeActivationContext(workspacePath, workspaceId);
  const authority = loadRuntimeConfigAuthority(workspacePath, activationContext);
  if (authority.kind !== 'v2') {
    throw new FieldMappingEditError(
      'v2_required',
      'Field mapping edits require an active v2 classification bundle; this workspace has no active v2 configuration.',
    );
  }
  return applyEditsToBundle(workspacePath, workspaceId, authority.bundle, activationContext, edits, options);
}

function applyEditsToBundle(
  workspacePath: string,
  workspaceId: string,
  bundle: ClassificationConfigBundleV2,
  activationContext: VerifiedActivationContext,
  edits: FieldMappingEdit[],
  options: { gitEnabled?: boolean; gitMessage?: string },
): FieldMappingEditResult {
  if (edits.length === 0) {
    return {
      bundleHash: bundle.manifest.bundleHash,
      commitHash: null,
      appliedFields: [],
      removedFields: [],
    };
  }

  // Structural validation: edits are strict — there is no label field (the
  // canonical field-metadata service is the only writer of field labels;
  // issue #31 I3). A payload carrying extra keys such as `label` is rejected.
  const parsedEdits = z.array(FieldMappingEditSchema).safeParse(edits);
  if (!parsedEdits.success) {
    throw new FieldMappingEditError(
      'invalid_edit',
      `Invalid mapping edit payload: ${parsedEdits.error.issues
        .map(issue => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }

  const attributeIds = new Set(bundle.attributes.map(attribute => attribute.id));

  // ── Validate the raw edits before any derivation ─────────────────────────
  for (const edit of edits) {
    if (!edit || typeof edit.catalogField !== 'string' || edit.catalogField.trim() === '') {
      throw new FieldMappingEditError('invalid_edit', 'Each edit requires a non-empty catalogField.');
    }
    // Issue #355: a semantic target cannot be rerouted into Brand, identity,
    // operational, or native fulfillment data through a mapping. The Brand
    // slot resolves from the current bundle mappings (pre-edit authority).
    if (edit.attributeId !== null && edit.attributeId !== undefined
      && isProtectedCatalogField(edit.catalogField, edit.attributeId, bundle.attributeMappings)) {
      throw new FieldMappingEditError(
        'invalid_edit',
        `Cannot map ${edit.catalogField} to "${edit.attributeId}": the field is Brand, identity, operational, or native fulfillment data outside classification ownership.`,
      );
    }
    if (edit.attributeId !== null && typeof edit.attributeId === 'string' && edit.attributeId.trim() === '') {
      throw new FieldMappingEditError('invalid_edit', 'attributeId must be null or a non-empty configured attribute id.');
    }
    if (edit.attributeId !== null && edit.attributeId !== undefined && !attributeIds.has(edit.attributeId)) {
      throw new FieldMappingEditError(
        'unknown_attribute',
        `Cannot map ${edit.catalogField}: attribute "${edit.attributeId}" is not configured in this bundle.`,
      );
    }
    if (edit.serialization !== undefined && edit.serialization !== null) {
      const parsed = SerializationConfigV2Schema.safeParse(edit.serialization);
      if (!parsed.success) {
        throw new FieldMappingEditError('invalid_edit', `Invalid serialization for ${edit.catalogField}.`);
      }
    }
  }

  const nextMappings = [...bundle.attributeMappings];
  const nextTargets = [...bundle.curationTargets];
  const appliedFields: string[] = [];
  const removedFields: string[] = [];
  // Targets removed because their attribute was unmapped; restored with the
  // new field when the same attribute is re-mapped later in this call.
  const removedTargetsByAttribute = new Map<string, ClassificationConfigBundleV2['curationTargets'][number]>();

  const mappingByField = new Map(nextMappings.map(mapping => [mapping.catalogField, mapping]));
  const mappingByAttribute = new Map(nextMappings.map(mapping => [mapping.attributeId, mapping]));

  // ── D3 collision pre-check (issue #31 D3) ────────────────────────────────
  // Before any mutation, reject a map-edit whose destination Catalog Field is
  // occupied by a DIFFERENT attribute that is NOT explicitly unmapped within
  // THIS batch of edits. Silently re-pointing a field over a live occupant
  // would destroy the displaced attribute's mapping AND its curation targets;
  // the caller must explicitly unmap the occupant in the same batch (the
  // existing in-batch move semantics) before a field can change owners.
  const unmappedAttributesInBatch = new Set<string>();
  for (const edit of edits) {
    if (edit.attributeId === null || edit.attributeId === undefined) {
      const occupant = mappingByField.get(edit.catalogField);
      if (occupant) unmappedAttributesInBatch.add(occupant.attributeId);
    }
  }
  for (const edit of edits) {
    if (edit.attributeId === null || edit.attributeId === undefined) continue;
    const occupant = mappingByField.get(edit.catalogField);
    if (occupant && occupant.attributeId !== edit.attributeId && !unmappedAttributesInBatch.has(occupant.attributeId)) {
      throw new FieldMappingEditError(
        'collision',
        `Cannot map ${edit.catalogField} to "${edit.attributeId}": the field is already mapped to attribute "${occupant.attributeId}". ` +
          `Unmap "${occupant.attributeId}" in the same edit batch to move it off ${edit.catalogField}, or choose a different Catalog Field.`,
      );
    }
  }

  for (const edit of edits) {
    const existing = mappingByField.get(edit.catalogField);

    if (edit.attributeId === null || edit.attributeId === undefined) {
      // Unmap: drop the mapping (and its attribute) for this field.
      if (existing) {
        removeMapping(nextMappings, mappingByField, mappingByAttribute, existing, nextTargets, removedTargetsByAttribute);
        removedFields.push(edit.catalogField);
      }
      continue;
    }

    // One attribute → one field.
    const attributeMapping = mappingByAttribute.get(edit.attributeId);
    if (attributeMapping && attributeMapping.catalogField !== edit.catalogField) {
      throw new FieldMappingEditError(
        'attribute_already_mapped',
        `Attribute "${edit.attributeId}" is already mapped to ${attributeMapping.catalogField}; move or unmap it first.`,
      );
    }

    if (existing && existing.attributeId !== edit.attributeId) {
      // Re-pointing the field from another attribute: drop the old mapping
      // first so a field never maps to two attributes.
      removeMapping(nextMappings, mappingByField, mappingByAttribute, existing, nextTargets, removedTargetsByAttribute);
    }

    const next: AttributeMappingConfigV2 = {
      id: `${edit.attributeId}-mapping`,
      attributeId: edit.attributeId,
      catalogField: edit.catalogField,
      serialization: edit.serialization ?? existing?.serialization ?? DEFAULT_SERIALIZATION,
      isStale: false,
    };
    const prior = mappingByField.get(edit.catalogField);
    if (prior) {
      const index = nextMappings.findIndex(mapping => mapping.id === prior.id);
      nextMappings[index] = next;
    } else {
      nextMappings.push(next);
    }
    mappingByField.set(edit.catalogField, next);
    mappingByAttribute.set(edit.attributeId, next);
    appliedFields.push(edit.catalogField);

    // Keep product_field curation targets aligned with the mapping field.
    const removedTarget = removedTargetsByAttribute.get(edit.attributeId);
    if (removedTarget) {
      // The attribute was unmapped and is being mapped again in this call:
      // restore its curation target against the new field.
      removedTargetsByAttribute.delete(edit.attributeId);
      nextTargets.push({ ...removedTarget, catalogField: edit.catalogField });
    }
    for (const target of nextTargets) {
      if (target.kind === 'product_field' && target.attributeId === edit.attributeId) {
        target.catalogField = edit.catalogField;
      }
    }
  }

  // ── Rebuild the manifest and focused files ───────────────────────────────
  const bundleWithoutManifest = { ...bundle, attributeMappings: nextMappings, curationTargets: nextTargets } as Omit<ClassificationConfigBundleV2, 'manifest'> & { manifest?: unknown };
  delete bundleWithoutManifest.manifest;
  const focusedFiles = buildFocusedFiles(bundleWithoutManifest);
  const fileVersions = Object.fromEntries(
    ClassificationFocusedFileNames.map(fileName => [fileName, sha256Hex(focusedFiles[fileName])]),
  );
  const updatedAt = new Date().toISOString();
  const manifestWithoutHash = { ...bundle.manifest, updatedAt, fileVersions };
  const manifest = ClassificationManifestV2Schema.parse({
    ...manifestWithoutHash,
    bundleHash: computeClassificationBundleHash(manifestWithoutHash),
  });
  const newBundle: ClassificationConfigBundleV2 = {
    ...bundleWithoutManifest,
    manifest,
  } as ClassificationConfigBundleV2;

  // ── Fail-closed active validation before anything is written ─────────────
  const report = validateClassificationConfigBundle(newBundle, {
    mode: 'active',
    focusedFileContents: focusedFiles,
    catalogFields: activationContext.catalogFields,
    verifiedPageIds: activationContext.verifiedPageIds,
    verifiedQualificationReceiptDigests: activationContext.verifiedQualificationReceiptDigests,
    verifyCatalogEvidence: activationContext.verifyCatalogEvidence,
  });
  // An enabled Page target without a verified Page catalog is a NOT-READY
  // condition (tolerated exactly like the active loader tolerates it), not a
  // mapping-editor failure; every other error finding stays fatal.
  const fatalFindings = report.findings.filter(
    finding => finding.severity === 'error' && finding.code !== 'verified_page_catalog_required',
  );
  if (fatalFindings.length > 0) {
    throw new FieldMappingEditError(
      'validation_failed',
      `Edited bundle failed active validation:\n${fatalFindings.map(f => `[${f.code}] ${f.path}: ${f.message}`).join('\n')}`,
    );
  }

  // ── Write the changed files (same symlink-safe mechanics as the loader) ──
  const checkedDir = checkedClassificationDirectoryForWrite(workspacePath);
  const dir = checkedDir.path;
  const files: Record<string, unknown> = {
    'mappings.json': focusedFiles['mappings.json'],
    'curation-targets.json': focusedFiles['curation-targets.json'],
    'manifest.json': canonicalJsonFileString(manifest),
  };
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  for (const [fileName, value] of Object.entries(files)) {
    const currentDir = checkedClassificationDirectory(workspacePath);
    if (currentDir.realPath !== checkedDir.realPath) {
      throw new FieldMappingEditError(
        'write_error',
        `Classification directory identity changed during write: ${dir}`,
      );
    }
    const filePath = path.join(currentDir.path, fileName);
    let descriptor: number | null = null;
    try {
      descriptor = fs.openSync(
        filePath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollow,
      );
      const openedStat = fs.fstatSync(descriptor);
      if (!openedStat.isFile()) {
        throw new FieldMappingEditError(
          'write_error',
          `Opened classification path is not a regular file: ${filePath}`,
        );
      }
      fs.writeFileSync(descriptor, typeof value === 'string' ? value : canonicalJsonFileString(value), 'utf8');
    } catch (error) {
      if (error instanceof FieldMappingEditError) throw error;
      throw new FieldMappingEditError(
        'write_error',
        `Unable to write classification file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch { /* original write result/error wins */ }
      }
    }
  }

  // ── Derived cache: mirror tables (promotion reads) + snapshot/hash ───────
  try {
    syncConfigToCache(workspaceId, newBundle as unknown as Parameters<typeof syncConfigToCache>[1]);
  } catch (error) {
    throw new FieldMappingEditError(
      'write_error',
      `Cache mirror sync failed after file write: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Snapshot last so classification_config_files content hashes match the
  // canonical file bytes (syncConfigToCache stores compact-JSON hashes).
  upsertConfigSnapshot(workspaceId, newBundle, manifest.sourceCatalogCommit);

  // ── Scoped Git commit (same narrow scope as activation) ──────────────────
  let commitHash: string | null = null;
  if (options.gitEnabled !== false) {
    try {
      commitHash = commitClassificationScope(
        workspacePath,
        options.gitMessage ?? `Update ShopSite field mappings (${appliedFields.length} fields)`,
      );
    } catch (error) {
      // Files and cache are already updated; a commit failure is surfaced but
      // not fatal — the workspace stays consistent, just uncommitted.
      console.warn(`[FieldMappingEditor] Git commit failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { bundleHash: manifest.bundleHash, commitHash, appliedFields, removedFields };
}

function removeMapping(
  mappings: AttributeMappingConfigV2[],
  byField: Map<string, AttributeMappingConfigV2>,
  byAttribute: Map<string, AttributeMappingConfigV2>,
  mapping: AttributeMappingConfigV2,
  targets: ClassificationConfigBundleV2['curationTargets'],
  removedTargetsByAttribute?: Map<string, ClassificationConfigBundleV2['curationTargets'][number]>,
): void {
  const index = mappings.findIndex(candidate => candidate.id === mapping.id);
  if (index >= 0) mappings.splice(index, 1);
  byField.delete(mapping.catalogField);
  if (byAttribute.get(mapping.attributeId)?.id === mapping.id) {
    byAttribute.delete(mapping.attributeId);
  }
  // Drop product_field curation targets that referenced the removed mapping's
  // attribute (their catalogField would no longer match any mapping).
  for (let targetIndex = targets.length - 1; targetIndex >= 0; targetIndex -= 1) {
    const target = targets[targetIndex]!;
    if (target.kind === 'product_field' && target.attributeId === mapping.attributeId) {
      targets.splice(targetIndex, 1);
      removedTargetsByAttribute?.set(mapping.attributeId, target);
    }
  }
}
