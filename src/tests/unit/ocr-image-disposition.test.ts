/**
 * A1 OCR input, provenance and trust gate (backfill remediation, Milestone 2A).
 *
 * DB-backed (bun:test): extractProductEvidence transitively imports
 * bun:sqlite repositories (same reason packaging-ocr-attempt.test.ts runs
 * under `bun test`, not vitest). Registered in package.json test:db +
 * vitest.config.ts exclude like its sibling suites.
 *
 * Covers, against the SHARED extractor used by catalog onboarding paths:
 * - fake local OCR success carries per-image disposition + byte digest
 *   plumbing with redacted metadata (no credential URLs, raw bytes);
 * - a textless image exposes `no_legible_text` (distinct from `failed`);
 * - an unreachable image exposes `failed` with a coded load reason;
 * - a cloud_allowed legacy snapshot with an unreachable local VLM makes
 *   zero remote vision requests (local-only fail-closed gate).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import { upsertProviderConnection, upsertWorkloadRoute } from '../../db/repositories/provider-connection-repo';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { generateCandidate } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { buildRuntimeSnapshot, requireModelCallContext } from '../../classification/runtime-snapshot';
import { createRun } from '../../db/repositories/classification-run-repo';
import { extractProductEvidence } from '../../classification/product-evidence-extractor';
import type { NormalizedEvidenceInput } from '../../classification/product-evidence-extractor';
import type { StageContext, StageInput } from '../../classification/types';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import type { RuntimeClassificationSnapshot } from '../../classification/runtime-snapshot';
import type { ModelCallContext } from '../../classification/model-operation-registry';

let tmpDir: string;
let workspaceId: string;

const LEGACY_BASE = 'http://127.0.0.1:11434';
const LEGACY_MODEL = 'qwen2.5vl:latest';

/** Local >1KiB raster-ish payload so no remote image fetch is needed. */
function seedLocalImage(name = 'img.bin'): string {
  const imgPath = path.join(tmpDir, name);
  fs.writeFileSync(imgPath, Buffer.alloc(2048, 0x64));
  return path.basename(imgPath);
}

function seedLocalVlm() {
  upsertApiKey('ollama_vlm', 'enabled', LEGACY_BASE, LEGACY_MODEL);
}

function seedLoopbackVisionRoute() {
  upsertProviderConnection({
    id: 'local-ocr-test',
    label: 'Local OCR test',
    transport: 'ollama-native',
    baseUrl: LEGACY_BASE,
    credential: null,
    trustZone: 'this_device',
    approvedHost: '127.0.0.1',
    approvedPort: 11434,
    enabled: true,
    connectTimeoutMs: 2000,
    inferenceTimeoutMs: 60000,
  });
  upsertWorkloadRoute('visionOcr', {
    primary: { connectionId: 'local-ocr-test', modelId: LEGACY_MODEL },
    fallback: null,
    textDataSharing: 'this_device_only',
    imageDataSharing: 'this_device_only',
    terminalBehavior: 'heuristic',
  });
}

