/**
 * Central Candidate Safety Validator (Milestone 5).
 *
 * Claims and composition require linked direct evidence; absence, inference,
 * Page context, and unapproved sources are rejected. Confidence never bypasses
 * review: claim/composition proposals cannot be bulk-acceptable, and every
 * proposal stays pending until a human decision exists.
 */
import { describe, expect, it } from 'vitest';
import { validateProposalSafety } from '../../classification/proposal-safety';
import type { ClassificationEvidence, ClassificationProposal } from '../../shared/types';
import type { ProductAttributeConfig } from '../../shared/schemas/classification';

function makeAttribute(overrides: Partial<ProductAttributeConfig> = {}): ProductAttributeConfig {
  return {
    id: 'health-benefits',
    name: 'Health Benefits',
    description: null,
    valueMode: 'controlled',
    canonicalUnit: null,
    allowedValues: ['Joint Health', 'Digestion'],
    valueAliases: [],
    visualEvidenceEligibility: 'eligible',
    isClaim: true,
    isCompositionAttribute: false,
    group: 'Health',
    ...overrides,
  };
}

function makeEvidence(overrides: Partial<ClassificationEvidence> = {}): ClassificationEvidence {
  return {
    id: 'ev-1',
    runId: 'run-1',
    stageName: 'evidence_extraction',
    productSku: 'SKU-1',
    attributeId: null,
    source: 'official_product_page',
    reliability: 'high',
    sourceUrl: null,
    sourceField: 'description',
    snippet: 'Supports joint health',
    value: 'Supports joint health',
    metadata: {},
    capturedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeProposal(overrides: Partial<ClassificationProposal> = {}): ClassificationProposal {
  const merged: ClassificationProposal = {
    id: 'prop-1',
    runId: 'run-1',
    productSku: 'SKU-1',
    proposalType: 'field_assignment',
    targetId: 'health-benefits',
    proposedValue: 'Joint Health',
    confidence: 0.95,
    evidenceIds: ['ev-1'],
    status: 'pending',
    isBulkAcceptable: false,
    isStale: false,
    stalenessReason: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
  // Claims/composition require target-specific SUPPORTING evidence (issue #17
  // pass 5b). Default the role split to the union so fixtures exercise the
  // direct-evidence provenance checks; tests may override with an explicit
  // (empty or context-only) supporting list.
  if (merged.supportingEvidenceIds === undefined) {
    merged.supportingEvidenceIds = merged.evidenceIds ?? [];
  }
  return merged;
}

describe('validateProposalSafety — claims', () => {
  const claimAttribute = makeAttribute();

  it('accepts a claim with linked official-product-page evidence', () => {
    const report = validateProposalSafety(
      [makeProposal()],
      { attributes: [claimAttribute], evidence: [makeEvidence()] },
    );
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it('rejects a claim with no linked evidence (absence/inference)', () => {
    const report = validateProposalSafety(
      [makeProposal({ evidenceIds: [] })],
      { attributes: [claimAttribute], evidence: [] },
    );
    expect(report.ok).toBe(false);
    expect(report.findings[0].code).toBe('claim_missing_direct_evidence');
  });

  it('rejects a claim whose evidence id does not resolve', () => {
    const report = validateProposalSafety(
      [makeProposal({ evidenceIds: ['missing-ev'] })],
      { attributes: [claimAttribute], evidence: [makeEvidence()] },
    );
    expect(report.ok).toBe(false);
    expect(report.findings[0].code).toBe('claim_missing_direct_evidence');
  });

  it('rejects a claim supported only by Page context', () => {
    const report = validateProposalSafety(
      [makeProposal()],
      {
        attributes: [claimAttribute],
        evidence: [makeEvidence({ id: 'ev-1', source: 'page_context', reliability: 'low' })],
      },
    );
    expect(report.ok).toBe(false);
    expect(report.findings[0].code).toBe('claim_page_context');
  });

  it('rejects a claim supported by an unapproved source (third-party page / guidance / spreadsheet)', () => {
    for (const source of ['third_party_page', 'catalog_manager_guidance', 'spreadsheet']) {
      const report = validateProposalSafety(
        [makeProposal()],
        {
          attributes: [claimAttribute],
          evidence: [makeEvidence({ id: 'ev-1', source: source as ClassificationEvidence['source'] })],
        },
      );
      expect(report.ok).toBe(false);
      expect(report.findings[0].code).toBe('claim_unapproved_source');
    }
  });

  it('accepts visual product evidence and catalog product evidence for claims', () => {
    for (const source of ['visual_product_evidence', 'catalog_product']) {
      const report = validateProposalSafety(
        [makeProposal()],
        {
          attributes: [claimAttribute],
          evidence: [makeEvidence({ id: 'ev-1', source: source as ClassificationEvidence['source'] })],
        },
      );
      expect(report.ok).toBe(true);
    }
  });

  it('withholds a claim whose only evidence is unrelated context (no supporting ids) (issue #17 pass 5b)', () => {
    const report = validateProposalSafety(
      [makeProposal({
        evidenceIds: ['ev-title'],
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
      })],
      {
        attributes: [claimAttribute],
        evidence: [makeEvidence({ id: 'ev-title', source: 'official_product_page', sourceField: 'name' })],
      },
    );
    expect(report.ok).toBe(false);
    expect(report.findings[0].code).toBe('claim_missing_direct_evidence');
  });

  it('never lets bulk acceptance bypass review for a claim', () => {
    const report = validateProposalSafety(
      [makeProposal({ isBulkAcceptable: true })],
      { attributes: [claimAttribute], evidence: [makeEvidence()] },
    );
    expect(report.ok).toBe(false);
    expect(report.findings[0].code).toBe('bulk_accept_claim');
  });
});

describe('validateProposalSafety — composition', () => {
  const compositionAttribute = makeAttribute({ isClaim: false, isCompositionAttribute: true });

  it('accepts a composition value with direct visual evidence', () => {
    const report = validateProposalSafety(
      [makeProposal({ proposedValue: 'Joint Health' })],
      {
        attributes: [compositionAttribute],
        evidence: [makeEvidence({ id: 'ev-1', source: 'visual_product_evidence' })],
      },
    );
    expect(report.ok).toBe(true);
  });

  it('rejects a composition value without direct evidence', () => {
    const report = validateProposalSafety(
      [makeProposal({ evidenceIds: [] })],
      { attributes: [compositionAttribute], evidence: [] },
    );
    expect(report.ok).toBe(false);
    expect(report.findings[0].code).toBe('composition_missing_direct_evidence');
  });

  it('rejects composition supported by Page context', () => {
    const report = validateProposalSafety(
      [makeProposal()],
      {
        attributes: [compositionAttribute],
        evidence: [makeEvidence({ id: 'ev-1', source: 'page_context' })],
      },
    );
    expect(report.ok).toBe(false);
    expect(report.findings[0].code).toBe('composition_page_context');
  });

  it('rejects composition bulk acceptance', () => {
    const report = validateProposalSafety(
      [makeProposal({ isBulkAcceptable: true })],
      {
        attributes: [compositionAttribute],
        evidence: [makeEvidence({ id: 'ev-1', source: 'official_product_page' })],
      },
    );
    expect(report.ok).toBe(false);
    expect(report.findings[0].code).toBe('bulk_accept_composition');
  });
});

describe('validateProposalSafety — controlled membership and measured units', () => {
  it('rejects a controlled value outside the allowed list', () => {
    const report = validateProposalSafety(
      [makeProposal({ proposedValue: 'Made Up Benefit' })],
      { attributes: [makeAttribute()], evidence: [makeEvidence()] },
    );
    expect(report.ok).toBe(false);
    expect(report.findings[0].code).toBe('controlled_membership');
  });

  it('accepts a controlled value that matches an alias', () => {
    const report = validateProposalSafety(
      [makeProposal({ proposedValue: 'Joint Health' })],
      { attributes: [makeAttribute()], evidence: [makeEvidence()] },
    );
    expect(report.ok).toBe(true);
  });

  it('rejects a non-finite measured value', () => {
    const measured = makeAttribute({ id: 'weight', valueMode: 'measured', canonicalUnit: 'lb', allowedValues: [] });
    const report = validateProposalSafety(
      [makeProposal({ targetId: 'weight', proposedValue: 'heavy' })],
      { attributes: [measured], evidence: [makeEvidence()] },
    );
    expect(report.ok).toBe(false);
    expect(report.findings[0].code).toBe('measured_unit');
  });

  it('accepts a finite measured value', () => {
    const measured = makeAttribute({ id: 'weight', valueMode: 'measured', canonicalUnit: 'lb', allowedValues: [] });
    const report = validateProposalSafety(
      [makeProposal({ targetId: 'weight', proposedValue: '15 lb' })],
      { attributes: [measured], evidence: [makeEvidence()] },
    );
    expect(report.ok).toBe(true);
  });

  it('withholds a claim proposal with contradicting evidence (issue #17 H)', () => {
    const claim = makeAttribute({ id: 'health-benefits', isClaim: true });
    const report = validateProposalSafety(
      [makeProposal({ contradictingEvidenceIds: ['ev-2'] })],
      { attributes: [claim], evidence: [makeEvidence(), makeEvidence({ id: 'ev-2' })] },
    );
    expect(report.ok).toBe(false);
    expect(report.findings[0].code).toBe('claim_contradicting_evidence');
  });

  it('withholds a composition proposal with contradicting evidence (issue #17 H)', () => {
    const composition = makeAttribute({ isClaim: false, isCompositionAttribute: true });
    const report = validateProposalSafety(
      [makeProposal({ contradictingEvidenceIds: ['ev-2'] })],
      { attributes: [composition], evidence: [makeEvidence(), makeEvidence({ id: 'ev-2' })] },
    );
    expect(report.ok).toBe(false);
    expect(report.findings[0].code).toBe('composition_contradicting_evidence');
  });

  it('ignores non-field proposals (primary type, pages, abstentions)', () => {
    const typeProposal = {
      id: 'p-type', runId: 'run-1', productSku: 'SKU-1', proposalType: 'primary_product_type' as const,
      targetId: 'dry-dog-food', proposedValue: { productTypeId: 'dry-dog-food' }, confidence: 0.9,
      evidenceIds: [], status: 'pending' as const, isBulkAcceptable: false, isStale: false,
      stalenessReason: null, createdAt: '2026-08-01T00:00:00.000Z',
    };
    const report = validateProposalSafety([typeProposal], { attributes: [makeAttribute()], evidence: [] });
    expect(report.ok).toBe(true);
  });
});
