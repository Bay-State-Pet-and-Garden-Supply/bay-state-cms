# ADR 0037 — Manual evidence is always available (no toggle)

- **Status:** Accepted
- **Relates to:** Parent #101 (manual-evidence route), `docs/runbooks/manual-evidence-rollout.md`, CONTEXT.md (`Manual Evidence` glossary)

## Context

The manual-evidence route was built behind a fail-closed DEFAULT-OFF env
toggle (`BAYSTATE_CMS_MANUAL_EVIDENCE_ENABLED`), gating both submit and the
Pipeline Board projection. The owner questioned the toggle itself: profiles
and distributors will never cover every brand (exemplar: The Butcher's Pup —
family page only, no per-SKU pages possible), so operator transcription needs
to be a permanent fallback, not a gated capability.

## Decision

**No toggle. Profile-blocked / triaged family-page-only items always surface
`manual_evidence_available`, and submit is always accepted for eligible items.**
The safety net is Review hold (manual rows count as provided-but-unreviewed)
plus per-item withdraw back to the fail-closed blocked state — withdraw was
already ungated and stays that way, so an active-manual item is never stranded.
Entry scope is unchanged: extraction/failed only, distributor/completed/legacy
rows never converted. Profiles remain the happy path (CONTEXT.md glossary).

## Considered Options

- **Keep the flag:** rejected — env-gated UX for a permanent workflow, plus
  real drift cost (the flag's own test failed on ambient `.env`/shell config).
- **Default-ON flag with env OFF as brake:** rejected — keeps the drift and
  the false promise of a global brake for what is inherently a per-item
  judgement call.
- **Per-brand control:** rejected for now — no evidence operators need it;
  re-open if bypass volume ever justifies it (submits carry reason codes in
  logs for that audit).

## Consequences

- No kill switch: incidents are handled by holding items in Review and
  withdrawing per item. The runbook documents this.
- `BAYSTATE_CMS_MANUAL_EVIDENCE_ENABLED` in local `.env`/shell exports is dead
  configuration — unset it.
- Telemetry counts `manual_evidence_available` as profile-blocked so the block
  rate keeps its meaning. The `extractor_profile_required` projection branch
  is gone from the work-state mapping; the client still handles the reason if
  it ever recurs.
