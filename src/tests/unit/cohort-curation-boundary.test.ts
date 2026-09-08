// @vitest-environment node
/**
 * Cohort Curation execution-seam boundary tests (plan Slice 2, §3.2.3).
 *
 * Vitest-only: runs the ACTUAL read-only checker (never a mock of its
 * classifier, never application execution imports) over synthetic trees
 * covering every rule plus the real production scan. The checker imports
 * node builtins only, so it stays Vitest-collectible.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  scanSpecifiers,
  scanExportedValues,
  checkSeamTree,
} from '../../../scripts/audit-cohort-curation-seam';

let tmpRoot: string;

function writeTree(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'seam-audit-selftest-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('specifier scanner (synthetic)', () => {
  it('detects static imports, re-exports, and literal dynamic imports', () => {
    const specs = scanSpecifiers([
      `import { a } from '../cohort-curator';`,
      `export { b } from './titles';`,
      `const m = await import('../cohort-curator');`,
      `const r = require('./decisions');`,
    ].join('\n'));
    expect(specs).toContain('../cohort-curator');
    expect(specs).toContain('./titles');
    expect(specs).toContain('./decisions');
  });

  it('ignores commented-out imports', () => {
    const specs = scanSpecifiers([
      `// import { a } from '../cohort-curator';`,
      `/* export { b } from './titles'; */`,
      `import { c } from './real';`,
    ].join('\n'));
    expect(specs).toEqual(['./real']);
  });

  it('detects exported runtime values but not interfaces or types', () => {
    const names = scanExportedValues([
      `export function runClaim() {}`,
      `export const keeper = 1;`,
      `export interface TestCheckpoints {}`,
      `export type Alias = string;`,
      `export { observeCohortShadowTypeResolution };`,
    ].join('\n'));
    expect(names).toContain('runClaim');
    expect(names).toContain('keeper');
    expect(names).toContain('observeCohortShadowTypeResolution');
    expect(names).not.toContain('TestCheckpoints');
    expect(names).not.toContain('Alias');
  });
});

describe('rule detection (synthetic trees)', () => {
  function rules(files: Record<string, string>): string[] {
    writeTree({
      // R5 needs its single legitimate owner in every tree.
      'src/onboarding/product-curator.ts': 'export function composeCurationPipelineStages() {}\n',
      ...files,
    });
    return checkSeamTree(tmpRoot).map(v => v.rule);
  }

  it('R1 fires on classification imports of onboarding cohort internals', () => {
    const found = rules({
      'src/classification/some-stage.ts': `import { x } from '../onboarding/cohort-curator';\n`,
    });
    expect(found).toContain('R1');
  });

  it('R1 ignores the shared pure leaf and comments', () => {
    const found = rules({
      'src/classification/leaf-user.ts': [
        `import { y } from './cohort-decision-authority';`,
        `// import { x } from '../onboarding/cohort-curator';`,
      ].join('\n'),
    });
    expect(found).not.toContain('R1');
  });

  it('R2 fires on package-internal imports of transitional ../cohort-curator', () => {
    const found = rules({
      'src/onboarding/cohort-curation/freeze.ts': `import { z } from '../cohort-curator';\n`,
      'src/onboarding/cohort-curation/index.ts': `import { z } from '../cohort-curator';\n`,
    });
    expect(found).toContain('R2');
    // Exactly one R2 violation: index.ts is the allowlisted owner.
    expect(checkSeamTree(tmpRoot).filter(v => v.rule === 'R2').map(v => v.file)).toEqual([
      'src/onboarding/cohort-curation/freeze.ts',
    ]);
  });

  it('R3 fires on job-queue use of old execution entries', () => {
    const found = rules({
      'src/onboarding/job-queue.ts': [
        `import { createCohortCuration } from './cohort-curation/index';`,
        `await processCohort(run, wsPath, wsId);`,
      ].join('\n'),
    });
    expect(found).toContain('R3');
  });

  it('R3 passes when job-queue uses only the seam', () => {
    const found = rules({
      'src/onboarding/job-queue.ts': [
        `import { createCohortCuration } from './cohort-curation/index';`,
        `await this.cohortCuration.executeClaim(run.id, this.workerId);`,
      ].join('\n'),
    });
    expect(found).not.toContain('R3');
  });

  it('R4 fires on runtime test-control exports, not the checkpoints type', () => {
    const found = rules({
      'src/onboarding/cohort-curation/index.ts': [
        `import { z } from '../cohort-curator';`,
        `export interface CohortCurationTestCheckpoints {}`,
        `export const testHooks = {};`,
      ].join('\n'),
    });
    expect(found).toContain('R4');
  });

  it('R5 fires when composition has zero or two owners', () => {
    writeTree({
      'src/onboarding/other.ts': 'export function composeCurationPipelineStages() {}\n',
      'src/onboarding/product-curator.ts': 'export function composeCurationPipelineStages() {}\n',
    });
    const found = checkSeamTree(tmpRoot).map(v => v.rule);
    expect(found).toContain('R5');
  });
});

describe('production scan (real tree)', () => {
  it('zero seam violations in the production import graph', () => {
    const violations = checkSeamTree(process.cwd());
    expect(violations).toEqual([]);
  });
});
