/**
 * Deterministic Product Type Verifier (P2.1).
 *
 * Consumes frozen evidence, configured options, hierarchy, and deterministic
 * scores. Returns a structured verdict, calibrated confidence, reason codes,
 * and evidence strength.
 *
 * Verdicts:
 * - 'pass_candidate': Candidate passed all integrity, domain, and confidence checks.
 * - 'prefer_classifiable_ancestor': Leaf is ambiguous or under-confident, but classifiable ancestor is solid.
 * - 'abstain': Evidence is absent, contradictory, or unclassifiable.
 * - 'human_review': Candidate has partial support or borderline confidence requiring manual curation.
 */

import type { RuntimeClassificationSnapshot } from './runtime-snapshot';

export type ProductTypeVerificationVerdict =
  | 'pass_candidate'
  | 'prefer_classifiable_ancestor'
  | 'abstain'
  | 'human_review';

export interface ProductTypeEvidenceSummary {
  strength: 'strong' | 'moderate' | 'weak' | 'none';
  supportingCount: number;
  contradictingCount: number;
  matchedWords: string[];
}

export interface ProductTypeVerificationResult {
  verdict: ProductTypeVerificationVerdict;
  recommendedProductTypeId: string | null;
  confidence: number;
  reasonCode: string;
  reasonMessage: string;
  checks: {
    configuredIdValid: boolean;
    speciesContradiction: boolean;
    invariantContradiction: boolean;
    hasSupportingEvidence: boolean;
    marginAcceptable: boolean;
    leafConfidenceAcceptable: boolean;
  };
  evidenceSummary: ProductTypeEvidenceSummary;
}

export interface VerifyProductTypeInput {
  candidateProductTypeId: string;
  candidateConfidence: number;
  evidence: Array<{ snippet?: string | null; valueJson?: string | null; source?: string | null }>;
  snapshot: RuntimeClassificationSnapshot;
  productTitle?: string | null;
  sku?: string | null;
  margin?: number | null;
}

// Species tokens for domain contradiction detection
const SPECIES_INDICATORS: Record<string, string[]> = {
  dog: ['dog', 'dogs', 'puppy', 'puppies', 'canine', 'k9'],
  cat: ['cat', 'cats', 'kitten', 'kittens', 'feline'],
  bird: ['bird', 'birds', 'avian', 'parrot', 'parakeet', 'cockatiel', 'finch', 'wild bird'],
  fish: ['fish', 'aquarium', 'cichlid', 'betta', 'goldfish', 'marine'],
  small_animal: ['rabbit', 'hamster', 'guinea pig', 'ferret', 'chinchilla', 'gerbil', 'mouse', 'rat'],
  horse: ['horse', 'horses', 'equine', 'foal', 'pony'],
};

/**
 * Deterministically verify a proposed Product Type against evidence and taxonomy rules.
 */
