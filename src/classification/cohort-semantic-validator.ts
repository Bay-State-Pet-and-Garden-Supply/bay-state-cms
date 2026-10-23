/**
 * Cohort Semantic Validator (issue #30 PR9) — PURE / deterministic module.
 *
 * Validates a finalized cohort against its FROZEN semantic authority using
 * the curation target scope model (ADR 0013 + `src/shared/schemas/cohorts.ts`
 * `CurationTargetScopeEnum`):
 *
 * - `family_invariant` — canonical Brand must resolve identically across
 *   finalized members (a disagreement is a HARD `family_brand` finding).
 *   There is NO Product Type family invariant (issue #351 SKU-local
 *   evidence): each SKU is classified from its own facts.
 * - `coordinated_variant` — curated title + Category Pages are computed once
 *   per cohort revision; individual member answers legitimately differ.
 *   Validation is CONTRACT CORRESPONDENCE ONLY: the member's title/page
 *   output must correspond to the PARENT DURABLE output assigned to that SKU
 *   (`curated_title` / `coordinated_page` rows) — sibling equality is NEVER
 *   checked. Title/page VARIANT differences between siblings always pass.
 * - `member_local` — attribute applicability under the member's effective
 *   Curation Product Type/profile: every non-universal `field_assignment`
 *   target must be profile-applicable; universal attributes are exempt
 *   (type-independent). Cardinality is re-checked defense-in-depth only
 *   (`validateProposalSafety` in `proposal-safety.ts` already throws first).
 *
 * FROZEN-ONLY CONTRACT: every input is passed in from frozen authority (the
 * parent run row, the persisted execution-evidence snapshot, the durable
 * cohort output rows, the member's committed curation data). This module has
 * NO database access — nothing here may read live batch/config/evidence
 * state, and the inputs must never be derived from a live re-grouping.
 *
 * BLOCKED-NOT-DESTROYED: hard findings produce `status: 'blocked'` — the
 * member's curationData + proposals are NEVER destroyed. The review
 * completion gate refuses blocked items (`semantic_validation_blocked`,
 * review-completion-gate.ts), while the curationData carries the findings
 * for the Review UX (PR10).
 * PR9 REVIEW ROUND 2 contracts (issue #30):
 * - `coordinated_title`: EXACT correspondence — the committed curated title
 *   AND its source must equal the durable parent output's title AND source
 *   (a matching title with a different source is a violation: the member
 *   pipeline materializes the parent output WITH its source).
 * - `coordinated_page`: the BLOCKING comparison is STABLE PAGE IDS — the
 *   member's `category_page` proposals must exact set-match the durable
 *   parent page ids. `pageName` correspondence is ADVISORY-ONLY
 *   (`coordinated_page_name_mismatch`, never blocking): Category Page
 *   Identity is the stable live-store id, not the display name.
 * - `family_brand`: with a frozen configured Brand authority (R2-C), every
 *   member's frozen brand evidence resolves to CANONICAL brand ids via
 *   `resolveBrand` (exact/alias/prefix); coherence is compared on canonical
 *   ids and TWO DISTINCT ids is a HARD disagreement regardless of counts
 *   (NO majority forcing). Unresolved raw text is diagnostic evidence only
 *   and NEVER substitutes for canonical identity. When NO member resolves,
 *   the validator ABSTAINS (soft/diagnostic, no hard block): the frozen
 *   authority cannot confirm a disagreement. Absent/empty brands keep the
 *   legacy deterministic-majority path byte-identical.
 */
import { normalizeBrand } from '../onboarding/product-line-grouper';
import { resolveBrand } from './brand-resolution';
import type { BrandConfig } from '../shared/schemas/classification';
import { evaluateConditions } from './applicability-evaluator';
import type { ReviewedFact } from './reviewed-facts';

// TODO (e09 B1): family title consistency is enforced pre-commit via
// src/classification/family-title-consistency.ts → cohort-name-coordinator.
// This validator intentionally does NOT re-check title skeleton/leakage yet —
// Page correctness (B2) lands next and will extend this module.
// TODO (e09 B2 P5): Page correctness re-validation via src/classification/category-page-correctness.ts
// — semantic compatibility (species, food/treat/toy, wet/dry, chew/jerky, product vs accessory) from
// member frozen evidence vs durable coordinated_page assignment. Pre-commit gate already enforces P5 per-member;
// this post-loop validator will add defense-in-depth without inventing taxonomy (P5 frozen-evidence only).

