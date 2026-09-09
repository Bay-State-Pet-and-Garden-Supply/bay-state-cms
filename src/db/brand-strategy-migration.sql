-- Brand Sourcing Strategy approval + durable Preparation gaps (spec #120, tickets #121/#124).
-- Additive only: new tables, never alters existing tables. Idempotent.
CREATE TABLE IF NOT EXISTS brand_sourcing_strategies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  brand TEXT NOT NULL,
  normalized_brand TEXT NOT NULL,
  sources_json TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  approved INTEGER NOT NULL DEFAULT 0,
  approved_at TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, normalized_brand)
);

CREATE INDEX IF NOT EXISTS idx_brand_sourcing_strategies_workspace ON brand_sourcing_strategies(workspace_id);

-- Durable Listing Evidence Gaps (ticket #124): one row per item while a
-- required-information gap is open; resolved rows are retained with
-- resolved_at set (audit, never deleted by normal flows).
CREATE TABLE IF NOT EXISTS preparation_gaps (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  collection_result_version TEXT NOT NULL DEFAULT 'strategy-collection-v1',
  missing_fields_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL DEFAULT '',
  evidence_hash TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  opened_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  correction_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(item_id)
);

CREATE INDEX IF NOT EXISTS idx_preparation_gaps_batch ON preparation_gaps(batch_id);
CREATE INDEX IF NOT EXISTS idx_preparation_gaps_item ON preparation_gaps(item_id);
