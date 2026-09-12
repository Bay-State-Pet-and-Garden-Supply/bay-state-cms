/**
 * Issue #106 SEQUENCE 1b/1c — allocation contract + bounded audit shape (TDD).
 *
 * Determinism is defined over: allocation version + candidate identities /
 * bases + kept ownership + catalog/pending snapshot. Persisted assignments
 * never renumber. Previews carry their allocation scope/snapshot label.
 */
import { describe, it, expect } from 'vitest';
import {
  FILENAME_ALLOCATION_VERSION,
  computeTakenSnapshotRef,
  allocationScopeLabel,
  buildAllocationRecords,
} from '../../onboarding/naming-allocation';

describe('allocation contract', () => {
  it('pins an allocation version', () => {
    expect(FILENAME_ALLOCATION_VERSION).toBe(1);
  });

  it('snapshot refs are deterministic over the taken set, order-independent', () => {
    const a = computeTakenSnapshotRef(['b.html', 'A.html']);
    const b = computeTakenSnapshotRef(['a.html', 'B.HTML']);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(computeTakenSnapshotRef(['a.html'])).not.toBe(a);
  });

  it('scope labels name the allocation scope and snapshot', () => {
    const label = allocationScopeLabel('promotion', 'abc123');
    expect(label).toContain('promotion');
    expect(label).toContain('abc123');
    expect(allocationScopeLabel('preview', 'abc123')).toContain('preview');
  });

  it('records distinguish kept ownership from suffixed allocation', () => {
    const records = buildAllocationRecords({
      candidates: [
        { key: 'u1#i1', itemId: 'i1', base: 'acme-food.html' },
        { key: 'u2#i2', itemId: 'i2', base: 'acme-food.html' },
      ],
      taken: ['live-kept.html'],
      assigned: new Map([
        ['u1#i1', 'acme-food.html'],
        ['u2#i2', 'acme-food-2.html'],
      ]),
      keptIds: new Set<string>(),
      snapshotRef: 'snap1',
      scope: 'promotion',
    });
    expect(records).toHaveLength(2);
    const first = records.find((r) => r.itemId === 'i1')!;
    expect(first.suffix).toBeNull();
    expect(first.keptOwnership).toBe(false);
    expect(first.algorithmVersion).toBe(FILENAME_ALLOCATION_VERSION);
    const second = records.find((r) => r.itemId === 'i2')!;
    expect(second.suffix).toBe(2);
    expect(second.assigned).toBe('acme-food-2.html');
    // Candidate identities are reconstructible (story 21).
    expect(second.candidateKey).toBe('u2#i2');
    expect(second.candidateBase).toBe('acme-food.html');
  });

  it('kept ownership never renumbers', () => {
    const records = buildAllocationRecords({
      candidates: [],
      taken: ['live-kept.html'],
      assigned: new Map(),
      keptIds: new Set(['i0']),
      keptNames: new Map([['i0', 'live-kept.html']]),
      snapshotRef: 'snap1',
      scope: 'promotion',
    });
    expect(records).toEqual([
      expect.objectContaining({ itemId: 'i0', assigned: 'live-kept.html', suffix: null, keptOwnership: true }),
    ]);
  });
});
