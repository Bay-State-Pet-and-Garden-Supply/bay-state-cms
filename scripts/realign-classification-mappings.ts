#!/usr/bin/env bun
/**
 * Realign the ACTIVE classification bundle's ShopSite field mappings to the
 * verified live Extra Fields configuration (fields 16–32), driven by the
 * reviewed seed.
 *
 * One-off maintenance script (the reviewed_generation path): it regenerates
 * a candidate from `bay-state-pet-garden-v1.ts` plus the committed
 * catalog-evidence artifact, stages it via `previewCandidate`, and
 * compare-and-swaps it into place with `activateBundle` — preserving the
 * active sourceCatalogCommit / catalogEvidenceHash binding and committing
 * only `store/classification/**`.
 *
 * Usage:
 *   bun run scripts/realign-classification-mappings.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { initDb, closeDb } from '../src/db/connection';
import { runMigrations } from '../src/db/migrations';
import { findWorkspace } from '../src/db/repositories/workspace-repo';
import { BayStatePetGardenSeed } from '../src/classification/config-seeds/bay-state-pet-garden-v1';
import { generateCandidate } from '../src/classification/config-generator';
import {
  activateBundle,
  getActiveHash,
  previewCandidate,
} from '../src/classification/config-store';
import {
  createRuntimeActivationContext,
  loadRuntimeConfigAuthority,
} from '../src/classification/config-loader';
import { sha256Hex } from '../src/shared/stable-id';
import type { CatalogEvidence } from '../src/classification/catalog-evidence';
import { listRegistry, upsertRegistryEntry } from '../src/db/repositories/field-registry-repo';

/**
 * ShopSite Extra Fields names (PF16–PF32 CERTIFIED against the authenticated
 * Extra Fields screenshot, 2026-10-15 — see
 * docs/audits/extra-fields-certification-2026-10-15.md; PF1–PF15 uncertified).
 */
const SHOP_SITE_FIELD_LABELS: Record<string, string> = {
  ProductField16: 'Facet - Brand',
  ProductField17: 'Facet - Pet Type',
  ProductField18: 'Facet - Lifestage',
  ProductField19: 'Facet - Pet Size',
  ProductField20: 'Facet - Special Diet',
  ProductField21: 'Facet - Health Feature',
  ProductField22: 'Facet - Food Form',
  ProductField23: 'Facet - Flavor',
  ProductField24: 'Facet - Category',
  ProductField25: 'Facet - Product Type',
  ProductField26: 'Facet - Product Feature',
  ProductField27: 'Facet - Size',
  ProductField28: 'Facet - Material',
  ProductField29: 'Facet - Color',
  ProductField30: 'Facet - Packaging Type',
  ProductField31: 'Product Category',
  ProductField32: 'Product Cross Sell',
};