// ─── Types ─────────────────────────────────────────────────────────────────────

export type CohortSemanticFindingCode =
  | 'family_brand'
  | 'coordinated_title'
  | 'coordinated_page'
  | 'coordinated_page_name_mismatch'
  | 'member_attribute_applicability'
  | 'member_cardinality';

export interface CohortSemanticFinding {
  code: CohortSemanticFindingCode;
  memberSku: string;
  message: string;
}

export interface CohortSemanticFindings {
  status: 'passed' | 'blocked';
  findings: CohortSemanticFinding[];
}

/** The parent durable `coordinated_page` output payload for one SKU. */
export type DurablePageOutput =
  | { status: 'assigned'; pages: Array<{ pageId: string; pageName: string; confidence: number }> }
  | { status: 'abstained'; reason: string };

// ─── Shared helpers ────────────────────────────────────────────────────────────

function passed(): CohortSemanticFindings {
  return { status: 'passed', findings: [] };
}

/**
 * Advisory-only finding codes NEVER block review (status stays 'passed').
 * PR9 review R2 (B): `coordinated_page_name_mismatch` is the sole advisory
 * code — pageName is display data; page identity (the stable id) is what
 * blocks.
 */
const ADVISORY_FINDING_CODES = new Set<CohortSemanticFindingCode>(['coordinated_page_name_mismatch']);

/** True when a finding is HARD (blocking). Advisory diagnostics never block. */
export function isBlockingSemanticFinding(finding: CohortSemanticFinding): boolean {
  return !ADVISORY_FINDING_CODES.has(finding.code);
}

function toFindings(findings: CohortSemanticFinding[]): CohortSemanticFindings {
  return findings.some(isBlockingSemanticFinding)
    ? { status: 'blocked', findings }
    : { status: 'passed', findings };
}

/** Canonical set comparison (order-insensitive, deterministic). */
function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

// ─── family_invariant + coordinated_variant (per member) ─────────────────────

export interface MemberSemanticsInput {
  memberSku: string;
  /** The member's curated title (curationData.curatedTitle). */
  curatedTitle: string | null;
  /** The member's title source (curationData.titleSource). */
  titleSource: string | null;
  /** The member's suggested Category Pages (curationData.suggestedPages). */
  suggestedPages: string[];
  /**
   * PR9 review R2 (B): the member's `category_page` PROPOSALS from the member
   * pipeline result — stable Page ID + display name. The BLOCKING page
   * correspondence is an EXACT SET MATCH on stable page ids against the
   * durable parent page ids; pageName correspondence is advisory-only
   * (`coordinated_page_name_mismatch`, never blocking).
   * PR9 review R3: PRESENCE is distinguished from NON-EMPTINESS — an
   * explicitly supplied set (`!== undefined`) is the ONLY contract for an
   * assigned durable result (empty-set vs non-empty durable BLOCKS;
   * identity-less proposals BLOCK); the legacy name-based comparison applies
   * ONLY when the set is absent entirely (direct/synthetic callers).
   */
  pageProposals?: Array<{ pageId: string | null; pageName: string }>;
  /**
   * The parent durable `curated_title` output for this SKU, or null. Only
   * multi-item group members have entries (singletons are never coordinated —
   * DECISION-O); a member with a cohort-coordinated titleSource and no
   * durable output is semantically inconsistent.
   */
  durableTitleOutput?: { title: string; source: 'llm_cohort' | 'cohort_fallback' } | null;
  /**
   * The parent durable `coordinated_page` output for this SKU, or null.
   * Pages cover ALL members (DECISION-A), so a missing row (without an
   * expected-empty marker) is a finding — PR8 already fails those members
   * closed, this re-asserts the correspondence.
   */
  durablePageOutput?: DurablePageOutput | null;
  /**
   * True when the parent page op chose EXPECTED-EMPTY (page target disabled
   * or no verified pages — DECISION-C): no output rows by design, members
   * abstain deterministically with zero pages.
   */
  pageOutputExpectedEmpty?: boolean;
}

