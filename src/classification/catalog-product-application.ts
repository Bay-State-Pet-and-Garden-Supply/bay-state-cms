import { getDb } from '../db/connection';
import { readProductFile } from '../git/workspace-files';
import { deterministicStringify, hashJson } from '../git/deterministic-json';
import { getAcceptedProposals, recordHistoryEvent } from '../db/repositories/classification-run-repo';
import { getCachedAttributeMappings } from '../db/repositories/classification-config-repo';
import { createChangeSet, upsertChangeSetItem } from '../db/repositories/change-set-repo';
import { findWorkspace } from '../db/repositories/workspace-repo';
import { loadRuntimeConfigAuthority, createRuntimeActivationContext } from './config-loader';
import { authorityConfigHashMatches, getRuntimeSnapshotByHash, runtimeSnapshotHashMatchesConfig } from './runtime-snapshot';
import { getActiveVerifiedPageIds } from '../shopsite/page-import-service';
import { getActivePageImportHash } from '../db/repositories/page-repo';
import { getEffectiveProposalTargetId, getEffectiveProposalValue, serializeAttributeValue } from './assignment-projection';
import { pageNameFromPageValue } from '../shared/proposal-display';
import { computeProductHash } from './catalog-product-source';
import { digestLoadedImageBytes } from '../onboarding/packaging-ocr';
import { findConnection } from '../db/repositories/connection-repo';
import { resolveProductImageUrl } from '../shopsite/url-utils';
import type { Product } from '../shared/types';
import { isSilentNarrowing } from './attribute-grounding-guards';
import { isBrandPageProposal, isProtectedCatalogField, isProtectedTargetId, protectedTargetRefusal } from './classification-ownership';

/**
 * A2: re-hash the image bytes behind the run's recorded OCR image refs and
 * fail when any recorded digest no longer matches. Recorded digests come
 * from the run's evidence_extraction stage metadata (persisted by the
 * pipeline runner); refs resolve exactly as the OCR attempt resolved them.
 * Changed/absent bytes block that SKU; text-only runs (no recorded digests)
 * pass through untouched.
 */
export async function verifyRunImageBytesUnchanged(
  workspacePath: string,
  _workspaceId: string,
  _sku: string,
  runId: string,
  product: Product,
): Promise<void> {
  const db = getDb();
  const rows = db.query(
    `SELECT output_json FROM classification_stage_results WHERE run_id = ? AND stage_name = 'evidence_extraction' ORDER BY started_at DESC LIMIT 1`,
  ).all(runId) as Array<{ output_json: string | null }>;
  if (rows.length === 0) return;
  let recorded: Array<{ imageBytesDigest?: string | null }>;
  try {
    const parsed = JSON.parse(rows[0].output_json ?? '{}') as {
      metadata?: { ocrSummary?: { images?: Array<{ imageBytesDigest?: string | null }> } };
    };
    recorded = parsed.metadata?.ocrSummary?.images ?? [];
  } catch {
    return;
  }
  const digests = recorded.map(entry => entry.imageBytesDigest).filter((digest): digest is string => !!digest);
  if (digests.length === 0) return;
  const cgiBaseUrl = (() => { try { return findConnection(_workspaceId)?.cgiBaseUrl; } catch { return undefined; } })();
  const refs = [product.core.media?.primary, ...(product.core.media?.additional ?? [])].filter((ref): ref is string => !!ref).slice(0, 2);
  const current = new Set<string>();
  for (const ref of refs) {
    const resolved = cgiBaseUrl ? resolveProductImageUrl(ref, cgiBaseUrl) : ref;
    const digest = await digestLoadedImageBytes(resolved ?? ref, workspacePath).catch(() => null);
    if (digest) current.add(digest);
  }
  for (const digest of digests) {
    if (!current.has(digest)) {
      throw new Error('Product images changed since classification (byte digest mismatch). Please provide a better image or re-run classification.');
    }
  }
}

const now = () => new Date().toISOString();

