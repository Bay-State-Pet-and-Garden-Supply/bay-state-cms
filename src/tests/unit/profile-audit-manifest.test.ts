import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildAuditManifest } from '../../onboarding/profile-audit/manifest-builder';

describe('profile audit manifest builder', () => {
  let tempDir: string;
  const domain = 'testbrand.com';

  beforeEach(() => {
    tempDir = join(tmpdir(), `manifest-test-${randomUUID()}`);
    const domainDir = join(tempDir, domain);
    mkdirSync(domainDir, { recursive: true });

    // Snapshot 1: Full artifact with supplemental files
    const snap1 = join(domainDir, 'snapshot-1001-aaaa');
    mkdirSync(snap1);
    writeFileSync(
      join(snap1, 'page.html'),
      '<!DOCTYPE html><html><head><link rel="canonical" href="https://testbrand.com/products/item-1"></head><body><h1>Item 1</h1></body></html>',
    );
    writeFileSync(join(snap1, 'page.min.html'), '<html><body>Item 1</body></html>');
    writeFileSync(join(snap1, 'screenshot.png'), 'fake-png-content');

    // Snapshot 2: Missing supplemental files (only page.html)
    const snap2 = join(domainDir, 'snapshot-1002-bbbb');
    mkdirSync(snap2);
    writeFileSync(
      join(snap2, 'page.html'),
      '<!DOCTYPE html><html><head><link rel="canonical" href="https://testbrand.com/products/item-2"></head><body><h1>Item 2</h1></body></html>',
    );
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('builds manifest with artifact resolution and supplemental tracking', async () => {
    const manifest = await buildAuditManifest({
      domain,
      artifactRoot: tempDir,
      suiteUrls: [
        'https://testbrand.com/products/item-1',
        'https://testbrand.com/products/item-2',
        'https://testbrand.com/products/item-missing-snap',
      ],
      groundTruthOverrides: {
        'https://testbrand.com/products/item-1': {
          identity: { brand: 'TestBrand', productName: 'Item 1' },
          fields: {
            title: { available: true, expectedValue: 'Item 1' },
            price: { available: false },
          },
          images: {
            primaryImage: null,
            admissibleImages: [],
          },
        },
      },
    });

    expect(manifest.domain).toBe(domain);
    expect(manifest.samples).toHaveLength(3);

    const s1 = manifest.samples.find(s => s.url === 'https://testbrand.com/products/item-1');
    expect(s1).toBeDefined();
    expect(s1?.artifactRef).toContain('snapshot-1001-aaaa/page.html');
    expect(s1?.hasSupplementalArtifact).toBe(true);
    expect(s1?.supplementalArtifactRefs).toHaveLength(2);
    expect(s1?.inventoryStatus).toBe('confirmed');

    const s2 = manifest.samples.find(s => s.url === 'https://testbrand.com/products/item-2');
    expect(s2).toBeDefined();
    expect(s2?.artifactRef).toContain('snapshot-1002-bbbb/page.html');
    expect(s2?.hasSupplementalArtifact).toBe(false);

    const s3 = manifest.samples.find(s => s.url === 'https://testbrand.com/products/item-missing-snap');
    expect(s3).toBeDefined();
    expect(s3?.artifactRef).toBeNull();
    expect(s3?.hasSupplementalArtifact).toBe(false);
  });
});
