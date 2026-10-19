import { describe, expect, it } from 'vitest';
import { matchOfficialPageIdentity } from '../../onboarding/official-page-identity';

const product = {
  registerName: 'WILD BETTER BONE MD VNSN 12 OZ', registerUpc: '017800010009',
  brandHint: 'Wild', pageName: 'Wild Better Bone Medium Venison 12oz',
  pageBrand: 'Wild', pageKind: 'product' as const,
  variants: [], observedGtins: [],
};

describe('official product page identity', () => {
  it('accepts a discriminative abbreviated name and exact package without a page UPC', () => {
    const match = matchOfficialPageIdentity(product);
    expect(match.outcome).toBe('unique_name_variant_match');
    expect(match.pageName).toBe(product.pageName);
    expect(match.variantKey).toBeNull();
    expect(match.missingTerms).toEqual([]);
  });

  it('normalizes package units and requires the exact selected size', () => {
    const match = matchOfficialPageIdentity({ ...product,
      pageName: 'Wild Better Bone Venison',
      variants: [
        { key: 'small', label: 'Small 6 oz' },
        { key: 'medium', label: 'Medium 12oz' },
        { key: 'large', label: 'Large 24 oz' },
      ],
    });
    expect(match.outcome).toBe('unique_name_variant_match');
    expect(match.variantKey).toBe('medium');
  });

  it('abstains on an ambiguous flavor/size matrix or missing product-line detail', () => {
    const ambiguous = matchOfficialPageIdentity({ ...product,
      pageName: 'Wild Better Bone Venison',
      variants: [
        { key: 'medium-12-a', label: 'Medium 12 oz' },
        { key: 'medium-12-b', label: 'Medium 12 oz' },
      ],
    });
    expect(ambiguous.outcome).toBe('needs_operator');
    expect(ambiguous.reasons).toContain('ambiguous_variant');
    expect(matchOfficialPageIdentity({ ...product, pageName: 'Wild Better Bone' }).outcome).toBe('needs_operator');
    expect(matchOfficialPageIdentity({ ...product, registerName: 'WILD BETTER BONE QXPT 12 OZ' }).outcome).toBe('needs_operator');
  });

  it('rejects contrary flavor, package, observed GTIN and listings despite brand match', () => {
    expect(matchOfficialPageIdentity({ ...product, pageName: 'Wild Better Bone Chicken 12oz' }).outcome).toBe('reject_conflict');
    expect(matchOfficialPageIdentity({ ...product, pageName: 'Wild Better Bone Venison 24 oz' }).outcome).toBe('reject_conflict');
    expect(matchOfficialPageIdentity({ ...product, observedGtins: ['017800010016'] }).outcome).toBe('reject_conflict');
    expect(matchOfficialPageIdentity({ ...product, pageKind: 'listing' }).outcome).toBe('reject_conflict');
    expect(matchOfficialPageIdentity({ ...product, pageBrand: 'Other Brand' }).outcome).toBe('reject_conflict');
  });

  it('rejects the wrong product even if its title shares generic pet words', () => {
    const match = matchOfficialPageIdentity({ ...product, pageName: 'Wild Chicken Dog Food Medium 12oz' });
    expect(match.outcome).toBe('reject_conflict');
  });
});
