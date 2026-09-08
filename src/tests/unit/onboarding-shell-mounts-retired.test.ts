// @vitest-environment node
/**
 * Slice 6 — §7.1 mounts-retired mount matrix (pure, node env).
 *
 * Every ledger row in `src/tests/fixtures/onboarding-shell-matrix-retired.json`
 * (640 factored W/D/Q × S/B/E × T cases + brand-setup/unsupported extras) is
 * asserted against the production resolver `resolveRetiredShell`. The ledger
 * was expanded mechanically from Tables A (mounts-retired column) / B / C —
 * never by calling the resolver. This file imports NO component or schema
 * modules.
 *
 * Slice 6 contract under test: BatchWorkspace is the sole shell (root is
 * ALWAYS BatchWorkspace; retired W/D switches are ignored); an explicit
 * `?board=pipeline` query resolves to the shell with a `retired-diagnostics`
 * notice; Tables B (content/features) and C (legacy destinations) apply
 * unchanged inside the shell. No PipelineBoard import/mount exists.
 */
import { describe, it, expect } from 'vitest';
import matrix from '../fixtures/onboarding-shell-matrix-retired.json';
import {
  resolveRetiredShell,
  type ShellMatrixInput,
} from '../../client/components/onboarding/linear-workspace-logic';

type FixtureCase = {
  phase: string;
  input: ShellMatrixInput;
  expected: ReturnType<typeof resolveRetiredShell>;
};

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

