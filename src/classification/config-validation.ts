import {
  ClassificationBundleOriginV2Schema,
  ClassificationConfigBundleV2Schema,
  ClassificationFocusedFileNames,
  ClassificationStageNameValues,
  type ClassificationConfigBundleV2,
  type ClassificationFocusedFileName,
  type ClassificationManifestV2,
} from '../shared/schemas/classification';
import { hashCanonicalJson, sha256Hex } from '../shared/stable-id';
import {
  comparisonKey,
  findCanonicalCollisions,
  validateCanonicalValue,
} from './controlled-value-identity';

export type ClassificationConfigFindingSeverity = 'error' | 'warning';

export interface ClassificationConfigFinding {
  severity: ClassificationConfigFindingSeverity;
  code: string;
  path: string;
  message: string;
}

export interface CatalogEvidenceVerificationInput {
  catalogEvidenceHash: string;
  sourceCatalogCommit: string;
  catalogFields: ReadonlySet<string>;
}

export interface CatalogEvidenceVerifier {
  (input: CatalogEvidenceVerificationInput): { verified: boolean; reason?: string };
}

export interface UnresolvedMigrationFinding {
  severity: string;
  code: string;
  path: string;
  message: string;
}

export interface ClassificationConfigValidationOptions {
  /** Preview allows incomplete provenance; active is the fail-closed runtime/activation contract. */
  mode?: 'preview' | 'active';
  /** Exact file bytes as read from disk, keyed by focused filename. */
  focusedFileContents?: Partial<Record<ClassificationFocusedFileName, string | Uint8Array>>;
  /** Catalog fields attested by a product export/field registry. Required in active mode. */
  catalogFields?: Iterable<string>;
  /** Stable IDs from an active, verified Page import. */
  verifiedPageIds?: Iterable<string>;
  /** Qualification receipts already verified by the benchmark subsystem. */
  verifiedQualificationReceiptDigests?: Iterable<string>;
  /**
   * The exact unresolved migration findings carried by a migrated candidate.
   * When the manifest declares migration provenance, the supplied findings must
   * reproduce the provenance digest; otherwise the candidate has been tampered
   * with. Milestone 3 supplies the committed evidence artifact for the active
   * catalog/field-set binding through {@link verifyCatalogEvidence}.
   */
  unresolvedMigrationFindings?: Iterable<UnresolvedMigrationFinding>;
  /**
   * Binds the manifest catalogEvidenceHash to the attested live Catalog Field
   * set and source catalog commit. Required in active mode; Milestone 3
   * provides the implementation backed by the generated committed evidence
   * artifact. No locality/provider-name guessing is ever performed here.
   */
  verifyCatalogEvidence?: CatalogEvidenceVerifier;
}

export interface ClassificationConfigValidationReport {
  valid: boolean;
  findings: ClassificationConfigFinding[];
  /** Present only when structural and semantic validation both succeeded. */
  config?: ClassificationConfigBundleV2;
}

type MappingV2 = ClassificationConfigBundleV2['attributeMappings'][number];

/**
 * Content digest of the exact unresolved-migration finding list so the
 * migration preview's safety state is bound into the manifest.
 */
export function computeMigrationFindingsDigest(
  findings: readonly UnresolvedMigrationFinding[],
): string {
  return hashCanonicalJson(findings.map(finding => ({
    severity: finding.severity,
    code: finding.code,
    path: finding.path,
    message: finding.message,
  })));
}

export function computeClassificationBundleHash(
  manifest: Omit<ClassificationManifestV2, 'bundleHash'> | ClassificationManifestV2,
): string {
  // Issue #31 D6: the bundle hash covers only SEMANTIC authority fields.
  // `updatedAt` is audit/timeline metadata, never drift content — an
  // identical effective config written at different times must produce the
  // SAME bundleHash so a no-op touch cannot masquerade as config drift.
  // `bundleHash` itself is excluded too (the recompute in the validator feeds
  // the full manifest, and a self-referential hash could never verify). The
  // explicit field list is deterministic under the strict manifest schema.
  const {
    schemaVersion,
    compatibilityVersion,
    createdAt,
    activeRevision,
    lifecycle,
    hasUnresolvedSafetyFindings,
    migrationProvenance,
    sourceCatalogCommit,
    catalogEvidenceHash,
    fileVersions,
  } = manifest;
  return hashCanonicalJson({
    schemaVersion,
    compatibilityVersion,
    createdAt,
    activeRevision,
    lifecycle,
    hasUnresolvedSafetyFindings,
    migrationProvenance,
    sourceCatalogCommit,
    catalogEvidenceHash,
    fileVersions,
  });
}

function zodPath(path: PropertyKey[]): string {
  if (path.length === 0) return '$';
  return path.reduce<string>((result, part) => (
    typeof part === 'number' ? `${result}[${part}]` : `${result}.${String(part)}`
  ), '$');
}

function addDuplicateFindings(
  findings: ClassificationConfigFinding[],
  values: Array<{ id: string }>,
  path: string,
): void {
  const seen = new Map<string, number>();
  values.forEach((value, index) => {
    const first = seen.get(value.id);
    if (first !== undefined) {
      findings.push({
        severity: 'error',
        code: 'duplicate_id',
        path: `${path}[${index}].id`,
        message: `Duplicate id "${value.id}" (first declared at ${path}[${first}].id).`,
      });
    } else {
      seen.set(value.id, index);
    }
  });
}

function addIdentityAliasFindings(
  findings: ClassificationConfigFinding[],
  values: Array<{ id: string; oldIdAliases: string[] }>,
  path: string,
): void {
  // Register every current ID before processing any alias. Otherwise an early
  // entry can claim a later entry's current ID and have that ownership silently
  // overwritten when the later entry is visited.
  const owners = new Map<string, string>();
  for (const value of values) owners.set(value.id, value.id);
  values.forEach((value, index) => {
    const seenInEntry = new Set<string>();
    value.oldIdAliases.forEach((alias, aliasIndex) => {
      const aliasPath = `${path}[${index}].oldIdAliases[${aliasIndex}]`;
      if (alias === value.id) {
        findings.push({
          severity: 'warning',
          code: 'alias_equals_current_id',
          path: aliasPath,
          message: `Stable identity alias "${alias}" must differ from its own id.`,
        });
      }
      if (seenInEntry.has(alias)) {
        findings.push({
          severity: 'warning',
          code: 'duplicate_old_id_alias',
          path: aliasPath,
          message: `Stable identity alias "${alias}" is declared more than once in this entry.`,
        });
      }
      seenInEntry.add(alias);
      const prior = owners.get(alias);
      if (prior !== undefined && prior !== value.id) {
        findings.push({
          severity: 'warning',
          code: 'duplicate_old_id_alias',
          path: aliasPath,
          message: `Stable identity alias "${alias}" is already owned by "${prior}".`,
        });
      } else {
        owners.set(alias, value.id);
      }
    });
  });
}

function addDuplicateLabelWarnings(
  findings: ClassificationConfigFinding[],
  values: Array<{ id: string; name: string }>,
  path: string,
): void {
  const labels = new Map<string, string>();
  values.forEach((value, index) => {
    const normalized = comparisonKey(value.name);
    const prior = labels.get(normalized);
    if (prior && prior !== value.id) {
      findings.push({
        severity: 'warning',
        code: 'duplicate_display_label',
        path: `${path}[${index}].name`,
        message: `Display label "${value.name}" is also used by "${prior}" and may confuse reviewers.`,
      });
    } else {
      labels.set(normalized, value.id);
    }
  });
}

