import { describe, it, expect } from 'vitest';
import { titleMatrixFixture } from './helpers/gate-matrix-fixture';

// story: e06s04
describe('profile activation gate (e06s04)', () => {
  it('blocks when title fails on 1 of 3', async () => {
    const { evaluateGate } = await import('../../onboarding/profile-activation-gate');
    const r = evaluateGate({ requiredResults: [{field:'title', success:true},{field:'title', success:true},{field:'title', success:false}], wrongProduct:false, wrongVariant:false, waiver:false, confirmedCount:3, imageRuleOk:true });
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toContain('title');
    expect(r.reviseAction).toBeTruthy();
  });

  it('allows when all required fields pass on all 3', async () => {
    const { evaluateGate } = await import('../../onboarding/profile-activation-gate');
    const r = evaluateGate({ requiredResults: [{field:'title', success:true},{field:'title', success:true},{field:'title', success:true}], wrongProduct:false, wrongVariant:false, waiver:false, confirmedCount:3, imageRuleOk:true });
    expect(r.allowed).toBe(true);
  });

  it('blocks without waiver when <3 and allows with waiver provenance', async () => {
    const { evaluateGate } = await import('../../onboarding/profile-activation-gate');
    const blocked = evaluateGate({ requiredResults: [{field:'title', success:true},{field:'title', success:true}], wrongProduct:false, wrongVariant:false, waiver:false, confirmedCount:2, imageRuleOk:true });
    expect(blocked.allowed).toBe(false);
    expect(blocked.blockReason).toContain('waiver');
    const allowed = evaluateGate({ requiredResults: [{field:'title', success:true},{field:'title', success:true}], wrongProduct:false, wrongVariant:false, waiver:true, confirmedCount:2, imageRuleOk:true });
    expect(allowed.allowed).toBe(true);
  });

  it('blocks on wrong_product and wrong_variant', async () => {
    const { evaluateGate } = await import('../../onboarding/profile-activation-gate');
    expect(evaluateGate({ requiredResults:[{field:'title', success:true},{field:'title', success:true},{field:'title', success:true}], wrongProduct:true, wrongVariant:false, waiver:false, confirmedCount:3, imageRuleOk:true }).allowed).toBe(false);
    expect(evaluateGate({ requiredResults:[{field:'title', success:true},{field:'title', success:true},{field:'title', success:true}], wrongProduct:false, wrongVariant:true, waiver:false, confirmedCount:3, imageRuleOk:true }).allowed).toBe(false);
  });

  it('requires passing run for exact draft version', async () => {
    const { canActivateVersion } = await import('../../onboarding/profile-activation-gate');
    expect(canActivateVersion({ draftVersion: 'v5', passingVersion: 'v4' })).toBe(false);
    expect(canActivateVersion({ draftVersion: 'v5', passingVersion: 'v5' })).toBe(true);
  });
});

// story: e07s01 — evidence-gated activation
import { describe as describe2, it as it2, expect as expect2 } from 'vitest';

describe2('profile activation gate evidence (e07s01)', () => {
  function matrix(ids: string[], hashes: string[]) {
    return titleMatrixFixture('example.com', ids, hashes);
  }

  async function evidenceRefusal(opts: { expected: string[]; samples: string[]; confirmed: number }) {
    const { evaluateGate } = await import('../../onboarding/profile-activation-gate');
    return evaluateGate({
      requiredResults: [{ field: 'title', success: true }],
      wrongProduct: false, wrongVariant: false, waiver: false, confirmedCount: opts.confirmed, imageRuleOk: true,
      matrixResult: matrix(['s1', 's2'], ['h1', 'h2']), expectedArtifactHashes: opts.expected, sampleIds: opts.samples,
    });
  }

  it2('blocks with missing_matrix when matrixResult is null', async () => {
    const { evaluateGate } = await import('../../onboarding/profile-activation-gate');
    const r = evaluateGate({
      requiredResults: [{ field: 'title', success: true }],
      wrongProduct: false, wrongVariant: false, waiver: false, confirmedCount: 3, imageRuleOk: true,
      matrixResult: null, expectedArtifactHashes: ['h1'], sampleIds: ['s1'],
    });
    expect2(r.allowed).toBe(false);
    expect2(r.blockReason).toBe('missing_matrix');
  });

  it2('blocks with artifact_mismatch when hashes differ', async () => {
    const r = await evidenceRefusal({ expected: ['h1', 'h2', 'h4'], samples: ['s1', 's2'], confirmed: 2 });
    expect2(r.allowed).toBe(false);
    expect2(r.blockReason).toBe('artifact_mismatch');
  });

  it2('blocks with missing_samples when matrix does not cover all sampleIds', async () => {
    const r = await evidenceRefusal({ expected: ['h1', 'h2'], samples: ['s1', 's2', 's3'], confirmed: 3 });
    expect2(r.allowed).toBe(false);
    expect2(r.blockReason).toBe('missing_samples');
  });

  it2('allows when evidence matches (happy pass)', async () => {
    const { evaluateGate } = await import('../../onboarding/profile-activation-gate');
    const m = matrix(['s1', 's2', 's3'], ['h1', 'h2', 'h3']);
    const r = evaluateGate({
      requiredResults: [{ field: 'title', success: true }, { field: 'title', success: true }, { field: 'title', success: true }],
      wrongProduct: false, wrongVariant: false, waiver: false, confirmedCount: 3, imageRuleOk: true,
      matrixResult: m, expectedArtifactHashes: ['h1', 'h2', 'h3'], sampleIds: ['s1', 's2', 's3'],
    });
    expect2(r.allowed).toBe(true);
  });
});
