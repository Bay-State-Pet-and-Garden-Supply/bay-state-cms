import React, { useState, useEffect, useRef } from 'react';
import { listProducts, getConnection, getProductFacets, type ProductIndexItem } from '../../api';

const STYLE_RULES = `
  .catalog-layout {
    display: flex;
    gap: 24px;
    align-items: flex-start;
    margin-top: 20px;
    position: relative;
  }
  .catalog-sidebar {
    width: 280px;
    flex-shrink: 0;
    background: var(--color-white-surface, #ffffff);
    border: 1px solid var(--color-card-border, #E8E6D9);
    border-radius: var(--rounded-lg, 8px);
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    box-shadow: var(--shadow-sm, 0 1px 3px rgba(33, 20, 20, 0.06));
    position: sticky;
    top: 20px;
    transition: all 0.2s ease;
  }
  .catalog-sidebar.collapsed {
    display: none;
  }
  .catalog-main {
    flex-grow: 1;
    min-width: 0;
  }
  .filter-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .filter-title {
    font-size: 11px;
    font-weight: 700;
    color: #525252;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0;
  }
  .price-range-inputs {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .price-input {
    width: 100%;
    padding: 6px 10px;
    font-size: 13px;
    border: 1px solid var(--color-card-border, #E8E6D9);
    border-radius: var(--rounded-sm, 4px);
    outline: none;
    transition: border-color var(--transition-fast, 0.15s ease), box-shadow var(--transition-fast, 0.15s ease);
    background: var(--color-white-surface, #fff);
  }
  .price-input:focus {
    border-color: var(--color-uniform-green, #14532D);
    box-shadow: 0 0 0 3px rgba(20, 83, 45, 0.15);
  }
  .active-filters-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 16px;
    align-items: center;
    background: var(--color-white-surface, #ffffff);
    padding: 8px 12px;
    border-radius: var(--rounded-md, 6px);
    border: 1px solid var(--color-card-border, #E8E6D9);
  }
  .filter-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(20, 83, 45, 0.08);
    color: var(--color-uniform-green, #14532D);
    border: 1px solid rgba(20, 83, 45, 0.2);
    padding: 4px 10px;
    border-radius: var(--rounded-full, 9999px);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all var(--transition-fast, 0.15s ease);
  }
  .filter-badge:hover {
    background: rgba(20, 83, 45, 0.15);
    border-color: var(--color-uniform-green, #14532D);
  }
  .filter-badge-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: rgba(20, 83, 45, 0.15);
    color: var(--color-uniform-green, #14532D);
    font-size: 10px;
    font-weight: 700;
  }
  .clear-all-btn {
    background: none;
    border: none;
    color: var(--color-signet-burgundy, #760C19);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: var(--rounded-xs, 2px);
    transition: background var(--transition-fast, 0.15s);
  }
  .clear-all-btn:hover {
    background: var(--color-danger-bg, #fee2e2);
  }
  .sidebar-input {
    width: 100%;
    padding: 6px 10px;
    font-size: 13px;
    border: 1px solid var(--color-card-border, #E8E6D9);
    border-radius: var(--rounded-sm, 4px);
    outline: none;
    transition: border-color var(--transition-fast, 0.15s ease), box-shadow var(--transition-fast, 0.15s ease);
    background: var(--color-white-surface, #fff);
  }
  .sidebar-input:focus {
    border-color: var(--color-uniform-green, #14532D);
    box-shadow: 0 0 0 3px rgba(20, 83, 45, 0.15);
  }
  .sidebar-select {
    width: 100%;
    padding: 6px 10px;
    font-size: 13px;
    border: 1px solid var(--color-card-border, #E8E6D9);
    border-radius: var(--rounded-sm, 4px);
    outline: none;
    background-color: var(--color-white-surface, #ffffff);
    cursor: pointer;
    transition: border-color var(--transition-fast, 0.15s ease);
  }
  .sidebar-select:focus {
    border-color: var(--color-uniform-green, #14532D);
  }
  .catalog-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 20px;
    margin-top: 20px;
  }
  .product-card {
    background: var(--color-white-surface, #ffffff);
    border: 1px solid var(--color-card-border, #E8E6D9);
    border-radius: var(--rounded-lg, 8px);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    transition: all var(--transition-normal, 0.25s ease);
    cursor: pointer;
    position: relative;
    box-shadow: var(--shadow-sm, 0 1px 3px rgba(33, 20, 20, 0.06));
  }
  .product-card:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-md, 0 4px 6px -1px rgba(33, 20, 20, 0.08));
    border-color: var(--color-uniform-green, #14532D);
  }
  .card-image-container {
    height: 180px;
    background: var(--color-feed-bag-cream, #FAF9F2);
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border-bottom: 1px solid var(--color-card-border, #E8E6D9);
  }
  .card-image {
    max-width: 90%;
    max-height: 90%;
    object-fit: contain;
    transition: transform 0.3s ease;
  }
  .product-card:hover .card-image {
    transform: scale(1.04);
  }
  .card-image-fallback {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #a3a3a3;
    padding: 16px;
    text-align: center;
  }
  .card-content {
    padding: 14px;
    display: flex;
    flex-direction: column;
    flex-grow: 1;
  }
  .card-sku {
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    color: #666666;
    margin-bottom: 4px;
    letter-spacing: 0.03em;
  }
  .card-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-ledger-charcoal, #211414);
    line-height: 1.4;
    margin: 0 0 10px 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-overflow: ellipsis;
    height: 38px;
  }
  .card-footer {
    margin-top: auto;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-top: 10px;
    border-top: 1px dashed var(--color-card-border, #E8E6D9);
  }
  .card-price {
    font-size: 15px;
    font-weight: 700;
    color: var(--color-ledger-charcoal, #211414);
  }
  .card-badge-container {
    position: absolute;
    top: 8px;
    left: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    z-index: 10;
  }
  .card-badge-right-container {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 10;
  }
  .card-badge {
    padding: 3px 8px;
    border-radius: var(--rounded-md, 6px);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #ffffff;
    box-shadow: 0 1px 2px rgba(0,0,0,0.1);
  }
  .view-toggle-container {
    display: flex;
    border: 1px solid var(--color-card-border, #E8E6D9);
    border-radius: var(--rounded-md, 6px);
    overflow: hidden;
    background: var(--color-feed-bag-cream, #FAF9F2);
    padding: 2px;
  }
  .view-toggle-btn {
    padding: 6px 12px;
    font-size: 13px;
    font-weight: 600;
    border: none;
    background: transparent;
    cursor: pointer;
    color: #666666;
    display: flex;
    align-items: center;
    gap: 6px;
    border-radius: var(--rounded-sm, 4px);
    transition: all var(--transition-fast, 0.15s ease);
  }
  .view-toggle-btn.active {
    background: var(--color-uniform-green, #14532D);
    color: var(--color-feed-bag-cream, #FAF9F2);
    box-shadow: var(--shadow-sm);
  }
  .settings-popover {
    position: absolute;
    right: 0;
    top: calc(100% + 8px);
    width: 280px;
    background: var(--color-white-surface, #ffffff);
    border: 1px solid var(--color-card-border, #E8E6D9);
    border-radius: var(--rounded-lg, 8px);
    box-shadow: var(--shadow-md);
    padding: 14px;
    z-index: 50;
  }
  .media-url-input {
    flex-grow: 1;
    padding: 6px 10px;
    font-size: 12px;
    border: 1px solid var(--color-card-border, #E8E6D9);
    border-radius: var(--rounded-sm, 4px);
    outline: none;
    transition: border-color var(--transition-fast, 0.15s ease);
  }
  .media-url-input:focus {
    border-color: var(--color-uniform-green, #14532D);
  }
  .cog-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: 1px solid var(--color-card-border, #E8E6D9);
    border-radius: var(--rounded-md, 6px);
    background: var(--color-white-surface, #ffffff);
    color: #525252;
    cursor: pointer;
    transition: all var(--transition-fast, 0.15s);
  }
  .cog-btn:hover {
    background: var(--color-feed-bag-cream, #FAF9F2);
    border-color: var(--color-uniform-green, #14532D);
    color: var(--color-uniform-green, #14532D);
  }
  .accordion-details {
    border-top: 1px dashed var(--color-card-border, #E8E6D9);
    padding-top: 10px;
    margin-top: 4px;
  }
  .accordion-summary {
    font-size: 11px;
    font-weight: 700;
    color: #525252;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    cursor: pointer;
    user-select: none;
    outline: none;
    margin-bottom: 8px;
  }
`;

