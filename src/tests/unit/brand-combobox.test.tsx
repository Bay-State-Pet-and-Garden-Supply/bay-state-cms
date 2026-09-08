// @vitest-environment jsdom
/**
 * Brand combobox slice — UI-only typeahead over the EXISTING getBrandSites()
 * client. Pins: suggestion filtering (case-insensitive, prefix-first),
 * canonical-spelling submission (no ghost brands via casing variants), and
 * the new-brand confirm nudge (advisory, free entry still allowed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/client/onboarding-api', () => ({
  getBrandSites: vi.fn(),
}));

import React, { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { getBrandSites } from '@/client/onboarding-api';
import {
  buildBrandOptions,
  filterBrandOptions,
  resolveCanonicalBrand,
  isNewBrandValue,
  getBrandOptions,
  resetBrandOptionsCache,
} from '@/client/components/onboarding/brand-combobox-logic';
import { BrandCombobox } from '@/client/components/onboarding/BrandCombobox';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('brand-combobox-logic: option pool', () => {
  it('keeps the brand_sites stored spelling as canonical (first spelling wins)', () => {
    const opts = buildBrandOptions(
      [{ brandName: 'Acana' }, { brandName: '  ' }, { brandName: 42 as unknown as string }],
      ['acana', 'Zebra', 'zebra', '', '  Orijen  '],
    );
    expect(opts).toEqual(['Acana', 'Zebra', 'Orijen']);
  });

  it('tolerates null/undefined reads (degrades to free text, never throws)', () => {
    expect(buildBrandOptions(null, undefined)).toEqual([]);
    expect(buildBrandOptions([], [])).toEqual([]);
  });
});

describe('brand-combobox-logic: suggestion filtering', () => {
  const pool = ['Acana', 'Acme', 'Orijen', 'Zebra Farms', 'Blue Buffalo'];

  it('matches case-insensitively on substrings', () => {
    expect(filterBrandOptions(pool, 'aca')).toEqual(['Acana']);
    expect(filterBrandOptions(pool, 'ACA')).toEqual(['Acana']);
    expect(filterBrandOptions(pool, 'buff')).toEqual(['Blue Buffalo']);
  });

  it('ranks prefix matches before contains matches', () => {
    // "ac" prefixes Acana + Acme; "Zebra Farms" does not contain "ac".
    expect(filterBrandOptions(pool, 'ac')).toEqual(['Acana', 'Acme']);
    // "far" is a contains-match on "Zebra Farms".
    expect(filterBrandOptions(pool, 'far')).toEqual(['Zebra Farms']);
  });

  it('returns no suggestions for empty queries and respects the limit', () => {
    expect(filterBrandOptions(pool, '')).toEqual([]);
    expect(filterBrandOptions(pool, '   ')).toEqual([]);
    expect(filterBrandOptions(pool, 'a', 1)).toHaveLength(1);
  });
});

describe('brand-combobox-logic: canonical submission + new-brand nudge', () => {
  const pool = ['Acana', 'Blue Buffalo'];

  it('resolves miscased existing brands to the canonical stored spelling', () => {
    expect(resolveCanonicalBrand('acana', pool)).toBe('Acana');
    expect(resolveCanonicalBrand('  ACANA  ', pool)).toBe('Acana');
    expect(resolveCanonicalBrand('blue buffalo', pool)).toBe('Blue Buffalo');
  });

  it('passes genuinely new brands through trimmed and untouched', () => {
    expect(resolveCanonicalBrand('  CustomBrandX  ', pool)).toBe('CustomBrandX');
    expect(resolveCanonicalBrand('', pool)).toBe('');
    expect(resolveCanonicalBrand('   ', pool)).toBe('');
  });

  it('flags only genuinely new values for the confirm nudge', () => {
    expect(isNewBrandValue('CustomBrandX', pool)).toBe(true);
    expect(isNewBrandValue('acana', pool)).toBe(false);
    expect(isNewBrandValue('ACANA', pool)).toBe(false);
    expect(isNewBrandValue('', pool)).toBe(false);
    expect(isNewBrandValue('   ', pool)).toBe(false);
  });
});

describe('brand-combobox-logic: getBrandOptions over the existing client', () => {
  beforeEach(() => {
    resetBrandOptionsCache();
    vi.mocked(getBrandSites).mockReset();
  });

  it('merges brandSites spellings + catalogBrands via getBrandSites()', async () => {
    vi.mocked(getBrandSites).mockResolvedValueOnce({
      brandSites: [{ brandName: 'Acana' }, { brandName: 'Orijen' }],
      catalogBrands: ['acana', 'Zebra'],
    } as never);
    await expect(getBrandOptions()).resolves.toEqual(['Acana', 'Orijen', 'Zebra']);
    expect(getBrandSites).toHaveBeenCalledTimes(1);
  });

  it('degrades to an empty pool (free-text entry) when the read fails', async () => {
    vi.mocked(getBrandSites).mockRejectedValueOnce(new Error('offline'));
    await expect(getBrandOptions()).resolves.toEqual([]);
  });
});

// ─── Component behavior ──────────────────────────────────────────────────────

function Harness({
  options,
  initial = '',
  onCommit,
}: {
  options: string[];
  initial?: string;
  onCommit: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <BrandCombobox
      value={value}
      onChange={setValue}
      onCommit={onCommit}
      options={options}
      ariaLabel="Brand for test"
      placeholder="Enter brand name"
      inputTestId="brand-test-input"
    />
  );
}

function setInputValue(input: HTMLInputElement, next: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, next);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('BrandCombobox component', () => {
  let container: HTMLDivElement;
  let root: Root;
  const OPTIONS = ['Acana', 'Acme', 'Orijen'];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  async function mount(initial = '', onCommit: (v: string) => void = () => {}) {
    await act(async () => {
      root.render(<Harness options={OPTIONS} initial={initial} onCommit={onCommit} />);
    });
  }

  function input(): HTMLInputElement {
    return container.querySelector('[data-testid="brand-test-input"]') as HTMLInputElement;
  }

  function suggestionTexts(): string[] {
    return Array.from(container.querySelectorAll('[data-testid="brand-combobox-option"]')).map(
      (el) => el.textContent ?? '',
    );
  }

  it('exposes a combobox + listbox and filters suggestions case-insensitively', async () => {
    await mount();
    const el = input();
    expect(el.getAttribute('role')).toBe('combobox');
    await act(async () => {
      setInputValue(el, 'aca');
    });
    expect(container.querySelector('[data-testid="brand-combobox-listbox"]')).not.toBeNull();
    expect(suggestionTexts()).toEqual(['Acana']);
    // Case-insensitive: uppercase query matches the same option.
    await act(async () => {
      setInputValue(el, 'ACA');
    });
    expect(suggestionTexts()).toEqual(['Acana']);
  });

  it('Enter picks the highlighted suggestion and commits its canonical spelling', async () => {
    const onCommit = vi.fn();
    await mount('', onCommit);
    const el = input();
    await act(async () => {
      setInputValue(el, 'ac');
    });
    // Prefix group, alphabetical: Acana then Acme.
    expect(suggestionTexts()).toEqual(['Acana', 'Acme']);
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    // Highlight moved to Acme; Enter commits that canonical spelling.
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('Acme');
    expect(input().value).toBe('Acme');
  });

  it('plain Enter with no highlight commits the typed value (caller canonicalizes)', async () => {
    const onCommit = vi.fn();
    await mount('', onCommit);
    const el = input();
    await act(async () => {
      setInputValue(el, 'acana');
    });
    await act(async () => {
      // Blur first so no suggestion is open, then Enter commits free entry.
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onCommit).toHaveBeenCalledWith('acana');
    // The submit path resolves to the stored spelling — no ghost brand.
    expect(resolveCanonicalBrand(onCommit.mock.calls[0][0], OPTIONS)).toBe('Acana');
  });

  it('shows a confirm nudge for genuinely new brands but none for existing spellings', async () => {
    await mount();
    const el = input();
    await act(async () => {
      setInputValue(el, 'CustomBrandX');
    });
    const nudge = container.querySelector('[data-testid="brand-combobox-new-nudge"]');
    expect(nudge).not.toBeNull();
    expect(nudge?.getAttribute('role')).toBe('status');
    expect(nudge?.textContent).toMatch(/Create new brand/);
    expect(nudge?.textContent).toContain('CustomBrandX');
    // Miscased existing brand: no nudge — it resolves canonically.
    await act(async () => {
      setInputValue(el, 'ACANA');
    });
    expect(container.querySelector('[data-testid="brand-combobox-new-nudge"]')).toBeNull();
  });

  it('preserves the prefilled value on mount', async () => {
    await mount('Orijen');
    expect(input().value).toBe('Orijen');
    expect(container.querySelector('[data-testid="brand-combobox-new-nudge"]')).toBeNull();
  });
});
