// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';

// story: e35s10 — tab registry is single source for Brands merge (profiles|sitemaps → brands)

describe('onboarding settings tab registry (e35s10)', () => {
  it('contains Brands tab and maps legacy profiles to brands; sitemaps is now primary (e08s03)', async () => {
    const mod = await import('../../client/components/onboarding-settings/tabRegistry');
    const { ONBOARDING_SETTINGS_TABS, resolveOnboardingSettingsTab } = mod as any;

    expect(Array.isArray(ONBOARDING_SETTINGS_TABS)).toBe(true);
    const ids = ONBOARDING_SETTINGS_TABS.map((t: any) => t.id);
    expect(ids).toContain('brands');
    expect(ids).toContain('sitemaps');
    expect(ids).not.toContain('general');
    // profiles still aliases to brands; sitemaps is now distinct primary
    expect(resolveOnboardingSettingsTab('profiles')).toBe('brands');
    expect(resolveOnboardingSettingsTab('sitemaps')).toBe('sitemaps');
    expect(resolveOnboardingSettingsTab('brands')).toBe('brands');
    // general defaults to curation; distributors passthrough
    expect(resolveOnboardingSettingsTab('general')).toBe('curation');
    expect(resolveOnboardingSettingsTab('distributors')).toBe('distributors');
  });

  it('brands tab is labeled as Strategy Hub and sitemaps as raw inventory (e08s03)', async () => {
    const { ONBOARDING_SETTINGS_TABS } = await import('../../client/components/onboarding-settings/tabRegistry') as any;
    const brands = ONBOARDING_SETTINGS_TABS.find((t: any) => t.id === 'brands');
    expect(brands).toBeDefined();
    expect(brands.label).toContain('Brands');
    expect(brands.label).toContain('Sourcing');
    const sitemaps = ONBOARDING_SETTINGS_TABS.find((t: any) => t.id === 'sitemaps');
    expect(sitemaps.label).toContain('Sitemaps');
    expect(sitemaps.label).toContain('Brand URL Index');
  });
});

// ── P1 UI revamp: cross-link from Onboarding Settings to Store Settings ──────
import { describe as describe2, it as it2, expect as expect2, vi, beforeEach, afterEach } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: React } = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');

vi.mock('../../client/onboarding-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../client/onboarding-api')>();
  return {
    ...actual,
    getApiKeys: vi.fn(async () => ({ keys: [] })),
    updateApiKey: vi.fn(async () => ({})),
    deleteApiKey: vi.fn(async () => ({})),
    getCurationTargets: vi.fn(async () => ({ targets: [], candidates: { productFields: [], pages: [] }, applicability: [], findings: [] })),
    getClassificationReadiness: vi.fn(async () => ({ readiness: {} })),
    getOnboardingCapabilities: vi.fn(async () => ({})),
    getExtractionWorkerHealth: vi.fn(async () => ({})),
  };
});

vi.mock('../../client/api', () => ({
  downloadPagesImport: vi.fn(),
  activatePagesImport: vi.fn(async () => ({ success: true })),
}));

vi.mock('../../client/components/common/AiRouteSummary', () => ({
  AiRouteSummary: () => null,
}));
vi.mock('../../client/components/onboarding-settings/DistributorConnectionsPanel', () => ({
  DistributorConnectionsPanel: () => null,
}));
vi.mock('../../client/components/sitemap-health/SitemapHealthView', () => ({
  SitemapHealthView: () => null,
}));
vi.mock('../../client/components/brand-strategy/BrandStrategyView', () => ({
  BrandStrategyView: () => null,
}));

describe2('OnboardingSettings cross-link to Store Settings taxonomy admin (P1)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it2('renders the taxonomy management link to the release tab', async () => {
    const { OnboardingSettings } = await import('../../client/components/OnboardingSettings');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(OnboardingSettings, { onBack: () => {} }));
    });
    const link = Array.from(container.querySelectorAll('a')).find(
      (a) => a.getAttribute('href') === '/?view=settings&tab=taxonomy-release',
    );
    expect2(link).toBeDefined();
    expect2(link!.textContent).toContain('Manage taxonomy releases, types, mappings & health');
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
  it2('renders the classification back-link to onboarding curation', async () => {
    const { SettingsClassificationTab } = await import('../../client/components/settings/SettingsClassificationTab');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(SettingsClassificationTab, { view: 'catalog-fields', children: null }));
    });
    const link = container.querySelector('a[href="/?view=onboarding&settingsTab=curation"]');
    expect2(link).toBeDefined();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
