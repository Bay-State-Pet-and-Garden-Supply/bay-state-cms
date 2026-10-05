/**
 * bay-state-v6 — REJECTED candidate, archived proposal.
 *
 * v6 flipped species single->multiple on the two SHARED facets
 * (profile-pet-food, profile-accessories), fanning out to 21 compiled
 * profiles — beyond the owner approval (compiled profile-supplements +
 * profile-grooming only). The proposal was moved byte-for-byte out of
 * release discovery to docs/audits/rejected-taxonomy-v6/bay-state-v6 and
 * must never be activatable from the application releases root.
 *
 * These tests pin the rejection invariants: archive integrity (manifest
 * hashes match file bytes, provenance fields frozen — no retroactive
 * approval), absence from release discovery, the documented 21-profile
 * fan-out scope, and the standalone rejection audit. No DB, no activation,
 * no model calls.
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
import { detectReleaseGeneration } from '../../classification/release-validation';

const REAL_RELEASES_ROOT = path.resolve(__dirname, '../../classification/releases');
const V5_DIR = path.join(REAL_RELEASES_ROOT, 'bay-state-v5');
const ARCHIVE_DIR = path.resolve(__dirname, '../../../docs/audits/rejected-taxonomy-v6/bay-state-v6');
const AUDIT_FILE = path.resolve(__dirname, '../../../docs/audits/taxonomy-v6-rejected-facet-fanout-2026-10-04.md');

function readJson(dir: string, fileName: string): any {
  return JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8'));
}

describe('bay-state-v6 — archived rejected proposal', () => {
  it('is absent from application release discovery (not activatable)', () => {
    expect(fs.existsSync(path.join(REAL_RELEASES_ROOT, 'bay-state-v6'))).toBe(false);
    expect(fs.readdirSync(REAL_RELEASES_ROOT).sort()).toEqual([
      'bay-state-v3',
      'bay-state-v4',
      'bay-state-v5',
      'bay-state-v7',
      'bay-state-v8',
    ]);
  });

  it('archive holds all 9 release files with manifest hashes matching file bytes', () => {
    const manifest = readJson(ARCHIVE_DIR, 'manifest.json');
    for (const [fileName, hash] of Object.entries(manifest.fileVersions as Record<string, string>)) {
      const text = fs.readFileSync(path.join(ARCHIVE_DIR, fileName), 'utf8');
      expect(crypto.createHash('sha256').update(text, 'utf8').digest('hex')).toBe(hash);
    }
  });

  it('archived provenance frozen: v6 identity, v5 baseline, release lifecycle (no retroactive approval)', () => {
    const manifest = readJson(ARCHIVE_DIR, 'manifest.json');
    expect(manifest.releaseId).toBe('bay-state-v6');
    expect(manifest.revision).toBe('bay-state-v6');
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.sourceBaseline).toBe('bay-state-v5');
    expect(manifest.lifecycle).toBe('release');
    expect(detectReleaseGeneration(ARCHIVE_DIR)).toBe('v5');
  });

  it('documents the rejected fan-out: shared facets multi with 21 referencing types', () => {
    const archived = readJson(ARCHIVE_DIR, 'facet-profiles.json');
    for (const profileId of ['profile-pet-food', 'profile-accessories']) {
      const entry = archived.entries.find((p: any) => p.id === profileId);
      expect(entry.attributes.find((a: any) => a.attributeId === 'species').cardinality).toBe('multiple');
    }
    const v5Hierarchy = readJson(V5_DIR, 'hierarchy.json');
    const fannedOut = v5Hierarchy.entries.filter(
      (n: any) => n.classifiable && (n.facetProfileId === 'profile-pet-food' || n.facetProfileId === 'profile-accessories'),
    );
    expect(fannedOut.length).toBe(21);
    expect(fannedOut.map((n: any) => n.id)).toContain('supplements');
    expect(fannedOut.map((n: any) => n.id)).toContain('grooming');
  });

  it('standalone rejection audit exists and references the actual archive', () => {
    expect(fs.existsSync(AUDIT_FILE)).toBe(true);
    const audit = fs.readFileSync(AUDIT_FILE, 'utf8');
    expect(audit).toMatch(/REJECTED/);
    expect(audit).toContain('docs/audits/rejected-taxonomy-v6/bay-state-v6');
  });
});

describe('release authoring — cardinality + invariant patch ops', () => {
  function readV5SourceFiles(): Record<string, unknown> {
    const files: Record<string, unknown> = {};
    for (const fileName of ['facet-profiles.json', 'hierarchy.json', 'attributes.json']) {
      files[fileName] = JSON.parse(fs.readFileSync(path.join(V5_DIR, fileName), 'utf8'));
    }
    return files;
  }

  it('patches an existing membership cardinality in place', () => {
    const out = applyChangeSetToFiles(readV5SourceFiles(), {
      newReleaseId: 'patch-check',
      profileCardinalityPatches: [{ profileId: 'profile-pet-food', attributeId: 'species', cardinality: 'multiple' }],
    });
    const profiles = JSON.parse(out['facet-profiles.json']).entries;
    const entry = profiles
      .find((p: any) => p.id === 'profile-pet-food').attributes
      .find((a: any) => a.attributeId === 'species');
    expect(entry.cardinality).toBe('multiple');
  });

  it('refuses unknown profiles, non-member attributes, and bad cardinalities', () => {
    const source = readV5SourceFiles();
    expect(() => applyChangeSetToFiles(source, {
      newReleaseId: 'x',
      profileCardinalityPatches: [{ profileId: 'nope', attributeId: 'species', cardinality: 'multiple' }],
    })).toThrow(/unknown facet profile id/);
    expect(() => applyChangeSetToFiles(source, {
      newReleaseId: 'x',
      profileCardinalityPatches: [{ profileId: 'profile-heating', attributeId: 'species', cardinality: 'multiple' }],
    })).toThrow(/not a member/);
    expect(() => applyChangeSetToFiles(source, {
      newReleaseId: 'x',
      profileCardinalityPatches: [{ profileId: 'profile-pet-food', attributeId: 'species', cardinality: 'multi' as any }],
    })).toThrow(/invalid cardinality/);
  });

  it('invariant patches preserve value sets and match final cardinality shape', () => {
    const source = readV5SourceFiles();
    // Value change refused.
    expect(() => applyChangeSetToFiles(source, {
      newReleaseId: 'x',
      profileCardinalityPatches: [{ profileId: 'profile-pet-food', attributeId: 'species', cardinality: 'multiple' }],
      hierarchyInvariantPatches: [{ nodeId: 'dog-food-dry', attributeId: 'species', value: ['Dog', 'Cat'] }],
    })).toThrow(/value set would change/);
    // Shape mismatch refused (string invariant under multiple cardinality).
    expect(() => applyChangeSetToFiles(source, {
      newReleaseId: 'x',
      profileCardinalityPatches: [{ profileId: 'profile-pet-food', attributeId: 'species', cardinality: 'multiple' }],
      hierarchyInvariantPatches: [{ nodeId: 'dog-food-dry', attributeId: 'species', value: 'Dog' }],
    })).toThrow(/shape does not match/);
    // Invention refused.
    expect(() => applyChangeSetToFiles(source, {
      newReleaseId: 'x',
      hierarchyInvariantPatches: [{ nodeId: 'supplements', attributeId: 'species', value: ['Dog'] }],
    })).toThrow(/has no invariant/);
  });
});

describe('release authoring — V5-generation end-to-end against a temp root', () => {
  let tempRoot = '';

  beforeAll(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-v6-test-'));
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

  it('authors a V5-generation candidate through the V5 gate (not V4)', () => {
    const result = authorCandidateRelease('bay-state-v5', {
      newReleaseId: 'e2e-v6-probe',
      createdAtOverride: '2026-10-04T00:00:00.000Z',
      profileCardinalityPatches: [
        { profileId: 'profile-pet-food', attributeId: 'species', cardinality: 'multiple' },
      ],
      hierarchyInvariantPatches: [
        { nodeId: 'dog-food-dry', attributeId: 'species', value: ['Dog'] },
        { nodeId: 'dog-food-wet', attributeId: 'species', value: ['Dog'] },
        { nodeId: 'dog-treats', attributeId: 'species', value: ['Dog'] },
        { nodeId: 'cat-food-dry', attributeId: 'species', value: ['Cat'] },
        { nodeId: 'cat-food-wet', attributeId: 'species', value: ['Cat'] },
        { nodeId: 'cat-treats', attributeId: 'species', value: ['Cat'] },
        { nodeId: 'fish-food', attributeId: 'species', value: ['Fish'] },
      ],
    }, { releasesRootOverride: tempRoot });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.findings.filter(f => f.severity === 'error')).toEqual([]);
    fs.rmSync(result.candidateDir, { recursive: true, force: true });
  });

  it('refuses to overwrite an existing release directory (immutability)', () => {
    const first = authorCandidateRelease('bay-state-v5', {
      newReleaseId: 'e2e-immutable-probe',
      createdAtOverride: '2026-10-04T00:00:00.000Z',
    }, { releasesRootOverride: tempRoot });
    expect(first.ok).toBe(true);
    const second = authorCandidateRelease('bay-state-v5', {
      newReleaseId: 'e2e-immutable-probe',
    }, { releasesRootOverride: tempRoot });
    expect(second.ok).toBe(false);
    if (first.ok) fs.rmSync(first.candidateDir, { recursive: true, force: true });
  });
});
