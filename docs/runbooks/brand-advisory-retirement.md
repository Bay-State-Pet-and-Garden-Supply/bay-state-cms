# Runbook — Brand advisory settings retirement (issue #150 / ADR 0035 B1.1)

Retires the brand strategy builder's advisory settings — aliases, sourcing
policy, preferred distributors — and the `brand_advisory_profiles` table.
New unapproved/no-brand collection uses versioned query-all routing;
approved strategies run only their frozen Included boundary.

Owner acknowledgement of the cost/behavior consequences below is a
merge/deployment gate. This runbook is operator-owned; implementation
proves behavior on temporary fixtures only and never migrates production.

## 1. Downtime and cutover shape

- Stop-the-world cutover: stop/quiesce API, sourcing/Discovery observation,
  and extraction workers. Pin `BAYSTATE_CMS_SOURCING_ENABLED=false` using
  sanctioned operations and verify disabled capability. No old/new code
  processes may overlap.
- Deploy API/client/worker code as one cutover; the migration final marker
  (`brand_advisory_retirement_schema_version = '1'`) must be present before
  workers start. Failure means stop, no partial service start.
- Require client reload. Old advisory payloads fail 400; pre-retirement
  mapping tokens fail stale-configuration 409; nothing is silently
  rewritten or retried. Read/proposal pages create no approvals.

## 2. Compatibility

| Before | After |
|---|---|
| `advisory` (default) unapproved routing | query-all (unchanged behavior, now the only rule) |
| `preferred_then_fallback` (early stop on qualified found) | query-all: every enabled connection runs even after qualified found |
| `preferred_only` (spend-control filter) | query-all: **removed without replacement** — can increase attempts, spend, latency, detected conflicts |
| Advisory CRUD `GET/POST/DELETE /api/onboarding/settings/brand-profiles` | **removed** (404, never empty-success shims) |
| Approve payload with `aliases` / `preferredDistributorIds` / `sourcingPolicy` | **400** `invalid_strategy`, even empty/default-valued |
| Pre-retirement `expectedConfigurationToken` | **409** `stale_configuration` (new `brand-strategy-mapping-configuration-v2` hash domain) |
| v1 `approved` pins | frozen, executable under the captured source set |
| v1 `legacy_advisory` pins | historical only; worker parks with “This generation used retired brand routing settings. Retry to start a new generation under query-all routing.” until an explicit retry/reset starts a new generation |
| Advisory-only brand names in Settings suggestions | disappear (recoverable from backup); mapped, stored-approval, catalog, and onboarding-hint names remain |
| Historical `preferred_distributor_ids_json` snapshot bytes | retained for audit; never configuration or execution authority |

An operator can bound future brand collection by explicitly approving
Included sources; connection disablement and the global capability kill
switch remain separate controls. Do not bulk auto-retry parked
generations. Completed/historical/reviewed items remain untouched.

## 3. Cost disclosure (owner acknowledgement required before merge)

- Removing `preferred_only` removes a spend-control knob; removing
  `preferred_then_fallback` removes an early stop. Old bound unapproved
  work pauses for explicit retry (backlog size unknown until the
  backup inventory below).
- No spend estimate is invented offline: estimate affected
  brands/generations/connections from a **read-only backup**, not live
  probes, and record owner acknowledgement in the issue/release notes.

## 4. Inventory (credential-free, from the offline backup, stored outside repositories)

Counts by old policy, advisory-only names, active legacy-bound
generations, approved pins, enabled connection count, table/schema/marker
state, and protected-row digests. The full DB may contain secrets and is
never a Git artifact.

## 5. Backup

Use the approved SQLite backup method, never a live WAL-mode `.db` copy:

`bun run classification:integrity backup --db <absolute-source.db> --backup <absolute-outside-repositories-backup.db>`

Require verifier success: correct source identity, quiescence, complete
checksums/manifest, integrity/FK evidence, protected-table counts/digests,
and an independent readable backup (no required backup WAL/SHM). Confirm
free disk for source + WAL + verified backup + working/rehearsal DB +
snapshot table rebuild. Do not migrate on a stale/wrong-source/incomplete
backup.

## 6. Rehearsal

Rehearse the exact release's migration on a disposable copy: verify
fresh/upgrade/idempotence results and end-to-end mocked Save/GET/engine/
worker behavior without paid connectors. Rehearse restore using a
disposable destination. Record hashes/return codes. Never restore over the
source as a rehearsal.

## 7. Cutover verification

Retired table absent, snapshot schema widened with old rows preserved, no
new strategy approvals or generation backfills, protected counts/digests
unchanged, all FKs/integrity checks pass. Resume only under
owner-approved capability/mode settings with existing per-connector safety
gates unchanged. A parked old-generation item requires the existing
`/api/onboarding/items/:id/retry` or authorized reset route with sourcing
active to supersede its generation.

## 8. Rollback

- **Immediate containment:** keep/restore capability OFF and stop workers;
  preserve current DB/evidence and any post-cutover diagnostic artifacts.
  No auto-undo of approvals/evidence.
- **Code-only downgrade is not a safe rollback:** old code still queries
  the deleted advisory table, understands only v1 modes, and cannot
  interpret new query-all pins. Do not recreate an empty table/default
  preferences as a shim; that loses the original spend boundary.
- **Before post-upgrade business writes:** with downtime and explicit
  authorization, restore the verified pre-upgrade backup using the approved
  procedure and a matched pre-retirement code/client version; verify
  source/restore hashes, schema markers, row counts/FKs. Keep capability
  OFF until checked.
- **After business writes/new query-all generations:** an automatic
  old-backup restore would discard new approvals/evidence. Preserve both
  snapshots and stop for an owner-approved recovery plan. Prefer an
  explicitly reviewed forward fix; no fabricated down migration or blind
  replay of old advisory policies.
