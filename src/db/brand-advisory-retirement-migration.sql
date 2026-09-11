-- Issue #150 (Amendment B1.1): retire brand advisory settings.
--
-- Executed once by the retirement block in src/db/migrations.ts, AFTER every
-- historical advisory dependency (distributor-v2 creation, batch-preflight
-- advisory ALTER). The block runs this script only when the snapshots table
-- still carries the legacy CHECK; the marker guards reruns.
--
-- 1. Rebuilds sourcing_generation_strategy_snapshots to widen the mode CHECK
--    to approved | legacy_advisory | query_all and defaults new bindings to
--    strategy-binding-v2. ALL existing rows, columns, and values are copied
--    explicitly — including v1 version/mode, timestamps, source JSON, and
--    the inert preferred_distributor_ids_json bytes (historical storage
--    only, never execution authority). No UPDATE/parse/rewrite of history.
-- 2. Drops brand_advisory_profiles (its table-local workspace index drops
--    with it). No replacement table, no backfill. The verified pre-upgrade
--    backup is the recovery source for retired settings.
CREATE TABLE IF NOT EXISTS sourcing_generation_strategy_snapshots_new (
  sourcing_generation_id TEXT PRIMARY KEY REFERENCES sourcing_generations(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('approved', 'legacy_advisory', 'query_all')),
  strategy_revision INTEGER,
  normalized_brand TEXT,
  sources_json TEXT NOT NULL DEFAULT '[]',
  preferred_distributor_ids_json TEXT NOT NULL DEFAULT '[]',
  binding_version TEXT NOT NULL DEFAULT 'strategy-binding-v2',
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO sourcing_generation_strategy_snapshots_new (
  sourcing_generation_id, workspace_id, item_id, mode, strategy_revision,
  normalized_brand, sources_json, preferred_distributor_ids_json,
  binding_version, captured_at, created_at
)
SELECT
  sourcing_generation_id, workspace_id, item_id, mode, strategy_revision,
  normalized_brand, sources_json, preferred_distributor_ids_json,
  binding_version, captured_at, created_at
FROM sourcing_generation_strategy_snapshots;

DROP TABLE sourcing_generation_strategy_snapshots;

ALTER TABLE sourcing_generation_strategy_snapshots_new RENAME TO sourcing_generation_strategy_snapshots;

CREATE INDEX IF NOT EXISTS idx_gen_strategy_snapshots_item ON sourcing_generation_strategy_snapshots(item_id);
CREATE INDEX IF NOT EXISTS idx_gen_strategy_snapshots_workspace ON sourcing_generation_strategy_snapshots(workspace_id);

DROP TABLE IF EXISTS brand_advisory_profiles;
