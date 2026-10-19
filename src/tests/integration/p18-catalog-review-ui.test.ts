/**
 * P2 #18 — catalog review UI contract at the decisions/apply seam.
 *
 * Fails pre-fix: the read-only panel had no decision controls, no client
 * helper posted { expectedRevisionId, evidenceIds } citations, and nothing
 * exercised the proof shape (accept type → revise one → reject one →
 * stale revision 409 → uncited image-backed apply blocked).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createRun, completeRun, getLiveDecisionsByRun } from '../../db/repositories/classification-run-repo';
import { generateCandidate } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { buildRuntimeSnapshot, persistRuntimeSnapshot } from '../../classification/runtime-snapshot';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import { validateCatalogReviewCompletionGate } from '../../classification/review-completion-gate';
import catalogClassificationRoutes from '../../server/routes/catalog-classification-routes';

let tmpDir: string;
let workspaceId: string;
let app: Hono;
const SKU = 'P18-REVIEW-UI';

function seedRun(): string {
  const evidence: CatalogEvidence = {
    schemaVersion: 1,
    sourceTreeHash: '0'.repeat(64),
    productFileCount: 0,
    parseFailureCount: 0,
    parseFailures: [],
    fieldRegistry: { entryCount: 0, xmlFields: [] },
    fields: [],
    pages: [],
  };
  const bundle = generateCandidate(BayStatePetGardenSeed, evidence).bundle;
  const snapshot = buildRuntimeSnapshot({
    workspaceId,
    workspacePath: tmpDir,
    productSku: SKU,
    authority: { kind: 'v2' as const, bundle },
    configSnapshotRef: {
      id: bundle.manifest.bundleHash,
      hash: bundle.manifest.bundleHash,
      sourceCommit: null,
      createdAt: new Date().toISOString(),
    },
    sourceProductHash: '',
  });
  const { hash } = persistRuntimeSnapshot(snapshot);
  const db = getDb();
  const now = new Date().toISOString();
  for (const binding of bundle.classificationOutputBindings ?? []) {
    db.run(
      `INSERT OR REPLACE INTO classification_output_bindings
       (workspace_id, role, catalog_field, serialization_json, is_stale, config_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
      [workspaceId, binding.role, binding.catalogField, JSON.stringify(binding.serialization), hash, now, now],
    );
  }
  const run = createRun(workspaceId, SKU, null, hash, { sourceKind: 'catalog_product' });
  completeRun(run.id, 'completed');
  return run.id;
}

function seedProposal(runId: string, id: string, type: string, target: string | null, value: unknown, visual: string[] = []): void {
  getDb().run(
    `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at, evidence_ids_json)
     VALUES (?, ?, ?, ?, ?, ?, 0.85, 'pending', ?, ?)`,
    [id, runId, SKU, type, target, JSON.stringify(value), new Date().toISOString(), JSON.stringify(visual)],
  );
}

function seedEvidence(runId: string, id: string, source: string, snippet: string | null): void {
  getDb().run(
    `INSERT INTO classification_evidence (id, run_id, product_sku, stage_name, source, reliability, attribute_id, source_url, source_field, snippet, value_json, metadata_json, created_at)
     VALUES (?, ?, ?, 'evidence_extraction', ?, 'high', NULL, NULL, 'package', ?, ?, '{}', ?)`,
    [id, runId, SKU, source, snippet, JSON.stringify(snippet), new Date().toISOString()],
  );
}

function link(proposalId: string, evidenceId: string, relation: string): void {
  getDb().run(
    `INSERT INTO classification_proposal_evidence (proposal_id, evidence_id, relation) VALUES (?, ?, ?)`,
    [proposalId, evidenceId, relation],
  );
}

async function postDecisions(runId: string, body: unknown): Promise<Response> {
  return app.request(`/api/products/${SKU}/classification/runs/${runId}/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p18-review-ui-'));
  fs.mkdirSync(path.join(tmpDir, '.baystate-cms'), { recursive: true });
  initDb(path.join(tmpDir, '.baystate-cms', 'app.db'));
  runMigrations();
  workspaceId = crypto.randomUUID();
  insertWorkspace({
    id: workspaceId, name: 'p18', workspacePath: tmpDir, gitPath: '',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null,
  });
  app = new Hono();
  app.route('/api', catalogClassificationRoutes);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('P2 #18 review proof shape', () => {
  it('accept type, revise one, reject one, stale revision fails 409, uncited image-backed apply blocked', async () => {
    const runId = seedRun();
    // Type proposal with a text citation; field with a quoteless visual union
    // member (image-backed); second field that will be rejected.
    seedEvidence(runId, 'ev-quote', 'visual_product_evidence', 'DOGS & PUPPIES');
    seedEvidence(runId, 'ev-bare', 'visual_product_evidence', null);
    seedEvidence(runId, 'ev-conflict', 'official_product_page', 'Cotton');
    seedProposal(runId, 'prop-type', 'product_classification', 'dog-food-wet', { categoryId: 'dog-food', productTypeId: 'dog-food-wet' });
    link('prop-type', 'ev-quote', 'supporting');
    seedProposal(runId, 'prop-brand', 'field_assignment', 'brand', 'Acme', ['ev-bare']);
    link('prop-brand', 'ev-bare', 'supporting');
    link('prop-brand', 'ev-conflict', 'contradicting');
    seedProposal(runId, 'prop-flavor', 'field_assignment', 'flavor', 'Chicken');

    // 1. Accept the type with a FIXED decision id + action token.
    const acceptType = await postDecisions(runId, {
      decisions: [{ id: 'dec-type-1', proposalId: 'prop-type', decision: 'accepted', expectedRevisionId: null, evidenceIds: ['ev-quote'], actionToken: 'p18-type-a' }],
    });
    expect(acceptType.status).toBe(200);

    // 2. Revise with a genuinely different payload (note change) carrying
    // the live predecessor — this inserts dec-type-2 and supersedes dec-type-1.
    const second = await postDecisions(runId, {
      decisions: [{ id: 'dec-type-2', proposalId: 'prop-type', decision: 'accepted', expectedRevisionId: 'dec-type-1', evidenceIds: ['ev-quote'], reviewerNote: 'confirmed wet pair', actionToken: 'p18-type-b' }],
    });
    expect(second.status).toBe(200);
    const liveAfterRevise = getLiveDecisionsByRun(runId).find(d => d.proposalId === 'prop-type');
    expect(liveAfterRevise?.id).toBe('dec-type-2');

    // 3. Reject the conflicting brand.
    const reject = await postDecisions(runId, {
      decisions: [{ proposalId: 'prop-brand', decision: 'rejected', expectedRevisionId: null }],
    });
    expect(reject.status).toBe(200);

    // 4. Stale revision: a NEW token naming the superseded predecessor
    // fails 409 without disturbing the live revision.
    const stale = await postDecisions(runId, {
      decisions: [{ proposalId: 'prop-type', decision: 'rejected', expectedRevisionId: 'dec-type-1', actionToken: 'p18-type-stale' }],
    });
    expect(stale.status).toBe(409);
    const staleBody = (await stale.json()) as { error?: string; code?: string };
    expect(staleBody.code ?? staleBody.error ?? '').toMatch(/conflict|changed|supersede|stale|different payload/i);

    // Live decisions still show the second revision.
    const live = getLiveDecisionsByRun(runId).find(d => d.proposalId === 'prop-type');
    expect(live?.decision).toBe('accepted');
    expect(live?.id).toBe('dec-type-2');
  });

  it('image-backed accept without a citation is blocked at the apply gate', async () => {
    const runId = seedRun();
    seedEvidence(runId, 'ev-img', 'visual_product_evidence', 'Blue');
    seedProposal(runId, 'prop-color', 'field_assignment', 'color', 'Blue', ['ev-img']);
    link('prop-color', 'ev-img', 'supporting');
    seedProposal(runId, 'prop-pair', 'product_classification', 'dog-food-wet', { categoryId: 'dog-food', productTypeId: 'dog-food-wet' });

    // Accept the image-backed proposal WITHOUT citing the quote.
    const accepted = await postDecisions(runId, {
      decisions: [
        { proposalId: 'prop-color', decision: 'accepted', expectedRevisionId: null },
        { proposalId: 'prop-pair', decision: 'accepted', expectedRevisionId: null },
      ],
    });
    expect(accepted.status).toBe(200);

    // The completion gate (shared with the apply endpoint) must refuse:
    // image-backed but uncited.
    const gate = validateCatalogReviewCompletionGate({ workspaceId, productSku: SKU, runId });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toMatch(/visual_citation_missing/);

    // Same decision WITH the citation passes the visual-citation check.
    const decision = getLiveDecisionsByRun(runId).find(d => d.proposalId === 'prop-color');
    expect(decision).toBeDefined();
    const cited = await postDecisions(runId, {
      decisions: [{
        proposalId: 'prop-color', decision: 'accepted',
        expectedRevisionId: decision ? decision.id : null, evidenceIds: ['ev-img'],
      }],
    });
    expect(cited.status).toBe(200);
    const gate2 = validateCatalogReviewCompletionGate({ workspaceId, productSku: SKU, runId });
    // May still fail on other grounds (e.g. type gating) but never on the
    // now-satisfied visual citation.
    if (!gate2.ok) expect(gate2.code).not.toMatch(/visual_citation_missing/);
  });

  it('unused decision id placeholder keeps run id binding (route wiring sanity)', async () => {
    const runId = seedRun();
    void randomUUID();
    seedProposal(runId, 'prop-solo', 'field_assignment', 'flavor', 'Chicken');
    const res = await postDecisions(runId, {
      decisions: [{ proposalId: 'prop-solo', decision: 'rejected', expectedRevisionId: null }],
    });
    expect(res.status).toBe(200);
  });
});
