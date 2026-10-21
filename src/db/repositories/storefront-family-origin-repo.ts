import { getDb } from '../connection';

export interface FamilyOnboardingOriginRow {
  itemId: string;
  batchId: string;
  workspaceId: string;
  sku: string;
  inputRevision: string;
  runId: string | null;
  runCurrentnessHash: string | null;
  evidenceId: string | null;
  evidenceHash: string | null;
  curationJson: string | null;
}

export interface ApprovedFamilyCatalogReceipt {
  approvedCommit: string;
  approvedAt: string;
  classificationRunId: string | null;
  draftHash: string;
}

/** Approved immutable change-set bindings for this workspace/SKU, newest approval first. */
export function listApprovedFamilyCatalogReceipts(workspaceId: string, sku: string): ApprovedFamilyCatalogReceipt[] {
  const rows = getDb().query(`
    SELECT cs.approved_commit, cs.approved_at, csi.classification_run_id, csi.draft_hash
    FROM change_set_items csi
    JOIN change_sets cs ON cs.id = csi.change_set_id
    WHERE cs.workspace_id = ? AND csi.sku = ?
      AND cs.status IN ('approved', 'pushed') AND cs.approved_commit IS NOT NULL AND cs.approved_at IS NOT NULL
    ORDER BY cs.approved_at DESC, cs.id DESC
  `).all(workspaceId, sku) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    approvedCommit: String(row.approved_commit),
    approvedAt: String(row.approved_at),
    classificationRunId: typeof row.classification_run_id === 'string' ? row.classification_run_id : null,
    draftHash: String(row.draft_hash),
  }));
}

/** Exact item lookup. Multiple live imports remain ambiguous; callers must not pick newest. */
export function listFamilyOnboardingOrigins(workspaceId: string, sku: string): FamilyOnboardingOriginRow[] {
  const rows = getDb().query(`
    SELECT i.id AS item_id, i.batch_id, b.workspace_id, i.upc, i.input_revision,
           i.curation_data_json,
           e.id AS evidence_id, e.evidence_hash
    FROM onboarding_items i
    JOIN onboarding_batches b ON b.id = i.batch_id
    LEFT JOIN accepted_item_evidence_current ec ON ec.workspace_id = b.workspace_id AND ec.item_id = i.id
    LEFT JOIN accepted_item_evidence_snapshots e ON e.workspace_id = ec.workspace_id AND e.item_id = ec.item_id
      AND e.id = ec.snapshot_id AND e.revision = ec.revision
    WHERE b.workspace_id = ? AND i.upc = ?
    ORDER BY i.id
  `).all(workspaceId, sku) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    let currentness: Record<string, unknown> | null = null;
    try {
      const curation = typeof row.curation_data_json === 'string' ? JSON.parse(row.curation_data_json) as Record<string, unknown> : null;
      const candidate = curation?.itemExecutionCurrentness;
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) currentness = candidate as Record<string, unknown>;
    } catch { /* invalid persisted curation is not authority */ }
    return {
      itemId: String(row.item_id), batchId: String(row.batch_id), workspaceId: String(row.workspace_id),
      sku: String(row.upc), inputRevision: String(row.input_revision ?? ''),
      runId: typeof currentness?.classificationRunId === 'string' ? currentness.classificationRunId : null,
      runCurrentnessHash: typeof currentness?.runCurrentnessHash === 'string' ? currentness.runCurrentnessHash : null,
      evidenceId: typeof row.evidence_id === 'string' ? row.evidence_id : null,
      evidenceHash: typeof row.evidence_hash === 'string' ? row.evidence_hash : null,
      curationJson: typeof row.curation_data_json === 'string' ? row.curation_data_json : null,
    };
  });
}

export function findFamilyOnboardingOrigin(workspaceId: string, itemId: string): FamilyOnboardingOriginRow | null {
  const row = getDb().query(`
    SELECT i.id AS item_id, i.batch_id, b.workspace_id, i.upc, i.input_revision,
           i.curation_data_json, ec.snapshot_id AS evidence_id, e.evidence_hash,
           i.curation_data_json AS currentness_source
    FROM onboarding_items i
    JOIN onboarding_batches b ON b.id = i.batch_id
    LEFT JOIN accepted_item_evidence_current ec ON ec.workspace_id = b.workspace_id AND ec.item_id = i.id
    LEFT JOIN accepted_item_evidence_snapshots e ON e.workspace_id = ec.workspace_id AND e.item_id = ec.item_id
      AND e.id = ec.snapshot_id AND e.revision = ec.revision
    WHERE b.workspace_id = ? AND i.id = ?
  `).get(workspaceId, itemId) as Record<string, unknown> | undefined;
  if (!row) return null;
  let currentness: Record<string, unknown> | null = null;
  try {
    const curation = typeof row.curation_data_json === 'string' ? JSON.parse(row.curation_data_json) as Record<string, unknown> : null;
    const candidate = curation?.itemExecutionCurrentness;
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) currentness = candidate as Record<string, unknown>;
  } catch { /* invalid persisted curation is not authority */ }
  return {
    itemId: String(row.item_id), batchId: String(row.batch_id), workspaceId: String(row.workspace_id), sku: String(row.upc),
    inputRevision: String(row.input_revision ?? ''),
    runId: typeof currentness?.classificationRunId === 'string' ? currentness.classificationRunId : null,
    runCurrentnessHash: typeof currentness?.runCurrentnessHash === 'string' ? currentness.runCurrentnessHash : null,
    evidenceId: typeof row.evidence_id === 'string' ? row.evidence_id : null,
    evidenceHash: typeof row.evidence_hash === 'string' ? row.evidence_hash : null,
    curationJson: typeof row.curation_data_json === 'string' ? row.curation_data_json : null,
  };
}
