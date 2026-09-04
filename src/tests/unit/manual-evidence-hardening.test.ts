// Ticket #105 (parent #101) — fail-closed hardening, pure lane (no sqlite).
// Runs under vitest.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MANUAL_EVIDENCE_ACTIVE_RETRY_CODE } from '../../onboarding/manual-evidence-eligibility';

const SRC_ROOT = join(__dirname, '..', '..', '..');

const SKIP_DIRS = new Set(['tests', 'node_modules', 'dist', '.git']);

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      listSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('hardening: the automated worker can never write manual rows', () => {
  it('only the operator route (plus the module itself and tests) references the manual-evidence service', () => {
    const allowed = new Set([
      'src/server/routes/onboarding-work-routes.ts',
      'src/server/routes/onboarding-routes.ts',
      'src/onboarding/manual-evidence-service.ts',
      'src/onboarding/manual-evidence-eligibility.ts',
    ]);
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const rel = file.replace(/\\/g, '/').split('bay-state-cms/').pop() ?? file;
      if (rel.startsWith('src/tests/')) continue;
      if (allowed.has(rel)) continue;
      const content = readFileSync(file, 'utf8');
      if (content.includes('manual-evidence-service')) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('neither the job queue nor the automated extractor references the service', () => {
    for (const rel of ['src/onboarding/job-queue.ts', 'src/onboarding/page-extractor.ts']) {
      const content = readFileSync(join(SRC_ROOT, rel), 'utf8');
      expect(content).not.toContain('manual-evidence-service');
      expect(content).not.toContain('submitManualEvidence');
    }
  });
});

describe('hardening: profile-retry guard code is stable', () => {
  it('exposes the documented retry-rejected code for the retry endpoint', () => {
    expect(MANUAL_EVIDENCE_ACTIVE_RETRY_CODE).toBe('manual_evidence_active_retry_rejected');
  });
});
