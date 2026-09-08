/**
 * Parent cohort page decisions (plan Slice 4) — the durable parent page op
 * as the second user of the closed durable-set lifecycle (`decisions.ts`).
 *
 * Page-specific policy lives here: the all-member target set, the frozen
 * page authority + P-hash preparation, the audited group/singleton page
 * engine invocation, durable abstentions, explicit expected-empty, and
 * member page-input selection. Kind-agnostic mechanics (set inspection,
 * parse-failure collection, write-once insert with commit-race conversion,
 * lease-scoped ownership) live in `decisions.ts`.
 *
 * Semantics moved verbatim from `../cohort-page-coordinator.ts` (now a thin
 * transitional adapter, deleted in Slice 6):
 *
 * 1. **Input hash** — P-hash over FROZEN PAGE AUTHORITY ONLY: the finalized
 *    P-set member SKUs (ALL members — groups AND singletons, unlike the
 *    title kind's multi-item-group-only set), the per-member frozen page
 *    authority slice, Execution Product Type resolution, the frozen page
 *    list + selection/maxPages, the prompt/rule version `cohort-pages-v2`,
 *    and the operation-specific Page model authority. Never live item rows,
 *    never the old cache fingerprint, never OCR provenance hashes.
 * 2. **Reuse** — a COMPLETE `coordinated_page` set for this run (a row for
 *    EVERY P-set member) with every row's `input_hash` equal to the fresh
 *    P-hash returns the parsed map with ZERO LLM calls.
 * 3. **Expected-empty** — config-level absence (page target disabled / no
 *    verified pages) writes NO rows and returns an empty map; ANY persisted
 *    rows are write-once corruption and fail closed.
 * 4. **Drift fails closed** — a NONEMPTY committed set that is incomplete,
 *    over-complete, or hash-mismatched throws
 *    `CohortPageAuthorityDriftError` (never re-coordinate, never replace,
 *    never delete).
 * 5. **NO cross-parent reuse** — unlike titles, pages never copy a
 *    superseded parent's set. An empty set always coordinates fresh.
 * 6. **Coordinate** — only when the set is EMPTY, under a scoped lease
 *    keeper: EVERY group (multi-item AND singleton one-member invocations)
 *    through the UNCACHED page core with the keeper's `assertHeld`
 *    threaded into the audited transport; persist all-or-nothing and
 *    WRITE-ONCE in a SEPARATE page transaction (titles may already be
 *    committed when pages crash — the two sets are never one
 *    super-transaction).
 *
 * HONEST DELIVERY CONTRACT: at most one ACTIVE coordination call at a time;
 * zero FURTHER calls once the durable set commits; replay-safe after commit;
 * each pre-commit crash MAY cause another independently audited invocation
 * (no retry cap, no provider idempotency). Never consults `cohortCache` /
 * `coordinateCohortPagesOnce` — the DB outputs are the sole
 * already-coordinated authority.
 *
 * Package-internal seam, not a public workflow step. Never imports the
 * transitional `../cohort-curator` (boundary R2) — only the repository layer,
 * the classification leaf + proposal engine, frozen evidence, and the shared
 * lifecycle.
 */
import {
  getCohortPageOutputsByRun,
  insertCohortPageOutputsOnce,
} from '../../db/repositories/classification-cohort-output-repo';
import type { CohortPageOutputRow } from '../../db/repositories/classification-cohort-output-repo';
import { getRuntimeSnapshotByHash, requireModelCallContext, getModelExecutionPlanEntry } from '../../classification/runtime-snapshot';
import type { RuntimeClassificationSnapshot } from '../../classification/runtime-snapshot';
import { getCohortMemberRunForTitleAudit } from '../../db/repositories/classification-cohort-run-repo';
import { modelPolicyViewFromConfig } from '../model-policy-snapshot';
import { titleExecutionTypeAuthorityFromRun } from '../../classification/cohort-decision-authority';
import { coordinateCohortPagesCore } from '../../classification/cohort-page-proposal-engine';
import type { CohortPageMemberResult } from '../../classification/cohort-page-proposal-engine';
import { validateCategoryPageAssignment, CATEGORY_PAGE_CORRECTNESS_VERSION } from '../../classification/category-page-correctness';
import { buildPageHierarchy } from '../../classification/page-assignment-llm';
import { resolveTargetsFromSnapshot } from '../../classification/curation-target-resolver';
import { groupByProductLine } from '../cohort-name-coordinator';
import { CohortPageOutputSchema } from '../../shared/schemas/cohorts';
import type { CohortPageOutput } from '../../shared/schemas/cohorts';
import type { CoordinatedPageMemberValue, ProductLineItemSnapshot } from '../../classification/types';
import type { FrozenProductLineContext } from './frozen-evidence';
import type {
  CohortRun,
  ExecutionEvidenceProjection,
  ExecutionEvidenceProjectionMemberV1,
  ExecutionEvidenceProjectionMemberV2,
} from '../../shared/schemas/cohorts';
import {
  inspectDurableSet,
  collectRowParseFailures,
  insertDecisionSetOnce,
  withOwnedDecisionScope,
} from './decisions';

// ─── Error identity (moved verbatim; re-exported by the transitional adapter) ─

/** Parse one persisted output row's payload through the shared page schema
 *  (fail-closed on corrupt stored JSON — a corrupt row never yields a page
 *  output). */
function parsePageRow(row: CohortPageOutputRow): CohortPageOutput {
  return CohortPageOutputSchema.parse(JSON.parse(row.outputValueJson));
}

/** Wrap a coordinator/LLM member result into the durable payload + provenance
 *  shape the parent op returns and persists. Assigned rows carry the producing
 *  call id; abstained rows always carry NULL model_call_id (deterministic
 *  abstentions — 'No configured Category Pages are available', policy denied,
 *  invalid responses — produce no call). */
