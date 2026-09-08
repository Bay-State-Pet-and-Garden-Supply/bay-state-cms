// Slice 0 — test-runner registration guard (council plan §6.1).
//
// Read-only: walks candidate test files plus the configured Vitest
// include/exclude membership and the package.json test:db command.
// Every candidate file with a Bun runtime dependency (direct
// `bun:test`/`bun:sqlite` import OR reviewed transitive-Bun manifest entry)
// must be BOTH excluded from Vitest AND named by a `bun test` invocation in
// test:db. Comment/textual-only mentions must carry an explicit reviewed
// manifest classification instead of being silently assumed safe.
//
// This module imports only node builtins (fs/path/os) — never application or
// DB modules — so it stays runnable in any environment with installed deps.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RunnerManifest {
  version: number;
  /** Files verified Vitest-safe despite a textual bun mention. value = reason. */
  vitestSafe: Record<string, string>;
  /** Files needing Bun registration via transitive imports. value = reason. */
  transitiveBun: Record<string, string>;
}

export interface GuardViolation {
  code:
    | 'missing-exclude'
    | 'missing-test-db'
    | 'unclassified-bun-mention'
    | 'stale-manifest'
    | 'duplicate-manifest'
    | 'broad-exclude'
    | 'missing-file'
    | 'stale-ledger';
  file: string;
  detail: string;
}

export interface BaselineLedger {
  version: number;
  entries: Array<{ file: string; code: string; area: string }>;
}

export interface GuardResult {
  violations: GuardViolation[];
  knownBaseline: GuardViolation[];
  checkedSuites: number;
  bunSuites: number;
}