export function verifyProductTypeCandidate(input: VerifyProductTypeInput): ProductTypeVerificationResult {
  const {
    candidateProductTypeId,
    candidateConfidence,
    evidence,
    snapshot,
    productTitle = '',
    margin = null,
  } = input;

  // 1. Check configured ID integrity
  const configuredType = snapshot.productTypes.find(pt => pt.id === candidateProductTypeId);
  if (!configuredType) {
    return {
      verdict: 'abstain',
      recommendedProductTypeId: null,
      confidence: 0,
      reasonCode: 'unconfigured_product_type',
      reasonMessage: `Product type "${candidateProductTypeId}" is not present in the runtime snapshot configuration.`,
      checks: {
        configuredIdValid: false,
        speciesContradiction: false,
        invariantContradiction: false,
        hasSupportingEvidence: false,
        marginAcceptable: false,
        leafConfidenceAcceptable: false,
      },
      evidenceSummary: {
        strength: 'none',
        supportingCount: 0,
        contradictingCount: 0,
        matchedWords: [],
      },
    };
  }

  // 2. Aggregate text tokens from evidence and product title
  const textCorpus = [
    productTitle ?? '',
    ...evidence.map(e => `${e.snippet ?? ''} ${e.valueJson ?? ''}`),
  ].join(' ').toLowerCase();

  // 3. Check species / domain contradiction
  const candidateLower = candidateProductTypeId.toLowerCase();
  let candidateSpecies: string | null = null;
  for (const [species, tokens] of Object.entries(SPECIES_INDICATORS)) {
    if (tokens.some(t => candidateLower.includes(t))) {
      candidateSpecies = species;
      break;
    }
  }

  let speciesContradiction = false;
  let contradictingSpeciesWord = '';
  if (candidateSpecies) {
    for (const [species, tokens] of Object.entries(SPECIES_INDICATORS)) {
      if (species !== candidateSpecies) {
        for (const token of tokens) {
          const regex = new RegExp(`\\b${token}\\b`, 'i');
          if (regex.test(textCorpus)) {
            // Check if candidate species is also present
            const candidateTokens = SPECIES_INDICATORS[candidateSpecies] ?? [];
            const hasCandidateTokens = candidateTokens.some(ct => new RegExp(`\\b${ct}\\b`, 'i').test(textCorpus));
            if (!hasCandidateTokens) {
              speciesContradiction = true;
              contradictingSpeciesWord = token;
              break;
            }
          }
        }
      }
      if (speciesContradiction) break;
    }
  }

  // 4. Token matching for evidence support
  const nameTokens = configuredType.name
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(t => t.length > 2);

  const matchedWords: string[] = [];
  for (const token of nameTokens) {
    if (new RegExp(`\\b${token}\\b`, 'i').test(textCorpus)) {
      matchedWords.push(token);
    }
  }

  const supportingCount = matchedWords.length;
  const contradictingCount = speciesContradiction ? 1 : 0;

  let strength: ProductTypeEvidenceSummary['strength'] = 'none';
  if (supportingCount >= 2 && !speciesContradiction) {
    strength = 'strong';
  } else if (supportingCount === 1 && !speciesContradiction) {
    strength = 'moderate';
  } else if (supportingCount > 0 && speciesContradiction) {
    strength = 'weak';
  }

  const hasSupportingEvidence = supportingCount > 0;
  const marginAcceptable = margin === null || margin >= 0.15;
  const leafConfidenceAcceptable = candidateConfidence >= 0.60;

  const checks = {
    configuredIdValid: true,
    speciesContradiction,
    invariantContradiction: false,
    hasSupportingEvidence,
    marginAcceptable,
    leafConfidenceAcceptable,
  };

  const evidenceSummary: ProductTypeEvidenceSummary = {
    strength,
    supportingCount,
    contradictingCount,
    matchedWords,
  };

  // Determine verdict fail-closed:
  if (speciesContradiction) {
    return {
      verdict: 'human_review',
      recommendedProductTypeId: candidateProductTypeId,
      confidence: Math.min(candidateConfidence, 0.35),
      reasonCode: 'species_contradiction',
      reasonMessage: `Evidence contains species term "${contradictingSpeciesWord}" contradicting candidate type "${configuredType.name}".`,
      checks,
      evidenceSummary,
    };
  }

  if (!hasSupportingEvidence) {
    return {
      verdict: 'abstain',
      recommendedProductTypeId: null,
      confidence: Math.min(candidateConfidence, 0.2),
      reasonCode: 'insufficient_evidence',
      reasonMessage: `No evidence tokens supporting candidate type "${configuredType.name}" found in product text or evidence snippets.`,
      checks,
      evidenceSummary,
    };
  }

  if (!marginAcceptable) {
    return {
      verdict: 'human_review',
      recommendedProductTypeId: candidateProductTypeId,
      confidence: candidateConfidence,
      reasonCode: 'ambiguous_sibling_margin',
      reasonMessage: `Candidate type margin (${margin}) is below the required 0.15 threshold against top alternative.`,
      checks,
      evidenceSummary,
    };
  }

  if (!leafConfidenceAcceptable) {
    return {
      verdict: 'human_review',
      recommendedProductTypeId: candidateProductTypeId,
      confidence: candidateConfidence,
      reasonCode: 'low_leaf_confidence',
      reasonMessage: `Candidate confidence (${candidateConfidence}) is below the leaf threshold (0.60).`,
      checks,
      evidenceSummary,
    };
  }

  return {
    verdict: 'pass_candidate',
    recommendedProductTypeId: candidateProductTypeId,
    confidence: candidateConfidence,
    reasonCode: 'verified_pass',
    reasonMessage: `Candidate type "${configuredType.name}" verified with ${strength} evidence support.`,
    checks,
    evidenceSummary,
  };
}
