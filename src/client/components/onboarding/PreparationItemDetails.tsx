import React, { useEffect, useRef, useState } from 'react';
import type { OnboardingWorkState } from '../../../shared/schemas/onboarding-work-state';
import type { PreparationSummary } from '../../../shared/schemas/onboarding-preparation';
import type { CurationData } from '../../../shared/schemas/onboarding';
import type { CurationCohortView } from '../../../shared/schemas/cohorts';
import type { ClassificationProposal } from '../../../shared/schemas/classification';
import { getBatchCohorts, getItemDetail, type ItemDetailResponse } from '../../onboarding-api';
import { getBatchWorkStateItems } from '../../onboarding-work-api';
import { deriveEvidenceView } from '../../classification-evidence-view';
import { GapCorrectionPanel } from './GapCorrectionPanel';
import { FamilyReadinessCard } from './families/FamilyReadinessCard';
import { buildFamilyCards } from './families/family-logic';
import {
  PREPARE_LISTING_SECTIONS, effectivePreparationFacts, preparationStatusLabel, preparationValue,
} from './prepare-listing-logic';
import './families/families.css';

export interface PreparationItemDetailsProps {
  batchId: string;
  workspaceId?: string;
  item: OnboardingWorkState;
  summary: PreparationSummary;
  stale?: boolean;
  refreshKey?: number;
  onOpenAttentionItem?: (itemId: string) => void;
  onChanged?: () => void;
  onCorrectionDirtyChange?: (dirty: boolean) => void;
}

const DETAIL_LIMIT = 25;

function stateLabel(state: string): string {
  return state === 'unavailable' ? 'Unavailable' : state.replaceAll('_', ' ');
}

function ProposalFacts({ proposals, curation, sku }: { proposals: ClassificationProposal[]; curation: CurationData; sku: string }) {
  const facts = effectivePreparationFacts(curation, sku);
  if (proposals.length === 0) return <p className="bws-muted">No proposal facts are available for the effective run.</p>;
  return <>
    <ul className="bws-preparation-proposals" style={{ paddingLeft: 20 }}>
      {proposals.slice(0, DETAIL_LIMIT).map(proposal => {
        const decision = facts.decisions.find(d => proposal.currentDecisionId ? d.id === proposal.currentDecisionId : d.proposalId === proposal.id);
        const revised = decision?.hasRevisedValue || proposal.hasRevisedValue;
        const effective = decision?.hasRevisedValue ? decision.revisedValue : proposal.hasRevisedValue ? proposal.revisedValue : proposal.proposedValue;
        const revisedTarget = decision?.hasRevisedTargetId || proposal.hasRevisedTargetId;
        const effectiveTarget = decision?.hasRevisedTargetId ? decision.revisedTargetId : proposal.revisedTargetId;
        const citations = deriveEvidenceView({ proposal, evidence: facts.evidence, decision });
        return <li key={proposal.id} style={{ marginBottom: 16 }}>
          <strong>{proposal.targetId ?? proposal.proposalType.replaceAll('_', ' ')}</strong>
          <p style={{ margin: '4px 0' }}>Proposed value: {preparationValue(proposal.proposedValue)}</p>
          {revised && <p style={{ margin: '4px 0' }}>Revised value: {preparationValue(effective)}</p>}
          {revisedTarget && <p style={{ margin: '4px 0' }}>Revised target: {preparationValue(effectiveTarget)}</p>}
          <p style={{ margin: '4px 0' }}>
            {proposal.isStale || proposal.status === 'stale' ? 'Stale proposal' : proposal.status === 'accepted'
              ? 'Accepted assignment — listing approval is separate' : `${stateLabel(proposal.status)} proposal`}
            {decision ? ` · Decision: ${decision.decision} (${decision.decisionOrigin ?? 'origin unavailable'})` : ''}
          </p>
          {proposal.stalenessReason && <p className="bws-muted">{proposal.stalenessReason}</p>}
          {proposal.derivation && <p className="bws-muted">Provenance: {stateLabel(proposal.derivation.kind)}</p>}
          {citations.rows.length > 0 ? <ul aria-label={`Evidence for ${proposal.targetId ?? proposal.proposalType}`}>
            {citations.rows.slice(0, DETAIL_LIMIT).map(citation => <li key={citation.evidenceId}>
              {citation.role === 'missing' ? 'Evidence unavailable for the effective run' : <>
                {stateLabel(citation.source)} · {citation.role} · {citation.reliability ?? 'reliability unavailable'}
                {citation.snippet || citation.value ? `: ${citation.snippet ?? citation.value}` : ''}
              </>}
            </li>)}
          </ul> : <p className="bws-muted">Supporting evidence unavailable.</p>}
          {citations.citation.isUncited && <p className="bws-muted">No citation supplied for this decision.</p>}
        </li>;
      })}
    </ul>
    {proposals.length > DETAIL_LIMIT && <p className="bws-muted">Showing the first {DETAIL_LIMIT} proposals for this product.</p>}
  </>;
}

