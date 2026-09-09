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
 * its canonical stored spelling; picking the explicit "Create new brand X"
 * option (rendered whenever the typed value matches nothing) commits the
 * trimmed free entry; plain Enter with a closed list commits the current
 * input (callers canonicalize exact-but-miscased entries via
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
  /** Whether a commit mutation is in progress. */
  saving?: boolean;
  /** Automatically commit on blur if value has changed. Defaults to true. */
  commitOnBlur?: boolean;
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
  saving,
  commitOnBlur = true,
  ariaLabel,
  placeholder,
  inputTestId,
  inputStyle,
}: BrandComboboxProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const initialFocusValueRef = useRef<string>(value);

  const suggestions = filterBrandOptions(options, value);
  const showNudge = !disabled && isNewBrandValue(value, options);
  const trimmed = value.trim();
  // Explicit create affordance: when the typed value matches nothing
  // existing, offer "Create new brand X" as a real listbox option (mouse
  // + Arrow/Enter navigable) so creation is a visible choice instead of
  // an implied side effect of the Assign button.
  const showCreate = showNudge;
  const totalOptions = suggestions.length + (showCreate ? 1 : 0);
  const listOpen = open && totalOptions > 0;

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
    initialFocusValueRef.current = canonical;
    onChange(canonical);
    onCommit(canonical);
  };

  const pickCreate = () => {
    setOpen(false);
    initialFocusValueRef.current = trimmed;
    onChange(trimmed);
    onCommit(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!totalOptions) return;
      e.preventDefault();
      setOpen(true);
      setHighlight((prev) => {
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        return (prev + delta + totalOptions) % totalOptions;
      });
      return;
    }
    if (e.key === 'Enter') {
      // Highlighted row wins: a suggestion commits its canonical spelling,
      // the Create row commits the trimmed free entry — all in one
      // keypress (Enter-to-submit preserved).
      if (open && totalOptions > 0) {
        e.preventDefault();
        const idx = Math.min(highlight, totalOptions - 1);
        if (idx < suggestions.length) pick(suggestions[idx]);
        else pickCreate();
        return;
      }
      const trimmedVal = value.trim();
      if (trimmedVal) {
        initialFocusValueRef.current = trimmedVal;
        onCommit(trimmedVal);
      }
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
        aria-expanded={listOpen}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          listOpen
            ? `${listId}-option-${Math.min(highlight, totalOptions - 1)}`
            : undefined
        }
        value={value}
        disabled={disabled || saving}
        aria-label={ariaLabel}
        placeholder={placeholder}
        data-testid={inputTestId}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          initialFocusValueRef.current = value;
          if (
            filterBrandOptions(options, value).length > 0 ||
            (!disabled && !saving && isNewBrandValue(value, options))
          ) {
            setOpen(true);
          }
        }}
        onBlur={(e) => {
          setOpen(false);
          if (commitOnBlur && !disabled && !saving) {
            const currentVal = (e.target.value ?? value).trim();
            if (currentVal && currentVal !== initialFocusValueRef.current?.trim()) {
              initialFocusValueRef.current = currentVal;
              onCommit(currentVal);
            }
          }
        }}
        onKeyDown={handleKeyDown}
        style={inputStyle}
      />
      {saving && (
        <span
          role="status"
          aria-label="Saving brand"
          data-testid="brand-combobox-saving"
          style={{
            position: 'absolute',
            right: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            fontSize: '0.6875rem',
            fontWeight: 600,
            color: colors.uniformGreen,
            backgroundColor: '#e8f3ec',
            padding: '1px 6px',
            borderRadius: rounded.sm,
            pointerEvents: 'none',
          }}
        >
          Saving…
        </span>
      )}
      {listOpen && (
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
            const active = index === Math.min(highlight, totalOptions - 1);
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
          {showCreate && (
            <li
              id={`${listId}-option-create`}
              role="option"
              aria-selected={Math.min(highlight, totalOptions - 1) === suggestions.length}
              data-testid="brand-combobox-create-option"
              data-active={Math.min(highlight, totalOptions - 1) === suggestions.length ? 'true' : undefined}
              onMouseDown={(e) => {
                // Fire before input blur closes the list.
                e.preventDefault();
                pickCreate();
              }}
              style={{
                padding: '6px 8px',
                borderRadius: rounded.md,
                fontSize: '0.8125rem',
                color: colors.uniformGreen,
                backgroundColor:
                  Math.min(highlight, totalOptions - 1) === suggestions.length ? '#e8f3ec' : 'transparent',
                fontWeight: 600,
                cursor: 'pointer',
                borderTop: `1px dashed ${colors.cardBorder}`,
                marginTop: 2,
              }}
            >
              + Create new brand &ldquo;{trimmed}&rdquo;
            </li>
          )}
        </ul>
      )}
      {showNudge && (
        <span
          role="status"
          data-testid="brand-combobox-new-nudge"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            marginTop: 4,
            padding: '1px 6px',
            fontSize: '0.6875rem',
            fontWeight: 500,
            color: colors.uniformGreen,
            backgroundColor: '#f0fdf4',
            border: '1px solid #bbf7d0',
            borderRadius: rounded.sm,
            lineHeight: 1.3,
            fontFamily: fonts.body,
          }}
        >
          + Create new brand &ldquo;{trimmed}&rdquo;
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
