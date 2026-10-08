import { describe, expect, it } from 'bun:test';
import { extractPublicProductEvidence } from '../../../scripts/lib/jev-public-source-enrichment';

const url = 'https://fixtures.test/products/herbal-relief';
const expected = { canonicalUrl: url, title: 'Herbal Relief', brand: 'Fixture Brand' };
const product = { '@type': 'Product', name: 'Herbal Relief', url, description: 'Herbal relief for dogs and cats.', category: 'Pet supplement', audience: { audienceType: 'Dogs and cats' }, offers: { price: '29.99' } };
const page = (body: string, nodes: unknown = product) => `<script type="application/ld+json">${JSON.stringify(nodes)}</script><main><h1>Herbal Relief</h1>${body}</main>`;

describe('already-public product enrichment', () => {
  it('retains short subject and usage facts but excludes UGC, cross-sells and prices', () => {
    const result = extractPublicProductEvidence(page(`<section class="product-description">Species: Dogs and cats.<div class="reviews">A customer says this topical shampoo cured my dog.</div><div class="related-products">Related Cat Toy contains catnip.</div></section><section id="tab-additional_information">Directions: Give orally. Package: Bottle. Price $29.99.</section>`), url, expected);
    expect(result?.excerpts.map(e => e.text)).toContain('Directions: Give orally.');
    expect(result?.excerpts.map(e => e.text)).toContain('Species: Dogs and cats.');
    expect(result?.excerpts.map(e => e.text)).toContain('Package: Bottle.');
    const evidence = result?.excerpts.map(e => e.text).join('\n');
    expect(evidence).not.toContain('customer');
    expect(evidence).not.toContain('Cat Toy');
    expect(evidence).not.toContain('29.99');
  });

  it('binds structured facts to the primary Product, not recommendation ItemList products', () => {
    const recommendation = { '@type': 'ItemList', itemListElement: [{ '@type': 'Product', name: 'Catnip Ball', url: 'https://fixtures.test/products/catnip-ball', description: 'A cat toy with catnip.' }] };
    const result = extractPublicProductEvidence(page('<section class="product-description">Give orally to dogs and cats.</section>', { '@graph': [product, recommendation] }), url, expected);
    expect(result?.excerpts.map(e => e.text)).toContain('Dogs and cats');
    expect(result?.excerpts.map(e => e.text).join('\n')).not.toContain('catnip');
  });

  it('refuses changed identity and multi-product pages rather than re-grounding an old SKU', () => {
    expect(extractPublicProductEvidence(page('', { ...product, name: 'Catnip Ball' }), url, expected)).toBeNull();
    expect(extractPublicProductEvidence(page('', [{ ...product }, { ...product, name: 'Different Product' }]), url, expected)).toBeNull();
    expect(extractPublicProductEvidence('<main><h1>Dogs and cats</h1><p>Shop all supplements.</p></main>', url, expected)).toBeNull();
  });
});
