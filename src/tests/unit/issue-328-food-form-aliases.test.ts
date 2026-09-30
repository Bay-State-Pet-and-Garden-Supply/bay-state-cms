/**
 * Issue #328: Dry Dog Food → Dry Food value alias (false type-conflict banners).
 *
 * Governed-config coverage: the alias lives in the reviewed seed (the canary
 * path: seed-sync → generateCandidate) AND in the tip release bundle
 * (bay-state-v5, the pinned-production path), with every mapsTo an exact
 * allowedValues entry. Decision/evidence code is untouched — reconciliation
 * flows through the existing `resolveCanonicalAssertion` alias path.
 *
 * Note on v4: bay-state-v4 is superseded (v5's sourceBaseline) and intentionally
 * left frozen — releases are append-only history, so only the tip release is
 * amended, following this repo's own v4-era precedent of in-place tip
 * amendments via reviewed PRs. Future aliases should author a new release via
 * the `valueAliasAdds` change-set op (tested below).
 */
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { generateCandidate } from '../../classification/config-generator';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import { applyChangeSetToFiles } from '../../classification/release-authoring';
import { buildEvidenceTargetPacket, resolveCanonicalAssertion } from '../../classification/evidence-targeting';
import type { ClassificationEvidence } from '../../shared/types';

const REQUIRED_ALIASES: Array<{ alias: string; mapsTo: string }> = [
  { alias: 'Dry Dog Food', mapsTo: 'Dry Food' },
  { alias: 'Dry Cat Food', mapsTo: 'Dry Food' },
  { alias: 'Wet Dog Food', mapsTo: 'Wet Food' },
  { alias: 'Wet Cat Food', mapsTo: 'Wet Food' },
  { alias: 'Dog Treats', mapsTo: 'Treat' },
  { alias: 'Cat Treats', mapsTo: 'Treat' },
];

const RELEASES_ROOT = path.resolve(__dirname, '../../classification/releases');

function releaseFoodForm(releaseId: string): { allowedValues: string[]; valueAliases: Array<{ alias: string; mapsTo: string }> } {
  const raw = JSON.parse(fs.readFileSync(path.join(RELEASES_ROOT, releaseId, 'attributes.json'), 'utf8')) as {
    entries: Array<{ id: string; allowedValues: string[]; valueAliases: Array<{ alias: string; mapsTo: string }> }>;
  };
  const ff = raw.entries.find(e => e.id === 'food-form');
  if (!ff) throw new Error(`release ${releaseId} has no food-form attribute`);
  return ff;
}

function canaryEvidence(id: string, value: string): ClassificationEvidence {
  return {
    runId: 'run-1',
    stageName: 'evidence_extraction',
    productSku: 'QUAL-DOG-KIBBLE-01',
    source: 'official_product_page',
    reliability: 'high',
    capturedAt: '2026-08-01T12:00:00.000Z',
    id,
    attributeId: 'food-form',
    sourceField: 'llm_productForm',
    snippet: value,
    value,
  } as ClassificationEvidence;
}

const EMPTY_EVIDENCE: CatalogEvidence = {
  schemaVersion: 1,
  sourceTreeHash: '0'.repeat(64),
  productFileCount: 0,
  parseFailureCount: 0,
  parseFailures: [],
  fieldRegistry: { entryCount: 0, xmlFields: [] },
  fields: [],
  pages: [],
};

