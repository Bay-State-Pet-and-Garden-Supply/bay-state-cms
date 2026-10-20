# Family push & recovery runbook (issue #373)

Carry a complete approved family group through package export or direct
ShopSite import/finalization/publish, and recover an interrupted push
without ever marking a partial family synced.

## Preconditions

- The change set is `approved` with a complete linked manifest
  (`committed`/`recovered`) over one immutable catalog commit (#363).
- No open/`in_reconcile` drift on any write OR unchanged referenced read
  SKU; no competing draft carries a group SKU.
- ShopSite connection configured (Basic merchant credentials live
  server-side only; never in tests or logs — artifacts are redacted).

## Normal push

1. Export (optional inspection): `POST /api/export/change-set/:id` —
   validates the complete-family plan and records `pushPayloadHash` +
   `pushSkus` on the package manifest.
2. Push: `POST /api/sync/push-publish { changeSetId }` (or `upload-only`
   to skip `generate.cgi`).
3. The route executes, in order: pages preflight → family plan (one
   unsplittable set, stable SKU order) → page reconciliation + `sha256Hex`
   of THOSE reconciled bytes (recorded as the payload identity, so hash ===
   uploaded === reconcile baseline) → pre-upload live census (doubles as
   the unchanged-member verification when the group carries reads, and as
   the reconcile baseline scope always) → MIME upload (`uniqueName=SKU`,
   `newRecords=yes`) → exact returned token through `dbmake.cgi` →
   fresh live census + complete-set reconcile (unexpected SKUs are only
   those outside the pre-upload baseline, so pre-existing store SKUs never
   fail the push) → `generate.cgi` (push-publish only, and ONLY on a
   reconciled success — a partial/unknown import never publishes) → synced
   marking (only on full reconcile).

## When it fails

- The error names the phase (plan / remote verification / upload / dbmake /
  publish / reconcile-unknown / reconcile-partial) and the job id.
- The approved operation is retained; every SKU stays unsynced; no
  replacement SKUs/parents are created; redacted CGI evidence lands under
  `exports/<jobId>/` (`dbupload.cgi.redacted.txt`,
  `dbmake.cgi.redacted.txt`, `generate.cgi.redacted.txt` when applicable).
- Never promise zero intermediate remote state: a dbmake transport failure
  after a successful upload is UNKNOWN — the store may have applied.

## Recovery

- `POST /api/sync/reconcile-push { changeSetId, jobId }` — re-checks
  without retransmitting. Re-runs the push path's drift and staleness
  gates first (a worktree edit or unresolved drift landing after the
  failed push refuses instead of syncing), re-derives the page-reconciled
  bytes against the current active Pages import (a Pages move between the
  push and the reconcile fails closed — resume instead), then replays the
  reconcile verdict scoped by the SAME change set's recorded pre-upload
  baseline. An explicit `jobId` with no baseline is unknowable — reconcile
  refuses (never another attempt's store state). Use first when the failure
  came after upload (dbmake/reconcile phases) or when the outcome is
  unknown. Marks exactly the reconciled complete set synced on success.
- `POST /api/sync/resume-push { changeSetId, publish }` — retransmits the
  byte-identical approved payload (deterministic over the immutable load
  plus current Pages state — a Pages change between attempts moves the
  active import and fails closed at page reconciliation instead of
  transmitting a moved-on payload) and runs the full pipeline again. Use
  when nothing reached the store (upload/auth failure) or after resolving
  a remote-verification blocker (include the missing complete record in the
  approved group first). Refuses `backfillMode` (family resume must upload
  `newRecords=yes`; backfill update-only would silently drop new children).
- Both preserve operator context: the same change set, same commit, same
  payload hash. Retries never leave a misleading success or spinner — the
  UI surfaces the verdict plus the recovery action.

## What never happens

- Subset/entire-family synced marking on partial/unknown outcomes.
- Update-only uploads for family pushes (new children would vanish).
- Silent payload rewrites from later working-tree edits (stale refuses).
- Unrelated field/price/inventory/rights/enablement writes (sync pointers
  only, and only on full reconcile).
