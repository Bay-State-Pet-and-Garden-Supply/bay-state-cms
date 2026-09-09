/**
 * Unit tests for `src/onboarding/title-prompt-template.ts`.
 *
 * Covers distributor title/brand signal rendering, input bounding,
 * and backward compatibility when distributor arrays are omitted.
 */
import { describe, it, expect } from 'vitest';
import {
  buildPerItemPrompt,
  FORMAT_RULES,
} from '../../onboarding/title-prompt-template';

// ─── buildPerItemPrompt ─────────────────────────────────────────────────────

describe('buildPerItemPrompt', () => {
  it('renders distributor titles as provider-labeled inputs', () => {
    const prompt = buildPerItemPrompt({
      name: 'Test Dog Food 5lb',
      brandHint: 'Acme',
      distributorTitles: [
        { title: 'Acme Premium Dog Food 5 lb', providerId: 'central_pet', confidence: 0.95 },
        { title: 'Acme Dog Food 5lb Bag', providerId: 'bradley', confidence: 0.85 },
      ],
    });

    expect(prompt).toContain('Distributor (central_pet) Title');
    expect(prompt).toContain('"Acme Premium Dog Food 5 lb"');
    expect(prompt).toContain('Distributor (bradley) Title');
    expect(prompt).toContain('"Acme Dog Food 5lb Bag"');
    // Untrusted evidence disclaimer
    expect(prompt).toContain('untrusted third-party evidence');
  });

  it('renders distributor brands as provider-labeled inputs', () => {
    const prompt = buildPerItemPrompt({
      name: 'Test Product',
      brandHint: 'Acme',
      distributorBrands: [
        { brand: 'Acme Pet Foods', providerId: 'central_pet', confidence: 0.95 },
        { brand: 'ACME', providerId: 'phillips', confidence: 0.80 },
      ],
    });

    expect(prompt).toContain('Distributor (central_pet) Brand');
    expect(prompt).toContain('"Acme Pet Foods"');
    expect(prompt).toContain('Distributor (phillips) Brand');
    expect(prompt).toContain('"ACME"');
  });

  it('renders both distributor titles and brands together', () => {
    const prompt = buildPerItemPrompt({
      name: 'Test Product',
      distributorTitles: [
        { title: 'Product Title A', providerId: 'p1', confidence: 0.9 },
      ],
      distributorBrands: [
        { brand: 'Brand A', providerId: 'p1', confidence: 0.9 },
      ],
    });

    expect(prompt).toContain('Distributor (p1) Title');
    expect(prompt).toContain('Distributor (p1) Brand');
  });

  it('bounds distributor title values to 500 characters', () => {
    const longTitle = 'A'.repeat(600);
    const prompt = buildPerItemPrompt({
      name: 'Test',
      distributorTitles: [
        { title: longTitle, providerId: 'test', confidence: 1.0 },
      ],
    });

    // The rendered title should be truncated to 500 chars
    expect(prompt).toContain('"'.concat('A'.repeat(500)));
    // Should NOT contain the full 600-char string
    expect(prompt).not.toContain('"'.concat('A'.repeat(501)));
  });

  it('bounds distributor brand values to 200 characters', () => {
    const longBrand = 'B'.repeat(300);
    const prompt = buildPerItemPrompt({
      name: 'Test',
      distributorBrands: [
        { brand: longBrand, providerId: 'test', confidence: 1.0 },
      ],
    });

    expect(prompt).toContain('"'.concat('B'.repeat(200)));
    expect(prompt).not.toContain('"'.concat('B'.repeat(201)));
  });

  it('omits distributor blocks when arrays are empty', () => {
    const prompt = buildPerItemPrompt({
      name: 'Test Product',
      brandHint: 'Acme',
      distributorTitles: [],
      distributorBrands: [],
    });

    expect(prompt).not.toContain('Distributor (');
  });

  it('preserves existing behavior when distributor arrays are omitted', () => {
    const withDist = buildPerItemPrompt({
      name: 'Test Product',
      brandHint: 'Acme',
      webTitle: 'Web Title',
      ocrTitle: 'OCR Title',
      distributorTitles: [{ title: 'Dist Title', providerId: 'p1', confidence: 0.9 }],
    });

    const withoutDist = buildPerItemPrompt({
      name: 'Test Product',
      brandHint: 'Acme',
      webTitle: 'Web Title',
      ocrTitle: 'OCR Title',
    });

    // Core structure should be intact in both cases
    expect(withDist).toContain('Original Spreadsheet Name');
    expect(withDist).toContain('Return ONLY the finalized product name');
    expect(withoutDist).toContain('Original Spreadsheet Name');
    expect(withoutDist).toContain('Return ONLY the finalized product name');

    // The distributor-free prompt should NOT contain provider-labelled sections
    expect(withoutDist).not.toContain('Distributor (');
  });

  it('includes the untrusted-evidence disclaimer even without distributor data', () => {
    const prompt = buildPerItemPrompt({
      name: 'Test',
    });

    // The safety wording is always present per the design
    expect(prompt).toContain('untrusted third-party evidence');
  });

  it('FORMAT_RULES is always included', () => {
    const prompt = buildPerItemPrompt({ name: 'Test' });
    expect(prompt).toContain(FORMAT_RULES);
  });

  it('handles null distributor title values gracefully', () => {
    const prompt = buildPerItemPrompt({
      name: 'Test',
      distributorTitles: [
        { title: null as unknown as string, providerId: 'p1', confidence: 0.9 },
      ],
    });

    // Should not crash, rendered value is empty string slice
    expect(prompt).toContain('Distributor (p1) Title');
  });

  it('renders packaging OCR species, form, flavor, weight, and size when provided', () => {
    const prompt = buildPerItemPrompt({
      name: 'ACME DOG FOOD',
      brandHint: 'Acme',
      ocrTitle: 'Acme Grain Free Recipe',
      ocrSpecies: 'Dog',
      ocrProductForm: 'Dry Kibble',
      ocrFlavor: 'Salmon & Sweet Potato',
      ocrWeight: '12 lb',
      ocrSize: '12 lb',
    });

    expect(prompt).toContain('- Packaging OCR Species: "Dog"');
    expect(prompt).toContain('- Packaging OCR Form: "Dry Kibble"');
    expect(prompt).toContain('- Packaging OCR Flavor/Variety: "Salmon & Sweet Potato"');
    expect(prompt).toContain('- Packaging OCR Weight: "12 lb"');
    expect(prompt).toContain('- Packaging OCR Size: "12 lb"');
  });
});
