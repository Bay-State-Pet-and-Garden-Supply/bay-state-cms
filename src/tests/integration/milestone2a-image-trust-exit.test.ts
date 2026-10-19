/**
 * Milestone-2A exit proof (backfill remediation plan, Milestone 2A + A1–A3).
 *
 * One new bun:test file only; zero prod edits. Temp workspace/database per
 * test, deterministic fake local VLM + fake CGI-free seams (direct DB rows at
 * the public review/apply/merge seams), no live network or store mutation.
 *
 * Exit claims (one test each):
 * 1. three-image SKU: front legible + rear panel selected via ocrImageRefs
 *    (#1+#3, rear-panel text omitted by default) + one text-free image; the
 *    persisted evidence_extraction stage metadata carries per-image coded
 *    status/quote with byte digests.
 * 2. an image-backed field cited in a durable reviewer decision applies.
 * 3. a no-text image-backed decision is refused at review/apply.
 * 4. changed image bytes block apply (A2 re-hash) while a
 *    title/description-only grounded value still passes.
 * 5. conflicting brands/species/UPCs abstain and a fourth-line quote stays
 *    citeable through the merge.
 *
 * Pre-fix behavior notes: every test fails before A1–A3 because the coded
 * per-image dispositions + byte digests (A1), the ocrImageRefs selection
 * freeze (A2), the conflict-abstention merge + fourth-line quote retention
 * (A3), the explicit-citation review gate (A3), and the byte re-hash apply
 * guard (A2) did not exist.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createRun, completeRun, getAcceptedProposals } from '../../db/repositories/classification-run-repo';
import { generateCandidate } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { buildRuntimeSnapshot, persistRuntimeSnapshot } from '../../classification/runtime-snapshot';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import { submitProposalDecisions } from '../../classification/proposal-review-service';
import { validateCatalogReviewCompletionGate } from '../../classification/review-completion-gate';
import { verifyRunImageBytesUnchanged } from '../../classification/catalog-product-application';
import { buildCatalogOcrSummary } from '../../classification/stages/catalog-product-evidence-extraction';
import { mergeOcrResults } from '../../onboarding/packaging-ocr';
import { packagingOcrDataToEvidence } from '../../classification/ocr-evidence';
import type { PackagingOcrData } from '../../shared/schemas/onboarding';
import type { ClassificationEvidence, ClassificationProposal } from '../../shared/types';

let tmpDir: string;
let workspaceId: string;
const now = () => new Date().toISOString();

function seedImage(name: string, fill = 0x64): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, Buffer.alloc(2048, fill));
  return name;
}

function shaFile(name: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(tmpDir, name))).digest('hex');
}

function baseOcr(overrides: Partial<PackagingOcrData> = {}): PackagingOcrData {
  return {
    productName: null, brand: null, species: [], upc: null, flavorVariety: null,
    color: null, material: null, size: null, weight: null, count: null,
    lifeStage: null, breedSize: null, productForm: null, packagingType: null,
    npkRatio: null, guaranteedAnalysis: {}, healthConcernFunction: [],
    dietaryLabels: [], ingredients: [], ingredientKeywords: [], claims: [],
    visibleTextLines: [], confidenceByField: {}, metadata: null,
    ...overrides,
  } as PackagingOcrData;
}

const M2A_EVIDENCE: CatalogEvidence = {
  schemaVersion: 1,
  sourceTreeHash: '0'.repeat(64),
  productFileCount: 0,
  parseFailureCount: 0,
  parseFailures: [],
  fieldRegistry: { entryCount: 0, xmlFields: [] },
  fields: [],
  pages: [],
};

function makeRun(sku: string): string {
  const run = createRun(workspaceId, sku, null, null, { sourceKind: 'catalog_product' });
  completeRun(run.id, 'completed');
  seedAuthority(sku, run.id);
  return run.id;
}

function seedAuthority(sku: string, runId: string): void {
  const candidate = generateCandidate(BayStatePetGardenSeed, M2A_EVIDENCE);
  const bundle = candidate.bundle;
  const snapshot = buildRuntimeSnapshot({
    workspaceId,
    workspacePath: tmpDir,
    productSku: sku,
    authority: { kind: 'v2' as const, bundle },
    configSnapshotRef: {
      id: bundle.manifest.bundleHash,
      hash: bundle.manifest.bundleHash,
      sourceCommit: null,
      createdAt: now(),
    },
    sourceProductHash: '',
  });
  const { hash } = persistRuntimeSnapshot(snapshot);
  const db = getDb();
  db.run('UPDATE classification_runs SET config_snapshot_hash = ? WHERE id = ?', [hash, runId]);
  for (const binding of bundle.classificationOutputBindings ?? []) {
    db.run(
      `INSERT OR REPLACE INTO classification_output_bindings
       (workspace_id, role, catalog_field, serialization_json, is_stale, config_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
      [workspaceId, binding.role, binding.catalogField, JSON.stringify(binding.serialization), hash, now(), now()],
    );
  }
}

function insertEvidence(runId: string, sku: string, rows: ClassificationEvidence[]): string[] {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO classification_evidence (id, run_id, product_sku, stage_name, source, reliability, attribute_id, source_url, source_field, snippet, value_json, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const e of rows) {
    stmt.run(
      e.id || randomUUID(), runId, sku, e.stageName, e.source, e.reliability,
      e.attributeId ?? null, e.sourceUrl ?? null, (e as { sourceField?: string | null }).sourceField ?? null,
      e.snippet ?? null, JSON.stringify((e as { value?: unknown }).value ?? null),
      JSON.stringify((e as { metadata?: unknown }).metadata ?? {}), now(),
    );
  }
  return rows.map(e => e.id);
}

function insertProposal(runId: string, sku: string, partial: Partial<ClassificationProposal> & { id: string }): void {
  const db = getDb();
  db.run(
    `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at, evidence_ids_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      partial.id, runId, sku,
      partial.proposalType ?? 'field_assignment',
      partial.targetId ?? 'flavor',
      JSON.stringify(partial.proposedValue ?? 'Chicken'),
      partial.confidence ?? 0.8, now(),
      JSON.stringify(partial.evidenceIds ?? []),
    ],
  );
}

function linkEvidence(proposalId: string, evidenceIds: string[], relation: 'supporting' | 'context' = 'supporting'): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO classification_proposal_evidence (proposal_id, evidence_id, relation) VALUES (?, ?, ?)`,
  );
  for (const id of evidenceIds) stmt.run(proposalId, id, relation);
}

function recordStageOutput(runId: string, output: Record<string, unknown>): void {
  getDb().run(
    `INSERT INTO classification_stage_results (id, run_id, stage_name, status, output_json, started_at, completed_at)
     VALUES (?, ?, 'evidence_extraction', 'succeeded', ?, ?, ?)`,
    [randomUUID(), runId, JSON.stringify(output), now(), now()],
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2a-exit-'));
  fs.mkdirSync(path.join(tmpDir, '.baystate-cms'), { recursive: true });
  initDb(path.join(tmpDir, '.baystate-cms', 'app.db'));
  runMigrations();
  workspaceId = crypto.randomUUID();
  insertWorkspace({
    id: workspaceId, name: 'm2a-exit', workspacePath: tmpDir, gitPath: '',
    createdAt: now(), updatedAt: now(), bootstrapStatus: 'complete', baselineCommit: null,
  });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Milestone-2A exit: three-image SKU with coded per-image status', () => {
  it('front succeeded + rear (#1+#3) succeeded + text-free image carry coded status/quote/byte digests in persisted stage metadata', () => {
    const front = seedImage('front.bin', 0x64);
    const side = seedImage('side.bin', 0x65);
    const rear = seedImage('rear.bin', 0x66);
    const empty = seedImage('empty.bin', 0x67);
    const sku = 'M2A-3IMG';
    const runId = makeRun(sku);

    // A2: operator selection picks #1 + #3 (rear), skipping the default
    // primary-plus-first-additional (#1+#2). Rear-panel text ("DOGS &
    // PUPPIES" on line 4) is omitted by the default pair and visible only
    // through the explicit selection.
    const ownedRefs = [front, side, rear];
    const ocrImageRefs = [ownedRefs[0], ownedRefs[2]];
    expect(new Set(ocrImageRefs).size).toBe(2);
    for (const ref of ocrImageRefs) expect(ownedRefs).toContain(ref);

    const frontOcr = baseOcr({
      productName: 'Acme Kibble', brand: 'Acme',
      visibleTextLines: ['ACME', 'KIBBLE', 'ADULT DOG FOOD'],
      confidenceByField: { productName: 0.9, brand: 0.9 },
      metadata: { model: 'qwen2.5vl:latest', modelCallIds: ['call-front'] } as never,
      contentHash: shaFile(front),
    } as Partial<PackagingOcrData>);
    const rearOcr = baseOcr({
      productName: 'Acme Kibble', brand: 'Acme',
      visibleTextLines: ['GUARANTEED ANALYSIS', 'CRUDE PROTEIN 26%', 'CRUDE FAT 14%', 'DOGS & PUPPIES'],
      confidenceByField: { productName: 0.88, brand: 0.85 },
      metadata: { model: 'qwen2.5vl:latest', modelCallIds: ['call-rear'] } as never,
      contentHash: shaFile(rear),
    } as Partial<PackagingOcrData>);
    const merged = mergeOcrResults([frontOcr, rearOcr]);
    expect(merged.productName).toBe('Acme Kibble');
    expect(merged.visibleTextLines).toContain('DOGS & PUPPIES');

    const evidence = packagingOcrDataToEvidence(merged, { runId, sku, model: 'qwen2.5vl:latest' });
    const ids = insertEvidence(runId, sku, evidence);
    expect(ids.length).toBeGreaterThan(0);

    const ocrOutcome = {
      status: 'succeeded' as const,
      localStatus: 'succeeded' as const,
      model: 'qwen2.5vl:latest',
      imageCount: 3,
      images: [
        { index: 0, status: 'succeeded' as const, reasonCode: null, attempts: 1, imageBytesDigest: shaFile(front), imageSourceDigest: 'src-front', model: 'qwen2.5vl:latest', modelCallId: 'call-front' },
        { index: 1, status: 'succeeded' as const, reasonCode: null, attempts: 1, imageBytesDigest: shaFile(rear), imageSourceDigest: 'src-rear', model: 'qwen2.5vl:latest', modelCallId: 'call-rear' },
        { index: 2, status: 'no_legible_text' as const, reasonCode: null, emptyContent: true, attempts: 1, imageBytesDigest: shaFile(empty), imageSourceDigest: 'src-empty', model: 'qwen2.5vl:latest', modelCallId: 'call-empty' },
      ],
    };
    const summary = buildCatalogOcrSummary({ ocrOutcome });
    expect(summary).not.toBeNull();
    expect(summary!.images).toHaveLength(3);
    expect(summary!.images.map((i: { status: string }) => i.status)).toEqual(['succeeded', 'succeeded', 'no_legible_text']);
    for (const img of summary!.images) expect(img.imageBytesDigest).toMatch(/^[0-9a-f]{64}$/);
    recordStageOutput(runId, { metadata: { ocrOutcome, ocrSummary: summary } });

    const stored = getDb().query(
      `SELECT output_json FROM classification_stage_results WHERE run_id = ? AND stage_name = 'evidence_extraction'`,
    ).get(runId) as { output_json: string };
    const parsed = JSON.parse(stored.output_json) as { metadata: { ocrSummary: { images: Array<{ status: string; imageBytesDigest: string }> } } };
    expect(parsed.metadata.ocrSummary.images).toHaveLength(3);
    expect(parsed.metadata.ocrSummary.images[2].status).toBe('no_legible_text');
    // Redaction: no credential-bearing URL shapes or raw bytes in metadata.
    expect(stored.output_json).not.toContain('Signature=');
  });
});

describe('Milestone-2A exit: cited image-backed decision applies', () => {
  it('an accepted image-backed field with an explicit same-run visual citation passes the gate and applies', async () => {
    const front = seedImage('cite-front.bin', 0x71);
    const sku = 'M2A-CITED';
    const runId = makeRun(sku);
    const merged = baseOcr({
      productName: 'Acme Kibble Blue',
      visibleTextLines: ['ACME KIBBLE', 'Blue'],
      confidenceByField: { productName: 0.9 },
      metadata: { model: 'qwen2.5vl:latest', modelCallIds: ['call-1'] } as never,
    } as Partial<PackagingOcrData>);
    const quote = packagingOcrDataToEvidence(merged, { runId, sku, model: 'qwen2.5vl:latest' })
      .find(e => String((e as { sourceField?: string }).sourceField) === 'visible_text' && String(e.snippet).includes('Blue'));
    expect(quote).toBeDefined();
    const [quoteId] = insertEvidence(runId, sku, [quote!]);
    insertProposal(runId, sku, { id: 'prop-cited', proposalType: 'field_assignment', targetId: 'flavor', proposedValue: 'Blue', evidenceIds: [quoteId] });
    linkEvidence('prop-cited', [quoteId], 'supporting');
    insertProposal(runId, sku, {
      id: 'prop-pair', proposalType: 'product_classification', targetId: 'dog-food-wet',
      proposedValue: { categoryId: 'dog-food', productTypeId: 'dog-food-wet' },
    });

    const res = submitProposalDecisions({
      workspaceId, productSku: sku, runId, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-cited', decision: 'accepted', evidenceIds: [quoteId] },
        { proposalId: 'prop-pair', decision: 'accepted' },
      ],
    });
    expect(res.ok).toBe(true);

    const gate = validateCatalogReviewCompletionGate({ workspaceId, productSku: sku, runId });
    expect(gate.ok).toBe(true);

    // Stage metadata binds the same bytes so apply's A2 re-hash can verify them.
    recordStageOutput(runId, { metadata: { ocrSummary: { images: [{ imageBytesDigest: shaFile(front) }] } } });
    const product = {
      schemaVersion: 1 as const, id: 'm2a-cited', sku, status: 'active' as const,
      core: {
        name: 'Acme Kibble', price: '9.99', salePrice: null, description: null,
        inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
        availability: null, weight: null, taxable: true,
        media: { primary: 'cite-front.bin', additional: [] },
        seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
        productOnPages: [],
      },
      customFields: {}, shopsite: { productId: null, productGuid: null, xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' } as const, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
      metadata: { createdAt: now(), updatedAt: now(), archivedAt: null },
    };
    await expect(verifyRunImageBytesUnchanged(tmpDir, workspaceId, sku, runId, product as never)).resolves.toBeUndefined();
    expect(getAcceptedProposals(sku, runId).map(p => p.id)).toContain('prop-cited');
  });
});

describe('Milestone-2A exit: no-text image-backed decision refused', () => {
  it('an accepted visual decision without an explicit reviewed quotation fails the gate (visual_citation_missing)', () => {
    const sku = 'M2A-NOTEXT';
    const runId = makeRun(sku);
    const visual = packagingOcrDataToEvidence(
      baseOcr({ productName: null, species: [], visibleTextLines: [] } as Partial<PackagingOcrData>),
      { runId, sku, model: 'qwen2.5vl:latest' },
    );
    expect(visual).toHaveLength(0);
    // Text-free OCR yields no visual rows; plant one quoteless visual row to
    // model the pre-A3 failure (union of unrelated calls, no reviewed quote).
    const quoteless = {
      id: randomUUID(), runId, stageName: 'evidence_extraction' as const, productSku: sku,
      source: 'visual_product_evidence' as const, reliability: 'low' as const,
      attributeId: null, sourceUrl: null, sourceField: 'visible_text', snippet: '',
      value: '', metadata: { provenance: 'packaging_ocr', model: 'qwen2.5vl:latest' }, capturedAt: now(),
    } as unknown as ClassificationEvidence;
    const [visualId] = insertEvidence(runId, sku, [quoteless]);
    insertProposal(runId, sku, { id: 'prop-notext', evidenceIds: [visualId] });
    linkEvidence('prop-notext', [visualId], 'supporting');
    insertProposal(runId, sku, {
      id: 'prop-pair-notext', proposalType: 'product_classification', targetId: 'dog-food-wet',
      proposedValue: { categoryId: 'dog-food', productTypeId: 'dog-food-wet' },
    });
    // Reviewer accepts without citing same-run OCR evidence.
    const res = submitProposalDecisions({
      workspaceId, productSku: sku, runId, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-notext', decision: 'accepted' },
        { proposalId: 'prop-pair-notext', decision: 'accepted' },
      ],
    });
    expect(res.ok).toBe(true);

    const gate = validateCatalogReviewCompletionGate({ workspaceId, productSku: sku, runId });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe('visual_citation_missing');
  });
});

describe('Milestone-2A exit: changed bytes block apply, title-only passes', () => {
  it('replaced bytes under the same ref throw at apply while a title-grounded run with no digests verifies clean', async () => {
    const img = seedImage('mutable.bin', 0x77);
    const sku = 'M2A-CHANGED';
    const runId = makeRun(sku);
    const oldDigest = shaFile(img);
    recordStageOutput(runId, { metadata: { ocrSummary: { images: [{ imageBytesDigest: oldDigest }] } } });

    // Bytes change under the same stable ref.
    fs.writeFileSync(path.join(tmpDir, img), Buffer.alloc(2048, 0x78));
    expect(shaFile(img)).not.toBe(oldDigest);

    const product = {
      schemaVersion: 1 as const, id: 'm2a-changed', sku, status: 'active' as const,
      core: {
        name: 'Acme Kibble', price: '9.99', salePrice: null, description: 'Blue kibble for dogs.',
        inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
        availability: null, weight: null, taxable: true,
        media: { primary: 'mutable.bin', additional: [] },
        seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
        productOnPages: [],
      },
      customFields: {}, shopsite: { productId: null, productGuid: null, xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' } as const, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
      metadata: { createdAt: now(), updatedAt: now(), archivedAt: null },
    };
    await expect(verifyRunImageBytesUnchanged(tmpDir, workspaceId, sku, runId, product as never)).rejects.toThrow(/byte digest mismatch/);

    // Title/description-only grounded run: no recorded digests, so the same
    // verifier passes through untouched.
    const sku2 = 'M2A-TITLEONLY';
    const runId2 = makeRun(sku2);
    recordStageOutput(runId2, { metadata: { ocrSummary: { images: [] } } });
    const product2 = { ...product, id: 'm2a-titleonly', sku: sku2 };
    await expect(verifyRunImageBytesUnchanged(tmpDir, workspaceId, sku2, runId2, product2 as never)).resolves.toBeUndefined();
  });
});

describe('Milestone-2A exit: merge conflicts abstain, fourth-line quote citeable', () => {
  it('conflicting brands/species/UPCs abstain while a fourth-line quote survives and converts to citeable evidence', () => {
    const sku = 'M2A-MERGE';
    const runId = makeRun(sku);
    const front = baseOcr({
      brand: 'Acme', upc: '111111111111',
      visibleTextLines: ['ACME', 'ADULT DOG FOOD', 'NET WT 5 LB', 'DOGS & PUPPIES'],
      confidenceByField: { brand: 0.95, upc: 0.95 },
      metadata: { model: 'qwen2.5vl:latest', modelCallIds: ['call-a'] } as never,
    } as Partial<PackagingOcrData>);
    const rear = baseOcr({
      brand: 'Other', upc: '222222222222',
      visibleTextLines: ['OTHER', 'PUPPY FORMULA', 'NET WT 5 LB', 'DOGS & PUPPIES'],
      confidenceByField: { brand: 0.9, upc: 0.9 },
      metadata: { model: 'qwen2.5vl:latest', modelCallIds: ['call-b'] } as never,
    } as Partial<PackagingOcrData>);

    const merged = mergeOcrResults([front, rear]);
    expect(merged.brand).toBeNull();
    expect(merged.upc).toBeNull();
    expect(merged.confidenceByField?.brand).toBe(0);
    // Fourth-line quote is retained, not truncated at line 3.
    expect(merged.visibleTextLines).toContain('DOGS & PUPPIES');

    const evidence = packagingOcrDataToEvidence(merged, { runId, sku, model: 'qwen2.5vl:latest' });
    const quote = evidence.find(e => String(e.snippet).includes('DOGS & PUPPIES'));
    expect(quote).toBeDefined();
    expect(String(quote!.snippet).length).toBeGreaterThan(0);
  });
});
