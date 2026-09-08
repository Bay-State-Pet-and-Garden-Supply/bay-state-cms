/**
 * URL-namespace regression tests for the linear shell selector.
 *
 * The app shell owns `view` for top-level routing, so EVERY production batch
 * URL carries `?view=onboarding&batch=…`. The shell's own view selector MUST
 * live in a separate namespace (`wview`); sharing `view` made every batch
 * page parse as conflicting/unknown and silently broke stage + legacy-tab
 * resolution (the 650-case matrix only ever fed abstract inputs, never
 * production-shape URLs — this file closes that hole).
 */
import { describe, it, expect } from 'vitest';
import { parseWorkspaceSelection, resolveLegacyTabDestination } from '../../client/components/onboarding/linear-workspace-logic';

describe('production-shape URLs (app view=onboarding always present)', () => {
  it('plain batch URL resolves to the default stage, never unsupported', () => {
    const selection = parseWorkspaceSelection('?view=onboarding&batch=batch-1');
    expect(selection).toEqual({ kind: 'legacy', rawTab: null });
    // No selectors: the shell falls through to the default first stage.
    expect(resolveLegacyTabDestination(selection.kind === 'legacy' ? selection.rawTab : 'invalid')).toEqual({
      kind: 'stage',
      stage: 'route_sources',
    });
  });

  it('legacy ?tab=review resolves to the review operation destination', () => {
    expect(parseWorkspaceSelection('?view=onboarding&batch=batch-1&tab=review')).toEqual({
      kind: 'legacy',
      rawTab: 'review',
    });
  });

  it('versioned stage links resolve under the app view param', () => {
    expect(
      parseWorkspaceSelection('?view=onboarding&batch=batch-1&stage=find_product_page&stageVersion=2'),
    ).toEqual({ kind: 'stage', stage: 'find_product_page' });
  });

  it('brand-setup travels in the shell namespace, app view intact', () => {
    expect(
      parseWorkspaceSelection('?view=onboarding&batch=batch-1&wview=brand-setup'),
    ).toEqual({ kind: 'brand-setup' });
  });

  it('genuine shell conflicts still report unsupported', () => {
    const r = parseWorkspaceSelection(
      '?view=onboarding&batch=batch-1&stage=find_product_page&stageVersion=2&wview=brand-setup',
    );
    expect(r.kind).toBe('unsupported');
  });

  it('other app sections never leak into shell selection', () => {
    const selection = parseWorkspaceSelection('?view=dashboard');
    expect(selection).toEqual({ kind: 'legacy', rawTab: null });
    expect(resolveLegacyTabDestination(selection.kind === 'legacy' ? selection.rawTab : 'invalid')).toEqual({
      kind: 'stage',
      stage: 'route_sources',
    });
  });
});
