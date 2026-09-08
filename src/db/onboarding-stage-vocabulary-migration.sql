-- Onboarding stage-vocabulary rename backfill (Slice 5a design, NOT executed).
--
-- Scope: stage spelling ONLY on `onboarding_items.stage`. Six statements, one
-- per v1 literal, each idempotent and order-independent. No history, receipt,
-- evidence, review, cohort, observer, status, or timestamp rewrite.
--
-- Preconditions (enforced by onboarding-stage-vocabulary-repo.ts, not here):
--   * app_meta.operator_state_schema_version = '2' (deferred marker-1→2 hop done)
--   * no unknown/null/empty stage values (SELECT inventory query below = 0)
--   * expected source identity + verified backup manifest match
--   * exclusive writer gate held (maintenance transaction)
--
-- Postconditions: zero v1 literals remain; 6x6 semantic count bijection holds.

UPDATE onboarding_items SET stage = 'route_sources', updated_at = updated_at WHERE stage = 'sourcing';
UPDATE onboarding_items SET stage = 'find_product_page', updated_at = updated_at WHERE stage = 'discovery';
UPDATE onboarding_items SET stage = 'collect_details', updated_at = updated_at WHERE stage = 'extraction';
UPDATE onboarding_items SET stage = 'prepare_listing', updated_at = updated_at WHERE stage = 'curation';
UPDATE onboarding_items SET stage = 'review_listings', updated_at = updated_at WHERE stage = 'review';
UPDATE onboarding_items SET stage = 'create_drafts', updated_at = updated_at WHERE stage = 'promotion';

-- Inventory probe (read-only): rows that would BLOCK the migration.
-- SELECT stage, COUNT(*) FROM onboarding_items
--  WHERE stage IS NULL OR stage NOT IN
--   ('sourcing','discovery','extraction','curation','review','promotion',
--    'route_sources','find_product_page','collect_details','prepare_listing',
--    'review_listings','create_drafts')
--  GROUP BY stage;
