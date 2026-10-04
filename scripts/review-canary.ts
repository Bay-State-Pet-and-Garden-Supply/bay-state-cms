/**
 * Terminal review driver for staged canaries (#302, #328 follow-up).
 *
 * The onboarding review UI is click-heavy and forces a drawer round-trip per
 * proposal with no accept→re-curate chaining. This script performs the exact
 * same review through the terminal:
 *
 * - Lists every pending proposal with inline evidence (supporting snippets +
 *   contradicting snippets flagged, so false-conflict banners like the
 *   "Dry Dog Food" case are visible in one view).
 * - Records per-proposal accept / reject / correct decisions through
 *   `submitProposalDecisions` — the same validator the HTTP route uses, with
 *   the same provenance columns. `bulk` is never set: Jev proposals stay
 *   non-bulk-acceptable, one keystroke per proposal.
 * - Shows the review gate (`deriveReviewGateStatus`) per item so blockers
 *   (missing price/brand/image/pages) are visible before approval.
 * - Chains a narrow dependent refresh after type review, reusing the frozen
 *   evidence and keeping the accepted type, name and universal decisions.
 *   Queue ownership and atomic publication protect concurrent work.
 * - Emits qualification receipts JSON compatible with
 *   TYPESAFE_CANARY_RECEIPTS_PATH (`productTypeReviewed`,
 *   `attributesReviewed`, `cohortPagesReviewed`).
 *
 * Usage:
 *   bun scripts/review-canary.ts --batch "Jev Canary — goldset-16" [--reviewer nick] [--receipts-out path] [--list-only]
 *
 * Fails closed: reviewer identity is required for decisions, corrections are
 * validated by the service (invalid values reject the decision, nothing is
 * written). Jev still requires an enabled approved route; incompatible
 * snapshots require a fresh run rather than being reinterpreted.
 */

import { createInterface } from 'node:readline/promises';
import { parseArgs as parseNodeArgs } from 'node:util';
import fs from 'node:fs';
import { z } from 'zod';
import { initDb } from '../src/db/connection';
import { findWorkspace } from '../src/db/repositories/workspace-repo';
import {
  listItemsByBatch,
  findItemById,
} from '../src/db/repositories/onboarding-item-repo';
import {
  getValidatedOnboardingRun,
  getEvidenceByRun,
} from '../src/db/repositories/classification-run-repo';
import { submitProposalDecisions } from '../src/classification/proposal-review-service';
import { listBatches } from '../src/db/repositories/onboarding-batch-repo';
import { getLiveDecisionsByRun } from '../src/db/repositories/classification-run-repo';
import { listCurrentRunProposals } from '../src/db/repositories/classification-dependent-review-repo';
import { makeCanaryDecision, parseCanaryCorrection, summarizeCanaryReview } from '../src/onboarding/canary-review';
import { getRuntimeSnapshotByHash, type RuntimeClassificationSnapshot } from '../src/classification/runtime-snapshot';
import { deriveReviewGateStatus } from '../src/shared/schemas/onboarding-review-queue';
import type {
  ClassificationProposal,
  ClassificationEvidence,
} from '../src/shared/types';

const DEFAULT_DB = 'storage/catalog/.shopsite-cms/app.db';

interface Args {
  batch: string;
  reviewer: string;
  receiptsOut: string;
  listOnly: boolean;
  db: string;
  decisionsFile: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const { values } = parseNodeArgs({ args: argv, strict: true, allowPositionals: false, options: {
    batch: { type: 'string' }, reviewer: { type: 'string' }, 'receipts-out': { type: 'string' },
    'list-only': { type: 'boolean' }, db: { type: 'string' }, 'decisions-file': { type: 'string' }, help: { type: 'boolean' },
  } });
  return {
    batch: values.batch ?? 'Jev Canary — goldset-16',
    reviewer: values.reviewer ?? '',
    receiptsOut: values['receipts-out'] ?? '',
    listOnly: values['list-only'] ?? false,
    db: values.db ?? process.env.BAYSTATE_CMS_DB ?? DEFAULT_DB,
    decisionsFile: values['decisions-file'] ?? '',
    help: values.help ?? false,
  };
}

