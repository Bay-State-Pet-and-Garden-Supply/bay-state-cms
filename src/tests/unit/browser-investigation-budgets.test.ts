// T3 (#227) — investigation budget ledger + pre-launch preview (Vitest, pure).
//
// Action, byte, token, image, artifact, and request-attempt budgets are shown
// before launch (describeInvestigationBudget) and enforced live at the
// broker/capture/dispatch layers (BudgetLedger). Oversized charges stop with
// `budget_exhausted` — they never grow the budget.

import { describe, it, expect } from 'vitest';
import {
  describeInvestigationBudget,
  resolveInvestigationBudget,
  type InvestigationBudgetRow,
} from '../../shared/schemas/browser-investigation';
import {
  BudgetLedger,
  InvestigationBudgetError,
  emptyConsumption,
  isExtendedUsageWithinBudget,
  type BudgetConsumption,
  type ExtendedUsageCounters,
} from '../../onboarding/browser-investigation/budgets';

describe('pre-launch budget preview', () => {
  it('starts every run ledger at zero consumption', () => {
    const zero: BudgetConsumption = emptyConsumption();
    expect(zero).toEqual({
      requestAttempts: 0,
      responseBytesTransferred: 0,
      responseBytesDecompressed: 0,
      artifactsRetainedBytes: 0,
      artifactsCount: 0,
      modelInputBytesTotal: 0,
      modelOutputTokensTotal: 0,
      imageAttachmentsTotal: 0,
    });
  });

  it('shows action, byte, token, image, artifact, and request budgets', () => {
    const rows: InvestigationBudgetRow[] = describeInvestigationBudget(resolveInvestigationBudget());
    const keys = rows.map((r) => r.key);
    for (const key of [
      'maxPages',
      'maxReads',
      'maxModelCalls',
      'timeoutMs',
      'maxCostUsd',
      'maxResponseBytesPerResponse',
      'maxTotalResponseBytes',
      'maxRequestAttempts',
      'maxArtifactBytes',
      'maxObservationBytesPerOperation',
      'maxModelInputBytes',
      'maxModelOutputTokensPerCall',
      'maxImages',
      'maxQuery',
      'maxRedirectHops',
    ]) {
      expect(keys, key).toContain(key);
    }
    expect(rows.find((r) => r.key === 'maxCostUsd')!.value).toBe('none requested');
    expect(rows.find((r) => r.key === 'maxCostUsd')!.label).toBeTruthy();
  });

  it('renders requested ceilings and lowered overrides', () => {
    const rows = describeInvestigationBudget(
      resolveInvestigationBudget({ maxCostUsd: 2.5, maxPages: 3 }),
    );
    expect(rows.find((r) => r.key === 'maxCostUsd')!.value).toBe('$2.5');
    expect(rows.find((r) => r.key === 'maxPages')!.value).toBe('up to 3');
  });

  it('budget overrides may lower caps but never raise them', () => {
    expect(() => resolveInvestigationBudget({ maxPages: 6 })).toThrow();
    expect(() => resolveInvestigationBudget({ maxRequestAttempts: 501 })).toThrow();
    expect(() =>
      resolveInvestigationBudget({ maxResponseBytesPerResponse: 6 * 1024 * 1024 }),
    ).toThrow();
    expect(resolveInvestigationBudget({ maxRequestAttempts: 10 }).maxRequestAttempts).toBe(10);
  });
});