function toMemberValue(result: CohortPageMemberResult): CoordinatedPageMemberValue {
  if (result.status === 'assigned') {
    return {
      output: {
        status: 'assigned',
        pages: result.pages.map(page => ({
          pageId: page.pageId,
          pageName: page.pageName,
          confidence: page.confidence,
        })),
        source: 'llm_cohort',
      },
      modelCallId: result.modelCallIds?.[0] ?? null,
    };
  }
  return { output: { status: 'abstained', reason: result.reason }, modelCallId: null };
}

/**
 * Deterministic per-SKU parse-failure signal (PR8 review R1, BLOCKER 1):
 * thrown by the REUSE path when one or more persisted `coordinated_page`
 * rows for a run fail to parse through `CohortPageOutputSchema` (corrupt
 * stored JSON, or a schema violation such as an assigned row with no pages).
 * Carries the parent run id, the affected product SKUs with their original
 * causes, and the USABLE parsed outputs for the unaffected rows so
 * `processCohort` can supersede with a diagnostic. Supersession diagnostic
 * (PR8 review R1 + review round 2 P1): a persisted `coordinated_page` row
 * that fails to parse is corruption of the WRITE-ONCE PARENT-OWNED shared
 * semantic artifact — the parent is SUPERSEDED via
 * `supersedeOwnedCohortRunForOutputDrift` (never a member failure: a member
 * failure would strand the revision — write-once rows stay immutable under a
 * terminal-current parent, and no new revision could be claimed). The class
 * retains per-SKU failures + the usable parsed map as DIAGNOSTICS only.
 */
export class CohortPageOutputCorruptError extends Error {
  readonly runId: string;
  readonly failures: Array<{ sku: string; cause: string }>;
  readonly usableOutputs: Map<string, CoordinatedPageMemberValue>;

  constructor(
    runId: string,
    failures: Array<{ sku: string; cause: string }>,
    usableOutputs: Map<string, CoordinatedPageMemberValue>,
  ) {
    super(
      `[CohortPageOutputCorrupt] Persisted coordinated_page outputs for run ${runId} failed to parse: ` +
        failures.map(f => `${f.sku} (${f.cause})`).join('; ') +
        ' — the shared page set is no longer coherent; the parent run must be superseded so a NEW revision can commit a fresh set.',
    );
    this.name = 'CohortPageOutputCorruptError';
    this.runId = runId;
    this.failures = failures;
    this.usableOutputs = usableOutputs;
  }
}

/**
 * Deterministic authority-drift signal (PR6 hardening A, applied to pages).
 * Thrown when a NONEMPTY committed `coordinated_page` set for a run does not
 * match the freshly computed canonical page input hash (or is incomplete /
 * over-complete). The set is WRITE-ONCE — it can never be replaced, so the op
 * FAILS CLOSED instead of re-coordinating. Carries the run id, the expected
 * (current) hash, the stored hash(es), and the persisted row count. Also
 * thrown when an `insertCohortPageOutputsOnce` commit-race reports an
 * already-committed set.
 */
export class CohortPageAuthorityDriftError extends Error {
  readonly runId: string;
  readonly expectedHash: string;
  readonly storedHashes: string[];
  readonly rowCount: number;

  constructor(runId: string, expectedHash: string, storedHashes: string[], rowCount: number) {
    super(
      `[CohortPageAuthorityDrift] Durable page outputs for run ${runId} are write-once but no longer match the ` +
        `frozen page authority: expected input_hash ${expectedHash}, stored hash(es) [${storedHashes.join(', ')}], ` +
        `${rowCount} row(s). A committed output set can never be replaced — this is corruption or an illegal ` +
        'mutation; failing the run closed without re-coordination.',
    );
    this.name = 'CohortPageAuthorityDriftError';
    this.runId = runId;
    this.expectedHash = expectedHash;
    this.storedHashes = storedHashes;
    this.rowCount = rowCount;
  }
}

// ─── Page policy: frozen authority ────────────────────────────────────────────

export interface PageFrozenAuthority {
  inputHash: string;
  /** Snapshot-bound policy view, retained ONLY for transport enforcement. */
  boundPolicyView: ReturnType<typeof modelPolicyViewFromConfig>;
  executionTypeAuthority: ReturnType<typeof titleExecutionTypeAuthorityFromRun>;
  memberSnapshot0: NonNullable<ReturnType<typeof getRuntimeSnapshotByHash>>;
  childRun0Id: string;
  /** The ONE canonical bundle the P-hash and the parent v2 prompt consume. */
  authorityBundle: ReturnType<typeof buildCohortPageAuthorityBundle>;
  /** The P-set: ALL member SKUs (groups AND singletons), bundle order. */
  pSetSkus: string[];
  /** False when the page target is disabled or no verified pages exist. */
  verifiedPagesAvailable: boolean;
}

/**
 * Prepare the frozen page authority: ordinal-0 child audit binding, frozen
 * member snapshot, canonical Execution Product Type authority, frozen page
 * target config + verified catalog, the canonical bundle, and the P-hash.
 * PURE READ ONLY: the parent op never creates a child and never updates refs
 * before the lease is asserted. A missing frozen snapshot / plan entry /
 * model-call context FAILS CLOSED before any transport — a non-audited live
 * page call is never made.
 */
