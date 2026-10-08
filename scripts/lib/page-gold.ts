/**
 * Owner-approved page-rule derivation for the JEV expansion corpus.
 *
 * One deep module behind a small interface: load + validate the owner-bound
 * page-rule packet (212 rules, exactly one per verified page), then derive
 * explicit per-product page gold from adjudicated evidence.
 *
 * No network, no model calls, no private-custody reads. Pure derivation:
 * entry evidence in, explicit categoryPages gold out. Unresolved or
 * contradictory subject definitions stay unresolved with exact reasons —
 * absence of evidence never becomes negative completeness.
 *
 * Frozen-taxonomy containment: rule pageIds must sit within the frozen
 * candidate pool; the pool itself always preserves all 212 verified IDs as
 * inference options (rule exclusion only gates gold eligibility, never clips
 * the model pool).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const PAGE_RULE_PACKET_VERSION = 'page-rule-packet-v1' as const;
/** Rev2: owner answers applied; adds zero-match + fallback-only semantics. V1 packets still load. */
export const PAGE_RULE_PACKET_VERSION_V2 = 'page-rule-packet-v2' as const;
export const PAGE_RULE_PACKET_KIND = 'owner-approved-page-rule-packet' as const;
export const PAGE_RULE_MAX_PER_PRODUCT = 4;

/** Every verified page carries exactly one of these owner-approved states. */
export const PageRuleStatusSchema = z.enum(['eligible', 'excluded', 'unresolved']);
export type PageRuleStatus = z.infer<typeof PageRuleStatusSchema>;

export const PageRuleKindSchema = z.enum(['merchandise-subject', 'exact-brand', 'excluded-role', 'unresolved']);
export type PageRuleKind = z.infer<typeof PageRuleKindSchema>;
/** One executable subject predicate. `evidence` cites the exact page field/quote that establishes it. */
export const PagePredicateSchema = z.object({
  kind: z.enum(['known-type-in', 'field-equals', 'brand-exact', 'zero-match-no-frozen-type']),
  /** Frozen product-type ids (known-type-in) — never catalog pseudo-types or raw string matches. */
  typeIds: z.array(z.string().min(1)).optional(),
  /** Controlled field target (field-equals), e.g. species/food-form/fuel-type. */
  targetId: z.string().min(1).optional(),
  /** Canonical frozen value (field-equals), e.g. Dog/Treat/Wood Pellets. */
  value: z.string().min(1).optional(),
  /** Verbatim page-declared brand/line (brand-exact), e.g. "Purina". */
  brand: z.string().min(1).optional(),
  evidence: z.object({
    pageField: z.string().min(1),
    quote: z.string().min(1),
  }).strict(),
}).strict().superRefine((p, ctx) => {
  if (p.kind === 'known-type-in' && (!p.typeIds || p.typeIds.length === 0)) {
    ctx.addIssue({ code: 'custom', message: 'known-type-in predicate requires non-empty typeIds' });
  }
  if (p.kind === 'field-equals' && (p.targetId === undefined || p.value === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'field-equals predicate requires targetId and value' });
  }
  if (p.kind === 'brand-exact' && p.brand === undefined) {
    ctx.addIssue({ code: 'custom', message: 'brand-exact predicate requires brand' });
  }
  if (p.kind === 'zero-match-no-frozen-type' && (p.typeIds !== undefined || p.targetId !== undefined || p.value !== undefined || p.brand !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'zero-match-no-frozen-type predicate carries evidence only (matches zero rows by construction)' });
  }
});
export type PagePredicate = z.infer<typeof PagePredicateSchema>;

