import { describe, expect, it } from 'vitest';
import { allocateSharedCost, projectComparisonRows } from '../../../scratch/comparison-report';

describe('projectComparisonRows', () => {
  const inputs = [
    { row_id: 'r1', upc: 'one', register_name: 'One', price: 1 },
    { row_id: 'r2', upc: 'one', register_name: 'One again', price: 2 },
    { row_id: 'r3', upc: 'two', register_name: 'Two', price: 3 },
    { row_id: 'r4', upc: 'three', register_name: 'Three', price: 4 },
  ];

  it('does not treat completion as reviewed success and accounts for each input once', () => {
    const result = projectComparisonRows(inputs, [
      { id: 'i1', upc: 'one', stage: 'discovery', stageStatus: 'completed', status: 'needs_review' },
      { id: 'i3', upc: 'three', stage: 'preparation', stageStatus: 'needs_input', status: 'active' },
      { id: 'i2', upc: 'two', stage: 'preparation', stageStatus: 'completed', status: 'active', sourceUrl: 'https://example.test/two' },
    ], []);
    expect(result.rows.map(row => row.disposition)).toEqual(['blocked', 'duplicate', 'pipeline_pending', 'blocked']);
    expect(result.rows[0]).toMatchObject({ item_id: 'i1', gate_blocks: ['BLOCKED_SOURCE_REVIEW'] });
    expect(result.rows[1]).toMatchObject({ item_id: null, candidates: [] });
    expect(result.imported_rows).toBe(3);
    expect(result.duplicate_rows).toBe(1);
    expect(result.missing_rows).toBe(0);
    expect(result.accounted_rows).toBe(inputs.length);
  });

  it('preserves failures and associates selected candidates only with their own first item row', () => {
    const result = projectComparisonRows(inputs.slice(0, 2), [
      { id: 'i1', upc: 'one', stage: 'discovery', stageStatus: 'failed', status: 'failed', errorMessage: 'provider failed' },
    ], [
      { id: 's1', itemId: 'i1', url: 'https://example.test/a', isSelected: true },
      { id: 's2', itemId: 'other', url: 'https://example.test/b', isSelected: false },
    ]);
    expect(result.rows[0]).toMatchObject({ disposition: 'failed', reason: 'provider failed', candidates: [{ id: 's1', selected: true }] });
    expect(result.rows[1]).toMatchObject({ disposition: 'duplicate', candidates: [] });
  });

  it('reports domain setup and unresolved source blockers without claiming success', () => {
    const result = projectComparisonRows([inputs[0]!, inputs[2]!], [
      { id: 'i1', upc: 'one', stage: 'discovery', stageStatus: 'blocked', status: 'active', errorMessage: 'Brand domain missing from setup' },
      { id: 'i2', upc: 'two', stage: 'find_product_page', stageStatus: 'completed', status: 'active' },
    ], []);
    expect(result.rows[0]?.gate_blocks).toEqual(['BLOCKED_DOMAIN_SETUP']);
    expect(result.rows[1]?.gate_blocks).toEqual(['BLOCKED_SOURCE_REVIEW']);
    expect(result.rows.map(row => row.disposition)).toEqual(['blocked', 'blocked']);
  });
  it('preserves failed stage status when legacy status is imported', () => {
    const result = projectComparisonRows([inputs[0]!], [
      { id: 'i1', upc: 'one', stage: 'find_product_page', stageStatus: 'failed', status: 'imported', errorMessage: 'provider failure' },
    ], []);
    expect(result.rows[0]).toMatchObject({ disposition: 'failed', reason: 'provider failure' });
    expect(result.imported_rows).toBe(1);
  });

  it('accounts for a missing imported item without inventing a skipped or duplicate outcome', () => {
    const result = projectComparisonRows([inputs[0]!], [], []);
    expect(result.rows[0]).toMatchObject({ disposition: 'missing_output', item_id: null, candidates: [] });
    expect(result.imported_rows).toBe(0);
    expect(result.missing_rows).toBe(1);
  });

  it('keeps a selected Discovery source pending progression rather than claiming completion or demanding review again', () => {
    const result = projectComparisonRows([inputs[0]!], [
      { id: 'i1', upc: 'one', stage: 'discovery', stageStatus: 'completed', status: 'imported', sourceUrl: 'https://example.test/one' },
    ], [
      { id: 's1', itemId: 'i1', url: 'https://example.test/one', isSelected: true },
    ]);
    expect(result.rows[0]).toMatchObject({ disposition: 'pipeline_pending', gate_blocks: [] });
  });

  it('keeps typed preparation stops separate from stage completion and treats review entry as unreviewed', () => {
    const result = projectComparisonRows([
      { row_id: 'ready', upc: 'a', register_name: 'A', price: 1 },
      { row_id: 'denied', upc: 'b', register_name: 'B', price: 2 },
      { row_id: 'failed', upc: 'c', register_name: 'C', price: 3 },
    ], [
      { id: 'a', upc: 'a', stage: 'review', stageStatus: 'completed', status: 'active', preparationStop: 'review_ready_for_operator' },
      { id: 'b', upc: 'b', stage: 'discovery', stageStatus: 'denied', status: 'active' },
      { id: 'c', upc: 'c', stage: 'curation', stageStatus: 'failed', status: 'failed' },
    ], [], { paired: true });
    expect(result.rows.map(row => row.preparation_stop)).toEqual(['review_ready_for_operator', 'policy_or_budget_denied', 'failed']);
    expect(result.rows[0]?.disposition).toBe('pipeline_pending');
    expect(result.paired_status).toBe('blocked');
    expect(result.unavailable_metrics).toContain('reviewed_accuracy');
  });

  it('preserves invalid and skipped-existing dispositions and does not turn unknown effect cost into zero', () => {
    const result = projectComparisonRows([
      { row_id: 'bad', upc: 'bad', register_name: 'Bad', price: null, import_disposition: 'invalid' },
      { row_id: 'old', upc: 'old', register_name: 'Old', price: 4, import_disposition: 'skipped_existing' },
    ], [], [], { costs: [
      { id: 'alias-1', arm: 'candidate', attempt_id: 'attempt', logical_effect_id: 'effect', beneficiary_ids: ['item-a'], amount_micros: null, kind: 'unknown' },
      { id: 'alias-2', arm: 'candidate', attempt_id: 'attempt', logical_effect_id: 'effect', beneficiary_ids: ['item-b'], amount_micros: null, kind: 'unknown' },
    ] });
    expect(result.dispositions.invalid).toBe(1);
    expect(result.dispositions.skipped_existing).toBe(1);
    expect(result.rows.map(row => row.preparation_stop)).toEqual(['unavailable', 'unavailable']);
    expect(result.costs).toMatchObject({ physical_effects: 1, attributed_micros: null, unknown_effects: 1, reconciled: false });
    expect(result.costs.effects[0]?.beneficiary_ids).toEqual(['item-a', 'item-b']);
  });

  it('allocates shared integer micros deterministically without losing remainders', () => {
    expect(allocateSharedCost(10, ['b', 'a', 'c'])).toEqual([
      { itemId: 'a', amountMicros: 4 }, { itemId: 'b', amountMicros: 3 }, { itemId: 'c', amountMicros: 3 },
    ]);
  });

  it('projects DEV-0015 matcher and contradiction blocks without authority failure', () => {
    const reason = 'needs_review: no candidate passed verification | verification: [verified] proof=exact_variant_gtin | gates: https://mywoof.com/products/pupsicle [exact_variant_gtin] BLOCKED:matcher:reject_conflict(product_line_mismatch),contradiction(variant=sm conflicts with register xl)';
    const result = projectComparisonRows(
      [{ row_id: 'DEV-0015', upc: '860012493753', register_name: 'WOOF PUPSICLE LAVENDER XL', price: 1 }],
      [{ id: 'i1', upc: '860012493753', stage: 'discovery', stageStatus: 'completed', status: 'needs_review', errorMessage: reason }],
      [],
    );
    expect(result.rows[0]?.disposition).toBe('blocked');
    expect(result.rows[0]?.gate_blocks).toContain('BLOCKED_SOURCE_REVIEW');
    expect(result.rows[0]?.gate_blocks).toContain('BLOCKED_IDENTITY_MATCHER');
    expect(result.rows[0]?.gate_blocks).toContain('BLOCKED_IDENTITY_CONTRADICTION');
    expect(result.rows[0]?.gate_blocks).not.toContain('BLOCKED_IDENTITY_AUTHORITY');
    expect(result.rows[0]?.gate_blocks).not.toContain('BLOCKED_DOMAIN_SETUP');
  });

  it('projects genuine authority failure and leaves missing gates as review-only', () => {
    const authReason = 'needs_review: no candidate passed verification | authority: auto-accept requires the mapped official domain | gates: https://other.example/p [exact_structured_gtin] BLOCKED:no_authority,matcher:reject_conflict(x)';
    const authResult = projectComparisonRows(
      [{ row_id: 'r-auth', upc: 'a1', register_name: 'A', price: 1 }],
      [{ id: 'i1', upc: 'a1', stage: 'discovery', stageStatus: 'completed', status: 'needs_review', errorMessage: authReason }],
      [],
    );
    expect(authResult.rows[0]?.gate_blocks).toContain('BLOCKED_IDENTITY_AUTHORITY');
    const noGates = projectComparisonRows(
      [{ row_id: 'r-plain', upc: 'a2', register_name: 'A2', price: 1 }],
      [{ id: 'i2', upc: 'a2', stage: 'discovery', stageStatus: 'completed', status: 'needs_review', errorMessage: 'needs_review: parked' }],
      [],
    );
    expect(noGates.rows[0]?.gate_blocks).toEqual(['BLOCKED_SOURCE_REVIEW']);
  });
});