export function preparePageAuthority(params: {
  run: CohortRun;
  workspaceId: string;
  projection: ExecutionEvidenceProjection;
  frozenLineContext: FrozenProductLineContext;
}): PageFrozenAuthority {
  const { run, workspaceId, projection, frozenLineContext } = params;
  const orderedMembers = [...projection.members].sort((a, b) => a.ordinal - b.ordinal);
  const member0 = orderedMembers[0];
  const childRun0 = getCohortMemberRunForTitleAudit(run.id, member0.onboardingItemId);
  if (!childRun0 || !childRun0.configSnapshotId || !childRun0.configSnapshotHash) {
    throw new Error(
      `[CohortPages] Ordinal-0 member ${member0.onboardingItemId} (run ${run.id}) has no child run ` +
        'with freeze-persisted snapshot refs — refusing to coordinate pages without the frozen audit authority.',
    );
  }
  const memberSnapshot0 = getRuntimeSnapshotByHash(workspaceId, childRun0.configSnapshotHash);
  if (!memberSnapshot0) {
    throw new Error(
      `[CohortPages] Frozen member runtime snapshot ${childRun0.configSnapshotHash} not found for ` +
        `ordinal-0 member ${member0.onboardingItemId} (run ${run.id}) — refusing to coordinate pages without ` +
        'the frozen audit authority.',
    );
  }
  const executionTypeAuthority = titleExecutionTypeAuthorityFromRun(run, memberSnapshot0);
  const boundPolicyView = modelPolicyViewFromConfig(
    memberSnapshot0.modelPolicy as never,
    memberSnapshot0.snapshotHash,
  );
  const resolved = resolveTargetsFromSnapshot(memberSnapshot0);
  const pageTarget = resolved.pages[0];
  // Config-level absence: target disabled OR enabled without a verified page
  // catalog. (The `pagePlan.pages` list is empty in exactly this case; the
  // explicit flag keeps the expected-empty branch readable.)
  const verifiedPagesAvailable = resolved.pages.length > 0 && pageTarget.options.length > 0;
  const selectionMode = (pageTarget?.config.selectionMode ?? 'single') as 'single' | 'multiple';
  const maxPages = selectionMode === 'multiple' ? 5 : 1;
  const pagePlan: CohortPagePlanAuthority = {
    pages: verifiedPagesAvailable
      ? buildPageHierarchy(
          pageTarget.options,
          memberSnapshot0.pages.state === 'verified' ? memberSnapshot0.pages.records : [],
        )
      : [],
    selectionMode,
    maxPages,
  };
  const authorityBundle = buildCohortPageAuthorityBundle({
    run,
    projection,
    frozenLineContext,
    pageCatalog: pagePlan.pages,
    pagePlan,
    executionTypeAuthority,
    snapshot: memberSnapshot0,
  });
  // The P-set: ALL members — groups AND singletons — unlike the title kind's
  // multi-item-group-only set. Matches the bundle's sorted membership exactly.
  const pSetSkus = authorityBundle.members.map(member => member.sku);
  const inputHash = computeCohortPageInputHash(authorityBundle);
  return {
    inputHash,
    boundPolicyView,
    executionTypeAuthority,
    memberSnapshot0,
    childRun0Id: childRun0.id,
    authorityBundle,
    pSetSkus,
    verifiedPagesAvailable,
  };
}

// ─── Parent op ────────────────────────────────────────────────────────────────

export interface EnsureCohortPagesParams {
  /** The frozen `running` cohort run (final membership + execution type + claim). */
  run: CohortRun;
  workspaceId: string;
  /** The frozen execution-evidence projection (v1 or v2 — source-aware). */
  projection: ExecutionEvidenceProjection;
  /** Frozen product-line sibling context (PR3 hardening Commit B / R2). */
  frozenLineContext: FrozenProductLineContext;
  /**
   * Test-only crash seam (PR6 hardening B, issue #30 P1-1): fires AFTER a
   * page coordination call resolves (its audited `classification_model_calls`
   * rows are durable) but BEFORE the outputs transaction commits —
   * deterministically simulating a worker crash exactly between transport
   * success and the durable output-set commit. The uncached page core fires
   * it internally after each group transport. Production callers never pass
   * it.
   */
  afterCoordinatedCall?: () => void | Promise<void>;
}

/**
 * The durable parent page coordination op, on the shared lifecycle. See the
 * module JSDoc for the expected-empty rule, the reuse rule, the lease-wrapped
 * coordinate step, the all-or-nothing persistence, the `HeartbeatLostError`
 * propagation contract, and the HONEST DELIVERY CONTRACT: at most one ACTIVE
 * page coordination call at a time, zero FURTHER calls once the durable
 * output set commits, replay-safe after commit, and a crash between transport
 * success and output commit may re-invoke coordination (each invocation
 * audited). No cross-parent copy branch — an empty set always coordinates
 * fresh.
 */
