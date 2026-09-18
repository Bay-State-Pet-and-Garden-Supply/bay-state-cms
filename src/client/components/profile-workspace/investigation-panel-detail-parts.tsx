// #238 — selected-investigation detail parts: holdout coverage, evidence-rich
// results, proposal + stored validation, and the three separate action cards.
//
// Presentational only: every action is delegated to the controller, nothing
// here activates, releases, or attests, and no verdict is inferred from
// anything but the server's stored state. Each block is a small
// render-null-when-empty component, so the section composition stays flat.

import React from 'react';
import { colors, fonts, rounded } from '../../theme';
import type { BudgetRow } from '../../investigation-api';
import type { InvestigationWorkspaceView, ValidationExpectationField, ValidationSampleEntry } from './investigation-contracts';
import type { InvestigationPanelController } from './investigation-panel-controller';
import {
  AlertBox,
  BudgetRows,
  DetailLine,
  Disclosure,
  actionCard,
  card,
  errorBox,
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

type Usage = {
  modelCalls?: unknown;
  pagesVisited?: unknown;
  readsPerformed?: unknown;
  costDisplay?: string;
};

type Workspace = NonNullable<InvestigationWorkspaceView['evidence']>;
type Structure = { id: string; platformSource?: string };
type Recommendation = { field: string; sources: string[]; evidenceRef?: string };
type StoredSample = { url: string; role: string; status: string; identityOutcome?: string; failureReasons?: string[] };

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

// ─── Coverage ──────────────────────────────────────────────────────────────

function HoldoutStatusLine({ holdouts }: { holdouts: InvestigationWorkspaceView['holdouts'] }): React.ReactElement {
  return (
    <div style={{ fontSize: 12, color: colors.ledgerCharcoal, marginBottom: 4 }}>
      Holdouts — required {holdouts?.required ?? 1}, passed {holdouts?.passed ?? 0},
      validation: {holdouts?.validationStatus ?? 'not_run'}
    </div>
  );
}

function ReservedHoldoutsLine({ reservedUrls }: { reservedUrls: string[] }): React.ReactElement {
  if (reservedUrls.length === 0) return <div style={hint}>No reserved holdouts yet — reserve one before validating.</div>;
  return (
    <div style={{ fontSize: 12, color: colors.ledgerCharcoal }}>
      Reserved ({reservedUrls.length}) — never sent to the investigator:{' '}
      <span style={hint}>{reservedUrls.map(shortPath).join(', ')}</span>
    </div>
  );
}

function CoverageSuggestion({ suggestion }: { suggestion?: { preferred?: unknown; gaps?: unknown } | null }): React.ReactElement | null {
  if (!suggestion) return null;
  const preferred = stringList(suggestion.preferred);
  const gaps = stringList(suggestion.gaps);
  return (
    <div style={{ ...hint, marginTop: 4 }}>
      Coverage suggestion: {preferred.length} preferred{gaps.length > 0 ? `, gaps: ${gaps.join('; ')}` : ', no gaps'}
    </div>
  );
}

function CoverageBudgets({ budgets }: { budgets: BudgetRow[] }): React.ReactElement | null {
  if (budgets.length === 0) return null;
  return (
    <Disclosure title={`Budgets (${budgets.length})`}>
      <BudgetRows rows={budgets} />
    </Disclosure>
  );
}

function HoldoutCoverageBlock({
  workspace,
  reservedUrls,
}: {
  workspace: InvestigationWorkspaceView;
  reservedUrls: string[];
}): React.ReactElement {
  const confirmed = workspace.representatives?.confirmed ?? [];
  const investigated = workspace.representatives?.investigated ?? [];
  const budgets = (workspace.budgets ?? []) as BudgetRow[];
  return (
    <div>
      <div style={fieldLabel}>Representatives &amp; holdout coverage</div>
      <DetailLine label="Confirmed" value={<span style={hint}>({confirmed.length}): {confirmed.map(shortPath).join(', ') || 'none'}</span>} />
      <DetailLine label="Investigated" value={<span style={hint}>({investigated.length}): {investigated.map(shortPath).join(', ') || 'none'}</span>} />
      <HoldoutStatusLine holdouts={workspace.holdouts} />
      <ReservedHoldoutsLine reservedUrls={reservedUrls} />
      <CoverageSuggestion suggestion={workspace.holdouts?.suggestion} />
      <CoverageBudgets budgets={budgets} />
    </div>
  );
}

// ─── Evidence ──────────────────────────────────────────────────────────────

function usageLine(usage?: Usage | null): string {
  if (!usage) return 'unavailable';
  return `${usage.modelCalls ?? '—'} calls · ${usage.pagesVisited ?? '—'} pages · ${usage.readsPerformed ?? '—'} reads`;
}

function EvidenceSummaryGrid({ evidence }: { evidence: Workspace }): React.ReactElement {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8, fontSize: 12 }}>
      <div><span style={hint}>Platform: </span><strong>{evidence.platform ?? 'unknown'}</strong></div>
      <div><span style={hint}>Provider: </span><strong>{evidence.provider ?? '—'}</strong></div>
      <div><span style={hint}>Requested model: </span><strong>{evidence.requestedModel ?? 'unreported'}</strong></div>
      <div><span style={hint}>Acting model: </span><strong>{evidence.actualModel ?? 'unreported'}</strong></div>
      <div><span style={hint}>Usage: </span><strong>{usageLine(evidence.usage)}</strong></div>
      <div><span style={hint}>Cost: </span><strong>{evidence.usage?.costDisplay ?? 'unavailable'}</strong></div>
    </div>
  );
}

