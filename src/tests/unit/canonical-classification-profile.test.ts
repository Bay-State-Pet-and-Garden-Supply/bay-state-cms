/**
 * Issue #350 slice 7 — empty vs missing profile + readiness gap codes (TDD).
 *
 * A deliberately configured empty profile (attributeProfileId: null) is
 * valid: universal attributes proceed, type-gated ones are not_applicable.
 * A missing profile (dangling pointer) or unmapped type is a precise
 * blocking error — never silent universal-only success. Readiness carries
 * the pair gap codes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { computeClassificationBundleHash, validateClassificationConfigBundle } from '../../classification/config-validation';
import { buildFocusedFiles, generateCandidate } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { ClassificationConfigBundleV2Schema, ClassificationFocusedFileNames } from '../../shared/schemas/classification';
import { sha256Hex } from '../../shared/stable-id';
import { isTaxonomyFrozen, setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import type { CatalogEvidence } from '../../classification/catalog-evidence';

const EVIDENCE: CatalogEvidence = {
  schemaVersion: 1,
  sourceTreeHash: '0'.repeat(64),
  productFileCount: 0,
  parseFailureCount: 0,
  parseFailures: [],
  fieldRegistry: { entryCount: 0, xmlFields: [] },
  fields: [],
  pages: [],
};

beforeEach(() => {
  setTaxonomyFreezeForTests(true);
  expect(isTaxonomyFrozen()).toBe(true);
});

afterEach(() => {
  setTaxonomyFreezeForTests(true);
  expect(isTaxonomyFrozen()).toBe(true);
});


describe('governed canonical configuration validation', () => {
  it('validation reports exact unmapped Category and dangling profile findings on a generated candidate', () => {
    const candidate = generateCandidate(BayStatePetGardenSeed, EVIDENCE);
    const baseline = validateClassificationConfigBundle(candidate.bundle, {
      mode: 'preview',
      focusedFileContents: candidate.focusedFiles,
    });
    expect(baseline.valid).toBe(true);

    const { manifest: sourceManifest, ...candidateContent } = candidate.bundle;
    const targetTypeIndex = candidateContent.productTypes.findIndex(type => type.id === 'dog-food-dry');
    if (targetTypeIndex < 0) throw new Error('Generated fixture candidate is missing its dry dog food Product Type');
    const targetType = candidateContent.productTypes[targetTypeIndex];
    if (!targetType) throw new Error('Generated fixture Product Type index is out of range');
    const danglingProfileId = 'missing-fixture-profile';
    const semanticallyInvalidContent = {
      ...candidateContent,
      productTypes: candidateContent.productTypes.map((type, index) => index === targetTypeIndex
        ? { ...type, categoryId: null, attributeProfileId: danglingProfileId }
        : type),
    };
    const focusedFiles = buildFocusedFiles(semanticallyInvalidContent);
    const fileVersions = Object.fromEntries(
      ClassificationFocusedFileNames.map(fileName => [fileName, sha256Hex(focusedFiles[fileName])]),
    );
    const { bundleHash: _candidateHash, ...sourceManifestWithoutHash } = sourceManifest;
    const manifestWithoutHash = { ...sourceManifestWithoutHash, fileVersions };
    const invalidBundle = ClassificationConfigBundleV2Schema.parse({
      ...semanticallyInvalidContent,
      manifest: {
        ...manifestWithoutHash,
        bundleHash: computeClassificationBundleHash(manifestWithoutHash),
      },
    });

    const report = validateClassificationConfigBundle(invalidBundle, {
      mode: 'preview',
      focusedFileContents: focusedFiles,
    });
    const semanticFindings = report.findings
      .filter(finding => finding.code === 'unmapped_product_type_category' || finding.code === 'dangling_profile')
      .map(({ severity, code, path: findingPath, message }) => ({ severity, code, path: findingPath, message }));
    expect(semanticFindings).toEqual([
      {
        severity: 'error',
        code: 'unmapped_product_type_category',
        path: `$.productTypes[${targetTypeIndex}].categoryId`,
        message: `Product Type "${targetType.id}" has no approved Category mapping; assign its canonical Category explicitly.`,
      },
      {
        severity: 'error',
        code: 'dangling_profile',
        path: `$.productTypes[${targetTypeIndex}].attributeProfileId`,
        message: `Unknown Attribute Profile "${danglingProfileId}".`,
      },
    ]);
    expect(report.findings.some(finding => finding.code === 'schema_invalid')).toBe(false);
    expect(report.valid).toBe(false);
  });
});
