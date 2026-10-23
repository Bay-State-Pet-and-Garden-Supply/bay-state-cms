import { z } from 'zod';
import { HEX_64, NormalizedVariantCandidateSchema, VariantMatchDecisionSchema } from './variant-resolution';

// Third-party page price fields are intentionally excluded: imported price remains
// authoritative and discovery observations never compare or replace it.
export const MAX_DISCOVERY_ASSESSMENT_DOMAINS = 100;
export const MAX_DISCOVERY_ASSESSMENT_CANDIDATES = 500;
export const DiscoveryVariantObservationSchema = NormalizedVariantCandidateSchema.omit({ price: true, currency: true });
export type DiscoveryVariantObservation = z.infer<typeof DiscoveryVariantObservationSchema>;

export const DISCOVERY_ASSESSMENT_VERSION = 1 as const;

export const DiscoveryCoverageStateSchema = z.enum(['complete', 'partial', 'unavailable']);
export type DiscoveryCoverageState = z.infer<typeof DiscoveryCoverageStateSchema>;

export const DiscoveryMethodCoverageSchema = z.object({
  method: z.enum(['local_index', 'sitemap']),
  state: DiscoveryCoverageStateSchema,
  eligibleCount: z.number().int().nonnegative(),
  emittedCandidateIds: z.array(z.string().min(1).max(256)).max(MAX_DISCOVERY_ASSESSMENT_CANDIDATES),
  emittedCount: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  excludedCount: z.number().int().nonnegative(),
  exclusionReasons: z.array(z.string().min(1).max(512)).max(250),
  failures: z.array(z.string().min(1).max(512)).max(250),
  modelCallIds: z.array(z.string().min(1).max(256)).max(100),
});
export type DiscoveryMethodCoverage = z.infer<typeof DiscoveryMethodCoverageSchema>;

export const DiscoveryDomainCoverageSchema = z.object({
  domain: z.string().min(1).max(253),
  methods: z.array(DiscoveryMethodCoverageSchema).min(1).max(2),
});
export type DiscoveryDomainCoverage = z.infer<typeof DiscoveryDomainCoverageSchema>;

export const DiscoveryCandidateOutcomeSchema = z.enum([
  'verified', 'fetch_failed', 'parse_failed', 'redirect_rejected', 'not_attempted',
]);
export type DiscoveryCandidateOutcome = z.infer<typeof DiscoveryCandidateOutcomeSchema>;

export const DiscoveryCandidateAssessmentSchema = z.object({
  candidateId: z.string().min(1).max(256),
  sourceHash: z.string().regex(HEX_64),
  outcome: DiscoveryCandidateOutcomeSchema,
  failure: z.string().max(1024).nullable(),
  retainedArtifactRef: z.string().min(1).max(2048).nullable(),
  artifactHash: z.string().regex(HEX_64).nullable(),
  visibleIdentity: z.object({
    name: z.string().max(512).nullable(),
    brand: z.string().max(256).nullable(),
    decision: z.enum(['consistent', 'conflict', 'unknown']),
    evidenceRefs: z.array(z.string().min(1).max(512)).max(32),
  }),
  variants: z.array(DiscoveryVariantObservationSchema).max(250),
  variantDecision: VariantMatchDecisionSchema.nullable(),
});
export type DiscoveryCandidateAssessment = z.infer<typeof DiscoveryCandidateAssessmentSchema>;

