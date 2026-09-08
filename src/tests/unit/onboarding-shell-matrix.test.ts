/**
 * Slice 2 — §7.1 P0 pre-retirement mount matrix (pure, node env).
 *
 * Every ledger row in `src/tests/fixtures/onboarding-shell-matrix.json`
 * (640 factored W/D/Q × S/B/E × T cases + brand-setup/unsupported extras)
 * is asserted against the production resolver `resolveLinearShell`. The
 * ledger was expanded mechanically from Tables A/B/C — never by calling
 * the resolver. This file imports NO component or schema modules so it
 * stays collectible under the current vite-node/zod toolchain breakage
 * (see the packet); component mounts live in onboarding-linear-shell.test.tsx
 * and are verified in the live browser until the toolchain is repaired.
 */
import { describe, it, expect } from 'vitest';
import matrix from '../fixtures/onboarding-shell-matrix.json';
import {
  resolveLinearShell,
  LINEAR_STAGES,
  type ShellMatrixInput,
} from '../../client/components/onboarding/linear-workspace-logic';

type FixtureCase = {
  phase: string;
  input: ShellMatrixInput;
  expected: ReturnType<typeof resolveLinearShell>;
};

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

describe('§7.1 pre-retirement mount matrix (full ledger)', () => {
  const cases = (matrix as { count: number; cases: FixtureCase[] }).cases;

  it('publishes the fully expanded ledger (650 cases: 640 factored + extras)', () => {
    expect(cases.length).toBe(650);
    const factored = cases.filter(
      (c) => !c.input.brandSetupView && !c.input.unsupportedSelector,
    );
    expect(factored.length).toBe(640);
    // Six stage tabs, exact order and labels (plan §2).
    expect(LINEAR_STAGES.map((s) => s.id)).toEqual([
      'route_sources',
      'find_product_page',
      'collect_details',
      'prepare_listing',
      'review_listings',
      'create_drafts',
    ]);
    expect(LINEAR_STAGES.map((s) => s.label)).toEqual([
      'Identify & Route Sources',
      'Find product page',
      'Collect details',
      'Prepare listing',
      'Review listings',
      'Create drafts',
    ]);
  });

  it('every ledger row matches the production resolver (root/notice/content/brand/strip/destination)', () => {
    const failures: string[] = [];
    for (const c of cases) {
      const actual = resolveLinearShell(c.input);
      if (!deepEqual(actual, c.expected)) {
        failures.push(
          `${JSON.stringify(c.input)} => expected ${JSON.stringify(c.expected)} got ${JSON.stringify(actual)}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('mandatory edge: shell-OFF+brand-ON never mounts the new brand view', () => {
    for (const e of [0, 1]) {
      const r = resolveLinearShell({
        workspaceEnabled: true,
        shellV2Enabled: false,
        brandGateV2Enabled: true,
        executionStripV2Enabled: Boolean(e),
        diagnosticsEnabled: false,
        boardQuery: false,
        legacyTab: 'absent',
        brandSetupView: true,
        stageSelector: null,
        unsupportedSelector: false,
      });
      expect(r.brandSetupAvailable).toBe(false);
      expect(r.destination).toEqual({ kind: 'brand-setup', mounted: false });
    }
  });

  it('mandatory edge: workspace-OFF+diagnostics-ON without query never mounts PipelineBoard', () => {
    const r = resolveLinearShell({
      workspaceEnabled: false,
      shellV2Enabled: true,
      brandGateV2Enabled: false,
      executionStripV2Enabled: false,
      diagnosticsEnabled: true,
      boardQuery: false,
      legacyTab: 'absent',
      brandSetupView: false,
      stageSelector: null,
      unsupportedSelector: false,
    });
    expect(r.root).toBe('Unavailable');
    expect(r.root).not.toBe('PipelineBoard');
  });

  it('mandatory edge: diagnostics query without the flag resolves to shell + notice', () => {
    const r = resolveLinearShell({
      workspaceEnabled: true,
      shellV2Enabled: true,
      brandGateV2Enabled: false,
      executionStripV2Enabled: false,
      diagnosticsEnabled: false,
      boardQuery: true,
      legacyTab: 'absent',
      brandSetupView: false,
      stageSelector: null,
      unsupportedSelector: false,
    });
    expect(r.root).toBe('BatchWorkspace');
    expect(r.notice).toBe('diagnostics-disabled');
  });

  it('opposite-order runs yield the same mounts (reset isolation spot check)', () => {
    const a = resolveLinearShell({
      workspaceEnabled: true, shellV2Enabled: true, brandGateV2Enabled: true,
      executionStripV2Enabled: true, diagnosticsEnabled: true, boardQuery: false,
      legacyTab: 'review', brandSetupView: false, stageSelector: null, unsupportedSelector: false,
    });
    expect(a).toEqual({
      root: 'BatchWorkspace', notice: 'none', content: 'linear',
      brandSetupAvailable: true, stripMounted: true,
      destination: { kind: 'operation', view: 'review' },
    });
  });
});
