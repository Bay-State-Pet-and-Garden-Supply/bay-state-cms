import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { verifyProductTypeCandidate } from '../../classification/product-type-verifier';

describe('product-type-verifier (deterministic verification)', () => {
  const dbPath = `/tmp/test-verif-${randomUUID()}.db`;

  beforeAll(() => {
    initDb(dbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try {
      unlinkSync(dbPath);
      unlinkSync(`${dbPath}-wal`);
      unlinkSync(`${dbPath}-shm`);
    } catch {
      // ok
    }
  });

  const mockSnapshot: any = {
    snapshotHash: 'snap-hash-1',
    manifest: { schemaVersion: 1, compatibilityVersion: 1 },
    rulesVersion: '1.0.0',
    productTypes: [
      { id: 'dog_food', name: 'Dog Food', description: null, attributeProfileId: 'dog-prof', oldIdAliases: [] },
      { id: 'cat_food', name: 'Cat Food', description: null, attributeProfileId: 'cat-prof', oldIdAliases: [] },
      { id: 'bird_cage', name: 'Bird Cage', description: null, attributeProfileId: 'bird-prof', oldIdAliases: [] },
    ],
    attributes: [],
    attributeProfiles: [],
    attributeMappings: [],
    curationTargets: [],
    sourceProductHash: 'hash-src',
    canonicalizedConfigJson: '{}',
  };

  it('passes clear, high-confidence candidate with strong evidence support', () => {
    const result = verifyProductTypeCandidate({
      candidateProductTypeId: 'dog_food',
      candidateConfidence: 0.95,
      productTitle: 'Purina Pro Plan Adult Dry Dog Food Chicken & Rice',
      evidence: [
        { snippet: 'Premium dog food formula for adult canines' },
      ],
      snapshot: mockSnapshot,
    });

    expect(result.verdict).toBe('pass_candidate');
    expect(result.reasonCode).toBe('verified_pass');
    expect(result.checks.hasSupportingEvidence).toBe(true);
    expect(result.checks.speciesContradiction).toBe(false);
    expect(result.evidenceSummary.strength).toBe('strong');
  });

  it('flags species contradiction when evidence mentions opposite species', () => {
    const result = verifyProductTypeCandidate({
      candidateProductTypeId: 'dog_food',
      candidateConfidence: 0.9,
      productTitle: 'Whiskas Delicious Kitten Cat Food Salmon Pouch',
      evidence: [
        { snippet: 'Nutritious wet food for growing kittens and adult cats' },
      ],
      snapshot: mockSnapshot,
    });

    expect(result.verdict).toBe('human_review');
    expect(result.reasonCode).toBe('species_contradiction');
    expect(result.checks.speciesContradiction).toBe(true);
    expect(result.reasonMessage).toContain('contradicting candidate type');
  });

  it('abstains on insufficient evidence when no supporting tokens match', () => {
    const result = verifyProductTypeCandidate({
      candidateProductTypeId: 'bird_cage',
      candidateConfidence: 0.75,
      productTitle: 'Generic Metal Wire Enclosure 24x18',
      evidence: [
        { snippet: 'Durable construction with easy clean tray' },
      ],
      snapshot: mockSnapshot,
    });

    expect(result.verdict).toBe('abstain');
    expect(result.reasonCode).toBe('insufficient_evidence');
    expect(result.checks.hasSupportingEvidence).toBe(false);
  });

  it('requires human review when leaf confidence is below threshold', () => {
    const result = verifyProductTypeCandidate({
      candidateProductTypeId: 'dog_food',
      candidateConfidence: 0.45,
      productTitle: 'Purina Dog Food',
      evidence: [
        { snippet: 'Dog food' },
      ],
      snapshot: mockSnapshot,
    });

    expect(result.verdict).toBe('human_review');
    expect(result.reasonCode).toBe('low_leaf_confidence');
    expect(result.checks.leafConfidenceAcceptable).toBe(false);
  });

});

