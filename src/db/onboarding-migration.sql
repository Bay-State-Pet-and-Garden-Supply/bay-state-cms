-- Onboarding Pipeline Migration
-- Adds tables for the product onboarding pipeline: spreadsheet import,
-- source discovery, page extraction, and draft promotion.

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL UNIQUE,
  api_key TEXT NOT NULL,
  base_url TEXT,
  model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS onboarding_batches (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  name TEXT NOT NULL,
  file_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  execution_state TEXT NOT NULL DEFAULT 'draft',
  total_items INTEGER NOT NULL DEFAULT 0,
  completed_items INTEGER NOT NULL DEFAULT 0,
  failed_items INTEGER NOT NULL DEFAULT 0,
  column_mapping_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS onboarding_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES onboarding_batches(id) ON DELETE CASCADE,
  upc TEXT NOT NULL,
  name TEXT NOT NULL,
  price TEXT,
  quantity INTEGER,
  brand_hint TEXT,
  department_hint TEXT,
  source_url TEXT,
  expected_name TEXT,
  status TEXT NOT NULL DEFAULT 'imported',
  is_held INTEGER NOT NULL DEFAULT 0,
  held_reason TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  is_duplicate INTEGER NOT NULL DEFAULT 0,
  existing_sku TEXT,
  extraction_data_json TEXT,
  curation_data_json TEXT,
  raw_identity_json TEXT,
  normalized_identity_json TEXT,
  identity_normalizer_version INTEGER,
  identity_provenance_hash TEXT,
  row_number INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  manual_reference_url TEXT
);

CREATE TABLE IF NOT EXISTS onboarding_sources (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  snippet TEXT,
  domain TEXT,
  confidence REAL NOT NULL DEFAULT 0.0,
  is_selected INTEGER NOT NULL DEFAULT 0,
  source_method TEXT NOT NULL DEFAULT 'unknown',
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS onboarding_extractions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
  source_url TEXT,
  extraction_data_json TEXT NOT NULL,
  extraction_method TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.0,
  images_json TEXT,
  raw_structured_data_json TEXT,
  source_type TEXT NOT NULL DEFAULT 'official_page' CHECK (source_type IN ('official_page', 'distributor_record')),
  sourcing_generation_id TEXT,
  accepted_evidence_attempt_ids_json TEXT,
  evidence_hash TEXT,
  manual_attestation_id TEXT,
  created_at TEXT NOT NULL
);

-- Manual-evidence attestation store (parent #101, ticket #102 foundation).
-- One row per operator submission; family_reference_url is reference-only.
CREATE TABLE IF NOT EXISTS onboarding_manual_evidence_attestations (
  attestation_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
  batch_id TEXT,
  operator_id TEXT NOT NULL,
  attested_at TEXT NOT NULL,
  family_reference_url TEXT,
  field_checklist_json TEXT NOT NULL,
  value_hashes_json TEXT NOT NULL,
  image_rights_json TEXT,
  family_reference_text TEXT,
  superseded_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS brand_sites (
  id TEXT PRIMARY KEY,
  brand_name TEXT NOT NULL,
  domain TEXT NOT NULL,
  url_pattern TEXT,
  success_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(brand_name, domain)
);

CREATE TABLE IF NOT EXISTS extractor_profiles (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  title_selector TEXT,
  price_selector TEXT,
  description_selector TEXT,
  brand_selector TEXT,
  images_selector TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_onboarding_batches_workspace ON onboarding_batches(workspace_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_items_batch ON onboarding_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_items_status ON onboarding_items(status);
CREATE INDEX IF NOT EXISTS idx_onboarding_items_upc ON onboarding_items(upc);
CREATE INDEX IF NOT EXISTS idx_onboarding_sources_item ON onboarding_sources(item_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_extractions_item ON onboarding_extractions(item_id);
CREATE INDEX IF NOT EXISTS idx_manual_evidence_attestations_item ON onboarding_manual_evidence_attestations(item_id);
CREATE INDEX IF NOT EXISTS idx_brand_sites_brand ON brand_sites(brand_name);
CREATE INDEX IF NOT EXISTS idx_extractor_profiles_domain ON extractor_profiles(domain);

-- Variant resolution durable table (issue #90)
CREATE TABLE IF NOT EXISTS onboarding_variant_resolutions (
  id TEXT PRIMARY KEY,
  onboarding_item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  canonical_parent_key TEXT NOT NULL,
  platform TEXT NOT NULL,
  parser_version INTEGER NOT NULL,
  identity_matrix_hash TEXT NOT NULL,
  source_content_hash TEXT,
  status TEXT NOT NULL CHECK(status IN ('resolved','ambiguous','no_match','unsupported','too_many_variants','selected','stale')),
  reason_codes_json TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  automatic_variant_key TEXT,
  selected_variant_key TEXT,
  decision_origin TEXT CHECK(decision_origin IN ('automatic','operator')),
  decided_at TEXT,
  superseded_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_variant_res_item ON onboarding_variant_resolutions(onboarding_item_id);
CREATE INDEX IF NOT EXISTS idx_variant_res_item_hash ON onboarding_variant_resolutions(onboarding_item_id, identity_matrix_hash);
CREATE INDEX IF NOT EXISTS idx_variant_res_status ON onboarding_variant_resolutions(status);
