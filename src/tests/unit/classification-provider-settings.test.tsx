// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ClassificationProviderSettings } from '../../client/components/settings/ClassificationProviderSettings';
import * as api from '../../client/api';

vi.mock('../../client/api', () => ({
  getClassificationPolicySettings: vi.fn(),
  previewClassificationPolicy: vi.fn(),
  applyClassificationPolicy: vi.fn(),
}));

const mockSettings: api.ClassificationPolicySettingsResponse = {
  migrationRequired: false,
  bundleHash: '1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
  activeRevision: 'bay-state-v5',
  defaultProvider: 'ollama',
  defaultModel: 'qwen2.5vl:latest',
  textDataSharing: 'local_only',
  imageDataSharing: 'local_only',
  stages: [
    {
      id: 'primary_product_type_proposal',
      label: 'Primary Product Type',
      description: 'Proposes canonical product type.',
      isInherited: true,
      effectiveProvider: 'ollama',
      effectiveModel: 'qwen2.5vl:latest',
      effectiveFallbackProvider: null,
      effectiveFallbackModel: null,
      connectionId: 'conn-ollama',
      connectionLabel: 'Local Ollama',
      connectionStatus: 'healthy',
      connectionLocality: 'local',
    },
    {
      id: 'product_attribute_proposals',
      label: 'Controlled Product Attributes',
      description: 'Proposes controlled attributes.',
      isInherited: true,
      effectiveProvider: 'ollama',
      effectiveModel: 'qwen2.5vl:latest',
      effectiveFallbackProvider: null,
      effectiveFallbackModel: null,
      connectionId: 'conn-ollama',
      connectionLabel: 'Local Ollama',
      connectionStatus: 'healthy',
      connectionLocality: 'local',
    },
    {
      id: 'category_page_proposals',
      label: 'Category Pages',
      description: 'Proposes category pages.',
      isInherited: true,
      effectiveProvider: 'ollama',
      effectiveModel: 'qwen2.5vl:latest',
      effectiveFallbackProvider: null,
      effectiveFallbackModel: null,
      connectionId: 'conn-ollama',
      connectionLabel: 'Local Ollama',
      connectionStatus: 'healthy',
      connectionLocality: 'local',
    },
  ],
  availableConnections: [
    {
      id: 'conn-ollama',
      label: 'Local Ollama',
      transport: 'ollama-native',
      trustZone: 'this_device',
      locality: 'local',
      enabled: true,
      status: 'healthy',
      models: [{ id: 'qwen2.5:7b', name: 'Qwen 2.5 7B' }],
      stageSupport: {
        primary_product_type_proposal: { supported: true },
        product_attribute_proposals: { supported: true },
        category_page_proposals: { supported: true },
      },
    },
    {
      id: 'conn-typesafe',
      label: 'TypeSafe Jev',
      transport: 'systemone',
      trustZone: 'cloud',
      locality: 'cloud',
      enabled: true,
      status: 'healthy',
      models: [{ id: 'jev-1.13.0', name: 'Jev 1.13.0' }],
      stageSupport: {
        primary_product_type_proposal: {
          supported: false,
          reason: 'TypeSafe Jev typed-judgment adapter is not yet available for stage "Primary Product Type" (pending stage adapter).',
        },
        product_attribute_proposals: {
          supported: false,
          reason: 'TypeSafe Jev typed-judgment adapter is not yet available for stage "Controlled Product Attributes" (pending stage adapter).',
        },
        category_page_proposals: {
          supported: false,
          reason: 'TypeSafe Jev typed-judgment adapter is not yet available for stage "Category Pages" (pending stage adapter).',
        },
      },
    },
  ],
};

describe('ClassificationProviderSettings UI', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  it('renders effective routes for all three classification stages', async () => {
    vi.mocked(api.getClassificationPolicySettings).mockResolvedValueOnce({ settings: mockSettings });

    const root = createRoot(container);
    await act(async () => {
      root.render(<ClassificationProviderSettings />);
    });

    expect(container.textContent).toContain('Classification Stage Providers');
    expect(container.textContent).toContain('Primary Product Type');
    expect(container.textContent).toContain('Controlled Product Attributes');
    expect(container.textContent).toContain('Category Pages');
    expect(container.textContent).toContain('Inherited from Default');
    expect(container.textContent).toContain('Active Revision: bay-state-v5');
  });

  it('displays warning when TypeSafe Jev adapter is selected on unwired stage', async () => {
    vi.mocked(api.getClassificationPolicySettings).mockResolvedValueOnce({ settings: mockSettings });

    const root = createRoot(container);
    await act(async () => {
      root.render(<ClassificationProviderSettings />);
    });

    // Find the override checkbox for Primary Product Type
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBeGreaterThan(0);

    // Toggle override on first stage
    await act(async () => {
      (checkboxes[0] as HTMLInputElement).click();
    });

    // Select TypeSafe Jev connection
    const selects = container.querySelectorAll('select');
    // Find connection select (it has option for conn-typesafe)
    const connSelect = Array.from(selects).find(s => s.textContent?.includes('TypeSafe Jev'));
    expect(connSelect).toBeDefined();

    await act(async () => {
      connSelect!.value = 'conn-typesafe';
      connSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Actionable explanation must appear
    expect(container.textContent).toContain('TypeSafe Jev typed-judgment adapter is not yet available');
    expect(container.textContent).toContain('pending stage adapter');
  });

  it('previews changes and displays validation errors', async () => {
    vi.mocked(api.getClassificationPolicySettings).mockResolvedValueOnce({ settings: mockSettings });
    vi.mocked(api.previewClassificationPolicy).mockResolvedValueOnce({
      preview: {
        valid: false,
        previewToken: null,
        baseBundleHash: mockSettings.bundleHash,
        dataSharingEffects: [],
        validationErrors: ['Cloud provider requires textDataSharing to be cloud_allowed.'],
        diff: { stages: {}, dataSharing: { text: { from: 'local_only', to: 'local_only' }, image: { from: 'local_only', to: 'local_only' } } },
      },
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(<ClassificationProviderSettings />);
    });

    // Click preview
    const previewBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Preview Changes'));
    expect(previewBtn).toBeDefined();

    await act(async () => {
      previewBtn!.click();
    });

    expect(container.textContent).toContain('Cannot Apply Changes:');
    expect(container.textContent).toContain('Cloud provider requires textDataSharing to be cloud_allowed.');
  });

  it('renders migration required banner for v1 configurations', async () => {
    vi.mocked(api.getClassificationPolicySettings).mockResolvedValueOnce({
      settings: {
        ...mockSettings,
        migrationRequired: true,
      },
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(<ClassificationProviderSettings />);
    });

    expect(container.textContent).toContain('Classification v2 Migration Required');
    expect(container.textContent).toContain('Onboarding Settings');
  });
});
