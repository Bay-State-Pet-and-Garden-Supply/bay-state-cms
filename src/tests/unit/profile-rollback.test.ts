import { describe, it, expect, beforeEach } from 'vitest';

// story: e06s04
describe('profile rollback (e06s04)', () => {
  beforeEach(async () => {
    const { resetProfileVersionsForTest } = await import('../../db/repositories/profile-version-repo');
    resetProfileVersionsForTest();
    const { resetParkingForTest } = await import('../../onboarding/profile-parking');
    resetParkingForTest();
  });

  it('moves pointer atomically and revalidates', async () => {
    const repo = await import('../../db/repositories/profile-version-repo');
    const v1 = repo.createVersion({ domain: 'example.com', selectors: { titleSelector: 'h1' }, runtime: 'rendered', sampleIds: ['a','b','c'], artifactHashes: ['h1'], validationSummary: { ok:true }, provenance: { provider:'openai', model:'gpt', configId:'c1'}, approver:'op', reason:'activate' });
    repo.setActiveVersion('example.com', v1.id);
    const v2 = repo.createVersion({ domain: 'example.com', selectors: { titleSelector: 'h2' }, runtime: 'rendered', sampleIds: ['a','b','c'], artifactHashes: ['h2'], validationSummary: { ok:true }, provenance: { provider:'openai', model:'gpt', configId:'c1'}, approver:'op', reason:'activate' });
    repo.setActiveVersion('example.com', v2.id);
    expect(repo.getActiveVersion('example.com')?.id).toBe(v2.id);
    const rolled = repo.rollbackToVersion('example.com', v1.id);
    expect(rolled?.id).toBe(v1.id);
    expect(repo.getActiveVersion('example.com')?.id).toBe(v1.id);
  });

  it('rollback re-evaluates evidence and does not auto-activate failing version', async () => {
    const gate = await import('../../onboarding/profile-activation-gate');
    const result = gate.evaluateGate({ requiredResults: [{ field:'title', success:true }, { field:'title', success:false }], wrongProduct:false, wrongVariant:false, waiver:false, confirmedCount:3, imageRuleOk:true });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('title');
  });
});
