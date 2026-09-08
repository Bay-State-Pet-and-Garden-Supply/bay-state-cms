/**
 * Cohort execution lease — scoped ownership-guarded renewal (Slice 1).
 *
 * Parent runs own the lease (15-minute default TTL, `max(1, floor(TTL / 3))`
 * scoped renewal cadence). A lost owner raises `HeartbeatLostError` and
 * performs no further writes. Timers stop in `finally` on every path.
 *
 * Relocated verbatim from `src/onboarding/cohort-lease-keeper.ts` (Slice 1);
 * that module re-exports it as a temporary forwarder (deleted in Slice 6).
 * Private implementation detail of the cohort-curation package, not a new
 * public service.
 */
import { heartbeatCohortRun } from '../../db/repositories/classification-cohort-run-repo';
import { HeartbeatLostError } from '../../classification/heartbeat-errors';

export class CohortLeaseKeeper {
  private readonly runId: string;
  private readonly workerId: string;
  private readonly leaseTtlMs: number;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private lost = false;

  constructor(runId: string, workerId: string, leaseTtlMs: number) {
    this.runId = runId;
    this.workerId = workerId;
    this.leaseTtlMs = leaseTtlMs;
    this.intervalMs = Math.max(1, Math.floor(leaseTtlMs / 3));
  }

  /** Start the periodic renewal; the wrapped operation always begins with a
   *  freshly asserted lease. Idempotent. PR3 hardening C: the INITIAL renewal
   *  runs BEFORE the timer is installed and a rejected renewal throws
   *  `HeartbeatLostError` IMMEDIATELY — callers must never begin OCR/pipeline
   *  side effects after ownership is already known lost. */
  start(): this {
    if (this.timer) return this;
    // Renew BEFORE installing the timer: if the run is no longer claimed by
    // us (a sibling reclaimed it, or it went terminal/superseded), ownership
    // is already lost — throw before any side effect begins.
    if (!this.renew()) {
      this.lost = true;
      throw new HeartbeatLostError(
        `Claim ownership already lost at operation start (run ${this.runId} is no longer claimed by ${this.workerId}).`,
      );
    }
    this.timer = setInterval(() => {
      this.renew();
    }, this.intervalMs);
    return this;
  }

  /** Attempt one lease renewal. Marks `lost` on rejection. */
  renew(): boolean {
    if (this.stopped || this.lost) return false;
    const held = heartbeatCohortRun(this.runId, this.workerId, this.leaseTtlMs);
    if (!held) this.lost = true;
    return held;
  }

  /**
   * Ownership assertion for a continuation write. Throws `HeartbeatLostError`
   * when the lease was lost — including a loss that happened between renewal
   * ticks (this is an immediate ownership re-assertion, never a flag-only
   * check), so NO write can occur after the claim moved to another worker.
   */
  assertHeld(): void {
    if (this.lost || !this.renew()) {
      throw new HeartbeatLostError(
        `Claim ownership lost during a long-running operation (run ${this.runId} is no longer claimed by ${this.workerId}).`,
      );
    }
  }

  /** Clear the renewal timer (always called from the operation's `finally`). */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