function decodeHtmlEntities(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
}

function ProductImage({ src, alt, title }: { src: string; alt: string; title: string }) {
  const [error, setError] = useState(false);

  useEffect(() => {
    setError(false);
  }, [src]);

  if (error || !src) {
    return (
      <div className="card-image-fallback">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 6, color: '#a3a3a3' }}>
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
          <line x1="12" y1="22.08" x2="12" y2="12" />
        </svg>
        <span style={{ fontSize: 11, color: '#737373', fontWeight: 500 }}>No Image</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      title={title}
      className="card-image"
      onError={() => setError(true)}
    />
  );
}

function productStatusLabel(status: string): string {
  switch (status) {
    case 'active': return 'Active';
    case 'draft': return 'Draft';
    case 'archived': return 'Archived';
    case 'inactive': return 'Inactive';
    default: return 'Status unavailable';
  }
}

function storeStatusLabel(status: string): string {
  switch (status) {
    case 'synced':
    case 'import_reconciled':
      return 'Matches your store';
    case 'drifted':
      return 'Different from your store';
    case 'pending':
      return 'Update in progress';
    case 'failed':
      return 'Update needs attention';
    case 'not_synced':
      return 'Not in your store';
    default:
      return 'Status unavailable';
  }
}

function storeStatusColor(status: string): string {
  if (status === 'synced' || status === 'import_reconciled') return 'var(--color-seedling-green, #16844D)';
  if (status === 'drifted' || status === 'failed') return 'var(--color-signet-burgundy, #760C19)';
  if (status === 'pending') return 'var(--color-muted-gold, #E9B520)';
  return '#9ca3af';
}