const STATIC_BUN_RE =
  /(^|[\s;])(import\s[^;]*?from\s*['"]|require\(\s*['"])(bun:test|bun:sqlite)['"]/m;
const DYNAMIC_BUN_RE = /import\(\s*['"](bun:test|bun:sqlite)['"]\)/;
const TEXTUAL_BUN_RE = /bun:(test|sqlite)/;
const EXCLUDE_LITERAL_RE = /['"]([^'"]+\.test\.tsx?)['"]/g;

function stripComments(src: string): string {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlocks
    .split('\n')
    .map((line: string) => {
      const idx = line.indexOf('//');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
}

export function hasDirectBunImport(sourceText: string): boolean {
  const code = stripComments(sourceText);
  return STATIC_BUN_RE.test(code) || DYNAMIC_BUN_RE.test(code);
}

export function hasStaticBunImport(sourceText: string): boolean {
  return STATIC_BUN_RE.test(stripComments(sourceText));
}

export function hasTextualBunMention(sourceText: string): boolean {
  return TEXTUAL_BUN_RE.test(sourceText);
}

/** Collect candidate test files under the given repo root (sorted, repo-relative). */
export function scanCandidates(repoRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full);
      } else if (/\.test\.tsx?$/.test(entry.name)) {
        const rel = path.relative(repoRoot, full);
        if (rel.startsWith('src/')) out.push(rel);
      }
    }
  };
  walk(path.join(repoRoot, 'src'));
  return out.sort();
}

export function parseVitestExcludes(vitestConfigText: string): {
  excludes: Set<string>;
  broad: string[];
} {
  const excludes = new Set<string>();
  const broad: string[] = [];
  // Scope glob analysis to the `exclude` array only — never `include`.
  const excludeBlock = vitestConfigText.match(/exclude\s*:\s*\[([\s\S]*?)\]/);
  const scope = excludeBlock ? excludeBlock[1] : '';
  let m: RegExpExecArray | null;
  EXCLUDE_LITERAL_RE.lastIndex = 0;
  while ((m = EXCLUDE_LITERAL_RE.exec(scope)) !== null) {
    const lit = m[1];
    if (lit.includes('*')) {
      broad.push(lit);
      continue;
    }
    if (lit.startsWith('src/')) excludes.add(lit);
  }
  for (const g of scope.match(/['"]src\/[^'"]*\*[^'"]*['"]/g) ?? []) {
    if (!broad.includes(g.slice(1, -1))) broad.push(g.slice(1, -1));
  }
  return { excludes, broad };
}

export function stripShellComments(command: string): string {
  return command
    .split('\n')
    .map(line => {
      const idx = line.indexOf('#');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
}

export function readManifest(manifestPath: string): RunnerManifest {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw) as RunnerManifest;
}

/** Vitest `include` covers only src/tests/** — extraction-worker suites are never collected. */
export function isVitestCollectable(relPath: string): boolean {
  return relPath.startsWith('src/tests/');
}

export function checkTree(opts: {
  repoRoot: string;
  candidates: string[];
  readFile: (rel: string) => string;
  vitestExcludes: Set<string>;
  broadExcludes: string[];
  testDbCommand: string;
  manifest: RunnerManifest;
  manifestPath: string;
  baselineLedger?: BaselineLedger;
}): GuardResult {
  const violations: GuardViolation[] = [];
  const knownBaseline: GuardViolation[] = [];
  const ledger = opts.baselineLedger ?? { version: 1, entries: [] };
  const ledgerKeys = new Set(ledger.entries.map(e => `${e.file}::${e.code}`));
  const matchedLedger = new Set<string>();
  const report = (v: GuardViolation) => {
    // Documented-red baseline: ledgered (file, code) pairs are reported but
    // do not fail the gate. Anything absent from the ledger fails.
    if (
      v.code !== 'stale-ledger' &&
      v.code !== 'stale-manifest' &&
      v.code !== 'broad-exclude' &&
      v.code !== 'duplicate-manifest' &&
      v.code !== 'missing-file' &&
      ledgerKeys.has(`${v.file}::${v.code}`)
    ) {
      matchedLedger.add(`${v.file}::${v.code}`);
      knownBaseline.push(v);
    } else {
      violations.push(v);
    }
  };
  let bunSuites = 0;
  const seen = new Set<string>();

  for (const b of opts.broadExcludes) {
    report({
      code: 'broad-exclude',
      file: opts.manifestPath,
      detail: `broad Vitest exclude conceals new suites: ${b}`,
    });
  }

  const executableTestDb = stripShellComments(opts.testDbCommand);
  const manifestFiles = new Set([
    ...Object.keys(opts.manifest.vitestSafe),
    ...Object.keys(opts.manifest.transitiveBun),
  ]);
  for (const f of manifestFiles) {
    if (seen.has(f)) {
      report({ code: 'duplicate-manifest', file: f, detail: 'listed twice' });
    }
    seen.add(f);
  }
  for (const f of manifestFiles) {
    if (
      !opts.candidates.includes(f) &&
      !f.endsWith('.test.ts') &&
      !f.endsWith('.test.tsx')
    ) {
      report({ code: 'missing-file', file: f, detail: 'manifest entry is not a test file' });
    } else if (!opts.candidates.includes(f)) {
      report({
        code: 'stale-manifest',
        file: f,
        detail: 'manifest entry matches no candidate file (missing or renamed)',
      });
    }
  }

  for (const rel of opts.candidates) {
    const text = opts.readFile(rel);
    const direct = hasDirectBunImport(text);
    const textual = hasTextualBunMention(text);
    const inTransitive = Object.hasOwn(opts.manifest.transitiveBun, rel);
    const inSafe = Object.hasOwn(opts.manifest.vitestSafe, rel);
    if (!direct && !textual && !inTransitive && !inSafe) continue;
    if (inSafe) {
      // Reviewed Vitest-safe basis covers textual mentions and guarded
      // dynamic-only imports (verified collection). A newly added static bun
      // import breaks that basis and must be re-reviewed.
      if (hasStaticBunImport(text)) {
        report({
          code: 'stale-manifest',
          file: rel,
          detail: 'classified vitest-safe but now has a static bun import',
        });
      }
      continue;
    }
    const needsBun = direct || inTransitive;
    const bunRegistered =
      (!isVitestCollectable(rel) || opts.vitestExcludes.has(rel)) &&
      executableTestDb.includes(rel);
    if (!needsBun) {
      // Textual-only mention: harmless when the suite is already fully
      // Bun-registered (excluded + test:db); otherwise it needs an explicit
      // reviewed manifest classification instead of a silent assumption.
      if (!inSafe && !bunRegistered) {
        report({
          code: 'unclassified-bun-mention',
          file: rel,
          detail: 'textual bun mention without a reviewed manifest classification',
        });
      }
      continue;
    }
    bunSuites += 1;
    if (isVitestCollectable(rel) && !opts.vitestExcludes.has(rel)) {
      report({
        code: 'missing-exclude',
        file: rel,
        detail: 'Bun suite is collectable by Vitest but has no explicit vitest.config.ts exclude',
      });
    }
    if (!executableTestDb.includes(rel)) {
      report({
        code: 'missing-test-db',
        file: rel,
        detail: 'Bun suite is not named by any `bun test` invocation in package.json test:db',
      });
    }
  }
  for (const e of ledger.entries) {
    if (!matchedLedger.has(`${e.file}::${e.code}`)) {
      violations.push({
        code: 'stale-ledger',
        file: e.file,
        detail: `ledgered baseline violation no longer occurs (code ${e.code}) — remove this ledger entry, do not re-add`,
      });
    }
  }
  return { violations, knownBaseline, checkedSuites: opts.candidates.length, bunSuites };
}

function main(): number {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const manifestPath = 'src/tests/fixtures/test-runner-coverage/runner-manifest.json';
  const candidates = scanCandidates(repoRoot);
  const vitestConfigText = fs.readFileSync(path.join(repoRoot, 'vitest.config.ts'), 'utf8');
  const { excludes, broad } = parseVitestExcludes(vitestConfigText);
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const testDbCommand = pkg.scripts?.['test:db'] ?? '';
  const manifest = readManifest(path.join(repoRoot, manifestPath));
  const ledgerPath = 'src/tests/fixtures/test-runner-coverage/known-baseline-violations.json';
  const baselineLedger = JSON.parse(
    fs.readFileSync(path.join(repoRoot, ledgerPath), 'utf8'),
  ) as BaselineLedger;
  const result = checkTree({
    repoRoot,
    candidates,
    readFile: rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8'),
    vitestExcludes: excludes,
    broadExcludes: broad,
    testDbCommand,
    manifest,
    manifestPath,
    baselineLedger,
  });
  console.log(
    `test-runner-coverage: ${result.checkedSuites} suites scanned, ${result.bunSuites} Bun suites, ` +
      `${result.violations.length} new violation(s), ${result.knownBaseline.length} documented-baseline`,
  );
  for (const v of result.violations) {
    console.log(`  [${v.code}] ${v.file} — ${v.detail}`);
  }
  if (result.knownBaseline.length > 0) {
    console.log(`  documented baseline (${ledgerPath}):`);
    for (const v of result.knownBaseline) {
      console.log(`  [known:${v.code}] ${v.file}`);
    }
  }
  return result.violations.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(main());
}
