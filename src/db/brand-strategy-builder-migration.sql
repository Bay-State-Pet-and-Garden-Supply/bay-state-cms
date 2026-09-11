-- Brand strategy builder slice B2: durable per-generation strategy binding.
-- Additive only: one append-only table, never alters existing tables. Idempotent.
--
-- NOTE: the mode CHECK below intentionally carries the pre-retirement set
-- ('approved', 'legacy_advisory'). The brand advisory retirement migration
-- (brand-advisory-retirement-migration.sql, Amendment B1.1) widens it to
-- include 'query_all' on upgrade; fresh databases reach the widened schema
-- by running both steps. Do not widen the CHECK here without updating the
-- retirement migration's final-schema verification to match.
--
-- Each row pins the exact strategy boundary captured when a sourcing
-- generation actually started execution: either the approved revision/source
-- set at that moment, or an explicit legacy/advisory marker recording that
-- no approved strategy existed. Retries and new generations capture anew;
-- rows are never updated or backfilled. A generation with evidence but no
-- binding is pre-builder/uncertain and must fail closed (explicit new
-- generation required), never stamped with today's approval.
CREATE TABLE IF NOT EXISTS sourcing_generation_strategy_snapshots (
  sourcing_generation_id TEXT PRIMARY KEY REFERENCES sourcing_generations(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('approved', 'legacy_advisory')),
  strategy_revision INTEGER,
  normalized_brand TEXT,
  sources_json TEXT NOT NULL DEFAULT '[]',
  preferred_distributor_ids_json TEXT NOT NULL DEFAULT '[]',
  binding_version TEXT NOT NULL DEFAULT 'strategy-binding-v1',
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gen_strategy_snapshots_item ON sourcing_generation_strategy_snapshots(item_id);
CREATE INDEX IF NOT EXISTS idx_gen_strategy_snapshots_workspace ON sourcing_generation_strategy_snapshots(workspace_id);
