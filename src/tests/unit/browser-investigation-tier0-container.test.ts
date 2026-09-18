// #236 — containerized Tier 0 execution (Vitest).
//
// Slice 1: the Tier 0 / Tier 1 network-shape decision lives in code.
// Tier 0 (implemented here): host-side broker fetch with in-container
// analysis; the container has no egress of its own. Tier 1 (rendered
// investigation behind a validating forward proxy) is explicitly deferred,
// never implied.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { resolveInvestigationBudget } from '../../shared/schemas/browser-investigation';
import type { Tier0AnalysisRequest } from '../../onboarding/browser-investigation/container-runner';
import { DockerTier0ContainerRunner } from '../../onboarding/browser-investigation/container-runner';
import {
  INVESTIGATION_NETWORK_SHAPE,
  TIER1_RENDER_CONTAINER_STATUS,
  buildInvestigationContainerSpec,
  tier0AnalysisDockerArgs,
} from '../../onboarding/browser-investigation/isolation';

const PAGE_HTML = `<!doctype html><html><head>
<title>Acme All-Natural Dog Food 15 lb</title>
<meta property="og:title" content="Acme All-Natural Dog Food" />
<meta name="description" content="Grain-free kibble for active dogs." />
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Acme Dog Food","brand":{"@type":"Brand","name":"Acme"},"offers":{"price":"54.99"}}</script>
<script src="https://cdn.shopify.com/s/files/1/shop.js"></script>
</head><body><h1>Acme All-Natural Dog Food</h1>
<img src="https://brand.example/images/kibble.jpg" alt="kibble" />
<img src="https://brand.example/images/kibble-2.jpg" alt="kibble bowl" />
</body></html>`;

const INV = 'binv_harness_1';

function captureOf(
  overrides: Partial<{
    pageIndex: number;
    html: string;
    contentType: string;
    pageUrl: string;
    artifactHash: string;
  }> = {},
) {
  const pageIndex = overrides.pageIndex ?? 0;
  return {
    pageIndex,
    bodyBase64: Buffer.from(overrides.html ?? PAGE_HTML, 'utf8').toString('base64'),
    contentType: overrides.contentType ?? 'text/html; charset=utf-8',
    pageUrl: overrides.pageUrl ?? 'https://brand.example/products/alpha',
    artifactHash:
      overrides.artifactHash ?? '9f2c4a7e1b3d5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8',
    artifactRef: `artifact:${INV}:p${pageIndex}`,
    responseRef: `response:${INV}:p${pageIndex}`,
  };
}

function requestFor(
  captures: ReturnType<typeof captureOf>[],
  budget: Record<string, number> = {},
) {
  return {
    investigationId: INV,
    budget: {
      maxSelectorLength: 512,
      maxSelectorMatches: 100,
      maxObservationBytesPerOperation: 32 * 1024,
      maxJsonNodesVisited: 10_000,
      maxJsonPointerDepth: 32,
      maxResponseBytesPerResponse: 5 * 1024 * 1024,
      maxReads: 20,
      ...budget,
    },
    captures,
  };
}