export async function ensureCohortPages(
  params: EnsureCohortPagesParams,
): Promise<Map<string, CoordinatedPageMemberValue>> {
  const { run, workspaceId, projection, frozenLineContext } = params;
  // The frozen sibling views + the run row are the entire authority.

  const authority = preparePageAuthority({ run, workspaceId, projection, frozenLineContext });
  const { inputHash, authorityBundle, pSetSkus, verifiedPagesAvailable } = authority;

  // Persisted rows are read BEFORE any early return so the expected-empty
  // case also fails closed on unexpected rows. Pure read: no keeper, no LLM,
  // no writes.
  const existingRows = getCohortPageOutputsByRun(run.id);

  // Config-level absence is NOT an output — the op writes NO rows and returns
  // an empty map. Any persisted rows for this run are write-once corruption.
  if (!verifiedPagesAvailable) {
    const inspection = inspectDurableSet({ expectedSkus: new Set<string>(), rows: existingRows, inputHash });
    if (inspection.status === 'drift') {
      throw new CohortPageAuthorityDriftError(run.id, inputHash, inspection.storedHashes, inspection.rowCount);
    }
    console.log(
      `[CohortPages] Page target disabled / no verified pages for run ${run.id} — expected-empty, zero rows written.`,
    );
    return new Map();
  }

  // REUSE when the persisted set is EXACTLY the expected P-set AND every
  // row's hash matches. Pure reads.
  const expectedSkus = new Set(pSetSkus);
  const rowBySku = new Map(existingRows.map(row => [row.productSku, row]));
  const inspection = inspectDurableSet({ expectedSkus, rows: existingRows, inputHash });
  if (inspection.status === 'complete-match') {
    const { parsed: map, failures } = collectRowParseFailures(expectedSkus, sku => {
      const row = rowBySku.get(sku)!;
      return {
        output: parsePageRow(row),
        modelCallId: row.modelCallId,
      };
    });
    if (failures.length > 0) {
      console.error(
        `[CohortPages] ${failures.length} persisted coordinated_page row(s) for run ${run.id} failed to parse: ` +
          failures.map(f => `${f.sku} (${f.cause})`).join('; '),
      );
      throw new CohortPageOutputCorruptError(run.id, failures, map);
    }
    console.log(
      `[CohortPages] Reusing ${map.size} durable page outputs for run ${run.id} (complete set + hash match, zero LLM calls).`,
    );
    return map;
  }

  // WRITE-ONCE: any NONEMPTY committed set that is incomplete, over-complete,
  // or hash-mismatched is authority drift — FAIL CLOSED, never re-coordinate,
  // never delete. An incomplete/over-complete nonempty set can only be
  // corruption: the insert is all-or-nothing, so a partial or extra-row set
  // is never produced by any writer.
  if (inspection.status === 'drift') {
    throw new CohortPageAuthorityDriftError(run.id, inputHash, inspection.storedHashes, inspection.rowCount);
  }

  // Coordinate ONCE under a scoped lease keeper + persist all-or-nothing in
  // the SEPARATE page transaction. The keeper renews the parent lease on a
  // TTL/3 cadence while the audited calls are in flight; `assertHeld`
  // (forwarded into the group transport AND re-asserted after every await)
  // aborts with `HeartbeatLostError` the moment the claim is lost — no output
  // rows are ever written by a stale owner. The coordinate path is reached
  // ONLY when the set is EMPTY (zero rows — see the drift guard above). There
  // is deliberately NO cross-parent copy branch: unlike titles, a page set is
  // never reused across parent revisions.
  const workerId = run.claimedBy;
  if (!workerId) {
    throw new Error(`ensureCohortPages: run ${run.id} has no claim owner.`);
  }
  return withOwnedDecisionScope({
    runId: run.id,
    workerId,
    body: async keeper => {
      // FROZEN AUDIT AUTHORITY: ONE audited model-call context for the NEW
      // parent operation `cohort_page_assignment_parent` — shared by every
      // parent page call (groups AND singletons). FAIL CLOSED before any
      // transport when the frozen plan has no compatible entry — a
      // non-audited live page call is never made.
      const parentModelCallContext = requireModelCallContext(
        authority.memberSnapshot0,
        authority.childRun0Id,
        'cohort_page_assignment_parent',
        1,
      );
      if (!parentModelCallContext) {
        throw new Error(
          `[CohortPages] No audited model-call context for ordinal-0 child run ${authority.childRun0Id} (parent run ${run.id}) ` +
            '— refusing to make a non-audited page call.',
        );
      }

      const pageHierarchy = authorityBundle.pages;
      const selectionMode = authorityBundle.selection.selectionMode;
      const maxPages = authorityBundle.selection.maxPages;
      // The parent prompt renders the SAME normalized member slices the
      // P-hash consumed (bundle members — sorted, shared truncation)
      // converted to the `ProductLineItemSnapshot` shape the core renders.
      // NEVER re-derives from the mutable/raw frozen line context.
      const snapshotBySku = new Map(
        authorityBundle.members.map(member => [member.sku, pageAuthorityMemberToSnapshot(member)]),
      );
      const memberValues = new Map<string, CoordinatedPageMemberValue>();

      // EVERY group — multi-item AND singleton — goes through the UNCACHED
      // page core (the ONE prompt/validation authority). Singletons are
      // ONE-MEMBER invocations with `allowSingleProduct` — the SAME v2 prompt
      // family, the SAME `cohort_page_assignment_parent` operation, and the
      // SAME ownership/crash seams as groups. `afterCoordinatedCall` is
      // threaded so the pre-commit crash seam fires after each successful
      // transport.
      // e09 T1 INVARIANT (same contract as the title op): this grouping via
      // groupByProductLine(frozenBatchItems) → extractNameStem is
      // BYTE-EQUIVALENT to durable product-family-v1 membership only while
      // GROUPING_VERSION and frozen raw inputs are unchanged; membership
      // divergence must route through coordinateCohortItems'
      // `authoritativeCohortId` seam, not re-derivation.
      for (const [groupKey, groupItems] of groupByProductLine(frozenLineContext.frozenBatchItems).entries()) {
        const skus = groupItems
          .map(item => item.upc)
          .filter((sku): sku is string => Boolean(sku));
        if (skus.length === 0) continue;
        const products = skus
          .map(sku => snapshotBySku.get(sku))
          .filter((snapshot): snapshot is ProductLineItemSnapshot => Boolean(snapshot));
        if (products.length !== skus.length) {
          throw new Error(
            `[CohortPages] Frozen product-line snapshot missing for a member of group ${groupKey} ` +
              `(run ${run.id}) — refusing to coordinate pages from partial frozen authority.`,
          );
        }
        const coordinated = await coordinateCohortPagesCore(
          {
            groupId: groupKey,
            products,
            pages: pageHierarchy,
            selectionMode,
            maxPages,
            modelPolicy: authority.boundPolicyView,
            modelCall: parentModelCallContext,
            snapshot: authority.memberSnapshot0,
          },
          {
            assertHeld: () => keeper.assertHeld(),
            afterCoordinatedCall: params.afterCoordinatedCall,
            // The parent path ALWAYS renders the v2 Execution Type context
            // block (the SAME full authority object the P-hash consumed).
            executionTypeContext: authorityBundle.executionTypeAuthority,
            // A singleton group is a ONE-MEMBER core invocation — skip the
            // >=2 products guard so the v2 prompt family renders.
            allowSingleProduct: skus.length === 1,
            // The parent transport/preflight routes as ITS OWN frozen
            // operation ('cohort_page_assignment_parent' with v2 prompt/rule
            // versions) — never the legacy v1 identity. The core fail-closes
            // on operation divergence.
            protectedOperation: 'cohort_page_assignment_parent',
          },
        );
        for (const sku of skus) {
          const result = coordinated.get(sku);
          if (!result) {
            throw new Error(
              `[CohortPages] Group coordination returned no result for member ${sku} (run ${run.id}).`,
            );
          }
          // Per-member Page correctness gate at the durable parent op — no
          // sibling copying. Defense-in-depth before persistence (the core
          // already gated per-member).
          if (result.status === 'assigned') {
            const memberAuthority = authorityBundle.members.find(m => m.sku === sku);
            const verifiedCatalogForValidation = pageHierarchy.map(p => ({
              id: p.id,
              name: p.name,
              parentId: null as string | null,
            }));
            const correctness = validateCategoryPageAssignment({
              member: {
                onboardingItemId: sku,
                frozenEvidenceHash: memberAuthority ? `member:${sku}` : `member:${sku}`,
                frozenEvidence: {
                  species: memberAuthority?.species ?? [],
                  form: memberAuthority?.productForm ?? null,
                  title: memberAuthority?.webTitle ?? memberAuthority?.name ?? null,
                  description: memberAuthority?.description ?? null,
                  productType: null,
                  brand: memberAuthority?.brand ?? null,
                  extraction: {
                    title: memberAuthority?.webTitle ?? null,
                    description: memberAuthority?.description ?? null,
                    productForm: memberAuthority?.productForm ?? null,
                  },
                },
              },
              candidate: {
                primaryPageId: result.pages[0]?.pageId ?? null,
                secondaryPageIds: result.pages.slice(1).map(p => p.pageId),
                primaryPageName: result.pages[0]?.pageName ?? null,
              },
              verifiedPageCatalog: verifiedCatalogForValidation,
              activePageImportHash: authority.memberSnapshot0.pageImportHash ?? 'unknown',
            });
            if (!correctness.valid || correctness.outcome !== 'assigned') {
              memberValues.set(sku, {
                output: { status: 'abstained', reason: correctness.reason ?? `Page correctness gate blocked assigned page for SKU ${sku} (P5/P6/P7).` },
                modelCallId: null,
              });
              continue;
            }
          }
          memberValues.set(sku, toMemberValue(result));
        }
      }

      // EXACT-SET completeness: every P-set member (groups AND singletons)
      // has exactly one output value before anything is persisted.
      const missing = pSetSkus.filter(sku => !memberValues.has(sku));
      if (missing.length > 0) {
        throw new Error(
          `[CohortPages] Coordinate step produced no output for members [${missing.join(', ')}] (run ${run.id}).`,
        );
      }

      // Post-await ownership guard BEFORE ANY write.
      keeper.assertHeld();

      const outputs = pSetSkus.map(sku => {
        const value = memberValues.get(sku)!;
        return { productSku: sku, output: value.output, modelCallId: value.modelCallId };
      });

      // ONE transaction — all members persist or NONE. WRITE-ONCE: the insert
      // is guarded by three-way semantics — zero rows ⇒ insert; any rows ⇒
      // the already-committed error (never delete). A commit race (a sibling
      // committed between our pure-read reuse check and this insert) is
      // converted to `CohortPageAuthorityDriftError` so the set can never be
      // silently split.
      insertDecisionSetOnce({
        insert: () =>
          insertCohortPageOutputsOnce({
            workspaceId,
            runId: run.id,
            inputHash,
            outputs,
          }),
        readCommittedHashes: () => getCohortPageOutputsByRun(run.id),
        toDriftError: (storedHashes, rowCount) =>
          new CohortPageAuthorityDriftError(run.id, inputHash, storedHashes, rowCount),
      });

      const map = new Map<string, CoordinatedPageMemberValue>();
      for (const output of outputs) {
        map.set(output.productSku, { output: output.output, modelCallId: output.modelCallId });
      }
      const assignedCount = [...map.values()].filter(value => value.output.status === 'assigned').length;
      console.log(
        `[CohortPages] Persisted ${map.size} page outputs for run ${run.id} ` +
          `(${assignedCount} assigned, ${map.size - assignedCount} abstained).`,
      );
      return map;
    },
  });
}

