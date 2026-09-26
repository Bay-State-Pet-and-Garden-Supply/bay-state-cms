import { describe, it, expect } from 'vitest';
import {
  rerankPageProposals,
  rerankPageProposalsVerified,
  assertVerifiedPageRerankContext,
  PageRerankBlockedError,
} from '../../classification/page-reranker';
import type { SimilarProduct } from '../../classification/product-retrieval';

describe('Page Reranker', () => {
  it('should boost pages supported by retrieval consensus', () => {
    const proposals = [
      { pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.70 },
      { pageId: 'p2', pageName: 'Dog Food Wet', confidence: 0.75 },
    ];

    const similarProducts: SimilarProduct[] = [
      { sku: 'S1', similarity: 0.9, productName: 'Item 1', productType: 'Dog Food Dry', acceptedPages: ['Dog Food Dry'], acceptedFields: {} },
      { sku: 'S2', similarity: 0.85, productName: 'Item 2', productType: 'Dog Food Dry', acceptedPages: ['Dog Food Dry'], acceptedFields: {} },
    ];

    const ranked = rerankPageProposals(proposals, similarProducts);

    expect(ranked[0].pageName).toBe('Dog Food Dry');
    expect(ranked[0].rerankReason).toBe('retrieval_consensus');
    expect(ranked[0].rerankScore).toBeGreaterThan(0.70);
  });

  it('should suppress parent Shop All pages when specific child page exists', () => {
    const proposals = [
      { pageId: 'p1', pageName: 'Dog Food Shop All', confidence: 0.80 },
      { pageId: 'p2', pageName: 'Dog Food Dry', confidence: 0.85 },
    ];

    const ranked = rerankPageProposals(proposals, []);

    const names = ranked.map(r => r.pageName);
    expect(names).toContain('Dog Food Dry');
    expect(names).not.toContain('Dog Food Shop All');
  });

  it('should filter out cross-species page assignments', () => {
    const proposals = [
      { pageId: 'p1', pageName: 'Cat Food Dry', confidence: 0.90 },
      { pageId: 'p2', pageName: 'Dog Food Dry', confidence: 0.80 },
    ];

    const ranked = rerankPageProposals(proposals, [], { productSpecies: ['dog'] });

    const names = ranked.map(r => r.pageName);
    expect(names).toContain('Dog Food Dry');
    expect(names).not.toContain('Cat Food Dry');
  });
});

describe('Page Reranker — verified identity gate', () => {
  const proposals = [
    { pageId: 'p1', pageName: 'Dog Food Dry', confidence: 0.80 },
    { pageId: 'p2', pageName: 'Dog Food Wet', confidence: 0.70 },
  ];

  it('blocks reranking when no verified Page catalog is supplied', () => {
    expect(() => assertVerifiedPageRerankContext(null)).toThrow(PageRerankBlockedError);
    expect(() => assertVerifiedPageRerankContext(new Set())).toThrow(PageRerankBlockedError);
    expect(() => assertVerifiedPageRerankContext()).toThrow(/verified Page identity/);
  });

  it('rerankPageProposalsVerified throws without verified Page data (never executes)', () => {
    expect(() => rerankPageProposalsVerified(proposals, [], { verifiedPageIds: new Set() }))
      .toThrow(PageRerankBlockedError);
  });

  it('filters proposals to verified identities only', () => {
    const ranked = rerankPageProposalsVerified(proposals, [], {
      verifiedPageIds: new Set(['p1']),
      maxPages: 5,
    });
    expect(ranked.map(r => r.pageId)).toEqual(['p1']);
  });

  it('does not execute cross-species or hierarchy logic on unverified pages', () => {
    const ranked = rerankPageProposalsVerified(
      [{ pageId: 'p9', pageName: 'Cat Food', confidence: 0.99 }],
      [],
      { verifiedPageIds: new Set(['p9']), productSpecies: ['dog'] },
    );
    expect(ranked).toEqual([]);
  });
});
