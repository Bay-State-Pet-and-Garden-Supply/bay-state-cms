import React, { useState, useEffect } from 'react';
import {
  getBatches,
  getBatch,
  deleteBatch,
  uploadSpreadsheet,
  createBatch,
  resolveBrandDomains,
  getBrandSites,
  getOnboardingCapabilities,
} from '../onboarding-api';
import { ViewHeader } from './common/ViewHeader';
import { colors, fonts, rounded, typography } from '../theme';
import { OnboardingSettings } from './OnboardingSettings';
import { BatchWorkspace } from './onboarding/BatchWorkspace';
import { BatchExecutionControls } from './onboarding/BatchExecutionControls';
import { WeeklyReportModal } from './WeeklyReportModal';
import type { OnboardingBatch, ColumnMapping } from '../../shared/schemas/onboarding';
import type { WorkStateCounts } from '../../shared/schemas/onboarding-work-state';
import { formatCount, totalItemCount } from './onboarding/batch-workspace-logic';
import { matchExistingBrand } from '../../shared/brand-matcher';
import { resolveOnboardingSettingsTab } from './onboarding-settings/tabRegistry';

// Semantic SVG Icons (replaces raw unicode emoji for consistent craft)
function ReportIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 20V10M12 20V4M6 20v-6" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: colors.uniformGreen, margin: '0 auto 8px', display: 'block' }}>
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function GearMini() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  );
}

function AlertMini() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function ClockMini() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function EyeMini() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function CheckMini() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function SkipMini() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
    </svg>
  );
}

