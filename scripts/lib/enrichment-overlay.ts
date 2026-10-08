/**
 * Enrichment-evidence overlay for the JEV expansion corpus assembler.
 *
 * Applies already-public re-crawl evidence to hash-verified bank sources:
 * each enriched=true row matches its source by SKU + canonicalUrl exact,
 * then appends excerpts with locator-dedupe. Original bank bytes are
 * verified BEFORE overlay (the assembler enforces source_hash_drift first);
 * this module only merges validated evidence into in-memory sources.
 *
 * Fail-closed: SKU/URL mismatch, familyId drift, excerpt schema violations,
 * within-row conflicting locator texts, and overflow past the schema max
 * (20) all throw. No network, no private-custody reads.
 */
import { z } from 'zod';
import {
  JevSourceCandidateSchema,
  JevSourceExcerptSchema,
  type JevSourceCandidate,
} from '../../src/shared/schemas/jev-benchmark';

export const ENRICHMENT_EVIDENCE_KIND = 'already-public-enrichment-evidence' as const;
export const ENRICHMENT_MAX_EXCERPTS = 20;

export const EnrichmentEvidenceRowSchema = z.object({
  sku: z.string().min(1).max(120),
  canonicalUrl: z.string().min(1),
  enriched: z.boolean(),
  familyId: z.string().min(1).max(200).optional(),
  excerpts: z.array(JevSourceExcerptSchema),
}).passthrough();

export const EnrichmentEvidenceFileSchema = z.object({
  artifactKind: z.literal(ENRICHMENT_EVIDENCE_KIND),
  rows: z.array(EnrichmentEvidenceRowSchema),
}).passthrough();

export type EnrichmentEvidenceRow = z.infer<typeof EnrichmentEvidenceRowSchema>;

export interface EnrichmentOverlayEntry {
  sku: string;
  bank: string;
  appendedExcerptLocators: string[];
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

/**
 * Overlay enriched excerpts onto hash-verified sources. Sources map values are
 * replaced with schema-validated updates; returns per-SKU provenance.
 * Only rows with enriched=true apply; enriched=false rows are ignored.
 * Dedupe is by (locator, text) pair: exact repeats collapse, while distinct
 * texts under one locator (the enrichment extractor's paragraph chunking)
 * all append. A conflicting text for a bank-held locator fails closed.
 */
export function applyEnrichmentOverlay(
  sources: Map<string, { bank: string; source: JevSourceCandidate }>,
  evidence: unknown,
): EnrichmentOverlayEntry[] {
  const file = EnrichmentEvidenceFileSchema.parse(evidence);
  const seen = new Set<string>();
  const provenance: EnrichmentOverlayEntry[] = [];
  for (const row of file.rows) {
    if (row.enriched !== true) continue;
    if (seen.has(row.sku)) fail('enrichment_duplicate_sku', `duplicate enrichment row for ${row.sku}`);
    seen.add(row.sku);
    const record = sources.get(row.sku);
    if (!record) fail('enrichment_sku_mismatch', `enrichment row ${row.sku} matches no loaded source`);
    if (record.source.canonicalUrl !== row.canonicalUrl) {
      fail('enrichment_url_mismatch', `enrichment row ${row.sku} canonicalUrl does not exactly match the loaded source`);
    }
    if (row.familyId !== undefined && row.familyId !== record.source.familyId) {
      fail('enrichment_family_drift', `enrichment row ${row.sku} familyId does not match the loaded source`);
    }
    const bankTextByLocator = new Map(record.source.excerpts.map(e => [e.locator, e.text]));
    const heldPairs = new Set(record.source.excerpts.map(e => `${e.locator}\n${e.text}`));
    const appended: string[] = [];
    const merged = [...record.source.excerpts];
    for (const excerpt of row.excerpts) {
      if (heldPairs.has(`${excerpt.locator}\n${excerpt.text}`)) continue;
      const bankText = bankTextByLocator.get(excerpt.locator);
      if (bankText !== undefined && bankText !== excerpt.text) {
        fail('enrichment_locator_conflict', `enrichment row ${row.sku} locator ${excerpt.locator} conflicts with loaded excerpt text`);
      }
      heldPairs.add(`${excerpt.locator}\n${excerpt.text}`);
      merged.push(excerpt);
      appended.push(excerpt.locator);
    }
    if (merged.length > ENRICHMENT_MAX_EXCERPTS) {
      fail('enrichment_excerpt_overflow', `enrichment row ${row.sku} would exceed max ${ENRICHMENT_MAX_EXCERPTS} excerpts (${merged.length})`);
    }
    const updated = JevSourceCandidateSchema.parse({ ...record.source, excerpts: merged });
    sources.set(row.sku, { bank: record.bank, source: updated });
    provenance.push({ sku: row.sku, bank: record.bank, appendedExcerptLocators: appended });
  }
  provenance.sort((a, b) => a.sku.localeCompare(b.sku));
  return provenance;
}