describe('§7.1 mounts-retired matrix (full ledger)', () => {
  const cases = (matrix as { count: number; phase: string; cases: FixtureCase[] }).cases;

  it('publishes the fully expanded retired ledger (656 cases: 640 factored + 16 extras)', () => {
    expect((matrix as { phase: string }).phase).toBe('mounts-retired');
    expect(cases.length).toBe(656);
    expect(cases.every((c) => c.phase === 'mounts-retired')).toBe(true);
    const factored = cases.filter(
      (c) => !c.input.brandSetupView && !c.input.unsupportedSelector,
    );
    expect(factored.length).toBe(640);
  });

  it('every ledger row matches the production resolver (root/notice/content/brand/strip/destination)', () => {
    const failures: string[] = [];
    for (const c of cases) {
      const actual = resolveRetiredShell(c.input);
      if (!deepEqual(actual, c.expected)) {
        failures.push(
          `${JSON.stringify(c.input)} => expected ${JSON.stringify(c.expected)} got ${JSON.stringify(actual)}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('root is ALWAYS BatchWorkspace: retired W/D switches are ignored (all 8 W/D/Q rows)', () => {
    for (const w of [false, true]) {
      for (const d of [false, true]) {
        for (const q of [false, true]) {
          const r = resolveRetiredShell({
            workspaceEnabled: w,
            shellV2Enabled: true,
            brandGateV2Enabled: true,
            executionStripV2Enabled: true,
            diagnosticsEnabled: d,
            boardQuery: q,
            legacyTab: 'absent',
            brandSetupView: false,
            stageSelector: null,
            unsupportedSelector: false,
          });
          expect(r.root).toBe('BatchWorkspace');
          expect(r.root).not.toBe('PipelineBoard');
          expect(r.root).not.toBe('Unavailable');
        }
      }
    }
  });

  it('mandatory edge: shell-OFF+brand-ON never mounts the new brand view', () => {
    for (const e of [false, true]) {
      const r = resolveRetiredShell({
        workspaceEnabled: true,
        shellV2Enabled: false,
        brandGateV2Enabled: true,
        executionStripV2Enabled: e,
        diagnosticsEnabled: false,
        boardQuery: false,
        legacyTab: 'absent',
        brandSetupView: true,
        stageSelector: null,
        unsupportedSelector: false,
      });
      expect(r.brandSetupAvailable).toBe(false);
      expect(r.destination).toEqual({ kind: 'brand-setup', mounted: false });
      expect(r.content).toBe('classic');
    }
  });

  it('mandatory edge: workspace-OFF+diagnostics-ON without query never mounts a board (shell, no notice)', () => {
    const r = resolveRetiredShell({
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
    expect(r.root).toBe('BatchWorkspace');
    expect(r.notice).toBe('none');
  });

  it('mandatory edge: diagnostics URL post-change resolves to shell + retirement notice (all W/D)', () => {
    for (const w of [false, true]) {
      for (const d of [false, true]) {
        const r = resolveRetiredShell({
          workspaceEnabled: w,
          shellV2Enabled: true,
          brandGateV2Enabled: false,
          executionStripV2Enabled: false,
          diagnosticsEnabled: d,
          boardQuery: true,
          legacyTab: 'absent',
          brandSetupView: false,
          stageSelector: null,
          unsupportedSelector: false,
        });
        expect(r.root).toBe('BatchWorkspace');
        expect(r.notice).toBe('retired-diagnostics');
      }
    }
  });

  it('view=brand-setup mounts the single brand view exactly when S+B are on (all 8 S/B/E rows)', () => {
    for (const s of [false, true]) {
      for (const b of [false, true]) {
        for (const e of [false, true]) {
          const r = resolveRetiredShell({
            workspaceEnabled: true,
            shellV2Enabled: s,
            brandGateV2Enabled: b,
            executionStripV2Enabled: e,
            diagnosticsEnabled: false,
            boardQuery: false,
            legacyTab: 'absent',
            brandSetupView: true,
            stageSelector: null,
            unsupportedSelector: false,
          });
          expect(r.brandSetupAvailable).toBe(s && b);
          expect(r.destination).toEqual({ kind: 'brand-setup', mounted: s && b });
          // Never a seventh stage: content stays linear/classic, strip follows S+E.
          expect(r.content).toBe(s ? 'linear' : 'classic');
          expect(r.stripMounted).toBe(s && e);
        }
      }
    }
  });

  it('legacy ?tab= deep links resolve to operation/outcome destinations in the sole shell (Table C)', () => {
    const expectations: Array<{ tab: ShellMatrixInput['legacyTab']; dest: unknown }> = [
      { tab: 'needs_attention', dest: { kind: 'operation', view: 'attention' } },
      { tab: 'processing', dest: { kind: 'operation', view: 'processing' } },
      { tab: 'waiting_on_family', dest: { kind: 'operation', view: 'family' } },
      { tab: 'review', dest: { kind: 'operation', view: 'review' } },
      { tab: 'approved', dest: { kind: 'operation', view: 'approved' } },
      { tab: 'ready_to_export', dest: { kind: 'operation', view: 'export' } },
      { tab: 'completed', dest: { kind: 'outcome', outcome: 'completed' } },
      { tab: 'skipped', dest: { kind: 'outcome', outcome: 'skipped' } },
      { tab: 'absent', dest: { kind: 'stage', stage: 'route_sources' } },
      { tab: 'invalid', dest: { kind: 'unsupported', fallback: 'stage' } },
    ];
    for (const { tab, dest } of expectations) {
      const r = resolveRetiredShell({
        workspaceEnabled: true,
        shellV2Enabled: true,
        brandGateV2Enabled: true,
        executionStripV2Enabled: true,
        diagnosticsEnabled: false,
        boardQuery: false,
        legacyTab: tab,
        brandSetupView: false,
        stageSelector: null,
        unsupportedSelector: false,
      });
      expect(r.root).toBe('BatchWorkspace');
      expect(r.destination).toEqual(dest);
    }
  });

  it('opposite-order runs yield the same mounts (reset isolation spot check)', () => {
    const a = resolveRetiredShell({
      workspaceEnabled: false, shellV2Enabled: true, brandGateV2Enabled: true,
      executionStripV2Enabled: true, diagnosticsEnabled: true, boardQuery: true,
      legacyTab: 'review', brandSetupView: false, stageSelector: null, unsupportedSelector: false,
    });
    expect(a).toEqual({
      root: 'BatchWorkspace', notice: 'retired-diagnostics', content: 'linear',
      brandSetupAvailable: true, stripMounted: true,
      destination: { kind: 'operation', view: 'review' },
    });
  });
});