/** Candidate readiness is separate from both the product's evidence and run outputs. */
function PreparationFamily({ batchId, workspaceId, item, refreshKey, onOpenAttentionItem }: {
  batchId: string; workspaceId?: string; item: OnboardingWorkState; refreshKey: number;
  onOpenAttentionItem?: (itemId: string) => void;
}) {
  const cohortId = item.family!.cohortId;
  const [view, setView] = useState<CurationCohortView | null>(null);
  const [tasks, setTasks] = useState<OnboardingWorkState[]>([]);
  const [taskCursor, setTaskCursor] = useState<string | null>(null);
  const [memberPage, setMemberPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [taskLoading, setTaskLoading] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    let active = true;
    generation.current += 1;
    setLoading(true);
    setError(null);
    setTaskError(null);
    setTasks([]);
    setTaskCursor(null);
    setTaskLoading(false);
    setMemberPage(0);
    void Promise.allSettled([
      getBatchCohorts(batchId),
      getBatchWorkStateItems(batchId, { cohortId, limit: DETAIL_LIMIT }),
    ]).then(([cohorts, work]) => {
      if (!active) return;
      if (cohorts.status === 'rejected' || !Array.isArray(cohorts.value?.cohorts)) {
        setView(null);
        setError('Family membership and readiness are unavailable. Retry family details.');
      } else {
        const candidate = cohorts.value.cohorts.find(v => v?.cohort?.id === cohortId && v.cohort.batchId === batchId
          && (!workspaceId || v.cohort.workspaceId === workspaceId)
          && v.status !== 'superseded' && v.cohort.status !== 'superseded' && !v.cohort.supersededAt
          && Number.isInteger(v.memberCount) && v.memberCount > 0
          && Number.isInteger(v.readyCount) && v.readyCount >= 0 && v.readyCount <= v.memberCount
          && Array.isArray(v.members) && Array.isArray(v.waitingOn)
          && v.members.every(m => m?.item && typeof m.onboardingItemId === 'string'
            && typeof m.item.name === 'string' && typeof m.item.upc === 'string'
            && (m.state === 'ready' || m.state === 'waiting' || m.state === 'blocked'))
          && v.members.some(m => m.onboardingItemId === item.itemId));
        setView(candidate ?? null);
        if (!candidate) setError('The selected product’s current family membership is unavailable or has changed. Refresh preparation.');
      }
      if (work.status === 'fulfilled' && work.value.batchId === batchId && Array.isArray(work.value.items)) {
        setTasks(work.value.items.filter(task => task?.family?.cohortId === cohortId));
        setTaskCursor(work.value.nextCursor ?? null);
        if (work.value.projectionHealth?.status === 'degraded') setTaskError('Current sibling tasks are degraded; readiness comes from the family read.');
      } else setTaskError('Current sibling task details are unavailable. Readiness comes from the family read.');
      setLoading(false);
    });
    return () => { active = false; generation.current += 1; };
  }, [batchId, workspaceId, cohortId, item.itemId, refreshKey, retry]);

  const nextTasks = async () => {
    if (!taskCursor || taskLoading) return;
    const epoch = generation.current;
    setTaskLoading(true);
    try {
      const result = await getBatchWorkStateItems(batchId, { cohortId, limit: DETAIL_LIMIT, cursor: taskCursor });
      if (generation.current !== epoch) return;
      if (result.batchId !== batchId || !Array.isArray(result.items)) throw new Error('Invalid sibling task page');
      // Keep only one task page; the canonical roster remains the membership authority.
      setTasks(result.items.filter(task => task?.family?.cohortId === cohortId));
      setTaskCursor(result.nextCursor ?? null);
      setTaskError(result.projectionHealth?.status === 'degraded' ? 'Current sibling tasks are degraded.' : null);
    } catch {
      if (generation.current === epoch) setTaskError('Could not load the next sibling task page. Try again.');
    } finally {
      if (generation.current === epoch) setTaskLoading(false);
    }
  };

  if (loading) return <p role="status">Loading selected product’s family…</p>;
  if (error || !view) return <div role="alert"><p>{error ?? 'Family details unavailable.'}</p>
    <button type="button" className="btn btn-outline" onClick={() => setRetry(value => value + 1)}>Retry family details</button></div>;
  const categories = new Map(tasks.map(task => [task.itemId, task.category]));
  const card = buildFamilyCards([item], [view], categories)[0];
  const visibleMembers = card.members.slice(memberPage * DETAIL_LIMIT, (memberPage + 1) * DETAIL_LIMIT);
  const visibleIds = new Set(visibleMembers.map(member => member.itemId));
  const taskById = new Map(tasks.map(task => [task.itemId, task]));
  return <div className="bws-preparation-family">
    <p className="bws-muted">Current candidate family readiness (live, not frozen run output). Family context across stages. These members do not change the preparation product count.</p>
    <p>{view.readyCount} ready · {card.waitingCount} still processing · {card.blockedCount} blocked (products)</p>
    {taskError && <p role="status">{taskError}</p>}
    <FamilyReadinessCard card={{ ...card, members: visibleMembers, actionItems: card.actionItems
      .filter(action => visibleIds.has(action.itemId) && action.itemId !== item.itemId)
      .map(action => ({ ...action, reason: taskById.get(action.itemId)?.detail ?? action.reason })) }}
      onOpenItem={onOpenAttentionItem} />
    <ul aria-label="Current family tasks" style={{ paddingLeft: 20 }}>
      {visibleMembers.map(member => {
        const task = taskById.get(member.itemId);
        return <li key={member.itemId}>{member.name}: {task
          ? `${preparationStatusLabel(task.category)} · ${task.label}${task.detail ? ` · ${task.detail}` : ''}`
          : 'Current task unavailable in this read page'}{member.itemId === item.itemId ? ' (selected product)' : ''}</li>;
      })}
    </ul>
    {view.memberCount !== view.members.length && <p role="status">Some member identities are unavailable. Missing facts are not ready products.</p>}
    <nav aria-label="Family member pagination" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      <button type="button" className="btn btn-outline" disabled={memberPage === 0} onClick={() => setMemberPage(value => value - 1)}>Previous family members</button>
      <span>Family member page {memberPage + 1}</span>
      <button type="button" className="btn btn-outline" disabled={(memberPage + 1) * DETAIL_LIMIT >= view.members.length}
        onClick={() => setMemberPage(value => value + 1)}>Next family members</button>
      {taskCursor && <button type="button" className="btn btn-outline" disabled={taskLoading}
        onClick={() => void nextTasks()}>Next sibling task page</button>}
    </nav>
    <p className="bws-muted">The family waits for every active member’s evidence. Routine progression is automatic.</p>
  </div>;
}

