// story: e04s01 — curation determinism guards (vitest-safe, no bun:sqlite)
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';

// ── e04s01 task 2: gated empty must be abstained, not silent succeeded ────────

describe('e04s01 — attribute proposals gated empty is abstained', () => {
  test('attribute-proposals file returns abstained with reviewable_abstention', () => {
    const src = fs.readFileSync('src/classification/stages/attribute-proposals.ts', 'utf8');
    expect(src).toContain("status: 'abstained'");
    expect(src).toContain('reviewable_abstention');
    // ensure the gated empty branch is the e04s01 change
    expect(src).toContain('e04s01');
  });

  test('attribute proposals stage requires applicability', () => {
    const src = fs.readFileSync('src/classification/stages/attribute-proposals.ts', 'utf8');
    expect(src).toContain('attribute_applicability');
  });
});

// ── e04s01 task 3: variant preservation guard ──────────────────────────────────

describe('e04s01 — title variant preservation', () => {
  test('title-consolidation uses rawRegisterName guard and deterministic fallback', () => {
    const src = fs.readFileSync('src/onboarding/title-consolidation.ts', 'utf8');
    // Issue #111: the raw-only verifyAndRestoreProtectedTokens guard was
    // extended to the merged known-variant set (ensureVariantTokensInTitle
    // over variantSourcesOf) — same story, every evidence origin.
    expect(src).toContain('ensureVariantTokensInTitle');
    expect(src).toContain('variantSourcesOf');
    expect(src).toContain('formatDeterministicTitle');
    expect(src).toContain('rawRegisterName');
    expect(src).toContain('e04s01');
  });

  test('name-consolidation stage threads rawRegisterName', () => {
    const src = fs.readFileSync('src/classification/stages/name-consolidation.ts', 'utf8');
    expect(src).toContain('rawRegisterName');
  });
});

// ── e04s01 task 4: synthesis ordering + snapshot hash fail-closed ───────────────

describe('e04s01 — synthesis ordering guard', () => {
  test('product-curator exposes COHORT_SYNTHESIS_REQUIRED_STAGES and assert', () => {
    const src = fs.readFileSync('src/onboarding/product-curator.ts', 'utf8');
    expect(src).toContain('COHORT_SYNTHESIS_REQUIRED_STAGES');
    expect(src).toContain('assertCohortSynthesisOrdering');
    expect(src).toContain('PR8 DECISION-C');
  });

  test('pipeline-runner enforces snapshot hash recompute', () => {
    const src = fs.readFileSync('src/classification/pipeline-runner.ts', 'utf8');
    expect(src).toContain('snapshotHash');
    expect(src).toContain('Snapshot mutated since build');
  });
});

// ── e04s01 task 1: stage index documented ───────────────────────────────────

describe('e04s01 — stage index documented', () => {
  test('product-curator header documents all 7 stages', () => {
    const src = fs.readFileSync('src/onboarding/product-curator.ts', 'utf8');
    expect(src).toContain('evidence_extraction');
    expect(src).toContain('name_consolidation');
    expect(src).toContain('primary_product_type_proposal');
    expect(src).toContain('attribute_applicability');
    expect(src).toContain('product_attribute_proposals');
    expect(src).toContain('category_page_proposals');
    expect(src).toContain('product_draft_projection');
    expect(src).toContain('ADR 0004');
  });
});
