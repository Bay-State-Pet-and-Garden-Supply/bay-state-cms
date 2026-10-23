import assert from 'node:assert/strict';
import { allocateSharedCost, projectComparisonRows, reconcileComparisonCosts } from './comparison-report';

const effects = reconcileComparisonCosts([
  {
    id: 'setup', arm: 'candidate', attempt_id: 'attempt-1', logical_effect_id: 'shared-source',
    beneficiary_ids: ['item-a', 'item-b'], amount_micros: 11, kind: 'billed',
  },
  {
    id: 'setup-alias', arm: 'candidate', attempt_id: 'attempt-1', logical_effect_id: 'shared-source',
    beneficiary_ids: ['item-b'], amount_micros: 11, kind: 'billed',
  },
  {
    id: 'in-flight', arm: 'candidate', attempt_id: 'attempt-2', logical_effect_id: 'unknown-call',
    beneficiary_ids: [], amount_micros: null, kind: 'unknown',
  },
]);
assert.equal(effects.physical_effects, 2);
assert.equal(effects.attributed_micros, 11);
assert.equal(effects.unallocated_micros, null);
assert.equal(effects.unknown_effects, 1);
assert.equal(effects.reconciled, false);
assert.deepEqual(allocateSharedCost(11, ['item-b', 'item-a']), [
  { itemId: 'item-a', amountMicros: 6 }, { itemId: 'item-b', amountMicros: 5 },
]);
const report = projectComparisonRows([
  { row_id: 'a', upc: 'a', register_name: 'A', price: 3 },
  { row_id: 'a-duplicate', upc: 'a', register_name: 'A duplicate', price: 8 },
  { row_id: 'b-invalid', upc: '', register_name: '', price: null, import_disposition: 'invalid' },
], [
  { id: 'item-a', upc: 'a', stage: 'review', stageStatus: 'completed', status: 'active', preparationStop: 'review_ready_for_operator' },
], [], { measurementMode: 'controlled_replay', costs: effects.effects, paired: true });
assert.equal(report.measurement_mode, 'controlled_replay');
assert.equal(report.accounted_rows, 3);
assert.deepEqual(report.rows.map(row => row.preparation_stop), ['review_ready_for_operator', 'unavailable', 'unavailable']);
assert.equal(report.rows[0]?.allocated_cost_micros, 6);
assert.equal(report.rows[1]?.allocated_cost_micros, null);
assert.equal(report.paired_status, 'blocked');
console.log(JSON.stringify({ status: 'PASS', source_rows: report.source_rows, effects: report.costs.physical_effects }));