const COORDINATED_TITLE_SOURCES = new Set(['llm_cohort', 'cohort_fallback']);

/**
 * Per-member coordinated_variant checks (issue #351 SKU-local evidence).
 * NEVER compares siblings to each other: every check is the member's own
 * output against the parent durable output assigned to that SKU (title/page
 * coordination). There is NO family Product Type invariant — each SKU is
 * classified from its own facts, so a member's suggested type is never
 * judged against a parent or sibling conclusion.
 */
export function validateMemberSemantics(
  input: MemberSemanticsInput,
): CohortSemanticFindings {
  const findings: CohortSemanticFinding[] = [];
  const { memberSku } = input;

  // ── coordinated_variant: title correspondence to the durable output ──────
  // PR9 review R2 (B): EXACT correspondence — the committed projection must
  // carry BOTH the durable coordinated title AND its exact source. A title
  // that merely equals the durable text with a different source (e.g.
  // 'llm_cohort' vs the durable 'cohort_fallback') is a coordinated-title
  // violation, not a pass: the member pipeline materializes the parent
  // output WITH its source, so a source mismatch means the projection did not
  // actually come from the durable authority.
  if (input.durableTitleOutput) {
    const titleMatches =
      input.curatedTitle === input.durableTitleOutput.title &&
      input.titleSource === input.durableTitleOutput.source;
    if (!titleMatches) {
      findings.push({
        code: 'coordinated_title',
        memberSku,
        message:
          `Curated title "${input.curatedTitle ?? '(none)'}" (source=${input.titleSource ?? 'none'}) ` +
          `does not exactly correspond to the parent durable coordinated title ` +
          `"${input.durableTitleOutput.title}" (source=${input.durableTitleOutput.source}) for this SKU.`,
      });
    }
  } else if (input.titleSource !== null && COORDINATED_TITLE_SOURCES.has(input.titleSource)) {
    // A title that CLAIMS cohort coordination must have a durable parent
    // output — a coordinated title without one is a semantic inconsistency
    // (singleton/per-item titles carry non-cohort sources and pass here).
    findings.push({
      code: 'coordinated_title',
      memberSku,
      message:
        `Curated title claims cohort coordination (titleSource="${input.titleSource}") but no ` +
        'durable parent curated_title output exists for this SKU.',
    });
  }

  // ── coordinated_variant: page correspondence to the durable output ───────
  // PR9 review R2 (B): the BLOCKING comparison is STABLE PAGE IDS — the
  // member's `category_page` proposals (passed from the member pipeline
  // result at the call site) must exact set-match the durable parent page
  // ids. pageName correspondence is an ADDITIONAL advisory diagnostic
  // (`coordinated_page_name_mismatch`, never blocking): Category Page
  // Identity is the stable live-store id, not the display name.
  // PR9 review R3: PRESENCE is distinguished from NON-EMPTINESS — an
  // explicitly supplied set (active cohort caller) is the ONLY contract for
  // an assigned durable result: any identity-less proposal BLOCKS, an empty
  // set against a non-empty durable set BLOCKS, and the display-name
  // fallback is reserved EXCLUSIVELY for callers that did not supply a
  // proposal set at all (legacy/direct synthetic callers).
  const pageProposalSetSupplied = input.pageProposals !== undefined;
  const pageProposals = input.pageProposals ?? [];
  const memberPageIds = pageProposals
    .map(proposal => proposal.pageId)
    .filter((id): id is string => id !== null && id !== undefined && id.length > 0);
  const identityLessProposal = pageProposals.some(
    proposal => !proposal.pageId || proposal.pageId.length === 0,
  );
  if (input.durablePageOutput) {
    if (input.durablePageOutput.status === 'assigned') {
      const durablePages = input.durablePageOutput.pages;
      if (pageProposalSetSupplied) {
        // Active cohort: the supplied proposal set is the ONLY authority.
        // 1) An explicitly supplied `category_page` proposal without a stable
        //    page identity is itself a hard finding (it can never verify
        //    against the durable ids).
        // 2) The exact proposal Page-ID set must equal the durable Page-ID
        //    set — an EMPTY supplied set against a NON-EMPTY durable set is
        //    a hard finding (the display-name fallback must never mask a
        //    missing materialization).
        const durablePageIds = durablePages.map(page => page.pageId);
        if (identityLessProposal) {
          findings.push({
            code: 'coordinated_page',
            memberSku,
            message:
              'One or more category_page proposals carry no stable page identity — the ' +
              'materialized proposal set can never correspond to the durable assignment.',
          });
        } else if (!sameStringSet(memberPageIds, durablePageIds)) {
          findings.push({
            code: 'coordinated_page',
            memberSku,
            message:
              `Suggested page ids [${memberPageIds.join(', ')}] do not exactly match the parent ` +
              `durable coordinated_page assignment [${durablePageIds.join(', ')}] for this SKU.`,
          });
        } else {
          // Advisory-only name correspondence for matched ids (R2-B): the
          // pageName is display data — a mismatch is a diagnostic (stale or
          // renamed store page), never a review blocker.
          for (const durable of durablePages) {
            const proposal = pageProposals.find(p => p.pageId === durable.pageId);
            if (proposal && proposal.pageName !== durable.pageName) {
              findings.push({
                code: 'coordinated_page_name_mismatch',
                memberSku,
                message:
                  `Suggested page "${proposal.pageName}" (id ${durable.pageId}) does not match the ` +
                  `durable page name "${durable.pageName}" for this SKU (page identity matches; ` +
                  'name mismatch is advisory).',
              });
            }
          }
        }
      } else {
        // Fallback (no proposal set supplied at all): name-based comparison —
        // the pre-R2 contract for direct/synthetic callers.
        const storedPageNames = durablePages.map(page => page.pageName);
        if (!sameStringSet(input.suggestedPages, storedPageNames)) {
          findings.push({
            code: 'coordinated_page',
            memberSku,
            message:
              `Suggested pages [${input.suggestedPages.join(', ')}] do not exactly match the parent ` +
              `durable coordinated_page assignment [${storedPageNames.join(', ')}] for this SKU.`,
          });
        }
      }
    } else {
      // Abstained durable row ⇒ the member must carry zero pages AND zero
      // category_page proposals (R2-B: a proposal with the same display name
      // but a wrong id must NOT pass).
      if (input.suggestedPages.length > 0 || pageProposals.length > 0) {
        findings.push({
          code: 'coordinated_page',
          memberSku,
          message:
            `Parent coordinated_page output abstained, but the member carries suggested pages ` +
            `[${input.suggestedPages.join(', ')}]` +
            (pageProposals.length > 0 ? ` and ${pageProposals.length} category_page proposal(s).` : '.'),
        });
      }
    }
  } else if (!input.pageOutputExpectedEmpty) {
    // Missing durable page row without the expected-empty marker — PR8 fails
    // the member closed; the validator re-asserts the correspondence.
    findings.push({
      code: 'coordinated_page',
      memberSku,
      message:
        'No parent coordinated_page output exists for this SKU (missing durable row); ' +
        'the member carries no valid page authority.',
    });
  } else {
    // Expected-empty (parent chose no page outputs BY DESIGN — DECISION-C):
    // zero pages AND zero category_page proposals are mandatory (R2-B).
    if (input.suggestedPages.length > 0 || pageProposals.length > 0) {
      findings.push({
        code: 'coordinated_page',
        memberSku,
        message:
          `The parent page op chose expected-empty (no coordinated_page output rows), but the ` +
          `member carries suggested pages [${input.suggestedPages.join(', ')}]` +
          (pageProposals.length > 0 ? ` and ${pageProposals.length} category_page proposal(s).` : '.'),
      });
    }
  }

  return toFindings(findings);
}