/** Proposal header with field target for attribute assignments (brand vs food-form matters). */
export function proposalHeader(p: ClassificationProposal, snapshot?: RuntimeClassificationSnapshot | null): string {
  const attribute = snapshot?.attributes.find(attribute => attribute.id === p.targetId);
  const mapping = snapshot?.attributeMappings.find(mapping => mapping.attributeId === p.targetId);
  const targetSuffix = p.targetId && ['field_assignment', 'reviewable_abstention'].includes(p.proposalType)
    ? `:${attribute?.name ?? p.targetId}${mapping ? ` → ${mapping.catalogField}` : ''}` : '';
  const correctionNote = p.hasRevisedValue || p.hasRevisedTargetId ? ' (reviewer correction)' : '';
  return `[${p.proposalType}${targetSuffix}] ${summarizeValue(p)}${correctionNote}`;
}
export function summarizeValue(p: ClassificationProposal): string {
  const v = p.hasRevisedValue ? p.revisedValue : p.proposedValue;
  if (p.proposalType === 'reviewable_abstention') return String((v as { reason?: string } | null)?.reason ?? 'Unresolved outcome');
  if (p.proposalType === 'primary_product_type') {
    const id = p.hasRevisedTargetId ? p.revisedTargetId : (v as Record<string, unknown> | null)?.productTypeId;
    const words = (v as Record<string, unknown> | null)?.matchedWords;
    const kw = Array.isArray(words) && words.length > 0 ? ` [keywords: ${words.join(', ')}]`
      : p.derivation?.kind === 'systemone_judgment' ? ' [Jev judgment]' : '';
    return `${String(id ?? '?')}${kw}`;
  }
  if (p.proposalType === 'category_page') {
    if (typeof v === 'string') return v;
    const rec = (v ?? {}) as Record<string, unknown>;
    return `${String(rec.pageName ?? '?')}${rec.pageId ? ` (${String(rec.pageId).slice(0, 8)})` : ''}`;
  }
  if (typeof v === 'string') return v;
  const json = JSON.stringify(v) ?? String(v);
  return json.length > 80 ? `${json.slice(0, 77)}…` : json;
}

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function renderEvidence(
  ids: string[] | undefined,
  byId: Map<string, ClassificationEvidence>,
  prefix: string,
): string[] {
  const lines: string[] = [];
  for (const id of ids ?? []) {
    const e = byId.get(id);
    if (!e) {
      lines.push(`  ${prefix} [missing evidence ${id.slice(0, 8)}]`);
      continue;
    }
    const snippet = typeof e.snippet === 'string' && e.snippet.length > 0 ? e.snippet : JSON.stringify(e.value);
    lines.push(`  ${prefix} “${trunc(snippet ?? '(empty)', 140)}” — ${e.source}${e.sourceField ? `/${e.sourceField}` : ''}`);
  }
  return lines;
}

