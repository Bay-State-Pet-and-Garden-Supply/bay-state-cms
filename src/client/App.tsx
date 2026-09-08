import React, { useState, useEffect, useRef } from 'react';
import { getWorkspace, type Workspace } from './api';
import { SetupWizard } from './components/SetupWizard';
import { Catalog } from './components/Catalog';
import { ProductDetail } from './components/ProductDetail';
import { ChangeSetReview } from './components/ChangeSetReview';
import { DriftView } from './components/DriftView';
import { SyncJobsView } from './components/SyncJobsView';
import { Dashboard } from './components/Dashboard';
import { CatalogHealth } from './components/CatalogHealth';
import { Onboarding } from './components/Onboarding';
import { StoreManagerAssistant } from './components/StoreManagerAssistant';
import { Settings } from './components/Settings';
import { ProfileWorkspacePage } from './components/profile-workspace/ProfileWorkspacePage';
import { colors, fonts, rounded } from './theme';
import './styles/workspace-tokens.css';

type View = 'setup' | 'dashboard' | 'catalog' | 'product' | 'changesets' | 'drift' | 'syncjobs' | 'health' | 'onboarding' | 'assistant' | 'settings';

const VALID_VIEWS: readonly View[] = ['setup', 'dashboard', 'catalog', 'product', 'changesets', 'drift', 'syncjobs', 'health', 'onboarding', 'assistant', 'settings'];

// Stale/deep-linked `?view=` values (e.g. removed views) degrade gracefully to
// Dashboard instead of rendering a blank main region.
function resolveViewParam(raw: string | null): View | null {
  return raw && (VALID_VIEWS as readonly string[]).includes(raw) ? (raw as View) : null;
}

function getProfileWorkspaceDomainFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/settings\/domains\/([^/]+)\/profile\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Static Navigation Styles
const navStyles: Record<string, React.CSSProperties> = {
  app: { fontFamily: fonts.body, minHeight: '100vh', background: colors.feedBagCream, color: colors.ledgerCharcoal },
  nav: {
    backgroundColor: colors.uniformGreen,
    borderBottom: `2px solid ${colors.shadowPine}`,
    padding: '8px 24px',
    display: 'flex',
    gap: 12,
    alignItems: 'center',
    boxShadow: '0 2px 4px rgba(0, 0, 0, 0.12)',
    flexWrap: 'nowrap' as const,
  },
  navBrand: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginRight: 16,
    textDecoration: 'none',
    flexShrink: 0,
  },
  navBrandBadge: {
    background: colors.signetBurgundy,
    color: colors.feedBagCream,
    fontSize: 10,
    fontWeight: 700,
    fontFamily: fonts.body,
    padding: '3px 8px',
    borderRadius: rounded.sm,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    border: `1px solid ${colors.burgundyDark}`,
  },
  navBrandText: {
    fontFamily: fonts.display,
    fontSize: 18,
    fontWeight: 700,
    color: colors.feedBagCream,
    letterSpacing: '-0.2px',
  },
  tabList: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    overflowX: 'auto',
    scrollbarWidth: 'none' as const,
    flex: 1,
    padding: '2px 0',
  },
  navLink: {
    background: 'none',
    border: 'none',
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
    cursor: 'pointer',
    color: colors.feedBagCream,
    padding: '8px 12px',
    minHeight: 38,
    borderRadius: rounded.sm,
    transition: 'all 0.15s ease',
    opacity: 0.85,
    whiteSpace: 'nowrap' as const,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  },
  navLinkActive: {
    backgroundColor: colors.shadowPine,
    borderBottom: `2px solid ${colors.cornerCalloutGold}`,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
    cursor: 'pointer',
    color: colors.feedBagCream,
    padding: '8px 12px',
    minHeight: 38,
    borderRadius: rounded.sm,
    opacity: 1,
    whiteSpace: 'nowrap' as const,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  },
  navSpacer: { flexShrink: 0 },
  reportBtn: {
    backgroundColor: colors.signetBurgundy,
    color: colors.feedBagCream,
    border: `1px solid ${colors.burgundyDark}`,
    borderRadius: rounded.sm,
    padding: '7px 14px',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.05em',
    textTransform: 'uppercase' as const,
    cursor: 'pointer',
    marginRight: 8,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    transition: 'all 0.15s ease',
    flexShrink: 0,
    minHeight: 36,
  },
  navStatus: {
    fontSize: 12,
    fontWeight: 600,
    color: colors.feedBagCream,
    backgroundColor: colors.shadowPine,
    border: `1px solid rgba(255, 255, 255, 0.15)`,
    padding: '5px 12px',
    borderRadius: rounded.sm,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    backgroundColor: colors.seedlingGreen,
    boxShadow: `0 0 0 2px ${colors.uniformGreen}`,
  },
  main: { maxWidth: 1380, margin: '0 auto', padding: '16px 24px 24px 24px' },
  loading: { padding: 40, textAlign: 'center' as any, color: colors.ledgerCharcoal, fontFamily: fonts.body },
};

