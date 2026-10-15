/**
 * Category Page Proposal Stage
 *
 * Thin wrapper around the shared curation target engine. Proposes
 * which existing store Category Pages the product should be assigned to.
 *
 * Fail-closed gating (issue #353):
 * - A `page` curation target must be enabled.
 * - Page proposals require a verified Page catalog; without one the stage
 *   abstains (name-only rows are review context, never assignment identities).
 * - The provisional canonical classification may drive page proposals in
 *   the same pass (ADR 0041) — there is no reviewed-type gate. Scope,
 *   hierarchy, species, and applicability policy still constrain every
 *   proposal; Brand pages are never proposed.
 *
 * Disabled page targets return succeeded with empty proposals (not abstained)
 * to avoid noisy reviewable_abstention proposals.
 *
 * Dependencies: Evidence from evidence_extraction stage.
 */
import type { StageDefinition, StageContext, StageInput, StageResult } from '../types';
import { loadClassificationConfig } from '../config-loader';
import { resolveEnabledTargets, resolveTargetsFromSnapshot } from '../curation-target-resolver';
import { processPageTarget, materializeCoordinatedPages } from '../curation-target-processor';

export const categoryPageProposalsStage: StageDefinition = {
  name: 'category_page_proposals',
  requires: ['evidence_extraction', 'primary_product_type_proposal'],
  evidenceFrom: ['evidence_extraction', 'primary_product_type_proposal'],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    const resolved = context.snapshot
      ? resolveTargetsFromSnapshot(context.snapshot)
      : resolveEnabledTargets(loadClassificationConfig(context.workspacePath), context.workspaceId);

    // If page assignment is not an enabled curation target, return
    // succeeded with empty proposals (not abstained).
    if (resolved.pages.length === 0) {
      return {
        status: 'succeeded',
        output: {
          evidence: [],
          proposals: [],
          abstained: false,
          message: 'Page assignment is not enabled as a curation target.',
        },
      };
    }

    // PR7 C5 (issue #30, DECISION-D): in ACTIVE cohort mode the parent page op
    // (`ensureCohortPagesCoordinated`) already consumed the frozen Execution
    // Product Type authority and persisted every member's result — the child
    // is a MATERIALIZER: the reviewed-Type gate and both LLM paths are
    // SKIPPED, and the stored result is turned into the existing proposal
    // shape with ZERO Page LLM calls. Legacy/shadow/non-cohort runs keep the
    // reviewed-Type gate + the coordinator/singleton LLM paths byte-identical.
    if (context.coordinatedPages !== undefined) {
      // PR7 review R2 (F3.3): the parent page op chose EXPECTED-EMPTY (page
      // target enabled but NO verified pages — DECISION-C config-level
      // absence) and wrote no output rows. Abstain with the clean legacy
      // reason — never a 'missing parent page output' warning, never an LLM
      // call.
      if (context.pageCoordinationAbsent === true) {
        return {
          status: 'abstained',
          reason: 'No verified store pages available. Page assignment requires a verified ShopSite Pages import.',
        };
      }
      const result = await materializeCoordinatedPages(resolved.pages[0], input, context);
      if (result.proposals.length === 0) {
        return {
          status: 'abstained',
          reason: `No category page matches found: ${result.message}`,
        };
      }
      return {
        status: 'succeeded',
        output: {
          evidence: [],
          proposals: result.proposals,
          abstained: false,
          message: result.message,
        },
      };
    }

    // Issue #353: no reviewed-type gate. The provisional canonical pair
    // (accepted, else pending) and SKU-local facts may drive page proposals
    // in the same pass — scope/hierarchy/species/applicability policy still
    // applies downstream. A missing pair is a gap in drive signal, not a
    // block on evidence-driven proposals.

    // Target exists but no verified store pages available
    if (resolved.pages[0].options.length === 0) {
      return {
        status: 'abstained',
        reason: 'No verified store pages available. Page assignment requires a verified ShopSite Pages import.',
      };
    }

    // Delegate to shared processor for the first page target
    const result = await processPageTarget(resolved.pages[0], input, context);

    if (result.proposals.length === 0) {
      return {
        status: 'abstained',
        reason: `No category page matches found: ${result.message}`,
      };
    }

    return {
      status: 'succeeded',
      output: {
        evidence: [],
        proposals: result.proposals,
        abstained: false,
        message: result.message,
      },
    };
  },
};
