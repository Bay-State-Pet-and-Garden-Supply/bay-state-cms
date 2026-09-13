import React, { useState, useEffect } from 'react';
import { 
  listChangeSets, 
  getChangeSet, 
  validateChangeSet, 
  approveChangeSet, 
  discardChangeSet, 
  exportChangeSet, 
  repairChangeSetImages, 
  pushPublish, 
  uploadOnly, 
  type ChangeSet, 
  type ChangeSetItem, 
  type ValidationResult 
} from '../api';
import { colors, fonts, rounded } from '../theme';

const STYLE_RULES = `
  /* Custom styled styles for the Change Sets workspace */
  .cs-manager-container {
    display: flex;
    height: calc(100vh - 57px);
    background: ${colors.feedBagCream};
    font-family: ${fonts.body};
    overflow: hidden;
    color: ${colors.ledgerCharcoal};
  }

  .cs-sidebar {
    width: 320px;
    min-width: 320px;
    max-width: 320px;
    border-right: 1px solid ${colors.cardBorder};
    background: ${colors.feedBagCream};
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .cs-sidebar-header {
    padding: 16px 20px;
    border-bottom: 1px solid ${colors.cardBorder};
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: ${colors.whiteSurface};
  }

  .cs-sidebar-title {
    font-family: ${fonts.display};
    font-size: 16px;
    font-weight: 700;
    color: ${colors.ledgerCharcoal};
    margin: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .cs-sidebar-search-container {
    position: relative;
    display: flex;
    align-items: center;
  }

  .cs-search-input {
    width: 100%;
    padding: 8px 12px 8px 32px;
    border-radius: ${rounded.md};
    border: 1px solid ${colors.cardBorder};
    background: ${colors.whiteSurface};
    color: ${colors.ledgerCharcoal};
    font-size: 13px;
    outline: none;
    transition: all 0.2s;
  }

  .cs-search-input:focus {
    border-color: ${colors.uniformGreen};
    box-shadow: 0 0 0 2px rgba(20, 83, 45, 0.15);
  }

  .cs-search-icon {
    position: absolute;
    left: 10px;
    color: ${colors.mulchBrown};
    font-size: 14px;
    pointer-events: none;
  }

  .cs-sidebar-list {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .cs-card {
    padding: 14px 16px;
    border-radius: ${rounded.md};
    border: 1px solid ${colors.cardBorder};
    background: ${colors.whiteSurface};
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    position: relative;
  }

  .cs-card:hover {
    border-color: ${colors.uniformGreen};
    box-shadow: 0 2px 8px rgba(33, 20, 20, 0.04);
  }

  .cs-card-active {
    background: ${colors.feedBagCream};
    border-color: ${colors.uniformGreen};
    box-shadow: 0 2px 8px rgba(20, 83, 45, 0.08);
  }

  .cs-card-active::before {
    content: '';
    position: absolute;
    left: 0;
    top: 12px;
    bottom: 12px;
    width: 4px;
    background: ${colors.uniformGreen};
    border-radius: 0 4px 4px 0;
  }

  .cs-workspace {
    flex: 1;
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: ${colors.feedBagCream};
  }

  .cs-empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 40px;
    color: ${colors.mulchBrown};
  }

  .cs-empty-icon {
    font-size: 48px;
    margin-bottom: 16px;
    opacity: 0.8;
  }

  .cs-workspace-header {
    padding: 16px 24px;
    background: ${colors.whiteSurface};
    border-bottom: 1px solid ${colors.cardBorder};
    display: flex;
    justify-content: space-between;
    align-items: center;
    box-shadow: 0 1px 2px rgba(33, 20, 20, 0.03);
    z-index: 5;
  }

  .cs-workspace-title {
    font-family: ${fonts.display};
    font-size: 1.25rem;
    font-weight: 700;
    color: ${colors.ledgerCharcoal};
    margin: 0 0 4px 0;
    line-height: 1.3;
  }

  .cs-workspace-meta {
    font-size: 12px;
    color: ${colors.mulchBrown};
    font-family: ${fonts.mono};
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .cs-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .cs-split-body {
    flex: 1;
    display: flex;
    overflow: hidden;
  }

  .cs-items-sidebar {
    width: 280px;
    min-width: 280px;
    max-width: 280px;
    background: ${colors.whiteSurface};
    border-right: 1px solid ${colors.cardBorder};
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .cs-items-sidebar-header {
    padding: 14px 16px;
    border-bottom: 1px solid ${colors.cardBorder};
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .cs-items-sidebar-title {
    font-size: 11px;
    font-weight: 700;
    color: ${colors.mulchBrown};
    margin: 0;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .cs-items-scroller {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .cs-item-row {
    padding: 10px 12px;
    border-radius: ${rounded.sm};
    border: 1px solid ${colors.cardBorder};
    background: ${colors.whiteSurface};
    cursor: pointer;
    transition: all 0.15s ease;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }

  .cs-item-row:hover {
    background: ${colors.feedBagCream};
    border-color: ${colors.cardBorder};
  }

  .cs-item-row-active {
    background: ${colors.feedBagCream};
    border-color: ${colors.uniformGreen};
  }

  .cs-detail-panel {
    flex: 1;
    overflow-y: auto;
    background: ${colors.feedBagCream};
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .cs-detail-card {
    background: ${colors.whiteSurface};
    border: 1px solid ${colors.cardBorder};
    border-radius: ${rounded.lg};
    padding: 24px;
    box-shadow: 0 1px 3px rgba(33, 20, 20, 0.04);
  }

  .cs-status-badge {
    display: inline-flex;
    align-items: center;
    padding: 3px 8px;
    border-radius: ${rounded.sm};
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .cs-status-draft { background: ${colors.cornerCalloutGold}; color: ${colors.ledgerCharcoal}; border: 1px solid ${colors.mutedGold}; }
  .cs-status-approved { background: ${colors.seedlingGreen}; color: #ffffff; border: 1px solid ${colors.seedlingGreen}; }
  .cs-status-pushed { background: ${colors.uniformGreen}; color: #ffffff; border: 1px solid ${colors.shadowPine}; }
  .cs-status-discarded { background: ${colors.mulchBrown}; color: #ffffff; border: 1px solid ${colors.mulchBrown}; }

  .cs-op-pill {
    padding: 2px 6px;
    border-radius: ${rounded.xs};
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .cs-op-create { background: ${colors.feedBagCream}; color: ${colors.seedlingGreen}; border: 1px solid ${colors.seedlingGreen}; }
  .cs-op-update { background: ${colors.feedBagCream}; color: ${colors.uniformGreen}; border: 1px solid ${colors.uniformGreen}; }
  .cs-op-archive { background: #fee2e2; color: ${colors.signetBurgundy}; border: 1px solid ${colors.signetBurgundy}; }
  .cs-op-delete { background: #fee2e2; color: ${colors.signetBurgundy}; border: 1px solid ${colors.signetBurgundy}; }

  .cs-button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    font-size: 12px;
    font-weight: 600;
    border-radius: ${rounded.sm};
    border: 1px solid transparent;
    cursor: pointer;
    transition: all 0.2s;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-family: ${fonts.body};
  }

  .cs-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .cs-btn-primary {
    background: ${colors.uniformGreen};
    color: ${colors.feedBagCream};
    border: 1px solid ${colors.shadowPine};
  }
  .cs-btn-primary:hover:not(:disabled) {
    background: ${colors.shadowPine};
  }

  .cs-btn-success {
    background: ${colors.seedlingGreen};
    color: #ffffff;
  }
  .cs-btn-success:hover:not(:disabled) {
    background: ${colors.uniformGreen};
  }

  .cs-btn-danger {
    background: ${colors.signetBurgundy};
    color: ${colors.feedBagCream};
    border: 1px solid ${colors.burgundyDark};
  }
  .cs-btn-danger:hover:not(:disabled) {
    background: ${colors.burgundyDark};
  }

  .cs-btn-secondary {
    background: ${colors.whiteSurface};
    color: ${colors.ledgerCharcoal};
    border: 1px solid ${colors.cardBorder};
  }
  .cs-btn-secondary:hover:not(:disabled) {
    background: ${colors.feedBagCream};
    border-color: ${colors.uniformGreen};
  }

  .cs-btn-warning {
    background: ${colors.cornerCalloutGold};
    color: ${colors.ledgerCharcoal};
    border: 1px solid ${colors.mutedGold};
  }
  .cs-btn-warning:hover:not(:disabled) {
    background: ${colors.mutedGold};
  }

  .cs-btn-purple {
    background: ${colors.uniformGreen};
    color: ${colors.feedBagCream};
    border: 1px solid ${colors.shadowPine};
  }
  .cs-btn-purple:hover:not(:disabled) {
    background: ${colors.shadowPine};
  }

  .spinner-sm {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid rgba(255, 255, 255, 0.35);
    border-radius: 50%;
    border-top-color: currentColor;
    animation: spin 0.8s linear infinite;
  }
  .spinner-secondary {
    border-top-color: ${colors.uniformGreen};
    border-right-color: transparent;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .cs-banner {
    padding: 12px 16px;
    border-radius: ${rounded.md};
    display: flex;
    flex-direction: column;
    gap: 6px;
    border: 1px solid transparent;
    font-size: 13px;
  }

  .cs-banner-success { background: ${colors.feedBagCream}; border-color: ${colors.seedlingGreen}; color: ${colors.uniformGreen}; }
  .cs-banner-warning { background: ${colors.feedBagCream}; border-color: ${colors.mutedGold}; color: ${colors.ledgerCharcoal}; }
  .cs-banner-error { background: #fee2e2; border-color: ${colors.signetBurgundy}; color: ${colors.signetBurgundy}; }

  .cs-tabs-bar {
    display: flex;
    gap: 16px;
    border-bottom: 2px solid ${colors.cardBorder};
    margin-bottom: 16px;
  }

  .cs-tab-button {
    background: none;
    border: none;
    padding: 10px 4px;
    font-size: 13px;
    font-weight: 600;
    color: ${colors.mulchBrown};
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -2px;
    transition: all 0.2s;
    font-family: ${fonts.body};
  }

  .cs-tab-button:hover {
    color: ${colors.ledgerCharcoal};
  }

  .cs-tab-button-active {
    color: ${colors.uniformGreen};
    border-bottom-color: ${colors.uniformGreen};
    font-weight: 700;
  }

  .cs-table-diff {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  .cs-table-diff th {
    padding: 10px 12px;
    background: ${colors.feedBagCream};
    border-bottom: 2px solid ${colors.cardBorder};
    font-weight: 700;
    color: ${colors.ledgerCharcoal};
    text-align: left;
    font-family: ${fonts.body};
  }

  .cs-table-diff td {
    padding: 10px 12px;
    border-bottom: 1px solid ${colors.cardBorder};
    vertical-align: top;
  }

  .cs-table-diff tr:hover {
    background: ${colors.feedBagCream};
  }

  .diff-path {
    font-family: ${fonts.mono};
    font-weight: 600;
    color: ${colors.ledgerCharcoal};
    word-break: break-all;
  }

  .diff-val-removed {
    background: #fee2e2;
    color: ${colors.signetBurgundy};
    padding: 2px 6px;
    border-radius: ${rounded.xs};
    text-decoration: line-through;
    font-family: ${fonts.mono};
    display: inline-block;
    word-break: break-all;
  }

  .diff-val-added {
    background: ${colors.feedBagCream};
    color: ${colors.seedlingGreen};
    border: 1px solid ${colors.seedlingGreen};
    padding: 2px 6px;
    border-radius: ${rounded.xs};
    font-family: ${fonts.mono};
    display: inline-block;
    word-break: break-all;
  }

  .diff-val-changed-container {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .cs-json-split-container {
    display: flex;
    gap: 16px;
    height: 480px;
    overflow: hidden;
  }

  .cs-json-split-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    border: 1px solid ${colors.cardBorder};
    border-radius: ${rounded.md};
    background: ${colors.ledgerCharcoal};
    overflow: hidden;
  }

  .cs-json-split-col-header {
    background: ${colors.shadowPine};
    border-bottom: 1px solid ${colors.uniformGreen};
    padding: 8px 16px;
    color: ${colors.feedBagCream};
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .cs-json-split-pre {
    flex: 1;
    margin: 0;
    padding: 16px;
    overflow: auto;
    font-family: ${fonts.mono};
    font-size: 12px;
    line-height: 1.5;
    color: ${colors.feedBagCream};
  }

  .cs-item-empty {
    height: 200px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #94a3b8;
    border: 2px dashed #e2e8f0;
    border-radius: 8px;
    gap: 12px;
    text-align: center;
    padding: 24px;
  }

  .product-preview-card {
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 20px;
    background: #ffffff;
    box-shadow: 0 1px 3px rgba(0,0,0,0.02);
  }
  
  .product-preview-grid {
    display: grid;
    grid-template-columns: 140px 1fr;
    gap: 20px;
  }

  .product-preview-image-box {
    width: 140px;
    height: 140px;
    border-radius: 6px;
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  .product-preview-image {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }

  .product-preview-info {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .product-preview-title {
    font-size: 16px;
    font-weight: 700;
    color: #0f172a;
    margin: 0;
  }

  .product-preview-sku {
    font-family: monospace;
    font-size: 11px;
    background: #f1f5f9;
    padding: 2px 6px;
    border-radius: 4px;
    color: #475569;
    align-self: flex-start;
  }

  .product-preview-price {
    font-size: 18px;
    font-weight: 700;
    color: #4f46e5;
  }

  .product-preview-desc {
    font-size: 13px;
    color: #475569;
    line-height: 1.5;
    margin: 0;
  }

  .custom-scrollbar::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }
  .custom-scrollbar::-webkit-scrollbar-track {
    background: transparent;
  }
  .custom-scrollbar::-webkit-scrollbar-thumb {
    background: #cbd5e1;
    border-radius: 3px;
  }
  .custom-scrollbar::-webkit-scrollbar-thumb:hover {
    background: #94a3b8;
  }

  .item-validation-alert {
    background: #fffbeb;
    border: 1px solid #fde68a;
    border-radius: 8px;
    padding: 12px 16px;
    margin-bottom: 16px;
    font-size: 13px;
  }
  .item-validation-alert ul {
    margin: 8px 0 0 0;
    padding-left: 20px;
  }
  .item-validation-alert li {
    margin-bottom: 4px;
  }
`;