function EvidenceStructures({ structures }: { structures: Structure[] }): React.ReactElement | null {
  if (structures.length === 0) return null;
  return (
    <DetailLine
      label={`Structures (${structures.length})`}
      value={structures.map((structure) => (
        <span key={structure.id} style={{ fontFamily: fonts.mono, marginRight: 8 }}>
          {structure.platformSource ? `${structure.id} (${structure.platformSource})` : structure.id}
        </span>
      ))}
    />
  );
}

function FieldRecommendations({ recommendations }: { recommendations: Recommendation[] }): React.ReactElement | null {
  if (recommendations.length === 0) return null;
  return (
    <Disclosure title={`Field recommendations (${recommendations.length})`}>
      {recommendations.map((recommendation) => (
        <div key={recommendation.field} style={{ fontSize: 12 }}>
          <strong>{recommendation.field}</strong>{' '}
          <span style={hint}>
            from {(recommendation.sources ?? []).join(', ')}
            {recommendation.evidenceRef ? ` · ${recommendation.evidenceRef}` : ''}
          </span>
        </div>
      ))}
    </Disclosure>
  );
}

function IdentityLine({ identity }: { identity: NonNullable<Workspace['identity']> }): React.ReactElement {
  const axes = stringList(identity.optionAxes);
  return (
    <DetailLine
      label="Identity — product"
      value={
        <>
          {stringList(identity.productIdentity).join(', ') || 'none'}
          {' · variant: '}
          {stringList(identity.variantIdentity).join(', ') || 'none'}
          {axes.length > 0 ? ` · axes: ${axes.join(', ')}` : ''}
        </>
      }
    />
  );
}

function EvidenceGaps({ gaps }: { gaps: string[] }): React.ReactElement | null {
  if (gaps.length === 0) return null;
  return <DetailLine label={`Gaps (${gaps.length})`} value={gaps.join('; ')} />;
}

function CodeAdapterLine({ adapter }: { adapter: NonNullable<Workspace['codeAdapterNeeded']> }): React.ReactElement {
  return (
    <DetailLine
      label="Code adapter needed"
      value={<><strong>{adapter.capability}</strong> — {adapter.reason}</>}
    />
  );
}

function RenderedBrowserLine({ renderedBrowser }: { renderedBrowser: NonNullable<Workspace['renderedBrowser']> }): React.ReactElement {
  return (
    <DetailLine
      label="Rendered browser"
      value={renderedBrowser.required ? `required — ${renderedBrowser.reason ?? ''}` : 'not required'}
    />
  );
}

function EvidenceRefs({ links }: { links: string[] }): React.ReactElement | null {
  if (links.length === 0) return null;
  return (
    <DetailLine label={`Evidence refs (${links.length})`} value={<span style={{ fontFamily: fonts.mono }}>{links.join(', ')}</span>} />
  );
}

function EvidenceFailure({ failure }: { failure: NonNullable<Workspace['failure']> }): React.ReactElement {
  return (
    <div role="alert" style={{ ...errorBox, marginTop: 6 }}>
      {failure.code}{failure.detail ? `: ${failure.detail}` : ''}
    </div>
  );
}

function EvidenceExtras({ evidence }: { evidence: Workspace }): React.ReactElement {
  const identity = evidence.identity ?? null;
  const adapter = evidence.codeAdapterNeeded ?? null;
  const renderedBrowser = evidence.renderedBrowser ?? null;
  const failure = evidence.failure ?? null;
  return (
    <>
      {identity && <IdentityLine identity={identity} />}
      <EvidenceGaps gaps={stringList(evidence.gaps)} />
      {adapter && <CodeAdapterLine adapter={adapter} />}
      {renderedBrowser && <RenderedBrowserLine renderedBrowser={renderedBrowser} />}
      <EvidenceRefs links={stringList(evidence.evidenceLinks)} />
      {failure && <EvidenceFailure failure={failure} />}
    </>
  );
}

