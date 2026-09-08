// @vitest-environment node
// Slice 0 — self-test for the §6.1 test-runner registration guard.
// Synthetic cases only: no repo I/O, no DB, no network. The guard itself
// remains Vitest-collectible (it imports only node builtins).
import { describe, expect, it } from 'vitest';
import {
  checkTree,
  hasDirectBunImport,
  hasTextualBunMention,
  parseVitestExcludes,
  type RunnerManifest,
} from '../../../scripts/check-test-runner-coverage';

// NOTE: fixture import strings are assembled via interpolation so this
// self-test file itself carries no static bun import (the guard must stay
// green on its own source; see the runner-manifest vitestSafe entry).
const BUN_TEST = 'bun:test';
const BUN_SQLITE = 'bun:sqlite';
const BUN_SUITE = `import { describe, it, expect } from '${BUN_TEST}';\ndescribe('x', () => { it('y', () => { expect(1).toBe(1); }); });\n`;
const VITEST_SUITE = `import { describe, it, expect } from 'vitest';\ndescribe('x', () => { it('y', () => { expect(1).toBe(1); }); });\n`;
const COMMENT_ONLY = `// ${BUN_SQLITE}-backed coverage lives in the -db suite\n${VITEST_SUITE}`;

const emptyManifest: RunnerManifest = { version: 1, vitestSafe: {}, transitiveBun: {} };

function run(
  files: Record<string, string>,
  opts?: {
    excludes?: string[];
    testDb?: string;
    manifest?: RunnerManifest;
    broad?: string[];
    baselineLedger?: { version: number; entries: Array<{ file: string; code: string; area: string }> };
  },
) {
  const candidates = Object.keys(files).sort();
  const excludes = new Set(opts?.excludes ?? []);
  return checkTree({
    repoRoot: '/fake-root',
    candidates,
    readFile: rel => files[rel],
    vitestExcludes: excludes,
    broadExcludes: opts?.broad ?? [],
    testDbCommand: opts?.testDb ?? '',
    manifest: opts?.manifest ?? emptyManifest,
    manifestPath: 'runner-manifest.json',
    baselineLedger: opts?.baselineLedger,
  });
}

const SUITE = 'src/tests/unit/fake-bun.test.ts';

