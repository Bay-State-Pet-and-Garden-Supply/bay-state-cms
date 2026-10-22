import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';
import {
  STOREFRONT_FAMILY_PLAN_VERSION,
  type StorefrontFamilyPlan,
  type StorefrontFamilyPlanStatus,
} from '../../shared/schemas/storefront-family';

/**
 * Listing-owned StorefrontFamilyPlan repository (issue #368).
 *
 * Persists versioned family plans + human decisions. Revision lifecycle:
 * proposed → accepted | revised | rejected | deferred → stale (drift) →
 * applied (linked change set committed). A deferred/rejected unapplied plan
 * leaves the standalone listing releasable (no readiness barrier); accepting
 * requires the complete validated dependency set (enforced at apply time).
 */

export interface StorefrontFamilyPlanRow {
  id: string;
  workspaceId: string;
  planJson: string;
  status: StorefrontFamilyPlanStatus;
  revision: number;
  linkedChangeSetId: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapPlanRow(row: Record<string, unknown>): StorefrontFamilyPlanRow {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    planJson: String(row.plan_json),
    status: String(row.status) as StorefrontFamilyPlanStatus,
    revision: Number(row.revision),
    linkedChangeSetId: row.linked_change_set_id != null ? String(row.linked_change_set_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function parseStorefrontFamilyPlan(planJson: string): StorefrontFamilyPlan {
  return JSON.parse(planJson) as StorefrontFamilyPlan;
}

export function createStorefrontFamilyPlan(input: {
  workspaceId: string;
  plan: StorefrontFamilyPlan;
}): StorefrontFamilyPlanRow {
  const db = getDb();
  const now = new Date().toISOString();
  const id = input.plan.id || randomUUID();
  db.run(
    `INSERT INTO storefront_family_plans (id, workspace_id, plan_json, status, revision, linked_change_set_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      JSON.stringify(input.plan),
      input.plan.status,
      input.plan.revision,
      input.plan.linkedChangeSetId,
      input.plan.createdAt ?? now,
      now,
    ],
  );
  return findStorefrontFamilyPlanById(id)!;
}

export function findStorefrontFamilyPlanById(id: string): StorefrontFamilyPlanRow | null {
  const db = getDb();
  const row = db.query('SELECT * FROM storefront_family_plans WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return mapPlanRow(row);
}

/** Find the family plan (any status) linked to a change set, if one exists. */
export function findStorefrontFamilyPlanByChangeSetId(changeSetId: string): StorefrontFamilyPlanRow | null {
  const db = getDb();
  const row = db.query('SELECT * FROM storefront_family_plans WHERE linked_change_set_id = ? ORDER BY updated_at DESC LIMIT 1').get(changeSetId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return mapPlanRow(row);
}

export function listStorefrontFamilyPlans(workspaceId: string): StorefrontFamilyPlanRow[] {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM storefront_family_plans WHERE workspace_id = ? ORDER BY created_at DESC',
  ).all(workspaceId) as Record<string, unknown>[];
  return rows.map(mapPlanRow);
}

export function listStorefrontFamilyPlansByMember(workspaceId: string, sku: string): StorefrontFamilyPlanRow[] {
  return listStorefrontFamilyPlans(workspaceId).filter((row) => {
    try {
      const plan = parseStorefrontFamilyPlan(row.planJson);
      return plan.memberSkus.includes(sku);
    } catch {
      return false;
    }
  });
}

/**
 * All plans in the workspace whose member set contains the SKU (#370
 * candidate family discovery: reparenting/merging must never happen
 * silently, so every existing family touching a SKU is surfaced).
 * Stored JSON that fails to parse (corrupt/predates the schema) is
 * skipped — the list route surfaces corruption separately at review.
 */
export function listStorefrontFamilyPlansForJoinCandidates(workspaceId: string, skus: readonly string[]): StorefrontFamilyPlanRow[] {
  if (skus.length === 0) return [];
  const wanted = new Set(skus);
  return listStorefrontFamilyPlans(workspaceId).filter((row) => {
    try {
      const plan = parseStorefrontFamilyPlan(row.planJson);
      return plan.memberSkus.some((sku) => wanted.has(sku));
    } catch {
      return false;
    }
  });
}

export function updateStorefrontFamilyPlan(input: {
  id: string;
  plan: StorefrontFamilyPlan;
  status: StorefrontFamilyPlanStatus;
  revision: number;
  linkedChangeSetId?: string | null;
}): StorefrontFamilyPlanRow {
  const db = getDb();
  const now = new Date().toISOString();
  db.run(
    `UPDATE storefront_family_plans
     SET plan_json = ?, status = ?, revision = ?, linked_change_set_id = ?, updated_at = ?
     WHERE id = ?`,
    [
      JSON.stringify(input.plan),
      input.status,
      input.revision,
      input.linkedChangeSetId !== undefined ? input.linkedChangeSetId : input.plan.linkedChangeSetId,
      now,
      input.id,
    ],
  );
  return findStorefrontFamilyPlanById(input.id)!;
}

export { STOREFRONT_FAMILY_PLAN_VERSION };
