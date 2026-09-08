/**
 * Slice 1 — inventory-checker self-tests (Vitest, pure).
 *
 * Runs the ACTUAL read-only checker (never a mock of its classifier) over
 * synthetic file trees covering every evasion pattern, residual-allowlist
 * behavior, exit codes, and determinism. The checker imports node builtins
 * only, so it stays Vitest-collectible.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { classifyLine, scanTree, checkTree } from '../../../scripts/audit-onboarding-stage-vocabulary';

let tmpRoot: string;

function writeTree(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-audit-selftest-'));
  writeTree({ 'src/anchor.ts': 'export const x = 1;\n' });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('classifier evasion patterns', () => {
  const cases: Array<{ name: string; content: string; kind: string; classification: string }> = [
    { name: 'single quotes', content: `const s = 'sourcing';\n`, kind: 'v1-literal', classification: 'operational-v1' },
    { name: 'double quotes', content: `const s = "discovery";\n`, kind: 'v1-literal', classification: 'operational-v1' },
    { name: 'quoted in template', content: 'const s = `stage is ${\'review\'}`;\n', kind: 'v1-literal', classification: 'operational-v1' },
    { name: 'dot access', content: 'if (row.stage === x) {}\n', kind: 'stage-access', classification: 'operational-v1' },
    { name: 'bracket access', content: `const s = item['stage'];\n`, kind: 'stage-access', classification: 'operational-v1' },
    { name: 'STAGES key', content: 'const keys = Object.keys(STAGES);\n', kind: 'stage-access', classification: 'operational-v1' },
    { name: 'stage_status sql', content: `db.query('SELECT * FROM t WHERE stage_status = ?').all('pending');\n`, kind: 'stage-access', classification: 'operational-v1' },
    { name: 'CHECK ddl', content: `CHECK (stage_name IN ('packaging_ocr'))\n`, kind: 'stage-access', classification: 'non-stage' },
  ];

  for (const c of cases) {
    it(`classifies ${c.name}`, () => {
      const hit = classifyLine('src/mod.ts', c.content);
      // CHECK-ddl line hits the classification-migration allowlist only for that file;
      // here it must stay operational (no allowlist for src/mod.ts).
      if (c.name === 'CHECK ddl') {
        expect(hit?.classification).toBe('operational-v1');
      } else {
        expect(hit?.kind).toBe(c.kind);
        expect(hit?.classification).toBe(c.classification);
      }
    });
  }

  it('fails closed on dynamic construction (never silently passes)', () => {
    for (const line of [`const k = 'stage_' + name;\n`, 'const e = `stage_${kind}`;\n']) {
      const hit = classifyLine('src/mod.ts', line);
      expect(hit?.kind).toBe('dynamic-construction');
      expect(hit?.classification).toBe('unclassified');
    }
  });

  it('passes immutable route ids as historical (never rewritten)', () => {
    const hit = classifyLine('src/mod.ts', `if (r !== 'distributor_record_to_extraction') {}\n`);
    expect(hit?.classification).toBe('historical-route-id');
  });

  it('passes test paths as versioned fixtures', () => {
    const hit = classifyLine('src/tests/unit/x.test.ts', `const s = 'sourcing';\n`);
    expect(hit?.classification).toBe('test-literal');
  });
});

describe('scanTree over synthetic trees', () => {
  it('finds quoted literals, access patterns, and dynamic failures deterministically', () => {
    writeTree({
      'src/a.ts': `export const s = 'sourcing';\n`,
      'src/b.ts': `if (x.stage === y) {}\n`,
      'src/c.ts': "const k = 'stage_' + n;\n",
      'src/clean.ts': 'export const n = 1;\n',
    });
    const first = scanTree(tmpRoot);
    const second = scanTree(tmpRoot);
    expect(second).toEqual(first);
    const byFile = new Map(first.map(f => [f.file, f.classification]));
    expect(byFile.get('src/a.ts')).toBe('operational-v1');
    expect(byFile.get('src/b.ts')).toBe('operational-v1');
    expect(byFile.get('src/c.ts')).toBe('unclassified');
    expect(byFile.has('src/clean.ts')).toBe(false);
    expect(byFile.has('src/anchor.ts')).toBe(false);
  });

  it('does not mutate the tree and ignores node_modules', () => {
    writeTree({
      'node_modules/pkg/index.ts': `export const s = 'sourcing';\n`,
      'src/ok.ts': `export const s = 'review';\n`,
    });
    const before = fs.readFileSync(path.join(tmpRoot, 'src/ok.ts'), 'utf8');
    const findings = scanTree(tmpRoot);
    expect(fs.readFileSync(path.join(tmpRoot, 'src/ok.ts'), 'utf8')).toBe(before);
    expect(findings.some(f => f.file.includes('node_modules'))).toBe(false);
    expect(findings.some(f => f.file === 'src/ok.ts')).toBe(true);
  });
});

describe('checkTree gates', () => {
  function writeInventory(rows: string[]): string {
    const inv = path.join(tmpRoot, 'inventory.md');
    fs.writeFileSync(
      inv,
      `# Inventory\n\n| File | Site | Class | Notes |\n|---|---|---|---|\n${rows.join('\n')}\n`,
    );
    return inv;
  }

  it('passes listed operational files, fails unlisted ones', () => {
    writeTree({ 'src/listed.ts': `export const s = 'sourcing';\n`, 'src/unlisted.ts': `export const s = 'review';\n` });
    const inv = writeInventory(['| `src/listed.ts` | STAGE_ORDER | operational | ok |']);
    const result = checkTree(tmpRoot, inv);
    expect(result.unlistedOperational).toEqual(['src/unlisted.ts']);
    expect(result.unclassified).toHaveLength(0);
  });

  it('fails on unclassified dynamic construction', () => {
    writeTree({ 'src/dyn.ts': "const k = 'stage_' + n;\n" });
    const inv = writeInventory(['| `src/dyn.ts` | dynamic | operational | listed but still unclassified |']);
    const result = checkTree(tmpRoot, inv);
    expect(result.unclassified).toHaveLength(1);
  });

  it('flags missing inventory files', () => {
    writeTree({});
    const inv = writeInventory(['| `src/gone.ts` | x | operational | y |']);
    const result = checkTree(tmpRoot, inv);
    expect(result.missingInventoryFiles).toEqual(['src/gone.ts']);
  });

  it('validates residuals: stale, overbroad, missing-file, and version-wrong all fail', () => {
    writeTree({ 'src/r.ts': `export const s = 'sourcing';\n` });
    const inv = writeInventory(['| `src/r.ts` | literal | operational | ok |']);
    const resPath = path.join(tmpRoot, 'residuals.json');
    // Stale: matches nothing.
    fs.writeFileSync(resPath, JSON.stringify({ version: 1, entries: [{ file: 'src/r.ts', pattern: 'no-such-line-zzz', reason: 'stale', version: 1 }] }));
    expect(checkTree(tmpRoot, inv, resPath).staleResiduals).toHaveLength(1);
    // Overbroad: file-scoped pattern leaks to another file.
    writeTree({ 'src/other.ts': `export const other = 'sourcing';\n` });
    const inv2 = writeInventory(['| `src/r.ts` | literal | operational | ok |', '| `src/other.ts` | literal | operational | ok |']);
    fs.writeFileSync(
      resPath,
      JSON.stringify({ version: 1, entries: [{ file: 'src/r.ts', pattern: "'sourcing'", reason: 'overbroad', version: 1 }] }),
    );
    expect(checkTree(tmpRoot, inv2, resPath).staleResiduals).toHaveLength(1);
    // Missing: excused file not inventoried anywhere.
    writeTree({ 'src/uninv.ts': `export const unique = 'discovery';\n` });
    fs.writeFileSync(
      resPath,
      JSON.stringify({ version: 1, entries: [{ file: 'src/uninv.ts', pattern: 'unique', reason: 'x', version: 1 }] }),
    );
    const missingRes = checkTree(tmpRoot, inv2, resPath).staleResiduals;
    expect(missingRes).toHaveLength(1);
    expect(missingRes[0]).toMatch(/missing/);
    // Version-wrong entry.
    fs.writeFileSync(
      resPath,
      JSON.stringify({ version: 1, entries: [{ file: 'src/r.ts', pattern: "'sourcing'", reason: 'x', version: 2 }] }),
    );
    expect(checkTree(tmpRoot, inv2, resPath).staleResiduals).toHaveLength(1);
  });

  it('excuses exactly-matched residuals and reports zero unclassified', () => {
    writeTree({ 'src/r.ts': `export const s = 'sourcing';\n` });
    const inv = writeInventory(['| `src/r.ts` | literal | operational | ok |']);
    const resPath = path.join(tmpRoot, 'residuals.json');
    fs.writeFileSync(
      resPath,
      JSON.stringify({ version: 1, entries: [{ file: 'src/r.ts', pattern: 'export const', reason: 'reviewed residual', version: 1 }] }),
    );
    const result = checkTree(tmpRoot, inv, resPath);
    expect(result.staleResiduals).toHaveLength(0);
    expect(result.findings.some(f => f.file === 'src/r.ts')).toBe(false);
  });

  it('rejects an unsupported residuals manifest version', () => {
    writeTree({});
    const inv = writeInventory([]);
    const resPath = path.join(tmpRoot, 'residuals.json');
    fs.writeFileSync(resPath, JSON.stringify({ version: 99, entries: [] }));
    expect(() => checkTree(tmpRoot, inv, resPath)).toThrow();
  });

  it('classifies committed synthetic fixtures without flagging them operational', () => {
    // Committed fixtures live in the real repo; assert their contract here:
    // quoted/access/ddl/route-id fixtures classify fixture/historical, clean is silent.
    const fixtureDir = path.join(__dirname, '..', 'fixtures', 'onboarding-stage-audit');
    if (!fs.existsSync(fixtureDir)) return;
    const expectations: Record<string, Array<'fixture' | 'historical-route-id'>> = {
      'quoted-literals.fixture': ['fixture'],
      'stage-access.fixture': ['fixture'],
      'ddl.fixture': ['fixture'],
      'route-id.fixture': ['historical-route-id'],
    };
    for (const [name, allowed] of Object.entries(expectations)) {
      const full = path.join(fixtureDir, name);
      expect(fs.existsSync(full)).toBe(true);
      const lines = fs.readFileSync(full, 'utf8').split('\n');
      let hits = 0;
      for (const line of lines) {
        const hit = classifyLine(`src/tests/fixtures/onboarding-stage-audit/${name}`, line);
        if (hit) {
          hits += 1;
          expect(allowed).toContain(hit.classification);
        }
      }
      expect(hits).toBeGreaterThan(0);
    }
    const cleanLines = fs.readFileSync(path.join(fixtureDir, 'clean.fixture'), 'utf8').split('\n');
    for (const line of cleanLines) {
      expect(classifyLine('src/tests/fixtures/onboarding-stage-audit/clean.fixture', line)).toBeNull();
    }
  });
});
