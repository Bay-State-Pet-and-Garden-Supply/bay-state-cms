# Evidence-first item-local onboarding implementation plan

**Status:** Owner-confirmed target — not implemented. No runtime behavior change is claimed by this document.
**Governing spec:** [onboarding-typesafe-expansion-spec.md](./onboarding-typesafe-expansion-spec.md).
**Decision record:** [0042-evidence-first-item-local-onboarding.md](../adr/0042-evidence-first-item-local-onboarding.md).
**GitHub publication:** [Specification and native work graph #362](https://github.com/Bay-State-Pet-and-Garden-Supply/bay-state-cms/issues/362), [complete implementation plan](https://github.com/Bay-State-Pet-and-Garden-Supply/bay-state-cms/issues/362#issuecomment-6296559834), and [ADR 0042](https://github.com/Bay-State-Pet-and-Garden-Supply/bay-state-cms/issues/362#issuecomment-6296559539).

New implementation work is tracked in [#377 accepted evidence](https://github.com/Bay-State-Pet-and-Garden-Supply/bay-state-cms/issues/377), [#378 standards and omissions](https://github.com/Bay-State-Pet-and-Garden-Supply/bay-state-cms/issues/378), [#379 bounded acquisition](https://github.com/Bay-State-Pet-and-Garden-Supply/bay-state-cms/issues/379), [#380 grounded copy](https://github.com/Bay-State-Pet-and-Garden-Supply/bay-state-cms/issues/380), and [#381 item-owned cutover](https://github.com/Bay-State-Pet-and-Garden-Supply/bay-state-cms/issues/381); [#382](https://github.com/Bay-State-Pet-and-Garden-Supply/bay-state-cms/issues/382) records human-owned production inputs. Existing #363–#376 are retained with amended contracts. Native blockers carry execution ordering; qualification remains human-gated and code delivery is not activation.

## Goal

Move onboarding from parent/cohort-owned readiness to item-local, evidence-first execution: each SKU owns its accepted evidence, checklist state, exceptions, readiness, and publication, while shared fetching/model batches remain pure optional computation. An unrelated item's incomplete extraction or failed batch MUST NOT hold a ready item. Truly linked multi-SKU family changes keep all-or-nothing consistency through explicit family-plan gates.

## Non-negotiable preserved contracts

- **ADR 0041 canonical classification** stays binding: canonical Category + Product Type, reviewed-only authority. Acquisition MAY supply accepted own-SKU facts into the classifier's frozen input; the classifier itself MUST NOT fetch, browse, enrich, or inherit sibling facts. Classification-required fields (canonical pair, applicable required values, profile configuration) are non-waivable: no listing exception, operator verification, or omission approval can clear them. Readiness seam: [classification-readiness.ts](../../src/classification/classification-readiness.ts). Gate consumers: [review-completion-gate.ts](../../src/classification/review-completion-gate.ts), [promotion-gate.ts](../../src/classification/promotion-gate.ts), catalog route [catalog-classification-routes.ts](../../src/server/routes/catalog-classification-routes.ts).
- **Item-owned immutable authority / lease / CAS semantics:** new item-owned execution uses per-item lease claim + write-once item outputs with CAS discipline modeled on (not reusing) the cohort-run pattern in [classification-cohort-run-repo.ts](../../src/db/repositories/classification-cohort-run-repo.ts). Cohort parent gates (`parent_superseded`, `parent_not_completed`, `parent_not_found` in [promotion-gate.ts](../../src/classification/promotion-gate.ts)) are removed from the NEW item-owned authority path and remain historical only for old parent-owned rows; they are NOT narrowed or reused for Product Families. Genuine family readiness uses `StorefrontFamilyPlan` lifecycle + consistency-group gates in [storefront-family-plan-service.ts](../../src/classification/storefront-family-plan-service.ts), never Curation Cohort parent rows. Migration MUST NOT delete gates or rewrite history; leases and model work stay owned and deduplicated.
- **Source role vs collection method:** source ROLE/authority (manufacturer official page, distributor record, retailer corroboration, operator-attested evidence) is distinct from collection METHOD (structured feed, static/profile extraction, rendered browser collection, manual entry, OCR). Browser rendering is a collection method, never a factual-authority source kind: rendered collection produces candidate facts that still require role authority (exact-item match, source authority, provenance, conflict, rights checks) before acceptance. There is no `admitRenderedExtraction` authority creator; method-specific handling (e.g. rendered-text capture) feeds role admission, it does not confer authority.
- **Family native/XML/Git constraints** stay: native Subproducts preserved as raw blocks by [product-codec.ts](../../src/shopsite/product-codec.ts); structured managed relationship only via listing-owned plan; PF7 (`Child - Short Name`) protected from classifier writes by [classification-ownership.ts](../../src/classification/classification-ownership.ts); rule authority in [family-variant-rule.ts](../../src/classification/family-variant-rule.ts) (`food-family-variant-rule-v1` + non-food size/color/count variants); strict consistency-group approval/publication in [change-set-service.ts](../../src/server/services/change-set-service.ts) and [storefront-family-plan-service.ts](../../src/classification/storefront-family-plan-service.ts). No synthetic UPCs, no SKU replacement, deterministic unique PF7, main stays a real purchasable member, atomic approved/export groups, no unsupported native adoption.
- **Source-span provenance** stays: name spans in [name-span-contract.ts](../../src/classification/name-span-contract.ts) + decision boundary [name-decision.ts](../../src/classification/name-decision.ts); claim units built in code (never a generative extractor) + deterministic checks first in [listing-evidence.ts](../../src/classification/listing-evidence.ts); currentness recomputation in [listing-evidence-currentness.ts](../../src/classification/listing-evidence-currentness.ts) (existing module is a starting seam only — WP1 replaces its fallback/hash behavior, see below); single gate evaluator [listing-evidence-gate.ts](../../src/classification/listing-evidence-gate.ts).
- **Real benchmark denominators** stay: same frozen population, unanswered/failed rows and retrieval misses reported, every percentage names its denominator; no invented dollars/accuracy/sample-size/saved-minutes.
- **Supplemental acquisition never regresses pipeline state:** scoped acquisition/preparation work issues through the existing worker while the item stays in its current stage (no backwards movement through the six stages); valid accepted facts are retained, and complementary evidence arrives via separate accepted-fact/source references, never by rewriting existing records. Distributor records keep their URL-null materialization (no fabricated `source_url`); an official `source_url` is never overwritten with a retailer URL (retailer corroboration is a separate evidence reference, not source replacement).
- **Cutover never silently rebinds model work:** current-generation evidence and frozen model calls keep their exact input/policy/run bindings; incompatible in-flight work is drained or superseded with fresh runs, and reuse requires exact equality (evidence/identity/candidates/order/authority/rules/prompt/model/policy) with ownership, hashes, and run compatibility revalidated before dispatch/retry/commit.
- **Checklist exact content and numeric production budgets are reviewed activation inputs, not invented defaults.** This plan defines the enforcement machinery and leaves content/numbers to the reviewed per-type checklists and enforceable limits in work package 5.
- **No extra retry stacks or generic orchestration frameworks.** Reuse the existing transport's single transient retry within caller budget, existing worker lease/reclaim, existing receipts/action tokens.
- **Durability layers are distinct, never one ACID claim:** the SQLite repository transaction, filesystem staging/preparation, the single approved Git commit (catalog authority), and idempotent index/status/receipt recovery are four separate steps with their own failure semantics (see WP4). A per-product write/index failure prevents the Git commit; once the commit exists, recovery completes idempotently against it without inventing a second commit.

## Current-state grounding (primary code)

- Execution owner today is the stage worker in [job-queue.ts](../../src/onboarding/job-queue.ts) (`OnboardingWorker`, cohort-claim dispatch, family-barrier hold with change-only SSE). Per-item curation body is [product-curator.ts](../../src/onboarding/product-curator.ts) (7-stage pipeline + post-pipeline description/keyword synthesis + distributor-copy authority).
- Cohort execution is parent-owned: freeze/members/titles/pages under [cohort-curation/](../../src/onboarding/cohort-curation/) with lease-scoped decision scope and write-once outputs. Promotion is per-item gated but parent-run-aware via [promotion-gate.ts](../../src/classification/promotion-gate.ts) and drafted in [draft-promoter.ts](../../src/onboarding/draft-promoter.ts).
- Review/durable-approval/draft-creation refusal paths already share single evaluators: `validateListingEvidenceForReview` + name-spans + `evaluateCanonicalReadiness` in [review-completion-gate.ts](../../src/classification/review-completion-gate.ts), consumed by [onboarding-routes.ts](../../src/server/routes/onboarding-routes.ts) (review-complete, draft creation, listing-evidence rerun/verify), [onboarding-review-repo.ts](../../src/db/repositories/onboarding-review-repo.ts) (durable approval), [change-set-validation.ts](../../src/validation/change-set-validation.ts), [export-routes.ts](../../src/server/routes/export-routes.ts), [sync-routes.ts](../../src/server/routes/sync-routes.ts).
- Copy/naming seams: deterministic candidate construction + TypeSafe Choice boundary [name-candidates.ts](../../src/classification/name-candidates.ts) / [name-decision.ts](../../src/classification/name-decision.ts); cohort coordination [cohort-name-coordinator.ts](../../src/onboarding/cohort-name-coordinator.ts); distributor copy authority (verified-v2 only, v1 identity-only) in [product-curator.ts](../../src/onboarding/product-curator.ts) + [distributor-copy-consolidator.ts](../../src/onboarding/distributor-copy-consolidator.ts) + [distributor-record-materializer.ts](../../src/onboarding/sourcing/distributor-record-materializer.ts); manual-evidence service + per-image rights in [manual-evidence-service.ts](../../src/onboarding/manual-evidence-service.ts).
- UI: Needs Attention / Review tabs and logic in [BatchWorkspace.tsx](../../src/client/components/onboarding/BatchWorkspace.tsx), [batch-workspace-logic.ts](../../src/client/components/onboarding/batch-workspace-logic.ts), [StageItemsView.tsx](../../src/client/components/onboarding/StageItemsView.tsx), review panels [ReviewListingEvidencePanel.tsx](../../src/client/components/onboarding/review/ReviewListingEvidencePanel.tsx) + [review-readiness.ts](../../src/client/components/onboarding/review/review-readiness.ts), work-state derivation [onboarding-work-state.ts](../../src/onboarding/onboarding-work-state.ts). The existing `waiting_on_family` tab ([FamilyWaitingView.tsx](../../src/client/components/onboarding/families/FamilyWaitingView.tsx)) and `family_barrier` strip ([execution-strip-logic.ts](../../src/client/components/onboarding/execution-strip-logic.ts)) describe the OLD cohort barrier and are NOT reused as genuine-family gates: WP4 removes those waiting states for unrelated items and shows explicit family-plan operation state (plan lifecycle + member readiness) as a separate surface.
- Preparation gaps: [preparation-gap-repo.ts](../../src/db/repositories/preparation-gap-repo.ts) (`assessListingEvidenceGap`, `openPreparationGap`, `blockingPreparationFields`).

---

## WP1 — Item accepted-evidence / checklist / exception contracts + persistence/currentness + honest migration

**Owns:** per-SKU source of truth for what is accepted, what the checklist requires, and what the operator explicitly excepted.

### Owning files/seams (existing → proposed)

| Concern | Existing seam | Proposed (new, labeled) |
|---|---|---|
| Accepted-evidence record | `CurationData` in [onboarding.ts](../../src/shared/schemas/onboarding.ts); eligible bundle builder `eligibleEvidenceFor` in [listing-evidence.ts](../../src/classification/listing-evidence.ts) | Proposed `AcceptedItemEvidence` Zod contract in `src/shared/schemas/onboarding.ts`, with the complete ownership, observation, fact-value/span/variant, acceptance and dependency bindings in spec §3.2. Persist append-only snapshots through a proposed `src/db/repositories/accepted-item-evidence-repo.ts`, installed by the existing migration runner; its current revision is an item reference, not a second approved catalog. No direct SQL outside that repository. |
| Completeness standard | `evaluateListingEvidenceGate` ([listing-evidence-gate.ts](../../src/classification/listing-evidence-gate.ts)), `evaluateCanonicalReadiness` ([classification-readiness.ts](../../src/classification/classification-readiness.ts)), `blockingPreparationFields` ([preparation-gap-repo.ts](../../src/db/repositories/preparation-gap-repo.ts)) | Proposed `ListingCompletenessStandard` versioned configuration and `evaluateItemChecklist(...)` pure evaluator in `src/classification/item-checklist.ts`. Per-requirement states are `satisfied`, `missing`, `not_applicable`, `excepted`, `conflicted`, `unavailable`, or `stale`, with evidence/policy/exception references as defined in spec §7.1. Standard content is an activation input, not a hardcoded universal checklist. |
| Operator exception | Listing-evidence operator verification in [listing-evidence-verify.ts](../../src/classification/listing-evidence-verify.ts) (evidence/revision-bound, `operator_verified` never rebranded as model verdict) | Proposed `ListingCompletenessException` record: `{ itemId, requirementId, standardId, standardRevision, inputRevision, reason, actor, timestamp, receiptId }`, bound to item+requirement+standard+input revision. No title-only or `['title']` fallbacks: the exception MUST name an explicit affected-requirement set (one or more requirement IDs, never an implicit default). Non-waivable requirements (identity/variant resolution, rights, required safety facts, all ADR 0041 classification-required fields) can never be excepted — enforced in code. |
| Currentness | [listing-evidence-currentness.ts](../../src/classification/listing-evidence-currentness.ts) is the existing owning seam | Evolve that module's shared currentness interpretation to include live values, source/observation/span/variant bindings, standard version and exception revision. Do not add a competing hash evaluator. Unreadable state is explicitly `unavailable`, never two matching empty hashes; required fields derive from the bound standard, with no implicit `['title']` fallback. |

### Data and mutation contracts

- Accepted evidence is append-only per input revision: new evidence/span/source-authority state creates a new record; old records stay readable. Never mutate an old evidence row to make a hash match.
- Exceptions are append-only decisions with action tokens + idempotent receipts (same pattern as [listing-evidence-verify.ts](../../src/classification/listing-evidence-verify.ts)); stale revision/authority returns conflict with no mutation; an old exception never clears a changed claim.
- Standard content lives in versioned listing configuration with the catalog's versioned configuration. Changing content stales affected item evaluations; presentation-only changes may reuse raw judgments when evidence/meaning is unchanged.
- No model requests inside a database transaction. Reuse existing migration runner; migrations initialize new state honestly and MUST NOT mark legacy items as checked/reviewed/adopted.

### Caller cutover

- [review-completion-gate.ts](../../src/classification/review-completion-gate.ts), [onboarding-review-repo.ts](../../src/db/repositories/onboarding-review-repo.ts), [draft-promoter.ts](../../src/onboarding/draft-promoter.ts), [change-set-validation.ts](../../src/validation/change-set-validation.ts), [export-routes.ts](../../src/server/routes/export-routes.ts), and [sync-routes.ts](../../src/server/routes/sync-routes.ts) consume the same checklist/currentness result for new item-owned work. Historical records remain readable, but missing checks never confer new accepted/checked authority. Existing runtime remains unchanged until the complete cutover; no grandfathering bypass is introduced for new runs.
- Preparation-gap callers ([onboarding-routes.ts](../../src/server/routes/onboarding-routes.ts) review-complete/draft paths, [onboarding-work-state.ts](../../src/onboarding/onboarding-work-state.ts)) map unresolved applicable requirements to the existing gap UX; optional absent or confirmed non-applicable facts do not become new gaps.

### Dependency ordering

- First package. No dependency on WP2 acquisition; WP3 listing preparation consumes its contracts; WP4 execution cutover requires its currentness evaluator.

### Consumer-visible acceptance scenarios

- Ready item with accepted evidence + passed standard reaches review even when an unrelated item's extraction failed (WP4 removes the barrier; this package makes the per-item verdict computable).
- Operator excepts a designated exception-eligible requirement with reason → item proceeds on that requirement; the record shows actor/time/revision; changing the underlying claim stales the exception.
- Attempt to except identity/rights/required-safety/ADR-0041-classification-required requirement → refused in code with the requirement reason. An exception with an empty or defaulted requirement set is rejected as malformed.
- Unreadable live state → `unavailable` (release-blocking), never a false pass from matching empty hashes.
- Evidence edit stales precisely the affected checklist entries and review/approval; unrelated unchanged entries do not require fresh inference.

### Actual smoke requirements

- CLI/API scenario smoke (no paid calls): create/advance one item through accepted-evidence → checklist evaluate → except → re-evaluate-after-edit, observing record versions and gate verdicts at the review-complete seam, including an `unavailable` injection (unreadable state) that must refuse. UI surface smoke for the exception control (real surface).

### External activation prerequisites

- Reviewed, versioned per-type `ListingCompletenessStandard` content (non-waivable vs exception-eligible flags) — content unknown until reviewed.
- Explicit provider/data-sharing approval covering any new model operation text actually sent.

---

## WP2 — Bounded acquisition fallback + code-controlled browser actions + role-based admission

**Owns:** how an item fills specific evidence gaps when structured UPC sources and static/profile extraction are insufficient.

### Role vs method (binding for this package)

- Source ROLE (authority): `manufacturer_official`, `distributor_record`, `retailer_corroboration`, `operator_attested`. Only these determine whether a fact can support a requirement, per the settled contracts (retailer corroborates attributable basic specs after exact-item matching; never official authority, prose, or images by default; safety/ingredients/nutrition/dose/medical claims need suitable authoritative evidence).
- Collection METHOD (how bytes were obtained): `structured`, `static_extraction`, `rendered_browser`, `manual`, `ocr`. Method affects handling/cost/trust plumbing (e.g. rendered text needs capture provenance) but confers ZERO authority by itself.
- Every accepted fact carries both: `{ value, sourceRole, observationId, span, variantBinding, collectedVia, rightsState }`. Admission checks ROLE; `collectedVia: rendered_browser` facts still pass the full role admission (source-authority, exact sellable-item + variant, provenance, conflict, rights) before acceptance.

### Owning files/seams

- Existing: approved-domain index/sitemap retrieval [source-discovery.ts](../../src/onboarding/source-discovery.ts), [sitemap-matcher.ts](../../src/onboarding/sitemap-matcher.ts), [sitemap-fetcher.ts](../../src/onboarding/sitemap-fetcher.ts); identity/authority/confirmation gates [official-page-identity.ts](../../src/onboarding/official-page-identity.ts), [official-page-confirmation.ts](../../src/onboarding/official-page-confirmation.ts), [page-verifier.ts](../../src/onboarding/page-verifier.ts); browser-investigation workspace tooling (`src/onboarding/browser-investigation/`) which stays workspace-scoped — its output is untrusted proposal evidence and can never be used as trusted item evidence directly.
- Proposed: `acquireItemEvidenceGap(itemId, gapSpec, budget)` code-owned dispatcher in `src/onboarding/item-evidence-acquisition.ts` with per-item and batch monetary/resource limits enforced before dispatch; role admission policies (`admitOfficialPageEvidence`, `admitDistributorEvidence`, `admitRetailerCorroboration`, `admitAttestedEvidence`) in `src/onboarding/evidence-admission.ts`, each taking candidate facts (whatever the collection method) and returning admit/reject with reason; shared accepted-fact representation = WP1 `AcceptedItemEvidence`.

### Data and mutation contracts

- Gap specs are explicit: `{ itemId, requirementId, missingAxes, attemptedSources }`. Broad search/browser collection is a bounded fallback for specific gaps only; search hits enter as untrusted candidates, never factual authority.
- Retailer corroboration is stored as a separate evidence reference with `sourceRole: retailer_corroboration` — it never overwrites an official `source_url`, and distributor records never gain a fabricated `source_url` (URL-null materialization preserved).
- Browser-collected fields are accepted per item only after role admission (source-authority, exact sellable-item + variant, provenance, conflict, applicable rights). Human listing/classification review remains. Preparation issues scoped work through the existing worker while the item stays in its current stage: no backwards movement through the six stages, valid accepted facts retained, complementary evidence carried on separate accepted-fact/source references.
- Budgets: per-item and batch resource/monetary limits are code-enforced pre-dispatch; a requested monetary limit that cannot be bounded is rejected before dispatch. Both model attempts (including retries) count in actual budgets/cost. Unknown cost stays unknown. No new monitoring subsystem — reuse existing model-call usage/latency records, review decisions, operation receipts.

### Caller cutover

- [job-queue.ts](../../src/onboarding/job-queue.ts) discovery/extraction stages call the dispatcher instead of inline fetch expansion; [product-curator.ts](../../src/onboarding/product-curator.ts) evidence-extraction stage consumes admitted facts through the same eligible-evidence channel; sourcing engine ([sourcing/engine.ts](../../src/onboarding/sourcing/engine.ts)) keeps its entry-policy/mode contract, observe mode unchanged.

### Dependency ordering

- After WP1's accepted-evidence/currentness contracts. WP2 acquisition and WP3 listing implementation may proceed independently once their shared inputs are defined; WP4 canonical cutover requires both complete paths.

### Consumer-visible acceptance scenarios

- Item missing one axis: dispatcher runs the bounded fallback, admits only the gap-matching fact with provenance, checklist entry flips; unrelated axes untouched.
- Retailer-only safety claim → refused; suitable authoritative evidence required.
- Rendered-browser capture of a manufacturer official page for the exact SKU → admitted under `manufacturer_official` role (method noted as `rendered_browser`); the same rendered capture from a retailer page → at most `retailer_corroboration`, never official authority.
- Unbounded request or unresolvable monetary bound → rejected before any fetch/model call, with the reason visible in Needs Attention.
- Browser-investigation workspace output, standing alone, cannot flip an item checklist entry to passed.

### Actual smoke requirements

- Controlled fixture smoke (deterministic suite, no live crawl): gap-spec → admission-decision matrix over role×method combinations with stubbed sources, proving method alone never admits.
- Actual disposable app/API/browser-path smoke (required by this package, no paid live quality claimed): in a disposable workspace, drive one item through gap detection → bounded acquisition dispatch → admission → checklist flip via the real API/worker path, exercising the browser-action plumbing (code-controlled actions, budget pre-checks, receipt audit) against controlled local fixtures — NOT stubbed replay of the decision function alone.
- Separately authorized real-source qualification (not part of package smoke): qualified browser network/isolation route + provider/data-sharing approval + real-batch measurement; only this qualifies live-source behavior. Package smoke and real-source qualification are reported separately and never conflated.

### External activation prerequisites

- Qualified browser network/isolation route (current investigation Tier1 defaults are `render_deferred`; separate rendered extraction exists — qualification required).
- Explicit provider/data-sharing approval for fallback text actually sent.
- Enforceable per-item + batch resource/monetary limits (numbers are activation inputs).

---

## WP3 — Listing preparation: names, canonical classification, grounded copy, images + claim checks + per-item exception/review UI

**Owns:** turning accepted item evidence into a reviewable listing without inventing facts.

### Owning files/seams

- Names: deterministic construction + `selectProductName` boundary in [name-candidates.ts](../../src/classification/name-candidates.ts) / [name-decision.ts](../../src/classification/name-decision.ts); singleton + cohort paths [product-curator.ts](../../src/onboarding/product-curator.ts) (name_consolidation stage) + [cohort-name-coordinator.ts](../../src/onboarding/cohort-name-coordinator.ts) + [cohort-curation/titles.ts](../../src/onboarding/cohort-curation/titles.ts). Full-name format: evidenced brand first, applicable size/count last; Brand and PF7 outside classifier ownership; no universal quantity requirement beyond the approved standard.
- Canonical classification: unchanged ADR 0041 path ([classification-readiness.ts](../../src/classification/classification-readiness.ts), stages in [product-curator.ts](../../src/onboarding/product-curator.ts)). Acquisition supplies accepted own-SKU facts into the classifier's frozen input; the classifier itself performs no fetching, browsing, enrichment, or sibling-fact inheritance.
- Grounded copy: a separate generative model MAY write rich descriptions from accepted attributable facts only — cannot create facts, resolve conflicts, fill omissions, or silently use raw rejected sources. TypeSafe handles bounded judgments, not prose. Existing seams: post-pipeline synthesis in [product-curator.ts](../../src/onboarding/product-curator.ts), verified-v2 distributor authority ([distributor-copy-consolidator.ts](../../src/onboarding/distributor-copy-consolidator.ts)), manual-evidence corrections ([manual-evidence-service.ts](../../src/onboarding/manual-evidence-service.ts)). Proposed `prepareGroundedCopy(itemId)` in `src/onboarding/grounded-copy.ts` that takes only the WP1 accepted bundle + WP2 admitted facts and returns text with per-sentence evidence refs; anything without a ref is dropped before projection.
- Images: existing rights + verification seams [distributor-imagery.ts](../../src/onboarding/distributor-imagery.ts), [image-utils.ts](../../src/onboarding/image-utils.ts), `image-verification/network-gate.ts`; per-image rights approvals in [manual-evidence-service.ts](../../src/onboarding/manual-evidence-service.ts). No inferred image rights.
- Claim checks: `checkListingEvidence` ([listing-evidence-service.ts](../../src/classification/listing-evidence-service.ts)) + pure currentness/gate evaluator, already shared by all release paths — this package wires the grounded-copy output through it and adds per-item exception/review UI.
- UI: extend [ReviewListingEvidencePanel.tsx](../../src/client/components/onboarding/review/ReviewListingEvidencePanel.tsx) + [review-readiness.ts](../../src/client/components/onboarding/review/review-readiness.ts) with per-item standard/exception states (contradicted / not established / unavailable / stale distinctly, anchored to exact field/text + actual evidence, with remove/correct/attest actions); reuse Batch Workspace/Review + Needs Attention flows, no shell redesign.

### Data and mutation contracts

- `CurationData` extensions (`nameDecision`, `listingEvidenceValidation`) keep existing provenance shape: candidate/component refs, exact source spans/offsets/hashes, rule/input/title hashes, producer (`typesafe_selection`|`deterministic`|`manual`), actual call IDs. Deterministic output is never labeled model-authored.
- Final projected title/description (including fallbacks + manual edits) is what gets checked, not only non-null curated fields. Claim units built in code (≤24 bound, overflow visible and unresolved, never partial-green).
- Corrections reuse existing curation rerun/correction + review-currentness flows; consequential edits stale affected judgments/approvals precisely.

### Caller cutover

- Singleton + cohort naming paths migrated together; in-flight incompatible frozen chat naming plans drained/superseded, history left readable, never rebound silently.
- Draft projection ([stages/draft-projection.ts](../../src/classification/stages/draft-projection.ts) via [product-curator.ts](../../src/onboarding/product-curator.ts)) and [draft-promoter.ts](../../src/onboarding/draft-promoter.ts) consume grounded copy + name decisions; review/durable-approval/export/push gates unchanged in shape, extended to the WP1 checklist result.

### Dependency ordering

- After WP1's accepted-fact/standard contracts and the claim-checking interface. Names/copy can be implemented against accepted structured or attested facts while WP2 acquisition is completed; WP4 waits for both acquisition and the full per-item listing verdict. Native GitHub dependencies express these actual prerequisites rather than serializing unrelated implementation work.

### Consumer-visible acceptance scenarios (retain full family/naming/listing scope; no narrowing)

- Official base identity + verified package facts → valid complete name without invented wording or sibling facts; conflicting sizes never union into one title.
- Copied current fact with valid same-SKU span passes deterministically; title claiming 15 lb against 5 lb evidence is contradicted regardless of model probability.
- Included unsupported marketing assertion blocks; removing/correcting it rechecks the actual final projection without a new source/model call when coverage resolves deterministically.
- `not suitable for puppies` source cannot support `suitable for puppies`; sibling/catalog evidence, stale attempts, unverified URLs, fabricated quotes cannot support a claim.

### Actual smoke requirements

- Singleton + cohort naming plus listing checks on supported examples; correct a contradiction; observe review/approval invalidation and recovery; verify the actual Review/Needs Attention surfaces and accessible correction actions (tests alone do not substitute).

### External activation prerequisites

- Fitted per-task proposal/abstention policies published before any sealed-holdout evaluation (existing 0.50/0.70 floors are not copied as thresholds); absent qualified policy leaves the capability unavailable.
- Reviewed description-quality bar for the generative copy model (separate authorization for paid live quality).

---

## WP4 — Item-owned execution/publication/currentness; unrelated-barrier removal; all-callers cutover; family groups + immutable history preserved

**Owns:** the final single item-owned path. No maintained dual orchestration/shims.

### Owning files/seams

- Item-owned execution in [job-queue.ts](../../src/onboarding/job-queue.ts) reuses and strengthens the existing atomic item claim in [onboarding-item-repo.ts](../../src/db/repositories/onboarding-item-repo.ts) (`claimItemsForProcessing`, `claimed_by`, `claimed_at`, stage/status). Bind the claim to an item-run revision and guard publication/reclaim against the observed owner, claim generation and input revision; do not invent a parallel lease table merely to copy cohort fields. Freeze inputs and commit write-once outputs under the item run. Optional batch computation may supply independently bound results, but cannot commit item outputs or gate readiness. Retire the existing cohort freeze/resume/title/page completion authority from the live path while preserving its immutable historical rows.
- Promotion/publication: [promotion-gate.ts](../../src/classification/promotion-gate.ts) (cohort parent-run blocking codes REMOVED from the new item-owned authority path; historical rows keep their recorded codes as history only), [draft-promoter.ts](../../src/onboarding/draft-promoter.ts), [change-set-service.ts](../../src/server/services/change-set-service.ts) (strict consistency-group path for true family groups), [change-set-validation.ts](../../src/validation/change-set-validation.ts), [export-routes.ts](../../src/server/routes/export-routes.ts), [sync-routes.ts](../../src/server/routes/sync-routes.ts).
- Genuine family readiness: ONLY `StorefrontFamilyPlan` lifecycle (`proposed|accepted|rejected|deferred|stale|applied`) in [storefront-family-plan-service.ts](../../src/classification/storefront-family-plan-service.ts) + consistency-group gates. Curation Cohort parent rows play no role in family readiness.
- Work-state/UI: [onboarding-work-state.ts](../../src/onboarding/onboarding-work-state.ts), [batch-release.ts](../../src/onboarding/batch-release.ts); the old `waiting_on_family` category, [FamilyWaitingView.tsx](../../src/client/components/onboarding/families/FamilyWaitingView.tsx), and the `family_barrier` strip ([execution-strip-logic.ts](../../src/client/components/onboarding/execution-strip-logic.ts)) are REMOVED for unrelated items (no rebranding as a family gate). Explicit family-plan operation state (plan lifecycle + per-member readiness within that plan) is shown as a separate surface owned by the family-plan feature, not as a work-state category. Everything else becomes per-item `processing`/`needs_attention`/`ready_for_review`.

### Data and mutation contracts (four distinct durability layers)

1. **SQLite repository transaction:** plan decisions + draft write set + dependency manifest prepared and committed atomically per operation. No model requests inside the transaction.
2. **Filesystem staging/preparation:** changed product files staged under workspace ownership — only the operation's exact changed files, never broad unrelated sweeps. A pre-commit failure leaves the change set unapproved and restores only operation-owned writes (never unrelated user changes).
3. **Single approved Git commit (catalog authority):** prepared only after layers 1–2 validate. A per-product write/index failure MUST prevent the commit. No partial approved family.
4. **Idempotent recovery against the commit:** after the commit exists, index/status/receipt completion resumes idempotently against that exact commit — never a second commit, never a partial-approval success claim, never history rewrite. Crash before the commit → group unavailable for export until reconciled to the last approved Git state or the exact write set completes.
- Model work deduplication: reuse requires exact equality of evidence/identity/candidates/order/authority/rules/prompt/model/policy; revalidate ownership, provider enablement, hashes, run compatibility before dispatch/retry/commit; stale work unapplied; per-item actual call IDs recorded (no synthetic one-call provenance).
- Migration: old parent-owned cohort outputs stay readable as history. Completed decisions remain immutable; compatible historical results may be referenced only under exact-equality reuse rules. Drain/supersede incompatible in-flight work rather than rebinding it. Remove obsolete live parent gates while preserving ownership/currentness safeguards under item authority and retaining recorded historical diagnostics.

### Caller cutover (all together)

- [job-queue.ts](../../src/onboarding/job-queue.ts) (claim/advance), [onboarding-work-state.ts](../../src/onboarding/onboarding-work-state.ts) + [batch-release.ts](../../src/onboarding/batch-release.ts) (partition/counts; `waiting_on_family` removed), [FamilyWaitingView.tsx](../../src/client/components/onboarding/families/FamilyWaitingView.tsx) + [Onboarding.tsx](../../src/client/components/Onboarding.tsx) tabs (old family-waiting tab removed; separate family-plan surface added), [promotion-gate.ts](../../src/classification/promotion-gate.ts) + [draft-promoter.ts](../../src/onboarding/draft-promoter.ts) (per-item promotion), [onboarding-routes.ts](../../src/server/routes/onboarding-routes.ts) review-complete/draft paths, [onboarding-review-repo.ts](../../src/db/repositories/onboarding-review-repo.ts), [change-set-validation.ts](../../src/validation/change-set-validation.ts), [export-routes.ts](../../src/server/routes/export-routes.ts), [sync-routes.ts](../../src/server/routes/sync-routes.ts) (uniform per-item + family-group checks). One canonical cutover; rollback is disable-to-unresolved/manual or reviewed code revert.

### Dependency ordering

- After WP1–WP3.

### Consumer-visible acceptance scenarios

- Ready item A promotes/drafts/exports while unrelated item B in the same batch is still extracting or failed — A never waits on B; no `waiting_on_family` or `family_barrier` appears for unrelated items.
- Genuine family (shared plan, e.g. three sizes): all-or-nothing approval/export via the family-plan/consistency-group gate; stale member evidence blocks the whole group; fault injection at each durability layer (SQLite commit failure, pre-commit file failure, commit failure, post-commit receipt failure) proves no partial approved family + idempotent recovery without unrelated file changes.
- Deferring/rejecting a family proposal preserves standalone progression and existing relationships.
- Cross-batch catalog joins (new size joins approved members) work without duplicates, main changes, or lost labels.

### Actual smoke requirements

- Disposable catalog workspace: prepare/review a family with existing + new members, approve one complete commit, inspect actual exported XML/PF7 values, inject failures at each of the four durability layers; single-item ready/blocked-unrelated promotion run; actual Review/Needs Attention/family-plan surfaces.

### External activation prerequisites

- Redacted real store-family export confirming native reference/ordering/child-metadata/template purchase behavior before managed authoring release; store-compatible canary access for import/finalize/publish proof (WP5).

---

## WP5 — End-to-end deterministic/smoke validation, baseline-vs-candidate qualification, reviewed canary, controlled activation

**Owns:** proof, not permission for partial production activation.

### Owning files/seams

- Deterministic suite: existing Bun/Vitest conventions; permanent regression tests target consumer-visible D/F/N/E-class bugs (fault/replay/concurrency, cross-workspace rejection), never source-text/wiring/mock echoes.
- Benchmark harness: family-separated dev/holdout partitions (same family/near-duplicate never leaks across partitions); frozen source evidence, candidate coverage, rules, gold, policy versions before scoring; existing TypeSafe/qualification seams ([model-operation-registry.ts](../../src/classification/model-operation-registry.ts), [systemone-transport.ts](../../src/ai/systemone-transport.ts) bounds: 32 questions, 255 options, 32 768 state bytes, 65 536 request bytes).
- Canary/activation: offline replay → fully reviewed supported canary → canonical activation, using existing adapter (`uniqueName=SKU`, exact `return_string` for `dbmake.cgi`, successful completion before `generate.cgi`; `newRecords=no` never for family creation; never `(none)` matching; never split a family across batches).

### Data and mutation contracts

- Gold labels and prediction bundles immutable and content-addressed; evaluation reads frozen inputs + submitted predictions only, never the latest operational run.
- Same-population baseline-vs-candidate comparison reporting unanswered/failed rows and retrieval misses (never answered-overlap only); P50/P95 end-to-end timings + actual billed/observed usage where available; unknown cost unknown, never zero.
- Sealed holdout contents/credentials never in docs. Underpowered/unlabeled/stale/mock-only/unreviewed evidence yields blocked qualification.

### Caller cutover

- None (validation only). Qualification never auto-enables a feature or auto-accepts a proposal; no automatic authority from probability alone.

### Dependency ordering

- Last. Requires WP1–WP4 complete slices, each with schemas, persistence, all active callers, review behavior, docs, and real smoke evidence.

### Consumer-visible acceptance scenarios

- Same frozen population: baseline (current parent-owned path) vs candidate (item-owned path) on quality (correct-URL coverage, selection precision, group precision/recall, harmful merges, material-fact preservation, missed contradictions, false blocks) + efficiency (request/token cost incl. retries, verification/network work, operator time-to-reviewed-listing) with named denominators.
- Fully reviewed canary: all expected sizes including the main purchasable, labels distinguish variants, unrelated data preserved, partial failures never marked synced.
- Failed/partial remote import retains the complete approved group + existing sync/reconciliation evidence; resume through the supported adapter/operator workflow.

### Actual smoke requirements (all five)

1. Discovery through retrieval → typed decision → verifier → operator/confirmed outcome on supported source examples.
2. Singleton + cohort naming plus listing checks; correct a contradiction; observe review/approval invalidation and recovery.
3. Disposable catalog workspace family prepare/review → one complete commit → exported XML/PF7 inspection → per-layer fault injection (SQLite, filesystem, commit, receipt).
4. Separately authorized store-compatible canary: complete import/finalize/publish + storefront inspection.
5. Actual Review/Needs Attention surfaces + accessible correction actions.

### External activation prerequisites (all must be satisfied before activation; none follows from a mocked/offline check)

- Reviewed versioned per-type standards; enforceable per-item + batch limits; qualified browser route; provider/data-sharing approval; real-batch outcome/cost/operator measurement.

---

## Honest limitations / unresolved factual prerequisites

- Per-type `ListingCompletenessStandard` content, exception-eligible requirement lists, and numeric budgets: unknown until reviewed — intentionally not invented here.
- Actual costs/operator savings: unqualified; no dollars, accuracy thresholds, sample sizes, or saved minutes are claimed.
- Browser network/isolation qualification, rendered-method capture proof, and provider/data-sharing approval: pending.
- Managed-family activation still requires an inspected redacted real store-family export and compatible canary proof of native references, ordering and template behavior; this documentation delivery does not establish that qualification.
- No sealed holdout content is part of this plan or its documentation research.
