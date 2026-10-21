/**
 * Joint naming + listing-evidence qualification (issue #375).
 *
 * Offline eval harness over the frozen dev corpus using ONLY pure,
 * deterministic, credential-free code paths:
 * - naming: buildNameCandidates + deterministicNameChoice (zero model calls);
 *   ambiguous rows MUST abstain offline (resolveNameSelection without a
 *   TypeSafe route abstains — asserted via the no-route shape, no dispatch).
 * - listing: buildClaimUnits + eligibleEvidenceFor + deterministicClaimCheck
 *   + toDeterministicClaimRecord, aggregated with the service's own rule
 *   (contradicted/insufficient material claim blocks; empty record passes);
 *   the gate evaluator (evaluateListingEvidenceGate) is exercised over the
 *   assembled record for currentness truthfulness.
 *
 * Fixed-population reporting: every dev row counted exactly once for naming
 * AND listing; failures/abstentions included. Asserts the frozen corpus
 * bytes match the digests pinned in the dev-fitted task policy, and that
 * the holdout stays sealed (family-disjoint, never executed here).
 *
 * Runs under `bun test`.
 */
import { describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_NAME_CANDIDATES,
  buildNameCandidates,
  deterministicNameChoice,
  type NameCandidateResult,
  type NameEvidenceText,
} from '../../classification/name-candidates';
import {
  LISTING_EVIDENCE_MAX_CLAIMS,
  LISTING_EVIDENCE_RULES_VERSION,
  buildClaimUnits,
  deterministicClaimCheck,
  eligibleEvidenceFor,
  toDeterministicClaimRecord,
  type FinalListingInput,
} from '../../classification/listing-evidence';
import { evaluateListingEvidenceGate } from '../../classification/listing-evidence-gate';
import { TYPESAFE_EVALUATED_MODEL } from '../../ai/systemone-transport';
import { assertConnectionEnabledForDispatch } from '../../ai/provider-connections';
import type { ProviderConnection } from '../../ai/provider-connections';
import type { ListingEvidenceValidation } from '../../shared/schemas/onboarding';
import type { ClassificationEvidence } from '../../shared/types';

const DEV_PATH = 'src/tests/fixtures/naming-listing-qualification/dev-corpus.json';
const HOLDOUT_PATH = 'src/tests/fixtures/naming-listing-qualification/holdout-corpus.json';
const POLICY_PATH = 'docs/audits/naming-listing-qualification/task-policy.json';

interface CorpusEvidence {
  id: string;
  sku: 'self' | 'sibling';
  source: ClassificationEvidence['source'];
  reliability: ClassificationEvidence['reliability'];
  sourceField: string;
  value: string;
}

interface CorpusNameSpan {
  channel: NameEvidenceText['channel'];
  span: string;
  evidenceId: string;
}

interface CorpusRow {
  id: string;
  familyId: string;
  category: string;
  sku: string;
  mode: 'singleton' | 'cohort';
  brand: string | null;
  evidence: CorpusEvidence[];
  nameSpans: CorpusNameSpan[];
  nameExpected: { kind: 'resolved' | 'needs_selection' | 'conflict' | 'missing' };
  listingTitle: string;
  listingDescription: string | null;
  variantFacts: Record<string, string>;
  requiredFields: string[];
  listingExpectedStatus: 'passed' | 'blocked';
  listingCorrectedDescription?: string;
}

interface CorpusFile {
  corpusId: string;
  description: string;
  frozenVersions: Record<string, string>;
  rows: CorpusRow[];
}

function loadCorpus(corpusPath: string): CorpusFile {
  const raw = fs.readFileSync(path.join(process.cwd(), corpusPath), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !('rows' in parsed)) throw new Error(`bad corpus ${corpusPath}`);
  return parsed as CorpusFile;
}

function evidenceOf(row: CorpusRow): ClassificationEvidence[] {
  return row.evidence.map(e => ({
    id: e.id,
    runId: 'qual-run-dev',
    stageName: 'name_consolidation',
    // Sibling rows keep their own SKU so eligibleEvidenceFor excludes them.
    productSku: e.sku === 'self' ? row.sku : `${row.sku}-SIBLING`,
    attributeId: null,
    source: e.source,
    reliability: e.reliability,
    sourceUrl: null,
    sourceField: e.sourceField,
    snippet: null,
    value: e.value,
    metadata: null,
    capturedAt: '2026-10-19T00:00:00.000Z',
  }) as ClassificationEvidence);
}

