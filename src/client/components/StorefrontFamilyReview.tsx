import { useEffect, useState } from 'react';
import { getApiAuthHeaders } from '../api';

/**
 * Storefront family review (issues #368 food, #372 non-food): operator
 * comparison table for one NEW family plan — members, origins
 * (SKU-local evidence), rule-resolved invariants vs permitted axes, labels
 * (PF7 proposals with preserved-vs-generated disposition), native
 * Subproducts diffs, and blockers — with accept / revise / reject / defer
 * actions. A deferred or rejected unapplied proposal leaves the standalone
 * listing releasable (no Cohort barrier); accepting requires the complete
 * validated set at apply. No Curation Cohort migration or accessory-group
 * reinterpretation happens here — review covers the explicit plan only.
 *
 * Mount: rendered by ChangeSetReview (the Review surface) when a family
 * plan is selected — the plan list sits beside the change-set list because
 * apply creates a linked change set. Requires an operator actor handle.
 */

interface FamilyPlanPayload {
  row: {
    id: string;
    status: string;
    revision: number;
    linkedChangeSetId: string | null;
    createdAt: string;
    updatedAt: string;
  };
  /** Live PF7 labels keyed by SKU (served by GET detail for new-family plans). */
  liveLabels?: Record<string, string | null>;
  /** Staged PF7 originals keyed by SKU (snapshot at stage time). */
  stagedLabels?: Record<string, string | null>;
  plan: {
    id: string;
    ruleVersion: string;
    status: string;
    revision: number;
    memberSkus: string[];
    members: Array<{
      sku: string;
      comparableOunces: number | null;
      sizeRaw: string | null;
      reviewedTypeHash: string;
      evidenceHash: string;
      baseHash: string | null;
      productTypeId?: string | null;
      model?: string | null;
      material?: string | null;
      function?: string | null;
      safetyDose?: string | null;
      strength?: string | null;
      fit?: string | null;
      colorRaw?: string | null;
      countRaw?: string | null;
      countQuantity?: number | null;
      stagedLabel?: string | null;
    }>;
    mainSku: string;
    mainOverridden: boolean;
    pf7Proposals: Array<{ sku: string; shortName: string; replaced?: boolean }>;
    ruleHash: string;
    evidenceHash: string;
    baseHash: string;
    readHash: string;
    writeHash: string;
    linkedChangeSetId: string | null;
    decisions: Array<{ actor: string; action: string; at: string; note: string | null; mainOverrideSku: string | null }>;
    adoptionOrigin?: { kind: string; nativeMain: string; nativeOrder: string[] } | null;
    membershipChange?: { kind: string; removedSkus: string[]; remainingSkus: string[]; at: string; actor: string } | null;
    joinOrigin?: {
      kind: string;
      familyPlanId: string;
      familyMain: string;
      familyOrder: string[];
      joinedSkus: string[];
      rejectedFamilies: Array<{ planId: string; revision: number; ruleVersion: string; memberSkus: string[] }>;
    } | null;
  };
  joinReview?: {
    joinOrigin: {
      familyPlanId: string;
      familyMain: string;
      familyOrder: string[];
      joinedSkus: string[];
      rejectedFamilies: Array<{ planId: string; revision: number; ruleVersion: string; memberSkus: string[] }>;
    };
    membership: Array<{ sku: string; origin: 'catalog' | 'import'; baseHash: string | null; reviewedTypeHash: string; evidenceHash: string }>;
    invariantEvidence: Array<{ axis: string; value: string | null; agreed: boolean }>;
    varyingAxes: Array<{ sku: string; sizeRaw: string; ounces: number | null; colorRaw?: string | null; countRaw?: string | null; countQuantity?: number | null }>;
    pf7BeforeAfter: Array<{ sku: string; before: string; after: string; replaced: boolean }>;
    nativeDiffs: Array<{ sku: string; beforeRefs: string[]; afterRefs: string[]; operation: 'create' | 'update' }>;
    readDependencies: string[];
    writeSet: Array<{ sku: string; operation: 'create' | 'update' }>;
    blockers: string[];
    membershipProposal?: {
      proposalId: string;
      outcome: string;
      status: string;
      judgments: Array<{ anchorSku: string; familyPlanId: string | null; outcome: string; reason: string }>;
      modelCallIds: string[];
      stale: boolean;
      staleReasons: string[];
    } | null;
  } | null;
  joinReviewError?: string;
}

