// #238 — presentational parts for the browser-investigation panel.
//
// Each part is a small, pure view over controller state: the launch card,
// the investigation list, the selected-investigation detail (coverage,
// evidence, proposal) and the three separate action cards. No part calls the
// server, performs a state change, or offers an automatic step — the
// controller owns every action, and Apply/Discard/Validate stay separate.

import React from 'react';
import { colors, fonts, rounded } from '../../theme';
import type { BudgetRow } from '../../investigation-api';
import type { InvestigationDriftContextView, InvestigationWorkspaceView } from './investigation-contracts';
import type { InvestigationPanelController } from './investigation-panel-controller';
import {
  AlertBox,
  BudgetRows,
  DetailLine,
  Disclosure,
  actionCard,
  card,
  fieldLabel,
  ghostButton,
  hint,
  inlineRow,
  mono,
  primaryButton,
  reasonText,
  sectionTitle,
  shortHash,
  shortPath,
  statusColor,
  textInput,
} from './investigation-panel-primitives';

// ─── Header + launch ───────────────────────────────────────────────────────

export function InvestigationHeaderBar({
  count,
  collapsed,
  onToggle,
}: {
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <div
      style={{
        background: colors.uniformGreen,
        color: colors.feedBagCream,
        padding: '12px 18px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 12,
        cursor: 'pointer',
        userSelect: 'none',
      }}
      onClick={onToggle}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontFamily: fonts.display, fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          4. Browser Investigation
        </span>
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 11,
            background: count > 0 ? colors.seedlingGreen : colors.shadowPine,
            color: colors.feedBagCream,
            padding: '2px 8px',
            borderRadius: rounded.sm,
            border: '1px solid rgba(250,249,242,0.2)',
          }}
        >
          {count} investigation{count === 1 ? '' : 's'}
        </span>
      </div>
      <span
        style={{
          fontFamily: fonts.body,
          fontSize: 11,
          fontWeight: 700,
          color: colors.feedBagCream,
          background: 'rgba(250,249,242,0.15)',
          padding: '3px 8px',
          borderRadius: rounded.sm,
        }}
      >
        {collapsed ? '▼ Expand' : '▲ Collapse'}
      </span>
    </div>
  );
}

function ReservedBadge(): React.ReactElement {
  return (
    <span
      style={{
        marginLeft: 'auto',
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        padding: '2px 6px',
        borderRadius: rounded.sm,
        background: '#fef3c7',
        color: '#92400e',
        whiteSpace: 'nowrap',
      }}
    >
      Reserved holdout
    </span>
  );
}

function SuiteSampleRow({
  url,
  reserved,
  checked,
  onToggle,
}: {
  url: string;
  reserved: boolean;
  checked: boolean;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 10px',
        background: reserved ? colors.feedBagCream : colors.whiteSurface,
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.sm,
        opacity: reserved ? 0.65 : 1,
        cursor: reserved ? 'not-allowed' : 'pointer',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={reserved}
        onChange={onToggle}
        style={{ accentColor: colors.uniformGreen, width: 15, height: 15 }}
      />
      <span style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.ledgerCharcoal, wordBreak: 'break-all' }}>
        {shortPath(url)}
      </span>
      {reserved && <ReservedBadge />}
    </label>
  );
}

function LaunchSelectionList({
  suiteUrls,
  reservedUrls,
  selected,
  onToggle,
}: {
  suiteUrls: string[];
  reservedUrls: string[];
  selected: string[];
  onToggle: (url: string) => void;
}): React.ReactElement {
  if (suiteUrls.length === 0) {
    return (
      <div style={{ ...hint, marginBottom: 10 }}>
        No confirmed representatives yet — confirm suite samples above, or paste a product URL below.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
      {suiteUrls.map((url) => (
        <SuiteSampleRow
          key={url}
          url={url}
          reserved={reservedUrls.includes(url)}
          checked={selected.includes(url)}
          onToggle={() => onToggle(url)}
        />
      ))}
    </div>
  );
}

function CustomUrlRow({ value, onChange, onAdd }: { value: string; onChange: (v: string) => void; onAdd: () => void }): React.ReactElement {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
      <input
        type="url"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="https://… add a product page URL"
        style={{ ...textInput, flex: 1, padding: '7px 10px', fontFamily: fonts.mono, background: colors.feedBagCream }}
      />
      <button type="button" onClick={onAdd} style={ghostButton}>
        Add URL
      </button>
    </div>
  );
}

function BudgetsBlock({ title, rows }: { title: string; rows: readonly BudgetRow[] }): React.ReactElement {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={fieldLabel}>{title}</div>
      <BudgetRows rows={rows} />
    </div>
  );
}

