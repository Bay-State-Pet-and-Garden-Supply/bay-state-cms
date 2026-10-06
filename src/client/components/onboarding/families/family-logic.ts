/**
 * Epic #46 — Waiting on Family view pure derivation logic (Phase 5).
 *
 * Merges the batch's waiting work-state items with the canonical cohort
 * readiness views (ADR 0013, `GET /api/onboarding/batches/:id/cohorts`)
 * into one family card per cohort: readiness fraction, per-member state,
 * and the deep-link action list (siblings the family is waiting on or that
 * are blocked). The server owns all projection — this module only shapes it
 * for display.
 */
import type { OnboardingWorkState, OnboardingFamilyState, WorkStateCategory } from '../../../../shared/schemas/onboarding-work-state';
import type { CurationCohortView, CohortMemberReadiness } from '../../../../shared/schemas/cohorts';

export type FamilyMemberState = 'ready' | 'waiting' | 'blocked';

export interface FamilyMemberRow {
  itemId: string;
  upc: string;
  name: string;
  state: FamilyMemberState;
  blockedReason: string | null;
}

export type FamilyActionKind = 'waiting' | 'blocked';

/** A sibling the family is waiting on or that blocks it — a deep-link target. */
export interface FamilyActionItem {
  itemId: string;
  upc: string;
  name: string;
  kind: FamilyActionKind;
  reason: string | null;
  /** The sibling's own operator category when known. */
  category?: WorkStateCategory | null;
  /** True when opening the resolution drawer is meaningful (blocked, or a needs_attention sibling). */
  actionable: boolean;
}

/**
 * Build a family action item. A blocked member is always actionable; a
 * waiting sibling is actionable only when its own category is
 * needs_attention (processing siblings would otherwise open an irrelevant
 * URL-decision workflow — audit M8).
 */
function toActionItem(params: {
  itemId: string;
  upc: string;
  name: string;
  kind: FamilyActionKind;
  reason: string | null;
  categories?: ReadonlyMap<string, WorkStateCategory>;
}): FamilyActionItem {
  const category = params.categories?.get(params.itemId) ?? null;
  return {
    itemId: params.itemId,
    upc: params.upc,
    name: params.name,
    kind: params.kind,
    reason: params.reason,
    category,
    actionable: params.kind === 'blocked' ? true : category === 'needs_attention',
  };
}

export interface FamilyCard {
  cohortId: string;
  /** Human-facing family label (cohort groupLabel). */
  label: string;
  memberCount: number;
  readyCount: number;
  blockedCount: number;
  /** Members neither ready nor blocked (still acquiring/extracting). */
  waitingCount: number;
  /** True when any member is blocked in a pre-Curation barrier stage. */
  blocked: boolean;
  blockedReason: string | null;
  members: FamilyMemberRow[];
  /** Deep-link targets: siblings this family waits on + blocked members. */
  actionItems: FamilyActionItem[];
}

/** Readiness fraction text, e.g. "3 / 4 products ready". */
export function readinessText(memberCount: number, readyCount: number): string {
  const plural = memberCount === 1 ? 'product' : 'products';
  return `${readyCount} / ${memberCount} ${plural} ready`;
}

function memberState(member: CohortMemberReadiness): FamilyMemberState {
  if (member.state === 'blocked') return 'blocked';
  if (member.state === 'ready') return 'ready';
  return 'waiting';
}

/**
 * Build family cards for families that currently have waiting members.
 *
 * A family is included when at least one waiting work-state item references
 * its cohortId. Cohort views are preferred for the full member roster; a
 * missing cohort view (superseded between fetches) degrades to the waiting
 * item's own family context without crashing.
 */
