/**
 * bay-state-v10 release tests — P1 #8 new native types + P1 #10 size retirement.
 *
 * v10 (sourceBaseline bay-state-v9) makes exactly the approved changes:
 *  - five new type_native leaves with empty legacyTypeIds: dog/cat
 *    freeze-dried raw (profile-pet-food, species + Freeze-Dried Raw
 *    invariants), milk-replacer (profile-pet-food, no forced species/form),
 *    aquarium-equipment (profile-accessories, Fish), catnip-loose
 *    (profile-accessories, Cat). No human-food leaf, no landscaping-mulch
 *    node — mulch stays the existing potting-soil type.
 *  - size retirement: breed-size + size to not_exported, PF19/PF27 mappings
 *    removed, all facet memberships revoked (attributes survive; existing
 *    live/workspace values untouched; core.weight independent).
 *
 * No DB, no activation, no model calls — pure file + compile assertions.
 * Engine-correctness fixtures stay release-agnostic (see agent handoff);
 * this file owns the v10 pin-shape proof.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { assertReleaseValidV5, detectReleaseGeneration, loadTaxonomyReleaseV5 } from '../../classification/release-validation';
import { compileTaxonomyReleaseV5, type CompiledReleaseBundle } from '../../classification/release-compiler';
import { validateClassificationConfigBundle } from '../../classification/config-validation';
import type { ReleaseValidationFinding } from '../../classification/release-validation';

const REAL_RELEASES_ROOT = path.resolve(__dirname, '../../classification/releases');
const V10_DIR = path.join(REAL_RELEASES_ROOT, 'bay-state-v10');

const V10: CompiledReleaseBundle = compileTaxonomyReleaseV5(loadTaxonomyReleaseV5('bay-state-v10'));
const V9: CompiledReleaseBundle = compileTaxonomyReleaseV5(loadTaxonomyReleaseV5('bay-state-v9'));

const NEW_NATIVE_LEAVES = [
  'dog-food-freeze-dried-raw',
  'cat-food-freeze-dried-raw',
  'milk-replacer',
  'aquarium-equipment',
  'catnip-loose',
] as const;

/** Minimal structural view of a hierarchy file entry (parsed JSON). */
interface HierarchyNodeJson {
  id: string;
  label?: string;
  parentId?: string | null;
  classifiable?: boolean;
  facetProfileId?: string | null;
  departmentId?: string;
  legacyTypeIds?: string[];
  derivation?: string;
  scope?: { animalDomain?: string } | null;
  description?: string | null;
  invariantAttributes?: Record<string, string | string[]>;
}

function readHierarchyNodes(dir: string): HierarchyNodeJson[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'hierarchy.json'), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('entries' in parsed)) {
    throw new Error('hierarchy.json has no entries array');
  }
  const entries: unknown = parsed.entries;
  if (!Array.isArray(entries)) throw new Error('hierarchy.json has no entries array');
  return entries.filter(
    (e: unknown): e is HierarchyNodeJson =>
      typeof e === 'object' && e !== null && 'id' in e && typeof e.id === 'string',
  );
}

function readProfiles(dir: string): Array<{ id: string; canonicalNodeIds: string[] }> {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'facet-profiles.json'), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('entries' in parsed)) {
    throw new Error('facet-profiles.json has no entries array');
  }
  const entries: unknown = parsed.entries;
  if (!Array.isArray(entries)) throw new Error('facet-profiles.json has no entries array');
  const out: Array<{ id: string; canonicalNodeIds: string[] }> = [];
  for (const e of entries) {
    if (typeof e !== 'object' || e === null || !('id' in e) || !('canonicalNodeIds' in e)) continue;
    if (typeof e.id !== 'string' || !Array.isArray(e.canonicalNodeIds)) continue;
    if (!e.canonicalNodeIds.every((id: unknown): id is string => typeof id === 'string')) continue;
    out.push({ id: e.id, canonicalNodeIds: e.canonicalNodeIds });
  }
  return out;
}