// ─── Member input selection ───────────────────────────────────────────────────

/**
 * Select one member's page input from the settled parent decision set. The
 * page kind covers ALL members, so a settled op always carries every member's
 * row (or the explicit expected-empty outcome, in which case the settled map
 * is empty and every member abstains deterministically). A missing row for a
 * member cannot happen after a settled op — the set is exact — so null here
 * means "no coordinated assignment", never "look elsewhere".
 */
export function pageInputForMember(
  settledPages: Map<string, CoordinatedPageMemberValue> | undefined,
  memberSku: string,
): CoordinatedPageMemberValue | null {
  return settledPages?.get(memberSku) ?? null;
}

// ─── P-hash authority (moved verbatim from `../cohort-page-hash.ts`, Slice 6) ───

/**
 * Canonical cohort Page input hash (issue #30, PR7 C2) — the "P-hash".
 *
 * PURE module (mirroring `cohort-title-hash.ts`): `computeCohortPageInputHash`
 * derives a canonical SHA-256 from FROZEN PAGE AUTHORITY ONLY
 * (architecture-report §3, DECISION-B). It is the per-row `input_hash` of the
 * durable `classification_cohort_outputs` rows for output_kind
 * 'coordinated_page' and the reuse key of the parent
 * `ensureCohortPagesCoordinated` op: outputs for a run are reusable iff EVERY
 * member (groups AND singletons — the P-set, DECISION-A) has a row AND every
 * row's input hash matches the freshly computed P-hash. The hash is
 * recomputed on every `processCohort` entry (cheap, pure); a mismatch against
 * a committed output set is WRITE-ONCE drift: the parent op FAILS CLOSED with
 * `CohortPageAuthorityDriftError` — the set is never re-coordinated or
 * replaced, and the run terminates deterministically.
 *
 * REPLAY CONTRACT (mirrors titles): at most one ACTIVE Page coordination call
 * at a time; a crash between transport success and the output-set commit may
 * cause ANOTHER independently audited invocation (no retry cap — each
 * pre-commit crash repeats this); only a successful commit makes later
 * entries call-free (replay-safe after commit).
 *
 * PROMPT-AUTHORITY CONSTRUCTION RULE (PR6 hardening C/D applied to pages):
 * ONE normalized authority object is BOTH hashed and rendered. The per-member
 * slice (`pageAuthorityFromProjectionMember`) applies the SAME truncation
 * constants the v2 prompt renders (`PAGE_AUTHORITY_TRUNCATION` +
 * `normalizePageAuthorityString`) — so a suffix-only mutation beyond a cutoff
 * changes NEITHER the P-hash NOR the rendered authority slice. The slice is
 * derived from the frozen projection member exactly the way the frozen
 * `ProductLineItemSnapshot` (page-coordination input) is built: `name` from
 * the spreadsheet identity, `brand` from the spreadsheet brandHint (never the
 * web-extracted brand), and species/flavor/lifeStage/productForm/healthConcern
 * from the packaging-OCR data.
 *
 * OPERATION-SPECIFIC MODEL AUTHORITY (DECISION-B + PR7 review R2 F2c): the
 * P-hash covers the `{provider, model}` from the FROZEN model-execution-plan
 * entry for `cohort_page_assignment_parent` (never live
 * `getLlmConfigForTask` — see the FROZEN-PLAN MODEL AUTHORITY note below) —
 * NOT the broad `policyDigest` P2 the T-hash carries (the Page projection is
 * genuinely operation-specific from day one). Unconfigured (no plan entry /
 * no policy route) resolves to null and is hashed as null.
 *
 * HASH ONLY FROZEN PAGE AUTHORITY — explicit exclusions (mirroring titles):
 * - NO live `onboarding_items` rows, stage/status, `curation_data_json`, or
 *   `updated_at` — members come strictly from `projection.members`.
 * - NO cache-key shape (`stableKey` in cohort-page-coordinator): the old
 *   string fingerprint + `modelIdentity {provider, model, policyDigest}` is
 *   replaced by this structured canonical JSON.
 * - NO non-page projection fields: `bulletPoints`, `searchKeywords`,
 *   `customFields`, `fieldProvenance`, `piEvidence`, `evidenceHash`,
 *   `ocrInputHash` / `ocrExecutionDigest` (OCR provenance), images.
 * - Milestone E EXCEPTION: the narrow source-kind/provenance binding slice
 *   (`sourceProvenance` — see cohort-title-hash.ts) DOES participate in the
 *   P-hash as input identity. It is intentionally NOT rendered into the page
 *   prompt (the rendered context stays product-line semantics); the
 *   hashed-authority == prompted-authority rule therefore applies to the
 *   rendered page fields only, with the source binding as a strict
 *   identity gate on top. V1 members normalize to official_page.
 * - NO `modelPolicyDigest` (titles' P2); the page model authority is the
 *   operation-specific `{provider, model}` slice only.
 *
 * FROZEN-PLAN MODEL AUTHORITY (PR7 review R2, F2c — P1-C): the P-hash model
 * authority + rule version NEVER come from live credentials. They are derived
 * from the ordinal-0 member runtime snapshot's FROZEN model-execution-plan
 * entry for the parent operation `cohort_page_assignment_parent` — so a
 * mid-flight credential lookup failure or a live policy change can never flip
 * the hash and needlessly supersede a committed decision. `buildCohortPageAuthorityBundle`
 * resolves the `modelExecutionAuthority` ({provider, model, promptTemplateVersion,
 * ruleVersion} — ALL four from the SAME frozen plan entry) when a snapshot is
 * supplied; the parent op always supplies the frozen ordinal-0 snapshot. Both
 * semantic versions participate in the P-hash, so a prompt-template bump
 * changes the hash even when rules/provider/model are unchanged — the hash
 * hardcodes no page version of its own.
 */
