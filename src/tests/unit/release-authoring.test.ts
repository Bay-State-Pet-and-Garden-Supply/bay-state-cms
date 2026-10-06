/**
 * Release Authoring (P2) tests — plan B.P2.3.
 *
 * Covers: change-set application determinism, hash recompute correctness,
 * no-op round-trip validation, id-deletion refusal, fail-closed candidate
 * validation (no directory published on error findings), and the exported-add
 * requires profile membership rule. All IO runs against a TEMP releases root
 * seeded with copies of the committed bay-state-v4 + bay-state-v3 releases;
 * the real releases are never touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyChangeSetToFiles,
  authorCandidateRelease,
  buildCandidateManifest,
  type ReleaseChangeSet,
} from '../../classification/release-authoring';
import { assertReleaseValidV4 } from '../../classification/release-validation';

const REAL_RELEASES_ROOT = path.resolve(__dirname, '../../classification/releases');
const V4_FILES = [
  'hierarchy.json',
  'facet-profiles.json',
  'legacy-mappings.json',
  'attributes.json',
  'export-mappings.json',
  'shopsite-projection.json',
  'guidance.json',
  'page-assignment-policy.json',
] as const;

let tempRoot = '';

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-authoring-test-'));
  for (const releaseId of ['bay-state-v4', 'bay-state-v3']) {
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

function readSourceFiles(): Record<string, unknown> {
  const files: Record<string, unknown> = {};
  const sourceDir = path.join(REAL_RELEASES_ROOT, 'bay-state-v4');
  for (const fileName of V4_FILES) {
    const filePath = path.join(sourceDir, fileName);
    if (fs.existsSync(filePath)) {
      files[fileName] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  }
  return files;
}

describe('release authoring — pure core', () => {
  it('change-set application is deterministic (byte-identical across runs)', () => {
    const sourceFiles = readSourceFiles();
    const cs: ReleaseChangeSet = {
      newReleaseId: 'determinism-check',
      createdAtOverride: '2026-08-24T00:00:00.000Z',
      notes: ['determinism probe'],
    };
    const out1 = applyChangeSetToFiles(sourceFiles, cs);
    const out2 = applyChangeSetToFiles(sourceFiles, cs);
    expect(JSON.stringify(out1)).toBe(JSON.stringify(out2));
  });

  it('a no-op change-set is byte-identical to the source apart from origin rebinding', () => {
    const sourceFiles = readSourceFiles();
    const out = applyChangeSetToFiles(sourceFiles, {
      newReleaseId: 'noop-check',
      createdAtOverride: '2026-08-24T00:00:00.000Z',
    });
    for (const [fileName, text] of Object.entries(out)) {
      const originalText = fs.readFileSync(path.join(REAL_RELEASES_ROOT, 'bay-state-v4', fileName), 'utf8');
      const normalizeOriginAndTime = (s: string) => s
        .replace(/"releaseId": "[^"]+"/g, '"releaseId": "X"')
        .replace(/"createdAt": "[^"]+"/g, '"createdAt": "Y"');
      expect(normalizeOriginAndTime(text)).toBe(normalizeOriginAndTime(originalText));
    }
  });

  it('manifest hashes match the sha256 of the exact serialized candidate files', () => {
    const sourceFiles = readSourceFiles();
    const sourceManifest = JSON.parse(
      fs.readFileSync(path.join(REAL_RELEASES_ROOT, 'bay-state-v4', 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    const cs: ReleaseChangeSet = {
      newReleaseId: 'hash-check',
      createdAtOverride: '2026-08-24T00:00:00.000Z',
    };
    const candidateFiles = applyChangeSetToFiles(sourceFiles, cs);
    const manifest = buildCandidateManifest(sourceManifest, cs, candidateFiles);
    const fileVersions = manifest.fileVersions as Record<string, string>;
    for (const [fileName, text] of Object.entries(candidateFiles)) {
      const expected = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
      expect(fileVersions[fileName]).toBe(expected);
    }
    // sourceBaseline bumped to the SOURCE release id.
    expect(manifest.sourceBaseline).toBe('bay-state-v4');
  });

  it('refuses edits that would invent or delete attribute ids', () => {
    const sourceFiles = readSourceFiles();
    // Invention via edit of an unknown id is refused...
    expect(() => applyChangeSetToFiles(sourceFiles, {
      newReleaseId: 'x1',
      attributeEdits: [{ attributeId: 'does-not-exist' }],
    })).toThrow(/unknown attribute id/);
    // ...and there is NO operation that can remove an attribute id at all:
    // mappingRemoves only drops rows; the attribute entry survives.
    const out = applyChangeSetToFiles(sourceFiles, {
      newReleaseId: 'x2',
      mappingRemoves: [{ attributeId: 'color' }],
    });
    const attributes = JSON.parse(out['attributes.json']) as { entries: Array<{ id: string }> };
    expect(attributes.entries.some(a => a.id === 'color')).toBe(true);
    const mappings = JSON.parse(out['export-mappings.json']) as { entries: Array<{ attributeId: string }> };
    expect(mappings.entries.some(m => m.attributeId === 'color')).toBe(false);
  });
});

describe('release authoring — end-to-end against a temp releases root', () => {
  it('round-trips a no-op change-set into a published candidate that validates clean', () => {
    const result = authorCandidateRelease('bay-state-v4', {
      newReleaseId: 'e2e-noop-v5',
      createdAtOverride: '2026-08-24T00:00:00.000Z',
      notes: ['no-op round trip'],
    }, { releasesRootOverride: tempRoot });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fs.existsSync(path.join(tempRoot, 'e2e-noop-v5', 'manifest.json'))).toBe(true);
    // The published candidate passes the full v4 validation gate on its own.
    expect(() => assertReleaseValidV4(result.candidateDir)).not.toThrow();
    // No staging residue left behind.
    expect(fs.readdirSync(tempRoot).filter(name => name.startsWith('.authoring-tmp-'))).toEqual([]);
  });

  it('refuses output when the candidate has an ERROR finding — no directory exists', () => {
    // Half-promotion of a retired attribute: shopsite disposition + mapping but
    // NO facet-profile membership and not universal → P2 rule b fails closed.
    const result = authorCandidateRelease('bay-state-v4', {
      newReleaseId: 'e2e-half-promo-v5',
      createdAtOverride: '2026-08-24T00:00:00.000Z',
      attributeEdits: [{
        attributeId: 'btu-rating',
        exportDisposition: { kind: 'shopsite', catalogField: 'ProductField31' },
      }],
      mappingAdds: [{ attributeId: 'btu-rating', catalogField: 'ProductField31' }],
    }, { releasesRootOverride: tempRoot });
    expect(result.ok).toBe(false);
    const codes = result.report?.findings.filter(f => f.severity === 'error').map(f => f.code) ?? [];
    expect(codes).toContain('exported_attribute_without_profile_membership');
    expect(fs.existsSync(path.join(tempRoot, 'e2e-half-promo-v5'))).toBe(false);
  });

  it('the SAME promotion succeeds once profile membership is granted in the same release', () => {
    // btu-rating belongs in profile-heating per its department semantics.
    const result = authorCandidateRelease('bay-state-v4', {
      newReleaseId: 'e2e-full-promo-v5',
      createdAtOverride: '2026-08-24T00:00:00.000Z',
      attributeEdits: [{
        attributeId: 'btu-rating',
        exportDisposition: { kind: 'shopsite', catalogField: 'ProductField31' },
      }],
      mappingAdds: [{ attributeId: 'btu-rating', catalogField: 'ProductField31' }],
      profileMembershipGrants: [{ profileId: 'profile-heating', attributeId: 'btu-rating' }],
    }, { releasesRootOverride: tempRoot });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => assertReleaseValidV4(result.candidateDir)).not.toThrow();
    const attrs = JSON.parse(fs.readFileSync(path.join(result.candidateDir, 'attributes.json'), 'utf8')) as {
      entries: Array<{ id: string; exportDisposition: { kind: string; catalogField?: string } }>;
    };
    const btu = attrs.entries.find(a => a.id === 'btu-rating');
    expect(btu?.exportDisposition).toEqual({ kind: 'shopsite', catalogField: 'ProductField31' });
    fs.rmSync(result.candidateDir, { recursive: true, force: true });
  });

  it('refuses to overwrite an existing release or use an invalid release id', () => {
    const existing = authorCandidateRelease('bay-state-v4', {
      newReleaseId: 'e2e-noop-v5', // already created by the earlier test
    }, { releasesRootOverride: tempRoot });
    expect(existing.ok).toBe(false);

    const invalidId = authorCandidateRelease('bay-state-v4', {
      newReleaseId: 'Not_Kebab',
    }, { releasesRootOverride: tempRoot });
    expect(invalidId.ok).toBe(false);
  });

  it('warning findings surface but never block publication', () => {
    // Any child of bay-state-v4 carries retire_candidate advisories for the
    // eight retired attributes; the no-op candidate above still published.
    const result = authorCandidateRelease('bay-state-v4', {
      newReleaseId: 'e2e-warnings-v5',
      createdAtOverride: '2026-08-24T00:00:00.000Z',
    }, { releasesRootOverride: tempRoot });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const warnings = result.report.findings.filter(f => f.severity === 'warning');
    expect(warnings.length).toBeGreaterThanOrEqual(8);
    expect(warnings.every(w => w.code === 'retire_candidate')).toBe(true);
    fs.rmSync(result.candidateDir, { recursive: true, force: true });
  });
});

describe('release authoring — attributeAllowedValueAdds (governed vocabulary widening)', () => {
  const readSpecies = (out: Record<string, string>, attributeId: string): { allowedValues: string[]; valueAliases: Array<{ alias: string; mapsTo: string }> } => {
    const attrs = JSON.parse(out['attributes.json']) as { entries: Array<{ id: string; allowedValues: string[]; valueAliases: Array<{ alias: string; mapsTo: string }> }> };
    return attrs.entries.find(a => a.id === attributeId)!;
  };

  it('appends values in order and lets aliases target them in the same change-set', () => {
    const files = readSourceFiles();
    const out = applyChangeSetToFiles(files, {
      newReleaseId: 'x',
      attributeAllowedValueAdds: [{ attributeId: 'flavor', values: ['Rabbit', 'Venison'] }],
      valueAliasAdds: [{ attributeId: 'flavor', alias: 'rabbit meat', mapsTo: 'Rabbit' }],
    });
    const flavor = readSpecies(out, 'flavor');
    expect(flavor.allowedValues.slice(-2)).toEqual(['Rabbit', 'Venison']);
    expect(flavor.valueAliases).toContainEqual({ alias: 'rabbit meat', mapsTo: 'Rabbit' });
  });

  it('refuses unknown, uncontrolled, duplicate, non-canonical, and colliding values', () => {
    const files = readSourceFiles();
    const attempt = (changeSet: ReleaseChangeSet) => () => applyChangeSetToFiles(files, changeSet);
    expect(attempt({ newReleaseId: 'x', attributeAllowedValueAdds: [{ attributeId: 'nope', values: ['A'] }] })).toThrow(/unknown attribute id/);
    expect(attempt({ newReleaseId: 'x', attributeAllowedValueAdds: [{ attributeId: 'brand', values: ['A'] }] })).toThrow(/not a controlled attribute/);
    expect(attempt({ newReleaseId: 'x', attributeAllowedValueAdds: [{ attributeId: 'flavor', values: ['Chicken'] }] })).toThrow(/already exists/);
    expect(attempt({ newReleaseId: 'x', attributeAllowedValueAdds: [{ attributeId: 'flavor', values: ['  Rabbit  '] }] })).toThrow(/not canonical/);
    expect(attempt({ newReleaseId: 'x', attributeAllowedValueAdds: [{ attributeId: 'flavor', values: ['Rabbit', 'rabbit'] }] })).toThrow(/collision/);
  });

  it('is deterministic across identical runs', () => {
    const run = () => applyChangeSetToFiles(readSourceFiles(), {
      newReleaseId: 'x',
      createdAtOverride: '2026-10-06T00:00:00.000Z',
      attributeAllowedValueAdds: [{ attributeId: 'flavor', values: ['Rabbit'] }],
    });
    expect(run()['attributes.json']).toBe(run()['attributes.json']);
  });
});
