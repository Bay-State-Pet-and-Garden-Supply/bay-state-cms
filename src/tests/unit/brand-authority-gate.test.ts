/**
 * ADR 0017 — brand authority gate.
 *
 * Proves the discovery invariant: `passesAuthorityGate` (+ worker flow) —
 * auto-accept as the selected official source requires the candidate's domain
 * to be a mapped official brand domain (strict exact-or-subdomain). Unknown or
 * unmapped brands ALWAYS route to manual review even when page-verification
 * identity proof is strong. Brands and their official domains are configured
 * ahead of time by the operator (brand_sites); discovery never infers them.
 *
 * Offline-only: `discoverSources` + `verifyTopCandidates` are injected through
 * the worker's deps seam (same convention as discovery-run-trace.test.ts). No
 * network, no LLM.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, findItemById } from '../../db/repositories/onboarding-item-repo';
import { getLatestDiscoveryRunForItem } from '../../db/repositories/onboarding-source-repo';
import { upsertBrandSite, findBrandSites, insertBrandSiteIfAbsent } from '../../db/repositories/brand-site-repo';
import {
  OnboardingWorker,
  passesAuthorityGate,
} from '../../onboarding/job-queue';
import type { Workspace } from '../../shared/types';
import type { InsertSourceData } from '../../db/repositories/onboarding-source-repo';
import type { VerificationResult } from '../../onboarding/page-verifier';

// ─── Deferred discovery/verification impls (deps seam) ───────────────────────

let discoverImpl: ((upc: string, name: string, brandHint?: string | null) => Promise<{
  candidates: InsertSourceData[];
  consolidatedName: string | null;
  noDomainMapped?: boolean;
}>) | null = null;
let verifyImpl: ((candidates: InsertSourceData[]) => Promise<VerificationResult[]>) | null = null;

const OFFICIAL_CANDIDATE: InsertSourceData = {
  url: 'https://brand.example.com/product/upc1',
  title: 'Brand Product',
  confidence: 0.95,
  domain: 'brand.example.com',
  sourceMethod: 'sitemap_upc',
};

const RETAILER_CANDIDATE: InsertSourceData = {
  url: 'https://farmtopaw.ca/products/upc1',
  title: 'Brand Product at Retailer',
  confidence: 0.9,
  domain: 'farmtopaw.ca',
  sourceMethod: 'sitemap_token_overlap',
};

const STRONG_SIGNALS: VerificationResult['signals'] = {
  domainOfficial: true,
  isProductDetailPage: true,
  isListingOrSearchPage: false,
  isBlogOrCmsPage: false,
  titleSimilarity: 0.8,
  brandInPage: true,
  upcInPage: true,
  skuInPage: true,
  hasJsonLdProduct: true,
  hasShopifyProductJson: false,
  variantResolved: false,
  canonicalMatchesCandidate: true,
  pageTitle: 'Brand Product',
  pageHeading: 'Brand Product',
  titleNameOverlap: 0.85,
};

function strongVerification(candidate: InsertSourceData, domainOfficial = true): VerificationResult {
  return {
    candidate,
    verificationScore: 0.9,
    signals: { ...STRONG_SIGNALS, domainOfficial },
    proofClass: 'exact_structured_gtin',
    hasStrongProof: true,
    extractedGtins: [],
    decisionReason: 'UPC match + title overlap',
    observedIdentity: { pageName: 'Brand Product', pageBrand: null, pageKind: 'product', variants: [], observedGtins: [], artifactRef: null, coverageComplete: true },
  };
}

function makeDiscover(
  candidates: InsertSourceData[],
  noDomainMapped = false,
): NonNullable<typeof discoverImpl> {
  return async () => ({
    candidates,
    consolidatedName: 'Brand Product',
    noDomainMapped,
  });
}

// ─── Harness ──────────────────────────────────────────────────────────────────

describe('brand authority gate (ADR 0017)', () => {
  let tempDir: string;
  let workspaceId: string;
  let wsPath: string;
  let batchId: string;

  beforeEach(() => {
    delete process.env.BAYSTATE_CMS_SOURCING_ENABLED;
    delete process.env.BAYSTATE_CMS_SOURCING_MODE;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-authority-gate-test-'));
    initDb(path.join(tempDir, 'test.db'));
    runMigrations();
    wsPath = path.join(tempDir, 'ws');
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    fs.mkdirSync(path.join(wsPath, 'store', 'classification'), { recursive: true });
    workspaceId = 'ws-brand-authority';
    const ws: Workspace = {
      id: workspaceId,
      name: 'Test Workspace',
      workspacePath: wsPath,
      gitPath: path.join(wsPath, '.git'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    };
    insertWorkspace(ws);
    batchId = createBatch({ workspaceId, name: 'Brand batch', fileName: 'brand.csv', totalItems: 2 }).id;
    discoverImpl = null;
    verifyImpl = null;
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function runWorkerOnce(): Promise<void> {
    const worker = new OnboardingWorker(workspaceId, wsPath, 10, 3, undefined, {
      discoverSources: (async (upc: string, name: string, brandHint?: string | null) => {
        if (!discoverImpl) throw new Error('discoverImpl not configured');
        return discoverImpl(upc, name, brandHint);
      }) as never,
      verifyTopCandidates: (async (candidates: InsertSourceData[]) => {
        if (!verifyImpl) return [];
        return verifyImpl(candidates);
      }) as never,
    });
    await worker.poll();
    await worker.drain();
  }

  function insertDiscoveryItem(overrides: Partial<{ upc: string; name: string; brandHint: string | null }> = {}) {
    const [item] = insertItems(
      batchId,
      [{
        upc: overrides.upc ?? 'UPC-A',
        name: overrides.name ?? 'Brand Product',
        brandHint: overrides.brandHint ?? null,
        rowNumber: 1,
        stage: 'discovery',
      }],
      'discovery',
      1,
    );
    return item;
  }

  // ─── Authority-gate predicate (pure) ──────────────────────────────

  test('passesAuthorityGate rejects unknown or unmapped brands', () => {
    expect(passesAuthorityGate(null, ['brand.example.com'], 'brand.example.com')).toBe(false);
    expect(passesAuthorityGate('', ['brand.example.com'], 'brand.example.com')).toBe(false);
    expect(passesAuthorityGate('  ', ['brand.example.com'], 'brand.example.com')).toBe(false);
    expect(passesAuthorityGate('Brand', [], 'brand.example.com')).toBe(false);
    expect(passesAuthorityGate('Brand', ['brand.example.com'], null)).toBe(false);
    expect(passesAuthorityGate('Brand', ['brand.example.com'], undefined)).toBe(false);
  });

  test('passesAuthorityGate accepts exact and subdomain matches, rejects others', () => {
    expect(passesAuthorityGate('Brand', ['brand.example.com'], 'brand.example.com')).toBe(true);
    expect(passesAuthorityGate('Brand', ['brand.example.com'], 'shop.brand.example.com')).toBe(true);
    expect(passesAuthorityGate('Brand', ['brand.example.com'], 'farmtopaw.ca')).toBe(false);
    // Strict matching: a lookalike domain is NOT official.
    expect(passesAuthorityGate('Brand', ['brand.example.com'], 'notbrand.example.com')).toBe(false);
  });

  // ─── Worker flow: authority gate blocks off-domain auto-accept ─────────

  test('unknown brand + strong retailer proof → manual review (authority)', async () => {
    const item = insertDiscoveryItem({ upc: 'UPC-C1', name: 'Retailer Strong Proof' });
    discoverImpl = makeDiscover([RETAILER_CANDIDATE]);
    verifyImpl = async (candidates: InsertSourceData[]) =>
      candidates.map(c => strongVerification(c, /* domainOfficial */ false));

    await runWorkerOnce();

    const run = getLatestDiscoveryRunForItem(item.id);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('completed');
    expect(run!.outcome).toBe('needs_input_candidates');
    expect(run!.outcome_message).toContain('authority');

    const after = findItemById(item.id)!;
    expect(after.stageStatus).toBe('completed');
    expect(after.sourceUrl).toBeNull();
    expect(after.errorMessage).toContain('authority');
  });

  test('mapped brand + off-domain strong proof → manual review (authority)', async () => {
    upsertBrandSite('BrandX', 'brand.example.com');
    const item = insertDiscoveryItem({ upc: 'UPC-C2', name: 'Off Domain', brandHint: 'BrandX' });
    discoverImpl = makeDiscover([RETAILER_CANDIDATE]);
    verifyImpl = async (candidates: InsertSourceData[]) =>
      candidates.map(c => strongVerification(c, /* domainOfficial */ false));

    await runWorkerOnce();

    const run = getLatestDiscoveryRunForItem(item.id);
    expect(run).not.toBeNull();
    expect(run!.outcome).toBe('needs_input_candidates');
    expect(run!.outcome_message).toContain('authority');
    expect(run!.outcome_message).toContain('brand.example.com');

    const after = findItemById(item.id)!;
    expect(after.sourceUrl).toBeNull();
  });

  test('mapped brand + official-domain candidate still auto-accepts', async () => {
    upsertBrandSite('BrandX', 'brand.example.com');
    const item = insertDiscoveryItem({ upc: 'UPC-D', name: 'Brand Product', brandHint: 'BrandX' });
    discoverImpl = makeDiscover([OFFICIAL_CANDIDATE]);
    verifyImpl = async (candidates: InsertSourceData[]) => candidates.map(c => strongVerification(c, true));

    await runWorkerOnce();

    const run = getLatestDiscoveryRunForItem(item.id);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('completed');
    expect(run!.outcome).toBe('auto_selected');
    expect(run!.outcome_message).toContain('Auto-selected');

    const after = findItemById(item.id)!;
    expect(after.sourceUrl).toBe(OFFICIAL_CANDIDATE.url);
  });

  // ─── Worker flow: authority gate blocks off-domain auto-accept ─────────

  test('passesAuthorityGate: multi-domain brands accept subdomains, reject lookalikes', () => {
    const officialDomains = ['brand.com', 'brand.co.uk'];
    // A subdomain of any mapped official domain is authoritative.
    expect(passesAuthorityGate('Brand', officialDomains, 'shop.brand.co.uk')).toBe(true);
    expect(passesAuthorityGate('Brand', officialDomains, 'www.brand.com')).toBe(true);
    // A lookalike that merely CONTAINS an official label is not authoritative
    // (strict exact-or-subdomain suffix matching).
    expect(passesAuthorityGate('Brand', officialDomains, 'brand.com.fake.com')).toBe(false);
    expect(passesAuthorityGate('Brand', officialDomains, 'notbrand.com')).toBe(false);
  });

  test('insertBrandSiteIfAbsent is atomic first-mapping-wins and same-domain idempotent', () => {
    const first = insertBrandSiteIfAbsent('PetBrand', 'petbrand.example.com');
    expect(first).not.toBeNull();
    expect(first!.brandName).toBe('petbrand');
    expect(first!.domain).toBe('petbrand.example.com');
    expect(first!.successCount).toBe(1);

    // Same brand + same domain: the existing row is returned unchanged — same
    // id, success_count still 1 (no upsert increment, no duplicate row).
    const second = insertBrandSiteIfAbsent('PetBrand', 'petbrand.example.com');
    expect(second).not.toBeNull();
    expect(second!.id).toBe(first!.id);
    expect(second!.successCount).toBe(1);
    expect(findBrandSites('petbrand')).toHaveLength(1);

    // Same brand + DIFFERENT domain: the guarded insert no-ops (the brand's
    // first mapping wins atomically) and the call reports no row for its
    // candidate.
    const third = insertBrandSiteIfAbsent('PetBrand', 'petbrand.ca');
    expect(third).toBeNull();
    expect(findBrandSites('petbrand')).toHaveLength(1);
    expect(findBrandSites('petbrand')[0].domain).toBe('petbrand.example.com');
  });

  test('relaxed official-domain candidate with token overlap but no strong GTIN proof is NOT auto-selected (P1-A fix)', async () => {
    upsertBrandSite('BrandX', 'brand.example.com');
    const item = insertDiscoveryItem({ upc: 'UPC-E', name: 'Official Weak Match', brandHint: 'BrandX' });
    discoverImpl = makeDiscover([OFFICIAL_CANDIDATE]);
    // Candidate is on official domain with 30% title overlap, but has no strong proof (e.g. wrong variant/missing GTIN)
    verifyImpl = async (candidates: InsertSourceData[]) => [
      {
        candidate: candidates[0],
        verificationScore: 0.35,
        signals: {
          ...STRONG_SIGNALS,
          domainOfficial: true,
          upcInPage: false,
          titleSimilarity: 0.3,
          titleNameOverlap: 0.3,
        },
        proofClass: 'none',
        hasStrongProof: false,
        extractedGtins: [],
        decisionReason: '[needs_review] proof=none | no_structured_gtin_found',
        observedIdentity: { pageName: 'Brand Product', pageBrand: null, pageKind: 'product', variants: [], observedGtins: [], artifactRef: null, coverageComplete: true },
      },
    ];

    await runWorkerOnce();

    const run = getLatestDiscoveryRunForItem(item.id);
    expect(run).not.toBeNull();
    expect(run!.outcome).toBe('needs_input_candidates');
    expect(run!.outcome_message).toContain('No candidate passed verification');

    const after = findItemById(item.id)!;
    expect(after.sourceUrl).toBeNull();
  });

  test('operational kill switch (BAYSTATE_CMS_OFFICIAL_AUTO_SELECT_DISABLED=1) disables auto-selection', async () => {
    process.env.BAYSTATE_CMS_OFFICIAL_AUTO_SELECT_DISABLED = '1';
    try {
      upsertBrandSite('BrandX', 'brand.example.com');
      const item = insertDiscoveryItem({ upc: 'UPC-F', name: 'Kill Switch Match', brandHint: 'BrandX' });
      discoverImpl = makeDiscover([OFFICIAL_CANDIDATE]);
      verifyImpl = async (candidates: InsertSourceData[]) => candidates.map(c => strongVerification(c, true));

      await runWorkerOnce();

      const run = getLatestDiscoveryRunForItem(item.id);
      expect(run).not.toBeNull();
      expect(run!.outcome).toBe('needs_input_candidates');
      expect(run!.outcome_message).toContain('kill_switch');

      const after = findItemById(item.id)!;
      expect(after.sourceUrl).toBeNull();
    } finally {
      delete process.env.BAYSTATE_CMS_OFFICIAL_AUTO_SELECT_DISABLED;
    }
  });
});