/**
 * Batch filename preview for the Review drawer (issue #109).
 *
 * Fetches the server-computed preview ONCE per batch review load (plus
 * explicit event-driven refreshes after edits/accepts/defers — never polling
 * or per-keystroke). A failed fetch degrades to "no preview": the filename
 * UI hides and approvals proceed exactly as before (the server gates
 * warned items regardless).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getBatchFilenamePreview,
  type BatchFilenamePreviewItem,
} from '../../../onboarding-work-api';

export interface FilenamePreviewState {
  /** Preview by item id (empty when not loaded or fetch failed). */
  byId: Map<string, BatchFilenamePreviewItem>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useFilenamePreview(batchId: string): FilenamePreviewState {
  const [byId, setById] = useState<Map<string, BatchFilenamePreviewItem>>(() => new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await getBatchFilenamePreview(batchId);
      if (requestRef.current !== requestId) return;
      setById(new Map(res.items.map(item => [item.itemId, item])));
    } catch (err) {
      if (requestRef.current !== requestId) return;
      // Degrade silently: filename UI hides; server-side gates still hold.
      setById(new Map());
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [batchId]);

  // Fetch once per batch; reset on batch change.
  useEffect(() => {
    setById(new Map());
    setError(null);
    void load();
  }, [batchId, load]);

  return { byId, loading, error, refresh: load };
}

/** Item ids in the preview that carry at least one filename warning. */
export function warnedPreviewIds(byId: Map<string, BatchFilenamePreviewItem>): Set<string> {
  const out = new Set<string>();
  for (const [id, item] of byId) {
    if (item.warnings.length > 0) out.add(id);
  }
  return out;
}
