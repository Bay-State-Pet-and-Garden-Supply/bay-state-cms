/**
 * B3 — shared strategy editing body for Settings → Brands and Stage 1
 * Review strategy. Both surfaces supply brand/context + completion
 * callbacks; every Save emits exactly one combined guarded command.
 *
 * Save is approve: each successful explicit Save immediately produces the
 * next approved revision. Reads, Cancel, and expander toggles never write.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { BrandStrategy } from '../../../shared/schemas/brand-strategy';
import type { SourcingPolicy } from '../../../shared/schemas/onboarding';
import {
  applyProposalToEdit,
  availabilityText,
  buildSavePayload,
  initEditFromApproved,
  rebaseEditOntoLatest,
  sourceKey,
  stageRemoveMapping,
  summarizeEdit,
  toggleIncluded,
  togglePreferred,
  validateEdit,
  type BuilderEdit,
} from './brand-strategy-builder-model';
import { BrandStrategySourcePicker } from './BrandStrategySourcePicker';
import {
  defaultBuilderApi,
  useBrandStrategyBuilder,
  type BuilderApi,
} from './use-brand-strategy-builder';

export interface BrandStrategyBuilderProps {
  /** Exact display brand. Empty + brandEditable for Settings New. */
  brand: string;
  brandEditable?: boolean;
  /** Stage 1 shortcut: enter with the live proposal staged locally (still requires explicit Save). */
  startFromProposal?: boolean;
  api?: BuilderApi;
  onSaved?: (revision: number) => void;
  onCancel?: () => void;
}

function readinessText(strategy: BrandStrategy | null): string {
  if (!strategy) return 'Strategy unavailable.';
  if (!strategy.approval?.approved) return 'Awaiting approval — no approved revision yet.';
  const readiness = strategy.collectionReadiness ?? 'unknown';
  const availability = strategy.sourceAvailability ?? [];
  const usable = availability.filter((s) => s.available).length;
  const revision = `Approved revision ${strategy.approval.revision}`;
  if (readiness === 'setup_attention' || usable === 0) {
    return `${revision} · Setup attention — no usable sources. Saving an unavailable-only set stays selectable but never Ready.`;
  }
  if (readiness === 'ready_partial') return `${revision} · Partial Source Collection (${usable} usable).`;
  if (readiness === 'ready') return `${revision} · Ready (${usable} usable).`;
  return `${revision} · Readiness: ${readiness}.`;
}