interface MembershipProposalPayload {
  id: string;
  sku: string;
  outcome: string;
  status: string;
  revision: number;
  linkedPlanId: string | null;
  judgments: Array<{ anchorSku: string; familyPlanId: string | null; outcome: string; reason: string }>;
  modelCallIds: string[];
  stale: boolean;
  staleReasons: string[];
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

interface ApiErrorBody {
  error?: string;
}

interface AdoptionPreviewPayload {
  relationship: {
    mainSku: string;
    memberSkus: string[];
    order: string[];
    existingLabels: Array<{ sku: string; pf7: string }>;
    supportedMetadata: Array<{ sku: string; price: string | null; childName: string | null }>;
    invariantEvidence: Array<{ axis: string; value: string | null; agreed: boolean }>;
    rawBlock: string;
    readHash: string;
    baseHash: string;
  };
  support: { code: string; detail: string };
  pf7Disposition: Array<{ sku: string; existing: string; proposed: string; replaced: boolean }>;
  blockers: string[];
  ruleHash: string;
  evidenceHash: string;
  baseHash: string;
  readHash: string;
  writeHash: string;
}

function apiErrorMessage(data: unknown, fallback: string): string {
  if (data !== null && typeof data === 'object' && 'error' in data) {
    const body: ApiErrorBody = data as ApiErrorBody;
    if (typeof body.error === 'string' && body.error.length > 0) return body.error;
  }
  return fallback;
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...getApiAuthHeaders(), ...(options?.headers || {}) },
  });
  const data: unknown = await res.json();
  if (!res.ok) throw new Error(apiErrorMessage(data, `HTTP ${res.status}`));
  return data as T;
}

