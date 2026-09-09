/**
 * P1-T1 structured OCR attempt results — coded failure taxonomy, bounded
 * transport retry, and circuit-breaker wiring in runPackagingOcrAttempt.
 *
 * DB-backed (bun:test) because src/onboarding/packaging-ocr.ts transitively
 * imports bun:sqlite repositories (same reason packaging-ocr.test.ts and
 * vlm-client.test.ts run under `bun test`, not vitest).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import { upsertProviderConnection, upsertWorkloadRoute } from '../../db/repositories/provider-connection-repo';
import {
  extractPackagingOcr,
  runPackagingOcrAttempt,
} from '../../onboarding/packaging-ocr';
import {
  buildCircuitBreakerKey,
  recordTransportFailure,
  resetCircuitBreakers,
  getCircuitBreakerStats,
} from '../../onboarding/vlm-circuit-breaker';
import { HeartbeatLostError } from '../../classification/heartbeat-errors';
import {
  overrideOcrStageFlags,
  resetOcrStageFlagsOverride,
} from '../../classification/ocr-stage-flags';
import { generateCandidate } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { buildRuntimeSnapshot, requireModelCallContext } from '../../classification/runtime-snapshot';
import { sha256Hex } from '../../shared/stable-id';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createRun } from '../../db/repositories/classification-run-repo';
import type { CatalogEvidence } from '../../classification/catalog-evidence';

let tmpDir: string;

const LEGACY_BASE = 'http://localhost:11434';
const LEGACY_MODEL = 'qwen2.5vl:latest';

function seedLegacyVlm() {
  upsertApiKey('ollama_vlm', 'enabled', LEGACY_BASE, LEGACY_MODEL);
}

/** Local >1KiB image so no remote image fetch is needed. */
function seedLocalImage(): string {
  const imgPath = path.join(tmpDir, 'img.bin');
  fs.writeFileSync(imgPath, Buffer.alloc(2048, 0x64));
  return imgPath;
}

type TransportMock = {
  fn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  calls: () => number;
};