describe('Tier 0 analyzer: captures in, typed observations out (no fetch of its own)', () => {
  it('reads a page into the fixed observation kinds within budget', async () => {
    const { analyzeTier0Captures } = await import(
      '../../onboarding/browser-investigation/tier0-analyzer.mjs'
    );
    const out = analyzeTier0Captures(requestFor([captureOf()]));
    const kinds = new Set(out.observations.map((o: { kind: string }) => o.kind));
    for (const kind of ['network_response', 'page_title', 'page_meta', 'page_json_ld', 'page_images']) {
      expect(kinds, kind).toContain(kind);
    }
    for (const obs of out.observations) {
      expect(obs.artifactHash).toMatch(/^[0-9a-f]{64}$/);
      expect(obs.sourceUrl).toMatch(/^https:\/\/brand\.example\//);
      expect(typeof obs.incomplete).toBe('boolean');
    }
    expect(out.platformSignals).toContain('shopify');
    expect(out.domSignals).toEqual({ title: true, meta: true, jsonLd: true, images: true });
    // Fixed plan charges one read per grammar op: inspect + title + meta +
    // script + image query + one attribute read per image.
    expect(out.readsPerformed).toBe(7);
    expect(out.gaps).toEqual([]);
  });

  it('clamps selector matches from lowered budgets (gate, not documentation)', async () => {
    const { analyzeTier0Captures } = await import(
      '../../onboarding/browser-investigation/tier0-analyzer.mjs'
    );
    const out = analyzeTier0Captures(requestFor([captureOf()], { maxSelectorMatches: 1 }));
    const images = out.observations.find((o: { kind: string }) => o.kind === 'page_images');
    expect(images?.detail).toMatch(/image elements observed: 1/);
  });

  it('fails closed with budget_exhausted when reads overrun the cap', async () => {
    const { analyzeTier0Captures } = await import(
      '../../onboarding/browser-investigation/tier0-analyzer.mjs'
    );
    try {
      analyzeTier0Captures(requestFor([captureOf()], { maxReads: 3 }));
      expect.unreachable('over-budget analysis must fail');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('budget_exhausted');
    }
  });

  it('clips image-heavy pages to the remaining read budget with an honest gap (never fails the run)', async () => {
    const { analyzeTier0Captures } = await import(
      '../../onboarding/browser-investigation/tier0-analyzer.mjs'
    );
    const imgs = Array.from({ length: 30 }, (_, i) => `<img src="https://brand.example/images/p${i}.jpg" alt="p${i}" />`).join('\n');
    const heavy = PAGE_HTML.replace('</body>', `${imgs}</body>`);
    const out = analyzeTier0Captures(requestFor([captureOf({ html: heavy })], { maxReads: 20 }));
    expect(out.readsPerformed).toBeLessThanOrEqual(20);
    const images = out.observations.find((o: { kind: string }) => o.kind === 'page_images');
    expect(images).toBeDefined();
    expect(out.gaps.join('\n')).toMatch(/image surface clipped/);
  });

  it('reserves read budget for later pages instead of failing the whole run', async () => {
    const { analyzeTier0Captures } = await import(
      '../../onboarding/browser-investigation/tier0-analyzer.mjs'
    );
    // Two image-heavy pages under the 20-read run budget: the first page's
    // image attributes are clipped so the second page still gets analyzed
    // (clipping is recorded as a gap, never a silent omission).
    const imgs = Array.from({ length: 30 }, (_, i) => `<img src="https://brand.example/images/p${i}.jpg" alt="p${i}" />`).join('\n');
    const heavy = PAGE_HTML.replace('</body>', `${imgs}</body>`);
    const out = analyzeTier0Captures(
      requestFor([
        captureOf({ pageIndex: 0, html: heavy, pageUrl: 'https://brand.example/products/alpha' }),
        captureOf({ pageIndex: 1, html: heavy, pageUrl: 'https://brand.example/products/beta' }),
      ]),
    );
    expect(out.readsPerformed).toBeLessThanOrEqual(20);
    const pages = new Set(out.observations.map((o: { sourceUrl: string }) => o.sourceUrl));
    expect(pages.size).toBe(2);
    expect(out.gaps.join('\n')).toMatch(/image surface clipped/);
  });

  it('reports no DOM evidence honestly on bare pages', async () => {
    const { analyzeTier0Captures } = await import(
      '../../onboarding/browser-investigation/tier0-analyzer.mjs'
    );
    const out = analyzeTier0Captures(
      requestFor([captureOf({ html: '<html><head></head><body><div id="app"></div></body></html>' })]),
    );
    expect(out.domSignals).toEqual({ title: false, meta: false, jsonLd: false, images: false });
    expect(out.observations.map((o: { kind: string }) => o.kind)).toContain('network_response');
  });

  it('marks clipped observations incomplete instead of truncating silently', async () => {
    const { analyzeTier0Captures } = await import(
      '../../onboarding/browser-investigation/tier0-analyzer.mjs'
    );
    const longMeta = PAGE_HTML.replace(
      'Grain-free kibble for active dogs.',
      `Grain-free kibble for active dogs. ${'Nutritious and delicious. '.repeat(120)}`,
    );
    const out = analyzeTier0Captures(
      requestFor([captureOf({ html: longMeta })], { maxObservationBytesPerOperation: 1024 }),
    );
    expect(out.observations.some((o: { incomplete: boolean }) => o.incomplete)).toBe(true);
  });

  it('cuts clipped text on UTF-8 boundaries, never splitting a sequence', async () => {
    const { analyzeTier0Captures } = await import(
      '../../onboarding/browser-investigation/tier0-analyzer.mjs'
    );
    const emojiMeta = PAGE_HTML.replace(
      'Grain-free kibble for active dogs.',
      `Grain-free héllo wörld — test ✓ emoji 🎉 ${'Nutritious and délicious. '.repeat(60)}`,
    );
    for (const cap of [64, 100, 101, 102, 103, 1000]) {
      const out = analyzeTier0Captures(
        requestFor([captureOf({ html: emojiMeta })], { maxObservationBytesPerOperation: cap }),
      );
      const meta = out.observations.find((o: { kind: string }) => o.kind === 'page_meta');
      expect(meta).toBeDefined();
      const detail = (meta as { detail?: string }).detail ?? '';
      expect(Buffer.byteLength(detail, 'utf8')).toBeLessThanOrEqual(cap);
      expect(detail).not.toContain('�');
      expect(meta?.incomplete).toBe(true);
    }
  });

  it('discards a stale response reference as a gap, never a bypass', async () => {
    const { analyzeTier0Captures } = await import(
      '../../onboarding/browser-investigation/tier0-analyzer.mjs'
    );
    const stale = { ...captureOf(), responseRef: 'response:other_investigation:p0' };
    const out = analyzeTier0Captures(requestFor([stale]));
    expect(out.observations).toHaveLength(0);
    expect(out.gaps.join('\n')).toMatch(/stale response reference/);
  });

  it('uses only stable analyzer codes (budget_exhausted | invalid_input)', async () => {
    const { analyzeTier0Captures, TIER0_ANALYZER_CODES } = await import(
      '../../onboarding/browser-investigation/tier0-analyzer.mjs'
    );
    expect(new Set(Object.values(TIER0_ANALYZER_CODES))).toEqual(
      new Set(['budget_exhausted', 'invalid_input']),
    );
    for (const bad of [null, {}, { investigationId: INV }, { investigationId: INV, budget: {}, captures: [] }]) {
      try {
        analyzeTier0Captures(bad as never);
        expect.unreachable('malformed request must fail');
      } catch (err) {
        expect((err as { code?: string }).code).toBe('invalid_input');
      }
    }
    try {
      analyzeTier0Captures(requestFor([captureOf()], { maxReads: 1 }));
      expect.unreachable('over-budget analysis must fail');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('budget_exhausted');
    }
    // Over-length fixed selectors and foreign refs surface as gaps carrying
    // the stable code, never an exotic throw.
    const out = analyzeTier0Captures(requestFor([captureOf()], { maxSelectorLength: 3 }));
    expect(out.observations.map((o: { kind: string }) => o.kind)).toContain('network_response');
    expect(out.gaps.join('\n')).toMatch(/invalid_input: selector exceeds/);
  });

  it('launches zero fetches of its own: no fetch, socket, or DNS surface', () => {
    const source = readFileSync(
      new URL('../../onboarding/browser-investigation/tier0-analyzer.mjs', import.meta.url),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    for (const pattern of [
      /\bfetch\s*\(/,
      /http\.request\s*\(/,
      /https\.request\s*\(/,
      /https\.get\s*\(/,
      /http\.get\s*\(/,
      /new\s+WebSocket\s*\(/,
      /\bdgram\b/i,
      /\b(XMLHttpRequest|playwright|puppeteer|camoufox)\b/i,
      /\brequire\s*\(/,
      /(^|\s)import\s+(.+\s+from\s+)?['"]/m,
    ]) {
      expect(code, String(pattern)).not.toMatch(pattern);
    }
  });
});

describe('Tier 0 container runner: deterministic teardown', () => {
  it('removes the run container idempotently and never throws', async () => {
    const runner = new DockerTier0ContainerRunner();
    // Missing names are fine: teardown is best-effort and must never mask a
    // run outcome (the isolated-run contract tears down on every exit path).
    await expect(runner.teardown('binv-nonexistent-239')).resolves.toBeUndefined();
    await expect(runner.teardown('binv-nonexistent-239')).resolves.toBeUndefined();
  });
});

describe('Tier 0 container runner: real container per run, teardown on every exit', () => {
  const DOCKER_TIMEOUT = 120_000;

  async function dockerAvailable(): Promise<boolean> {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const run = promisify(execFile);
      await run('docker', ['info'], { timeout: 15_000 });
      const override = process.env.BAYSTATE_INVESTIGATION_TEST_IMAGE;
      let image = override ?? '';
      if (!image) {
        try {
          const { stdout } = await run('docker', ['images', '-q', 'node:22-bookworm'], { timeout: 15_000 });
          if (stdout.trim()) image = 'node:22-bookworm';
        } catch {
          image = '';
        }
      }
      if (!image) return false;
      await run('docker', ['run', '--rm', image, 'node', '-e', ''], { timeout: 15_000 });
      return true;
    } catch {
      return false;
    }
  }

  async function ensureTier0Image(): Promise<string | null> {
    const override = process.env.BAYSTATE_INVESTIGATION_TEST_IMAGE;
    if (override) return override;
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const run = promisify(execFile);
      try {
        await run('docker', ['image', 'inspect', 'baystate/investigation-browser:1'], { timeout: 15_000 });
        return 'baystate/investigation-browser:1';
      } catch {
        await run(
          'docker',
          ['build', '-t', 'baystate/investigation-browser:1', '-f', 'docker/investigation-browser/Dockerfile', '.'],
          { timeout: 100_000, maxBuffer: 8 * 1024 * 1024 },
        );
        return 'baystate/investigation-browser:1';
      }
    } catch {
      return null;
    }
  }

  /** Daemon gate + image provision for one live test. Null means skip loudly. */
  async function liveImage(skipNote: string): Promise<string | null> {
    if (!(await dockerAvailable())) {
      console.warn(`SKIP: no Docker daemon — ${skipNote} skipped`);
      return null;
    }
    const image = await ensureTier0Image();
    if (!image) console.warn(`SKIP: Tier 0 image unavailable — ${skipNote} skipped`);
    return image;
  }

  /** Runner + posture spec for one live run id. */
  async function liveContext(runId: string, image: string) {
    const { DockerTier0ContainerRunner } = await import(
      '../../onboarding/browser-investigation/container-runner'
    );
    const { buildInvestigationContainerSpec } = await import(
      '../../onboarding/browser-investigation/isolation'
    );
    const runner = new DockerTier0ContainerRunner(
      image === 'baystate/investigation-browser:1' ? {} : { imageOverride: image },
    );
    return { runner, spec: buildInvestigationContainerSpec(runId) };
  }

  /** Gate, provision, and start one live run. Null means skip loudly. */
  async function startLiveRun(
    label: string,
    prefix: string,
  ): Promise<{ runner: Awaited<ReturnType<typeof liveContext>>['runner']; spec: Awaited<ReturnType<typeof liveContext>>['spec']; runId: string } | null> {
    const image = await liveImage(label);
    if (!image) return null;
    const runId = `${prefix}${Date.now().toString(36)}`;
    const { runner, spec } = await liveContext(runId, image);
    await runner.start(spec);
    return { runner, spec, runId };
  }

  /** No leftover container may survive a run, however it exited. */
  async function assertContainerGone(containerName: string): Promise<void> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)(
      'docker',
      ['ps', '-a', '--filter', `name=${containerName}`, '--format', '{{.Names}}'],
      { timeout: 15_000 },
    );
    expect(stdout.trim()).toBe('');
  }

  it('analyzer CLI speaks the stdin/stdout envelope over plain stdio', async () => {
    const { spawn } = await import('node:child_process');
    const cli = new URL('../../onboarding/browser-investigation/tier0-analyzer-cli.mjs', import.meta.url);
    const child = spawn('node', [cli.pathname], { stdio: ['pipe', 'pipe', 'pipe'] });
    const payload = JSON.stringify(requestFor([captureOf()]));
    const [code, stdout] = await new Promise<[number | null, string]>((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (c: Buffer) => void (out += c.toString('utf8')));
      child.on('error', reject);
      child.on('close', (c) => resolve([c, out]));
      child.stdin.write(payload);
      child.stdin.end();
    });
    expect(code).toBe(0);
    const envelope = JSON.parse(stdout) as { ok: boolean; version: number; result?: { readsPerformed: number } };
    expect(envelope.ok).toBe(true);
    expect(envelope.version).toBe(1);
    expect(envelope.result?.readsPerformed).toBe(7);
  });

  it(
    'starts a real container per run and returns typed observations',
    { timeout: DOCKER_TIMEOUT },
    async () => {
      const live = await startLiveRun('Tier 0 container run (argv posture still asserted)', 'tier0live');
      if (!live) return;
      const { runner, spec, runId } = live;
      try {
        const result = await runner.runAnalysis(
          spec,
          { investigationId: INV, budget: requestFor([]).budget, captures: [captureOf()] },
          { timeoutMs: 60_000 },
        );
        expect(result.readsPerformed).toBe(7);
        expect(result.domSignals).toEqual({ title: true, meta: true, jsonLd: true, images: true });
        expect(result.platformSignals).toContain('shopify');
      } finally {
        await runner.teardown(runId);
      }
      await assertContainerGone(`binv-${runId}`);
    },
  );

  it('fails closed with isolation_unavailable when the image is missing', async () => {
    const { DockerTier0ContainerRunner } = await import(
      '../../onboarding/browser-investigation/container-runner'
    );
    const { buildInvestigationContainerSpec } = await import(
      '../../onboarding/browser-investigation/isolation'
    );
    const runner = new DockerTier0ContainerRunner({
      imageOverride: 'baystate/definitely-not-an-image:0',
    });
    const spec = buildInvestigationContainerSpec('binvrun_noimage');
    await expect(runner.start(spec)).rejects.toMatchObject({ code: 'isolation_unavailable' });
  });

  it(
    'tears down the container when analysis fails',
    { timeout: DOCKER_TIMEOUT },
    async () => {
      const live = await startLiveRun('Tier 0 failure-teardown', 'tier0fail');
      if (!live) return;
      const { runner, spec, runId } = live;
      // maxReads 3 against a 7-read page: the container reports
      // budget_exhausted, and teardown still removes the container.
      await expect(
        runner.runAnalysis(
          spec,
          {
            investigationId: INV,
            budget: { ...requestFor([]).budget, maxReads: 3 },
            captures: [captureOf()],
          },
          { timeoutMs: 60_000 },
        ),
      ).rejects.toMatchObject({ code: 'budget_exhausted' });
      await runner.teardown(runId);
      const { containerNameForRun } = await import(
        '../../onboarding/browser-investigation/isolation'
      );
      await assertContainerGone(containerNameForRun(runId));
    },
  );
  it(
    'the Tier 0 posture denies egress from inside the analysis container',
    { timeout: DOCKER_TIMEOUT },
    async () => {
      const image = await liveImage('Tier 0 in-container egress proof');
      if (!image) return;
      // Same deny-by-default flags as the analysis launch, probe command
      // instead of the analyzer: no interceptors, routes, or guards in the
      // loop — denial is container-level or it is nothing.
      const { buildInvestigationContainerSpec, tier0AnalysisDockerArgs } = await import(
        '../../onboarding/browser-investigation/isolation'
      );
      const runId = `tier0egress${Date.now().toString(36)}`;
      const argv = tier0AnalysisDockerArgs(buildInvestigationContainerSpec(runId));
      argv[argv.length - 3] = image;
      const probe = [
        `const dns=require('dns'),https=require('https'),net=require('net');`,
        `(async()=>{`,
        `const dip=await new Promise((r)=>dns.lookup('example.com',(e)=>r(e?('DENIED:'+e.code):'ALLOWED')));`,
        `console.log('DNS-'+dip);if(dip==='ALLOWED')process.exit(1);`,
        `const h=await new Promise((r)=>{const q=https.get('https://example.com/',{timeout:5000},(s)=>{r('ALLOWED');process.exit(1)});q.on('timeout',()=>{r('DENIED:timeout');q.destroy()});q.on('error',(e)=>r('DENIED:'+(e.code||'error')))});`,
        `console.log('HTTPS-'+h);`,
        `const t=await new Promise((r)=>{const s=net.connect(443,'93.184.216.34',()=>{r('ALLOWED');process.exit(1)});s.setTimeout(5000);s.on('timeout',()=>{r('DENIED:timeout');s.destroy()});s.on('error',(e)=>r('DENIED:'+(e.code||'error')))});`,
        `console.log('TCP-'+t);console.log('TIER0-CONTAINMENT-VERIFIED');`,
        `})().catch((e)=>{console.log('PROBE-ERROR:'+e.message);process.exit(1)});`,
      ].join('\n');
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { stdout } = await promisify(execFile)('docker', [...argv.slice(0, -2), 'node', '-e', probe], {
        timeout: 100_000,
        maxBuffer: 1024 * 1024,
      });
      expect(stdout).toContain('DNS-DENIED');
      expect(stdout).toContain('HTTPS-DENIED');
      expect(stdout).toContain('TCP-DENIED');
      expect(stdout).toContain('TIER0-CONTAINMENT-VERIFIED');
      expect(stdout).not.toContain('ALLOWED');
    },
  );

  it(
    'tears down the container when analysis times out',
    { timeout: DOCKER_TIMEOUT },
    async () => {
      const live = await startLiveRun('Tier 0 timeout-teardown', 'tier0timeout');
      if (!live) return;
      const { runner, spec, runId } = live;
      // Container startup alone exceeds this budget: the kill path reports
      // timeout AND removes the container before reporting.
      await expect(
        runner.runAnalysis(
          spec,
          { investigationId: INV, budget: requestFor([]).budget, captures: [captureOf()] },
          { timeoutMs: 5 },
        ),
      ).rejects.toMatchObject({ code: 'timeout' });
      await runner.teardown(runId);
      const { containerNameForRun } = await import(
        '../../onboarding/browser-investigation/isolation'
      );
      await assertContainerGone(containerNameForRun(runId));
    },
  );

});

describe('harness container boundary: analysis runs in-container or not at all', () => {
  const ENV_KEY = 'BAYSTATE_INVESTIGATION_ISOLATION';

  async function harnessWith(runner: unknown, transportHtml: string = PAGE_HTML) {
    const { LocalBrowserHarnessProvider } = await import(
      '../../onboarding/browser-investigation/local-harness'
    );
    const { releaseInvestigationSlot } = await import(
      '../../onboarding/browser-investigation/isolation'
    );
    releaseInvestigationSlot();
    const provider = new LocalBrowserHarnessProvider({
      isolationProbe: { dockerReachable: async () => true },
      brokerDeps: {
        lookup: async () => ['93.184.216.34'],
        transport: async (req: { url: string; validatedAddresses: string[] }) => ({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: Buffer.from(transportHtml, 'utf8'),
          connectedIp: req.validatedAddresses[0] ?? null,
        }),
      },
      containerRunner: runner as never,
    });
    return provider;
  }

  function harnessRequest() {
    const budget = resolveInvestigationBudget({});
    const sampleUrls = ['https://brand.example/products/alpha'];
    return {
      investigationId: INV,
      workspaceId: 'ws_harness',
      domain: 'brand.example',
      mode: 'domain_onboarding' as const,
      sampleUrls,
      inputSnapshot: {
        domain: 'brand.example',
        mode: 'domain_onboarding' as const,
        sampleUrls,
        budget,
        modelPolicy: { allowCloudTextAnalysis: false, allowImageSharing: false },
        knownContext: {},
        requestedAt: new Date().toISOString(),
      },
      inputHash: 'abcdef1234567890abcdef1234567890',
      budget,
      modelPolicy: { allowCloudTextAnalysis: false, allowImageSharing: false },
      knownContext: {},
      runId: 'binvrun_boundary1',
    };
  }

  it('fails closed without fetching when the runner cannot run analysis (never host fallback)', async () => {
    const saved = process.env[ENV_KEY];
    process.env[ENV_KEY] = 'ready';
    try {
      let fetched = 0;
      const { LocalBrowserHarnessProvider } = await import(
        '../../onboarding/browser-investigation/local-harness'
      );
      const { releaseInvestigationSlot } = await import(
        '../../onboarding/browser-investigation/isolation'
      );
      releaseInvestigationSlot();
      const provider = new LocalBrowserHarnessProvider({
        isolationProbe: { dockerReachable: async () => true },
        brokerDeps: {
          lookup: async () => ['93.184.216.34'],
          transport: async () => {
            fetched += 1;
            return { status: 200, headers: {}, body: Buffer.from('x'), connectedIp: null };
          },
        },
        // Teardown-only runner: predates start/run, cannot execute analysis.
        containerRunner: { teardown: async () => {} } as never,
      });
      await expect(provider.invoke(harnessRequest())).rejects.toThrowError(/isolation_unavailable/);
      expect(fetched).toBe(0);
    } finally {
      if (saved === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = saved;
      const { releaseInvestigationSlot } = await import(
        '../../onboarding/browser-investigation/isolation'
      );
      releaseInvestigationSlot();
    }
  });

  it('delegates analysis to the runner and still tears down', async () => {
    const saved = process.env[ENV_KEY];
    process.env[ENV_KEY] = 'ready';
    try {
      const seen: Array<{ captures: number }> = [];
      const tornDown: string[] = [];
      const runner = {
        start: async () => {},
        runAnalysis: async (_spec: unknown, request: Tier0AnalysisRequest) => {
          seen.push({ captures: request.captures.length });
          const { analyzeTier0Captures } = await import(
            '../../onboarding/browser-investigation/tier0-analyzer.mjs'
          );
          return analyzeTier0Captures(request);
        },
        teardown: async (runId: string) => void tornDown.push(runId),
      };
      const provider = await harnessWith(runner);
      const completion = await provider.invoke(harnessRequest());
      expect(completion.provider).toBe('local_browser_harness');
      expect(seen).toEqual([{ captures: 1 }]);
      expect(tornDown).toEqual(['binvrun_boundary1']);
      const result = completion.result as { observations: unknown[] };
      expect(result.observations.length).toBeGreaterThan(0);
    } finally {
      if (saved === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = saved;
      const { releaseInvestigationSlot } = await import(
        '../../onboarding/browser-investigation/isolation'
      );
      releaseInvestigationSlot();
    }
  });

  it('processes no page bytes in the host: no DOM library in the harness', () => {
    const source = readFileSync(
      new URL('../../onboarding/browser-investigation/local-harness.ts', import.meta.url),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/cheerio/);
    expect(code).not.toMatch(/querySelector/i);
    expect(code).not.toMatch(/DOMParser/);
  });
});


describe('Tier 0 / Tier 1 network shape (recorded decision)', () => {
  it('runs Tier 0 as host fetch with in-container analysis and zero container egress', () => {
    expect(INVESTIGATION_NETWORK_SHAPE.tier0.implemented).toBe(true);
    expect(INVESTIGATION_NETWORK_SHAPE.tier0.fetchLocation).toBe('host_broker');
    expect(INVESTIGATION_NETWORK_SHAPE.tier0.analysisLocation).toBe('container');
    expect(INVESTIGATION_NETWORK_SHAPE.tier0.containerNetwork).toBe('none');
    expect(INVESTIGATION_NETWORK_SHAPE.tier0.containerEgress).toBe('deny_all');
  });

  it('marks the Tier 1 proxy-only render container implemented (#237), not implied by Tier 0', () => {
    expect(INVESTIGATION_NETWORK_SHAPE.tier1.implemented).toBe(true);
    expect(TIER1_RENDER_CONTAINER_STATUS).toMatch(/proxy-only egress/);
    expect(`${TIER1_RENDER_CONTAINER_STATUS} ${INVESTIGATION_NETWORK_SHAPE.tier1.note}`.toLowerCase())
      .toMatch(/proxy/);
  });

  it('records the Tier 0 / Tier 1 shape in docs, with Tier 1 implemented not implied', () => {
    const design = readFileSync(
      new URL('../../../docs/plans/browser-investigation-design.md', import.meta.url),
      'utf8',
    );
    expect(design).toMatch(/Tier 1.*implemented/s);
    expect(design).toMatch(/proxy-only/);
    const context = readFileSync(new URL('../../../CONTEXT.md', import.meta.url), 'utf8');
    expect(context).toMatch(/Tier 1 Rendered Investigation/);
    // #248 correction: the glossary records the deferred state (render-required
    // work fails closed), not the previously intended executing-render story.
    expect(context).toMatch(/render_deferred/);
  });

  it('builds Tier 0 analysis argv from the posture spec with stdin attached and no proxy', () => {
    const spec = buildInvestigationContainerSpec('binvrun_tier0a');
    const argv = tier0AnalysisDockerArgs(spec);
    const joined = argv.join(' ');
    // Real container launch: docker run --rm -i with the posture flags.
    expect(argv[0]).toBe('run');
    expect(argv).toContain('--rm');
    expect(argv).toContain('-i');
    expect(joined).toContain('--network=none');
    // The container executes the analyzer over piped captures, nothing else.
    expect(argv.slice(-3)).toEqual([spec.image, 'node', '/app/tier0-analyzer-cli.mjs']);
    // No proxy affordance anywhere: Tier 0 analysis never renders, so the
    // proxy declaration lives only in the render argv (Tier 1).
    expect(joined).not.toMatch(/proxy/i);
    expect(joined).not.toMatch(/HTTP_PROXY|HTTPS_PROXY|ALL_PROXY/i);
  });
});
