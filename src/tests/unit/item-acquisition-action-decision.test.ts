import { describe, expect, it } from 'vitest';
import { decideItemAcquisitionAction } from '../../classification/item-acquisition-action-decision';

const base = {
  runId: 'run-fixture', itemId: 'item-fixture', sku: '000000000000', itemName: 'Fixture item',
  missingFields: ['brand'], modelPolicy: null,
};

describe('item acquisition action decision', () => {
  it('rejects duplicate or malformed supplied action IDs before any TypeSafe route is used', async () => {
    const duplicate = await decideItemAcquisitionAction({
      ...base,
      actions: [
        { id: 'approved-action', kind: 'observe', candidateId: 'approved-candidate', label: 'Observe supplied page' },
        { id: 'approved-action', kind: 'links', candidateId: 'approved-candidate', label: 'Read supplied links' },
      ],
    });
    expect(duplicate).toMatchObject({ status: 'stale', actionId: null, modelCallIds: [] });

    const malformed = await decideItemAcquisitionAction({
      ...base,
      actions: [{ id: 'https://attacker.example', kind: 'observe', candidateId: 'approved-candidate', label: 'Observe supplied page' }],
    });
    expect(malformed).toMatchObject({ status: 'stale', actionId: null, modelCallIds: [] });
  });

  it('fails closed when a valid supplied action has no frozen TypeSafe policy', async () => {
    const result = await decideItemAcquisitionAction({
      ...base,
      actions: [{ id: 'approved-action', kind: 'observe', candidateId: 'approved-candidate', label: 'Observe supplied page' }],
    });
    expect(result).toMatchObject({ status: 'unavailable', actionId: null, modelCallIds: [] });
    expect(result.reason).toContain('Frozen TypeSafe model policy');
  });
});
