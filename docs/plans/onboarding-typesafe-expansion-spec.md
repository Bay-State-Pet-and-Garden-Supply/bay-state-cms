# TypeSafe onboarding expansion specification

**Date:** 2026-10-19  
**Status:** Owner-approved direction; complete specification for implementation review. No runtime implementation or live qualification is claimed.  
**Scope:** Official product-page candidate selection; storefront Product Families, Subproducts, and Short Names; evidence-backed product naming; listing-evidence support and contradiction checks.

**Tracker specification:** [#362 — TypeSafe onboarding expansion](https://github.com/Bay-State-Pet-and-Garden-Supply/bay-state-cms/issues/362), published with `ready-for-agent`.

The owner approved specifying all four capabilities, preserving existing Main Products, using a real member SKU for a new Main Product, searching both the current import and approved catalog, and using product-type-specific Family Variant Rules. Engineering defaults below are explicit, conservative proposal defaults, not claims of measured model performance or authorization to modify the live store.

## 1. Outcome and limits

The primary outcome is less operator work per correctly reviewed listing, with API cost, incorrect SKU/variant matches, and harmful family merges as guardrails. Replacing remaining chat calls is useful; adding inference to deterministic grouping must earn its cost through improved grouping or reduced review effort.

Deliver all four capabilities through the existing Sourcing → Discovery → Extraction → Curation → Review → Promotion pipeline, using the existing worker, model transport, repositories, review workflow, Git change sets, codec, and ShopSite adapter.

Non-goals:

- No discovery agent, autonomous browsing loop, external web-search provider, generic AI orchestration framework, or new telemetry platform.
- No runtime model extraction, model-selected source-page variants, inferred image rights, invented product facts, or automatic catalog approval.
- No migration of historical Curation Cohorts into storefront families. No whole-catalog reclassification, reparenting, or retrospective rewrite of old judgments.
- No changes to the classifier's catalog-field allowlist. Brand/PF16, Child - Short Name/PF7, native Subproducts, and cross-sell/PF32 remain outside classifier ownership.
- No new display-only parent products, synthetic UPCs, SKU replacement, automatic changes to existing filenames, or enabling new products. New products remain disabled for the owner's ShopSite review.
- No changes to existing Curation Cohort readiness, lease ownership, write-once outputs, classification review authority, or the existing qualification/comparator-retirement gates.

## 2. Current implementation evidence

These are starting facts, not claims that the specified behavior already exists.

| Area | Existing implementation and consequence |
|---|---|
| Official-page retrieval | [source-discovery.ts](../../src/onboarding/source-discovery.ts) uses approved-domain local index and sitemap retrieval. [sitemap-matcher.ts](../../src/onboarding/sitemap-matcher.ts) shortlists up to ten URLs and `selectWithLlm` calls `discovery_candidate_selection`, parses text, and conflates no-pick/service failure in its overlap fallback. This is an existing-chat replacement opportunity. |
| Official-page authority | [official-page-identity.ts](../../src/onboarding/official-page-identity.ts), [official-page-confirmation.ts](../../src/onboarding/official-page-confirmation.ts), [page-verifier.ts](../../src/onboarding/page-verifier.ts), and [job-queue.ts](../../src/onboarding/job-queue.ts) separately enforce identity, variant, domain, confirmation, and auto-selection conditions. Category Page imports are not the authority for manufacturer product URLs. |
| Internal grouping | [product-line-grouper.ts](../../src/onboarding/product-line-grouper.ts) removes flavor/life-stage/size/color/modifier terms. Its candidate cohorts coordinate Curation; they are not storefront family authority. |
| Native family fields | [product-codec.ts](../../src/shopsite/product-codec.ts) preserves Subproducts as raw advanced XML blocks. [product.ts](../../src/shared/schemas/product.ts) has no first-class editable Subproducts relationship. The [field certification](../audits/extra-fields-certification-2026-10-15.md) identifies PF7 as `Child - Short Name`; [classification-ownership.ts](../../src/classification/classification-ownership.ts) protects it from classifier writes. |
| Naming | [name-consolidation.ts](../../src/classification/stages/name-consolidation.ts), [title-consolidation.ts](../../src/onboarding/title-consolidation.ts), [cohort-name-coordinator.ts](../../src/onboarding/cohort-name-coordinator.ts), and [cohort-curation/titles.ts](../../src/onboarding/cohort-curation/titles.ts) contain singleton/cohort chat naming, deterministic guards, and durable coordinated outputs. Both active naming paths must be migrated. |
| Listing evidence and review | [onboarding.ts](../../src/shared/schemas/onboarding.ts) stores title/description provenance and semantic validation, but no general per-claim evidence judgment. [review-completeness.ts](../../src/classification/review-completeness.ts), [review-completion-gate.ts](../../src/classification/review-completion-gate.ts), [onboarding-review-repo.ts](../../src/db/repositories/onboarding-review-repo.ts), and [draft-promoter.ts](../../src/onboarding/draft-promoter.ts) enforce readiness and approval. Preparation gaps currently cover correctable title/description gaps, not arbitrary optional fields. |
| Publication | [change-set-repo.ts](../../src/db/repositories/change-set-repo.ts) stores draft/base JSON per SKU; [change-set-service.ts](../../src/server/services/change-set-service.ts) writes files/index rows in a loop and can commit successful writes despite another item's error. One Git commit does not currently establish all-or-nothing family approval. |
| Export and drift | [change-set-validation.ts](../../src/validation/change-set-validation.ts), [sync-routes.ts](../../src/server/routes/sync-routes.ts), and [export-routes.ts](../../src/server/routes/export-routes.ts) provide existing validation and publication seams. Export reads approved change-set item JSON; workspace edits alone do not update that approved export payload. |

### External contracts

- TypeSafe [API](https://docs.typesafe.ai/api.md), [state](https://docs.typesafe.ai/concepts/state.md), [Choice](https://docs.typesafe.ai/primitives/choice.md), and [confidence](https://docs.typesafe.ai/confidence.md): code supplies state/options, receives typed judgments/probabilities, and retains control. Question IDs are not model-visible instructions.
- Closest patterns: [reranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md), [entity alignment](https://docs.typesafe.ai/cookbooks/entity_alignment.md), [source-value selection](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook.md), and [claim/citation verification](https://docs.typesafe.ai/cookbooks/citation_check.md). Their example scores/thresholds are not Bay State acceptance policies.
- ShopSite [Subproduct FAQ](https://help.shopsite.com/help/current/en-US/sc/pro/working/faq.prod.subproducts.html): adding Subproducts normally hides the main product's own purchase controls; include the main product as its own Subproduct to keep it purchasable. Subproducts can also describe accessories, so an existing native relationship is not automatically proof of a Product Family.
- ShopSite [database field documentation](https://help.shopsite.com/help/15.0/en-US/sc/pro/upload.fields.html) and repository ShopSite skills govern field/wire behavior. Complete native relationship authoring must be verified with a real, redacted store-family export, not inferred from fixture XML alone.

## 3. Shared execution contract

### 3.1 Decisions, authority, and failures

Each capability produces a reviewable decision over supplied evidence/options. It does not execute catalog writes. Use Choice and, where independently useful, Noul; the application's existing System One schema supports those primitives. Score/image capabilities are unnecessary for this design.

Persist operation-specific results with: decision ID; workspace/item/SKU or family-plan identity; immutable input hash; relevant evidence/candidate IDs; prompt/rule/model-policy versions; requested and returned model; raw typed answers and distributions; selected probability and concentration confidence where returned; model-call IDs; terminal outcome/reason; producing run/revision. A request with several answers has one producing call ID, not invented calls per answer.

Keep semantic outcomes separate from execution outcomes:

- `selected` or a task-specific positive judgment: a bounded proposal, never approval.
- `no_match`: the supplied candidates do not fit, not a service error or a claim that the manufacturer does not stock the product.
- `insufficient_evidence`: evidence cannot distinguish the allowed outcomes.
- `candidate_limit_exceeded`: the operation cannot cover its eligible candidate set within its declared bound; never silently first-N clip an adjudication set.
- `policy_denied`, `unavailable`, `failed`: transport/configuration outcomes, never semantic abstention credits.
- `stale`: a result no longer matches its input/configuration/base state; retain history but refuse application.

Use the existing transport and audit repositories; add the necessary protected operation registrations and frozen execution-plan entries. Discovery's existing `sitemap_selection` operation can receive a versioned typed implementation. Naming/family/evidence operations must be explicit judgment workloads, not System One connections passed through chat/naming endpoints. Do not weaken the existing chat/vision/workload capability guards.

Use the evaluated configured model pin, currently `jev-1.13.0`, through the existing model-policy mechanism. No silent switch to `jev-latest`, chat provider, reasoning model, or another model after failure. Any new pin requires its own qualification. Existing credential resolution remains server-side; no credentials in browser state, model state, logs, or Git.

Raw model confidence is distribution concentration, not store accuracy or approval authority. Fit task-specific proposal/abstention policies on development data, publish them before evaluating the sealed holdout, and include the policy hash in execution/reuse keys. Do not copy classification's engineering 0.50/0.70 floors into these tasks as fitted thresholds. An absent qualified policy leaves the capability unavailable; the existing manual workflow remains available.

### 3.2 Bounds and reuse

Honor the current application bounds in [systemone-transport.ts](../../src/ai/systemone-transport.ts): at most 32 questions, 255 Choice options, 32,768 state bytes, and 65,536 serialized request bytes. The vendor's larger HTTP allowance does not authorize increasing application limits.

| Capability | Declared logical-request bound | Candidate/question bound |
|---|---|---|
| Official-page selection | One request per item and mapped official domain requiring disambiguation | Existing retrieval shortlist: at most ten URL candidates; one Choice plus two abstention options |
| Family membership | One request per item needing semantic disambiguation | At most sixteen eligible family anchors; one independent relationship Choice per anchor |
| Naming | One request per SKU needing semantic selection | At most sixteen complete evidence-backed name candidates; one Choice plus two abstention options |
| Listing evidence | One request per SKU needing semantic checks | At most 24 current claim units; one Choice per claim; deterministic checks need no question |

These are engineering caps, not measured optimal batch sizes. Empty/unambiguous deterministic work makes zero model requests. Preserve the existing transport's single transient retry within its caller budget; no additional retry stack, schema-repair model call, recursive fan-out, or unbounded overflow chunking. Both attempts count in actual budgets and cost. Exceeding any cap produces an actionable unresolved result with counts; never certify only the inspected prefix of a listing/group.

Batch independent questions over the same state. A question cannot depend on another answer in the same request. Use named JSON state and explicit criteria; external page/provider text is untrusted content, never execution instructions. Send only the required source snippets and identities, not whole catalog exports, images, credentials, or unrelated product evidence. Source URLs containing secrets must be excluded/redacted before dispatch.

Reuse requires exact equality of relevant evidence, item identity, candidate set/content/order, source/domain authority, family/catalog base, rules, prompt, evaluated model, and frozen policy. Reuse of a model judgment does not reuse human approval. Revalidate ownership, live provider enablement, current hashes, and immutable-run compatibility before dispatch, before retry, and before committing results. Leave stale work unapplied.

Explicit route/data-sharing approval must cover each new operation and its actual cloud-bound text. Classification consent is not blanket consent for all listing evidence. Reuse existing model-call usage/latency records, review decisions, and operation receipts rather than adding a monitoring subsystem.

## 4. Official product-page candidate selection

### 4.1 Interface and inputs

Replace the free-text selector inside the existing sitemap matcher with a typed `selectOfficialPageCandidate` interface. It receives a frozen register item, approved-domain snapshot, retrieval-run/generation identity, and candidate IDs mapped to original URLs and available cached metadata. It returns a selected candidate ID or an explicit terminal outcome, with the shared provenance envelope. It performs no retrieval or catalog write itself.

State includes the original Register Name, SKU/UPC, evidenced brand, known package/variant tokens, approved domains, and each shortlisted URL with available title/snippet/structured identity. Missing page evidence is explicit. Do not synthesize a new expected name or use a curated name as the identity reference.

The Choice asks which candidate is the best product-detail-page candidate for that register item, rather than a merely related product, listing, or blog page. Options reference complete candidate descriptions and include `no_match` and `insufficient_evidence`. An option ID maps to exactly one original URL; no URL generation, substring extraction, or off-shortlist selection is accepted.

### 4.2 Workflow and composition

1. Retain approved-domain index/sitemap retrieval and deterministic product-URL filtering. Freeze and deduplicate variant-aware URL identities using existing helpers.
2. Preserve deterministic exact-proof paths. A unique verified exact identity under approved domain authority does not need a semantic selection call. A UPC appearing in a URL alone is not that proof.
3. With one candidate, fetch/verify it normally; do not call TypeSafe merely to choose it. With multiple candidates requiring disambiguation, use the bounded typed selector.
4. Feed the selected candidate into the existing page-verifier/confirmation/variant/profile flow. A high-probability choice does not relax any confirmation or auto-selection condition.
5. Keep retrieval score, model probabilities, and deterministic verification outcome as distinct fields. Remove the selected candidate's artificial `+0.15` LLM-confidence boost from this new decision path.
6. On `no_match`, `insufficient_evidence`, or service failure, retain safe retrieved candidates for operator inspection with the actual reason. Do not turn the token-overlap top result into a successful semantic selection. Independently established deterministic proof may still be used on its own authority, not mislabeled as a Jev success.
7. Confirmation uses existing append-only official-page decisions and server-side re-verification. Recheck redirects/final host, frozen allowed domains, exact variant, and item/run identity before changing `source_url`.
8. Domain/evidence/candidate changes invalidate the selector result. Category Page IDs, page-import hashes, and ShopSite browsing-page options are unrelated and must not enter this decision's authority checks.

The selector cannot recover a URL absent from retrieval. Report correct-URL shortlist coverage separately from selection precision. Retrieval misses go to the existing official-site exception workflow; do not silently add external search or larger paid crawls.

Distributor-record items retain their URL-null Discovery bypass. TypeSafe is never used to manufacture a URL for them.

### 4.3 Acceptance

- **D1:** Exact approved-domain identity/variant cases remain correctly resolved without a model-dependent regression.
- **D2:** Similar flavor, wrong size, collection page, retailer, off-domain redirect, and ambiguous variant candidates cannot become Confirmed Official Pages from model confidence.
- **D3:** A valid manufacturer page lacking a UPC is not automatically rejected merely for that absence; existing name/variant/operator confirmation rules remain distinct from stricter automatic selection proof.
- **D4:** An omitted correct URL is recorded as a retrieval miss, not a selector success or model error on an unseen candidate.
- **D5:** No-match, insufficient evidence, disabled provider, timeout, malformed response, and candidate overflow remain distinguishable; none is converted into a positive overlap match.
- **D6:** A forged/out-of-set candidate ID or response-question mismatch is rejected before selection persistence.
- **D7:** A stale run/domain/candidate result cannot overwrite a newer source confirmation. An operator can replace a bad candidate and resume the normal flow.
- **D8:** New official confirmation still requires a usable extractor profile before automated page Extraction; distributor-record bypass remains profile-free and zero-fetch.

## 5. Storefront Product Families, Subproducts, and Short Names

### 5.1 Family identity and rules

A Product Family is one underlying product under an explicit, versioned Family Variant Rule. A Curation Cohort, shared category, name stem, common brand, same manufacturer page, or similar packaging is not sufficient proof.

Family rules are approved listing configuration stored with the catalog's versioned configuration, separate from classifier export mappings. Resolve a rule through configured canonical Product Type identities, not a model-invented type label. A provisional type may help prepare a proposal, but final acceptance requires current reviewed type/rule authority. No configured rule means no automatic family proposal; standalone listing remains possible.

Each rule defines: stable ID/version; applicable Product Type IDs; invariant axes; permitted variation axes; explicitly non-applicable axes; required evidence; quantity/unit normalization; Short Name axis order; and display ordering. A missing invariant is unknown, not agreement. Version/hash changes stale dependent plans.

- **Food:** same evidenced brand, product line/recipe, flavor, species, life stage, and form. Package size may vary. Pack/count may vary only when the applicable approved rule explicitly permits that retail-unit relationship. A single bag and a shipping case of bags are not silently interchangeable.
- **Non-food:** allow configured size/color/count axes only when members are otherwise the same model/product. Preserve material, function, safety/dose, strength/hardness, fit, and other product-specific identity differences as invariants unless explicitly declared legitimate variants.
- Exact unit conversions are deterministic and dimension-aware. Equal net weight does not imply equal pack structure; never confuse shipping weight with net contents. Ambiguous units or duplicate variant tuples require operator resolution.

Existing native Subproducts may represent accessories or historical merchandising. Treat them as relationship evidence, not automatically as managed families. Adoption requires a complete preview and explicit review; unsupported/ambiguous native structures remain preserved and unmodified.

### 5.2 Candidate generation and TypeSafe judgment

Search the current import and existing approved catalog. Catalog references use `(workspaceId, sku)` and immutable approved-product hashes/commits; preserve existing `Product.id`, native IDs, and SKU. Do not create a duplicate file for an existing SKU or infer catalog identity from a newly decoded UUID.

Use deterministic brand/type/rule blocking, source identifiers, and a high-recall name/model shortlist to find plausible family anchors. Do not compare the entire catalog pairwise. The existing stem grouper can contribute candidates, but cannot decide storefront membership or be the only candidate-recall mechanism.

For at most sixteen eligible anchors, ask an independent Choice about the incoming SKU and each supplied family's common product identity:

- `same_sku`: the descriptions may be the same sellable item; route to existing identity/duplicate resolution, never merge records through a family judgment.
- `same_family`: same underlying product and invariants; differences are exclusively permitted axes.
- `different_product`: related or unrelated products that do not share this family identity.
- `insufficient_evidence`: any required invariant/relationship cannot be established.

Provide each anchor's reviewed common identity, rule, member variant tuples, relevant evidence, and existing relationship metadata. A small semantic sample must not hide conflicting member invariants. Code checks the incoming member against every existing member's hard invariants/variant tuple and checks the full proposed group before acceptance.

There is no transitive union of positive pairwise results: A~B and B~C cannot override an A/C conflict. Two different existing families matching the same incoming product produce a conflicting-family proposal requiring operator resolution, not an automatic family merge/reparent. Reviewed negative decisions remain attached to their exact evidence/rule revisions.

### 5.3 Main Product and Short Names

Preserve an existing Main Product, its identifiers, filename/URL, and unrelated listing data. Never replace a main because a smaller/newer size arrives.

For a new family, nominate a real member SKU. The reversible engineering default is the smallest verified comparable package size; sort ties by a stable SKU key only after duplicate variant tuples have been resolved. If sizes are not comparable or the product's rule lacks a valid ordering, require a main selection. The operator may select another real member during family review. A newly created family requires at least two distinct purchasable SKUs.

The new main remains in the Subproducts member list exactly once, so its own size remains purchasable. This permitted main-to-self relationship must not be rejected by a generic cycle rule; all other self-links, recursive multi-product cycles, missing references, and conflicting managed-family membership fail validation. Preserve pre-existing nonstandard main structures unless an explicit reviewed adoption/change handles them.

Keep each SKU's full Name, price, stock, images, classification, evidence, and enablement state independent. No shared-fact inheritance and no automatic removal of the main's size from its full Name.

Generate new Short Names deterministically from verified permitted axes:

- Size-only food family: `5 lb`, `15 lb`, `30 lb`.
- A configured size/color family: include both axes in the rule's order, e.g. `Small / Red`.
- Pack information appears when required to distinguish permitted retail units, not by guessing from total weight.

Names must be nonempty and unique across the full family, including existing catalog members and the main. Preserve existing nonempty PF7 values by default; expose a replacement only as an explicit reviewed diff. Do not use extra model calls for formatting or assign a Short Name just because unrelated products share a Curation Cohort.

### 5.4 Durable plan and canonical representation

Introduce a listing-owned `StorefrontFamilyPlan` Zod contract and repository-backed durable revisions, not classifier `field_assignment` proposals. Required plan data:

- Plan/revision/workspace identity and operation (`create`, `join`, `adopt`, or explicit membership edit).
- Main SKU, complete ordered member SKU set, resolved source-item links, rule identity/hash, invariant facts and each member's permitted-axis values with evidence references.
- Approved catalog commit and per-SKU base/read hashes; existing relationship block hash; pending draft conflicts; changed-product write set and unchanged-member read dependencies.
- Proposed PF7 values and preservation/replacement disposition; typed model judgments/call IDs; input hash; human decision actor/time/revision; linked change-set ID and eventual approval commit.
- Lifecycle `proposed`, `accepted`, `rejected`, `deferred`, `stale`, `applied`. `applied` means the approved catalog commit contains the change, not that ShopSite publishing succeeded. Remote delivery uses existing sync status.

Persist plans/members/decisions through repositories and the existing migration runner. Revisions and decisions are append-only; rejecting/defering a proposal does not erase history. Scope membership exclusivity to managed Product Families, not all accessory/native Subproducts relationships.

Add an explicit managed family relationship to `Product.shopsite` through the shared product schema: `subproducts: null | { kind: 'family', ruleId, ruleVersion, memberSkus }`. The containing product is the Main Product; it owns the only canonical member list. PF7 remains `customFields.ProductField7`, not a duplicate persisted `shortName` field. Database family indexes are rebuildable projections of approved Git product files, not a second canonical catalog.

For unmanaged/legacy records, null/absence means preserve the raw native Subproducts block without reinterpretation. Explicit adoption populates the structured relationship. For managed records, the codec owns Subproducts emission and must not also re-emit the preserved raw block. Use approved member snapshots/IDs/names to resolve native references, supplied to the codec by callers; the codec performs no database/network lookup. Preserve every unrelated unknown field/block.

Before authoring is released, obtain a redacted real export of this store's family/main/self relationships. Confirm native reference representation, ordering, supported child metadata, clear semantics, and template purchase behavior. Implement decode/encode inside `ShopSiteProductCodec`, not a competing XML builder or guessed `<ShortName>` tag. A structure that cannot be safely edited with preservation blocks adoption rather than losing fields. Existing raw-block pass-through remains intentional preservation, not a second managed writer.

An explicit member removal/dissolution is a separate reviewed relationship revision; it cannot silently clear PF7 or remove unrelated accessory relationships. A reviewed clear must have verified ShopSite wire semantics, not rely on omitting a populated block.

### 5.5 Review, change sets, and all-or-nothing publication

Family review shows every member and its origin, preserved Main Product or new nomination, invariant evidence, changing axes, PF7 before/after, complete Subproducts diff, affected existing products, and stale/conflict reasons. Actions: accept the current complete plan; revise membership/main/Short Names with revalidation; reject; or explicitly defer and continue without applying the proposed family change. No confidence-based bulk acceptance or silent catalog joins.

A deferred/rejected/insufficient family proposal does not force a standalone valid product to wait for hypothetical family formation. Existing Curation Cohort readiness still applies independently. Once the operator chooses a family change, its required member dependencies must be ready; do not publish the new relationship with unresolved/new children missing.

Prepare one consistency group in the existing change-set path:

1. Resolve each SKU against the approved catalog and pending drafts. Existing SKU means update with its true base; absent SKU means create. Never overwrite a competing active draft or manufacture a second catalog identity.
2. In one SQLite transaction, create/update the family plan's changed product drafts and its complete read/write dependency manifest. Include the main, all new products, and every changed PF7/native relationship. Unchanged approved members are read dependencies, not needless rewrites.
3. Recheck all members' evidence/review authority, variant rules, classification/listing readiness, filenames, membership uniqueness, drift (`open` or `in_reconcile`), current base hashes, and other pending family/draft conflicts at approval. Any stale/invalid dependency blocks the whole family change.
4. Extend existing approval with a strict consistency-group path. Serialize publication under workspace ownership; stage only the operation's exact changed files, never broad unrelated `products/` or `store/` changes. Prepare/validate the complete write set before publishing any approval result.
5. A per-product write/index failure must prevent a partial family Git commit. Restore only operation-owned pre-commit writes under the ownership guard; never reset unrelated user changes. Keep the change set unapproved on pre-commit failure. Crash recovery must keep the group unavailable for export until it has reconciled to the last approved Git state or completed the exact prepared write set.
6. The single complete Git commit is catalog authority. After it exists, recovery resumes idempotent index/status/receipt completion against that commit; it does not invent a second commit, declare a partial approval successful, or silently revert approved history. Filesystem, SQLite, and Git are not falsely treated as one ACID transaction.
7. The approved export payload and dependency manifest must describe that same commit. Resolve unchanged member records from that immutable commit, not mutable workspace files. Child-name/native-reference changes are relationship dependencies too. Any related later change that invalidates an approved family's pending export requires revalidation/new review, not an unreviewed payload rewrite.
8. Apply family completeness/currentness checks to both package export and direct push, not just the review UI. Required new/changed members cannot be split across independent uploads/change sets. A reference to an unchanged remote member requires verified remote existence/currentness; otherwise include its required record in the same publication group.

ShopSite upload is not claimed to be an atomic multi-record transaction. Use the existing adapter, stable `uniqueName=SKU`, complete family payload, its exact returned MIME `return_string` for `dbmake.cgi`, and successful completion before `generate.cgi`. Include actual new members using appropriate new-record handling; `newRecords=no` silently ignores unmatched rows and is not safe for family creation. Never use `(none)` matching, which risks duplicates. Do not split a family across batches or assume undocumented Subproduct ordering/forward-reference behavior; prove it in the store-compatible canary.

On remote timeout/partial import, retain the complete approved group and existing sync/reconciliation evidence, do not mark a subset or the whole family synced, and do not create replacement SKUs/parents. Resume/reconcile through the existing supported adapter/operator workflow; publish only after the complete import/linking result is established. This cannot promise zero intermediate remote state; the UI must report that limitation truthfully. Keep unrelated prices/inventory/status and unknown fields unchanged, and never enable new products as part of the family operation.

### 5.6 Acceptance

- **F1:** Same recipe/flavor in three sizes produces one reviewable family with three distinct SKU members and size Short Names. A different flavor, recipe, species, life stage, or form does not join it.
- **F2:** Configured non-food size/color variants can join; differing material/function/dose or an undeclared axis cannot. Missing invariants never pass as equality.
- **F3:** A new imported size can join approved catalog sizes from earlier batches without duplicate records, changed existing main, or lost existing members/labels.
- **F4:** Adding a smaller size preserves the existing main. A new comparable-size family receives the documented nomination and can be revised before acceptance.
- **F5:** Main-to-self is emitted exactly once and remains purchasable in the actual template; other cycles and missing/cross-workspace references fail.
- **F6:** Same-SKU ambiguity and two matching existing families require identity/family resolution; no transitive bridge merges incompatible endpoints.
- **F7:** Full names, per-SKU facts, prices, inventory, images, filenames, enablement, unrelated Subproducts/accessories, PF32, and other unknown fields survive unless explicitly changed by their owners.
- **F8:** Duplicate/blank Short Names, ambiguous net quantity, forbidden pack differences, or duplicate variant tuples prevent accepting an unsafe family plan.
- **F9:** Classifier write attempts to PF7 or native Subproducts remain refused; listing-owned reviewed edits work through their explicit contract.
- **F10:** Unmanaged native families round-trip without adoption; managed families emit one Subproducts block; unsupported native structures cannot be destructively adopted.
- **F11:** Member evidence/type/rule/base/draft/drift changes stale the whole affected plan. No family subset can bypass approve/export/push checks.
- **F12:** Fault injection before any member write, between writes, before Git commit, after commit, and before receipt completion proves no partial approved family and safe idempotent recovery without unrelated file changes.
- **F13:** A failed or partial remote import is not reported as a synced family. A real compatible canary proves reference matching, self membership, labels, ordering, and purchase behavior before activation.
- **F14:** Rejecting/defering an unapplied proposal preserves standalone listing release and all existing relationships; it does not rewrite or dissolve a family implicitly.

## 6. Evidence-backed product naming

### 6.1 Interface and deterministic candidate construction

Replace text synthesis with a `selectProductName` interface in the existing name-consolidation flow. Input is one SKU's frozen eligible title/fact evidence, approved normalization/format rules, and optional cohort presentation context. Output is a selected name candidate ID, exact component/source references, normalized full name, producer (`typesafe_selection`, `deterministic`, or `manual`), input hash, and call IDs. It does not mutate evidence or classify the product.

Candidate construction and rendering are deterministic:

1. Read the original Register Name/raw register text, confirmed official product evidence, accepted distributor materialization, existing OCR results, and current operator-attested evidence for this SKU. Do not run OCR/fetches to satisfy a naming request.
2. Exclude unresolved source/identity/variant conflicts and stale evidence. Preserve known Brand/size/count/color authority. Conflicting sizes must not be blindly unioned into the title by a restoration helper.
3. Build source-backed complete candidates from exact source spans/components plus whitelisted existing abbreviation/unit/whitespace normalization. Never drop material model/recipe/form/life-stage terms merely to make siblings look alike. Preserve qualifiers such as `not`, `free`, and package/unit distinctions.
4. Format full names as evidenced brand + product identity + required variant detail, with size/count at the end under current house style. Brand casing comes from evidenced/approved identity, not invented capitalization. No change to PF16 Brand ownership.
5. Collapse semantically identical formatting candidates before inference. One valid candidate or a purely stylistic choice is deterministic; call TypeSafe only when semantic interpretation selects among genuinely different valid source-backed candidates.

The Choice asks which supplied complete candidate most accurately names this SKU without losing or inventing identity/variant facts. Include `no_match` and `insufficient_evidence`. Code copies/renders the chosen candidate; the model returns neither a new title nor new component text. More than sixteen required candidates is explicit overflow, not first-N clipping or an uncontrolled Cartesian product of source fragments.

Sibling context may establish formatting vocabulary or which permitted axis must distinguish labels. It is never evidence for this SKU's flavor, size, ingredient, species, brand, or Product Classification. Short Names remain the deterministic listing-owned output described in section 5, separate from the full-name selector.

### 6.2 Active paths, persistence, and failure

Update singleton and cohort naming together: the shared consolidator, name-consolidation stage, active cohort coordinator/title persistence, shared source enums/provenance, draft projection, title validation, Review, and Promotion consumers. Preserve the existing lease-guarded all-or-nothing/write-once parent title-output contract. If per-SKU decisions are composed into a cohort output, record each member's actual producing call ID; no synthetic one-call provenance for several requests.

Extend `CurationData` with a `nameDecision` record containing the selected candidate/components, exact source references/spans, normalization rule version, input/title hash, producer, model-call IDs, and outcome. New source labels must truthfully distinguish a typed selection from deterministic/manual output; no new result may label deterministic output as LLM-authored. Historical source labels remain readable as history, not live fallback routes.

Existing mandatory brand/variant and deterministic title-lint/consistency protections remain. Any source-backed deterministic fallback must independently satisfy these protections and the listing-evidence gate, retain its actual provenance, and be visible to Review. A failed model request is not a successful typed selection. Where no valid deterministic candidate exists, keep the title unresolved and offer current manual evidence/title correction; do not ship `Unknown Product` or an unsupported signal just to satisfy nonempty validation.

Use source-span offsets/hashes for provenance, not newly generated quotes. Existing validated manual evidence is retained as a first-class candidate/authority; its exact current revision is still checked. Changing a name or one of its supporting facts invalidates dependent evidence judgments, family labels/plan when affected, review/approval, and derived draft filename proposals. Do not silently rename existing approved filenames.

At cutover, drain or supersede incompatible in-flight frozen chat naming plans and run fresh typed plans. Remove active text-generation selection/parsing/fallback chains for the migrated operations. Do not reroute an old frozen plan or rewrite historical outputs to pretend they were typed judgments. Other nonmigrated generative capabilities are not removed or expanded by this spec.

### 6.3 Acceptance

- **N1:** Official base identity plus this SKU's verified package facts yields a valid complete candidate without invented wording or sibling facts.
- **N2:** Abbreviated/attached register quantities normalize safely; all required size/capacity/count distinctions remain; shipping weight does not replace net contents.
- **N3:** Conflicting 5 lb/15 lb evidence cannot create a title containing both as a guessed solution. Missing required brand/variant evidence remains actionable rather than bypassing existing holds.
- **N4:** Flavor, species, life stage, form, negation, model suffixes, strength, and material distinctions survive even when cohort siblings differ.
- **N5:** Exact/equivalent candidates use zero model calls. Typed selection cannot output a title not constructible from the supplied evidence-backed candidate.
- **N6:** Singleton and cohort paths produce truthful provenance and equivalent per-SKU protections; crash/replay does not split or overwrite a committed cohort title set.
- **N7:** Manual edits/evidence revisions stale old name decisions and approvals; unchanged evidence/rules can reuse a judgment without inheriting human approval.
- **N8:** Service failure, no-fit, missing evidence, invalid candidate ID, and overflow have distinct visible outcomes. No chat retry chain or invented fallback title is introduced.

## 7. Listing-evidence support and contradiction checks

### 7.1 Claim scope and interface

Add `checkListingEvidence` after current name/description preparation and before publishing the draft projection to Review. It receives the exact current proposed listing fields, SKU-local eligible evidence, source/variant authority, field-requiredness policy, and existing source conflicts. It returns a pure verdict structure plus audited semantic judgments where needed. The same currentness validator is reused by Review completion, durable approval, draft creation, change-set approval, and export/push.

A claim is text or a structured fact actually asserted in the proposed listing: a selected name component, a product description sentence/bullet, or a material variant/measurement fact. Build these units in code from existing field boundaries and plain-text HTML/sentence blocks, retaining source offsets and qualifiers; do not introduce another generative claim extractor. A block can pass only when all its material assertions are supported. A multipart statement is not supported just because one clause matches.

Check the final projected title/description, including extraction/name fallbacks and manual edits, not only non-null curated fields. Exclude non-claim navigation/formatting and absent optional fields. Do not inspect unprojected provider text, the whole catalog, or all possible future product attributes.

### 7.2 Deterministic checks, semantic checks, and provenance

Code first verifies citation/span existence, evidence eligibility/currentness, item/source linkage, resolved hard conflicts, exact identifiers, quantities/units, and variant consistency. A model cannot overrule a deterministic contradiction or rehabilitate the wrong SKU/source. Exact supported structured copies require zero semantic questions.

For remaining current claim units, ask one narrow Choice per claim over the relevant evidence bundle:

- `supported`: every material assertion is directly supported by the eligible evidence for this SKU, with no unresolved contradiction.
- `contradicted`: eligible evidence directly conflicts with a material assertion.
- `insufficient_evidence`: the evidence neither supports the complete assertion nor establishes a direct contradiction.

Questions in one request are independent and cannot see one another's verdicts. The instructions include the claim and full meaning; IDs alone are not instructions. Preserve the exact evidence bundle IDs/hashes considered and raw judgment. Label that bundle as evidence considered, not a fabricated per-source proof or model-generated quotation. Specific supporting spans can be shown only when present/validated in the source; no invented evidence IDs or citations.

Persist `CurationData.listingEvidenceValidation` with rule/model-policy version, final listing hash, evidence hash, per-claim field/span/hash/requiredness, deterministic/model producer, evidence considered, verdict/reason, actual call IDs, unresolved findings, and aggregate status (`passed`, `needs_review`, `blocked`, `unavailable`, `stale`). A `passed` record requires complete coverage of all in-scope included claims, not just the first 24. Overflow/oversized evidence is visible and unresolved; it cannot produce a partial green check.

### 7.3 Gate and resolution policy

- An included contradicted or unsupported material claim cannot ship as-is, even if its field is optional. The operator must remove it, correct it to evidenced text, or provide eligible attested evidence. Optionality is not permission to publish an unsupported assertion.
- An absent optional fact does not become a new blocker or preparation gap. Preserve current configured requiredness; do not add a universal ingredient/nutrition/marketing checklist.
- Missing required listing facts continue through existing preparation-gap/readiness semantics. Reuse title/description preparation gaps where applicable; findings on other fields remain listing-evidence findings, not unsupported new gap types.
- Service failure, model uncertainty, and overflow are not `supported`. Keep the draft/evidence visible, offer retry through the existing bounded worker flow or explicit manual verification, and leave unresolved checks release-blocking for affected included claims.
- Human resolution uses existing authenticated review/manual-evidence patterns: exact claim/field/SKU hash, evidence/input hash, actor, timestamp, expected revision, reason, and existing operation receipt. A manual verification is stored as `operator_verified`, not rebranded as a positive model verdict. It requires a real current observation/attestation; clicking approve alone cannot fabricate evidence.
- Explicit manual verification cannot bypass wrong-identity/variant/domain constraints, unresolved hard source conflicts, image rights, classification approval, drift, or catalog ownership. Corrections must resolve the responsible upstream conflict or provide the permitted evidence, then revalidate.

Display contradictions and missing support with the proposed text and actual evidence, not only a confidence score. Removing an unsupported optional sentence can unblock a listing without a new source/model call if no remaining claim depends on it and deterministic coverage/currentness is re-established.

Distributor-record Extraction stays a deterministic, hash-bound, URL-null materialization with zero model/fetch/profile/OCR/image calls. These checks run in Curation against read-only materialized evidence; never repair/rewrite distributor extraction payloads. Tamper/hash mismatch remains the existing promotion refusal, not a model-resolvable disagreement.

### 7.4 Acceptance

- **E1:** A copied current fact with a valid same-SKU source/span passes deterministically; an absent optional description/keyword/weight field does not open a new universal gap.
- **E2:** A title/description claiming 15 lb against verified 5 lb evidence is contradicted regardless of high model probability or provider majority.
- **E3:** An included unsupported marketing assertion is not allowed merely because description is optional. Removing/correcting it rechecks the actual final projected listing.
- **E4:** A source that says `not suitable for puppies` cannot support `suitable for puppies`; similar topic or one supported clause cannot certify the whole statement.
- **E5:** Sibling/catalog-family evidence, another variant's facts, stale provider attempts, unverified URLs, fabricated quotes, and unlinked evidence IDs cannot support a claim.
- **E6:** Required title/description gaps reuse existing correctable-gap behavior. Unsupported included text and missing optional text have distinct handling.
- **E7:** Manual verification is authenticated, evidence/revision-bound, auditable, and idempotent; an old decision cannot clear a changed claim or a hard identity/rights/classification conflict.
- **E8:** Model failure, uncalibrated policy, excessive claims/state, and an incomplete response never become an all-clear. All safe listing/proposal data remains visible for correction.
- **E9:** Consequential text, source, quantity, manual-evidence, family-axis, or classification/rule changes stale precisely the affected judgments and review/approval. Unrelated unchanged claims do not require fresh inference just because a display preference changed.
- **E10:** Both official-page and distributor-record products reach the same Curation check while distributor Extraction's zero-model/provenance invariants remain unchanged.

## 8. Operator interaction and mutation contract

Use the existing Batch Workspace/Review and Needs Attention flows in Operate mode; do not redesign the shell or add an agent console.

- Official Site Resolution shows safe retrieved candidates, the proposed candidate, separate verification state, and the exact no-match/uncertainty/service reason. Confirmation remains an explicit existing action where deterministic automation has not already qualified it.
- Family review is a comparison table inside the listing workflow: main designation, SKU, source (import/catalog), invariant/variant evidence, Short Name before/after, and changed/unchanged relationship members. Existing catalog changes are conspicuous. Never preselect approval or hide an old member because it is not in the import.
- Full Name and Child - Short Name are distinct controls. The latter is enabled only for the explicit listing-owned family operation; it does not appear as a classifier facet.
- Listing findings anchor to the exact affected field/text and source evidence. Show `contradicted`, `not established`, `unavailable`, and `stale` distinctly, with actions appropriate to each. No progress badge implies approval or confirmed identity.
- Loading retains current data and disables only conflicting saves. Empty candidate/family states allow manual/standalone work. Stale saves preserve operator input, return the current revision/diff, and require explicit resubmission. Overflow shows counts and the affected scope; failures are not indefinite spinners.
- Use current tokens/layout and accessible labels/table semantics, keyboard actions, focus return after correction, descriptive field errors, and `aria-describedby` links from readiness blockers. Status is never color-only. Narrow screens retain identity/main/decision columns with an accessible details view rather than hiding affected products.

Add family-plan detail/decision operations under the existing authenticated onboarding router. The mutation contract includes plan ID, expected revision/input hash, action (`accept`, `revise`, `reject`, `defer`), exact submitted edits, and an action token. Workspace, actor, base products, eligibility, and evidence are server-derived; a client cannot approve another workspace's plan or submit arbitrary Product JSON as a family edit. Return current per-field/group blockers and changed SKU diffs, not a bare boolean. Stale revision/authority returns conflict with no mutation; malformed input is validation failure; existing action-token retries replay the same receipt, while payload/token mismatch refuses.

Accept/revise persists the complete decision and draft write set in one repository transaction, with currentness rechecked inside it. Review completion must validate all requested affected items before mutation, preserving its all-or-nothing semantics. Existing unrelated bulk-release partial-success behavior is not silently redefined; family publication uses the stricter consistency-group gate.

For naming/evidence re-evaluation, reuse existing Curation rerun/correction and review-currentness flows rather than inventing independent worker queues. Family-plan decision records are listing-owned and cannot reuse the classifier's protected-target mutation interface.

## 9. Dependencies, invalidation, and storage ownership

| Change | Invalidate/recheck |
|---|---|
| Register identity, allowed domains, candidate content/final URL/variant | Official selection/confirmation; affected Extraction and dependent listing work under existing rules |
| Accepted source evidence, materialization generation, OCR bytes/results, manual attestation | Dependent name/components, family invariants/axes, claim verdicts, review/approval; never mutate old evidence to make a hash match |
| Reviewed Category/Product Type or Family Variant Rule | Family eligibility/plan and affected name/claims; preserve existing classifier dependency invalidation and review authority |
| Main/member set, variant tuple, PF7 value, relevant native relationship | Whole family plan/read-write manifest, Short Name uniqueness, changed listings, publication validation; not unrelated Curation Cohort membership |
| Proposed full name/description/fallback source | Exact listing hash, affected claims, draft projection/review; no automatic approved URL rename |
| Existing catalog base/member name/native IDs, pending draft, drift, or remote existence | Family plan and pending export dependency closure; refuse stale group publication |
| Model/prompt/meaning/policy or requiredness change | Relevant judgments and readiness; no reuse under old meaning. A presentation-only change can reuse raw judgments if their evidence/meaning is unchanged. |

Proposed new contracts live in shared Zod schemas; repository implementations are the only direct SQL owners. Add the minimum family-plan/member/decision storage needed for durable cross-batch review and extend existing item Curation data for name/evidence decisions. Keep completed runs/decisions immutable; use new revisions and existing review invalidation rather than deleting history. Do not run model requests inside a database transaction.

Canonical approved product/configuration state stays in Git. SQLite family indexes, operational plans, model-call rows, and receipts are local state/audit, not competing catalog truth. Database migrations initialize the new state honestly; they must not mark legacy items/families as checked, reviewed, or adopted. Historical items remain readable and acquire new judgments through explicit new runs/edits, not a fabricated backfill pass.

## 10. Implementation seams and delivery sequence

The following names are proposed interfaces, not claims of existing exports. Implement deep behavior behind these narrow interfaces and reuse existing modules; no generic framework is required.

| Interface | Implementation seam | Required integration |
|---|---|---|
| `selectOfficialPageCandidate` | Existing sitemap matcher plus System One transport | Discovery operation policy/audit, source-discovery and worker result handling, official confirmation UI; remove active free-text selection parsing |
| `proposeStorefrontFamily` / `reviewStorefrontFamilyPlan` | New listing-owned family module and repository | Shared plan/rule schemas, catalog snapshot/index, Review actions, native product schema/codec, change-set consistency groups and export/push guards |
| `selectProductName` | Existing title consolidator/name stage and active cohort coordinator | Source candidate/provenance contract, frozen operations, source enums, durable title outputs, projection and readiness consumers; remove migrated chat generation paths |
| `checkListingEvidence` plus pure currentness/gate evaluator | New Curation listing-evidence module using existing evidence/readiness patterns | CurationData, final projected listing fields, Review completeness, durable approval, promoter, change-set/export validation and corrections |

Deliver complete slices in this dependency order; each slice includes schemas, persistence, all active callers, Review behavior, acceptance scenarios, docs, and its real smoke evidence:

1. Official-page typed selector and its independent qualification/cutover.
2. Evidence-backed naming and listing-evidence checks together, so selected/fallback names are never shipped without their declared evidence/currentness behavior; preserve both singleton and cohort paths.
3. Family rules/plans, cross-catalog review, first-class native authoring, deterministic Short Names, strict family publication, and compatible ShopSite canary as one end-to-end family delivery.

All four capabilities remain in the committed scope; ordering is not permission to deliver a family classifier without Subproducts/PF7/review/export, or a naming selector without the required consumers. Do not retire the existing classification comparator or change classification qualification merely because these slices exist.

Activation uses offline replay → fully reviewed supported canary → canonical activation. Remove obsolete active migrated paths after acceptance; rollback is disable-to-unresolved/manual or a reviewed code revert, not a maintained alternate chat orchestration. Complete history stays readable. In-flight incompatible snapshots must be drained/superseded, never silently rebound to new operations.

## 11. Evaluation and release evidence

Use representative, family-separated development/holdout data; the same product family or near-duplicate source must not leak across partitions. Cover food, non-food, unknown/missing invariants, abbreviated register names, no-fit, insufficient evidence, same-flavor/different-form cases, pack versus unit, and existing-catalog joins. Freeze source evidence, candidate coverage, applicable rules, final gold, and policy versions before scoring.

Measure the actual composed workflow, not just model answers:

| Capability | Quality measures | Efficiency measures |
|---|---|---|
| Official selection | Correct-URL retrieval coverage; correct candidate selection; wrong SKU/variant/authority recommendations; end-to-end confirmed page precision; correct abstentions | Actual request/token cost including retries; verification/network work; time and operator actions to confirmed source |
| Families | Group precision/recall; harmful merges versus harmless splits; invariant/tuple violations; existing-main/member/label preservation; complete native publication | Pair/candidate counts; paid calls avoided by blocking; family review/correction time; blocked/standalone products and publication recovery |
| Naming | Exact preservation of material facts/variants; unsupported additions/lost qualifiers; corrected titles; provenance/currentness; singleton/cohort parity | Calls skipped, cost per accepted title, operator edit time, end-to-end Curation latency |
| Evidence | Missed contradictions/unsupported included claims; false blocks; optional-omission behavior; reviewer resolution/currentness; source/variant eligibility | Calls/claim units; retry/overflow cost; operator resolution time; time to correctly reviewed listing |

Report P50/P95 end-to-end timings and actual billed/observed usage where available; unknown cost is unknown, not zero. Compare on the same frozen population, reporting unanswered/failed rows and retrieval misses rather than evaluating only the answered overlap. Name the denominator and support for every percentage. Family grouping is new inference and must not be advertised as an existing-model cost saving.

Existing Assistant/TypeSafe operational and qualification requirements remain binding. Each new capability needs its own development-fitted policy, independent held-out evidence, invariant regressions, and fully reviewed canary. No automatic authority is earned by a probability alone. Underpowered, unlabeled, stale, mock-only, or unreviewed evidence yields a blocked qualification result; do not invent sample-size/accuracy claims or weaken existing gates to declare release.

The permanent regression suite must cover the D/F/N/E consumer-visible acceptance cases, including fault/replay/concurrency and cross-workspace rejection. Do not add source-text/wiring/mock-echo tests. Use the existing appropriate Bun/Vitest runner conventions; no live credentials/network in the deterministic suite.

Implementation smoke evidence must exercise the actual changed seams:

- Run Discovery through retrieval, typed decision, verifier, and operator/confirmed outcome on supported source examples.
- Run singleton and cohort naming plus listing checks, correct a contradiction, and observe review/approval invalidation and recovery.
- In a disposable catalog workspace, prepare/review a family containing existing and new members, approve one complete commit, inspect the actual exported XML/PF7 values, and inject pre-/post-commit failures.
- With separately authorized store-compatible canary access, complete import/finalization/publish and inspect the actual storefront: all expected sizes including the main are purchasable, labels distinguish variants, unrelated data is preserved, and partial failures are not marked synced.
- Verify the actual Review/Needs Attention surfaces and accessible correction actions. Tests alone do not substitute for these runs.

## 12. Evidence from this specification session

Read-only repository investigation and current live TypeSafe/ShopSite documentation informed this specification. A synthetic no-network run of the existing family grouper showed flavor/life-stage stripping; a synthetic run of `matchOfficialPageIdentity` accepted an exact package and a uniquely selectable variant, rejected a conflicting package, and required operator help for missing package details.

Verification completed after writing:

- All 26 distinct local file links resolve.
- Acceptance coverage is explicitly enumerated as eight Discovery, fourteen family, eight naming, and ten listing-evidence scenarios. This is a specification inventory, not forty passed tests.
- An additional no-network smoke of the existing codec round-tripped three top-level size SKUs with PF7 values `5 lb`, `15 lb`, and `30 lb`, preserved the main-to-self/three-member Subproducts block exactly, and kept all three products disabled/draft. Encoding produced zero warnings. No fixture files, paid model requests, or live store writes were needed.

Those are baseline behavior checks, not validation of the proposed capabilities, editable native relationship authoring, remote atomicity, storefront rendering, or TypeSafe accuracy/cost. No new model call, live store write, runtime implementation, or qualification pass is claimed by this specification.