describe('issue #328 — food-form value aliases via governed config', () => {
  it('seed carries the species-prefixed food-form aliases with exact canonical targets', () => {
    const seedForm = BayStatePetGardenSeed.attributes.find(a => a.id === 'food-form');
    expect(seedForm).toBeDefined();
    for (const required of REQUIRED_ALIASES) {
      expect(seedForm!.valueAliases).toContainEqual(required);
    }
    const allowed = new Set(seedForm!.allowedValues);
    for (const entry of seedForm!.valueAliases) {
      expect(allowed.has(entry.mapsTo)).toBe(true);
    }
  });

  it('tip release bay-state-v5 carries the aliases with exact allowed targets', () => {
    const ff = releaseFoodForm('bay-state-v5');
    for (const required of REQUIRED_ALIASES) {
      expect(ff.valueAliases).toContainEqual(required);
    }
    const allowed = new Set(ff.allowedValues);
    for (const entry of ff.valueAliases) {
      expect(allowed.has(entry.mapsTo)).toBe(true);
    }
  });

  it('tip release manifest hash matches attributes.json on disk', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(RELEASES_ROOT, 'bay-state-v5', 'manifest.json'), 'utf8'),
    ) as { fileVersions: Record<string, string> };
    const text = fs.readFileSync(path.join(RELEASES_ROOT, 'bay-state-v5', 'attributes.json'), 'utf8');
    expect(manifest.fileVersions['attributes.json']).toBe(crypto.createHash('sha256').update(text, 'utf8').digest('hex'));
  });

  it('configured aliases reconcile through the existing canonical path (no decision-code change)', () => {
    const seedForm = BayStatePetGardenSeed.attributes.find(a => a.id === 'food-form')!;
    expect(resolveCanonicalAssertion('Dry Dog Food', seedForm.valueAliases)).toBe('Dry Food');
    expect(resolveCanonicalAssertion('Dry Cat Food', seedForm.valueAliases)).toBe('Dry Food');
    expect(resolveCanonicalAssertion('Wet Dog Food', seedForm.valueAliases)).toBe('Wet Food');
    expect(resolveCanonicalAssertion('Dry Food', seedForm.valueAliases)).toBe('Dry Food');
    // A genuinely different value does NOT reconcile.
    expect(resolveCanonicalAssertion('Wet Food', seedForm.valueAliases)).toBe('Wet Food');
  });

  it('canary path end-to-end: seed → generateCandidate → packet supports Dry Food (no hardcoded aliases)', () => {
    // This mirrors the canary runtime (seed-sync → generateCandidate): the
    // aliases must flow from the reviewed seed into the packet, not from a
    // test-local literal.
    const candidate = generateCandidate(BayStatePetGardenSeed, EMPTY_EVIDENCE);
    const ff = candidate.bundle.attributes.find(a => a.id === 'food-form')!;
    expect(ff.valueAliases).toContainEqual({ alias: 'Dry Dog Food', mapsTo: 'Dry Food' });
    const packet = buildEvidenceTargetPacket([canaryEvidence('llm-form', 'Dry Dog Food')], {
      attributeId: 'food-form',
      sourceField: 'llm_productForm',
      selectionMode: 'single',
      proposedValue: 'Dry Food',
      aliases: ff.valueAliases,
    });
    expect(packet.supportingEvidenceIds).toEqual(['llm-form']);
    expect(packet.contradictingEvidenceIds).toEqual([]);
    expect(packet.hasConflict).toBe(false);
  });

  it('release wiring end-to-end: v5 on-disk aliases → packet supports Dry Food (no hardcoded aliases)', () => {
    const ff = releaseFoodForm('bay-state-v5');
    const packet = buildEvidenceTargetPacket([canaryEvidence('llm-form', 'Dry Dog Food')], {
      attributeId: 'food-form',
      sourceField: 'llm_productForm',
      selectionMode: 'single',
      proposedValue: 'Dry Food',
      aliases: ff.valueAliases,
    });
    expect(packet.supportingEvidenceIds).toEqual(['llm-form']);
    expect(packet.contradictingEvidenceIds).toEqual([]);
    // And a genuinely different value from the same release config still contradicts.
    const genuine = buildEvidenceTargetPacket([canaryEvidence('wet', 'Wet Food')], {
      attributeId: 'food-form',
      sourceField: 'llm_productForm',
      selectionMode: 'single',
      proposedValue: 'Dry Food',
      aliases: ff.valueAliases,
    });
    expect(genuine.contradictingEvidenceIds).toEqual(['wet']);
  });

  it('release-authoring supports append-only valueAliasAdds (governed bundle-release path)', () => {
    const sourceDir = path.join(RELEASES_ROOT, 'bay-state-v5');
    const files: Record<string, unknown> = {};
    for (const name of ['attributes.json', 'facet-profiles.json', 'hierarchy.json', 'export-mappings.json']) {
      files[name] = JSON.parse(fs.readFileSync(path.join(sourceDir, name), 'utf8'));
    }
    // Stripped copy: remove the Dry Dog Food alias to prove the op re-adds it.
    const stripped = JSON.parse(JSON.stringify(files)) as Record<string, any>;
    const entries = stripped['attributes.json'].entries as Array<any>;
    const ff = entries.find(e => e.id === 'food-form');
    ff.valueAliases = (ff.valueAliases as Array<any>).filter(a => a.alias !== 'Dry Dog Food');
    const out = applyChangeSetToFiles(stripped, {
      newReleaseId: 'alias-op-check',
      createdAtOverride: '2026-09-30T00:00:00.000Z',
      valueAliasAdds: [{ attributeId: 'food-form', alias: 'Dry Dog Food', mapsTo: 'Dry Food' }],
    });
    const result = JSON.parse(out['attributes.json']) as { entries: Array<{ id: string; valueAliases: Array<{ alias: string; mapsTo: string }> }> };
    expect(result.entries.find(e => e.id === 'food-form')!.valueAliases).toContainEqual({
      alias: 'Dry Dog Food',
      mapsTo: 'Dry Food',
    });
    // Fail-closed: unknown attribute, unknown target, non-canonical alias,
    // alias colliding with an allowed value, duplicate alias.
    expect(() => applyChangeSetToFiles(files, {
      newReleaseId: 'x', valueAliasAdds: [{ attributeId: 'nope', alias: 'A', mapsTo: 'Dry Food' }],
    })).toThrow(/unknown attribute id/);
    expect(() => applyChangeSetToFiles(files, {
      newReleaseId: 'x', valueAliasAdds: [{ attributeId: 'food-form', alias: 'New Alias', mapsTo: 'Not A Value' }],
    })).toThrow(/not an allowed value/);
    expect(() => applyChangeSetToFiles(files, {
      newReleaseId: 'x', valueAliasAdds: [{ attributeId: 'food-form', alias: '  Dry Dog Food  ', mapsTo: 'Dry Food' }],
    })).toThrow(/not canonical/);
    expect(() => applyChangeSetToFiles(files, {
      newReleaseId: 'x', valueAliasAdds: [{ attributeId: 'food-form', alias: 'Dry Food', mapsTo: 'Dry Food' }],
    })).toThrow(/collides with an allowed value/);
    expect(() => applyChangeSetToFiles(files, {
      newReleaseId: 'x', valueAliasAdds: [{ attributeId: 'food-form', alias: 'Dry Dog Food', mapsTo: 'Dry Food' }],
    })).toThrow(/already exists/);
  });
});