export function StorefrontFamilyReview({ planId, actor }: { planId: string; actor: string }) {
  const [payload, setPayload] = useState<FamilyPlanPayload | null>(null);
  const [preview, setPreview] = useState<AdoptionPreviewPayload | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [discoverSku, setDiscoverSku] = useState('');
  const [discoverResult, setDiscoverResult] = useState<{
    candidates: Array<{ sku: string; familyPlanId: string | null; familyMain: string | null; signals: string[]; matchedOn: string[] }>;
    ambiguous: boolean;
    reasons: string[];
  } | null>(null);
  const [discoverError, setDiscoverError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [mainOverride, setMainOverride] = useState('');
  const [removeSkus, setRemoveSkus] = useState('');

  const [proposalSku, setProposalSku] = useState('');
  const [proposal, setProposal] = useState<MembershipProposalPayload | null>(null);
  const [proposalError, setProposalError] = useState('');

  const load = async (): Promise<void> => {
    setError('');
    try {
      setPayload(await api<FamilyPlanPayload>(`/storefront-families/${planId}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const loadPreview = async (): Promise<void> => {
    if (!payload) return;
    setPreviewError('');
    setPreview(null);
    setBusy(true);
    try {
      const body = await api<{ preview: AdoptionPreviewPayload }>('/storefront-families/adopt-preview', {
        method: 'POST',
        body: JSON.stringify({ members: payload.plan.memberSkus.map((sku) => ({ sku })) }),
      });
      setPreview(body.preview);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const discoverJoin = async (): Promise<void> => {
    if (!discoverSku.trim()) return;
    setDiscoverError('');
    setDiscoverResult(null);
    setBusy(true);
    try {
      const body = await api<{
        candidates: Array<{ sku: string; familyPlanId: string | null; familyMain: string | null; signals: string[]; matchedOn: string[] }>;
        ambiguous: boolean;
        reasons: string[];
      }>('/storefront-families/join-discover', {
        method: 'POST',
        body: JSON.stringify({ sku: discoverSku.trim() }),
      });
      setDiscoverResult(body);
    } catch (err) {
      setDiscoverError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
  }, [planId]);

  const decide = async (action: 'accept' | 'revise' | 'reject' | 'defer'): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await api(`/storefront-families/${planId}/decide`, {
        method: 'POST',
        body: JSON.stringify({
          action,
          actor,
          note: note.trim().length > 0 ? note.trim() : null,
          mainOverrideSku: mainOverride.trim().length > 0 ? mainOverride.trim() : null,
          membershipProposalId: payload?.joinReview?.membershipProposal?.proposalId ?? undefined,
        }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const apply = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await api(`/storefront-families/${planId}/apply`, {
        method: 'POST',
        body: JSON.stringify({ actor }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const memberChange = async (dissolve: boolean): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const skus = removeSkus.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      await api(`/storefront-families/${planId}/member-change`, {
        method: 'POST',
        body: JSON.stringify({ actor, removeSkus: dissolve ? [] : skus, dissolve }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async (): Promise<void> => {
    setBusy(true);
    try {
      await api(`/storefront-families/${planId}/freshness`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const normalizeProposal = (raw: MembershipProposalPayload): MembershipProposalPayload => ({
    ...raw,
    judgments: Array.isArray(raw.judgments) ? raw.judgments : [],
    modelCallIds: Array.isArray(raw.modelCallIds) ? raw.modelCallIds : [],
    stale: raw.stale === true,
    staleReasons: Array.isArray(raw.staleReasons) ? raw.staleReasons : [],
  });

  const propose = async (): Promise<void> => {
    if (!proposalSku.trim()) return;
    setProposalError('');
    setProposal(null);
    setBusy(true);
    try {
      const body = await api<{ proposal: MembershipProposalPayload; reused: boolean }>('/storefront-families/join-propose', {
        method: 'POST',
        body: JSON.stringify({ sku: proposalSku.trim() }),
      });
      setProposal(normalizeProposal(body.proposal));
    } catch (err) {
      setProposalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadProposal = async (proposalId: string): Promise<void> => {
    setProposalError('');
    setBusy(true);
    try {
      const body = await api<{ proposal: MembershipProposalPayload }>(`/storefront-families/proposals/${proposalId}`);
      setProposal(normalizeProposal(body.proposal));
    } catch (err) {
      setProposalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const decideProposal = async (action: 'accept' | 'revise' | 'reject' | 'defer'): Promise<void> => {
    const targetId = proposal?.id ?? payload?.joinReview?.membershipProposal?.proposalId;
    if (!targetId) return;
    setProposalError('');
    setBusy(true);
    try {
      await api(`/storefront-families/proposals/${targetId}/decide`, {
        method: 'POST',
        body: JSON.stringify({ action, actor, note: note.trim().length > 0 ? note.trim() : null }),
      });
      await load();
      await loadProposal(targetId);
    } catch (err) {
      setProposalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };


  if (error && !payload) return <div role="alert">Family plan failed to load: {error}</div>;
  if (!payload) return <div>Loading family plan…</div>;
  const { row, plan } = payload;
  // N2: apply requires accepted status — a revised plan must be re-accepted
  // first (the server refuses revised at apply time).
  const decided = row.status === 'accepted';
  const isNonFood = plan.ruleVersion !== 'food-family-variant-rule-v1';
  const variantLabel = (member: (typeof plan.members)[number]): string => {
    if (!isNonFood) {
      return `${member.sizeRaw ?? '—'}${member.comparableOunces != null ? ` (${member.comparableOunces} oz)` : ' (incomparable)'}`;
    }
    const parts: string[] = [];
    if (member.sizeRaw) parts.push(member.sizeRaw);
    if (member.colorRaw) parts.push(member.colorRaw);
    if (member.countRaw) parts.push(member.countRaw);
    return parts.join(' / ') || member.sku;
  };
  return (
    <section aria-label="Storefront family review">
      <h2>Family {plan.id.slice(0, 8)} — {plan.memberSkus.length} {isNonFood ? 'members' : 'sizes'} (main {plan.mainSku})</h2>
      <p>
        Rule {plan.ruleVersion} · status {row.status} · revision {row.revision}
        {plan.mainOverridden ? ' · main overridden pre-acceptance' : isNonFood ? ' · main auto-nominated or operator-selected' : ' · main auto-nominated (smallest verified size)'}
      </p>
      {error ? <div role="alert">{error}</div> : null}
      <table>
        <caption>Members, staged invariants, labels, and native diffs</caption>
        <thead>
          <tr>
            <th scope="col">Member SKU</th>
            <th scope="col">{isNonFood ? 'Variant' : 'Size'}</th>
            <th scope="col">Main</th>
            <th scope="col">Staged invariants</th>
            <th scope="col">Short Name PF7 (staged → proposed)</th>
            <th scope="col">Native diff</th>
            <th scope="col">Evidence hashes</th>
          </tr>
        </thead>
        <tbody>
          {plan.members.map((member) => {
            const proposal = plan.pf7Proposals.find((p) => p.sku === member.sku) ?? null;
            const stagedOriginal = (payload.stagedLabels?.[member.sku] ?? member.stagedLabel) || '(empty)';
            const liveLabel = (payload.liveLabels?.[member.sku] ?? null) || '(empty)';
            const proposed = proposal?.shortName ?? '(missing)';
            const replaced = proposal?.replaced === true || stagedOriginal !== proposed;
            const invariantParts: string[] = [];
            if (isNonFood) {
              if (member.model) invariantParts.push(`model ${member.model}`);
              if (member.material) invariantParts.push(`material ${member.material}`);
              if (member.function) invariantParts.push(`function ${member.function}`);
              if (member.safetyDose) invariantParts.push(`safety/dose ${member.safetyDose}`);
              if (member.strength) invariantParts.push(`strength ${member.strength}`);
              if (member.fit) invariantParts.push(`fit ${member.fit}`);
            }
            const isMain = member.sku === plan.mainSku;
            return (
              <tr key={member.sku}>
                <td>{member.sku}</td>
                <td>{variantLabel(member)}</td>
                <td>{isMain ? 'main · self-included' : 'member'}</td>
                <td>{invariantParts.length > 0 ? invariantParts.join('; ') : isNonFood ? '(all non-food invariants staged — see member record)' : '(food invariants staged — see member record)'}</td>
                <td>{stagedOriginal} → {proposed}{replaced ? ' (replaced)' : ''} · live {liveLabel}</td>
                <td>{isMain ? `managed Subproducts block lists all ${plan.memberSkus.length} members (main self-included exactly once)` : 'no managed block — native posture untouched (main-only emission)'}</td>
                <td>type {member.reviewedTypeHash.slice(0, 12)} · evidence {member.evidenceHash.slice(0, 12)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p>
        {isNonFood
          ? 'Invariants held identical: brand, model, material, function, safety/dose, strength, fit. Qualifying axes per the approved rule only. Full names, SKU, prices, stock, images, facts, classifications, filenames, and enablement stay SKU-local and independent; new products remain disabled.'
          : 'Invariants held identical: brand, recipe, flavor, species, life-stage, form. Qualifying axis: package size only. Full names, SKU, prices, stock, images, facts, classifications, filenames, and enablement stay SKU-local and independent; new products remain disabled.'}
      </p>
      <label>
        Decision note
        <input value={note} onChange={(e) => setNote(e.target.value)} aria-label="Decision note" />
      </label>
      <label>
        Pre-acceptance main override (real member SKU)
        <input value={mainOverride} onChange={(e) => setMainOverride(e.target.value)} aria-label="Main override SKU" />
      </label>
      <div role="group" aria-label="Family decision actions">
        <button type="button" disabled={busy} onClick={() => void decide('accept')}>Accept</button>
        <button type="button" disabled={busy} onClick={() => void decide('revise')}>Revise</button>
        <button type="button" disabled={busy} onClick={() => void decide('reject')}>Reject</button>
        <button type="button" disabled={busy} onClick={() => void decide('defer')}>Defer</button>
        <button type="button" disabled={busy || !decided} onClick={() => void apply()}>Apply to change set</button>
        <button type="button" disabled={busy} onClick={() => void refresh()}>Re-check freshness</button>
      </div>
      <fieldset>
        <legend>Native adoption preview (read-only inspection)</legend>
        <p>
          Inspect the live native Subproducts relationship before accepting: complete members, existing main,
          native document order, PF7 labels, supported per-stanza metadata (Price/Name), invariant evidence, and
          rule/evidence/base hashes. Unsupported or ambiguous natives return blockers with a preservation reason.
        </p>
        <button type="button" disabled={busy} onClick={() => void loadPreview()}>Inspect native relationship</button>
        {previewError ? <div role="alert">{previewError}</div> : null}
        {preview ? (
          <div>
            <p>
              Native main {preview.relationship.mainSku || '(none)'} · verdict {preview.support.code} ·
              rule {preview.ruleHash.slice(0, 12) || '(none)'} · evidence {preview.evidenceHash.slice(0, 12) || '(none)'} ·
              base {preview.baseHash.slice(0, 12) || '(none)'} · read {preview.readHash.slice(0, 12) || '(none)'} ·
              write {preview.writeHash.slice(0, 12) || '(none)'}
              {plan.adoptionOrigin ? ` · adopted from native main ${plan.adoptionOrigin.nativeMain} (order ${plan.adoptionOrigin.nativeOrder.join(', ')})` : null}
              {plan.membershipChange ? ` · revision ${plan.membershipChange.kind} (removed ${plan.membershipChange.removedSkus.join(', ') || 'none'}; remaining ${plan.membershipChange.remainingSkus.join(', ') || 'none'})` : null}
            </p>
            <table>
              <caption>Native members in document order</caption>
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Member SKU</th>
                  <th scope="col">PF7 (existing → proposed)</th>
                  <th scope="col">Stanza Price</th>
                  <th scope="col">Stanza child Name</th>
                </tr>
              </thead>
              <tbody>
                {preview.relationship.order.map((sku, i) => {
                  const label = preview.relationship.existingLabels.find((l) => l.sku === sku)?.pf7 ?? '';
                  const meta = preview.relationship.supportedMetadata.find((m) => m.sku === sku);
                  const pf7 = preview.pf7Disposition.find((p) => p.sku === sku);
                  return (
                    <tr key={sku}>
                      <td>{i + 1}</td>
                      <td>{sku}{sku === preview.relationship.mainSku ? ' (main · self-included)' : null}</td>
                      <td>{pf7 ? `${pf7.existing || '(empty)'} → ${pf7.proposed}${pf7.replaced ? ' (replaced)' : ''}` : label}</td>
                      <td>{meta?.price ?? '(none)'}</td>
                      <td>{meta?.childName ?? '(none)'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <ul aria-label="Invariant evidence">
              {preview.relationship.invariantEvidence.map((row) => (
                <li key={row.axis}>{row.axis}: {row.value ?? '(unknown)'} {row.agreed ? '(agreed)' : '(CONFLICT)'}</li>
              ))}
            </ul>
            {preview.blockers.length > 0 ? (
              <ul aria-label="Adoption blockers">
                {preview.blockers.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </fieldset>
      {payload.joinReview || payload.joinReviewError || plan.joinOrigin ? (
        <fieldset>
          <legend>Imported family join review (read-only inspection)</legend>
          <p>
            An imported size joins the reviewed existing family without changing its main, IDs, URL, existing
            members/order, or nonempty labels unless an explicit reviewed diff authorizes the relevant change.
            Complete imported/catalog membership, origins, invariant and varying-axis evidence, changing labels,
            native before/after references, unchanged read dependencies, and the exact write set.
          </p>
          <label>
            Join candidate discovery (imported SKU)
            <input value={discoverSku} onChange={(e) => setDiscoverSku(e.target.value)} aria-label="Join discovery SKU" />
          </label>
          <button type="button" disabled={busy} onClick={() => void discoverJoin()}>Discover join candidates</button>
          {discoverError ? <div role="alert">{discoverError}</div> : null}
          {discoverResult ? (
            <div>
              <p>
                {discoverResult.candidates.length} candidate{discoverResult.candidates.length === 1 ? '' : 's'}
                {discoverResult.ambiguous ? ' · AMBIGUOUS: explicit operator resolution required' : ''}
              </p>
              <ul aria-label="Join candidates">
                {discoverResult.candidates.map((candidate) => (
                  <li key={`${candidate.sku}:${candidate.familyPlanId ?? 'none'}`}>
                    {candidate.sku} → family {candidate.familyPlanId ? candidate.familyPlanId.slice(0, 8) : '(none)'}
                    {candidate.familyMain ? ` (main ${candidate.familyMain})` : ''}
                    {' · '}signals {candidate.signals.join(', ') || '(none)'}
                    {' · '}matched {candidate.matchedOn.join(', ') || '(none)'}
                  </li>
                ))}
              </ul>
              {discoverResult.reasons.length > 0 ? (
                <ul aria-label="Join discovery resolutions">
                  {discoverResult.reasons.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {payload.joinReviewError ? <div role="alert">Join review unavailable: {payload.joinReviewError}</div> : null}
          {payload.joinReview ? (
            <div>
              <p>
                Target family {payload.joinReview.joinOrigin.familyPlanId.slice(0, 8)} · existing main {payload.joinReview.joinOrigin.familyMain} preserved ·
                joined {payload.joinReview.joinOrigin.joinedSkus.join(', ')} ·
                order {payload.joinReview.joinOrigin.familyOrder.join(', ')}
              </p>
              {payload.joinReview.joinOrigin.rejectedFamilies.length > 0 ? (
                <p>
                  Explicitly rejected competing {payload.joinReview.joinOrigin.rejectedFamilies.length === 1 ? 'family' : 'families'}:{' '}
                  {payload.joinReview.joinOrigin.rejectedFamilies.map((r) => `${r.planId.slice(0, 8)} (rev ${r.revision})`).join(', ')}
                </p>
              ) : null}
              <table>
                <caption>Joined membership with origins</caption>
                <thead>
                  <tr>
                    <th scope="col">Member SKU</th>
                    <th scope="col">Origin</th>
                    <th scope="col">Base hash</th>
                    <th scope="col">Type hash</th>
                    <th scope="col">Evidence hash</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.joinReview.membership.map((member) => (
                    <tr key={member.sku}>
                      <td>{member.sku}</td>
                      <td>{member.origin}</td>
                      <td>{member.baseHash ? member.baseHash.slice(0, 12) : '(new import)'}</td>
                      <td>{member.reviewedTypeHash.slice(0, 12)}</td>
                      <td>{member.evidenceHash.slice(0, 12)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul aria-label="Join invariant evidence">
                {payload.joinReview.invariantEvidence.map((row) => (
                  <li key={row.axis}>{row.axis}: {row.value ?? '(unknown)'} {row.agreed ? '(agreed)' : '(CONFLICT)'}</li>
                ))}
              </ul>
              <table>
                <caption>Varying-axis and label disposition</caption>
                <thead>
                  <tr>
                    <th scope="col">Member SKU</th>
                    <th scope="col">Varying axis</th>
                    <th scope="col">PF7 (before → after)</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.joinReview.varyingAxes.map((axis) => {
                    const pf7 = payload.joinReview!.pf7BeforeAfter.find((p) => p.sku === axis.sku);
                    const branches: string[] = [];
                    if (axis.sizeRaw) branches.push(`size: ${axis.sizeRaw}`);
                    if (axis.colorRaw) branches.push(`color: ${axis.colorRaw}`);
                    if (axis.countRaw) branches.push(`count: ${axis.countRaw}${axis.countQuantity != null ? ` (${axis.countQuantity})` : ' (unverified)'}`);
                    return (
                      <tr key={axis.sku}>
                        <td>{axis.sku}</td>
                        <td>{branches.length > 0 ? branches.join(' · ') : axis.sku}{axis.ounces != null ? ` (${axis.ounces} oz)` : ' (incomparable)'}</td>
                        <td>{pf7 ? `${pf7.before || '(empty)'} → ${pf7.after}${pf7.replaced ? ' (replaced)' : ''}` : '(missing)'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <table>
                <caption>Native before/after references and operations</caption>
                <thead>
                  <tr>
                    <th scope="col">Member SKU</th>
                    <th scope="col">Native before</th>
                    <th scope="col">Native after</th>
                    <th scope="col">Operation</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.joinReview.nativeDiffs.map((diff) => (
                    <tr key={diff.sku}>
                      <td>{diff.sku}</td>
                      <td>{diff.beforeRefs.join(', ') || '(none)'}</td>
                      <td>{diff.afterRefs.join(', ')}</td>
                      <td>{diff.operation}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <table>
                <caption>Exact write set and unchanged read dependencies</caption>
                <thead>
                  <tr>
                    <th scope="col">Member SKU</th>
                    <th scope="col">Write operation</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.joinReview.writeSet.map((write) => (
                    <tr key={write.sku}>
                      <td>{write.sku}</td>
                      <td>{write.operation}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>Read dependencies: {payload.joinReview.readDependencies.join(', ') || '(none — the full group is the write set)'}</p>
              {payload.joinReview.blockers.length > 0 ? (
                <ul aria-label="Join blockers">
                  {payload.joinReview.blockers.map((blocker, i) => (
                    <li key={i}>{blocker}</li>
                  ))}
                </ul>
              ) : <p>No join blockers.</p>}
            </div>
          ) : null}
        </fieldset>
      ) : null}
      <fieldset>
        <legend>TypeSafe membership proposal (evidence-backed, never auto-joins)</legend>
        <p>
          An ambiguous imported SKU gets a frozen ≤16-anchor relationship proposal: one independent closed-set
          choice per anchor (same sellable SKU, same permitted family, different product, insufficient evidence).
          The model proposes; the complete plan gates below still validate everything before acceptance. Same-SKU
          answers route to identity/duplicate resolution, never a family merge; multiple positive families require
          explicit conflict resolution. No confidence-based automatic join.
        </p>
        <label>
          Propose membership (imported SKU)
          <input value={proposalSku} onChange={(e) => setProposalSku(e.target.value)} aria-label="Proposal SKU" />
        </label>
        <button type="button" disabled={busy} onClick={() => void propose()}>Request membership proposal</button>
        {proposalError ? <div role="alert">{proposalError}</div> : null}
        {payload.joinReview?.membershipProposal ? (
          <div>
            <p>
              Linked proposal {payload.joinReview.membershipProposal.proposalId.slice(0, 8)} · outcome{' '}
              {payload.joinReview.membershipProposal.outcome} · status {payload.joinReview.membershipProposal.status}
              {payload.joinReview.membershipProposal.stale ? ' · STALE: re-propose before staging' : ''}
            </p>
            <table>
              <caption>Per-anchor proposal outcomes</caption>
              <thead>
                <tr>
                  <th scope="col">Anchor SKU</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Family</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {payload.joinReview.membershipProposal.judgments.map((judgment) => (
                  <tr key={`${judgment.anchorSku}:${judgment.familyPlanId ?? 'none'}`}>
                    <td>{judgment.anchorSku}</td>
                    <td>{judgment.outcome}</td>
                    <td>{judgment.familyPlanId ? judgment.familyPlanId.slice(0, 8) : '(none)'}</td>
                    <td>{judgment.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {payload.joinReview.membershipProposal.staleReasons.length > 0 ? (
              <ul aria-label="Proposal staleness">
                {payload.joinReview.membershipProposal.staleReasons.map((reason, i) => (
                  <li key={i}>{reason}</li>
                ))}
              </ul>
            ) : null}
            <p>Model calls: {payload.joinReview.membershipProposal.modelCallIds.join(', ') || '(none — no dispatch)'}</p>
            <div role="group" aria-label="Linked proposal decision actions">
              <button type="button" disabled={busy} onClick={() => void loadProposal(payload.joinReview!.membershipProposal!.proposalId)}>Refresh proposal</button>
              <button type="button" disabled={busy} onClick={() => void decideProposal('accept')}>Accept proposal</button>
              <button type="button" disabled={busy} onClick={() => void decideProposal('revise')}>Revise proposal</button>
              <button type="button" disabled={busy} onClick={() => void decideProposal('reject')}>Reject proposal</button>
              <button type="button" disabled={busy} onClick={() => void decideProposal('defer')}>Defer proposal</button>
            </div>
          </div>
        ) : proposal ? (
          <div>
            <p>
              Proposal {proposal.id.slice(0, 8)} for {proposal.sku} · outcome {proposal.outcome} · status {proposal.status}
              {proposal.stale ? ' · STALE: re-propose before staging' : ''}
              {proposal.status === 'rejected' || proposal.status === 'deferred'
                ? ' · standalone continuation: the listing stays releasable with no family applied'
                : null}
            </p>
            <table>
              <caption>Per-anchor proposal outcomes</caption>
              <thead>
                <tr>
                  <th scope="col">Anchor SKU</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Family</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {proposal.judgments.map((judgment) => (
                  <tr key={`${judgment.anchorSku}:${judgment.familyPlanId ?? 'none'}`}>
                    <td>{judgment.anchorSku}</td>
                    <td>{judgment.outcome}</td>
                    <td>{judgment.familyPlanId ? judgment.familyPlanId.slice(0, 8) : '(none)'}</td>
                    <td>{judgment.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(proposal.staleReasons ?? []).length > 0 ? (
              <ul aria-label="Proposal staleness">
                {(proposal.staleReasons ?? []).map((reason, i) => (
                  <li key={i}>{reason}</li>
                ))}
              </ul>
            ) : null}
            <p>Model calls: {(proposal.modelCallIds ?? []).join(', ') || '(none — no dispatch)'}</p>
            <div role="group" aria-label="Standalone proposal decision actions">
              <button type="button" disabled={busy} onClick={() => void decideProposal('accept')}>Accept proposal</button>
              <button type="button" disabled={busy} onClick={() => void decideProposal('revise')}>Revise proposal</button>
              <button type="button" disabled={busy} onClick={() => void decideProposal('reject')}>Reject proposal</button>
              <button type="button" disabled={busy} onClick={() => void decideProposal('defer')}>Defer proposal</button>
            </div>
          </div>
        ) : <p>No membership proposal requested for this review.</p>}
      </fieldset>
      <fieldset>
        <legend>Explicit membership change (reviewed revision)</legend>
        <p>
          Removal/dissolution is a new reviewed revision on this plan — the removed members keep their files, PF7
          labels, and unrelated relationships; only managed Subproducts references change (dissolution clears every
          member with an explicit empty block — omission never clears).
        </p>
        <label>
          Remove SKUs (comma-separated; the main cannot be removed without dissolution)
          <input value={removeSkus} onChange={(e) => setRemoveSkus(e.target.value)} aria-label="Remove SKUs" />
        </label>
        <button type="button" disabled={busy} onClick={() => void memberChange(false)}>Stage removal revision</button>
        <button type="button" disabled={busy} onClick={() => void memberChange(true)}>Stage dissolution revision</button>
      </fieldset>
      {row.linkedChangeSetId ? <p>Linked change set: {row.linkedChangeSetId}</p> : null}
      {plan.decisions.length > 0 ? (
        <ol aria-label="Human decision labels (as entered, not authenticated identity)">
          {plan.decisions.map((d, i) => (
            <li key={`${d.at}-${i}`}>{d.action} by {d.actor} at {d.at}{d.note ? ` — ${d.note}` : ''}{d.mainOverrideSku ? ` (main → ${d.mainOverrideSku})` : ''}</li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