export function Onboarding() {
  const [showSettings, setShowSettings] = useState(false);

  // Sourcing engine capability probe (server-reported). Slice 7: the engine
  // flag value was consumed only by the deleted PipelineBoard diagnostics
  // mount, so only a fetch failure is surfaced (fail-closed banner below).
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null);
  // Deep-linked settings tab (`?view=onboarding&settingsTab=curation` — the
  // "Open Curation Targets settings" banner links land here, not on the
  // generic ?view=settings page). Read once at mount: the banner anchors are
  // full-page navigations, so a fresh mount always sees the param.
  const settingsDeepLinkTab = (() => {
    const tab = new URLSearchParams(window.location.search).get('settingsTab');
    if (tab === 'llm') return 'llm';
    if (!tab) return null;
    return resolveOnboardingSettingsTab(tab);
  })();
  useEffect(() => {
    if (settingsDeepLinkTab === 'llm') {
      // Migrate the removed onboarding-owned editor to the canonical global
      // AI Compute surface while keeping existing bookmarks actionable.
      const url = new URL(window.location.href);
      url.searchParams.set('view', 'settings');
      url.searchParams.set('tab', 'ai');
      url.searchParams.delete('settingsTab');
      window.history.replaceState({ view: 'settings' }, '', url.toString());
      window.dispatchEvent(new PopStateEvent('popstate'));
      return;
    }
    if (settingsDeepLinkTab) {
      setShowSettings(true);
    }
  }, [settingsDeepLinkTab]);
  const [showWeeklyReportModal, setShowWeeklyReportModal] = useState(false);
  const [batches, setBatches] = useState<OnboardingBatch[]>([]);
  const [batchCounts, setBatchCounts] = useState<Record<string, WorkStateCounts>>({});
  const initialBatchId = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('batch')
    : null;
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(initialBatchId);
  const [selectedBatch, setSelectedBatch] = useState<OnboardingBatch | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Load onboarding capabilities once on mount; only a fetch failure is
  // surfaced (engine treated as disabled). The value itself was consumed
  // only by the retired board mount.
  useEffect(() => {
    let cancelled = false;
    getOnboardingCapabilities()
      .then(() => {
        if (cancelled) return;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCapabilitiesError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, []);

  // Upload modal states
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadHeaders, setUploadHeaders] = useState<string[]>([]);
  const [uploadMapping, setUploadMapping] = useState<Partial<ColumnMapping>>({});
  const [uploadTempRows, setUploadTempRows] = useState<Record<string, string>[]>([]);
  const [uploadRowsCount, setUploadRowsCount] = useState(0);
  const [uploadBatchName, setUploadBatchName] = useState('');
  const [uploadStep, setUploadStep] = useState<1 | 2>(1);
  const [detectedBrands, setDetectedBrands] = useState<string[]>([]);
  const [brandMappings, setBrandMappings] = useState<Record<string, string>>({});
  const [loadingBrands, setLoadingBrands] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // Accessible Escape key handling for the upload modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showUploadModal && !loading && !loadingBrands) {
        setShowUploadModal(false);
        setUploadFile(null);
        setUploadStep(1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showUploadModal, loading, loadingBrands]);

  // Item review/edit drawer states were removed in the epic #46 operator
  // rollover — per-item review lives in the Review workspace, bulk actions in
  // the Batch Workspace (the deleted Pipeline Board diagnostics owned its
  // own drawer components).
  // story: e07s04 — profile builder modal state removed; navigation via getProfileWorkspacePath

  // Custom Selector Editor state was removed; extractor profiles are
  // managed in OnboardingSettings ("Domain Extractor Profiles" section).

  const fetchBatchesList = async () => {
    try {
      const res = await getBatches();
      setBatches(res.batches);
      // Server-owned per-batch operator work-state counts (epic #46
      // refinement): the table shows the same metrics as the workspace tabs.
      setBatchCounts(res.workStateCounts ?? {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSelectBatch = async (batchId: string, replaceHistory = false) => {
    setLoading(true);
    setError('');
    setSelectedBatchId(batchId);
    try {
      const batchRes = await getBatch(batchId);
      setSelectedBatch(batchRes.batch);
      const url = new URL(window.location.href);
      url.searchParams.set('view', 'onboarding');
      url.searchParams.set('batch', batchId);
      // If the batch has items needing attention and no explicit stage/tab was in the URL,
      // default the user directly into Needs Attention:
      const counts = batchCounts[batchId];
      if (!url.searchParams.get('tab') && !url.searchParams.get('stage') && counts && (counts.needs_attention ?? 0) > 0) {
        url.searchParams.set('tab', 'needs_attention');
      }
      if (replaceHistory) {
        window.history.replaceState({ view: 'onboarding', batch: batchId }, '', url.toString());
      } else {
        window.history.pushState({ view: 'onboarding', batch: batchId }, '', url.toString());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSelectedBatchId(null);
      setSelectedBatch(null);
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('batch');
      cleanUrl.searchParams.delete('tab');
      cleanUrl.searchParams.delete('board');
      window.history.replaceState({ view: 'onboarding' }, '', cleanUrl.toString());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBatchesList();
    if (initialBatchId) {
      void handleSelectBatch(initialBatchId, true);
    }
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search);
      const urlBatchId = params.get('batch');
      if (urlBatchId !== selectedBatchId) {
        if (urlBatchId) {
          void handleSelectBatch(urlBatchId, true);
        } else {
          setSelectedBatchId(null);
          setSelectedBatch(null);
          void fetchBatchesList();
        }
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [selectedBatchId]);

  const handleBackToBatches = () => {
    setSelectedBatchId(null);
    setSelectedBatch(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('batch');
    url.searchParams.delete('tab');
    url.searchParams.delete('board');
    window.history.pushState({ view: 'onboarding' }, '', url.toString());
    fetchBatchesList();
  };

  const handleDeleteBatch = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this batch and all its items?')) return;
    try {
      await deleteBatch(id);
      if (selectedBatchId === id) {
        setSelectedBatchId(null);
        setSelectedBatch(null);
        const url = new URL(window.location.href);
        url.searchParams.delete('batch');
        url.searchParams.delete('tab');
        url.searchParams.delete('board');
        window.history.replaceState({ view: 'onboarding' }, '', url.toString());
      }
      fetchBatchesList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // ─── SPREADSHEET UPLOAD & CREATION ──────────────────────────────────────────

  const processUploadedFile = async (file: File) => {
    setLoading(true);
    setError('');
    setUploadStep(1);
    setDetectedBrands([]);
    setBrandMappings({});
    try {
      const res = await uploadSpreadsheet(file);
      setUploadFile(file);
      setUploadHeaders(res.headers);
      setUploadMapping(res.mapping);
      setUploadTempRows(res.tempRows);
      setUploadRowsCount(res.rowsCount);
      
      // Auto-name batch
      const baseName = file.name.replace(/\.[^/.]+$/, '');
      setUploadBatchName(baseName);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void processUploadedFile(file);
  };

  const handleNextStep = async () => {
    if (!uploadMapping.upc || !uploadMapping.name) {
      alert('UPC and Product Name column mappings are required');
      return;
    }

    setLoadingBrands(true);
    try {
      // Fetch existing brands in the system
      const brandSitesRes = await getBrandSites();
      const existingBrands = [
        ...brandSitesRes.brandSites.map((b) => b.brandName),
        ...(brandSitesRes.catalogBrands || []),
      ];

      const brandCol = uploadMapping.brand;
      const nameCol = uploadMapping.name;

      const brandsSet = new Set<string>();
      for (const row of uploadTempRows) {
        let brandVal = '';
        if (brandCol && row[brandCol]) {
          brandVal = row[brandCol].trim();
        } else if (nameCol && row[nameCol]) {
          // Check if first word(s) matches an existing brand exactly
          const matched = matchExistingBrand(row[nameCol], existingBrands);
          if (matched) {
            brandVal = matched;
          }
        }
        
        // Filter out short noise/numeric tokens
        if (brandVal && brandVal.length > 1 && !/^\d+$/.test(brandVal)) {
          brandsSet.add(brandVal.toUpperCase());
        }
      }

      const uniqueBrands = Array.from(brandsSet).sort();
      setDetectedBrands(uniqueBrands);

      // Query backend to resolve domains
      if (uniqueBrands.length > 0) {
        const res = await resolveBrandDomains(uniqueBrands);
        const initialMappings: Record<string, string> = {};
        for (const brand of uniqueBrands) {
          initialMappings[brand] = res.mappings[brand] || '';
        }
        setBrandMappings(initialMappings);
      }

      setUploadStep(2);
    } catch (err) {
      alert('Failed to detect brands: ' + String(err));
    } finally {
      setLoadingBrands(false);
    }
  };

  const handleConfirmBatch = async () => {
    if (!uploadBatchName.trim()) {
      alert('Please enter a batch name');
      return;
    }
    if (!uploadMapping.upc || !uploadMapping.name) {
      alert('UPC and Product Name column mappings are required');
      return;
    }

    setLoading(true);
    setError('');
    try {
      // ADR 0017 follow-up: uploads no longer submit brandMappings — brand→domain
      // authority is managed in Settings (Domain Configuration) and via Discovery
      // attention actions. The step-2 UI is now a read-only confirm summary.
      const res = await createBatch({
        name: uploadBatchName,
        fileName: uploadFile!.name,
        mapping: uploadMapping as ColumnMapping,
        rows: uploadTempRows,
      });

      setShowUploadModal(false);
      setUploadFile(null);
      setUploadHeaders([]);
      setUploadMapping({});
      setUploadTempRows([]);
      setUploadRowsCount(0);
      setUploadBatchName('');
      setUploadStep(1);
      setDetectedBrands([]);
      setBrandMappings({});
      
      await fetchBatchesList();
      handleSelectBatch(res.batch.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // ─── LAYOUTS AND RENDERING ───────────────────────────────────────────────────

  const renderBatchProgress = (batch: OnboardingBatch) => {
    const counts = batchCounts[batch.id];
    if (!counts) {
      // Legacy fallback (no work-state data yet): keep the old bar.
      const total = batch.totalItems || 1;
      const completed = batch.completedItems;
      const failed = batch.failedItems;
      const skipped = batch.skippedItems ?? 0;
      const completedPercent = Math.round((completed / total) * 100);
      const failedPercent = Math.round((failed / total) * 100);
      const skippedPercent = Math.round((skipped / total) * 100);
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: colors.mulchBrown }}>
            <span>
              {completed} completed / {failed} failed
              {skipped > 0 && ` / ${skipped} skipped`} ({total} total)
            </span>
            <span style={{ fontFamily: fonts.mono }}>{completedPercent + failedPercent}%</span>
          </div>
          <div style={{ height: 6, width: '100%', background: colors.cardBorder, borderRadius: 3, overflow: 'hidden', display: 'flex' }}>
            <div style={{ height: '100%', width: `${completedPercent}%`, background: colors.seedlingGreen }} />
            <div style={{ height: '100%', width: `${failedPercent}%`, background: colors.signetBurgundy }} />
            <div style={{ height: '100%', width: `${skippedPercent}%`, background: colors.mulchBrown }} />
          </div>
        </div>
      );
    }

    // Epic #46 refinement: the operator work-state metrics — the same
    // numbers the Batch Workspace tabs show. Needs Attention is emphasized
    // when non-zero.
    const total = Math.max(totalItemCount(counts), 1);
    const approvedTotal = counts.approved + counts.ready_to_export + counts.completed;
    const pct = (v: number) => Math.round((v / total) * 100);
    const barStyle = { height: '100%' } as const;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 240 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem 0.625rem', fontSize: 12, color: colors.mulchBrown, alignItems: 'center' }}>
          <span title="Processing — automation is working" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <GearMini /> {formatCount(counts.processing)}
          </span>
          <span
            title="Needs Attention — products that need your judgment"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              ...(counts.needs_attention > 0 ? { color: colors.signetBurgundy, fontWeight: 700 } : {}),
            }}
          >
            <AlertMini /> {formatCount(counts.needs_attention)}
          </span>
          <span title="Waiting on Family — blocked on sibling readiness" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <ClockMini /> {formatCount(counts.waiting_on_family)}
          </span>
          <span title="Ready for Review — awaiting inspection" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <EyeMini /> {formatCount(counts.ready_for_review)}
          </span>
          <span title="Approved / Ready to Export / Completed" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: colors.seedlingGreen, fontWeight: 600 }}>
            <CheckMini /> {formatCount(approvedTotal)}
          </span>
          {counts.skipped > 0 && (
            <span title="Skipped" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <SkipMini /> {formatCount(counts.skipped)}
            </span>
          )}
          <span style={{ marginLeft: 'auto', fontFamily: fonts.mono, fontSize: 11 }}>({formatCount(total)})</span>
        </div>
        <div style={{ height: 6, width: '100%', background: colors.cardBorder, borderRadius: 3, overflow: 'hidden', display: 'flex' }}>
          <div style={{ ...barStyle, width: `${pct(counts.needs_attention)}%`, background: colors.signetBurgundy }} />
          <div style={{ ...barStyle, width: `${pct(counts.processing)}%`, background: colors.mulchBrown }} />
          <div style={{ ...barStyle, width: `${pct(counts.waiting_on_family)}%`, background: colors.mutedGold }} />
          <div style={{ ...barStyle, width: `${pct(counts.ready_for_review)}%`, background: colors.uniformGreen }} />
          <div style={{ ...barStyle, width: `${pct(approvedTotal)}%`, background: colors.seedlingGreen }} />
          {counts.skipped > 0 && <div style={{ ...barStyle, width: `${pct(counts.skipped)}%`, background: colors.cardBorder }} />}
        </div>
      </div>
    );
  };

  const statusLabel = (s: string) => {
    const labels: Record<string, string> = {
      imported: 'Imported',
      discovering: 'Searching sources...',
      source_found: 'Source found',
      source_confirmed: 'Confirmed',
      extracting: 'Scraping page...',
      extracted: 'Scraped',
      needs_review: 'Needs review',
      ready: 'Ready',
      promoted: 'Promoted',
      failed: 'Failed',
      skipped: 'Skipped'
    };
    return labels[s] ?? s;
  };

  const statusStyle = (s: string): React.CSSProperties => {
    const statusPalette: Record<string, { bg: string; text: string; border: string }> = {
      imported: { bg: colors.feedBagCream, text: colors.ledgerCharcoal, border: colors.cardBorder },
      discovering: { bg: '#eff6ff', text: '#1e40af', border: '#bfdbfe' },
      source_found: { bg: '#fef3c7', text: '#78350f', border: '#fde68a' },
      source_confirmed: { bg: '#e0f2fe', text: '#0369a1', border: '#bae6fd' },
      extracting: { bg: '#eff6ff', text: '#1e40af', border: '#bfdbfe' },
      extracted: { bg: '#d1fae5', text: '#14532d', border: '#a7f3d0' },
      needs_review: { bg: '#ffedd5', text: '#c2410c', border: '#fed7aa' },
      ready: { bg: '#d1fae5', text: '#14532d', border: '#a7f3d0' },
      promoted: { bg: '#d1fae5', text: '#14532d', border: '#a7f3d0' },
      failed: { bg: '#fee2e2', text: '#991b1b', border: '#fecaca' },
      skipped: { bg: colors.feedBagCream, text: colors.mulchBrown, border: colors.cardBorder },
    };
    const c = statusPalette[s] ?? { bg: colors.feedBagCream, text: colors.ledgerCharcoal, border: colors.cardBorder };
    return {
      background: c.bg,
      color: c.text,
      border: `1px solid ${c.border}`,
      padding: '2px 8px',
      borderRadius: rounded.full,
      fontSize: 11,
      fontWeight: 600,
      display: 'inline-flex',
      alignItems: 'center',
    };
  };

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: 24, fontFamily: fonts.body, color: colors.ledgerCharcoal, backgroundColor: colors.feedBagCream, minHeight: '100vh' },
    titleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
    title: { ...typography.viewTitle },
    btnRow: { display: 'flex', gap: 12 },
    primaryBtn: {
      background: colors.uniformGreen,
      color: colors.feedBagCream,
      border: `1px solid ${colors.shadowPine}`,
      borderRadius: rounded.md,
      padding: '8px 16px',
      cursor: 'pointer',
      fontWeight: 600,
      fontSize: '0.8125rem',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontFamily: fonts.body,
      transition: 'background-color 0.15s ease',
    },
    secondaryBtn: {
      background: colors.whiteSurface,
      border: `1px solid ${colors.cardBorder}`,
      color: colors.ledgerCharcoal,
      borderRadius: rounded.md,
      padding: '8px 16px',
      cursor: 'pointer',
      fontWeight: 600,
      fontSize: '0.8125rem',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontFamily: fonts.body,
      transition: 'background-color 0.15s ease, border-color 0.15s ease',
    },
    table: {
      width: '100%',
      borderCollapse: 'collapse',
      background: colors.whiteSurface,
      border: `1px solid ${colors.cardBorder}`,
      borderRadius: rounded.lg,
      overflow: 'hidden',
    },
    th: {
      background: colors.feedBagCream,
      borderBottom: `2px solid ${colors.cardBorder}`,
      textAlign: 'left',
      padding: '12px 16px',
      color: colors.mulchBrown,
      fontWeight: 600,
      fontSize: '0.75rem',
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
      fontFamily: fonts.body,
    },
    td: {
      borderBottom: `1px solid ${colors.cardBorder}`,
      padding: '12px 16px',
      fontSize: '0.875rem',
      color: colors.ledgerCharcoal,
      fontFamily: fonts.body,
    },
    card: {
      background: colors.whiteSurface,
      border: `1px solid ${colors.cardBorder}`,
      borderRadius: rounded.lg,
      padding: 20,
      marginBottom: 20,
      boxShadow: '0 1px 3px rgba(33, 20, 20, 0.05)',
    },
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 },
    modalOverlay: {
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(33, 20, 20, 0.45)',
      backdropFilter: 'blur(2px)',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      zIndex: 1000,
      padding: 16,
    },
    modalContent: {
      background: colors.whiteSurface,
      padding: 24,
      borderRadius: rounded.lg,
      width: '100%',
      maxWidth: 600,
      boxSizing: 'border-box',
      border: `1px solid ${colors.cardBorder}`,
      boxShadow: '0 10px 25px rgba(33, 20, 20, 0.15)',
    },
    fieldGroup: { marginBottom: 16 },
    label: {
      display: 'block',
      fontSize: '0.8125rem',
      fontWeight: 600,
      color: colors.ledgerCharcoal,
      marginBottom: 6,
      fontFamily: fonts.body,
    },
    select: {
      width: '100%',
      padding: '8px 12px',
      border: `1px solid ${colors.cardBorder}`,
      borderRadius: rounded.md,
      fontSize: '0.875rem',
      fontFamily: fonts.body,
      color: colors.ledgerCharcoal,
      backgroundColor: colors.whiteSurface,
      outline: 'none',
    },
  };

  if (showSettings) {
    return (
      <OnboardingSettings
        onBack={() => {
          setShowSettings(false);
          const url = new URL(window.location.href);
          if (url.searchParams.has('settingsTab')) {
            url.searchParams.delete('settingsTab');
            window.history.replaceState(null, '', url.toString());
          }
        }}
        initialTab={settingsDeepLinkTab === 'llm' ? undefined : settingsDeepLinkTab ?? undefined}
      />
    );
  }

  // ─── VIEW 1: BATCHES LIST ─────────────────────────────────────────────────────
  // Slice 7 P2: `?board=pipeline` with no `?batch=` renders the same
  // retired-diagnostics notice above the batches list (never a dead
  // screen, never a board mount — the board file is deleted).

  if (!selectedBatchId) {
    const boardQuery = typeof window !== 'undefined'
      && new URLSearchParams(window.location.search).get('board') === 'pipeline';
    return (
      <div style={styles.container}>
        {boardQuery && (
          <div role="status" data-testid="retired-diagnostics-notice" style={{ backgroundColor: colors.feedBagCream, color: colors.ledgerCharcoal, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, padding: '8px 12px', marginBottom: 20, fontSize: '0.8125rem' }}>
            The pipeline board diagnostics view has been retired — showing the Batch Workspace instead. Use the stage tabs and operations below; nothing was lost.
          </div>
        )}
        <ViewHeader
          title="Product Onboarding"
          description="Automatic acquisition — distributor lookups, official-site fallback, extraction, and family curation — with human review and bulk approval before export."
          actions={
            <>
              <button
                style={{ ...styles.secondaryBtn, background: colors.signetBurgundy, color: colors.feedBagCream, borderColor: colors.burgundyDark }}
                onClick={() => setShowWeeklyReportModal(true)}
              >
                <ReportIcon /> Generate Weekly Report
              </button>
              <button style={styles.secondaryBtn} onClick={() => setShowSettings(true)}>
                <SettingsIcon /> Onboarding Settings
              </button>
              <button style={styles.primaryBtn} onClick={() => setShowUploadModal(true)}>
                <PlusIcon /> Upload Weekly Spreadsheet
              </button>
            </>
          }
        />

        {error && <div role="alert" style={{ color: colors.feedBagCream, background: colors.signetBurgundy, padding: 12, borderRadius: rounded.md, marginBottom: 20, fontSize: '0.875rem' }}>{error}</div>}
        {capabilitiesError && !error && (
          <div role="status" style={{ color: colors.mulchBrown, background: colors.feedBagCream, border: `1px solid ${colors.cardBorder}`, padding: 12, borderRadius: rounded.md, marginBottom: 20, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
            <SettingsIcon /> Onboarding capabilities unavailable ({capabilitiesError}) — Sourcing engine treated as disabled.
          </div>
        )}

        {batches.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 24px', background: colors.whiteSurface, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.lg, boxShadow: '0 1px 3px rgba(33, 20, 20, 0.05)' }}>
            <p style={{ fontSize: 16, color: colors.mulchBrown, margin: '0 0 16px', fontFamily: fonts.body }}>No onboarding batches uploaded yet.</p>
            <button onClick={() => setShowUploadModal(true)} style={{ ...styles.primaryBtn, margin: '0 auto' }}>
              <PlusIcon /> Upload Spreadsheet to Start
            </button>
          </div>
        ) : (
          <div style={{ borderRadius: rounded.lg, overflow: 'hidden', border: `1px solid ${colors.cardBorder}`, boxShadow: '0 1px 3px rgba(33, 20, 20, 0.05)' }}>
            <table style={styles.table} aria-label="Onboarding Batches">
              <thead>
                <tr>
                  <th scope="col" style={styles.th}>Batch Name</th>
                  <th scope="col" style={styles.th}>Filename</th>
                  <th scope="col" style={styles.th}>Uploaded At</th>
                  <th scope="col" style={styles.th}>Status</th>
                  <th scope="col" style={styles.th}>Progress</th>
                  <th scope="col" style={styles.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {batches.map(batch => (
                  <tr
                    key={batch.id}
                    tabIndex={0}
                    role="row"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleSelectBatch(batch.id);
                      }
                    }}
                    onClick={() => handleSelectBatch(batch.id)}
                    style={{ cursor: 'pointer', transition: 'background-color 0.15s ease' }}
                    className="hover-row"
                  >
                    <td style={styles.td}>
                      <button
                        type="button"
                        onClick={() => handleSelectBatch(batch.id)}
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          font: 'inherit',
                          fontWeight: 700,
                          color: colors.uniformGreen,
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        {batch.name}
                      </button>
                    </td>
                    <td style={{ ...styles.td, fontFamily: fonts.mono, fontSize: '0.8125rem' }}>{batch.fileName}</td>
                    <td style={{ ...styles.td, fontSize: '0.8125rem', color: colors.mulchBrown }}>{batch.createdAt.slice(0, 19).replace('T', ' ')}</td>
                    <td style={styles.td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={statusStyle(batch.status)}>{statusLabel(batch.status)}</span>
                        {batch.executionState && (
                          <span style={{
                            fontSize: 10,
                            padding: '2px 8px',
                            borderRadius: rounded.full,
                            fontWeight: 700,
                            letterSpacing: '0.04em',
                            background: batch.executionState === 'running' ? '#d1fae5' :
                              batch.executionState === 'paused' ? '#fef3c7' :
                              batch.executionState === 'completed' ? '#e0f2fe' : colors.feedBagCream,
                            color: batch.executionState === 'running' ? '#14532d' :
                              batch.executionState === 'paused' ? '#78350f' :
                              batch.executionState === 'completed' ? '#0369a1' : colors.ledgerCharcoal,
                            border: `1px solid ${
                              batch.executionState === 'running' ? '#a7f3d0' :
                              batch.executionState === 'paused' ? '#fde68a' :
                              batch.executionState === 'completed' ? '#bae6fd' : colors.cardBorder
                            }`,
                          }}>
                            {batch.executionState.toUpperCase()}
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={styles.td} onClick={(e) => e.stopPropagation()}>{renderBatchProgress(batch)}</td>
                    <td style={styles.td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span onClick={(e) => e.stopPropagation()}>
                          <BatchExecutionControls batchId={batch.id} executionState={batch.executionState} compact onChanged={() => fetchBatchesList()} />
                        </span>
                        <button
                          type="button"
                          aria-label={`Delete batch ${batch.name}`}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: colors.signetBurgundy,
                            cursor: 'pointer',
                            fontWeight: 600,
                            fontSize: 13,
                            padding: '4px 6px',
                            borderRadius: rounded.sm,
                          }}
                          onClick={(e) => handleDeleteBatch(batch.id, e)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ─── UPLOAD MODAL ──────────────────────────────────────────────────────── */}
        {showUploadModal && (
          <div
            style={styles.modalOverlay}
            onClick={() => {
              if (!loading && !loadingBrands) {
                setShowUploadModal(false);
                setUploadFile(null);
                setUploadStep(1);
              }
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="upload-modal-title"
              style={styles.modalContent}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <h2 id="upload-modal-title" style={{ ...typography.sectionTitle, margin: 0 }}>Upload Onboarding Spreadsheet</h2>
                <button
                  type="button"
                  onClick={() => {
                    setShowUploadModal(false);
                    setUploadFile(null);
                    setUploadStep(1);
                  }}
                  aria-label="Close upload modal"
                  disabled={loading || loadingBrands}
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: '1.25rem',
                    color: colors.mulchBrown,
                    cursor: loading || loadingBrands ? 'not-allowed' : 'pointer',
                    padding: 4,
                    lineHeight: 1,
                  }}
                >
                  ✕
                </button>
              </div>
              
              {!uploadFile ? (
                <div
                  onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setIsDragging(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) void processUploadedFile(f);
                  }}
                  style={{
                    border: isDragging ? `2px dashed ${colors.uniformGreen}` : `2px dashed ${colors.cardBorder}`,
                    borderRadius: rounded.lg,
                    padding: 36,
                    textAlign: 'center',
                    background: isDragging ? colors.feedBagCream : colors.whiteSurface,
                    transition: 'border-color 0.15s ease, background-color 0.15s ease',
                  }}
                >
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={handleFileChange}
                    style={{ display: 'none' }}
                    id="file-upload-input"
                  />
                  <UploadIcon />
                  <label htmlFor="file-upload-input" style={{ cursor: 'pointer', color: colors.uniformGreen, fontWeight: 600, fontSize: '0.875rem' }}>
                    Click to browse files or drag spreadsheet here
                  </label>
                  <p style={{ margin: '8px 0 0', fontSize: 13, color: colors.mulchBrown }}>Accepts .xlsx, .xls, or .csv spreadsheets</p>
                </div>
              ) : (
                <div>
                  <p style={{ fontSize: 13, color: colors.ledgerCharcoal, margin: '0 0 16px 0' }}>
                    File: <strong style={{ fontFamily: fonts.mono }}>{uploadFile.name}</strong> ({uploadRowsCount} data rows found)
                  </p>

                  {uploadStep === 1 ? (
                    <div>
                      <div style={styles.fieldGroup}>
                        <label style={styles.label}>Onboarding Batch Name</label>
                        <input
                          style={{
                            width: '100%',
                            padding: '8px 12px',
                            border: `1px solid ${colors.cardBorder}`,
                            borderRadius: rounded.md,
                            fontFamily: fonts.body,
                            fontSize: '0.875rem',
                            color: colors.ledgerCharcoal,
                            backgroundColor: loadingBrands ? colors.feedBagCream : colors.whiteSurface,
                            cursor: loadingBrands ? 'not-allowed' : 'text',
                            boxSizing: 'border-box',
                          }}
                          type="text"
                          value={uploadBatchName}
                          onChange={(e) => setUploadBatchName(e.target.value)}
                          disabled={loadingBrands}
                        />
                      </div>

                      <h3 style={{ fontSize: 14, fontWeight: 600, margin: '16px 0 8px', color: colors.ledgerCharcoal }}>Map Spreadsheet Columns</h3>
                      
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>UPC/SKU Column *</label>
                          <select
                            style={{
                              ...styles.select,
                              ...(loadingBrands ? { backgroundColor: colors.feedBagCream, cursor: 'not-allowed' } : {})
                            }}
                            value={uploadMapping.upc || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, upc: e.target.value }))}
                            disabled={loadingBrands}
                          >
                            <option value="">-- Select --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Product Name Column *</label>
                          <select
                            style={{
                              ...styles.select,
                              ...(loadingBrands ? { backgroundColor: colors.feedBagCream, cursor: 'not-allowed' } : {})
                            }}
                            value={uploadMapping.name || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, name: e.target.value }))}
                            disabled={loadingBrands}
                          >
                            <option value="">-- Select --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Merge Name With Column (Optional)</label>
                          <select
                            style={{
                              ...styles.select,
                              ...(loadingBrands ? { backgroundColor: colors.feedBagCream, cursor: 'not-allowed' } : {})
                            }}
                            value={uploadMapping.nameMergeWith || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, nameMergeWith: e.target.value || null }))}
                            disabled={loadingBrands}
                          >
                            <option value="">-- None --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Price Column (Optional)</label>
                          <select
                            style={{
                              ...styles.select,
                              ...(loadingBrands ? { backgroundColor: colors.feedBagCream, cursor: 'not-allowed' } : {})
                            }}
                            value={uploadMapping.price || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, price: e.target.value }))}
                            disabled={loadingBrands}
                          >
                            <option value="">-- None --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Quantity Column (Optional)</label>
                          <select
                            style={{
                              ...styles.select,
                              ...(loadingBrands ? { backgroundColor: colors.feedBagCream, cursor: 'not-allowed' } : {})
                            }}
                            value={uploadMapping.quantity || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, quantity: e.target.value }))}
                            disabled={loadingBrands}
                          >
                            <option value="">-- None --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Brand Column (Optional)</label>
                          <select
                            style={{
                              ...styles.select,
                              ...(loadingBrands ? { backgroundColor: colors.feedBagCream, cursor: 'not-allowed' } : {})
                            }}
                            value={uploadMapping.brand || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, brand: e.target.value }))}
                            disabled={loadingBrands}
                          >
                            <option value="">-- None --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Product Page URL Column (Optional)</label>
                          <select
                            style={{
                              ...styles.select,
                              ...(loadingBrands ? { backgroundColor: colors.feedBagCream, cursor: 'not-allowed' } : {})
                            }}
                            value={uploadMapping.sourceUrl || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, sourceUrl: e.target.value }))}
                            disabled={loadingBrands}
                          >
                            <option value="">-- None --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>
                      </div>

                      <div style={{ ...styles.btnRow, marginTop: 24, justifyContent: 'flex-end' }}>
                        <button
                          style={{
                            ...styles.secondaryBtn,
                            marginRight: 8,
                            ...(loadingBrands ? { opacity: 0.5, cursor: 'not-allowed' } : {})
                          }}
                          onClick={() => { setUploadFile(null); setShowUploadModal(false); setUploadStep(1); }}
                          disabled={loadingBrands}
                        >
                          Cancel
                        </button>
                        <button
                          style={{
                            ...styles.primaryBtn,
                            ...(loadingBrands ? { opacity: 0.7, cursor: 'not-allowed' } : {})
                          }}
                          onClick={handleNextStep}
                          disabled={loadingBrands}
                        >
                          {loadingBrands ? (
                            <>
                              <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                              Analyzing Brands...
                            </>
                          ) : (
                            'Next →'
                          )}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 8px 0', color: colors.ledgerCharcoal }}>Confirm Import</h3>
                      <p style={{ fontSize: 13, color: colors.mulchBrown, margin: '0 0 16px 0', lineHeight: '1.4' }}>
                        We detected <strong>{detectedBrands.length}</strong> distinct brand(s) in this batch.
                        Brands without configured official domains will be handled during Discovery.
                      </p>

                      {detectedBrands.length === 0 ? (
                        <p style={{ fontSize: 13, color: colors.mulchBrown, fontStyle: 'italic', padding: '12px 0' }}>
                          No brands detected in name/brand columns. Click Create Batch to proceed.
                        </p>
                      ) : (
                        <div style={{ maxHeight: '250px', overflowY: 'auto', border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.lg, padding: 12, backgroundColor: colors.feedBagCream }}>
                          {detectedBrands.map((brand) => {
                            const domain = (brandMappings[brand] || '').trim();
                            return (
                              <div key={brand} style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 12, alignItems: 'baseline', marginBottom: 10 }}>
                                <span style={{ fontSize: 13, fontWeight: 600, color: colors.ledgerCharcoal, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }} title={brand}>
                                  {brand}
                                </span>
                                {domain ? (
                                  <span style={{ fontSize: 13, color: colors.seedlingGreen, fontWeight: 500 }}>
                                    → {domain} (configured)
                                  </span>
                                ) : (
                                  <span style={{ fontSize: 13, color: colors.mulchBrown }}>
                                    No official domain configured — will be resolved during Discovery (items may pause for setup; they will not block upload)
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      <div style={{ ...styles.btnRow, marginTop: 24, justifyContent: 'space-between' }}>
                        <button
                          style={{
                            ...styles.secondaryBtn,
                            ...(loading ? { opacity: 0.5, cursor: 'not-allowed' } : {})
                          }}
                          onClick={() => setUploadStep(1)}
                          disabled={loading}
                        >
                          ← Back
                        </button>
                        <button
                          style={{
                            ...styles.primaryBtn,
                            ...(loading ? { opacity: 0.7, cursor: 'not-allowed' } : {})
                          }}
                          onClick={handleConfirmBatch}
                          disabled={loading}
                        >
                          {loading ? (
                            <>
                              <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                              Creating Batch...
                            </>
                          ) : (
                            'Create Batch'
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        {showWeeklyReportModal && (
          <WeeklyReportModal onClose={() => setShowWeeklyReportModal(false)} />
        )}
      </div>
    );
  }

  // ─── VIEW 2: BATCH WORKSPACE (sole shell) ─────────────────────────────────
  // Slice 7 file deletion (council plan §6 Slice 7): PipelineBoard.tsx is
  // deleted after the Slice 6 zero-mount evidence + grace interval. No
  // board import/mount/implicit fallback remains anywhere; an explicit
  // `?board=pipeline` URL resolves to the current shell with a retirement
  // notice, never a dead screen. `VITE_BATCH_WORKSPACE_ENABLED=false` stays
  // a deprecated no-op. Rollback uses the archived matching bridge client —
  // never a resurrected board. `shellV2Enabled=false` is an emergency
  // disabled-content state inside BatchWorkspace (see BatchWorkspace.tsx).
  if (selectedBatchId && selectedBatch) {
    const boardQuery = new URLSearchParams(window.location.search).get('board') === 'pipeline';
    return (
      <>
        {boardQuery && (
          <div role="status" data-testid="retired-diagnostics-notice" style={{ margin: '12px 24px 0 24px', backgroundColor: '#eef2ff', color: '#3730a3', border: '1px solid #c7d2fe', borderRadius: 8, padding: '8px 12px', fontSize: '0.8125rem' }}>
            The pipeline board diagnostics view has been retired — showing the Batch Workspace instead. Use the stage tabs and operations below; nothing was lost.
          </div>
        )}
        <BatchWorkspace
          batchId={selectedBatchId}
          batchName={selectedBatch.name}
          onBack={handleBackToBatches}
          onOpenSettings={() => setShowSettings(true)}
        />
        {showWeeklyReportModal && (
          <WeeklyReportModal onClose={() => setShowWeeklyReportModal(false)} />
        )}
      </>
    );
  }

  // Loading or failed state when a batch ID is selected
  if (selectedBatchId && !selectedBatch) {
    if (loading) {
      return (
        <div style={{ padding: 40, textAlign: 'center', color: colors.ledgerCharcoal }}>
          <span className="spinner" style={{ width: 24, height: 24, marginBottom: 12 }} />
          <div>Loading batch...</div>
        </div>
      );
    }
    if (error) {
      return (
        <div style={styles.container}>
          <div style={{ color: '#dc2626', background: '#fef2f2', padding: 16, borderRadius: 8, marginBottom: 20 }}>
            <strong>Error loading batch:</strong> {error}
          </div>
          <button style={styles.secondaryBtn} onClick={handleBackToBatches}>
            ← Back to Batches
          </button>
        </div>
      );
    }
    return null;
  }

  // No batch selected or batch not loaded
  return null;
}
