import React, { useState } from 'react';

export interface VariantCandidateCard {
  variantKey: string;
  title: string;
  available: boolean;
  image?: string | null;
  options?: Array<{ axis: string; value: string }>;
}

export interface ChooseVariantPanelProps {
  candidates: VariantCandidateCard[];
  onSelect: (variantKey: string) => Promise<void>;
  onCancel?: () => void;
}

export function ChooseVariantPanel({ candidates, onSelect, onCancel }: ChooseVariantPanelProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await onSelect(selected);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div role="dialog" aria-label="Choose the matching product" data-testid="choose-variant-panel">
      <h3>Choose the matching product</h3>
      <p>These products look similar. Choose the one that matches the item you are adding.</p>
      <div role="radiogroup" aria-label="Matching products">
        {candidates.map((c) => (
          <label key={c.variantKey} style={{ display: 'block', border: '1px solid #ccc', margin: 8, padding: 8, opacity: c.available ? 1 : 0.5 }}>
            <input
              type="radio"
              name="variant"
              value={c.variantKey}
              checked={selected === c.variantKey}
              onChange={() => setSelected(c.variantKey)}
              disabled={!c.available}
              aria-label={c.title}
            />
            {c.image && <img src={c.image} alt={c.title} width={48} height={48} />}
            <span>{c.title}</span>
            {!c.available && <span> (Not available)</span>}
          </label>
        ))}
      </div>
      {error && <div role="alert">{error}</div>}
      <button type="button" onClick={submit} disabled={!selected || saving} aria-label="Use this match">
        {saving ? 'Saving…' : 'Use this match'}
      </button>
      {onCancel && <button onClick={onCancel}>Cancel</button>}
    </div>
  );
}
export default ChooseVariantPanel;
