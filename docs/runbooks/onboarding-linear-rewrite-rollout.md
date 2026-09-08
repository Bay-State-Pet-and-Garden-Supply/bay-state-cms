# Onboarding linear-rewrite rollout runbook (Slice 7 — board deleted, fallback retired)

**Status:** Slice 7 implemented. `src/client/components/PipelineBoard.tsx`
is DELETED (zero-mount evidence + grace interval + manual acceptance); the
diagnostics flag is removed; the temporary classic primary branch is removed
(`shellV2Enabled=false` is now the emergency disabled-content state);
`?board=pipeline` with or without `?batch=` renders the shell/batches list
with a retirement notice. Rollback uses the archived matching bridge client.
NO live DB upgrade is authorized in this tranche. Migration execution remains
a separately approved operational action with its own downtime, backup, and
quiescence gates.

## 1. Vocabulary

v1 storage: `sourcing discovery extraction curation review promotion`.
v2 canonical: `route_sources find_product_page collect_details prepare_listing
review_listings create_drafts`. Statuses unchanged
(`pending in_progress completed failed needs_input skipped`).

## 2. Bridge build (pinned, §5.6)

- Runtime pin: **Bun 1.3.5** (`bun --version`, `bun --revision`, executable
  SHA-256), TypeScript **5.9.3**, platform/arch, `package.json`/`bun.lock`/
  `tsconfig.json` hashes, per-input source/asset hashes.
- Command:
  `bun scripts/build-onboarding-stage-bridge.ts --source-root "$PWD" --output-parent /tmp --prefix baystate-onboarding-bridge- --write-pointer /tmp/baystate-onboarding-bridge-current.json`
- Compiler invocation inside: `bun build --target=bun --format=esm --splitting
  --packages=external --root . --outdir "$BRIDGE_ROOT/bun"
  src/server/index.ts src/server/app.ts scripts/onboarding-stage-compat-smoke.ts`
- Client: `VITE_BATCH_WORKSPACE_ENABLED=true VITE_ONBOARDING_SHELL_V2=false
  VITE_BRAND_GATE_V2=false VITE_EXECUTION_STRIP_V2=false
  VITE_PIPELINE_DIAGNOSTICS_ENABLED=false bun node_modules/vite/bin/vite.js build
  --outDir "$BRIDGE_ROOT/client"`
- Manifest locations (fixed): `$BRIDGE_ROOT/bridge-manifest.json`,
  `$BRIDGE_ROOT/bridge-manifest.sha256`, `$BRIDGE_ROOT/SHA256SUMS`,
  `$BRIDGE_ROOT/build.log`, `$BRIDGE_ROOT/versions.txt`.

## 3. Emitted-artifact proof

- Provision: `ONBOARDING_BRIDGE_MANIFEST="$BRIDGE_ROOT/bridge-manifest.json"`.
  Missing/checksum-mismatched input FAILS the suite (never skips/rebuilds).
- Command:
  `ONBOARDING_BRIDGE_MANIFEST="$BRIDGE_ROOT/bridge-manifest.json" bun test --timeout 120000 src/tests/unit/onboarding-stage-rollback-bridge.test.ts`
- Child argv (exact): `bun "$BRIDGE_ROOT/bun/scripts/onboarding-stage-compat-smoke.js"
  --fixture-root "$FIXTURE_ROOT" --db "$FIXTURE_ROOT/db/app.db" --workspace
  "$FIXTURE_ROOT/workspace" --scenario migrated-edited-v2
  --expected-storage-version 2 --manifest "$BRIDGE_ROOT/bridge-manifest.json"
  --report "$FIXTURE_ROOT/bridge-result.json"`
- Child env (fresh, not inherited): `NODE_ENV=test TZ=UTC LANG=C LC_ALL=C
  HOME=$FIXTURE_ROOT/home TMPDIR=$FIXTURE_ROOT/tmp
  ONBOARDING_COMPAT_FIXTURE_ROOT=$FIXTURE_ROOT` + manifest-pinned `PATH` +
  generated `BAYSTATE_CMS_API_TOKEN`. 30s child budget; 120s outer budget.
- Parent seeds v1 history → sanctioned migration → v2 edits, closes, spawns
  the child, then independently re-verifies rows/hashes/side effects.

## 6. Slice 6 — controlled default-on + PipelineBoard mount retirement (IMPLEMENTED; Slice 7 follows in §6a)

### 6.1 Flag defaults (rollout order: shell first, then brand gate + strip)

| Flag | Slice 6 default | Kill-switch |
|---|---|---|
| `VITE_ONBOARDING_SHELL_V2` | `true` (sole shell default-on) | `false\|0\|no` ⇒ classic grace navigation inside `BatchWorkspace` (never the board) |
| `VITE_BRAND_GATE_V2` | `true` (requires shell flag) | `false\|0\|no` ⇒ brand view unavailable; existing Settings/attention actions stay authoritative |
| `VITE_EXECUTION_STRIP_V2` | `true` (requires shell flag) | `false\|0\|no` ⇒ strip unmounted; no DB/worker change |
| `VITE_BATCH_WORKSPACE_ENABLED` | `true` (deprecated) | `false` is now a **no-op**: the sole shell always mounts (workspace-disabled branch retired) |
| `VITE_PIPELINE_DIAGNOSTICS_ENABLED` | **REMOVED in Slice 7** | Flag retired with the deleted board file. `?board=pipeline` (with or without `?batch=`) always resolves to the shell/batches list with a retirement notice — gated by no flag |
| `VITE_REVIEW_UI_V2` | `true` (UNCHANGED) | Untouched by this rewrite; tested noninterference |

