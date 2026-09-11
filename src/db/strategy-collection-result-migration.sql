-- Ticket #122: durable completed strategy-collection envelope (A-lite).
-- Additive only: one generation-keyed table, never alters existing tables. Idempotent.
--
-- Each row is the immutable completed-collection contract for one sourcing
-- generation under an approved distributor-only strategy: the frozen
-- revision/brand, every selected source's outcome contribution (success /
-- no_match / failed / unavailable), and the canonical hash. Write-once:
-- an identical rewrite is idempotent; a divergent rewrite is rejected by
-- the repository (never silently overwritten). Generations without a row
-- keep their legacy interpretation — no backfill, no replay.
CREATE TABLE IF NOT EXISTS strategy_collection_results (
  sourcing_generation_id TEXT PRIMARY KEY REFERENCES sourcing_generations(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
  version TEXT NOT NULL DEFAULT 'strategy-collection-v1',
  strategy_revision INTEGER NOT NULL,
  normalized_brand TEXT NOT NULL,
  contributions_json TEXT NOT NULL DEFAULT '[]',
  identity_conflict INTEGER NOT NULL DEFAULT 0,
  collection_hash TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_strategy_collection_results_item ON strategy_collection_results(item_id);
CREATE INDEX IF NOT EXISTS idx_strategy_collection_results_workspace ON strategy_collection_results(workspace_id);