function aliasesForAttribute(
  attribute: ClassificationConfigBundleV2['attributes'][number],
  profileAliases: Array<{ alias: string; mapsTo: string }> = [],
): Array<{ alias: string; mapsTo: string; path: string }> {
  return [
    ...attribute.valueAliases.map((entry, index) => ({ ...entry, path: `attributes.${attribute.id}.valueAliases[${index}]` })),
    ...profileAliases.map((entry, index) => ({ ...entry, path: `profile.valueAliases[${index}]` })),
  ];
}

function serializationKind(mapping: MappingV2): MappingV2['serialization']['kind'] {
  return mapping.serialization.kind;
}

function isEffectiveTarget(
  target: ClassificationConfigBundleV2['curationTargets'][number],
): boolean {
  return target.enabled || target.mandatory;
}

export function validateClassificationConfigBundle(
  input: unknown,
  options: ClassificationConfigValidationOptions = {},
): ClassificationConfigValidationReport {
  const findings: ClassificationConfigFinding[] = [];
  const parsed = ClassificationConfigBundleV2Schema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      findings.push({
        severity: 'error',
        code: 'schema_invalid',
        path: zodPath(issue.path),
        message: issue.message,
      });
    }
    return { valid: false, findings };
  }

  const config = parsed.data;
  const mode = options.mode ?? 'preview';
  const expectedFiles = new Set<string>(ClassificationFocusedFileNames);

  if (mode === 'preview' && config.manifest.lifecycle !== 'preview') {
    findings.push({
      severity: 'error',
      code: 'preview_lifecycle_required',
      path: '$.manifest.lifecycle',
      message: 'Lifecycle-active bundles may only be validated through active mode.',
    });
  }

  const manifestOrigin = config.manifest.migrationProvenance;
  const focusedOrigin = config.bundleOrigin;
  const originMatches = manifestOrigin.kind === focusedOrigin.kind
    && (manifestOrigin.kind !== 'migrated_v1'
      || (focusedOrigin.kind === 'migrated_v1'
        && manifestOrigin.sourceConfigHash === focusedOrigin.sourceConfigHash));
  if (!originMatches) {
    findings.push({
      severity: 'error',
      code: 'bundle_origin_mismatch',
      path: '$.bundleOrigin',
      message: 'Manifest provenance must match the origin bound into every focused-file payload.',
    });
  }

  if (mode === 'active') {
    if (config.manifest.lifecycle !== 'active' || config.manifest.hasUnresolvedSafetyFindings) {
      findings.push({
        severity: 'error',
        code: 'active_lifecycle_required',
        path: '$.manifest.lifecycle',
        message: 'Active configuration must be explicitly activated with no unresolved safety findings.',
      });
    }
    if (manifestOrigin.kind === 'migrated_v1' || focusedOrigin.kind === 'migrated_v1') {
      findings.push({
        severity: 'error',
        code: 'unresolved_migration_provenance',
        path: '$.manifest.migrationProvenance',
        message: 'Migrated candidates cannot be activated; a reviewed generator must regenerate clean focused files and a clean manifest.',
      });
    }
    if (!config.manifest.sourceCatalogCommit || !/^[a-f0-9]{40,64}$/.test(config.manifest.sourceCatalogCommit)) {
      findings.push({
        severity: 'warning',
        code: 'active_catalog_commit_required',
        path: '$.manifest.sourceCatalogCommit',
        message: 'Active configuration requires an attested lowercase catalog commit hash.',
      });
    }
    if (!config.manifest.catalogEvidenceHash) {
      findings.push({
        severity: 'warning',
        code: 'active_catalog_evidence_required',
        path: '$.manifest.catalogEvidenceHash',
        message: 'Active configuration requires a catalog-evidence SHA-256.',
      });
    }
    if (/preview|draft|migrated/i.test(config.manifest.activeRevision)) {
      findings.push({
        severity: 'error',
        code: 'preview_revision_not_active',
        path: '$.manifest.activeRevision',
        message: 'Preview, draft, and migration revision identifiers cannot be active.',
      });
    }
    if (!options.catalogFields) {
      findings.push({
        severity: 'error',
        code: 'catalog_attestation_required',
        path: '$.manifest.catalogEvidenceHash',
        message: 'Active validation requires the attested live Catalog Field set.',
      });
    }
    if (!options.verifyCatalogEvidence) {
      findings.push({
        severity: 'error',
        code: 'catalog_evidence_verifier_required',
        path: '$.manifest.catalogEvidenceHash',
        message: 'Active validation requires a catalog-evidence verifier that binds the manifest evidence hash to the attested field set and source commit (Milestone 3 supplies the committed evidence artifact).',
      });
    } else if (config.manifest.catalogEvidenceHash) {
      const verification = options.verifyCatalogEvidence({
        catalogEvidenceHash: config.manifest.catalogEvidenceHash,
        sourceCatalogCommit: config.manifest.sourceCatalogCommit ?? '',
        catalogFields: new Set(options.catalogFields ?? []),
      });
      if (!verification.verified) {
        findings.push({
          severity: 'error',
          code: 'catalog_evidence_unverified',
          path: '$.manifest.catalogEvidenceHash',
          message: verification.reason ?? 'Catalog evidence attestation failed.',
        });
      }
    }
  }
  if (manifestOrigin.kind === 'migrated_v1' && !config.manifest.hasUnresolvedSafetyFindings) {
    findings.push({
      severity: 'error',
      code: 'migration_provenance_inconsistent',
      path: '$.manifest.hasUnresolvedSafetyFindings',
      message: 'A migrated candidate must declare unresolved safety findings while its migration provenance is present.',
    });
  }
  if (options.unresolvedMigrationFindings) {
    const supplied = [...options.unresolvedMigrationFindings];
    if (manifestOrigin.kind !== 'migrated_v1') {
      findings.push({
        severity: 'error',
        code: 'unexpected_migration_findings',
        path: '$.manifest.migrationProvenance',
        message: 'Migration findings were supplied for a reviewed-generation candidate.',
      });
    } else {
      const expectedDigest = computeMigrationFindingsDigest(supplied);
      if (expectedDigest !== manifestOrigin.findingsDigest) {
        findings.push({
          severity: 'error',
          code: 'migration_findings_digest_mismatch',
          path: '$.manifest.migrationProvenance.findingsDigest',
          message: `Migration findings digest mismatch: expected ${expectedDigest}.`,
        });
      }
      if (supplied.length !== manifestOrigin.findingCount) {
        findings.push({
          severity: 'error',
          code: 'migration_finding_count_mismatch',
          path: '$.manifest.migrationProvenance.findingCount',
          message: `Migration finding count mismatch: expected ${manifestOrigin.findingCount}, supplied ${supplied.length}.`,
        });
      }
      const suppliedErrorCount = supplied.filter(finding => finding.severity === 'error').length;
      if (suppliedErrorCount !== manifestOrigin.errorCount) {
        findings.push({
          severity: 'error',
          code: 'migration_finding_error_count_mismatch',
          path: '$.manifest.migrationProvenance.errorCount',
          message: `Migration error count mismatch: expected ${manifestOrigin.errorCount}, supplied ${suppliedErrorCount}.`,
        });
      }
    }
  }
  const actualFiles = Object.keys(config.manifest.fileVersions);
  const isV4 = (config as unknown as { taxonomyRevision?: unknown }).taxonomyRevision !== undefined;
  if (!isV4) {
    for (const fileName of ClassificationFocusedFileNames) {
      if (!Object.prototype.hasOwnProperty.call(config.manifest.fileVersions, fileName)) {
        findings.push({
          severity: 'warning',
          code: 'missing_file_hash',
          path: `$.manifest.fileVersions.${fileName}`,
          message: `Missing SHA-256 for ${fileName}.`,
        });
      }
    }
    for (const fileName of actualFiles) {
      if (!expectedFiles.has(fileName)) {
        findings.push({
          severity: 'warning',
          code: 'unexpected_file_hash',
          path: `$.manifest.fileVersions.${fileName}`,
          message: `Unexpected focused-file hash for ${fileName}.`,
        });
      }
    }
  }

  const expectedBundleHash = computeClassificationBundleHash(config.manifest);
  if (config.manifest.bundleHash !== expectedBundleHash) {
    findings.push({
      severity: 'error',
      code: 'bundle_hash_mismatch',
      path: '$.manifest.bundleHash',
      message: `Bundle hash mismatch: expected ${expectedBundleHash}.`,
    });
  }

  if (options.focusedFileContents) {
    for (const fileName of ClassificationFocusedFileNames) {
      const content = options.focusedFileContents[fileName];
      if (content === undefined) {
        findings.push({
          severity: 'error',
          code: 'missing_focused_file',
          path: `$.files.${fileName}`,
          message: `No content was supplied for ${fileName}.`,
        });
        continue;
      }
      const actualHash = sha256Hex(content);
      const expectedHash = config.manifest.fileVersions[fileName];
      if (expectedHash !== actualHash) {
        findings.push({
          severity: 'error',
          code: 'file_hash_mismatch',
          path: `$.manifest.fileVersions.${fileName}`,
          message: `${fileName} hash mismatch: expected ${expectedHash}, read ${actualHash}.`,
        });
      }
      try {
        const text = typeof content === 'string'
          ? content
          : new TextDecoder('utf-8', { fatal: true }).decode(content);
        const envelope = JSON.parse(text) as Record<string, unknown>;
        const parsedOrigin = ClassificationBundleOriginV2Schema.safeParse(envelope.bundleOrigin);
        if (!parsedOrigin.success) {
          findings.push({
            severity: 'error',
            code: 'focused_file_origin_invalid',
            path: `$.files.${fileName}.bundleOrigin`,
            message: `${fileName} does not carry a valid required bundle origin.`,
          });
        } else if (hashCanonicalJson(parsedOrigin.data) !== hashCanonicalJson(config.bundleOrigin)) {
          findings.push({
            severity: 'error',
            code: 'focused_file_origin_mismatch',
            path: `$.files.${fileName}.bundleOrigin`,
            message: `${fileName} origin does not match the bundle origin under validation.`,
          });
        }
      } catch {
        findings.push({
          severity: 'error',
          code: 'focused_file_origin_invalid',
          path: `$.files.${fileName}.bundleOrigin`,
          message: `${fileName} could not be decoded as a focused-file envelope with a valid bundle origin.`,
        });
      }
    }
  }

  addDuplicateFindings(findings, config.productTypes, '$.productTypes');
  addDuplicateFindings(findings, config.attributes, '$.attributes');
  addDuplicateFindings(findings, config.attributeProfiles, '$.attributeProfiles');
  addDuplicateFindings(findings, config.attributeMappings, '$.attributeMappings');
  addDuplicateFindings(findings, config.curationTargets, '$.curationTargets');
  addDuplicateFindings(findings, config.brands, '$.brands');
  addDuplicateFindings(findings, config.guidance, '$.guidance');
  addIdentityAliasFindings(findings, config.productTypes, '$.productTypes');
  addIdentityAliasFindings(findings, config.attributes, '$.attributes');
  addIdentityAliasFindings(findings, config.attributeProfiles, '$.attributeProfiles');
  addDuplicateLabelWarnings(findings, config.productTypes, '$.productTypes');
  addDuplicateLabelWarnings(findings, config.attributes, '$.attributes');
  addDuplicateLabelWarnings(findings, config.attributeProfiles, '$.attributeProfiles');

  const productTypes = new Map(config.productTypes.map((entry, index) => [entry.id, { entry, index }]));
  const attributes = new Map(config.attributes.map((entry, index) => [entry.id, { entry, index }]));
  const profiles = new Map(config.attributeProfiles.map((entry, index) => [entry.id, { entry, index }]));

  config.productTypes.forEach((type, index) => {
    let profileEntry = type.attributeProfileId ? profiles.get(type.attributeProfileId) : undefined;
    if (type.attributeProfileId) {
      if (!profileEntry) {
        findings.push({
          severity: 'error',
          code: 'dangling_profile',
          path: `$.productTypes[${index}].attributeProfileId`,
          message: `Unknown Attribute Profile "${type.attributeProfileId}".`,
        });
      } else if (profileEntry.entry.productTypeId !== type.id) {
        findings.push({
          severity: 'error',
          code: 'profile_type_mismatch',
          path: `$.productTypes[${index}].attributeProfileId`,
          message: `Profile "${profileEntry.entry.id}" belongs to Product Type "${profileEntry.entry.productTypeId}".`,
        });
      }
    }

    if (type.invariantAttributes) {
      const invariantEntries = Object.entries(type.invariantAttributes);
      for (const [attrId, rawVal] of invariantEntries) {
        const attrRecord = attributes.get(attrId);
        if (!attrRecord) {
          findings.push({
            severity: 'error',
            code: 'unknown_invariant_attribute',
            path: `$.productTypes[${index}].invariantAttributes.${attrId}`,
            message: `Product Type "${type.id}" defines invariant for unknown attribute "${attrId}".`,
          });
          continue;
        }

        const attr = attrRecord.entry;
        const isUniversal = (attr as { isUniversal?: boolean }).isUniversal === true;
        const profileAttr = profileEntry?.entry.attributes.find(a => a.attributeId === attrId);

        if (!isUniversal && !profileAttr) {
          findings.push({
            severity: 'error',
            code: 'invariant_attribute_not_applicable',
            path: `$.productTypes[${index}].invariantAttributes.${attrId}`,
            message: `Attribute "${attrId}" is an invariant for Product Type "${type.id}" but is not in its Attribute Profile or universal.`,
          });
        }

        const cardinality = profileAttr?.cardinality ?? 'single';
        if (cardinality === 'single' && Array.isArray(rawVal)) {
          findings.push({
            severity: 'error',
            code: 'invariant_cardinality_mismatch',
            path: `$.productTypes[${index}].invariantAttributes.${attrId}`,
            message: `Single-cardinality attribute "${attrId}" cannot have an array invariant value.`,
          });
        } else if (cardinality === 'multiple' && !Array.isArray(rawVal)) {
          findings.push({
            severity: 'error',
            code: 'invariant_cardinality_mismatch',
            path: `$.productTypes[${index}].invariantAttributes.${attrId}`,
            message: `Multiple-cardinality attribute "${attrId}" requires a non-empty array invariant value.`,
          });
        }

        if (attr.valueMode === 'controlled') {
          const valuesToCheck = Array.isArray(rawVal) ? rawVal : [rawVal];
          for (const val of valuesToCheck) {
            if (!attr.allowedValues.includes(String(val))) {
              findings.push({
                severity: 'error',
                code: 'invalid_invariant_controlled_value',
                path: `$.productTypes[${index}].invariantAttributes.${attrId}`,
                message: `Invariant value "${val}" is not in allowedValues for controlled attribute "${attrId}".`,
              });
            }
          }
        }
      }
    }
  });

  config.attributes.forEach((attribute, index) => {
    if (attribute.valueMode === 'measured' && !attribute.canonicalUnit) {
      findings.push({
        severity: 'error',
        code: 'measured_unit_required',
        path: `$.attributes[${index}].canonicalUnit`,
        message: 'Measured attributes require a canonical unit.',
      });
    }
    if (attribute.valueMode === 'controlled' && attribute.allowedValues.length === 0) {
      findings.push({
        severity: 'error',
        code: 'controlled_values_required',
        path: `$.attributes[${index}].allowedValues`,
        message: 'Controlled attributes require at least one allowed value.',
      });
    }
    if (attribute.isClaim && attribute.isCompositionAttribute) {
      findings.push({
        severity: 'error',
        code: 'claim_composition_overlap',
        path: `$.attributes[${index}]`,
        message: 'An attribute cannot be both a claim and a composition attribute.',
      });
    }
    const permitsVisualSource = attribute.evidencePolicy.allowedSources.includes('visual_product_evidence');
    const permitsThirdPartySource = attribute.evidencePolicy.allowedSources.includes('third_party_page');
    if (attribute.visualEvidenceEligibility === 'ineligible' && attribute.evidencePolicy.allowVisualEvidence) {
      findings.push({
        severity: 'error',
        code: 'visual_policy_conflict',
        path: `$.attributes[${index}].evidencePolicy.allowVisualEvidence`,
        message: 'Visual evidence is enabled for a visually ineligible attribute.',
      });
    }
    if (permitsVisualSource !== attribute.evidencePolicy.allowVisualEvidence) {
      findings.push({
        severity: 'error',
        code: 'visual_source_policy_mismatch',
        path: `$.attributes[${index}].evidencePolicy`,
        message: 'Visual source membership must match allowVisualEvidence.',
      });
    }
    if (permitsThirdPartySource !== attribute.evidencePolicy.allowThirdPartyEvidence) {
      findings.push({
        severity: 'error',
        code: 'third_party_source_policy_mismatch',
        path: `$.attributes[${index}].evidencePolicy`,
        message: 'Third-party source membership must match allowThirdPartyEvidence.',
      });
    }
    if (attribute.evidencePolicy.allowThirdPartyEvidence) {
      if (!attribute.evidencePolicy.thirdPartyEvidenceApproval
        || !attribute.evidencePolicy.manualReviewRequired) {
        findings.push({
          severity: 'error',
          code: 'third_party_review_approval_required',
          path: `$.attributes[${index}].evidencePolicy`,
          message: 'Third-party evidence requires an explicit reviewed approval and mandatory manual review.',
        });
      }
    } else if (attribute.evidencePolicy.thirdPartyEvidenceApproval) {
      findings.push({
        severity: 'error',
        code: 'unexpected_third_party_approval',
        path: `$.attributes[${index}].evidencePolicy.thirdPartyEvidenceApproval`,
        message: 'Third-party approval must be null when third-party evidence is disabled.',
      });
    }
    if (attribute.isClaim || attribute.isCompositionAttribute) {
      if (!attribute.evidencePolicy.directEvidenceRequired
        || !attribute.evidencePolicy.forbidAbsenceInference
        || !attribute.evidencePolicy.manualReviewRequired) {
        findings.push({
          severity: 'error',
          code: 'unsafe_direct_evidence_policy',
          path: `$.attributes[${index}].evidencePolicy`,
          message: 'Claim and composition attributes require direct evidence, mandatory review, and must forbid absence inference.',
        });
      }
      const alwaysProhibitedSources = new Set(['page_context', 'approved_product_example', 'spreadsheet', 'catalog_product']);
      const unsafeSource = attribute.evidencePolicy.allowedSources.find(source => alwaysProhibitedSources.has(source));
      if (unsafeSource) {
        findings.push({
          severity: 'error',
          code: 'unsafe_evidence_source',
          path: `$.attributes[${index}].evidencePolicy`,
          message: `Claim and composition attributes cannot use ${unsafeSource} as direct evidence.`,
        });
      }
    }
    if (attribute.valueMode === 'controlled') {
      const allowed = new Set(attribute.allowedValues);
      if (allowed.size !== attribute.allowedValues.length) {
        findings.push({
          severity: 'error',
          code: 'duplicate_controlled_value',
          path: `$.attributes[${index}].allowedValues`,
          message: 'Controlled values must be unique.',
        });
      }
      // Canonical identity (issue #17 G): every controlled value must be its
      // own canonical form (non-empty, NFC, trimmed, no control characters)
      // and the set must be free of normalized/case-fold collision pairs — an
      // ambiguous set can never activate.
      attribute.allowedValues.forEach((value, valueIndex) => {
        const valuePath = `$.attributes[${index}].allowedValues[${valueIndex}]`;
        const canonical = validateCanonicalValue(value);
        if (!canonical.ok) {
          findings.push({
            severity: 'error',
            code: 'non_canonical_controlled_value',
            path: valuePath,
            message: `Controlled value ${JSON.stringify(value)} is not canonical (${canonical.reason}); store the NFC-normalized, trimmed form.`,
          });
        }
      });
      for (const collision of findCanonicalCollisions(attribute.allowedValues)) {
        findings.push({
          severity: 'error',
          code: 'ambiguous_controlled_value',
          path: `$.attributes[${index}].allowedValues`,
          message: `Controlled values ${JSON.stringify(collision.a)} and ${JSON.stringify(collision.b)} collide (${collision.kind}); an ambiguous set can never activate.`,
        });
      }
      const aliases = aliasesForAttribute(attribute);
      const seenAliases = new Map<string, string>();
      for (const alias of aliases) {
        const priorTarget = seenAliases.get(alias.alias);
        if (priorTarget !== undefined) {
          findings.push({
            severity: 'error',
            code: priorTarget === alias.mapsTo ? 'duplicate_value_alias' : 'ambiguous_value_alias',
            path: `$.${alias.path}.alias`,
            message: priorTarget === alias.mapsTo
              ? `Alias "${alias.alias}" is declared more than once.`
              : `Alias "${alias.alias}" maps to both "${priorTarget}" and "${alias.mapsTo}".`,
          });
        }
        seenAliases.set(alias.alias, alias.mapsTo);
        if (!allowed.has(alias.mapsTo)) {
          findings.push({
            severity: 'error',
            code: 'alias_target_unknown',
            path: `$.${alias.path}.mapsTo`,
            message: `Alias target "${alias.mapsTo}" is not an allowed value for "${attribute.id}".`,
          });
        }
      }
    }
  });

  // Cardinality belongs to a Product Type profile, but the one shared Catalog
  // Field serializer must be able to represent every configured use. A
  // delimited serializer can represent both a single value and a list.
  const profileCardinalities = new Map<string, Set<'single' | 'multiple'>>();
  const enabledTargetCardinalities = new Map<string, Set<'single' | 'multiple'>>();
  const profileByProductType = new Map<string, number>();
  config.attributeProfiles.forEach((profile, profileIndex) => {
    const priorProfile = profileByProductType.get(profile.productTypeId);
    if (priorProfile !== undefined) {
      findings.push({
        severity: 'error',
        code: 'duplicate_product_type_profile',
        path: `$.attributeProfiles[${profileIndex}].productTypeId`,
        message: `Product Type already has a profile at $.attributeProfiles[${priorProfile}].`,
      });
    } else {
      profileByProductType.set(profile.productTypeId, profileIndex);
    }
    const productType = productTypes.get(profile.productTypeId)?.entry;
    if (!productType) {
      findings.push({
        severity: 'error',
        code: 'dangling_product_type',
        path: `$.attributeProfiles[${profileIndex}].productTypeId`,
        message: `Unknown Product Type "${profile.productTypeId}".`,
      });
    } else if (productType.attributeProfileId !== profile.id) {
      findings.push({
        severity: 'error',
        code: 'profile_not_linked',
        path: `$.attributeProfiles[${profileIndex}].id`,
        message: `Product Type "${profile.productTypeId}" does not link to profile "${profile.id}".`,
      });
    }

    const profileAttributeById = new Map(profile.attributes.map(entry => [entry.attributeId, entry]));
    const dependencies = new Map<string, Set<string>>();
    const localAttributes = new Set<string>();
    profile.attributes.forEach((profileAttribute, attributeIndex) => {
      const basePath = `$.attributeProfiles[${profileIndex}].attributes[${attributeIndex}]`;
      if (localAttributes.has(profileAttribute.attributeId)) {
        findings.push({
          severity: 'error',
          code: 'duplicate_profile_attribute',
          path: `${basePath}.attributeId`,
          message: `Attribute "${profileAttribute.attributeId}" appears more than once in this profile.`,
        });
      }
      localAttributes.add(profileAttribute.attributeId);
      const attribute = attributes.get(profileAttribute.attributeId)?.entry;
      if (!attribute) {
        findings.push({
          severity: 'error',
          code: 'dangling_attribute',
          path: `${basePath}.attributeId`,
          message: `Unknown Product Attribute "${profileAttribute.attributeId}".`,
        });
      } else {
        const seen = profileCardinalities.get(attribute.id) ?? new Set<'single' | 'multiple'>();
        seen.add(profileAttribute.cardinality);
        profileCardinalities.set(attribute.id, seen);
        if (attribute.isUniversal) {
          findings.push({
            severity: 'warning',
            code: 'redundant_universal_profile_attribute',
            path: `${basePath}.attributeId`,
            message: `Universal attribute "${attribute.id}" does not need profile membership.`,
          });
        }
        if (attribute.valueMode === 'controlled') {
          const allowed = new Set(attribute.allowedValues);
          const seenAliases = new Map<string, string>();
          for (const alias of aliasesForAttribute(attribute, profileAttribute.valueAliases)) {
            const prior = seenAliases.get(alias.alias);
            if (prior !== undefined) {
              findings.push({
                severity: 'error',
                code: prior === alias.mapsTo ? 'duplicate_value_alias' : 'ambiguous_value_alias',
                path: `${basePath}.valueAliases`,
                message: prior === alias.mapsTo
                  ? `Alias "${alias.alias}" is declared more than once.`
                  : `Alias "${alias.alias}" maps to both "${prior}" and "${alias.mapsTo}".`,
              });
            }
            seenAliases.set(alias.alias, alias.mapsTo);
            if (!allowed.has(alias.mapsTo)) {
              findings.push({
                severity: 'error',
                code: 'alias_target_unknown',
                path: `${basePath}.valueAliases`,
                message: `Alias target "${alias.mapsTo}" is not allowed for "${attribute.id}".`,
              });
            }
          }
        }
      }

      profileAttribute.applicabilityConditions.forEach((condition, conditionIndex) => {
        const conditionPath = `${basePath}.applicabilityConditions[${conditionIndex}]`;
        const referenced = attributes.get(condition.attributeId)?.entry;
        if (!referenced) {
          findings.push({
            severity: 'error',
            code: 'dangling_condition_attribute',
            path: `${conditionPath}.attributeId`,
            message: `Unknown condition attribute "${condition.attributeId}".`,
          });
          return;
        }
        if (condition.attributeId === profileAttribute.attributeId) {
          findings.push({
            severity: 'error',
            code: 'self_referential_applicability',
            path: `${conditionPath}.attributeId`,
            message: 'An attribute cannot determine its own applicability.',
          });
        }
        if (!referenced.isUniversal && !profileAttributeById.has(condition.attributeId)) {
          findings.push({
            severity: 'error',
            code: 'condition_attribute_not_applicable',
            path: `${conditionPath}.attributeId`,
            message: `Applicability can only reference a universal attribute or an attribute in the same Product Type profile; "${condition.attributeId}" is neither.`,
          });
        }
        const edges = dependencies.get(profileAttribute.attributeId) ?? new Set<string>();
        edges.add(condition.attributeId);
        dependencies.set(profileAttribute.attributeId, edges);

        const conditionValues = condition.operator === 'equals' ? [condition.value] : condition.values;
        if (referenced.valueMode === 'controlled') {
          const allowed = new Set(referenced.allowedValues);
          for (const value of conditionValues) {
            if (!allowed.has(value)) {
              findings.push({
                severity: 'error',
                code: 'impossible_condition_value',
                path: conditionPath,
                message: `Condition value "${value}" is not allowed for controlled attribute "${referenced.id}".`,
              });
            }
          }
        }
        const enabledTargetMode = config.curationTargets.find(target => (
          target.kind === 'product_field' && isEffectiveTarget(target) && target.attributeId === condition.attributeId
        ))?.selectionMode;
        const referencedCardinality = profileAttributeById.get(condition.attributeId)?.cardinality
          ?? enabledTargetMode;
        if (condition.operator === 'containsAny' && referencedCardinality !== 'multiple') {
          findings.push({
            severity: 'error',
            code: 'condition_operator_cardinality_mismatch',
            path: `${conditionPath}.operator`,
            message: 'containsAny requires a multiple-cardinality reviewed fact in this profile.',
          });
        }
        if ((condition.operator === 'equals' || condition.operator === 'in') && referencedCardinality === 'multiple') {
          findings.push({
            severity: 'error',
            code: 'condition_operator_cardinality_mismatch',
            path: `${conditionPath}.operator`,
            message: `${condition.operator} requires a single-cardinality reviewed fact; use containsAny for lists.`,
          });
        }
      });
    });

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (attributeId: string): void => {
      if (visiting.has(attributeId)) {
        findings.push({
          severity: 'error',
          code: 'applicability_cycle',
          path: `$.attributeProfiles[${profileIndex}].attributes`,
          message: `Applicability conditions contain a cycle through "${attributeId}".`,
        });
        return;
      }
      if (visited.has(attributeId)) return;
      visiting.add(attributeId);
      for (const dependency of dependencies.get(attributeId) ?? []) {
        if (profileAttributeById.has(dependency)) visit(dependency);
      }
      visiting.delete(attributeId);
      visited.add(attributeId);
    };
    for (const attributeId of dependencies.keys()) visit(attributeId);
  });

  config.curationTargets.forEach(target => {
    if (target.kind === 'product_field' && target.attributeId && isEffectiveTarget(target)) {
      const seen = enabledTargetCardinalities.get(target.attributeId) ?? new Set<'single' | 'multiple'>();
      seen.add(target.selectionMode);
      enabledTargetCardinalities.set(target.attributeId, seen);
    }
  });

  const mappedAttributes = new Map<string, number>();
  const mappedCatalogFields = new Map<string, number>();
  const attestedFields = options.catalogFields ? new Set(options.catalogFields) : null;
  config.attributeMappings.forEach((mapping, index) => {
    const priorAttribute = mappedAttributes.get(mapping.attributeId);
    if (priorAttribute !== undefined) {
      findings.push({
        severity: 'error',
        code: 'duplicate_attribute_mapping',
        path: `$.attributeMappings[${index}].attributeId`,
        message: `Attribute is already mapped at $.attributeMappings[${priorAttribute}].`,
      });
    } else {
      mappedAttributes.set(mapping.attributeId, index);
    }
    const priorField = mappedCatalogFields.get(mapping.catalogField);
    if (priorField !== undefined) {
      findings.push({
        severity: 'error',
        code: 'duplicate_catalog_field_mapping',
        path: `$.attributeMappings[${index}].catalogField`,
        message: `Catalog Field is already targeted at $.attributeMappings[${priorField}].`,
      });
    } else {
      mappedCatalogFields.set(mapping.catalogField, index);
    }

    const attribute = attributes.get(mapping.attributeId)?.entry;
    if (!attribute) {
      findings.push({
        severity: 'error',
        code: 'dangling_attribute',
        path: `$.attributeMappings[${index}].attributeId`,
        message: `Unknown Product Attribute "${mapping.attributeId}".`,
      });
      return;
    }
    if (attestedFields && !attestedFields.has(mapping.catalogField)) {
      findings.push({
        severity: 'error',
        code: 'catalog_field_unattested',
        path: `$.attributeMappings[${index}].catalogField`,
        message: `Catalog Field "${mapping.catalogField}" is not present in the supplied catalog attestation.`,
      });
    }

    const kind = serializationKind(mapping);
    const profileUses = profileCardinalities.get(attribute.id);
    const enabledTargetUses = enabledTargetCardinalities.get(attribute.id);
    const uses = new Set<'single' | 'multiple'>(profileUses ?? []);
    for (const mode of enabledTargetUses ?? []) uses.add(mode);
    if (uses.has('multiple') && kind !== 'delimited') {
      findings.push({
        severity: 'error',
        code: 'serialization_cardinality_mismatch',
        path: `$.attributeMappings[${index}].serialization`,
        message: 'Any multiple-cardinality use requires a shared delimited serializer; the same serializer may also represent single values.',
      });
    }
    if (attribute.valueMode === 'measured') {
      if (uses?.has('multiple')) {
        findings.push({
          severity: 'error',
          code: 'multiple_measured_unsupported',
          path: `$.attributeMappings[${index}].serialization`,
          message: 'Multiple measured values require an explicit future measured-list serialization contract.',
        });
      }
      if (kind !== 'measured') {
        findings.push({
          severity: 'error',
          code: 'measured_serialization_required',
          path: `$.attributeMappings[${index}].serialization`,
          message: 'Measured attributes require measured serialization.',
        });
      } else if (mapping.serialization.kind === 'measured' && mapping.serialization.unit !== attribute.canonicalUnit) {
        findings.push({
          severity: 'error',
          code: 'measured_unit_mismatch',
          path: `$.attributeMappings[${index}].serialization.unit`,
          message: `Serialization unit must equal canonical unit "${attribute.canonicalUnit}".`,
        });
      }
    } else if (kind === 'measured') {
      findings.push({
        severity: 'error',
        code: 'unexpected_measured_serialization',
        path: `$.attributeMappings[${index}].serialization`,
        message: 'Only measured attributes may use measured serialization.',
      });
    }
  });

  const verifiedPageIds = options.verifiedPageIds ? new Set(options.verifiedPageIds) : null;
  const effectiveProductFieldAttributes = new Map<string, number>();
  const effectiveProductFieldCatalogFields = new Map<string, number>();
  config.curationTargets.forEach((target, index) => {
    const basePath = `$.curationTargets[${index}]`;
    const effective = isEffectiveTarget(target);
    if (target.kind === 'product_field') {
      if (effective && target.attributeId) {
        const priorAttributeTarget = effectiveProductFieldAttributes.get(target.attributeId);
        if (priorAttributeTarget !== undefined) {
          findings.push({
            severity: 'error',
            code: 'duplicate_product_field_target_attribute',
            path: `${basePath}.attributeId`,
            message: `Effective Product Field target duplicates the attribute used at $.curationTargets[${priorAttributeTarget}].`,
          });
        } else {
          effectiveProductFieldAttributes.set(target.attributeId, index);
        }
      }
      if (effective && target.catalogField) {
        const priorCatalogFieldTarget = effectiveProductFieldCatalogFields.get(target.catalogField);
        if (priorCatalogFieldTarget !== undefined) {
          findings.push({
            severity: 'error',
            code: 'duplicate_product_field_target_catalog_field',
            path: `${basePath}.catalogField`,
            message: `Effective Product Field target duplicates the Catalog Field used at $.curationTargets[${priorCatalogFieldTarget}].`,
          });
        } else {
          effectiveProductFieldCatalogFields.set(target.catalogField, index);
        }
      }
      if (!target.attributeId || !attributes.has(target.attributeId)) {
        findings.push({
          severity: 'error',
          code: 'dangling_target_attribute',
          path: `${basePath}.attributeId`,
          message: 'Product Field targets require a configured Product Attribute.',
        });
      }
      if (!target.catalogField) {
        findings.push({
          severity: 'error',
          code: 'target_catalog_field_required',
          path: `${basePath}.catalogField`,
          message: 'Product Field targets require a Catalog Field.',
        });
      }
      if (target.attributeId) {
        const attrEntry = attributes.get(target.attributeId)?.entry;
        if (attrEntry && target.optionSource === 'live_store' && attrEntry.valueMode !== 'controlled') {
          findings.push({
            severity: 'error',
            code: 'invalid_option_source_for_value_mode',
            path: `${basePath}.optionSource`,
            message: `Curation target "${target.label}" (${target.catalogField}) cannot use optionSource 'live_store' because attribute "${attrEntry.name}" has valueMode '${attrEntry.valueMode}'.`,
          });
        }
        const mappingIndex = mappedAttributes.get(target.attributeId);
        const mapping = mappingIndex === undefined ? undefined : config.attributeMappings[mappingIndex];
        if (!mapping) {
          findings.push({
            severity: 'error',
            code: 'target_mapping_required',
            path: `${basePath}.attributeId`,
            message: `Enabled Product Field target requires a mapping for "${target.attributeId}".`,
          });
        } else if (mapping.catalogField !== target.catalogField) {
          findings.push({
            severity: 'error',
            code: 'target_mapping_mismatch',
            path: `${basePath}.catalogField`,
            message: `Target Catalog Field does not match mapping "${mapping.id}".`,
          });
        } else if (mapping.isStale && effective) {
          findings.push({
            severity: 'error',
            code: 'stale_mapping_enabled',
            path: `${basePath}.enabled`,
            message: `Target cannot be effective while mapping "${mapping.id}" is stale.`,
          });
        }
        if (effective) {
          const profileUses = profileCardinalities.get(target.attributeId);
          if (profileUses && profileUses.size > 1) {
            findings.push({
              severity: 'error',
              code: 'target_cardinality_conflict',
              path: `${basePath}.selectionMode`,
              message: `Attribute "${target.attributeId}" has mixed Product-Type-scoped cardinality; the schema does not yet represent per-Product-Type selection modes, so an enabled global target cannot be honored.`,
            });
          } else if (profileUses && profileUses.size === 1) {
            const profileMode = [...profileUses][0];
            if (profileMode !== target.selectionMode) {
              findings.push({
                severity: 'error',
                code: 'target_cardinality_mismatch',
                path: `${basePath}.selectionMode`,
                message: `Target selectionMode ${target.selectionMode} contradicts the profile cardinality ${profileMode} for "${target.attributeId}".`,
              });
            }
          }
        }
      }
    } else {
      if (target.attributeId || target.catalogField) {
        findings.push({
          severity: 'error',
          code: 'target_shape_invalid',
          path: basePath,
          message: `${target.kind} targets cannot declare attributeId or catalogField.`,
        });
      }
      if (target.kind === 'product_type') {
        if (target.selectionMode !== 'single' || target.optionSource !== 'configured') {
          findings.push({
            severity: 'error',
            code: 'product_type_target_contract',
            path: basePath,
            message: 'Primary Product Type is single-cardinality and sourced from configured Product Types.',
          });
        }
      } else if (target.kind === 'page') {
        if (target.selectionMode !== 'multiple' || target.optionSource !== 'live_store') {
          findings.push({
            severity: 'error',
            code: 'page_target_contract',
            path: basePath,
            message: 'Category Page targets are multiple-cardinality and sourced from the verified live store.',
          });
        }
        if (mode === 'active' && effective
          && (!verifiedPageIds || verifiedPageIds.size === 0)) {
          findings.push({
            severity: 'error',
            code: 'verified_page_catalog_required',
            path: `${basePath}.enabled`,
            message: 'Enabled Page assignment requires an active verified Page import.',
          });
        }
      }
    }
  });

  const productTypeTargets = config.curationTargets.filter(target => (
    target.kind === 'product_type' && isEffectiveTarget(target)
  ));
  if (productTypeTargets.length !== 1) {
    findings.push({
      severity: 'error',
      code: productTypeTargets.length === 0 ? 'product_type_target_required' : 'duplicate_product_type_target',
      path: '$.curationTargets',
      message: productTypeTargets.length === 0
        ? 'Exactly one effective Primary Product Type curation target is required.'
        : `Exactly one effective Primary Product Type curation target is required; found ${productTypeTargets.length}.`,
    });
  }

  config.guidance.forEach((guidance, index) => {
    if (guidance.scope === 'workspace' && guidance.scopeId) {
      findings.push({
        severity: 'error',
        code: 'workspace_guidance_scope_id',
        path: `$.guidance[${index}].scopeId`,
        message: 'Workspace guidance cannot have a scope id.',
      });
    }
    if (guidance.scope !== 'workspace' && !guidance.scopeId) {
      findings.push({
        severity: 'error',
        code: 'guidance_scope_id_required',
        path: `$.guidance[${index}].scopeId`,
        message: `${guidance.scope} guidance requires a scope id.`,
      });
    }
    if (guidance.scope === 'productType' && guidance.scopeId && !productTypes.has(guidance.scopeId)) {
      findings.push({
        severity: 'error',
        code: 'dangling_guidance_scope',
        path: `$.guidance[${index}].scopeId`,
        message: `Unknown Product Type "${guidance.scopeId}".`,
      });
    }
    if (guidance.scope === 'attribute' && guidance.scopeId && !attributes.has(guidance.scopeId)) {
      findings.push({
        severity: 'error',
        code: 'dangling_guidance_scope',
        path: `$.guidance[${index}].scopeId`,
        message: `Unknown Product Attribute "${guidance.scopeId}".`,
      });
    }
    if (guidance.scope === 'attributeMapping' && guidance.scopeId
      && !config.attributeMappings.some(mapping => mapping.id === guidance.scopeId)) {
      findings.push({
        severity: 'error',
        code: 'dangling_guidance_scope',
        path: `$.guidance[${index}].scopeId`,
        message: `Unknown Attribute Mapping "${guidance.scopeId}".`,
      });
    }
    if (guidance.scope === 'categoryPage' && guidance.scopeId
      && (!verifiedPageIds || !verifiedPageIds.has(guidance.scopeId))) {
      findings.push({
        severity: 'error',
        code: 'unverified_page_guidance_scope',
        path: `$.guidance[${index}].scopeId`,
        message: `Category Page guidance requires a verified live Page id; "${guidance.scopeId}" is not attested.`,
      });
    }
  });

  const validStageNames = new Set<string>(ClassificationStageNameValues);
  const referencedProviders = new Set<string>();
  if (!config.modelPolicy.defaultProvider || !config.modelPolicy.defaultModel) {
    findings.push({
      severity: 'error',
      code: 'empty_model_default_pair',
      path: '$.modelPolicy',
      message: 'A nonempty default provider/model pair is required.',
    });
  }
  if (config.modelPolicy.defaultProvider) referencedProviders.add(config.modelPolicy.defaultProvider);
  for (const [stageName, override] of Object.entries(config.modelPolicy.stageOverrides)
    .sort(([left], [right]) => left.localeCompare(right))) {
    if (!validStageNames.has(stageName)) {
      findings.push({
        severity: 'error',
        code: 'unknown_model_stage',
        path: `$.modelPolicy.stageOverrides.${stageName}`,
        message: `Unknown classification stage "${stageName}".`,
      });
    }
    const hasProvider = override.provider !== undefined;
    const hasModel = override.model !== undefined;
    if (hasProvider !== hasModel) {
      findings.push({
        severity: 'error',
        code: 'incomplete_model_override',
        path: `$.modelPolicy.stageOverrides.${stageName}`,
        message: 'Stage override provider and model must be configured together or both omitted.',
      });
    }
    if (override.provider !== undefined && !override.provider) {
      findings.push({
        severity: 'error',
        code: 'empty_model_override_provider',
        path: `$.modelPolicy.stageOverrides.${stageName}.provider`,
        message: 'Stage override provider must be nonempty when present.',
      });
    }
    if (override.model !== undefined && !override.model) {
      findings.push({
        severity: 'error',
        code: 'empty_model_override_model',
        path: `$.modelPolicy.stageOverrides.${stageName}.model`,
        message: 'Stage override model must be nonempty when present.',
      });
    }
    if (override.fallbackProvider !== null && override.fallbackProvider !== undefined && !override.fallbackProvider) {
      findings.push({
        severity: 'error',
        code: 'empty_model_fallback_provider',
        path: `$.modelPolicy.stageOverrides.${stageName}.fallbackProvider`,
        message: 'Fallback provider must be nonempty when present.',
      });
    }
    if (override.fallbackModel !== null && override.fallbackModel !== undefined && !override.fallbackModel) {
      findings.push({
        severity: 'error',
        code: 'empty_model_fallback_model',
        path: `$.modelPolicy.stageOverrides.${stageName}.fallbackModel`,
        message: 'Fallback model must be nonempty when present.',
      });
    }
    const hasFallbackProvider = Boolean(override.fallbackProvider);
    const hasFallbackModel = Boolean(override.fallbackModel);
    if (hasFallbackProvider !== hasFallbackModel) {
      findings.push({
        severity: 'error',
        code: 'incomplete_model_fallback',
        path: `$.modelPolicy.stageOverrides.${stageName}`,
        message: 'Fallback provider and model must be configured together or both be null.',
      });
    }
    if (override.provider) referencedProviders.add(override.provider);
    if (override.fallbackProvider) referencedProviders.add(override.fallbackProvider);
  }
  const anyLocalOnly = config.modelPolicy.imageDataSharing === 'local_only'
    || config.modelPolicy.textDataSharing === 'local_only';
  for (const provider of [...referencedProviders].sort()) {
    const hasLocality = Object.prototype.hasOwnProperty.call(config.modelPolicy.providerLocalities, provider);
    const locality = hasLocality ? config.modelPolicy.providerLocalities[provider] : undefined;
    if (!hasLocality || !locality) {
      findings.push({
        severity: 'error',
        code: 'provider_locality_undeclared',
        path: `$.modelPolicy.providerLocalities.${provider}`,
        message: `Provider "${provider}" is referenced by the model policy but has no explicit locality declaration; locality is never guessed from provider names.`,
      });
    } else if (anyLocalOnly && locality !== 'local') {
      findings.push({
        severity: 'error',
        code: 'provider_locality_conflict',
        path: `$.modelPolicy.providerLocalities.${provider}`,
        message: `Provider "${provider}" is declared "${locality}" but the policy requires local-only data processing.`,
      });
    }
  }
  if (config.modelPolicy.imageDataSharing !== config.dataSharing.imagePolicy
    || config.modelPolicy.textDataSharing !== config.dataSharing.textPolicy) {
    findings.push({
      severity: 'error',
      code: 'data_sharing_policy_conflict',
      path: '$.modelPolicy',
      message: 'Model and workspace data-sharing policies must agree exactly.',
    });
  }

  const verifiedReceipts = options.verifiedQualificationReceiptDigests
    ? new Set(options.verifiedQualificationReceiptDigests)
    : null;
  for (const [featureId, policy] of Object.entries(config.modelPolicy.mlFeatures)) {
    if ((policy.state === 'qualified' || policy.state === 'enabled') && !policy.qualificationReceiptDigest) {
      findings.push({
        severity: 'error',
        code: 'ml_qualification_receipt_required',
        path: `$.modelPolicy.mlFeatures.${featureId}.qualificationReceiptDigest`,
        message: `${featureId} cannot be ${policy.state} without a qualification receipt.`,
      });
    }
    if (policy.state === 'enabled' && (!policy.activatedBy || !policy.activatedAt)) {
      findings.push({
        severity: 'error',
        code: 'ml_activation_audit_required',
        path: `$.modelPolicy.mlFeatures.${featureId}`,
        message: `${featureId} cannot be enabled without activation identity and time.`,
      });
    }
    if (mode === 'active' && policy.state === 'enabled'
      && (!policy.qualificationReceiptDigest
        || !verifiedReceipts?.has(policy.qualificationReceiptDigest))) {
      findings.push({
        severity: 'error',
        code: 'ml_verified_receipt_required',
        path: `$.modelPolicy.mlFeatures.${featureId}.qualificationReceiptDigest`,
        message: `${featureId} cannot be active until its receipt is independently verified.`,
      });
    }
  }

  const hasErrors = findings.some(finding => finding.severity === 'error');
  return hasErrors ? { valid: false, findings } : { valid: true, findings, config };
}

