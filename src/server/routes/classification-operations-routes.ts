import { Hono } from 'hono';
import { getCurrentWorkspace } from '../services/workspace-service';
import { getDb } from '../../db/connection';
import { getLocalRuntimeHealth } from '../../ai/local-runtime-coordinator';

const route = new Hono();

/**
 * GET /api/classification-operations - Workspace-scoped read-only aggregates.
 * P2 #26: attempt/load/empty/failure/timeout counts, local model and latency
 * buckets, text-yield by field, selected vs missing image counts, queue
 * depth, visually confirmed citation coverage. A successful model call or
 * nonempty field is NOT OCR accuracy — only the hand-verified A4 corpus
 * measures that. No raw prompts, package images, tokens, or merchant
 * identifiers in labels.
 */
route.get('/classification-operations', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const db = getDb();
  const ws = workspace.id;

  const callRows = db.query(
    `SELECT m.status AS status, m.locality AS locality, m.model AS model, m.duration_ms AS duration_ms
     FROM classification_model_calls m
     JOIN classification_runs r ON r.id = m.run_id
     WHERE r.workspace_id = ?`,
  ).all(ws) as Array<{ status: string | null; locality: string | null; model: string | null; duration_ms: number | null }>;

  const byStatus: Record<string, number> = {};
  const byLocality: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  const latencyBuckets: Record<string, number> = { p50_under_5s: 0, p50_5_30s: 0, p50_over_30s: 0 };
  for (const row of callRows) {
    const status = String(row.status ?? 'unknown');
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    const locality = String(row.locality ?? 'unknown');
    byLocality[locality] = (byLocality[locality] ?? 0) + 1;
    const model = String(row.model ?? 'unknown');
    byModel[model] = (byModel[model] ?? 0) + 1;
    if (typeof row.duration_ms === 'number') {
      if (row.duration_ms < 5000) latencyBuckets.p50_under_5s += 1;
      else if (row.duration_ms < 30000) latencyBuckets.p50_5_30s += 1;
      else latencyBuckets.p50_over_30s += 1;
    }
  }

  // Per-image coded OCR outcomes from persisted stage metadata (A1 summary).
  let textOnlyRuns = 0;
  let imageRuns = 0;
  let succeededImages = 0;
  let failedImages = 0;
  let citedVisual = 0;
  try {
    const stageRows = db.query(
      `SELECT s.output_json AS output_json
       FROM classification_stage_results s
       JOIN classification_runs r ON r.id = s.run_id
       WHERE r.workspace_id = ? AND s.stage_name = 'evidence_extraction'`,
    ).all(ws) as Array<{ output_json: string | null }>;
    for (const row of stageRows) {
      try {
        const parsed = JSON.parse(row.output_json ?? '{}') as {
          metadata?: { ocrSummary?: { status?: string; images?: Array<{ status?: string }> } };
        };
        const summary = parsed.metadata?.ocrSummary;
        if (!summary) {
          textOnlyRuns += 1;
          continue;
        }
        imageRuns += 1;
        for (const image of summary.images ?? []) {
          if (image.status === 'succeeded') succeededImages += 1;
          else failedImages += 1;
        }
      } catch {
        textOnlyRuns += 1;
      }
    }
    const cited = db.query(
      `SELECT COUNT(*) AS cnt FROM classification_proposal_evidence pe
       JOIN classification_evidence e ON e.id = pe.evidence_id
       JOIN classification_runs r ON r.id = e.run_id
       WHERE r.workspace_id = ? AND e.source = 'visual_product_evidence' AND pe.relation = 'supporting'`,
    ).get(ws) as { cnt: number };
    citedVisual = Number(cited?.cnt ?? 0);
  } catch {
    // Missing tables (older DBs): report zeros, never throw.
  }

  const health = getLocalRuntimeHealth();

  return c.json({
    workspaceId: ws,
    modelCalls: { total: callRows.length, byStatus, byLocality, byModel, latencyBuckets },
    ocr: {
      textOnlyRuns,
      imageRuns,
      succeededImages,
      failedImages,
      citedVisualSupporting: citedVisual,
      note: 'A successful model call or nonempty field is not OCR accuracy; only the hand-verified A4 corpus measures that.',
    },
    queue: {
      activeRequests: health.concurrency.activeRequests,
      queuedRequests: health.concurrency.queuedRequests,
      maxConcurrency: health.concurrency.maxConcurrency,
    },
  });
});

export default route;
