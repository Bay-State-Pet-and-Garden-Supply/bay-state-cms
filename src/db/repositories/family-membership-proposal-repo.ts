import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';
import type { Database } from '../driver';
import type {
  FamilyMembershipAnchorJudgment,
  FamilyMembershipOutcome,
} from '../../classification/family-membership-proposal';
/**
 * Versioned TypeSafe family-membership proposal store (issue #371).
 *
 * One row per (workspace, incoming SKU, frozen anchor set): raw typed
 * judgments + distributions, actual producing call IDs, rule/model/policy/
 * evidence/anchor hashes, and the reviewed negative/positive decision.
 * Lifecycle: proposed | unresolved → accepted | revised | rejected |
 * deferred → stale. Selected/negative/same_sku persist as live `proposed`
 * rows; recorded refusals (overflow/service/disabled/no_fit/…) persist as
 * `unresolved` audit rows that never replay and never decide. `applied` is
 * never stored here — an accepted proposal flows through the complete #370
 * plan/apply path; the plan row carries `applied`.
 *
 * Reuse is only of identical relevant state (stored-hash match on policy,
 * evidence, anchors, rules) and never carries human approval implicitly:
 * a reused row replays its judgments; the operator still decides.
 */
export type FamilyMembershipProposalStatus =
  | 'proposed'
  | 'unresolved'
  | 'accepted'
  | 'revised'
  | 'rejected'
  | 'deferred'
  | 'stale';

/**
 * Outcomes that complete adjudication and persist as live `proposed` rows:
 * selected (a family choice to dispose) and same_sku (identity handling).
 * Every other outcome — including negative — persists as `unresolved`:
 * recorded for audit, never replayed by reuse, never decidable without a
 * fresh proposal. Failure rows never replay.
 */
const REUSABLE_OUTCOME: Record<'selected' | 'same_sku', true> = {
  selected: true,
  same_sku: true,
};

