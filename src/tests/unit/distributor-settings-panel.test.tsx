/**
 * DistributorConnectionsPanel render + interaction assertions.
 *
 * Pure-component tests via `renderToStaticMarkup` (no effects) follow the
 * `sourcing-stage-panel.test.tsx` pattern, plus jsdom interaction tests that
 * prove the Amendment A enable-with-confirmation flow: creation is ALWAYS
 * disabled, and enabling is a separate explicit PATCH after a confirmation
 * step mentioning fixture/credential/health checks.
 */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

vi.mock('@/client/onboarding-api', () => ({
  getDistributorConnections: vi.fn(),
  getDistributors: vi.fn(),
  getBrandProfiles: vi.fn(),
  createDistributorConnection: vi.fn(),
  updateDistributorConnection: vi.fn(),
  upsertBrandProfile: vi.fn(),
  deleteBrandProfile: vi.fn(),
}));

import { DistributorConnectionsPanel } from '../../client/components/onboarding-settings/DistributorConnectionsPanel';
import {
  getDistributorConnections,
  getDistributors,
  getBrandProfiles,
  updateDistributorConnection,
} from '../../client/onboarding-api';
import type { DistributorConnectionView } from '../../client/onboarding-api';

function conn(overrides: Partial<DistributorConnectionView> = {}): DistributorConnectionView {
  return {
    id: 'c1',
    distributorId: 'phillips',
    distributorName: 'Phillips',
    connectorType: 'api',
    enabled: false,
    secretConfigured: true,
    secretRequired: true,
    configuration: {},
    authorityPolicy: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('DistributorConnectionsPanel', () => {
  it('renders the engine-disabled banner when the capability is off', () => {
    const html = renderToStaticMarkup(<DistributorConnectionsPanel engineEnabled={false} />);
    expect(html).toContain('Sourcing engine is');
    expect(html).toContain('disabled');
    expect(html).toContain('BAYSTATE_CMS_SOURCING_ENABLED');
  });

  it('surfaces the configuration reason in the disabled banner', () => {
    const html = renderToStaticMarkup(
      <DistributorConnectionsPanel engineEnabled={false} configurationReason="malformed configuration" />,
    );
    expect(html).toContain('malformed configuration');
  });

  it('omits the disabled banner when the capability is on', () => {
    const html = renderToStaticMarkup(<DistributorConnectionsPanel engineEnabled={true} />);
    expect(html).not.toContain('Sourcing engine is');
  });

  it('surfaces the Add connection button and the empty state', () => {
    const html = renderToStaticMarkup(<DistributorConnectionsPanel engineEnabled={true} />);
    expect(html).toContain('+ Add connection');
    expect(html).toContain('No distributor connections configured.');
  });

  it('renders the create form with an OPAQUE secret-ref input and config/authority editors', () => {
    const html = renderToStaticMarkup(<DistributorConnectionsPanel engineEnabled={true} initiallyOpen />);
    expect(html).toContain('Secret ref');
    expect(html).toContain('never the key itself');
    expect(html).toContain('Raw credentials are never stored');
    expect(html).toContain('Config JSON');
    expect(html).toContain('Authority JSON');
    // The secret input is a plain text reference name, never a password field.
    expect(html.toLowerCase()).not.toContain('type="password"');
  });

  it('never renders raw-credential inputs in the static surface (no password/token fields)', () => {
    const html = renderToStaticMarkup(<DistributorConnectionsPanel engineEnabled={true} />);
    expect(html.toLowerCase()).not.toContain('type="password"');
    expect(html.toLowerCase()).not.toContain('placeholder="api key');
    // Secret references are opaque names, never values.
    expect(html.toLowerCase()).not.toContain('secret value');
  });

  it('is infra-only: advisory brand profiles moved to Brands Hub (no advisory form, pointer copy present)', () => {
    const html = renderToStaticMarkup(<DistributorConnectionsPanel engineEnabled={true} />);
    expect(html).not.toContain('Advisory Brand Profiles');
    expect(html).not.toContain('never implies not_stocked');
    expect(html).toContain('Brand routing moved to');
    expect(html).toContain('Settings → Brands');
  });
});

describe('DistributorConnectionsPanel (Amendment A defaults)', () => {
  it('create form states connections are created disabled and require health checks', () => {
    const html = renderToStaticMarkup(<DistributorConnectionsPanel engineEnabled={true} initiallyOpen />);
    expect(html).toContain('created');
    expect(html).toContain('disabled');
    expect(html).toContain('fixture, credential, and health checks');
  });

  it('a disabled connection renders the Enable action with a separate confirmation step', () => {
    const html = renderToStaticMarkup(
      <DistributorConnectionsPanel
        engineEnabled={true}
        initialConnections={[conn()]}
        initiallyConfirmingId="c1"
      />,
    );
    expect(html).toContain('disabled');
    expect(html).toContain('Enable');
    expect(html).toContain('Enable this connection for distributor lookups?');
    expect(html).toContain('Verify fixture, credential, and health checks completed before activating.');
    expect(html).toContain('Confirm enable');
  });

  it('an enabled connection renders a direct Disable action without a confirmation strip', () => {
    const html = renderToStaticMarkup(
      <DistributorConnectionsPanel
        engineEnabled={true}
        initialConnections={[conn({ enabled: true })]}
      />,
    );
    expect(html).toContain('enabled');
    expect(html).toContain('Disable');
    expect(html).not.toContain('Confirm enable');
  });
});

describe('DistributorConnectionsPanel enable flow (jsdom)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDistributorConnections).mockResolvedValue({ connections: [conn()] });
    vi.mocked(getDistributors).mockResolvedValue({ distributors: [] });
    vi.mocked(getBrandProfiles).mockResolvedValue({ profiles: [] });
    vi.mocked(updateDistributorConnection).mockResolvedValue({ connection: conn({ enabled: true }) });
  });

  it('enabling a connection requires confirmation and PATCHes only on Confirm enable', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<DistributorConnectionsPanel engineEnabled={true} />);
    });

    // The mocked connection renders; Enable does NOT patch immediately.
    const enableBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Enable');
    expect(enableBtn).toBeTruthy();
    expect(updateDistributorConnection).not.toHaveBeenCalled();

    await act(async () => {
      enableBtn!.click();
    });
    expect(container.textContent).toContain('Confirm enable');
    expect(updateDistributorConnection).not.toHaveBeenCalled();

    const confirmBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Confirm enable');
    await act(async () => {
      confirmBtn!.click();
    });
    expect(updateDistributorConnection).toHaveBeenCalledWith('c1', { enabled: true });

    await act(async () => {
      root.unmount();
      container.remove();
    });
  });

  it('Cancel dismisses the enable confirmation without patching', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<DistributorConnectionsPanel engineEnabled={true} />);
    });

    const enableBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Enable');
    await act(async () => {
      enableBtn!.click();
    });
    const cancelBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Cancel');
    await act(async () => {
      cancelBtn!.click();
    });
    expect(updateDistributorConnection).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Confirm enable');

    await act(async () => {
      root.unmount();
      container.remove();
    });
  });
});

