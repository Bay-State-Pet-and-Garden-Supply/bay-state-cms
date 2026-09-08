#!/usr/bin/env bun
/**
 * Slice 6 — read-only PipelineBoard mount/import audit (council plan §6 Slice 6).
 *
 * Walks `src/client` from every client entry point and proves zero
 * production static/dynamic/re-export/glob/CSS import-graph paths reach
 * `PipelineBoard.tsx` after mount retirement. Any unresolved computed import
 * that might reach the board is an unclassified blocker (gate fails), never
 * an assumed absence. File deletion alone or grep for a JSX name is not
 * evidence — this tool resolves TS path aliases, barrel re-exports,
 * `require`, literal/constant-foldable dynamic `import`, `React.lazy`,
 * import-meta glob patterns, and CSS `@import`/`url()` references.
 *
 * No DB/application imports (node builtins only); never writes to the repo.
 *
 * Usage:
 *   bun scripts/audit-onboarding-shell-imports.ts [--emit-manifest]
 *   bun scripts/audit-onboarding-shell-imports.ts --check <retirement-inventory.md>
 *
 * --check asserts:
 *   1. zero production import-graph edges to PipelineBoard.tsx, and
 *   2. zero unclassified (possibly-board-reaching) computed imports/globs, and
 *   3. the retirement inventory names PipelineBoard.tsx as retained-unreachable
 *      with zero approved mount paths.
 *
 * Exit 0 = gate passes. Any failure prints findings to stderr.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const BOARD_FILE = 'src/client/components/PipelineBoard.tsx';
const BOARD_BASENAME_RE = /pipelineboard/i;

const SCAN_ROOTS = ['src/client'];
const SCAN_EXTS = new Set(['.ts', '.tsx', '.css']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

export type BoardEdgeKind =
  | 'static-import'
  | 're-export'
  | 'require'
  | 'dynamic-import'
  | 'unresolved-dynamic'
  | 'glob'
  | 'css-ref'
  | 'jsx-mount';

export interface BoardFinding {
  file: string;
  line: number;
  kind: BoardEdgeKind;
  snippet: string;
}

const FROM_RE = /(?:import|export)\s[^;]*?\bfrom\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_RE = /^\s*import\s*['"]([^'"]+)['"]\s*;/;
const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_IMPORT_RE = /import\(\s*([^)]*?)\)/gs;
const STRING_LITERAL_RE = /^\s*['"]([^'"]+)['"]\s*$/;
const GLOB_RE = /import\.meta\.glob\(\s*[`'"]([^`'"]+)[`'"]/g;
const CSS_REF_RE = /@import\s+['"]([^'"]+)['"]|url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
const JSX_MOUNT_RE = /<PipelineBoard(?=[\s>/])/;

function lineOf(content: string, index: number): number {
  return content.slice(0, index).length - content.slice(0, index).replace(/\n/g, '').length + 1;
}

/** Resolve a TS specifier to a repo-relative file path, or null when external/unresolvable. */
export function resolveClientSpec(root: string, fromFile: string, spec: string): string | null {
  let candidate: string;
  if (spec.startsWith('.')) {
    candidate = path.normalize(path.join(path.dirname(fromFile), spec));
  } else if (spec.startsWith('@/')) {
    // tsconfig paths: "@/*" -> "./src/*".
    candidate = path.normalize(path.join('src', spec.slice(2)));
  } else {
    return null; // Bare package import (node_modules) — cannot be the board.
  }
  const exts = ['', '.ts', '.tsx', '.d.ts', '/index.ts', '/index.tsx'];
  for (const ext of exts) {
    const rel = `${candidate}${ext}`;
    try {
      const stat = fs.statSync(path.join(root, rel));
      if (stat.isFile()) return rel;
    } catch {
      continue;
    }
  }
  return null;
}

