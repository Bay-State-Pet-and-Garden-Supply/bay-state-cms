/**
 * bay-state-v7 release tests — scoped species multi-value via dedicated facets.
 *
 * Owner approval covers EXACTLY the compiled profile-supplements +
 * profile-grooming species entries. v7 therefore clones (not edits) the two
 * shared facets and rebinds ONLY the supplements/grooming type nodes, so the
 * compiled before/after proves EXACTLY two profiles changed and the other 72
 * are byte-identical. Supersedes the rejected v6 candidate (untouched).
 *
 * No DB, no activation, no model calls — pure file + compile assertions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyChangeSetToFiles,
  authorCandidateRelease,
} from '../../classification/release-authoring';
import {
  assertReleaseValidV5,
  detectReleaseGeneration,
  loadTaxonomyReleaseV5,
} from '../../classification/release-validation';
import { compileTaxonomyReleaseV5 } from '../../classification/release-compiler';

const REAL_RELEASES_ROOT = path.resolve(__dirname, '../../classification/releases');
const V5_DIR = path.join(REAL_RELEASES_ROOT, 'bay-state-v5');
const V7_DIR = path.join(REAL_RELEASES_ROOT, 'bay-state-v7');

function readJson(dir: string, fileName: string): any {
  return JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8'));
}

function normalizeOrigin(text: string): string {
  return text
    .replace(/"releaseId": "[^"]+"/g, '"releaseId": "X"')
    .replace(/"createdAt": "[^"]+"/g, '"createdAt": "Y"');
}

describe('bay-state-v7 — scoped species multi-value release', () => {
  it('v7 exists with V5-generation manifest provenance off the v5 baseline', () => {
    const manifest = readJson(V7_DIR, 'manifest.json');
    expect(manifest.releaseId).toBe('bay-state-v7');
    expect(manifest.revision).toBe('bay-state-v7');
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.compatibilityVersion).toBe(3);
    expect(manifest.lifecycle).toBe('release');
    expect(manifest.sourceBaseline).toBe('bay-state-v5');
    expect(manifest.counts).toEqual({ ...readJson(V5_DIR, 'manifest.json').counts, facetProfiles: 11 });
    expect(detectReleaseGeneration('bay-state-v7')).toBe('v5');
  });

  it('manifest fileVersions match the sha256 of the exact v7 file bytes', () => {
    const manifest = readJson(V7_DIR, 'manifest.json');
    for (const [fileName, hash] of Object.entries(manifest.fileVersions as Record<string, string>)) {
      const text = fs.readFileSync(path.join(V7_DIR, fileName), 'utf8');
      expect(crypto.createHash('sha256').update(text, 'utf8').digest('hex')).toBe(hash);
    }
  });

  it('adds EXACTLY two dedicated facets cloned with only species multiple', () => {
    const v5 = readJson(V5_DIR, 'facet-profiles.json');
    const v7 = readJson(V7_DIR, 'facet-profiles.json');
    const v5Ids = v5.entries.map((p: any) => p.id).sort();
    const v7Ids = v7.entries.map((p: any) => p.id).sort();
    expect(v7Ids.filter((id: string) => !v5Ids.includes(id)).sort()).toEqual([
      'profile-accessories-grooming',
      'profile-pet-food-supplements',
    ]);
    const clones: Array<[string, string, string]> = [
      ['profile-pet-food-supplements', 'profile-pet-food', 'supplements-profile'],
      ['profile-accessories-grooming', 'profile-accessories', 'grooming-profile'],
    ];
    for (const [cloneId, sourceId, v3Id] of clones) {
      const source = v5.entries.find((p: any) => p.id === sourceId);
      const clone = v7.entries.find((p: any) => p.id === cloneId);
      expect(clone.name).toContain(source.name);
      expect(clone.sourceV3ProfileIds).toEqual([v3Id]);
      expect(clone.attributes.length).toBe(source.attributes.length);
      for (const s of source.attributes) {
        const c = clone.attributes.find((a: any) => a.attributeId === s.attributeId);
        if (s.attributeId === 'species') {
          expect(s.cardinality).toBe('single');
          expect(c.cardinality).toBe('multiple');
          expect({ ...c, cardinality: 'x' }).toEqual({ ...s, cardinality: 'x' });
        } else {
          expect(c).toEqual(s);
        }
      }
    }
  });

  it('shared source facets keep behavior; only the moved nodes leave canonicalNodeIds', () => {
    const v5 = readJson(V5_DIR, 'facet-profiles.json');
    const v7 = readJson(V7_DIR, 'facet-profiles.json');
    const moves: Array<[string, string]> = [
      ['profile-pet-food', 'supplements'],
      ['profile-accessories', 'grooming'],
    ];
    for (const [profileId, movedNode] of moves) {
      const before = v5.entries.find((p: any) => p.id === profileId);
      const after = v7.entries.find((p: any) => p.id === profileId);
      expect(after.attributes).toEqual(before.attributes);
      expect(after.behaviorFingerprint).toBe(before.behaviorFingerprint);
      expect(after.sourceV3ProfileIds).toEqual(before.sourceV3ProfileIds);
      expect(after.canonicalNodeIds).toEqual(before.canonicalNodeIds.filter((n: string) => n !== movedNode));
    }
    // Dedicated facets each back exactly their single rebound node.
    expect(v7.entries.find((p: any) => p.id === 'profile-pet-food-supplements').canonicalNodeIds)
      .toEqual(['supplements']);
    expect(v7.entries.find((p: any) => p.id === 'profile-accessories-grooming').canonicalNodeIds)
      .toEqual(['grooming']);
  });

  it('hierarchy rebinds ONLY the two type nodes; every invariant byte-identical', () => {
    const v5 = readJson(V5_DIR, 'hierarchy.json');
    const v7 = readJson(V7_DIR, 'hierarchy.json');
    expect(v7.entries.length).toBe(v5.entries.length);
    const changed: string[] = [];
    for (const n5 of v5.entries) {
      const n6 = v7.entries.find((n: any) => n.id === n5.id);
      expect(n6.invariantAttributes).toEqual(n5.invariantAttributes);
      if (JSON.stringify(n6) !== JSON.stringify(n5)) {
        changed.push(`${n5.id}: ${n5.facetProfileId}->${n6.facetProfileId}`);
      }
    }
    expect(changed.sort()).toEqual([
      'grooming: profile-accessories->profile-accessories-grooming',
      'supplements: profile-pet-food->profile-pet-food-supplements',
    ]);
  });

  it('all non-focused release files are byte-identical modulo origin rebinding', () => {
    for (const fileName of [
      'attributes.json',
      'export-mappings.json',
      'legacy-mappings.json',
      'guidance.json',
      'page-assignment-policy.json',
      'shopsite-projection.json',
    ]) {
      expect(normalizeOrigin(fs.readFileSync(path.join(V7_DIR, fileName), 'utf8')))
        .toBe(normalizeOrigin(fs.readFileSync(path.join(V5_DIR, fileName), 'utf8')));
    }
  });

  it('v7 passes the V5 validation gate with zero errors', () => {
    const report = assertReleaseValidV5('bay-state-v7');
    expect(report.findings.filter(f => f.severity === 'error')).toEqual([]);
  });

  it('compiled v5->v7: EXACTLY profile-supplements + profile-grooming species change; other 72 identical', () => {
    const before = compileTaxonomyReleaseV5(loadTaxonomyReleaseV5('bay-state-v5'));
    const after = compileTaxonomyReleaseV5(loadTaxonomyReleaseV5('bay-state-v7'));
    expect(after.taxonomyRevision).toBe('bay-state-v7');
    expect(after.attributeProfiles.length).toBe(74);
    const changed: string[] = [];
    for (const p of before.attributeProfiles) {
      const q = after.attributeProfiles.find(x => x.id === p.id);
      expect(q).toBeDefined();
      if (JSON.stringify(p) !== JSON.stringify(q)) {
        const diffAttrs = p.attributes.filter((a, i) => JSON.stringify(a) !== JSON.stringify(q!.attributes[i]));
        changed.push(`${p.id}: [${diffAttrs.map(a => a.attributeId)}] ${p.attributes.find(a => a.attributeId === 'species')?.cardinality}->${q!.attributes.find(a => a.attributeId === 'species')?.cardinality}`);
      }
    }
    expect(changed.sort()).toEqual([
      'profile-grooming: [species] single->multiple',
      'profile-supplements: [species] single->multiple',
    ]);
  });

  it('rejected v6 proposal is archived outside release discovery (never activatable)', () => {
    expect(fs.existsSync(path.join(REAL_RELEASES_ROOT, 'bay-state-v6'))).toBe(false);
    expect(readJson(path.resolve(__dirname, '../../../docs/audits/rejected-taxonomy-v6/bay-state-v6'), 'manifest.json').releaseId)
      .toBe('bay-state-v6');
    const result = authorCandidateRelease('bay-state-v5', { newReleaseId: 'bay-state-v7' });
    expect(result.ok).toBe(false);
  });
});

describe('release authoring — facet-split ops', () => {
  function readV5SourceFiles(): Record<string, unknown> {
    const files: Record<string, unknown> = {};
    for (const fileName of ['facet-profiles.json', 'hierarchy.json', 'attributes.json']) {
      files[fileName] = JSON.parse(fs.readFileSync(path.join(V5_DIR, fileName), 'utf8'));
    }
    return files;
  }

  const split = {
    newReleaseId: 'split-check',
    facetProfileAdds: [{
      profileId: 'profile-pet-food-x',
      cloneFromProfileId: 'profile-pet-food',
      sourceV3ProfileIds: ['supplements-profile'],
      cardinalityPatches: [{ attributeId: 'species', cardinality: 'multiple' as const }],
    }],
    typeFacetRebindings: [{ nodeId: 'supplements', facetProfileId: 'profile-pet-food-x' }],
  };

  it('clones a facet with overrides and rebinds the node with provenance upkeep', () => {
    const out = applyChangeSetToFiles(readV5SourceFiles(), split);
    const profiles = JSON.parse(out['facet-profiles.json']).entries;
    expect(profiles.length).toBe(10);
    const clone = profiles.find((p: any) => p.id === 'profile-pet-food-x');
    expect(clone.canonicalNodeIds).toEqual(['supplements']);
    expect(clone.attributes.find((a: any) => a.attributeId === 'species').cardinality).toBe('multiple');
    const donor = profiles.find((p: any) => p.id === 'profile-pet-food');
    expect(donor.canonicalNodeIds).not.toContain('supplements');
    expect(donor.attributes.find((a: any) => a.attributeId === 'species').cardinality).toBe('single');
    const nodes = JSON.parse(out['hierarchy.json']).entries;
    expect(nodes.find((n: any) => n.id === 'supplements').facetProfileId).toBe('profile-pet-food-x');
  });

  it('refuses duplicate ids, unknown sources, empty provenance, and bad rebinds', () => {
    const source = readV5SourceFiles();
    const badAdds = [
      { ...split.facetProfileAdds[0], profileId: 'profile-pet-food' },
      { ...split.facetProfileAdds[0], profileId: 'x-new', cloneFromProfileId: 'nope' },
      { ...split.facetProfileAdds[0], profileId: 'x-new', sourceV3ProfileIds: [] },
      { ...split.facetProfileAdds[0], profileId: 'Not_Kebab' },
    ];
    for (const add of badAdds) {
      expect(() => applyChangeSetToFiles(source, { newReleaseId: 'x', facetProfileAdds: [add as any] })).toThrow();
    }
    const badRebinds = [
      { nodeId: 'nope', facetProfileId: 'profile-pet-food' },
      { nodeId: 'supplements', facetProfileId: 'nope' },
      { nodeId: 'supplements', facetProfileId: 'profile-pet-food' },
      { nodeId: 'pet-supplies', facetProfileId: 'profile-pet-food' },
    ];
    for (const rebind of badRebinds) {
      expect(() => applyChangeSetToFiles(source, { newReleaseId: 'x', typeFacetRebindings: [rebind] })).toThrow();
    }
  });
});

describe('release authoring — V5 facet-split end-to-end against a temp root', () => {
  let tempRoot = '';

  beforeAll(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-v7-test-'));
    for (const releaseId of ['bay-state-v5', 'bay-state-v3']) {
      fs.cpSync(path.join(REAL_RELEASES_ROOT, releaseId), path.join(tempRoot, releaseId), { recursive: true });
    }
  });

  afterAll(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it('authors a V5-generation facet-split candidate through the V5 gate', () => {
    const result = authorCandidateRelease('bay-state-v5', {
      newReleaseId: 'e2e-v7-probe',
      createdAtOverride: '2026-10-04T12:00:00.000Z',
      facetProfileAdds: [{
        profileId: 'profile-pet-food-x',
        cloneFromProfileId: 'profile-pet-food',
        sourceV3ProfileIds: ['supplements-profile'],
        cardinalityPatches: [{ attributeId: 'species', cardinality: 'multiple' }],
      }],
      typeFacetRebindings: [{ nodeId: 'supplements', facetProfileId: 'profile-pet-food-x' }],
    }, { releasesRootOverride: tempRoot });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => assertReleaseValidV5(result.candidateDir)).not.toThrow();
    fs.rmSync(result.candidateDir, { recursive: true, force: true });
  });
});

describe('release generation detection — no exact-name checks', () => {
  it('resolves v3/v4/v5-descendant generations', () => {
    expect(detectReleaseGeneration('bay-state-v3')).toBe('legacy');
    expect(detectReleaseGeneration('bay-state-v4')).toBe('v4');
    expect(detectReleaseGeneration('bay-state-v5')).toBe('v5');
    expect(detectReleaseGeneration('bay-state-v7')).toBe('v5');
    expect(detectReleaseGeneration(path.resolve(__dirname, '../../../docs/audits/rejected-taxonomy-v6/bay-state-v6')))
      .toBe('v5');
  });

  it('dispatches a schema-3 V5 child lacking invariant fields via sourceBaseline (not self-schema v4)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gen-lineage-'));
    try {
      const child = path.join(root, 'lineage-child');
      fs.mkdirSync(child, { recursive: true });
      fs.writeFileSync(path.join(child, 'manifest.json'), JSON.stringify({
        releaseId: 'lineage-child',
        revision: 'lineage-child',
        schemaVersion: 3,
        sourceBaseline: 'bay-state-v5',
      }));
      // Hierarchy WITHOUT explicit invariantAttributes keys.
      fs.writeFileSync(path.join(child, 'hierarchy.json'), JSON.stringify({ entries: [{ id: 'x' }] }));
      expect(detectReleaseGeneration(child)).toBe('v5');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps schema-3 v4 lineage at v4 and fails closed on cycles/unreadable lineage', () => {
    expect(detectReleaseGeneration('bay-state-v4')).toBe('v4');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gen-broken-'));
    try {
      // Self-referential baseline cycle with schemaVersion 3: must NOT widen to v5.
      const cycle = path.join(root, 'cycle-probe');
      fs.mkdirSync(cycle, { recursive: true });
      fs.writeFileSync(path.join(cycle, 'manifest.json'), JSON.stringify({
        releaseId: 'cycle-probe',
        revision: 'cycle-probe',
        schemaVersion: 3,
        sourceBaseline: 'cycle-probe',
      }));
      expect(detectReleaseGeneration(cycle)).not.toBe('v5');
      // Dangling baseline with no readable files: legacy, never v5/v4 widening.
      const dangling = path.join(root, 'dangling-probe');
      fs.mkdirSync(dangling, { recursive: true });
      fs.writeFileSync(path.join(dangling, 'manifest.json'), JSON.stringify({
        releaseId: 'dangling-probe',
        sourceBaseline: 'no-such-release-anywhere',
      }));
      expect(detectReleaseGeneration(dangling)).toBe('legacy');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    expect(detectReleaseGeneration('no-such-release-anywhere')).toBe('legacy');
  });
});