function fail(message: string): never {
  console.error(`realign-classification-mappings: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const storageRoot = process.env.BAYSTATE_STORAGE_ROOT ?? path.resolve('storage');
  const dbPath = path.join(storageRoot, 'catalog', '.shopsite-cms', 'app.db');
  if (!fs.existsSync(dbPath)) {
    fail(`Database not found at ${dbPath}`);
  }
  initDb(dbPath);
  runMigrations();

  const ws = findWorkspace();
  if (!ws) fail('No workspace row found in the database.');
  const workspacePath = ws.workspacePath;

  // ── Require an ACTIVE v2 bundle ──────────────────────────────────────────
  let active: ReturnType<typeof loadRuntimeConfigAuthority>;
  try {
    active = loadRuntimeConfigAuthority(workspacePath, createRuntimeActivationContext(workspacePath, ws.id));
  } catch (error) {
    fail(`Unable to load the active classification configuration: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (active.kind !== 'v2') {
    fail('The active classification configuration is not a v2 bundle; nothing to realign.');
  }
  const bundle = active.bundle;
  const activeHash = getActiveHash(workspacePath);

  // ── Load the committed catalog-evidence artifact ─────────────────────────
  const evidencePath = path.join(workspacePath, 'store', 'classification', 'catalog-evidence.json');
  let artifact: string;
  try {
    artifact = fs.readFileSync(evidencePath, 'utf-8');
  } catch (error) {
    fail(`Catalog evidence artifact is missing at ${evidencePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let evidence: CatalogEvidence;
  try {
    evidence = JSON.parse(artifact) as CatalogEvidence;
  } catch (error) {
    fail(`Catalog evidence artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const evidenceHash = sha256Hex(artifact);

  // ── Show what is about to change ─────────────────────────────────────────
  const oldByAttr = new Map(bundle.attributeMappings.map(mapping => [mapping.attributeId, mapping.catalogField]));
  const newByAttr = new Map(
    BayStatePetGardenSeed.mappings.map(mapping => [mapping.attributeId, mapping.catalogField]),
  );
  console.log('Planned mapping changes (seed vs active):');
  for (const [attributeId, field] of newByAttr) {
    const prior = oldByAttr.get(attributeId);
    if (prior !== field) {
      console.log(`  ${attributeId}: ${prior ?? '<none>'} → ${field}`);
    }
  }
  for (const [attributeId] of oldByAttr) {
    if (!newByAttr.has(attributeId)) {
      console.log(`  ${attributeId}: ${oldByAttr.get(attributeId)} → <removed>`);
    }
  }

  // ── Generate, stage, activate ────────────────────────────────────────────
  const candidate = generateCandidate(BayStatePetGardenSeed, evidence);
  for (const finding of candidate.findings) {
    console.warn(`  finding [${finding.severity}] ${finding.code}: ${finding.message}`);
  }

  const preview = previewCandidate(candidate.bundle, workspacePath, { catalogEvidence: artifact });
  if (!preview.hash) {
    fail(`Preview rejected the realigned bundle:\n${preview.report.findings.map(f => `  [${f.severity}] ${f.code} ${f.message}`).join('\n')}`);
  }

  // Sync ShopSite-side field names into the field registry BEFORE activation
  // so a no-op re-run (identical bundle → nothing staged) still converges the
  // labels.
  const registry = listRegistry(ws.id);
  let labelsUpdated = 0;
  const now = new Date().toISOString();
  for (const [xmlField, label] of Object.entries(SHOP_SITE_FIELD_LABELS)) {
    const existing = registry.find(entry => entry.xmlField === xmlField);
    if (existing?.label === label) continue;
    upsertRegistryEntry({
      id: existing?.id ?? crypto.randomUUID(),
      workspaceId: ws.id,
      xmlField,
      label,
      kind: existing?.kind ?? 'custom',
      dataType: existing?.dataType ?? 'string',
      editable: existing?.editable ?? true,
      required: existing?.required ?? false,
      uiGroup: existing?.uiGroup ?? null,
      sampleValuesJson: existing?.sampleValuesJson ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    labelsUpdated += 1;
  }
  console.log(`Field registry labels updated: ${labelsUpdated}`);

  const result = await activateBundle(preview.hash, activeHash, {
    workspacePath,
    workspaceId: ws.id,
    activationContext: createRuntimeActivationContext(workspacePath, ws.id),
    sourceCatalogCommit: bundle.manifest.sourceCatalogCommit ?? undefined,
    catalogEvidenceHash: bundle.manifest.catalogEvidenceHash ?? evidenceHash,
    activeRevision: 'bay-state-v2',
    gitMessage: 'Realign ShopSite field mappings to the verified Extra Fields configuration',
  });

  console.log(`\nActivated bundle ${result.hash} (snapshot ${result.snapshotId})`);
  console.log(`Git commit: ${result.commitHash ?? '<none>'}`);
  console.log('Active mappings now:');
  for (const mapping of candidate.bundle.attributeMappings) {
    console.log(`  ${mapping.catalogField} ← ${mapping.attributeId}`);
  }
}

main()
  .catch(error => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => closeDb());
