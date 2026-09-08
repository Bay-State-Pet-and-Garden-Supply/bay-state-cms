/**
 * Slice 2 — preparation-read suite (Bun).
 *
 * Exercises the read-only preparation presentation contracts under the Bun
 * runner: the five-section summary stays exactly five fixed sections with
 * bounded reasons, unavailable states are never completion, the six-stage
 * order is intact, and outcome routing stays truthful (skipped never
 * Approved, completed never Ready-to-Export). Pure modules only — no DOM, no
 * DB, no network, no worker side effects.
 */
import { describe, it, expect } from 'bun:test';
import { StageStatusEnum } from '../../shared/schemas/onboarding';
import {
  PreparationSummarySchema,
  PREPARATION_SECTION_KEYS,
} from '../../shared/schemas/onboarding-preparation';
import {
  buildUnavailablePreparationSummary,
  isPreparationSummaryEmpty,
} from '../../client/components/onboarding/prepare-listing-logic';
import {
  LINEAR_STAGE_ORDER,
  LINEAR_STAGES,
  resolveLegacyTabDestination,
} from '../../client/components/onboarding/linear-workspace-logic';
import { workspaceTabForCategory } from '../../client/components/onboarding/batch-workspace-logic';

describe('preparation summary (read-only display contract)', () => {
  it('keeps exactly five fixed sections with bounded reasons', () => {
    const summary = buildUnavailablePreparationSummary();
    expect(summary.sections.map((s) => s.key)).toEqual([...PREPARATION_SECTION_KEYS]);
    const parsed = PreparationSummarySchema.safeParse(summary);
    expect(parsed.success).toBe(true);
    for (const section of summary.sections) {
      expect((section.reason ?? '').length).toBeLessThanOrEqual(160);
    }
  });

  it('never confers approval or completion from unavailable states', () => {
    expect(isPreparationSummaryEmpty(buildUnavailablePreparationSummary())).toBe(true);
    const text = JSON.stringify(buildUnavailablePreparationSummary());
    expect(text).not.toContain('approved');
    expect(text).not.toContain('5/5');
  });

  it('keeps six execution stages in order (sections are not stages)', () => {
    expect(LINEAR_STAGE_ORDER).toHaveLength(6);
    expect(LINEAR_STAGES).toHaveLength(6);
    expect(PREPARATION_SECTION_KEYS).toHaveLength(5);
    for (const key of PREPARATION_SECTION_KEYS) {
      expect(LINEAR_STAGE_ORDER).not.toContain(key);
    }
  });

  it('leaves StageStatus byte-identical (six statuses, order preserved)', () => {
    expect(StageStatusEnum.options).toEqual([
      'pending',
      'in_progress',
      'completed',
      'failed',
      'needs_input',
      'skipped',
    ]);
  });
});

describe('truthful outcome routing (both flag states)', () => {
  it('skipped never opens Approved; completed never joins Ready-to-Export', () => {
    expect(workspaceTabForCategory('skipped')).toBeNull();
    expect(workspaceTabForCategory('completed')).toBeNull();
    expect(resolveLegacyTabDestination('skipped')).toEqual({ kind: 'outcome', outcome: 'skipped' });
    expect(resolveLegacyTabDestination('completed')).toEqual({ kind: 'outcome', outcome: 'completed' });
  });

  it('legacy review resolves to the whole-batch operation without inheriting stage filters', () => {
    expect(resolveLegacyTabDestination('review')).toEqual({ kind: 'operation', view: 'review' });
    expect(resolveLegacyTabDestination(null)).toEqual({ kind: 'stage', stage: 'route_sources' });
  });
});
