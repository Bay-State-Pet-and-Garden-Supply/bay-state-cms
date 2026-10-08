# Generation-1 freeze plan (REWRITTEN 2026-10-08 after NO-FREEZE review)

Status: PLAN v2 — supersedes the 93/26 family-hash split (withdrawn —
spec §4 requires a *new unexposed* holdout; re-splitting 119 public
dev rows cannot satisfy it).

## What the review proved

- 8/119 rows share normalized canonical URLs with v1/v2 public banks
  (reviewer found 6; sweep found 2 more same-family earthbath rows).
  SKU/family-ID comparison missed them because v1 SKU hashes differ.
- All 119 rows are public-bank dev rows; no unexposed holdout exists.
- 6 type/field labeling errors + blanket-inapplicable field states
  (all remediated 2026-10-08, see gold status notes).

## Remediation applied

- 8 exposed rows quarantined to `quarantined-exposed-rows.json`;
  111 rows remain (87 known + 24 NO-FIT).
- Field states derived from frozen profile membership + invariants +
  excerpt evidence; canonical values verified against v9 vocabularies.
- Containment asserted via `findGoldOutsideFrozenTaxonomy` (see
  verification log in the remediation commit).

## Freeze shape (v2)

- **Dev: 111 rows** (this generation, public, peer-receipted).
- **Holdout: 0 rows here** — a fresh holdout is sourced ONLY from
  canonical URLs absent from every prior artifact (v1–v9 +
  expansion banks), sealed before any adjudication, at the spec's
  200-row / 20-per-class floors. No family-hash re-split of dev rows.
- Batch-3+ rows join generation-1 dev only when their normalized
  canonical URLs are absent from all prior artifacts AND their
  families are disjoint from these 111. The URL gate is now part of
  the batch builder (not a post-hoc sweep).

## Freeze steps

1. Family-ID materialization (DONE 2026-10-08): survivors joined to
   adjudication-file familyIds — 111 rows / 111 distinct families,
   0 placeholders, split=dev preserved.
2. URL-gate verification: every generation-1 dev URL absent from
   v1–v9 representative banks (re-run sweep, attach log). The
   expansion banks are this generation's own provenance, not an
   exclusion set — dev rows trivially appear there.
3. Peer receipt: independent re-derivation of counts, hashes,
   containment, and URL-gate proof.
4. Holdout sourcing (separate track, sealed custody first).