describe('bay-state-v10 — new native types + size retirement', () => {
  it('exists with V5-generation manifest provenance off the v9 baseline', () => {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(V10_DIR, 'manifest.json'), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || !('counts' in parsed) || !('releaseId' in parsed) || !('sourceBaseline' in parsed)) {
      throw new Error('manifest.json is missing release fields');
    }
    const counts: unknown = parsed.counts;
    if (typeof counts !== 'object' || counts === null || !('nodes' in counts) || !('types' in counts) || !('nativeLeaves' in counts) || !('mappings' in counts)) {
      throw new Error('manifest.json has no counts object');
    }
    expect(parsed.releaseId).toBe('bay-state-v10');
    expect(parsed.sourceBaseline).toBe('bay-state-v9');
    expect(counts.nodes).toBe(96);
    expect(counts.types).toBe(79);
    expect(counts.nativeLeaves).toBe(6);
    expect(counts.mappings).toBe(13);
    expect(detectReleaseGeneration('bay-state-v10')).toBe('v5');
  });

  it('passes the V5 release gate with zero errors', () => {
    const report = assertReleaseValidV5('bay-state-v10');
    expect(report.findings.filter((f: ReleaseValidationFinding) => f.severity === 'error')).toEqual([]);
  });

  it('adds the five new native leaves with empty legacyTypeIds', () => {
    const nodes = readHierarchyNodes(V10_DIR);
    const byId: Record<string, HierarchyNodeJson> = {};
    for (const n of nodes) byId[n.id] = n;
    for (const id of NEW_NATIVE_LEAVES) {
      const node = byId[id];
      expect(node, id).toBeTruthy();
      expect(node.classifiable).toBe(true);
      expect(node.derivation).toBe('type_native');
      expect(node.legacyTypeIds).toEqual([]);
    }
    // Parents, facets, scopes, invariants per the approved shape.
    expect(byId['dog-food-freeze-dried-raw']).toMatchObject({
      parentId: 'dog-food', departmentId: 'pet-supplies', facetProfileId: 'profile-pet-food',
      scope: { animalDomain: 'dog' },
      invariantAttributes: { species: 'Dog', 'food-form': 'Freeze-Dried Raw' },
    });
    expect(byId['cat-food-freeze-dried-raw']).toMatchObject({
      parentId: 'cat-food', departmentId: 'pet-supplies', facetProfileId: 'profile-pet-food',
      scope: { animalDomain: 'cat' },
      invariantAttributes: { species: 'Cat', 'food-form': 'Freeze-Dried Raw' },
    });
    expect(byId['milk-replacer']).toMatchObject({
      parentId: 'pet-supplies', departmentId: 'pet-supplies', facetProfileId: 'profile-pet-food',
      invariantAttributes: {},
    });
    expect(byId['aquarium-equipment']).toMatchObject({
      parentId: 'fish', departmentId: 'pet-supplies', facetProfileId: 'profile-accessories',
      scope: { animalDomain: 'fish' },
      invariantAttributes: { species: 'Fish' },
    });
    expect(byId['catnip-loose']).toMatchObject({
      parentId: 'cat', departmentId: 'pet-supplies', facetProfileId: 'profile-accessories',
      scope: { animalDomain: 'cat' },
      invariantAttributes: { species: 'Cat' },
    });
    // Facet provenance: new leaves join their profiles' canonicalNodeIds.
    const profiles: Record<string, string[]> = {};
    for (const p of readProfiles(V10_DIR)) profiles[p.id] = p.canonicalNodeIds;
    expect(profiles['profile-pet-food']).toContain('dog-food-freeze-dried-raw');
    expect(profiles['profile-pet-food']).toContain('cat-food-freeze-dried-raw');
    expect(profiles['profile-pet-food']).toContain('milk-replacer');
    expect(profiles['profile-accessories']).toContain('aquarium-equipment');
    expect(profiles['profile-accessories']).toContain('catnip-loose');
  });

  it('adds no human-food leaf and no landscaping-mulch node; mulch stays potting-soil', () => {
    const ids = readHierarchyNodes(V10_DIR).map(n => n.id);
    expect(ids).not.toContain('landscaping-mulch');
    expect(ids.filter(id => /human/.test(id))).toEqual([]);
    expect(V10.productTypes.some(t => t.id === 'potting-soil')).toBe(true);
  });

  it('exposes the new leaves as compiled classifiable types with correct invariants', () => {
    for (const id of NEW_NATIVE_LEAVES) {
      expect(V10.productTypes.some(t => t.id === id), id).toBe(true);
    }
    // Freeze-dried invariants must not collapse onto dry-food invariants.
    const dry = V10.productTypes.find(t => t.id === 'dog-food-dry');
    const raw = V10.productTypes.find(t => t.id === 'dog-food-freeze-dried-raw');
    expect(JSON.stringify(raw)).not.toContain('"Dry Food"');
    expect(JSON.stringify(raw)).toContain('Freeze-Dried Raw');
    expect(JSON.stringify(dry)).toContain('Dry Food');
  });

  it('retires breed-size and size: not_exported, unmapped, profile-less, target-less', () => {
    for (const attrId of ['breed-size', 'size']) {
      const attr = V10.attributes.find(a => a.id === attrId);
      expect(attr, attrId).toBeTruthy();
      expect(attr?.exportDisposition).toEqual({ kind: 'not_exported' });
      expect(V10.attributeMappings.map(m => m.attributeId)).not.toContain(attrId);
      expect(V10.curationTargets.map(t => t.attributeId)).not.toContain(attrId);
    }
    const memberships = V10.attributeProfiles.flatMap(
      (p) => p.attributes as unknown as Array<{ attributeId?: unknown }>,
    ).map(m => m.attributeId);
    expect(memberships).not.toContain('breed-size');
    expect(memberships).not.toContain('size');
  });

  it('rejects old-run size writes: v9-era PF19/PF27 proposals have no mapping authority in v10', () => {
    const v10Fields = new Set(V10.attributeMappings.map(m => m.catalogField));
    expect(v10Fields.has('ProductField19')).toBe(false);
    expect(v10Fields.has('ProductField27')).toBe(false);
    // v9 did map them (guard against a test that passes vacuously).
    const v9Fields = new Set(V9.attributeMappings.map(m => m.catalogField));
    expect(v9Fields.has('ProductField19')).toBe(true);
    expect(v9Fields.has('ProductField27')).toBe(true);
  });

  it('keeps v9 interpretable: v9 still validates and its size mappings survive there', () => {
    const report = assertReleaseValidV5('bay-state-v9');
    expect(report.findings.filter((f: ReleaseValidationFinding) => f.severity === 'error')).toEqual([]);
    expect(V9.attributeMappings.map(m => m.attributeId)).toContain('breed-size');
    expect(V9.attributeMappings.map(m => m.attributeId)).toContain('size');
  });

  it('compiles to a coherent bundle under the strict config contract', () => {
    const report = validateClassificationConfigBundle(V10, { mode: 'preview' });
    const codes = report.findings.map((f: ReleaseValidationFinding) => f.code);
    expect(codes).not.toContain('serialization_cardinality_mismatch');
    expect(codes).not.toContain('target_cardinality_conflict');
  });
});
