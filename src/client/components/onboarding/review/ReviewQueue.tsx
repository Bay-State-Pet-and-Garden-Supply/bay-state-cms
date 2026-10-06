/**
 * Epic #46 — Review queue (Phase 6).
 *
 * High-density product list: review-state icon, primary image thumbnail,
 * curated/imported title, UPC, brand, source chip, family badge, warning
 * badge, reviewed state. Rows are keyboard-accessible (ArrowUp/Down handled
 * by the workspace).
 */
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import type { ReviewQueueRow as ReviewQueueRowType } from '../../../../shared/schemas/onboarding-review-queue';
import type { ItemDetailResponse } from '../../../onboarding-api';
import { distributorApprovedImages, groupQueueItems, isReviewed, itemDisplayName, sourceTypeLabel } from './review-logic';

export interface ReviewQueueProps {
  items: Array<ReviewQueueRowType | OnboardingWorkState>;
  currentItemId: string | null;
  /** Optional enriched detail cache (for backward compatibility). */
  details?: Map<string, ItemDetailResponse>;
  /** Item ids known to carry warnings. */
  warnedIds: Set<string>;
  /** Item ids edited during this session. */
  editedIds: Set<string>;
  /** Bulk-review selection (epic #46 follow-up, phase 4). */
  selectedIds?: Set<string>;
  selectableIds?: Set<string>;
  onToggleSelected?: (itemId: string) => void;
  /** Toggle every visible member of a family group (family header checkbox). */
  onToggleFamilySelected?: (itemIds: string[]) => void;
  emptyMessage: string;
  onSelect: (itemId: string) => void;
}

