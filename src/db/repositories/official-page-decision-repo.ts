import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';
import type { OnboardingSource } from '../../shared/schemas/onboarding';
import { insertSources, listSourcesByItem } from './onboarding-source-repo';
import { toCanonicalStored } from './onboarding-stage-vocabulary-repo';

export type PageCandidateOrigin = 'index' | 'sitemap' | 'import' | 'operator' | 'historical' | 'legacy';
export type PageIdentityEvidence = 'automatic_name' | 'operator_name' | 'observed_gtin';

const PERSISTENT_METHODS: Record<'import' | 'operator' | 'historical' | 'legacy', string> = {
  import: 'imported_url',
  operator: 'operator_url',
  historical: 'historical_url',
  legacy: 'legacy_unverified_url',
};

function candidateOrigin(method: string): PageCandidateOrigin {
  if (method === 'imported_url') return 'import';
  if (method === 'operator_url' || method === 'operator_variant') return 'operator';
  if (method === 'historical_url') return 'historical';
  if (method === 'legacy_unverified_url') return 'legacy';
  if (method.startsWith('sitemap_') || method === 'shopify_variant') return 'sitemap';
  return 'index';
}

export interface OfficialPageDecision {
  id: string;
  workspaceId: string;
  itemId: string;
  url: string;
  candidateOrigin: PageCandidateOrigin;
  evidenceKind: PageIdentityEvidence;
  pageTitle: string;
  variantKey: string | null;
  identitySignalsJson: string;
  sourceRunId: string | null;
  decidedAt: string;
}

interface DecisionRow {
  id: string;
  workspace_id: string;
  item_id: string;
  url: string;
  candidate_origin: PageCandidateOrigin;
  evidence_kind: PageIdentityEvidence;
  page_title: string;
  variant_key: string | null;
  identity_signals_json: string;
  source_run_id: string | null;
  decided_at: string;
}

function mapDecision(row: DecisionRow): OfficialPageDecision {
  return {
    id: row.id, workspaceId: row.workspace_id, itemId: row.item_id,
    url: row.url, candidateOrigin: row.candidate_origin, evidenceKind: row.evidence_kind,
    pageTitle: row.page_title, variantKey: row.variant_key,
    identitySignalsJson: row.identity_signals_json, sourceRunId: row.source_run_id,
    decidedAt: row.decided_at,
  };
}

/** An offered URL is never a confirmed item URL. Reuse the original provenance on retry. */
export function proposePageCandidate(input: {
  itemId: string;
  url: string;
  origin: 'import' | 'operator' | 'historical' | 'legacy';
}): OnboardingSource {
  const parsed = new URL(input.url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Product page URL must be an HTTP(S) URL without credentials');
  }
  const existing = listSourcesByItem(input.itemId).find(
    source => source.url === parsed.toString() && source.sourceMethod === PERSISTENT_METHODS[input.origin],
  );
  if (existing) return existing;
  return insertSources(input.itemId, [{
    url: parsed.toString(), domain: parsed.hostname.toLowerCase(), confidence: 0,
    sourceMethod: PERSISTENT_METHODS[input.origin],
  }])[0];
}

