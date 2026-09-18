// Browser Investigation budget ledger (T3).
//
// Live enforcement for the resource budgets declared in the shared schema.
// The broker charges request attempts + response bytes here, the capture
// layer charges retained artifacts, and the dispatch layer charges
// model-payload bytes/tokens/images. Every charge throws `budget_exhausted`
// instead of silently growing the budget — an oversized response stops the
// run with a stable failure code, it never increases the caps.
//
// Pure (no DB, no network): Vitest-safe. The service consults
// `isExtendedUsageWithinBudget` when accepting provider completions so a
// completion that overruns any cap fails closed.

import type {
  InvestigationBudget,
  InvestigationUsage,
} from '../../shared/schemas/browser-investigation';

export class InvestigationBudgetError extends Error {
  readonly code = 'budget_exhausted' as const;
  constructor(message: string) {
    super(`budget_exhausted: ${message}`);
    this.name = 'InvestigationBudgetError';
  }
}

/** Mutable per-run consumption counters. */
export interface BudgetConsumption {
  requestAttempts: number;
  responseBytesTransferred: number;
  responseBytesDecompressed: number;
  artifactsRetainedBytes: number;
  artifactsCount: number;
  modelInputBytesTotal: number;
  modelOutputTokensTotal: number;
  imageAttachmentsTotal: number;
}

export function emptyConsumption(): BudgetConsumption {
  return {
    requestAttempts: 0,
    responseBytesTransferred: 0,
    responseBytesDecompressed: 0,
    artifactsRetainedBytes: 0,
    artifactsCount: 0,
    modelInputBytesTotal: 0,
    modelOutputTokensTotal: 0,
    imageAttachmentsTotal: 0,
  };
}

/**
 * Live ledger for one investigation run. Construct from the immutable
 * investigation budget; every mutating method enforces its cap before
 * recording consumption.
 *
 * Image exposure defaults to DENY: `setImageSharingAllowed(true)` must be
 * called explicitly when the investigation model policy permits image
 * sharing (`allowImageSharing`). Without it the effective image cap is
 * zero, per the design-doc image-permission contract.
 */
export class BudgetLedger {
  private readonly consumed = emptyConsumption();
  private imageSharingAllowed = false;

  constructor(private readonly budget: InvestigationBudget) {}

  /** Enable image attachments under the budget ceiling (explicit opt-in only). */
  setImageSharingAllowed(allowed: boolean): void {
    this.imageSharingAllowed = allowed;
  }

  /** Effective image cap: zero without image-sharing permission. */
  effectiveImageCap(): number {
    return this.imageSharingAllowed ? this.budget.maxImageAttachmentsTotal : 0;
  }

  snapshot(): BudgetConsumption {
    return { ...this.consumed };
  }

  toUsage(): InvestigationUsage {
    return {
      requestAttempts: this.consumed.requestAttempts,
      responseBytesTransferred: this.consumed.responseBytesTransferred,
      responseBytesDecompressed: this.consumed.responseBytesDecompressed,
      artifactsRetainedBytes: this.consumed.artifactsRetainedBytes,
      artifactsCount: this.consumed.artifactsCount,
      modelInputBytesTotal: this.consumed.modelInputBytesTotal,
      modelOutputTokensTotal: this.consumed.modelOutputTokensTotal,
      imageAttachmentsTotal: this.consumed.imageAttachmentsTotal,
      costUsd: null,
      costBasis: 'unavailable',
    };
  }

  /** Charge one broker request attempt (subresources, redirects, denied, retries all count). */
  chargeRequestAttempt(): void {
    if (this.consumed.requestAttempts + 1 > this.budget.maxRequestAttempts) {
      throw new InvestigationBudgetError(
        `request attempts would exceed ${this.budget.maxRequestAttempts}`,
      );
    }
    this.consumed.requestAttempts += 1;
  }

  /**
   * Charge streamed response bytes against the per-response cap and both
   * totals. Call incrementally while streaming — do not trust Content-Length.
   */
  chargeResponseBytes(byteLength: number): void {
    if (byteLength < 0 || !Number.isSafeInteger(byteLength)) {
      throw new InvestigationBudgetError('invalid byte charge');
    }
    if (byteLength > this.budget.maxResponseBytesPerResponse) {
      throw new InvestigationBudgetError(
        `single charge of ${byteLength} B exceeds per-response cap of ${this.budget.maxResponseBytesPerResponse} B`,
      );
    }
    // The broker requests `Accept-Encoding: identity`, so transferred and
    // decompressed bytes coincide; both ledgers are charged identically and
    // either cap stops the download.
    if (this.consumed.responseBytesTransferred + byteLength > this.budget.maxTotalResponseBytesTransferred) {
      throw new InvestigationBudgetError('total transferred response bytes would exceed budget');
    }
    if (this.consumed.responseBytesDecompressed + byteLength > this.budget.maxTotalResponseBytesDecompressed) {
      throw new InvestigationBudgetError('total decompressed response bytes would exceed budget');
    }
    this.consumed.responseBytesTransferred += byteLength;
    this.consumed.responseBytesDecompressed += byteLength;
  }

