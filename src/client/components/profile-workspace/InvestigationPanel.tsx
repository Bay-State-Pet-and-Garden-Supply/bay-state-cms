// #238 — Profile Workspace browser-investigation operator UI.
//
// Operator launch / watch / cancel, representative selection with visible
// holdout coverage and budgets, evidence-rich per-investigation results,
// proposal preview with stored validation, and separate Validate, Apply to
// Draft, and Discard actions — built against the server-authoritative apply
// contract (`{ actor }` only, #234) and the existing
// investigate/validate/apply/discard/status/workspace/drift-context/preview
// routes. No new server routes. Forms shape bodies through
// investigation-contracts so the operator never touches API payloads, and
// this view offers no automatic step beyond the three explicit actions.
//
// Holdout discipline: reserved holdouts render as reserved and are excluded
// from launch candidates, so blind-holdout material is never exposed to the
// investigator through this UI. Validate entries carry reserved URLs as
// holdouts (every reserved holdout must run — the server rejects drops).
//
// This file is the composition only: state and actions live in
// `investigation-panel-controller.ts`, presentation in
// `investigation-panel-launch-parts.tsx` /
// `investigation-panel-detail-parts.tsx`, and shared primitives in
// `investigation-panel-primitives.tsx`.

import React from 'react';
import { colors, rounded } from '../../theme';
import { useInvestigationPanel } from './investigation-panel-controller';
import { InvestigationHeaderBar, InvestigationLaunchCard, InvestigationListCard } from './investigation-panel-launch-parts';
import { InvestigationDetailCard } from './investigation-panel-detail-parts';

export function InvestigationPanel({
  domain,
  suiteUrls,
}: {
  domain: string;
  suiteUrls: string[];
}): React.ReactElement {
  const controller = useInvestigationPanel(domain, suiteUrls);
  return (
    <div
      style={{
        background: colors.whiteSurface,
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.lg,
        boxShadow: '0 1px 4px rgba(33,20,20,0.06)',
        overflow: 'hidden',
      }}
    >
      <InvestigationHeaderBar
        count={controller.list.investigations.length}
        collapsed={controller.collapsed}
        onToggle={controller.toggleCollapsed}
      />
      {!controller.collapsed && (
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <InvestigationLaunchCard controller={controller} />
          <InvestigationListCard controller={controller} />
          <InvestigationDetailCard controller={controller} />
        </div>
      )}
    </div>
  );
}
