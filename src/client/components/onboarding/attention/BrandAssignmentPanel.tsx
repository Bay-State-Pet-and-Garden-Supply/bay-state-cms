/**
 * Batch-level 'Assign Missing Brands' setup queue.
 *
 * Positioned alongside BrandDomainSetupPanel and DomainBlockerPanel at the top of
 * the Needs Attention queue. Elevates unbranded items into grouped, actionable
 * cluster tasks (e.g. "Suggested brand: ACANA — unblocks 22 products").
 *
 * Assigning a brand updates all products in the cluster, clears any hold status,
 * and lets automation proceed to distributor lookups and official site discovery.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { MissingBrandGroup } from '../../../onboarding-api';
import { getMissingBrandGroups, assignBrandGroup } from '../../../onboarding-api';
import './attention.css';

interface BrandAssignmentPanelProps {
  batchId: string;
  onBrandAssigned?: () => void;
}

interface GroupRowState {
  brand: string;
  saving: boolean;
  error: string | null;
}

export function BrandAssignmentPanel({
  batchId,
  onBrandAssigned,
}: BrandAssignmentPanelProps): React.ReactElement | null {
  const [groups, setGroups] = useState<MissingBrandGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, GroupRowState>>({});

  const mounted = useRef(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await getMissingBrandGroups(batchId);
      if (!mounted.current) return;
      setGroups(res.groups);
      setRows((prev) => {
        const next: Record<string, GroupRowState> = {};
        for (const group of res.groups) {
          next[group.key] = prev[group.key] ?? {
            brand: group.suggestedBrand ?? '',
            saving: false,
            error: null,
          };
        }
        return next;
      });
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof Error ? err.message : 'Could not load brand assignment queue');
      }
    }
  }, [batchId]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const updateDraft = useCallback((key: string, brand: string) => {
    setRows((prev) => ({
      ...prev,
      [key]: { ...prev[key], brand, error: null },
    }));
  }, []);

  const handleSave = useCallback(
    async (group: MissingBrandGroup) => {
      const draft = rows[group.key];
      const brandToAssign = (draft?.brand ?? group.suggestedBrand ?? '').trim();
      if (!brandToAssign) {
        setRows((prev) => ({
          ...prev,
          [group.key]: {
            ...prev[group.key],
            saving: false,
            error: 'Enter a brand name first.',
          },
        }));
        return;
      }

      setRows((prev) => ({
        ...prev,
        [group.key]: { ...prev[group.key], saving: true, error: null },
      }));

      try {
        await assignBrandGroup(batchId, group.itemIds, brandToAssign);
        if (!mounted.current) return;
        setRows((prev) => {
          const next = { ...prev };
          delete next[group.key];
          return next;
        });
        await load();
        onBrandAssigned?.();
      } catch (err) {
        if (!mounted.current) return;
        setRows((prev) => ({
          ...prev,
          [group.key]: {
            ...prev[group.key],
            saving: false,
            error: err instanceof Error ? err.message : 'Could not assign brand',
          },
        }));
      }
    },
    [batchId, rows, load, onBrandAssigned],
  );

  if (error) {
    return (
      <div className="attn-error" role="alert" style={{ margin: '0 0 12px' }}>
        {error}
      </div>
    );
  }

  if (!groups || groups.length === 0) return null;

  const totalUnbranded = groups.reduce((acc, g) => acc + g.itemCount, 0);

  return (
    <section className="attn-domain-queue" aria-label="Brand assignment queue">
      <div className="attn-domain-queue-title">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>Assign Missing Brands</strong>
          <span
            style={{
              fontSize: '0.75rem',
              fontWeight: 700,
              color: '#991b1b',
              background: '#fee2e2',
              padding: '2px 8px',
              borderRadius: '9999px',
            }}
          >
            {totalUnbranded} product{totalUnbranded === 1 ? '' : 's'} need a brand
          </span>
        </div>
        <span className="attn-domain-queue-sub">
          Products without brands cannot query distributor catalogs or discover official sites. Assign brands to
          unblock automation for each product cluster.
        </span>
      </div>
      <ul className="attn-domain-queue-list">
        {groups.map((group) => {
          const row = rows[group.key];
          const draft = row?.brand ?? group.suggestedBrand ?? '';
          const saving = row?.saving ?? false;
          const rowError = row?.error ?? null;

          return (
            <li className="attn-domain-queue-row" key={group.key}>
              <div className="attn-domain-queue-main">
                <span className="attn-domain-queue-domain">
                  {group.suggestedBrand ? (
                    <>Suggested: <span style={{ color: '#14532d' }}>{group.suggestedBrand}</span></>
                  ) : (
                    <span style={{ color: '#6b7280', fontStyle: 'italic' }}>Unassigned Brand</span>
                  )}
                </span>
                <span className="attn-domain-queue-count">
                  {group.itemCount} product{group.itemCount === 1 ? '' : 's'}
                </span>
                {group.sampleProductNames.length > 0 && (
                  <span className="attn-domain-queue-samples">
                    e.g. {group.sampleProductNames.join(' · ')}
                  </span>
                )}
                <input
                  type="text"
                  value={draft}
                  placeholder="Enter brand name (e.g. ACANA)"
                  aria-label={`Brand name for cluster ${group.key}`}
                  style={{ minWidth: 200, flex: '1 1 240px' }}
                  onChange={(e) => updateDraft(group.key, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleSave(group);
                  }}
                  disabled={saving}
                />
                {rowError && (
                  <span
                    role="alert"
                    style={{ flexBasis: '100%', fontSize: '0.75rem', color: 'var(--color-danger-text)' }}
                  >
                    {rowError}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => void handleSave(group)}
                disabled={saving || !draft.trim()}
                style={{
                  background: '#14532d',
                  color: '#fff',
                  border: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                {saving ? 'Assigning…' : `Assign all ${group.itemCount}`}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
