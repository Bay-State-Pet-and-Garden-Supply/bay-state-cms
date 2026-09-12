import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // zod v4 ships conditional exports whose CJS build breaks vite-node
    // externalization (`import { z } from 'zod'` resolves to undefined at
    // collect). Inlining forces the ESM build through the vite pipeline.
    server: {
      deps: {
        inline: ['zod'],
      },
    },
    include: ['src/tests/**/*.test.ts', 'src/tests/**/*.test.tsx'],
    exclude: [
      'node_modules',
      // Batch preflight & sourcing policy tests — use bun:sqlite, run under bun test (test:db)
      'src/tests/unit/batch-controlled-release-routes.test.ts',
      'src/tests/unit/batch-preflight-lifecycle.test.ts',
      'src/tests/unit/sourcing-policy.test.ts',
      // Brand sourcing strategy approval/engine/gap tests — use bun:sqlite, run under bun test (test:db)
      'src/tests/unit/brand-sourcing-strategy.test.ts',
      // Strategy collection tracers (#122 distributor-only, #123 mixed) — bun:sqlite, run under bun test (test:db)
      'src/tests/unit/strategy-distributor-only-tracer.test.ts',
      'src/tests/unit/strategy-mixed-official-tracer.test.ts',
      // Gap correction/resume loop (#124) — bun:sqlite, run under bun test (test:db)
      'src/tests/unit/preparation-gap-correction.test.ts',
      // Strategy-driven Stage 1 collection read (#125) — bun:sqlite, run under bun test (test:db)
      'src/tests/unit/stage-one-collection-read.test.ts',
      // Brand advisory retirement migration — bun:sqlite, run under bun test (test:db)
      'src/tests/unit/brand-advisory-retirement-migration.test.ts',
      'src/tests/unit/brand-strategy-builder-migration.test.ts',
      'src/tests/unit/brand-strategy-select-source-guard.test.ts',
      // Strategy setup-attention worker test — bun:sqlite, run under bun test (test:db)
      'src/tests/unit/brand-strategy-setup-attention.test.ts',
      // M7 scraper acceptance — bun:sqlite/bun:test, run under bun test (test:db)
      'src/tests/unit/distributor-scrapers-acceptance.test.ts',
      // M6 live-smoke DB suite — uses bun:sqlite, run under bun test instead of vitest
      'src/tests/unit/sourcing-live-smoke-db.test.ts',
      // Brand authority gate — bun:sqlite/bun:test, run under bun test (test:db)
      'src/tests/unit/brand-authority-gate.test.ts',
      // ADR 0017 assign_brand/assign_domain attention routes — bun:sqlite,
      // run under bun test (test:db)
      'src/tests/unit/brand-assign-routes.test.ts',
      // ADR 0017 batch brand-domain setup (service + blockers + routes) —
      // bun:sqlite, run under bun test (test:db)
      'src/tests/unit/brand-domain-setup.test.ts',
      // DB-backed tests — use bun:sqlite, run under bun test instead of vitest
      'src/tests/unit/db-migration.test.ts',
      'src/tests/unit/catalog-health.test.ts',
      'src/tests/integration/phase2-change-set.test.ts',
      'src/tests/integration/phase3-sync-drift.test.ts',
      'src/tests/unit/onboarding-repos.test.ts',
      'src/tests/unit/onboarding-approval-gates.test.ts',
      // e10s01 review-completeness gate — bun:sqlite/bun:test, run under bun test (test:db)
      'src/tests/unit/review-completeness-gate.test.ts',
      // P2 mapping audit — imports repository modules that load bun:sqlite; run under bun test (test:db)
      'src/tests/unit/mapping-audit.test.ts',
      // e10s04 media route/resolution — bun:sqlite/bun:test, run under bun test (test:db)
      'src/tests/unit/review-media-route.test.ts',
      'src/tests/unit/review-media-resolution.test.ts',
      'src/tests/unit/durable-approval-promote.test.ts',
      'src/tests/unit/draft-promoter.test.ts',
      'src/tests/unit/naming-promotion-filenames.test.ts',
      'src/tests/unit/filename-review.test.ts',
      'src/tests/unit/naming-ownership-snapshot.test.ts',
      'src/tests/unit/naming-promotion-gate.test.ts',
      'src/tests/unit/naming-presync-overlay.test.ts',
      'src/tests/unit/naming-reimport-hold.test.ts',
      // Brand guarantee uses bun:sqlite via llm-client; runs under bun test.
      // NOTE: keep isolated from name-consolidation-stage.test.ts — that file
      // vi.mock()s title-consolidation and bun shares the module registry
      // per process, so co-running would poison these real-path tests.
      'src/tests/unit/brand-title-guarantee.test.ts',
      // Size guarantee uses bun:sqlite via llm-client; same isolation rule.
      'src/tests/unit/size-title-guarantee.test.ts',
      // Color guarantee uses bun:sqlite via llm-client; same isolation rule.
      'src/tests/unit/color-consolidation.test.ts',
      'src/tests/unit/onboarding-duplicate-skip.test.ts',
      'src/tests/unit/extractor-profiles.test.ts',
      'src/tests/unit/extraction-remedies.test.ts',
      'src/tests/unit/classification-pipeline.test.ts',
      'src/tests/unit/taxonomy-freeze.test.ts',
      'src/tests/unit/taxonomy-release-validation.test.ts',
      'src/tests/unit/taxonomy-release-v4.test.ts',
      'src/tests/unit/taxonomy-release-v5.test.ts',
      'src/tests/unit/classification-model-call-repo.test.ts',
      'src/tests/unit/classification-run-routes.test.ts',
      'src/tests/unit/profile-generation-repo.test.ts',
      'src/tests/unit/profile-promoter.test.ts',
      'src/tests/unit/sitemap-cache-repo.test.ts',
      'src/tests/unit/sitemap-fetcher.test.ts',
      'src/tests/unit/sitemap-matcher.test.ts',
      'src/tests/unit/sitemap-sync-service.test.ts',
      'src/tests/unit/profile-generation-revision-repo.test.ts',
      'src/tests/unit/profile-generation-field-decision-repo.test.ts',
      'src/tests/unit/llm-task-config-repo.test.ts',
      'src/tests/unit/llm-client-task-routing.test.ts',
      // bun:sqlite suites missing from the excludes at 0e9a242 (vitest
      // cannot collect them); registered in package.json test:db
      'src/tests/unit/onboarding-variant-selection-route.test.ts',
      'src/tests/unit/packaging-ocr-stage.test.ts',
      'src/tests/unit/packaging-ocr-shadow.test.ts',
      'src/tests/unit/packaging-ocr-consumer-wiring.test.ts',
      'src/tests/unit/provider-connection-routing.test.ts',
      'src/tests/unit/vlm-client.test.ts',
      'src/tests/unit/profile-governance-service.test.ts',
      'src/tests/unit/domain-diagnostics-service.test.ts',
      'src/tests/unit/packaging-ocr.test.ts',
      // P1-T1 structured OCR attempt results — transitively imports bun:sqlite
      // repositories (run under bun test via test:db)
      'src/tests/unit/packaging-ocr-attempt.test.ts',
      // P3-T1/T2 packaging-OCR eval harness + repetition mitigation — bun:sqlite
      // transitive imports (run under bun test via test:db)
      'src/tests/unit/ocr-eval-harness.test.ts',
      'src/tests/unit/packaging-ocr-repetition.test.ts',
      // New Phase 1-8 DB-backed tests
      'src/tests/unit/brand-integration.test.ts',
      'src/tests/unit/detail-enrichment-integration.test.ts',
      'src/tests/unit/evidence-extraction.test.ts',
      'src/tests/unit/cloud-vlm-client.test.ts',
      'src/tests/unit/curation-target-ranker.test.ts',
      'src/tests/unit/workspace-connection.test.ts',
      'src/tests/unit/product-field-audit-service.test.ts',
      'src/tests/unit/store-manager-tools.test.ts',
      'src/tests/unit/store-manager.test.ts',
      'src/tests/unit/store-manager-approval.test.ts',
      'src/tests/unit/store-manager-chat-history-service.test.ts',
      'src/tests/unit/store-manager-context.test.ts',
      'src/tests/unit/store-manager-image-repair.test.ts',
      'src/tests/unit/store-manager-ai-proposals.test.ts',
      'src/tests/unit/name-consolidation-guard.test.ts',
      'src/tests/unit/catalog-classification-db.test.ts',
      'src/tests/unit/decision-revision-migration.test.ts',
      'src/tests/unit/onboarding-decision-routes.test.ts',
      'src/tests/unit/classification-integrity-audit.test.ts',
      'src/tests/unit/sqlite-backup-verifier.test.ts',
      'src/tests/unit/classification-integrity-cli.test.ts',
      'src/tests/unit/classification-quality-routes.test.ts',
      'src/tests/unit/weekly-report.test.ts',
      'src/tests/unit/benchmark-export.test.ts',
      'src/tests/unit/benchmark-evaluator.test.ts',
      'src/tests/unit/product-retrieval.test.ts',
      'src/tests/unit/classification-config-store.test.ts',
      'src/tests/unit/classification-config-loader.test.ts',
      'src/tests/unit/name-consolidation-stage.test.ts',
      'src/tests/unit/classification-runtime-snapshot.test.ts',
      'src/tests/unit/reviewed-facts.test.ts',
      'src/tests/unit/page-import-service.test.ts',
      'src/tests/unit/page-identity-migration.test.ts',
      'src/tests/unit/page-routes.test.ts',
      'src/tests/unit/page-sync-preflight.test.ts',
      'src/tests/unit/sync-routes-preflight.test.ts',
      'src/tests/unit/catalog-evidence-verifier.test.ts',
      'src/tests/unit/runtime-snapshot-v2.test.ts',
      'src/tests/unit/benchmark-dataset-lifecycle.test.ts',
      'src/tests/unit/benchmark-prediction.test.ts',
      'src/tests/unit/benchmark-qualification.test.ts',
      'src/tests/unit/embedding-maintenance.test.ts',
      'src/tests/unit/embedding-routes.test.ts',
      'src/tests/unit/classification-page-snapshot.test.ts',
      'src/tests/unit/classification-readiness-routes.test.ts',
      'src/tests/unit/sourcing-resolution.test.ts',
      'src/tests/unit/sourcing-stage-order.test.ts',
      'src/tests/unit/sourcing-safety-routes.test.ts',
      'src/tests/unit/fetch-html-ssrf.test.ts',
      'src/tests/unit/distributor-v2.test.ts',
      // DB-backed (bun:sqlite) — run under `bun test` via test:db
      'src/tests/unit/distributor-image-verification.test.ts',
      // Image-fetch SSRF gate adversarial suite (bun:test — run under `bun test` via test:db)
      'src/tests/unit/image-downloader-ssrf.test.ts',
      'src/tests/unit/pi-reuse-policies.test.ts',
      'src/tests/unit/acceptance-migration.test.ts',
      'src/tests/unit/conflict-resolution.test.ts',
      'src/tests/unit/sourcing-engine.test.ts',
      'src/tests/unit/sourcing-reconciler.test.ts',
      'src/tests/unit/sourcing-pass-through.test.ts',
      'src/tests/unit/sourcing-recovery-acceptance.test.ts',
      'src/tests/unit/distributor-routes.test.ts',
      // DB-backed suites committed without vitest registration (bun:sqlite /
      // bun:test imports — vitest cannot collect them; run under test:db)
      'src/tests/unit/store-manager-execution-boundary.test.ts',
      'src/tests/unit/store-manager-operations-migration.test.ts',
      'src/tests/unit/distributor-scrapers-acceptance.test.ts',
      // Operations-console epic DB suites (Issues 3-9): bun:sqlite/bun:test
      // imports — excluded here, registered in package.json test:db.
      'src/tests/unit/store-manager-action-diff.test.ts',
      'src/tests/unit/store-manager-bulk-review-repo.test.ts',
      'src/tests/unit/store-manager-bulk-review-tools.test.ts',
      'src/tests/unit/store-manager-bulk-review.test.ts',
      'src/tests/unit/store-manager-event-runtime.test.ts',
      'src/tests/unit/store-manager-event-worker.test.ts',
      'src/tests/unit/store-manager-events-sse.test.ts',
      'src/tests/unit/store-manager-history-query.test.ts',
      'src/tests/unit/store-manager-history.test.ts',
      'src/tests/unit/store-manager-inbox-repo.test.ts',
      'src/tests/unit/store-manager-inbox.test.ts',
      'src/tests/unit/store-manager-notifications.test.ts',
      'src/tests/unit/store-manager-operations-acceptance.test.ts',
      'src/tests/unit/store-manager-playbook-repo.test.ts',
      'src/tests/unit/store-manager-playbook-runner.test.ts',
      'src/tests/unit/store-manager-playbook-templates.test.ts',
      'src/tests/unit/store-manager-playbook-validator.test.ts',
      'src/tests/unit/store-manager-preferences.test.ts',
      'src/tests/unit/store-manager-replay.test.ts',
      'src/tests/unit/store-manager-schedule-repo.test.ts',
      'src/tests/unit/store-manager-scheduled-runtime.test.ts',
      'src/tests/unit/store-manager-scheduler.test.ts',
      'src/tests/unit/store-manager-scope.test.ts',
      'src/tests/unit/store-manager-trigger-repo.test.ts',
      'src/tests/unit/cancel-overdue-benchmark.test.ts',
      'src/tests/unit/sourcing-default-on-e2e.test.ts',
      'src/tests/unit/sourcing-observe-mode.test.ts',
      'src/tests/unit/distributor-record-materializer.test.ts',
      // DB-backed suites committed without vitest registration (bun:sqlite /
      // bun:test imports — vitest cannot collect them; run under test:db)
      'src/tests/unit/attribute-editor.test.ts',
      'src/tests/unit/attribute-profile-editor.test.ts',
      'src/tests/unit/cohort-page-hash.test.ts',
      'src/tests/unit/cohort-semantic-validator.test.ts',
      'src/tests/unit/curation-applicability-runtime.test.ts',
      'src/tests/unit/curation-applicability.test.ts',
      'src/tests/unit/curation-target-editor.test.ts',
      'src/tests/unit/curation-value-mode-acceptance.test.ts',
      'src/tests/unit/field-mapping-editor.test.ts',
      'src/tests/unit/field-registry-routes.test.ts',
      'src/tests/unit/mapping-validity-sync.test.ts',
      'src/tests/unit/page-download-service.test.ts',
      'src/tests/unit/pr12-acceptance.test.ts',
      'src/tests/unit/pr13-acceptance.test.ts',
      'src/tests/unit/pr7-acceptance.test.ts',
      'src/tests/unit/pr9-acceptance.test.ts',
      'src/tests/unit/sync-service-labels.test.ts',
      'src/tests/unit/general-task-fallback-telemetry.test.ts',
      'src/tests/unit/pricing-and-telemetry.test.ts',
      'src/tests/unit/provider-and-model-registry.test.ts',
      'src/tests/unit/store-manager-models.test.ts',
      'src/tests/unit/store-manager-chat-runtime.test.ts',
      'src/tests/unit/store-manager-report.test.ts',
      'src/tests/unit/store-manager-tool-registry.test.ts',
      'src/tests/unit/store-manager-runtime.test.ts',
      'src/tests/unit/zero-deployment-rollback.test.ts',
      // Issue #30 cohort curation (bun:sqlite DB tests)
      'src/tests/unit/curation-cohort-repo.test.ts',
      'src/tests/unit/curation-cohort-service.test.ts',
      'src/tests/unit/cohort-freeze.test.ts',
      'src/tests/unit/cohort-worker.test.ts',
      'src/tests/unit/cohort-shadow-observations.test.ts',
      // Slice 2 cohort-curation seam: bun:sqlite/bun:test, run under bun test (test:db); boundary is Vitest-only
      'src/tests/unit/cohort-curation-interface.test.ts',
      'src/tests/unit/cohort-curation-recovery.test.ts',
      'src/tests/unit/classification-cohort-run-repo.test.ts',
      'src/tests/unit/cohort-v6-migration.test.ts',
      // PR6 C1/C2/C4/C6 Bun-only suites (bun:test imports — vitest cannot collect them)
      'src/tests/unit/cohort-output-repo.test.ts',
      'src/tests/unit/cohort-title-hash.test.ts',
      'src/tests/unit/cohort-v7-migration.test.ts',
      'src/tests/unit/cohort-curation-titles.test.ts',
      'src/tests/unit/cohort-curation-pages.test.ts',
      'src/tests/unit/pr6-acceptance.test.ts',
      // PR4 C3 pure resolver (bun:test imports — vitest cannot collect it)
      'src/tests/unit/cohort-product-type-resolver.test.ts',
      // N+1 query-plan benchmark (bun:test + bun:sqlite — run under bun test via test:db)
      'src/tests/unit/cohort-context-query-plan.test.ts',
      // P4 taxonomy release wiring (bun:test imports + bun:sqlite transitive —
      // run under bun test via test:db)
      'src/tests/unit/release-compiler.test.ts',
      'src/tests/unit/release-routes.test.ts',
      'src/tests/unit/release-shadow.test.ts',
      // PR5 effective-curation-type suites (bun:test imports — vitest cannot collect them)
      'src/tests/unit/effective-curation-type.test.ts',
      'src/tests/unit/effective-curation-stages.test.ts',
      // PR8 draft-projection stage suite (bun:test imports — vitest cannot collect it)
      'src/tests/unit/draft-projection.test.ts',
      // PR8 acceptance (bun:test imports — vitest cannot collect it)
      'src/tests/unit/pr8-acceptance.test.ts',
      // PR10 acceptance (bun:test imports — vitest cannot collect it; runs
      // under bun test via the test:db third invocation group)
      'src/tests/unit/pr10-acceptance.test.ts',
      // PR11 acceptance (bun:test imports — vitest cannot collect it; runs
      // under bun test via the test:db third invocation group)
      'src/tests/unit/pr11-acceptance.test.ts',
      // Issue #31 cleanup F2 freshness gate (bun:sqlite DB tests)
      'src/tests/unit/catalog-evidence-freshness.test.ts',
      // Epic #46 Phase 2 automation suite (bun:sqlite/bun:test — run under bun test via test:db)
      'src/tests/unit/onboarding-automation.test.ts',
      // Epic #46 follow-up discovery run-trace suite (bun:sqlite/bun:test —
      // run under bun test via test:db)
      'src/tests/unit/discovery-run-trace.test.ts',
      // Epic #46 follow-up profile-blockers suite (bun:sqlite/bun:test —
      // run under bun test via test:db)
      'src/tests/unit/profile-blockers.test.ts',
      // Epic #46 follow-up official-domain ranking (imports source-discovery,
      // which pulls bun:sqlite modules — run under bun test via test:db)
      'src/tests/unit/official-domain-ranking.test.ts',
      // Epic #46 follow-up distributor imagery verification (bun:sqlite/
      // bun:test + sharp — run under bun test via test:db)
      'src/tests/unit/distributor-imagery.test.ts',
      // Epic #46 Phase 1/7/8 + telemetry DB suites (bun:sqlite — run under bun test via test:db)
      'src/tests/unit/onboarding-work-state.test.ts',
      'src/tests/unit/onboarding-review-state.test.ts',
      'src/tests/unit/onboarding-telemetry.test.ts',
      // Product intelligence seed persistence (bun:test / bun:sqlite — run under bun test via test:db)
      // Epic #61 sitemap & brand URL index DB-backed suites
      'src/tests/unit/brand-url-index-repo.test.ts',
      'src/tests/unit/local-brand-url-finder.test.ts',
      'src/tests/unit/sitemap-health-evaluator.test.ts',
      'src/tests/unit/sitemap-routes.test.ts',
      'src/tests/unit/brand-url-index.test.ts',
      'src/tests/unit/sitemap-inventory.test.ts',
      'src/tests/unit/representative-suite.test.ts',
      'src/tests/unit/profile-waiver.test.ts',
      'src/tests/unit/source-discovery-sitemap-priority.test.ts',
      'src/tests/unit/template-clustering.test.ts',
      // Page extractor / specialist workflow DB suites
      'src/tests/unit/page-extractor-images.test.ts',
      'src/tests/unit/page-extractor-ladder-wiring.test.ts',
      'src/tests/unit/page-extractor-profile-generation.test.ts',
      'src/tests/unit/page-extractor-variant-inference.test.ts',
      'src/tests/unit/brand-hub-routes.test.ts',
      // Variant resolution migration — bun:sqlite, run under bun test via test:db (not vitest)
      'src/tests/unit/onboarding-variant-resolution-migration.test.ts',
      'src/tests/unit/onboarding-variant-resolution-repo.test.ts',
      'src/tests/integration/onboarding-betterbone-variant-flow.test.ts',
      'src/tests/unit/sourcing-engine-dual-connector.test.ts',
      'src/tests/unit/profile-engineer-workflow-repo.test.ts',
      'src/tests/unit/official-page-identity-benchmark.test.ts',
      'src/tests/unit/review-queue-routes-adversarial.test.ts',
      // Milestone 3 bounded work-state (bun:sqlite/bun:test — run under bun test via test:db)
      'src/tests/unit/onboarding-work-state-query-plan.test.ts',
      'src/tests/unit/onboarding-work-routes.test.ts',
      // Milestone 4 operation receipts (bun:sqlite/bun:test — run under bun test)
      'src/tests/unit/onboarding-operation-receipt-migration.test.ts',
      'src/tests/unit/onboarding-operation-idempotency.test.ts',
      'src/tests/unit/onboarding-approval-export-ui.test.tsx',
      // Milestone 5 lossless identity (bun:sqlite — run under bun test)
      'src/tests/unit/onboarding-imported-identity-migration.test.ts',
      // Milestone 6 hash stability & page verifier (bun:sqlite/bun:test)
      'src/tests/unit/hash-stability-characterization.test.ts',
      'src/tests/unit/m2-challenger-stress.test.ts',
      'src/tests/unit/page-verifier.test.ts',
      'src/tests/unit/review-queue-adversarial.test.ts',
      'src/tests/unit/review-queue-schema.test.ts',
      // Manual-evidence foundation DB suite (ticket #102, parent #101) —
      // bun:sqlite via the repository layer; run under bun test via test:db.
      'src/tests/unit/manual-evidence-foundation-db.test.ts',
      // Manual-evidence thin-slice DB suite (ticket #103, parent #101) —
      // bun:sqlite via the repository layer; run under bun test via test:db.
      'src/tests/unit/manual-evidence-thin-slice-db.test.ts',
      // Manual-evidence full-set DB suite (ticket #104, parent #101) —
      // bun:sqlite via the repository layer; run under bun test via test:db.
      'src/tests/unit/manual-evidence-full-set-db.test.ts',
      // Manual-evidence title-source suite (ticket #104) — own test:db
      // segment: neighboring suites mock title-consolidation at module
      // level and bun shares the registry per process.
      'src/tests/unit/manual-evidence-title-source-db.test.ts',
      // Manual-evidence hardening DB suite (ticket #105, parent #101) —
      // bun:sqlite via the repository layer; run under bun test via test:db.
      'src/tests/unit/manual-evidence-hardening-db.test.ts',
      // Manual-evidence retry route suite (ticket #105 review P1-2) —
      // real Hono app + bun:sqlite; run under bun test via test:db.
      'src/tests/unit/manual-evidence-retry-route.test.ts',
      // Slice 1 v2 stage-read suites — bun:test/bun:sqlite (one imports the
      // route layer + real Hono app); run under bun test via test:db.
      // The schema suite is pure (no DB) but its chain (./onboarding →
      // ./classification) uses zod named imports, which vite-node cannot
      // resolve (pre-existing toolchain breakage); it runs under Bun too.
      'src/tests/unit/onboarding-stage-read-routes.test.ts',
      'src/tests/unit/onboarding-stage-read-query-plan.test.ts',
      'src/tests/unit/onboarding-stage-read-schema.test.ts',
      // Slice 2 preparation-read suite — bun:test (imports client pure
      // modules through the shared schema chain); run under bun test via
      // test:db, excluded from Vitest per the §6.1 dual-runner gate.
      'src/tests/unit/onboarding-preparation-read.test.ts',
      // Slice 4-SERVER Bun suites (route + derivation) — dual-runner gate.
      'src/tests/unit/onboarding-sse-versioning.test.ts',
      'src/tests/unit/onboarding-preparation-derive.test.ts',
      // Slice 5a stage-rename bridge/migration suites — bun:test/bun:sqlite;
      // run under bun test via test:db (dual-runner gate §6.1).
      'src/tests/unit/onboarding-stage-migration.test.ts',
      'src/tests/unit/onboarding-stage-history-compat.test.ts',
      'src/tests/unit/onboarding-stage-queued-continuation.test.ts',
      'src/tests/unit/onboarding-stage-rollback-bridge.test.ts',
      // Slice 5b native-cutover API compat suite — bun:test/bun:sqlite;
      // run under bun test via test:db (dual-runner gate §6.1).
      'src/tests/unit/onboarding-stage-api-compat.test.ts',
      // Slice 5a maintenance-script regression suite — bun:test/bun:sqlite
      // + spawns the offline maintenance script; run under bun test via
      // test:db (dual-runner gate §6.1).
      'src/tests/unit/onboarding-stage-vocabulary-script.test.ts',
      // Type-first refresh suite (their workstream) — bun:test/bun:sqlite;
      // run under bun test via test:db (dual-runner gate §6.1).
      'src/tests/unit/type-dependent-refresh.test.ts',
      // Type-first curation / accuracy guardrails suites — bun:test/bun:sqlite
      'src/tests/unit/classification-currentness.test.ts',
      'src/tests/unit/classification-refresh-repo.test.ts',
      'src/tests/unit/product-type-verifier.test.ts',
      'src/tests/unit/proposal-review-service-invalidation.test.ts',
      'src/tests/unit/repair-system-auto-accept.test.ts',
      'src/tests/unit/type-change-impact.test.ts',
      'src/tests/unit/type-first-guardrails-fixes.test.ts',
      'src/tests/unit/type-review-detail.test.ts',
    ],
  },
});