/** Transport that always rejects like a VLM timeout. */
function timeoutTransport(): TransportMock {
  let calls = 0;
  return {
    calls: () => calls,
    fn: (async () => {
      calls += 1;
      const err = new Error('The operation was aborted.');
      err.name = 'TimeoutError';
      throw err;
    }) as unknown as (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  };
}

/** Transport that resolves an Ollama-native chat response with given content. */
function contentTransport(content: string): TransportMock {
  let calls = 0;
  return {
    calls: () => calls,
    fn: (async () => {
      calls += 1;
      return new Response(JSON.stringify({ message: { content } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  };
}

function httpStatusTransport(status: number, body: string): TransportMock {
  let calls = 0;
  return {
    calls: () => calls,
    fn: (async () => {
      calls += 1;
      return new Response(body, { status, headers: { 'content-type': 'application/json' } });
    }) as unknown as (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  };
}

/** Mock IMAGE-fetch transport returning one canned response (FIX-I tests). */
function imageResponseTransport(body: string, contentType: string): TransportMock {
  let calls = 0;
  return {
    calls: () => calls,
    fn: (async () => {
      calls += 1;
      return new Response(body, { status: 200, headers: { 'content-type': contentType } });
    }) as unknown as (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  };
}

function makeParams(overrides: Record<string, unknown> = {}) {
  const imgPath = seedLocalImage();
  return {
    imageUrl: 'https://example.com/img.jpg',
    imageLocalPath: path.basename(imgPath),
    workspacePath: tmpDir,
    sku: 'SKU-ATTEMPT',
    modelFetchFn: undefined,
    ...overrides,
  } as Parameters<typeof runPackagingOcrAttempt>[0];
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-attempt-'));
  initDb(path.join(tmpDir, '.baystate-cms', 'app.db'));
  runMigrations();
  resetCircuitBreakers();
});

afterEach(() => {
  closeDb();
  resetCircuitBreakers();
  resetOcrStageFlagsOverride();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.BAYSTATE_CMS_OCR_RETRIES_ENABLED;
});

// ─── coded failures ────────────────────────────────────────────────────────────

describe('runPackagingOcrAttempt — coded failure taxonomy', () => {
  it('returns not_configured when the VLM is not configured (fresh DB)', async () => {
    const result = await runPackagingOcrAttempt(makeParams());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('not_configured');
      expect(result.redactedMessage.length).toBeGreaterThan(0);
      expect(result.attempts).toBe(0);
    }
  });

  it('classifies a VLM timeout as timeout (default: no retry)', async () => {
    seedLegacyVlm();
    const transport = timeoutTransport();
    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('timeout');
      expect(result.attempts).toBe(1);
    }
    expect(transport.calls()).toBe(1);
  });

  it('classifies HTTP 500 as http_error with the status encoded separately', async () => {
    seedLegacyVlm();
    const transport = httpStatusTransport(500, '{"error":"boom"}');
    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('http_error');
      expect(result.httpStatus).toBe(500);
      expect(result.attempts).toBe(1);
    }
    expect(transport.calls()).toBe(1);
  });

  it('classifies an empty VLM response as empty_response', async () => {
    seedLegacyVlm();
    const transport = contentTransport('');
    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('empty_response');
    }
    expect(transport.calls()).toBe(1);
  });

  it('classifies prose-only output as unparseable_json', async () => {
    seedLegacyVlm();
    const transport = contentTransport('This package appears to contain dog treats.');
    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('unparseable_json');
    }
    expect(transport.calls()).toBe(1);
  });

  it('classifies schema-invalid metadata as schema_coercion_failed', async () => {
    seedLegacyVlm();
    // imageSourceUrl is typed string|null but runtime JS allows a number —
    // it flows into metadata.imageSourceUrl and breaks PackagingOcrDataSchema.
    const result = await runPackagingOcrAttempt(
      makeParams({
        imageSourceUrl: 4242,
        modelFetchFn: contentTransport('{"productName":"Valid Name"}').fn,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('schema_coercion_failed');
    }
  });

  it('reports circuit_open with zero transport when the breaker is tripped for this route', async () => {
    seedLegacyVlm();
    const key = buildCircuitBreakerKey(LEGACY_BASE, LEGACY_MODEL);
    recordTransportFailure(key);
    recordTransportFailure(key);
    recordTransportFailure(key);
    const transport = contentTransport('{"productName":"Never Called"}');
    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('circuit_open');
    }
    expect(transport.calls()).toBe(0);
  });
});

// ─── FIX-I round 3: textual/SVG payload rejection before transport ────────────

describe('runPackagingOcrAttempt — FIX-I non-raster payload rejection', () => {
  it('rejects a remote HTML-markup payload with image_svg_unsupported and NO VLM transport call', async () => {
    seedLegacyVlm();
    const html = '<!DOCTYPE html><html><head><title>error page</title></head><body>not an image</body></html>' +
      'padding-padding-padding'; // > 1 KiB so the too-small gate never fires first
    const imgFetch = imageResponseTransport(html, 'Text/HTML; charset=utf-8'); // case-mixed on purpose
    const vlmTransport = contentTransport('{"productName":"Never Called"}');
    const result = await runPackagingOcrAttempt(
      makeParams({ imageLocalPath: null, fetchFn: imgFetch.fn, modelFetchFn: vlmTransport.fn }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('image_svg_unsupported');
      expect(result.redactedMessage).toContain('not a raster image');
      expect(result.attempts).toBe(0);
    }
    expect(imgFetch.calls()).toBe(1);
    expect(vlmTransport.calls()).toBe(0);
  });

  it('ACCEPTS a valid PNG whose early tEXt metadata contains markup-like strings (signature-first ordering)', async () => {
    seedLegacyVlm();
    // Minimal valid PNG: signature + IHDR + a tEXt chunk whose payload embeds
    // "<svg" and "<!doctype html" — must NOT be rejected by the markup scan.
    // CRCs are zero-filled: the loader never validates them.
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(1, 0); ihdrData.writeUInt32BE(1, 4);
    ihdrData[8] = 8; // bit depth
    const ihdrChunk = Buffer.concat([
      Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR', 'latin1'), ihdrData, Buffer.from([0, 0, 0, 0]),
    ]);
    const textPayload = Buffer.from('Comment\u0000see <svg> or <!doctype html> docs', 'latin1');
    const textChunk = Buffer.concat([
      Buffer.from([0]), Buffer.from([0, 0]), Buffer.from([0, textPayload.length]),
      Buffer.from('tEXt', 'latin1'), textPayload, Buffer.from([0, 0, 0, 0]),
    ]);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ihdrChunk, textChunk,
      // Trailing padding: the OCR loader enforces a 1 KiB minimum size and
      // never parses PNG chunk structure, so trailing bytes are inert here.
      Buffer.alloc(2048, 0),
    ]);
    fs.writeFileSync(path.join(tmpDir, 'meta.png'), png);
    const vlmTransport = contentTransport('{"productName":"Real Raster"}');
    const result = await runPackagingOcrAttempt(
      makeParams({ imageLocalPath: 'meta.png', modelFetchFn: vlmTransport.fn }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.productName).toBe('Real Raster');
    expect(vlmTransport.calls()).toBe(1);
  });

  it('rejects a local <svg …> file with image_svg_unsupported and NO VLM transport call', async () => {
    seedLegacyVlm();
    const svgPath = path.join(tmpDir, 'img.svg');
    fs.writeFileSync(svgPath, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', 'utf8'));
    fs.appendFileSync(svgPath, Buffer.alloc(2048, 0x20)); // push past the 1 KiB minimum
    const vlmTransport = contentTransport('{"productName":"Never Called"}');
    const result = await runPackagingOcrAttempt(
      makeParams({ imageLocalPath: path.basename(svgPath), modelFetchFn: vlmTransport.fn }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('image_svg_unsupported');
      expect(result.redactedMessage).toContain('not a raster image');
      expect(result.attempts).toBe(0);
    }
    expect(vlmTransport.calls()).toBe(0);
  });
});

// ─── success + legacy adapter ──────────────────────────────────────────────────

describe('runPackagingOcrAttempt success & extractPackagingOcr adapter', () => {
  it('returns coded success with data bound to a content hash', async () => {
    seedLegacyVlm();
    const result = await runPackagingOcrAttempt(
      makeParams({
        modelFetchFn: contentTransport('{"productName":"Feline Wormeze Liquid","species":["cat"]}').fn,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.productName).toBe('Feline Wormeze Liquid');
      expect(result.data.species).toEqual(['cat']);
      expect(typeof result.data.contentHash).toBe('string');
      expect(result.data.contentHash!.length).toBe(64);
      expect(result.attempts).toBe(1);
    }
  });

  it('adapter extractPackagingOcr still returns null on failure and data on success', async () => {
    seedLegacyVlm();

    // Failure → null (HTTP 500).
    const failing = await extractPackagingOcr(
      makeParams({ modelFetchFn: httpStatusTransport(500, '{"error":"boom"}').fn }),
    );
    expect(failing).toBeNull();

    // Not configured → null.
    // (fresh route bucket needed after the 500 above fed the breaker once)
    resetCircuitBreakers();

    // Success → data with contentHash.
    const ok = await extractPackagingOcr(
      makeParams({
        modelFetchFn: contentTransport('{"productName":"Canine Wormeze Liquid"}').fn,
      }),
    );
    expect(ok).not.toBeNull();
    expect(ok!.productName).toBe('Canine Wormeze Liquid');
    expect(ok!.contentHash).not.toBeNull();
  });
});

// ─── bounded transport retry ───────────────────────────────────────────────────

describe('bounded transport retry (BAYSTATE_CMS_OCR_RETRIES_ENABLED)', () => {
  it('retries a transient timeout ONCE and succeeds (max 2 attempts total)', async () => {
    seedLegacyVlm();
    process.env.BAYSTATE_CMS_OCR_RETRIES_ENABLED = 'true';
    let calls = 0;
    const transport = (async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('The operation was aborted.');
        err.name = 'TimeoutError';
        throw err;
      }
      return new Response(JSON.stringify({ message: { content: '{"productName":"Retried OK"}' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.productName).toBe('Retried OK');
      expect(result.attempts).toBe(2);
    }
    expect(calls).toBe(2);
  });

  it('gives up after 2 total attempts when both transient tries fail', async () => {
    seedLegacyVlm();
    process.env.BAYSTATE_CMS_OCR_RETRIES_ENABLED = 'true';
    const transport = timeoutTransport();
    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('timeout');
      expect(result.attempts).toBe(2);
    }
    expect(transport.calls()).toBe(2);
  });

  it('NEVER retries deterministic parse failures even when retries are enabled', async () => {
    seedLegacyVlm();
    process.env.BAYSTATE_CMS_OCR_RETRIES_ENABLED = 'true';
    const transport = contentTransport('No JSON anywhere in this response.');
    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('unparseable_json');
      expect(result.attempts).toBe(1);
    }
    expect(transport.calls()).toBe(1);
  });

  it('does not retry at all when the flag is unset (default OFF)', async () => {
    seedLegacyVlm();
    const transport = timeoutTransport();
    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toBe(1);
    }
    expect(transport.calls()).toBe(1);
  });

  it('does not retry non-transient HTTP errors (e.g. 404) even when enabled', async () => {
    seedLegacyVlm();
    process.env.BAYSTATE_CMS_OCR_RETRIES_ENABLED = 'true';
    const transport = httpStatusTransport(404, '{"error":"missing"}');
    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('http_error');
      expect(result.httpStatus).toBe(404);
      expect(result.attempts).toBe(1);
    }
    expect(transport.calls()).toBe(1);
  });

  it('retry flag via in-memory OVERRIDE enables retries without any env (post-review fixup 7a)', async () => {
    seedLegacyVlm();
    delete process.env.BAYSTATE_CMS_OCR_RETRIES_ENABLED;
    overrideOcrStageFlags({ packagingOcrRetriesEnabled: true });
    let calls = 0;
    const transport = (async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('The operation was aborted.');
        err.name = 'TimeoutError';
        throw err;
      }
      return new Response(JSON.stringify({ message: { content: '{"productName":"Override Retry OK"}' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toBe(2);
    }
    expect(calls).toBe(2);
  });
});

// ─── circuit breaker determinism (post-review fixup 1) ───────────────────────

describe('circuit breaker ignores deterministic HTTP failures', () => {
  it('does NOT open the circuit after three consecutive HTTP 404 responses', async () => {
    seedLegacyVlm();
    const transport = httpStatusTransport(404, '{"error":"missing"}');

    // Three consecutive deterministic 404s — the OLD behavior fed each into
    // the breaker and tripped it (threshold = 3).
    for (let i = 0; i < 3; i++) {
      const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reasonCode).toBe('http_error');
        expect(result.httpStatus).toBe(404);
      }
    }

    // Breaker stats unchanged: no failure streak recorded for the route.
    const key = buildCircuitBreakerKey(LEGACY_BASE, LEGACY_MODEL);
    const stats = getCircuitBreakerStats()[key];
    expect(stats === undefined || stats.state === 'closed').toBe(true);
    expect(stats?.consecutiveTransportFailures ?? 0).toBe(0);

    // The next attempt still REACHES the transport (no circuit_open short-circuit).
    const fourth = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) {
      expect(fourth.reasonCode).toBe('http_error');
    }
    expect(transport.calls()).toBe(4);
  });
});

// ─── loader containment (FIX-4) ───────────────────────────────────────────────

describe('loadImageWithReason workspace containment', () => {
  it('reads a basename local candidate inside the workspace (existing behavior kept)', async () => {
    seedLegacyVlm();
    const transport = contentTransport('{"productName":"Contained OK"}');
    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.productName).toBe('Contained OK');
    expect(transport.calls()).toBe(1);
  });

  it('rejects an ABSOLUTE imageLocalPath pointing outside the workspace', async () => {
    seedLegacyVlm();
    // A readable image OUTSIDE the workspace — the loader must never touch it.
    const outsidePath = path.join(path.dirname(tmpDir), `outside-${path.basename(tmpDir)}.bin`);
    fs.writeFileSync(outsidePath, Buffer.alloc(2048, 0x64));
    try {
      // Non-remote imageUrl ⇒ after both contained local strategies fail, the
      // attempt ends as a coded no_image WITHOUT any transport.
      const result = await runPackagingOcrAttempt(makeParams({
        imageUrl: 'definitely-missing-inside-workspace.bin',
        imageLocalPath: outsidePath,
        modelFetchFn: contentTransport('{"productName":"MUST NOT RUN"}').fn,
      }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe('no_image');
    } finally {
      fs.rmSync(outsidePath, { force: true });
    }
  });

  it('rejects an ABSOLUTE imageLocalPath even when it points INSIDE the workspace (FIX-A round 2)', async () => {
    seedLegacyVlm();
    // The file exists and is readable INSIDE tmpDir — but absolute candidates
    // are rejected outright, so no transport may run.
    const result = await runPackagingOcrAttempt(makeParams({
      imageUrl: 'definitely-missing-inside-workspace.bin',
      imageLocalPath: seedLocalImage(),
      modelFetchFn: contentTransport('{"productName":"MUST NOT RUN"}').fn,
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe('no_image');
  });

  it('rejects a workspace symlink that resolves OUTSIDE the workspace (FIX-A round 2)', async () => {
    seedLegacyVlm();
    // Real payload lives OUTSIDE tmpDir; a symlink INSIDE tmpDir points at it.
    const outsidePath = path.join(path.dirname(tmpDir), `outside-${path.basename(tmpDir)}.bin`);
    fs.writeFileSync(outsidePath, Buffer.alloc(2048, 0x64));
    const linkPath = path.join(tmpDir, 'escape-link.bin');
    try {
      fs.symlinkSync(outsidePath, linkPath);
      const result = await runPackagingOcrAttempt(makeParams({
        imageUrl: 'definitely-missing-inside-workspace.bin',
        imageLocalPath: 'escape-link.bin',
        modelFetchFn: contentTransport('{"productName":"MUST NOT RUN"}').fn,
      }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasonCode).toBe('no_image');
    } finally {
      fs.rmSync(linkPath, { force: true });
      fs.rmSync(outsidePath, { force: true });
    }
  });

  it('still loads a legitimate RELATIVE candidate inside the workspace (FIX-A round 2)', async () => {
    seedLegacyVlm();
    const transport = contentTransport('{"productName":"Relative Still OK"}');
    const result = await runPackagingOcrAttempt(makeParams({ modelFetchFn: transport.fn }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.productName).toBe('Relative Still OK');
    expect(transport.calls()).toBe(1);
  });

  it('rejects a ../ traversal imageLocalPath that escapes the workspace', async () => {
    seedLegacyVlm();
    const result = await runPackagingOcrAttempt(makeParams({
      imageUrl: 'definitely-missing-inside-workspace.bin',
      // ../img.bin escapes tmpDir (the workspace) even though the target exists.
      imageLocalPath: `..${path.sep}${path.basename(seedLocalImage())}`,
      modelFetchFn: contentTransport('{"productName":"MUST NOT RUN"}').fn,
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonCode).toBe('no_image');
  });

  it('still normalizes interior .. segments that stay INSIDE the workspace', async () => {
    seedLegacyVlm();
    const imgName = path.basename(seedLocalImage());
    const transport = contentTransport('{"productName":"Interior DotDot OK"}');
    const result = await runPackagingOcrAttempt(makeParams({
      imageLocalPath: `sub${path.sep}..${path.sep}${imgName}`,
      modelFetchFn: transport.fn,
    }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.productName).toBe('Interior DotDot OK');
  });
});

// ─── heartbeat-loss propagation (post-review fixup 2) ─────────────────────────

/** Minimal catalog evidence fixture (mirrors cohort-freeze.test.ts). */
const HB_EVIDENCE: CatalogEvidence = {
  schemaVersion: 1,
  sourceTreeHash: '0'.repeat(64),
  productFileCount: 0,
  parseFailureCount: 0,
  parseFailures: [],
  fieldRegistry: { entryCount: 0, xmlFields: [] },
  fields: [],
  pages: [],
};

/** Build a run-bound (schema-v2) snapshot + child run + audit context so the
 *  transport writes durable started/terminal rows and honors `assertHeld`. */
function makeRunBoundContext(sku: string) {
  const HB_BASE = 'http://127.0.0.1:9'; // loopback ⇒ policy-permitted; transport is injected anyway
  upsertApiKey('ollama_vlm', 'enabled', HB_BASE, LEGACY_MODEL);
  const workspaceId = crypto.randomUUID();
  insertWorkspace({
    id: workspaceId,
    name: 'hb',
    workspacePath: tmpDir,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
  const candidate = generateCandidate(BayStatePetGardenSeed, HB_EVIDENCE);
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
      createdAt: new Date().toISOString(),
    },
    sourceProductHash: '',
  });
  const run = createRun(workspaceId, sku, null, null, { sourceKind: 'onboarding' });
  const modelCall = requireModelCallContext(snapshot, String(run.id), 'evidence_extraction', 1);
  if (!modelCall) throw new Error('expected a compatible frozen plan for the heartbeat test');
  return { snapshot, modelCall };
}

describe('runPackagingOcrAttempt propagates HeartbeatLostError from the terminal write', () => {
  it('rejects with HeartbeatLostError when assertHeld throws during the terminal write after a transport failure', async () => {
    seedLegacyVlm();
    const { snapshot, modelCall } = makeRunBoundContext('SKU-HB-LOST');
    let terminalWriteAttempts = 0;
    const pending = runPackagingOcrAttempt(
      makeParams({
        modelCall,
        snapshot,
        modelFetchFn: httpStatusTransport(500, '{"error":"boom"}').fn,
        assertHeld: () => {
          terminalWriteAttempts += 1;
          throw new HeartbeatLostError('cohort lease lost to a reclaiming sibling');
        },
      }),
    );
    // The ownership loss must PROPAGATE out of the attempt (not be swallowed).
    await expect(pending).rejects.toBeInstanceOf(HeartbeatLostError);
    expect(terminalWriteAttempts).toBe(1);
  });

  it('still swallows non-ownership errors from the best-effort terminal write', async () => {
    seedLegacyVlm();
    const result = await runPackagingOcrAttempt(
      makeParams({
        modelFetchFn: httpStatusTransport(500, '{"error":"boom"}').fn,
        assertHeld: () => {
          throw new Error('some other durable-write failure');
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('http_error');
    }
  });
});

// ─── P2 metadata redaction: raw image-source refs never persisted ─────────────

describe('runPackagingOcrAttempt — P2 metadata redaction', () => {
  it('persists a stripped imageSourceUrl + sha256 digest, never the raw credential/query-bearing ref', async () => {
    seedLegacyVlm();
    const rawRef = 'https://key-123:topsecret@example.com/signed/primary.jpg?Signature=abc&Expires=42';
    const result = await runPackagingOcrAttempt(
      makeParams({
        imageUrl: 'https://example.com/img.jpg',
        imageSourceUrl: rawRef,
        modelFetchFn: contentTransport('{"productName":"Redacted Provenance"}').fn,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const meta = result.data.metadata as Record<string, unknown> | null;
    expect(typeof meta?.imageSourceUrl).toBe('string');
    const redacted = meta!.imageSourceUrl as string;
    expect(redacted).toBe('https://example.com/signed/primary.jpg');
    expect(redacted).not.toContain('key-123');
    expect(redacted).not.toContain('topsecret');
    expect(redacted).not.toContain('Signature=abc');
    // Exact provenance stays recoverable only via the digest.
    expect(meta?.imageSourceDigest).toBe(sha256Hex(rawRef));
  });
});

// ─── Cloud VLM endpoints and locality discipline ──────────────────────────────

describe('runPackagingOcrAttempt — cloud VLM endpoints and locality discipline', () => {
  it('allows cloud VLM endpoint when imageDataSharing is cloud_allowed, passes auth and records cloud locality', async () => {
    upsertProviderConnection({
      id: 'openai-cloud',
      label: 'OpenAI Cloud',
      transport: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      credential: 'sk-test-secret-key-12345',
      trustZone: 'cloud',
      approvedHost: 'api.openai.com',
      approvedPort: 443,
      enabled: true,
      connectTimeoutMs: 2000,
      inferenceTimeoutMs: 60000,
    });
    upsertWorkloadRoute('visionOcr', {
      primary: { connectionId: 'openai-cloud', modelId: 'gpt-4o' },
      fallback: null,
      textDataSharing: 'this_device_only',
      imageDataSharing: 'cloud_allowed',
      terminalBehavior: 'heuristic',
    });

    const workspaceId = crypto.randomUUID();
    insertWorkspace({
      id: workspaceId,
      name: 'cloud-test-ws',
      workspacePath: tmpDir,
      gitPath: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    const candidate = generateCandidate(BayStatePetGardenSeed, HB_EVIDENCE);
    const bundle = {
      ...candidate.bundle,
      modelPolicy: {
        ...candidate.bundle.modelPolicy,
        imageDataSharing: 'cloud_allowed' as const,
        stageOverrides: {
          evidence_extraction: {
            provider: 'openai',
            model: 'gpt-4o',
            fallbackProvider: null,
            fallbackModel: null,
          },
        },
      },
      dataSharing: {
        ...candidate.bundle.dataSharing,
        imagePolicy: 'cloud_allowed' as const,
      },
    };
    const snapshot = buildRuntimeSnapshot({
      workspaceId,
      workspacePath: tmpDir,
      productSku: 'SKU-CLOUD-OK',
      authority: { kind: 'v2' as const, bundle },
      configSnapshotRef: {
        id: bundle.manifest.bundleHash,
        hash: bundle.manifest.bundleHash,
        sourceCommit: null,
        createdAt: new Date().toISOString(),
      },
      sourceProductHash: '',
    });
    const run = createRun(workspaceId, 'SKU-CLOUD-OK', null, null, { sourceKind: 'onboarding' });
    const modelCall = requireModelCallContext(snapshot, String(run.id), 'evidence_extraction', 1);

    let capturedUrl = '';
    let capturedAuthHeader = '';
    const mockTransport = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedAuthHeader = (init?.headers as Record<string, string>)?.Authorization || '';
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  productName: 'Cloud Kibble',
                  species: ['Dog'],
                  productForm: 'Dry Food',
                  dietaryLabels: ['Grain-Free'],
                  confidenceByField: {},
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const result = await runPackagingOcrAttempt(
      makeParams({
        sku: 'SKU-CLOUD-OK',
        snapshot,
        modelCall,
        modelFetchFn: mockTransport,
      }),
    );

    expect(result.ok).toBe(true);
    expect(capturedUrl).toContain('https://api.openai.com/v1/chat/completions');
    expect(capturedAuthHeader).toBe('Bearer sk-test-secret-key-12345');

    if (result.ok) {
      expect(result.data.productName).toBe('Cloud Kibble');
      expect(result.data.metadata?.model).toBe('gpt-4o');
      const db = getDb();
      const callRow = db
        .query('SELECT * FROM classification_model_calls WHERE id = ?')
        .get(result.data.metadata!.modelCallIds![0]) as Record<string, unknown>;
      expect(callRow.provider).toBe('openai');
      expect(callRow.model).toBe('gpt-4o');
      expect(callRow.locality).toBe('cloud');
      expect(callRow.status).toBe('success');
    }
  });

  it('denies cloud VLM endpoint when imageDataSharing is local_only (fail closed)', async () => {
    upsertProviderConnection({
      id: 'openai-cloud',
      label: 'OpenAI Cloud',
      transport: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      credential: 'sk-test-secret-key-12345',
      trustZone: 'cloud',
      approvedHost: 'api.openai.com',
      approvedPort: 443,
      enabled: true,
      connectTimeoutMs: 2000,
      inferenceTimeoutMs: 60000,
    });
    upsertWorkloadRoute('visionOcr', {
      primary: { connectionId: 'openai-cloud', modelId: 'gpt-4o' },
      fallback: null,
      textDataSharing: 'this_device_only',
      imageDataSharing: 'this_device_only',
      terminalBehavior: 'heuristic',
    });

    const workspaceId = crypto.randomUUID();
    insertWorkspace({
      id: workspaceId,
      name: 'cloud-test-ws-denied',
      workspacePath: tmpDir,
      gitPath: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    const candidate = generateCandidate(BayStatePetGardenSeed, HB_EVIDENCE);
    const bundle = {
      ...candidate.bundle,
      modelPolicy: {
        ...candidate.bundle.modelPolicy,
        imageDataSharing: 'local_only' as const,
        stageOverrides: {
          evidence_extraction: {
            provider: 'openai',
            model: 'gpt-4o',
            fallbackProvider: null,
            fallbackModel: null,
          },
        },
      },
      dataSharing: {
        ...candidate.bundle.dataSharing,
        imagePolicy: 'local_only' as const,
      },
    };
    const snapshot = buildRuntimeSnapshot({
      workspaceId,
      workspacePath: tmpDir,
      productSku: 'SKU-CLOUD-DENIED',
      authority: { kind: 'v2' as const, bundle },
      configSnapshotRef: {
        id: bundle.manifest.bundleHash,
        hash: bundle.manifest.bundleHash,
        sourceCommit: null,
        createdAt: new Date().toISOString(),
      },
      sourceProductHash: '',
    });
    const run = createRun(workspaceId, 'SKU-CLOUD-DENIED', null, null, { sourceKind: 'onboarding' });
    const modelCall = requireModelCallContext(snapshot, String(run.id), 'evidence_extraction', 1);

    let transportInvoked = false;
    const mockTransport = async () => {
      transportInvoked = true;
      return new Response('{}', { status: 200 });
    };

    const result = await runPackagingOcrAttempt(
      makeParams({
        sku: 'SKU-CLOUD-DENIED',
        snapshot,
        modelCall,
        modelFetchFn: mockTransport,
      }),
    );

    expect(result.ok).toBe(false);
    expect(transportInvoked).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe('policy_denied');
    }

    const db = getDb();
    const calls = db
      .query('SELECT * FROM classification_model_calls WHERE run_id = ?')
      .all(String(run.id)) as Record<string, unknown>[];
    expect(calls.length).toBe(1);
    expect(calls[0].status).toBe('policy_denied');
  });
});