Env flags are build-time cached (`CACHED_ENV_FLAGS`); tests/emergency
in-session overrides use `overrideOnboardingFeatureFlags` +
`resetOnboardingFeatureFlags` (isolation covered in
`onboarding-feature-flags.test.ts`).

### 6.2 Mount retirement

- `Onboarding.tsx` has zero `PipelineBoard` imports/mounts (both the
explicit-diagnostics mount and the workspace-disabled fallback are gone).
- `?board=pipeline` (with or without the diagnostics flag, workspace on or
off) renders `BatchWorkspace` + a `retired-diagnostics` retirement notice
(`data-testid="retired-diagnostics-notice"): never a board mount, never a
dead screen, never `Unavailable`.
- `shellV2Enabled=false` selects the emergency disabled-content state
(`data-testid="shell-disabled-notice"`: header + rollback instruction, no
brand/strip/old navigation); Slice 7 removed the temporary classic grace
navigation. Classic rollback after Slice 7 uses the
archived matching bridge client, never PipelineBoard.
- `PipelineBoard.tsx` is DELETED in Slice 7 after the Slice 6
verified-unreachable interval (see
`docs/plans/onboarding-shell-retirement-inventory.md` §§6–8 for the deletion
allowlist and export/coverage diff).

### 6.3 Verification (Slice 6 acceptance evidence)

- Retired truth-table ledger
`src/tests/fixtures/onboarding-shell-matrix-retired.json` (656 cases: 640
factored W/D/Q × S/B/E × T + 16 brand-setup/unsupported extras) green
against `resolveRetiredShell` (`onboarding-shell-mounts-retired.test.ts`).
- Pre-retirement ledger still green against retained `resolveLinearShell`.
- Import-graph gate green:
`bun scripts/audit-onboarding-shell-imports.ts --check
docs/plans/onboarding-shell-retirement-inventory.md` (+ self-tests in
`onboarding-shell-imports.test.ts`: direct/aliased/barrel/require/lazy-dynamic/concatenated/glob/CSS/JSX detection, clean-tree determinism).
- Flag suites green (`onboarding-feature-flags.test.ts`: Slice 6 defaults,
kill-switch parser, override/reset + REVIEW_UI_V2 isolation).
- Operator-flow mounts green (`onboarding-linear-shell.test.tsx`:
attention resolution, full-batch review, family waiting, approval,
export-draft surfaces; outcome separation; unsupported-link state).
- Browser walkthrough (this slice): default-on linear shell, rollback grace
mode (`VITE_ONBOARDING_SHELL_V2=false`), and the `?board=pipeline`
retirement notice — screenshots/logs outside the repo (§7 packet).

## 6a. Slice 7 — board deletion + fallback retirement (IMPLEMENTED)

- `src/client/components/PipelineBoard.tsx` deleted (§§6–8 of the
retirement inventory: single-export/coverage diff, zero production edges
before AND after, zero helper/style/test deletions — reviewed allowlist
empty for helpers).
- `pipelineDiagnosticsEnabled` removed from
`src/client/onboarding-feature-flags.ts`; exact UI flag keys are now five
(`batchWorkspaceEnabled`, `shellV2Enabled`, `brandGateV2Enabled`,
`executionStripV2Enabled`, `reviewUiV2`).
- `?board=pipeline` with no `?batch=` renders the `retired-diagnostics`
notice above the batches list (P2); with `?batch=` it renders above the
Batch Workspace as in Slice 6.
- Temporary `ClassicWorkspace` primary branch removed from
`BatchWorkspace.tsx`; `shellV2Enabled=false` renders
`shell-disabled-notice` (header + archived-bridge-client rollback
instruction). `WorkStateTabs`/`batch-workspace-logic` retained as secondary
operation navigation/helpers; every frozen operation view preserved.
- Verification: audit gate green before AND after deletion; retired +
pre-retirement ledgers green; flag/logic/import/matrix/linear-shell
(incl. the one documented frozen-review mock flake)/brand-gate/strip
suites per the §7 packet; browser walkthrough of the final shell + both
notice paths (screenshots/logs outside the repo).

## 7. Sanctioned application sequence (future, gated — NOT executed here)

1. Approve vocabulary, inventory, binaries, rehearsal evidence, downtime.
2. Quiesce ALL writers; exclusive maintenance access; abort on unprovable in-flight writes.
3. Verified standalone backup (`src/db/sqlite-backup-verifier.ts`, VACUUM INTO,
   immutable verification, identity/hash) + rename-specific protected tables.
4. Dry-run inventory (known stages only, markers complete, identity match).
5. One atomic transaction: six stage-only updates + version marker + receipt.
6. Verify 6×6 bijection, zero v1 rows, immutable bytes/hashes, FK/integrity;
   rerun is a no-op.
7. Start approved v2/bridge binary; read-only probes; resume under existing
   claim/lease CAS recovery; reopen traffic.

## 5. Rollback

Supported rollback = tested bridge binary + client from the frozen artifact
(metadata/data unchanged). Backup restore = disaster recovery only. Never run
an unmodified pre-bridge binary on v2 storage.