function listingInputOf(row: CorpusRow, descriptionOverride?: string | null): FinalListingInput {
  return {
    title: row.listingTitle,
    description: descriptionOverride !== undefined ? descriptionOverride : row.listingDescription,
    variantFacts: row.variantFacts,
    requiredFields: row.requiredFields,
  };
}

/** Same aggregation rule as the listing-evidence service (any included unsafe claim blocks). */
function aggregateDeterministic(
  records: Array<{ verdict: string; material: boolean }>,
  overflow: boolean,
): ListingEvidenceValidation['status'] {
  if (overflow) return 'unavailable';
  if (records.length === 0) return 'passed';
  let hasUnavailable = false;
  let hasInsufficient = false;
  for (const record of records) {
    if (!record.material) continue;
    if (record.verdict === 'contradicted') return 'blocked';
    if (record.verdict === 'unavailable' || record.verdict === 'stale') hasUnavailable = true;
    if (record.verdict === 'insufficient') hasInsufficient = true;
  }
  if (hasUnavailable) return 'unavailable';
  if (hasInsufficient) return 'blocked';
  return 'passed';
}

describe('naming + listing-evidence joint qualification (offline, #375)', () => {
  test('corpora are frozen, family-separated, and pinned by the dev-fitted policy', () => {
    const dev = loadCorpus(DEV_PATH);
    const holdout = loadCorpus(HOLDOUT_PATH);
    expect(dev.rows).toHaveLength(14);
    expect(holdout.rows).toHaveLength(15);

    const devFamilies = new Set<string>();
    for (const r of dev.rows) devFamilies.add(r.familyId);
    const holdFamilies = new Set<string>();
    for (const r of holdout.rows) holdFamilies.add(r.familyId);
    // Intra-dev cohort pair (dev-13/dev-14) shares one family by design;
    // intra-holdout cohort pair (hold-10/hold-14) shares one family by design.
    expect(devFamilies.size).toBe(13);
    expect(holdFamilies.size).toBe(14);
    for (const f of holdFamilies) expect(devFamilies.has(f)).toBe(false);
    // Distinct SKUs everywhere (no SKU reuse across corpora either).
    const devSkus = new Set<string>();
    for (const r of dev.rows) devSkus.add(r.sku);
    for (const r of holdout.rows) {
      expect(devSkus.has(r.sku)).toBe(false);
      expect(r.sku.startsWith('HOLD-')).toBe(true);
    }

    // Required coverage present in dev.
    const devCats = new Set<string>();
    for (const r of dev.rows) devCats.add(r.category);
    for (const need of [
      'official_agree_deterministic',
      'abbreviated_distributor_needs_selection',
      'ocr_single_source',
      'manual_supplies_evidence',
      'conflicting_sizes',
      'missing_brand',
      'missing_size',
      'shipping_weight_ignored',
      'unsupported_text_blocked',
      'negation_contradiction',
      'quantity_mismatch_blocked',
      'optional_omission_passes',
      'cohort_sibling_excluded',
      'cohort_same_family_distinct_sku',
    ]) {
      expect(devCats.has(need)).toBe(true);
    }
    // Holdout is representative, not just disjoint: every dev category is
    // present, including the previously-missing quantity_mismatch_blocked,
    // missing_size, shipping_weight_ignored, the second cohort-pair member,
    // and a second blocked+correction row.
    const holdCats = new Set<string>();
    for (const r of holdout.rows) holdCats.add(r.category);
    for (const need of [
      'official_agree_deterministic',
      'abbreviated_distributor_needs_selection',
      'ocr_single_source',
      'manual_supplies_evidence',
      'conflicting_sizes',
      'missing_brand',
      'missing_size',
      'shipping_weight_ignored',
      'unsupported_text_blocked',
      'negation_contradiction',
      'quantity_mismatch_blocked',
      'optional_omission_passes',
      'cohort_sibling_excluded',
      'cohort_same_family_distinct_sku',
    ]) {
      expect(holdCats.has(need)).toBe(true);
    }
    // Holdout holds a same-family cohort pair by design (mirrors dev-13/14),
    // plus a second blocked+correction row.
    const holdPair = holdout.rows.filter(r => r.familyId === 'holdfam-beacon-cohort-12-24');
    expect(holdPair).toHaveLength(2);
    expect(holdPair.filter(r => r.mode === 'cohort')).toHaveLength(2);
    expect(holdout.rows.filter(r => r.listingCorrectedDescription !== undefined)).toHaveLength(2);
    // Both modes exercised.
    expect(dev.rows.some(r => r.mode === 'cohort')).toBe(true);
    expect(dev.rows.some(r => r.mode === 'singleton')).toBe(true);
    expect(holdout.rows.some(r => r.mode === 'cohort')).toBe(true);
    expect(holdout.rows.some(r => r.mode === 'singleton')).toBe(true);

    // Normalized-title similarity ceiling: category-parallel rows across
    // corpora must not be near-duplicates. Same-category pairs share the
    // same brand-neutral skeleton by construction; the brand token differs
    // (Acme vs Beacon) and the quantities/pets differ per row, so every
    // cross-corpus title pair must stay strictly below 0.60 token Jaccard.
    // (Observed max is the dev-05/hold-05 parallel at ~0.43.)
    // Rationale for 0.60 (not 0.80): a pure brand-swap near-duplicate
    // (Acme->Beacon, all else identical) scores ~0.67 and would pass 0.80,
    // so 0.80 was lax by construction; 0.60 rejects brand-swap/paraphrase
    // near-duplicates while keeping ~0.17 margin above the observed max.
    // The ceiling also binds the dev-fitted policy (similarityCeiling).
    const normTitle = (t: string): string[] =>
      t
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(/\s+/);
    let maxJaccard = 0;
    let maxPair = '';
    for (const d of dev.rows) {
      for (const h of holdout.rows) {
        const a = new Set(normTitle(d.listingTitle));
        const b = new Set(normTitle(h.listingTitle));
        if (a.size === 0 || b.size === 0) continue;
        let inter = 0;
        for (const tok of a) if (b.has(tok)) inter += 1;
        const j = inter / (a.size + b.size - inter);
        if (j > maxJaccard) {
          maxJaccard = j;
          maxPair = `${d.id} vs ${h.id}`;
        }
      }
    }
    expect(`${maxPair} jaccard=${maxJaccard.toFixed(3)}`).not.toContain('NaN');
    expect(maxJaccard).toBeLessThan(0.6);

    // Frozen pins.
    expect(dev.frozenVersions).toEqual({
      listingRules: 'listing-evidence-rules-v1',
      model: TYPESAFE_EVALUATED_MODEL,
      normalization: 'name-normalization-v1',
      policy: 'naming-listing-task-policy-v1-dev',
    });
    expect(holdout.frozenVersions).toEqual(dev.frozenVersions);
    expect(LISTING_EVIDENCE_RULES_VERSION).toBe('listing-evidence-rules-v1');

    const policyRaw: unknown = JSON.parse(fs.readFileSync(path.join(process.cwd(), POLICY_PATH), 'utf8'));
    if (!policyRaw || typeof policyRaw !== 'object') throw new Error('bad task policy');
    const policy = policyRaw as {
      publishedBeforeHoldoutInspection: boolean;
      activation: string;
      sha256: string;
      holdoutSha256: string;
      modelPin: string;
      fitExecutedAt: string;
      fitExecutedBeforeFreezeNote: string;
      freezeAmendmentNote: string;
      frozenRecordedAt: string;
      frozenCommit: string;
      noFurtherEditLock: boolean;
      freezeReview: { reviewer: string; status: string; scope: string; statement: string };
      similarityCeiling: { metric: string; threshold: number; observedMax: number; rationale: string };
      holdoutUnseal: { accessControl: string; requirement: string };
    };
    expect(policy.publishedBeforeHoldoutInspection).toBe(true);
    // Gap-1 provenance: the flag is meaningful only with the recorded
    // fit-then-freeze ordering and frozen-file binding.
    expect(typeof policy.fitExecutedAt).toBe('string');
    expect(policy.fitExecutedAt.length).toBeGreaterThan(0);
    expect(policy.fitExecutedBeforeFreezeNote).toContain('BEFORE');
    expect(policy.fitExecutedBeforeFreezeNote).toContain('holdout seal ordering');
    expect(typeof policy.frozenRecordedAt).toBe('string');
    expect(policy.frozenRecordedAt.length).toBeGreaterThan(0);
    expect(typeof policy.frozenCommit).toBe('string');
    expect(policy.frozenCommit.length).toBeGreaterThan(0);
    // Fix-then-freeze lock: the re-freeze needs an independent reviewer
    // attestation; until status=signed the lock is pending and activation
    // stays OFF. The attestation field must exist with scope + statement.
    expect(policy.noFurtherEditLock).toBe(true);
    expect(policy.freezeAmendmentNote).toContain('13 distinct families');
    expect(typeof policy.freezeReview.reviewer).toBe('string');
    expect(policy.freezeReview.reviewer.length).toBeGreaterThan(0);
    expect(typeof policy.freezeReview.scope).toBe('string');
    expect(policy.freezeReview.scope.length).toBeGreaterThan(0);
    expect(typeof policy.freezeReview.statement).toBe('string');
    expect(policy.freezeReview.statement.length).toBeGreaterThan(0);
    expect(['pending', 'signed']).toContain(policy.freezeReview.status);
    // Tightened similarity ceiling binds the policy: threshold 0.60 with a
    // measured rationale, and the observed max stays below it.
    expect(policy.similarityCeiling.threshold).toBe(0.6);
    expect(policy.similarityCeiling.metric.length).toBeGreaterThan(0);
    expect(policy.similarityCeiling.rationale).toContain('0.429');
    expect(maxJaccard).toBeLessThan(policy.similarityCeiling.threshold);
    // Holdout access: procedural seal honestly disclosed + reviewer-witnessed
    // unseal recorded as an activation-time requirement.
    expect(policy.holdoutUnseal.accessControl.length).toBeGreaterThan(0);
    expect(policy.holdoutUnseal.requirement).toContain('reviewer');
    expect(policy.holdoutUnseal.requirement).toContain('activation-time requirement');
    // Dev description must state the true family count (14 rows, 13 distinct).
    expect(dev.description).toContain('13 distinct families');
    expect(policy.activation.startsWith('OFF')).toBe(true);
    expect(policy.modelPin).toBe(TYPESAFE_EVALUATED_MODEL);
    expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(process.cwd(), DEV_PATH))).digest('hex')).toBe(
      policy.sha256,
    );
    expect(
      crypto.createHash('sha256').update(fs.readFileSync(path.join(process.cwd(), HOLDOUT_PATH))).digest('hex'),
    ).toBe(policy.holdoutSha256);
  });

  test('dev naming: fixed population 14 — deterministic resolves, conflicts/missing hold, ambiguity abstains offline', () => {
    const dev = loadCorpus(DEV_PATH);
    const failures: string[] = [];
    let resolved = 0;
    let needsSelectionAbstained = 0;
    let conflictHeld = 0;
    let missingHeld = 0;
    let zeroCallResolves = 0;

    for (const row of dev.rows) {
      let outcome: NameCandidateResult;
      try {
        const spans: NameEvidenceText[] = row.nameSpans.map(s => ({
          channel: s.channel,
          span: s.span,
          evidenceId: s.evidenceId,
        }));
        // Brand is the row's own attested brand — never borrowed from siblings.
        outcome = buildNameCandidates({ spans, brand: row.brand });
      } catch (err) {
        failures.push(`${row.id}: harness_error ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (row.nameExpected.kind === 'resolved') {
        if (outcome.kind !== 'candidates') {
          failures.push(`${row.id}: expected candidates, got ${outcome.kind}`);
          continue;
        }
        expect(outcome.candidates.length).toBeLessThanOrEqual(MAX_NAME_CANDIDATES);
        expect(outcome.overflow).toBe(false);
        resolved += 1;
        const choice = deterministicNameChoice(outcome.candidates);
        if (choice) {
          zeroCallResolves += 1;
          // Truthful provenance: deterministic, zero model calls.
          if (!choice.title.toLowerCase().startsWith((row.brand ?? '').toLowerCase())) {
            failures.push(`${row.id}: resolved title lost brand-first style: ${choice.title}`);
          }
        } else {
          // Multiple semantically distinct candidates with no TypeSafe route
          // offline: abstention is the ONLY honest outcome (no chat fallback,
          // no invention). Counted, never a harness failure.
          needsSelectionAbstained += 1;
        }
        // Dev rows are constructed so every resolved-case gold title is
        // either the deterministic choice or reachable by typed selection.
        const goldSupported = outcome.candidates.some(
          c => c.title.toLowerCase() === row.listingTitle.toLowerCase(),
        );
        if (!goldSupported) failures.push(`${row.id}: gold title not among candidates: ${row.listingTitle}`);
      } else if (row.nameExpected.kind === 'needs_selection') {
        // Abbreviated register vs full distributor spelling: candidates or
        // honest offline abstention both count; invention/conflict never.
        if (outcome.kind === 'candidates') {
          needsSelectionAbstained += 1; // offline: would dispatch Choice live
        } else if (outcome.kind === 'missing' || outcome.kind === 'conflict') {
          failures.push(`${row.id}: needs_selection row must not ${outcome.kind}`);
        } else if (outcome.kind === 'overflow') {
          failures.push(`${row.id}: needs_selection row must not overflow`);
        }
      } else if (row.nameExpected.kind === 'conflict') {
        if (outcome.kind !== 'conflict') failures.push(`${row.id}: expected conflict hold, got ${outcome.kind}`);
        else conflictHeld += 1;
      } else {
        if (outcome.kind !== 'missing') failures.push(`${row.id}: expected missing hold, got ${outcome.kind}`);
        else missingHeld += 1;
      }
    }

    expect(failures).toEqual([]);
    // Fixed-population accounting cited in the qualification report §2.
    expect(dev.rows).toHaveLength(14);
    expect(resolved).toBe(11);
    expect(needsSelectionAbstained).toBe(1);
    expect(conflictHeld).toBe(1);
    expect(missingHeld).toBe(1);
    expect(zeroCallResolves).toBeGreaterThan(0);
  });

  test('dev listing: fixed population 14 — supported pass, unsafe block, optional omission nonblocking', () => {
    const dev = loadCorpus(DEV_PATH);
    const failures: string[] = [];
    let passed = 0;
    let blocked = 0;
    let totalClaims = 0;
    let deterministicRecords = 0;
    let missedContradictions = 0;
    let falseBlocks = 0;

    for (const row of dev.rows) {
      try {
        const eligible = eligibleEvidenceFor(evidenceOf(row), row.sku);
        // Sibling evidence must never leak into the eligible bundle.
        if (eligible.some(e => e.evidence.id.includes('sib'))) {
          failures.push(`${row.id}: sibling evidence leaked into eligible bundle`);
          continue;
        }
        const built = buildClaimUnits(listingInputOf(row));
        expect(built.overflow).toBe(false);
        expect(built.oversized).toBe(false);
        expect(built.claims.length).toBeLessThanOrEqual(LISTING_EVIDENCE_MAX_CLAIMS);
        const records = built.claims.map(claim =>
          toDeterministicClaimRecord(claim, deterministicClaimCheck(claim, eligible), eligible),
        );
        totalClaims += built.claims.length;
        deterministicRecords += records.filter(r => r.producer === 'deterministic').length;
        // Truthful provenance: every deterministic record carries zero model calls.
        for (const r of records) {
          if (r.producer === 'deterministic' && r.modelCallId !== null) {
            failures.push(`${row.id}: deterministic record carries a model call id`);
          }
        }
        const status = aggregateDeterministic(records, built.overflow);
        if (status !== row.listingExpectedStatus) {
          failures.push(`${row.id}: expected ${row.listingExpectedStatus}, got ${status}`);
          if (row.listingExpectedStatus === 'blocked') missedContradictions += 1;
          else falseBlocks += 1;
          continue;
        }
        if (status === 'passed') passed += 1;
        else blocked += 1;

        // Optional-omission row carries exactly one title claim.
        if (row.category === 'optional_omission_passes' && built.claims.length !== 1) {
          failures.push(`${row.id}: optional omission must yield exactly 1 claim, got ${built.claims.length}`);
        }
        // Unsupported-text row: correction (removing the unsafe sentence)
        // must pass — remove/correct path demonstrated offline.
        if (row.listingCorrectedDescription !== undefined) {
          const corrected = buildClaimUnits(listingInputOf(row, row.listingCorrectedDescription));
          const correctedRecords = corrected.claims.map(claim =>
            toDeterministicClaimRecord(claim, deterministicClaimCheck(claim, eligible), eligible),
          );
          const correctedStatus = aggregateDeterministic(correctedRecords, corrected.overflow);
          if (correctedStatus !== 'passed') {
            failures.push(`${row.id}: corrected listing must pass, got ${correctedStatus}`);
          }
        }
        // Gate truthfulness: a record assembled at the CURRENT hashes passes
        // the single gate evaluator; a drifted listing hash blocks stale.
        const record: ListingEvidenceValidation = {
          recordVersion: 1,
          listingHash: 'a'.repeat(64),
          evidenceHash: 'b'.repeat(64),
          requiredFields: [...row.requiredFields].sort(),
          rulesVersion: LISTING_EVIDENCE_RULES_VERSION,
          modelPolicyDigest: 'snap-naming-listing-qualification-offline',
          claims: records,
          overflow: false,
          modelCallIds: [],
          status,
          findings: status === 'passed' ? [] : ['offline harness finding'],
          evaluatedAt: new Date().toISOString(),
        };
        const gateOk = evaluateListingEvidenceGate({
          curationData: { listingEvidenceValidation: record },
          currentListingHash: 'a'.repeat(64),
          currentEvidenceHash: 'b'.repeat(64),
          currentModelPolicyDigest: 'snap-naming-listing-qualification-offline',
        });
        if (status === 'passed' && !(gateOk.ok && gateOk.status === 'passed')) {
          failures.push(`${row.id}: gate must pass a current passed record`);
        }
        const gateStale = evaluateListingEvidenceGate({
          curationData: { listingEvidenceValidation: record },
          currentListingHash: 'c'.repeat(64),
          currentEvidenceHash: 'b'.repeat(64),
          currentModelPolicyDigest: 'snap-naming-listing-qualification-offline',
        });
        if (gateStale.ok || !('code' in gateStale) || gateStale.code !== 'listing_evidence_stale') {
          failures.push(`${row.id}: gate must stale-block a drifted listing hash`);
        }
      } catch (err) {
        failures.push(`${row.id}: harness_error ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
      }
    }

    expect(failures).toEqual([]);
    // Fixed-population accounting cited in the qualification report §2.
    expect(dev.rows).toHaveLength(14);
    expect(passed).toBe(11);
    expect(blocked).toBe(3);
    expect(missedContradictions).toBe(0);
    expect(falseBlocks).toBe(0);
    expect(totalClaims).toBeGreaterThan(14);
    expect(deterministicRecords).toBe(totalClaims);
  });

  test('dispatch without credentials/routes refuses: disabled connection halts before any network use', () => {
    // Real negative test on the dispatch gate the live Choice path must pass
    // through: assertConnectionEnabledForDispatch throws for a disabled
    // connection, so with no enabled route/credential nothing can dispatch.
    // provider-connections is pure (zero imports), so importing the gate here
    // adds no transport, DB, or credential surface.
    const disabledConn: ProviderConnection = {
      id: 'qual-offline-conn',
      label: 'Qualification offline (disabled)',
      transport: 'systemone',
      baseUrl: 'http://localhost:1/',
      credential: null,
      trustZone: 'this_device',
      enabled: false,
    };
    let threw: unknown = null;
    try {
      assertConnectionEnabledForDispatch(disabledConn, TYPESAFE_EVALUATED_MODEL);
    } catch (err) {
      threw = err;
    }
    expect(threw).not.toBeNull();
    expect((threw as Error).message).toContain('is disabled');
    // The harness above constructs no enabled connection, route, or
    // credential anywhere in this file, so the live Choice path
    // (resolveNameSelection / runBoundedClaimChoices) has no dispatchable
    // target offline. The pin assertions bind the evaluated versions.
    expect(TYPESAFE_EVALUATED_MODEL).toBe('jev-1.13.0');
    expect(MAX_NAME_CANDIDATES).toBe(16);
    expect(LISTING_EVIDENCE_MAX_CLAIMS).toBe(24);
  });
});
