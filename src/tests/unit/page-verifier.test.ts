import { describe, it, expect } from 'vitest';
import {
  extractStructuredGtinsFromHtml,
  qualifyIdentityProof,
  verifyCandidate,
  type VerificationContext,
} from '../../onboarding/page-verifier';
import type { InsertSourceData } from '../../db/repositories/onboarding-source-repo';

describe('Page Verifier — P1-A Structured GTIN Extraction', () => {
  it('extracts GTIN from single Schema.org Product JSON-LD', () => {
    const html = `
      <html>
      <head>
        <script type="application/ld+json">
        {
          "@context": "https://schema.org/",
          "@type": "Product",
          "name": "Acme Dog Food 15lb",
          "gtin12": "017800010009"
        }
        </script>
      </head>
      <body><h1>Acme Dog Food</h1></body>
      </html>
    `;
    const gtins = extractStructuredGtinsFromHtml(html);
    expect(gtins).toHaveLength(1);
    expect(gtins[0].gtin).toBe('017800010009');
    expect(gtins[0].type).toBe('single');
    expect(gtins[0].isValidChecksum).toBe(true);
    expect(gtins[0].path).toBe('Product.gtin12');
  });

  it('extracts GTIN from JSON-LD @graph node', () => {
    const html = `
      <html>
      <head>
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@graph": [
            { "@type": "WebSite", "name": "Acme Store" },
            {
              "@type": "Product",
              "name": "Acme Cat Treats",
              "gtin13": "0017800010009",
              "offers": {
                "@type": "Offer",
                "price": "12.99"
              }
            }
          ]
        }
        </script>
      </head>
      </html>
    `;
    const gtins = extractStructuredGtinsFromHtml(html);
    expect(gtins).toHaveLength(1);
    expect(gtins[0].gtin).toBe('0017800010009');
    expect(gtins[0].type).toBe('single');
    expect(gtins[0].isValidChecksum).toBe(true);
  });

  it('extracts variants from Schema.org ProductGroup.hasVariant', () => {
    const html = `
      <html>
      <head>
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "ProductGroup",
          "name": "Acme Multi-Size Kibble",
          "hasVariant": [
            { "@type": "Product", "name": "Small Bag", "gtin12": "017800010009" },
            { "@type": "Product", "name": "Large Bag", "gtin12": "017800010016" }
          ]
        }
        </script>
      </head>
      </html>
    `;
    const gtins = extractStructuredGtinsFromHtml(html);
    expect(gtins).toHaveLength(2);
    expect(gtins[0].gtin).toBe('017800010009');
    expect(gtins[0].type).toBe('variant');
    expect(gtins[1].gtin).toBe('017800010016');
    expect(gtins[1].type).toBe('variant');
  });

  it('extracts single barcode from single-variant Shopify ProductJson', () => {
    const html = `
      <html>
      <body>
        <script id="ProductJson-12345" type="application/json">
        {
          "id": 12345,
          "title": "Single Variant Item",
          "variants": [
            { "id": 1, "title": "Default Title", "barcode": "017800010009" }
          ]
        }
        </script>
      </body>
      </html>
    `;
    const gtins = extractStructuredGtinsFromHtml(html);
    expect(gtins).toHaveLength(1);
    expect(gtins[0].gtin).toBe('017800010009');
    expect(gtins[0].type).toBe('single');
  });

  it('extracts variant barcodes from multi-variant Shopify ProductJson', () => {
    const html = `
      <html>
      <body>
        <script id="ProductJson-99999" type="application/json">
        {
          "id": 99999,
          "title": "Multi Variant Item",
          "variants": [
            { "id": 1, "title": "5 lb", "barcode": "017800010009" },
            { "id": 2, "title": "15 lb", "barcode": "017800010016" }
          ]
        }
        </script>
      </body>
      </html>
    `;
    const gtins = extractStructuredGtinsFromHtml(html);
    expect(gtins).toHaveLength(2);
    expect(gtins[0].type).toBe('variant');
    expect(gtins[1].type).toBe('variant');
  });

  it('extracts GTIN from HTML5 Microdata (itemprop text and content attribute)', () => {
    const htmlContentAttr = `
      <div itemscope itemtype="http://schema.org/Product">
        <span itemprop="name">Microdata Dog Toy</span>
        <meta itemprop="gtin12" content="017800010009" />
      </div>
    `;
    const gtinsA = extractStructuredGtinsFromHtml(htmlContentAttr);
    expect(gtinsA.length).toBeGreaterThanOrEqual(1);
    expect(gtinsA[0].gtin).toBe('017800010009');

    const htmlInnerText = `
      <div itemscope itemtype="http://schema.org/Product">
        <span itemprop="gtin12">017800010009</span>
      </div>
    `;
    const gtinsB = extractStructuredGtinsFromHtml(htmlInnerText);
    expect(gtinsB.length).toBeGreaterThanOrEqual(1);
    expect(gtinsB[0].gtin).toBe('017800010009');
  });

  it('extracts GTIN from meta tags', () => {
    const html = `
      <html>
      <head>
        <meta property="product:upc" content="017800010009" />
        <meta property="og:product:upc" content="017800010009" />
      </head>
      </html>
    `;
    const gtins = extractStructuredGtinsFromHtml(html);
    expect(gtins.length).toBeGreaterThanOrEqual(1);
    expect(gtins[0].gtin).toBe('017800010009');
  });
});

