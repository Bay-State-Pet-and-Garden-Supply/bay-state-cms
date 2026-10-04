// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { AiComputePanel } from '../../client/components/AiComputePanel';
import { getAiConfig } from '../../client/onboarding-api';
import type { AiRoutingConfig, WorkloadRoute } from '../../ai/provider-connections';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../client/onboarding-api', () => ({
  getAiConfig: vi.fn(), upsertAiConnection: vi.fn(), deleteAiConnection: vi.fn(), probeAiConnection: vi.fn(),
  testEphemeralAiConnection: vi.fn(), saveAiDefaults: vi.fn(), upsertAiWorkloadRoute: vi.fn(),
}));
vi.mock('../../client/components/settings/ClassificationProviderSettings', () => ({
  ClassificationProviderSettings: () => <section>Classification Stage Providers</section>,
}));

describe('AI Compute settings', () => {
  it('renders configured routing without recursion and keeps judgment-only providers out of chat choices', async () => {
    const inherited: WorkloadRoute = { primary: 'inherit', fallback: null, terminalBehavior: 'fail_closed' };
    const config: AiRoutingConfig = {
      connections: {
        local: { id: 'local', label: 'Local Ollama', transport: 'ollama-native', baseUrl: 'http://127.0.0.1:11434', trustZone: 'this_device', enabled: true },
        jev: { id: 'jev', label: 'TypeSafe Jev', transport: 'systemone', baseUrl: 'https://api.typesafe.ai/v1', trustZone: 'cloud', enabled: true },
      },
      defaults: { catalogTarget: { connectionId: 'local', modelId: 'qwen2.5vl:latest' }, catalogFallback: null,
        textDataSharing: 'this_device_only', imageDataSharing: 'this_device_only' },
      workloads: { discovery: inherited, curation: inherited, visionOcr: inherited, profileBuilder: inherited, storeManager: inherited },
    };
    vi.mocked(getAiConfig).mockResolvedValue({ config, health: {} });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<AiComputePanel />); });
      expect(container.textContent).toContain('TypeSafe Jev');
      expect(container.textContent).toContain('Classification Stage Providers');
      const chatChoices = [...container.querySelectorAll('select')].filter(select => [...select.options].some(option => option.value === 'local'));
      expect(chatChoices.length).toBeGreaterThanOrEqual(2);
      for (const select of chatChoices) {
        expect([...select.options].map(option => option.value)).not.toContain('jev');
      }
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });
});