import { hashCanonicalJson } from '../../shared/stable-id';
import {
  normalizePageAuthorityString,
  PAGE_AUTHORITY_TRUNCATION,
} from '../../classification/cohort-decision-authority';
import type {
  ExecutionTypeTitleAuthority,
  SourceProvenanceSlice,
} from '../../classification/cohort-decision-authority';
import { sourceProvenanceFromMember } from '../../classification/cohort-decision-authority';

// ─── Constants ────────────────────────────────────────────────────────────────

// (PAGE_AUTHORITY_TRUNCATION moved to the pure leaf; re-exported above. Removed in Slice 6.)

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The frozen page-relevant slice of one projection member. Every field here
 * participates in the P-hash; everything else on the member is excluded by
 * design (see the module JSDoc).
 */
export interface CohortPageAuthorityMember {
  /** `productSku ?? ''` — the onboarding key the output rows are keyed by. */
  sku: string;
  /** `spreadsheetIdentity.name` (truncated at 500). */
  name: string;
  /** `extraction.title` (truncated at 500); null when absent. */
  webTitle: string | null;
  /** `spreadsheetIdentity.brandHint` (truncated at 200) — never the web-extracted brand. */
  brand: string | null;
  /** `extraction.description` (truncated at 1500); '' when absent. */
  description: string;
  /** OCR species, sorted for determinism. */
  species: string[];
  /** OCR flavor (packagingOcrData.flavorVariety); null when absent. */
  flavor: string | null;
  /** OCR life stage; null when absent. */
  lifeStage: string | null;
  /** OCR product form; null when absent. */
  productForm: string | null;
  /** OCR health-concern functions, sorted for determinism. */
  healthConcern: string[];
  /**
   * Milestone E: source-kind/provenance binding (see
   * `sourceProvenanceFromMember` in cohort-title-hash.ts). Distributor-record
   * members are a different page input identity than official-page members;
   * generation/attempt/hash drift changes the P-hash so stale evidence is
   * never reused for page assignment. V1 members normalize to official_page.
   */
  sourceProvenance: SourceProvenanceSlice;
}