export const DiscoveryAssessmentSchema = z.object({
  version: z.literal(DISCOVERY_ASSESSMENT_VERSION),
  state: DiscoveryCoverageStateSchema,
  approvedDomains: z.array(z.string().min(1).max(253)).max(MAX_DISCOVERY_ASSESSMENT_DOMAINS),
  authorityHash: z.string().regex(HEX_64),
  domains: z.array(DiscoveryDomainCoverageSchema).max(MAX_DISCOVERY_ASSESSMENT_DOMAINS),
  candidates: z.array(DiscoveryCandidateAssessmentSchema).max(MAX_DISCOVERY_ASSESSMENT_CANDIDATES),
  candidateCount: z.number().int().nonnegative(),
  assessedCount: z.number().int().nonnegative(),
  candidateSetHash: z.string().regex(HEX_64),
  sourceHashes: z.array(z.string().regex(HEX_64)).max(MAX_DISCOVERY_ASSESSMENT_CANDIDATES),
  selectorIds: z.array(z.string().min(1).max(256)).max(500),
  modelCallIds: z.array(z.string().min(1).max(256)).max(500),
  truncated: z.boolean(),
}).superRefine((assessment, ctx) => {
  if (assessment.assessedCount !== assessment.candidates.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['assessedCount'], message: 'must equal the retained candidate assessment count' });
  }
  if (assessment.candidateCount < assessment.assessedCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['candidateCount'], message: 'cannot be less than assessedCount' });
  }
  if (assessment.state === 'complete' && assessment.approvedDomains.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['approvedDomains'], message: 'complete assessment requires an approved domain boundary' });
  }
  const domainNames = new Set<string>();
  assessment.domains.forEach((domain, index) => {
    if (domainNames.has(domain.domain)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['domains', index, 'domain'], message: 'domain coverage entries must be unique' });
    }
    domainNames.add(domain.domain);
    const methods = new Set(domain.methods.map(method => method.method));
    if (methods.size !== domain.methods.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['domains', index, 'methods'], message: 'method coverage entries must be unique per domain' });
    }
    domain.methods.forEach((method, methodIndex) => {
      if (method.emittedCount > method.eligibleCount) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['domains', index, 'methods', methodIndex, 'emittedCount'], message: 'emittedCount cannot exceed eligibleCount' });
      }
      if (method.emittedCandidateIds.length !== method.emittedCount ||
          new Set(method.emittedCandidateIds).size !== method.emittedCandidateIds.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['domains', index, 'methods', methodIndex, 'emittedCandidateIds'], message: 'emitted candidate IDs must be unique and match emittedCount' });
      }
    });
  });
  if (new Set(assessment.approvedDomains).size !== assessment.approvedDomains.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['approvedDomains'], message: 'approved domains must be unique' });
  }
  if (assessment.state === 'complete' && assessment.domains.length !== assessment.approvedDomains.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['domains'], message: 'complete assessment requires coverage for every approved domain' });
  }
  if (assessment.state === 'complete') {
    if (assessment.truncated) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['truncated'], message: 'complete assessment cannot be truncated' });
    if (assessment.candidateCount !== assessment.assessedCount) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['candidateCount'], message: 'complete assessment must assess every candidate' });
    const emittedCandidateIds = new Set<string>();
    assessment.domains.forEach(domain => domain.methods.forEach(method => {
      method.emittedCandidateIds.forEach(candidateId => emittedCandidateIds.add(candidateId));
    }));
    const assessedCandidateIds = new Set(assessment.candidates.map(candidate => candidate.candidateId));
    if (emittedCandidateIds.size !== assessment.candidateCount ||
        assessedCandidateIds.size !== assessment.candidateCount ||
        assessment.candidates.some(candidate => !emittedCandidateIds.has(candidate.candidateId))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['candidateCount'], message: 'complete candidate assessments must exactly cover the union of emitted candidate IDs' });
    }
    assessment.domains.forEach((domain, index) => {
      if (!assessment.approvedDomains.includes(domain.domain) || domain.methods.length !== 2 ||
          !domain.methods.some(method => method.method === 'local_index') ||
          !domain.methods.some(method => method.method === 'sitemap')) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['domains', index], message: 'complete domain coverage requires local_index and sitemap methods for every approved domain' });
      }
      domain.methods.forEach((method, methodIndex) => {
        if (method.state !== 'complete' || method.failures.length > 0 ||
            method.emittedCount > method.limit ||
            method.emittedCount + method.excludedCount !== method.eligibleCount) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['domains', index, 'methods', methodIndex], message: 'complete assessment requires complete, failure-free, exhaustively classified bounded method coverage' });
        }
      });
    });
    assessment.candidates.forEach((candidate, index) => {
      if (candidate.outcome !== 'verified') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['candidates', index, 'outcome'], message: 'complete assessment cannot contain failed or unattempted candidates' });
      if (!assessment.sourceHashes.includes(candidate.sourceHash)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['candidates', index, 'sourceHash'], message: 'complete assessments must list each candidate source hash' });
      }
    });
  }
});
export type DiscoveryAssessment = z.infer<typeof DiscoveryAssessmentSchema>;

export function createDiscoveryAssessment(input: unknown): DiscoveryAssessment {
  return DiscoveryAssessmentSchema.parse(input);
}

export function safeParseDiscoveryAssessment(input: unknown) {
  return DiscoveryAssessmentSchema.safeParse(input);
}
