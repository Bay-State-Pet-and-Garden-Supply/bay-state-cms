// @vitest-environment node
/**
 * Slice 6 — shell-import audit self-tests (Vitest, pure).
 *
 * Runs the ACTUAL read-only checker (never a mock of its classifier) over
 * synthetic file trees covering every import-evasion pattern, plus the real
 * production scan: zero import-graph edges to PipelineBoard.tsx after mount
 * retirement. The checker imports node builtins only, so it stays
 * Vitest-collectible.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  BOARD_FILE,
  classifyBoardRefs,
  scanBoardRefs,
  checkBoardTree,
} from '../../../scripts/audit-onboarding-shell-imports';

let tmpRoot: string;

function writeTree(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-audit-selftest-'));
  writeTree({ 'src/client/anchor.ts': 'export const x = 1;\n' });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('edge-pattern detection (synthetic trees)', () => {
  function edges(files: Record<string, string>): ReturnType<typeof scanBoardRefs> {
    writeTree(files);
    return scanBoardRefs(tmpRoot);
  }

  it('detects a direct relative static import', () => {
    const found = edges({
      'src/client/components/Onboarding.tsx': `import { PipelineBoard } from './PipelineBoard';\n`,
    });
    expect(found.map((f) => f.kind)).toEqual(['static-import']);
    expect(found[0].file).toBe('src/client/components/Onboarding.tsx');
  });

  it('detects an aliased (@/) static import', () => {
    const found = edges({
      'src/client/components/Onboarding.tsx': `import { PipelineBoard } from '@/client/components/PipelineBoard';\n`,
    });
    expect(found.map((f) => f.kind)).toEqual(['static-import']);
  });

  it('detects a barrel re-export edge', () => {
    const found = edges({
      'src/client/components/PipelineBoard.tsx': 'export function PipelineBoard() { return null; }\n',
      'src/client/components/boards.ts': `export { PipelineBoard } from './PipelineBoard';\n`,
      'src/client/components/Onboarding.tsx': `import { PipelineBoard } from './boards';\n`,
    });
    // The barrel itself is the classified production edge; the consumer edge
    // to the barrel is out of contract (barrel resolution is one level).
    expect(found.some((f) => f.file === 'src/client/components/boards.ts' && f.kind === 're-export')).toBe(true);
  });

  it('detects require() and literal dynamic import (incl. React.lazy)', () => {
    const found = edges({
      'src/client/components/a.ts': `const B = require('./PipelineBoard');\n`,
      'src/client/components/b.ts': `const Lazy = React.lazy(() => import('./PipelineBoard'));\n`,
    });
    expect(found.filter((f) => f.file.endsWith('a.ts')).map((f) => f.kind)).toEqual(['require']);
    expect(found.filter((f) => f.file.endsWith('b.ts')).map((f) => f.kind)).toEqual(['dynamic-import']);
  });

  it('fails closed on concatenated/computed dynamic imports that might reach the board', () => {
    const found = edges({
      'src/client/components/c.ts': 'const mod = await import(`./${name}`);\n',
    });
    expect(found.map((f) => f.kind)).toEqual(['unresolved-dynamic']);
  });

  it('detects board-named computed imports as direct edges', () => {
    const found = edges({
      'src/client/components/d.ts': 'const mod = await import(`./PipelineBoard_${variant}`);\n',
    });
    expect(found.map((f) => f.kind)).toEqual(['dynamic-import']);
  });

  it('detects component-spanning import-meta globs as blockers', () => {
    const found = edges({
      'src/client/components/e.ts': 'const mods = import.meta.glob("./**/*.tsx");\n',
    });
    expect(found.map((f) => f.kind)).toEqual(['glob']);
  });

  it('detects CSS @import/url references to the board', () => {
    const found = edges({
      'src/client/components/f.css': `@import './PipelineBoard.css';\n.g { background: url("./PipelineBoard-bg.png"); }\n`,
    });
    expect(found.map((f) => f.kind)).toEqual(['css-ref', 'css-ref']);
  });

  it('detects JSX mounts outside the board file, but not idle mentions', () => {
    const mounted = classifyBoardRefs(
      'src/client/components/g.tsx',
      'return <PipelineBoard batchId="b" />;\n',
      tmpRoot,
    );
    expect(mounted.map((f) => f.kind)).toContain('jsx-mount');
    const mentioned = classifyBoardRefs(
      'src/client/components/h.ts',
      '// PipelineBoard mounts were removed in Slice 6 (comment only).\nconst label = "board";\n',
      tmpRoot,
    );
    expect(mentioned).toEqual([]);
  });

  it('a clean tree passes deterministically (sorted, repeatable)', () => {
    writeTree({
      'src/client/components/Onboarding.tsx': `import { BatchWorkspace } from './onboarding/BatchWorkspace';\n`,
      'src/client/components/PipelineBoard.tsx': 'export function PipelineBoard() { return null; }\n',
    });
    const first = scanBoardRefs(tmpRoot);
    const second = scanBoardRefs(tmpRoot);
    expect(first).toEqual([]);
    expect(second).toEqual([]);
  });

  it('does not confuse type-only literal imports of other modules', () => {
    const found = edges({
      'src/client/components/i.ts': `const p: import('../store-manager-api').X | null = null;\nconst api = await import('../store-manager-api');\n`,
    });
    expect(found).toEqual([]);
  });
});

describe('production scan (real tree)', () => {
  it('zero production import-graph edges reach the board file after mount retirement', () => {
    const result = checkBoardTree(process.cwd());
    expect(result.production).toEqual([]);
  });

  it('--check passes against the reviewed retirement inventory', () => {
    const result = checkBoardTree(
      process.cwd(),
      path.join(process.cwd(), 'docs/plans/onboarding-shell-retirement-inventory.md'),
    );
    expect(result.production).toEqual([]);
    expect(result.inventoryMentionsBoard).toBe(true);
    expect(result.inventoryApprovesZeroMounts).toBe(true);
  });

  it('Slice 7: the board file itself is deleted (zero file/mount/fallback remains)', () => {
    expect(fs.existsSync(path.join(process.cwd(), BOARD_FILE))).toBe(false);
  });
});
