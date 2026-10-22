import { describe, expect, it } from 'vitest';
import {
  createDiscoveryAssessment,
  DiscoveryAssessmentSchema,
} from '../../shared/schemas/discovery-assessment';

const hash = 'a'.repeat(64);
const complete = {
  version: 1,
  state: 'complete',
  approvedDomains: ['example.test'],
  authorityHash: hash,
  domains: [{
    domain: 'example.test',
    methods: [
      { method: 'local_index', state: 'complete', eligibleCount: 1, emittedCount: 1, emittedCandidateIds: ['candidate-1'], limit: 2, excludedCount: 0, exclusionReasons: [], failures: [], modelCallIds: [] },
      { method: 'sitemap', state: 'complete', eligibleCount: 1, emittedCount: 1, emittedCandidateIds: ['candidate-1'], limit: 2, excludedCount: 0, exclusionReasons: [], failures: [], modelCallIds: [] },
    ],
  }],
  candidates: [{
    candidateId: 'candidate-1',
    sourceHash: hash,
    outcome: 'verified',
    failure: null,
    retainedArtifactRef: 'artifact://candidate-1',
    artifactHash: hash,
    visibleIdentity: { name: 'Known product', brand: 'Known brand', decision: 'consistent', evidenceRefs: ['artifact://candidate-1#heading'] },
    variants: [],
    variantDecision: null,
  }],
  candidateCount: 1,
  assessedCount: 1,
  candidateSetHash: hash,
  sourceHashes: [hash],
  selectorIds: ['selector-call-1'],
  modelCallIds: ['model-call-1'],
  truncated: false,
};

describe('discovery assessment contract', () => {
  it('accepts complete bounded observations with retained evidence and actual call identifiers', () => {
    expect(createDiscoveryAssessment(complete)).toMatchObject({
      state: 'complete',
      selectorIds: ['selector-call-1'],
      modelCallIds: ['model-call-1'],
    });
  });

  it('allows absent retained artifacts when none was available', () => {
    const candidate = { ...complete.candidates[0], retainedArtifactRef: null, artifactHash: null };
    expect(createDiscoveryAssessment({ ...complete, candidates: [candidate] }).state).toBe('complete');
  });

  it.each([
    ['failed domain method', { domains: [{ ...complete.domains[0], methods: [{ ...complete.domains[0].methods[0], state: 'partial', failures: ['fetch failed'] }] }] }],
    ['truncated candidate set', { truncated: true }],
    ['missing candidate outcome', { candidateCount: 2 }],
    ['too few candidates for emitted coverage', { domains: [{ ...complete.domains[0], methods: complete.domains[0].methods.map(method => ({ ...method, eligibleCount: 2, emittedCount: 2, emittedCandidateIds: ['candidate-1', 'candidate-2'], limit: 2 })) }] }],
    ['failed candidate fetch', { candidates: [{ ...complete.candidates[0], outcome: 'fetch_failed', failure: 'timeout' }] }],
  ])('rejects complete assessment with %s', (_description, change) => {
    expect(DiscoveryAssessmentSchema.safeParse({ ...complete, ...change }).success).toBe(false);
  });

  it('keeps partial retrieval, failed candidates and truncation distinct from complete', () => {
    const result = createDiscoveryAssessment({
      ...complete,
      state: 'partial',
      truncated: true,
      candidateCount: 2,
      candidates: [{ ...complete.candidates[0], outcome: 'fetch_failed', failure: 'connection refused', retainedArtifactRef: null, artifactHash: null }],
      assessedCount: 1,
    });
    expect(result.state).toBe('partial');
    expect(result.candidates[0].outcome).toBe('fetch_failed');
  });
});
