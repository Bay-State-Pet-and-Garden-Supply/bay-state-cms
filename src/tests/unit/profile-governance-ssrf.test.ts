import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { insertSources, selectSource } from '../../db/repositories/onboarding-source-repo';
import { insertProfileGeneration } from '../../db/repositories/profile-generation-repo';
import { getDb } from '../../db/connection';
import {
  createInitialRevisionForGeneration,
  validateRevisionAcrossConfirmedSamples,
  reviseProfileFromStructuredFeedback,
} from '../../onboarding/profile-governance-service';
import type { StructuredFeedback } from '../../shared/schemas/onboarding';

const TEST_DB = 'src/tests/unit/profile-governance-ssrf-test.db';
const WORKSPACE_ID = 'workspace-ssrf-test';

function seedConfirmedSample(itemName: string, url: string, domain: string): { itemId: string; sourceId: string } {
  const batch = createBatch({
    workspaceId: WORKSPACE_ID,
    name: 'SSRF Test Batch',
    fileName: 'ssrf.xlsx',
    totalItems: 1,
  });
  const items = insertItems(batch.id, [
    { upc: `upc-${Math.random().toString(36).slice(2, 8)}`, name: itemName, rowNumber: 1 },
  ]);
  const sources = insertSources(items[0].id, [
    { url, domain, confidence: 0.9, title: itemName, snippet: '' },
  ]);
  selectSource(sources[0].id);
  return { itemId: items[0].id, sourceId: sources[0].id };
}

describe('Profile Governance Service - SSRF Protection', () => {
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

  describe('validateRevisionAcrossConfirmedSamples SSRF protection', () => {
    test('blocks fetching sample URLs pointing to loopback or private IP addresses', async () => {
      const domain = 'ssrf-sample.com';
      seedConfirmedSample('Localhost Target', 'http://127.0.0.1/secret.html', domain);
      seedConfirmedSample('Cloud Metadata Target', 'http://169.254.169.254/latest/meta-data/', domain);
      seedConfirmedSample('Private IP Target', 'http://10.0.0.1/internal.html', domain);

      const gen = insertProfileGeneration({
        domain,
        sourceUrl: 'http://127.0.0.1/secret.html',
        expectedName: null,
        brandHint: null,
        selectors: { titleSelector: 'h1' },
        status: 'validated',
        confidence: 0.5,
      });

      const rev = createInitialRevisionForGeneration(gen.id)!;
      const result = await validateRevisionAcrossConfirmedSamples(rev.id, domain);

      // All 3 samples must fail closed without fetching internal networks
      expect(result.sampleCount).toBe(3);
      expect(result.passingSamples).toBe(0);
      for (const sample of result.samples) {
        expect(sample.status).toBe('fail');
        expect(sample.warnings[0]).toMatch(/could not be fetched/i);
      }
    });
  });

  describe('reviseProfileFromStructuredFeedback SSRF protection', () => {
    test('blocks fetching source URLs pointing to loopback or private IP addresses', async () => {
      const domain = 'ssrf-revise.com';
      const gen = insertProfileGeneration({
        domain,
        sourceUrl: 'http://127.0.0.1/secret.html',
        expectedName: null,
        brandHint: null,
        selectors: { titleSelector: 'h1' },
        status: 'validated',
        confidence: 0.5,
      });

      const rev = createInitialRevisionForGeneration(gen.id)!;
      const feedback: StructuredFeedback = {
        kind: 'text',
        field: 'titleSelector',
        expectedValue: 'Expected Title',
        notes: 'Fix title selector',
      };

      const child = reviseProfileFromStructuredFeedback({
        generationId: gen.id,
        parentRevisionId: rev.id,
        feedback,
      });

      expect(child).not.toBeNull();
      // The revision was created as draft, but the LLM pass/fetch failed closed (did not fetch 127.0.0.1)
      expect(child!.status).toBe('draft');
    });
  });
});