// ─── member_local: profile applicability + cardinality (defense-in-depth) ─────

export interface MemberLocalProposal {
  targetId: string | null;
  /** The proposal's proposed value (used for canonical-value de-dup). */
  proposedValue?: unknown;
  /** Effective reviewer-corrected value (canonical when present). */
  revisedValue?: unknown;
  hasRevisedValue?: boolean;
}

export interface MemberLocalProfileEntry {
  attributeId: string;
  cardinality?: 'single' | 'multiple';
  /** v1/v2 free-form profile applicability conditions (frozen). */
  applicabilityConditions?: unknown[];
}

export interface MemberLocalAttributesInput {
  memberSku: string;
  /** field_assignment proposals ONLY (the caller filters). */
  proposals: MemberLocalProposal[];
  /** The member's effective Curation Product Type id (null = none). */
  effectiveTypeId: string | null;
  /** The frozen snapshot attribute config. */
  attributeConfig: Array<{ id: string; isUniversal?: boolean }>;
  /** Universal attribute ids (type-independent applicability — exempt). */
  universalAttributeIds: Set<string> | string[];
  /** Profile attribute ids resolved from the frozen Category + Type pair. */
  profileAttributeIds?: Set<string> | null;
  /** Profile-declared cardinality per attribute id (frozen). */
  cardinalityByAttributeId?: Map<string, 'single' | 'multiple'>;
  /** Frozen profile entries include configured applicability conditions. */
  profileEntriesByAttributeId?: Map<string, MemberLocalProfileEntry> | null;
  /** Member's frozen/reviewed facts for conditional applicability. */
  reviewedFacts?: ReviewedFact[];
  /** Missing/invalid pair and profile authority remain attributable. */
  profileResolution?: { status: 'ready' | 'unresolved' | 'configuration_gap'; reason: string | null };
}


