#!/usr/bin/env bun
/**
 * Slice 1 — read-only onboarding stage-vocabulary audit (council plan §6 Slice 1).
 *
 * Scans source files for pipeline-stage references, classifies each match, and
 * fails closed on anything unclassified. No DB/application imports (node
 * builtins only); never writes to the repo.
 *
 * Usage:
 *   bun scripts/audit-onboarding-stage-vocabulary.ts [--emit-manifest]
 *   bun scripts/audit-onboarding-stage-vocabulary.ts --check <inventory.md> [--residuals <residuals.json>]
 *
 * --check asserts:
 *   1. zero unclassified matches, and
 *   2. every file with operational matches is mentioned in <inventory.md>, or
 *      in REVIEWED_SLICE1_ADDITIONS (new Slice 1 files), or in
 *      REVIEWED_SEED_GAPS (Appendix-A files the Slice-0 seed table omits —
 *      reported distinctly for Slice 5a, never silently passed).
 *   3. every inventory-listed file still exists.
 *   4. every residuals entry still matches (stale), matches exactly what it
 *      claims (missing/overbroad/version-wrong all fail).
 *
 * Exit 0 = gate passes. Any failure prints classified findings to stderr.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// Stage word lists live in the regexes below (single source; do not duplicate).
type Classification =
  | 'operational-v1'
  | 'operational-v2'
  | 'historical-route-id'
  | 'test-literal'
  | 'fixture'
  | 'non-stage'
  | 'unclassified';

interface Finding {
  file: string;
  line: number;
  kind: string;
  snippet: string;
  classification: Classification;
}

/** In-code reviewed non-stage allowlist: [file suffix, line regex, reason].
 * A match is non-stage ONLY when its line matches the pair regex; any other
 * stage reference in the same file stays operational. Each entry cites the
 * inventory's "Known non-stage" section. */
