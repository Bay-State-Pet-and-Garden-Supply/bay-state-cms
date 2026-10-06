/**
 * bay-state-v9 release tests — CMS↔ShopSite alignment (2026-10-06 owner decisions).
 *
 * v9 (sourceBaseline bay-state-v8) makes exactly the approved changes:
 *  - PF32 read-only (`product-cross-sell` mapping removed, not_exported, label
 *    "UPC List (read-only)"); PF8 read-only (`nutrition` mapping removed,
 *    not_exported) — live PF32/PF8 hold barcodes/instructions, never CMS data;
 *  - species vocabulary widened append-only (+Wild Bird, Caged Bird,
 *    Farm Animal, Small Pet, Bee);
 *  - delimited '|' serialization for the CMS-owned multi-value slots;
 *  - species membership cardinality normalized to single (the compiler's
 *    derived targets are single-select).
 *
 * No DB, no activation, no model calls — pure file + compile assertions.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { assertReleaseValidV5, detectReleaseGeneration, loadTaxonomyReleaseV5 } from '../../classification/release-validation';
import { compileTaxonomyReleaseV5, type CompiledReleaseBundle } from '../../classification/release-compiler';
import { validateClassificationConfigBundle } from '../../classification/config-validation';
import type { ReleaseValidationFinding } from '../../classification/release-validation';

const REAL_RELEASES_ROOT = path.resolve(__dirname, '../../classification/releases');
const V9_DIR = path.join(REAL_RELEASES_ROOT, 'bay-state-v9');

const V9: CompiledReleaseBundle = compileTaxonomyReleaseV5(loadTaxonomyReleaseV5('bay-state-v9'));

const DELIMITED_ATTRIBUTES = [
  'species', 'life-stage', 'dietary-features', 'health-benefits', 'food-form',
  'flavor', 'category', 'product-feature', 'material', 'color',
];

describe('bay-state-v9 — CMS↔ShopSite alignment release', () => {
  it('exists with V5-generation manifest provenance off the v8 baseline', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(V9_DIR, 'manifest.json'), 'utf8'));
    expect(manifest.releaseId).toBe('bay-state-v9');
    expect(manifest.sourceBaseline).toBe('bay-state-v8');
    expect(detectReleaseGeneration('bay-state-v9')).toBe('v5');
  });

  it('passes the V5 release gate with zero errors', () => {
    const report = assertReleaseValidV5('bay-state-v9');
    expect(report.findings.filter((f: ReleaseValidationFinding) => f.severity === 'error')).toEqual([]);
  });

  it('retires the PF32/PF8 export targets (read-only; never written)', () => {
    const targetAttributes = V9.curationTargets.map((t: (typeof V9.curationTargets)[number]) => t.attributeId);
    expect(targetAttributes).not.toContain('product-cross-sell');
    expect(targetAttributes).not.toContain('nutrition');
    expect(V9.attributeMappings.map((m: (typeof V9.attributeMappings)[number]) => m.attributeId)).not.toContain('product-cross-sell');
    expect(V9.attributeMappings.map((m: (typeof V9.attributeMappings)[number]) => m.attributeId)).not.toContain('nutrition');
    const upc = V9.attributes.find((a: (typeof V9.attributes)[number]) => a.id === 'product-cross-sell');
    expect(upc?.name).toBe('UPC List (read-only)');
    expect(upc?.exportDisposition).toEqual({ kind: 'not_exported' });
    const nutrition = V9.attributes.find((a: (typeof V9.attributes)[number]) => a.id === 'nutrition');
    expect(nutrition?.exportDisposition).toEqual({ kind: 'not_exported' });
  });

  it('widens the species vocabulary append-only', () => {
    const species = V9.attributes.find((a: (typeof V9.attributes)[number]) => a.id === 'species');
    expect(species?.allowedValues).toEqual([
      'Dog', 'Cat', 'Bird', 'Horse', 'Poultry', 'Cattle', 'Goat', 'Sheep', 'Swine',
      'Small Animal', 'Wildlife', 'Fish', 'Reptile',
      'Wild Bird', 'Caged Bird', 'Farm Animal', 'Small Pet', 'Bee',
    ]);
  });

  it('adopts delimited serialization for the CMS-owned multi-value slots', () => {
    for (const attributeId of DELIMITED_ATTRIBUTES) {
      const mapping = V9.attributeMappings.find((m: (typeof V9.attributeMappings)[number]) => m.attributeId === attributeId);
      expect(mapping, `${attributeId} mapping`).toBeTruthy();
      expect(mapping?.serialization).toMatchObject({ kind: 'delimited', delimiter: '|', escapePolicy: 'reject' });
    }
    // Slots kept scalar (no live evidence of lists).
    for (const attributeId of ['packaging-type', 'size', 'brand']) {
      const mapping = V9.attributeMappings.find((m: (typeof V9.attributeMappings)[number]) => m.attributeId === attributeId);
      expect(mapping?.serialization.kind).toBe('scalar');
    }
  });

  it('normalizes species cardinality to single (compiler targets are single-select)', () => {
    // The declared attributeProfiles type mistypes membership entries as full
    // attribute configs; the runtime shape is the membership object the
    // compiler copies from the facet profile (attributeId + cardinality).
    const memberships = V9.attributeProfiles.flatMap(
      (p) => p.attributes as unknown as Array<{ attributeId?: unknown; cardinality?: unknown }>,
    ).filter(m => m.attributeId === 'species');
    expect([...new Set(memberships.map(m => m.cardinality))]).toEqual(['single']);
    const speciesTarget = V9.curationTargets.find((t: (typeof V9.curationTargets)[number]) => t.attributeId === 'species');
    expect(speciesTarget?.selectionMode).toBe('single');
  });

  it('fixes the v8 configuration incoherence (the two validator errors are gone)', () => {
    const report = validateClassificationConfigBundle(V9, { mode: 'preview' });
    const codes = report.findings.map((f: ReleaseValidationFinding) => f.code);
    expect(codes).not.toContain('serialization_cardinality_mismatch');
    expect(codes).not.toContain('target_cardinality_conflict');
  });
});