function EvidenceBlock({ workspace }: { workspace: InvestigationWorkspaceView }): React.ReactElement | null {
  const evidence = workspace.evidence;
  if (!evidence) return null;
  return (
    <div>
      <div style={fieldLabel}>Evidence-rich results</div>
      <EvidenceSummaryGrid evidence={evidence} />
      <EvidenceStructures structures={(evidence.structures ?? []) as Structure[]} />
      <FieldRecommendations recommendations={(evidence.fieldRecommendations ?? []) as Recommendation[]} />
      <EvidenceExtras evidence={evidence} />
    </div>
  );
}

// ─── Proposal + stored validation ──────────────────────────────────────────

function ProposalSummary({ proposal }: { proposal: NonNullable<InvestigationWorkspaceView['proposal']> }): React.ReactElement {
  if (proposal.available !== true) {
    return <div style={hint}>No proposal to preview{proposal.reason ? `: ${proposal.reason}` : ''}.</div>;
  }
  const gaps = stringList(proposal.gaps);
  return (
    <div style={{ fontSize: 12, color: colors.ledgerCharcoal }}>
      {proposal.status} · {proposal.structuresCount} structures · {proposal.fieldsCount} fields ·{' '}
      proposal {shortHash(proposal.proposalHash)} · policy {shortHash(proposal.policyHash)}
      {gaps.length > 0 && <span style={hint}> · gaps: {gaps.join('; ')}</span>}
      {proposal.capability && <span style={hint}> · capability: {proposal.capability}</span>}
    </div>
  );
}

function ValidationSampleLine({ sample }: { sample: StoredSample }): React.ReactElement {
  const reasons = stringList(sample.failureReasons);
  return (
    <div style={{ fontSize: 12 }}>
      <span style={{ fontFamily: fonts.mono }}>{shortPath(sample.url)}</span>{' '}
      <span style={hint}>
        {sample.role} · {sample.status}
        {sample.identityOutcome ? ` · ${sample.identityOutcome}` : ''}
      </span>
      {reasons.length > 0 && <span style={hint}> — {reasons.join('; ')}</span>}
    </div>
  );
}

function ValidationSamples({ samples }: { samples: StoredSample[] }): React.ReactElement | null {
  if (samples.length === 0) return null;
  return (
    <Disclosure title={`Samples (${samples.length})`}>
      {samples.map((sample) => (
        <ValidationSampleLine key={`${sample.role}:${sample.url}`} sample={sample} />
      ))}
    </Disclosure>
  );
}

function StoredValidation({ validation }: { validation: NonNullable<InvestigationWorkspaceView['validation']> }): React.ReactElement {
  const blockers = stringList(validation.blockers);
  return (
    <div style={{ fontSize: 12, color: colors.ledgerCharcoal, marginTop: 6 }}>
      Stored validation <strong>{validation.validationId ?? ''}</strong> — status{' '}
      <strong>{validation.status}</strong> · holdouts {validation.holdouts?.passed ?? 0}/{validation.holdouts?.required ?? 1}
      {blockers.length > 0 && <span> · blockers: {blockers.join('; ')}</span>}
      <ValidationSamples samples={(validation.samples ?? []) as StoredSample[]} />
    </div>
  );
}

function ProposalBlock({ workspace }: { workspace: InvestigationWorkspaceView }): React.ReactElement {
  const validation = workspace.validation ?? null;
  return (
    <div>
      <div style={fieldLabel}>Proposal preview &amp; stored validation</div>
      {workspace.proposal ? <ProposalSummary proposal={workspace.proposal} /> : <div style={hint}>No proposal to preview.</div>}
      {validation ? (
        <StoredValidation validation={validation} />
      ) : (
        <div style={{ ...hint, marginTop: 6 }}>No stored validation yet — validate the proposal below.</div>
      )}
    </div>
  );
}

// ─── Actions ───────────────────────────────────────────────────────────────

function availabilityLine(action: { allowed: boolean; reason: string } | undefined | null): string {
  return action ? reasonText(action.allowed, action.reason) : 'Load the workspace to see availability.';
}

function RolePill({ role }: { role: string }): React.ReactElement {
  const holdout = role === 'holdout';
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        padding: '2px 6px',
        borderRadius: rounded.sm,
        background: holdout ? '#fef3c7' : colors.feedBagCream,
        color: holdout ? '#92400e' : colors.mulchBrown,
        whiteSpace: 'nowrap',
      }}
    >
      {role}
    </span>
  );
}

