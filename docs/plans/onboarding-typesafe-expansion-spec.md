# Evidence-first, item-local onboarding specification

**Status:** Owner-confirmed target architecture; specification for implementation. The design interview is complete. Runtime cutover, live qualification, paid acquisition, and production activation are not claimed or authorized by this document.

**Decision:** [ADR 0042 — evidence-first item-local onboarding](../adr/0042-evidence-first-item-local-onboarding.md). **Delivery:** [Implementation plan](evidence-first-onboarding-implementation-plan.md). **GitHub specification and work graph:** [#362 — evidence-first, item-local onboarding](https://github.com/Bay-State-Pet-and-Garden-Supply/bay-state-cms/issues/362). The issue publishes this specification and links the complete plan and ADR; the prior issue body is archived as superseded history, with the retained family/naming/listing scope preserved.

The starting inputs are **only UPC, abbreviated Register Name, and Price**. The target is rich, evidence-supported listings with less operator work, not replacement of every model call with TypeSafe. Definitions live in [CONTEXT.md](../../CONTEXT.md); implementation and activation rules live here and in the linked plan.

## 1. Outcome, confirmed decisions, and limits

Optimize operator effort per correctly reviewed rich listing, subject to exact-item/variant correctness, claim support, image rights, and bounded acquisition cost. Greater completeness is not permission to invent facts; fewer model milliseconds is not proof of better end-to-end throughput.

The owner confirmed:

- Rich listings before review-readiness, against finite product-type-specific **Listing Completeness Standards**, rather than every manufacturer-published fact.
- Structured UPC sources and static/profile extraction first; broader search and browser collection only as bounded fallbacks for specific missing evidence.
- Extra bounded acquisition/model spend when it reduces operator work. Production dollar limits and measured savings are not invented by this spec.
- Per-item acceptance of browser-collected facts after the required authority, sellable-item/variant, provenance, conflict, and rights checks; no reusable healthy-profile prerequisite for that fallback.
- Retailer corroboration of attributable basic specifications after exact-item matching, not official-page authority or reusable retailer prose/images by default.
- Explicit operator-approved omissions for designated non-critical requirements. No automatic waiver of identity/variant resolution, rights, required safety information, or classification-required configuration/values.
- Independent SKU progress/readiness. Shared fetching, model batches, and Curation Cohorts are optimizations, not completion authorities for unrelated items.
- A separate generative model may write customer-facing descriptions from accepted facts only. Code owns execution; TypeSafe supplies bounded semantic judgments; neither model creates factual authority.

Deliver through the existing Sourcing → Discovery → Extraction → Curation → Review → Promotion pipeline. Preserve the existing worker, repository pattern, shared Zod schemas, frozen model policy, review, Git change sets, codec, and ShopSite adapter. The logical acquisition loop is not a stage-name/schema migration and must not move an item backwards through those stages.

Non-goals:

- No generic agent platform, new monitoring platform, Agent Lab restoration, unrestricted browser, CAPTCHA/paywall bypass, credential-bearing browser profile, or model-generated executable adapter.
- No invented product facts, model-inferred image rights, automatic classification approval, automatic catalog release, enabling new products, synthetic UPCs, duplicate SKU identities, or display-only family parents.
- No classifier ownership of Brand/PF16, PF7 Short Name, native Subproducts, cross-sell/PF32, identity, price, stock, or listing copy. [ADR 0041](../adr/0041-single-product-classification-contract.md) remains binding: one canonical Category + Product Type per SKU, reviewed-only assignments/removals, configured Attribute Profiles and verified taxonomy pages.
- No inheritance of product facts/classification from a sibling, source-page option group, approved catalog example, or Curation Cohort.
- No whole-catalog rewrite, historical family adoption, retrospective conversion of model judgments, maintained legacy orchestration, or silent weakening of existing qualification/comparator-retirement gates.

## 2. Current evidence and capability gaps

These are primary-code starting points, not claims that the new target is implemented or qualified.

| Area | Current evidence and required change |
|---|---|
| Intake | [imported-identity.ts](../../src/onboarding/imported-identity.ts) preserves raw register values and normalization provenance. Extra spreadsheet columns are optional, never design prerequisites. Known-brand prefix matching is not general brand discovery. |
| Acquisition | [sourcing/engine.ts](../../src/onboarding/sourcing/engine.ts) uses UPC-first connector/strategy evidence; [source-discovery.ts](../../src/onboarding/source-discovery.ts) uses configured official-domain indexes/sitemaps, not an external search provider. New bounded broader acquisition is required. |
| Admission | [onboarding.ts](../../src/shared/schemas/onboarding.ts) has official-page/distributor extraction routes; [manual-evidence-service.ts](../../src/onboarding/manual-evidence-service.ts) stores operator-attributed values and attestations. Browser fallback and retailer corroboration need truthful new evidence bindings, not relabeling as manual or official. |
| Browser | [local-harness.ts](../../src/onboarding/browser-investigation/local-harness.ts) defers investigation rendering by default. [render-proxy.ts](../../src/onboarding/browser-investigation/render-proxy.ts) contains validating CONNECT interception, so older comments about universal CONNECT refusal are not proof of the current implementation. Real isolated HTTPS navigation is still an explicit qualification requirement. The separate [rendered-page-runner.ts](../../src/extraction-worker/browser/rendered-page-runner.ts) exists, but its presence is not proof of the fallback's complete security contract. |
| Richness | [preparation-gap-repo.ts](../../src/db/repositories/preparation-gap-repo.ts) derives title and optionally description requiredness. Separate review checks cover basics, but this is not a product-type-specific rich-listing standard or a general omission mechanism. |
| Existing decisions | [name-candidates.ts](../../src/classification/name-candidates.ts), [name-decision.ts](../../src/classification/name-decision.ts), and [listing-evidence-service.ts](../../src/classification/listing-evidence-service.ts) provide candidate/judgment/check seams. Their existence does not establish end-to-end listing quality. |
| Completion | [promotion-gate.ts](../../src/classification/promotion-gate.ts) and [review-completion-gate.ts](../../src/classification/review-completion-gate.ts) consume parent-cohort authority; [job-queue.ts](../../src/onboarding/job-queue.ts) owns claims/dispatch. Move independent listing authority to the item, not merely remove parent checks. |
| Copy | [distributor-copy-consolidator.ts](../../src/onboarding/distributor-copy-consolidator.ts) and [product-curator.ts](../../src/onboarding/product-curator.ts) contain generative copy paths. Replace raw/conflicting-description inputs with accepted facts and check the actual final output. A prompt saying “never invent” is not an evidence gate. |
| Family/publication | [storefront-family-plan-service.ts](../../src/classification/storefront-family-plan-service.ts), [product-codec.ts](../../src/shopsite/product-codec.ts), and [change-set-service.ts](../../src/server/services/change-set-service.ts) are retained seams. Family deferral already preserves standalone progress; actual linked changes still require strict publication consistency. |

The [Jev implementation report](../audits/jev-implementation-verification-2026-10-03.md) and [naming/listing qualification report](../audits/naming-listing-qualification/qualification-report.md) do not establish real-batch rich-listing completeness, operator-time savings, or total acquisition cost. Preserve unknowns rather than converting mechanism checks into quality claims.

## 3. Shared evidence, policy, and execution contracts

### 3.1 Input and source authority

Preserve original UPC, register text, price, row identity, and parser/normalization provenance. Normalize identifiers and units conservatively without losing leading zeros or inventing corrected identifiers. UPC is a lookup key, not automatic proof of a retail unit; Register Name is an identity clue, not a full specification. Price remains imported commercial authority and must not select a product/pack or be replaced by distributor/retailer pricing.

Keep **source role** separate from **collection method**:

- Roles: approved manufacturer evidence, qualified distributor evidence, retailer corroboration, operator-attested observations. A website is not official merely because a search result/model says so.
- Methods: structured connector data, static extraction, rendered/browser collection, operator submission, or existing image/OCR observations. A browser or OCR method creates no source authority or independent corroboration by itself.
- Domain/strategy authority comes from existing approved configuration; new official-domain candidates require that authority before official admission. Search may find candidates without a preexisting brand hint, but cannot approve a domain.
- Retailers never become Confirmed Official Pages. Their permitted basic facts need exact-item binding and role-specific eligibility. Safety/ingredient/nutrition/dose/medical claims require suitable authoritative evidence, not retailer consensus. Do not require two sources universally: one authoritative exact-item source may suffice, while syndicated copies are not independent proof.

### 3.2 AcceptedItemEvidence

`AcceptedItemEvidence` is a **proposed** shared Zod snapshot contract, not an assertion of an existing export. The same accepted-fact representation must serve structured, profile/static, browser, and attested contributions; source-specific adapters retain their own admission rules.

Each immutable snapshot binds:

| Part | Required meaning |
|---|---|
| Ownership | Workspace, onboarding item, Product SKU, input revision/hash, producing operation/run and generation where applicable. |
| Observations | Original/final URL or connector record identity, source role/authority revision, collection method, observation time, immutable artifact/response hash, currentness/expiry, selected variant and identity decision references. |
| Facts | Field/claim identity, actual value and unit, exact source span/path/component and value hash, permitted deterministic normalization, observation references, admitted/unknown/conflicted disposition and reason. |
| Acceptance | Server-derived acceptance revision, rule/version hashes, exact sellable-item/variant binding, eligible source set, conflict disposition, and applicable image-rights approvals bound to the actual asset. |
| Dependents | Evidence hash, relevant canonical classification/checklist versions, producing model-call IDs when a judgment was used, and manual attestations with actor/time/revision. |

No client or model can invent source IDs, offsets, quotes, acceptance flags, actor identity, authority, or rights. Preserve raw observations separately from admitted facts. New evidence creates a new snapshot; never mutate old observations to make a hash agree. Completed decisions remain immutable; operational pointers may advance to a newly validated revision.

Item Evidence Acceptance is permission to prepare/review a listing, not catalog approval, release, Profile Health, or proof of model accuracy. Hard identity/variant conflicts prevent combining the affected sources. Quarantine disputed fields; preserve valid independent facts where their own item binding is established. Unknown evidence is not negative evidence or agreement.

Distributor materialization remains URL-null, generation/hash-bound, profile-free and zero-fetch/model/OCR/image at that materialization seam. Complementary acquisition creates separately bound contributions; it must not rewrite the distributor payload, invent `source_url`, or overwrite an official `source_url` with a retailer URL. Existing manual attestations retain their actual user provenance; browser-prefilled values require the new binding, not `operator_transcription` camouflage.

### 3.3 Model roles, outcomes, and bounds

Use the existing [System One transport](../../src/ai/systemone-transport.ts) for Choice/Noul judgments only. Current application limits are 32 questions, 255 Choice options, 32,768 state bytes, and 65,536 serialized request bytes. Keep the evaluated configured model pin (currently `jev-1.13.0`) and frozen model-policy routing; no silent latest alias, chat fallback, or provider substitution. Different generative-copy and judgment operations have separate approved workload/data-sharing authority.

Persist exact inputs/candidates, rules, requested/returned model, raw typed answers/distributions, actual call IDs, and terminal reason. Separate semantic outcomes (`selected`, `no_match`, `insufficient_evidence`) from `candidate_limit_exceeded`, `policy_denied`, `budget_exhausted`, `budget_not_enforceable`, `unsupported`, `unavailable`, `failed`, and `stale`. A failure is not semantic abstention credit or a successful deterministic/model decision.

Code supplies complete candidate meanings and explicit abstention options. Batch only independent questions over the same state. Page/provider text is untrusted data, never instructions; use bounded relevant snippets and exclude credentials, secrets in URLs, unrelated products, and unnecessary commercial data. Question IDs are not model-visible instructions.

Retain existing engineering bounds where applicable: up to ten candidates per official-domain selector, sixteen family anchors, sixteen complete name candidates, and 24 current claim units per listing-evidence request. These are not measured optimal settings. Overflow is explicit and cannot certify an inspected prefix. Deterministically settled work makes zero model calls. Preserve the transport's existing single transient retry within the caller budget; count both attempts and add no repair/retry stack.

Reuse requires exact equality of relevant item evidence, source/variant authority, candidate content/order, rules, prompt, model, policy, and base/dependency hashes. Recheck live provider enablement, ownership, cancellation and currentness before dispatch, retry, and commit. Reuse never transfers human approval. Unreadable/missing currentness is `unavailable`, not a title-only fallback or two matching empty hashes.

### 3.4 Item-owned execution

One item-owned immutable execution revision controls each independent listing's frozen inputs, proposals, projection and completion. Shared calls may return independently attributable member outputs; store actual producing call IDs and item bindings. Item publication cannot depend on another member finishing or a cohort parent reaching terminal status.

Replace the live cohort-owned completion/title/page publication contract coherently across worker, repositories, projection, Review, Promotion and UI. Do not just delete `parent_not_completed` while leaving parent-owned mutable dependencies. Preserve lease/CAS ownership, deduplicated work, guarded commits, frozen policy, review authority, and replay/currentness checks under item ownership. Cohort parent codes remain historical diagnostics, not new Product Family gates.

Drain or supersede incompatible in-flight plans and create fresh item-owned runs at cutover. Retain old outputs as immutable history; reuse a compatible historical result only under the same exact input/meaning rules. No rewriting old rows into new approvals, silently rebinding frozen calls, persistent dual orchestration, or compatibility aliases. Optional shared work may fail without invalidating unrelated accepted item outputs.

## 4. Acquisition and item-level admission

### 4.1 Narrow interface and acquisition ladder

`acquireItemEvidenceGap` is a **proposed** interface at the existing acquisition/worker seam. Input: item/input revision, immutable known facts and unresolved requirements, source/strategy authority, tried candidates/sources, frozen model/data-sharing policy, and enforceable remaining item/batch budgets. Output: retained observations, admitted fact contributions or exact unresolved reasons, actual usage, and producing references. It cannot approve a listing/profile or write canonical catalog files.

1. Query legitimate structured UPC sources under the current approved strategy; do not let the first successful provider suppress complementary approved sources.
2. Use approved official indexes/sitemaps and static/profile extraction. A known brand/healthy profile is an optimization, not an intake prerequisite for the new fallback.
3. When a specific requirement remains unfilled, allow bounded broader search for candidates and static reads before rendering. A result snippet is not accepted product evidence. Record retrieval coverage/truncation separately from selection precision.
4. Use a browser only when necessary for rendered content, variant options, relevant sections or links. Prefer structured data/DOM/text, not screenshot-coordinate reasoning. TypeSafe image/Box support is not the production basis for this design.
5. Admit facts through the item contract; recompute the applicable checklist and stop when requirements are satisfied or the budget/policy/support boundary is reached. A provisional canonical classification may choose what to seek; correcting the pair recomputes requirements and dependent work. Never choose a less-demanding type to declare success.

Supplemental work uses the existing worker while an item stays in its current stage; Preparation can request scoped acquisition without restarting Sourcing or moving backwards. Reuse current facts and ask the operator for a specific unresolved identity, authority, rights or evidence decision—not routine approval of every navigation.

### 4.2 Browser action and network contract

Code enumerates current permitted action IDs from retained observations: open a supplied link, inspect a supplied variant option, expand a supported information section, read supported structures, or stop. TypeSafe may choose among those actions or abstain. Code resolves the actual URL/element/arguments and revalidates page/target freshness, allowed scope and remaining budget before execution. No model-generated URL, selector, JavaScript, tool program or arbitrary command is executed.

Public read-only collection must have enforced method/path/host/DNS/IP/redirect/TLS/content-type and streaming byte limits outside the untrusted browser, plus process isolation and bounded scratch/CPU/memory/process use. Browser interception is defense-in-depth, not the sole egress boundary. Deny login/account/cart/purchase/form submission, uploads/downloads, private destinations and credential/profile mounts. Keep unsupported interaction/POST-only sites explicit rather than silently weakening the policy.

Reuse compatible broker/isolation primitives, not their production-readiness claims. Investigation's default `render_deferred` and diagnostic opt-in do not authorize this route. Demonstrate real HTTPS navigation through the validating boundary and direct-egress denial, including with browser interceptors disabled. The separate rendered worker needs the same complete policy before use here. Browser Investigation remains profile proposal tooling and cannot supply accepted item facts or activate profiles.

### 4.3 Budget and stopping contract

Production requires explicit per-item and batch bounds for search/fetch attempts, pages/actions, redirects/fan-out, transferred/decompressed/artifact bytes, elapsed time, concurrency, model calls/tokens and applicable monetary spend. Exact limits are reviewed activation configuration, not invented defaults or copied investigation maxima.

Reserve the permitted work before dispatch under concurrent item/batch ownership; include retries and in-flight commitments. A requested monetary ceiling requires a documented enforceable upper bound before dispatch, including provider pricing and request/output bounds. If it cannot be bounded, refuse with `budget_not_enforceable`; post-hoc accounting is not a cap. Cancellation/timeout stop owned work and preserve honest in-flight/unknown charge state. Record billed cost, rate-derived estimate, or unavailable distinctly; unknown is never zero.

Stop on completed requirements, unsupported policy/action, unresolved identity/variant or authority, source conflict requiring human resolution, cancellation, or exhausted budget. No automatic budget escalation, recursive repair, repeat investigation loop or silent partial green. Retain acquired facts/proposals and show the remaining requirement and reason. Missing non-critical content may enter the explicit exception workflow; safety/identity/rights/classification cannot be bypassed.

### 4.4 Discovery and admission acceptance

- **D1:** Deterministic exact approved-source cases remain correctly resolved without unnecessary model/browser work.
- **D2:** Wrong SKU, flavor, size, pack, collection page, retailer-as-official and off-domain redirects cannot become confirmed/accepted from confidence.
- **D3:** A manufacturer page lacking a UPC is not rejected solely for that absence; conservative observed name/variant matching and explicit operator resolution remain available.
- **D4:** Missing correct URLs, failed fetches and truncated candidate coverage are retrieval limitations, not selector successes on unseen candidates. No first-N uniqueness claim.
- **D5:** No-match, insufficient evidence, denied/unavailable service, unsupported site, budget exhaustion and malformed/overflow results remain distinguishable and actionable.
- **D6:** Forged/out-of-set action/candidate IDs, stale page references, injected instructions and arbitrary execution are rejected before effects.
- **D7:** Changed item/source/authority/variant/run state cannot overwrite newer evidence or a source confirmation. Corrections resume from the current revision.
- **D8:** Structured distributor materialization retains its zero-fetch/profile/model/OCR and null-URL invariants; supplemental browser facts do not mutate that envelope.
- **D9:** A per-item manufacturer fact may pass without a healthy profile after all item gates; the same observation cannot activate Profile Health. Investigation-only observations cannot pass item admission.
- **D10:** Retailer basic corroboration remains separately attributed; retailer safety claims, prose reuse and image reuse are refused absent the required authority/rights.
- **D11:** Missing bounds or an unenforceable requested billing ceiling refuse before dispatch. Concurrent work/retries cannot exceed reserved limits; cancellation does not fabricate zero cost.
- **D12:** A rich, independently ready SKU proceeds while another imported/cohort item is unresolved, without borrowing its facts or weakening a genuine family operation.

## 5. Optional Product Families, Subproducts, and Short Names

The original complete family scope remains committed; it is not a prerequisite for a standalone listing. Use existing listing-owned family/rule/codec/change-set seams, never classifier field assignments or Curation Cohort membership as family authority.

### 5.1 Identity, candidates, and rules

A family is one underlying product under an explicit versioned Family Variant Rule. Search both the current import and approved catalog, resolving existing records by `(workspaceId, sku)` and immutable approved hashes/commits. Do not create duplicates from newly decoded UUIDs. Brand/type/rule blocking and a high-recall name/model shortlist limit comparisons; name stems may suggest candidates but cannot determine membership or be the only recall mechanism.

Rules use configured canonical Product Classifications, not model-invented labels. Define invariants, permitted and non-applicable axes, required evidence, deterministic dimension-aware normalization, Short Name axis order and display order. Missing invariants are unknown. Food preserves brand, line/recipe, flavor, species, life stage and form while approved size/pack relationships may vary. Non-food permits only configured size/color/count axes for the same model/product; material/function/safety/dose/strength/fit remain invariants unless explicitly legitimate variation. Net contents, shipping weight, unit count and case pack are not interchangeable.

At most sixteen eligible anchors receive independent relationship Choices: `same_sku`, `same_family`, `different_product`, `insufficient_evidence`. Same-SKU ambiguity goes to identity resolution. Code checks every member's hard invariants and complete variant tuples; two positive edges cannot bridge conflicting endpoints or merge competing existing families. Final acceptance uses current reviewed classification/rule authority. Existing native Subproducts may be accessories or legacy merchandising, not managed families; unsupported adoption is refused with preservation.

### 5.2 Main Product, names, and durable representation

Preserve an existing main, identifiers, filename/URL, membership and unrelated listing values. A new family has at least two real purchasable member SKUs; nominate the smallest verified comparable package as a reversible default. Incomparable/color-only cases require explicit selection; the operator may select another real member. No display-only parent or synthetic UPC. Include a new main in its own member list exactly once to keep it purchasable; other cycles/missing references/conflicting managed membership fail.

Every SKU retains its full name, price, stock, images, facts, classification, filename and enablement independently. Deterministically derive unique nonempty PF7 Short Names from verified permitted axes (`5 lb`, or `Small / Red` in configured order). Include pack distinctions when needed. Preserve existing nonempty PF7 by default; replacements are explicit reviewed diffs. Do not remove the main's size from its full name or assign PF7 merely because products share a cohort.

Retain a versioned durable `StorefrontFamilyPlan` with operation (`create`, `join`, `adopt`, explicit edit/removal), main and complete ordered members, item/catalog origins, rule/evidence/type/base/read-write hashes, native block hash, invariant/axis evidence, PF7 diffs, model calls and human decision revision/actor/time. Store changed-product write dependencies and unchanged-member read dependencies. Lifecycle: proposed/revised as supported, accepted, rejected, deferred, stale, applied; applied means the approved Git commit contains the change, not remote publication success.

The main owns the canonical managed member list in the shared Product schema; PF7 stays in its existing custom field, not a duplicated persisted label. Git product/configuration files are approved catalog authority; SQLite indexes are rebuildable projections and operational plans/audit. Unmanaged raw native blocks pass through without reinterpretation. Managed authoring belongs solely to `ShopSiteProductCodec`, with caller-supplied approved member snapshots/native IDs; the codec performs no DB/network lookup and emits no duplicate raw/managed block. Preserve unrelated unknown fields. Verify real store reference/clear/ordering semantics before adoption or dissolution; never invent a `<ShortName>` tag or treat omission as a verified clear.

### 5.3 Review and complete publication

Show every member/import-or-catalog origin, invariant evidence, permitted axes, preserved/new main, PF7 before/after, native diff, changed/unchanged dependencies and stale reasons. Accept/revise/reject/defer explicitly; no probability-based acceptance. Deferral/rejection preserves standalone progress and current relationships. Once an actual family change is selected, its complete dependencies must be ready; this is a Product Family consistency group, not a cohort parent gate.

Resolve true bases and competing drafts; create the complete plan/draft/dependency set in one repository transaction. Before approval, recheck source/type/rule/evidence/review authority, variant tuples, rights, filenames, membership uniqueness, drift, native references and bases for the entire group. Serialize publication under workspace ownership; prepare/validate exact operation-owned files before writing/committing. A member write/index failure prevents a partial approved family. Restore only operation-owned pre-commit changes, never reset unrelated user work.

SQLite, filesystem staging, Git commit and receipt/index recovery are distinct durability layers, not one ACID transaction. After the single complete approved commit exists, recover receipts/index/status idempotently against that commit without a second invented commit or reverting approved history. Export uses the matching approved JSON/dependency manifest and immutable commit, not mutable workspace data. Revalidate later relevant changes before approval/export/push; required new/changed members cannot be split across independent uploads. An unchanged remote member needs verified remote existence/currentness or its required record included.

Use the existing ShopSite adapter and stable `uniqueName=SKU`. MIME completion passes the returned `return_string` to `dbmake.cgi` exactly, then publishes/regenerates only after successful complete import/linking. `newRecords=no` ignores unmatched records and is not safe for creating new members; `(none)` matching risks duplicates and is forbidden here. Do not assume undocumented ordering/forward-reference or atomic multi-record remote import. A partial/timeout result stays unresolved with the complete approved group and reconciliation evidence; no subset is called synced. Verify actual labels/purchase controls with separately authorized compatible storefront canary access. Keep new products disabled and unrelated prices/inventory/status intact.

### 5.4 Retained family acceptance

- **F1:** Same recipe/flavor in three sizes yields one reviewable family; differing recipe/flavor/species/life stage/form does not join.
- **F2:** Configured non-food axes work; material/function/dose/undeclared differences and missing invariants do not pass.
- **F3:** A new size joins approved catalog members across batches without duplicates, changed main or lost labels/members.
- **F4:** A smaller new size preserves an existing main; new comparable families have the documented reversible nomination.
- **F5:** Main-to-self emits once and stays purchasable in the actual template; other cycles/missing/cross-workspace references fail.
- **F6:** Same-SKU ambiguity and competing families require resolution; no transitive bridge merge.
- **F7:** Per-SKU facts/names/prices/stock/images/filenames/status, unrelated accessories/PF32 and unknown fields survive unless explicitly changed by their owners.
- **F8:** Blank/duplicate labels, ambiguous quantities, forbidden packs and duplicate tuples block unsafe acceptance.
- **F9:** Classifier writes to PF7/native Subproducts are refused; listing-owned reviewed edits work.
- **F10:** Unmanaged native blocks round-trip without adoption; managed output emits one block; unsupported adoption loses no fields.
- **F11:** Evidence/type/rule/base/draft/drift changes stale affected plans; no subset bypasses approve/export/push guards.
- **F12:** Pre-/between-write, pre-/post-Git-commit and pre-receipt faults prove no partial approved group and idempotent recovery without unrelated changes.
- **F13:** Partial remote import is not synced; a real compatible canary proves references, main self-membership, labels, ordering and purchase behavior.
- **F14:** Reject/defer preserves independent listing progress and existing relationships, without implicit dissolution.

## 6. Evidence-backed naming and grounded copy

### 6.1 Names

Retain `selectProductName` at the existing name-consolidation seam, consuming this item's accepted immutable facts, permitted normalization/format rules, applicable checklist and optional presentation context. Build complete candidates in code from exact source components; no runtime model-generated title/component text or new fetch/OCR merely for naming. Exclude stale/conflicted evidence and retain material negation, recipe/model/form/life-stage/material/variant distinctions.

Render evidenced brand first and applicable size/count last under house style. Required details derive from the applicable standard and actual variant, not a universal size requirement that blocks model-number parts or unmeasured products. A missing required brand/variant remains a gap; do not invent `Unknown Product`, brand or quantity. Brand ownership stays outside the classifier.

Deduplicate equivalent candidates before inference. One valid or purely stylistic candidate is deterministic; semantic ambiguity uses one bounded Choice over at most sixteen full candidates plus `no_match`/`insufficient_evidence`. The answer maps to an existing candidate only. Sibling context may guide formatting, never establish another SKU's product facts or classification.

Persist exact components/spans, normalization version, item/input/name hashes, producer (`typesafe_selection`, `deterministic`, `manual`), actual call IDs, outcome and reason. Update singleton and former cohort consumers together under item-owned publication; do not retain a parent write-once title set as mandatory item authority. Historical outputs remain readable with honest producing sources. Changes invalidate affected decisions/review/draft filename proposals; approved filenames are not silently renamed.

### 6.2 Grounded copy

A separate explicitly configured generative workload receives only accepted attributable facts and applicable writing requirements, not raw rejected/conflicting sources or sibling copy. Reuse the existing copy-preparation seams, but remove any active instruction that lets the writer choose “most recent/specific” facts to resolve a conflict. Source authority and conflict resolution happen upstream.

Produce useful, coherent descriptions/features that explain this product and its supported differences without invented benefits, ingredients, suitability, instructions or medical/safety claims. Generation is wording, not evidence extraction or approval. Omitted/unknown values are absent, not filled from model knowledge. Permitted source wording or deterministic formatting may be used only with truthful provenance, applicable reuse permission and the same final claim checks; a model failure is never relabeled as successful generation.

Construct claim units in code from final text boundaries. A generator may reference supplied fact IDs, but code must validate each reference; generated citations are not proof. Check the actual final projected description/name, including fallback/manual text, before Review and at downstream currentness gates. Copy policy/model/prompt changes participate in reuse and invalidation. No generative repair chain is added.

### 6.3 Naming/copy acceptance

- **N1:** Accepted base identity and this SKU's actual variant facts produce a complete name without invented or inherited components.
- **N2:** Abbreviated/attached quantities normalize conservatively; applicable distinctions remain, shipping weight is not net content, and a product without a required quantity is not universally blocked.
- **N3:** Conflicting sizes never become a unioned title or a guessed winner; absent required identity details remain actionable.
- **N4:** Negation, flavor/species/life stage/form/model/strength/material distinctions survive presentation coordination.
- **N5:** Exact/equivalent candidates use zero selection calls; the typed result cannot create a new name/component.
- **N6:** Independent items retain truthful producing call/source IDs and equivalent protections; failure/replay of another member cannot withhold or overwrite a current item output.
- **N7:** Manual/evidence/policy edits stale affected name/copy and review state; judgment reuse transfers no approval.
- **N8:** Failures/no-fit/uncertainty/overflow are distinct. Generated copy cannot invent unsupported benefits, ingest rejected source facts, resolve conflicts or fill an approved omission; unsupported final text remains blocked.

## 7. Completeness, claim support, exceptions, and readiness

### 7.1 ListingCompletenessStandard

`ListingCompletenessStandard` is a **proposed** versioned listing-configuration contract stored with approved catalog configuration. Resolve it through the canonical Category + Product Type; it is not a second classifier Attribute Profile. Each requirement has a stable ID, field/content meaning, applicability, evidence/source constraints, requiredness, non-waivable versus exception-eligible status, and deterministic or reviewable satisfaction criteria. Missing configuration/applicability is unresolved, never the least-demanding checklist.

The standard must cover a full evidenced name/variant, useful description and meaningful supported features/specifications, suitable rights-approved imagery, imported commercial data and reviewed classification/placement. Actual food/accessory/parts/care requirements are type-appropriate reviewed content, not hardcoded universal ingredients, nutrition, weight or image-count rules. Review exact checklists before activation; this document does not fabricate them. Classification-required attributes/configuration remain independently governed by ADR 0041.

Compute per-requirement `satisfied`, `missing`, `not_applicable`, `excepted`, `conflicted`, `unavailable`, or `stale`, with exact evidence/policy/exception references. Confirmed non-applicability differs from not found. Evidence sufficiency, claim support, classification readiness and listing completeness are distinct results. An empty string or a nonempty generic description does not establish satisfaction.

### 7.2 Claim checks

Use the existing listing-evidence seam and one shared pure gate/currentness evaluator for Preparation, Review completion, durable approval, draft creation, change-set approval, export and push. Evaluate the exact listing/draft being applied against its current eligible facts and policy, not a different live text projection.

Build claim units in code from name components, structured values and final sentences/bullets/HTML blocks, retaining qualifiers and source hashes. Every material assertion in a multipart statement must be supported. Check deterministic citations, exact identifiers, units/pack structure, source/variant linkage and conflicts first; a model cannot overrule contradiction. Exact supported copies need no model question.

Remaining independent claim Choices return `supported`, `contradicted`, or `insufficient_evidence` over the supplied eligible bundle. Persist input/listing/evidence/checklist/policy hashes, full in-scope claim coverage, exact evidence considered, actual answers/call IDs and aggregate status. “Evidence considered” is not a fabricated per-source proof. Missing responses, overflow beyond the declared 24 claims, unqualified policy or unavailable transport cannot yield a partial green.

An included unsupported claim cannot ship merely because its field is optional. Remove/correct it or supply eligible evidence. An absent optional fact is not a blocker; an applicable required fact needs evidence or an allowed explicit omission. Human verification records a real current observation and actual operator producer; clicking approve cannot create facts or bypass identity/source/rights/classification gates.

### 7.3 ListingCompletenessException

`ListingCompletenessException` is a **proposed**, server-authored immutable decision, not the existing title/description correction receipt. Bind workspace/item/SKU, requirement/field, standard ID/version/hash, relevant canonical classification, input/fact/listing revision, actor/time/reason, expected revision and idempotent action token/receipt. Authorize only a designated non-critical requirement; reject identity/variant, rights, required safety and classification-required field/configuration omissions in code, even if a client or policy marks them waivable.

Approve/revoke through authenticated existing review/correction patterns. Recheck currentness and authority in the transaction. Stale requests mutate nothing and preserve entered operator text; identical action-token retries replay the exact receipt, mismatched payloads refuse. An exception affects only its item/requirement/revision, does not assert a value or mark evidence verified, and remains visible in Review/approval. Relevant fact/classification/standard changes stale it. Removing an unsupported sentence is a text correction, not an omission approval or manual fact verification.

### 7.4 Readiness and acceptance

- **E1:** Current same-SKU facts/spans can support deterministic copies; optional absence and confirmed non-applicability do not become universal gaps.
- **E2:** A claimed 15 lb against verified 5 lb is contradicted regardless of probability or source majority; pack structure is checked separately.
- **E3:** Unsupported included marketing text blocks; removal/correction rechecks the actual final projection without needless inference when deterministic coverage is sufficient.
- **E4:** `not suitable for puppies` cannot support its negation; one supported clause cannot certify a multipart assertion.
- **E5:** Wrong-variant, sibling/example, stale, unlinked or fabricated evidence cannot support a claim; OCR of a selected image is not independent proof that the image depicts the imported SKU.
- **E6:** Richness uses the current applicable standard, not the old title-only fallback. No approved standard, unreadable currentness or incomplete checking means unresolved, not success.
- **E7:** An authorized non-critical omission has visible actor/reason/revision; changing its dependency stales it. Automatic waivers and forged/stale/cross-workspace approvals refuse.
- **E8:** Identity/variant, rights, required safety and ADR 0041 classification-required configuration/values cannot be waived by a listing exception or model/manual support verdict.
- **E9:** Final text, evidence, classification, standard, source authority, rights or policy changes invalidate precisely affected checks and review/approval; unrelated presentation changes do not invent inference work.
- **E10:** Official, distributor, browser and attested contributions converge on the same eligible-fact/readiness meanings without rewriting historical provenance or distributor materialization.
- **E11:** An unrelated incomplete/failed cohort member cannot block a current item. Lost own-item lease, stale snapshot or incomplete own run still blocks publication.
- **E12:** Missing required fields, unsupported included text, approved omissions, unavailable checks and unresolved classification are distinct operator states and remain consistent at all apply/export/push consumers.

## 8. Operator interaction and mutation contract

Use existing Batch Workspace, Review and Needs Attention surfaces; no new shell or agent console. Show this item's accepted facts, source roles/methods, exact source evidence, applicable checklist, missing/conflicted/unavailable/stale reasons, acquisition attempts/budget state, explicit omissions and classification readiness. Shared computation must not display “waiting on family” for unrelated item readiness. Actual Product Family plans retain their own explicit state/actions, not renamed cohort barriers.

Candidate discovery distinguishes offered URLs from confirmed official pages. Source-authority decisions are reusable brand/domain configuration, not profile approval or item fact approval. Never use a progress badge/confidence score to imply authority. Operator requests name the precise remaining variant/domain/rights/field decision; retained safe facts and input remain visible after failure.

Expose grounded-copy/name edits and field-anchored remove/correct/attest/omit actions with their different meanings. Full Name and PF7 Short Name remain distinct controls; PF7 is enabled only for explicit listing-owned family operations. Family review shows all existing/new members and native/label diffs. No preselected approval or silent joins.

Mutations use server-derived workspace/actor/eligibility, expected input/policy revision, exact submitted fields and action token. Stale state returns conflict without mutation; malformed payload is validation failure. Recheck inside the repository transaction; do not run models inside it. Review-completion multi-selection retains its existing all-requested-items validation/atomic semantics; unrelated bulk-release behavior is not silently redefined. Real family operations use the stricter full-group path.

Loading retains data and disables only conflicting saves. Preserve edits on stale responses; show current revision/diff and require explicit resubmission. Overflow includes counts/scope. Keyboard/focus return, descriptive errors, semantic tables and non-color status are required. Narrow layouts retain identity and decision meaning with accessible details. Reuse existing curation rerun/correction/worker flows rather than independent queues or classifier-target mutations for listing-owned exceptions/family plans.

## 9. Dependencies, currentness, and storage ownership

| Change | Recheck/invalidate |
|---|---|
| Imported identity, allowed source role/domain, source response/final URL or selected variant | Admission, relevant collected facts, source confirmation and dependent listing work. |
| Accepted fact/span/connector generation/OCR/manual attestation/rights | Dependent name/copy/claims/checklist, family axes if affected, review/approval; retain immutable old observations. |
| Canonical Category + Product Type or approved Attribute Profile/configuration | Existing ADR 0041 dependents plus applicable listing standard, acquisition gaps and exception eligibility; no sibling propagation. |
| Listing standard/applicability/exception decision | Affected completeness/currentness and review/approval; old omitted facts do not become known. |
| Final projected name/description/fallback/manual text | Exact claim/listing hash, dependent projection/review; never silently rename approved URLs. |
| Model/prompt/rule/meaning/data-sharing policy | Relevant execution/reuse/currentness; only meaning-preserving presentation changes may reuse raw judgments. |
| Family main/members/tuples/PF7/native references, catalog bases/drafts/drift/remote existence | Complete affected family plan/read-write/export dependency closure, not unrelated item/cohort readiness. |

Shared Zod schemas define contracts. Repositories alone own SQL; the existing migration runner installs minimal operational evidence/evaluation/exception state. Approved checklist/source/policy/catalog configuration remains Git-backed; SQLite operational snapshots, decisions and indexes do not become competing approved truth. Do not mark historical rows accepted, checked, reviewed, or adopted through schema defaults/backfill. Keep history readable; new meaning requires a fresh explicit execution/decision.

## 10. Implementation seams and complete cutover

Names below are proposed interfaces where not already implemented, not claims of current exports:

| Interface/contract | Existing seam and required consumers |
|---|---|
| `AcceptedItemEvidence` / item admission | Existing source collectors/materializers, official confirmation, manual evidence and shared schemas; new browser/retailer bindings feed the same eligible-fact semantics. |
| `acquireItemEvidenceGap` | Existing worker/acquisition and isolated rendered infrastructure; gap work, source policy, action validation, item/batch reservations and honest usage outcomes. |
| `selectProductName` / grounded-copy preparation | Existing candidate/name stages and copy consolidators; final projection, source spans, claim checks, item-owned outputs and all former cohort consumers. |
| `ListingCompletenessStandard` / `ListingCompletenessException` / shared item-readiness evaluator | Versioned listing configuration, repository decisions and currentness; Preparation, Review, durable approval, promoter, change sets, export/push and UI use one interpretation. |
| Product Family plan/review/publication | Existing rule/plan/codec/change-set/adapter seams with full scope in section 5; independent of ordinary item readiness. |

The [implementation plan](evidence-first-onboarding-implementation-plan.md) specifies owning files and acceptance/smoke work in this dependency order:

1. Accepted-evidence, standard/exception, repository/currentness and honest migration contracts.
2. Bounded search/browser fallback and source-specific admission, including actual network/isolation enforcement and budget reservation.
3. Rich listing preparation, canonical classification inputs, grounded copy, names, complete support checks and field-specific operator UI.
4. Item-owned claiming/freeze/output/publication; all worker/readiness/projection/review/promotion/UI consumers cut over together. Remove unrelated cohort barriers and obsolete live orchestration, not safety ownership checks or history.
5. End-to-end scenario proof, fixed-population baseline/candidate qualification, fully reviewed canary and canonical activation.

Packages are dependencies, not permission to activate an incomplete product path. All original family authoring/PF7/review/export capabilities remain in scope; do not deliver only family inference or only a browser proposal. Stop incompatible new dispatch at cutover, drain/supersede old work and create fresh item authority. Rollback is disable-to-unresolved/manual or a reviewed code revert, never a maintained second orchestration. No prototype/default mock/fake fallback may be presented as the permanent implementation.

## 11. Qualification and activation

### 11.1 Fixed-population outcome comparison

Use representative real UPC/Register Name/Price-only batches, including unknown brands, unavailable profiles/sources, abbreviated names, near-neighbor models/flavors, unit/case packs, no-fit, ambiguous variants, missing safety/rights evidence, and actual catalog joins. Freeze baseline/candidate inputs, evidence/candidate coverage, final labels, rules, budgets and model policies. Separate families/near-duplicate sources across development and sealed holdout; fitting cannot read holdout labels. Review labels independently; unchanged UI values or model agreement are not proof of correct external product identity.

Report all imported rows, unresolved/failed/denied rows and retrieval misses, not answered overlap. For every percentage name its denominator/support. Measure:

- Correct exact sellable-item/variant resolution, candidate retrieval coverage and wrong-source/authority rates.
- Type-specific rich-listing completion, unsupported/contradicted included claims, false blocks, approved omissions and their actual reviewer outcomes.
- Active operator actions/edit/resolution time per correctly reviewed listing, separately from wall-clock waiting and amortized domain/profile setup.
- End-to-end P50/P95, search/fetch/browser work, model calls/tokens/retries and total billed/observed cost or explicitly labeled estimate/unavailable. Include failed attempts, setup and shared-work attribution; unknown is not zero.
- Family group precision/recall and harmful merges versus harmless splits; main/member/PF7/native preservation, complete publication and recovery. New family inference is not advertised as an existing-call saving.

Retain existing per-capability qualification/comparator gates. Publish development-fitted selection/abstention and release criteria before sealed evaluation; do not copy arbitrary classification floors or invent improvement thresholds/sample sizes. A small fixture, underpowered/unlabeled/stale data, stubbed result or unreviewed canary is blocked qualification, not earned automatic authority.

### 11.2 Required runtime smoke evidence

Permanent regressions target plausible consumer-visible D/F/N/E boundary, error, precedence, currentness, concurrency and recovery bugs; no source-text/wiring/mock-echo tests. Follow existing Bun/Vitest conventions and keep deterministic suites isolated from live credentials/network.

Tests alone are insufficient. Implementation must also run:

1. Actual acquisition/admission/worker flow in a disposable workspace using controlled source artifacts/pages, including real browser navigation/action policy and denied destinations/actions. Distinguish controlled fixture proof from real-source browser qualification.
2. A ready SKU alongside an unresolved/failed cohort peer; observe its own review/draft progress, lease loss/stale refusal and replay without peer authority or fabricated provenance.
3. Name/copy preparation and final claim checks; correct an unsupported claim, approve/revoke a permissible omission, change its inputs/classification and observe invalidation at Review, approval, draft and export.
4. Actual Review/Needs Attention/exception/family surfaces, including stale-save recovery, keyboard/focus and narrow layout.
5. Disposable catalog family create/join/review, one complete approved commit, exported XML/PF7 inspection, per-layer pre-/post-commit failure/recovery, and unknown-field preservation.
6. Separately authorized compatible real-source and store canaries: source identity/content, browser boundary, review decisions, complete import/finalization/publish, visible labels/main purchase behavior and truthful partial-failure handling.

### 11.3 Explicit activation prerequisites

Before activation, provide approved versioned type-specific standards/exception eligibility; enforceable item/batch resource and monetary limits; a configured supported search provider and actual data-sharing authority; qualified isolated browser navigation/egress; model-policy and copy/claim quality qualification; rights-approved usable imagery; and fixed-population outcome/operator/cost evidence. Managed family delivery additionally needs inspected redacted real native-family export semantics and compatible storefront canary proof.

Design approval provides none of the missing provider credentials, pricing contracts, dollar values, product-type content, live-source qualification or store-write permission. Their absence is a named activation blocker, not a placeholder implementation or a reason to mark the path passed.

## 12. Documentation delivery evidence

This revision records the confirmed target and preserves the prior four-capability family/naming/listing scope while replacing profile/cohort-first and no-search assumptions. Primary code and existing qualification reports support the current-state limitations above; TypeSafe [typed function-selection](https://docs.typesafe.ai/cookbooks/function_calling.md), [coding-agent limitations](https://docs.typesafe.ai/introduction/coding-agents.md), and [experimental image support](https://docs.typesafe.ai/images.md) support the separation of browser execution, judgments and prose.

The native family contract is constrained by ShopSite's [Subproduct FAQ](https://help.shopsite.com/help/current/en-US/sc/pro/working/faq.prod.subproducts.html) and [v15 database field documentation](https://help.shopsite.com/help/15.0/en-US/sc/pro/upload.fields.html), the repository field catalog/codec and inspected store evidence. No inferred wire tag, remote atomicity or authenticated workflow is claimed from a fixture alone.

The previous specification session's recorded parser/grouping/identity/codec smokes and offline qualification artifacts remain historical mechanism evidence, not proof of this redesign. This documentation change runs no paid model/search, product-site crawl, production mutation, store upload or activation. Document-link/Markdown validation is reported separately from runtime or product-quality qualification.