export interface ApplyClassificationResult {
  changeSetId: string;
  appliedFields: string[];
  appliedPages: string[];
  /** Accepted reviewed removals applied in this draft (issue #353). */
  removedPages: string[];
  skipped: Array<{ proposalId: string; reason: string }>;
}

/**
 * Apply accepted classification proposals to an existing catalog product.
 *
 * 1. Re-reads the product and verifies source/config hashes match
 * 2. Creates an update change-set draft (never writes directly)
 * 3. Merges accepted field assignments into customFields (explicit reviewed
 *    null clears the slot; reviewed reduced arrays remove only named values)
 * 4. Adds accepted pages to ProductOnPages and removes accepted reviewed
 *    taxonomy-page removals (other pages — including Brand pages — survive)
 * 5. Returns change-set ID for the user to approve
 */
export async function applyCatalogClassification(
  workspacePath: string,
  workspaceId: string,
  sku: string,
  runId: string,
): Promise<ApplyClassificationResult> {
  const db = getDb();

  // Verify run
  const run = db.query(
    `SELECT id, status, source_kind, source_product_hash, config_snapshot_hash
     FROM classification_runs WHERE id = ?`,
  ).get(runId) as {
    id: string; status: string; source_kind: string;
    source_product_hash: string | null; config_snapshot_hash: string | null;
  } | undefined;

  if (!run) throw new Error(`Run ${runId} not found.`);
  if (run.source_kind !== 'catalog_product') throw new Error('Run is not a catalog product run.');
  if (run.status !== 'completed' && run.status !== 'completed_with_abstentions') {
    throw new Error(`Run status is "${run.status}". Cannot apply.`);
  }
  // A3: refuse pre-change visual runs at apply. Runs frozen before the
  // grounded-merge evidence contract carry an older evidence_extraction rule
  // version — reclassify instead of reinterpreting their frozen snapshots.
  // Text-only runs (no visual evidence) are unaffected.
  const visualCount = db.query(
    `SELECT COUNT(*) AS cnt FROM classification_evidence WHERE run_id = ? AND source = 'visual_product_evidence'`,
  ).get(runId) as { cnt: number };
  if ((visualCount?.cnt ?? 0) > 0) {
    const snapshotRow = run.config_snapshot_hash
      ? db.query(`SELECT snapshot_json FROM runtime_snapshots WHERE snapshot_hash = ?`).get(String(run.config_snapshot_hash)) as { snapshot_json: string | null } | undefined
      : undefined;
    let ruleVersion: string | null;
    try {
      const snapshot = snapshotRow?.snapshot_json ? JSON.parse(snapshotRow.snapshot_json) as { runtimeRuleVersions?: { evidence_extraction?: string } } : null;
      ruleVersion = snapshot?.runtimeRuleVersions?.evidence_extraction ?? null;
    } catch {
      ruleVersion = null;
    }
    if (ruleVersion !== 'evidence-extraction-rules-v3-grounded-merge') {
      throw new Error('Run uses a pre-A3 visual evidence contract; reclassify instead of reinterpreting its frozen snapshot.');
    }
  }

  const product = readProductFile(workspacePath, sku);
  if (!product) throw new Error(`Product not found for SKU: ${sku}`);

  // Source hash drift check — must use same hash function as classifier
  if (run.source_product_hash) {
    const currentHash = computeProductHash(product);
    if (currentHash !== run.source_product_hash) {
      throw new Error('Product has changed since classification. Please rerun classification.');
    }
  }

  // Config hash drift check — supports plain config hashes (legacy), the
  // active v2 bundle hash, and persisted runtime snapshot hashes; unknown
  // formats fail closed.
  if (run.config_snapshot_hash) {
    const storedHash = String(run.config_snapshot_hash);
    const authority = loadRuntimeConfigAuthority(workspacePath, createRuntimeActivationContext(workspacePath, workspaceId));
    const matches =
      authorityConfigHashMatches(authority, storedHash) ||
      runtimeSnapshotHashMatchesConfig(
        workspaceId,
        storedHash,
        authority.kind === 'v2' ? authority.bundle : authority.config,
      );
    if (!matches) {
      throw new Error('Classification config has changed since classification. Please rerun classification.');
    }
  }

  // Get accepted proposals
  const acceptedProposals = getAcceptedProposals(sku, runId);
  if (acceptedProposals.length === 0) {
    throw new Error('No accepted proposals to apply.');
  }

  // Issue #354 pre-draft page-authority recheck: when the run carries accepted
  // page proposals or removals, the frozen page import must still be active.
  // A rotated import means accepted page identities are stale authority —
  // fail attributably with no partial write instead of silently skipping or
  // (worse) applying colliding IDs from the new import.
  if (acceptedProposals.some(p => p.proposalType === 'category_page')) {
    const snapshotRow = run.config_snapshot_hash
      ? db.query(`SELECT config_json FROM classification_config_snapshots WHERE workspace_id = ? AND snapshot_hash = ?`).get(workspaceId, String(run.config_snapshot_hash)) as { config_json: string | null } | undefined
      : undefined;
    let frozenImportHash: string | null = null;
    try {
      const snap = snapshotRow?.config_json ? JSON.parse(snapshotRow.config_json) as { pageImportHash?: unknown } : null;
      if (snap && typeof snap.pageImportHash === 'string') frozenImportHash = snap.pageImportHash;
    } catch {
      frozenImportHash = null;
    }
    if (frozenImportHash) {
      const activeHash = getActivePageImportHash(workspaceId);
      if (activeHash !== frozenImportHash) {
        throw new Error('Page import has changed since classification (page_decision_stale). Re-resolve page assignments against the active verified import before applying.');
      }
    }
  }

  // A2: re-verify image byte identity for image-backed runs. The run's
  // evidence_extraction stage metadata carries per-image byte digests; the
  // current bytes behind the same refs are re-hashed and any change/absence
  // blocks the SKU (fresh run/review required). Title-only grounded values
  // proceed unaffected.
  await verifyRunImageBytesUnchanged(workspacePath, workspaceId, sku, runId, product);

  const mappings = getCachedAttributeMappings(workspaceId);
  // Issue #355: frozen mapping authority for the currency check below. Null
  // when the run has no resolvable snapshot (legacy passthrough — no
  // authority to compare, same as readiness).
  const frozenSnapshot = run.config_snapshot_hash
    ? getRuntimeSnapshotByHash(workspaceId, run.config_snapshot_hash)
    : null;
  const frozenMappings = frozenSnapshot?.attributeMappings ?? null;
  const appliedFields: string[] = [];
  const appliedPages: string[] = [];
  const skipped: Array<{ proposalId: string; reason: string }> = [];

  // Apply field assignments
  const mergedCustomFields = { ...(product.customFields || {}) };
  for (const proposal of acceptedProposals) {
    if (proposal.proposalType !== 'field_assignment') continue;
    // Effective reviewed target/value win over the immutable prediction.
    const targetId = getEffectiveProposalTargetId(proposal);
    if (!targetId) continue;
    // ADR 0041 / issue #349: classification application preserves existing
    // identity — protected targets (including protected revised targets)
    // never write. A revised/historical Brand proposal cannot authorize a
    // protected write; refuse attributably instead of applying it.
    if (isProtectedTargetId(targetId, mappings) || isProtectedTargetId(proposal.targetId, mappings)) {
      const refusal = protectedTargetRefusal(targetId ?? proposal.targetId);
      skipped.push({ proposalId: proposal.id, reason: `${refusal.code}: ${refusal.reason}` });
      continue;
    }

    const mapping = mappings.find(m => m.attributeId === targetId);
    if (!mapping) {
      skipped.push({ proposalId: proposal.id, reason: 'No attribute mapping found' });
      continue;
    }
    if (mapping.isStale) {
      skipped.push({ proposalId: proposal.id, reason: 'Attribute mapping is stale' });
      continue;
    }
    if (!mapping.catalogField) {
      skipped.push({ proposalId: proposal.id, reason: 'No catalog field in mapping' });
      continue;
    }
    // Issue #355: a semantic target cannot reroute into Brand, identity,
    // operational, or native fulfillment data through its mapping. The
    // resolved catalog field is checked — not just the attribute target —
    // so a mapping that points flavor (or any non-Brand attribute) at the
    // Brand slot or a native slot refuses attributably instead of writing.
    if (isProtectedCatalogField(mapping.catalogField, targetId, mappings)) {
      const refusal = protectedTargetRefusal(mapping.catalogField);
      skipped.push({ proposalId: proposal.id, reason: `${refusal.code}: ${refusal.reason}` });
      continue;
    }
    // Issue #355: the live mapping must still match the run's frozen mapping
    // authority — a re-pointed field or changed serialization since review
    // cannot replay a frozen accepted value into another field or format.
    // Mismatch refuses attributably with no write for that proposal.
    const frozenMapping = frozenMappings?.find(m => m.attributeId === targetId);
    if (frozenMappings && (!frozenMapping
      || frozenMapping.catalogField !== mapping.catalogField
      || deterministicStringify(frozenMapping.serialization ?? null) !== deterministicStringify(mapping.serialization ?? null))) {
      skipped.push({ proposalId: proposal.id, reason: 'Mapping changed since classification (mapping_changed). Re-review under the current mapping before applying.' });
      continue;
    }
    const effectiveValue = getEffectiveProposalValue(proposal);
    const value = serializeAttributeValue(effectiveValue, mapping.serialization);
    // P1 #9 apply-time no-narrowing: a PREDICTED single value can never
    // silently replace an existing multi-value slot (e.g. Salmon|Venison|Lamb
    // → Salmon) — skipped visibly. An EXPLICIT reviewed revised value is
    // human intent (issue #353 targeted multi-value removal), so it bypasses
    // the guard; an explicit null clears via the gate below.
    if (!proposal.hasRevisedValue && isSilentNarrowing(product.customFields?.[mapping.catalogField] ?? null, value)) {
      skipped.push({ proposalId: proposal.id, reason: 'No-narrowing guard: existing multi-value slot survives; intentional reduction needs a separate explicit edit' });
      continue;
    }
    if (value || (proposal.hasRevisedValue && effectiveValue === null)) {
      mergedCustomFields[mapping.catalogField] = value;
      appliedFields.push(mapping.catalogField);
    }
  }
  // Apply page assignments and reviewed removals. The identity of every
  // accepted page MUST be verified in the currently active import. Name-only
  // or out-of-import identities are skipped visibly and never serialized
  // into ProductOnPages. An accepted explicit removal (null target + null
  // value, issue #353) removes the PROPOSED page from the existing set while
  // preserving every other assignment — including Brand/non-taxonomy pages,
  // which are outside classifier ownership and never removal targets
  // (refused at review; defense-in-depth skips them here too).
  const verifiedPageIds = getActiveVerifiedPageIds(workspaceId);
  const additionalPages: string[] = [];
  const removedPages: string[] = [];
  for (const proposal of acceptedProposals) {
    if (proposal.proposalType !== 'category_page') continue;
    const targetId = getEffectiveProposalTargetId(proposal);
    const pv = getEffectiveProposalValue(proposal) as Record<string, unknown> | undefined;
    if (!targetId && pv == null && proposal.hasRevisedValue && proposal.hasRevisedTargetId) {
      // Reviewed removal: the PROPOSED (before) value names the assignment
      // to drop. Brand pages can never be removed — skip visibly.
      const beforeName = pageNameFromPageValue(proposal.proposedValue);
      if (!beforeName) {
        skipped.push({ proposalId: proposal.id, reason: 'Page removal names no existing assignment' });
        continue;
      }
      if (isBrandPageProposal(beforeName)) {
        const refusal = protectedTargetRefusal(proposal.targetId);
        skipped.push({ proposalId: proposal.id, reason: `${refusal.code}: ${refusal.reason}` });
        continue;
      }
      if (!removedPages.includes(beforeName)) removedPages.push(beforeName);
      continue;
    }
    if (!targetId) continue;
    // Display name comes from the value only — never the Page ID (the target
    // is the stable identity for new proposals).
    const pageName = pageNameFromPageValue(pv);
    const pageId = pv?.pageId ? String(pv.pageId) : null;
    if (!pageId || !verifiedPageIds.has(pageId)) {
      skipped.push({
        proposalId: proposal.id,
        reason: 'Page identity unverified (name-only or not in the active verified import)',
      });
      continue;
    }
    if (!pageName) {
      // A verified page without a display name is a visible skip; the Page ID
      // must never be serialized as a page name.
      skipped.push({ proposalId: proposal.id, reason: 'Page display name missing' });
      continue;
    }
    if (isBrandPageProposal(pageName)) {
      const refusal = protectedTargetRefusal(targetId);
      skipped.push({ proposalId: proposal.id, reason: `${refusal.code}: ${refusal.reason}` });
      continue;
    }
    if (!additionalPages.includes(pageName)) {
      additionalPages.push(pageName);
    }
  }

  // Merge into first-class core.productOnPages: accepted additions join,
  // accepted reviewed removals leave (only the named taxonomy assignment —
  // every other existing page survives, Brand pages included). Any stale
  // ProductOnPages fragment in preserved state is dropped — the codec
  // serializes core.productOnPages to DTD-compliant XML at export.
  const removedSet = new Set(removedPages);
  const mergedPages = [...(product.core.productOnPages ?? [])].filter(p => !removedSet.has(p));
  for (const pageName of additionalPages) {
    if (!mergedPages.includes(pageName)) mergedPages.push(pageName);
  }
  const remainingUnknownElements = { ...(product.shopsite?.preserved?.unknownElements ?? {}) };
  delete remainingUnknownElements['ProductOnPages'];

  // Build updated product
  const updatedProduct: Product = {
    ...product,
    core: {
      ...product.core,
      productOnPages: mergedPages,
    },
    customFields: mergedCustomFields,
    shopsite: {
      ...product.shopsite,
      preserved: {
        ...product.shopsite.preserved,
        unknownElements: remainingUnknownElements,
      },
    },
    metadata: {
      ...product.metadata,
      updatedAt: now(),
    },
  };

  // Create change set + item atomically (issue #354): a failure between the
  // two writes must never orphan an empty change set — either both persist
  // or neither does. All fallible validation already ran above; only
  // serialization (pure) and these two inserts remain.
  const workspace = findWorkspace();
  const baseCommit = workspace?.baselineCommit ?? 'unknown';
  const dateStr = new Date().toLocaleDateString();
  const draftJsonStr = deterministicStringify(updatedProduct);
  const draftHash = hashJson(updatedProduct);
  const baseJsonStr = deterministicStringify(product);
  const changeSet = db.transaction(() => {
    const created = createChangeSet({
      workspaceId,
      title: `Classification: ${sku} (${dateStr})`,
      description: `Applied accepted classification proposals for product ${sku}.`,
      baseCommit,
    });
    upsertChangeSetItem({
      changeSetId: created.id,
      sku,
      operation: 'update',
      draftJson: draftJsonStr,
      baseJson: baseJsonStr,
      draftHash,
      classificationRunId: runId,
    });
    return created;
  })();

  // Track applied page names for the result (page data is embedded in the
  // ProductOnPages draft — product_pages table is updated when the change
  // set is approved, not during draft creation). Removals are tracked
  // separately so review surfaces can distinguish them from additions.
  for (const pageName of additionalPages) {
    appliedPages.push(pageName);
  }
  const removedPageNames: string[] = [...removedPages];

  // Record history
  try {
    recordHistoryEvent(workspaceId, sku, 'classification_draft_created', {
      runId,
      changeSetId: changeSet.id,
      appliedFields,
      appliedPages,
      removedPages: removedPageNames,
      skippedCount: skipped.length,
    });
  } catch {
    // non-blocking
  }

  return { changeSetId: changeSet.id, appliedFields, appliedPages, removedPages: removedPageNames, skipped };
}
