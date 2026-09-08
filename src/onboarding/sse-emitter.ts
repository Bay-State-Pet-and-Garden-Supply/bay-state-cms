/**
 * Server-Sent Events emitter for onboarding pipeline progress.
 * Uses a singleton EventTarget so any service can emit events
 * and any SSE connection can listen.
 */

export interface OnboardingEvent {
  type: 'item:status' | 'batch:progress' | 'batch:complete' | 'batch:error';
  batchId: string;
  itemId?: string;
  data: Record<string, unknown>;
}

class OnboardingEventBus {
  private listeners = new Map<string, Set<(event: OnboardingEvent) => void>>();

  /**
   * Subscribe to events for a specific batch.
   * Returns an unsubscribe function.
   */
  subscribe(batchId: string, handler: (event: OnboardingEvent) => void): () => void {
    if (!this.listeners.has(batchId)) {
      this.listeners.set(batchId, new Set());
    }
    this.listeners.get(batchId)!.add(handler);

    return () => {
      const set = this.listeners.get(batchId);
      if (set) {
        set.delete(handler);
        if (set.size === 0) this.listeners.delete(batchId);
      }
    };
  }

  /**
   * Emit an event to all listeners for the given batch.
   */
  emit(event: OnboardingEvent): void {
    const set = this.listeners.get(event.batchId);
    if (set) {
      for (const handler of set) {
        try {
          handler(event);
        } catch (err) {
          console.error('[SSE] Handler error:', err);
        }
      }
    }
  }

  /**
   * Emit an item status change event.
   */
  emitItemStatus(batchId: string, itemId: string, status: string, extra?: Record<string, unknown>): void {
    this.emit({
      type: 'item:status',
      batchId,
      itemId,
      data: { status, ...extra },
    });
  }

  /**
   * Emit a batch progress event (counters updated).
   */
  emitBatchProgress(batchId: string, completed: number, failed: number, total: number): void {
    this.emit({
      type: 'batch:progress',
      batchId,
      data: { completed, failed, total },
    });
  }

  /**
   * Emit a batch completion event.
   */
  emitBatchComplete(batchId: string, status: string): void {
    this.emit({
      type: 'batch:complete',
      batchId,
      data: { status },
    });
  }

  emitClassificationRefreshStarted(batchId: string, itemId: string, data: Record<string, unknown>): void {
    this.emit({
      type: 'item:status',
      batchId,
      itemId,
      data: { status: 'refresh_started', ...data },
    });
  }

  emitClassificationRefreshCompleted(batchId: string, itemId: string, data: Record<string, unknown>): void {
    this.emit({
      type: 'item:status',
      batchId,
      itemId,
      data: { status: 'refresh_completed', ...data },
    });
  }

  emitClassificationRefreshFailed(batchId: string, itemId: string, data: Record<string, unknown>): void {
    this.emit({
      type: 'item:status',
      batchId,
      itemId,
      data: { status: 'refresh_failed', ...data },
    });
  }
}

// Singleton instance
export const onboardingEvents = new OnboardingEventBus();