export interface ClassificationReadinessCapability {
  kind: 'product_type' | 'product_field' | 'page';
  enabled: boolean;
  targetCount: number;
  runnable: boolean;
  reason?: string;
  multiValueSupported?: boolean;
}

export interface ClassificationReadinessReport {
  isReady: boolean;
  hasWarnings: boolean;
  capabilities: {
    productType: ClassificationReadinessCapability;
    productFields: ClassificationReadinessCapability;
    categoryPages: ClassificationReadinessCapability;
  };
  findings: ClassificationConfigFinding[];
  summary: string[];
}

export function evaluateClassificationReadiness(
  input: unknown,
  options: ClassificationConfigValidationOptions = {},
): ClassificationReadinessReport {
  // Lifecycle-active bundles must never be validated in preview mode: preview
  // validation rejects them with `preview_lifecycle_required`. Route callers
  // supply the active-mode context (catalog fields + evidence verifier) so the
  // active contract is enforced here too.
  const manifestRaw = (input as { manifest?: { schemaVersion?: unknown; lifecycle?: unknown } } | null)?.manifest;
  const isActiveV2 = manifestRaw?.schemaVersion === 2 && manifestRaw?.lifecycle === 'active';
  const effectiveOptions: ClassificationConfigValidationOptions = isActiveV2
    ? { ...options, mode: 'active' }
    : options;
  const validationReport = validateClassificationConfigBundle(input, effectiveOptions);
  const findings = [...validationReport.findings];

  const parsed = ClassificationConfigBundleV2Schema.safeParse(input);
  const config = parsed.success ? parsed.data : null;

  const targets = config?.curationTargets ?? [];
  const productTypeTargets = targets.filter(t => t.kind === 'product_type' && (t.enabled || t.mandatory));
  const fieldTargets = targets.filter(t => t.kind === 'product_field' && (t.enabled || t.mandatory));
  const pageTargets = targets.filter(t => t.kind === 'page' && (t.enabled || t.mandatory));

  // Check mandatory options or target readiness gaps
  if (productTypeTargets.length > 0 && (config?.productTypes?.length ?? 0) === 0) {
    findings.push({
      severity: 'error',
      code: 'target_no_legal_options',
      path: '$.productTypes',
      message: 'Mandatory Product Type target is enabled, but no legal Product Types are configured.',
    });
  }

  if (productTypeTargets.length === 0 && fieldTargets.length === 0 && pageTargets.length > 0) {
    findings.push({
      severity: 'warning',
      code: 'page_only_workspace',
      path: '$.curationTargets',
      message: 'Workspace is configured for Category Page proposals only. Primary Product Type and Product Attribute classifications are disabled.',
    });
  }

  const hasTypeError = findings.some(f => f.severity === 'error' && (f.path.includes('productTypes') || f.code.includes('product_type')));
  const hasFieldError = findings.some(f => f.severity === 'error' && (f.path.includes('attributes') || f.code.includes('attribute') || f.code.includes('product_field')));
  const hasPageError = findings.some(f => f.severity === 'error' && (f.path.includes('page') || f.code.includes('page')));

  const productTypeRunnable = productTypeTargets.length > 0 && (config?.productTypes?.length ?? 0) > 0 && !hasTypeError;
  const productFieldsRunnable = fieldTargets.length > 0 && !hasFieldError;
  const categoryPagesRunnable = pageTargets.length > 0 && !hasPageError;

  const summary: string[] = [
    productTypeRunnable
      ? `Product Type classification is runnable (${productTypeTargets.length} target(s) enabled).`
      : `Product Type classification is disabled (${productTypeTargets.length} target(s) enabled).`,
    productFieldsRunnable
      ? `Product Attribute classification is runnable (${fieldTargets.length} target(s) enabled, single- and multi-value supported).`
      : `Product Attribute classification is disabled (${fieldTargets.length} target(s) enabled).`,
    categoryPagesRunnable
      ? `Category Page classification is runnable (${pageTargets.length} target(s) enabled).`
      : `Category Page classification is disabled (${pageTargets.length} target(s) enabled).`,
  ];

  const errorFindings = findings.filter(f => f.severity === 'error');
  const warningFindings = findings.filter(f => f.severity === 'warning');

  const isReady = (productTypeRunnable || productFieldsRunnable || categoryPagesRunnable) && errorFindings.length === 0;

  return {
    isReady,
    hasWarnings: warningFindings.length > 0,
    capabilities: {
      productType: {
        kind: 'product_type',
        enabled: productTypeTargets.length > 0,
        targetCount: productTypeTargets.length,
        runnable: productTypeRunnable,
        reason: productTypeRunnable ? undefined : (productTypeTargets.length === 0 ? 'No enabled Product Type targets' : 'No Product Types defined in configuration'),
      },
      productFields: {
        kind: 'product_field',
        enabled: fieldTargets.length > 0,
        targetCount: fieldTargets.length,
        runnable: productFieldsRunnable,
        reason: productFieldsRunnable ? undefined : (fieldTargets.length === 0 ? 'No enabled Product Field targets' : 'Configuration errors present'),
        multiValueSupported: true,
      },
      categoryPages: {
        kind: 'page',
        enabled: pageTargets.length > 0,
        targetCount: pageTargets.length,
        runnable: categoryPagesRunnable,
        reason: categoryPagesRunnable ? undefined : (pageTargets.length === 0 ? 'No enabled Category Page targets' : 'Configuration errors present'),
      },
    },
    findings,
    summary,
  };
}