export const PageRuleSchema = z.object({
  pageId: z.string().min(1),
  pageName: z.string().min(1),
  exportedGuid: z.string().min(1),
  filename: z.string().min(1),
  sourceFragmentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  status: PageRuleStatusSchema,
  ruleKind: PageRuleKindSchema,
  predicates: z.object({ allOf: z.array(PagePredicateSchema) }).strict(),
  /** Closed only where page copy + frozen types bound the subject; open keeps co-assignment/precedence explicit. */
  completeness: z.enum(['closed', 'open']),
  evidence: z.array(z.object({
    pageField: z.string().min(1),
    quote: z.string().min(1),
    quoteRole: z.enum(['declared-page-subject', 'captured-page-copy', 'identity-or-template-context']),
  }).strict()).min(1),
  ambiguityReasons: z.array(z.string().min(1)),
  neededOwnerDecision: z.object({
    id: z.string().min(1),
    question: z.string().min(1),
    options: z.array(z.string().min(1)).min(1),
  }).strict().nullable(),
  reviewRowSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Rev2: most-specific-only fallback — matches only when no closed merchandise rule matched. */
  fallbackOnly: z.literal(true).optional(),
  /** Rev2: applied owner-answer audit trail (additive). */
  resolutionNotes: z.array(z.object({
    decisionId: z.string().min(1),
    selectedOption: z.string().min(1),
    note: z.string().min(1),
  }).strict()).optional(),
}).strict().superRefine((r, ctx) => {
  if (r.status === 'eligible' && r.predicates.allOf.length === 0) {
    ctx.addIssue({ code: 'custom', message: `eligible rule "${r.pageId}" requires at least one predicate` });
  }
  if (r.status !== 'eligible' && r.predicates.allOf.length !== 0) {
    ctx.addIssue({ code: 'custom', message: `non-eligible rule "${r.pageId}" must carry no executable predicates` });
  }
  if (r.status === 'unresolved' && r.neededOwnerDecision === null) {
    ctx.addIssue({ code: 'custom', message: `unresolved rule "${r.pageId}" requires an exact owner decision` });
  }
  if (r.fallbackOnly === true && (r.status !== 'eligible' || r.completeness !== 'closed')) {
    ctx.addIssue({ code: 'custom', message: `fallback-only rule "${r.pageId}" must be eligible-closed` });
  }
  const zeroCount = r.predicates.allOf.filter(p => p.kind === 'zero-match-no-frozen-type').length;
  if (zeroCount > 0 && (zeroCount !== 1 || r.predicates.allOf.length !== 1)) {
    ctx.addIssue({ code: 'custom', message: `zero-match rule "${r.pageId}" must carry exactly one standalone zero-match predicate` });
  }
});
export type PageRule = z.infer<typeof PageRuleSchema>;