/** The frozen operation-specific Page model authority (DECISION-B). */
export interface CohortPageModelAuthority {
  provider: string;
  model: string;
}

/**
 * The frozen operation-specific Page model-EXECUTION authority (PR7 review
 * round 3, P1): provider/model AND both independent semantic versions
 * (promptTemplateVersion + ruleVersion) from the SAME frozen
 * `cohort_page_assignment_parent` model-execution-plan entry. The registry
 * treats the two versions as independently bumpable (prompt text vs
 * deterministic post-processing), so BOTH participate in the P-hash — a
 * prompt-template bump that changes the Page decision must change the hash
 * even when rules/provider/model are unchanged.
 */
export interface CohortPageModelExecutionAuthority {
  provider: string;
  model: string;
  promptTemplateVersion: string;
  ruleVersion: string;
}

/** The frozen page-catalog + selection slice the P-hash covers (H4 Page
 *  catalog is deliberately NOT in the hash — only the exact list the prompt
 *  renders, sorted by id). */
export interface CohortPagePlanAuthority {
  /** Frozen page list: `{id, name, parentName}` — the prompt renders the same list. */
  pages: Array<{ id: string; name: string; parentName: string | null }>;
  /** Frozen per-target selection mode. */
  selectionMode: 'single' | 'multiple';
  /** Frozen per-target max pages. */
  maxPages: number;
}

/**
 * ONE canonical cohort-Page authority bundle (PR7 review R1, B2): the SINGLE
 * normalized object set that BOTH the P-hash and the parent v2 prompt consume.
 * Built once per `ensureCohortPagesCoordinated` entry from the frozen inputs,
 * then passed to `computeCohortPageInputHash` AND to the parent prompt path
 * (`coordinateCohortPagesCore`'s `executionTypeContext` option + the
 * bundle-derived products/pages/selection) — so hashed authority == prompted
 * authority BY CONSTRUCTION: no duplicated truncation literals, no order
 * dependence (members sorted by sku, pages by id, species/healthConcern
 * arrays sorted).
 */
export interface CohortPageAuthorityBundle {
  /** Canonical P-set membership + per-member normalized authority slices,
   *  sorted by sku; species/healthConcern arrays sorted. */
  members: CohortPageAuthorityMember[];
  /** Frozen page list sorted by id. */
  pages: Array<{ id: string; name: string; parentName: string | null }>;
  /** Frozen per-target selection. */
  selection: { selectionMode: 'single' | 'multiple'; maxPages: number };
  /** The frozen Execution Product Type authority (id+label+confidence+outcome). */
  executionTypeAuthority: ExecutionTypeTitleAuthority;
  /** The frozen operation-specific Page model-EXECUTION authority (from the
   *  frozen model-execution-plan entry — provider, model, prompt-template
   *  version, rule version); null when unconfigured / no plan entry. */
  modelExecutionAuthority: CohortPageModelExecutionAuthority | null;
}

export interface CohortPageAuthorityBundleParams {
  /** The cohort run (execution Product Type resolution). */
  run: CohortRun;
  /** Frozen per-member Page authority (the persisted execution-evidence-v1 payload). */
  projection: ExecutionEvidenceProjection;
  /** Frozen product-line sibling context (contract symmetry — the canonical
   *  members are normalized from the projection via
   *  `pageAuthorityFromProjectionMember`; the bundle output is the ONE
   *  authority both the P-hash and the parent prompt consume). */
  frozenLineContext?: { productLineItems: ProductLineItemSnapshot[] } | null;
  /** Frozen verified page catalog (contract symmetry — the canonical page
   *  list is `pagePlan.pages`, sorted by id). */
  pageCatalog?: Array<{ id: string; name: string; parentName: string | null }> | null;
  /** Frozen page list + selection mode/maxPages (per-target config, frozen). */
  pagePlan: CohortPagePlanAuthority;
  /**
   * Frozen Execution Product Type authority (the SAME
   * `ExecutionTypeTitleAuthority` object the v2 prompt's Execution Type
   * context renders — `titleExecutionTypeAuthorityFromRun`). Absent → the
   * run-fallback authority is built (abstained/conflicted).
   */
  executionTypeAuthority?: ExecutionTypeTitleAuthority | null;
  /**
   * PR7 review R2 (F2c): the frozen ordinal-0 member runtime snapshot the
   * parent op passes in. The `modelExecutionAuthority` (provider, model,
   * prompt-template version, rule version) is derived from the frozen
   * model-execution-plan entry for `cohort_page_assignment_parent` — NEVER
   * live credentials. Absent for direct/test construction.
   */
  snapshot?: RuntimeClassificationSnapshot | null;
  /**
   * Explicit frozen operation-specific Page model-EXECUTION authority
   * (DECISION-B); null when unconfigured — still hashed as null. Overrides
   * the snapshot-derived authority (tests/direct construction). In production
   * this ALWAYS comes from the frozen plan entry (provider + model + BOTH
   * semantic versions).
   */
  modelExecutionAuthority?: CohortPageModelExecutionAuthority | null;
}

/**
 * Build the single canonical authority bundle (PR7 review R1, B2). Both the
 * P-hash and the parent v2 prompt consume this exact bundle: members are
 * normalized via `pageAuthorityFromProjectionMember` and sorted by sku, pages
 * are sorted by id, species/healthConcern arrays are sorted — so any
 * reordering of the raw inputs changes NEITHER the hash NOR the rendered
 * prompt.
 *
 * PR7 review R2 (F2c / P1-C): when `snapshot` is supplied, the bundle's
 * `modelExecutionAuthority` comes from the frozen model-execution-plan entry
 * for `cohort_page_assignment_parent` (provider + model + promptTemplateVersion
 * + ruleVersion — ALL four from the same entry) — the P-hash therefore never
 * touches live credential/config resolution, and a prompt-template bump that
 * can change the Page decision changes the P-hash even when rules and
 * provider/model are unchanged.
 */