function derivationLabel(p: ClassificationProposal): string {
  const d = p.derivation as { kind?: string; productTypeSource?: string } | undefined;
  if (!d?.kind) return 'unknown derivation';
  if (d.kind === 'product_type_invariant') return `type invariant (source: ${d.productTypeSource ?? '?'})`;
  if (d.kind === 'evidence_match') return 'evidence match';
  if (d.kind === 'systemone_judgment') return 'Jev judgment';
  return d.kind;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: bun scripts/review-canary.ts --batch "Jev Canary — goldset-16" --reviewer nick [--list-only] [--receipts-out path] [--decisions-file path] [--db path]');
    return;
  }
  if (!fs.existsSync(args.db)) throw new Error('The review command requires an existing initialized workspace database.');
  initDb(args.db);
  const workspace = findWorkspace();
  if (!workspace) throw new Error('no workspace row found.');

  const batch = listBatches(workspace.id).find(candidate => candidate.name === args.batch);
  if (!batch) throw new Error(`batch "${args.batch}" not found.`);
  if (batch.workspaceId !== workspace.id) throw new Error('batch belongs to a different workspace.');

  const items = listItemsByBatch(batch.id);
  if (items.length === 0) throw new Error('batch has no items.');

  if (args.decisionsFile) {
    const plan = z.array(z.object({
      itemId: z.string().min(1), runId: z.string().min(1), proposalId: z.string().min(1),
      action: z.enum(['accept', 'reject', 'correct', 'defer']), note: z.string().min(1),
      revisedValue: z.unknown().optional(), revisedTargetId: z.string().nullable().optional(),
    }).strict()).parse(JSON.parse(fs.readFileSync(args.decisionsFile, 'utf8')));
    if (new Set(plan.map(entry => entry.proposalId)).size !== plan.length) throw new Error('Each proposal must appear exactly once in the decision plan.');
    const reviewer = 'opencode:jev-canary-evaluation';
    let recorded = 0;
    for (const entry of plan) {
      const item = findItemById(entry.itemId);
      if (!item || item.batchId !== batch.id || item.curationData?.classificationRunId !== entry.runId) throw new Error('Decision plan belongs to a different batch or superseded run.');
      const proposal = listCurrentRunProposals(entry.runId).find(p => p.id === entry.proposalId);
      if (!proposal) throw new Error('Proposal is no longer current.');
      if (proposal.status !== 'pending' || proposal.currentDecisionId) throw new Error('Agent plans may only evaluate undecided proposals; existing reviewer decisions are preserved.');
      if (args.listOnly) { console.log(`  ${proposalHeader(proposal)} → ${entry.action} (${entry.note})`); continue; }
      const result = submitProposalDecisions({
        workspaceId: workspace.id, productSku: item.upc, sourceKind: 'onboarding', onboardingItemId: item.id,
        runId: entry.runId, reviewOrigin: 'agent_review',
        decisions: [makeCanaryDecision({ ...entry, proposal, reviewer })],
      });
      if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
      recorded += 1;
    }
    console.log(`[review-canary] ${recorded} individually evaluated agent decision(s). Final human review/promotion authority is retained.`);
    writeReceipts({ ...args, reviewer }, recorded);
    return;
  }

  const rl = args.listOnly ? null : createInterface({ input: process.stdin, output: process.stdout });
  let reviewer = args.reviewer;
  if (!args.listOnly && !reviewer) {
    reviewer = (await rl!.question('Reviewer id (recorded as reviewer_id): ')).trim();
    if (!reviewer) throw new Error('reviewer identity is required — decisions are unattributed otherwise.');
  }
  args.reviewer = reviewer;

  let decided = 0;
  const typeAcceptedThisSession = new Set<string>();

  for (const item of items) {
    const curationData = (item.curationData ?? null) as Record<string, unknown> | null;
    const extractionData = (item.extractionData ?? null) as Record<string, unknown> | null;
    const run = ((curationData?.classificationRunId as string | undefined) ?? null) ? getValidatedOnboardingRun((curationData?.classificationRunId as string), workspace.id, item.id, item.upc) : null;

    const gate = deriveReviewGateStatus(item as never, curationData, extractionData);
    const gateNote = gate.status === 'ready'
      ? 'gate: ready'
      : `gate: ${gate.status} [${(gate.warningCodes ?? []).join(', ') || 'no codes'}]`;

    if (!run) {
      console.log(`\n== ${item.upc} — ${item.name ?? '(unnamed)'} ==\n  no validated classification run (${gateNote}); skipping.`);
      continue;
    }

    const decideRun = async (activeRun: { id: string }): Promise<void> => {
      const snapshot = run.configSnapshotHash ? getRuntimeSnapshotByHash(workspace.id, run.configSnapshotHash) : null;
      const freshItem = findItemById(item.id) ?? item;
      const freshGate = deriveReviewGateStatus(freshItem as never, freshItem.curationData as Record<string, unknown> | null, freshItem.extractionData as Record<string, unknown> | null);
      const current = listCurrentRunProposals(activeRun.id);
      const liveDecisions = getLiveDecisionsByRun(activeRun.id);
      const agentDecisions = new Set(liveDecisions.filter(d => d.decisionOrigin === 'agent_review').map(d => d.id));
      const proposals = current.filter(p => p.status === 'pending' || (p.currentDecisionId && agentDecisions.has(p.currentDecisionId)));
      const evidence = getEvidenceByRun(activeRun.id);
      const byId = new Map(evidence.map(e => [e.id, e]));
      const pending = proposals;

      console.log(`\n== ${item.upc} — ${item.name ?? '(unnamed)'} ==`);
      console.log(`  run ${activeRun.id.slice(0, 8)} · gate: ${freshGate.status} [${freshGate.warningCodes.join(', ')}] · ${pending.length} pending proposals`);
      const assignedPages = current.filter(p => p.proposalType === 'category_page' && p.status === 'accepted').map(summarizeValue);
      if (assignedPages.length) console.log(`  Already accepted pages: ${assignedPages.join(', ')}`);

      if (args.listOnly) {
        for (const p of pending) {
          console.log(`  ${proposalHeader(p, snapshot)} (${Math.round((p.confidence ?? 0) * 100)}% original support, ${derivationLabel(p)})`);
        }
        return;
      }

      for (const p of pending) {
        console.log(`\n  ${proposalHeader(p, snapshot)}`);
        const measure = p.derivation?.kind === 'systemone_judgment'
          ? `${p.derivation.primitive === 'noul' ? 'P(yes)' : 'P(chosen outcome)'} ${p.derivation.selectedProbability == null ? 'unknown' : `${Math.round(p.derivation.selectedProbability * 100)}%`}`
          : `original support score ${Math.round((p.confidence ?? 0) * 100)}%`;
        console.log(`    ${measure} · ${derivationLabel(p)} · id ${p.id.slice(0, 8)}`);
        for (const line of renderEvidence(p.supportingEvidenceIds, byId, '＋')) console.log(line);
        for (const line of renderEvidence(p.contradictingEvidenceIds, byId, '⚠ CONFLICT')) console.log(line);
        const roleIds = new Set([...(p.supportingEvidenceIds ?? []), ...(p.contradictingEvidenceIds ?? [])]);
        for (const line of renderEvidence(p.evidenceIds.filter(id => !roleIds.has(id)), byId, 'context')) console.log(line);

        let answer = '';
        while (!['a', 'r', 'c', 's', 'q'].includes(answer)) {
          answer = (await rl!.question('    [a]ccept [r]eject [c]orrect [s]kip [q]uit > ')).trim().toLowerCase();
        }
        if (answer === 'q') {
          rl!.close();
          printSummary(decided);
          process.exit(0);
        }
        if (answer === 's') continue;

        let revisedValue: unknown;
        let revisedTargetId: string | null | undefined;
        let hasCorrection = false;
        if (answer === 'c') {
          const text = (await rl!.question(`    corrected value / type ID / page name or ID (current: ${summarizeValue(p)}): `)).trim();
          if (!text) { console.log('    empty — skipped.'); continue; }
          try {
            const correction = parseCanaryCorrection(p, text, run.configSnapshotHash ? getRuntimeSnapshotByHash(workspace.id, run.configSnapshotHash) : null);
            revisedValue = correction.revisedValue;
            revisedTargetId = correction.revisedTargetId;
          } catch (error) { console.log(`    ${error instanceof Error ? error.message : String(error)} — nothing written.`); continue; }
          hasCorrection = true;
        }
        const note = (await rl!.question('    note (optional, Enter to skip): ')).trim();

        const result = submitProposalDecisions({
          workspaceId: workspace.id,
          productSku: item.upc,
          runId: activeRun.id,
          sourceKind: 'onboarding',
          onboardingItemId: item.id,
          decisions: [makeCanaryDecision({ proposal: p,
            action: answer === 'r' ? 'reject' : hasCorrection ? 'correct' : 'accept',
            reviewer, note, revisedValue, revisedTargetId })],
        });
        if (!result.ok) {
          console.log(`    ✗ decision rejected (${result.code}): ${result.reason} — nothing written.`);
          continue;
        }
        decided += 1;
        console.log(`    ✓ ${result.decisions[0].decision} (decision ${result.decisions[0].id.slice(0, 8)})`);
        if (p.proposalType === 'primary_product_type' && answer !== 'r') {
          const withheld = listCurrentRunProposals(activeRun.id).some(proposal => proposal.proposalType === 'reviewable_abstention'
            && ['product_attribute_proposals', 'category_page_proposals'].includes(proposal.targetId ?? '')
            && String((proposal.proposedValue as { reason?: string })?.reason ?? '').includes('No reviewed Primary Product Type'));
          if (hasCorrection || withheld) typeAcceptedThisSession.add(item.id);
        }
      }
    };

    // Review loop follows run succession: accepting a type and re-curating
    // supersedes the old run, so decisions continue on the fresh run (the
    // type is re-proposed there — confirm it again). One chained
    // re-curation per item per session; unrecognized answers re-prompt
    // instead of silently meaning "no".
    const activeRun: { id: string } = run;
    let recurateDone = false;
    for (;;) {
      typeAcceptedThisSession.delete(item.id);
      await decideRun(activeRun);

      if (args.listOnly || recurateDone || !typeAcceptedThisSession.has(item.id)) break;
      let yn = 'x';
      while (!['y', 'n', ''].includes(yn)) {
        yn = (await rl!.question('  Type accepted. Refresh attributes/pages using existing evidence? [Y/n] ')).trim().toLowerCase();
        if (!['y', 'n', ''].includes(yn)) console.log('  please answer Y or n.');
      }
      if (yn === 'n') break;
      const { refreshReviewedDependents } = await import('../src/classification/refresh-reviewed-dependents');
      await refreshReviewedDependents({ runId: activeRun.id, workspaceId: workspace.id, itemId: item.id });
      recurateDone = true;
      console.log('  Refreshed attributes/pages from frozen evidence. Accepted type, OCR, name and universal decisions retained.');
    }
  }

  rl?.close();
  printSummary(decided);
  writeReceipts(args, decided);
}