describe('Page Verifier — qualifyIdentityProof qualification logic', () => {
  const dummySignals = {
    isListingOrSearchPage: false,
    isBlogOrCmsPage: false,
    upcInPage: false,
  };

  it('qualifies exact structured single-product match with valid checksum', () => {
    const extracted = [
      {
        gtin: '017800010009',
        normalizedGtin: '017800010009',
        type: 'single' as const,
        path: 'Product.gtin12',
        isValidChecksum: true,
      },
    ];
    const res = qualifyIdentityProof(extracted, '017800010009', dummySignals);
    expect(res.proofClass).toBe('exact_structured_gtin');
    expect(res.decisionReason).toBe('exact_structured_gtin_verified');
  });

  it('qualifies exact variant match with valid checksum', () => {
    const extracted = [
      {
        gtin: '017800010009',
        normalizedGtin: '017800010009',
        type: 'variant' as const,
        path: 'ProductGroup.hasVariant[0].gtin12',
        isValidChecksum: true,
      },
      {
        gtin: '017800010016',
        normalizedGtin: '017800010016',
        type: 'variant' as const,
        path: 'ProductGroup.hasVariant[1].gtin12',
        isValidChecksum: true,
      },
    ];
    const res = qualifyIdentityProof(extracted, '017800010009', dummySignals);
    expect(res.proofClass).toBe('exact_variant_gtin');
    expect(res.decisionReason).toBe('exact_variant_gtin_resolved');
  });

  it('handles canonical 0-padding equivalence without contradiction', () => {
    const extracted = [
      {
        gtin: '017800010009',
        normalizedGtin: '017800010009',
        type: 'single' as const,
        path: 'Product.gtin12',
        isValidChecksum: true,
      },
      {
        gtin: '0017800010009',
        normalizedGtin: '0017800010009',
        type: 'single' as const,
        path: 'Product.gtin13',
        isValidChecksum: true,
      },
    ];
    const res = qualifyIdentityProof(extracted, '017800010009', dummySignals);
    expect(res.proofClass).toBe('exact_structured_gtin');
    expect(res.decisionReason).toBe('exact_structured_gtin_verified');
  });

  it('rejects contradictory single-product GTINs on same page', () => {
    const extracted = [
      {
        gtin: '017800010009',
        normalizedGtin: '017800010009',
        type: 'single' as const,
        path: 'Product.gtin12',
        isValidChecksum: true,
      },
      {
        gtin: '017800010016',
        normalizedGtin: '017800010016',
        type: 'single' as const,
        path: 'meta[product:upc]',
        isValidChecksum: true,
      },
    ];
    const res = qualifyIdentityProof(extracted, '017800010009', dummySignals);
    expect(res.proofClass).toBe('none');
    expect(res.decisionReason).toBe('contradictory_gtins_found');
  });

  it('rejects invalid GTIN checksum', () => {
    const extracted = [
      {
        gtin: '017800010005', // bad check digit
        normalizedGtin: '017800010005',
        type: 'single' as const,
        path: 'Product.gtin12',
        isValidChecksum: false,
      },
    ];
    const res = qualifyIdentityProof(extracted, '017800010005', dummySignals);
    expect(res.proofClass).toBe('none');
    expect(res.decisionReason).toBe('invalid_gtin_checksum_or_length');
  });

  it('rejects when UPC is only found in body or review text', () => {
    const res = qualifyIdentityProof([], '017800010009', {
      ...dummySignals,
      upcInPage: true,
    });
    expect(res.proofClass).toBe('none');
    expect(res.decisionReason).toBe('upc_in_body_or_review_text_only');
  });

  it('rejects listing, search, or blog pages immediately', () => {
    const extracted = [
      {
        gtin: '017800010009',
        normalizedGtin: '017800010009',
        type: 'single' as const,
        path: 'Product.gtin12',
        isValidChecksum: true,
      },
    ];
    const listingRes = qualifyIdentityProof(extracted, '017800010009', {
      ...dummySignals,
      isListingOrSearchPage: true,
    });
    expect(listingRes.proofClass).toBe('none');
    expect(listingRes.decisionReason).toBe('listing_or_search_page');

    const blogRes = qualifyIdentityProof(extracted, '017800010009', {
      ...dummySignals,
      isBlogOrCmsPage: true,
    });
    expect(blogRes.proofClass).toBe('none');
    expect(blogRes.decisionReason).toBe('blog_or_cms_page');
  });
});