export function buildCohortPageAuthorityBundle(
  params: CohortPageAuthorityBundleParams,
): CohortPageAuthorityBundle {
  const { run, projection, pagePlan, executionTypeAuthority, snapshot } = params;
  // FROZEN-PLAN authority: the plan entry's provider/model + BOTH semantic
  // versions are the authority of the P-hash (never live credentials). A
  // missing entry (legacy schema-v1 snapshot, pre-change registry-v1 plan)
  // resolves to null — production always reaches the entry (the parent op
  // fails closed otherwise).
  const planEntry = snapshot
    ? getModelExecutionPlanEntry(snapshot, 'cohort_page_assignment_parent')
    : null;
  const modelExecutionAuthority =
    params.modelExecutionAuthority ??
    (planEntry
      ? {
          provider: planEntry.provider,
          model: planEntry.model,
          promptTemplateVersion: planEntry.promptTemplateVersion,
          ruleVersion: planEntry.ruleVersion,
        }
      : null);
  const members = [...projection.members]
    .map(pageAuthorityFromProjectionMember)
    .sort((a, b) => a.sku.localeCompare(b.sku));
  const pages = [...pagePlan.pages].sort((a, b) => a.id.localeCompare(b.id));
  return {
    members,
    pages,
    selection: { selectionMode: pagePlan.selectionMode, maxPages: pagePlan.maxPages },
    executionTypeAuthority: executionTypeAuthority ?? {
      id: run.executionProductTypeId,
      label: null,
      confidence: run.productTypeConfidence,
      outcome: run.productTypeOutcome,
    },
    modelExecutionAuthority,
  };
}

/**
 * Bridge the canonical bundle member back to the `ProductLineItemSnapshot`
 * shape the coordinated Page prompt renders (PR7 review R1, B2). The parent
 * path builds its core params FROM the bundle members (normalized, sorted)
 * instead of re-deriving from the raw frozen line context, so the rendered
 * prompt text is fully determined by the hashed objects.
 */
export function pageAuthorityMemberToSnapshot(
  member: CohortPageAuthorityMember,
): ProductLineItemSnapshot {
  return {
    sku: member.sku,
    name: member.name,
    webTitle: member.webTitle,
    brand: member.brand,
    description: member.description,
    species: [...member.species],
    flavor: member.flavor,
    lifeStage: member.lifeStage,
    productForm: member.productForm,
    healthConcern: [...member.healthConcern],
  };
}

// ─── Pure builders ────────────────────────────────────────────────────────────

/**
 * The member's frozen page-relevant slice (the exact slice the v2 prompt
 * renders). Species + health-concern arrays are sorted so the hashed
 * authority is independent of OCR array order.
 */
export function pageAuthorityFromProjectionMember(
  member: ExecutionEvidenceProjectionMemberV1 | ExecutionEvidenceProjectionMemberV2,
): CohortPageAuthorityMember {
  const ocr = member.extraction.ocr.packagingOcrData;
  const trunc = PAGE_AUTHORITY_TRUNCATION;
  return {
    sku: member.productSku ?? '',
    name: normalizePageAuthorityString(member.spreadsheetIdentity.name, trunc.name) ?? '',
    webTitle: normalizePageAuthorityString(member.extraction.title, trunc.webTitle),
    brand: normalizePageAuthorityString(member.spreadsheetIdentity.brandHint, trunc.brand),
    description: normalizePageAuthorityString(member.extraction.description, trunc.description) ?? '',
    species: [...(ocr?.species ?? [])].sort(),
    flavor: ocr?.flavorVariety ?? null,
    lifeStage: ocr?.lifeStage ?? null,
    productForm: ocr?.productForm ?? null,
    healthConcern: [...(ocr?.healthConcernFunction ?? [])].sort(),
    // Milestone E: source-kind/provenance binding participates in the P-hash.
    sourceProvenance: sourceProvenanceFromMember(member),
  };
}

// ─── Hash ─────────────────────────────────────────────────────────────────────

/**
 * Compute the canonical cohort Page input hash (P-hash) over the frozen Page
 * authority bundle (PR7 review R1, B2): the sorted P-set member SKUs, the
 * per-member normalized authority slices, the execution Product Type
 * authority, the sorted frozen page list + selection mode/maxPages, the
 * prompt/rule version (the frozen plan entry's ruleVersion — F2c), and the
 * frozen operation-specific model authority.
 *
 * Consumes ONLY the canonical `CohortPageAuthorityBundle` — the SAME bundle
 * the parent v2 prompt renders — so hashed authority == prompted authority
 * by construction. Deterministic and pure — no DB access, no live item reads,
 * no live credential resolution. The model-EXECUTION authority (provider,
 * model, promptTemplateVersion, ruleVersion — ALL four from the frozen plan
 * entry) participates as ONE object, so a prompt-template bump changes the
 * P-hash even when rules/provider/model are unchanged (PR7 review round 3,
 * P1).
 */

export function computeCohortPageInputHash(bundle: CohortPageAuthorityBundle): string {
  return hashCanonicalJson({
    version: 1,
    kind: 'coordinated_page',
    membership: bundle.members.map(member => member.sku),
    members: bundle.members,
    executionProductType: bundle.executionTypeAuthority,
    pages: bundle.pages,
    selection: bundle.selection,
    modelExecutionAuthority: bundle.modelExecutionAuthority ?? null,
    categoryPageCorrectnessVersion: CATEGORY_PAGE_CORRECTNESS_VERSION,
  });
}