function printSummary(decided: number): void {
  console.log(`\n[review-canary] session complete: ${decided} decision(s) recorded.`);
}

function writeReceipts(args: Args, decided: number): void {
  const workspace = findWorkspace()!;
  const batch = listBatches(workspace.id).find(candidate => candidate.name === args.batch)!;
  const review = summarizeCanaryReview(listItemsByBatch(batch.id).map(item => {
    const run = getValidatedOnboardingRun(item.curationData?.classificationRunId, workspace.id, item.id, item.upc);
    return { itemId: item.id, runId: run?.id ?? null, cohortRunId: run?.cohortRunId ?? null,
      snapshotHash: run?.configSnapshotHash ?? null,
      proposals: run ? listCurrentRunProposals(run.id) : [],
      decisions: run ? getLiveDecisionsByRun(run.id) : [] };
  }));
  const receipts = {
    ...review,
    batch: args.batch,
    reviewedBy: args.reviewer || null,
    reviewedAt: new Date().toISOString(),
    decisionsThisSession: decided,
  };
  console.log(`[review-canary] receipts: types=${receipts.productTypeReviewed} attrs=${receipts.attributesReviewed} pages=${receipts.cohortPagesReviewed}`);
  if (receipts.productTypeReviewed && receipts.attributesReviewed && receipts.cohortPagesReviewed) {
    console.log('[review-canary] all stages fully decided. For qualification:');
    console.log(`  TYPESAFE_CANARY_PRODUCT_TYPE_REVIEWED=1 TYPESAFE_CANARY_ATTRIBUTES_REVIEWED=1 TYPESAFE_CANARY_COHORT_PAGES_REVIEWED=1`);
  }
  if (args.receiptsOut) {
    fs.writeFileSync(args.receiptsOut, `${JSON.stringify(receipts, null, 2)}\n`);
    console.log(`[review-canary] receipts written to ${args.receiptsOut} (use as TYPESAFE_CANARY_RECEIPTS_PATH).`);
  }
}

if (import.meta.main) main().catch(err => {
  console.error(`[review-canary] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