export function PreparationItemDetails({ batchId, workspaceId, item, summary, stale = false, refreshKey = 0, onOpenAttentionItem, onChanged, onCorrectionDirtyChange }: PreparationItemDetailsProps) {
  const [read, setRead] = useState<{
    batchId: string; itemId: string; summary: PreparationSummary; refreshKey: number;
    detail: ItemDetailResponse | null; loading: boolean; error: string | null;
  }>({ batchId, itemId: item.itemId, summary, refreshKey, detail: null, loading: true, error: null });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const binding = { batchId, itemId: item.itemId, summary, refreshKey };
    setRead({ ...binding, loading: true, detail: null, error: null });
    void getItemDetail(item.itemId, { signal: controller.signal }).then(result => {
      if (!active) return;
      if (result.item.id !== item.itemId || result.item.batchId !== batchId || result.item.upc !== item.upc) {
        throw new Error('Preparation evidence does not belong to the selected product.');
      }
      setRead({ ...binding, detail: result, loading: false, error: null });
    }).catch(err => {
      if (active) setRead({ ...binding, detail: null, loading: false,
        error: err instanceof Error ? err.message : 'Product evidence unavailable.' });
    });
    return () => { active = false; controller.abort(); };
  }, [batchId, item.itemId, item.upc, summary, refreshKey, retry]);

  const current = read.batchId === batchId && read.itemId === item.itemId && read.summary === summary && read.refreshKey === refreshKey;
  const loading = !current || read.loading;
  const error = current ? read.error : null;
  const boundDetail = current && read.detail?.item.id === item.itemId && read.detail.item.batchId === batchId ? read.detail : null;
  const curation = boundDetail?.item.curationData;
  const extraction = boundDetail?.extraction ?? boundDetail?.item.extractionData;
  const facts = effectivePreparationFacts(curation, item.upc);
  const ocrEvidence = facts.evidence.filter(e => e.source === 'visual_product_evidence');
  const gap = summary.gap;
  return <div className="bws-preparation-details" data-testid={`preparation-details-${item.itemId}`}>
    <header>
      <h3 style={{ margin: '0 0 8px' }}>{item.curatedTitle ?? item.name}</h3>
      <p>{item.upc} · {preparationStatusLabel(item.category)} · {item.label}</p>
      {item.detail && <p>{item.detail}</p>}
      <p className="bws-muted">Review state: {item.reviewState ? stateLabel(item.reviewState) : 'unavailable'}. Preparation proposals and accepted assignments do not approve a listing.</p>
      {loading ? <p role="status">Loading selected product evidence…</p> : <p className="bws-muted" data-testid="preparation-effective-run">
        Effective classification run: {facts.runId ?? 'Unavailable — no validated run reported'}
      </p>}
      {stale && <p role="status">Last reported preparation facts; refresh is pending or unavailable. Correction actions are paused.</p>}
      {error && <div role="alert"><p>{error}</p><button type="button" className="btn btn-outline" onClick={() => setRetry(value => value + 1)}>Retry product evidence</button></div>}
      {item.category === 'needs_attention' && onOpenAttentionItem && <button type="button" className="btn btn-outline"
        disabled={stale} onClick={() => onOpenAttentionItem(item.itemId)}>Open product attention task</button>}
    </header>
    <section aria-label="Listing Evidence Gap" className="bws-preparation-gap" style={{ margin: '24px 0' }}>
      <h4>Listing Evidence Gap</h4>
      {gap === undefined ? <p className="bws-muted">Listing gap state unavailable. No clear result has been reported.</p>
        : gap === null ? <p>No open listing gap reported for this product.</p> : <>
          <p>{gap.reason}</p>
          <p>Missing fields: {gap.missingFields.join(', ')}</p>
          <p>Correction revision {gap.correctionRevision} · {gap.correctionStatus} · Last updated {gap.updatedAt}</p>
          <p className="bws-muted">Recording a correction does not clear the gap. Existing preparation validation must apply it.</p>
          <fieldset disabled={stale || loading || !!error} style={{ border: 0, padding: 0, margin: 0 }}>
            <GapCorrectionPanel key={JSON.stringify([item.itemId, gap.evidenceHash, gap.updatedAt, gap.correctionRevision])}
              itemId={item.itemId} itemName={item.name} onChanged={onChanged} onDirtyChange={onCorrectionDirtyChange} />
          </fieldset>
        </>}
    </section>
    <div className="bws-preparation-detail-groups">
      {PREPARE_LISTING_SECTIONS.map(group => {
        const section = summary.sections.find(s => s.key === group.key)!;
        return <section key={group.key} aria-label={group.title} className="bws-preparation-detail-group"
          data-testid={`prepare-section-${group.key}`} style={{ padding: '16px 0', borderTop: '1px solid var(--color-card-border)' }}>
          <h4 style={{ margin: '0 0 8px' }}>{group.title}</h4>
          <p data-testid={`prepare-section-state-${group.key}`}><strong>{stateLabel(section.state)}</strong>{section.reason ? ` · ${section.reason}` : ''}</p>
          {group.key === 'family_cohort' ? item.family ? <PreparationFamily
            key={JSON.stringify([item.itemId, item.family.cohortId, refreshKey])} batchId={batchId} workspaceId={workspaceId}
            item={item} refreshKey={refreshKey + retry} onOpenAttentionItem={stale ? undefined : onOpenAttentionItem} />
            : <p className="bws-muted">No current family membership reported for this product.</p>
            : loading ? <p className="bws-muted">Loading product-specific facts…</p>
            : error ? <p className="bws-muted">Product-specific facts unavailable.</p> : <>
              {group.key === 'ocr_evidence' && <>
                {ocrEvidence.length > 0 ? <ul aria-label="Effective run packaging evidence">
                  {ocrEvidence.slice(0, DETAIL_LIMIT).map(e => <li key={e.id}>{stateLabel(e.source)} · {e.reliability}: {e.snippet ?? preparationValue(e.value)}</li>)}
                </ul> : <p className="bws-muted">Packaging evidence unavailable for the effective run.</p>}
                {extraction?.ocrOutcome && <p>Collected OCR attempt: {extraction.ocrOutcome.status}{extraction.ocrOutcome.stale ? ' · stale' : ''}
                  {extraction.ocrOutcome.reason ? ` · ${extraction.ocrOutcome.reason}` : ''}</p>}
                {extraction?.packagingOcrData && <>
                  <p className="bws-muted">Retained packaging evidence (not a claim about this run): {extraction.packagingOcrData.productName ?? 'name unavailable'}
                    {extraction.packagingOcrData.metadata?.model ? ` · ${extraction.packagingOcrData.metadata.model}` : ''}</p>
                  <ul>{extraction.packagingOcrData.visibleTextLines.slice(0, DETAIL_LIMIT).map((line, index) => <li key={index}>{line}</li>)}</ul>
                </>}
              </>}
              {group.key === 'names' && <dl>
                <dt>Original product name</dt><dd>{item.name}</dd>
                <dt>Curated name (proposed)</dt><dd>{curation?.curatedTitle ?? item.curatedTitle ?? 'Unavailable'}</dd>
                <dt>Name provenance</dt><dd>{curation?.titleSource ? stateLabel(curation.titleSource) : 'Unavailable'}</dd>
                <dt>Collected title</dt><dd>{extraction?.title ?? 'Unavailable'}</dd>
                <dt>Packaging title</dt><dd>{curation?.packagingOcrTitle ?? extraction?.packagingTitle ?? 'Unavailable'}</dd>
              </dl>}
              {group.key === 'product_type' && <>
                {curation?.effectiveProductType && <p>Effective product type: {curation.effectiveProductType.id ?? 'Unavailable'} · {curation.effectiveProductType.source}
                  {curation.effectiveProductType.source === 'execution' ? ' (frozen execution fallback, not a reviewed assignment)' : ''}</p>}
                {curation ? <ProposalFacts curation={curation} sku={item.upc} proposals={facts.proposals.filter(p => p.proposalType === 'product_classification' || p.proposalType === 'primary_product_type')} />
                  : <p className="bws-muted">Product type facts unavailable.</p>}
              </>}
              {group.key === 'field_classification' && <>
                {curation ? <ProposalFacts curation={curation} sku={item.upc} proposals={facts.proposals.filter(p => p.proposalType !== 'primary_product_type' && p.proposalType !== 'product_classification' && p.proposalType !== 'category_page')} />
                  : <p className="bws-muted">Field classification facts unavailable.</p>}
                <div data-testid="prepare-page-placement-subrow">
                  <h5>Page placement / draft-readiness</h5>
                  {curation ? <>
                    <ProposalFacts curation={curation} sku={item.upc} proposals={facts.proposals.filter(p => p.proposalType === 'category_page')} />
                    <p>Suggested pages: {curation.suggestedPages?.length ? curation.suggestedPages.join(', ') : 'Unavailable'}</p>
                    <p>Page decision: {curation.pageDecisionStatus ? `${curation.pageDecisionStatus.status}${curation.pageDecisionStatus.reason ? ` · ${curation.pageDecisionStatus.reason}` : ''}` : 'Unavailable'}</p>
                  </> : <p className="bws-muted">Page placement facts unavailable.</p>}
                  <p className="bws-muted">Draft readiness unavailable in this preparation read. Stage completion does not establish draft readiness.</p>
                </div>
              </>}
            </>}
        </section>;
      })}
    </div>
  </div>;
}
