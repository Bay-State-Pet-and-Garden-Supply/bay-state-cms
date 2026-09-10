// ---------------------------------------------------------------------------
// Store Manager evidence-grounded cleanup report (epic #42, #38)
//
// The deterministic report is the DEFAULT and needs no model. An optional
// narrative may only SUMMARIZE the bounded evidence bundle; it can never add
// counts, severity labels, SKUs, field names, or action claims. The narrative
// call is audited through the general callLlmForTask path (ai_model_calls).
// ---------------------------------------------------------------------------

import { getCatalogHealthReport } from './product-service';
import { generateProductFieldAuditReport } from './catalog-insight-service';
import { listRegistry } from '../../db/repositories/field-registry-repo';
import {
  countProposalsByStatus,
  countProposalsByField,
} from '../../db/repositories/catalog-health-proposal-repo';
import { listChangeSetCountsByState } from '../../db/repositories/change-set-repo';
import { callLlmForTask } from '../../onboarding/llm-client';
import {
  StoreManagerReportRequestSchema,
  StoreManagerEvidenceBundleSchema,
  MAX_ISSUE_SAMPLES,
  MAX_REPORT_FIELDS,
  MAX_REPORT_STRING_LENGTH,
  MAX_NARRATIVE_BULLETS,
  type StoreManagerReportRequest,
  type StoreManagerEvidenceBundle,
  type StoreManagerReportResponse,
  type ProductFieldAuditEvidence,
} from '../../shared/schemas/store-manager-report';

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

// ---------------------------------------------------------------------------
// Evidence collection
// ---------------------------------------------------------------------------

/**
 * Collect the strict, bounded evidence bundle through authoritative
 * repositories/services. Requested fields are validated against the workspace
 * field registry and capped. No model call occurs here.
 */
