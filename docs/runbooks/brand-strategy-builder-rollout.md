# Brand Strategy Builder rollout (plan slices B0–B2)

Backend-only tranche: guarded atomic Save + source/config read model (B1) and
durable generation binding + worker fail-closed guard (B2). No user-facing
builder is activated by this tranche (B3–B5 are separate).

## Safety gates

1. Disposable-database proof only. Never run migrations against live storage
   as part of this tranche. Quiesce workers and mutating clients before any
   separately authorized live migration.
2. Additive migrations only (`CREATE TABLE IF NOT EXISTS`, new marker
   `brand_strategy_builder_schema_version = 1`). No `ALTER` of existing
   tables, no backfill of `sourcing_generation_strategy_snapshots`, no replay
   of historical generations.
3. The guarded Save commits approval + mapping deltas + advisory profile
   atomically. Any stale/validation/database failure rolls all three back.
4. Approved `official_page` sources stay `not_supported`. No official
   collector is added here; the worker parks approved-but-unusable work in
   setup attention instead of falling back to unapproved discovery.
5. `#126` classification files are out of scope. `storage/catalog/**`,
   ShopSite XML, curator/classifier, preparation blending, review/promoter
   semantics, and image/claim rights are untouched.

## Slice acceptance checklist

### B0 (docs only)

- [ ] ADR 0035 Amendment B1 records save-is-approval + runtime caveat.
- [ ] CONTEXT Brand Sourcing Strategy definition mentions Save-approves.
- [ ] This runbook exists with gates + checklist.
- [ ] `git diff --check` clean; no app/DB/network changes.

### B1 (guarded Save + read model)

- [ ] Identical-source / source-only / config-only Save increments exactly once.
- [ ] Guarded replay with the same previous `expectedRevision` → 409, no row.
- [ ] Missing `expectedRevision` → 400; missing config token with
      `configuration` → 400.
- [ ] Forced failure mid-transaction rolls back mappings + advisory + approval.
- [ ] Concurrent Saves with the same guard: one winner, one 409, no loser write.
- [ ] External Domain Configuration / advisory edit between GET and Save →
      `stale_configuration`; pure timestamp/count updates do not invalidate.
- [ ] Other brands sharing a domain, extractor profiles, sitemap data,
      mapping usage counters/IDs, and unrelated advisory rows unchanged.
- [ ] Approval-only brands appear in reads; new-brand detail returns revision 0
      with an empty-configuration token and writes nothing.
- [ ] `bun test --timeout 30000 src/tests/unit/brand-sourcing-strategy.test.ts`
- [ ] `bunx --no-install vitest run src/tests/unit/brand-strategy-builder-schema.test.ts src/tests/unit/brand-strategy-routes.test.ts src/tests/unit/brand-strategy-view-model.test.ts`
- [ ] `bun run typecheck`, scoped `eslint`, `git diff --check`.

### B2 (generation binding + worker guard)

- [ ] Fresh + upgrade-from-#120 migration runs; rerun idempotent; preexisting
      rows byte-equivalent; no snapshot backfill.
- [ ] Generation G at revision N keeps N across Save N+1; retry G2 uses N+1.
- [ ] Tampered / wrong-owner / unknown-version / superseded / evidence-without-
      binding generations fail closed without attributing today's revision.
- [ ] Kill switch and connector disable override pins; enabling an unselected
      connector does not broaden a pin.
- [ ] Approved official-only / zero-usable / all-error generations park in
      setup attention — no unapproved fallback, no fake extraction.
- [ ] Strategy-bound manual fallback cannot admit a non-official candidate;
      legacy unbound rows keep historical semantics.
- [ ] `bun test --timeout 30000 src/tests/unit/brand-sourcing-strategy.test.ts`
- [ ] `bun test --timeout 30000 src/tests/unit/brand-strategy-builder-migration.test.ts`
- [ ] `bun test --timeout 30000 src/tests/unit/brand-authority-gate.test.ts src/tests/unit/sourcing-default-on-e2e.test.ts src/tests/unit/distributor-record-materializer.test.ts`
- [ ] `bun run test:runner-coverage`, `bun run typecheck`, scoped `eslint`,
      `git diff --check`.