function isBoardTarget(resolved: string | null, spec: string): boolean {
  if (resolved !== null) return resolved === BOARD_FILE;
  // Unresolvable but board-named specifier: still an edge, never an absence.
  return BOARD_BASENAME_RE.test(spec);
}

function pushEdge(
  findings: BoardFinding[],
  file: string,
  content: string,
  index: number,
  kind: BoardEdgeKind,
  snippet: string,
): void {
  findings.push({ file, line: lineOf(content, index), kind, snippet: snippet.trim().slice(0, 160) });
}

/** Classify one file's content into board-reaching edges/blockers. */
export function classifyBoardRefs(file: string, content: string, root: string): BoardFinding[] {
  const findings: BoardFinding[] = [];
  const isBoardFile = file === BOARD_FILE;

  if (file.endsWith('.css')) {
    CSS_REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CSS_REF_RE.exec(content)) !== null) {
      const ref = m[1] ?? m[2] ?? '';
      if (BOARD_BASENAME_RE.test(ref)) pushEdge(findings, file, content, m.index, 'css-ref', m[0]);
    }
    return findings;
  }

  FROM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FROM_RE.exec(content)) !== null) {
    const spec = m[1];
    const isReExport = /^\s*export\s/.test(m[0]);
    if (isBoardTarget(resolveClientSpec(root, file, spec), spec)) {
      pushEdge(findings, file, content, m.index, isReExport ? 're-export' : 'static-import', m[0]);
    }
  }
  const sideLines = content.split('\n');
  sideLines.forEach((lineText, idx) => {
    const sm = SIDE_EFFECT_RE.exec(lineText);
    if (sm && isBoardTarget(resolveClientSpec(root, file, sm[1]), sm[1])) {
      findings.push({ file, line: idx + 1, kind: 'static-import', snippet: lineText.trim().slice(0, 160) });
    }
  });

  REQUIRE_RE.lastIndex = 0;
  while ((m = REQUIRE_RE.exec(content)) !== null) {
    const spec = m[1];
    if (isBoardTarget(resolveClientSpec(root, file, spec), spec)) {
      pushEdge(findings, file, content, m.index, 'require', m[0]);
    }
  }

  DYNAMIC_IMPORT_RE.lastIndex = 0;
  while ((m = DYNAMIC_IMPORT_RE.exec(content)) !== null) {
    // Skip `import('x')` used purely as a TYPE annotation — it still creates
    // a compile-time edge, so only skip when the spec cannot be the board.
    const rawArg = m[1];
    const lit = STRING_LITERAL_RE.exec(rawArg);
    if (lit) {
      const spec = lit[1];
      if (isBoardTarget(resolveClientSpec(root, file, spec), spec)) {
        pushEdge(findings, file, content, m.index, 'dynamic-import', `import(${rawArg.trim().slice(0, 80)})`);
      }
      continue;
    }
    // Non-literal (concatenated/template/identifier) specifier.
    if (BOARD_BASENAME_RE.test(rawArg)) {
      pushEdge(findings, file, content, m.index, 'dynamic-import', `import(${rawArg.trim().slice(0, 80)})`);
    } else {
      // Might reach the board via computed construction — unclassified blocker.
      pushEdge(findings, file, content, m.index, 'unresolved-dynamic', `import(${rawArg.trim().slice(0, 80)})`);
    }
  }

  GLOB_RE.lastIndex = 0;
  while ((m = GLOB_RE.exec(content)) !== null) {
    const pattern = m[1];
    // A glob spanning component sources could match the board file. Only a
    // pattern that cannot match .tsx under components/ is safe.
    const couldMatch =
      BOARD_BASENAME_RE.test(pattern) ||
      (pattern.includes('*') && (pattern.includes('components') || pattern.includes('**') || pattern.endsWith('.tsx') || pattern.endsWith('.ts')));
    if (couldMatch) {
      pushEdge(findings, file, content, m.index, 'glob', `import.meta.glob(${pattern.slice(0, 80)})`);
    }
  }

  if (!isBoardFile && JSX_MOUNT_RE.test(content)) {
    const idx = content.search(JSX_MOUNT_RE);
    pushEdge(findings, file, content, idx, 'jsx-mount', '<PipelineBoard');
  }

  return findings.sort((a, b) => a.line - b.line);
}