export const PageRulePacketSchema = z.object({
  artifactKind: z.literal(PAGE_RULE_PACKET_KIND),
  artifactVersion: z.enum([PAGE_RULE_PACKET_VERSION, PAGE_RULE_PACKET_VERSION_V2]),
  authorityHash: z.string().regex(/^[0-9a-f]{64}$/),
  ownerApproval: z.object({
    decisionsPath: z.string().min(1),
    decisionsSha256: z.string().regex(/^[0-9a-f]{64}$/),
    pageScope: z.object({
      selected: z.string().min(1),
      maxPagesPerProduct: z.literal(PAGE_RULE_MAX_PER_PRODUCT),
      brandMembership: z.string().min(1),
      excludedRoles: z.array(z.string().min(1)),
      compatibleVerifiedHorseFarmWildlifeBee: z.literal(true),
      conflictingSubjectDefinitionsRequireReview: z.literal(true),
      fullCandidateUniverseRetained: z.literal(true),
    }).strict(),
    humanCanaryApproval: z.literal(false),
  }).strict(),
  ruleProvenance: z.string().min(1),
  counts: z.object({
    pages: z.literal(212),
    eligible: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
  }).strict(),
  rules: z.array(PageRuleSchema).length(212),
  membershipSemantics: z.object({
    knownTypePrerequisite: z.literal(true),
    noFitInsufficientPages: z.string().min(1),
    capPerProduct: z.literal(PAGE_RULE_MAX_PER_PRODUCT),
    selectionPolicy: z.string().min(1),
    inferencePool: z.string().min(1),
  }).strict(),
  enrichmentTargets: z.object({
    brandEvidence: z.array(z.object({
      pageId: z.string().min(1),
      pageName: z.string().min(1),
      brand: z.string().min(1),
    }).strict()),
    usageEvidence: z.array(z.object({
      pageId: z.string().min(1),
      pageName: z.string().min(1),
      reason: z.string().min(1),
    }).strict()),
  }).strict(),
  ownerDecisionsRequired: z.array(z.object({
    id: z.string().min(1),
    question: z.string().min(1),
    options: z.array(z.string().min(1)).min(1),
    pageIds: z.array(z.string().min(1)).min(1),
  }).strict()),
  /** Rev2: owner answers applied to produce this packet (additive). */
  appliedDecisions: z.array(z.object({
    id: z.string().min(1),
    selectedOption: z.string().min(1),
    answeredBy: z.string().min(1),
    appliedAt: z.string().min(1),
  }).strict()).optional(),
  integrity: z.object({
    packetSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
}).strict().superRefine((p, ctx) => {
  const ids = p.rules.map(r => r.pageId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', message: 'page rules must contain each pageId exactly once' });
  }
  const sorted = [...ids].sort();
  if (ids.some((id, i) => id !== sorted[i])) {
    ctx.addIssue({ code: 'custom', message: 'page rules must be sorted by pageId' });
  }
  const byStatus = (s: PageRuleStatus): number => p.rules.filter(r => r.status === s).length;
  if (p.counts.eligible !== byStatus('eligible') ||
      p.counts.excluded !== byStatus('excluded') ||
      p.counts.unresolved !== byStatus('unresolved')) {
    ctx.addIssue({ code: 'custom', message: 'counts must match rule statuses' });
  }
});
export type PageRulePacket = z.infer<typeof PageRulePacketSchema>;

const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

/**
 * Load + validate the owner-bound page-rule packet. Fails closed on: schema
 * violations, authority/decision binding drift, non-212 or unordered rules,
 * predicate executability gaps (unknown type/target/value against the frozen
 * snapshot), or packet self-hash drift. Never reads private custody.
 */
export function loadPageRulePacket(args: {
  packetPath: string;
  decisionsPath: string;
  expectedAuthorityHash: string;
  frozenTypes: Map<string, unknown>;
  frozenTargets: Map<string, Set<string>>;
  frozenPageIds: Set<string>;
}): PageRulePacket {
  const packetBytes = fs.readFileSync(path.resolve(args.packetPath));
  const packet = PageRulePacketSchema.parse(JSON.parse(packetBytes.toString('utf8')));
  if (packet.authorityHash !== args.expectedAuthorityHash) {
    fail('page_rule_authority_drift', 'packet authorityHash does not match the frozen authority');
  }
  const decisionsBytes = fs.readFileSync(path.resolve(args.decisionsPath));
  const decisionsSha = sha256(decisionsBytes);
  if (decisionsSha !== packet.ownerApproval.decisionsSha256) {
    fail('page_rule_decision_drift', 'owner decision bytes do not match the packet binding');
  }
  const decisions = JSON.parse(decisionsBytes.toString('utf8')) as {
    pageScope?: { maxPagesPerProduct?: unknown };
  };
  if (decisions?.pageScope?.maxPagesPerProduct !== PAGE_RULE_MAX_PER_PRODUCT) {
    fail('page_rule_decision_drift', 'owner maxPagesPerProduct binding mismatch');
  }
  for (const rule of packet.rules) {
    if (!args.frozenPageIds.has(rule.pageId)) {
      fail('page_rule_outside_frozen_pool', `rule page "${rule.pageId}" not in frozen candidates`);
    }
    for (const predicate of rule.predicates.allOf) {
      if (predicate.kind === 'known-type-in') {
        for (const typeId of predicate.typeIds ?? []) {
          if (!args.frozenTypes.has(typeId)) {
            fail('page_rule_unknown_type', `rule "${rule.pageId}" cites unknown type "${typeId}"`);
          }
        }
      } else if (predicate.kind === 'field-equals') {
        const allowed = args.frozenTargets.get(predicate.targetId!);
        if (!allowed) fail('page_rule_unknown_target', `rule "${rule.pageId}" cites unknown target "${predicate.targetId}"`);
        if (!allowed.has(predicate.value!)) {
          fail('page_rule_noncanonical_value', `rule "${rule.pageId}" cites noncanonical ${predicate.targetId} value "${predicate.value}"`);
        }
      }
    }
  }
  // Self-hash domain: sha256 of the packet file bytes with the trailing integrity block
  // removed textually (generator writes integrity last as `,\n "integrity": {...}\n}\n`).
  // Byte-exact: immune to JSON re-serialization escaping differences.
  const rawText = packetBytes.toString('utf8');
  const integrityAnchor = rawText.lastIndexOf(',\n "integrity"');
  if (integrityAnchor < 0) fail('page_rule_hash_drift', 'packet integrity block not in expected trailing position');
  const unsignedBytes = `${rawText.slice(0, integrityAnchor)}\n}\n`;
  if (sha256(unsignedBytes) !== packet.integrity.packetSha256) {
    fail('page_rule_hash_drift', 'packet self-hash does not match recomputed bytes');
  }
  return packet;
}

/** Adjudicated per-product inputs the matcher may read. Product evidence is direct quotes only. */
export interface PageGoldProductInput {
  sku: string;
  productType: { kind: 'known-type' | 'no-fit' | 'insufficient-evidence'; typeId: string | null };
  fieldByTarget: Map<string, { state: string; value?: string }>;
  /** Direct product-evidence brand (source brand/title identity), verbatim. */
  brand: string | null;
  /** Verbatim direct-evidence quotes (title + admissible excerpts). */
  evidenceQuotes: string[];
}

export interface PageGoldResult {
  state: 'known' | 'partial' | 'unknown';
  completeness: 'complete' | 'partial' | 'unknown';
  pageIds: string[];
  pageAssignments: Array<{ pageId: string; pageName: string }>;
  /** Exact missing predicate/evidence or cap/selection reason; present unless known-complete. */
  pageReason: string | null;
}

function normalizeBrand(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;|’/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Derive explicit page gold for one adjudicated product. Deterministic:
 * predicate match → most-specific merchandise first, exact-brand additive,
 * open-rule unresolved reasons, deterministic pageId tiebreak, hard cap 4.
 * Rev2: zero-match rules never match; fallback-only rules match only when no
 * closed merchandise rule matched; confirmed raw-form rules accept Frozen Raw
 * or Freeze-Dried Raw. no-fit/insufficient-evidence types yield complete-empty
 * pages ONLY under the known-type requirement — never guessed physical
 * assignments.
 */
export function derivePageGold(
  packet: PageRulePacket,
  product: PageGoldProductInput,
): PageGoldResult {
  if (product.productType.kind !== 'known-type' || product.productType.typeId === null) {
    return {
      state: 'known',
      completeness: 'complete',
      pageIds: [],
      pageAssignments: [],
      pageReason: null,
    };
  }
  const typeId = product.productType.typeId;
  const matchesRule = (rule: PageRule, failures: string[]): boolean => {
    for (const predicate of rule.predicates.allOf) {
      if (predicate.kind === 'zero-match-no-frozen-type') return false;
      if (predicate.kind === 'known-type-in') {
        if (!(predicate.typeIds ?? []).includes(typeId)) return false;
      } else if (predicate.kind === 'field-equals') {
        const field = product.fieldByTarget.get(predicate.targetId!);
        // Owner-confirmed raw-form boundary (D-CAT-RAW / D-RAW-SCOPE): frozen and
        // freeze-dried raw are the same shippable raw subject.
        const rawFormBoundary = predicate.targetId === 'food-form' &&
          (predicate.value === 'Frozen Raw' || predicate.value === 'Freeze-Dried Raw') &&
          (field?.value === 'Frozen Raw' || field?.value === 'Freeze-Dried Raw');
        const valueMatch = field?.value === predicate.value || rawFormBoundary;
        if (field?.state !== 'known' || !valueMatch) {
          if (field?.state === 'insufficient-evidence' || field?.state === 'no-fit') {
            failures.push(`${rule.pageId} needs ${predicate.targetId}=${predicate.value} but field is ${field.state}`);
          }
          return false;
        }
      } else if (predicate.kind === 'brand-exact') {
        if (product.brand === null || normalizeBrand(product.brand) !== normalizeBrand(predicate.brand!)) {
          return false;
        }
      }
    }
    return true;
  };
  const matched: PageRule[] = [];
  const openReasons: string[] = [];
  const unknownReasons: string[] = [];
  const fallbackCandidates: PageRule[] = [];
  for (const rule of packet.rules) {
    if (rule.status !== 'eligible') continue;
    const failures: string[] = [];
    if (!matchesRule(rule, failures)) {
      unknownReasons.push(...failures);
      continue;
    }
    if (rule.completeness === 'open') {
      openReasons.push(`${rule.pageId} (${rule.pageName}) matches but is open: ${rule.ambiguityReasons[0] ?? 'co-assignment unresolved'}`);
      continue;
    }
    // Most-specific-only (D-SHOPALL): fallback rules wait until closed merchandise matching finishes.
    if (rule.fallbackOnly === true) {
      fallbackCandidates.push(rule);
      continue;
    }
    matched.push(rule);
  }
  // Fallback scope applies only when NO closed merchandise rule matched (brand rules never trigger it).
  if (!matched.some(r => r.ruleKind === 'merchandise-subject')) {
    matched.push(...fallbackCandidates);
  }
  const merchandise = matched
    .filter(r => r.ruleKind === 'merchandise-subject')
    .sort((a, b) => b.predicates.allOf.length - a.predicates.allOf.length || a.pageId.localeCompare(b.pageId));
  const brand = matched
    .filter(r => r.ruleKind === 'exact-brand')
    .sort((a, b) => a.pageId.localeCompare(b.pageId));
  const selected = [...merchandise, ...brand].slice(0, PAGE_RULE_MAX_PER_PRODUCT);
  const clipped = matched.length > PAGE_RULE_MAX_PER_PRODUCT;
  const pageIds = selected.map(r => r.pageId).sort();
  const pageAssignments = selected
    .map(r => ({ pageId: r.pageId, pageName: r.pageName }))
    .sort((a, b) => a.pageId.localeCompare(b.pageId));
  if (openReasons.length > 0 || unknownReasons.length > 0 || clipped) {
    const reasons = [
      ...openReasons,
      ...unknownReasons,
      ...(clipped ? [`${matched.length} eligible-closed predicates match; cap ${PAGE_RULE_MAX_PER_PRODUCT} selects most-specific-first with pageId tiebreak (clipped, not silent)`] : []),
    ];
    return {
      state: pageIds.length > 0 ? 'partial' : 'unknown',
      completeness: 'partial',
      pageIds,
      pageAssignments,
      pageReason: reasons.join(' | '),
    };
  }
  return { state: 'known', completeness: 'complete', pageIds, pageAssignments, pageReason: null };
}