function ExpectationInput({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}): React.ReactElement {
  return (
    <input
      type="text"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      style={{ ...textInput, width: '100%', boxSizing: 'border-box' }}
    />
  );
}

function ValidationSampleRow({
  entry,
  problems,
  onChange,
}: {
  entry: ValidationSampleEntry;
  problems: string[];
  onChange: (field: ValidationExpectationField, value: string) => void;
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 8,
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.sm,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <RolePill role={entry.role} />
        <span
          style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.ledgerCharcoal, minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={entry.url}
        >
          {shortPath(entry.url)}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 6 }}>
        <ExpectationInput value={entry.expectedName} placeholder="Expected product name" onChange={(value) => onChange('expectedName', value)} />
        <ExpectationInput value={entry.expectedProductId} placeholder="Parent product ID" onChange={(value) => onChange('expectedProductId', value)} />
        <ExpectationInput value={entry.expectedGtin} placeholder="GTIN" onChange={(value) => onChange('expectedGtin', value)} />
        <ExpectationInput value={entry.expectedSku} placeholder="SKU" onChange={(value) => onChange('expectedSku', value)} />
        <ExpectationInput value={entry.expectedPlatformVariantId} placeholder="Platform variant ID" onChange={(value) => onChange('expectedPlatformVariantId', value)} />
        <ExpectationInput value={entry.expectedVariantKey} placeholder="Variant key" onChange={(value) => onChange('expectedVariantKey', value)} />
      </div>
      {problems.length > 0 && (
        <div role="alert" style={{ ...hint, color: colors.signetBurgundy, fontWeight: 600 }}>
          {problems.join('; ')}
        </div>
      )}
    </div>
  );
}

function ActionCardShell({
  title,
  availability,
  children,
}: {
  title: string;
  availability: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div style={actionCard}>
      <div style={{ fontSize: 12, fontWeight: 700, color: colors.ledgerCharcoal, marginBottom: 4 }}>{title}</div>
      <div style={{ ...hint, marginBottom: 8 }}>{availability}</div>
      {children}
    </div>
  );
}

function CoverageRefusalHint({ shown }: { shown: boolean }): React.ReactElement | null {
  if (!shown) return null;
  return (
    <div style={{ ...hint, marginBottom: 8 }}>
      Every reserved holdout must run — fill in the trusted identity (parent product ID plus a trusted identifier) for each holdout row.
    </div>
  );
}

function IncompleteIdentityHint({ shown }: { shown: boolean }): React.ReactElement | null {
  if (!shown) return null;
  return (
    <div style={{ ...hint, marginBottom: 8 }}>
      Each sample needs a trusted parent product ID plus at least one trusted identifier (GTIN, SKU, platform variant ID, or variant key) — a name alone never proves identity.
    </div>
  );
}

function ValidationActionCard({ controller }: { controller: InvestigationPanelController }): React.ReactElement {
  const { validation, workspace } = controller;
  const disabled =
    validation.validating || workspace?.actions?.validate.allowed !== true || !validation.allTrusted || !validation.coverageMet;
  return (
    <ActionCardShell title="Validate proposal" availability={availabilityLine(workspace?.actions?.validate)}>
      <div style={{ ...hint, marginBottom: 8 }}>
        Trusted identity per sample — the server rejects name-only samples as untrusted_expectation.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
        {validation.entries.map((entry) => (
          <ValidationSampleRow
            key={`${entry.role}:${entry.url}`}
            entry={entry}
            problems={validation.problemsByKey[`${entry.role}:${entry.url}`] ?? []}
            onChange={(field, value) => validation.setExpectedField(entry, field, value)}
          />
        ))}
      </div>
      <CoverageRefusalHint shown={!validation.coverageMet && controller.reservedUrls.length > 0} />
      <IncompleteIdentityHint shown={!validation.allTrusted} />
      <button type="button" onClick={() => void validation.validate()} disabled={disabled} style={primaryButton(disabled)}>
        {validation.validating ? 'Validating…' : 'Run validation'}
      </button>
      <AlertBox message={validation.validateError} style={{ marginTop: 8 }} />
    </ActionCardShell>
  );
}

function BlockedDraftHint({ status }: { status: string | null }): React.ReactElement | null {
  if (status !== 'failed' && status !== 'incomplete') return null;
  return (
    <div style={{ ...hint, marginBottom: 8 }}>
      Failed or incomplete validation still applies as a blocked draft — blockers stay visible on the draft.
    </div>
  );
}