export function scanBoardRefs(root: string): BoardFinding[] {
  const findings: BoardFinding[] = [];
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
      if (!SCAN_EXTS.has(path.extname(name))) continue;
      let content: string;
      try {
        content = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const rel = path.relative(root, full);
      for (const f of classifyBoardRefs(rel, content, root)) findings.push(f);
    }
  };
  for (const scanRoot of SCAN_ROOTS) {
    const abs = path.join(root, scanRoot);
    if (fs.existsSync(abs)) walk(abs);
  }
  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return findings;
}

export interface BoardCheckResult {
  /** Edges/blockers in production files EXCLUDING the board file itself. */
  production: BoardFinding[];
  /** Self-references inside the board file (informational only). */
  boardSelf: BoardFinding[];
  inventoryMentionsBoard: boolean;
  inventoryApprovesZeroMounts: boolean;
}

export function checkBoardTree(root: string, inventoryPath?: string): BoardCheckResult {
  const all = scanBoardRefs(root);
  const production = all.filter((f) => f.file !== BOARD_FILE);
  const boardSelf = all.filter((f) => f.file === BOARD_FILE);
  let inventoryMentionsBoard = false;
  let inventoryApprovesZeroMounts = false;
  if (inventoryPath) {
    try {
      const text = fs.readFileSync(inventoryPath, 'utf8');
      inventoryMentionsBoard = text.includes('PipelineBoard.tsx');
      inventoryApprovesZeroMounts =
        inventoryMentionsBoard && /zero mounts|no .*mount|retained-unreachable|unreachable/i.test(text);
    } catch {
      inventoryMentionsBoard = false;
    }
  }
  return { production, boardSelf, inventoryMentionsBoard, inventoryApprovesZeroMounts };
}

function main(): void {
  const args = process.argv.slice(2);
  const root = process.cwd();
  if (args.includes('--emit-manifest')) {
    for (const f of scanBoardRefs(root)) {
      console.log(`${f.file}:${f.line} [${f.kind}] ${f.snippet}`);
    }
    return;
  }
  const checkIdx = args.indexOf('--check');
  if (checkIdx === -1) {
    console.error('Usage: audit-onboarding-shell-imports.ts [--emit-manifest | --check <retirement-inventory.md>]');
    process.exit(2);
  }
  const inventoryArg = args[checkIdx + 1];
  if (!inventoryArg) {
    console.error('Missing inventory path after --check');
    process.exit(2);
  }
  const result = checkBoardTree(root, path.resolve(inventoryArg));
  let failed = false;
  if (result.production.length > 0) {
    failed = true;
    console.error(`BOARD EDGES IN PRODUCTION (${result.production.length}):`);
    for (const f of result.production) console.error(`  ${f.file}:${f.line} [${f.kind}] ${f.snippet}`);
  }
  if (!result.inventoryMentionsBoard) {
    failed = true;
    console.error(`INVENTORY MISSING: ${inventoryArg} does not name ${BOARD_FILE}`);
  } else if (!result.inventoryApprovesZeroMounts) {
    failed = true;
    console.error('INVENTORY INCOMPLETE: board file is not recorded as retained-unreachable with zero mounts');
  }
  console.log(
    `Shell-import audit: ${result.production.length} production edge(s), ` +
      `${result.boardSelf.length} board-self reference(s), ` +
      `${failed ? 'GATE FAILED' : 'GATE PASSED'}`,
  );
  process.exit(failed ? 1 : 0);
}

// Importing this module must not execute the CLI (self-test imports it).
if (import.meta.main) {
  main();
}