describe('Page Verifier — verifyCandidate end-to-end', () => {
  const candidate: InsertSourceData = {
    url: 'https://brand.example.com/products/dog-food',
    title: 'Acme Dog Food',
    confidence: 0.9,
    domain: 'brand.example.com',
    sourceMethod: 'sitemap_upc',
  };

  const context: VerificationContext = {
    upc: '017800010009',
    expectedName: 'Acme Dog Food 15lb',
    brandHint: 'Acme',
    officialDomains: ['brand.example.com'],
  };

  it('verifies candidate with exact structured GTIN', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Acme Dog Food 15lb</title>
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Product",
          "name": "Acme Dog Food 15lb",
          "gtin12": "017800010009",
          "brand": { "@type": "Brand", "name": "Acme" }
        }
        </script>
      </head>
      <body><h1>Acme Dog Food 15lb</h1></body>
      </html>
    `;

    const mockFetch = async () => new Response(html, { status: 200 });
    const result = await verifyCandidate(candidate, context, mockFetch as any);

    expect(result).not.toBeNull();
    expect(result!.proofClass).toBe('exact_structured_gtin');
    expect(result!.hasStrongProof).toBe(true);
    expect(result!.decisionReason).toContain('verified');
  });

  it('denies strong proof if GTIN is missing even if title matches and schema exists', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Acme Dog Food 15lb</title>
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Product",
          "name": "Acme Dog Food 15lb",
          "brand": { "@type": "Brand", "name": "Acme" }
        }
        </script>
      </head>
      <body><h1>Acme Dog Food 15lb</h1></body>
      </html>
    `;

    const mockFetch = async () => new Response(html, { status: 200 });
    const result = await verifyCandidate(candidate, context, mockFetch as any);

    expect(result).not.toBeNull();
    expect(result!.proofClass).toBe('none');
    expect(result!.hasStrongProof).toBe(false);
    expect(result!.decisionReason).toContain('needs_review');
  });
});

describe('Page Verifier — observedIdentity', () => {
  const candidate: import('../../db/repositories/onboarding-source-repo').InsertSourceData = {
    url: 'https://brand.example.com/products/dog-food',
    title: 'Acme Dog Food',
    confidence: 0.9,
    domain: 'brand.example.com',
    sourceMethod: 'sitemap_upc',
  };
  const listingCandidate: import('../../db/repositories/onboarding-source-repo').InsertSourceData = {
    url: 'https://brand.example.com/collections/all',
    title: 'All products',
    confidence: 0.9,
    domain: 'brand.example.com',
    sourceMethod: 'sitemap_name',
  };
  const context: import('../../onboarding/page-verifier').VerificationContext = {
    upc: '017800010009',
    expectedName: 'Acme Dog Food 15lb',
    brandHint: 'Acme',
    officialDomains: ['brand.example.com'],
  };
  it('returns observed product identity from heading, JSON-LD brand, and Shopify variants', async () => {
    const html = `
      <html><head><title>Different document title</title>
      <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Product","name":"Acme Dog Food","brand":{"@type":"Brand","name":"Acme"},"gtin12":"017800010009"}
      </script></head><body><h1>Visible H1 product name</h1>
      <script>window.productJSON = {"title":"Acme Dog Food","variants":[{"id":1,"title":"15 lb","barcode":"017800010009"},{"id":2,"title":"30 lb","barcode":"017800010016"}]};</script></body></html>`;
    const result = await verifyCandidate(candidate, context, (async () => new Response(html)) as unknown as typeof fetch);
    expect(result?.observedIdentity).toMatchObject({
      pageName: 'Visible H1 product name',
      pageBrand: 'Acme',
      pageKind: 'product',
      variants: [
        { label: '15 lb', gtin: '017800010009' },
        { label: '30 lb', gtin: '017800010016' },
      ],
      observedGtins: ['017800010009'],
      coverageComplete: true,
    });
  });

  it('classifies a listing page in observed identity', async () => {
    const html = '<html><head><title>All products</title></head><body><h1>All products</h1></body></html>';
    const result = await verifyCandidate(listingCandidate, context, (async () => new Response(html)) as unknown as typeof fetch);
    expect(result?.observedIdentity.pageKind).toBe('listing');
  });

  it('returns null brand and no variants when absent', async () => {
    const html = '<html><head><title>Plain page</title></head><body><h1>Plain product</h1></body></html>';
    const result = await verifyCandidate(candidate, context, (async () => new Response(html)) as unknown as typeof fetch);
    expect(result?.observedIdentity.pageBrand).toBeNull();
    expect(result?.observedIdentity.variants).toEqual([]);
  });
});