export function ReviewQueue({
  items,
  currentItemId,
  details,
  warnedIds,
  editedIds,
  selectedIds = new Set(),
  selectableIds,
  onToggleSelected,
  onToggleFamilySelected,
  emptyMessage,
  onSelect,
}: ReviewQueueProps) {
  if (items.length === 0) {
    return <div className="rv-state-note">{emptyMessage}</div>;
  }

  const groups = groupQueueItems(items);

  return (
    <div className="rv-queue-container">
      {groups.map(group => (
        <div key={group.key} className="rv-family-group">
          {group.title && (
            <div className={`rv-family-group-header${group.type === 'individual' ? ' rv-family-group-header--individual' : ''}`}>
              {group.type === 'family' && onToggleFamilySelected && (() => {
                const itemIds = group.items.filter(i => !selectableIds || selectableIds.has(i.itemId)).map(i => i.itemId);
                if (!itemIds.length) return null;
                const selectedCount = itemIds.filter(id => selectedIds.has(id)).length;
                const allSelected = selectedCount === itemIds.length;
                return (
                  <span className="rv-family-group-checkbox" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select all shown products in ${group.title ?? 'this family'} for bulk review`}
                      checked={allSelected}
                      ref={el => {
                        if (el) el.indeterminate = !allSelected && selectedCount > 0;
                      }}
                      onChange={() => onToggleFamilySelected(itemIds)}
                    />
                  </span>
                );
              })()}
              <span className="rv-family-group-title">
                {group.type === 'family' ? '👪' : '📦'} {group.title}
              </span>
              {group.family ? (
                <span className="rv-family-group-count">
                  {group.family.readyCount}/{group.family.memberCount} ready
                </span>
              ) : (
                <span className="rv-family-group-count">
                  {group.items.length} {group.items.length === 1 ? 'item' : 'items'}
                </span>
              )}
            </div>
          )}
          {/* Each group's list is its own listbox so the family header
              (with a focusable checkbox) never sits inside one — ARIA's
              listbox content model only allows option/group children.
              activedescendant is scoped to the listbox that owns the
              current row. */}
          <ul
            className="rv-queue-list"
            role="listbox"
            aria-label={group.title ?? 'Review queue'}
            aria-activedescendant={
              currentItemId && group.items.some(i => i.itemId === currentItemId)
                ? currentItemId
                : undefined
            }
          >
            {group.items.map(item => (
              <ReviewQueueRowItem
                key={item.itemId}
                item={item}
                active={item.itemId === currentItemId}
                detail={details?.get(item.itemId) ?? null}
                warned={'hasWarnings' in item ? Boolean(item.hasWarnings) || warnedIds.has(item.itemId) : warnedIds.has(item.itemId)}
                edited={editedIds.has(item.itemId)}
                selected={onToggleSelected ? selectedIds.has(item.itemId) : false}
                onSelect={onSelect}
                onToggleSelected={!selectableIds || selectableIds.has(item.itemId) ? onToggleSelected : undefined}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ReviewQueueRowItem({
  item,
  active,
  detail,
  warned,
  edited,
  selected,
  onSelect,
  onToggleSelected,
}: {
  item: ReviewQueueRowType | OnboardingWorkState;
  active: boolean;
  detail: ItemDetailResponse | null;
  warned: boolean;
  edited: boolean;
  selected: boolean;
  onSelect: (itemId: string) => void;
  onToggleSelected?: (itemId: string) => void;
}) {
  const ext = detail?.extraction ?? detail?.item.extractionData ?? null;
  const approved = distributorApprovedImages(ext);
  const image =
    item.imageUrl ??
    ext?.primaryImage ??
    approved?.primary ??
    (ext as any)?.distributorImageCandidates?.[0]?.url ??
    null;
  const curatedTitle = detail?.item.curationData?.curatedTitle ?? ('curatedTitle' in item ? (item as any).curatedTitle : null);
  const title = itemDisplayName(item, curatedTitle);
  const brand = item.brand ?? detail?.item.brandHint ?? null;
  const reviewed = isReviewed(item);

  return (
    <li
      id={item.itemId}
      role="option"
      aria-selected={active}
      className={`rv-queue-row${active ? ' rv-row-active' : ''}${selected ? ' rv-row-selected' : ''}${onToggleSelected ? ' rv-row-selectable' : ''}`}
      onClick={() => onSelect(item.itemId)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(item.itemId);
        }
      }}
      tabIndex={active ? 0 : -1}
    >
      {onToggleSelected && (
        <span className="rv-row-checkbox" onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            aria-label={`Select ${title} for bulk review`}
            checked={selected}
            onChange={() => onToggleSelected(item.itemId)}
          />
        </span>
      )}
      <span className={image ? undefined : 'rv-row-thumb rv-no-thumb'}>
        {image ? (
          <img className="rv-row-thumb" src={image} alt="" aria-hidden="true" loading="lazy" />
        ) : (
          <>📦</>
        )}
      </span>

      <span className="rv-row-main">
        <span className="rv-row-title" title={title}>
          {title}
        </span>
        <span className="rv-row-meta">
          <span style={{ fontFamily: 'var(--font-mono)' }}>{item.upc}</span>
          {brand ? <span>{brand}</span> : null}
          {item.family ? (
            <span
              className="rv-badge rv-badge-family"
              title={`${item.family.label ?? 'Family'} — ${item.family.readyCount}/${item.family.memberCount} ready`}
            >
              👪 {item.family.readyCount}/{item.family.memberCount}
            </span>
          ) : null}
        </span>
      </span>

      <span className="rv-row-checks">
        <span
          className={`rv-badge ${reviewed ? 'rv-badge-review' : 'rv-badge-unreviewed'}`}
           title={item.reviewState === 'approved' ? 'Approved' : reviewed ? 'Reviewed' : 'Not yet reviewed'}
        >
           {item.reviewState === 'approved' ? '✓ approved' : reviewed ? '✓ reviewed' : 'unreviewed'}
        </span>
        <span className="rv-row-meta" style={{ justifyContent: 'flex-end' }}>
          <span className="rv-badge rv-badge-source">{sourceTypeLabel(item.sourceType)}</span>
          {warned && <span className="rv-badge rv-badge-warn" title="Warnings present">⚠</span>}
          {edited && <span className="rv-badge rv-badge-warn" title="Edited during review">edit</span>}
        </span>
      </span>
    </li>
  );
}
