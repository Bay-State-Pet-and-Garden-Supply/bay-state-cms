import { describe, it, expect } from 'vitest';
import {
  ScrapedProductEvidenceSchema,
  validateGtin,
  computePayloadHash,
  type ScrapedProductEvidence,
} from '../../crawler/corpus-schema';
import { validateCorpusLine, computeEntityId } from '../../crawler/corpus-validator';

const VALID_RECORD: ScrapedProductEvidence = {
  retailer: 'chewy.com',
  sourceUrl: 'https://www.chewy.com/dp/102534',
  scrapedAt: '2026-08-01T08:41:00.000Z',
  title: 'Blue Buffalo Life Protection Adult Dry Dog Food',
  brand: 'Blue Buffalo',
  gtin: '0840243105625',
  rawBreadcrumb: ['Dog', 'Dog Food', 'Dry Kibble'],
  specifications: { 'Life Stage': 'Adult' },
  images: [],
  acquisitionMode: 'browser_parse',
  parserVersion: '2.0',
};

describe('corpus schema', () => {
  describe('validateGtin', () => {
    it('accepts valid GTIN-8, GTIN-12, GTIN-13, and GTIN-14 checksums', () => {
      expect(validateGtin('96385074')).toBe(true); // GTIN-8
      expect(validateGtin('017800010009')).toBe(true); // GTIN-12 (UPC-A)
      expect(validateGtin('0840243105625')).toBe(true); // GTIN-13 (Blue Buffalo UPC)
      expect(validateGtin('0070158005028')).toBe(true); // GTIN-13 (Zignature)
      expect(validateGtin('00017800010009')).toBe(true); // GTIN-14
    });

    it('rejects bad checksums and wrong lengths', () => {
      expect(validateGtin('0840243105626')).toBe(false);
      expect(validateGtin('017800010005')).toBe(false);
      expect(validateGtin('12345')).toBe(false);
      expect(validateGtin('12345678901234567')).toBe(false);
      expect(validateGtin('abc')).toBe(false);
    });

    it('tolerates formatting noise', () => {
      expect(validateGtin('0 84024 31056 25')).toBe(true);
      expect(validateGtin('0-17800-01000-9')).toBe(true);
    });
  });

  describe('ScrapedProductEvidenceSchema', () => {
    it('parses a valid record with provenance', () => {
      const parsed = ScrapedProductEvidenceSchema.parse(VALID_RECORD);
      expect(parsed.acquisitionMode).toBe('browser_parse');
      expect(parsed.parserVersion).toBe('2.0');
      expect(parsed.pageKind).toBe('unknown');
    });
    it('discards price supplied by third-party evidence', () => {
      const parsed = ScrapedProductEvidenceSchema.parse({
        ...VALID_RECORD,
        price: '$29.99',
        specifications: {
          Price: '$29.99',
          'Sale Price': '$19.99',
          Weight: '5 lb',
        },
      });

      expect(parsed).not.toHaveProperty('price');
      expect(parsed.specifications).toEqual({ Weight: '5 lb' });
    });


    it('defaults provenance fields for legacy records', () => {
      const legacy = { ...VALID_RECORD };
      delete legacy.acquisitionMode;
      delete legacy.parserVersion;
      delete legacy.licenseStatus;
      const parsed = ScrapedProductEvidenceSchema.parse(legacy);
      expect(parsed.acquisitionMode).toBe('import_file');
      expect(parsed.parserVersion).toBe('1.0');
      expect(parsed.licenseStatus).toBe('unknown');
    });
  });

  describe('payload hashing and entity identity', () => {
    it('produces identical payload hashes for identical payloads', () => {
      const a = computePayloadHash(VALID_RECORD as unknown as Record<string, unknown>);
      const b = computePayloadHash({ ...VALID_RECORD } as unknown as Record<string, unknown>);
      expect(a).toBe(b);
    });

    it('ignores identity/timestamp fields in the payload hash', () => {
      const withScrapeTime = computePayloadHash({
        ...VALID_RECORD,
        scrapedAt: '2026-08-02T00:00:00.000Z',
      } as unknown as Record<string, unknown>);
      const without = computePayloadHash(VALID_RECORD as unknown as Record<string, unknown>);
      expect(withScrapeTime).toBe(without);
    });

    it('produces source-scoped SHA-256 entity IDs (no prefix collision)', () => {
      const a = computeEntityId('https://www.chewy.com/dp/102534');
      const b = computeEntityId('https://www.chewy.com/dp/102534');
      const c = computeEntityId('https://www.chewy.com/dp/102535');
      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a).toMatch(/^[a-f0-9]{64}$/);
    });

    it('never emits the legacy generic prefix', () => {
      const line = JSON.stringify({ ...VALID_RECORD, sourceUrl: 'https://scotts.com/en-us/shop/fertilizer/' });
      const result = validateCorpusLine(line);
      if (result.ok) {
        expect(result.entityId).not.toContain('generic-');
        expect(result.entityId).toMatch(/^[a-f0-9]{64}$/);
      }
    });
  });

  describe('validateCorpusLine', () => {
    it('accepts a valid product-page record', () => {
      const result = validateCorpusLine(JSON.stringify(VALID_RECORD));
      expect(result.ok).toBe(true);
      expect(result.entityId).toBeDefined();
      expect(result.observationId).toBeDefined();
    });

    it('rejects invalid JSON', () => {
      const result = validateCorpusLine('{not json');
      expect(result.ok).toBe(false);
      expect(result.rejectionCode).toBe('invalid_json');
    });

    it('rejects category/interstitial pages', () => {
      const category = validateCorpusLine(
        JSON.stringify({ ...VALID_RECORD, sourceUrl: 'https://scotts.com/en-us/shop/fertilizer/', title: 'Technical Page' }),
      );
      expect(category.ok).toBe(false);
      expect(['non_product_page', 'blocked_page']).toContain(category.rejectionCode);
    });

    it('normalizes legacy records without provenance to import_file defaults', () => {
      const noProvenance = { ...VALID_RECORD };
      delete noProvenance.acquisitionMode;
      delete noProvenance.parserVersion;
      const result = validateCorpusLine(JSON.stringify(noProvenance));
      expect(result.ok).toBe(true);
      expect(result.entityId).toBeDefined();
    });

    it('rejects records with an invalid acquisitionMode value', () => {
      const result = validateCorpusLine(
        JSON.stringify({ ...VALID_RECORD, acquisitionMode: 'teleport' }),
      );
      expect(result.ok).toBe(false);
      expect(result.rejectionCode).toBe('invalid_json');
    });

    it('rejects invalid GTINs', () => {
      const result = validateCorpusLine(
        JSON.stringify({ ...VALID_RECORD, gtin: '0840243105626' }),
      );
      expect(result.ok).toBe(false);
      expect(result.rejectionCode).toBe('invalid_gtin');
    });

    it('rejects duplicate source locators', () => {
      const seen = new Set<string>();
      const first = validateCorpusLine(JSON.stringify(VALID_RECORD), { seenEntityIds: seen });
      expect(first.ok).toBe(true);
      if (first.entityId) seen.add(first.entityId);
      const second = validateCorpusLine(JSON.stringify(VALID_RECORD), { seenEntityIds: seen });
      expect(second.ok).toBe(false);
      expect(second.rejectionCode).toBe('duplicate_locator');
    });

    it('rejects invalid URLs', () => {
      const result = validateCorpusLine(
        JSON.stringify({ ...VALID_RECORD, sourceUrl: 'https://127.0.0.1/x' }),
      );
      expect(result.ok).toBe(false);
      expect(result.rejectionCode).toBe('invalid_url');
    });
  });
});