describe('budget ledger enforcement', () => {
  it('charges request attempts including denied ones, then stops', () => {
    const ledger = new BudgetLedger(resolveInvestigationBudget({ maxRequestAttempts: 2 }));
    ledger.chargeRequestAttempt();
    ledger.chargeRequestAttempt();
    try {
      ledger.chargeRequestAttempt();
      expect.unreachable('third attempt must stop');
    } catch (err) {
      expect(err).toBeInstanceOf(InvestigationBudgetError);
      expect((err as InvestigationBudgetError).code).toBe('budget_exhausted');
    }
    const consumed: BudgetConsumption = ledger.snapshot();
    expect(consumed.requestAttempts).toBe(2);
  });

  it('stops oversized and over-total response bodies', () => {
    const ledger = new BudgetLedger(
      resolveInvestigationBudget({ maxResponseBytesPerResponse: 2048, maxTotalResponseBytesTransferred: 3000 }),
    );
    ledger.chargeResponseBytes(1024);
    expect(() => ledger.chargeResponseBytes(2049)).toThrowError(/per-response/);
    ledger.chargeResponseBytes(1024);
    expect(() => ledger.chargeResponseBytes(1024)).toThrowError(/total/);
    expect(() => ledger.assertDeclaredLengthOk(999_999_999)).toThrowError(/Content-Length/);
    // Both transferred and decompressed ledgers move together.
    expect(ledger.snapshot().responseBytesTransferred).toBe(2048);
    expect(ledger.snapshot().responseBytesDecompressed).toBe(2048);
  });

  it('caps retained artifacts per artifact and in total', () => {
    const ledger = new BudgetLedger(
      resolveInvestigationBudget({ maxArtifactBytesPerArtifact: 2048, maxArtifactBytesTotal: 3000 }),
    );
    ledger.chargeArtifact(2048);
    expect(() => ledger.chargeArtifact(2049)).toThrowError(/per-artifact/);
    expect(() => ledger.chargeArtifact(1024)).toThrowError(/total/);
  });

  it('caps model input per call and cumulatively', () => {
    const ledger = new BudgetLedger(
      resolveInvestigationBudget({ maxModelInputBytesPerCall: 2048, maxModelInputBytesTotal: 3000 }),
    );
    expect(() => ledger.chargeModelInput(2049)).toThrowError(/per-call/);
    ledger.chargeModelInput(2000);
    expect(() => ledger.chargeModelInput(1500)).toThrowError(/cumulative/);
  });

  it('caps model output tokens and result bytes', () => {
    const ledger = new BudgetLedger(resolveInvestigationBudget({}));
    expect(() => ledger.chargeModelOutput(4097, 10)).toThrowError(/tokens/);
    expect(() => ledger.chargeModelOutput(10, 33 * 1024)).toThrowError(/result/);
    ledger.chargeModelOutput(100, 1024);
    expect(ledger.snapshot().modelOutputTokensTotal).toBe(100);
  });

  it('denies images without explicit image-sharing permission (default-deny)', () => {
    const gated = new BudgetLedger(resolveInvestigationBudget({ maxImageAttachmentsTotal: 2 }));
    expect(gated.effectiveImageCap()).toBe(0);
    expect(() => gated.chargeImageAttachment(1024, 100)).toThrowError(/not permitted/);
    gated.setImageSharingAllowed(true);
    expect(gated.effectiveImageCap()).toBe(2);
    gated.chargeImageAttachment(1024, 800);
    expect(gated.snapshot().imageAttachmentsTotal).toBe(1);
  });

  it('forbids images at zero cap; re-sends consume attachments', () => {
    const none = new BudgetLedger(resolveInvestigationBudget({ maxImageAttachmentsTotal: 0 }));
    none.setImageSharingAllowed(true);
    expect(() => none.chargeImageAttachment(1024, 100)).toThrowError(/not permitted/);
    const two = new BudgetLedger(resolveInvestigationBudget({ maxImageAttachmentsTotal: 2 }));
    two.setImageSharingAllowed(true);
    two.chargeImageAttachment(1024, 800);
    two.chargeImageAttachment(1024, 800);
    expect(() => two.chargeImageAttachment(1024, 800)).toThrowError(/would exceed/);
    const sized = new BudgetLedger(resolveInvestigationBudget({}));
    sized.setImageSharingAllowed(true);
    expect(() => sized.chargeImageAttachment(600 * 1024, 100)).toThrowError(/per-image/);
    expect(() => sized.chargeImageAttachment(1024, 2048)).toThrowError(/longest edge/);
  });
});

describe('extended usage post-hoc check', () => {
  it('accepts absent usage and rejects overruns', () => {
    const budget = resolveInvestigationBudget({ maxRequestAttempts: 5 });
    expect(isExtendedUsageWithinBudget(null, budget)).toBe(true);
    const within: ExtendedUsageCounters = { requestAttempts: 5 };
    expect(isExtendedUsageWithinBudget(within, budget)).toBe(true);
    const overAttempts: ExtendedUsageCounters = { requestAttempts: 6 };
    expect(isExtendedUsageWithinBudget(overAttempts, budget)).toBe(false);
    const overBytes: ExtendedUsageCounters = {
      responseBytesTransferred: budget.maxTotalResponseBytesTransferred + 1,
    };
    expect(isExtendedUsageWithinBudget(overBytes, budget)).toBe(false);
    const overImages: ExtendedUsageCounters = {
      imageAttachmentsTotal: budget.maxImageAttachmentsTotal + 1,
    };
    expect(isExtendedUsageWithinBudget(overImages, budget)).toBe(false);
  });
});
