# ADR 0036 — Deslop via fallow: trace-verified dead-code deletion

- **Status:** Accepted
- **Relates to:** ADR 0030 (Agent Lab decommission — source of orphaned repos/panels), ADR 0034 (stage vocabulary), docs/plans/deslop-evidence-ledger.md (per-file trace evidence)

## Context

Fallow full-project scan (fallow 2.54.3): health score 69.6 grade C across 1535
files — 136 unused files, 1489 unused exports, 1203 unused types, 53 duplicate
exports, 4 circular dependencies, 42 stale suppressions, 14.5% duplication
(75k lines). Raw totals overstate the problem: 107 of 136 dead files are
vendored `.github/skills/impeccable` scripts (not our code), 16 "dead" scripts
are live CLI entries unreachable by import edges, and 1 "dead" test
(`src/extraction-worker/auth.test.ts`) is a live vitest entry. `.fallowrc.json`
carries 26 `exports:["*"]` star suppressions that hide unknown findings.

## Decision

**Deslop = trace-verified dead-code deletion, prod + tests scope, with docs and
a CI gate — not blind auto-fix.**

- **Scope:** `src/` production + `src/tests/` (654 unit files are the largest
  bloat surface). Vendor noise (`.github/skills/**`) is excluded from analysis
  via `ignorePatterns`, not deleted.
- **Proof standard (trace-verified only):** no deletion without (1) `fallow
  dead-code --trace-file` showing UNREACHABLE, (2) `rg` proving no static,
  dynamic (`import()`/`lazy`), test, migration, or docs-as-spec reference,
  (3) `bun run typecheck` + focused `vitest` + `fallow dead-code` re-run after
  the edit. `fallow fix --yes` is never run repo-wide.
- **Barrels are internal:** `src/classification/index.ts` (62) and
  `src/onboarding/profile-audit/index.ts` (47) re-exports are deletable when
  untraced. No new barrel-wide `ignoreExports` entries.
- **Star suppressions are audited, not kept:** each of the 26 `["*"]` entries
  is removed file-by-file with trace evidence, replaced only by narrow
  per-export ignores proven to be external/test/dynamic entries.
- **Scripts are entries, not dead code:** `scripts/*.ts` invoked via
  `package.json`, docs runbooks, or direct `bun scripts/` invocation are entry
  points (fallow config gap), deleted only when the invoking workflow is itself
  proven obsolete (e.g. v3/v4 release builders superseded by current release).
- **First cut:** the 12 `src/` unreachable files + 4 circular deps + 53
  duplicate-export canonicalizations, each gated by the ledger
  (`docs/plans/deslop-evidence-ledger.md`) safe/blocked split. Blocked items
  (plan-referenced orphans like `LlmTaskConfigPanel`, `SectionHeader`;
  migration-live tables like `profile_engineer_domain_workflows`) are kept
  until the owning plan/migration retires them.

## Considered Options

- **Aggressive `fallow fix --yes` repo-wide:** rejected — would delete CLI
  entries, live tests, and plan-referenced orphans the import graph cannot see.
- **Duplication-first (75k lines, god files):** rejected for first cut —
  larger blast radius and subjective merges; dead code first shrinks the
  consolidation surface.
- **Gate-only without deletion:** rejected — grade C with 35.8% dead-export
  ratio needs actual removal, not just prevention.

## Consequences

- `fallow audit --base main` becomes a CI gate (new findings fail the change;
  legacy backlog quarantined via `--save-baseline`/`--baseline`, never via new
  star suppressions).
- `CONTEXT.md` is unchanged: deslop terms (dead file/export, trace-verified,
  star suppression) are general engineering vocabulary, not project domain
  language per the domain-modeling format rules. The vocabulary lives here and
  in the ledger.
- Future "why is this export unexported / file deleted" questions resolve to
  this ADR + the ledger's trace evidence, not to archaeology.
