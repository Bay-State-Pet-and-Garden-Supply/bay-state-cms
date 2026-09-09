/**
 * Epic #46 — Family readiness card (Phase 5).
 *
 * One card per candidate family: readiness fraction, per-member state, and
 * the deep-link list of siblings the family is waiting on / that are
 * blocked. There is deliberately NO manual "Curate family" control — the
 * family waits for all active members per ADR 0013.
 */
import React from 'react';
import type { FamilyCard, FamilyMemberRow, FamilyActionItem } from './family-logic';
import { readinessText } from './family-logic';

interface FamilyReadinessCardProps {
  card: FamilyCard;
  /** Deep-link opener for a blocking sibling's Needs Attention task. */
  onOpenItem?: (itemId: string) => void;
}

function MemberStateBadge({ member }: { member: FamilyMemberRow }) {
  const label = member.state === 'ready' ? 'Ready' : member.state === 'blocked' ? 'Blocked' : 'Waiting';
  const className =
    member.state === 'ready' ? 'fw-state-ready' : member.state === 'blocked' ? 'fw-state-blocked' : 'fw-state-waiting';
  return <span className={`fw-state-badge ${className}`}>{label}</span>;
}

function ActionItemRow({
  action,
  onOpenItem,
}: {
  action: FamilyActionItem;
  onOpenItem?: (itemId: string) => void;
}) {
  return (
    <li className="fw-action-item">
      <div className="fw-action-identity">
        <p className="fw-action-name" title={action.name}>{action.name}</p>
        {action.upc ? <span className="fw-member-upc">{action.upc}</span> : null}
        {action.kind === 'blocked' && action.reason ? (
          <p className="fw-action-reason">{action.reason}</p>
        ) : null}
      </div>
      {action.actionable ? (
        <button
          type="button"
          className="fw-view-button"
          onClick={() => onOpenItem?.(action.itemId)}
          title={`Open ${action.kind === 'blocked' ? 'the blocked' : 'the waiting'} item for this family`}
        >
          View {action.kind === 'blocked' ? 'blocker' : 'item'}
        </button>
      ) : (
        <span className="fw-pending-note" role="note">
          ⏳ Still processing — will unblock automatically
        </span>
      )}
    </li>
  );
}

export function FamilyReadinessCard({ card, onOpenItem }: FamilyReadinessCardProps) {
  const progressPct = card.memberCount > 0 ? Math.round((card.readyCount / card.memberCount) * 100) : 0;
  return (
    <section
      className={`fw-card${card.blocked ? ' fw-card-blocked' : ''}`}
      aria-label={`Family ${card.label}`}
    >
      <header className="fw-card-header">
        <h3 className="fw-card-title">{card.label}</h3>
        <span className={`fw-fraction${card.blocked ? ' fw-fraction-blocked' : ''}`}>
          {readinessText(card.memberCount, card.readyCount)}
        </span>
      </header>
      <div className="fw-card-body">
        <div className="fw-progress" aria-hidden="true">
          <div
            className={`fw-progress-fill${card.blocked ? ' fw-progress-fill-blocked' : ''}`}
            style={{ transform: `scaleX(${Math.max(0, Math.min(100, progressPct)) / 100})` }}
          />
        </div>

        <ul style={{ listStyle: 'none', margin: '0.625rem 0 0 0', padding: 0 }} className="fw-members">
          {card.members.map((member) => (
            <li key={member.itemId} className="fw-member">
              <div className="fw-member-identity">
                <p className="fw-member-name" title={member.name}>{member.name}</p>
                <span className="fw-member-upc">{member.upc}</span>
              </div>
              <MemberStateBadge member={member} />
            </li>
          ))}
        </ul>

        {card.blocked ? (
          <p className="fw-action-reason" style={{ marginTop: '0.5rem' }}>
            {card.blockedReason ?? 'A member is blocked in an earlier stage.'}
          </p>
        ) : null}

        {card.actionItems.length > 0 ? (
          <div className="fw-waiting-section">
            <p className="fw-waiting-title">
              {card.blocked ? 'Blocking members' : 'Waiting on'}
            </p>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {card.actionItems.map((action) => (
                <ActionItemRow key={action.itemId} action={action} onOpenItem={onOpenItem} />
              ))}
            </ul>
            <p className="fw-empty-copy" style={{ marginTop: '0.5rem' }}>
              This family waits until every member is extraction-ready — no partial-family Curation.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
