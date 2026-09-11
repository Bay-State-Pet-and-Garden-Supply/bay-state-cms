/**
 * B3 — load/save/refresh state machine for the shared strategy builder.
 *
 * One command wrapper with request cancellation and a stale-response guard:
 * late responses after brand change, unmount, or a newer request are
 * ignored. 409s retain caller context (no silent retry); transport failures
 * with an unknown outcome force an explicit refresh before any resubmit.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getBrandStrategies,
  getBrandStrategyDetail,
  OnboardingApiError,
  saveBrandStrategy,
} from '../../onboarding-api';
import type {
  ApproveBrandStrategy,
  ApprovedBrandStrategy,
  BrandStrategy,
} from '../../../shared/schemas/brand-strategy';
import { normalizeBrandKey } from './brand-strategy-builder-model';

export interface BuilderApi {
  loadDetail: (brand: string) => Promise<{ strategy: BrandStrategy | null }>;
  save: (input: ApproveBrandStrategy) => Promise<{ strategy: ApprovedBrandStrategy }>;
}

export const defaultBuilderApi: BuilderApi = {
  loadDetail: async (brand: string) => {
    try {
      const res = await getBrandStrategyDetail(brand);
      if (res.strategy) return { strategy: res.strategy };
    } catch {
      // Fall through to the list read below (older servers may lack ?brand=).
    }
    const list = await getBrandStrategies();
    const key = normalizeBrandKey(brand);
    const found = (list.strategies ?? []).find((s) => s.normalizedBrand === key) ?? null;
    return { strategy: found };
  },
  save: (input: ApproveBrandStrategy) => saveBrandStrategy(input),
};

export type BuilderConflictKind = 'stale_revision' | 'stale_configuration';

export interface BuilderConflict {
  kind: BuilderConflictKind | 'other';
  message: string;
  serverRevision: number | null;
}

function toConflict(err: unknown): BuilderConflict {
  const code = err instanceof OnboardingApiError ? err.code : null;
  const payload = (err instanceof OnboardingApiError ? err.payload : null) as {
    revision?: unknown;
  } | null;
  const serverRevision = typeof payload?.revision === 'number' ? payload.revision : null;
  if (code === 'stale_revision') {
    return { kind: 'stale_revision', message: 'This strategy changed since you started editing.', serverRevision };
  }
  if (code === 'stale_configuration') {
    return {
      kind: 'stale_configuration',
      message: 'Brand mappings changed outside this editor since you started.',
      serverRevision,
    };
  }
  return { kind: 'other', message: err instanceof Error ? err.message : String(err), serverRevision };
}

function isTransportUncertain(err: unknown): boolean {
  // OnboardingApiError always carries a server verdict; anything else
  // (network abort, TypeError) leaves the outcome unknown.
  return !(err instanceof OnboardingApiError);
}

export interface UseBrandStrategyBuilder {
  strategy: BrandStrategy | null;
  loading: boolean;
  loadError: string | null;
  saving: boolean;
  saveError: string | null;
  conflict: BuilderConflict | null;
  uncertainOutcome: boolean;
  savedRevision: number | null;
  savedNeedsRefresh: boolean;
  load: (brand: string) => void;
  refresh: () => Promise<BrandStrategy | null>;
  runSave: (input: ApproveBrandStrategy) => Promise<ApprovedBrandStrategy | null>;
  clearConflict: () => void;
}

export function useBrandStrategyBuilder(
  initialBrand: string,
  api: BuilderApi = defaultBuilderApi,
): UseBrandStrategyBuilder {
  const [strategy, setStrategy] = useState<BrandStrategy | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<BuilderConflict | null>(null);
  const [uncertainOutcome, setUncertainOutcome] = useState(false);
  const [savedRevision, setSavedRevision] = useState<number | null>(null);
  const [savedNeedsRefresh, setSavedNeedsRefresh] = useState(false);
  const requestId = useRef(0);
  const brandRef = useRef(initialBrand);
  brandRef.current = initialBrand;
  const apiRef = useRef(api);
  apiRef.current = api;

  const loadInto = useCallback(async (brand: string, id: number): Promise<BrandStrategy | null> => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiRef.current.loadDetail(brand);
      if (requestId.current !== id) return null;
      setStrategy(res.strategy);
      return res.strategy;
    } catch (err) {
      if (requestId.current !== id) return null;
      // Read failure never initializes a fake revision-0 editor.
      setStrategy(null);
      setLoadError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      if (requestId.current === id) setLoading(false);
    }
  }, []);

  const load = useCallback(
    (brand: string) => {
      requestId.current += 1;
      const id = requestId.current;
      setConflict(null);
      setSaveError(null);
      setUncertainOutcome(false);
      setSavedRevision(null);
      setSavedNeedsRefresh(false);
      void loadInto(brand, id);
    },
    [loadInto],
  );

  useEffect(() => {
    requestId.current += 1;
    const id = requestId.current;
    void loadInto(brandRef.current, id);
    return () => {
      requestId.current += 1;
    };
  }, [loadInto]);

  const refresh = useCallback(async (): Promise<BrandStrategy | null> => {
    requestId.current += 1;
    const id = requestId.current;
    const next = await loadInto(brandRef.current, id);
    if (next) {
      setUncertainOutcome(false);
      setConflict(null);
    }
    return next;
  }, [loadInto]);

  const runSave = useCallback(
    async (input: ApproveBrandStrategy): Promise<ApprovedBrandStrategy | null> => {
      const id = ++requestId.current;
      setSaving(true);
      setSaveError(null);
      try {
        const res = await apiRef.current.save(input);
        if (requestId.current !== id) return null;
        setSavedRevision(res.strategy.revision);
        setConflict(null);
        setUncertainOutcome(false);
        // Refresh the server projection; a refresh failure must not look
        // like the durable Save was rolled back.
        try {
          const latest = await apiRef.current.loadDetail(brandRef.current);
          if (requestId.current !== id) return null;
          if (latest.strategy) {
            setStrategy(latest.strategy);
            setSavedNeedsRefresh(false);
          } else {
            setSavedNeedsRefresh(true);
          }
        } catch {
          if (requestId.current === id) setSavedNeedsRefresh(true);
        }
        return res.strategy;
      } catch (err) {
        if (requestId.current !== id) return null;
        if (err instanceof OnboardingApiError && err.status === 409) {
          const c = toConflict(err);
          setConflict(c);
          // Fetch latest revision AND configuration; keep unsaved edits
          // (the caller owns edit state — this hook only refreshes facts).
          try {
            const latest = await apiRef.current.loadDetail(brandRef.current);
            if (requestId.current !== id) return null;
            if (latest.strategy) setStrategy(latest.strategy);
          } catch {
            // Remain stale with Save disabled; caller shows refresh failure.
          }
          setSaveError(null);
          return null;
        }
        if (isTransportUncertain(err)) {
          setUncertainOutcome(true);
          setSaveError(
            'Save outcome is uncertain (the request may or may not have committed). Refresh first — do not resubmit blindly.',
          );
          return null;
        }
        setSaveError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        if (requestId.current === id) setSaving(false);
      }
    },
    [],
  );

  const clearConflict = useCallback(() => setConflict(null), []);

  return {
    strategy,
    loading,
    loadError,
    saving,
    saveError,
    conflict,
    uncertainOutcome,
    savedRevision,
    savedNeedsRefresh,
    load,
    refresh,
    runSave,
    clearConflict,
  };
}
