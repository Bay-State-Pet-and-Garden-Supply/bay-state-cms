#!/usr/bin/env bun
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../src/db/connection';
import { runMigrations } from '../src/db/migrations';
import {
  createDiscoveryRun,
  readDiscoveryAssessment,
  saveDiscoveryAssessment,
} from '../src/db/repositories/onboarding-source-repo';
import { createDiscoveryAssessment } from '../src/shared/schemas/discovery-assessment';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-assessment-'));
const hash = 'b'.repeat(64);
const assessment = createDiscoveryAssessment({
  version: 1,
  state: 'complete',
  approvedDomains: ['controlled.example'],
  authorityHash: hash,
  domains: [{
    domain: 'controlled.example',
    methods: [
      { method: 'local_index', state: 'complete', eligibleCount: 1, emittedCount: 1, emittedCandidateIds: ['controlled-candidate'], limit: 1, excludedCount: 0, exclusionReasons: [], failures: [], modelCallIds: [] },
      { method: 'sitemap', state: 'complete', eligibleCount: 1, emittedCount: 1, emittedCandidateIds: ['controlled-candidate'], limit: 1, excludedCount: 0, exclusionReasons: [], failures: [], modelCallIds: [] },
    ],
  }],
  candidates: [{
    candidateId: 'controlled-candidate',
    sourceHash: hash,
    outcome: 'verified',
    failure: null,
    retainedArtifactRef: 'file://controlled-artifact.html',
    artifactHash: hash,
    visibleIdentity: { name: 'Controlled product', brand: 'Controlled brand', decision: 'consistent', evidenceRefs: ['file://controlled-artifact.html#heading'] },
    variants: [],
    variantDecision: null,
  }],
  candidateCount: 1,
  assessedCount: 1,
  candidateSetHash: hash,
  sourceHashes: [hash],
  selectorIds: ['controlled-selector'],
  modelCallIds: ['controlled-model-call'],
  truncated: false,
});

try {
  const db = initDb(path.join(dir, 'smoke.sqlite'));
  runMigrations();
  runMigrations();
  const now = new Date().toISOString();
  db.query(`INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at)
    VALUES ('workspace-smoke', 'Smoke workspace', ?, ?, ?, ?)`).run(dir, dir, now, now);
  db.query(`INSERT INTO onboarding_batches (id, workspace_id, name, file_name, total_items, created_at, updated_at)
    VALUES ('batch-smoke', 'workspace-smoke', 'Smoke batch', 'controlled.csv', 2, ?, ?)`).run(now, now);
  db.query(`INSERT INTO onboarding_items (id, batch_id, upc, name, row_number, created_at, updated_at)
    VALUES ('item-smoke', 'batch-smoke', '000000000000', 'Controlled product', 1, ?, ?),
           ('other-item', 'batch-smoke', '000000000001', 'Other product', 2, ?, ?)`)
    .run(now, now, now, now);

  const oldRun = createDiscoveryRun('item-smoke', { trigger: 'automatic', upc: '000000000000', name: 'Controlled product' });
  if (!saveDiscoveryAssessment({ itemId: 'item-smoke', runId: oldRun, expectedRevision: 0 }, assessment)) {
    throw new Error('Current running run refused assessment save');
  }
  const persisted = readDiscoveryAssessment({ itemId: 'item-smoke', runId: oldRun, expectedRevision: 1 });
  if (persisted.status !== 'available' || persisted.assessment.candidateSetHash !== hash) {
    throw new Error('Assessment did not round-trip through the repository');
  }
  db.query(`UPDATE onboarding_discovery_runs SET assessment_json = '{malformed' WHERE id = ?`).run(oldRun);
  if (readDiscoveryAssessment({ itemId: 'item-smoke', runId: oldRun }).status !== 'invalid') {
    throw new Error('Malformed persisted assessment was not reported as invalid');
  }
  if (saveDiscoveryAssessment({ itemId: 'item-smoke', runId: oldRun, expectedRevision: 0 }, assessment)) {
    throw new Error('Stale assessment revision was accepted');
  }
  if (saveDiscoveryAssessment({ itemId: 'item-smoke', runId: oldRun, claimToken: 'wrong-claim' }, assessment)) {
    throw new Error('Mismatched worker claim was accepted');
  }
  if (saveDiscoveryAssessment({ itemId: 'other-item', runId: oldRun }, assessment)) {
    throw new Error('Foreign item/run binding was accepted');
  }
  const newRun = createDiscoveryRun('item-smoke', { trigger: 'refinement', upc: '000000000000', name: 'Controlled product' });
  if (saveDiscoveryAssessment({ itemId: 'item-smoke', runId: oldRun }, assessment)) {
    throw new Error('Superseded run accepted assessment');
  }
  if (readDiscoveryAssessment({ itemId: 'item-smoke', runId: oldRun }).status !== 'unknown') {
    throw new Error('Superseded assessment was exposed');
  }
  if (readDiscoveryAssessment({ itemId: 'item-smoke', runId: newRun }).status !== 'unknown') {
    throw new Error('Legacy/null assessment was not reported as unknown');
  }
  console.log('Discovery assessment disposable persistence/refusal smoke passed.');
} finally {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
}
