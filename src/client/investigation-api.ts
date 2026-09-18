// #238 — Profile Workspace investigation API (client fetch wrappers).
//
// Thin wrappers over the existing investigate/validate/apply/discard,
// workspace, drift-context, and budget-preview routes. Status and stored
// validation ride the workspace view (polled while a run is active), so no
// separate status/validation fetchers ship here. Bodies are shaped by
// `./components/profile-workspace/investigation-contracts` so UI forms
// never hand-assemble payloads: launch sends sample URLs only, validate
// sends sample references, and apply sends `{ actor }` only
// (server-authoritative apply, #234 — never validation verdicts or
// holdout counts).

import {
  buildApplyBody,
  buildDiscardBody,
  buildLaunchBody,
  buildValidateBody,
  type InvestigationAppliedView,
  type InvestigationDriftContextView,
  type InvestigationWorkspaceView,
  type ValidationSampleEntry,
} from './components/profile-workspace/investigation-contracts';

export type InvestigationMode = 'domain_onboarding' | 'drift_repair';

export interface InvestigationListItem {
  id: string;
  domain: string;
  mode: InvestigationMode;
  status: string;
  provider: string;
}

export interface BudgetRow {
  key: string;
  label: string;
  value: string;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail =
      (body as { error?: string; code?: string }).error ??
      (body as { code?: string }).code ??
      `HTTP ${res.status}`;
    throw new Error(String(detail));
  }
  return body as T;
}

function domainBase(domain: string): string {
  return `/api/domains/${encodeURIComponent(domain)}`;
}

export async function listInvestigations(domain: string): Promise<InvestigationListItem[]> {
  const body = await requestJson<{ investigations: InvestigationListItem[] }>(
    `${domainBase(domain)}/investigations`,
  );
  return body.investigations ?? [];
}

export async function previewInvestigationBudgets(
  domain: string,
  sampleUrls: string[],
): Promise<BudgetRow[]> {
  const payload = sampleUrls.length > 0 ? { sampleUrls } : {};
  const body = await requestJson<{ budgets: BudgetRow[] }>(
    `${domainBase(domain)}/investigations/preview`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
  );
  return body.budgets ?? [];
}

export async function launchInvestigation(
  domain: string,
  mode: InvestigationMode,
  sampleUrls: string[],
): Promise<{ investigation: InvestigationListItem; budgets?: BudgetRow[] }> {
  const suffix = mode === 'drift_repair' ? '/investigations/drift-repair' : '/investigations';
  return requestJson(`${domainBase(domain)}${suffix}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildLaunchBody(sampleUrls)),
  });
}

export async function fetchInvestigationWorkspace(
  domain: string,
  id: string,
): Promise<{ workspace: InvestigationWorkspaceView }> {
  return requestJson(`${domainBase(domain)}/investigations/${encodeURIComponent(id)}/workspace`);
}

export async function fetchDriftContext(
  domain: string,
): Promise<{ driftContext: InvestigationDriftContextView | null }> {
  return requestJson(`${domainBase(domain)}/investigations/drift-context`);
}

export async function cancelInvestigation(
  domain: string,
  id: string,
): Promise<{ investigation: InvestigationListItem }> {
  return requestJson(`${domainBase(domain)}/investigations/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export async function validateInvestigation(
  domain: string,
  id: string,
  entries: ValidationSampleEntry[],
  baselineVersionId?: string | null,
): Promise<{ validation: InvestigationWorkspaceView['validation'] }> {
  return requestJson(`${domainBase(domain)}/investigations/${encodeURIComponent(id)}/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildValidateBody(entries, baselineVersionId)),
  });
}

export async function applyInvestigationToDraft(
  domain: string,
  id: string,
  actor: string,
): Promise<{ applied: InvestigationAppliedView; version?: unknown }> {
  return requestJson(`${domainBase(domain)}/investigations/${encodeURIComponent(id)}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildApplyBody(actor)),
  });
}

export async function discardInvestigation(
  domain: string,
  id: string,
  actor: string,
): Promise<{ investigation: InvestigationListItem }> {
  return requestJson(`${domainBase(domain)}/investigations/${encodeURIComponent(id)}/discard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildDiscardBody(actor)),
  });
}