const NON_STAGE_ALLOWLIST: Array<{ file: string; lineRe: string; reason: string }> = [
  {
    file: 'scripts/audit-onboarding-stage-vocabulary.ts',
    lineRe: '.',
    reason: 'Audit tool self-reference: its own word lists and regex sources',
  },
  {
    file: 'src/classification/cohort-product-type-resolver.ts',
    lineRe: 'extraction.*official_product_page|normalized.*extraction|frozen packaging',
    reason: 'Classification doc comments on evidence fields (inventory non-stage)',
  },
  {
    file: 'src/classification/confidence-calibrator.ts',
    lineRe: "ReviewTier|'abstain'|'review'|'auto'|abstain.*review",
    reason: 'ReviewTier values abstain/review/auto are proposal routing, not pipeline stages',
  },
  {
    file: 'src/classification/flags.ts',
    lineRe: 'claimItemsForProcessing|ownership flows',
    reason: 'Doc comment referencing another module API; no runtime stage decision here',
  },
  {
    file: 'src/classification/stages/evidence-extraction.ts',
    lineRe: 'spreadsheetIdentity|projection.*extraction',
    reason: 'Classification stage doc comment on evidence fields (inventory non-stage)',
  },
  {
    file: 'src/classification/runtime-snapshot.ts',
    lineRe: 'stage: entry\\.stage|entry\\.stage',
    reason: 'Classification recorded-snapshot stage transport (inventory non-stage)',
  },
  {
    file: 'src/client/components/AiComputePanel.tsx',
    lineRe: "id: '(discovery|curation)'|label.*(Discovery|Curation)|capability|workload|route",
    reason: 'Model-operation/capability routing values (inventory non-stage)',
  },
  {
    file: 'src/client/components/common/AiRouteSummary.tsx',
    lineRe: 'discovery|curation|WORKLOAD_KEYS|workloads|capability|workload|route|operation',
    reason: 'WORKLOAD_KEYS model-operation routing values only (inventory non-stage)',
  },
  {
    file: 'src/onboarding/product-curator.ts',
    lineRe: 'stage_\\$|stage_name|sr\\.stage',
    reason: 'Classification stage-result event names, not onboarding stages (inventory non-stage)',
  },
  {
    file: 'src/client/components/onboarding-settings/tabRegistry.ts',
    lineRe: "id: 'curation'|return 'curation'|tab",
    reason: 'Settings tab registry ids/defaults, not pipeline stages (inventory non-stage)',
  },
  {
    file: 'src/db/repositories/provider-connection-repo.ts',
    lineRe: 'WorkloadRoute|workload|getWorkloadRoute',
    reason: 'Provider workload-route values (inventory model-operation non-stage)',
  },
  {
    file: 'src/db/repositories/packaging-ocr-shadow-repo.ts',
    lineRe: 'stage_status|stage_reason|legacy_|stage_name',
    reason: 'OCR shadow own status columns (inventory non-stage)',
  },
  {
    file: 'src/db/classification-migration.sql',
    lineRe: 'stage_name|CHECK',
    reason: 'Classification stage-name DDL (inventory non-stage)',
  },
  {
    file: 'src/onboarding/llm-client.ts',
    lineRe: "workloadKeyForTask|'discovery'|'curation'|stageName",
    reason: 'LLM task-routing keys and call labels (inventory model-operation non-stage)',
  },
  {
    file: 'src/onboarding/packaging-ocr.ts',
    lineRe: 'stageName|auditCtx\\.stage',
    reason: 'OCR audit-context operation label, not onboarding stage (inventory non-stage)',
  },
  {
    file: 'src/onboarding/sourcing/html-scraper/session-runner.ts',
    lineRe: 'crawlee-storage|sourcing.*artifacts|artifacts.*sourcing',
    reason: 'Scraper storage directory name (inventory word collision)',
  },
  {
    file: 'src/shared/schemas/onboarding-review-queue.ts',
    lineRe: 'review|Review',
    reason: 'Review-queue contract words; ReviewState is distinct from pipeline stages',
  },
  {
    file: 'src/client/components/onboarding/processing/processing-logic.ts',
    lineRe: 'ACTIVITY_ORDER|WorkActivity|activity',
    reason: 'WorkActivity values/order, not STAGE_ORDER (inventory non-stage)',
  },
  {
    file: 'src/client/components/onboarding/processing/ProcessingStatus.tsx',
    lineRe: 'ACTIVITY_ORDER|WorkActivity|activity',
    reason: 'WorkActivity values/order, not STAGE_ORDER (inventory non-stage)',
  },
  {
    file: 'src/classification/',
    lineRe: 'model-operation|snapshot|packaging_ocr|value-gap|effective-curation|evidence-targeting|page-coordinator|runtime-snapshot|confidence-calibrator|cohort-page',
    reason: 'Classification-internal stage/operation names (inventory non-stage)',
  },
  {
    file: 'src/onboarding/packaging-ocr.ts',
    lineRe: 'packaging_ocr|ocr|stage_name',
    reason: 'Packaging-OCR operation names, not onboarding stages (inventory non-stage)',
  },
  {
    file: 'src/onboarding/cloud-vlm-client.ts',
    lineRe: 'packaging_ocr|stage',
    reason: 'VLM operation names, not onboarding stages (inventory non-stage)',
  },
  {
    file: 'src/db/repositories/packaging-ocr-shadow-repo.ts',
    lineRe: 'packaging_ocr|stage_name',
    reason: 'OCR shadow names, not onboarding stages (inventory non-stage)',
  },
  {
    file: 'src/db/repositories/classification-model-call-repo.ts',
    lineRe: 'stage',
    reason: 'Model-call stage names, not onboarding stages (inventory non-stage)',
  },
  {
    file: 'src/client/App.tsx',
    lineRe: 'tab|route|view|navigation|settings',
    reason: 'Review navigation words (inventory non-stage)',
  },
  {
    file: 'src/client/components/OnboardingSettings.tsx',
    lineRe: 'tab|route|view|navigation|registry',
    reason: 'Review navigation words (inventory non-stage)',
  },
  {
    file: 'src/client/components/onboarding-settings/tabRegistry.ts',
    lineRe: 'tab|route|view|navigation',
    reason: 'Review navigation words (inventory non-stage)',
  },
  {
    file: 'src/onboarding/sourcing/html-scraper/session-runner.ts',
    lineRe: 'stage|phase|step',
    reason: 'Scraper-internal step words (inventory non-stage word collision)',
  },
  {
    file: 'scripts/build-page-role-proposals.ts',
    lineRe: 'stage|phase|role',
    reason: 'Proposal-script words (inventory non-stage word collision)',
  },
];

/** New Slice 1 files with operational v2 references (plan §6 Slice 1). Each
 * entry cites the deliverable; Slice 5a folds these into the full manifest. */