describe('DistributorConnectionsPanel html_scraper form (Amendment B)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDistributorConnections).mockResolvedValue({ connections: [] });
    vi.mocked(getDistributors).mockResolvedValue({ distributors: [] });
    vi.mocked(getBrandProfiles).mockResolvedValue({ profiles: [] });
  });

  it('offers html_scraper as a connector type in the create form', () => {
    const html = renderToStaticMarkup(<DistributorConnectionsPanel engineEnabled={true} initiallyOpen />);
    expect(html).toContain('html_scraper');
    // The generic base-URL override is present for the default 'api' type.
    expect(html).toContain('Base URL (optional)');
  });

  it('selecting html_scraper hides the base-URL override and explains the fixed code config', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<DistributorConnectionsPanel engineEnabled={true} initiallyOpen />);
    });

    expect(container.textContent).toContain('Base URL (optional)');

    const select = container.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      nativeSetter.call(select, 'html_scraper');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(container.textContent).not.toContain('Base URL (optional)');
    expect(container.textContent).toContain('code-fixed storefront URL');

    await act(async () => {
      root.unmount();
      container.remove();
    });
  });

  it('creating an html_scraper connection sends no enabled flag and no base URL', async () => {
    const { createDistributorConnection } = await import('../../client/onboarding-api');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<DistributorConnectionsPanel engineEnabled={true} initiallyOpen />);
    });

    // Select html_scraper and fill the distributor id.
    const select = container.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      nativeSetter.call(select, 'html_scraper');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const distributorInput = Array.from(container.querySelectorAll('input'))
      .find((i) => i.getAttribute('list') === 'distributor-options') as HTMLInputElement;
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      nativeSetter.call(distributorInput, 'bradley');
      distributorInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const createBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Create connection');
    expect(createBtn).toBeTruthy();
    await act(async () => {
      createBtn!.click();
    });

    expect(createDistributorConnection).toHaveBeenCalledWith({
      distributorId: 'bradley',
      connectorType: 'html_scraper',
      secretRef: null,
      configuration: {},
      authorityPolicy: undefined,
    });

    await act(async () => {
      root.unmount();
      container.remove();
    });
  });
});
