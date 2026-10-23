import React, { useState, useEffect } from 'react';
import { 
  runCatalogHealthCheck, 
  getCatalogHealthReport, 
  getHealthConfig, 
  saveHealthConfig, 
  listFieldRegistry,
  getStoreManagerInsights,
  listStoreManagerProposals,
  generateStoreManagerProposals,
  applyStoreManagerProposal,
  dismissStoreManagerProposal,
  getStoreManagerReport,
  type CatalogHealthReport, 
  type CatalogHealthIssue, 
  type HealthRuleConfig,
  type CatalogProposal,
  type ProductFieldAuditReport
} from '../api';
import type { StoreManagerReportResponse } from '../../shared/schemas/store-manager-report';
import { ViewHeader } from './common/ViewHeader';

const STYLE_RULES = `
  .store-manager-container {
    padding: 32px 24px;
    max-width: 1250px;
    margin: 0 auto;
    color: #1f2937;
    animation: fadeIn 0.4s ease-out;
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  
  .store-manager-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
    gap: 16px;
    flex-wrap: wrap;
  }
  
  .title-group h1 {
    font-size: 28px;
    font-weight: 800;
    color: #111827;
    margin: 0 0 6px 0;
    letter-spacing: -0.6px;
  }
  
  .title-group p {
    color: #6b7280;
    margin: 0;
    font-size: 14px;
    font-weight: 500;
  }
  
  /* Tabs Navigation */
  .store-manager-tabs {
    display: flex;
    gap: 8px;
    border-bottom: 1px solid #e5e7eb;
    margin-bottom: 32px;
    overflow-x: auto;
    padding-bottom: 1px;
  }
  
  .tab-btn {
    background: none;
    border: none;
    padding: 12px 20px;
    font-size: 14px;
    font-weight: 600;
    color: #4b5563;
    cursor: pointer;
    position: relative;
    white-space: nowrap;
    transition: all 0.2s;
  }
  
  .tab-btn:hover {
    color: #111827;
  }
  
  .tab-btn.active {
    color: #4f46e5;
  }
  
  .tab-btn.active::after {
    content: '';
    position: absolute;
    bottom: -1px;
    left: 0;
    right: 0;
    height: 2px;
    background: #4f46e5;
    border-radius: 2px;
  }
  
  /* General Buttons */
  .btn-primary {
    background: linear-gradient(135deg, #4f46e5 0%, #6366f1 100%);
    color: white;
    border: none;
    padding: 10px 18px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow: 0 4px 12px rgba(79, 70, 229, 0.25);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  
  .btn-primary:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 6px 16px rgba(79, 70, 229, 0.35);
    filter: brightness(1.05);
  }
  
  .btn-primary:active:not(:disabled) {
    transform: translateY(1px);
  }
  
  .btn-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    box-shadow: none;
  }
  
  .btn-secondary {
    background: white;
    color: #374151;
    border: 1px solid #e5e7eb;
    padding: 10px 18px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  
  .btn-secondary:hover:not(:disabled) {
    background: #f9fafb;
    border-color: #cbd5e1;
    color: #111827;
  }
  
  .btn-secondary.active {
    background: #f5f3ff;
    border-color: #c7d2fe;
    color: #4f46e5;
  }
  
  /* KPI Cards */
  .health-kpi-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 20px;
    margin-bottom: 32px;
  }
  
  .health-kpi-card {
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 16px;
    padding: 24px;
    position: relative;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
    transition: all 0.2s;
  }
  
  .health-kpi-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 10px 20px rgba(0, 0, 0, 0.03);
    border-color: #cbd5e1;
  }
  
  .kpi-score-ring {
    position: absolute;
    top: 24px;
    right: 24px;
    width: 50px;
    height: 50px;
  }
  
  .kpi-label {
    font-size: 11px;
    font-weight: 700;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    margin-bottom: 8px;
  }
  
  .kpi-value {
    font-size: 32px;
    font-weight: 800;
    color: #111827;
    line-height: 1.1;
    margin-bottom: 8px;
  }
  
  .kpi-subtext {
    font-size: 13px;
    color: #6b7280;
    font-weight: 500;
  }
  
  /* Settings panel styling */
  .settings-panel {
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 16px;
    padding: 24px;
    margin-bottom: 32px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.03);
  }
  
  .settings-title-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
    padding-bottom: 12px;
    border-bottom: 1px solid #f3f4f6;
  }
  
  .settings-title-row h2 {
    font-size: 18px;
    font-weight: 800;
    color: #111827;
    margin: 0;
  }
  
  .rules-grid {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-bottom: 24px;
    max-height: 350px;
    overflow-y: auto;
  }
  
  .rule-config-row {
    display: grid;
    grid-template-columns: 2fr 1fr;
    align-items: center;
    gap: 16px;
    padding: 12px 16px;
    border: 1px solid #f3f4f6;
    background: #fafafa;
    border-radius: 10px;
  }
  
  .rule-info h4 {
    margin: 0 0 4px 0;
    font-size: 13.5px;
    color: #1f2937;
  }
  
  .rule-info p {
    margin: 0;
    font-size: 12px;
    color: #6b7280;
  }
  
  .rule-default-badge {
    font-size: 10px;
    background: #e2e8f0;
    color: #475569;
    padding: 1px 6px;
    border-radius: 4px;
    font-weight: 500;
    margin-left: 8px;
  }
  
  .severity-select {
    padding: 6px 12px;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  
  .settings-actions {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    padding-top: 16px;
    border-top: 1px solid #f3f4f6;
  }
  
  /* Filter and search bar */
  .filter-section {
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 16px 20px;
    margin-bottom: 24px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }
  
  .search-input-wrapper {
    position: relative;
    flex-grow: 1;
    max-width: 400px;
  }
  
  .search-input {
    width: 100%;
    padding: 8px 12px 8px 36px;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    font-size: 14px;
    outline: none;
    box-sizing: border-box;
  }
  
  .search-icon {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    color: #9ca3af;
  }
  
  .filter-tabs {
    display: flex;
    gap: 8px;
  }
  
  .filter-btn {
    background: none;
    border: 1px solid #e5e7eb;
    padding: 8px 14px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    color: #4b5563;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .filter-btn.active {
    background: #f3f4f6;
    border-color: #d1d5db;
    color: #111827;
  }
  
  /* Issue List Card view */
  .product-issue-card {
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    margin-bottom: 16px;
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(0,0,0,0.02);
  }
  
  .product-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    cursor: pointer;
    background: #fafafa;
    user-select: none;
  }
  
  .product-card-header:hover {
    background: #f5f5f5;
  }
  
  .product-title-area {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  
  .product-badge-blocker {
    background: #fef2f2;
    color: #ef4444;
    padding: 4px 10px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 700;
    border: 1px solid #fecaca;
  }
  
  .product-badge-warning {
    background: #fffbeb;
    color: #f59e0b;
    padding: 4px 10px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 700;
    border: 1px solid #fef3c7;
  }
  
  .product-badge-info {
    background: #ecfdf5;
    color: #10b981;
    padding: 4px 10px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 700;
    border: 1px solid #a7f3d0;
  }
  
  .product-meta h3 {
    margin: 0 0 2px 0;
    font-size: 15px;
    font-weight: 700;
    color: #111827;
  }
  
  .product-meta span {
    font-size: 12px;
    color: #6b7280;
    font-weight: 500;
  }
  
  .header-actions {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  
  .btn-edit-product {
    background: white;
    border: 1px solid #d1d5db;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    color: #374151;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    transition: all 0.2s;
  }
  
  .btn-edit-product:hover {
    background: #f9fafb;
    color: #111827;
    border-color: #cbd5e1;
  }
  
  .chevron-icon {
    transition: transform 0.2s;
    color: #9ca3af;
  }
  
  .chevron-icon.open {
    transform: rotate(180deg);
  }
  
  .product-card-body {
    border-top: 1px solid #e5e7eb;
    padding: 16px 20px;
    background: white;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  
  .issue-row {
    display: flex;
    gap: 12px;
    padding: 12px;
    border-radius: 8px;
  }
  
  .issue-row.blocker { background: #fef2f2; border-left: 4px solid #ef4444; }
  .issue-row.warning { background: #fffbeb; border-left: 4px solid #f59e0b; }
  .issue-row.info { background: #ecfdf5; border-left: 4px solid #10b981; }
  
  .issue-msg {
    margin: 0 0 4px 0;
    font-size: 13.5px;
    font-weight: 600;
    color: #1f2937;
  }
  
  .issue-code {
    font-size: 11px;
    color: #6b7280;
    font-weight: 500;
    display: flex;
    gap: 12px;
  }
  
  .issue-field {
    font-weight: 600;
    color: #4b5563;
  }
  
  .empty-state {
    text-align: center;
    padding: 60px 40px;
    background: white;
    border: 1px dashed #cbd5e1;
    border-radius: 16px;
    color: #6b7280;
  }
  
  .empty-state h3 {
    margin: 0 0 8px 0;
    color: #1f2937;
  }
  
  .empty-state p {
    margin: 0;
    font-size: 14px;
  }
  
  /* Audit Report & Cleanup Tab CSS */
  .cleanup-controls-bar {
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 16px 20px;
    margin-bottom: 24px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }
  
  .field-select-group {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  
  .field-select-label {
    font-size: 14px;
    font-weight: 700;
    color: #374151;
  }
  
  .field-select {
    padding: 8px 16px;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    color: #1f2937;
    background: white;
    cursor: pointer;
    outline: none;
  }
  
  .field-select:focus {
    border-color: #4f46e5;
    box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.12);
  }
  
  .cleanup-actions-group {
    display: flex;
    gap: 12px;
  }
  
  .audit-kpi-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 20px;
    margin-bottom: 32px;
  }
  
  .audit-kpi-card {
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 20px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.01);
  }
  
  .cleanup-section-card {
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 16px;
    padding: 24px;
    margin-bottom: 24px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
  }
  
  .cleanup-section-card h3 {
    margin: 0 0 16px 0;
    font-size: 16px;
    font-weight: 800;
    color: #111827;
    border-bottom: 1px solid #f3f4f6;
    padding-bottom: 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  
  .cleanup-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13.5px;
    text-align: left;
  }
  
  .cleanup-table th {
    padding: 10px 12px;
    background: #f8fafc;
    color: #475569;
    font-weight: 700;
    border-bottom: 2px solid #e2e8f0;
  }
  
  .cleanup-table td {
    padding: 12px;
    border-bottom: 1px solid #f1f5f9;
    color: #334155;
  }
  
  .cleanup-table tr:last-child td {
    border-bottom: none;
  }
  
  .casing-value-item {
    padding: 4px 8px;
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    font-family: monospace;
    font-size: 12px;
    margin-right: 8px;
    display: inline-block;
  }
  
  /* Proposal card layout */
  .proposal-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 16px;
  }
  
  .proposal-card {
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.02);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 20px;
    transition: all 0.2s;
  }
  
  .proposal-card:hover {
    border-color: #cbd5e1;
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0,0,0,0.03);
  }
  
  .proposal-info {
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex-grow: 1;
  }
  
  .proposal-field-badge {
    background: #e0e7ff;
    color: #4338ca;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 700;
    display: inline-block;
    align-self: flex-start;
  }
  
  .proposal-source-badge-ai {
    background: #f5f3ff;
    color: #6d28d9;
    border: 1px solid #ddd6fe;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 700;
    display: inline-block;
    align-self: flex-start;
  }
  
  .proposal-source-badge-det {
    background: #ecfdf5;
    color: #047857;
    border: 1px solid #a7f3d0;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 700;
    display: inline-block;
    align-self: flex-start;
  }
  
  .proposal-diff-flow {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 15px;
    font-weight: 700;
    flex-wrap: wrap;
  }
  
  .old-val-text {
    color: #ef4444;
    text-decoration: line-through;
    background: #fef2f2;
    padding: 2px 6px;
    border-radius: 4px;
  }
  
  .new-val-text {
    color: #10b981;
    background: #ecfdf5;
    padding: 2px 6px;
    border-radius: 4px;
  }
  
  .proposal-meta-details {
    display: flex;
    gap: 16px;
    font-size: 12.5px;
    color: #64748b;
    font-weight: 500;
    align-items: center;
  }
  
  .proposal-reason {
    color: #334155;
    font-weight: 600;
  }
  
  .proposal-actions {
    display: flex;
    gap: 10px;
  }
  
  /* Assistant markdown area */
  .assistant-report-body {
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 16px;
    padding: 32px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.02);
    line-height: 1.6;
    color: #334155;
  }
  
  .assistant-status-bar {
    background: #f5f3ff;
    border: 1px solid #ddd6fe;
    padding: 12px 20px;
    border-radius: 12px;
    color: #6d28d9;
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 24px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  
  /* Loader helper */
  .tab-loader {
    text-align: center;
    padding: 80px 40px;
  }
  
  .spinner-ring {
    display: inline-block;
    width: 32px;
    height: 32px;
    border: 3px solid #e2e8f0;
    border-top-color: #4f46e5;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
`;

