/**
 * BrandCombobox — typeahead brand input over the existing brand_sites +
 * catalog brand pool (see `brand-combobox-logic.ts`).
 *
 * Operate-mode refinement of the incumbent plain text brand inputs: same
 * size, same tokens, same controlled `value`/`onChange` contract — plus a
 * suggestion listbox (case-insensitive, keyboard navigable) and a
 * non-blocking "Create new brand X?" nudge for genuinely new brands.
 *
 * Submission contract: `onCommit(nextValue)` always receives the value to
 * submit. Picking a suggestion (mouse or Enter on the highlight) commits
 * its canonical stored spelling; plain Enter commits the current input
 * (callers canonicalize exact-but-miscased entries via
 * `resolveCanonicalBrand`). Free entry is never blocked: the nudge is
 * advisory (`role="status"`), errors keep `role="alert"`.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { colors, fonts, rounded } from '../../theme';
import {
  filterBrandOptions,
  isNewBrandValue,
  resolveCanonicalBrand,
} from './brand-combobox-logic';

export interface BrandComboboxProps {
  /** Controlled input value (prefill preserved: draft ?? server brand). */
  value: string;
  onChange: (value: string) => void;
  /** Submit path — receives the canonical spelling when a suggestion is picked. */
  onCommit: (value: string) => void;
  /** Canonical option pool (brand_sites spellings first). */
  options: string[];
  disabled?: boolean;
  ariaLabel: string;
  placeholder?: string;
  /** Forwarded to the inner input (preserves incumbent testids). */
  inputTestId?: string;
  /** Incumbent input styling passthrough (keeps the three usages identical). */
  inputStyle?: React.CSSProperties;
}

export function BrandCombobox({
  value,
  onChange,
  onCommit,
  options,
  disabled,
  ariaLabel,
  placeholder,
  inputTestId,
  inputStyle,
}: BrandComboboxProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);

  const suggestions = filterBrandOptions(options, value);
  const showNudge = !disabled && isNewBrandValue(value, options);
  const trimmed = value.trim();

  // Highlight tracks the current suggestion list; stale indexes never leak
  // across keystrokes or option reloads.
  useEffect(() => {
    setHighlight(0);
  }, [value, options]);

  // Close on outside pointer contact (blur alone would swallow suggestion
  // clicks before they land; clicks select via onMouseDown regardless).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open ]);

  const pick = (canonical: string) => {
    setOpen(false);
    onChange(canonical);
    onCommit(canonical);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!suggestions.length) return;
      e.preventDefault();
      setOpen(true);
      setHighlight((prev) => {
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        return (prev + delta + suggestions.length) % suggestions.length;
      });
      return;
    }
    if (e.key === 'Enter') {
      // Highlighted suggestion wins: Enter picks it AND submits its
      // canonical spelling in one keypress (Enter-to-submit preserved).
      if (open && suggestions.length > 0) {
        e.preventDefault();
        pick(suggestions[Math.min(highlight, suggestions.length - 1)]);
        return;
      }
      onCommit(value);
      return;
    }
    if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input
        type="text"
        role="combobox"
        aria-expanded={open && suggestions.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && suggestions.length > 0
            ? `${listId}-option-${Math.min(highlight, suggestions.length - 1)}`
            : undefined
        }
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        placeholder={placeholder}
        data-testid={inputTestId}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          if (filterBrandOptions(options, value).length > 0) setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={handleKeyDown}
        style={inputStyle}
      />
      {open && suggestions.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching brands"
          data-testid="brand-combobox-listbox"
          style={{
            position: 'absolute',
            zIndex: 20,
            top: '100%',
            left: 0,
            right: 0,
            margin: '2px 0 0 0',
            padding: 4,
            listStyle: 'none',
            backgroundColor: colors.whiteSurface,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: rounded.md,
            boxShadow: '0 8px 24px rgba(20, 83, 45, 0.14)',
            maxHeight: 192,
            overflowY: 'auto',
            fontFamily: fonts.body,
          }}
        >
          {suggestions.map((option, index) => {
            const active = index === Math.min(highlight, suggestions.length - 1);
            return (
              <li
                key={option.toLowerCase()}
                id={`${listId}-option-${index}`}
                role="option"
                aria-selected={active}
                data-testid="brand-combobox-option"
                data-active={active ? 'true' : undefined}
                onMouseDown={(e) => {
                  // Fire before input blur closes the list.
                  e.preventDefault();
                  pick(option);
                }}
                style={{
                  padding: '6px 8px',
                  borderRadius: rounded.md,
                  fontSize: '0.8125rem',
                  color: colors.ledgerCharcoal,
                  backgroundColor: active ? '#e8f3ec' : 'transparent',
                  fontWeight: active ? 600 : 400,
                  cursor: 'pointer',
                }}
              >
                {option}
              </li>
            );
          })}
        </ul>
      )}
      {showNudge && (
        <span
          role="status"
          data-testid="brand-combobox-new-nudge"
          style={{
            display: 'block',
            marginTop: 4,
            fontSize: '0.75rem',
            color: colors.mulchBrown,
            fontFamily: fonts.body,
          }}
        >
          Create new brand &ldquo;{trimmed}&rdquo;? No existing brand matches — assigning will
          create it. Pick a suggestion above to use an existing brand instead.
        </span>
      )}
    </div>
  );
}

/**
 * Canonicalize a brand value against loaded options before submission, so
 * assignments hit brand_sites keys exactly. Pure re-export for call sites
 * that submit without passing through suggestion pick (button clicks).
 */
export { resolveCanonicalBrand };