/**
 * member_local re-validation: every non-universal `field_assignment` target
 * must be profile-applicable under the member's effective type; universal
 * attributes are exempt; cardinality is re-checked defense-in-depth (the
 * pipeline's `validateProposalSafety` already throws first — this only
 * records a finding if a proposal set somehow passed with a breach).
 * Cross-sibling member_local equality is NEVER required.
 */
export function validateMemberLocalAttributes(
  input: MemberLocalAttributesInput,
): CohortSemanticFindings {
  const findings: CohortSemanticFinding[] = [];
  const { memberSku } = input;
  const universal = new Set<string>(input.universalAttributeIds);
  const profile = input.profileAttributeIds ?? null;
  const cardinality = input.cardinalityByAttributeId ?? new Map<string, 'single' | 'multiple'>();
  const effectiveTypeId =
    input.effectiveTypeId !== null && input.effectiveTypeId.length > 0
      ? input.effectiveTypeId
      : null;

  const attributeFor = (id: string) => input.attributeConfig.find(candidate => candidate.id === id);
  const isUniversal = (id: string) =>
    universal.has(id) || attributeFor(id)?.isUniversal === true;
  if (input.profileResolution && input.profileResolution.status !== 'ready' && input.proposals.some(proposal => proposal.targetId && !isUniversal(proposal.targetId))) {
    findings.push({
      code: 'member_attribute_applicability',
      memberSku,
      message: `Frozen Attribute Profile resolution is ${input.profileResolution.status}: ${input.profileResolution.reason ?? 'no reason supplied'}`,
    });
  }

  // Cardinality re-check inputs: DISTINCT canonical values per target id. A
  // re-executed member (crash between pipeline completion and the atomic
  // commit) legitimately accumulates IDENTICAL proposals from earlier
  // attempts on the same child run — those are an audit artifact, never a
  // semantic breach. Two DIFFERENT values for a single-cardinality attribute
  // are the breach this defense-in-depth check is here to catch.
  // PR9 review R1 (B5): an array-valued proposal is NOT one canonical value —
  // its internal cardinality counts too. For a single-cardinality target,
  // ['Chicken','Beef'] (or a revised multi-value array) is a breach even
  // though it arrives in ONE proposal record.
  const canonicalValueOf = (proposal: MemberLocalProposal): unknown =>
    proposal.hasRevisedValue ? proposal.revisedValue : proposal.proposedValue;
  const distinctValueMembersOf = (value: unknown): string[] => {
    if (Array.isArray(value)) {
      return [
        ...new Set(
          value
            .filter(member => member !== null && member !== undefined)
            .map(member => String(member).trim())
            .filter(member => member.length > 0),
        ),
      ];
    }
    if (value === null || value === undefined) return [];
    const text = String(value).trim();
    return text.length > 0 ? [text] : [];
  };
  const distinctValuesByTarget = new Map<string, Set<string>>();
  for (const proposal of input.proposals) {
    if (!proposal.targetId) continue;
    if (!distinctValuesByTarget.has(proposal.targetId)) {
      distinctValuesByTarget.set(proposal.targetId, new Set());
    }
    const targetSet = distinctValuesByTarget.get(proposal.targetId)!;
    for (const member of distinctValueMembersOf(canonicalValueOf(proposal))) {
      targetSet.add(member);
    }
  }

  for (const proposal of input.proposals) {
    if (!proposal.targetId) {
      findings.push({
        code: 'member_attribute_applicability',
        memberSku,
        message: 'A field_assignment proposal carries no target attribute id; applicability cannot be established.',
      });
      continue;
    }
    if (isUniversal(proposal.targetId)) continue;

    if (effectiveTypeId === null) {
      findings.push({
        code: 'member_attribute_applicability',
        memberSku,
        message:
          `Field assignment targets "${proposal.targetId}" but no effective Curation Product Type exists; ` +
          'the non-universal attribute cannot be applicable.',
      });
      continue;
    }

    if (profile === null || !profile.has(proposal.targetId)) {
      // Fail closed: a non-universal proposal outside the effective type's
      // profile (or with an unresolvable profile) is inapplicable.
      findings.push({
        code: 'member_attribute_applicability',
        memberSku,
        message:
          `Field assignment targets "${proposal.targetId}" which is not profile-applicable under ` +
          `the effective Curation Product Type "${effectiveTypeId}".`,
      });
    } else {
      // PR9 review R1 (B4): profile membership is NOT enough — a profile
      // entry with `applicabilityConditions` must be re-evaluated against
      // the member's FROZEN/reviewed facts using the ESTABLISHED
      // applicability evaluator (`evaluateConditions` — the same condition
      // semantics the pipeline's applicability stage applies). Fail closed:
      // `not_applicable` AND unresolved/unknown outcomes both block.
      const profileEntry = input.profileEntriesByAttributeId?.get(proposal.targetId);
      const conditions = profileEntry?.applicabilityConditions;
      if (Array.isArray(conditions) && conditions.length > 0) {
        const state = evaluateConditions(conditions, input.reviewedFacts ?? []);
        if (state !== 'applicable') {
          findings.push({
            code: 'member_attribute_applicability',
            memberSku,
            message:
              state === 'not_applicable'
                ? `Field assignment targets "${proposal.targetId}" whose profile applicability ` +
                  `condition is NOT satisfied by the member's frozen/reviewed facts under the ` +
                  `effective Curation Product Type "${effectiveTypeId}".`
                : `Field assignment targets "${proposal.targetId}" whose profile applicability ` +
                  `condition cannot be resolved from the member's frozen/reviewed facts under the ` +
                  `effective Curation Product Type "${effectiveTypeId}".`,
          });
        }
      }
    }
  }

  // Cardinality re-check (defense-in-depth): more than one DISTINCT value
  // for a single-cardinality attribute is a breach the pipeline should
  // already have thrown on.
  for (const [targetId, values] of distinctValuesByTarget) {
    if (values.size <= 1) continue;
    const declared = cardinality.get(targetId);
    let effectiveCardinality: 'single' | 'multiple';
    if (declared) {
      effectiveCardinality = declared;
    } else if (isUniversal(targetId)) {
      // Universal attribute with no profile entry: never assume single.
      effectiveCardinality = 'multiple';
    } else {
      // Profile attribute default per the schema.
      effectiveCardinality = 'single';
    }
    if (effectiveCardinality === 'single') {
      findings.push({
        code: 'member_cardinality',
        memberSku,
        message:
          `Attribute "${targetId}" received ${values.size} distinct field_assignment value(s) but is single-cardinality.`,
      });
    }
  }

  return toFindings(findings);
}

