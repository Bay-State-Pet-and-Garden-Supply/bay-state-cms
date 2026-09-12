/**
 * v5 canonical-hierarchy and product-type invariants release validation tests.
 *
 * Verifies the committed bay-state-v5 release validates, loads, and compiles with
 * controlled species, domain facet profiles, and deterministic invariant attributes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertReleaseValidV5,
  loadTaxonomyReleaseV5,
  validateTaxonomyReleaseV5,
  type ReleaseValidationReport,
} from '../../classification/release-validation';
import { compileTaxonomyReleaseV5 } from '../../classification/release-compiler';

const RELEASE_ID = 'bay-state-v5';
const RELEASE_DIR = path.resolve(__dirname, '..', '..', 'classification', 'releases', RELEASE_ID);

function findingCodes(report: ReleaseValidationReport): string[] {
  return report.findings.map(f => f.code);
}

function expectFinding(report: ReleaseValidationReport, code: string): void {
  expect(findingCodes(report)).toContain(code);
}

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-release-test-'));
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch { /* best effort */ }
});

function copyV5Release(scenarioName: string): string {
  const dir = path.join(tmpRoot, `${scenarioName}-${Math.random().toString(36).slice(2, 8)}`, RELEASE_ID);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of fs.readdirSync(RELEASE_DIR)) {
    fs.copyFileSync(path.join(RELEASE_DIR, file), path.join(dir, file));
  }
  return dir;
}

