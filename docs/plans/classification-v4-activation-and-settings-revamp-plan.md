# Classification Hardening Roadmap: v4 Activation, Settings UI Revamp, Attribute Disposition

**Status:** PLAN (no code changes made by this planning pass)
**Scope owner:** Bay State CMS classification subsystem (ADR 0004 / 0011 / 0013 lineage)
**Governing docs:** `CONTEXT.md`, `docs/adr/0004`, `docs/adr/0011`, `docs/adr/0013`, `src/classification/workspace-state.ts` header, `src/classification/releases/bay-state-v4/*`
**Verdict honored:** KEEP-AND-HARDEN the type→profile→fields curation system (oracle). No replacement.

---

## 0. Verified ground truth (discovery performed for this plan)

Facts verified at HEAD that the phases below build on:

1. **Release machinery exists but is UNWIRED at runtime.** `loadTaxonomyRelease` / `loadTaxonomyReleaseV4` (`src/classification/release-validation.ts`) and `readWorkspaceState` / `migrateWorkspaceToRelease` (`src/classification/workspace-state.ts`) have **zero production callers** outside their own modules — they are exercised only by tests (`taxonomy-release-validation.test.ts`, `taxonomy-release-v4.test.ts`). The runtime config authority remains the workspace v2 bundle via `config-loader.ts`. The DEFAULT pin is `bay-state-v3`.
2. **bay-state-v4 artifacts are complete and validated-by-test**: manifest schemaVersion 3, 91 nodes / 10 departments / 74 types / 27 attributes / 9 facet profiles / **153 ratified pages** / 19 export mappings, with SHA-256 file hashes and `oldIdAliases` id preservation.
3. **The 8 unmapped attributes are already declared `exportDisposition: {kind:'not_exported'}` in v4 `attributes.json`** and have **zero membership in any of the 9 facet profiles** (verified by enumerating every profile's `attributes[].attributeId`). They are: `btu-rating`, `fuel-type`, `hose-length`, `joule-rating`, `npk-ratio`, `protein-pct`, `safety-toe-type`, `towing-capacity-lbs`.
4. **ProductField slot occupancy (from v4 `export-mappings.json` + code):** mapped = PF8 (nutrition), PF13/PF14 (canonical-category-id / canonical-breadcrumb compiled projections), PF16–PF30, PF32. Within the PF16–PF32 merchandising band only **PF31 is free** — and PF31 ("Product Category") is intentionally unmapped per `src/classification/config-seeds/bay-state-pet-garden-v1.ts` ("the store does not use it") — treat as reserved-unless-live-verified. Outside the band, PF9–PF12 and PF15 appear unused **in code**, but must be verified against the LIVE catalog field registry before any mapping; **PF1 is consumed** by draft-promoter (`newMMDDYY` marker). Net: ≤6 candidate slots for 8 attributes → not all can ever be mapped simultaneously.
5. **Category Page assignment is end-to-end on the v3 path**: verified-import identity registry → `captureVerifiedPageSnapshot` → cohort/single LLM assignment (`category-page-proposals.ts`, `cohort-page-coordinator.ts`) → `category-page-correctness.ts` v1 validator → `ReviewPagesPanel` (promoted UX, commit 53ce292) → mandatory-pages fail-closed gate in `draft-promoter.ts` (~lines 920–1000) → ProductOnPages XML rewrite.
6. **Known dormant/partial seams (confirmed):** v4 `hierarchy.json` / `shopsite-projection.json` are validated but consumed by no runtime engine; `page-assignment-policy.json` is advisory only; accessory/refill contradiction detection is an explicit `TODO(e09 Phase C)` at `category-page-correctness.ts:291`; `page-reranker.ts` is exported from `src/classification/index.ts` but has no runtime caller.
7. **UI facts confirmed:** `OnboardingSettings.tsx` tabs come from `onboarding-settings/tabRegistry.ts` (general/curation/brands/sitemaps/distributors); frozen banner + locked tooltips present; catalog-workbench trio (`TypesAttributesView`/`MappingsView`/`SchemaHealthView`) read-only inside Catalog view; `LlmTaskConfigPanel.tsx` exists in `src/client/components/` and is mounted NOWHERE while server routes GET/PUT/DELETE `/api/onboarding/settings/llm-task-configs` are live (`onboarding-routes.ts:3952–3996`); all 7 taxonomy mutations return 403 `taxonomy_frozen` (`classification-routes.ts:26–36`).
8. **Worktree is dirty** (many modified files incl. profile-builder, approved views). One sequential writer. Only sanctioned commit path: exact-path commit in nested `storage/catalog` repo containing only `store/classification/**`.

---

## A. Phased roadmap + dependency graph

```
P1 Settings UI revamp ──────────────┐
                                    │  (release-status card added in P4)
P4 v4 activation wiring (shadow) ───┴─→ P2 unmapped disposition + release authoring mechanics
                                            │
                                            → P3 universal-tier widening + ladder completion
                                                    │
                                                    → P5 Gen1 retirement (LAST)
```

**Ordering decision: P1 → P4 → P2 → P3 → P5. P4 precedes P2/P3.**

Justification:

- **Pages-first priority is satisfied.** Category page assignment is functionally complete on the v3 runtime path (fact 5), which was the sole reason v4 activation was parked. The park reason no longer holds.
- **Why P4 before P2/P3:** v4 preserves all taxonomy ids via `oldIdAliases`, so PI/Agent Lab contracts (`ClassificationProposalSchema`, taxonomy tools, mirror TypeBox schema) are unaffected by the pin flip. Activating v4 FIRST means all subsequent work (P2 disposition codification, P3 universal-tier behavior) is developed, tested, and shadow-validated against the FINAL taxonomy baseline exactly once — instead of building on v3 and re-validating everything after a later flip. Since Owner Decision 3 (Section D) recommends **retire-by-default with zero artifact change to v4**, there is nothing in P2 that needs to amend v4 pre-activation; a mapping demanded later becomes a clean v5 authored through P2's new mechanics.
- **Why P2 before P3:** oracle sequence steps 2–3 (mapping coverage audit, unmapped disposition) feed step 4–6 (universal-tier widening, CONTEXT.md amendment, id-constrained abstain stage). The audit's residual-gap inventory determines how much work P3's LLM-abstain stage must absorb; doing P3 first would guess at the gap set.
- **Why P1 first:** it is pure client-side, mutates no taxonomy state, cannot regress pipeline determinism, and delivers the manager-visible release/pin surface that operating the P4 rollout safely requires (the release-status card lands as an incremental addition during P4 when its backing endpoint exists — avoiding a stubbed endpoint in P1).
- **Why P5 last:** Gen1 DB routes (`field_registry`, `product_types` tables/routes) coexist deliberately until every consumer above them has run stably on release-gated config for at least one full onboarding cycle post-P3.

---

## B. Phase specifications

---

### P1 — Classification Settings UI revamp

**Goals:** Consolidate scattered classification surfaces into one coherent settings IA; mount the orphaned `LlmTaskConfigPanel`; establish shared primitives and the frozen-vs-editable pattern; make taxonomy read-only state legible. Zero server behavior change except none (all routes used already exist).

#### B.P1.1 Information architecture

New tab structure under the EXISTING top-level `?view=settings` route (App.tsx line ~174 already deep-links `?view=settings&tab=ai|catalog`):

| Tab | Content | Source |
|---|---|---|
| General | Existing general settings | move/reuse current general panel |
| AI Tasks | `LlmTaskConfigPanel` (NEW MOUNT) | `src/client/components/LlmTaskConfigPanel.tsx` |
| AI Routes | existing ai tab content | unchanged |
| Catalog Fields | live field registry view (reuse `CatalogFieldsView` from catalog-workbench) | reuse |
| Types & Attributes | `TypesAttributesView` (read-only) | reuse |
| Mappings & Health | `MappingsView` + `SchemaHealthView` stacked, or split if crowded | reuse |
| Taxonomy Release *(added in P4)* | pin status card, manifest summary, validation report | P4 |

`OnboardingSettings` stays physically under the Onboarding view (conservative; moving it is a separate owner call — see open questions). Its `tabRegistry.ts` gains no classification tabs; instead the Catalog/Taxonomy admin lives top-level so managers find it without entering Onboarding. Cross-link both directions ("Manage types, mappings & releases →" / "Back to onboarding settings").

#### B.P1.2 Component inventory

Extract shared primitives ONLY where reuse ≥ 3 call sites (house rule):

| New primitive | Path | Consumers (≥3) |
|---|---|---|
| `SettingsTabShell` (tablist + deep-link `?tab=` sync + lazy panels) | `src/client/components/settings/SettingsTabShell.tsx` | settings tabs here; refactor target for `WorkbenchTabs`; future OnboardingSettings migration |
| `FrozenBanner` (🔒 banner + tooltip copy + optional "changes require a new release" link) | `src/client/components/settings/FrozenBanner.tsx` | TypesAttributesView, MappingsView, SchemaHealthView, Taxonomy Release card, CatalogFieldDrawer |
| `StatusBadge` (frozen/stale/active/draft variants, icon+text, never color-only) | `src/client/components/settings/StatusBadge.tsx` | MappingsView stale flags, SchemaHealthView, Release card, CatalogFieldDrawer |
| `KeyValueList` (definition-list rows replacing ad-hoc inline-styled dl/div pairs) | `src/client/components/settings/KeyValueList.tsx` | SchemaHealthView, TypesAttributesView detail pane, Release manifest summary |

Reuse untouched: `ViewHeader`, `SectionHeader`, `AiRouteSummary`, `theme.ts` tokens, inline `React.CSSProperties`, `styles/workspace-tokens.css`. NO Tailwind/CSS-modules introduction.

#### B.P1.3 Frozen-vs-editable UX pattern

- Every release-derived view renders `<FrozenBanner revision={activeRevision} />`: "🔒 Managed by immutable taxonomy release `bay-state-vX`. Definitions, profiles, mappings and seeds are read-only. Changes require authoring and activating a new release." This REPLACES hidden/disabled editors — the affordance states what WOULD be possible, never pretends editability.
- Locked tooltips (OnboardingSettings line ~481 pattern) standardized through `FrozenBanner`/`StatusBadge` copy.
- Editable surfaces limited to what the server actually permits today: LLM task configs (live routes) and non-taxonomy general settings. No new mutation UI for anything returning 403 `taxonomy_frozen`.

#### B.P1.4 Accessibility

Tabs: `role="tablist"/"tab"/"panel"`, `aria-selected`, arrow-key navigation, roving tabindex (pattern already asserted by `settings-tab-accessibility.test.tsx` — extend it). Badges: text+icon, WCAG AA contrast against `theme.ts` backgrounds. Async loads: `aria-live="polite"` region. Focus visible via theme focus tokens.

#### Files touched (P1)

- Modify: `src/client/App.tsx` (settings tab registry wiring only), `src/client/components/settings/**` (new dir), `src/client/components/catalog-workbench/{TypesAttributesView,MappingsView,SchemaHealthView}.tsx` (adopt FrozenBanner/primitives; logic unchanged), `src/client/components/LlmTaskConfigPanel.tsx` (mount-only adjustments), `src/client/theme.ts` (additive tokens only if needed).
- Create: primitives in table above, `SettingsClassificationTab` composition component.
- Do NOT touch: `StoreManagerAssistant.tsx`, `llm-client.ts`, any `src/server` route, any classification module.

#### Tests (P1)

- Update: `src/tests/unit/settings-tab-accessibility.test.tsx` (new tab structure roles/keyboard).
- Update: `src/tests/unit/onboarding-settings-tabs.test.ts` (unchanged expectations stay green; cross-link presence).
- Add: `src/tests/unit/settings-classification-tab.test.tsx` — asserts frozen banner renders on each read-only view, LlmTaskConfigPanel mounts under AI Tasks and issues GET `/settings/llm-task-configs`, no mutation controls render for frozen surfaces.
- Add: `src/tests/unit/frozen-banner.test.tsx` — copy contains active revision slug; no edit affordances.

#### Rollout / rollback (P1)

Client-only; ship behind no flag (purely presentational reorganization of existing data). Rollback = revert client files; zero data/state impact.

#### Acceptance criteria (P1)

1. `LlmTaskConfigPanel` reachable at `?view=settings&tab=ai-tasks`, loads and saves configs against live routes (manual verify + test).
2. All four read-only views show the frozen banner with correct revision string.
3. `bun run typecheck && bun run lint && bun run test` green; `git status` shows only intended files modified, nothing staged.

---

### P4 — bay-state-v4 activation wiring behind shadow validation

**Goals:** Make the release pin the operative runtime selector; wire V4 bundle loading into config-loader; give the runtime engine controlled access to v4 hierarchy/page projections WITHOUT destabilizing page assignment; validate under cohort shadow before flipping production pins.

#### B.P4.1 Runtime selection (config-loader integration)

- Modify `src/classification/config-loader.ts`: after reading the workspace bundle, read the pin (`readWorkspaceState`); when `activeTaxonomyRevision === 'bay-state-v4'`, call `loadTaxonomyReleaseV4('src/classification/releases/bay-state-v4')` (fail closed on any validation failure) and compile the V4 bundle into the runtime `ClassificationConfig` shape via a NEW pure compiler `src/classification/release-compiler.ts` (V4 hierarchy nodes → product types/departments projection identical in shape to what v3 seed emits; attributes/profiles/mappings/guidance passed through; canonical-category-id/canonical-breadcrumb attributes included; page-assignment-policy attached as advisory metadata). Pin absent → existing default-migration path to `bay-state-v3` (byte-identical behavior).
- The compiler MUST be deterministic + hash-stable: same bundle bytes ⇒ byte-identical compiled config ⇒ identical `bundleHash` inputs. Unit-pinned.

#### B.P4.2 Controlled consumption of v4 projections (page stability first)

- **Authority stays live-and-verified:** category page assignment continues to use `captureVerifiedPageSnapshot` + verified page imports. `shopsite-projection.json` (153 pages) is NOT injected as an assignment candidate source in this phase — injecting 153 static pages alongside live verified imports risks mass reassignment, violating page stability.
- Consume instead:
  - `hierarchy.json` → canonical leaf ids/breadcrumb paths for the PF13/PF14 compiled-projection attributes once a product's primary page resolves (deterministic join pageId→projection role; missing join ⇒ attribute omitted, never guessed).
  - `page-assignment-policy.json` → surfaced read-only in UI (P1 card, P4) and logged in run snapshots as advisory rule-version metadata. Promotion into prompt rules requires its own versioned prompt bump (`cohort-pages-v3` class change) — explicitly OUT OF SCOPE here.
  - `TODO(e09 Phase C)` accessory/refill detection and `page-reranker.ts` dormancy: NOT addressed in P4 (tracked deferrals, see Section E).

#### B.P4.3 Pin management (fail-closed, sanctioned channel only)

- New additive read routes in a NEW file `src/server/routes/release-routes.ts` (mounted additively):
  - `GET /api/settings/taxonomy-release` → `{activeRevision, updatedAt, availableRevisions:[{revision, counts, manifestHashesOk}]}` (validator run read-only per request, cached).
  - `POST /api/settings/taxonomy-release/pin` → writes `store/classification/state.json` via `writeWorkspaceState` AFTER `assertReleaseValidV4` passes; guarded by `BAYSTATE_CMS_API_TOKEN` AND env kill-switch-style gate `BAYSTATE_CMS_RELEASE_ADMIN_ENABLED` (default disabled → 403 `release_admin_disabled`). No other writer of state.json may exist (grep-enforced in review).
- Per-workspace flip; production workspace flips ONLY after B.P4.4 gate passes.

#### B.P4.4 Shadow cohort validation gate

- Reuse the established shadow machinery pattern (`cohortShadowOnly`, observe-only, writes nothing — ADR 0013 PR4 precedent): new env `BAYSTATE_CMS_TAXONOMY_V4_SHADOW` runs the curation pipeline with the V4-compiled config while recording a parallel diff summary (proposed types/pages vs the pinned v3 arm) into run-scoped logs — no persisted proposal changes.
- Gate metric: ≥ N batches shadow-run (owner sets N, default 3), page/type proposal divergence reviewed manually; ZERO unexplained divergences on verified-page identity joins.

#### B.P4.5 Rollout order

1. Shadow flag on dev workspace → divergence report reviewed.
2. Flip a scratch/test workspace pin → full `bun run test` + manual promotion smoke (promotion gates unchanged).
3. Flip production workspace pin via sanctioned POST (token + admin env).
4. Keep v3 bundle directory untouched forever (rollback target).

#### Files touched (P4)

- Modify: `src/classification/config-loader.ts` (pin-aware load), `src/server/index.ts` or routes aggregator (mount release routes), `docs/runbooks/` (new rollout runbook `taxonomy-v4-activation.md`).
- Create: `src/classification/release-compiler.ts`, `src/server/routes/release-routes.ts`, runbook doc.
- Client (incremental on P1): `TaxonomyReleaseCard` consuming the GET route.
- Tests: below.

#### Tests (P4)

- Add: `src/tests/unit/release-compiler.test.ts` — deterministic compile; hash-stability across two loads; unknown-pin fails closed; v3-absent-pin path byte-identical to current loader output (golden compare against `classification-config-loader.test.ts` fixtures).
- Add: `src/tests/unit/release-routes.test.ts` — GET shapes; POST without token/admin-env → 403; POST with invalid release → validator error surfaced, state.json untouched; POST happy path writes pin + updatedAt ISO.
- Update: `src/tests/unit/taxonomy-release-v4.test.ts` (compiler integration points), `src/tests/unit/classification-config-loader.test.ts` (pin=v4 branch), `src/tests/unit/workspace-state` coverage if a dedicated suite exists via `taxonomy-freeze.test.ts` adjacency.
- Update: `cohort-shadow-observations.test.ts` (v4-shadow observer writes nothing).
- Regression guard suites that MUST stay green: `category-page-correctness.test.ts`, `cohort-page-coordinator.test.ts`, `promotion-gate.test.ts`, `draft-promoter.test.ts`, `classification-runtime-snapshot.test.ts`, `taxonomy-freeze.test.ts`, `pi-tool-registry` mirror suite (ids unchanged).

#### Flags (P4)

- `BAYSTATE_CMS_RELEASE_ADMIN_ENABLED` (default off) — enables the pin POST route.
- `BAYSTATE_CMS_TAXONOMY_V4_SHADOW` (default off) — parallel v3/v4 diff observation.
Rollback: set pin back to `bay-state-v3` (single state.json write / route call); v3 bundle untouched ⇒ loader reproduces prior behavior byte-identically. Kill switch: unset admin env ⇒ no further flips.

#### Acceptance criteria (P4)

1. With pin=`bay-state-v4`: loader serves V4-compiled config; run snapshots record revision `bay-state-v4`; PI tool taxonomy candidates resolve by preserved ids (oldIdAliases verified).
2. With pin absent/v3: behavior byte-identical to HEAD (golden test proves it).
3. Zero verified-page reassignments attributable to v4 consumption in shadow report.
4. Pin POST refuses without token+admin-env; refuses invalid release; never leaves partial state.json.

---

### P2 — Unmapped-attribute disposition + release authoring mechanics

**Goals:** Codify the disposition rule (Section D) into validator + UI truth; build the deterministic tooling that authors a future release (v5+) end-to-end so map-on-demand is cheap and safe; complete the mapping coverage audit.

#### B.P2.1 Disposition codification

- `release-validation.ts`: add rules enforcing the hybrid policy — (a) an attribute with zero facet-profile membership MAY carry `not_exported` (already legal); (b) NEW fail-closed rule: promoting an attribute from `not_exported` to `shopsite` REQUIRES ≥1 facet-profile membership entry in the SAME release (an exported attribute nobody proposes is dead weight and masks gaps); (c) NEW warning-level finding: `not_exported` attribute absent from every profile for >1 consecutive release is flagged `retire_candidate` in the validation report (advisory; never blocks).
- No change to the 8 attributes' v4 entries themselves (retire-by-default = status quo, formalized).

#### B.P2.2 Mapping coverage audit (one-shot, scripted)

- Script `scripts/classification-mapping-audit.ts` (run via `bun scripts/...`): reads live field registry (repository pattern, `src/db/repositories`) + v4 export-mappings + attributes; outputs a markdown report: occupied slots (with attribute), free slots (PF31 flagged reserved-until-live-verified; PF9–12/15 verification status), per-unmapped-attribute curated-value incidence from `curation_data_json` history (demand signal). NO writes; NO network.

#### B.P2.3 Release authoring mechanics

- New pure module `src/classification/release-authoring.ts` + CLI `scripts/classification-author-release.ts`: takes a source release dir + a declarative change-set (JSON: attribute edits, mapping adds/removes, profile memberships, hierarchy deltas) → emits a candidate `releases/<new-id>/` with recomputed hashes, bumped `sourceBaseline`, updated manifest counts, then runs `loadTaxonomyReleaseV4`-equivalent validation over the candidate and prints the structured report. Fail-closed: refuses output when any validation finding exists; refuses id deletion (ids are immutable; retirement = keep declaration, drop profile membership — never remove the id, protecting `ClassificationProposalSchema`/PI bindings and `oldIdAliases` chains).
- The tool NEVER writes to `storage/catalog` and never touches pins; activation remains exclusively P4's sanctioned route.

#### Files touched (P2)

- Modify: `src/classification/release-validation.ts` (rules b, c), `src/shared/schemas/classification.ts` ONLY IF a new additive optional field is required (e.g., `retireCandidate` stays OUT of schemas — report-level only; prefer zero schema churn).
- Create: `scripts/classification-mapping-audit.ts`, `scripts/classification-author-release.ts`, `src/classification/release-authoring.ts`, audit report doc under `docs/audits/`.
- Tests below.

#### Tests (P2)

- Update: `taxonomy-release-validation.test.ts` (new rules: exported-without-profile fails; retire_candidate advisory appears; existing 19-mapping v4 fixture still valid).
- Add: `src/tests/unit/release-authoring.test.ts` — change-set application determinism; hash recompute correctness; id-deletion refusal; candidate failing validation produces no directory; exported-add requires profile membership.
- Add: `mapping-audit.test.ts` — free-slot computation matches hand-checked expectation (PF31 reserved note present); demand query uses repository, no raw SQL outside repos.
- Suites kept green: `taxonomy-release-v4.test.ts`, `catalog-field-serialization.test.ts`, `pi` mirror TypeBox schema tests (no contract change).

#### Flags / rollback (P2)

None required (tooling + validator strictness). Validator additions are fail-closed and only affect FUTURE candidate releases; v4 remains valid (verified by keeping `taxonomy-release-v4.test.ts` green). Rollback = revert modules.

#### Acceptance criteria (P2)

1. Audit report exists with live-verified free-slot list and per-attribute demand counts.
2. Authoring CLI round-trips a no-op change-set into a candidate that validates clean with identical content hashes where expected.
3. All 8 unmapped attributes remain `not_exported`, profile-less, and produce zero export fields at serialization (asserted in `catalog-field-serialization.test.ts` update).

---

### P3 — Universal-tier widening + value-production ladder completion

**Goals:** Implement oracle steps 4–6: widen the universally-proposable tier; amend CONTEXT.md terminology; close residual value-production gaps with an id-constrained LLM-abstain stage; wire calibrated bulk acceptance.

#### B.P3.1 Universal-tier widening

- Modify `src/classification/curation-target-processor.ts` (+ `curation-target-resolver.ts` if tier gating lives there): size/color/material/flavor proposals are produced from DETERMINISTIC evidence regardless of Product Type status; the attribute PROFILE still governs requiredness/cardinality/applicability post-type (profile enforcement unchanged — this widens PROPOSABILITY only, never bypasses `validateProposalSafety`).
- Dependency stamping must respect the PR9 DECISION-B invariant: universal targets carry NO type-dependency row. Widened-tier proposals proposed pre-type are treated as universal for stamping purposes; when a profile later marks one required for a type, applicability still evaluates under the effective type (reviewed-first resolver `getEffectiveCurationProductType` untouched).

#### B.P3.2 CONTEXT.md amendment

- Line 67 "Universal Product Attribute" definition amended to: "A Product Attribute that is universally PROPOSABLE from evidence, with requiredness and applicability still enforced by the Attribute Profile." Line 427 conformed. Terminology-only; avoid-terms list respected.

#### B.P3.3 Id-constrained LLM-abstain stage (residual gaps)

- New stage module `src/classification/stages/value-gap-abstain.ts` (ADR 0004 replaceable-stage pattern): for residual gap attributes (mapped, in-profile, but no deterministic value produced), ONE constrained LLM call whose candidate values are restricted to the attribute's frozen `allowedValues`/aliases; any out-of-constraint output ⇒ deterministic abstain (`value_gap_abstained`), never invention. Operation registered in `model-operation-registry.ts` (version bump per ADR 0013 precedent; snapshot compatibility via `assertModelPlanCompatible` handles old snapshots fail-closed).

#### B.P3.4 Calibrated bulk acceptance

- Wire bulk acceptance through existing `isBulkAcceptable` machinery (`proposal-safety.ts:184`): confidence thresholds sourced from calibration (`confidence-calibrator.ts`) rather than constants where a calibrated model exists; uncalibrated ⇒ current constants (byte-identical fallback).

#### Files touched (P3)

- Modify: `curation-target-processor.ts`, `proposal-safety.ts` (threshold plumbing only), `model-operation-registry.ts` (new operation entry + version bump), `CONTEXT.md` (two lines), `src/classification/index.ts` (stage export).
- Create: `src/classification/stages/value-gap-abstain.ts`.
- Do NOT touch: `pipeline-runner.ts` stage ordering guarantees beyond additive stage registration; promotion gates; `detail-enrichment.ts` (already built, deterministic-first — consumed, not rebuilt).

#### Tests (P3)

- Add: `src/tests/unit/value-gap-abstain.test.ts` — constraint adherence; abstain on out-of-set; operation registered with versions; model-call audited.
- Update: `curation-target-processor` unit suite(s) (widened tier proposes without type; profile still gates requiredness), `proposal-safety`/bulk suites (`isBulkAcceptable` calibrated path + fallback byte-identity), `model-operation-registry` version fixtures, `cohort-semantic-validator.test.ts` (universal exemption still holds for widened tier).
- Regression: `family-title-page-goldset.test.ts`, `classification-evidence-targeting.test.ts`, e04s01/e04s02 determinism/provenance suites.

#### Flags / rollback (P3)

- `BAYSTATE_CMS_UNIVERSAL_TIER_WIDENING` (default off) — flag OFF byte-identical legacy behavior; shadow-validate on a batch before enabling broadly (mirror P4 gate discipline).
- Value-gap stage additionally gated by `BAYSTATE_CMS_VALUE_GAP_LLM` (default off).
Rollback: flags off ⇒ byte-identical; registry version bump is forward-safe via `assertModelPlanCompatible` fail-closed semantics.

#### Acceptance criteria (P3)

1. Flag ON: size/color/material/flavor propose from deterministic evidence on type-less items; requiredness still profile-driven; promotion gates untouched and green.
2. Flag OFF: byte-identical outputs (pinned golden test).
3. Zero out-of-constraint LLM values can reach a proposal (property test over fuzzed responses).
4. CONTEXT.md wording matches implementation; grep confirms no remaining "relevant regardless of Product Type" contradiction.

---

### P5 — Gen1 DB-route retirement (LAST)

**Goals:** Remove coexisting Gen1 field_registry/product_types ROUTES once stable; tables retained read-only for history unless owner approves drop.

Prerequisites: ≥1 full onboarding cycle completed post-P3 on v4 pin; zero reads of Gen1 routes in access logs/audit; PI taxonomy tools confirmed serving from release config only.

#### Steps

1. Inventory callers: grep `field_registry`/`product_types` route consumers (server + client).
2. Migrate any straggler client view to release-backed endpoints (expected: none after P1 consolidates views).
3. Delete route handlers (keep repository read functions for audit tooling); mark tables archived in migrations doc. NO destructive DROP in this phase — a table drop would require its own migration + `db-migration.test.ts` coverage + backup verification and is an explicit owner follow-up.
4. Update `specs/state.yaml` execution notes per house convention.

#### Tests (P5)

- Update: `catalog-classification-db.test.ts` (removed routes → 404), `db-migration.test.ts` (marker unchanged — no schema change), `classification-integrity-cli.test.ts` (attestation fallback path documented as archive-read).

#### Acceptance criteria

All Gen1 HTTP surfaces return structured 404; no client view references them; suites green; tables untouched.

---

## C. UI revamp design spec (summary of B.P1 + B.P4 client work)

- **Where taxonomy admin lives:** top-level `?view=settings` tabs (Catalog Fields / Types & Attributes / Mappings & Health / AI Tasks / Taxonomy Release). OnboardingSettings remains under Onboarding with cross-links. Rationale: managers operate releases without entering an onboarding batch context; avoids breaking `?view=settings&tab=ai|catalog` deep links (App.tsx:174).
- **Orphan resolution:** `LlmTaskConfigPanel` mounts under Settings → AI Tasks; its server routes are already live; panel needs no API changes.
- **Primitives extracted first** (reuse ≥3): `SettingsTabShell`, `FrozenBanner`, `StatusBadge`, `KeyValueList` — see B.P1.2 table with exact consumer lists.
- **Frozen-vs-editable pattern:** release-derived = read-only + FrozenBanner stating the active revision and the "new release" requirement (affordance-preserving, never fake-disabled editors); editable = only server-permitted surfaces (LLM task configs, general settings).
- **Release activation surfacing:** Taxonomy Release card shows `{activeRevision, updatedAt}`, available revisions with validation status (green check / red findings count), and an Activate action rendered DISABLED unless `BAYSTATE_CMS_RELEASE_ADMIN_ENABLED` is on server-side (client learns via GET payload flag; never guesses) with explanatory tooltip — defense in depth: client hiding + server 403.
- **Accessibility:** tablist/tab/tabpanel ARIA + keyboard arrows; badges icon+text (never color-only); `aria-live` async regions; contrast AA against theme tokens; covered in `settings-tab-accessibility.test.tsx` extensions.

---

## D. RECOMMENDATION — unmapped-attribute disposition (Owner Decision 2)

**Rule: HYBRID — retire-by-default, map-on-demand. Commit.**

1. **Retire-by-default (status quo, now formalized):** the 8 attributes remain declared `exportDisposition: {kind:'not_exported'}` with zero facet-profile membership. They persist as canonical internal vocabulary (ids never deleted — PI contracts bind to them), nothing proposes them (no profile ⇒ no proposer — already fail-closed), and they serialize nothing. P2 makes the validator enforce that an EXPORTED attribute always has profile membership, so reactivation can never half-happen.
2. **Map-on-demand exception** requires ALL of: (a) demonstrated demand (audit-measured curated-value incidence or explicit owner request); (b) a FREE ProductField slot **verified against the live field registry** — code-level absence is insufficient; (c) a NEW immutable release (v5+) authored via P2 mechanics with the profile membership granted in the SAME release; (d) activation through the P4 sanctioned pin route.
3. **Rationale grounded in scarcity and value:**
   - *Slot math:* within the merchandising band PF16–PF32, only PF31 is free — and PF31 is ShopSite's "Product Category," intentionally unmapped by store convention (config-seeds comment) and therefore reserved-unless-live-verified. PF9–12/PF15 look free in code but need live-registry verification (legacy store data may occupy them). PF1 is taken (promoter date marker). Ceiling ≈6 usable slots < 8 attributes: completeness is impossible; allocation must therefore be demand-driven.
   - *Merchandising value:* these are deep-spec attributes (BTU/joule ratings, NPK ratios, safety-toe types) concentrated in low-SKU-volume categories (heating, fencing, apparel). Their internal curation value (type discrimination, family coherence, search keywords via description synthesis) is retained even unexported; the only thing retired is external field emission nobody currently consumes.
   - *Cost asymmetry:* mapping consumes a scarce, effectively irreversible slot per release and adds prompt/serialization surface; retiring costs nothing today and keeps map-on-demand open via cheap P2 tooling. Map-all-now spends irreversibly on speculation; full-delete breaks id stability contracts. Hybrid dominates both.

---

## E. Risks register + open questions

**Risks:**

| # | Risk | Mitigation |
|---|---|---|
| R1 | v4 pin flip silently changes page/type proposals | Shadow gate (B.P4.4) + rollback pin write; v3 bundle immutable forever |
| R2 | Compiled-config hash drift between loads (nondeterministic compiler) | Hash-stability golden test in `release-compiler.test.ts` |
| R3 | Second writer of `state.json` corrupts pin | Grep-enforced single-writer rule in review checklist; route is sole production writer |
| R4 | Widened universal tier stamps false type dependencies → PR11 promotion gate refusals | Respect PR9 DECISION-B skip; dedicated dependency-row assertions in P3 tests |
| R5 | Registry version bump strands frozen snapshots mid-rollout | `assertModelPlanCompatible` fail-closed (PR12 DECISION-B) already covers; document in runbook |
| R6 | Dirty worktree collisions (many modified UI files) | P1 touches disjoint files (settings/, catalog-workbench trio, App.tsx wiring); coordinate one sequential writer |
| R7 | PF9–12/PF15 secretly occupied by legacy store data → bad future mapping | P2 audit REQUIRES live-registry verification before any slot is declared free |

**Open questions for owner (non-blocking; defaults chosen):**

1. Move `OnboardingSettings` under top-level Settings entirely? Default plan: NO (cross-links only) — moving changes reviewer muscle memory and deep links.
2. Shadow batch count N for P4 gate. Default 3.
3. Whether PF31 ("Product Category") should EVER be considered for mapping. Default: reserved, requires owner sign-off.
4. Timing of `page-assignment-policy.json` promotion into prompt rules (needs `cohort-pages-v3` prompt version work). Default: deferred, tracked.
5. Accessory/refill detection (`category-page-correctness.ts:291`) and `page-reranker.ts` dormancy: schedule as their own issue(s). Default: out of roadmap scope.

---

## F. DO-NOT-REBUILD list (hard boundaries)

- **Cohort CAS/lease machinery** — `reclaimExpiredCohortRuns` CAS, ownership-guarded heartbeat/supersede primitives, two-phase freeze engine, write-once coordinated title/page outputs (`classification_cohort_outputs` input-hash reuse/drift semantics). ADR 0013 PR3–PR13; reuse as-is.
- **Promotion fail-closed gates** — Name, Price, Brand(PF16), Primary Image, ≥1 VERIFIED page (mandatory-pages gate); `validatePromotionGate` semantic/parent-currentness/stale-proposal checks incl. PR12 value-hash dimension. Never weaken or duplicate.
- **Config bundle format** — strict versioned envelopes, manifest SHA-256 map, `bundleHash` composition, catalog-evidence attestation projection. Extend only via additive schemaVersion with the "byte-identical when absent" convention.
- **Taxonomy ids** — never delete/rename; retirement is declaration-level (`not_exported`, profile removal); `oldIdAliases` chains and PI bindings (`ClassificationProposalSchema`, mirror TypeBox in `pi/pi-tool-registry.ts`, taxonomy tools) stay intact.
- **Built-in XML output policy** — `SHOP_SITE_BUILT_IN_OUTPUT_POLICY_V1` (ADR 0011); ProductFields are never built-ins; preserve-unknowns (`shopsite.preserved.*`) mandate absolute.
- **Hard-rule files** — `StoreManagerAssistant.tsx`, `llm-client.ts` untouched.
- **Gen1 tables** — no destructive drops in P5; archive-read only pending owner migration decision.

---

## Validation commands (per phase, all phases)

```
bun run typecheck
bun run lint
bun run test            # named suites per phase above must be green; regression suites listed per phase
git status --porcelain  # nothing staged; only intended files modified
```

Sanctioned-commit reminder: the ONLY permitted commit remains the scoped exact-path commit in nested `storage/catalog` containing solely `store/classification/**` — none of P1–P5 code work stages or commits anything else.
