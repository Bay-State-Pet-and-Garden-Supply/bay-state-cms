import fs from 'fs';
import { randomUUID } from 'node:crypto';

const API = 'http://127.0.0.1:3030';
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface OcrSummaryImage {
  index?: number;
  status?: string;
  reasonCode?: string | null;
  attempts?: number | null;
  imageBytesDigest?: string | null;
  model?: string | null;
}

interface OcrSummary {
  status?: string;
  imageCount?: number;
  succeededImages?: number;
  model?: string | null;
  imageGateDenied?: boolean;
  images?: OcrSummaryImage[];
}

interface RunView {
  run?: { id?: string; status?: string };
  evidence?: Array<{ source: string }>;
  proposals?: Array<{ id: string; proposalType: string; targetId: string; proposedValue: unknown }>;
  stageResults?: Array<{ stage_name?: string; output_json?: string | null }>;
}

function readOcrSummary(d: RunView): OcrSummary | null {
  for (const row of d.stageResults ?? []) {
    if (row.stage_name !== 'evidence_extraction' || !row.output_json) continue;
    try {
      const parsed = JSON.parse(row.output_json) as { metadata?: { ocrSummary?: OcrSummary; ocrOutcome?: OcrSummary } };
      if (parsed.metadata?.ocrSummary) return parsed.metadata.ocrSummary;
      if (parsed.metadata?.ocrOutcome) return parsed.metadata.ocrOutcome;
    } catch {
      // Unparseable stage metadata never blocks the run summary.
    }
  }
  return null;
}

async function getClassification(sku: string): Promise<RunView> {
  const res = await fetch(`${API}/api/products/${sku}/classification`);
  return (await res.json()) as RunView;
}

// P2 #19: poll one durable run by ID (never the latest-run view, which a
// superseding run could move under us — impossible by contract, but the
// run-ID view is still the correct poll target for a queued start).
async function getRunById(sku: string, runId: string): Promise<RunView> {
  const res = await fetch(`${API}/api/products/${sku}/classification/runs/${runId}`);
  return (await res.json()) as RunView;
}

function summarize(d: RunView): void {
  console.log('run:', d.run?.id, 'status:', d.run?.status, 'props:', d.proposals?.length ?? 0);
  const counts: Record<string, number> = {};
  for (const e of d.evidence ?? []) counts[e.source] = (counts[e.source] ?? 0) + 1;
  console.log('evidence:', JSON.stringify(counts));
  // A1: coded per-image OCR disposition (redacted summary from persisted
  // stage metadata — never raw URLs, responses, or image bytes).
  const ocr = readOcrSummary(d);
  if (ocr) {
    console.log(
      `ocr: status=${ocr.status ?? 'unknown'} images=${ocr.imageCount ?? 0} succeeded=${ocr.succeededImages ?? 0}` +
      ` model=${ocr.model ?? 'none'}` +
      (ocr.imageGateDenied ? ' gate=denied(local-only)' : ''),
    );
    for (const image of ocr.images ?? []) {
      const digest = typeof image.imageBytesDigest === 'string' ? ` digest=${image.imageBytesDigest.slice(0, 12)}…` : '';
      console.log(
        `ocr-image #${image.index ?? '?'}: ${image.status ?? 'unknown'}` +
        (image.reasonCode ? ` (${image.reasonCode})` : '') +
        (typeof image.attempts === 'number' ? ` attempts=${image.attempts}` : '') +
        digest,
      );
    }
  } else {
    console.log('ocr: no summary in evidence_extraction stage metadata');
  }
  for (const p of d.proposals ?? []) {
    const tag = p.proposalType === 'reviewable_abstention' ? 'ABSTAIN' : 'REVIEW';
    console.log(tag, p.id, p.proposalType, p.targetId, '->', JSON.stringify(p.proposedValue).slice(0, 100));
  }
}

const cmd = process.argv[2];
const sku = process.argv[3];
// A2: explicit OCR image selection (up to two refs, e.g. a legible rear
// panel or third gallery image). Parsed from `--images ref1,ref2`.
const imagesFlag = process.argv.find(arg => arg.startsWith('--images='));
const ocrImageRefs = imagesFlag ? imagesFlag.slice('--images='.length).split(',').map(s => s.trim()).filter(Boolean).slice(0, 2) : undefined;
if (!cmd || !sku) {
  console.log('usage: backfill-run.ts run|show <sku> [--images=ref1,ref2]');
  process.exit(1);
}

if (cmd === 'run') {
  // P2 #19: one idempotency key per requested run, persisted beside the
  // output so a dropped POST retried with the SAME key replays the same
  // server-side run instead of superseding review. A 409 means a different
  // key (or no key) hit an active run: poll the returned runId, never re-POST.
  const keyPath = `/tmp/bf-${sku}.key`;
  let idempotencyKey: string;
  try {
    idempotencyKey = fs.readFileSync(keyPath, 'utf-8').trim();
    if (!idempotencyKey) throw new Error('empty key');
  } catch {
    idempotencyKey = randomUUID();
  }
  fs.writeFileSync(keyPath, idempotencyKey);
  let runId: string | null = null;
  let startText: string | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const startRes = await fetch(`${API}/api/products/${sku}/classification/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(ocrImageRefs ? { ocrImageRefs } : {}),
      });
      startText = await startRes.text();
      try {
        const parsed = JSON.parse(startText) as { runId?: string };
        if (typeof parsed.runId === 'string' && parsed.runId) runId = parsed.runId;
      } catch {
        // Non-JSON start text: fall through to latest-run recovery below.
      }
      if (startRes.status === 409 && !runId) {
        const cur = await getClassification(sku);
        if (cur.run?.id) runId = cur.run.id;
      }
      break;
    } catch {
      // The 202 POST never blocks on execution, but the connection can still
      // drop: retry with the SAME key (never a fresh one), then recover the
      // runId from the key replay or the latest-run view.
      if (attempt === 3) startText = null;
      else await sleep(5000);
    }
  }
  if (!runId) {
    try {
      const cur = await getClassification(sku);
      if (cur.run?.id) {
        runId = cur.run.id;
        startText = `recovered server-side run ${runId} for key ${idempotencyKey.slice(0, 8)}`;
      }
    } catch {
      /* fall through to null */
    }
  }
  console.log('start:', startText ? startText.slice(0, 200) : 'connection dropped, polling for server-side run');
  if (!runId) {
    console.log('no run id recovered; aborting (same key replays safely on retry)');
    process.exit(2);
  }
  const targetRunId: string = runId;
  const t0 = Date.now();
  for (;;) {
    await sleep(15000);
    const d = await getRunById(sku, targetRunId);
    const st = d.run?.status;
    const el = Math.round((Date.now() - t0) / 1000);
    if (st && st !== 'queued' && st !== 'running') {
      console.log(`done in ${el}s`);
      fs.writeFileSync(`/tmp/bf-${sku}.json`, JSON.stringify(d));
      summarize(d);
      break;
    }
    console.log(`... ${el}s ${st ?? 'unknown'}`);
    if (Date.now() - t0 > 20 * 60 * 1000) {
      console.log('TIMEOUT');
      process.exit(2);
    }
  }
} else if (cmd === 'show') {
  const d = await getClassification(sku);
  if (!d.run) {
    console.log('no run');
    process.exit(1);
  }
  fs.writeFileSync(`/tmp/bf-${sku}.json`, JSON.stringify(d));
  summarize(d);
} else {
  console.log('usage: backfill-run.ts run|show <sku>');
  process.exit(1);
}
