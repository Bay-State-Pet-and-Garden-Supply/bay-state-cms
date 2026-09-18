// Browser Investigation artifact capture (T3).
//
// Hashed, size-capped retained artifacts for investigation evidence. Every
// artifact carries the SHA-256 of its FULL bytes — a retained prefix must
// never masquerade as a full-content hash, so oversized content is rejected
// (not truncated) and clipped observations are marked incomplete at the
// grammar layer with their artifact reference.
//
// Pure except for the injected ledger: Vitest-safe.

import { sha256 } from '../../shared/hash';
import { InvestigationBudgetError, type BudgetLedger } from './budgets';

export interface RetainedArtifact {
  artifactId: string;
  /** Hex SHA-256 of the FULL retained bytes. Present only when `clipped` is false. */
  sha256: string;
  byteLength: number;
  clipped: false;
  contentType: string;
  sourceUrl: string;
}

export interface ArtifactSource {
  contentType: string;
  sourceUrl: string;
}

export interface ArtifactStore {
  retain(bytes: Uint8Array, source: ArtifactSource): RetainedArtifact;
  count(): number;
  retainedBytes(): number;
}

let artifactSequence = 0;

/**
 * Create a bounded per-investigation artifact store. Retention charges the
 * shared run ledger (per-artifact + total caps enforced there).
 */
export function createArtifactStore(ledger: BudgetLedger): ArtifactStore {
  const artifacts: RetainedArtifact[] = [];
  let total = 0;
  return {
    retain(bytes: Uint8Array, source: ArtifactSource): RetainedArtifact {
      const byteLength = bytes.length;
      try {
        ledger.chargeArtifact(byteLength);
      } catch (err) {
        if (err instanceof InvestigationBudgetError) {
          throw new InvestigationBudgetError(`artifact retention refused: ${err.message}`);
        }
        throw err;
      }
      artifactSequence += 1;
      const artifact: RetainedArtifact = {
        artifactId: `art_${Date.now().toString(36)}_${artifactSequence}`,
        sha256: sha256(bytes),
        byteLength,
        clipped: false,
        contentType: source.contentType,
        sourceUrl: source.sourceUrl,
      };
      artifacts.push(artifact);
      total += byteLength;
      return artifact;
    },
    count(): number {
      return artifacts.length;
    },
    retainedBytes(): number {
      return total;
    },
  };
}