export function BrandStrategyBuilder({
  brand,
  brandEditable = false,
  startFromProposal = false,
  api = defaultBuilderApi,
  onSaved,
  onCancel,
}: BrandStrategyBuilderProps) {
  const builder = useBrandStrategyBuilder(brand, api);
  const { strategy, loading, loadError, saving } = builder;
  const [edit, setEdit] = useState<BuilderEdit | null>(null);
  const [brandInput, setBrandInput] = useState(brand);
  const [newDomain, setNewDomain] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [rebasedNote, setRebasedNote] = useState(false);
  const errorRef = useRef<HTMLDivElement | null>(null);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  // Initialize from the approved boundary once the projection arrives.
  // Never overwrite dirty local state on background refresh.
  useEffect(() => {
    if (!loading && !loadError) {
      setEdit((prev) => {
        if (prev) return prev;
        const base = initEditFromApproved(strategy, brandEditable ? '' : brand);
        return startFromProposal ? applyProposalToEdit(base, strategy) : base;
      });
    }
  }, [loading, loadError, strategy, brand, brandEditable, startFromProposal]);

  // Brand switch: reset the local editor (late responses are already
  // guarded by the hook's request ids). Skipped on mount — the hook's own
  // mount effect already issued the initial load.
  const mountedBrand = useRef(false);
  useEffect(() => {
    if (!mountedBrand.current) {
      mountedBrand.current = true;
      setBrandInput(brand);
      return;
    }
    builder.load(brand);
    setEdit(null);
    setBrandInput(brand);
    setConfirmDiscard(false);
    setRebasedNote(false);
  }, [brand]);

  const summary = useMemo(
    () => (edit ? summarizeEdit({ ...edit, brand: brandEditable ? brandInput : edit.brand }, strategy) : null),
    [edit, brandInput, brandEditable, strategy],
  );
  const validation = useMemo(() => (edit ? validateEdit({ ...edit, brand: brandEditable ? brandInput : edit.brand }) : null), [edit, brandInput, brandEditable]);

  useEffect(() => {
    if ((builder.saveError || builder.conflict) && errorRef.current) {
      errorRef.current.focus();
    }
  }, [builder.saveError, builder.conflict]);

  if (loading || !edit) {
    if (loading) return <div style={{ padding: 12, fontSize: 13, color: '#6b7280' }}>Loading strategy…</div>;
    if (loadError) {
      return (
        <div role="alert" style={{ padding: 12, fontSize: 13, color: '#991b1b' }}>
          Could not load the strategy ({loadError}). Refresh to retry — no editor was initialized.
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={() => void builder.refresh()} style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '4px 10px', fontSize: 12, background: '#fff', cursor: 'pointer' }}>
              Refresh
            </button>
          </div>
        </div>
      );
    }
    return null;
  }

  const effectiveEdit: BuilderEdit = brandEditable ? { ...edit, brand: brandInput } : edit;
  const update = (next: BuilderEdit) => {
    setEdit(brandEditable ? { ...next, brand: '' } : next);
    setRebasedNote(false);
  };

  const tokenMissing = !strategy?.configurationToken && !loadError;
  const saveDisabled =
    saving || !validation?.ok || tokenMissing || builder.uncertainOutcome || (!!builder.conflict && !rebasedNote);

  async function handleSave() {
    const payload = buildSavePayload(effectiveEdit);
    if ('error' in payload) return;
    const result = await builder.runSave(payload);
    if (result) onSavedRef.current?.(result.revision);
  }

  function handleCancel() {
    if (summary?.dirty && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    setConfirmDiscard(false);
    onCancel?.();
  }

  function handleRebase() {
    setEdit((prev) => (prev ? { ...rebaseEditOntoLatest(prev, strategy), usedProposal: prev.usedProposal } : prev));
    builder.clearConflict();
    setRebasedNote(true);
  }

  function handleDiscardRemote() {
    const fresh = initEditFromApproved(strategy, brandEditable ? brandInput : brand);
    setEdit(brandEditable ? { ...fresh, brand: '' } : fresh);
    builder.clearConflict();
    setRebasedNote(false);
  }

  const approved = strategy?.approval?.approved === true;
  const proposal = strategy?.proposalSources ?? [];
  const availabilityByRef = new Map(
    (strategy?.sourceAvailability ?? []).map((s) => [`${s.kind}:${s.ref.trim().toLowerCase()}`, s]),
  );
  const usableIncluded = effectiveEdit.included.filter((s) => {
    const hit = availabilityByRef.get(sourceKey(s));
    return hit?.available === true;
  }).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        role="status"
        style={{ fontSize: 12, color: '#374151', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px' }}
      >
        {readinessText(strategy)}
        {strategy?.executionAvailability && !strategy.executionAvailability.enabled && (
          <span style={{ display: 'block', marginTop: 4 }}>
            Collection engine: disabled ({strategy.executionAvailability.reason}) — approval still allowed, readiness stays capped.
          </span>
        )}
        {summary && summary.proposalDiffersFromApproved && approved && (
          <span style={{ display: 'block', marginTop: 4 }}>
            Proposal differs from the approved boundary — the approved set below stays authoritative until you save.
          </span>
        )}
      </div>

      {brandEditable && (
        <label style={{ fontSize: 12, color: '#374151' }}>
          Brand name
          <input
            aria-label="Brand name"
            value={brandInput}
            onChange={(e) => setBrandInput(e.target.value)}
            style={{ width: '100%', marginTop: 4, border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 8px', fontSize: 13 }}
            placeholder="Fromm"
          />
        </label>
      )}

      {tokenMissing ? (
        <div role="alert" style={{ fontSize: 12, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 12px' }}>
          This server response is missing the configuration token — refresh or upgrade before saving. Save is disabled.
        </div>
      ) : (
        <BrandStrategySourcePicker
          options={strategy?.sourceOptions ?? []}
          retainedRefs={strategy?.approvedSources ?? []}
          included={effectiveEdit.included}
          preferredDistributorIds={effectiveEdit.preferredDistributorIds}
          onToggleInclude={(ref) => update(toggleIncluded(effectiveEdit, ref))}
          onTogglePreferred={(id) => update(togglePreferred(effectiveEdit, id))}
          disabled={saving}
        />
      )}

      {proposal.length > 0 && (
        <div style={{ fontSize: 12, color: '#374151' }}>
          <span>Live proposal: {proposal.map((s) => (s.kind === 'official_page' ? s.domain : s.distributorId)).join(', ')}</span>{' '}
          <button
            type="button"
            onClick={() => update(applyProposalToEdit(effectiveEdit, strategy))}
            disabled={saving}
            style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '2px 8px', fontSize: 12, background: '#fff', cursor: 'pointer', marginLeft: 6 }}
          >
            Use current proposal
          </button>
        </div>
      )}

      <fieldset style={{ border: '1px solid #d1d5db', borderRadius: 8, padding: '10px 12px', margin: 0 }}>
        <legend style={{ fontSize: 12, fontWeight: 700, color: '#374151', padding: '0 6px' }}>Official domain mappings</legend>
        <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 8px' }}>
          Adding a domain declares this brand&apos;s official host. Removing a mapping removes only this
          brand&apos;s association (and its selected source) — profiles and other brands are untouched. Nothing
          writes until Save.
        </p>
        {effectiveEdit.officialDomains.length === 0 && (
          <div style={{ fontSize: 12, color: '#6b7280' }}>No official domain mapped — distributor-only strategies are valid.</div>
        )}
        <ul style={{ listStyle: 'none', margin: '0 0 8px', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {effectiveEdit.officialDomains.map((d) => {
            const avail = availabilityByRef.get(`official_page:${d.trim().toLowerCase()}`);
            return (
              <li key={d} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <span style={{ fontWeight: 600, color: '#111827' }}>{d}</span>
                {avail && <span style={{ fontSize: 11, color: '#6b7280' }}>· {availabilityText(avail.available, avail.reason)}</span>}
                <button
                  type="button"
                  aria-label={`Remove mapping for ${d}`}
                  onClick={() => update(stageRemoveMapping(effectiveEdit, d))}
                  disabled={saving}
                  style={{ border: '1px solid #fecaca', borderRadius: 6, padding: '2px 8px', fontSize: 11, background: '#fff', color: '#991b1b', cursor: 'pointer' }}
                >
                  Remove mapping
                </button>
              </li>
            );
          })}
        </ul>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            aria-label="Add official domain"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            placeholder="example.com or https://example.com/shop"
            style={{ flex: 1, border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 8px', fontSize: 13 }}
          />
          <button
            type="button"
            onClick={() => {
              const host = newDomain.trim().toLowerCase();
              if (!host) return;
              if (effectiveEdit.officialDomains.some((d) => d.trim().toLowerCase() === host)) return;
              update({ ...effectiveEdit, officialDomains: [...effectiveEdit.officialDomains, host] });
              setNewDomain('');
            }}
            disabled={saving || !newDomain.trim()}
            style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 10px', fontSize: 12, background: '#fff', cursor: 'pointer' }}
          >
            Stage domain
          </button>
        </div>
      </fieldset>

      <fieldset style={{ border: '1px solid #d1d5db', borderRadius: 8, padding: '10px 12px', margin: 0 }}>
        <legend style={{ fontSize: 12, fontWeight: 700, color: '#374151', padding: '0 6px' }}>Legacy advisory settings</legend>
        <label style={{ fontSize: 12, color: '#374151', display: 'block', marginBottom: 8 }}>
          Aliases (comma-separated, advisory only)
          <input
            aria-label="Aliases"
            value={effectiveEdit.aliases.join(', ')}
            onChange={(e) => update({ ...effectiveEdit, aliases: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })}
            style={{ width: '100%', marginTop: 4, border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 8px', fontSize: 13 }}
          />
        </label>
        <label style={{ fontSize: 12, color: '#374151', display: 'block' }}>
          Sourcing policy (advisory)
          <select
            aria-label="Sourcing policy"
            value={effectiveEdit.sourcingPolicy}
            onChange={(e) => update({ ...effectiveEdit, sourcingPolicy: e.target.value as SourcingPolicy })}
            style={{ width: '100%', marginTop: 4, border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 8px', fontSize: 13 }}
          >
            <option value="advisory">advisory</option>
            <option value="preferred_then_fallback">preferred_then_fallback</option>
            <option value="preferred_only">preferred_only</option>
          </select>
        </label>
      </fieldset>

      {effectiveEdit.included.length === 0 && (
        <div role="note" style={{ fontSize: 12, color: '#92400e' }}>
          No sources selected — select at least one source before saving. Disabled or unavailable sources can still be selected.
        </div>
      )}
      {effectiveEdit.included.length > 0 && usableIncluded === 0 && (
        <div role="note" style={{ fontSize: 12, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 12px' }}>
          None of the selected sources is currently usable — saving will record setup attention, not readiness.
        </div>
      )}

      {validation && !validation.ok && (
        <div role="alert" style={{ fontSize: 12, color: '#991b1b' }}>
          {validation.errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}

      {(builder.saveError || builder.conflict) && (
        <div ref={errorRef} tabIndex={-1} role="alert" style={{ fontSize: 12, color: '#991b1b', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px' }}>
          {builder.conflict ? (
            <div>
              <div style={{ fontWeight: 700 }}>
                {builder.conflict.kind === 'stale_revision' && 'Strategy changed while editing (stale revision).'}
                {builder.conflict.kind === 'stale_configuration' && 'Mappings or settings changed while editing (stale configuration).'}
                {builder.conflict.kind === 'advisory_identity_conflict' && 'Brand identity conflict.'}
                {builder.conflict.kind === 'other' && 'Save failed.'}
              </div>
              <div style={{ marginTop: 4 }}>{builder.conflict.message} Your edits are preserved.</div>
              {builder.conflict.serverRevision != null && (
                <div style={{ marginTop: 4 }}>Current approved revision: {builder.conflict.serverRevision}.</div>
              )}
              {builder.conflict.kind !== 'advisory_identity_conflict' && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={handleDiscardRemote}
                    style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '4px 10px', fontSize: 12, background: '#fff', cursor: 'pointer' }}
                  >
                    Reload latest / discard edits
                  </button>
                  <button
                    type="button"
                    onClick={handleRebase}
                    style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '4px 10px', fontSize: 12, background: '#fff', cursor: 'pointer' }}
                  >
                    Review changes against latest
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div>{builder.saveError}</div>
          )}
          {builder.uncertainOutcome && (
            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                onClick={() => void builder.refresh()}
                style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '4px 10px', fontSize: 12, background: '#fff', cursor: 'pointer' }}
              >
                Refresh to resolve
              </button>
            </div>
          )}
        </div>
      )}

      {rebasedNote && !builder.conflict && (
        <div role="status" style={{ fontSize: 12, color: '#166534' }}>
          Rebased onto the latest revision — review, then save again explicitly.
        </div>
      )}

      {builder.savedRevision != null && (
        <div role="status" style={{ fontSize: 12, color: '#166534' }}>
          Saved revision {builder.savedRevision}; refresh unavailable — duplicate submission disabled.
          {builder.savedNeedsRefresh && ' Refresh the list to see the latest projection.'}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: '#6b7280', marginRight: 'auto' }}>
          Saving approves this strategy immediately for new collection attempts. Active attempts keep their current revision.
        </span>
        {confirmDiscard && <span style={{ fontSize: 12, color: '#92400e' }}>Discard unsaved edits?</span>}
        <button
          type="button"
          onClick={handleCancel}
          style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 14px', fontSize: 13, background: '#fff', cursor: 'pointer' }}
        >
          {confirmDiscard ? 'Discard edits' : 'Cancel'}
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saveDisabled}
          aria-disabled={saveDisabled}
          title={
            builder.uncertainOutcome
              ? 'Refresh first — the previous save outcome is uncertain'
              : !validation?.ok
                ? validation?.errors[0] ?? 'Resolve validation errors'
                : 'Save strategy (approves immediately as a new revision)'
          }
          style={{
            background: '#14532d',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '6px 14px',
            fontSize: 13,
            cursor: saveDisabled ? 'not-allowed' : 'pointer',
            opacity: saveDisabled ? 0.55 : 1,
          }}
        >
          {saving ? 'Saving…' : 'Save strategy'}
        </button>
      </div>
    </div>
  );
}