describe('bay-state-v5 release validation & invariants', () => {
  it('validates and loads the committed bay-state-v5 release bundle', () => {
    assertReleaseValidV5(RELEASE_DIR);
    const report = validateTaxonomyReleaseV5(RELEASE_DIR);
    expect(report.ok).toBe(true);
    expect(report.counts.productTypes).toBe(74);

    const bundle = loadTaxonomyReleaseV5(RELEASE_DIR);
    expect(bundle.manifest.revision).toBe('bay-state-v5');
    expect(bundle.hierarchy.length).toBeGreaterThan(74);

    const dryDog = bundle.hierarchy.find(n => n.id === 'dog-food-dry');
    expect(dryDog).toBeDefined();
    expect(dryDog!.invariantAttributes).toEqual({
      species: 'Dog',
      'food-form': 'Dry Food',
    });
  });

  it('verifies species is controlled with canonical values and aliases', () => {
    const bundle = loadTaxonomyReleaseV5(RELEASE_DIR);
    const speciesAttr = bundle.attributes.find(a => a.id === 'species');
    expect(speciesAttr).toBeDefined();
    expect(speciesAttr!.valueMode).toBe('controlled');
    expect(speciesAttr!.allowedValues).toContain('Dog');
    expect(speciesAttr!.allowedValues).toContain('Cat');
    expect(speciesAttr!.allowedValues).toContain('Horse');
    expect(speciesAttr!.allowedValues).toContain('Poultry');
    expect(speciesAttr!.allowedValues).toContain('Cattle');
    expect(speciesAttr!.allowedValues).toContain('Swine');
    expect(speciesAttr!.allowedValues).toContain('Wildlife');

    expect(speciesAttr!.valueAliases.some(a => a.alias === 'canine' && a.mapsTo === 'Dog')).toBe(true);
    expect(speciesAttr!.valueAliases.some(a => a.alias === 'feline' && a.mapsTo === 'Cat')).toBe(true);
    expect(speciesAttr!.valueAliases.some(a => a.alias === 'equine' && a.mapsTo === 'Horse')).toBe(true);
    expect(speciesAttr!.valueAliases.some(a => a.alias === 'chicken' && a.mapsTo === 'Poultry')).toBe(true);
  });

  it('compiles into runtime authority with 30 invariant-bearing product types', () => {
    const bundle = loadTaxonomyReleaseV5(RELEASE_DIR);
    const compiled = compileTaxonomyReleaseV5(bundle);
    expect(compiled.taxonomyRevision).toBe('bay-state-v5');
    expect(compiled.productTypes).toHaveLength(74);

    const dogKibble = compiled.productTypes.find(t => t.id === 'dog-food-dry');
    expect(dogKibble!.invariantAttributes).toEqual({
      species: 'Dog',
      'food-form': 'Dry Food',
    });

    const horseFeed = compiled.productTypes.find(t => t.id === 'horse-feed');
    expect(horseFeed!.invariantAttributes).toEqual({ species: 'Horse' });

    const pellets = compiled.productTypes.find(t => t.id === 'heating-pellets-wood');
    expect(pellets!.invariantAttributes).toEqual({ 'fuel-type': 'Wood Pellets' });
  });

  describe('invariant validation failure modes on temp copies', () => {
    it('fails when an invariant references an unknown attribute', () => {
      const dir = copyV5Release('unknown-attr');
      const hierarchyPath = path.join(dir, 'hierarchy.json');
      const h = JSON.parse(fs.readFileSync(hierarchyPath, 'utf8'));
      const dog = h.entries.find((n: any) => n.id === 'dog-food-dry');
      dog.invariantAttributes = { 'non-existent-attr': 'Foo' };
      fs.writeFileSync(hierarchyPath, JSON.stringify(h, null, 2));

      const report = validateTaxonomyReleaseV5(dir);
      expect(report.ok).toBe(false);
      expectFinding(report, 'unknown_invariant_attribute');
    });

    it('fails when an invariant attribute is not in the facet profile and not universal', () => {
      const dir = copyV5Release('not-applicable');
      const hierarchyPath = path.join(dir, 'hierarchy.json');
      const h = JSON.parse(fs.readFileSync(hierarchyPath, 'utf8'));
      const dog = h.entries.find((n: any) => n.id === 'dog-food-dry');
      // fuel-type is not in profile-pet-food and is not universal
      dog.invariantAttributes = { 'fuel-type': 'Wood Pellets' };
      fs.writeFileSync(hierarchyPath, JSON.stringify(h, null, 2));

      const report = validateTaxonomyReleaseV5(dir);
      expect(report.ok).toBe(false);
      expectFinding(report, 'invariant_attribute_not_applicable');
    });

    it('fails when an invariant provides an invalid controlled value', () => {
      const dir = copyV5Release('invalid-controlled');
      const hierarchyPath = path.join(dir, 'hierarchy.json');
      const h = JSON.parse(fs.readFileSync(hierarchyPath, 'utf8'));
      const dog = h.entries.find((n: any) => n.id === 'dog-food-dry');
      dog.invariantAttributes = { species: 'Unicorn' };
      fs.writeFileSync(hierarchyPath, JSON.stringify(h, null, 2));

      const report = validateTaxonomyReleaseV5(dir);
      expect(report.ok).toBe(false);
      expectFinding(report, 'invalid_invariant_controlled_value');
    });

    it('fails when cardinality mismatches (single given array)', () => {
      const dir = copyV5Release('cardinality-mismatch');
      const hierarchyPath = path.join(dir, 'hierarchy.json');
      const h = JSON.parse(fs.readFileSync(hierarchyPath, 'utf8'));
      const dog = h.entries.find((n: any) => n.id === 'dog-food-dry');
      dog.invariantAttributes = { species: ['Dog', 'Puppy'] };
      fs.writeFileSync(hierarchyPath, JSON.stringify(h, null, 2));

      const report = validateTaxonomyReleaseV5(dir);
      expect(report.ok).toBe(false);
      expectFinding(report, 'invariant_cardinality_mismatch');
    });

    it('fails when a non-classifiable node defines non-empty invariantAttributes', () => {
      const dir = copyV5Release('non-classifiable-invariants');
      const hierarchyPath = path.join(dir, 'hierarchy.json');
      const h = JSON.parse(fs.readFileSync(hierarchyPath, 'utf8'));
      // pet-supplies is an L1 department root (non-classifiable)
      const dept = h.entries.find((n: any) => n.id === 'pet-supplies');
      expect(dept.classifiable).toBe(false);
      dept.invariantAttributes = { species: 'Dog' };
      fs.writeFileSync(hierarchyPath, JSON.stringify(h, null, 2));

      const report = validateTaxonomyReleaseV5(dir);
      expect(report.ok).toBe(false);
      expectFinding(report, 'invariant_attributes_on_non_classifiable_node');
    });
  });

  describe('shared canonical integrity rules inherited by V5', () => {
    it('fails when a file hash does not match manifest.fileVersions', () => {
      const dir = copyV5Release('corrupt-hash');
      const guidancePath = path.join(dir, 'guidance.json');
      fs.writeFileSync(guidancePath, JSON.stringify({ bundleOrigin: { kind: 'release', releaseId: 'bay-state-v5', createdAt: '2026-09-01T12:00:00.000Z' }, schemaVersion: 2, entries: [] }));

      const report = validateTaxonomyReleaseV5(dir);
      expect(report.ok).toBe(false);
      expectFinding(report, 'manifest_hash_mismatch');
    });

    it('fails when hierarchy contains a cycle or unreachable node', () => {
      const dir = copyV5Release('cycle');
      const hierarchyPath = path.join(dir, 'hierarchy.json');
      const h = JSON.parse(fs.readFileSync(hierarchyPath, 'utf8'));
      // Create a cycle: pet-supplies -> dog -> pet-supplies
      const dept = h.entries.find((n: any) => n.id === 'pet-supplies');
      dept.parentId = 'dog';
      fs.writeFileSync(hierarchyPath, JSON.stringify(h, null, 2));

      const report = validateTaxonomyReleaseV5(dir);
      expect(report.ok).toBe(false);
      expectFinding(report, 'hierarchy_cycle_or_unreachable');
    });

    it('fails when a node references an unknown parentId', () => {
      const dir = copyV5Release('unknown-parent');
      const hierarchyPath = path.join(dir, 'hierarchy.json');
      const h = JSON.parse(fs.readFileSync(hierarchyPath, 'utf8'));
      const dog = h.entries.find((n: any) => n.id === 'dog');
      dog.parentId = 'non-existent-parent';
      fs.writeFileSync(hierarchyPath, JSON.stringify(h, null, 2));

      const report = validateTaxonomyReleaseV5(dir);
      expect(report.ok).toBe(false);
      expectFinding(report, 'unknown_parent_node');
    });

    it('fails when duplicate node ids exist', () => {
      const dir = copyV5Release('duplicate-node');
      const hierarchyPath = path.join(dir, 'hierarchy.json');
      const h = JSON.parse(fs.readFileSync(hierarchyPath, 'utf8'));
      h.entries.push({ ...h.entries[0] });
      fs.writeFileSync(hierarchyPath, JSON.stringify(h, null, 2));

      const report = validateTaxonomyReleaseV5(dir);
      expect(report.ok).toBe(false);
      expectFinding(report, 'duplicate_node_id');
    });

    it('fails when a classifiable leaf is missing a facet profile', () => {
      const dir = copyV5Release('missing-profile');
      const hierarchyPath = path.join(dir, 'hierarchy.json');
      const h = JSON.parse(fs.readFileSync(hierarchyPath, 'utf8'));
      const dog = h.entries.find((n: any) => n.id === 'dog-food-dry');
      dog.facetProfileId = null;
      fs.writeFileSync(hierarchyPath, JSON.stringify(h, null, 2));

      const report = validateTaxonomyReleaseV5(dir);
      expect(report.ok).toBe(false);
      expectFinding(report, 'classifiable_node_missing_profile');
    });

    it('fails when a non-classifiable node specifies a facet profile', () => {
      const dir = copyV5Release('non-classifiable-profile');
      const hierarchyPath = path.join(dir, 'hierarchy.json');
      const h = JSON.parse(fs.readFileSync(hierarchyPath, 'utf8'));
      const dept = h.entries.find((n: any) => n.id === 'pet-supplies');
      dept.facetProfileId = 'profile-accessories';
      fs.writeFileSync(hierarchyPath, JSON.stringify(h, null, 2));

      const report = validateTaxonomyReleaseV5(dir);
      expect(report.ok).toBe(false);
      expectFinding(report, 'non_classifiable_node_has_profile');
    });

    it('fails when an export mapping is missing for an attribute with shopsite disposition', () => {
      const dir = copyV5Release('missing-export-mapping');
      const mappingPath = path.join(dir, 'export-mappings.json');
      const m = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
      m.entries = m.entries.filter((entry: any) => entry.attributeId !== 'species');
      fs.writeFileSync(mappingPath, JSON.stringify(m, null, 2));

      const report = validateTaxonomyReleaseV5(dir);
      expect(report.ok).toBe(false);
      expectFinding(report, 'export_mapping_missing');
    });

    it('fails when a shopsite page projection remains needs_review', () => {
      const dir = copyV5Release('needs-review-page');
      const projectionPath = path.join(dir, 'shopsite-projection.json');
      const p = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
      p.entries[0].role = 'needs_review';
      fs.writeFileSync(projectionPath, JSON.stringify(p, null, 2));

      const report = validateTaxonomyReleaseV5(dir);
      expect(report.ok).toBe(false);
      expectFinding(report, 'page_projection_needs_review');
    });

    it('fails when a controlled attribute has duplicate allowed values', () => {
      const dir = copyV5Release('duplicate-allowed-value');
      const attrPath = path.join(dir, 'attributes.json');
      const attrs = JSON.parse(fs.readFileSync(attrPath, 'utf8'));
      const species = attrs.entries.find((a: any) => a.id === 'species');
      species.allowedValues.push(species.allowedValues[0]);
      fs.writeFileSync(attrPath, JSON.stringify(attrs, null, 2));

      const report = validateTaxonomyReleaseV5(dir);
      expect(report.ok).toBe(false);
      expectFinding(report, 'duplicate_allowed_value');
    });

    it('fails when a controlled attribute value alias maps to an unknown value', () => {
      const dir = copyV5Release('unresolved-value-alias');
      const attrPath = path.join(dir, 'attributes.json');
      const attrs = JSON.parse(fs.readFileSync(attrPath, 'utf8'));
      const species = attrs.entries.find((a: any) => a.id === 'species');
      species.valueAliases.push({ alias: 'dragon', mapsTo: 'MythicalDragon' });
      fs.writeFileSync(attrPath, JSON.stringify(attrs, null, 2));

      const report = validateTaxonomyReleaseV5(dir);
      expect(report.ok).toBe(false);
      expectFinding(report, 'unresolved_value_alias');
    });

    it('fails when a measured attribute is missing canonicalUnit', () => {
      const dir = copyV5Release('missing-canonical-unit');
      const attrPath = path.join(dir, 'attributes.json');
      const attrs = JSON.parse(fs.readFileSync(attrPath, 'utf8'));
      const weight = attrs.entries.find((a: any) => a.valueMode === 'measured');
      if (weight) {
        weight.canonicalUnit = '';
        fs.writeFileSync(attrPath, JSON.stringify(attrs, null, 2));

        const report = validateTaxonomyReleaseV5(dir);
        expect(report.ok).toBe(false);
        expectFinding(report, 'measured_attribute_missing_unit');
      }
    });

    it('fails when guidance structured references contain an unknown product type', () => {
      const dir = copyV5Release('unknown-guidance-type');
      const gPath = path.join(dir, 'guidance.json');
      const g = JSON.parse(fs.readFileSync(gPath, 'utf8'));
      g.entries.push({
        id: 'bad-guidance-ref',
        scope: 'productType',
        scopeId: 'dog-food-dry',
        structured: { productTypeIds: ['non-existent-type'] },
        freeForm: null,
        manualReviewRequirement: false,
      });
      fs.writeFileSync(gPath, JSON.stringify(g, null, 2));

      const report = validateTaxonomyReleaseV5(dir);
      expect(report.ok).toBe(false);
      expectFinding(report, 'guidance_unknown_type_ref');
    });

    it('fails when focused file envelope origins are inconsistent', () => {
      const dir = copyV5Release('inconsistent-origin');
      const attrPath = path.join(dir, 'attributes.json');
      const attrs = JSON.parse(fs.readFileSync(attrPath, 'utf8'));
      attrs.bundleOrigin.releaseId = 'other-release-id';
      fs.writeFileSync(attrPath, JSON.stringify(attrs, null, 2));

      const report = validateTaxonomyReleaseV5(dir);
      expect(report.ok).toBe(false);
      expectFinding(report, 'inconsistent_release_origin');
    });
  });
});