export function ChangeSetReview() {
  const [changeSets, setChangeSets] = useState<ChangeSet[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [items, setItems] = useState<ChangeSetItem[]>([]);
  const [selectedItemSku, setSelectedItemSku] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);

  // Filter & tab states
  const [csSearch, setCsSearch] = useState('');
  const [itemSearch, setItemSearch] = useState('');
  const [itemFilter, setItemFilter] = useState<'all' | 'create' | 'update' | 'archive'>('all');
  const [activeTab, setActiveTab] = useState<'diff' | 'json' | 'preview'>('diff');

  const mediaUrl = localStorage.getItem('baystate_cms_media_url') || '';

  const fetch = async () => {
    try {
      const res = await listChangeSets();
      setChangeSets(res.changeSets);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => { fetch(); }, []);

  const handleSelect = async (id: string) => {
    setSelected(id);
    setValidation(null);
    setResult('');
    setError('');
    setSelectedItemSku(null);
    try {
      const res = await getChangeSet(id);
      setItems(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const selectedChangeSet = changeSets.find(cs => cs.id === selected);
  const isDraft = selectedChangeSet?.status === 'draft';
  const isApproved = selectedChangeSet?.status === 'approved';

  const selectedItem = items.find(i => i.sku === selectedItemSku);

  const flattenObject = (obj: any, prefix = ''): Record<string, any> => {
    const res: Record<string, any> = {};
    for (const key in obj) {
      const propName = prefix ? `${prefix}.${key}` : key;
      if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
        Object.assign(res, flattenObject(obj[key], propName));
      } else {
        res[propName] = obj[key];
      }
    }
    return res;
  };

  const computeDiff = (base: string | null, draft: string) => {
    try {
      const b = base ? JSON.parse(base) : {};
      const d = JSON.parse(draft);
      const fb = flattenObject(b);
      const fd = flattenObject(d);
      const allKeys = Array.from(new Set([...Object.keys(fb), ...Object.keys(fd)])).sort();
      return allKeys.map(key => {
        const bv = fb[key];
        const dv = fd[key];
        if (!(key in fb)) return { key, status: 'added' as const, baseVal: undefined, draftVal: dv };
        if (!(key in fd)) return { key, status: 'removed' as const, baseVal: bv, draftVal: undefined };
        if (JSON.stringify(bv) !== JSON.stringify(dv)) return { key, status: 'changed' as const, baseVal: bv, draftVal: dv };
        return null;
      }).filter(Boolean) as Array<{ key: string; status: 'added' | 'removed' | 'changed'; baseVal: any; draftVal: any }>;
    } catch {
      return [];
    }
  };

  const handleValidate = async () => {
    if (!selected) return;
    setLoading(true);
    setActiveAction('validate');
    setError('');
    try {
      const res = await validateChangeSet(selected);
      setValidation(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setActiveAction(null);
    }
  };

  const handleApprove = async () => {
    if (!selected) return;
    setLoading(true);
    setActiveAction('approve');
    setError('');
    try {
      const res = await approveChangeSet(selected);
      if (res.success) {
        setResult(`Approved successfully!\nCommit Hash: ${res.commitHash}`);
        await fetch();
      } else {
        setError(res.errors.join('; '));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setActiveAction(null);
    }
  };

  const handleRepairImages = async () => {
    if (!selected) return;
    setLoading(true);
    setActiveAction('repair-images');
    setError('');
    setResult('');
    try {
      const res = await repairChangeSetImages(selected);
      setResult(res.summary);
      if (!res.success) {
        const failed = res.results.filter(r => r.error);
        setError(`${failed.length} product(s) failed: ${failed.map(f => `${f.sku}: ${f.error}`).join('; ')}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setActiveAction(null);
    }
  };

  const handleExport = async () => {
    if (!selected) return;
    setLoading(true);
    setActiveAction('export');
    setError('');
    try {
      const res = await exportChangeSet(selected);
      if (res.success) {
        setResult(`Export package created successfully!\nXML: ${res.xmlPath}\nManifest: ${res.manifestPath}`);
        window.open(`/api/export/change-set/${selected}/images-zip`, '_blank');
      } else {
        setError('Export failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setActiveAction(null);
    }
  };

  const handlePushPublish = async () => {
    if (!selected) return;
    setLoading(true);
    setActiveAction('pushPublish');
    setError('');
    setResult('');
    try {
      const res = await pushPublish(selected);
      if (res.success) {
        setResult(`Push & Publish started successfully!\nJob ID: ${res.jobId}\nProduct count: ${res.productCount}`);
        if (res.warnings.length > 0) {
          setResult(r => r + '\nWarnings: ' + res.warnings.join('; '));
        }
        window.open(`/api/export/change-set/${selected}/images-zip`, '_blank');
        await fetch();
      } else {
        setError('Push & Publish failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setActiveAction(null);
    }
  };

  const handleUploadOnly = async () => {
    if (!selected) return;
    setLoading(true);
    setActiveAction('uploadOnly');
    setError('');
    setResult('');
    try {
      const res = await uploadOnly(selected);
      if (res.success) {
        setResult(`Upload completed successfully!\nJob ID: ${res.jobId}\nProduct count: ${res.productCount}\nNote: Changes may not be visible until publication.`);
        window.open(`/api/export/change-set/${selected}/images-zip`, '_blank');
        await fetch();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setActiveAction(null);
    }
  };

  const handleDiscard = async () => {
    if (!selected) return;
    if (!confirm('Are you sure you want to discard this change set? This action cannot be undone.')) return;
    setLoading(true);
    setActiveAction('discard');
    setError('');
    try {
      await discardChangeSet(selected);
      setResult('Change set successfully discarded.');
      setSelected(null);
      setItems([]);
      setSelectedItemSku(null);
      setValidation(null);
      await fetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setActiveAction(null);
    }
  };

  const formatDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch {
      return dateStr.slice(0, 10);
    }
  };

  const getProductPreviewData = (jsonStr: string) => {
    try {
      const data = JSON.parse(jsonStr);
      const sku = data.sku || (data.core && data.core.sku) || 'No SKU';
      const status = data.status || 'draft';
      const core = data.core || {};
      const name = core.name || data.name || data.title || 'Unnamed Product';
      const price = core.price || data.price || null;
      const salePrice = core.salePrice || data.salePrice || null;
      const description = core.description || data.description || '';
      
      let primaryImage = '';
      if (core.media && core.media.primary) {
        primaryImage = core.media.primary;
      } else if (data.primaryImage) {
        primaryImage = data.primaryImage;
      } else {
        for (const k of Object.keys(data)) {
          if (k.toLowerCase().includes('image') && typeof data[k] === 'string' && data[k]) {
            primaryImage = data[k];
            break;
          }
        }
      }
      return { name, sku, price, salePrice, description, primaryImage, status, raw: data };
    } catch {
      return null;
    }
  };

  // Filtered change sets
  const filteredChangeSets = changeSets.filter(cs => 
    cs.title.toLowerCase().includes(csSearch.toLowerCase()) ||
    cs.status.toLowerCase().includes(csSearch.toLowerCase()) ||
    cs.id.toLowerCase().includes(csSearch.toLowerCase())
  );

  // Filtered items
  const filteredItems = items.filter(item => {
    const matchesSearch = item.sku.toLowerCase().includes(itemSearch.toLowerCase());
    const matchesFilter = itemFilter === 'all' || item.operation === itemFilter;
    return matchesSearch && matchesFilter;
  });

  const selectedItemValidation = validation?.items.find(v => v.sku === selectedItemSku);

  return (
    <div className="cs-manager-container">
      <style dangerouslySetInnerHTML={{ __html: STYLE_RULES }} />

      {/* Left Sidebar - Change Sets list */}
      <div className="cs-sidebar">
        <div className="cs-sidebar-header">
          <div className="cs-sidebar-title">
            <span>Change Sets</span>
            <button 
              className="cs-button cs-btn-secondary" 
              style={{ padding: '4px 8px', fontSize: '11px', display: 'flex', gap: '4px' }} 
              onClick={fetch}
              disabled={loading}
              title="Refresh Change Sets"
            >
              🔄 Refresh
            </button>
          </div>
          <div className="cs-sidebar-search-container">
            <span className="cs-search-icon">🔍</span>
            <input
              type="text"
              placeholder="Search change sets..."
              className="cs-search-input"
              value={csSearch}
              onChange={(e) => setCsSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="cs-sidebar-list custom-scrollbar">
          {filteredChangeSets.length === 0 && (
            <p style={{ padding: 16, color: '#94a3b8', textAlign: 'center', fontSize: 13 }}>No change sets found.</p>
          )}
          {filteredChangeSets.map(cs => {
            const isActive = selected === cs.id;
            return (
              <div
                key={cs.id}
                className={`cs-card ${isActive ? 'cs-card-active' : ''}`}
                onClick={() => handleSelect(cs.id)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                  <strong style={{ fontSize: 14, color: '#1e293b' }}>{cs.title}</strong>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                  <span className={`cs-status-badge cs-status-${cs.status}`}>{cs.status}</span>
                  <span style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'monospace' }}>
                    {cs.id.slice(0, 8)}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: '#64748b', display: 'flex', justifyContent: 'space-between' }}>
                  <span>Base: <code>{cs.baseCommit.slice(0, 8)}</code></span>
                  <span>{formatDate(cs.createdAt).split(',')[0]}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Main Workspace (selected change set review area) */}
      <div className="cs-workspace">
        {selectedChangeSet ? (
          <>
            {/* Workspace Header */}
            <div className="cs-workspace-header">
              <div className="cs-workspace-title-area">
                <h2 className="cs-workspace-title">{selectedChangeSet.title}</h2>
                <div className="cs-workspace-meta">
                  <span className={`cs-status-badge cs-status-${selectedChangeSet.status}`}>{selectedChangeSet.status}</span>
                  <span>Baseline Commit: <code style={{ background: '#f1f5f9', padding: '2px 4px', borderRadius: 4 }}>{selectedChangeSet.baseCommit.slice(0, 8)}</code></span>
                  <span>Workspace: <span style={{ fontWeight: 600 }}>{selectedChangeSet.workspaceId}</span></span>
                  <span>Created: {formatDate(selectedChangeSet.createdAt)}</span>
                </div>
              </div>

              {/* Actions cluster */}
              <div className="cs-actions">
                {isDraft && (
                  <>
                    <button 
                      className="cs-button cs-btn-secondary" 
                      onClick={handleValidate} 
                      disabled={loading}
                    >
                      {activeAction === 'validate' ? <span className="spinner-sm spinner-secondary" /> : '🔍 Validate'}
                    </button>
                    <button 
                      className="cs-button cs-btn-success" 
                      onClick={handleApprove} 
                      disabled={loading}
                      title="Validate & commit changes to catalog baseline"
                    >
                      {activeAction === 'approve' ? <span className="spinner-sm" /> : '✅ Approve & Commit'}
                    </button>
                    <button 
                      className="cs-button cs-btn-danger" 
                      onClick={handleDiscard} 
                      disabled={loading}
                    >
                      {activeAction === 'discard' ? <span className="spinner-sm" /> : '🗑️ Discard'}
                    </button>
                  </>
                )}
                {isApproved && (
                  <>
                    <button 
                      className="cs-button cs-btn-purple" 
                      onClick={handleExport} 
                      disabled={loading}
                    >
                      {activeAction === 'export' ? <span className="spinner-sm" /> : '📤 Export Package'}
                    </button>
                    <button 
                      className="cs-button cs-btn-secondary" 
                      onClick={() => window.open(`/api/export/change-set/${selected}/xml`, '_blank')} 
                      disabled={loading}
                      title="Download ShopSite products XML file"
                    >
                      📄 Download XML
                    </button>
                    <button 
                      className="cs-button cs-btn-secondary" 
                      onClick={() => window.open(`/api/export/change-set/${selected}/images-zip`, '_blank')} 
                      disabled={loading}
                      title="Download brand-organized images ZIP"
                    >
                      📦 Download Images ZIP
                    </button>
                    <button 
                      className="cs-button cs-btn-warning" 
                      onClick={handleRepairImages} 
                      disabled={loading}
                      title="Re-download product images from onboarding extraction data"
                    >
                      {activeAction === 'repair-images' ? <span className="spinner-sm" /> : '🖼️ Repair Images'}
                    </button>
                    <button 
                      className="cs-button cs-btn-success" 
                      onClick={handlePushPublish} 
                      disabled={loading}
                      title="Publish and build ShopSite pages"
                    >
                      {activeAction === 'pushPublish' ? <span className="spinner-sm" /> : '🚀 Push & Publish'}
                    </button>
                    <button 
                      className="cs-button cs-btn-secondary" 
                      onClick={handleUploadOnly} 
                      disabled={loading}
                      title="Upload changes without publishing"
                    >
                      {activeAction === 'uploadOnly' ? <span className="spinner-sm spinner-secondary" /> : '☁️ Upload Only'}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Error and Result Notification Banners */}
            {error && (
              <div style={{ padding: '12px 24px 0 24px' }}>
                <div className="cs-banner cs-banner-error">
                  <div className="cs-banner-title">⚠️ Operation Failed</div>
                  <div>{error}</div>
                </div>
              </div>
            )}
            {result && (
              <div style={{ padding: '12px 24px 0 24px' }}>
                <div className="cs-banner cs-banner-success">
                  <div className="cs-banner-title">✅ Operation Succeeded</div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{result}</div>
                </div>
              </div>
            )}

            {/* Global validation summary */}
            {validation && (
              <div style={{ padding: '12px 24px 0 24px' }}>
                <div className={`cs-banner ${
                  validation.blockers > 0 ? 'cs-banner-error' : validation.warnings > 0 ? 'cs-banner-warning' : 'cs-banner-success'
                }`}>
                  <div className="cs-banner-title">
                    {validation.blockers > 0 ? '❌ Validation Blocked' : validation.warnings > 0 ? '⚠️ Validation Warnings' : '✅ Validation Passed'}
                  </div>
                  <div style={{ display: 'flex', gap: 16 }}>
                    <span>Blockers: <strong>{validation.blockers}</strong></span>
                    <span>Warnings: <strong>{validation.warnings}</strong></span>
                    <span>Infos: <strong>{validation.infos}</strong></span>
                    <span style={{ marginLeft: 'auto', fontWeight: 700 }}>
                      {validation.canApprove ? '✅ Ready to Approve' : '❌ Cannot Approve (Fix blockers)'}
                    </span>
                  </div>
                  {validation.items.length > 0 && (
                    <div style={{ marginTop: 8, fontSize: 12, borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: 6 }}>
                      <strong>Global Issues:</strong>
                      <div style={{ maxHeight: 100, overflowY: 'auto', marginTop: 4 }}>
                        {validation.items.map(item =>
                          item.results.map((r, idx) => (
                            <div key={`${item.sku}-${r.code}-${idx}`} style={{ margin: '2px 0' }}>
                              <code>{item.sku}</code>: [{r.code}] {r.message}
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Split review workspace body */}
            <div className="cs-split-body">
              {/* Products/Items modified list sidebar */}
              <div className="cs-items-sidebar">
                <div className="cs-items-sidebar-header">
                  <h3 className="cs-items-sidebar-title">Staged Items ({items.length})</h3>
                  <div className="cs-sidebar-search-container">
                    <span className="cs-search-icon">🔍</span>
                    <input
                      type="text"
                      placeholder="Filter SKU / name..."
                      className="cs-search-input"
                      value={itemSearch}
                      onChange={(e) => setItemSearch(e.target.value)}
                    />
                  </div>

                  {/* Filter tabs */}
                  <div style={{ display: 'flex', gap: 4, background: '#f1f5f9', padding: 2, borderRadius: 6 }}>
                    {(['all', 'create', 'update', 'archive'] as const).map(op => (
                      <button
                        key={op}
                        onClick={() => setItemFilter(op)}
                        style={{
                          flex: 1,
                          border: 'none',
                          background: itemFilter === op ? '#ffffff' : 'transparent',
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '4px 0',
                          borderRadius: 4,
                          cursor: 'pointer',
                          color: itemFilter === op ? '#0f172a' : '#64748b',
                          boxShadow: itemFilter === op ? '0 1px 2px rgba(0,0,0,0.05)' : 'none',
                          textTransform: 'uppercase'
                        }}
                      >
                        {op === 'all' ? 'All' : op}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="cs-items-scroller custom-scrollbar">
                  {filteredItems.length === 0 && (
                    <p style={{ padding: 16, color: '#94a3b8', textAlign: 'center', fontSize: 12 }}>No matching items.</p>
                  )}
                  {filteredItems.map(item => {
                    const isSelected = selectedItemSku === item.sku;
                    return (
                      <div
                        key={item.sku}
                        className={`cs-item-row ${isSelected ? 'cs-item-row-active' : ''}`}
                        onClick={() => {
                          setSelectedItemSku(item.sku);
                          setActiveTab('diff'); // reset to diff view on item change
                        }}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: '#334155' }}>{item.sku}</span>
                          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                            <span className={`cs-op-pill cs-op-${item.operation}`}>{item.operation}</span>
                            {item.validationStatus !== 'unknown' && (
                              <span style={{ 
                                fontSize: 10, 
                                fontWeight: 600,
                                color: item.validationStatus === 'blocked' ? '#e11d48' : item.validationStatus === 'valid' ? '#059669' : '#d97706'
                              }}>
                                • {item.validationStatus}
                              </span>
                            )}
                          </div>
                        </div>
                        <span style={{ fontSize: 16 }}>{item.operation === 'create' ? '➕' : item.operation === 'archive' || item.operation === 'delete' ? '🗑️' : '📝'}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Details Pane (Diff, JSON, Preview) */}
              <div className="cs-detail-panel custom-scrollbar">
                {selectedItem ? (
                  <div className="cs-detail-card">
                    {/* Item header */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, borderBottom: '1px solid #e2e8f0', paddingBottom: 12 }}>
                      <div>
                        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#0f172a' }}>
                          Staged Changes for SKU: <span style={{ fontFamily: 'monospace', background: '#f1f5f9', padding: '2px 6px', borderRadius: 4 }}>{selectedItem.sku}</span>
                        </h3>
                        <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center' }}>
                          <span className={`cs-op-pill cs-op-${selectedItem.operation}`}>{selectedItem.operation}</span>
                          <span style={{ fontSize: 12, color: '#64748b' }}>
                            Validation: <strong>{selectedItem.validationStatus}</strong>
                          </span>
                        </div>
                      </div>

                      {/* Tab buttons */}
                      <div className="cs-tabs-bar" style={{ marginBottom: 0, borderBottom: 'none' }}>
                        <button 
                          className={`cs-tab-button ${activeTab === 'diff' ? 'cs-tab-button-active' : ''}`}
                          onClick={() => setActiveTab('diff')}
                        >
                          Visual Diff
                        </button>
                        <button 
                          className={`cs-tab-button ${activeTab === 'json' ? 'cs-tab-button-active' : ''}`}
                          onClick={() => setActiveTab('json')}
                        >
                          Raw JSON Comparison
                        </button>
                        <button 
                          className={`cs-tab-button ${activeTab === 'preview' ? 'cs-tab-button-active' : ''}`}
                          onClick={() => setActiveTab('preview')}
                        >
                          Live Preview Card
                        </button>
                      </div>
                    </div>

                    {/* Item-level warnings/validation blockers */}
                    {selectedItemValidation && selectedItemValidation.results.length > 0 && (
                      <div className="item-validation-alert">
                        <strong>⚠️ Validation Issues Staged:</strong>
                        <ul>
                          {selectedItemValidation.results.map((r, idx) => (
                            <li key={idx} style={{ color: r.severity === 'blocker' ? '#be123c' : '#b45309' }}>
                              <strong>[{r.severity.toUpperCase()}]</strong> {r.fieldPath ? `(${r.fieldPath})` : ''} {r.message}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Tab contents */}
                    {activeTab === 'diff' && (
                      <div style={{ overflowX: 'auto' }}>
                        {selectedItem.operation === 'create' && (
                          <div className="cs-banner cs-banner-success" style={{ marginBottom: 16 }}>
                            <span>➕ This is a <strong>New Product</strong> draft. The table below lists all staged attributes.</span>
                          </div>
                        )}
                        {selectedItem.operation === 'archive' && (
                          <div className="cs-banner cs-banner-error" style={{ marginBottom: 16 }}>
                            <span>🗑️ This product is scheduled to be <strong>Archived/Deleted</strong>.</span>
                          </div>
                        )}

                        <table className="cs-table-diff">
                          <thead>
                            <tr>
                              <th style={{ width: '25%' }}>Attribute Field</th>
                              <th style={{ width: '37.5%' }}>Original Value</th>
                              <th style={{ width: '37.5%' }}>Staged Value</th>
                            </tr>
                          </thead>
                          <tbody>
                            {computeDiff(selectedItem.baseJson, selectedItem.draftJson).map(diff => {
                              const isAdded = diff.status === 'added';
                              const isRemoved = diff.status === 'removed';
                              const isChanged = diff.status === 'changed';
                              
                              return (
                                <tr key={diff.key} style={{ background: isAdded ? '#f0fdf4' : isRemoved ? '#fff1f2' : '#fffbeb' }}>
                                  <td className="diff-path">{diff.key}</td>
                                  <td>
                                    {isRemoved && <span className="diff-val-removed">{String(diff.baseVal)}</span>}
                                    {isChanged && <span className="diff-val-removed">{String(diff.baseVal)}</span>}
                                    {isAdded && <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>none</span>}
                                  </td>
                                  <td>
                                    {isAdded && <span className="diff-val-added">{String(diff.draftVal)}</span>}
                                    {isChanged && (
                                      <div className="diff-val-changed-container">
                                        <span className="diff-val-added">{String(diff.draftVal)}</span>
                                      </div>
                                    )}
                                    {isRemoved && <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>removed</span>}
                                  </td>
                                </tr>
                              );
                            })}
                            {computeDiff(selectedItem.baseJson, selectedItem.draftJson).length === 0 && (
                              <tr>
                                <td colSpan={3} style={{ textAlign: 'center', color: '#94a3b8', padding: '24px' }}>
                                  No differences detected in attributes.
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {activeTab === 'json' && (
                      <div className="cs-json-split-container">
                        <div className="cs-json-split-col">
                          <div className="cs-json-split-col-header">Original Base (Baseline)</div>
                          <pre className="cs-json-split-pre custom-scrollbar">
                            {selectedItem.baseJson 
                              ? JSON.stringify(JSON.parse(selectedItem.baseJson), null, 2)
                              : '// No base database record (New Item)'}
                          </pre>
                        </div>
                        <div className="cs-json-split-col">
                          <div className="cs-json-split-col-header">Staged Draft Changes</div>
                          <pre className="cs-json-split-pre custom-scrollbar">
                            {selectedItem.draftJson 
                              ? JSON.stringify(JSON.parse(selectedItem.draftJson), null, 2)
                              : '// No draft JSON (Deleted/Archived)'}
                          </pre>
                        </div>
                      </div>
                    )}

                    {activeTab === 'preview' && (
                      <div>
                        {(() => {
                          const previewData = getProductPreviewData(selectedItem.draftJson || selectedItem.baseJson || '{}');
                          if (!previewData) {
                            return (
                              <div className="cs-item-empty">
                                <span>Failed to parse item catalog preview data</span>
                              </div>
                            );
                          }
                          return (
                            <div className="product-preview-card">
                              <div className="product-preview-grid">
                                <div className="product-preview-image-box">
                                  {previewData.primaryImage ? (
                                    <img
                                      src={mediaUrl ? (mediaUrl.endsWith('/') ? mediaUrl : mediaUrl + '/') + previewData.primaryImage : previewData.primaryImage}
                                      alt={previewData.name}
                                      className="product-preview-image"
                                      onError={(e) => {
                                        (e.target as HTMLImageElement).style.display = 'none';
                                      }}
                                    />
                                  ) : (
                                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#94a3b8' }}>
                                      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                                      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                                      <line x1="12" y1="22.08" x2="12" y2="12" />
                                    </svg>
                                  )}
                                </div>
                                
                                <div className="product-preview-info">
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                    <h4 className="product-preview-title">{previewData.name}</h4>
                                    <span className={`cs-status-badge cs-status-${previewData.status === 'active' ? 'approved' : 'draft'}`}>
                                      {previewData.status}
                                    </span>
                                  </div>
                                  
                                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                                    <span className="product-preview-sku">SKU: {previewData.sku}</span>
                                  </div>
                                  
                                  <div className="product-preview-price">
                                    {previewData.salePrice ? (
                                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                                        <span>${previewData.salePrice}</span>
                                        <span style={{ fontSize: 12, textDecoration: 'line-through', color: '#94a3b8', fontWeight: 500 }}>
                                          ${previewData.price}
                                        </span>
                                      </div>
                                    ) : (
                                      <span>{previewData.price ? `$${previewData.price}` : 'No Price Set'}</span>
                                    )}
                                  </div>
                                  
                                  <p className="product-preview-desc">
                                    {previewData.description ? previewData.description.replace(/<[^>]*>/g, '') : 'No description text.'}
                                  </p>
                                </div>
                              </div>
                              
                              {/* Extended schema visual check */}
                              <div style={{ marginTop: 20, borderTop: '1px solid #e2e8f0', paddingTop: 16 }}>
                                <h5 style={{ margin: '0 0 10px 0', fontSize: 12, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                  Schema Attributes & Custom Data
                                </h5>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px 20px' }}>
                                  {previewData.raw.core && (
                                    <>
                                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, borderBottom: '1px solid #f1f5f9', paddingBottom: 3 }}>
                                        <span style={{ color: '#64748b' }}>Weight:</span>
                                        <span style={{ fontWeight: 600, color: '#334155' }}>{previewData.raw.core.weight || 'N/A'}</span>
                                      </div>
                                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, borderBottom: '1px solid #f1f5f9', paddingBottom: 3 }}>
                                        <span style={{ color: '#64748b' }}>Taxable:</span>
                                        <span style={{ fontWeight: 600, color: '#334155' }}>{previewData.raw.core.taxable ? 'Yes' : 'No'}</span>
                                      </div>
                                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, borderBottom: '1px solid #f1f5f9', paddingBottom: 3 }}>
                                        <span style={{ color: '#64748b' }}>QOH:</span>
                                        <span style={{ fontWeight: 600, color: '#334155' }}>
                                          {previewData.raw.core.inventory?.quantityOnHand !== undefined && previewData.raw.core.inventory?.quantityOnHand !== null 
                                            ? previewData.raw.core.inventory.quantityOnHand 
                                            : 'Unlimited'}
                                        </span>
                                      </div>
                                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, borderBottom: '1px solid #f1f5f9', paddingBottom: 3 }}>
                                        <span style={{ color: '#64748b' }}>Availability:</span>
                                        <span style={{ fontWeight: 600, color: '#334155' }}>{previewData.raw.core.availability || 'In Stock'}</span>
                                      </div>
                                    </>
                                  )}
                                  {previewData.raw.customFields && Object.entries(previewData.raw.customFields).map(([k, v]) => (
                                    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, borderBottom: '1px solid #f1f5f9', paddingBottom: 3 }}>
                                      <span style={{ color: '#64748b' }}>{k}:</span>
                                      <span style={{ fontWeight: 600, color: '#334155', maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={String(v)}>
                                        {String(v)}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="cs-item-empty">
                    <span>👈 Select a staged product item from the sidebar to review attribute differences</span>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="cs-empty-state">
            <div className="cs-empty-icon">📂</div>
            <h3 style={{ margin: '0 0 8px 0', fontSize: 18, fontWeight: 700, color: '#334155' }}>Select a Change Set</h3>
            <p style={{ margin: 0, fontSize: 14, color: '#64748b', maxWidth: 360 }}>
              Choose a change set from the sidebar to review modifications, run validations, and publish updates to ShopSite.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