// ─── family_invariant: mutual Brand coherence (post-loop) ────────────────────

export interface CohortBrandMemberInput {
  sku: string;
  /**
   * FROZEN brand evidence for the member (normalizeBrand is applied; empty
   * values are ignored). The canonical brand is the deterministic majority
   * over ALL members' normalized evidence — never a live batch read.
   */
  frozenBrandEvidence: Array<string | null | undefined>;
}

export interface CohortBrandCoherenceOptions {
  /**
   * PR9 review R2 (C): the FROZEN configured canonical Brand identities
   * (`ClassificationConfig['brands']` — `snapshot.brands`), passed from the
   * call site (never a live config read). When non-empty, EVERY member's
   * frozen brand evidence is resolved to CANONICAL brand ids via
   * `resolveBrand` FIRST (exact/alias/prefix against the configured
   * identities + aliases) and coherence is compared on canonical ids:
   * two DISTINCT canonical ids across members is a HARD `family_brand`
   * disagreement regardless of counts (NO majority forcing). Unresolved raw
   * text (resolveBrand null) is diagnostic evidence only and NEVER
   * substitutes for canonical identity. When NO member resolves, the
   * validator ABSTAINS (no hard block) — the frozen authority cannot confirm
   * a disagreement. Absent/empty → the legacy normalizeBrand
   * deterministic-majority path (byte-identical pre-R2 behavior).
   */
  brands?: BrandConfig[];
}