describe('bun import detection', () => {
  it('detects single-quoted static import', () => {
    expect(hasDirectBunImport(BUN_SUITE)).toBe(true);
  });

  it('detects double-quoted static import', () => {
    expect(hasDirectBunImport(BUN_SUITE.replace(/'/g, '"'))).toBe(true);
  });

  it('detects require()', () => {
    expect(hasDirectBunImport(`const { test } = require('${BUN_TEST}');\n`)).toBe(true);
  });

  it('detects dynamic import()', () => {
    expect(hasDirectBunImport(`const m = await import('${BUN_SQLITE}');\n`)).toBe(true);
  });

  it('ignores comment-only mentions for direct detection, flags textual', () => {
    expect(hasDirectBunImport(COMMENT_ONLY)).toBe(false);
    expect(hasTextualBunMention(COMMENT_ONLY)).toBe(true);
  });

  it('clean vitest suite has neither signal', () => {
    expect(hasDirectBunImport(VITEST_SUITE)).toBe(false);
    expect(hasTextualBunMention(VITEST_SUITE)).toBe(false);
  });
});

describe('registration gate', () => {
  it('both entries present ⇒ clean', () => {
    const r = run(
      { [SUITE]: BUN_SUITE },
      { excludes: [SUITE], testDb: `bun test --timeout 30000 ${SUITE}` },
    );
    expect(r.violations).toEqual([]);
    expect(r.bunSuites).toBe(1);
  });

  it('missing exclude ⇒ violation', () => {
    const r = run({ [SUITE]: BUN_SUITE }, { testDb: `bun test ${SUITE}` });
    expect(r.violations.map(v => v.code)).toContain('missing-exclude');
  });

  it('missing test:db entry ⇒ violation', () => {
    const r = run({ [SUITE]: BUN_SUITE }, { excludes: [SUITE], testDb: 'bun test other.test.ts' });
    expect(r.violations.map(v => v.code)).toContain('missing-test-db');
  });

  it('neither entry ⇒ both violations', () => {
    const r = run({ [SUITE]: BUN_SUITE });
    const codes = r.violations.map(v => v.code);
    expect(codes).toContain('missing-exclude');
    expect(codes).toContain('missing-test-db');
  });

  it('registration only in a shell comment is not registration', () => {
    const r = run(
      { [SUITE]: BUN_SUITE },
      { excludes: [SUITE], testDb: `bun test other.test.ts # bun test ${SUITE} (disabled)` },
    );
    expect(r.violations.map(v => v.code)).toContain('missing-test-db');
  });

  it('transitive-Bun manifest entry enforces both registrations', () => {
    const transitive = 'src/tests/unit/fake-transitive.test.ts';
    const manifest: RunnerManifest = {
      version: 1,
      vitestSafe: {},
      transitiveBun: { [transitive]: `transitive ${BUN_SQLITE} import` },
    };
    const r = run({ [transitive]: VITEST_SUITE }, { manifest });
    const codes = r.violations.map(v => v.code);
    expect(codes).toContain('missing-exclude');
    expect(codes).toContain('missing-test-db');
  });

  it('unclassified textual mention ⇒ violation', () => {
    const f = 'src/tests/unit/fake-mention.test.ts';
    const r = run({ [f]: COMMENT_ONLY });
    expect(r.violations.map(v => v.code)).toContain('unclassified-bun-mention');
  });

  it('manifest vitestSafe classification clears a textual mention', () => {
    const f = 'src/tests/unit/fake-mention.test.ts';
    const manifest: RunnerManifest = {
      version: 1,
      vitestSafe: { [f]: 'comment-only, verified collect' },
      transitiveBun: {},
    };
    const r = run({ [f]: COMMENT_ONLY }, { manifest });
    expect(r.violations).toEqual([]);
  });

  it('vitestSafe entry with a new static bun import ⇒ stale-manifest', () => {
    const manifest: RunnerManifest = {
      version: 1,
      vitestSafe: { [SUITE]: 'was comment-only' },
      transitiveBun: {},
    };
    const r = run({ [SUITE]: BUN_SUITE }, { manifest });
    expect(r.violations.map(v => v.code)).toContain('stale-manifest');
  });

  it('vitestSafe entry with only a guarded dynamic import stays clean', () => {
    const guarded = `try { await import('${BUN_SQLITE}'); } catch { /* skip */ }\n${VITEST_SUITE}`;
    const manifest: RunnerManifest = {
      version: 1,
      vitestSafe: { [SUITE]: 'guarded dynamic import, verified collect' },
      transitiveBun: {},
    };
    const r = run({ [SUITE]: guarded }, { manifest });
    expect(r.violations).toEqual([]);
  });

  it('fully Bun-registered suite needs no manifest entry for textual mentions', () => {
    const f = 'src/tests/unit/fake-registered.test.ts';
    const r = run(
      { [f]: COMMENT_ONLY },
      { excludes: [f], testDb: `bun test --timeout 30000 ${f}` },
    );
    expect(r.violations).toEqual([]);
  });

  it('manifest entry for a nonexistent file ⇒ stale-manifest', () => {
    const manifest: RunnerManifest = {
      version: 1,
      vitestSafe: {},
      transitiveBun: { 'src/tests/unit/does-not-exist.test.ts': 'ghost' },
    };
    const r = run({ [SUITE]: VITEST_SUITE }, { manifest });
    expect(r.violations.map(v => v.code)).toContain('stale-manifest');
  });

  it('broad exclude ⇒ broad-exclude violation', () => {
    const r = run({ [SUITE]: VITEST_SUITE }, { broad: ['src/tests/unit/*'] });
    expect(r.violations.map(v => v.code)).toContain('broad-exclude');
  });

  it('extraction-worker suites need no Vitest exclude (outside include)', () => {
    const f = 'src/extraction-worker/routes/fake.test.ts';
    const r = run({ [f]: BUN_SUITE }, { testDb: `bun test ${f}` });
    expect(r.violations.map(v => v.code)).not.toContain('missing-exclude');
    expect(r.violations).toEqual([]);
  });
});

describe('baseline ledger (documented-red)', () => {
  const LEDGER_SUITE = 'src/tests/unit/fake-legacy.test.ts';
  const ledger = {
    version: 1,
    entries: [{ file: LEDGER_SUITE, code: 'missing-test-db', area: 'test' }],
  };

  it('ledgered violation is reported but does not fail', () => {
    const r = run(
      { [LEDGER_SUITE]: BUN_SUITE },
      {
        excludes: [LEDGER_SUITE],
        testDb: 'bun test other.test.ts',
        baselineLedger: ledger,
      },
    );
    expect(r.violations).toEqual([]);
    expect(r.knownBaseline.map(v => `${v.file}::${v.code}`)).toEqual([
      `${LEDGER_SUITE}::missing-test-db`,
    ]);
  });

  it('ledger does not cover a different code on the same file', () => {
    const r = run(
      { [LEDGER_SUITE]: BUN_SUITE },
      { testDb: 'bun test other.test.ts', baselineLedger: ledger },
    );
    // missing-exclude is NOT ledgered ⇒ still fails; missing-test-db is known.
    expect(r.violations.map(v => v.code)).toEqual(['missing-exclude']);
    expect(r.knownBaseline.map(v => v.code)).toEqual(['missing-test-db']);
  });

  it('ledger entry with no matching violation ⇒ stale-ledger', () => {
    const r = run(
      { [LEDGER_SUITE]: BUN_SUITE },
      {
        excludes: [LEDGER_SUITE],
        testDb: `bun test --timeout 30000 ${LEDGER_SUITE}`,
        baselineLedger: ledger,
      },
    );
    // Fully registered ⇒ the ledger entry is stale and must be removed.
    expect(r.violations.map(v => v.code)).toEqual(['stale-ledger']);
  });

  it('unledgered new violation still fails with a non-empty ledger', () => {
    const other = 'src/tests/unit/fake-new.test.ts';
    const r = run(
      { [LEDGER_SUITE]: BUN_SUITE, [other]: BUN_SUITE },
      {
        excludes: [LEDGER_SUITE, other],
        testDb: 'bun test other.test.ts',
        baselineLedger: ledger,
      },
    );
    expect(r.violations.map(v => v.file)).toEqual([other]);
  });
});

describe('vitest config parsing', () => {
  it('extracts explicit per-file excludes, ignores bare words', () => {
    const cfg = `exclude: ['node_modules', 'src/tests/unit/a.test.ts', "src/tests/unit/b.test.tsx"]`;
    const { excludes, broad } = parseVitestExcludes(cfg);
    expect([...excludes].sort()).toEqual(['src/tests/unit/a.test.ts', 'src/tests/unit/b.test.tsx']);
    expect(broad).toEqual([]);
  });

  it('flags glob excludes under src', () => {
    const { broad } = parseVitestExcludes(`exclude: ['src/tests/unit/*.test.ts']`);
    expect(broad.length).toBeGreaterThan(0);
  });
});
