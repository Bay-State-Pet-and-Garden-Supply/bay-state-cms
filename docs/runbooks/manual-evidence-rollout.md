# Manual-Evidence Rollout Runbook (parent #101)

How the manual-evidence extraction route behaves and how to enable it safely.
**The capability is DEFAULT OFF**: a missing
`BAYSTATE_CMS_MANUAL_EVIDENCE_ENABLED` means disabled. Enabling alone changes
no automated behavior — every submission is an explicit, audited operator act
on an already-blocked item.

Exemplar: The Butcher's Pup (family/parent page only, no per-SKU product
pages, no healthy extractor profile possible within Profile Scope).

## Quick reference

| Action | Command / location |
|---|---|
| Enable | `BAYSTATE_CMS_MANUAL_EVIDENCE_ENABLED=true` + restart |
| Kill switch (OFF) | unset the key, or `=false` + restart |
| Eligible items | Pipeline Board → Needs Attention → `manual_evidence_available` |
| Manual entry UI | Official Site Resolution workspace → manual phase |
| Withdraw a submission | Same drawer → **Withdraw manual evidence** |
| Retry after withdraw | Settings → profile retry preview (failed items only) |

### Flag parsing (fail-closed)

The flag is re-read from the environment per call. There is no `.env.example`
in this repo — set the key in the process environment directly.

| Input | Effective state | reason |
|---|---|---|
| env key absent | disabled | `disabled_default` |
| `true` / `1` / `yes` (trimmed, case-insensitive) | enabled | `env_enabled` |
| `false` / `0` / `no` (trimmed, case-insensitive) | disabled | `env_disabled` |
| empty / whitespace / unparseable | disabled | `malformed_config` |
| in-memory runtime override in effect | per override | `override` |

Reason codes are stable and non-secret. In-memory overrides are test-only.

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

All three SQL queries must return sensible results on a scratch copy before
enabling in any shared environment; the coverage query must return zero rows.

## Enable procedure

1. Verify a current database backup (`sqlite-backup-verifier` pattern) and
   confirm the observation queries above on a scratch copy.
2. Set `BAYSTATE_CMS_MANUAL_EVIDENCE_ENABLED=true` in the environment and
   restart. Confirm no behavior change for non-blocked items.
3. Trial on one profile-blocked, family-page-only SKU: submit, verify
   `extraction/completed` with attestation id, verify review holds it as
   unreviewed, then withdraw and verify the blocked state returns.
4. Roll out to operators with the attestation checklist guidance (no family
   inheritance, per-SKU verified, image rights).

## Incident rollback

- Set the key to `false` (or unset it) + restart. New submissions stop
  immediately; existing manual rows stay gated by Review and can be withdrawn
  per item — withdraw is deliberately NOT flag-gated so the kill-switch can
  never strand an active-manual item in a state that is neither retryable
  (retry refuses active-manual items withdraw-first) nor withdrawable.
  No migration rollback is needed (all schema additions additive).
- Boot-time verification throws (refuses boot, never repairs) only on genuine
  invariant violations: changed source-type vocabulary, manual rows with a
  URL/generation/non-official type/missing attestation, or attestations with
  empty checklist/hash JSON. Resolve the violating rows from backup; do not
  hand-edit production rows.