export function buildFamilyCards(
  waitingItems: OnboardingWorkState[],
  cohortViews: CurationCohortView[],
  categories?: ReadonlyMap<string, WorkStateCategory>,
): FamilyCard[] {
  const viewsByCohort = new Map<string, CurationCohortView>();
  for (const view of cohortViews) {
    if (!viewsByCohort.has(view.cohort.id)) viewsByCohort.set(view.cohort.id, view);
  }

  // Waiting members grouped by cohort (insertion order = stable).
  const byCohort = new Map<string, OnboardingWorkState[]>();
  for (const item of waitingItems) {
    const cohortId = item.family?.cohortId;
    if (!cohortId) continue; // Not family-annotated — never rendered as a family.
    const list = byCohort.get(cohortId);
    if (list) list.push(item);
    else byCohort.set(cohortId, [item]);
  }

  const cards: FamilyCard[] = [];
  for (const [cohortId, waitingMembers] of byCohort) {
    const view = viewsByCohort.get(cohortId);

    if (view) {
      const members: FamilyMemberRow[] = view.members.map((m) => ({
        itemId: m.onboardingItemId,
        upc: m.item.upc,
        name: m.item.name,
        state: memberState(m),
        blockedReason: m.blockedReason,
      }));
      const blockedMembers = view.members.filter((m) => m.state === 'blocked');
      // Cohort-level waitingOn is the canonical deep-link set; fall back to
      // the union of member waitingOn arrays when absent.
      const waitingActions: FamilyActionItem[] = (
        view.waitingOn.length > 0
          ? view.waitingOn
          : dedupeById(
              view.members.flatMap((m) => m.waitingOn),
              (w) => w.itemId,
            )
      ).map((w) =>
        toActionItem({
          itemId: w.itemId,
          upc: w.upc,
          name: w.name,
          kind: 'waiting',
          reason: null,
          categories,
        }),
      );
      const blockedActions: FamilyActionItem[] = blockedMembers.map((m) =>
        toActionItem({
          itemId: m.onboardingItemId,
          upc: m.item.upc,
          name: m.item.name,
          kind: 'blocked',
          reason: m.blockedReason,
          categories,
        }),
      );

      cards.push({
        cohortId,
        label: view.cohort.groupLabel || waitingMembers[0].family?.label || 'Product family',
        memberCount: view.memberCount,
        readyCount: view.readyCount,
        blockedCount: blockedMembers.length,
        waitingCount: Math.max(0, view.memberCount - view.readyCount - blockedMembers.length),
        blocked: view.state === 'blocked' || blockedMembers.length > 0,
        blockedReason: view.blockedReason,
        members,
        // A member in both sets is a blocker, never just a processing wait.
        actionItems: dedupeById([...blockedActions, ...waitingActions], (a) => a.itemId),
      });
      continue;
    }

    // Degraded path: no cohort view for this cohort — build from the waiting
    // member's own family context (counts + waiting-on ids).
    const family: OnboardingFamilyState | null = waitingMembers[0].family ?? null;
    const memberById = new Map(waitingMembers.map((m) => [m.itemId, m]));
    const waitingOnIds = dedupeById(
      waitingMembers.flatMap((m) => m.family?.waitingOnItemIds ?? []),
      (id) => id,
    );
    const actionItems: FamilyActionItem[] = waitingOnIds.map((id) => {
      const sibling = memberById.get(id);
      return toActionItem({
        itemId: id,
        upc: sibling?.upc ?? '',
        name: sibling?.name ?? 'Family member',
        kind: 'waiting',
        reason: null,
        categories,
      });
    });
    cards.push({
      cohortId,
      label: family?.label || waitingMembers[0].name || 'Product family',
      memberCount: family?.memberCount ?? waitingMembers.length,
      readyCount: family?.readyCount ?? 0,
      blockedCount: family?.blockedCount ?? 0,
      waitingCount: Math.max(
        0,
        (family?.memberCount ?? waitingMembers.length) -
          (family?.readyCount ?? 0) -
          (family?.blockedCount ?? 0),
      ),
      blocked: (family?.blockedCount ?? 0) > 0,
      blockedReason: null,
      members: waitingMembers.map((m) => ({
        itemId: m.itemId,
        upc: m.upc,
        name: m.name,
        state: 'waiting' as const,
        blockedReason: null,
      })),
      actionItems,
    });
  }

  // Stable ordering: blocked families first (most urgent), then by label.
  return cards.sort((a, b) => {
    if (a.blocked !== b.blocked) return a.blocked ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

/** Dedupe by key, preserving first-seen order. */
function dedupeById<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}