  /** Pre-check a declared Content-Length without trusting it (streaming caps still apply). */
  assertDeclaredLengthOk(declaredBytes: number): void {
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) return;
    if (declaredBytes > this.budget.maxResponseBytesPerResponse) {
      throw new InvestigationBudgetError(
        `declared Content-Length ${declaredBytes} B exceeds per-response cap`,
      );
    }
  }

  /** Charge one retained artifact (capture layer). */
  chargeArtifact(byteLength: number): void {
    if (byteLength > this.budget.maxArtifactBytesPerArtifact) {
      throw new InvestigationBudgetError(
        `artifact of ${byteLength} B exceeds per-artifact cap of ${this.budget.maxArtifactBytesPerArtifact} B`,
      );
    }
    if (this.consumed.artifactsRetainedBytes + byteLength > this.budget.maxArtifactBytesTotal) {
      throw new InvestigationBudgetError('total retained artifact bytes would exceed budget');
    }
    this.consumed.artifactsRetainedBytes += byteLength;
    this.consumed.artifactsCount += 1;
  }

  /** Charge one model-dispatch input payload (instructions + schemas + history included). */
  chargeModelInput(byteLength: number): void {
    if (byteLength > this.budget.maxModelInputBytesPerCall) {
      throw new InvestigationBudgetError(
        `model input of ${byteLength} B exceeds per-call cap of ${this.budget.maxModelInputBytesPerCall} B`,
      );
    }
    if (this.consumed.modelInputBytesTotal + byteLength > this.budget.maxModelInputBytesTotal) {
      throw new InvestigationBudgetError('cumulative model input would exceed budget');
    }
    this.consumed.modelInputBytesTotal += byteLength;
  }

  /** Charge accepted model output (tokens + structured-result bytes). */
  chargeModelOutput(outputTokens: number, resultBytes: number): void {
    if (outputTokens > this.budget.maxModelOutputTokensPerCall) {
      throw new InvestigationBudgetError(
        `model output of ${outputTokens} tokens exceeds per-call cap of ${this.budget.maxModelOutputTokensPerCall}`,
      );
    }
    if (resultBytes > this.budget.maxModelResultBytesPerCall) {
      throw new InvestigationBudgetError(
        `model result of ${resultBytes} B exceeds per-call cap of ${this.budget.maxModelResultBytesPerCall} B`,
      );
    }
    this.consumed.modelOutputTokensTotal += outputTokens;
  }

  /** Charge one image attachment (re-sends count again). Forbidden without image-sharing permission. */
  chargeImageAttachment(byteLength: number, longestEdgePx: number): void {
    const cap = this.effectiveImageCap();
    if (cap === 0) {
      throw new InvestigationBudgetError('image attachments are not permitted for this investigation');
    }
    if (this.consumed.imageAttachmentsTotal + 1 > cap) {
      throw new InvestigationBudgetError('image attachments would exceed budget');
    }
    if (byteLength > this.budget.maxImageBytesPerImage) {
      throw new InvestigationBudgetError(
        `image of ${byteLength} B exceeds per-image cap of ${this.budget.maxImageBytesPerImage} B`,
      );
    }
    if (longestEdgePx > this.budget.maxImageLongestEdgePx) {
      throw new InvestigationBudgetError(
        `image longest edge ${longestEdgePx}px exceeds cap of ${this.budget.maxImageLongestEdgePx}px`,
      );
    }
    this.consumed.imageAttachmentsTotal += 1;
  }
}

/** Provider-reported cumulative resource counters (all optional, post-hoc). */
export interface ExtendedUsageCounters {
  requestAttempts?: number;
  responseBytesTransferred?: number;
  responseBytesDecompressed?: number;
  artifactsRetainedBytes?: number;
  artifactsCount?: number;
  modelInputBytesTotal?: number;
  modelOutputTokensTotal?: number;
  imageAttachmentsTotal?: number;
}

/**
 * Post-hoc check for provider-reported usage: request attempts, transferred
 * and decompressed bytes, retained artifact bytes, cumulative model input,
 * and image attachments must each fit their cap. Two reported counters have
 * no independent caps by design and are telemetry only: `artifactsCount` is
 * bounded indirectly by the artifact byte totals, and
 * `modelOutputTokensTotal` by the per-call token cap times `maxModelCalls`.
 * The service ANDs this with its core action/time/cost check when accepting
 * completions.
 */
export function isExtendedUsageWithinBudget(
  usage: ExtendedUsageCounters | null | undefined,
  budget: InvestigationBudget,
): boolean {
  if (!usage) return true;
  const pairs: ReadonlyArray<readonly [number | undefined, number]> = [
    [usage.requestAttempts, budget.maxRequestAttempts],
    [usage.responseBytesTransferred, budget.maxTotalResponseBytesTransferred],
    [usage.responseBytesDecompressed, budget.maxTotalResponseBytesDecompressed],
    [usage.artifactsRetainedBytes, budget.maxArtifactBytesTotal],
    [usage.modelInputBytesTotal, budget.maxModelInputBytesTotal],
    [usage.imageAttachmentsTotal, budget.maxImageAttachmentsTotal],
  ];
  return pairs.every(([actual, cap]) => actual === undefined || actual <= cap);
}