function App() {
  const [view, setView] = useState<View>('setup');
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [selectedSku, setSelectedSku] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [profileWorkspaceDomain, setProfileWorkspaceDomain] = useState<string | null>(() =>
    typeof window !== 'undefined' ? getProfileWorkspaceDomainFromPath(window.location.pathname) : null,
  );
  const hasPushedHistory = useRef(false);
  const handleNavigate = (newView: View, replace = false) => {
    setView(newView);
    setProfileWorkspaceDomain(null);
    const url = new URL(window.location.href);
    // Clear profile-workspace pathname when navigating via top nav (so it doesn't keep rendering workspace)
    if (getProfileWorkspaceDomainFromPath(url.pathname)) {
      url.pathname = '/';
    }
    url.searchParams.delete('settingsTab');
    // Store Settings tab deep link (`?view=settings&tab=ai|catalog`): keep a
    // valid one when (re-)entering settings so deep links survive navigation,
    // drop it otherwise. The top-nav Settings link stays canonical and never
    // forces a specific tab.
    if (newView === 'settings') {
      const settingsTab = url.searchParams.get('tab');
      const validSettingsTabs = ['ai', 'catalog', 'types', 'mappings-health'];
      if (!validSettingsTabs.includes(settingsTab ?? '')) {
        url.searchParams.delete('tab');
      }
    } else if (newView === 'onboarding') {
      const onboardingTab = url.searchParams.get('tab');
      const validOnboardingTabs = ['needs_attention', 'processing', 'waiting_on_family', 'review', 'approved'];
      if (!validOnboardingTabs.includes(onboardingTab ?? '')) {
        url.searchParams.delete('tab');
      }
    } else {
      url.searchParams.delete('tab');
    }
    if (newView !== 'onboarding') {
      url.searchParams.delete('batch');
      url.searchParams.delete('board');
    }
    if (newView === 'setup') {
      url.searchParams.delete('view');
    } else {
      url.searchParams.set('view', newView);
    }
    if (replace) {
      window.history.replaceState({ view: newView }, '', url.toString());
    } else {
      window.history.pushState({ view: newView }, '', url.toString());
    }
  };

  useEffect(() => {
    // If URL is already a profile workspace path, keep it — don't overwrite with dashboard
    const initialPwDomain = getProfileWorkspaceDomainFromPath(window.location.pathname);
    if (initialPwDomain) {
      setProfileWorkspaceDomain(initialPwDomain);
      // still load workspace for nav, but don't override view
      getWorkspace().then(res => {
        if (res.workspace) setWorkspace(res.workspace);
        setReady(true);
      }).catch(() => setReady(true));
      return;
    }
    getWorkspace().then(res => {
      if (res.workspace) {
        setWorkspace(res.workspace);
        const needsSetup = res.workspace.bootstrapStatus !== 'complete'
          || !res.workspace.baselineCommit;
        
        if (needsSetup) {
          setView('setup');
        } else {
          const params = new URLSearchParams(window.location.search);
          const sku = params.get('product');
          const urlView = resolveViewParam(params.get('view'));
          
          if (sku) {
            setSelectedSku(sku);
            setView(urlView || 'catalog');
          } else if (urlView) {
            setView(urlView);
          } else {
            setView('dashboard');
          }
        }
      }
      setReady(true);
    }).catch(() => {
      setReady(true);
    });
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      const pwDomain = getProfileWorkspaceDomainFromPath(window.location.pathname);
      setProfileWorkspaceDomain(pwDomain);
      if (pwDomain) return;
      const params = new URLSearchParams(window.location.search);
      const sku = params.get('product');
      setSelectedSku(sku);
      
      const urlView = resolveViewParam(params.get('view'));
      if (urlView) {
        setView(urlView);
      } else {
        if (workspace && (workspace.bootstrapStatus !== 'complete' || !workspace.baselineCommit)) {
          setView('setup');
        } else {
          setView('dashboard');
        }
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [workspace]);

  useEffect(() => {
    if (selectedSku) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [selectedSku]);

  const handleOpenProduct = (sku: string) => {
    setSelectedSku(sku);
    hasPushedHistory.current = true;
    const url = new URL(window.location.href);
    url.searchParams.set('product', sku);
    window.history.pushState({ sku }, '', url.toString());
  };

  const handleCloseProduct = () => {
    if (hasPushedHistory.current) {
      window.history.back();
    } else {
      const url = new URL(window.location.href);
      url.searchParams.delete('product');
      window.history.replaceState(null, '', url.toString());
      setSelectedSku(null);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleCloseProduct();
      }
    };
    if (selectedSku) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedSku]);

  const handleSetupComplete = () => {
    getWorkspace().then(res => {
      if (res.workspace) setWorkspace(res.workspace);
    });
    handleNavigate('dashboard', true);
  };

  const handleSetupUpdated = () => {
    getWorkspace().then(res => {
      if (res.workspace) {
        setWorkspace(res.workspace);
        const needsSetup = res.workspace.bootstrapStatus !== 'complete'
          || !res.workspace.baselineCommit;
        handleNavigate(needsSetup ? 'setup' : 'dashboard', true);
      }
    });
  };

  if (!ready) {
    return <div style={navStyles.loading}>Loading Baystate CMS...</div>;
  }

  return (
    <div style={navStyles.app}>
      <nav style={navStyles.nav} aria-label="Main Navigation">
        <div style={navStyles.navBrand}>
          <span style={navStyles.navBrandBadge}>Bay State</span>
          <span style={navStyles.navBrandText}>CMS</span>
        </div>
        {workspace && workspace.bootstrapStatus === 'complete' && workspace.baselineCommit && (
          <div style={navStyles.tabList} role="tablist">
            <button
              style={view === 'dashboard' ? navStyles.navLinkActive : navStyles.navLink}
              onClick={() => handleNavigate('dashboard')}
              aria-current={view === 'dashboard' ? 'page' : undefined}
            >
              Overview
            </button>
            <button
              style={view === 'catalog' ? navStyles.navLinkActive : navStyles.navLink}
              onClick={() => handleNavigate('catalog')}
              aria-current={view === 'catalog' ? 'page' : undefined}
            >
              Catalog
            </button>
            <button
              style={view === 'onboarding' ? navStyles.navLinkActive : navStyles.navLink}
              onClick={() => handleNavigate('onboarding')}
              aria-current={view === 'onboarding' ? 'page' : undefined}
            >
              Onboarding
            </button>
            <button
              style={view === 'changesets' ? navStyles.navLinkActive : navStyles.navLink}
              onClick={() => handleNavigate('changesets')}
              aria-current={view === 'changesets' ? 'page' : undefined}
            >
              Change Sets
            </button>
            <button
              style={view === 'health' ? navStyles.navLinkActive : navStyles.navLink}
              onClick={() => handleNavigate('health')}
              aria-current={view === 'health' ? 'page' : undefined}
            >
              Catalog Health
            </button>
            <button
              style={view === 'assistant' ? navStyles.navLinkActive : navStyles.navLink}
              onClick={() => handleNavigate('assistant')}
              aria-current={view === 'assistant' ? 'page' : undefined}
            >
              Store Manager
            </button>
            <button
              style={view === 'drift' ? navStyles.navLinkActive : navStyles.navLink}
              onClick={() => handleNavigate('drift')}
              aria-current={view === 'drift' ? 'page' : undefined}
            >
              Drift
            </button>
            <button
              style={view === 'syncjobs' ? navStyles.navLinkActive : navStyles.navLink}
              onClick={() => handleNavigate('syncjobs')}
              aria-current={view === 'syncjobs' ? 'page' : undefined}
            >
              Sync Jobs
            </button>
            <button
              style={view === 'settings' ? navStyles.navLinkActive : navStyles.navLink}
              onClick={() => handleNavigate('settings')}
              aria-current={view === 'settings' ? 'page' : undefined}
            >
              Settings
            </button>
          </div>
        )}
        <div style={navStyles.navSpacer} />

        <span style={navStyles.navStatus}>
          <span style={navStyles.statusDot} aria-hidden="true" />
          {workspace ? workspace.name : 'Store Disconnected'}
        </span>
      </nav>

      <main style={profileWorkspaceDomain ? { ...navStyles.main, maxWidth: 'none', margin: 0, padding: 0 } : (view === 'onboarding' || view === 'assistant' || view === 'changesets') ? { ...navStyles.main, maxWidth: 'none', margin: 0, padding: 0 } : navStyles.main}>
        {profileWorkspaceDomain ? (
          <ProfileWorkspacePage domain={profileWorkspaceDomain} />
        ) : (
          <>
            {view === 'setup' && (
          <SetupWizard
            onComplete={handleSetupComplete}
            onUpdated={handleSetupUpdated}
          />
        )}

        {view === 'dashboard' && workspace && (
          <Dashboard onNavigate={(targetView) => handleNavigate(targetView)} />
        )}

        {view === 'catalog' && workspace && (
          <Catalog
            onSelectProduct={handleOpenProduct}
          />
        )}

        {view === 'changesets' && <ChangeSetReview />}

        {view === 'onboarding' && <Onboarding />}

        {view === 'health' && workspace && (
          <CatalogHealth onSelectProduct={handleOpenProduct} />
        )}

        {view === 'assistant' && workspace && (
          <StoreManagerAssistant onSelectProduct={handleOpenProduct} />
        )}

        {view === 'drift' && <DriftView />}

        {view === 'syncjobs' && <SyncJobsView />}

        {view === 'settings' && <Settings onSelectProduct={handleOpenProduct} />}
          </>
        )}
      </main>

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        .spinner {
          display: inline-block;
          width: 20px;
          height: 20px;
          border: 2px solid rgba(33, 20, 20, 0.15);
          border-radius: 50%;
          border-top-color: currentColor;
          animation: spin 0.8s linear infinite;
        }
        .drawer-backdrop {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(33, 20, 20, 0.5);
          backdrop-filter: blur(4px);
          z-index: 1000;
          animation: fadeIn 0.2s ease forwards;
        }
        .drawer-container {
          position: fixed;
          top: 0;
          right: 0;
          bottom: 0;
          width: 100%;
          max-width: 880px;
          background: ${colors.whiteSurface};
          z-index: 1001;
          box-shadow: -10px 0 30px -5px rgba(33, 20, 20, 0.15);
          border-left: 1px solid ${colors.cardBorder};
          animation: slideIn 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards;
          display: flex;
          flex-direction: column;
          height: 100vh;
        }
        .drawer-close-btn {
          position: absolute;
          top: 20px;
          left: -52px;
          width: 36px;
          height: 36px;
          border-radius: 50%;
          background: ${colors.whiteSurface};
          border: 1px solid ${colors.cardBorder};
          box-shadow: -4px 4px 12px rgba(33, 20, 20, 0.08);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 0.2s ease;
          z-index: 1002;
          color: ${colors.ledgerCharcoal};
          font-size: 14px;
          font-weight: bold;
        }
        .drawer-close-btn:hover {
          transform: scale(1.08) rotate(90deg);
          background: ${colors.feedBagCream};
          border-color: ${colors.uniformGreen};
        }
        .drawer-body {
          flex: 1;
          overflow-y: auto;
          height: 100%;
          background: ${colors.whiteSurface};
        }
        @media (max-width: 950px) {
          .drawer-container {
            max-width: 100%;
          }
          .drawer-close-btn {
            left: auto;
            right: 20px;
            top: 20px;
          }
        }
      ` }} />

      {selectedSku && (
        <>
          <div 
            className="drawer-backdrop" 
            onClick={handleCloseProduct}
          />
          <div className="drawer-container">
            <button 
              className="drawer-close-btn" 
              onClick={handleCloseProduct}
              title="Close Panel"
            >
              ✕
            </button>
            <div className="drawer-body">
              <ProductDetail sku={selectedSku} onBack={handleCloseProduct} />
            </div>
          </div>
        </>
      )}


    </div>
  );
}

export default App;
