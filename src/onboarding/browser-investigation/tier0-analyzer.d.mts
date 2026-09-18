// Types for the dependency-free Tier 0 analyzer (#236).
// The implementation is plain `.mjs` (no imports) so it runs identically in
// the investigation container and the in-process test double. Protocol
// shapes live in `./container-runner` (single source); this file only binds
// the analyzer entrypoint to them.

import type {
  Tier0AnalysisRequest,
  Tier0AnalysisResult,
} from './container-runner';

export const TIER0_ANALYSIS_PROTOCOL_VERSION: 1;

export const TIER0_ANALYZER_CODES: {
  readonly budgetExhausted: 'budget_exhausted';
  readonly invalidInput: 'invalid_input';
};

export class Tier0AnalyzerError extends Error {
  readonly code: 'budget_exhausted' | 'invalid_input';
  constructor(code: 'budget_exhausted' | 'invalid_input', message: string);
}

export function analyzeTier0Captures(request: Tier0AnalysisRequest): Tier0AnalysisResult;
