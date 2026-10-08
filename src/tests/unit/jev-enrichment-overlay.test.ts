/**
 * Behavioral enrichment-overlay tests (public seam only, no network, no custody).
 *
 * Covers the overlay boundary at the module interface: append with
 * locator-dedupe (exact-text dupes collapse, novel locators append),
 * enriched=false rows ignored, SKU mismatch / URL mismatch / familyId drift /
 * conflicting locator text / excerpt overflow past 20 all fail closed,
 * duplicate enrichment SKUs rejected, and sorted per-SKU provenance.
 * No wording or wiring tests.
 */
import { describe, it, expect } from 'vitest';
import {
  applyEnrichmentOverlay,
  ENRICHMENT_EVIDENCE_KIND,
  ENRICHMENT_MAX_EXCERPTS,
  type EnrichmentEvidenceRow,
} from '../../../scripts/lib/enrichment-overlay';
import type { JevSourceCandidate } from '../../shared/schemas/jev-benchmark';

const SKU = 'PUBLIC:acme-pet-foods.com:001';
const URL = 'https://acme-pet-foods.com/products/widget';

function source(overrides: Partial<JevSourceCandidate> = {}): JevSourceCandidate {
  return {
    sku: SKU,
    title: 'Acme Widget',
    brand: 'Acme',
    canonicalUrl: URL,
    productIdentity: 'Acme: Widget',
    sourceLocator: URL,
    sourceHash: 'a'.repeat(64),
    retrievedAt: '2026-10-08T12:00:00.000Z',
    familyId: 'family-001',
    excerpts: [{ text: 'A fine widget.', locator: `${URL}#excerpt-0` }],
    ...overrides,
  };
}

function row(overrides: Partial<EnrichmentEvidenceRow> = {}): EnrichmentEvidenceRow {
  return {
    sku: SKU,
    canonicalUrl: URL,
    enriched: true,
    excerpts: [],
    ...overrides,
  } as EnrichmentEvidenceRow;
}

function file(rows: EnrichmentEvidenceRow[]): unknown {
  return { artifactKind: ENRICHMENT_EVIDENCE_KIND, rows };
}

function sourcesFor(candidate: JevSourceCandidate) {
  return new Map([[candidate.sku, { bank: 'pilot', source: candidate }]]);
}

describe('enrichment overlay (append + dedupe)', () => {
  it('appends novel locators, dedupes exact-text repeats, records provenance', () => {
    const sources = sourcesFor(source());
    const provenance = applyEnrichmentOverlay(
      sources,
      file([row({ excerpts: [
        { text: 'A fine widget.', locator: `${URL}#excerpt-0` },
        { text: 'New evidence one.', locator: `${URL}#jsonld-a` },
        { text: 'New evidence two.', locator: `${URL}#jsonld-b` },
        { text: 'New evidence one.', locator: `${URL}#jsonld-a` },
      ] })]),
    );
    const merged = sources.get(SKU)!.source.excerpts;
    expect(merged).toHaveLength(3);
    expect(merged.map(e => e.locator)).toEqual([
      `${URL}#excerpt-0`, `${URL}#jsonld-a`, `${URL}#jsonld-b`,
    ]);
    expect(provenance).toEqual([{
      sku: SKU, bank: 'pilot', appendedExcerptLocators: [`${URL}#jsonld-a`, `${URL}#jsonld-b`],
    }]);
  });

  it('ignores enriched=false rows without touching sources', () => {
    const sources = sourcesFor(source());
    const before = JSON.stringify(sources.get(SKU)!.source.excerpts);
    const provenance = applyEnrichmentOverlay(
      sources,
      file([row({ enriched: false, excerpts: [{ text: 'Ignored.', locator: `${URL}#x` }] })]),
    );
    expect(provenance).toEqual([]);
    expect(JSON.stringify(sources.get(SKU)!.source.excerpts)).toBe(before);
  });

  it('appends distinct texts sharing one locator (extractor paragraph chunking)', () => {
    const sources = sourcesFor(source());
    const provenance = applyEnrichmentOverlay(
      sources,
      file([row({ excerpts: [
        { text: 'Chunk one.', locator: `${URL}#jsonld-desc` },
        { text: 'Chunk two.', locator: `${URL}#jsonld-desc` },
        { text: 'Chunk one.', locator: `${URL}#jsonld-desc` },
      ] })]),
    );
    const merged = sources.get(SKU)!.source.excerpts;
    expect(merged.map(e => e.text)).toEqual(['A fine widget.', 'Chunk one.', 'Chunk two.']);
    expect(provenance).toEqual([{
      sku: SKU, bank: 'pilot', appendedExcerptLocators: [`${URL}#jsonld-desc`, `${URL}#jsonld-desc`],
    }]);
  });

  it('fails closed on SKU mismatch, URL mismatch, and familyId drift', () => {
    expect(() => applyEnrichmentOverlay(
      sourcesFor(source()),
      file([row({ sku: 'PUBLIC:acme-pet-foods.com:999' })]),
    )).toThrow(/enrichment_sku_mismatch/);
    expect(() => applyEnrichmentOverlay(
      sourcesFor(source()),
      file([row({ canonicalUrl: 'https://acme-pet-foods.com/products/other' })]),
    )).toThrow(/enrichment_url_mismatch/);
    expect(() => applyEnrichmentOverlay(
      sourcesFor(source()),
      file([row({ familyId: 'family-drifted', excerpts: [{ text: 'E.', locator: `${URL}#e` }] })]),
    )).toThrow(/enrichment_family_drift/);
  });

  it('fails closed on conflicting locator text and duplicate enrichment SKUs', () => {
    expect(() => applyEnrichmentOverlay(
      sourcesFor(source()),
      file([row({ excerpts: [{ text: 'DIFFERENT text.', locator: `${URL}#excerpt-0` }] })]),
    )).toThrow(/enrichment_locator_conflict/);
    expect(() => applyEnrichmentOverlay(
      sourcesFor(source()),
      file([row({ excerpts: [] }), row({ excerpts: [] })]),
    )).toThrow(/enrichment_duplicate_sku/);
  });

  it('fails closed on excerpt overflow past the schema max', () => {
    const many = Array.from({ length: ENRICHMENT_MAX_EXCERPTS }, (_, i) => ({
      text: `Seed ${i}.`, locator: `${URL}#seed-${i}`,
    }));
    expect(() => applyEnrichmentOverlay(
      sourcesFor(source({ excerpts: many })),
      file([row({ excerpts: [{ text: 'Overflow.', locator: `${URL}#overflow` }] })]),
    )).toThrow(/enrichment_excerpt_overflow/);
  });
});
