/**
 * P1 #7, #9, #11–#16 golden fixtures (backfill remediation plan, Milestone 2B).
 *
 * Release-agnostic unit fixtures: synthetic targets + v9 ids where behavior
 * is release-independent (mulch→existing potting-soil; no new leaves
 * invented here). "Passes on v10" is satisfied by these plus the
 * TaxonomyV10-owned v10 validation test (new-type selection,
 * mulch→potting-soil, size-freedom). Depends on the bay-state-v10 pin for
 * live runs; fixtures themselves do not import any release.
 */
import { describe, expect, it } from 'vitest';
import {
  applyProductTypeVeto,
} from '../../classification/product-type-decision';
import { vetoMemberTypeMatch } from '../../classification/cohort-product-type-resolver';
import { isProtectedTargetId } from '../../classification/classification-ownership';
import { processProductFieldTarget } from '../../classification/curation-target-processor';
import { filterPageCandidatesForBackfill } from '../../classification/page-decision';
import {
  groundSpeciesProposal,
  groundVisualDetail,
  isSilentNarrowing,
  mapLifeStageCoverage,
  requireSupportingCitation,
  isPlaceholderFragment,
} from '../../classification/attribute-grounding-guards';
import { isSpeciesRoleBlocked, isVisualDetailNonGrounding, enrichProductDetails } from '../../classification/detail-enrichment';
import { buildEvidenceTargetPacket } from '../../classification/evidence-targeting';
import { buildAssignmentProjection } from '../../classification/assignment-projection';
import { reviewQuoteForRecord } from '../../classification/preserved-content-tags';
import type { ClassificationEvidence } from '../../shared/types';

