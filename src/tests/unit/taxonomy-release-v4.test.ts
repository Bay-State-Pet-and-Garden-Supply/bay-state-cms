/**
 * v4 canonical-hierarchy release validation tests (P-v4 gate).
 *
 * Verifies the committed bay-state-v4 release validates and loads, then
 * exercises every hierarchy invariant on TEMP COPIES (never mutates the real
 * release): duplicate node ids, unknown parents, cycles, missing facet
 * profiles, unknown attribute refs, page/node collisions, non-classifiable
 * canonical pages, manifest count/hash mismatches, and release-id binding.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ReleaseValidationError,
  assertReleaseValidV4,
  loadTaxonomyReleaseV4,
  validateTaxonomyReleaseV4,
  type ReleaseValidationReport,
} from '../../classification/release-validation';

const RELEASE_ID = 'bay-state-v4';
const RELEASE_DIR = path.resolve(__dirname, '..', '..', 'classification', 'releases', RELEASE_ID);
const V3_RELEASE_ID = 'bay-state-v3';
const V3_RELEASE_DIR = path.resolve(__dirname, '..', '..', 'classification', 'releases', V3_RELEASE_ID);

function findingCodes(report: ReleaseValidationReport): string[] {
  return report.findings.map(f => f.code);
}

function expectFinding(report: ReleaseValidationReport, code: string): void {
  expect(findingCodes(report)).toContain(code);
}

function bundleProfileExists(profileId: string): boolean {
  const profiles = JSON.parse(
    fs.readFileSync(path.join(RELEASE_DIR, 'facet-profiles.json'), 'utf8'),
  );
  return profiles.entries.some((p: any) => p.id === profileId);
}

// ─── Temp-copy helpers (tests never mutate the real release) ───────────────────

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-release-test-'));
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch { /* best effort */ }
});

/**
 * Create a per-test release directory named `bay-state-v4` with a sibling
 * `bay-state-v3` baseline, so release-id binding and the leaf bijection checks
 * behave exactly like the committed release. Returns the v4 dir path.
 */