function DriftPreviewLine({ preview }: { preview: InvestigationDriftContextView }): React.ReactElement {
  if (preview.available !== true) {
    return (
      <div style={{ marginTop: 10, fontSize: 12, color: colors.ledgerCharcoal }}>
        <span style={hint}>Drift entry unavailable: {String(preview.reason ?? 'no baseline')}</span>
      </div>
    );
  }
  const fields = (Array.isArray(preview.affectedFields) ? preview.affectedFields : []) as string[];
  const failures = (Array.isArray(preview.failureCodes) ? preview.failureCodes : []) as string[];
  return (
    <div style={{ marginTop: 10, fontSize: 12, color: colors.ledgerCharcoal }}>
      <span>
        Drift entry ready — last healthy {String(preview.lastHealthyVersionId ?? 'version')}
        {fields.length > 0 ? `, affected: ${fields.join(', ')}` : ''}
        {failures.length > 0 ? `, failures: ${failures.join(', ')}` : ''}
      </span>
    </div>
  );
}

export function InvestigationLaunchCard({ controller }: { controller: InvestigationPanelController }): React.ReactElement {
  const { launch, reservedUrls, suiteUrls } = controller;
  const busy = launch.launching !== null;
  const noSelection = launch.launchSelected.length === 0;
  return (
    <div style={card}>
      <h4 style={sectionTitle}>Launch investigation</h4>
      <div style={{ ...hint, marginBottom: 10 }}>
        Pick up to 5 representative product pages. Reserved holdouts are shown as
        reserved and are never sent to the investigator.
      </div>
      <LaunchSelectionList
        suiteUrls={suiteUrls}
        reservedUrls={reservedUrls}
        selected={launch.launchSelected}
        onToggle={launch.toggleLaunchUrl}
      />
      <CustomUrlRow value={launch.customUrl} onChange={launch.setCustomUrl} onAdd={launch.addCustomUrl} />
      {launch.launchSelected.length > 0 && (
        <div style={{ ...hint, marginBottom: 10 }}>
          Selected {launch.launchSelected.length}/5: {launch.launchSelected.map(shortPath).join(', ')}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => void launch.previewBudgets()} disabled={launch.previewLoading} style={ghostButton}>
          {launch.previewLoading ? 'Previewing…' : 'Preview budgets'}
        </button>
        <button type="button" onClick={() => void launch.checkDriftEntry()} disabled={launch.driftLoading} style={ghostButton}>
          {launch.driftLoading ? 'Checking…' : 'Check drift entry'}
        </button>
        <button
          type="button"
          onClick={() => void launch.launch('domain_onboarding')}
          disabled={busy || noSelection}
          style={primaryButton(busy || noSelection)}
        >
          {launch.launching === 'domain_onboarding' ? 'Launching…' : 'Investigate Domain'}
        </button>
        <button
          type="button"
          onClick={() => void launch.launch('drift_repair')}
          disabled={busy || noSelection}
          style={primaryButton(busy || noSelection)}
        >
          {launch.launching === 'drift_repair' ? 'Launching…' : 'Investigate Drift'}
        </button>
      </div>
      <AlertBox message={launch.launchError} style={{ marginTop: 10 }} />
      <AlertBox message={launch.previewError} style={{ marginTop: 10 }} />
      {launch.budgetRows && launch.budgetRows.length > 0 && <BudgetsBlock title="Budgets" rows={launch.budgetRows} />}
      <AlertBox message={launch.driftError} style={{ marginTop: 10 }} />
      {launch.driftPreview && <DriftPreviewLine preview={launch.driftPreview} />}
    </div>
  );
}

// ─── Investigation list ────────────────────────────────────────────────────

function InvestigationRow({
  id,
  status,
  mode,
  provider,
  selected,
  onSelect,
}: {
  id: string;
  status: string;
  mode: string;
  provider: string;
  selected: boolean;
  onSelect: () => void;
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        background: selected ? 'rgba(22, 132, 77, 0.08)' : colors.feedBagCream,
        border: `1px solid ${selected ? colors.seedlingGreen : colors.cardBorder}`,
        borderRadius: rounded.sm,
      }}
    >
      <span style={{ width: 10, height: 10, borderRadius: '50%', background: statusColor(status), flexShrink: 0 }} />
      <span style={mono}>{id}</span>
      <span style={{ fontSize: 11, color: colors.mulchBrown }}>
        {mode === 'drift_repair' ? 'Drift' : 'Domain'} · {status} · {provider}
      </span>
      <button type="button" onClick={onSelect} style={{ ...ghostButton, marginLeft: 'auto' }}>
        {selected ? 'Selected' : 'Open'}
      </button>
    </div>
  );
}

export function InvestigationListCard({ controller }: { controller: InvestigationPanelController }): React.ReactElement {
  const { list, selectedId, select } = controller;
  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <h4 style={{ ...sectionTitle, margin: 0 }}>Investigations</h4>
        <button type="button" onClick={() => void list.refreshList()} disabled={list.listLoading} style={ghostButton}>
          {list.listLoading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <AlertBox message={list.listError} />
      {list.investigations.length === 0 && !list.listLoading ? (
        <div style={hint}>No investigations for this domain yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {list.investigations.map((investigation) => (
            <InvestigationRow
              key={investigation.id}
              id={investigation.id}
              status={investigation.status}
              mode={investigation.mode}
              provider={investigation.provider}
              selected={selectedId === investigation.id}
              onSelect={() => select(investigation.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