let seq = 0;
function ev(overrides: Partial<ClassificationEvidence> & { value?: unknown; sourceField?: string | null }): ClassificationEvidence {
  seq += 1;
  return {
    id: `ev-${seq}`,
    runId: 'run-1',
    stageName: 'evidence_extraction',
    productSku: 'SKU-1',
    attributeId: null,
    source: 'catalog_product',
    reliability: 'high',
    sourceUrl: null,
    sourceField: 'name',
    snippet: null,
    value: null,
    metadata: null,
    capturedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as ClassificationEvidence;
}

const DOG_TREATS = { id: 'dog-treats', scope: { animalDomain: 'dog' }, invariantAttributes: { species: 'Dog', 'food-form': 'Treat' } };
const DOG_TOYS = { id: 'dog-toys', scope: { animalDomain: 'dog' }, invariantAttributes: { species: 'Dog' } };
const CAT_TOYS = { id: 'cat-toys', scope: { animalDomain: 'cat' }, invariantAttributes: { species: 'Cat' } };
const BIRD_FOOD = { id: 'bird-food', scope: { animalDomain: 'wild_bird' }, invariantAttributes: { species: 'Bird', 'food-form': 'Seed Blend' } };

function resolved(typeId: string) {
  return {
    status: 'resolved' as const,
    productTypeId: typeId,
    confidence: 0.85,
    selectedProbability: 0.85,
    vendorConfidence: 0.9,
    probabilityBasis: 'deterministic_keyword',
    source: 'keyword' as const,
    derivation: { kind: 'evidence_match' as const },
    modelCallIds: [],
    evidenceIds: ['ev-1'],
    supportingEvidenceIds: ['ev-1'],
    contradictingEvidenceIds: [],
  };
}

describe('P1 #7 type candidate veto', () => {
  it('KONG jerky resolves to dog treats, never toys', () => {
    const evidence = [ev({ sourceField: 'name', value: 'KONG Jerky Treats for Dogs' })];
    const toys = applyProductTypeVeto(resolved('dog-toys'), evidence, [DOG_TOYS, DOG_TREATS]);
    expect(toys.status).toBe('abstained');
    expect(toys.abstentionReason).toMatch(/treat form contradicts toy/);
    const treats = applyProductTypeVeto(resolved('dog-treats'), evidence, [DOG_TOYS, DOG_TREATS]);
    expect(treats.status).toBe('resolved');
  });

  it('KONG Kickeroo resolves to cat toy, never dog-toys', () => {
    const evidence = [ev({ sourceField: 'name', value: 'KONG Kickeroo Cat Toy' })];
    const dog = applyProductTypeVeto(resolved('dog-toys'), evidence, [DOG_TOYS, CAT_TOYS]);
    expect(dog.status).toBe('abstained');
    const cat = applyProductTypeVeto(resolved('cat-toys'), evidence, [DOG_TOYS, CAT_TOYS]);
    expect(cat.status).toBe('resolved');
  });

  it('wild-bird feeder is equipment, never bird food', () => {
    const evidence = [ev({ sourceField: 'name', value: 'Wild-Bird Hopper Feeder' })];
    const food = applyProductTypeVeto(resolved('bird-food'), evidence, [BIRD_FOOD]);
    expect(food.status).toBe('abstained');
  });

  it('human snack without pet evidence abstains', () => {
    const evidence = [ev({ sourceField: 'name', value: 'Trail Mix Human Snack Granola Bar' })];
    const out = applyProductTypeVeto(resolved('dog-treats'), evidence, [DOG_TREATS]);
    expect(out.status).toBe('abstained');
    expect(out.abstentionReason).toMatch(/human snack/);
  });

  it('wet/dry invariants hold; canned food never supplement', () => {
    const wet = [ev({ sourceField: 'name', value: 'Open Farm Wet Dog Food Canned Gravy' })];
    const dry = applyProductTypeVeto(
      resolved('dog-food-dry'),
      wet,
      [{ id: 'dog-food-dry', scope: { animalDomain: 'dog' }, invariantAttributes: { species: 'Dog', 'food-form': 'Dry Food' } }],
    );
    expect(dry.status).toBe('abstained');
    const supp = applyProductTypeVeto(resolved('supplement'), wet, [{ id: 'supplement' }]);
    expect(supp.status).toBe('abstained');
  });

  it('cohort member veto abstains contradicted winners', () => {
    const snap = { productTypes: [DOG_TOYS, CAT_TOYS] };
    const evidence = [ev({ sourceField: 'name', value: 'KONG Kickeroo Cat Toy' })];
    const out = vetoMemberTypeMatch(
      { match: { productTypeId: 'dog-toys', confidence: 0.8, source: 'keyword' }, memberEvidence: evidence, memberSnapshot: snap as never },
    );
    expect(out.productTypeId).toBeNull();
  });
});

describe('P1 #9 no-narrowing', () => {
  it('Salmon|Venison|Lamb survives a single-value proposal', () => {
    expect(isSilentNarrowing('Salmon|Venison|Lamb', 'Salmon')).toBe(true);
    expect(isSilentNarrowing('Adult|All Life Stages', 'Adult')).toBe(true);
    expect(isSilentNarrowing('', 'Salmon')).toBe(false);
    expect(isSilentNarrowing('Salmon', 'Salmon')).toBe(false);
  });

  it('projection skips narrowing visibly', () => {
    const mappings = [{
      id: 'm', attributeId: 'flavor', catalogField: 'ProductField17',
      serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false,
    }];
    const proposals = [{
      id: 'p1', runId: 'r1', productSku: 'SKU001', proposalType: 'field_assignment', targetId: 'flavor',
      proposedValue: 'Salmon', confidence: 0.9, evidenceIds: [], status: 'accepted',
      isBulkAcceptable: false, isStale: false, stalenessReason: null, createdAt: new Date().toISOString(),
    }];
    const result = buildAssignmentProjection(proposals as never, { ProductField17: 'Salmon|Venison|Lamb' }, [], mappings as never);
    expect(result.fields).toHaveLength(0);
    expect(result.skipped[0].reason).toMatch(/No-narrowing/);
  });
});

describe('P1 #11 species grounding', () => {
  it('cowhide work gloves never gain Cattle', () => {
    expect(isSpeciesRoleBlocked('cowhide work gloves leather', 'Cattle')).toBe(true);
    const g = groundSpeciesProposal({ proposedSpecies: 'Cattle', titleText: 'cowhide work gloves leather' });
    expect(g.abstain).toBe(true);
  });

  it('Chicken Yellow boots never gain Poultry', () => {
    expect(isSpeciesRoleBlocked('Chicken Yellow rain boots', 'Poultry')).toBe(true);
  });

  it('For Fish is target species, not flavor', () => {
    const g = groundSpeciesProposal({ proposedSpecies: 'Fish', titleText: 'food For Fish salmon recipe' });
    expect(g.abstain).toBe(false);
  });

  it('conflicting dog/cat abstains; For Cats permits Cat', () => {
    expect(groundSpeciesProposal({ proposedSpecies: 'Cat', titleText: 'dog and cat formula' }).abstain).toBe(true);
    expect(groundSpeciesProposal({ proposedSpecies: 'Cat', titleText: 'cat food For Cats chicken' }).abstain).toBe(false);
  });

  it('enrichment drops blocked species candidates', () => {
    const out = enrichProductDetails({
      evidenceText: 'cowhide work gloves leather',
      packagingOcrData: null,
      curatedTitle: null,
      allowedValues: ['Cattle', 'Dog'],
    });
    expect(out.filter(c => c.attributeId === 'species' && c.value === 'Cattle')).toHaveLength(0);
  });
});

describe('P1 #12 visual detail grounding', () => {
  it('High Viz and Ladybug do not produce Yellow/Red', () => {
    expect(isVisualDetailNonGrounding('high viz safety vest', 'color', 'Yellow')).toBe(true);
    expect(isVisualDetailNonGrounding('ladybug rain boots', 'color', 'Red')).toBe(true);
  });

  it('string toy yields no material; jar feeder no Jar; blister no Pouch', () => {
    expect(isVisualDetailNonGrounding('string toy fuzzy texture', 'material', 'String')).toBe(true);
    expect(isVisualDetailNonGrounding('jar feeder wild bird', 'packaging-type', 'Jar')).toBe(true);
    expect(isVisualDetailNonGrounding('blister card packaging', 'packaging-type', 'Pouch')).toBe(true);
  });

  it('title beats contradicting OCR; confirmed quotes support', () => {
    const beaten = groundVisualDetail({
      attributeId: 'material', proposedValue: 'Polyester',
      titleText: 'cotton canvas tote', ocrQuote: 'Polyester', titleContradictsOcr: true, imageConfirmed: true,
    });
    expect(beaten.grounded).toBe(false);
    const ok = groundVisualDetail({
      attributeId: 'color', proposedValue: 'Blue',
      titleText: 'blue nylon bottle', ocrQuote: 'Blue', titleContradictsOcr: false, imageConfirmed: true,
    });
    expect(ok.grounded).toBe(true);
  });
});

describe('P1 #13 brand agreement (ADR 0041 / issue #349: Brand is never a classifier output)', () => {
  it('Brand targets are outside classification ownership', () => {
    expect(isProtectedTargetId('brand')).toBe(true);
    expect(isProtectedTargetId('flavor')).toBe(false);
  });

  it('the shared composition emits no Brand proposal even with unanimous Brand evidence', async () => {
    const evidence = [
      ev({ source: 'catalog_product', sourceField: 'brand', value: 'Acme' }),
      ev({ source: 'visual_product_evidence', sourceField: 'brand', value: 'Acme' }),
    ];
    const result = await processProductFieldTarget(
      {
        config: { id: 'brand-target', kind: 'product_field', label: 'Brand', enabled: true, selectionMode: 'single', attributeId: 'brand', catalogField: 'ProductField16', optionSource: 'configured', required: false, mandatory: false, sortOrder: 10 },
        options: [],
        attribute: { id: 'brand', name: 'Brand', description: null, valueMode: 'freeText', canonicalUnit: null, allowedValues: [], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: 'Identity' },
      } as never,
      { sku: 'SKU-1', evidence, acceptedProposals: [], allProposals: [] },
      { workspacePath: '/tmp/p1-349', workspaceId: 'ws-p1-349', runId: 'run-1', configSnapshotRef: { id: 's', hash: 'h', sourceCommit: null, createdAt: '2026-01-01T00:00:00.000Z' } } as never,
    );
    expect(result.proposals).toEqual([]);
  });
});

describe('P1 #14 life-stage mapping', () => {
  it('DOGS & PUPPIES maps to All Life Stages', () => {
    const m = mapLifeStageCoverage('DOGS & PUPPIES complete nutrition');
    expect(m).toMatchObject({ mapped: true, value: 'All Life Stages' });
  });

  it('puppy-only maps to Puppy; partial terms abstain', () => {
    expect(mapLifeStageCoverage('puppy formula kibble')).toMatchObject({ mapped: true, value: 'Puppy' });
    expect(mapLifeStageCoverage('junior growth blend')).toMatchObject({ mapped: false, abstain: true });
  });
});

describe('P1 #15 page filtering', () => {
  const candidates = [
    { pageId: 'p1', pageName: 'Dog Food', parentId: null, parentName: null, path: 'Dog Food' },
    { pageId: 'p2', pageName: 'Cat Food', parentId: null, parentName: null, path: 'Cat Food' },
    { pageId: 'p3', pageName: 'Brand - Acme', parentId: null, parentName: null, path: 'Brand - Acme' },
    { pageId: 'p9', pageName: 'Unverified Page', parentId: null, parentName: null, path: 'Unverified Page' },
  ];

  it('assigned pages never reappear; brand pages off; unverified dropped', () => {
    const out = filterPageCandidatesForBackfill(candidates, {
      verifiedPageIds: new Set(['p1', 'p2', 'p3']),
      assignedPageNames: ['Dog Food'],
      resolvedBrand: 'Acme',
      backfillBrandPagesOff: true,
    });
    expect(out.map(p => p.pageName)).toEqual(['Cat Food']);
  });

  it('wrong-brand pages are absent', () => {
    const out = filterPageCandidatesForBackfill(
      [{ pageId: 'p4', pageName: 'Brand - Wrong', parentId: null, parentName: null, path: 'Brand - Wrong' }],
      { verifiedPageIds: new Set(['p4']), assignedPageNames: [], resolvedBrand: 'Acme', backfillBrandPagesOff: false },
    );
    expect(out).toHaveLength(0);
  });
});

describe('P1 #16 supporting citations', () => {
  it('isolated "I" never justifies a value', () => {
    expect(isPlaceholderFragment('I')).toBe(true);
    const packet = buildEvidenceTargetPacket(
      [ev({ sourceField: 'visible_text', value: 'I', attributeId: null })],
      { attributeId: 'color', selectionMode: 'single', proposedValue: 'Red' },
    );
    expect(packet.supporting).toHaveLength(0);
    expect(packet.promptText).not.toMatch(/\bI\b/);
  });

  it('supporting value-bearing citation required; quote exposed', () => {
    expect(requireSupportingCitation([]).grounded).toBe(false);
    const good = requireSupportingCitation([ev({ sourceField: 'name', value: 'Blue collar' })]);
    expect(good.grounded).toBe(true);
    if (good.grounded) expect(good.quote).toMatch(/Blue/);
    expect(reviewQuoteForRecord({ value: 'Blue collar', sourceField: 'name', source: 'catalog_product' }).quote).toMatch(/Blue/);
  });
});