/** The item URL, selected source and append-only evidence are a single commit. */
function ensureDecisionTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS official_page_decisions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      url TEXT NOT NULL,
      candidate_origin TEXT NOT NULL,
      evidence_kind TEXT NOT NULL,
      page_title TEXT NOT NULL,
      variant_key TEXT,
      identity_signals_json TEXT NOT NULL,
      source_run_id TEXT,
      decided_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_official_page_decisions_item
      ON official_page_decisions(item_id, decided_at);
  `);
}

export function recordOfficialPageDecision(input: {
  workspaceId: string;
  itemId: string;
  sourceId: string;
  evidenceKind: PageIdentityEvidence;
  pageTitle: string;
  variantKey: string | null;
  signals: Record<string, unknown>;
  sourceRunId: string | null;
}): OfficialPageDecision {
  ensureDecisionTable();
  const db = getDb();
  return db.transaction(() => {
    const row = db.query(`
      SELECT i.stage, i.source_type, s.url, s.source_method, s.discovery_run_id,
             b.workspace_id, s.item_id
      FROM onboarding_sources s
      JOIN onboarding_items i ON i.id = s.item_id
      JOIN onboarding_batches b ON b.id = i.batch_id
      WHERE s.id = ? AND i.id = ? AND b.workspace_id = ?
    `).get(input.sourceId, input.itemId, input.workspaceId) as {
      stage: string; source_type: string | null; url: string; source_method: string;
      discovery_run_id: string | null; workspace_id: string; item_id: string;
    } | undefined;
    if (!row || row.source_type === 'distributor_record' || toCanonicalStored(row.stage) !== 'find_product_page') {
      throw new Error('Official page candidate is not selectable for this item and workspace');
    }
    const pageTitle = input.pageTitle.trim();
    if (!pageTitle || pageTitle.length > 500) throw new Error('A visible product page title is required');
    const decision: OfficialPageDecision = {
      id: randomUUID(), workspaceId: input.workspaceId, itemId: input.itemId,
      url: row.url, candidateOrigin: candidateOrigin(row.source_method),
      evidenceKind: input.evidenceKind, pageTitle, variantKey: input.variantKey,
      identitySignalsJson: JSON.stringify(input.signals),
      sourceRunId: input.sourceRunId ?? row.discovery_run_id,
      decidedAt: new Date().toISOString(),
    };
    db.query('UPDATE onboarding_sources SET is_selected = 0 WHERE item_id = ?').run(input.itemId);
    db.query('UPDATE onboarding_sources SET is_selected = 1 WHERE id = ?').run(input.sourceId);
    db.query(`INSERT INTO official_page_decisions
      (id, workspace_id, item_id, url, candidate_origin, evidence_kind, page_title, variant_key,
       identity_signals_json, source_run_id, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      decision.id, decision.workspaceId, decision.itemId, decision.url, decision.candidateOrigin,
      decision.evidenceKind, decision.pageTitle, decision.variantKey, decision.identitySignalsJson,
      decision.sourceRunId, decision.decidedAt,
    );
    const updated = db.query(`UPDATE onboarding_items
      SET source_url = ?, stage_status = 'completed', status = 'source_confirmed',
          error_message = NULL, updated_at = ?
      WHERE id = ? AND source_type = 'official_page'`).run(decision.url, decision.decidedAt, input.itemId);
    if (updated.changes !== 1) throw new Error('Official page item changed during confirmation');
    return decision;
  })();
}

export function listOfficialPageDecisions(itemId: string): OfficialPageDecision[] {
  ensureDecisionTable();
  const rows = getDb().query(
    'SELECT * FROM official_page_decisions WHERE item_id = ? ORDER BY decided_at DESC, rowid DESC',
  ).all(itemId) as DecisionRow[];
  return rows.map(mapDecision);
}

/** Previous approval suggests a URL, never authenticates another item. */
export function listPriorOfficialPageCandidates(input: {
  workspaceId: string; brand: string; upc: string; name: string;
}): OfficialPageDecision[] {
  if (!input.brand.trim()) return [];
  ensureDecisionTable();
  const rows = getDb().query(`
    SELECT d.* FROM official_page_decisions d
    JOIN onboarding_items i ON i.id = d.item_id
    WHERE d.workspace_id = ? AND LOWER(i.brand_hint) = LOWER(?)
      AND (i.upc = ? OR LOWER(i.name) = LOWER(?))
    ORDER BY d.decided_at DESC, d.rowid DESC LIMIT 20
  `).all(input.workspaceId, input.brand, input.upc, input.name) as DecisionRow[];
  return rows.map(mapDecision);
}
