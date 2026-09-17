# Manual-Evidence Runbook (parent #101)

How the manual-evidence extraction route behaves. **The route is always
available** (no toggle): profile-blocked items offer manual entry as a
fallback, and every submission is an explicit, audited operator act on an
already-blocked item. Automated behavior is unchanged — the worker never
writes manual rows.

Exemplar: The Butcher's Pup (family/parent page only, no per-SKU product
pages, no healthy extractor profile possible within Profile Scope).

## Quick reference

| Eligible items | Pipeline Board → Needs Attention → `manual_evidence_available` |
| Manual entry UI | Official Site Resolution workspace → manual phase |
| Withdraw a submission | Same drawer → **Withdraw manual evidence** |
| Retry after withdraw | Settings → profile retry preview (failed items only) |

## Availability

There is no flag. Profile-blocked / triaged family-page-only items always
surface `manual_evidence_available`, and submit is always accepted for
eligible items. (The retired `BAYSTATE_CMS_MANUAL_EVIDENCE_ENABLED` toggle
was removed per owner decision: manual evidence is a permanent fallback,
and Review hold + per-item withdraw are the safety net. If the key still
exists in a local `.env` or shell export, it is dead configuration — unset
it.)

## What the route does

- **Entry.** Only from `extraction/failed`: either the profile-blocked
  signature (`No extractor profile for %`) or a non-profile failure the
  operator explicitly confirms as family-page-only. Sourcing, discovery,
  never-attempted, curation, promotion, and already-completed items all
  reject with distinct codes — there is no Sourcing→Curation path.
- **Submission.** One audited API action per SKU: raw fields (title required;
  brand/description/bullets/weight/dimensions/images optional) + booleans +
  optional reference-only family URL/text. The server derives all provenance
  (`fieldProvenance='user'`, `extractionMethod='manual_evidence_v1'`,
  NULL extraction source URL, identity `parent_product_only` with a reference
  or `insufficient_evidence` without, zero confidence, no sourcing-generation
  linkage) and links the required attestation row. Double submit replays
  idempotently; nothing is written until every guard passes, in one
  transaction.
- **Downstream.** Manual rows emit operator-manual, low-reliability evidence
  (NULL URL) into Curation, count as provided-but-unreviewed in Review, and
  promote like any official-page row once review accepts and image rights
  approve. The Family Readiness Barrier and cohort semantic validation apply
  with no exemption.
- **Retry.** The profile-retry preview lists `extraction/failed` items only,
  so manual-completed items are excluded by default. The retry endpoint
  additionally refuses active-manual items (`409`,
  `manual_evidence_active_retry_rejected`) — withdraw first, then retry per
  item. The automated worker never writes manual rows (pinned by suite).
- **No backfill.** Legacy rows, already-completed rows, and distributor rows
  are never converted. Migrations are additive; boot verification fails
  closed on invariant violation instead of repairing.

## Observation queries (read-only, sqlite)

```sql
-- Blocked-by-domain candidates for manual triage
SELECT COALESCE(brand_hint, '(no brand)') AS brand, COUNT(*) AS blocked
FROM onboarding_items
WHERE stage = 'extraction' AND stage_status = 'failed'
GROUP BY brand_hint ORDER BY blocked DESC;

-- Manual rows in flight
SELECT COUNT(*) FROM onboarding_extractions
WHERE extraction_method = 'manual_evidence_v1';

-- Attestation coverage (every manual row must join an active attestation)
SELECT e.id
FROM onboarding_extractions e
LEFT JOIN onboarding_manual_evidence_attestations a
  ON a.attestation_id = e.manual_attestation_id AND a.superseded_at IS NULL
WHERE e.extraction_method = 'manual_evidence_v1' AND a.attestation_id IS NULL;

-- Gate refusal codes surface in review-completion responses; aggregate from
-- application logs by matching: manual_attestation_missing,
-- manual_attestation_incomplete, manual_family_inheritance_suspected,
-- manual_image_rights_missing.
```

All three SQL queries must return sensible results on a scratch copy after
restores or migrations; the coverage query must return zero rows.

## Operator trial (first use in a new environment)

1. Verify a current database backup (`sqlite-backup-verifier` pattern) and
   confirm the observation queries above on a scratch copy.
2. Trial on one profile-blocked, family-page-only SKU: submit, verify
   `extraction/completed` with attestation id, verify review holds it as
   unreviewed, then withdraw and verify the blocked state returns.
3. Roll out to operators with the attestation checklist guidance (no family
   inheritance, per-SKU verified, image rights).

## Incident control

- There is no kill switch. Stop bad submissions by holding the affected
  items in Review and withdrawing per item — withdraw returns the item to
  the fail-closed blocked state and is never gated, so an active-manual
  item is always either retryable-after-withdraw or withdrawable.
  No migration rollback is needed (all schema additions additive).
- Boot-time verification throws (refuses boot, never repairs) only on genuine
  invariant violations: changed source-type vocabulary, manual rows with a
  URL/generation/non-official type/missing attestation, or attestations with
  empty checklist/hash JSON. Resolve the violating rows from backup; do not
  hand-edit production rows.
