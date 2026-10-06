import { useCallback, useEffect, useRef, useState } from 'react';
import { approveItems, getBatchWorkStateCounts, type BatchFilenamePreviewItem } from '../../../onboarding-work-api';
import type { ApproveItemsResponse } from '../../../../shared/schemas/onboarding-work-state';
import type { ReviewQueueRow } from '../../../../shared/schemas/onboarding-review-queue';

interface Props {
  batchId: string;
  selected: ReviewQueueRow[];
  disabledReason?: string;
  previews: Map<string, BatchFilenamePreviewItem>;
  onApproved: (result: ApproveItemsResponse) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
  queueComputedAt: string;
}

/** Uses the existing approval command and receipt; selection is loaded IDs only. */
export function ReviewApprovalControl({ batchId, selected, disabledReason, previews, onApproved, onBusyChange, queueComputedAt }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof approveItems>> | null>(null);
  const [decisions, setDecisions] = useState<Record<string, 'accept' | 'defer'>>({});
  const operation = useRef<{ fingerprint: string; key: string } | null>(null);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const healthRequest = useRef(0);
  const [health, setHealth] = useState<'loading' | 'healthy' | 'degraded' | 'unavailable'>('loading');
  const refreshHealth = useCallback(async () => {
    const version = ++healthRequest.current;
    setHealth('loading');
    try {
      // Same bounded health seam as ApprovedView; never fetch an approval list.
      const response = await getBatchWorkStateCounts(batchId);
      if (version === healthRequest.current) setHealth(response.projectionHealth?.status ?? 'unavailable');
    } catch {
      if (version === healthRequest.current) setHealth('unavailable');
    }
  }, [batchId]);
  useEffect(() => {
    void refreshHealth();
    return () => { healthRequest.current++; };
  }, [refreshHealth, queueComputedAt]);
  useEffect(() => {
    generation.current++;
    operation.current = null;
    setDecisions({});
    setResult(null);
    setError(null);
    return () => { generation.current++; };
  }, [batchId]);

  async function approve() {
    if (disabledReason || health !== 'healthy' || selected.length === 0 || inFlight.current) return;
    const currentGeneration = generation.current;
    const ids = selected.map(row => row.itemId).sort();
    const filenameDecisions = Object.fromEntries(ids.filter(id => decisions[id]).map(id => [id, decisions[id]]));
    const fingerprint = JSON.stringify([batchId, ids, filenameDecisions]);
    if (operation.current?.fingerprint !== fingerprint) {
      operation.current = { fingerprint, key: globalThis.crypto?.randomUUID?.()
        ?? `${Date.now()}-${Math.random().toString(36).slice(2)}` };
    }
    inFlight.current = true;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    setResult(null);
    try {
      const response = await approveItems(batchId, ids, {
        idempotencyKey: operation.current.key,
        ...(Object.keys(filenameDecisions).length ? { filenameDecisions } : {}),
      });
      if (generation.current !== currentGeneration) return;
      operation.current = null;
      setResult(response);
      setDecisions({});
      await onApproved(response);
      if (generation.current === currentGeneration) await refreshHealth();
    } catch (err) {
      if (generation.current === currentGeneration) setError(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      inFlight.current = false;
      if (generation.current === currentGeneration) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  }

  return (
    <section className="rv-panel" aria-label="Approve reviewed selection">
      <p>Approval is a separate decision. It creates no drafts and does not export or publish.</p>
      <p>{selected.length} selected reviewed product{selected.length === 1 ? '' : 's'}. Selection applies only to shown products.</p>
      {selected.map(row => {
        const preview = previews.get(row.itemId);
        if (!preview?.warnings.length) return null;
        return (
          <label key={row.itemId} className="rv-field">
            Filename decision for {row.displayTitle}
            <select className="rv-select" disabled={busy} value={decisions[row.itemId] ?? ''} onChange={e => {
              const value = e.target.value as 'accept' | 'defer' | '';
              setDecisions(prev => {
                const next = { ...prev };
                if (value) next[row.itemId] = value;
                else delete next[row.itemId];
                return next;
              });
            }}>
              <option value="">Use recorded decision (server rechecks)</option>
              {!preview.warnings.some(w => w.code === 'filename_collision_catalog') && <option value="accept">Accept filename</option>}
              <option value="defer">Defer</option>
            </select>
          </label>
        );
      })}
      <button type="button" className="btn btn-primary" disabled={busy || !!disabledReason || health !== 'healthy' || selected.length === 0} onClick={() => void approve()}>
        {busy ? 'Approving…' : `Approve selected reviewed (${selected.length})`}
      </button>
      {disabledReason && <p role="status">{disabledReason}</p>}
      {health !== 'healthy' && <p role="status">
        {health === 'loading' ? 'Checking approval projection health…' : health === 'degraded' ? 'Approval projection degraded — cannot approve.' : 'Approval projection health unavailable — cannot approve.'}
        {health !== 'loading' && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void refreshHealth()}>Retry approval health</button>}
      </p>}
      {error && <p role="alert">{error} Retry the same selection to reuse its receipt key.</p>}
      {result && <div role="status">
        <p>{result.approvedCount} approved · {result.rejectedCount} rejected.</p>
        <ul>{result.results.map(outcome => <li key={outcome.itemId}>
          {outcome.itemId}: {outcome.status}{outcome.reason ? ` — ${outcome.reason}` : ''}
        </li>)}</ul>
        {result.receiptId && <p>Receipt: {result.receiptId}</p>}
      </div>}
    </section>
  );
}
