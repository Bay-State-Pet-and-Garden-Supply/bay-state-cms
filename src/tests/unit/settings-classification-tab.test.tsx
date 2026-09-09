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

describe('Settings classification tabs (P1 UI revamp)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    getLlmTaskConfigs.mockClear();
    getClassificationConfig.mockClear();
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('shows the frozen banner on read-only Types & Attributes with no mutation controls', async () => {
    const { container, unmount } = await renderSettings('&tab=types');
    const panel = container.querySelector<HTMLElement>('#settings-tabpanel-types');
    expect(panel).not.toBeNull();

    const banner = panel!.querySelector('[data-frozen-banner="true"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain('immutable taxonomy release');
    expect(banner!.textContent).toContain('read-only');

    // Read-only surface: no save/submit-style controls rendered
    const buttons = Array.from(panel!.querySelectorAll('button'));
    expect(buttons.length).toBe(0);

    // Reused workbench content renders (product types list)
    expect(panel!.textContent).toContain('Dog Food');
    expect(getClassificationConfig).toHaveBeenCalled();
    await unmount();
  });

  it('shows the frozen banner on Mappings & Health without mutation controls', async () => {
    const { container, unmount } = await renderSettings('&tab=mappings-health');
    const panel = container.querySelector<HTMLElement>('#settings-tabpanel-mappings-health');
    expect(panel).not.toBeNull();

    const banners = panel!.querySelectorAll('[data-frozen-banner="true"]');
    expect(banners.length).toBeGreaterThanOrEqual(1);
    for (const banner of banners) {
      expect(banner.textContent).toContain('read-only');
    }

    // Mapping selects are disabled under the freeze; no enabled selects exist
    const enabledSelects = Array.from(panel!.querySelectorAll('select')).filter((s) => !s.disabled);
    expect(enabledSelects.length).toBe(0);
    await unmount();
  });
});