export interface FamilyMembershipProposalRow {
  id: string;
  workspaceId: string;
  sku: string;
  outcome: FamilyMembershipOutcome;
  judgmentsJson: string;
  rawJudgmentsJson: string;
  modelCallIdsJson: string;
  evidenceHash: string;
  ruleHash: string;
  anchorHash: string;
  modelPolicyDigest: string;
  ruleVersion: string;
  promptTemplateVersion: string;
  status: FamilyMembershipProposalStatus;
  revision: number;
  linkedPlanId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FamilyMembershipProposalRecord extends FamilyMembershipProposalRow {
  judgments: FamilyMembershipAnchorJudgment[];
  rawJudgments: Array<{ anchorSku: string; choice: string; probabilities: Record<string, number>; confidence: number }>;
  modelCallIds: string[];
  request: FamilyMembershipProposalRequest;
}

export interface FamilyMembershipProposalRequest {
  gtin: string | null;
  upc: string | null;
  mpn: string | null;
  maxAnchors: number | null;
}

interface ProposalDbRow {
  id: string;
  workspace_id: string;
  sku: string;
  outcome: string;
  judgments_json: string;
  raw_judgments_json: string;
  model_call_ids_json: string;
  request_json: string | null;
  evidence_hash: string;
  rule_hash: string;
  anchor_hash: string;
  model_policy_digest: string;
  rule_version: string;
  prompt_template_version: string;
  status: string;
  revision: number;
  linked_plan_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: ProposalDbRow): FamilyMembershipProposalRecord {
  let judgments: FamilyMembershipAnchorJudgment[];
  let rawJudgments: FamilyMembershipProposalRecord['rawJudgments'];
  let modelCallIds: string[];
  try {
    judgments = JSON.parse(row.judgments_json) as FamilyMembershipAnchorJudgment[];
  } catch {
    judgments = [];
  }
  try {
    rawJudgments = JSON.parse(row.raw_judgments_json) as FamilyMembershipProposalRecord['rawJudgments'];
  } catch {
    rawJudgments = [];
  }
  try {
    modelCallIds = JSON.parse(row.model_call_ids_json) as string[];
  } catch {
    modelCallIds = [];
  }
  let request: FamilyMembershipProposalRequest = { gtin: null, upc: null, mpn: null, maxAnchors: null };
  try {
    const parsed = JSON.parse(row.request_json ?? '{}') as Partial<FamilyMembershipProposalRequest>;
    request = {
      gtin: typeof parsed.gtin === 'string' ? parsed.gtin : null,
      upc: typeof parsed.upc === 'string' ? parsed.upc : null,
      mpn: typeof parsed.mpn === 'string' ? parsed.mpn : null,
      maxAnchors: typeof parsed.maxAnchors === 'number' ? parsed.maxAnchors : null,
    };
  } catch {
    // Legacy rows predate request capture: fail closed to nulls (never replayed
    // across an unknown request). Reuse pins on the stored hashes anyway.
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sku: row.sku,
    outcome: row.outcome as FamilyMembershipOutcome,
    judgmentsJson: row.judgments_json,
    rawJudgmentsJson: row.raw_judgments_json,
    modelCallIdsJson: row.model_call_ids_json,
    evidenceHash: row.evidence_hash,
    ruleHash: row.rule_hash,
    anchorHash: row.anchor_hash,
    modelPolicyDigest: row.model_policy_digest,
    ruleVersion: row.rule_version,
    promptTemplateVersion: row.prompt_template_version,
    status: row.status as FamilyMembershipProposalStatus,
    revision: row.revision,
    linkedPlanId: row.linked_plan_id,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    judgments,
    rawJudgments,
    modelCallIds,
    request,
  };
}

export function createFamilyMembershipProposal(input: {
  workspaceId: string;
  sku: string;
  outcome: FamilyMembershipOutcome;
  judgments: FamilyMembershipAnchorJudgment[];
  rawJudgments: Array<{ anchorSku: string; choice: string; probabilities: Record<string, number>; confidence: number }>;
  modelCallIds: string[];
  evidenceHash: string;
  ruleHash: string;
  anchorHash: string;
  modelPolicyDigest: string;
  ruleVersion: string;
  promptTemplateVersion: string;
  request?: Partial<FamilyMembershipProposalRequest>;
}): FamilyMembershipProposalRecord {
  const db = getDb();
  ensureProposalRequestColumn(db);
  const now = new Date().toISOString();
  const id = randomUUID();
  // Non-selected outcomes never persist as live rows: negatives and every
  // refusal (overflow/service/disabled/no_fit/insufficient/…) record as
  // `unresolved` for audit and never replay under identical hashes.
  const status: FamilyMembershipProposalStatus =
    input.outcome === 'selected' || input.outcome === 'same_sku'
      ? 'proposed'
      : 'unresolved';
  const request: FamilyMembershipProposalRequest = {
    gtin: input.request?.gtin ?? null,
    upc: input.request?.upc ?? null,
    mpn: input.request?.mpn ?? null,
    maxAnchors: input.request?.maxAnchors ?? null,
  };
  db.run(
    `INSERT INTO family_membership_proposals
     (id, workspace_id, sku, outcome, judgments_json, raw_judgments_json, model_call_ids_json, request_json,
      evidence_hash, rule_hash, anchor_hash, model_policy_digest, rule_version, prompt_template_version,
      status, revision, linked_plan_id, decided_by, decided_at, decision_note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.sku,
      input.outcome,
      JSON.stringify(input.judgments),
      JSON.stringify(input.rawJudgments),
      JSON.stringify(input.modelCallIds),
      JSON.stringify(request),
      input.evidenceHash,
      input.ruleHash,
      input.anchorHash,
      input.modelPolicyDigest,
      input.ruleVersion,
      input.promptTemplateVersion,
      status,
      0,
      null,
      null,
      null,
      null,
      now,
      now,
    ],
  );
  const created = findFamilyMembershipProposalById(id);
  if (!created) throw new Error(`family_membership_proposal_missing: created proposal "${id}" is unreadable.`);
  return created;
}

/**
 * Additive column for the originating join-propose request (gtin/upc/mpn/
 * maxAnchors). Existing databases predate it: add once, converge silently.
 */
function ensureProposalRequestColumn(db: Database): void {
  const cols = db.query('PRAGMA table_info(family_membership_proposals)').all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === 'request_json')) return;
  db.exec(`ALTER TABLE family_membership_proposals ADD COLUMN request_json TEXT NOT NULL DEFAULT '{}'`);
}

export function findFamilyMembershipProposalById(id: string): FamilyMembershipProposalRecord | null {
  const db = getDb();
  const row = db.query('SELECT * FROM family_membership_proposals WHERE id = ?').get(id) as ProposalDbRow | undefined;
  return row ? mapRow(row) : null;
}

export function listFamilyMembershipProposals(workspaceId: string, sku?: string): FamilyMembershipProposalRecord[] {
  const db = getDb();
  const rows = sku
    ? (db.query(
        'SELECT * FROM family_membership_proposals WHERE workspace_id = ? AND sku = ? ORDER BY created_at DESC',
      ).all(workspaceId, sku) as ProposalDbRow[])
    : (db.query(
        'SELECT * FROM family_membership_proposals WHERE workspace_id = ? ORDER BY created_at DESC',
      ).all(workspaceId) as ProposalDbRow[]);
  return rows.map(mapRow);
}

/**
 * Latest live proposal for reuse checks: only a `proposed` row with
 * identical stored hashes replays judgments. `unresolved` rows (recorded
 * refusals: overflow/service/disabled/no_fit/…) and accepted/revised/
 * rejected/deferred/stale rows never replay — the operator re-proposes and
 * still decides. The hashes bind policy, evidence, anchors, AND rule state
 * (`ruleHash` covers ruleVersions + prompt template + policy): a
 * rule-version or template change over identical anchors/evidence never
 * replays stale judgments.
 */
export function findReusableFamilyMembershipProposal(input: {
  workspaceId: string;
  sku: string;
  evidenceHash: string;
  anchorHash: string;
  modelPolicyDigest: string;
  ruleHash?: string;
}): FamilyMembershipProposalRecord | null {
  const live = listFamilyMembershipProposals(input.workspaceId, input.sku).filter(
    (row) => row.status === 'proposed' && REUSABLE_OUTCOME[row.outcome as 'selected' | 'same_sku'] === true,
  );
  for (const row of live) {
    if (row.evidenceHash !== input.evidenceHash) continue;
    if (row.anchorHash !== input.anchorHash) continue;
    if (row.modelPolicyDigest !== input.modelPolicyDigest) continue;
    // Rule-bound: a rule-version or template change over identical
    // anchors/evidence never replays stale judgments. Callers without a
    // ruleHash opt out of reuse entirely (fail closed, never replay
    // across an unknown rule state).
    if (input.ruleHash === undefined) continue;
    if (row.ruleHash !== input.ruleHash) continue;
    return row;
  }
  return null;
}

export function decideFamilyMembershipProposal(input: {
  id: string;
  actor: string;
  action: 'accept' | 'revise' | 'reject' | 'defer';
  linkedPlanId?: string | null;
  note?: string | null;
  /** Fail closed when the caller supplies current hashes: drift refuses the decision. */
  current?: { evidenceHash: string; anchorHash: string; ruleHash: string; modelPolicyDigest: string };
}): FamilyMembershipProposalRecord {
  const db = getDb();
  const row = findFamilyMembershipProposalById(input.id);
  if (!row) throw new Error(`family_membership_proposal_missing: no proposal "${input.id}".`);
  if (row.status === 'stale') {
    throw new Error('family_membership_proposal_stale: re-propose against current evidence before deciding.');
  }
  if (row.status === 'unresolved') {
    throw new Error('family_membership_proposal_unresolved: recorded refusal carries no adjudication; re-propose against current evidence.');
  }
  if (input.current) {
    const drifted =
      row.evidenceHash !== input.current.evidenceHash ||
      row.anchorHash !== input.current.anchorHash ||
      row.ruleHash !== input.current.ruleHash ||
      row.modelPolicyDigest !== input.current.modelPolicyDigest;
    if (drifted) {
      throw new Error('family_membership_proposal_stale: evidence/anchor/rule/policy drifted since the proposal; re-propose before deciding.');
    }
  }
  const status: FamilyMembershipProposalStatus =
    input.action === 'accept'
      ? 'accepted'
      : input.action === 'revise'
        ? 'revised'
        : input.action === 'reject'
          ? 'rejected'
          : 'deferred';
  const now = new Date().toISOString();
  const revision = input.action === 'revise' ? row.revision + 1 : row.revision;
  db.run(
    `UPDATE family_membership_proposals
     SET status = ?, revision = ?, linked_plan_id = COALESCE(?, linked_plan_id),
         decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ?
     WHERE id = ?`,
    [
      status,
      revision,
      input.linkedPlanId ?? null,
      input.actor,
      now,
      input.note ?? null,
      now,
      input.id,
    ],
  );
  const updated = findFamilyMembershipProposalById(input.id);
  if (!updated) throw new Error(`family_membership_proposal_missing: proposal "${input.id}" is unreadable after decision.`);
  return updated;
}

export function markFamilyMembershipProposalStale(id: string): FamilyMembershipProposalRecord | null {
  const db = getDb();
  const row = findFamilyMembershipProposalById(id);
  if (!row) return null;
  if (row.status === 'accepted' || row.status === 'unresolved') return row;
  const now = new Date().toISOString();
  db.run('UPDATE family_membership_proposals SET status = ?, updated_at = ? WHERE id = ?', ['stale', now, id]);
  return findFamilyMembershipProposalById(id);
}

/**
 * Mark every live (`proposed`) proposal touching any of the given SKUs
 * stale: the incoming SKU plus each anchor SKU stored in the judgments.
 * Accepted/applied history is untouched; recorded refusals need no marking.
 */
export function markProposalsStaleForSkus(workspaceId: string, skus: string[]): number {
  const touched = skus.filter((s) => s.trim().length > 0);
  if (touched.length === 0) return 0;
  const wanted: Record<string, true> = {};
  for (const s of touched) wanted[s] = true;
  let marked = 0;
  for (const sku of touched) {
    for (const row of listFamilyMembershipProposals(workspaceId, sku)) {
      if (row.status !== 'proposed') continue;
      if (markFamilyMembershipProposalStale(row.id)) marked += 1;
    }
  }
  // Anchor-side: a proposal for SKU X stores judgments against anchor SKUs,
  // so a mutation to anchor SKU A must stale X's live row even though X's
  // own SKU listing is untouched.
  for (const row of listFamilyMembershipProposals(workspaceId)) {
    if (row.status !== 'proposed') continue;
    if (wanted[row.sku]) continue;
    if (row.judgments.some((j) => wanted[j.anchorSku])) {
      if (markFamilyMembershipProposalStale(row.id)) marked += 1;
    }
  }
  return marked;
}