function ApplyResultLine({ result }: { result: InvestigationPanelController['apply']['result'] }): React.ReactElement | null {
  if (!result) return null;
  const blockers = stringList(result.blockers);
  return (
    <div role="status" style={{ fontSize: 12, color: colors.uniformGreen, marginTop: 8 }}>
      Draft {String(result.appliedVersionId ?? 'created')}
      {blockers.length > 0 ? ` — blockers: ${blockers.join('; ')}` : ' — no blockers'}
    </div>
  );
}

function ApplyActionCard({ controller }: { controller: InvestigationPanelController }): React.ReactElement {
  const { apply, workspace } = controller;
  const disabled = apply.running || workspace?.actions?.apply.allowed !== true || !apply.actor.trim();
  return (
    <ActionCardShell
      title="Apply to Draft"
      availability={`${availabilityLine(workspace?.actions?.apply)} Sends the operator name only — the server binds the stored validation by hash.`}
    >
      <BlockedDraftHint status={workspace?.validation?.status ?? null} />
      <div style={inlineRow}>
        <input
          type="text"
          value={apply.actor}
          onChange={(event) => apply.setActor(event.target.value)}
          placeholder="Operator name"
          style={{ ...textInput, width: 220 }}
        />
        <button type="button" onClick={() => void apply.run()} disabled={disabled} style={primaryButton(disabled)}>
          {apply.running ? 'Applying…' : 'Apply to Draft'}
        </button>
      </div>
      <AlertBox message={apply.error} style={{ marginTop: 8 }} />
      <ApplyResultLine result={apply.result} />
    </ActionCardShell>
  );
}

function DiscardActionCard({ controller }: { controller: InvestigationPanelController }): React.ReactElement {
  const { discard, workspace } = controller;
  const disabled = discard.running || workspace?.actions?.discard.allowed !== true || !discard.actor.trim();
  return (
    <ActionCardShell title="Discard investigation" availability={availabilityLine(workspace?.actions?.discard)}>
      <div style={inlineRow}>
        <input
          type="text"
          value={discard.actor}
          onChange={(event) => discard.setActor(event.target.value)}
          placeholder="Operator name"
          style={{ ...textInput, width: 220 }}
        />
        <button type="button" onClick={() => void discard.run()} disabled={disabled} style={ghostButton}>
          {discard.running ? 'Discarding…' : 'Discard'}
        </button>
      </div>
      <AlertBox message={discard.error} style={{ marginTop: 8 }} />
    </ActionCardShell>
  );
}

// ─── Detail composition ────────────────────────────────────────────────────

function StatusPill({ status }: { status: string }): React.ReactElement {
  return (
    <span
      style={{
        marginLeft: 8,
        fontSize: 11,
        fontWeight: 700,
        padding: '2px 8px',
        borderRadius: rounded.full,
        background: statusColor(status),
        color: colors.feedBagCream,
      }}
    >
      {status}
    </span>
  );
}

function CancelButton({ controller }: { controller: InvestigationPanelController }): React.ReactElement | null {
  if (!controller.isActive) return null;
  const cancelling = controller.launch.cancelling;
  return (
    <button
      type="button"
      onClick={() => void controller.launch.cancel()}
      disabled={cancelling}
      style={primaryButton(cancelling)}
    >
      {cancelling ? 'Cancelling…' : 'Cancel investigation'}
    </button>
  );
}

function DetailBody({ controller }: { controller: InvestigationPanelController }): React.ReactElement | null {
  const workspace = controller.workspace;
  if (!workspace) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <HoldoutCoverageBlock workspace={workspace} reservedUrls={controller.reservedUrls} />
      <EvidenceBlock workspace={workspace} />
      <ProposalBlock workspace={workspace} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <ValidationActionCard controller={controller} />
        <ApplyActionCard controller={controller} />
        <DiscardActionCard controller={controller} />
      </div>
    </div>
  );
}

export function InvestigationDetailCard({ controller }: { controller: InvestigationPanelController }): React.ReactElement | null {
  const { selectedId, selectedStatus, wsLoading, wsError } = controller;
  if (!selectedId) return null;
  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
        <h4 style={{ ...sectionTitle, margin: 0 }}>
          Investigation {selectedId}
          {selectedStatus && <StatusPill status={selectedStatus} />}
        </h4>
        <CancelButton controller={controller} />
      </div>
      {wsLoading && !controller.workspace && <div style={hint}>Loading investigation…</div>}
      <AlertBox message={wsError} />
      <DetailBody controller={controller} />
    </div>
  );
}
