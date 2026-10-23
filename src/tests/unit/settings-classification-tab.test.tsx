// @vitest-environment jsdom
/**
 * Settings classification tabs tests (P1 UI revamp).
 *
 * Asserts the consolidated Store Settings IA:
 *  - LlmTaskConfigPanel mounts under AI Tasks and issues GET /settings/llm-task-configs
 *  - read-only classification views render the FrozenBanner
 *  - no mutation controls render on frozen surfaces
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

const { getLlmTaskConfigs, getClassificationConfig } = vi.hoisted(() => ({
  getLlmTaskConfigs: vi.fn(async () => ({ taskConfigs: [], knownTasks: ['profile_generation'] })),
  getClassificationConfig: vi.fn(async () => ({
    config: {
      productTypes: [{ id: 'dog-food', name: 'Dog Food', description: null, attributeProfileId: null, oldIdAliases: [] }],
      attributes: [],
      attributeProfiles: [],
      attributeMappings: [],
    },
  })),
}));

vi.mock('@/client/api', () => ({
  listFieldRegistry: vi.fn(async () => ({ entries: [] })),
  updateFieldRegistryEntry: vi.fn(async () => ({})),
  getConnection: vi.fn(async () => ({ connection: null })),
  saveConnection: vi.fn(async () => ({})),
  testConnection: vi.fn(async () => ({ ok: true, message: 'ok' })),
  listCatalogFields: vi.fn(async () => ({ fields: [] })),
  listAttributeMappings: vi.fn(async () => ({ mappings: [] })),
  getCatalogSchemaHealth: vi.fn(async () => ({ findings: [], summary: { blockers: 0, warnings: 0, infos: 0 } })),
  getCatalogHealthReport: vi.fn(async () => ({ issues: [] })),
  getSecuritySettings: vi.fn(async () => ({ tokenConfigured: false, tokenMask: null, releaseAdminEnabled: false, apiTokenSource: 'unset', releaseAdminSource: 'database' })),
  generateSecurityToken: vi.fn(async () => ({})),
  updateSecuritySettings: vi.fn(async () => ({})),
}));
vi.mock('@/client/onboarding-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../client/onboarding-api')>();
  return {
    ...actual,
    getClassificationConfig,
    getLlmTaskConfigs,
    getCurationTargets: vi.fn(async () => ({ targets: [], candidates: { productFields: [], pages: [] }, applicability: [], findings: [] })),
    getApiKeys: vi.fn(async () => ({ keys: [] })),
    updateApiKey: vi.fn(async () => ({})),
    deleteApiKey: vi.fn(async () => ({})),
    getOnboardingCapabilities: vi.fn(async () => ({})),
    getExtractionWorkerHealth: vi.fn(async () => ({})),
    upsertLlmTaskConfig: vi.fn(async () => ({})),
    deleteLlmTaskConfig: vi.fn(async () => ({})),
    getDeepseekModels: vi.fn(async () => ({ models: [] })),
    getOpenaiModels: vi.fn(async () => ({ models: [] })),
    getOllamaModels: vi.fn(async () => ({ models: [] })),
  };
});

vi.mock('@/client/components/AiComputePanel', () => ({
  AiComputePanel: () => <div data-testid="ai-compute-panel">AI Compute</div>,
}));

import { Settings } from '../../client/components/Settings';

async function renderSettings(search = ''): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  window.history.replaceState(null, '', `/?view=settings${search}`);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Settings />);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/**
 * No taxonomy mutation affordances: no enabled data entry, no submit
 * buttons, no mutation-labeled buttons. Exempt: the sanctioned back-link,
 * product-navigation links, read-only affordances (Refresh, filter tabs,
 * disclose toggles), and the listing-standards authoring section (versioned
 * Git-backed config with its own server-side gates, not a taxonomy
 * mutation).
 */
const READONLY_BUTTON_LABELS = /^\d*(refresh|all|blockers|warnings|infos?|\+ format|×|reload standards|←.*|open product:.*)$/i;
const MUTATION_BUTTON_LABELS = /save|apply|update|delete|activate|create|edit|commit/i;
function assertNoTaxonomyMutationControls(panel: HTMLElement): void {
  const mutationControls = Array.from(panel.querySelectorAll('button, input, select, textarea, a'))
    .filter((control) => {
      if (control.closest('section[aria-labelledby="listing-standards-heading"]')) return false;
      if (control instanceof HTMLAnchorElement) {
        return control.getAttribute('href') !== '/?view=onboarding&settingsTab=curation'
          && !/^open product:/i.test(control.textContent ?? '');
      }
      if (control instanceof HTMLButtonElement) {
        if (control.disabled) return false;
        const label = (control.textContent ?? '').trim();
        if (READONLY_BUTTON_LABELS.test(label)) return false;
        return true;
      }
      return true;
    });
  const mutationLabeled = Array.from(panel.querySelectorAll('button'))
    .filter((b) => !(b as HTMLButtonElement).disabled && MUTATION_BUTTON_LABELS.test((b.textContent ?? '').trim()));
  expect(mutationLabeled).toHaveLength(0);
  expect(mutationControls).toHaveLength(0);
}

describe('Settings classification tabs (P1 UI revamp)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    getLlmTaskConfigs.mockClear();
    getClassificationConfig.mockClear();
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('shows frozen copy and no mutation controls on Types & Attributes', async () => {
    const { container, unmount } = await renderSettings('&tab=types');
    const panel = container.querySelector<HTMLElement>('#settings-tabpanel-types');
    expect(panel).not.toBeNull();

    const banner = panel!.querySelector('[data-frozen-banner="true"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain('immutable taxonomy release');
    expect(banner!.textContent).toContain('read-only');
    expect(banner!.textContent).toContain('new release');
    expect(banner!.textContent).not.toContain('Editing');
    expect(panel!.textContent).toContain('Dog Food');
    expect(getClassificationConfig).toHaveBeenCalled();

    // No taxonomy mutation affordances (see helper above).
    assertNoTaxonomyMutationControls(panel!);
    await unmount();
  });

  it('shows item acquisition settings only on General', async () => {
    const general = await renderSettings();
    const generalPanel = general.container.querySelector<HTMLElement>('#settings-tabpanel-general');
    expect(generalPanel?.textContent).toContain('Item acquisition policy');
    await general.unmount();

    const types = await renderSettings('&tab=types');
    const typesPanel = types.container.querySelector<HTMLElement>('#settings-tabpanel-types');
    expect(typesPanel?.textContent).not.toContain('Item acquisition policy');
    await types.unmount();
  });

  it('shows frozen copy and no mutation controls on Mappings & Health', async () => {
    const { container, unmount } = await renderSettings('&tab=mappings-health');
    const panel = container.querySelector<HTMLElement>('#settings-tabpanel-mappings-health');
    expect(panel).not.toBeNull();

    const banners = panel!.querySelectorAll('[data-frozen-banner="true"]');
    expect(banners.length).toBeGreaterThanOrEqual(1);
    for (const banner of banners) {
      expect(banner.textContent).toContain('immutable taxonomy release');
      expect(banner.textContent).toContain('read-only');
      expect(banner.textContent).toContain('new release');
      expect(banner.textContent).not.toContain('Editing');
    }

    // No taxonomy mutation affordances (see helper above).
    assertNoTaxonomyMutationControls(panel!);
    await unmount();
  });
});
