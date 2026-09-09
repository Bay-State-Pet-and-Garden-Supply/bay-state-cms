/**
 * Cohort Curation execution-seam audit (plan Slice 2, boundary suite support).
 *
 * Read-only checker over the production import graph. Node builtins only, so
 * the Vitest boundary suite can import it directly. Scans static imports,
 * re-exports, and dynamic imports (import(...) / require(...)).
 *
 * Rules (plan §§2.2–2.3):
 *  R1 classification/ must not import onboarding cohort execution/hash
 *     internals (cohort-curator, cohort-curation/*, cohort-title-hash,
 *     cohort-page-hash, cohort title/page coordinators). The shared pure
 *     leaf (classification/cohort-decision-authority.ts) is the one
 *     legitimate seam and lives inside classification/.
 *  R2 only cohort-curation/index.ts may import ../cohort-curator
 *     (temporary Slice-2 delegation, removed in Slice 6 with the old
 *     surface — every other package-internal module must not).
 *  R3 job-queue.ts must not import the old execution entries
 *     (freezeCohortForExecution, processCohort, verifyCohortRunFrozen)
 *     from ./cohort-curator — execution flows through the seam.
 *  R4 the seam package must not export runtime test controls: no exported
 *     value matching /hook|checkpoint/i except the
 *     CohortCurationTestCheckpoints TYPE (types vanish at runtime).
 *  R5 exactly one stage-composition owner: composeCurationPipelineStages is
 *     defined once (product-curator.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SeamViolation {
  file: string;
  rule: string;
  detail: string;
}

const ONBOARDING_INTERNAL_RE = /onboarding\/(cohort-curator|cohort-curation\/|cohort-title-hash|cohort-page-hash|cohort-title-coordinator|cohort-page-coordinator)/;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'\\])\/\/.*$/gm, '$1');
}

/** All module specifiers referenced by static imports, re-exports, and
 *  literal dynamic imports/requires. */
export function scanSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const specs: string[] = [];
  const staticRe = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g;
  const dynamicRe = /(?:import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = staticRe.exec(code)) !== null) specs.push(match[1]);
  while ((match = dynamicRe.exec(code)) !== null) specs.push(match[1]);
  return specs;
}

/** Names of exported runtime values (function/const/class, incl. `export { a, b }`). */
export function scanExportedValues(source: string): string[] {
  const code = stripComments(source);
  const names: string[] = [];
  const declRe = /export\s+(?:async\s+function|function|const|class|let|var)\s+([A-Za-z_$][\w$]*)/g;
  const listRe = /export\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = declRe.exec(code)) !== null) names.push(match[1]);
  while ((match = listRe.exec(code)) !== null) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()!.trim();
      if (name && name !== 'type') names.push(name);
    }
  }
  return names;
}

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      listTsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function checkSeamTree(repoRoot: string): SeamViolation[] {
  const violations: SeamViolation[] = [];
  const srcRoot = path.join(repoRoot, 'src');
  if (!fs.existsSync(srcRoot)) return [{ file: '<root>', rule: 'R0', detail: 'src/ not found' }];
  const files = listTsFiles(srcRoot);
  const compositionOwners: string[] = [];

  for (const file of files) {
    const rel = toPosix(path.relative(repoRoot, file));
    const source = fs.readFileSync(file, 'utf-8');
    const specs = scanSpecifiers(source);

    // R1: classification must not reach up into onboarding cohort internals.
    if (rel.startsWith('src/classification/')) {
      for (const spec of specs) {
        if (ONBOARDING_INTERNAL_RE.test(spec)) {
          violations.push({ file: rel, rule: 'R1', detail: `classification imports onboarding cohort internals: ${spec}` });
        }
      }
    }

    // R2: only index.ts may import the transitional ../cohort-curator.
    if (rel.startsWith('src/onboarding/cohort-curation/') && rel !== 'src/onboarding/cohort-curation/index.ts') {
      for (const spec of specs) {
        if (/(^|\/)cohort-curator['"]?$/.test(spec) || spec === '../cohort-curator') {
          violations.push({ file: rel, rule: 'R2', detail: `package-internal module imports transitional ../cohort-curator: ${spec}` });
        }
      }
    }

    // R3: job-queue must not use the old execution entries directly.
    if (rel === 'src/onboarding/job-queue.ts') {
      const code = stripComments(source);
      for (const name of ['freezeCohortForExecution', 'processCohort', 'verifyCohortRunFrozen']) {
        const useRe = new RegExp(`\\b${name}\\b`);
        // Type-only mentions are fine; any value import or call is not.
        const importRe = new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]\\.\\/cohort-curator['"]`);
        const importMatch = importRe.exec(code);
        if (importMatch && !/import\s+type\b/.test(importMatch[0])) {
          violations.push({ file: rel, rule: 'R3', detail: `job-queue imports old execution entry from ./cohort-curator: ${name}` });
        } else if (useRe.test(code)) {
          violations.push({ file: rel, rule: 'R3', detail: `job-queue still references old execution entry: ${name}` });
        }
      }
    }

    // R4: no runtime test-control exports from the seam package.
    if (rel.startsWith('src/onboarding/cohort-curation/')) {
      for (const name of scanExportedValues(source)) {
        if (/hook|checkpoint/i.test(name)) {
          violations.push({ file: rel, rule: 'R4', detail: `seam package exports runtime test control: ${name}` });
        }
      }
    }

    // R5: collect stage-composition owners.
    if (/function\s+composeCurationPipelineStages|const\s+composeCurationPipelineStages\s*=/.test(source)) {
      compositionOwners.push(rel);
    }
  }

  if (compositionOwners.length !== 1 || compositionOwners[0] !== 'src/onboarding/product-curator.ts') {
    violations.push({
      file: '<composition>',
      rule: 'R5',
      detail: `expected exactly src/onboarding/product-curator.ts to define composeCurationPipelineStages, found: ${compositionOwners.join(', ') || 'none'}`,
    });
  }
  return violations;
}