/**
 * Cohort-level mutual Brand coherence.
 *
 * PR9 review R2 (C): when a frozen configured Brand authority is supplied,
 * the canonical comparison happens on RESOLVED BrandConfig ids — members
 * whose raw text resolves to the same canonical id (exact, alias, or
 * prefix) are COHERENT even when their raw strings differ. Two DISTINCT
 * canonical ids across the cohort is a HARD disagreement regardless of
 * counts (no majority forcing). Unresolved raw text is diagnostic evidence
 * only and never blocks; when NO member resolves, the validator ABSTAINS
 * (the authority cannot confirm a disagreement).
 *
 * Legacy path (no brands supplied): the canonical brand is the deterministic
 * majority over normalizeBrand of the FROZEN member brand evidence; a tie
 * (or an empty evidence set) blocks with the tie listed, and every member
 * whose evidence conflicts with the canonical brand is blocked. A singleton
 * cohort follows the same architecture: its evidence IS the canonical brand,
 * so only an internal evidence conflict blocks it.
 */
export function validateCohortBrandCoherence(
  members: CohortBrandMemberInput[],
  options?: CohortBrandCoherenceOptions,
): CohortSemanticFindings {
  const findings: CohortSemanticFinding[] = [];

  const brands = options?.brands;
  if (brands && brands.length > 0) {
    // ── PR9 review R2 (C): canonical Brand identity resolution ───────────
    // Resolve every member's frozen evidence to canonical BrandConfig ids
    // (exact/alias/prefix). Coherence is compared on CANONICAL ids.
    const resolvedIdsBySku = new Map<string, Set<string>>();
    for (const member of members) {
      const ids = new Set<string>();
      for (const evidence of member.frozenBrandEvidence) {
        const resolution = resolveBrand(evidence ?? '', brands);
        if (resolution) ids.add(resolution.brandId);
      }
      if (ids.size > 0) resolvedIdsBySku.set(member.sku, ids);
    }

    if (resolvedIdsBySku.size === 0) {
      // NO member resolves to a configured canonical Brand. The frozen
      // authority cannot confirm a disagreement — ABSTAIN (documented in the
      // module JSDoc): unresolved raw text is diagnostic evidence only and
      // never produces a hard block.
      return passed();
    }

    const distinctCanonicalIds = [
      ...new Set([...resolvedIdsBySku.values()].flatMap(ids => [...ids])),
    ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (distinctCanonicalIds.length <= 1) {
      // Every resolved member agrees on ONE canonical Brand → coherent;
      // unresolved members are diagnostic only and never block.
      return passed();
    }

    // Two or more distinct canonical ids → HARD disagreement, regardless of
    // counts (no majority forcing). The cohort consensus is the id set EVERY
    // resolved member shares; a member carrying an id OUTSIDE that consensus
    // (or an internally conflicting multi-id set) is the conflicted member.
    // When nobody carries an id outside the consensus yet the cohort still
    // has multiple distinct ids (every resolved member internally
    // conflicted), every resolved member is flagged.
    const consensusIds = new Set(distinctCanonicalIds);
    for (const ids of resolvedIdsBySku.values()) {
      for (const id of [...consensusIds]) {
        if (!ids.has(id)) consensusIds.delete(id);
      }
    }
    let flaggedSkus = new Set<string>();
    for (const [sku, ids] of resolvedIdsBySku) {
      if ([...ids].some(id => !consensusIds.has(id))) flaggedSkus.add(sku);
    }
    if (flaggedSkus.size === 0) flaggedSkus = new Set([...resolvedIdsBySku.keys()]);

    for (const member of members) {
      const ids = resolvedIdsBySku.get(member.sku);
      if (!ids || !flaggedSkus.has(member.sku)) continue;
      const idList = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(', ');
      const distinctList = distinctCanonicalIds.join(', ');
      findings.push({
        code: 'family_brand',
        memberSku: member.sku,
        message:
          ids.size > 1
            ? `Member brand evidence resolves to conflicting canonical cohort Brand identities [${idList}] ` +
              `for this SKU; the cohort's distinct canonical Brand identities are [${distinctList}].`
            : `Member brand evidence resolves to canonical Brand "${idList}" which conflicts with the ` +
              `cohort's distinct canonical Brand identities [${distinctList}].`,
      });
    }
    return toFindings(findings);
  }

  // ── Legacy path (no frozen configured brands): deterministic majority ────
  // (byte-identical pre-R2 behavior).
  const normalizedByMember = new Map<string, Set<string>>();
  const counts = new Map<string, number>();
  for (const member of members) {
    const brands = new Set<string>();
    for (const evidence of member.frozenBrandEvidence) {
      const normalized = normalizeBrand(evidence);
      if (!normalized) continue;
      brands.add(normalized);
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
    normalizedByMember.set(member.sku, brands);
  }

  const distinctBrands = [...counts.keys()];
  if (distinctBrands.length === 0) return passed();

  // Stable ordering so the tie list is deterministic (PR9 review R1
  // SHOULD-FIX b: an explicit code-point comparator — never ambient locale
  // collation, which varies across deployments/ICU versions).
  const sortedByCount = [...distinctBrands].sort((a, b) => {
    const diff = (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
    return diff !== 0 ? diff : a < b ? -1 : a > b ? 1 : 0;
  });
  const topCount = counts.get(sortedByCount[0]) ?? 0;
  const tiedBrands = sortedByCount.filter(brand => (counts.get(brand) ?? 0) === topCount);
  const isTie = tiedBrands.length > 1;

  if (isTie) {
    // The canonical brand is unresolved: every member whose evidence
    // participates in the tie is blocked (the finding lists the tie).
    const tiedSet = new Set(tiedBrands);
    for (const member of members) {
      const memberBrands = normalizedByMember.get(member.sku) ?? new Set<string>();
      if ([...memberBrands].some(brand => tiedSet.has(brand))) {
        findings.push({
          code: 'family_brand',
          memberSku: member.sku,
          message:
            `Brand evidence ties across the cohort (tied canonical brands: ${tiedBrands.join(', ')}); ` +
            'the family Brand invariant is unresolved.',
        });
      }
    }
  } else {
    const canonicalBrand = sortedByCount[0];
    for (const member of members) {
      const memberBrands = normalizedByMember.get(member.sku) ?? new Set<string>();
      const conflicting = [...memberBrands].filter(brand => brand !== canonicalBrand);
      for (const conflict of conflicting) {
        findings.push({
          code: 'family_brand',
          memberSku: member.sku,
          message:
            `Member brand "${conflict}" conflicts with the canonical cohort Brand "${canonicalBrand}".`,
        });
      }
    }
  }

  return toFindings(findings);
}

/**
 * PR9 review R1 (B7): deterministic merge of semantic findings — the incoming
 * set (e.g. post-loop Brand findings) is appended to the member's already
 * committed findings with dedupe by (code, memberSku, message) so a member
 * blocked for Product Type / title / applicability / cardinality never loses
 * those diagnostics when Brand coherence is applied post-loop, and a repeated
 * identical finding never duplicates. Order-preserving (existing first).
 */
export function mergeSemanticFindings(
  existing: CohortSemanticFinding[] | undefined | null,
  incoming: CohortSemanticFinding[],
): CohortSemanticFinding[] {
  const seen = new Set<string>();
  const merged: CohortSemanticFinding[] = [];
  for (const finding of [...(existing ?? []), ...incoming]) {
    const key = `${finding.code}\u0000${finding.memberSku}\u0000${finding.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(finding);
  }
  return merged;
}
