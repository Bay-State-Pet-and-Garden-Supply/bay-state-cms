import { describe, expect, it } from 'vitest';
import { validateExtraction } from '../../onboarding/extraction-validator';

const expected = { name: 'Wild Better Bone MD VNSN 12 OZ', brandHint: 'Wild', upc: '017800010009', domain: 'wild.example' };

describe('extraction identity revalidation', () => {
  it('accepts the same conservative unique name/package match without an extracted barcode', () => {
    const result = validateExtraction({ title: 'Wild Better Bone Medium Venison 12oz', brand: 'Wild', sourceUrl: 'https://wild.example/products/better-bone' }, expected);
    expect(result).toMatchObject({ valid: true, status: 'ok' });
    expect(result.identity?.outcome).toBe('unique_name_variant_match');
  });

  it('holds ambiguous or changed packaging for review instead of completing extraction', () => {
    const ambiguous = validateExtraction({ title: 'Wild Better Bone', brand: 'Wild', sourceUrl: 'https://wild.example/products/better-bone' }, expected);
    expect(ambiguous).toMatchObject({ valid: false, status: 'mismatch' });
    expect(ambiguous.reason).toContain('needs operator');
    const changed = validateExtraction({ title: 'Wild Better Bone Venison 24 oz', brand: 'Wild', sourceUrl: 'https://wild.example/products/better-bone' }, expected);
    expect(changed.valid).toBe(false);
    expect(changed.reason).toContain('variant_conflict');
  });

  it('rejects a contradictory extracted barcode and a stale variant receipt without retrying blindly', () => {
    const wrongBarcode = validateExtraction({ title: 'Wild Better Bone Medium Venison 12oz', sourceUrl: 'https://wild.example/products/better-bone' }, { ...expected, barcode: '017800010016' });
    expect(wrongBarcode).toMatchObject({ valid: false, status: 'mismatch' });
    const staleReceipt = validateExtraction(
      { title: 'Wild Better Bone Medium Venison 12oz', sourceUrl: 'https://wild.example/products/better-bone' },
      { ...expected, selectedVariantKey: 'medium-12oz', extractedVariantKey: 'large-24oz', extractedVariantLabel: 'Large 24 oz' },
    );
    expect(staleReceipt.valid).toBe(false);
    expect(staleReceipt.reason).toContain('stale_selection');
  });
});
