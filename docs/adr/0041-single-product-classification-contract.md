# One canonical Product Classification with reviewed-only authority

**Status:** accepted — owner-confirmed domain contract.

The classifier proposes one canonical **Product Classification**, consisting of the website **Category + Product Type**, for each Product SKU. That classification selects its configured **Attribute Profile**; an internal identifier references the same classification, not a separately inferred or reviewed Product Type. This removes competing type vocabularies and a hidden review gate while retaining configured attribute applicability.

## Contract

- Use only supplied facts and images for the SKU. Reading supplied images, including OCR, is permitted; source discovery, input-data enrichment, and inheritance from sibling products are not. Batch scheduling and frozen evidence remain valid, but neither establishes shared product facts.
- Name and other supplied facts may support classification without usable images. Brand is optional input and never an assignment, replacement, or removal output.
- Always address Category and Product Type. Insufficient, conflicting, or unsupported evidence yields an explicit unresolved result and reason, never a forced label.
- The provisional classification may select a configured profile and drive dependent attribute and page proposals in one pass. Profiles, applicability, cardinality, allowed values, and evidence eligibility constrain those proposals; correcting Category or Product Type invalidates dependent results before application.
- Flavor, ingredients, and health claims require explicit product wording or facts. Package artwork alone is insufficient. Independently supported results may proceed when another field conflicts; uncertain product/variant identity must not be resolved by merging conflicting sources.
- Page proposals target existing verified taxonomy pages only. Brand-page placement and automatic page creation are outside classifier ownership.
- Propose explicit clears/removals for incompatible existing classification values and taxonomy-page assignments. Preserve existing assignments until their removals are reviewed; never touch Brand or other protected product data.
- Classification outputs exclude identity, listing content, pricing, inventory, and operational status. Broader listing preparation remains separate from classification.
- Every proposed assignment and removal requires a reviewed decision, applied separately through CMS drafts. No model-confidence or earned-authority gate bypasses classification review.
- Classification Readiness uses the current reviewed pair and frozen Attribute Profile authority. A required entry is satisfied only by a current accepted value valid under its captured applicability, target, allowed values, cardinality, and unit; missing, empty, invalid, stale, or wrong-target values keep the item in Review.
- An explicitly empty profile is resolved; a missing or invalid declared profile is unresolved. Optional unvalued and confirmed non-applicability do not block, but unknown applicability blocks regardless of optionality.
- Catalog Review and onboarding Review/Promotion consume the same server-owned readiness result; the review surface does not reconstruct readiness rules.
- Correcting either member of the pair invalidates dependent attribute/page/removal decisions before mutation, refreshes only compatible own-SKU evidence as pending review, and retains valid independent decisions. An accepted field result is carried forward as a condition premise only when its effective value is valid and its source attribute remains applicable under the corrected frozen profile; invalid, unknown, or non-applicable premises confer no dependent authority.
- Listing, identity, commercial, and image-rights gates remain separate; classification never supplies protected data to pass them.

## Tradeoff and prior decisions

We reject a parallel granular internal Product Type and website Product Type: finer distinctions belong in configured classification attributes rather than an independent semantic type or review card. We also reject family-level classification inheritance in favor of SKU-local evidence; cohort scheduling and evidence-freeze discipline are retained.

This partially supersedes classification semantics in ADR 0004, the type/family-invariant classification authority in ADR 0013, and the separate-type/future-auto-approval classification provisions in ADR 0033. Their unrelated execution, provider, and pipeline decisions remain intact. Historical terminology in those records describes the prior model, not an active second Product Type.

## Field authority

The [authenticated Extra Fields certification](../audits/extra-fields-certification-2026-10-15.md) establishes the configured field purposes. Facet Category (`ProductField24`) and Facet Product Type (`ProductField25`) are distinct from Product Category (`ProductField31`) and native ShopSite fulfillment `ProductType`. Brand (`ProductField16`), MAP Pricing (`ProductField6`), other listing/identity/commerce roles, and unknown or unverified purposes remain outside classification ownership.

The [export and public-facet audit](../audits/live-storefront-product-fields-2026-10-13.md) supplies corroborating values, not a substitute for authenticated field identity. Empty slots, numeric slot ranges, example values, or an Attribute Mapping alone never establish permission to classify a field. Certification does not approve a granular taxonomy identifier's website meaning; ambiguous meanings require governed Configuration Review, not an invented collapse table.

The approved pair carries explicit storefront values for its Category and Product Type roles; local projection may write only those values to Facet Category (`ProductField24`) and Facet Product Type (`ProductField25`). It must not derive website values from taxonomy identifiers or labels. A missing or ambiguous mapping is an attributable configuration gap that keeps Review open and blocks local draft creation. The current Bay State starter seed intentionally supplies no storefront-value mappings pending governed approval. V2 role bindings are separate from ordinary Classification Attribute mappings, frozen with each run, and must still match the current approved bindings at projection; either both core values project or neither does.

## Shared interpretations

`effective-proposal.ts` owns effective reviewed target/value interpretation for Classification Proposals. `assignment-projection.ts` consumes it and owns explicit clear/no-target handling, serialization, and verified Taxonomy Category Page delta interpretation shared by approved preview and both local draft owners. Refused reviewed changes block application rather than producing a successful partial draft; persistence and final currentness checks remain with the mutation owners.

- `attribute-profile-plan.ts` interprets the immutable own-SKU pair and declared profile for applicability and attribute production. A same-pass provisional pair may select that profile. Conditional applicability resolves from effective accepted facts whose source attributes are applicable, reaching the least fixed point; unknown or non-applicable sources cannot unlock downstream rules or bootstrap cycles. When a pair is corrected, a reviewed condition premise is retained only when its effective accepted value is valid and the premise remains applicable under the corrected profile. When a pair selects a missing or invalid profile, the configuration gap blocks all attribute proposals, including universal attributes; their independent ownership permits proposals without a pair, not a bypass of broken captured configuration.

`frozen-evidence-mapping.ts` gives the freeze scan and frozen-member execution the same supplied-identity, official-page, distributor, manual-evidence, and provenance meanings. Frozen OCR requires both its own source/image input hash and matching non-null expected execution authority. Scan bookkeeping, member persistence, run IDs, and leases stay with their existing owners.