/** Ollama-native chat transport returning one canned model content string. */
function contentTransport(content: string) {
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

const EVIDENCE: CatalogEvidence = {
  schemaVersion: 1,
  sourceTreeHash: '0'.repeat(64),
  productFileCount: 0,
  parseFailureCount: 0,
  parseFailures: [],
  fieldRegistry: { entryCount: 0, xmlFields: [] },
  fields: [],
  pages: [],
};

interface LocalOnlySnapshotFixture {
  snapshot: RuntimeClassificationSnapshot;
  run: { id: string };
  modelCall: ModelCallContext | null;
}

function localOnlySnapshot(sku: string, overrides: Record<string, unknown> = {}): LocalOnlySnapshotFixture {
  const candidate = generateCandidate(BayStatePetGardenSeed, EVIDENCE);
  const bundle = {
    ...candidate.bundle,
    ...overrides,
  };
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
  const run = createRun(workspaceId, sku, null, null, { sourceKind: 'catalog_product' });
  const modelCall = requireModelCallContext(snapshot, String(run.id), 'evidence_extraction', 1);
  if (!modelCall) throw new Error('expected a compatible frozen plan for the A1 fixture');
  return { snapshot, run, modelCall };
}

function stageFixtures(sku: string, snapshot: LocalOnlySnapshotFixture['snapshot'], runId: string): {
  stageInput: StageInput;
  context: StageContext;
} {
  return {
    stageInput: {
      sku,
      sourceKind: 'catalog_product',
      evidence: [],
      acceptedProposals: [],
      allProposals: [],
    },
    context: {
      workspaceId,
      workspacePath: tmpDir,
      runId: String(runId),
      snapshot,
      configSnapshotRef: { id: 'test-snapshot', hash: 'abc', sourceCommit: null, createdAt: new Date().toISOString() },
    },
  };
}

function baseInput(overrides: Partial<NormalizedEvidenceInput> = {}): NormalizedEvidenceInput {
  return {
    title: 'Acme Kibble',
    brand: 'Acme',
    weight: null,
    description: 'Crunchy bites for adult dogs.',
    bulletPoints: [],
    searchKeywords: null,
    customFields: {},
    primaryImage: null,
    additionalImages: [],
    sourceUrl: null,
    existingPageNames: [],
    workspacePath: tmpDir,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-a1-'));
  initDb(path.join(tmpDir, '.baystate-cms', 'app.db'));
  runMigrations();
  workspaceId = crypto.randomUUID();
  insertWorkspace({
    id: workspaceId,
    name: 'ocr-a1',
    workspacePath: tmpDir,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('A1 per-image OCR disposition + byte-digest plumbing', () => {
  it('fake local OCR success records succeeded disposition, byte digest, and redacted metadata', async () => {
    seedLocalVlm();
    seedLoopbackVisionRoute();
    const imageName = seedLocalImage('success.bin');
    const { snapshot, run } = localOnlySnapshot('SKU-A1-SUCCESS');
    const { stageInput, context } = stageFixtures('SKU-A1-SUCCESS', snapshot, String(run.id));
    // Route the extractor's VLM transport through a canned local responder
    // via the global fetch seam (loopback local VLM only; no remote vision).
    const transport = contentTransport('{"productName":"Acme Kibble","species":["dog"]}');
    const realFetch = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = transport.fn;
    try {
      const result = await extractProductEvidence(baseInput({ primaryImage: imageName }), stageInput, context);
      expect(result.ocrOutcome?.status).toBe('succeeded');
      const images = result.ocrOutcome?.images ?? [];
      expect(images).toHaveLength(1);
      expect(images[0].status).toBe('succeeded');
      expect(images[0].imageBytesDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(images[0].model).toBeTruthy();
      // Redacted metadata: bounded ref + digests, never raw bytes/URLs.
      expect(String(images[0].imageRef ?? '')).not.toContain('?');
      expect(result.ocrOutcome?.model).toBeTruthy();
      expect(result.packagingOcrData?.productName).toBe('Acme Kibble');
    } finally {
      (globalThis as Record<string, unknown>).fetch = realFetch;
    }
  });

  it('textless image exposes no_legible_text, distinct from the failed outcome of an unreachable image', async () => {
    seedLocalVlm();
    seedLoopbackVisionRoute();
    const emptyName = seedLocalImage('textless.bin');
    // Text-free: the VLM answers with parseable but content-free JSON.
    const emptyTransport = contentTransport('{"productName":null,"species":[]}');
    const { snapshot, run } = localOnlySnapshot('SKU-A1-TEXTLESS');
    const { stageInput, context } = stageFixtures('SKU-A1-TEXTLESS', snapshot, String(run.id));
    const realFetch = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = emptyTransport.fn;
    try {
      const textless = await extractProductEvidence(baseInput({ primaryImage: emptyName }), stageInput, context);
      // Overall status stays in the settled vocabulary (failed); the
      // text-free distinction lives on localStatus + the per-image row.
      expect(textless.ocrOutcome?.status).toBe('failed');
      expect(textless.ocrOutcome?.localStatus).toBe('no_legible_text');
      expect(textless.ocrOutcome?.images?.[0]?.status).toBe('no_legible_text');
    } finally {
      (globalThis as Record<string, unknown>).fetch = realFetch;
    }

    // Unreachable: the stored ref resolves to nothing loadable.
    const { snapshot: snapshot2, run: run2 } = localOnlySnapshot('SKU-A1-UNREACHABLE');
    const fixtures2 = stageFixtures('SKU-A1-UNREACHABLE', snapshot2, String(run2.id));
    // Unreachable: the stored ref is an unresolvable host, so the loader
    // fails coded (image_fetch_failed) before any VLM transport — the canned
    // model transport below must never run.
    const unreachable = await extractProductEvidence(
      baseInput({ primaryImage: 'https://unreachable.invalid/missing.jpg' }),
      fixtures2.stageInput,
      fixtures2.context,
    );
    expect(unreachable.ocrOutcome?.status).toBe('failed');
    expect(unreachable.ocrOutcome?.images?.[0]?.status).toBe('failed');
    expect(unreachable.ocrOutcome?.images?.[0]?.reasonCode).toBeTruthy();
    // The two coded outcomes are distinct per image and locally.
    expect(unreachable.ocrOutcome?.images?.[0]?.status).toBe('failed');
    expect(unreachable.ocrOutcome?.localStatus).not.toBe('no_legible_text');
  });
});

describe('A1 local-only fail-closed gate', () => {
  it('cloud_allowed legacy snapshot with unreachable local VLM makes zero remote vision requests', async () => {
    // Legacy cloud-allowed data policy, but the local VLM endpoint is
    // unreachable (non-loopback / disabled route): image bytes must never
    // reach a remote model.
    upsertProviderConnection({
      id: 'remote-vlm',
      label: 'Remote VLM',
      transport: 'openai-compatible',
      baseUrl: 'https://vision.example.com/v1',
      credential: 'sk-test',
      trustZone: 'cloud',
      approvedHost: 'vision.example.com',
      approvedPort: 443,
      enabled: true,
      connectTimeoutMs: 2000,
      inferenceTimeoutMs: 60000,
    });
    upsertWorkloadRoute('visionOcr', {
      primary: { connectionId: 'remote-vlm', modelId: 'remote-vision' },
      fallback: null,
      textDataSharing: 'cloud_allowed',
      imageDataSharing: 'cloud_allowed',
      terminalBehavior: 'heuristic',
    });
    // Legacy mutable row points at the same unreachable remote endpoint.
    upsertApiKey('ollama_vlm', 'enabled', 'https://vision.example.com/v1', 'remote-vision');

    const candidate = generateCandidate(BayStatePetGardenSeed, EVIDENCE);
    const bundle = {
      ...candidate.bundle,
      modelPolicy: { ...candidate.bundle.modelPolicy, imageDataSharing: 'cloud_allowed' as const },
      dataSharing: { ...candidate.bundle.dataSharing, imagePolicy: 'cloud_allowed' as const },
    };
    const snapshot = buildRuntimeSnapshot({
      workspaceId,
      workspacePath: tmpDir,
      productSku: 'SKU-A1-CLOUD',
      authority: { kind: 'v2' as const, bundle },
      configSnapshotRef: {
        id: bundle.manifest.bundleHash,
        hash: bundle.manifest.bundleHash,
        sourceCommit: null,
        createdAt: new Date().toISOString(),
      },
      sourceProductHash: '',
    });
    const run = createRun(workspaceId, 'SKU-A1-CLOUD', null, null, { sourceKind: 'catalog_product' });
    const { stageInput, context } = stageFixtures('SKU-A1-CLOUD', snapshot, String(run.id));

    let remoteVisionCalls = 0;
    const countingRemoteFetch = (async () => {
      remoteVisionCalls += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    const realFetch = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = countingRemoteFetch;
    try {
      const result = await extractProductEvidence(
        baseInput({ primaryImage: seedLocalImage('gated.bin') }),
        stageInput,
        context,
      );
      // Fail closed: text-only disabled outcome, never an OCR pass.
      expect(result.ocrOutcome?.status).toBe('disabled');
      expect(result.packagingOcrData).toBeUndefined();
      expect(result.ocrOutcome?.imageGateDenied).toBe(true);
      expect(remoteVisionCalls).toBe(0);
    } finally {
      (globalThis as Record<string, unknown>).fetch = realFetch;
    }
    // No durable remote-vision audit row may exist for this run.
    const db = getDb();
    const remoteCalls = db
      .query("SELECT * FROM classification_model_calls WHERE run_id = ? AND locality = 'cloud'")
      .all(String(run.id)) as Record<string, unknown>[];
    expect(remoteCalls).toHaveLength(0);
  });
});