const REVIEWED_SLICE1_ADDITIONS: Array<{ file: string; reason: string }> = [
  { file: 'src/shared/onboarding-stage-vocabulary.ts', reason: 'Slice 1 canonical v2 authority (bijective v1↔v2)' },
  { file: 'src/shared/schemas/onboarding-stage-read.ts', reason: 'Slice 1 v2 read contracts (stage/status filters, cursor v3)' },
  { file: 'src/shared/schemas/onboarding.ts', reason: 'Slice 1 legacy-vs-proposed export alias (no runtime cutover)' },
  { file: 'src/db/repositories/onboarding-item-repo.ts', reason: 'Slice 1 additive stage/status chunk reader + chunk hydration' },
  { file: 'src/db/repositories/onboarding-acceptance-repo.ts', reason: 'Slice 1 chunk bulk acceptance hydration' },
  { file: 'src/db/repositories/onboarding-stage-read-repo.ts', reason: 'Slice 1 tracked v2 loaders + statement budget' },
  { file: 'src/onboarding/onboarding-stage-read.ts', reason: 'Slice 1 v2 read service (frozen v1 evaluators reused)' },
  { file: 'src/onboarding/onboarding-work-state.ts', reason: 'Slice 1 matchesFilters export (no behavior change)' },
  { file: 'src/server/routes/onboarding-stage-read-routes.ts', reason: 'Slice 1 dedicated v2 read routes' },
  { file: 'src/server/app.ts', reason: 'Slice 1 v2 route mount' },
  { file: 'src/client/onboarding-stage-api.ts', reason: 'Slice 1 v2 typed fetch client' },
  { file: 'scripts/audit-onboarding-stage-vocabulary.ts', reason: 'Slice 1 audit tool itself (v2 word lists)' },
];

/** Appendix-A files with operational matches that the Slice-0 seed table
 * omits. Reported distinctly as seed-gaps for Slice 5a; never silently passed. */
const REVIEWED_SEED_GAPS: Array<{ file: string; reason: string }> = [
  { file: 'src/client/components/WeeklyReportPanel.tsx', reason: 'Appendix A: stage distribution order (seed table omits)' },
  { file: 'src/client/components/onboarding/families/FamilyInspectorDrawer.tsx', reason: 'Appendix A: incoming stage display (seed table omits)' },
  { file: 'src/server/services/store-manager-trigger-service.ts', reason: 'Appendix A: semantic stage comparisons (seed table omits)' },
  { file: 'src/client/components/onboarding/BatchWorkspace.tsx', reason: 'Pre-existing stage diagnostics display; freeze boundary (Slice 2), seed table omits' },
  { file: 'src/client/components/onboarding/batch-workspace-logic.ts', reason: 'Pre-existing tab/stage mapping; freeze boundary (Slice 2), seed table omits' },
  { file: 'src/client/components/onboarding/processing/ProcessingStatus.tsx', reason: 'Pre-existing stage diagnostics display; freeze boundary (Slice 2), seed table omits' },
  { file: 'src/client/components/onboarding/processing/processing-logic.ts', reason: 'Pre-existing activity/stage display mapping; freeze boundary (Slice 2), seed table omits' },
];

