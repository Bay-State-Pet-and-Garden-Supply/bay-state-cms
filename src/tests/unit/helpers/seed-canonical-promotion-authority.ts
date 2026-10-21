import { generateCandidate } from '../../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../../classification/config-seeds/bay-state-pet-garden-v1';
import type { CatalogEvidence } from '../../../classification/catalog-evidence';
import { buildRuntimeSnapshot, persistRuntimeSnapshot } from '../../../classification/runtime-snapshot';
import { captureVerifiedPageSnapshot, toPageSnapshotState } from '../../../classification/page-snapshot';

import { hashCanonicalJson } from '../../../shared/stable-id';
import type { ClassificationConfigBundleV2 } from '../../../shared/schemas/classification';
import type { Database } from '../../../db/driver';
interface SeedCanonicalPromotionAuthorityOptions {
  db: Database;
  workspaceId: string;
  workspacePath: string;
  sku: string;
  runId: string;
  includePair?: boolean;
  requiredAttributeId?: string;
}

/** Persisted snapshot handle plus the frozen bundle for cache sync. */
export interface SeededCanonicalPromotionAuthority { id: string; hash: string; bundle: ClassificationConfigBundleV2 }
/** Seed explicit test-only website mappings and a frozen V2 authority snapshot for promotion tests. */
export function seedCanonicalPromotionAuthority({
  db,
  workspaceId,
  workspacePath,
  sku,
  runId,
  includePair = true,
  requiredAttributeId,
}: SeedCanonicalPromotionAuthorityOptions): SeededCanonicalPromotionAuthority {
  const now = new Date().toISOString();
  const websiteValues = new Map([
    ['dog-food-dry', { category: 'QA/test-only dog-food category', productType: 'QA/test-only dry dog food' }],
    ['dog-food-wet', { category: 'QA/test-only dog-food category', productType: 'QA/test-only wet dog food' }],
    ['cat-food-wet', { category: 'QA/test-only cat-food category', productType: 'QA/test-only wet cat food' }],
    ['bird-food', { category: 'QA/test-only bird category', productType: 'QA/test-only bird food' }],
  ]);
  const seed = {
    ...BayStatePetGardenSeed,
    revision: 'qa-promotion-authority',
    createdAt: '2026-10-16T00:00:00.000Z',
    profileTemplates: requiredAttributeId
      ? BayStatePetGardenSeed.profileTemplates.map(profile => profile.id === 'pet-food'
        ? {
          ...profile,
          attributes: profile.attributes.map(rule => rule.attributeId === requiredAttributeId
            ? { ...rule, required: true }
            : rule),
        }
        : profile)
      : BayStatePetGardenSeed.profileTemplates,
    productTypes: BayStatePetGardenSeed.productTypes.map(type => {
      const mappedValues = websiteValues.get(type.id);
      return mappedValues ? { ...type, websiteValues: mappedValues } : type;
    }),
    classificationOutputBindings: [
      { role: 'category' as const, catalogField: 'ProductField24', serialization: { kind: 'scalar' as const, prefix: '', suffix: '' }, isStale: false },
      { role: 'product-type' as const, catalogField: 'ProductField25', serialization: { kind: 'scalar' as const, prefix: '', suffix: '' }, isStale: false },
    ],
  };
  const evidence: CatalogEvidence = {
    schemaVersion: 1,
    sourceTreeHash: '0'.repeat(64),
    productFileCount: 0,
    parseFailureCount: 0,
    parseFailures: [],
    fieldRegistry: { entryCount: 0, xmlFields: [] },
    fields: [],
    pages: [],
  };
  const bundle = generateCandidate(seed, evidence).bundle;
  const pages = captureVerifiedPageSnapshot(workspaceId);
  const snapshot = buildRuntimeSnapshot({
    workspaceId,
    workspacePath,
    productSku: sku,
    authority: { kind: 'v2', bundle },
    configSnapshotRef: {
      id: `qa-config-${runId}`,
      hash: bundle.manifest.bundleHash,
      sourceCommit: null,
      createdAt: now,
    },
    sourceProductHash: null,
    pages: toPageSnapshotState(pages),
    pageImportId: pages.pageImportId,
    pageImportHash: pages.pageImportHash,
  });
  const persisted = persistRuntimeSnapshot(snapshot);
  db.run('UPDATE classification_runs SET config_snapshot_id = ?, config_snapshot_hash = ? WHERE id = ?', [persisted.id, persisted.hash, runId]);
  for (const binding of seed.classificationOutputBindings!) {
    db.run(
      `INSERT OR REPLACE INTO classification_output_bindings
       (workspace_id, role, catalog_field, serialization_json, is_stale, config_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
      [workspaceId, binding.role, binding.catalogField, JSON.stringify(binding.serialization), hashCanonicalJson(binding), now, now],
    );
  }

  if (includePair) {
    const pairProposalId = `pair-${runId}`;
    db.run(
      `INSERT OR IGNORE INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'product_classification', 'dog-food-dry', ?, 1.0, 'accepted', ?)`,
      [pairProposalId, runId, sku, JSON.stringify({ categoryId: 'dog-food', productTypeId: 'dog-food-dry' }), now],
    );
    db.run(
      `INSERT OR IGNORE INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_key, created_at)
       VALUES (?, ?, 'accepted', ?, ?)`,
      [`decision-${pairProposalId}`, pairProposalId, `decision-token-${pairProposalId}`, now],
    );
  }
  return { ...persisted, bundle };
}
