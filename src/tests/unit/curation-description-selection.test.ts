// story: curation - description selection regression test
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';

describe('curation - official page description selection', () => {
  test('product-curator selects ext.description for non-distributor items', () => {
    const src = fs.readFileSync('src/onboarding/product-curator.ts', 'utf8');
    expect(src).toContain('selectedDescription = distributorSource');
    expect(src).toContain('? (verifiedV2Distributor && typeof ext.description === \'string\' && ext.description.trim().length > 0 ? ext.description : null)');
    expect(src).toContain(': (typeof ext.description === \'string\' && ext.description.trim().length > 0 ? ext.description : null)');
  });
});