const SCAN_ROOTS = ['src', 'scripts'];
const SCAN_EXTS = new Set(['.ts', '.tsx', '.sql']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

// Quoted literals only (single/double quotes). Backtick TEMPLATE prose is NOT
// matched: log/error strings like `Rendered extraction failed: ${e}` carry
// bare words, not stage identifiers. Quoted literals inside templates ARE
// matched by the quote patterns below. SQL value interpolation without quotes
// is out of contract (this repo binds all values); computed `stage_${...}`
// construction is caught by DYNAMIC_STAGE_RE and fails closed.
const QUOTED_V1_RE = /('|")(sourcing|discovery|extraction|curation|review|promotion)\1/g;
const QUOTED_V2_RE = /('|")(route_sources|find_product_page|collect_details|prepare_listing|review_listings|create_drafts)\1/g;
const STAGE_ACCESS_RE = /([.]stage\b|\[['"]stage['"]\]|\bstage_status\b|\bSTAGES\b|\bstage_distribution\b|\bSTAGE_ORDER\b|\bstage:\s*['"]|\bDEFAULT\s+['"](sourcing|discovery|extraction|curation|review|promotion)['"]|\bCHECK\b[^\n]*stage)/;
const DYNAMIC_STAGE_RE = /(['"`]stage_['"]?\s*\+|stage_[$][{]|computed-key|dynamic.*stage|stage.*dynamic)/i;
const ROUTE_ID_RE = /\b[a-z_]+_to_(discovery|extraction|curation|review|promotion)\b/;

export function isTestPath(file: string): boolean {
  return /(^|\/)tests\//.test(file) || /\.test\.(ts|tsx)$/.test(file) || /\/helpers\/seed-[^/]+$/.test(file);
}

export function classifyLine(file: string, line: string): { kind: string; classification: Classification } | null {
  // Comments still count when they carry quoted stage literals: they often
  // mark authority claims. Classify by content below (no early return).
  if (ROUTE_ID_RE.test(line)) return { kind: 'route-id', classification: 'historical-route-id' };
  const testPath = isTestPath(file);
  if (file.endsWith('.fixture') || file.includes('/fixtures/onboarding-stage-audit/')) {
    // Synthetic audit inputs: dynamic construction still fails closed here
    // (fixtures are audit data, not application tests).
    if (DYNAMIC_STAGE_RE.test(line)) return { kind: 'dynamic-construction', classification: 'unclassified' };
    QUOTED_V1_RE.lastIndex = 0;
    QUOTED_V2_RE.lastIndex = 0;
    const hit = QUOTED_V1_RE.test(line) || QUOTED_V2_RE.test(line) || STAGE_ACCESS_RE.test(line);
    QUOTED_V1_RE.lastIndex = 0;
    QUOTED_V2_RE.lastIndex = 0;
    if (hit) return { kind: 'synthetic-fixture', classification: 'fixture' };
    return null;
  }
  QUOTED_V2_RE.lastIndex = 0;
  const hasV2 = QUOTED_V2_RE.test(line);
  QUOTED_V2_RE.lastIndex = 0;
  QUOTED_V1_RE.lastIndex = 0;
  const hasV1 = QUOTED_V1_RE.test(line);
  QUOTED_V1_RE.lastIndex = 0;
  const allowlistedNonStage = (): boolean => {
    for (const entry of NON_STAGE_ALLOWLIST) {
      if (file.endsWith(entry.file) || (entry.file.endsWith('/') && file.includes(entry.file))) {
        if (new RegExp(entry.lineRe, 'i').test(line)) return true;
      }
    }
    return false;
  };
  if (hasV2) {
    if (testPath) return { kind: 'test-literal', classification: 'test-literal' };
    return { kind: 'v2-literal', classification: 'operational-v2' };
  }
  // Dynamic computed construction fails closed. Allowlisted non-stage
  // contexts (e.g. this audit tool's own pattern sources) still pass.
  if (DYNAMIC_STAGE_RE.test(line) && !testPath) {
    for (const entry of NON_STAGE_ALLOWLIST) {
      if (file.endsWith(entry.file) || (entry.file.endsWith('/') && file.includes(entry.file))) {
        if (new RegExp(entry.lineRe, 'i').test(line)) return { kind: 'non-stage', classification: 'non-stage' };
      }
    }
    return { kind: 'dynamic-construction', classification: 'unclassified' };
  }
  if (hasV1) {
    // Quoted v1 literal: test paths are versioned fixtures; everything else
    // is operational unless an allowlisted non-stage context matches this line.
    if (testPath) return { kind: 'test-literal', classification: 'test-literal' };
    if (allowlistedNonStage()) return { kind: 'non-stage', classification: 'non-stage' };
    return { kind: 'v1-literal', classification: 'operational-v1' };
  }
  if (STAGE_ACCESS_RE.test(line)) {
    if (testPath) return { kind: 'test-literal', classification: 'test-literal' };
    if (allowlistedNonStage()) return { kind: 'non-stage', classification: 'non-stage' };
    return { kind: 'stage-access', classification: 'operational-v1' };
  }
  return null;
}

export function scanTree(root: string): Finding[] {
  const findings: Finding[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    entries.sort();
    for (const name of entries) {
      const full = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        walk(full);
        continue;
      }
      const ext = path.extname(name);
      if (!SCAN_EXTS.has(ext) && !full.endsWith('.fixture')) continue;
      let content: string;
      try {
        content = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const rel = path.relative(root, full);
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        const hit = classifyLine(rel, line);
        if (hit) {
          findings.push({
            file: rel,
            line: idx + 1,
            kind: hit.kind,
            snippet: line.trim().slice(0, 160),
            classification: hit.classification,
          });
        }
      });
    }
  };
  for (const scanRoot of SCAN_ROOTS) {
    const abs = path.join(root, scanRoot);
    if (fs.existsSync(abs)) walk(abs);
  }
  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return findings;
}

interface ResidualEntry {
  file: string;
  pattern: string;
  reason: string;
  version: number;
}

function loadResiduals(residualsPath: string): ResidualEntry[] {
  const raw = fs.readFileSync(residualsPath, 'utf8');
  const parsed = JSON.parse(raw) as { version: number; entries: ResidualEntry[] };
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error(`Unsupported residuals manifest version in ${residualsPath}`);
  }
  return parsed.entries;
}

function parseInventoryFiles(inventoryPath: string): Set<string> {
  // Only markdown table first-cell paths count (prose backticks grant nothing).
  const content = fs.readFileSync(inventoryPath, 'utf8');
  const files = new Set<string>();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    const firstCell = line.split('|')[1] ?? '';
    // All backticked paths in the cell; bare filenames inherit the row's directory.
    const candidates: string[] = [];
    const re = /`([^`]+)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(firstCell)) !== null) candidates.push(m[1].split(/\s/)[0].replace(/[:~].*$/, ''));
    const anchor = candidates.find(c => /^(src|scripts)\//.test(c));
    const dir = anchor ? anchor.slice(0, anchor.lastIndexOf('/') + 1) : null;
    for (const candidate of candidates) {
      if (/^(src|scripts)\//.test(candidate)) {
        files.add(candidate);
      } else if (dir && /^[^`]*\.(ts|tsx|sql)$/.test(candidate) && !candidate.startsWith('/')) {
        // Bare relative paths inherit the row directory, collapsing a
        // repeated leading segment (e.g. `sourcing/x` under `src/.../sourcing/`).
        const dirSegs = dir.split('/').filter(Boolean);
        const first = candidate.split('/')[0];
        const base = dirSegs.length > 0 && dirSegs[dirSegs.length - 1] === first
          ? `${dirSegs.slice(0, -1).join('/')}/`
          : dir;
        files.add(`${base}${candidate}`);
      }
    }
  }
  return files;
}

export interface CheckResult {
  unclassified: Finding[];
  unlistedOperational: string[];
  missingInventoryFiles: string[];
  staleResiduals: string[];
  seedGapsUsed: string[];
  operationalFileCount: number;
}

export function checkTree(
  root: string,
  inventoryPath?: string,
  residualsPath?: string,
): CheckResult & { findings: Finding[] } {
  const findings = scanTree(root);
  const unclassified = findings.filter(f => f.classification === 'unclassified');

  const operationalFiles = new Set(
    findings.filter(f => f.classification === 'operational-v1' || f.classification === 'operational-v2').map(f => f.file),
  );

  const listed = inventoryPath ? parseInventoryFiles(inventoryPath) : new Set<string>();
  const slice1 = new Set(REVIEWED_SLICE1_ADDITIONS.map(e => e.file));
  const seedGaps = new Set(REVIEWED_SEED_GAPS.map(e => e.file));
  const seedGapsUsed: string[] = [];

  // Residuals: each entry must match ≥1 finding (stale fails), must not match
  // findings outside its file (overbroad fails), excused findings are removed.
  const excused = new Set<Finding>();
  const staleResiduals: string[] = [];
  if (residualsPath) {
    const entries = loadResiduals(residualsPath);
    for (const entry of entries) {
      if (entry.version !== 1) {
        staleResiduals.push(`${entry.file}::${entry.pattern} (version-wrong: ${entry.version})`);
        continue;
      }
      const re = new RegExp(entry.pattern);
      const hits = findings.filter(f => f.file === entry.file && re.test(`${f.line}:${f.snippet}`));
      if (hits.length === 0) {
        staleResiduals.push(`${entry.file}::${entry.pattern} (stale: matches nothing)`);
        continue;
      }
      const outside = findings.filter(f => f.file !== entry.file && re.test(`${f.line}:${f.snippet}`));
      if (outside.length > 0) {
        staleResiduals.push(`${entry.file}::${entry.pattern} (overbroad: also matches ${outside[0].file})`);
        continue;
      }
      if (!listed.has(entry.file) && !slice1.has(entry.file) && !seedGaps.has(entry.file)) {
        staleResiduals.push(`${entry.file}::${entry.pattern} (missing: file not inventoried)`);
        continue;
      }
      hits.forEach(h => excused.add(h));
    }
  }

  // Excused residual findings do not count toward operational coverage.
  const excusedFiles = new Set<string>();
  for (const f of findings) {
    if (excused.has(f) && (f.classification === 'operational-v1' || f.classification === 'operational-v2')) {
      const remaining = findings.some(o => !excused.has(o) && o.file === f.file && (o.classification === 'operational-v1' || o.classification === 'operational-v2'));
      if (!remaining) excusedFiles.add(f.file);
    }
  }
  const unlistedOperational: string[] = [];
  for (const file of [...operationalFiles].sort()) {
    if (excusedFiles.has(file)) continue;
    if (listed.has(file) || slice1.has(file)) continue;
    if (seedGaps.has(file)) {
      seedGapsUsed.push(file);
      continue;
    }
    // Directory-prefix coverage: inventory may list `src/client/` style dirs.
    const dirCovered = [...listed].some(l => l.endsWith('/') && file.startsWith(l));
    if (!dirCovered) unlistedOperational.push(file);
  }

  const missingInventoryFiles = inventoryPath
    ? [...listed]
        .filter(f => !f.endsWith('/') && /\.(ts|tsx|sql)$/.test(f))
        .filter(f => !fs.existsSync(path.join(root, f)))
    : [];

  return {
    findings: findings.filter(f => !excused.has(f)),
    unclassified: unclassified.filter(f => !excused.has(f)),
    unlistedOperational,
    missingInventoryFiles,
    staleResiduals,
    seedGapsUsed,
    operationalFileCount: operationalFiles.size,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const root = process.cwd();
  if (args.includes('--emit-manifest')) {
    const findings = scanTree(root);
    for (const f of findings) {
      console.log(`${f.file}:${f.line} [${f.kind}/${f.classification}] ${f.snippet}`);
    }
    return;
  }
  const checkIdx = args.indexOf('--check');
  if (checkIdx === -1) {
    console.error('Usage: audit-onboarding-stage-vocabulary.ts [--emit-manifest | --check <inventory.md> [--residuals <residuals.json>]]');
    process.exit(2);
  }
  const inventoryPath = args[checkIdx + 1];
  if (!inventoryPath) {
    console.error('Missing inventory path after --check');
    process.exit(2);
  }
  const resIdx = args.indexOf('--residuals');
  const residualsPath = resIdx === -1 ? undefined : args[resIdx + 1];
  if (resIdx !== -1 && !residualsPath) {
    console.error('Missing residuals path after --residuals');
    process.exit(2);
  }
  const result = checkTree(root, path.resolve(inventoryPath), residualsPath ? path.resolve(residualsPath) : undefined);
  let failed = false;
  if (result.unclassified.length > 0) {
    failed = true;
    console.error(`UNCLASSIFIED (${result.unclassified.length}):`);
    for (const f of result.unclassified) console.error(`  ${f.file}:${f.line} [${f.kind}] ${f.snippet}`);
  }
  if (result.unlistedOperational.length > 0) {
    failed = true;
    console.error(`UNLISTED OPERATIONAL FILES (${result.unlistedOperational.length}):`);
    for (const f of result.unlistedOperational) console.error(`  ${f}`);
  }
  if (result.missingInventoryFiles.length > 0) {
    failed = true;
    console.error(`MISSING INVENTORY FILES (${result.missingInventoryFiles.length}):`);
    for (const f of result.missingInventoryFiles) console.error(`  ${f}`);
  }
  if (result.staleResiduals.length > 0) {
    failed = true;
    console.error(`STALE RESIDUALS (${result.staleResiduals.length}):`);
    for (const s of result.staleResiduals) console.error(`  ${s}`);
  }
  if (result.seedGapsUsed.length > 0) {
    console.log(`Seed gaps exercised (Slice 5a must fold into manifest): ${result.seedGapsUsed.join(', ')}`);
  }
  console.log(
    `Audit: ${result.findings.length} findings, ${result.operationalFileCount} operational files, ` +
      `${failed ? 'GATE FAILED' : 'GATE PASSED'}`,
  );
  process.exit(failed ? 1 : 0);
}

// Importing this module must not execute the CLI (self-test imports it).
if (import.meta.main) {
  main();
}
