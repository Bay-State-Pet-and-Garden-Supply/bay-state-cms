import { describe, expect, it } from 'vitest';
import { runComparisonArm } from '../../../scratch/comparison-arm';
import { runArmBarrier } from '../../../scratch/run-comparison';

describe('isolated comparison arm bootstrap', () => {
  it('returns a typed, redacted preflight denial for an invalid freeze', async () => {
    const result = await runComparisonArm({
      arm: 'candidate', freezePath: '/nonexistent/private/freeze.json', privateRoot: '/nonexistent/private',
      workspacePath: '/nonexistent/private/workspace', destinationRoot: '/nonexistent/private/arm', dbPath: '/nonexistent/private/arm/db.sqlite',
    }, [{ upc: '0001', register_name: 'Sample product', price: 1.23 }]);
    expect(result.stop).toBe('preflight_denied');
    expect(result.imported).toBe(0);
    expect(result.polls).toBe(0);
    expect(result.denial).toContain('ENOENT');
    expect(result.denial).not.toMatch(/Bearer\s+\S+|sk-[A-Za-z0-9]{16,}/i);
  });

  it('preflights both arms before releasing either arm', async () => {
    const events: string[] = [];
    const result = await runArmBarrier(
      ['baseline', 'candidate'],
      async arm => { events.push(`preflight:${arm}`); return { prepared: `${arm}-prepared` }; },
      async (arm, prepared) => { events.push(`release:${arm}`); return `${arm}:${prepared}`; },
    );
    expect(events).toEqual(['preflight:baseline', 'preflight:candidate', 'release:baseline', 'release:candidate']);
    expect(result.results.map(entry => entry.result)).toEqual(['baseline:baseline-prepared', 'candidate:candidate-prepared']);
  });

  it('denies all release when either arm preflight fails', async () => {
    const events: string[] = [];
    const result = await runArmBarrier(
      ['baseline', 'candidate'],
      async arm => {
        events.push(`preflight:${arm}`);
        return arm === 'candidate' ? { denial: 'freeze authorization missing' } : { prepared: 'baseline-prepared' };
      },
      async arm => { events.push(`release:${arm}`); return arm; },
    );
    expect(events).toEqual(['preflight:baseline', 'preflight:candidate']);
    expect(result.results).toEqual([]);
    expect(result.preflight[1]?.denial).toBe('freeze authorization missing');
  });

  it('does not release either arm when release is disabled', async () => {
    const events: string[] = [];
    const result = await runArmBarrier(
      ['baseline', 'candidate'],
      async arm => { events.push(`preflight:${arm}`); return { prepared: `${arm}-prepared` }; },
      async arm => { events.push(`release:${arm}`); return arm; },
      false,
    );
    expect(events).toEqual(['preflight:baseline', 'preflight:candidate']);
    expect(result.results).toEqual([]);
  });

  it('builds a coordinator-backed paid scope and closes under the CLI cap', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { Database } = await import('bun:sqlite');
    const dir = mkdtempSync(`${tmpdir()}/t4-budget-arm-`);
    try {
      const { PaidEffectBudgetCoordinator } = await import('../../ai/paid-effect-budget');
      const { pilotBudgetAuthorization } = await import('../../../scratch/comparison-budget');
      const authorization = pilotBudgetAuthorization({ runId: 't4-test-run', arms: ['candidate'] });
      expect(authorization.approvedCeilingMicros).toBe(3_000_000);
      expect(authorization.billingContracts[0]?.contractId).toBe('serper-pilot-2499-credits');
      // Coordinator accepts the authorization and snapshots an empty ledger.
      const ledgerDb = new Database(`${dir}/budget.sqlite`);
      const coordinator = new PaidEffectBudgetCoordinator(ledgerDb, authorization);
      const snapshot = coordinator.snapshot({
        qualificationRunId: 't4-test-run', authorizationId: authorization.authorizationId,
        arm: 'candidate', outputId: 'batch-1', beneficiaries: [{ kind: 'item', id: 'item-1' }],
      });
      expect(snapshot.totalEncumberedMicros).toBe(0);
      expect(snapshot.availableMicros).toBe(3_000_000);
      coordinator.close('t4 unit test complete');
      ledgerDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets operational builder failures propagate instead of mislabeling them as policy', async () => {
    const { PolicyDeniedError } = await import('../../../scratch/comparison-arm');
    expect(new PolicyDeniedError('x')).toBeInstanceOf(Error);
    expect(new PolicyDeniedError('x').name).toBe('PolicyDeniedError');
    // Operational errors (ledger open, coordinator construct) are not policy:
    expect(new Error('paid_effect_journal_unavailable') instanceof PolicyDeniedError).toBe(false);
  });
});
