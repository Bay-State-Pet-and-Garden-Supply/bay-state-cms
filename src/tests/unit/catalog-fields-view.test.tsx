// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CatalogFieldsView } from '../../client/components/catalog-workbench/CatalogFieldsView';
import { listCatalogFields, listFieldRegistry, listAttributeMappings } from '../../client/api';
import { getCurationTargets } from '../../client/onboarding-api';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../client/api', () => ({
  listCatalogFields: vi.fn(),
  listFieldRegistry: vi.fn(),
  listAttributeMappings: vi.fn(),
}));

vi.mock('../../client/onboarding-api', () => ({
  getCurationTargets: vi.fn(),
}));

describe('CatalogFieldsView fallback & characterization (Ticket #127 / W0)', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  const flushPromises = () => new Promise(resolve => setTimeout(resolve, 10));

  it('renders fields from primary listCatalogFields without invoking fallback APIs on success', async () => {
    (listCatalogFields as any).mockResolvedValue({
      fields: [
        {
          xmlField: 'ProductField24',
          label: 'Flavor',
          kind: 'custom',
          dataType: 'string',
          uiGroup: 'Custom Fields',
          nonEmptyCount: 15,
          distinctCount: 4,
          inferredValueMode: 'controlled',
          mappedAttributeId: 'flavor',
          isCurationTarget: true,
          isStale: false,
          warning: null,
        },
      ],
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(<CatalogFieldsView onSelectProduct={vi.fn()} />);
    });
    await act(async () => {
      await flushPromises();
    });

    expect(listCatalogFields).toHaveBeenCalledTimes(1);
    expect(listFieldRegistry).not.toHaveBeenCalled();
    expect(listAttributeMappings).not.toHaveBeenCalled();
    expect(getCurationTargets).not.toHaveBeenCalled();

    expect(container.textContent).toContain('Flavor');
    expect(container.textContent).toContain('ProductField24');
    expect(container.textContent).toContain('15');
    expect(container.textContent).toContain('ok');

    act(() => root.unmount());
  });

  it('engages fallback when primary listCatalogFields fails, assembling registry + mappings + targets', async () => {
    (listCatalogFields as any).mockRejectedValue(new Error('Server unavailable'));
    (listFieldRegistry as any).mockResolvedValue({
      entries: [
        {
          xmlField: 'ProductField24',
          label: 'Flavor',
          kind: 'custom',
          dataType: 'string',
          uiGroup: 'Custom Fields',
        },
        {
          xmlField: 'ProductField25',
          label: 'ProductField25', // unlabeled -> triggers warning in fallback
          kind: 'custom',
          dataType: 'string',
          uiGroup: 'Custom Fields',
        },
      ],
    });
    (listAttributeMappings as any).mockResolvedValue({
      mappings: [
        { catalogField: 'ProductField24', attributeId: 'flavor', isStale: true },
      ],
    });
    (getCurationTargets as any).mockResolvedValue({
      targets: [
        { kind: 'product_field', catalogField: 'ProductField24' },
      ],
      candidates: { productFields: [], pages: [] },
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(<CatalogFieldsView onSelectProduct={vi.fn()} />);
    });
    await act(async () => {
      await flushPromises();
    });

    expect(listCatalogFields).toHaveBeenCalledTimes(1);
    expect(listFieldRegistry).toHaveBeenCalledTimes(1);
    expect(listAttributeMappings).toHaveBeenCalledTimes(1);
    expect(getCurationTargets).toHaveBeenCalledTimes(1);

    // Fallback renders the entries
    expect(container.textContent).toContain('Flavor');
    expect(container.textContent).toContain('ProductField24');
    expect(container.textContent).toContain('ProductField25');
    // In fallback: unlabeled field shows ⚠️ and "warning" in status
    expect(container.textContent).toContain('⚠️');
    expect(container.textContent).toContain('warning');

    act(() => root.unmount());
  });

  it('pins fallback quirks: isStale is always false, counts are 0, and inferredValueMode is unknown', async () => {
    (listCatalogFields as any).mockRejectedValue(new Error('500 Internal Server Error'));
    (listFieldRegistry as any).mockResolvedValue({
      entries: [
        {
          xmlField: 'ProductField24',
          label: 'Flavor',
          kind: 'custom',
          dataType: 'string',
          uiGroup: null,
        },
      ],
    });
    // Even though mapping has isStale: true, fallback sets isStale: false and warning: null
    (listAttributeMappings as any).mockResolvedValue({
      mappings: [
        { catalogField: 'ProductField24', attributeId: 'flavor', isStale: true },
      ],
    });
    (getCurationTargets as any).mockResolvedValue({
      targets: [],
      candidates: { productFields: [], pages: [] },
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(<CatalogFieldsView onSelectProduct={vi.fn()} />);
    });
    await act(async () => {
      await flushPromises();
    });

    // Content shows Unclassified (unknown mode badge) and 'ok' status because isStale: false in fallback
    expect(container.textContent).toContain('Flavor');
    expect(container.textContent).toContain('Unclassified');
    expect(container.textContent).toContain('ok');
    expect(container.textContent).not.toContain('stale');

    act(() => root.unmount());
  });

  it('handles partial fallback failures gracefully when mappings or targets fail', async () => {
    (listCatalogFields as any).mockRejectedValue(new Error('Down'));
    (listFieldRegistry as any).mockResolvedValue({
      entries: [
        { xmlField: 'ProductField1', label: 'Field 1', kind: 'custom', dataType: 'string', uiGroup: null },
      ],
    });
    (listAttributeMappings as any).mockRejectedValue(new Error('Mappings failed'));
    (getCurationTargets as any).mockRejectedValue(new Error('Targets failed'));

    const root = createRoot(container);
    await act(async () => {
      root.render(<CatalogFieldsView onSelectProduct={vi.fn()} />);
    });
    await act(async () => {
      await flushPromises();
    });

    expect(container.textContent).toContain('Field 1');

    act(() => root.unmount());
  });

  it('renders empty table when registry also fails in fallback', async () => {
    (listCatalogFields as any).mockRejectedValue(new Error('Down'));
    (listFieldRegistry as any).mockRejectedValue(new Error('Registry down'));
    (listAttributeMappings as any).mockResolvedValue({ mappings: [] });
    (getCurationTargets as any).mockResolvedValue({ targets: [] });

    const root = createRoot(container);
    await act(async () => {
      root.render(<CatalogFieldsView onSelectProduct={vi.fn()} />);
    });
    await act(async () => {
      await flushPromises();
    });

    expect(container.textContent).toContain('No catalog fields found.');

    act(() => root.unmount());
  });

  it('handles component unmounting during in-flight requests safely', async () => {
    let resolvePrimary: any;
    (listCatalogFields as any).mockReturnValue(
      new Promise(resolve => {
        resolvePrimary = resolve;
      }),
    );

    const root = createRoot(container);
    await act(async () => {
      root.render(<CatalogFieldsView onSelectProduct={vi.fn()} />);
    });

    // Unmount before resolve
    act(() => {
      root.unmount();
    });

    // Resolving now must not throw or update unmounted component
    await act(async () => {
      resolvePrimary({ fields: [] });
      await flushPromises();
    });
  });
});
