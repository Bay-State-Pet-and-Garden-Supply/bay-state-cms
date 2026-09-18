// T3 (#227) — artifact capture: hashed, size-capped retention (Vitest, pure).
//
// Every retained artifact carries the SHA-256 of its FULL bytes. Oversized
// content is refused, never truncated — a retained prefix must never
// masquerade as a full-content hash.

import { describe, it, expect } from 'vitest';
import { sha256 } from '../../shared/hash';
import { resolveInvestigationBudget } from '../../shared/schemas/browser-investigation';
import { BudgetLedger } from '../../onboarding/browser-investigation/budgets';
import {
  createArtifactStore,
  type ArtifactSource,
  type ArtifactStore,
  type RetainedArtifact,
} from '../../onboarding/browser-investigation/artifacts';

function storeFor(budget: Parameters<typeof resolveInvestigationBudget>[0] = {}): {
  store: ArtifactStore;
  ledger: BudgetLedger;
} {
  const ledger = new BudgetLedger(resolveInvestigationBudget(budget));
  return { store: createArtifactStore(ledger), ledger };
}

const SOURCE: ArtifactSource = { contentType: 'text/html', sourceUrl: 'https://brand.example/a' };

describe('artifact retention', () => {
  it('retains full bytes with their SHA-256 and byte length', () => {
    const { store } = storeFor();
    const bytes = Buffer.from('<html>hello</html>', 'utf8');
    const artifact: RetainedArtifact = store.retain(bytes, SOURCE);
    expect(artifact.sha256).toBe(sha256(bytes));
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.byteLength).toBe(bytes.length);
    expect(artifact.clipped).toBe(false);
    expect(artifact.contentType).toBe(SOURCE.contentType);
    expect(store.count()).toBe(1);
    expect(store.retainedBytes()).toBe(bytes.length);
  });

  it('refuses over-cap artifacts instead of truncating them', () => {
    const { store } = storeFor({ maxArtifactBytesPerArtifact: 1024 });
    expect(() => store.retain(Buffer.alloc(1025), SOURCE)).toThrowError(/budget_exhausted/);
    expect(store.count()).toBe(0);
  });

  it('refuses retention past the investigation total', () => {
    const { store } = storeFor({ maxArtifactBytesPerArtifact: 2048, maxArtifactBytesTotal: 3000 });
    store.retain(Buffer.alloc(2000), SOURCE);
    expect(() => store.retain(Buffer.alloc(1500), SOURCE)).toThrowError(/budget_exhausted/);
    expect(store.count()).toBe(1);
  });
});
