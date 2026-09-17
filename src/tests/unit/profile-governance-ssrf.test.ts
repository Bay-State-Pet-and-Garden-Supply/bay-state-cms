import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { insertSources, selectSource } from '../../db/repositories/onboarding-source-repo';
import { insertProfileGeneration } from '../../db/repositories/profile-generation-repo';
import { createInitialRevisionForGeneration, validateRevisionAcrossConfirmedSamples } from '../../onboarding/profile-governance-service';
import { handleValidate } from '../../extraction-worker/routes/validate';
import { EventEmitter } from 'node:events';

const TEST_DB = 'src/tests/unit/profile-governance-ssrf-test.db';
const WORKSPACE_ID = 'workspace-ssrf-test';

describe('Profile Governance & Worker SSRF Protection Adversarial Tests', () => {
  beforeAll(() => {
    try {
      resetDb();
    } catch {
      /* ok */
    }
    initDb(TEST_DB);
    runMigrations();
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [WORKSPACE_ID, 'SSRF Test Workspace', '/tmp/ws-ssrf', '/tmp/ws-ssrf/.git', now, now, 'complete'],
    );
  });

  afterAll(() => {
    closeDb();
    try {
      unlinkSync(TEST_DB);
    } catch {
      /* ok */
    }
  });

  it('validateRevisionAcrossConfirmedSamples / fetchSampleHtml blocks private/loopback/cloud-metadata URLs instantly', async () => {
    const domain = 'ssrf-test-domain.com';
    const privateUrls = [
      'http://127.0.0.1/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/secret',
      'http://192.168.1.1/router',
      'http://[::1]/internal',
      'file:///etc/passwd',
    ];

    const batch = createBatch({
      workspaceId: WORKSPACE_ID,
      name: 'SSRF Test Batch',
      fileName: 'ssrf.xlsx',
      totalItems: privateUrls.length,
    });

    for (let i = 0; i < privateUrls.length; i++) {
      const url = privateUrls[i];
      const items = insertItems(batch.id, [
        { upc: `upc-ssrf-${i}`, name: `SSRF Item ${i}`, rowNumber: i + 1 },
      ]);
      const sources = insertSources(items[0].id, [
        { url, domain, confidence: 0.9, title: `SSRF Item ${i}`, snippet: '' },
      ]);
      selectSource(sources[0].id);
    }

    const gen = insertProfileGeneration({
      domain,
      sourceUrl: 'https://ssrf-test-domain.com/p',
      expectedName: 'SSRF Item 0',
      brandHint: null,
      selectors: { titleSelector: 'h1' },
      status: 'validated',
      confidence: 0.5,
      llmProvider: 'deepseek',
      llmModel: 'deepseek-v4-flash',
    });

    const rev = createInitialRevisionForGeneration(gen.id)!;
    const startTime = Date.now();
    const result = await validateRevisionAcrossConfirmedSamples(rev.id, domain, { sampleLimit: 10 });
    const duration = Date.now() - startTime;

    expect(result.sampleCount).toBe(privateUrls.length);
    expect(result.passingSamples).toBe(0);
    expect(result.samples.every((s) => s.status === 'fail')).toBe(true);
    expect(result.samples.every((s) => s.warnings.some((w) => w.includes('could not be fetched')))).toBe(true);
    // Should fail instantly without waiting for connection timeouts
    expect(duration).toBeLessThan(1000);
  });

  it('extraction-worker handleValidate validateSampleStatic blocks private/loopback/cloud-metadata URLs', async () => {
    const privateUrls = [
      'http://127.0.0.1/test.html',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/internal',
      'file:///etc/hosts',
    ];

    for (const url of privateUrls) {
      const reqPayload = {
        profileDraft: {
          domain: 'example-test.com',
          runtime: 'static',
          selectors: { titleSelector: 'h1' },
          imageRules: {},
          variantSelectionStrategy: null,
        },
        samples: [
          {
            url,
            confirmed: true,
            spreadsheetHints: {},
          },
        ],
      };

      const req = new EventEmitter() as any;
      req.method = 'POST';
      req.headers = { 'content-type': 'application/json' };

      let responseBody = '';
      let statusCode = 0;
      const res = {
        writeHead: (status: number) => {
          statusCode = status;
        },
        end: (body: string) => {
          responseBody = body;
        },
      } as any;

      handleValidate(req, res);
      req.emit('data', Buffer.from(JSON.stringify(reqPayload)));
      req.emit('end');

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(statusCode).toBe(200);
      const parsed = JSON.parse(responseBody);
      expect(parsed.results[0].imageResults.warnings.some((w: string) => w.toLowerCase().includes('ssrf') || w.toLowerCase().includes('private') || w.toLowerCase().includes('unsupported protocol'))).toBe(true);
    }
  });

  it('extraction-worker handleValidate validateSampleRendered blocks private/loopback/cloud-metadata URLs', async () => {
    const privateUrls = [
      'http://127.0.0.1/rendered.html',
      'http://169.254.169.254/latest/meta-data/',
      'http://user:secretpass@127.0.0.1/test',
    ];

    for (const url of privateUrls) {
      const reqPayload = {
        profileDraft: {
          domain: 'example-test.com',
          runtime: 'rendered',
          selectors: { titleSelector: 'h1' },
          imageRules: {},
          variantSelectionStrategy: null,
        },
        samples: [
          {
            url,
            confirmed: true,
            spreadsheetHints: {},
          },
        ],
      };

      const req = new EventEmitter() as any;
      req.method = 'POST';
      req.headers = { 'content-type': 'application/json' };

      let responseBody = '';
      let statusCode = 0;
      const res = {
        writeHead: (status: number) => {
          statusCode = status;
        },
        end: (body: string) => {
          responseBody = body;
        },
      } as any;

      handleValidate(req, res);
      req.emit('data', Buffer.from(JSON.stringify(reqPayload)));
      req.emit('end');

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(statusCode).toBe(200);
      const parsed = JSON.parse(responseBody);
      expect(parsed.results[0].imageResults.warnings.some((w: string) =>
        w.toLowerCase().includes('ssrf') ||
        w.toLowerCase().includes('private') ||
        w.toLowerCase().includes('credentials')
      )).toBe(true);
      // Ensure credentials are redacted from warning messages
      expect(parsed.results[0].imageResults.warnings.join(' ')).not.toContain('secretpass');
    }
  });

  it('fetchPinned pins connection to validated IP and detects DNS rebinding attempts', async () => {
    const { fetchPinned } = await import('../../shared/ssrf');

    let dnsCallCount = 0;
    // Mock lookup that returns public IP on first call, but loopback on second call (rebinding)
    const rebindingLookup = (async () => {
      dnsCallCount++;
      if (dnsCallCount === 1) {
        return [{ address: '93.184.216.34', family: 4 }];
      }
      return [{ address: '127.0.0.1', family: 4 }];
    }) as any;

    let targetFetchUrl = '';
    let targetFetchHeaders: any = {};
    const mockFetch = (async (input: any, init: any) => {
      targetFetchUrl = String(input);
      targetFetchHeaders = init?.headers ?? {};
      return new Response('ok', { status: 200 });
    }) as any;

    const result = await fetchPinned('http://rebinding-domain.example.com/page', {
      lookupFn: rebindingLookup,
      fetchFn: mockFetch,
    });

    expect(result.pinned).toBe(true);
    // The HTTP connection URL must be rewritten to the IP literal from validation time
    expect(targetFetchUrl).toBe('http://93.184.216.34/page');
    // Host header must preserve the original hostname
    expect(targetFetchHeaders.Host).toBe('rebinding-domain.example.com');
  });

  it('fetchPinned fails closed when hostname resolves to a private IP', async () => {
    const { fetchPinned } = await import('../../shared/ssrf');

    const privateLookup = (async () => [{ address: '169.254.169.254', family: 4 }]) as any;

    await expect(
      fetchPinned('http://metadata-attacker.example.com/meta', {
        lookupFn: privateLookup,
      })
    ).rejects.toThrow(/SSRF blocked/);
  });
});
