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
import { filterPageCandidatesForBackfill } from '../../classification/page-decision';
import {
  groundSpeciesProposal,
  groundVisualDetail,
  isSilentNarrowing,
  mapLifeStageCoverage,
  requireSupportingCitation,
  isPlaceholderFragment,
} from '../../classification/attribute-grounding-guards';
import { enrichProductDetails } from '../../classification/detail-enrichment';
import { buildEvidenceTargetPacket } from '../../classification/evidence-targeting';
import { buildAssignmentProjection } from '../../classification/assignment-projection';
import type { AttributeMappingConfig, ClassificationEvidence, ClassificationProposal, ProductAttributeConfig } from '../../shared/types';

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

});

describe('P1 #9 no-narrowing', () => {
  it('Salmon|Venison|Lamb survives a single-value proposal', () => {
    expect(isSilentNarrowing('Salmon|Venison|Lamb', 'Salmon')).toBe(true);
    expect(isSilentNarrowing('Adult|All Life Stages', 'Adult')).toBe(true);
    expect(isSilentNarrowing('', 'Salmon')).toBe(false);
    expect(isSilentNarrowing('Salmon', 'Salmon')).toBe(false);
  });

  it('projection refuses unreviewed Flavor narrowing but permits an explicit reviewed reduction', () => {
    const mappings: AttributeMappingConfig[] = [{
      id: 'm', attributeId: 'flavor', catalogField: 'ProductField23',
      serialization: { format: 'direct', separator: '|', prefix: '', suffix: '' }, isStale: false,
    }];
    const attributes: ProductAttributeConfig[] = [{
      id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled', canonicalUnit: null,
      allowedValues: ['Salmon', 'Venison', 'Lamb'], valueAliases: [], visualEvidenceEligibility: 'eligible',
      isClaim: false, isCompositionAttribute: false, group: null,
    }];
    const proposals: ClassificationProposal[] = [{
      id: 'p1', runId: 'r1', productSku: 'SKU001', proposalType: 'field_assignment', targetId: 'flavor',
      proposedValue: 'Salmon', confidence: 0.9, evidenceIds: [], status: 'accepted',
      isBulkAcceptable: false, isStale: false, stalenessReason: null, createdAt: '2026-08-01T00:00:00Z',
    }];
    const authority = { attributes, frozenMappings: mappings };
    const result = buildAssignmentProjection(proposals, { ProductField23: 'Salmon|Venison|Lamb' }, [], mappings, undefined, authority);
    expect(result.fields).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ proposalId: 'p1', targetId: 'flavor', reason: expect.stringContaining('No-narrowing') }),
    ]);
    const reviewed = buildAssignmentProjection([
      { ...proposals[0], revisedValue: 'Salmon', hasRevisedValue: true },
    ], { ProductField23: 'Salmon|Venison|Lamb' }, [], mappings, undefined, authority);
    expect(reviewed.fields).toEqual([
      { catalogField: 'ProductField23', currentValue: 'Salmon|Venison|Lamb', proposedValue: 'Salmon', isOverwrite: true, isNoOp: false },
    ]);
    expect(reviewed.skipped).toEqual([]);
  });
});

describe('P1 #11 species grounding', () => {
  it('cowhide work gloves never gain Cattle', () => {
    const g = groundSpeciesProposal({ proposedSpecies: 'Cattle', titleText: 'cowhide work gloves leather' });
    expect(g.abstain).toBe(true);
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
  });
});