interface ProductsViewProps {
  onSelectProduct: (sku: string) => void;
}

export function ProductsView({ onSelectProduct }: ProductsViewProps) {
  const [products, setProducts] = useState<ProductIndexItem[]>([]);
  const [search, setSearch] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  
  // Sidebar & Filter States
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeSearch, setActiveSearch] = useState('');
  const [status, setStatus] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [inventoryStatus, setInventoryStatus] = useState('');
  const [customFilters, setCustomFilters] = useState<Record<string, string>>({});
  const [facets, setFacets] = useState<Record<string, { label: string; values: string[] }>>({});
  const [facetsLoading, setFacetsLoading] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // View settings
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
    return (localStorage.getItem('shopsite_catalog_view_mode') as 'grid' | 'list') || 'grid';
  });
  const [mediaUrl, setMediaUrl] = useState(() => {
    return localStorage.getItem('shopsite_media_url') || '';
  });
  const [showSettings, setShowSettings] = useState(false);

  // Pagination states
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [total, setTotal] = useState(0);

  // Keyboard shortcut listener (/ to search, Esc to close settings)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        if (!sidebarOpen) setSidebarOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      } else if (e.key === 'Escape') {
        if (showSettings) setShowSettings(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [sidebarOpen, showSettings]);

  // Load Facets on Mount
  useEffect(() => {
    setFacetsLoading(true);
    getProductFacets()
      .then(res => {
        setFacets(res.facets);
      })
      .catch(err => {
        console.error('Failed to load facets:', err);
      })
      .finally(() => {
        setFacetsLoading(false);
      });
  }, []);

  const fetchProducts = async (
    currentPage: number,
    currentStatus: string,
    currentSearch: string,
    limit: number,
    minP: string,
    maxP: string,
    invStatus: string,
    cFilters: Record<string, string>
  ) => {
    setLoading(true);
    setError('');
    try {
      const offset = (currentPage - 1) * limit;
      const res = await listProducts(
        currentStatus || undefined,
        currentSearch || undefined,
        limit,
        offset,
        minP || undefined,
        maxP || undefined,
        invStatus || undefined,
        cFilters
      );
      setProducts(res.products);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!localStorage.getItem('shopsite_media_url')) {
      getConnection().then(res => {
        if (res.connection && res.connection.cgiBaseUrl) {
          try {
            const url = new URL(res.connection.cgiBaseUrl);
            const derivedMediaUrl = `${url.protocol}//${url.host}/media/`;
            setMediaUrl(derivedMediaUrl);
            localStorage.setItem('shopsite_media_url', derivedMediaUrl);
          } catch (e) {
            console.error('Failed to parse cgiBaseUrl:', e);
          }
        }
      }).catch(err => {
        console.error('Failed to load connection settings:', err);
      });
    }
  }, []);

  useEffect(() => {
    fetchProducts(page, status, activeSearch, pageSize, minPrice, maxPrice, inventoryStatus, customFilters);
  }, [page, status, activeSearch, pageSize, minPrice, maxPrice, inventoryStatus, customFilters]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setActiveSearch(search);
    setPage(1);
  };

  const handleStatusChange = (newStatus: string) => {
    setStatus(newStatus);
    setPage(1);
  };

  const handlePageSizeChange = (newSize: number) => {
    setPageSize(newSize);
    setPage(1);
  };

  const handlePrevPage = () => {
    if (page > 1) {
      setPage(p => p - 1);
    }
  };

  const handleNextPage = () => {
    if (page < Math.ceil(total / pageSize)) {
      setPage(p => p + 1);
    }
  };

  const handleViewModeChange = (mode: 'grid' | 'list') => {
    setViewMode(mode);
    localStorage.setItem('shopsite_catalog_view_mode', mode);
  };

  const handleMediaUrlChange = (url: string) => {
    setMediaUrl(url);
    localStorage.setItem('shopsite_media_url', url);
  };

  const handleResetAll = () => {
    setSearch('');
    setActiveSearch('');
    setStatus('');
    setMinPrice('');
    setMaxPrice('');
    setInventoryStatus('');
    setCustomFilters({});
    setPage(1);
  };

  const renderActiveFilterBadges = () => {
    const badges: React.ReactNode[] = [];

    if (activeSearch) {
      badges.push(
        <div key="search" className="filter-badge" onClick={() => { setSearch(''); setActiveSearch(''); setPage(1); }}>
          Search: "{activeSearch}"
          <span className="filter-badge-close">×</span>
        </div>
      );
    }
    if (status) {
      let label = status;
      if (status === 'enabled') label = 'Enabled';
      if (status === 'disabled') label = 'Disabled';
      if (status === 'active') label = 'Active';
      if (status === 'draft') label = 'Draft';
      if (status === 'archived') label = 'Archived';
      badges.push(
        <div key="status" className="filter-badge" onClick={() => { setStatus(''); setPage(1); }}>
          Status: {label}
          <span className="filter-badge-close">×</span>
        </div>
      );
    }
    if (minPrice || maxPrice) {
      badges.push(
        <div key="price" className="filter-badge" onClick={() => { setMinPrice(''); setMaxPrice(''); setPage(1); }}>
          Price: ${minPrice || '0'} – ${maxPrice || '∞'}
          <span className="filter-badge-close">×</span>
        </div>
      );
    }
    if (inventoryStatus) {
      badges.push(
        <div key="inventory" className="filter-badge" onClick={() => { setInventoryStatus(''); setPage(1); }}>
          Stock: {inventoryStatus.replace('_', ' ')}
          <span className="filter-badge-close">×</span>
        </div>
      );
    }
    Object.entries(customFilters).forEach(([field, val]) => {
      const fieldLabel = facets[field]?.label || field;
      badges.push(
        <div key={field} className="filter-badge" onClick={() => {
          setCustomFilters(prev => {
            const next = { ...prev };
            delete next[field];
            return next;
          });
          setPage(1);
        }}>
          {fieldLabel}: "{val}"
          <span className="filter-badge-close">×</span>
        </div>
      );
    });

    if (badges.length === 0) return null;

    return (
      <div className="active-filters-bar">
        <span style={{ fontSize: 12, fontWeight: 600, color: '#525252' }}>Active Filters:</span>
        {badges}
        <button type="button" className="clear-all-btn" onClick={handleResetAll}>Clear all</button>
      </div>
    );
  };

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: '0 0 24px 0' },
    headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
    title: { fontSize: 20, fontWeight: 700, margin: 0, color: 'var(--color-uniform-green, #14532D)' },
    controlsRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
    rightControls: { display: 'flex', gap: 12, alignItems: 'center' },
    select: { padding: '6px 10px', fontSize: 13, border: '1px solid var(--color-card-border, #E8E6D9)', borderRadius: 4, background: '#fff' },
    btnPrimary: { padding: '6px 14px', fontSize: 13, cursor: 'pointer', background: 'var(--color-uniform-green, #14532D)', color: 'var(--color-feed-bag-cream, #FAF9F2)', border: 'none', borderRadius: 4, fontWeight: 600 },
    btnOutline: { padding: '6px 12px', fontSize: 13, cursor: 'pointer', background: 'transparent', color: 'var(--color-uniform-green, #14532D)', border: '1px solid var(--color-uniform-green, #14532D)', borderRadius: 4, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 },
    table: { width: '100%', borderCollapse: 'collapse' as any, background: 'var(--color-white-surface, #fff)', border: '1px solid var(--color-card-border, #E8E6D9)', borderRadius: 8, overflow: 'hidden' },
    th: { textAlign: 'left' as any, padding: '10px 14px', borderBottom: '2px solid var(--color-card-border, #E8E6D9)', fontSize: 12, fontWeight: 700, color: 'var(--color-uniform-green, #14532D)', textTransform: 'uppercase', letterSpacing: '0.04em' },
    td: { padding: '10px 14px', borderBottom: '1px solid var(--color-card-border, #E8E6D9)', fontSize: 13, cursor: 'pointer' },
    row: { cursor: 'pointer', transition: 'background 0.15s ease' },
    badge: { padding: '3px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600, color: '#fff', textTransform: 'uppercase', letterSpacing: '0.03em' },
    loading: { textAlign: 'center' as any, padding: 40, color: '#666666' },
    error: { color: 'var(--color-danger-text, #760c19)', padding: 12, background: 'var(--color-danger-bg, #fee2e2)', borderRadius: 6, marginBottom: 16, border: '1px solid var(--color-danger-border, #fca5a5)' },
    empty: { textAlign: 'center' as any, padding: 40, color: '#737373', background: '#fff', border: '1px solid var(--color-card-border)', borderRadius: 8 },
    pagination: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--color-card-border, #E8E6D9)', flexWrap: 'wrap', gap: 12 },
    paginationInfo: { fontSize: 13, color: '#525252' },
    paginationControls: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
    pageBtn: { padding: '6px 14px', fontSize: 13, background: '#fff', border: '1px solid var(--color-card-border, #E8E6D9)', borderRadius: 4, color: '#211414', minWidth: 80, textAlign: 'center', fontWeight: 600 },
    pageIndicator: { fontSize: 13, color: '#525252', margin: '0 6px' },
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div style={styles.container}>
      <style>{STYLE_RULES}</style>
      
      <div style={styles.headerRow}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            type="button"
            style={styles.btnOutline}
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label={sidebarOpen ? 'Hide product filters' : 'Show product filters'}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
            </svg>
            {sidebarOpen ? 'Hide filters' : 'Show filters'}
          </button>
          <span style={{ fontSize: 13, color: '#525252' }}>
            <strong>{total.toLocaleString()}</strong> product{total === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      <div className="catalog-layout">
        {/* Left-hand Sidebar for Filters */}
        <aside className={`catalog-sidebar ${!sidebarOpen ? 'collapsed' : ''}`}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--color-card-border, #E8E6D9)', paddingBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--color-uniform-green, #14532D)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Find products
            </h3>
            {(activeSearch || status || minPrice || maxPrice || inventoryStatus || Object.keys(customFilters).length > 0) && (
              <button type="button" className="clear-all-btn" style={{ padding: 0 }} onClick={handleResetAll}>Clear filters</button>
            )}
          </div>

          {/* Text Search */}
          <div className="filter-section">
            <label className="filter-title">Search products</label>
            <form onSubmit={handleSearch} style={{ display: 'flex', gap: 6 }}>
              <input
                ref={searchInputRef}
                className="sidebar-input"
                placeholder="Product name or code..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              <button style={styles.btnPrimary} type="submit">Search</button>
            </form>
          </div>

          {/* Status filter */}
          <div className="filter-section">
            <label className="filter-title">Store status</label>
            <select className="sidebar-select" value={status} onChange={e => handleStatusChange(e.target.value)}>
              <option value="">All products</option>
              <option value="enabled">Available in your store</option>
              <option value="disabled">Not available in your store</option>
              <option value="active">Active</option>
              <option value="draft">Draft</option>
              <option value="archived">Archived</option>
            </select>
          </div>

          {/* Price Range */}
          <div className="filter-section">
            <label className="filter-title">Price Range</label>
            <div className="price-range-inputs">
              <input
                type="number"
                className="price-input"
                placeholder="From $"
                value={minPrice}
                onChange={e => { setMinPrice(e.target.value); setPage(1); }}
              />
              <span style={{ color: '#a3a3a3' }}>–</span>
              <input
                type="number"
                className="price-input"
                placeholder="To $"
                value={maxPrice}
                onChange={e => { setMaxPrice(e.target.value); setPage(1); }}
              />
            </div>
          </div>

          {/* Stock Status */}
          <div className="filter-section">
            <label className="filter-title">Stock Status</label>
            <select className="sidebar-select" value={inventoryStatus} onChange={e => { setInventoryStatus(e.target.value); setPage(1); }}>
              <option value="">All Inventory</option>
              <option value="in_stock">In Stock Only</option>
              <option value="out_of_stock">Out of Stock</option>
              <option value="low_stock">Low Stock (≤ 5)</option>
            </select>
          </div>

          {/* Dynamic Facets (Custom Fields Accordion) */}
          {!facetsLoading && Object.keys(facets).length > 0 && (
            <details className="accordion-details" open>
              <summary className="accordion-summary">Custom Fields ({Object.keys(facets).length})</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
                {Object.entries(facets).map(([xmlField, facet]) => (
                  <div className="filter-section" key={xmlField}>
                    <label style={{ fontSize: 11, fontWeight: 600, color: '#525252' }}>{facet.label}</label>
                    <input
                      className="sidebar-input"
                      placeholder={`Filter ${facet.label}...`}
                      value={customFilters[xmlField] || ''}
                      onChange={e => {
                        const val = e.target.value;
                        setCustomFilters(prev => {
                          const next = { ...prev };
                          if (val) {
                            next[xmlField] = val;
                          } else {
                            delete next[xmlField];
                          }
                          return next;
                        });
                        setPage(1);
                      }}
                    />
                  </div>
                ))}
              </div>
            </details>
          )}
          {facetsLoading && <div style={{ fontSize: 12, color: '#737373', textAlign: 'center' }}>Loading fields...</div>}
        </aside>

        {/* Right-hand side main content area */}
        <main className="catalog-main">
          {/* Header Controls (Grid/List Toggle & Media Settings) */}
          <div style={styles.controlsRow}>
            {renderActiveFilterBadges()}
            <div style={styles.rightControls}>
              <div className="view-toggle-container">
                <button
                  type="button"
                  className={`view-toggle-btn ${viewMode === 'grid' ? 'active' : ''}`}
                  onClick={() => handleViewModeChange('grid')}
                  title="Grid view"
                  aria-label="Grid view"
                  style={{ padding: '6px 10px' }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="7" height="7" />
                    <rect x="14" y="3" width="7" height="7" />
                    <rect x="14" y="14" width="7" height="7" />
                    <rect x="3" y="14" width="7" height="7" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={`view-toggle-btn ${viewMode === 'list' ? 'active' : ''}`}
                  onClick={() => handleViewModeChange('list')}
                  title="List view"
                  aria-label="List view"
                  style={{ padding: '6px 10px' }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="8" y1="6" x2="21" y2="6" />
                    <line x1="8" y1="12" x2="21" y2="12" />
                    <line x1="8" y1="18" x2="21" y2="18" />
                    <line x1="3" y1="6" x2="3.01" y2="6" />
                    <line x1="3" y1="12" x2="3.01" y2="12" />
                    <line x1="3" y1="18" x2="3.01" y2="18" />
                  </svg>
                </button>
              </div>

              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  onClick={() => setShowSettings(!showSettings)}
                  className="cog-btn"
                  title="Image settings"
                  aria-label="Image settings"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </button>

                {showSettings && (
                  <div className="settings-popover">
                    <h4 style={{ margin: '0 0 8px 0', fontSize: 13, fontWeight: 700, color: 'var(--color-uniform-green, #14532D)' }}>Image settings</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ fontSize: 11, fontWeight: 600, color: '#525252' }}>Media Base URL</label>
                      <input
                        className="media-url-input"
                        type="text"
                        placeholder="e.g. https://store.example.com/media/"
                        value={mediaUrl}
                        onChange={e => handleMediaUrlChange(e.target.value)}
                        style={{ fontSize: 12, padding: '6px 8px' }}
                      />
                      {!mediaUrl && (
                        <span style={{ fontSize: 11, color: 'var(--color-warning-text, #78350f)' }}>⚠️ Set URL to load product images</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {error && <div style={styles.error}>{error}</div>}

          {loading ? (
            <div style={styles.loading}>Loading catalog products...</div>
          ) : products.length === 0 ? (
            <div style={styles.empty}>
              <p>No products found matching active filters.</p>
            </div>
          ) : (
            <>
              {viewMode === 'grid' ? (
                <div className="catalog-grid">
                  {products.map(p => (
                    <div key={p.sku} className="product-card" onClick={() => onSelectProduct(p.sku)} tabIndex={0} role="button" onKeyDown={e => e.key === 'Enter' && onSelectProduct(p.sku)}>
                      <div className="card-badge-container">
                        <span className="card-badge" style={{
                          background: p.status === 'active' ? 'var(--color-uniform-green, #14532D)' : p.status === 'draft' ? 'var(--color-muted-gold, #E9B520)' : '#737373',
                        }}>
                          {productStatusLabel(p.status)}
                        </span>
                      </div>
                      <div className="card-badge-right-container">
                        <span className="card-badge" style={{
                          background: storeStatusColor(p.syncStatus),
                        }}>
                          {storeStatusLabel(p.syncStatus)}
                        </span>
                      </div>
                      <div className="card-image-container">
                        <ProductImage
                          src={p.primaryImage ? (mediaUrl ? (mediaUrl.endsWith('/') ? mediaUrl : mediaUrl + '/') + p.primaryImage : '') : ''}
                          alt={decodeHtmlEntities(p.title)}
                          title={decodeHtmlEntities(p.title)}
                        />
                      </div>
                      <div className="card-content">
                        <div className="card-sku">Product code: {p.sku}</div>
                        <h3 className="card-title" title={decodeHtmlEntities(p.title)}>{decodeHtmlEntities(p.title)}</h3>
                        {p.customFields && Object.keys(p.customFields).length > 0 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                            {Object.entries(p.customFields)
                              .filter(([_, val]) => val && val.trim() !== '')
                              .slice(0, 2)
                              .map(([field, val]) => {
                                const fieldLabel = facets[field]?.label || field;
                                return (
                                  <span key={field} style={{ fontSize: 10, background: 'var(--color-feed-bag-cream, #FAF9F2)', border: '1px solid var(--color-card-border, #E8E6D9)', color: '#404040', padding: '2px 6px', borderRadius: 4 }}>
                                    {fieldLabel}: {val}
                                  </span>
                                );
                              })}
                          </div>
                        )}
                        <div className="card-footer">
                          <span className="card-price">{p.price ? `$${p.price}` : '—'}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Product code</th>
                      <th style={styles.th}>Product name</th>
                      <th style={styles.th}>Price</th>
                      <th style={styles.th}>Product status</th>
                      <th style={styles.th}>Store status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map(p => (
                      <tr key={p.sku} style={styles.row} onClick={() => onSelectProduct(p.sku)} tabIndex={0} role="button" onKeyDown={e => e.key === 'Enter' && onSelectProduct(p.sku)}>
                        <td style={styles.td}><strong>{p.sku}</strong></td>
                        <td style={styles.td}>
                          <div>{decodeHtmlEntities(p.title)}</div>
                          {p.customFields && Object.keys(p.customFields).length > 0 && (
                            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                              {Object.entries(p.customFields)
                                .filter(([_, val]) => val && val.trim() !== '')
                                .map(([field, val]) => {
                                  const fieldLabel = facets[field]?.label || field;
                                  return (
                                    <span key={field} style={{ fontSize: 10, color: '#666666' }}>
                                      <strong>{fieldLabel}:</strong> {val}
                                    </span>
                                  );
                                })}
                            </div>
                          )}
                        </td>
                        <td style={styles.td}>{p.price ? `$${p.price}` : '-'}</td>
                        <td style={styles.td}>
                          <span style={{
                            ...styles.badge,
                            background: p.status === 'active' ? 'var(--color-uniform-green, #14532D)' : p.status === 'draft' ? 'var(--color-muted-gold, #E9B520)' : '#737373',
                          }}>
                            {productStatusLabel(p.status)}
                          </span>
                        </td>
                        <td style={styles.td}>
                          <span style={{
                            ...styles.badge,
                            background: storeStatusColor(p.syncStatus),
                          }}>
                            {storeStatusLabel(p.syncStatus)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <div style={styles.pagination}>
                <div style={styles.paginationInfo}>
                  Showing {Math.min((page - 1) * pageSize + 1, total)} to {Math.min(page * pageSize, total)} of {total} products
                </div>
                <div style={styles.paginationControls}>
                  <button 
                    type="button"
                    style={{ ...styles.pageBtn, opacity: page === 1 ? 0.5 : 1, cursor: page === 1 ? 'not-allowed' : 'pointer' }}
                    onClick={handlePrevPage}
                    disabled={page === 1}
                  >
                    Previous
                  </button>
                  <span style={styles.pageIndicator}>Page {page} of {totalPages}</span>
                  <button 
                    type="button"
                    style={{ ...styles.pageBtn, opacity: page >= totalPages ? 0.5 : 1, cursor: page >= totalPages ? 'not-allowed' : 'pointer' }}
                    onClick={handleNextPage}
                    disabled={page >= totalPages}
                  >
                    Next
                  </button>
                  
                  <select 
                    style={styles.select} 
                    value={pageSize} 
                    onChange={e => handlePageSizeChange(Number(e.target.value))}
                    aria-label="Products per page"
                  >
                    <option value={25}>25 per page</option>
                    <option value={50}>50 per page</option>
                    <option value={100}>100 per page</option>
                    <option value={200}>200 per page</option>
                  </select>
                </div>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