function freshCopy(): string {
  const caseRoot = path.join(tmpRoot, `case-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(caseRoot, { recursive: true });
  const dir = path.join(caseRoot, RELEASE_ID);
  fs.cpSync(RELEASE_DIR, dir, { recursive: true });
  fs.cpSync(V3_RELEASE_DIR, path.join(caseRoot, V3_RELEASE_ID), { recursive: true });
  return dir;
}

function readJson(dir: string, fileName: string): any {
  return JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8'));
}

function writeJson(dir: string, fileName: string, data: unknown): void {
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ─── Positive: the committed release ───────────────────────────────────────────

describe('committed bay-state-v4 release', () => {
  it('loads with expected counts matching the manifest', () => {
    const bundle = loadTaxonomyReleaseV4(RELEASE_ID);
    expect(bundle.manifest.releaseId).toBe('bay-state-v4');
    expect(bundle.manifest.counts.nodes).toBe(91);
    expect(bundle.hierarchy.length).toBe(91);
    const leaves = bundle.hierarchy.filter(n => n.classifiable);
    expect(leaves.length).toBe(74);
    expect(bundle.manifest.counts.types).toBe(74);
    expect(bundle.attributes.length).toBe(27);
    expect(bundle.manifest.counts.attributes).toBe(27);
    expect(bundle.pageProjections.length).toBe(153);
    expect(bundle.pageProjections.filter(page => page.role === 'needs_review')).toHaveLength(0);
    expect(bundle.manifest.counts.pages).toBe(153);
    expect(bundle.exportMappings.length).toBe(19);
    expect(bundle.manifest.counts.mappings).toBe(19);
    expect(bundle.facetProfiles.length).toBe(9);
    expect(bundle.guidance.length).toBe(3);
  });

  it('validates with ok=true and zero error findings', () => {
    const report = validateTaxonomyReleaseV4(RELEASE_ID);
    expect(report.ok).toBe(true);
    expect(report.findings.filter(f => f.severity === 'error')).toEqual([]);
  });

  it('assertReleaseValidV4 does not throw', () => {
    expect(() => assertReleaseValidV4(RELEASE_ID)).not.toThrow();
  });

  it('hierarchy shape: 10 roots, 4 browse + 3 families, 74 leaves, all reachable', () => {
    const bundle = loadTaxonomyReleaseV4(RELEASE_ID);
    const roots = bundle.hierarchy.filter(n => n.parentId === null);
    expect(roots.length).toBe(10);
    const groups = bundle.hierarchy.filter(n => n.derivation === 'group');
    expect(groups.length).toBe(4);
    const families = bundle.hierarchy.filter(n => n.derivation === 'family');
    expect(families.length).toBe(3);
    const leaves = bundle.hierarchy.filter(n => n.classifiable);
    expect(leaves.length).toBe(74);
    const nodeIds = new Set(bundle.hierarchy.map(n => n.id));
    expect(nodeIds.size).toBe(bundle.hierarchy.length);
    // Every non-root parent resolves.
    for (const node of bundle.hierarchy) {
      if (node.parentId !== null) expect(nodeIds.has(node.parentId)).toBe(true);
    }
    // Semantic browse nodes exist (ChatGPT ragged hierarchy).
    for (const id of ['dog', 'cat', 'fish', 'pet-health-wellness', 'dog-food', 'cat-food', 'wild-bird']) {
      expect(nodeIds.has(id)).toBe(true);
    }
  });
});

// ─── Negative cases (temp copies) ───────────────────────────────────────────────

describe('negative cases (temp copies)', () => {
  it('rejects a duplicate node id', () => {
    const dir = freshCopy();
    const hierarchy = readJson(dir, 'hierarchy.json');
    const first = hierarchy.entries[0];
    hierarchy.entries.push({ ...first, id: first.id });
    writeJson(dir, 'hierarchy.json', hierarchy);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'duplicate_node_id');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a node whose parentId references a nonexistent node', () => {
    const dir = freshCopy();
    const hierarchy = readJson(dir, 'hierarchy.json');
    const leaf = hierarchy.entries.find((e: any) => e.classifiable);
    leaf.parentId = 'nonexistent-node';
    writeJson(dir, 'hierarchy.json', hierarchy);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'unknown_parent_node');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a self-parent cycle', () => {
    const dir = freshCopy();
    const hierarchy = readJson(dir, 'hierarchy.json');
    const leaf = hierarchy.entries.find((e: any) => e.classifiable);
    leaf.parentId = leaf.id;
    writeJson(dir, 'hierarchy.json', hierarchy);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'self_parent_node');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a two-node cycle that makes nodes unreachable from roots', () => {
    const dir = freshCopy();
    const hierarchy = readJson(dir, 'hierarchy.json');
    const entries = hierarchy.entries as Array<{ id: string; parentId: string | null }>;
    // Reparent a leaf under another leaf to create a cycle pair.
    const leaves = entries.filter((e: any) => e.classifiable);
    const a = leaves[0];
    const b = leaves[1];
    a.parentId = b.id;
    b.parentId = a.id;
    writeJson(dir, 'hierarchy.json', hierarchy);
    const report = validateTaxonomyReleaseV4(dir);
    // Both nodes become unreachable from the roots → cycle detected.
    expect(findingCodes(report).some(c => c === 'hierarchy_cycle_or_unreachable')).toBe(true);
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a classifiable node with a missing facetProfileId', () => {
    const dir = freshCopy();
    const hierarchy = readJson(dir, 'hierarchy.json');
    const leaf = hierarchy.entries.find((e: any) => e.classifiable);
    leaf.facetProfileId = null;
    writeJson(dir, 'hierarchy.json', hierarchy);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'classifiable_node_missing_profile');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a descendant scope that contradicts its ancestor', () => {
    const dir = freshCopy();
    const hierarchy = readJson(dir, 'hierarchy.json');
    const dogLeaf = hierarchy.entries.find((e: any) => e.id === 'dog-food-dry');
    dogLeaf.scope = { animalDomain: 'cat' };
    writeJson(dir, 'hierarchy.json', hierarchy);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'scope_conflict');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a facet profile referencing an unknown attribute', () => {
    const dir = freshCopy();
    const profiles = readJson(dir, 'facet-profiles.json');
    // Push a schema-valid attribute entry with an unknown attributeId (clone
    // the first attribute so the pushed object passes the strict schema).
    const template = profiles.entries[0].attributes[0];
    profiles.entries[0].attributes.push({ ...template, attributeId: 'does-not-exist' });
    writeJson(dir, 'facet-profiles.json', profiles);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'facet_profile_unknown_attribute');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a duplicate attribute inside one facet profile', () => {
    const dir = freshCopy();
    const profiles = readJson(dir, 'facet-profiles.json');
    const profile = profiles.entries[0];
    const firstAttr = profile.attributes[0];
    profile.attributes.push({ ...firstAttr });
    writeJson(dir, 'facet-profiles.json', profiles);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'facet_profile_duplicate_attribute');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects two canonical_leaf pages sharing a nodeId', () => {
    const dir = freshCopy();
    const projection = readJson(dir, 'shopsite-projection.json');
    const leafPage = projection.entries.find((e: any) => e.role === 'canonical_leaf');
    const anotherLeaf = projection.entries.find((e: any) => e.role === 'canonical_leaf' && e.pageName !== leafPage.pageName);
    anotherLeaf.nodeId = leafPage.nodeId;
    writeJson(dir, 'shopsite-projection.json', projection);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'duplicate_canonical_node_page');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a canonical_leaf page whose nodeId is not classifiable', () => {
    const dir = freshCopy();
    const projection = readJson(dir, 'shopsite-projection.json');
    const leafPage = projection.entries.find((e: any) => e.role === 'canonical_leaf');
    // Repoint at the first root (a department root, non-classifiable).
    const hierarchy = readJson(dir, 'hierarchy.json');
    const root = hierarchy.entries.find((e: any) => e.parentId === null);
    leafPage.nodeId = root.id;
    writeJson(dir, 'shopsite-projection.json', projection);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'canonical_leaf_node_not_classifiable');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects an unresolved needs_review page projection', () => {
    const dir = freshCopy();
    const projection = readJson(dir, 'shopsite-projection.json');
    const page = projection.entries[0];
    page.role = 'needs_review';
    page.nodeId = null;
    page.facetProfileId = null;
    writeJson(dir, 'shopsite-projection.json', projection);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'page_projection_needs_review');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a manifest count mismatch', () => {
    const dir = freshCopy();
    const manifest = readJson(dir, 'manifest.json');
    manifest.counts.nodes = manifest.counts.nodes + 1;
    writeJson(dir, 'manifest.json', manifest);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'manifest_count_mismatch');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a manifest file-hash mismatch', () => {
    const dir = freshCopy();
    const manifest = readJson(dir, 'manifest.json');
    manifest.fileVersions['hierarchy.json'] = '0'.repeat(64);
    writeJson(dir, 'manifest.json', manifest);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'manifest_hash_mismatch');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a releaseId that does not match the directory basename', () => {
    const dir = freshCopy();
    const manifest = readJson(dir, 'manifest.json');
    manifest.releaseId = 'not-bay-state-v4';
    writeJson(dir, 'manifest.json', manifest);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'release_id_mismatch');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a v3 type absent from leaf legacyTypeIds (bijection break)', () => {
    const dir = freshCopy();
    const hierarchy = readJson(dir, 'hierarchy.json');
    const leaf = hierarchy.entries.find((e: any) => e.classifiable && e.legacyTypeIds.length > 0);
    leaf.legacyTypeIds = [];
    writeJson(dir, 'hierarchy.json', hierarchy);
    const report = validateTaxonomyReleaseV4(dir);
    expect(findingCodes(report).some(c => c === 'leaf_node_no_legacy_type' || c === 'leaf_type_missing')).toBe(true);
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('throws ReleaseValidationError with code release_invalid on load', () => {
    const dir = freshCopy();
    const manifest = readJson(dir, 'manifest.json');
    manifest.counts.pages = 999;
    writeJson(dir, 'manifest.json', manifest);
    try {
      loadTaxonomyReleaseV4(dir);
      throw new Error('expected loadTaxonomyReleaseV4 to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ReleaseValidationError);
      expect((err as ReleaseValidationError).code).toBe('release_invalid');
    }
  });

  // ── Profile behavioral-equivalence + provenance (ChatGPT v4 review #12/#13) ──

  it('all profile_map entries are behaviorally equivalent with matching fingerprints', () => {
    const bundle = loadTaxonomyReleaseV4(RELEASE_ID);
    const profileMaps = bundle.legacyMappings.filter(m => m.kind === 'profile_map');
    expect(profileMaps.length).toBe(73);
    for (const m of profileMaps) {
      if (m.kind !== 'profile_map') continue;
      expect(m.equivalent).toBe(true);
      expect(m.v3Fingerprint).toBe(m.v4Fingerprint);
      const target = bundle.facetProfiles.find(p => p.id === m.v4ProfileId);
      expect(target).toBeDefined();
      expect(target!.behaviorFingerprint).toBe(m.v4Fingerprint);
      expect(target!.sourceV3ProfileIds).toContain(m.v3ProfileId);
    }
  });

  it('every facet profile has provenance and its canonicalNodeIds match the hierarchy', () => {
    const bundle = loadTaxonomyReleaseV4(RELEASE_ID);
    for (const profile of bundle.facetProfiles) {
      expect(profile.sourceV3ProfileIds.length).toBeGreaterThan(0);
      expect(profile.behaviorFingerprint.length).toBeGreaterThanOrEqual(8);
      const actualLeaves = bundle.hierarchy.filter(n => n.classifiable && n.facetProfileId === profile.id).map(n => n.id).sort();
      expect([...profile.canonicalNodeIds].sort()).toEqual(actualLeaves);
    }
  });

  it('reports shared-profile blast radii for profiles with >1 consuming node', () => {
    const report = validateTaxonomyReleaseV4(RELEASE_ID);
    expect(report.profileBlastRadii.length).toBeGreaterThan(0);
    for (const radius of report.profileBlastRadii) {
      expect(radius.nodeCount).toBe(radius.nodeIds.length);
      expect(radius.nodeCount).toBeGreaterThan(1);
      expect(bundleProfileExists(radius.profileId)).toBe(true);
    }
  });

  it('rejects a profile_map whose fingerprints differ (behavioral mismatch)', () => {
    const dir = freshCopy();
    const legacy = readJson(dir, 'legacy-mappings.json');
    const map = legacy.entries.find((e: any) => e.kind === 'profile_map');
    map.v4Fingerprint = 'f'.repeat(24);
    writeJson(dir, 'legacy-mappings.json', legacy);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'profile_behavior_mismatch');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects self-consistent but independently incorrect profile fingerprints', () => {
    const dir = freshCopy();
    const legacy = readJson(dir, 'legacy-mappings.json');
    const profiles = readJson(dir, 'facet-profiles.json');
    const map = legacy.entries.find((e: any) => e.kind === 'profile_map');
    const target = profiles.entries.find((e: any) => e.id === map.v4ProfileId);
    const bogus = 'b'.repeat(24);
    map.v3Fingerprint = bogus;
    map.v4Fingerprint = bogus;
    target.behaviorFingerprint = bogus;
    writeJson(dir, 'legacy-mappings.json', legacy);
    writeJson(dir, 'facet-profiles.json', profiles);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'profile_v3_fingerprint_untrusted');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a profile whose recorded canonicalNodeIds drift from the hierarchy', () => {
    const dir = freshCopy();
    const profiles = readJson(dir, 'facet-profiles.json');
    const profile = profiles.entries.find((e: any) => e.canonicalNodeIds.length > 0);
    profile.canonicalNodeIds = ['nonexistent-leaf'];
    writeJson(dir, 'facet-profiles.json', profiles);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'profile_node_ids_mismatch');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a shared profile missing provenance', () => {
    const dir = freshCopy();
    const profiles = readJson(dir, 'facet-profiles.json');
    profiles.entries[0].sourceV3ProfileIds = [];
    writeJson(dir, 'facet-profiles.json', profiles);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'profile_missing_provenance');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a controlled attribute with duplicate allowed values', () => {
    const dir = freshCopy();
    const attrs = readJson(dir, 'attributes.json');
    const foodForm = attrs.entries.find((a: any) => a.id === 'food-form');
    foodForm.allowedValues.push(foodForm.allowedValues[0]);
    writeJson(dir, 'attributes.json', attrs);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'duplicate_allowed_value');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a controlled attribute with an unresolved value alias', () => {
    const dir = freshCopy();
    const attrs = readJson(dir, 'attributes.json');
    const foodForm = attrs.entries.find((a: any) => a.id === 'food-form');
    foodForm.valueAliases.push({ alias: 'bogus', mapsTo: 'UnknownForm' });
    writeJson(dir, 'attributes.json', attrs);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'unresolved_value_alias');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects a measured attribute missing canonicalUnit', () => {
    const dir = freshCopy();
    const attrs = readJson(dir, 'attributes.json');
    const weight = attrs.entries.find((a: any) => a.valueMode === 'measured');
    if (weight) {
      weight.canonicalUnit = '';
      writeJson(dir, 'attributes.json', attrs);
      const report = validateTaxonomyReleaseV4(dir);
      expectFinding(report, 'measured_attribute_missing_unit');
      expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
    }
  });

  it('rejects guidance with an unknown product type ref', () => {
    const dir = freshCopy();
    const g = readJson(dir, 'guidance.json');
    g.entries.push({
      id: 'bad-guidance-ref',
      scope: 'productType',
      scopeId: 'dog-food-dry',
      structured: { productTypeIds: ['nonexistent-node-id'] },
      freeForm: null,
      manualReviewRequirement: false,
    });
    writeJson(dir, 'guidance.json', g);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'guidance_unknown_type_ref');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });

  it('rejects inconsistent envelope origins across focused files', () => {
    const dir = freshCopy();
    const attrs = readJson(dir, 'attributes.json');
    attrs.bundleOrigin.releaseId = 'other-release-id';
    writeJson(dir, 'attributes.json', attrs);
    const report = validateTaxonomyReleaseV4(dir);
    expectFinding(report, 'inconsistent_release_origin');
    expect(() => loadTaxonomyReleaseV4(dir)).toThrow(ReleaseValidationError);
  });
});