interface CatalogHealthProps {
  onSelectProduct: (sku: string) => void;
}

export function CatalogHealth({ onSelectProduct }: CatalogHealthProps) {
  // Navigation / Tabs
  const [activeTab, setActiveTab] = useState<'overview' | 'cleanup' | 'proposals' | 'assistant'>('overview');
  
  // General health report states
  const [report, setReport] = useState<CatalogHealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'blockers' | 'warnings'>('all');
  const [expandedProducts, setExpandedProducts] = useState<Record<string, boolean>>({});

  // Configuration States
  const [showSettings, setShowSettings] = useState(false);
  const [rules, setRules] = useState<HealthRuleConfig[]>([]);
  const [savingSettings, setSavingSettings] = useState(false);

  // Store Manager states
  const [selectedField, setSelectedField] = useState('ProductField24'); // default category
  const [customFields, setCustomFields] = useState<Array<{ xmlField: string; label: string }>>([]);
  const [auditReport, setAuditReport] = useState<ProductFieldAuditReport | null>(null);
  const [proposals, setProposals] = useState<CatalogProposal[]>([]);
  const [assistantReport, setAssistantReport] = useState<StoreManagerReportResponse | null>(null);
  
  // Loading sub-states
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [loadingProposals, setLoadingProposals] = useState(false);
  const [loadingAssistant, setLoadingAssistant] = useState(false);
  const [generatingProposals, setGeneratingProposals] = useState(false);
  const [applyingProposalId, setApplyingProposalId] = useState<string | null>(null);
  const [aiScanStatus, setAiScanStatus] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // 1. Initial Load of Health Report & Config
  const fetchReport = async () => {
    try {
      setLoading(true);
      const data = await getCatalogHealthReport();
      setReport(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load health report');
    } finally {
      setLoading(false);
    }
  };

  const fetchConfig = async () => {
    try {
      const data = await getHealthConfig();
      setRules(data.rules);
    } catch (err) {
      console.error('Failed to load health rules config:', err);
    }
  };

  // Load Custom Fields from Field Registry
  const fetchCustomFields = async () => {
    try {
      const res = await listFieldRegistry();
      // Filter fields that are custom or start with ProductField
      const fields = (res.entries || [])
        .filter((f: any) => f.kind === 'custom' || f.xmlField.startsWith('ProductField'))
        .map((f: any) => ({
          xmlField: f.xmlField,
          label: f.label || f.xmlField,
        }));
      
      // Fallback defaults if registry is empty
      if (fields.length === 0) {
        fields.push(
          { xmlField: 'ProductField24', label: 'Category (ProductField24)' },
          { xmlField: 'ProductField16', label: 'Brand (ProductField16)' }
        );
      }
      setCustomFields(fields);
    } catch (err) {
      console.error('Failed to load custom fields registry:', err);
    }
  };

  useEffect(() => {
    fetchReport();
    fetchConfig();
    fetchCustomFields();
  }, []);

  // 2. Load tab-specific data when active tab changes
  useEffect(() => {
    if (activeTab === 'cleanup') {
      loadAuditReport(selectedField);
    } else if (activeTab === 'proposals') {
      loadProposals();
    } else if (activeTab === 'assistant') {
      loadAssistantReport();
    }
  }, [activeTab, selectedField]);

  // Tab Load functions
  const loadAuditReport = async (field: string) => {
    try {
      setLoadingAudit(true);
      const data = await getStoreManagerInsights(field);
      setAuditReport(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load custom field insights');
    } finally {
      setLoadingAudit(false);
    }
  };

  const loadProposals = async () => {
    try {
      setLoadingProposals(true);
      const res = await listStoreManagerProposals();
      setProposals(res.proposals || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load proposals');
    } finally {
      setLoadingProposals(false);
    }
  };

  const loadAssistantReport = async () => {
    try {
      setLoadingAssistant(true);
      const data = await getStoreManagerReport();
      setAssistantReport(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate store assistant notes');
    } finally {
      setLoadingAssistant(false);
    }
  };

  // Actions
  const handleRunScan = async () => {
    setScanning(true);
    setError(null);
    try {
      const data = await runCatalogHealthCheck();
      setReport(data);
      // Automatically expand products with issues in the new scan
      const newExp: Record<string, boolean> = {};
      data.issues.forEach(i => {
        newExp[i.sku] = true;
      });
      setExpandedProducts(newExp);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Catalog health check failed');
    } finally {
      setScanning(false);
    }
  };

  const handleSeverityChange = (code: string, severity: 'blocker' | 'warning' | 'info' | 'disabled') => {
    setRules(prev => prev.map(r => r.code === code ? { ...r, severity } : r));
  };

  const handleSaveConfig = async () => {
    setSavingSettings(true);
    setError(null);
    try {
      await saveHealthConfig(rules);
      setShowSettings(false);
      await handleRunScan();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save health settings');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleRestoreDefaults = () => {
    setRules(prev => prev.map(r => ({ ...r, severity: r.defaultSeverity })));
  };

  const toggleProduct = (sku: string, e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.btn-edit-product')) {
      return;
    }
    setExpandedProducts(prev => ({ ...prev, [sku]: !prev[sku] }));
  };

  // Generate proposals action
  const handleGenerateProposals = async (useAi = false) => {
    setGeneratingProposals(true);
    setAiScanStatus(useAi ? 'Checking product details...' : 'Looking for formatting issues...');
    setError(null);
    setSuccessMessage(null);
    try {
      const res = await generateStoreManagerProposals(selectedField, useAi);
      if (res.success) {
        setSuccessMessage(`${res.proposals.length} suggestions are ready. Review them before adding any changes.`);
        // Navigate to proposals tab
        setActiveTab('proposals');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate proposals');
    } finally {
      setGeneratingProposals(false);
      setAiScanStatus(null);
    }
  };

  // Apply proposal
  const handleApplyProposal = async (id: string) => {
    setApplyingProposalId(id);
    setError(null);
    setSuccessMessage(null);
    try {
      const res = await applyStoreManagerProposal(id);
      if (res.success) {
        setSuccessMessage('The changes are ready for your review.');
        // reload proposals
        await loadProposals();
        // reload health report
        await getCatalogHealthReport().then(setReport);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply proposal');
    } finally {
      setApplyingProposalId(null);
    }
  };

  // Dismiss proposal
  const handleDismissProposal = async (id: string) => {
    setError(null);
    setSuccessMessage(null);
    try {
      const res = await dismissStoreManagerProposal(id);
      if (res.success) {
        setSuccessMessage('Suggestion removed.');
        await loadProposals();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to dismiss proposal');
    }
  };

  // Helper renderer for Markdown in assistant report
  const renderMarkdown = (md: string) => {
    if (!md) return null;
    return md.split('\n').map((line, idx) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('# ')) {
        return <h1 key={idx} className="view-title" style={{ fontSize: '1.375rem', margin: '16px 0 8px', borderBottom: '1px solid var(--color-card-border)', paddingBottom: '6px' }}>{trimmed.substring(2)}</h1>;
      }
      if (trimmed.startsWith('## ')) {
        return <h2 key={idx} className="section-title" style={{ fontSize: '1.125rem', margin: '14px 0 6px' }}>{trimmed.substring(3)}</h2>;
      }
      if (trimmed.startsWith('### ')) {
        return <h3 key={idx} className="card-title" style={{ fontSize: '1rem', margin: '12px 0 4px' }}>{trimmed.substring(4)}</h3>;
      }
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        return <li key={idx} style={{ marginLeft: '20px', listStyleType: 'disc', margin: '4px 0', fontSize: '14px', color: '#4b5563' }}>{trimmed.substring(2)}</li>;
      }
      if (/^\d+\.\s/.test(trimmed)) {
        const content = trimmed.replace(/^\d+\.\s/, '');
        return <li key={idx} style={{ marginLeft: '20px', listStyleType: 'decimal', margin: '4px 0', fontSize: '14px', color: '#4b5563' }}>{content}</li>;
      }
      if (trimmed === '') {
        return <div key={idx} style={{ height: '12px' }} />;
      }
      return <p key={idx} style={{ margin: '6px 0', fontSize: '14px', color: '#374151', lineHeight: '1.6' }}>{line}</p>;
    });
  };

  // Initial loader
  if (loading && !report) {
    return (
      <div style={{ textAlign: 'center', padding: 100 }}>
        <style>{STYLE_RULES}</style>
        <div className="spinner-ring" />
        <p style={{ marginTop: 16, color: '#6b7280', fontWeight: 600 }}>Loading Store Manager...</p>
      </div>
    );
  }

  const { totalProducts = 0, healthyProducts = 0, unhealthyProducts = 0, totalErrors = 0, totalWarnings = 0, issues = [] } = report || {};
  const healthScore = totalProducts > 0 ? Math.round((healthyProducts / totalProducts) * 100) : 100;

  // Group issues by SKU
  const issuesByProduct: Record<string, { title: string; sku: string; issues: CatalogHealthIssue[] }> = {};
  issues.forEach(issue => {
    if (!issuesByProduct[issue.sku]) {
      issuesByProduct[issue.sku] = {
        sku: issue.sku,
        title: issue.title,
        issues: [],
      };
    }
    issuesByProduct[issue.sku].issues.push(issue);
  });

  const productSkus = Object.keys(issuesByProduct);
  const filteredProductsList = productSkus
    .map(sku => issuesByProduct[sku])
    .filter(prod => {
      const matchesSearch = prod.sku.toLowerCase().includes(search.toLowerCase()) || 
                            prod.title.toLowerCase().includes(search.toLowerCase());
      if (!matchesSearch) return false;

      if (filterType === 'blockers') {
        return prod.issues.some(i => i.severity === 'blocker');
      }
      if (filterType === 'warnings') {
        return prod.issues.some(i => i.severity === 'warning');
      }
      return true;
    });

  return (
    <div className="store-manager-container">
      <style>{STYLE_RULES}</style>

      {/* Header */}
      <ViewHeader
        title="Catalog Review"
        description="Check your product information for missing details, repeated values, and inconsistent formatting. Review suggested changes before adding them."
        actions={
          <>
            {activeTab === 'overview' && (
              <>
                <button 
                  className={`btn-secondary ${showSettings ? 'active' : ''}`}
                  onClick={() => setShowSettings(!showSettings)}
                  disabled={scanning}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
                  </svg>
                  Review settings
                </button>
                <button className="btn-primary" onClick={handleRunScan} disabled={scanning || savingSettings}>
                  {scanning ? (
                    <>
                      <span className="spinner-ring" style={{ width: 14, height: 14, borderWidth: 2 }} />
                      Scanning...
                    </>
                  ) : (
                    <>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 8H18" />
                      </svg>
                      Check catalog
                    </>
                  )}
                </button>
              </>
            )}
            {activeTab === 'cleanup' && (
              <button className="btn-secondary" onClick={() => loadAuditReport(selectedField)} disabled={loadingAudit}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 8H18" />
                </svg>
                Refresh details
              </button>
            )}
            {activeTab === 'proposals' && (
              <button className="btn-secondary" onClick={loadProposals} disabled={loadingProposals}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 8H18" />
                </svg>
                Refresh suggestions
              </button>
            )}
            {activeTab === 'assistant' && (
              <button className="btn-primary" onClick={loadAssistantReport} disabled={loadingAssistant}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 8H18" />
                </svg>
                Refresh notes
              </button>
            )}
          </>
        }
      />

      {/* Tabs */}
      <nav className="store-manager-tabs">
        <button className={`tab-btn ${activeTab === 'overview' ? 'active' : ''}`} onClick={() => setActiveTab('overview')}>
          Catalog status
        </button>
        <button className={`tab-btn ${activeTab === 'cleanup' ? 'active' : ''}`} onClick={() => setActiveTab('cleanup')}>
          Product Details
        </button>
        <button className={`tab-btn ${activeTab === 'proposals' ? 'active' : ''}`} onClick={() => setActiveTab('proposals')}>
          Suggested Changes {proposals.filter(p => p.status === 'proposed').length > 0 && `(${proposals.filter(p => p.status === 'proposed').length})`}
        </button>
        <button className={`tab-btn ${activeTab === 'assistant' ? 'active' : ''}`} onClick={() => setActiveTab('assistant')}>
          Review Notes
        </button>
      </nav>

      {/* Messages */}
      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fee2e2', padding: '12px 16px', borderRadius: 8, color: '#991b1b', fontSize: 13, fontWeight: 600, marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{error}</span>
          <button style={{ background: 'none', border: 'none', color: '#b91c1c', cursor: 'pointer', fontWeight: 'bold' }} onClick={() => setError(null)}>✕</button>
        </div>
      )}
      {successMessage && (
        <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', padding: '12px 16px', borderRadius: 8, color: '#166534', fontSize: 13, fontWeight: 600, marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{successMessage}</span>
          <button style={{ background: 'none', border: 'none', color: '#15803d', cursor: 'pointer', fontWeight: 'bold' }} onClick={() => setSuccessMessage(null)}>✕</button>
        </div>
      )}
      {aiScanStatus && (
        <div className="assistant-status-bar">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="spinner-ring" style={{ width: 14, height: 14, borderWidth: 2, borderTopColor: '#6d28d9' }} />
            {aiScanStatus}
          </span>
        </div>
      )}

      {/* Overview Tab Content */}
      {activeTab === 'overview' && (
        <>
          {/* Rules Config Panel */}
          {showSettings && (
            <section className="settings-panel">
              <div className="settings-title-row">
                <h2>Configure Catalog Validation Rules</h2>
                <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={handleRestoreDefaults}>
                  Reset to Defaults
                </button>
              </div>

              <div className="rules-grid">
                {rules.map(rule => (
                  <div key={rule.code} className="rule-config-row">
                    <div className="rule-info">
                      <h4>
                        {rule.name}
                        <span className="rule-default-badge">Default: {rule.defaultSeverity}</span>
                      </h4>
                      <p>{rule.description}</p>
                    </div>
                    <div className="severity-select-wrapper">
                      <select
                        className="severity-select"
                        value={rule.severity}
                        onChange={(e) => handleSeverityChange(rule.code, e.target.value as any)}
                      >
                        <option value="blocker">Blocker</option>
                        <option value="warning">Warning</option>
                        <option value="info">Info</option>
                        <option value="disabled">Disabled</option>
                      </select>
                    </div>
                  </div>
                ))}
              </div>

              <div className="settings-actions">
                <button className="btn-secondary" onClick={() => setShowSettings(false)} disabled={savingSettings}>
                  Cancel
                </button>
                <button className="btn-primary" onClick={handleSaveConfig} disabled={savingSettings}>
                  {savingSettings ? 'Saving...' : 'Save & Re-Scan'}
                </button>
              </div>
            </section>
          )}

          {/* KPI Grid */}
          <section className="health-kpi-grid">
            <div className="health-kpi-card" style={{ background: 'linear-gradient(135deg, #f8fafc 0%, #eff6ff 100%)' }}>
              <div className="kpi-label">Health Score</div>
              <div className="kpi-value" style={{ color: healthScore > 90 ? '#10b981' : healthScore > 75 ? '#f59e0b' : '#dc2626' }}>
                {healthScore}%
              </div>
              <div className="kpi-subtext">
                {healthScore === 100 ? 'All products meet your review rules' : `${healthyProducts} of ${totalProducts} products meet your rules`}
              </div>
              <div className="kpi-score-ring">
                <svg width="50" height="50" viewBox="0 0 36 36">
                  <circle cx="18" cy="18" r="15.9155" fill="none" stroke="#e2e8f0" strokeWidth="3" />
                  <circle cx="18" cy="18" r="15.9155" fill="none" 
                          stroke={healthScore > 90 ? '#10b981' : healthScore > 75 ? '#f59e0b' : '#dc2626'} 
                          strokeWidth="3"
                          strokeDasharray={`${healthScore} ${100 - healthScore}`}
                          strokeDashoffset="0"
                          transform="rotate(-90 18 18)"
                  />
                </svg>
              </div>
            </div>

            <div className="health-kpi-card">
              <div className="kpi-label">Total Products</div>
              <div className="kpi-value">{totalProducts}</div>
              <div className="kpi-subtext">Products in your catalog</div>
            </div>

            <div className="health-kpi-card" style={totalErrors > 0 ? { borderLeft: '4px solid #ef4444' } : {}}>
              <div className="kpi-label">Blockers</div>
              <div className="kpi-value" style={{ color: totalErrors > 0 ? '#ef4444' : '#111827' }}>{totalErrors}</div>
              <div className="kpi-subtext">Must be corrected before store updates</div>
            </div>

            <div className="health-kpi-card" style={totalWarnings > 0 ? { borderLeft: '4px solid #f59e0b' } : {}}>
              <div className="kpi-label">Warnings</div>
              <div className="kpi-value" style={{ color: totalWarnings > 0 ? '#f59e0b' : '#111827' }}>{totalWarnings}</div>
              <div className="kpi-subtext">Optimizations & field audits</div>
            </div>
          </section>

          {/* Filter Bar */}
          <section className="filter-section">
            <div className="search-input-wrapper">
              <svg className="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
              <input
                type="text"
                className="search-input"
                placeholder="Search products by name..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="filter-tabs">
              <button className={`filter-btn ${filterType === 'all' ? 'active' : ''}`} onClick={() => setFilterType('all')}>
                Products to review ({productSkus.length})
              </button>
              <button className={`filter-btn ${filterType === 'blockers' ? 'active' : ''}`} onClick={() => setFilterType('blockers')}>
                Needs fixing
              </button>
              <button className={`filter-btn ${filterType === 'warnings' ? 'active' : ''}`} onClick={() => setFilterType('warnings')}>
                Suggestions to review
              </button>
            </div>
          </section>

          {/* Issues List */}
          <section className="issues-list">
            {filteredProductsList.length > 0 ? (
              filteredProductsList.map(prod => {
                const blockersCount = prod.issues.filter(i => i.severity === 'blocker').length;
                const warningsCount = prod.issues.filter(i => i.severity === 'warning').length;
                const infosCount = prod.issues.filter(i => i.severity === 'info').length;
                const isOpen = expandedProducts[prod.sku] ?? false;

                return (
                  <div key={prod.sku} className="product-issue-card">
                    <div className="product-card-header" onClick={(e) => toggleProduct(prod.sku, e)}>
                      <div className="product-title-area">
                        {blockersCount > 0 ? (
                          <span className="product-badge-blocker">{blockersCount} to fix</span>
                        ) : warningsCount > 0 ? (
                          <span className="product-badge-warning">{warningsCount} to review</span>
                        ) : (
                          <span className="product-badge-info">{infosCount} notes</span>
                        )}
                        <div className="product-meta">
                          <h3>{prod.title}</h3>
                          <span>Product code: {prod.sku}</span>
                        </div>
                      </div>

                      <div className="header-actions">
                        <button 
                          className="btn-edit-product"
                          onClick={() => onSelectProduct(prod.sku)}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 113 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                          Review product
                        </button>
                        <svg className={`chevron-icon ${isOpen ? 'open' : ''}`} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                    </div>

                    {isOpen && (
                      <div className="product-card-body">
                        {prod.issues.map((issue, idx) => (
                          <div key={idx} className={`issue-row ${issue.severity}`}>
                            <div className="issue-icon" style={{ marginTop: 2 }}>
                              {issue.severity === 'blocker' && (
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5">
                                  <circle cx="12" cy="12" r="10" />
                                  <line x1="12" y1="8" x2="12" y2="12" />
                                  <line x1="12" y1="16" x2="12.01" y2="16" />
                                </svg>
                              )}
                              {issue.severity === 'warning' && (
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2.5">
                                  <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                                  <line x1="12" y1="9" x2="12" y2="13" />
                                  <line x1="12" y1="17" x2="12.01" y2="17" />
                                </svg>
                              )}
                              {issue.severity === 'info' && (
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2.5">
                                  <circle cx="12" cy="12" r="10" />
                                  <line x1="12" y1="16" x2="12" y2="12" />
                                  <line x1="12" y1="9" x2="12.01" y2="9" />
                                </svg>
                              )}
                            </div>
                            <div className="issue-text">
                              <p className="issue-msg">{issue.message}</p>
                              <span className="issue-code">
                                Code: {issue.code}
                                {issue.fieldPath && (
                                  <span className="issue-field">Field: {issue.fieldPath}</span>
                                )}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="empty-state">
                <h3>No Catalog Health Issues</h3>
                <p>All products meet target validation rules. Catalog score is 100%!</p>
              </div>
            )}
          </section>
        </>
      )}

      {/* ProductField Cleanup Tab */}
      {activeTab === 'cleanup' && (
        <>
          {/* Controls */}
          <section className="cleanup-controls-bar">
            <div className="field-select-group">
              <label className="field-select-label">Choose product detail:</label>
              <select
                className="field-select"
                value={selectedField}
                onChange={(e) => setSelectedField(e.target.value)}
                disabled={loadingAudit || generatingProposals}
              >
                {customFields.map(f => (
                  <option key={f.xmlField} value={f.xmlField}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
            
            <div className="cleanup-actions-group">
              <button 
                className="btn-secondary" 
                onClick={() => handleGenerateProposals(false)} 
                disabled={loadingAudit || generatingProposals}
              >
                Find formatting fixes
              </button>
              <button 
                className="btn-primary" 
                onClick={() => handleGenerateProposals(true)} 
                disabled={loadingAudit || generatingProposals}
                style={{ background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)' }}
              >
                Get suggestions
              </button>
            </div>
          </section>

          {loadingAudit ? (
            <div className="tab-loader">
              <div className="spinner-ring" />
              <p style={{ marginTop: 12, color: '#6b7280', fontWeight: 500 }}>Checking product details...</p>
            </div>
          ) : auditReport ? (
            <>
              {/* Field Statistics */}
              <div className="audit-kpi-grid">
                <div className="audit-kpi-card">
                  <div className="kpi-label">Product detail</div>
                  <div className="kpi-value" style={{ fontSize: '20px', fontWeight: 800, color: '#4f46e5' }}>
                    {auditReport.label}
                  </div>
                  <div className="kpi-subtext">Product detail values</div>
                </div>
                
                <div className="audit-kpi-card">
                  <div className="kpi-label">Different values</div>
                  <div className="kpi-value">{auditReport.uniqueValueCount}</div>
                  <div className="kpi-subtext">Number of different values</div>
                </div>

                <div className="audit-kpi-card">
                  <div className="kpi-label">Products missing this detail</div>
                  <div className="kpi-value" style={{ color: auditReport.emptyRate > 0.3 ? '#f59e0b' : '#111827' }}>
                    {Math.round(auditReport.emptyRate * 100)}%
                  </div>
                  <div className="kpi-subtext">{auditReport.emptyCount} of {auditReport.totalActiveProducts} products have no value</div>
                </div>
              </div>

              {/* Casing Normalization Report */}
              <div className="cleanup-section-card">
                <h3>
                  Different capitalization
                  <span style={{ fontSize: 12, fontWeight: 500, color: '#6b7280' }}>
                    {auditReport.casingDuplicates.length} groups
                  </span>
                </h3>
                {auditReport.casingDuplicates.length > 0 ? (
                  <table className="cleanup-table">
                    <thead>
                      <tr>
                        <th>Normalized Key</th>
                        <th>Cased Variations (Frequency)</th>
                        <th>Recommended Fix</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditReport.casingDuplicates.map((group, idx) => {
                        const sorted = [...group.values].sort((a,b) => b.frequency - a.frequency);
                        const canonical = sorted[0].value;
                        return (
                          <tr key={idx}>
                            <td style={{ fontWeight: 'bold' }}>{group.normalized}</td>
                            <td>
                              {group.values.map((v, i) => (
                                <span key={i} className="casing-value-item">
                                  {v.value} ({v.frequency})
                                </span>
                              ))}
                            </td>
                            <td>
                              Propose standardizing all to <span style={{ color: '#10b981', fontWeight: 600 }}>"{canonical}"</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <p style={{ margin: 0, fontSize: 13.5, color: '#6b7280' }}>No casing duplicates detected. Capitalization is consistent!</p>
                )}
              </div>

              {/* Near Duplicates */}
              <div className="cleanup-section-card">
                <h3>
                  Near-Duplicates & Typos
                  <span style={{ fontSize: 12, fontWeight: 500, color: '#6b7280' }}>
                    {auditReport.nearDuplicates.length} candidates
                  </span>
                </h3>
                {auditReport.nearDuplicates.length > 0 ? (
                  <table className="cleanup-table">
                    <thead>
                      <tr>
                        <th>Value A (Freq)</th>
                        <th>Value B (Freq)</th>
                        <th>Rel. Distance</th>
                        <th>Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditReport.nearDuplicates.map((pair, idx) => (
                        <tr key={idx}>
                          <td>"{pair.valueA}" ({pair.frequencyA})</td>
                          <td>"{pair.valueB}" ({pair.frequencyB})</td>
                          <td>{pair.distance === 0 ? 'Exact match' : `${pair.distance} chars`}</td>
                          <td>
                            <span style={{
                              padding: '2px 8px',
                              borderRadius: 4,
                              fontSize: 11,
                              fontWeight: 700,
                              background: pair.type === 'alphanumeric' ? '#fffbeb' : '#f1f5f9',
                              color: pair.type === 'alphanumeric' ? '#b45309' : '#475569',
                            }}>
                              {pair.type}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p style={{ margin: 0, fontSize: 13.5, color: '#6b7280' }}>No near duplicates or punctuation differences detected.</p>
                )}
              </div>

              {/* Separators */}
              <div className="cleanup-section-card">
                <h3>Punctuation</h3>
                {auditReport.separatorInconsistencies.inconsistent ? (
                  <div>
                    <div style={{ color: '#b45309', background: '#fffbeb', border: '1px solid #fef3c7', padding: '10px 14px', borderRadius: 8, fontSize: 13, display: 'inline-block', marginBottom: 12, fontWeight: 600 }}>
                      ⚠️ Inconsistent punctuation: this product detail uses more than one separator.
                    </div>
                    <table className="cleanup-table" style={{ maxWidth: 400 }}>
                      <thead>
                        <tr>
                          <th>Separator</th>
                          <th>Occurrence Count</th>
                        </tr>
                      </thead>
                      <tbody>
                        {auditReport.separatorInconsistencies.counts.map(s => (
                          <tr key={s.separator}>
                            <td style={{ fontWeight: 'bold', fontFamily: 'monospace', fontSize: 15 }}>{s.separator}</td>
                            <td>{s.count} values</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p style={{ margin: 0, fontSize: 13.5, color: '#6b7280' }}>
                    Punctuation is consistent. Most-used separator: {auditReport.separatorInconsistencies.counts.find(s => s.count > 0)?.separator || 'None used'}
                  </p>
                )}
              </div>

              {/* Suspicious Values */}
              <div className="cleanup-section-card">
                <h3>
                  Suspicious / Invalid Values
                  <span style={{ fontSize: 12, fontWeight: 500, color: '#6b7280' }}>
                    {auditReport.suspiciousValues.length} flagged
                  </span>
                </h3>
                {auditReport.suspiciousValues.length > 0 ? (
                  <table className="cleanup-table">
                    <thead>
                      <tr>
                        <th>Value</th>
                        <th>Frequency</th>
                        <th>Reason Flagged</th>
                        <th>Example SKUs</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditReport.suspiciousValues.map((v, idx) => (
                        <tr key={idx}>
                          <td style={{ fontFamily: 'monospace', color: '#b91c1c' }}>"{v.value}"</td>
                          <td>{v.frequency}</td>
                          <td>
                            {v.reasons.map((r, i) => (
                              <div key={i} style={{ color: '#dc2626', fontSize: 12, fontWeight: 500 }}>• {r}</div>
                            ))}
                          </td>
                          <td style={{ fontSize: 11, fontFamily: 'monospace' }}>
                            {v.skus.join(', ')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p style={{ margin: 0, fontSize: 13.5, color: '#6b7280' }}>No suspicious values found! All parameters look catalog-ready.</p>
                )}
              </div>
            </>
          ) : (
            <p className="empty-state">Unable to load audit report. Re-scan health or load workspace again.</p>
          )}
        </>
      )}

      {/* Proposed Changes Tab */}
      {activeTab === 'proposals' && (
        <>
          {loadingProposals ? (
            <div className="tab-loader">
              <div className="spinner-ring" />
              <p style={{ marginTop: 12, color: '#6b7280' }}>Loading suggestions...</p>
            </div>
          ) : proposals.length > 0 ? (
            <div className="proposal-grid">
              {proposals.map(prop => (
                <div key={prop.id} className="proposal-card" style={prop.status !== 'proposed' ? { opacity: 0.6 } : {}}>
                  <div className="proposal-info">
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span className="proposal-field-badge">{customFields.find(field => field.xmlField === prop.field)?.label ?? 'Product detail'}</span>
                      {prop.source === 'ai' ? (
                        <span className="proposal-source-badge-ai">Suggested</span>
                      ) : (
                        <span className="proposal-source-badge-det">Automatic</span>
                      )}
                      <span style={{
                        fontSize: 11,
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: 4,
                        background: prop.status === 'applied' ? '#d1fae5' : prop.status === 'dismissed' ? '#f3f4f6' : '#fef3c7',
                        color: prop.status === 'applied' ? '#065f46' : prop.status === 'dismissed' ? '#374151' : '#92400e',
                      }}>
                        {prop.status.toUpperCase()}
                      </span>
                    </div>

                    <div className="proposal-diff-flow">
                      <span className="old-val-text">"{prop.oldValue}"</span>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="3">
                        <line x1="5" y1="12" x2="19" y2="12" />
                        <polyline points="12 5 19 12 12 19" />
                      </svg>
                      <span className="new-val-text">"{prop.newValue}"</span>
                    </div>

                    <div className="proposal-meta-details">
                      <span>Why: <span className="proposal-reason">{prop.reason}</span></span>
                      <span>•</span>
                      <span>Match quality: <strong>{Math.round(prop.confidence * 100)}%</strong></span>
                      <span>•</span>
                      <span>Affected products: <strong>{prop.affectedSkus.length}</strong></span>
                    </div>
                  </div>

                  <div className="proposal-actions">
                    {prop.status === 'proposed' && (
                      <>
                        <button
                          className="btn-secondary"
                          style={{ padding: '6px 12px', fontSize: 12 }}
                          onClick={() => handleDismissProposal(prop.id)}
                          disabled={applyingProposalId !== null}
                        >
                          Dismiss
                        </button>
                        <button
                          className="btn-primary"
                          style={{ padding: '6px 14px', fontSize: 12 }}
                          onClick={() => handleApplyProposal(prop.id)}
                          disabled={applyingProposalId !== null}
                        >
                          {applyingProposalId === prop.id ? 'Adding...' : 'Add to review'}
                        </button>
                      </>
                    )}
                    {prop.status === 'applied' && prop.changeSetId && (
                      <span style={{ fontSize: 12, color: '#059669', fontWeight: 600 }}>Ready for review</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <h3>No suggested changes yet</h3>
              <p>Open Product Details, choose a detail, and select Find formatting fixes or Get suggestions.</p>
            </div>
          )}
        </>
      )}

      {/* Assistant Notes Tab */}
      {activeTab === 'assistant' && (
        <>
          {loadingAssistant ? (
            <div className="tab-loader">
              <div className="spinner-ring" />
              <p style={{ marginTop: 12, color: '#6b7280' }}>Preparing your catalog review notes...</p>
            </div>
          ) : assistantReport ? (
            <div className="assistant-report-body">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, paddingBottom: 12, borderBottom: '2px solid #e5e7eb' }}>
                <span style={{ fontSize: 14, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, color: '#6d28d9' }}>
                  Catalog review notes
                </span>
                <span style={{ fontSize: 12, color: '#9ca3af', fontWeight: 500 }}>
                  Catalog status
                </span>
              </div>
              <div style={{ padding: '16px 20px', background: '#f5f3ff', borderLeft: '4px solid #8b5cf6', borderRadius: 8, marginBottom: 24, fontSize: 14, color: '#5b21b6', fontWeight: 600 }}>
                💡 Summary: {assistantReport.summary}
              </div>
              <div>
                {renderMarkdown(assistantReport.reportMarkdown)}
              </div>
            </div>
          ) : (
            <p className="empty-state">No notes yet. Select Refresh notes to prepare a summary.</p>
          )}
        </>
      )}
    </div>
  );
}
export default CatalogHealth;