export function collectStoreManagerEvidence(
  workspaceId: string,
  requestedFields: string[],
): StoreManagerEvidenceBundle {
  const health = getCatalogHealthReport();

  const issueCountsBySeverity: Record<string, number> = {};
  const issueCountsByCode: Record<string, number> = {};
  for (const issue of health.issues) {
    issueCountsBySeverity[issue.severity] = (issueCountsBySeverity[issue.severity] ?? 0) + 1;
    issueCountsByCode[issue.code] = (issueCountsByCode[issue.code] ?? 0) + 1;
  }
  const issueSamples = health.issues.slice(0, MAX_ISSUE_SAMPLES).map((i) => ({
    sku: i.sku,
    severity: i.severity,
    code: i.code,
    message: truncate(i.message, MAX_REPORT_STRING_LENGTH),
    fieldPath: i.fieldPath,
  }));

  // Validate requested fields against the workspace field registry; unknown
  // fields are silently dropped (never audited, never fabricated).
  const registry = listRegistry(workspaceId);
  const validFields: string[] = [];
  for (const field of requestedFields) {
    if (registry.some((r) => r.xmlField === field)) validFields.push(field);
    if (validFields.length >= MAX_REPORT_FIELDS) break;
  }

  const fieldAudits: ProductFieldAuditEvidence[] = validFields.map((field) => {
    const audit = generateProductFieldAuditReport(workspaceId, field);
    return {
      field: audit.field,
      label: audit.label,
      totalActiveProducts: audit.totalActiveProducts,
      emptyCount: audit.emptyCount,
      emptyRate: audit.emptyRate,
      uniqueValueCount: audit.uniqueValueCount,
      casingDuplicateCount: audit.casingDuplicates.length,
      nearDuplicateCount: audit.nearDuplicates.length,
      separatorInconsistent: audit.separatorInconsistencies.inconsistent,
      suspiciousCount: audit.suspiciousValues.length,
    };
  });

  const proposedCount = countProposalsByStatus(workspaceId, 'proposed');
  const proposalsByField = countProposalsByField(workspaceId, 'proposed');
  const changeSetsByState = listChangeSetCountsByState(workspaceId);
  const changeSetTotal = Object.values(changeSetsByState).reduce((a, b) => a + b, 0);

  const bundle = {
    generatedAt: new Date().toISOString(),
    workspaceId,
    catalogHealth: {
      totalProducts: health.totalProducts,
      healthyProducts: health.healthyProducts,
      unhealthyProducts: health.unhealthyProducts,
      totalErrors: health.totalErrors,
      totalWarnings: health.totalWarnings,
      issueCountsBySeverity,
      issueCountsByCode,
      issueSamples,
      issueSamplesTruncated: health.issues.length > MAX_ISSUE_SAMPLES,
    },
    fieldAudits,
    proposals: { proposedCount, byField: proposalsByField },
    changeSets: { byState: changeSetsByState, total: changeSetTotal },
  };

  const parsed = StoreManagerEvidenceBundleSchema.safeParse(bundle);
  if (!parsed.success) {
    throw new Error(`Evidence bundle failed schema validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Deterministic report builder (default; no model required)
// ---------------------------------------------------------------------------

export interface DeterministicReport {
  summary: string;
  markdown: string;
}

const GENERAL_WORKFLOW_NOTE =
  'General workflow recommendation (fixed code, not a model finding): review the ' +
  'highest-severity catalog issues first, then route stored proposals through the ' +
  'investigate -> approve -> stage -> verify lifecycle.';

/** Build a one-line summary entirely from evidence fields. */
export function buildReportSummary(evidence: StoreManagerEvidenceBundle): string {
  const ch = evidence.catalogHealth;
  return (
    `Catalog has ${ch.totalErrors} error(s) and ${ch.totalWarnings} warning(s) across ` +
    `${ch.unhealthyProducts} product(s); ${evidence.proposals.proposedCount} proposal(s) ` +
    `pending review; ${evidence.changeSets.total} change set(s).`
  );
}

function formatRecord(record: Record<string, number>): string {
  const entries = Object.entries(record);
  if (entries.length === 0) return 'none';
  return entries.map(([k, v]) => `${k}: ${v}`).join(', ');
}

/**
 * Build the deterministic Markdown report. Every catalog-specific line cites
 * its evidence key; the only non-cited lines are fixed-code workflow
 * recommendations explicitly labeled as such. Empty/clean catalogs yield an
 * explicit "no observed issues" report with no fabricated categories.
 */
export function buildDeterministicReport(evidence: StoreManagerEvidenceBundle): DeterministicReport {
  const ch = evidence.catalogHealth;
  const lines: string[] = [];

  lines.push('# Store Manager Cleanup Report');
  lines.push('');
  lines.push(`Generated at ${evidence.generatedAt} (evidence: evidence.generatedAt)`);
  lines.push(`Workspace: ${evidence.workspaceId} (evidence: evidence.workspaceId)`);
  lines.push('');
  lines.push('## Executive Summary');
  lines.push('');
  lines.push(`- Active products: ${ch.totalProducts} (evidence: evidence.catalogHealth.totalProducts)`);
  lines.push(`- Healthy products: ${ch.healthyProducts} (evidence: evidence.catalogHealth.healthyProducts)`);
  lines.push(`- Products with at least one issue: ${ch.unhealthyProducts} (evidence: evidence.catalogHealth.unhealthyProducts)`);
  lines.push(`- Stored proposals pending review: ${evidence.proposals.proposedCount} (evidence: evidence.proposals.proposedCount)${Object.keys(evidence.proposals.byField).length > 0 ? ` (by field: ${formatRecord(evidence.proposals.byField)}) (evidence: evidence.proposals.byField)` : ''}`);
  lines.push(`- Change Sets total: ${evidence.changeSets.total} (evidence: evidence.changeSets.total)`);
  lines.push('');
  lines.push('## Catalog Health Insights');
  lines.push('');

  const hasIssues = ch.totalErrors > 0 || ch.totalWarnings > 0 || Object.keys(ch.issueCountsByCode).length > 0;
  if (!hasIssues) {
    lines.push(
      'No observed catalog issues in the current evidence ' +
        '(evidence: evidence.catalogHealth.totalErrors = 0, ' +
        'evidence.catalogHealth.totalWarnings = 0, ' +
        'evidence.catalogHealth.issueCountsByCode is empty).',
    );
    lines.push('');
  } else {
    lines.push(`- Validation issues by severity: ${formatRecord(ch.issueCountsBySeverity)} (evidence: evidence.catalogHealth.issueCountsBySeverity)`);
    lines.push(`- Validation issues by code: ${formatRecord(ch.issueCountsByCode)} (evidence: evidence.catalogHealth.issueCountsByCode)`);
    lines.push('');
    lines.push('### Issues by severity');
    lines.push('');
    for (const [severity, count] of Object.entries(ch.issueCountsBySeverity).sort()) {
      lines.push(`- ${severity}: ${count} (evidence: evidence.catalogHealth.issueCountsBySeverity.${severity})`);
    }
    lines.push('');
    lines.push('### Issues by code');
    lines.push('');
    for (const [code, count] of Object.entries(ch.issueCountsByCode).sort()) {
      lines.push(`- ${code}: ${count} (evidence: evidence.catalogHealth.issueCountsByCode.${code})`);
    }
    lines.push('');
    lines.push(`### Sample issues (bounded to ${ch.issueSamples.length} of ${ch.unhealthyProducts} affected products${ch.issueSamplesTruncated ? '; issue list truncated to sample cap' : ''})`);
    lines.push('');
    ch.issueSamples.forEach((sample, i) => {
      lines.push(
        `- \`${sample.sku}\` [${sample.code}] ${sample.message} (evidence: evidence.catalogHealth.issueSamples[${i}])`,
      );
    });
    if (ch.issueSamples.length === 0) {
      lines.push('(No sample entries retained; issue details exist outside the bounded sample.)');
    }
    lines.push('');
  }

  lines.push('## ProductField Cleanup');
  lines.push('');
  if (evidence.fieldAudits.length === 0) {
    lines.push(
      'No ProductFields were requested for audit; this report is derived from catalog health, ' +
        'proposal, and Change Set evidence only (evidence: evidence.fieldAudits is empty).',
    );
    lines.push('');
  } else {
    for (const f of evidence.fieldAudits) {
      lines.push(`### ${f.label} (${f.field})`);
      lines.push(`- Empty count: ${f.emptyCount} of ${f.totalActiveProducts} (evidence: evidence.fieldAudits.${f.field}.emptyCount)`);
      lines.push(`- Unique values: ${f.uniqueValueCount} (evidence: evidence.fieldAudits.${f.field}.uniqueValueCount)`);
      lines.push(`- Casing duplicate groups: ${f.casingDuplicateCount} (evidence: evidence.fieldAudits.${f.field}.casingDuplicateCount)`);
      lines.push(`- Near-duplicate pairs: ${f.nearDuplicateCount} (evidence: evidence.fieldAudits.${f.field}.nearDuplicateCount)`);
      lines.push(`- Separator inconsistencies present: ${f.separatorInconsistent ? 'yes' : 'no'} (evidence: evidence.fieldAudits.${f.field}.separatorInconsistent)`);
      lines.push(`- Suspicious values: ${f.suspiciousCount} (evidence: evidence.fieldAudits.${f.field}.suspiciousCount)`);
      lines.push('');
    }
    lines.push(
      GENERAL_WORKFLOW_NOTE +
        ' Mechanical casing/whitespace normalization may be staged after review; ' +
        'semantic or taxonomy consolidation always requires explicit human review (fixed code, not a model finding).',
    );
    lines.push('');
  }

  lines.push('## Change Set Status');
  lines.push('');
  lines.push(`Total Change Sets: ${evidence.changeSets.total} (evidence: evidence.changeSets.total)`);
  for (const state of ['draft', 'reviewing', 'approved', 'pushed', 'discarded']) {
    const count = evidence.changeSets.byState[state] ?? 0;
    if (count > 0) {
      lines.push(`- ${state}: ${count} (evidence: evidence.changeSets.byState.${state})`);
    }
  }
  lines.push('');
  lines.push(
    'State vocabulary (fixed code): a staged proposal is a draft change inside a Change Set; ' +
      'an approved Change Set is a Git-backed change that is NOT automatically imported, ' +
      'published, or synced. "approved" and "synced" remain distinct states ' +
      '(evidence: evidence.changeSets.byState).',
  );
  lines.push('');

  return { summary: buildReportSummary(evidence), markdown: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Optional narrative (opt-in, summarization only, evidence-key validated)
// ---------------------------------------------------------------------------

export interface NarrativeBullet {
  evidenceKey: string;
  statement: string;
}

export interface NarrativeOutput {
  summary: string;
  bullets: NarrativeBullet[];
}

export type NarrativeGenerator = (bundle: StoreManagerEvidenceBundle) => Promise<NarrativeOutput | null>;

/** Exact set of evidence keys a narrative may reference. */
export function buildEvidenceKeyAllowlist(evidence: StoreManagerEvidenceBundle): Set<string> {
  const keys = new Set<string>();
  const ch = evidence.catalogHealth;
  keys.add('evidence.catalogHealth.totalProducts');
  keys.add('evidence.catalogHealth.healthyProducts');
  keys.add('evidence.catalogHealth.unhealthyProducts');
  keys.add('evidence.catalogHealth.totalErrors');
  keys.add('evidence.catalogHealth.totalWarnings');
  keys.add('evidence.catalogHealth.issueSamplesTruncated');
  for (const severity of Object.keys(ch.issueCountsBySeverity)) {
    keys.add(`evidence.catalogHealth.issueCountsBySeverity.${severity}`);
  }
  for (const code of Object.keys(ch.issueCountsByCode)) {
    keys.add(`evidence.catalogHealth.issueCountsByCode.${code}`);
  }
  ch.issueSamples.forEach((_, i) => keys.add(`evidence.catalogHealth.issueSamples[${i}]`));
  for (const f of evidence.fieldAudits) {
    for (const suffix of [
      'emptyCount',
      'uniqueValueCount',
      'casingDuplicateCount',
      'nearDuplicateCount',
      'separatorInconsistent',
      'suspiciousCount',
    ]) {
      keys.add(`evidence.fieldAudits.${f.field}.${suffix}`);
    }
  }
  keys.add('evidence.proposals.proposedCount');
  for (const field of Object.keys(evidence.proposals.byField)) {
    keys.add(`evidence.proposals.byField.${field}`);
  }
  keys.add('evidence.changeSets.total');
  for (const state of Object.keys(evidence.changeSets.byState)) {
    keys.add(`evidence.changeSets.byState.${state}`);
  }
  return keys;
}

/**
 * Validate raw model text into a structured narrative. Rejects unknown
 * evidence keys, oversized bullets, malformed JSON, and missing fields so the
 * model can never introduce facts the evidence does not support.
 */
export function validateNarrativeOutput(
  raw: string,
  allowlist: Set<string>,
): NarrativeOutput | null {
  const trimmed = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  if (typeof obj.summary !== 'string' || obj.summary.length === 0 || obj.summary.length > 2000) {
    return null;
  }
  if (!Array.isArray(obj.bullets) || obj.bullets.length > MAX_NARRATIVE_BULLETS) return null;
  const bullets: NarrativeBullet[] = [];
  for (const bullet of obj.bullets) {
    if (!bullet || typeof bullet !== 'object') return null;
    const b = bullet as Record<string, unknown>;
    if (typeof b.evidenceKey !== 'string' || typeof b.statement !== 'string') return null;
    if (!allowlist.has(b.evidenceKey)) return null;
    if (b.statement.length === 0 || b.statement.length > MAX_REPORT_STRING_LENGTH) return null;
    bullets.push({ evidenceKey: b.evidenceKey, statement: b.statement });
  }
  return { summary: obj.summary, bullets };
}

function narrativeToMarkdown(output: NarrativeOutput): string {
  const lines = [
    '# Store Manager Cleanup Report (narrative over evidence bundle)',
    '',
    output.summary,
    '',
    '## Evidence-referenced highlights',
    '',
  ];
  for (const bullet of output.bullets) {
    lines.push(`- [${bullet.evidenceKey}] ${bullet.statement}`);
  }
  return lines.join('\n');
}

const NARRATIVE_SYSTEM_PROMPT =
  'You are a summarization assistant for the Bay State CMS Store Manager. ' +
  'You receive a bounded evidence bundle and produce a SHORT executive summary. ' +
  'You never add counts, severity labels, SKUs, field names, proposals, change sets, ' +
  'or recommended actions that are not present in the supplied evidence.';

/**
 * Default narrative generator: summarizes the bounded bundle through the
 * general audited LLM path. Returns null on any validation failure so the
 * caller falls back to the deterministic report.
 */
export const defaultNarrativeGenerator: NarrativeGenerator = async (bundle) => {
  const allowlist = buildEvidenceKeyAllowlist(bundle);
  const allowedKeys = [...allowlist].sort().join('\n');
  const prompt =
    'Summarize this evidence bundle. Return ONLY JSON with shape ' +
    '{"summary": string, "bullets": [{"evidenceKey": string, "statement": string}]} ' +
    'where every evidenceKey is exactly one of the allowed keys listed below, ' +
    'statements stay under 200 characters, and at most 20 bullets.\n\n' +
    'Allowed evidence keys:\n' + allowedKeys + '\n\n' +
    'Evidence bundle (JSON):\n' + JSON.stringify(bundle);

  const response = await callLlmForTask('store_manager_assistant', prompt, NARRATIVE_SYSTEM_PROMPT, {
    allowFallback: true,
    // Real workspace identity so the narrative model call is audited in
    // ai_model_calls for this workspace (epic #42, #37).
    workspaceId: bundle.workspaceId,
  });
  if (!response) return null;
  return validateNarrativeOutput(response, allowlist);
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Generate the evidence-grounded cleanup report. Deterministic by default;
 * an optional narrative summarizes only the validated bundle. Never invents
 * findings: when the narrative is unavailable or invalid, the deterministic
 * report is returned unchanged.
 */
export async function generateStoreManagerReport(
  workspaceId: string,
  workspacePath: string,
  request: StoreManagerReportRequest = {},
  deps: { narrative?: NarrativeGenerator } = {},
): Promise<StoreManagerReportResponse> {
  // workspacePath is retained for signature compatibility with the previous
  // report entry point; evidence is derived from the active workspace DB.
  void workspacePath;

  const parsed = StoreManagerReportRequestSchema.safeParse(request ?? {});
  const fields = parsed.success ? (parsed.data.fields ?? []) : [];
  const wantNarrative = parsed.success ? (parsed.data.narrative ?? false) : false;

  const evidence = collectStoreManagerEvidence(workspaceId, fields);
  const deterministic = buildDeterministicReport(evidence);

  if (wantNarrative) {
    const generator = deps.narrative ?? defaultNarrativeGenerator;
    let output: NarrativeOutput | null = null;
    try {
      output = await generator(evidence);
    } catch {
      // Model/policy failure never blocks the report: fail closed to the
      // deterministic builder (which needs no model).
      output = null;
    }
    if (output) {
      return {
        evidence,
        summary: output.summary,
        reportMarkdown: narrativeToMarkdown(output),
      };
    }
  }
  return { evidence, summary: deterministic.summary, reportMarkdown: deterministic.markdown };
}
