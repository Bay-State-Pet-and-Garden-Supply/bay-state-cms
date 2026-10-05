/**
 * Representative Jev benchmark preparation (#302 steps 2/3).
 *
 * Default: dry-run validation only — no model calls, no DB/routing changes,
 * no writes. Explicit `--write --out <dir>` writes ONLY public
 * manifest/taxonomy/dev-input/support metadata; holdout labels never go to
 * git/shared indexes (custody commit-hashes + metadata only).
 *
 * Authority is DERIVED, never hardcoded: workspace id from the readonly DB
 * workspace row, release pin from store/classification/state.json, catalog
 * commit from `git rev-parse HEAD` in the workspace, config hash canonical
 * from the loaded authority bundle, pages from captureVerifiedPageSnapshot
 * over the SAME independent readonly driver. Never buildRuntimeSnapshot
 * (reads reviewed facts / VLM credentials). Never initDb (which enables
 * WAL); the global connection is never opened.
 *
 * Usage:
 *   bun scripts/prepare-jev-benchmark.ts --workspace <path> --db <path> [--inventory <export.json>] [--dataset <id>] [--write --out docs/audits/jev-representative-v1]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { loadRuntimeConfigAuthority } from '../src/classification/config-loader';
import { readWorkspaceState } from '../src/classification/workspace-state';
import { captureVerifiedPageSnapshot } from '../src/classification/page-snapshot';
import { getDatasetMetadataOnly } from '../src/db/repositories/benchmark-repo';
import { findWorkspaceIdReadonly } from '../src/db/repositories/workspace-repo';
import {
  assignFamilyManifest,
  buildDryRunSummary,
  buildWriteResult,
  capturePreparationAuthority,
  revalidatePreparationAuthority,
} from '../src/classification/jev-benchmark-preparation';
import { validateSourceCandidates } from '../src/classification/jev-benchmark-preparation';

const SPLIT_SEED = 42;
const HOLDOUT_PERCENT = 20;

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

function readCatalogCommit(workspacePath: string): string {
  let stdout: string;
  try {
    stdout = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspacePath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error(`unverifiable_catalog_commit: git rev-parse HEAD failed in ${workspacePath}`);
  }
  if (!/^[0-9a-f]{8,40}$/.test(stdout)) {
    throw new Error(`unverifiable_catalog_commit: unexpected HEAD "${stdout}"`);
  }
  return stdout;
}

async function main(): Promise<void> {
  const workspacePath = arg('--workspace');
  const dbPath = arg('--db');
  const inventoryPath = arg('--inventory');
  const write = flag('--write');
  const outDir = arg('--out');
  if (!workspacePath || !dbPath) {
    console.error('Usage: prepare-jev-benchmark.ts --workspace <path> --db <path> [--inventory <export.json>] [--dataset <id>] [--write --out <dir>]');
    process.exit(2);
  }
  if (write && !outDir) {
    console.error('Refusing to write: --write requires explicit --out <dir>.');
    process.exit(2);
  }

  // Independent readonly driver only — global initDb/getDb never touched.
  const readonlyDb = new Database(dbPath, { readonly: true });
  try {
    readonlyDb.exec('PRAGMA query_only = ON;');
    const workspaceId = findWorkspaceIdReadonly(readonlyDb);
    if (!workspaceId) throw new Error('unverifiable_workspace: readonly DB has no workspace row');

    const deps = {
      workspaceId,
      loadAuthority: () => loadRuntimeConfigAuthority(workspacePath),
      capturePages: (id: string) => captureVerifiedPageSnapshot(id, readonlyDb),
      readReleasePin: () => readWorkspaceState(workspacePath)?.activeTaxonomyRevision ?? null,
      readCatalogCommit: () => readCatalogCommit(workspacePath),
    };
    const view = capturePreparationAuthority(deps);
    revalidatePreparationAuthority(view, deps);

    const datasetId = arg('--dataset');
    if (datasetId) {
      const metadata = getDatasetMetadataOnly(readonlyDb, datasetId, workspaceId);
      if (!metadata) {
        console.warn(`[prepare] dataset "${datasetId}" not found in workspace "${workspaceId}" (metadata-only read).`);
      } else {
        console.log(`[prepare] dataset "${metadata.id}" status=${metadata.status} total=${metadata.total_examples} splits=${JSON.stringify(metadata.splitCounts)}`);
      }
    }

    const candidates = inventoryPath
      ? validateSourceCandidates(JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) as unknown[])
      : [];
    const manifest = assignFamilyManifest(candidates, { splitSeed: SPLIT_SEED, holdoutPercent: HOLDOUT_PERCENT });
    const authorityMeta = {
      release: view.binding.release,
      catalogGitCommit: view.binding.catalogGitCommit,
      configHash: view.binding.configHash,
      pageImportId: view.binding.pageImportId,
      pageImportHash: view.binding.pageImportHash,
      verifiedPages: view.counts.pages,
      productTypes: view.counts.productTypes,
      attributes: view.counts.attributes,
    };

    if (!write) {
      // Default dry-run validation: no writes, no models, no routing changes.
      const summary = buildDryRunSummary({ workspaceId, authority: view, candidates, manifest });
      console.log(JSON.stringify({ ...summary, ...authorityMeta }, null, 2));
      return;
    }

    // Explicit-output mode: public manifest/taxonomy/dev-inputs/support metadata ONLY.
    const resolved = path.resolve(outDir!);
    fs.mkdirSync(resolved, { recursive: true });
    const publicManifest = manifest.filter(e => e.splitGroup !== 'holdout');
    const outputs: Array<[string, string]> = [
      ['manifest.json', JSON.stringify({ authorityHash: view.authorityHash, binding: view.binding, entries: publicManifest }, null, 2)],
      ['taxonomy.json', JSON.stringify(view.payload, null, 2)],
      ['development.json', JSON.stringify({ devInputs: candidates.filter(c => publicManifest.some(m => m.sku === c.sku)) }, null, 2)],
    ];
    let filesWritten = 0;
    for (const [name, body] of outputs) {
      fs.writeFileSync(path.join(resolved, name), `${body}\n`);
      filesWritten++;
    }
    const result = buildWriteResult({ workspaceId, authority: view, candidates, manifest, filesWritten: filesWritten + 1, outDir: resolved });
    fs.writeFileSync(path.join(resolved, 'support.json'), `${JSON.stringify({ ...result, ...authorityMeta }, null, 2)}\n`);
    console.log(JSON.stringify({ ...result, ...authorityMeta }, null, 2));
    console.log(`[prepare] wrote ${result.filesWritten} public metadata files to ${resolved} (holdout labels excluded; db writes: 0)`);
  } finally {
    readonlyDb.close();
  }
}

main().catch(error => {
  console.error(`[prepare-jev-benchmark] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
