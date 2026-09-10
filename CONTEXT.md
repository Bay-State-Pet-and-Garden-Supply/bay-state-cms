# Bay State CMS

Bay State CMS manages store product data as local product drafts that can be reviewed, approved, and published to a ShopSite store.

## Language

**Category Page**:
An existing customer-facing store page that a product can be assigned to for browsing.
_Avoid_: Category, taxonomy page, page category

**Category Page Identity**:
The stable live-store identity used to validate a Category Page assignment.
_Avoid_: Display name only, suggested page string

**Category Page Assignment Scope**:
Whether products should be assigned only to the most specific matching Category Page or to multiple matching hierarchy levels.
_Avoid_: Page spam, automatic parent assignment

**Unmapped Category Page**:
A plausible customer-facing store page that does not yet exist in the store.
_Avoid_: Auto-created page, missing category

**Unavailable Category Page Assignment**:
An accepted Category Page assignment whose page no longer exists or is ambiguous at product draft creation.
_Avoid_: Deleted assignment, broken page

**Product Type**:
A reusable classification for products that share the same merchandising expectations.
_Avoid_: Category, template, department

**Primary Product Type**:
The Product Type that selects a product's Attribute Profile when known.
_Avoid_: Secondary type, category, facet

**Unknown Primary Product Type**:
The reviewed absence of a Primary Product Type for a product.
_Avoid_: Product failure, forced type

**Assistant**:
A bounded, schema-validated LLM capability that fills or proposes pipeline outputs by selecting from constrained options (configured enums, existing page identities) and abstaining with a coded reason when it cannot comply. Assistants execute inside frozen cohort windows with audited provenance. _Avoid_: Agent, specialist, bot, autonomous pipeline

**Catalog Adjudication Assistant**:
The Curation-stage Assistant that selects Primary Product Type and Category Page assignments from currently-configured store values only, abstaining to blank-plus-reason when constraints cannot be satisfied. _Avoid_: Classifier agent, auto-classifier, AI curator

**Assistant Authority Gate**:
The measured condition (Wilson lower-bound precision over operator-reviewed history) an Assistant must satisfy before its output may advance items without per-item review. Until met, Assistant output is propose-only and every item passes the Review drawer. _Avoid_: Trust score, autopilot mode, confidence auto-advance

**Coded Abstention**:
An Assistant declining to produce a value, recorded as an empty field plus a machine-readable reason surfaced in the review drawer. _Avoid_: Silent skip, low-confidence guess, fallback value

**Product SKU**:
A store-facing product identifier used as the onboarding key.
_Avoid_: Product identity, product family, variant group

**Product Identity**:
The stable local CMS identity for a product after it becomes a product draft or approved product.
_Avoid_: SKU, onboarding row

**Unmapped Product Type**:
A plausible Product Type that is not yet configured for the store.
_Avoid_: New category, auto-created type

**Product Attribute**:
A store-configured merchandisable fact about a product, such as flavor, color, size, material, or life stage.
_Avoid_: Field, custom field, classifier result

**Attribute Group**:
An optional manager-facing grouping for Product Attributes.
_Avoid_: Product Type, classification rule, inheritance

**Attribute Group Layout**:
A Product Type-specific display ordering or override for Attribute Groups.
_Avoid_: Classification rule, attribute applicability

**Unmapped Product Attribute**:
A Product Attribute without a live Catalog Field target.
_Avoid_: Planned field, final assignment

**Universal Product Attribute**:
A Product Attribute that is universally PROPOSABLE from evidence, with requiredness and applicability still enforced by the Attribute Profile.
_Avoid_: Global field, common metadata

**Product Claim**:
A Product Attribute that states a marketing or compliance-sensitive claim about a product.
_Avoid_: Creative copy, inferred benefit

**Direct Claim Evidence**:
Classification Evidence that explicitly states a Product Claim.
_Avoid_: Inferred claim, absence-based claim

**Absence-Based Claim**:
A claim inferred from missing evidence rather than an explicit product statement.
_Avoid_: Free-from claim, allergen conclusion

**Product Composition Attribute**:
A Product Attribute that records ingredient, nutrient, active ingredient, allergen, or analysis information.
_Avoid_: Generic attribute, generated summary

**Attribute Profile**:
The set of Product Attributes expected for a Product Type.
_Avoid_: Field set, schema, template

**Attribute Constraint**:
A Product Type-specific limit on how a Product Attribute may be assigned.
_Avoid_: Validation rule, configuration option

**Attribute Applicability Condition**:
A deterministic Attribute Profile rule that decides whether a Product Attribute applies to a product.
_Avoid_: Free-form guidance, hidden classifier rule

**Applicability Preview**:
A non-final indication that a Product Attribute may apply based on unreviewed proposals.
_Avoid_: Required field, final assignment

**Non-Applicable Product Attribute**:
A Product Attribute whose Attribute Applicability Conditions are not satisfied for a product.
_Avoid_: Deleted attribute, hidden field

**Applicability Override**:
A reviewer decision that treats a Non-Applicable Product Attribute as applicable for one product.
_Avoid_: Attribute Profile change, silent applicability change

**Attribute Cardinality**:
Whether a Product Attribute accepts one value or multiple values for a Product Type.
_Avoid_: Array field, multi-select flag

**Unmapped Attribute Value**:
A plausible controlled Product Attribute value that is not yet allowed by the relevant Attribute Profile.
_Avoid_: Bad value, invalid value, hallucination

**Attribute Value Mode**:
The way a Product Attribute accepts values, such as controlled choice, free text, or measured value.
_Avoid_: Field type, data type

**Measured Attribute Value**:
A structured Product Attribute value with a quantity, unit, or range.
_Avoid_: Display string, raw text

**Canonical Measurement Unit**:
The standard unit used to compare Measured Attribute Values for a Product Attribute.
_Avoid_: Display unit, original text

**Attribute Value Alias**:
A configured synonym that supports mapping evidence text to a controlled Product Attribute value.
_Avoid_: Replacement value, hidden rewrite

**Ambiguous Attribute Value Alias**:
An Attribute Value Alias that could map to different values in different Product Types or contexts.
_Avoid_: Bad alias, automatic match

**Canonical Controlled Value**:
A controlled Product Attribute value whose stored string IS its identity: NFC-normalized and trimmed, with label equal to the ID (v2 policy). Config validation rejects empty/control-character/non-NFC/non-trimmed values, exact duplicates, normalized/case-fold collision pairs, and aliases whose target is not an exact allowed value. Evidence-text matching is case-tolerant, but the emitted value is always the exact canonical ID — the runtime never guesses an ID from a display label. See `src/classification/controlled-value-identity.ts` and ADR 0012.
_Avoid_: Display string as ID, case-variant values, silent rewrite

**ShopSite Built-in Output Field**:
A DTD-level ShopSite product element governed by the immutable adapter-owned output policy (Name, FileName, Price, SaleAmount, ProductDescription, MinimumQuantity, ProductType, Weight, Graphic, MoreInformationText, MoreInformationGraphic, SearchKeywords, MoreInfoImage1–20). The policy fixes each field's omission/default/encoding/cardinality rule; it is not workspace-configurable, and `ProductField*` values are never built-ins. See `src/shopsite/built-in-output-policy.ts` and ADR 0011.
_Avoid_: Store-specific config for DTD behavior

**Catalog Field**:
A store-specific product field present in the live ShopSite XML pulled from the store.
_Avoid_: Database column, classifier slot, planned field

**Catalog Field Serialization**:
The store-specific format used when writing one or more Product Attribute values into a Catalog Field.
_Avoid_: String formatting, display text

**Attribute Mapping**:
A workspace-specific link from a Product Attribute to its primary Catalog Field.
_Avoid_: Store-specific taxonomy, hardcoded field map

**Stale Attribute Mapping**:
An Attribute Mapping whose Catalog Field is no longer present in the live ShopSite XML pull.
_Avoid_: Deleted mapping, broken field

**Legacy Field Map**:
A store-specific mapping that predates the Product Attribute model.
_Avoid_: Attribute Profile, classification model

**Field Assignment**:
A reviewed value for a store-specific product attribute.
_Avoid_: Metadata, tag, enrichment

**Classification Proposal**:
A reviewable suggested Product Type, Category Page, or Field Assignment for a product.
_Avoid_: Automatic classification, final assignment

**Proposal Confidence**:
A confidence level for a Classification Proposal that influences review preselection.
_Avoid_: Certainty, auto-approval

**Proposal Decision**:
A reviewer choice to accept, reject, or defer one Classification Proposal.
_Avoid_: Product approval, batch approval

**Proposal Decision Revision**:
A later reviewer choice that changes an earlier Proposal Decision without erasing it.
_Avoid_: Mutated decision, deleted history

**Bulk Proposal Acceptance**:
A reviewer action that accepts multiple safe Classification Proposals at once.
_Avoid_: Auto-approval, blanket acceptance

**Manual Review Requirement**:
A Catalog Manager Guidance rule that requires an individual Proposal Decision for an otherwise safe Classification Proposal.
_Avoid_: Safety bypass, auto-rejection

**Batch Bulk Proposal Acceptance**:
Bulk Proposal Acceptance across multiple Product SKUs in one onboarding batch.
_Avoid_: Blind batch approval, automatic batch classification

**Product Draft Projection**:
A preview of product draft fields and Category Page assignments derived from accepted Proposal Decisions.
_Avoid_: Final product draft, persisted field values

**Skipped Draft Assignment**:
An accepted proposal that is not written during product draft creation because it is stale or blocked by configuration.
_Avoid_: Product blocker, silent omission

**Classification History**:
The retained local CMS operational record of Classification Proposals, Classification Evidence, and Proposal Decisions for a product.
_Avoid_: Canonical catalog state, final field values, model log, ShopSite export data

**Classification Run**:
A reproducible attempt to create Classification Proposals for one Product SKU.
_Avoid_: Model call, ad hoc enrichment

**Classification Configuration Snapshot**:
The Classification Configuration state used for a Classification Run.
_Avoid_: Runtime cache, hidden prompt state

**Configuration Snapshot Drift**:
A mismatch between a proposal's Classification Configuration Snapshot and the active Classification Configuration.
_Avoid_: Silent reinterpretation, old mapping reuse

**Classification Refresh**:
A Classification Run triggered by changed product evidence or changed Classification Configuration.
_Avoid_: Silent overwrite, automatic approval

**Configuration-Driven Classification Refresh**:
A visible Classification Refresh queued after Configuration Review changes active Classification Configuration.
_Avoid_: Hidden rerun, inline configuration application

**Refresh Scope**:
The set of Classification Stages rerun during a Classification Refresh.
_Avoid_: Always-full rerun, hidden partial rerun

**Refresh Preview**:
A configuration-review summary of affected products and Classification Stages before a Classification Refresh is queued.
_Avoid_: Hidden queue, surprise rerun

**Refresh Deferral**:
A manager choice to exclude a Product SKU from a queued Classification Refresh.
_Avoid_: Invalid partial refresh, skipped required stage

**Stale Classification Proposal**:
A Classification Proposal that should be reconsidered because a dependent proposal changed.
_Avoid_: Invalid field, deleted suggestion

**Classification Evidence**:
A product fact that supports a Classification Proposal.
_Avoid_: Model output, AI reasoning

**Evidence Source**:
The origin of Classification Evidence, such as product text, visual observation, inferred context, spreadsheet hint, brand history, or prior approved products.
_Avoid_: Model reasoning, prompt output

**Third-Party Evidence**:
Classification Evidence from a retailer, marketplace, distributor, or other non-official product page.
_Avoid_: Official evidence, claim evidence

**Distributor Scraper**:
An `html_scraper` connector family that extracts distributor catalog data from web storefronts via authenticated sessions (orgill, pet_food_experts, phillips_storefront, bradley, central_pet). Distributor Scrapers are Distributor Connections whose transport is web scraping rather than a provider API or catalog feed (ADR 0014 Amendment B).
_Avoid_: Crawler, bot, legacy adapter

**Page Context Evidence**:
Low-reliability Classification Evidence derived from existing or proposed Category Page names, paths, or hierarchy.
_Avoid_: Direct product evidence, claim evidence

**Evidence Conflict**:
A disagreement between Classification Evidence that prevents a confident proposal.
_Avoid_: Model error, bad data

**Evidence Reliability**:
The trustworthiness of an Evidence Source for preselecting a Classification Proposal.
_Avoid_: Truth, priority rule

**Approved Product Example**:
An existing reviewed product used as store-local evidence for a Classification Proposal.
_Avoid_: Training data, global example

**Configuration Suggestion**:
A reviewable proposed Product Type, Product Attribute, Attribute Constraint, or allowed value derived from store-local evidence.
_Avoid_: Auto-generated configuration, inferred schema

**Configuration Review**:
A workspace-level review of Configuration Suggestions and Configuration Changes.
_Avoid_: Product review, inline product decision

**Starter Preset**:
An optional predefined set of Product Types, Product Attributes, Attribute Constraints, and allowed values that a store may adapt.
_Avoid_: Default configuration, global taxonomy

**Batch Classification Hint**:
A temporary cue used to interpret products in one onboarding batch.
_Avoid_: Workspace configuration, permanent mapping

**Baseline Classification**:
The automatic classification work that can run before durable Classification Configuration exists.
_Avoid_: Full classification, configured attribute proposal

**Configured Classification**:
Classification work that depends on active Classification Configuration.
_Avoid_: Baseline classification, always-on classification

**Classification Configuration**:
The durable workspace-specific setup for Product Types, Product Attributes, Attribute Profiles, Attribute Mappings, and allowed values.
_Avoid_: Runtime cache, batch hint, model prompt

**Catalog Manager Guidance**:
Manager-authored instructions that shape classification behavior for a workspace, Product Type, Product Attribute, Category Page assignment, or Attribute Mapping.
_Avoid_: Hardcoded behavior, hidden prompt

**Structured Catalog Manager Guidance**:
Catalog Manager Guidance expressed as enforceable configuration.
_Avoid_: Free-form prompt, suggestion text

**Free-Form Catalog Manager Guidance**:
Catalog Manager Guidance expressed as natural-language merchandising preference.
_Avoid_: Enforceable rule, safety rule

**Guidance Boundary**:
The separation that keeps Catalog Manager Guidance, Classification Safety Rules, and product evidence distinct for Model-Backed Classification Stages.
_Avoid_: Verbatim prompt, mixed evidence

**Untrusted Product Evidence**:
Product evidence that may contain product facts but cannot issue instructions to a Classification Stage.
_Avoid_: Manager guidance, model instruction

**Structured Product Evidence**:
A bounded product fact, snippet, or observation extracted from Untrusted Product Evidence with provenance.
_Avoid_: Raw page text, prompt content

**Evidence Snapshot**:
A bounded retained copy of Structured Product Evidence as it existed when it supported a proposal or decision.
_Avoid_: Raw page archive, full image copy

**Evidence Retention Policy**:
The workspace default and type-specific override rules that control how long Evidence Snapshots are retained.
_Avoid_: Immediate purge, raw archive policy

**Visual Product Evidence**:
Structured Product Evidence extracted from a product image.
_Avoid_: Final visual classification, image guess

**Visual Evidence Eligibility**:
Whether a Product Attribute may use Visual Product Evidence for proposals.
_Avoid_: Image-based guessing, universal vision support

**Evidence Extraction Stage**:
A Classification Stage that turns Untrusted Product Evidence into Structured Product Evidence.
_Avoid_: Proposal stage, raw prompt passthrough

**Guidance Precedence**:
The order used to resolve overlapping Catalog Manager Guidance from broader and narrower scopes.
_Avoid_: Prompt merge, hidden override

**Guidance Override Warning**:
A configuration-review warning that narrower Catalog Manager Guidance overrides broader guidance.
_Avoid_: Configuration blocker, hidden conflict

**Classification Safety Rule**:
A non-overridable constraint that Catalog Manager Guidance cannot weaken.
_Avoid_: Preference, manager instruction

**Configuration Change**:
A reviewed update to Classification Configuration.
_Avoid_: Instant setting, runtime tweak

**Configuration Gap**:
A missing, stale, or unmapped part of Classification Configuration that prevents a proposal from becoming a final Field Assignment.
_Avoid_: Product blocker, validation error

**Classification Stage**:
A focused step that turns available product information into either Classification Evidence or Classification Proposals.
_Avoid_: Monolithic prompt, all-in-one classifier

**Deterministic Classification Stage**:
A rule-based Classification Stage that uses configuration or exact extraction instead of a generative model.
_Avoid_: AI fallback, heuristic guess

**Model-Backed Classification Stage**:
A Classification Stage that uses a language or vision model to interpret product information.
_Avoid_: Deterministic rule, hidden automation

**Stage Model Policy**:
The advanced model/provider selection used by a Model-Backed Classification Stage, with workspace defaults and optional stage overrides.
_Avoid_: Hardcoded model, global-only model setting, everyday merchandising setting

**Stage Model Fallback**:
An explicitly allowed alternate model/provider for a Stage Model Policy when the selected model is unavailable.
_Avoid_: Silent fallback, implicit cloud fallback

**Model Data Sharing Policy**:
The workspace or stage rule that controls what product evidence may be sent to cloud-backed Model-Backed Classification Stages.
_Avoid_: Implicit upload, provider default

**Image Data Sharing Policy**:
The rule that controls whether raw product images may be sent to cloud-backed vision stages.
_Avoid_: Text evidence policy, implicit image upload

**Sensitive Store Data**:
Store data that must not be sent to model providers, such as credentials, API keys, merchant identifiers, or raw secrets.
_Avoid_: Product evidence, allowed context

**Classification Model Preset**:
A manager-friendly quality, cost, speed, or locality choice that maps to Stage Model Policies.
_Avoid_: Raw provider setting, model override

**Stage Abstention**:
A Classification Stage outcome that intentionally produces no proposal.
_Avoid_: Failure, empty result, low-confidence guess

**Reviewable Abstention**:
A Stage Abstention surfaced to a reviewer because the missing proposal matters.
_Avoid_: Review noise, validation error

**Stage Failure**:
A failed Classification Stage that is recorded without failing the entire Classification Run.
_Avoid_: Product failure, run failure

**Stage Dependency**:
A required or optional input relationship between Classification Stages.
_Avoid_: Hidden ordering, implicit prerequisite

## Relationships

- A **Product Type** defines which **Product Attributes** are relevant for a product.
- A **Product SKU** may have one **Primary Product Type** or an **Unknown Primary Product Type** during review.
- A **Primary Product Type** gates Product Attribute classification except for **Universal Product Attributes**, which are universally PROPOSABLE from evidence while the **Attribute Profile** continues to enforce requiredness and applicability.
- An **Unknown Primary Product Type** pauses type-gated Product Attribute proposals and Category Page proposals but does not block product draft creation.
- A **Product Type** remains local CMS classification unless represented by a mapped **Product Attribute**.
- Changing a **Product Type** may make type-specific **Classification Proposals** stale.
- Changing the **Primary Product Type** is a **Proposal Decision Revision** with downstream effects.
- Changing the **Primary Product Type** triggers a **Classification Refresh** for dependent Attribute Applicability, Attribute Proposal, Category Page Proposal, and Product Draft Projection stages.
- An **Unmapped Product Type** requires review before it can become a **Product Type**.
- An **Attribute Profile** belongs to exactly one **Product Type**.
- An **Attribute Profile** may define **Attribute Constraints** for each included **Product Attribute**.
- An **Attribute Profile** may define **Attribute Applicability Conditions** for each included **Product Attribute**.
- An **Attribute Applicability Condition** may use unreviewed proposals only for **Applicability Previews**.
- Accepted or reviewed values are required before an **Attribute Applicability Condition** can affect final Field Assignments or required-field validation.
- Required-field validation applies only to Product Attributes whose **Attribute Applicability Conditions** are satisfied by accepted or reviewed values.
- A **Non-Applicable Product Attribute** does not affect final Field Assignments or required-field validation.
- Product review focuses on applicable Product Attributes while allowing Non-Applicable Product Attributes to be inspected for configuration debugging.
- An **Applicability Override** may allow a Non-Applicable Product Attribute to receive a Proposal Decision for one product.
- An **Applicability Override** is not eligible for bulk actions.
- An **Applicability Override** may produce a **Configuration Suggestion** when it indicates the Attribute Profile may be wrong.
- An **Attribute Profile** may define **Attribute Cardinality** for each included **Product Attribute**.
- An **Attribute Profile** may define Product Type-specific **Attribute Value Aliases**.
- An **Attribute Profile** may define confidence thresholds for its **Classification Proposals**.
- An **Unmapped Attribute Value** requires review before it can become a **Field Assignment**.
- An **Unmapped Category Page** requires review before it can become a **Category Page**.
- A **Product Attribute** may appear in many **Attribute Profiles**.
- A **Product Attribute** may belong to one **Attribute Group** for review and configuration organization.
- **Classification Configuration** may define workspace-global **Attribute Groups**.
- A **Product Type** may define an **Attribute Group Layout** for manager-facing display.
- An **Attribute Group** does not determine whether a Product Attribute applies to a product.
- A **Product Attribute** may have one **Attribute Mapping**.
- An **Unmapped Product Attribute** cannot produce a final **Field Assignment**.
- An **Attribute Mapping** points to one primary **Catalog Field**.
- A **Stale Attribute Mapping** cannot produce a final **Field Assignment** until remapped.
- A **Catalog Field** must come from the live ShopSite XML pulled from the store.
- A **Product Attribute** has exactly one **Attribute Value Mode**.
- A **Product Claim** requires **Direct Claim Evidence**.
- An **Absence-Based Claim** cannot become a **Classification Proposal**.
- A **Product Composition Attribute** requires strict evidence and provenance.
- A measured **Product Attribute** stores **Measured Attribute Values** before field serialization.
- A measured **Product Attribute** has one **Canonical Measurement Unit**.
- A controlled **Product Attribute** may define **Attribute Value Aliases**.
- An **Ambiguous Attribute Value Alias** requires review before preselection.
- A **Field Assignment** applies to the **Catalog Field** identified by its **Attribute Mapping**.
- A **Field Assignment** uses **Catalog Field Serialization** when writing values into a **Catalog Field**.
- A product may belong to zero or more **Category Pages**.
- **Category Page** assignment requires a known **Primary Product Type**.
- **Category Page** assignment may depend on **Product Type**, **Product Attributes**, and direct product evidence.
- **Category Page** assignment follows the configured **Category Page Assignment Scope**.
- **Category Page Assignment Scope** may be defined by Product Type with a workspace default fallback.
- Without configuration or store-local evidence, Category Page assignment prefers the most specific matching Category Page.
- A **Category Page** may provide **Page Context Evidence**.
- **Page Context Evidence** may use the full existing Category Page hierarchy when available.
- **Page Context Evidence** cannot support Product Claims or Product Composition Attributes.
- A product can only be assigned to existing **Category Pages**.
- A **Category Page** has one **Category Page Identity**.
- An accepted Category Page assignment is validated by **Category Page Identity** before product draft creation.
- An **Unavailable Category Page Assignment** becomes a **Skipped Draft Assignment**.
- A product may have zero or more **Field Assignments**.
- A **Field Assignment** records the value of one **Product Attribute** for one product.
- A **Classification Run** is composed of one or more **Classification Stages**.
- A **Classification Stage** declares its **Stage Dependencies**.
- A **Classification Stage** produces **Classification Evidence**, **Classification Proposals**, or a **Stage Abstention**.
- A **Deterministic Classification Stage** runs before model-backed stages when it can answer the same question.
- **Free-Form Catalog Manager Guidance** may inform **Model-Backed Classification Stages**.
- **Model-Backed Classification Stages** use a **Stage Model Policy**.
- A **Stage Model Policy** may define **Stage Model Fallbacks**.
- Model unavailability without an allowed **Stage Model Fallback** becomes a **Stage Failure** or **Stage Abstention**.
- **Model-Backed Classification Stages** respect **Guidance Boundaries** between safety rules, configuration, manager guidance, and product evidence.
- **Structured Catalog Manager Guidance** drives **Deterministic Classification Stages**.
- A **Stage Abstention** is recorded in **Classification History** without forcing a **Classification Proposal**.
- A **Stage Abstention** may become a **Reviewable Abstention** when it concerns an expected or important Product Attribute.
- A **Stage Failure** is recorded in **Classification History** without failing the whole **Classification Run**.
- A required **Stage Dependency** can make a dependent **Classification Stage** unavailable.
- An optional **Stage Dependency** can lower proposal confidence without stopping a dependent **Classification Stage**.
- A **Classification Proposal** is supported by one or more pieces of **Classification Evidence**.
- A **Classification Proposal** has exactly one **Proposal Confidence**.
- **Proposal Confidence** may preselect but never bypass a **Proposal Decision**.
- **Classification Evidence** has exactly one **Evidence Source**.
- Product evidence is **Untrusted Product Evidence** for Model-Backed Classification Stages.
- **Untrusted Product Evidence** cannot override Classification Safety Rules, Catalog Manager Guidance, or Classification Configuration.
- An **Evidence Extraction Stage** produces **Structured Product Evidence** from **Untrusted Product Evidence**.
- A vision model may produce **Visual Product Evidence** as an **Evidence Extraction Stage**.
- A Product Attribute may define **Visual Evidence Eligibility**.
- **Visual Product Evidence** may support proposals only within the Product Attribute's **Visual Evidence Eligibility**.
- Model-backed proposal stages should prefer **Structured Product Evidence** over raw product text.
- A **Model Data Sharing Policy** controls what evidence may be sent to cloud-backed Model-Backed Classification Stages.
- An **Image Data Sharing Policy** controls cloud access to raw product images separately from text evidence.
- Raw product images remain local unless an **Image Data Sharing Policy** explicitly permits cloud processing.
- **Sensitive Store Data** is never sent to model providers.
- **Third-Party Evidence** may support ordinary merchandising Product Attributes.
- **Third-Party Evidence** cannot support Product Claims or Product Composition Attributes unless explicitly configured.
- **Evidence Reliability** influences proposal preselection.
- **Evidence Reliability** may vary by Product Attribute and workspace.
- An **Evidence Conflict** requires review before preselection.
- An **Approved Product Example** may provide **Classification Evidence**.
- An **Approved Product Example** may produce **Configuration Suggestions**.
- A **Starter Preset** may produce **Configuration Suggestions**.
- A **Legacy Field Map** may produce **Configuration Suggestions**.
- A **Configuration Suggestion** may propose merging multiple legacy entries into one **Product Attribute**.
- A **Configuration Suggestion** is resolved through **Configuration Review**.
- Product review may link to **Configuration Review** but does not apply workspace-level configuration changes inline.
- A **Batch Classification Hint** may inform **Classification Proposals** for one onboarding batch.
- **Baseline Classification** may run without active **Classification Configuration**.
- **Configured Classification** requires active **Classification Configuration**.
- Missing Classification Configuration produces **Configuration Suggestions** rather than Product Type or Product Attribute proposals.
- **Classification Configuration** contains the durable Product Types, Product Attributes, Attribute Profiles, Attribute Mappings, allowed values, Catalog Manager Guidance, Stage Model Policies, Classification Model Presets, and Model Data Sharing Policies for a workspace.
- A Catalog Manager Guidance edit is a **Configuration Change**.
- A **Classification Configuration Snapshot** includes the active **Catalog Manager Guidance** for that run.
- **Catalog Manager Guidance** may be **Structured Catalog Manager Guidance** or **Free-Form Catalog Manager Guidance**.
- **Catalog Manager Guidance** follows **Guidance Precedence** when multiple scopes apply.
- **Guidance Precedence** favors the narrowest applicable scope within **Classification Safety Rules**.
- **Guidance Override Warnings** surface broader guidance overridden by narrower guidance.
- **Structured Catalog Manager Guidance** is preferred when classification behavior can be enforced.
- **Free-Form Catalog Manager Guidance** may inform **Classification Proposals** within **Classification Safety Rules**.
- **Classification Safety Rules** include live Catalog Field matching, review before final assignment, and direct-evidence requirements for Product Claims.
- A **Classification Run** uses exactly one **Classification Configuration Snapshot**.
- A **Classification Run** produces **Classification Proposals** for one **Product SKU**.
- A **Classification Refresh** may make dependent **Classification Proposals** stale.
- A **Classification Refresh** has a **Refresh Scope**.
- Primary Product Type changes determine Refresh Scope through dependent stages.
- A **Classification Refresh** may have a **Refresh Preview** before it is queued.
- A **Refresh Preview** may allow **Refresh Deferrals** for Product SKUs.
- A **Refresh Deferral** cannot alter required stages for included Product SKUs.
- A **Classification Refresh** must preserve prior **Proposal Decisions** in **Classification History**.
- **Configuration Review** may queue **Configuration-Driven Classification Refreshes** for affected products.
- A **Configuration-Driven Classification Refresh** reruns affected stages when dependencies are known and falls back to a full Classification Run when impact is unclear.
- A **Configuration Suggestion** becomes active only through a **Configuration Change**.
- A **Configuration Change** is reviewed before it updates **Classification Configuration**.
- A **Configuration Gap** blocks affected **Field Assignments** but does not block product draft creation.
- A **Classification Proposal** has its own **Proposal Decision**.
- A **Proposal Decision** may have **Proposal Decision Revisions**.
- A **Proposal Decision Revision** preserves earlier decisions in **Classification History**.
- **Bulk Proposal Acceptance** may apply only to safe, unambiguous Classification Proposals.
- A **Manual Review Requirement** removes Bulk Proposal Acceptance eligibility.
- **Batch Bulk Proposal Acceptance** requires a preview summary before applying decisions across Product SKUs.
- Product Claims, Product Composition Attributes, Evidence Conflicts, Unmapped values, Configuration Gaps, Stale Classification Proposals, and Manual Review Requirements require individual Proposal Decisions.
- A product may have one **Classification History**.
- Before product draft creation, **Classification History** is associated with a **Product SKU**.
- After product draft creation, **Classification History** is associated with a **Product Identity** while retaining Product SKU references.
- A **Classification History** preserves proposals, evidence, and decisions separately from final product values.
- A **Classification History** retains **Evidence Snapshots** sufficient to explain past decisions.
- **Evidence Retention Policy** controls how long **Evidence Snapshots** are retained.
- **Evidence Retention Policy** may vary by evidence type or Product Attribute type.
- **Classification History** is local operational/audit state, not canonical catalog state.
- **Classification History** stays in the local CMS and is not exported to ShopSite.
- A **Stale Classification Proposal** requires a new **Proposal Decision** before becoming a **Field Assignment** or **Category Page** assignment.
- A **Product Draft Projection** previews accepted **Proposal Decisions** before product draft creation.
- **Configuration Snapshot Drift** makes affected accepted proposals stale before product draft creation.
- A **Skipped Draft Assignment** does not block product draft creation.
- A **Classification Proposal** applies to one **Product SKU**.
- A **Classification Proposal** becomes a **Field Assignment** or **Category Page** assignment only during product draft creation.

## Example dialogue

> **Dev:** "If a food product is assigned to the **Dog Food** **Category Page**, do we automatically know its flavor?"
> **Domain expert:** "No — the **Category Page** controls where customers browse for it, while flavor is a **Product Attribute** determined from the product data."

## Onboarding Pipeline

**Onboarding Batch**:
A group of products imported together from a spreadsheet. It is the primary view lens for the Pipeline Board — users navigate between batches to see items at different stages. It aggregates derived progress from its items but has no lifecycle control of its own.
_Avoid_: Active batch, processing unit, batch status

**Pipeline Stage**:
A declared step in the onboarding pipeline. Each item independently tracks which stage it is in and its stage-level status. Stages form a linear progression defined once per workspace.
_Avoid_: Batch status, phase, step

**Stage Status**:
An item's status within a Pipeline Stage: `pending`, `in_progress`, `completed`, `failed`, or `skipped`. Failed items remain in their current stage column. The user resets them to `pending` to retry processing in the same stage — they never move backwards to a previous stage.
_Avoid_: Item state, pipeline status, old status

**Stage Advancement**:
The action of moving one or more items from their current Pipeline Stage to the next. Happy-path progression is automation-owned: the worker runs `sweepAutoAdvance` every poll (discovery→extraction→curation→review) plus `sweepDomainReleases`, so an item that satisfies its stage exit contract advances without an operator click. Manual advancement is reserved for explicit human decisions — approval, export, source-conflict resolution, URL/profile exception resolution. The worker only processes items within their current stage; retries are idempotent (`pending` requeue, never backwards). (Supersedes the pre-ADR-0016 “always manual” wording for the operator model; execution `stage` + `stage_status` diagnostics semantics unchanged.)
_Avoid_: Batch promotion, phase transition, routine manual auto-advance

**Stage Names**:
The six declared Pipeline Stages (v1 storage vocabulary; v2 canonical vocabulary owner-approved 2026-09-08 — `route_sources` / Identify & Route Sources, `find_product_page` / Find product page, `collect_details` / Collect details, `prepare_listing` / Prepare listing, `review_listings` / Review listings, `create_drafts` / Create drafts): **Sourcing**, **Discovery**, **Extraction**, **Curation**, **Review**, and **Promotion**, in that order. Storage remains v1 until the separately gated migration; see ADR 0034.

**Sourcing** (v2 canonical `route_sources` / Identify & Route Sources — owner-approved 2026-09-08):
The first pipeline stage that evaluates distributor evidence against each imported product (ADR 0014 + Amendment A). The capability is **DEFAULT ON** (`BAYSTATE_CMS_SOURCING_ENABLED` absent = enabled, mode `automatic`; explicit `false|0|no` is the global kill switch; empty/whitespace/malformed values fail closed disabled; `BAYSTATE_CMS_SOURCING_MODE` selects `observe|manual|automatic`). Imports derive their entry stage from the effective capability (`manual`/`automatic` → **Sourcing**, otherwise **Discovery**) and write `sourcing_entry_policy_version = 1`; pre-Amendment rows (version 0, incl. the 148 legacy rows) are never claimed, observed, or backfilled and stay on the audited **Continue to Official Site Discovery** path. When active, the worker runs the provider-neutral engine (`src/onboarding/sourcing/`) — enabled distributor connections (Phillips/BCI Phase 1 REST `api` connectors; Orgill/PFX/Phillips-storefront/Bradley/Central Pet `html_scraper` **Distributor Scraper** connectors per Amendment B — the deferred Orgill/PFX SFTP plans and Central Pet EDI feed are superseded as primary transports), each invoked with an exact normalized UPC/GTIN lookup (brand is advisory only, never a filter and never implies `not_stocked`). Evidence attempts are immutable and generation-scoped (`sourcing_generations`); a retry supersedes the generation. The reconciler compares identity-critical fields (upc/gtin/MPN/weight/size/count/packCount/brand, plus variant axes incl. flavor/formula and connector-declared axes): a deterministic projection authority decides qualification; hard identity disagreements persist as durable conflicts (`sourcing/needs_input`) resolvable only via the operator workflow (use candidate / custom value / dismiss); no evidence or provider errors degrade to audited fallback routes. **A qualified distributor record SKIPS Discovery**: the route `distributor_record_to_extraction` moves the item to `extraction/pending` with `source_type='distributor_record'` and a null URL (never a fake official URL). Materialization is **merchandising-depth** (Amendment B): identity fields plus description, features, category, dimensions, case pack, unit of measure, ingredients, and image URLs (display-only); price/inventory stay excluded and the URL stays null. Merchandising fields merge with per-field provenance and never trigger conflicts — only identity-critical fields do. Modes: `observe` writes only generations+attempts (zero decisions/acceptances/conflicts/extractions); `manual` holds non-conflict outcomes at `needs_input` with a server-derived qualification view and two operator actions (**Use distributor record** / **Continue to Official Site Discovery**); `automatic` applies the full route table (hard conflicts always manual). `bundle_to_curation` is prohibited and unactionable everywhere; no Sourcing → Curation routing exists. Distributor images are display-only until PI-6 rights verification. See `docs/runbooks/sourcing-engine-rollout.md` for the rollout/rollback sequence and read-only observation queries.
_Avoid_: Branding stage, distributor-to-curation routing, fake source URLs

**Brand Sourcing Strategy**:
A system-proposed, operator-approved reusable plan for gathering product evidence from one or more legitimate sources for a brand; an official website is optional. Each explicit Save is the approval command and immediately produces the next approved revision. Complementary evidence remains attributable to its sources and is collected for consolidation during **Prepare listing**, rather than requiring one exclusive source.
_Avoid_: Official-domain requirement, single-source route, extractor profile

**Partial Source Collection**:
Gathering evidence from available sources in an approved **Brand Sourcing Strategy** while other planned sources are unavailable. Unavailable sources remain visible but do not block collection from usable sources; listing sufficiency is assessed during **Prepare listing**.
_Avoid_: Whole-product profile block, silent source omission

**Listing Evidence Gap**:
Missing product information that prevents a usable listing after collected evidence is consolidated during **Prepare listing**, requiring operator help in that stage. A gap is distinct from an identity or variant conflict, which must be resolved before conflicting evidence can be used together.
_Avoid_: Incomplete individual source, missing official domain, source identity conflict

**Discovery** (v2 canonical `find_product_page` / Find product page — owner-approved 2026-09-08):
The pipeline stage that finds the official product page URL on brand sites via web search.

**Extraction** (v2 canonical `collect_details` / Collect details — owner-approved 2026-09-08):
The pipeline stage that scrapes raw product details (titles, descriptions, images, prices) from confirmed URLs. **Source-dispatched (Amendment A + Amendment B):** official-page items keep the URL/profile/page-scrape path; `distributor_record` items bypass scraping entirely and are materialized **merchandising-depth** (identity fields plus description, features, category, dimensions, case pack, unit of measure, ingredients, and display-only image candidates) with a null URL, zero fetch/profile/OCR/model/image calls, and a dedicated `distributorRecordProvenance` (generation, evidence hash, sorted accepted attempt/provider ids, projection version, per-field merchandising provenance). Price, inventory, and commerce images stay absent. See `docs/runbooks/sourcing-engine-rollout.md`.

**Domain Extractor Profile**:
A reviewed extraction contract for one product-page structure on a domain that identifies the structures trusted during Extraction.
_Avoid_: Crawlee profile, generic scraper, selector cache

**Profile Scope**:
The subset of a domain's product pages that a Domain Extractor Profile covers, described by both an operator-visible URL pattern and a page-structure signal.
_Avoid_: Whole-domain assumption, URL-only rule

**Page Structure Signal**:
A stable product-page structure observation used to confirm that a Domain Extractor Profile still applies to a source URL.
_Avoid_: Visual design, exact DOM snapshot, URL pattern

**Profile Match**:
The single healthy Domain Extractor Profile selected for a source URL before automated Extraction begins.
_Avoid_: First profile, silent fallback, ambiguous match

**Source-Page Variant**:
An option state on a source product page that must be selected to extract evidence for one imported Product SKU.
_Avoid_: Product family, variant group, inherited product data

**Variant Selection Strategy**:
A reviewed deterministic method for selecting the Source-Page Variant that corresponds to one imported Product SKU.
_Avoid_: LLM guess, visual hunch, best-effort variant

**Variant Resolution (Issue #90)**:
Deterministic pre-extraction capability that parses Shopify/JSON-LD/Woo/BigCommerce/Magento variant matrices already in fetched HTML or one same-origin Shopify `GET /products/<handle>.js` via injected `safeProfileFetch` (ADR 0031 additive-only), normalizes to `NormalizedVariantCandidate` (parser version, canonical parent/identity hash), matches by precedence `unique GTIN → trusted SKU/MPN → complete exact option tuple → threshold+margin ranked` (duplicate GTIN never alone, exact axis-mapped options, substring prohibited), synthesizes `?variant=` deep links per candidate, persists `onboarding_variant_resolutions` (`resolved|ambiguous|no_match|unsupported|too_many_variants|selected|stale`, server-derived `identityMatrixHash` stale check), gates Extraction on `selectedVariantLinkage` (ambiguous writes no extraction, projects `attentionReason/action=choose_variant`), and surfaces a **Choose Variant** operator decision (server derives deep link/payload, idempotent `select-variant` with `{resolutionId,identityMatrixHash,variantKey}`) before re-queueing Extraction; flags deprecated/ignored — resolution always `active` (variant matrices always parsed, `?variant=` deep links always synthesized, `choose_variant` always gated) and interaction default-off unless test override enables exact per-axis click/select with post-action verification per `docs/plans/issue-90-implementation-plan.md` and `docs/runbooks/variant-resolution-rollout.md` (env-based rollback now via revert, not env).
_Avoid_: LLM variant guess, client-trusted URL/payload, default-on browser interaction

**Profile Health**:
The reviewed readiness of a Domain Extractor Profile, including product identity, description, image, and relevant variant evidence, to support automated Extraction for a domain.
_Avoid_: Profile exists, latest generation status, domain uptime

**Profile Revalidation Requirement**:
The review state created when a Domain Extractor Profile may no longer match its covered page structure.
_Avoid_: Immediate profile deletion, transient page failure, silent profile decay

**Fail-Closed Extraction**:
The rule that automated Extraction stops for a product page when its domain lacks a healthy Domain Extractor Profile.
_Avoid_: Generic fallback extraction, best-effort scraping

**Profile-Blocked Item**:
An Onboarding Item stopped in Extraction because no healthy Domain Extractor Profile produced a Profile Match.
_Avoid_: Failed product, auto-retry candidate, skipped item

**Profile Retry Preview**:
A summary of Profile-Blocked Items that could be retried after a relevant Domain Extractor Profile becomes healthy.
_Avoid_: Automatic rerun, hidden queue, batch advancement

**Profile Tooling Extraction**:
Exploratory page extraction used to build, validate, preview, or diagnose Domain Extractor Profiles without producing trusted product evidence.
_Avoid_: Trusted extraction, curation input, product evidence

**Profile Builder**:
A proposal-only workflow that helps create or revise Domain Extractor Profiles.
_Avoid_: Auto-profile creator, trusted extractor, profile autopilot

**Profile Builder Workspace**:
A domain-first review surface for building, validating, and approving Domain Extractor Profile proposals.
_Avoid_: Review drawer, product drawer, inline extraction result

**Profile Validation Sample**:
A product page used to test whether a Domain Extractor Profile extracts the expected product evidence within its Profile Scope.
_Avoid_: Training data, random URL, product approval

**Confirmed Profile Sample**:
A Profile Validation Sample whose source URL has been reviewed as the correct product page for its product.
_Avoid_: Sitemap guess, search result, unreviewed candidate

**Curation** (v2 canonical `prepare_listing` / Prepare listing — owner-approved 2026-09-08):
The pipeline stage that synthesizes final clean store-ready titles (integrating spreadsheet hints, web scraped details, and local packaging OCR) and classifies products into internal product types and existing category pages.

**Review** (v2 canonical `review_listings` / Review listings — owner-approved 2026-09-08):
The pipeline stage that surfaces curated drafts in a review drawer for user approval. Items in this stage can be approved individually.

**Promotion** (v2 canonical `create_drafts` / Create drafts — owner-approved 2026-09-08):
The pipeline stage that creates CMS product drafts and links them to page directories. Items in this stage remain visible in the Promotion column. When all items in a batch reach Promotion (or are skipped/failed), the batch auto-archives.

**Batch Archival**:
When all items in a batch have reached Promotion or been skipped/failed, the batch is automatically archived and disappears from the active Pipeline Board. Archived batches remain accessible via the batch list.
_Avoid_: Batch completion, batch cleanup

**Advancement Trigger**:
A user action that selects one or more items in a given stage and advances them to the next stage. This queues the items for worker processing if the target stage is automated.
_Avoid_: Batch promotion, auto-transition

**Pipeline Board**:
A Kanban-style UI showing columns for each Pipeline Stage. Items appear as cards within their current stage column. Each column has an advance button to move selected items to the next stage. The board renders one Onboarding Batch at a time. Clicking any card opens a review drawer — read-only inspection in automated stages, full approve/reject controls in the Review stage.
_Avoid_: Table view, item list, batch detail view

## Relationships

- The **Pipeline Board** renders four automated stage columns (**Discovery**, **Extraction**, **Curation**) and two manual columns (**Review**, **Promotion**).
- **Extraction** requires a healthy **Domain Extractor Profile** for the source URL's domain — for **official_page** sources. **Distributor-record sources are profile-free**: `distributor_record_to_extraction` items materialize merchandising-depth structured data (null URL, Amendment B) and never require a profile or URL.
- A domain may have multiple **Domain Extractor Profiles** when its product pages use different structures.
- Each **Domain Extractor Profile** has one **Profile Scope**.
- A **Profile Scope** includes both an operator-visible URL pattern and a **Page Structure Signal**.
- A source URL must resolve to exactly one **Profile Match** before automated **Extraction** can produce trusted product evidence.
- A **Profile Match** requires both the source URL and the source page's **Page Structure Signal** to fit the **Profile Scope**.
- The most specific healthy **Profile Scope** determines the **Profile Match**.
- Ambiguous matching **Profile Scopes** prevent a **Profile Match** until a reviewer resolves the ambiguity.
- A default **Domain Extractor Profile** may produce a **Profile Match** only when it is explicitly scoped as the domain default and healthy.
- When a source URL fits a **Profile Scope** URL pattern but its **Page Structure Signal** no longer fits, **Fail-Closed Extraction** stops that item.
- A **Page Structure Signal** mismatch creates a **Profile Revalidation Requirement** for the relevant **Domain Extractor Profile**.
- A single **Page Structure Signal** mismatch does not remove **Profile Health** without repeated mismatches or reviewer confirmation.
- **Profile Tooling Extraction** may run when automated **Extraction** would fail closed.
- **Profile Tooling Extraction** may support profile generation, validation, previews, and diagnostics.
- **Profile Tooling Extraction** cannot produce trusted product evidence or advance an item past **Extraction**.
- The **Profile Builder** produces Domain Extractor Profile proposals only.
- The **Profile Builder** cannot create **Profile Health** without validation and reviewer approval.
- A **Profile Builder Workspace** is organized around one domain, not one product item.
- An **Onboarding Item** may provide a seed **Profile Validation Sample** for a **Profile Builder Workspace**.
- A **Profile Builder Workspace** may use unreviewed sitemap product URLs as exploratory Profile Validation Samples.
- Only **Confirmed Profile Samples** count toward **Profile Health**.
- A normal **Domain Extractor Profile** requires at least two **Confirmed Profile Samples** within its **Profile Scope** before it can be healthy.
- A variant-bearing **Domain Extractor Profile** requires at least one **Confirmed Profile Sample** that demonstrates correct Source-Page Variant distinction before it can be healthy.
- A **Product SKU** may require selecting one **Source-Page Variant** during **Extraction**.
- A **Variant Selection Strategy** may use product-linked inputs such as expected name, UPC, SKU, spreadsheet hints, URL variant parameters, embedded source-page variant data, and visible selected option labels.
- A **Variant Selection Strategy** must fail closed when the correct **Source-Page Variant** is ambiguous.
- The **Profile Builder** may propose a **Variant Selection Strategy**, but automated **Extraction** executes it deterministically.
- **Source-Page Variant** selection does not create a product-family model or inherited product data.
- A **Profile Builder Workspace** is separate from the product review drawer.
- **Profile Health** belongs to the matched **Domain Extractor Profile**, not to the whole domain.
- **Profile Health** is determined from confirmed same-domain product samples within the **Profile Scope**.
- A healthy **Domain Extractor Profile** includes reviewed title, description, and image extraction coverage.
- Price extraction is not required for **Profile Health** when the imported product provides the trusted price.
- A **Domain Extractor Profile** for variant-bearing product pages requires reviewed evidence that the correct variant can be distinguished before it is healthy.
- Image extraction coverage requires reviewed image previews before **Profile Health** can allow automated **Extraction**.
- **Fail-Closed Extraction** may stop an item in **Extraction** without producing trusted product evidence.
- **Fail-Closed Extraction** may create a **Profile-Blocked Item**.
- A **Profile-Blocked Item** remains in **Extraction** until a reviewer chooses to retry it.
- When a relevant **Domain Extractor Profile** becomes healthy, affected **Profile-Blocked Items** appear in a **Profile Retry Preview** rather than automatically rerunning.
- A **Profile Retry Preview** supports selected retries; it does not advance a whole **Onboarding Batch**.
- An **Onboarding Batch** has derived progress (counts per stage) computed from its items, not a controlling status of its own.
- An **Onboarding Batch** contains one or more **Onboarding Items**.
- An **Onboarding Item** is in exactly one **Pipeline Stage** at any time.
- A **Pipeline Stage** has exactly one **Stage Status** per item.
- **Stage Advancement** moves items from one stage to the next in the linear order: **Discovery** → **Extraction** → **Curation** → **Review** → **Promotion**.
- An **Advancement Trigger** acts on items in any **Onboarding Batch** — batch membership does not gate advancement.

## Flagged ambiguities

- "Crawlee profile system" was used to mean both the extraction contract and the crawling runtime — resolved: use **Domain Extractor Profile** for the domain contract and reserve Crawlee for runtime implementation details.
- "healthy profile" could mean a profile row exists, a generation was promoted, or extraction recently succeeded — resolved: use **Profile Health** for reviewed readiness to support automated Extraction.
- "domain profile" could imply exactly one extraction profile per domain — resolved: a domain may have multiple **Domain Extractor Profiles**, each with its own **Profile Scope** and **Profile Health**.
- "default profile" could imply a silent fallback when no structure-specific profile matches — resolved: defaults must be explicit, healthy **Domain Extractor Profiles** and still produce a single **Profile Match**.
- "profile scope" could be treated as URL-only — resolved: **Profile Scope** combines an operator-visible URL pattern with a **Page Structure Signal**.
- A page-structure mismatch could be treated as immediate profile invalidation — resolved: it creates a **Profile Revalidation Requirement** and stops the item, while **Profile Health** changes only after repeated mismatches or reviewer confirmation.
- Generic extraction could be treated as trusted product evidence after fail-closed matching — resolved: use **Profile Tooling Extraction** only for profile building, validation, previews, and diagnostics.
- LLM-assisted profile building could be mistaken for automatic profile activation — resolved: the **Profile Builder** is proposal-only and cannot create **Profile Health** without validation and reviewer approval.
- Profile review could be buried inside the product drawer — resolved: use a separate **Profile Builder Workspace** for profile building, validation, and approval.
- Profile building could be treated as a one-off product fix — resolved: the **Profile Builder Workspace** is domain-first, and product items only provide seed samples.
- Sitemap product URLs could be treated as validation evidence by default — resolved: only **Confirmed Profile Samples** count toward **Profile Health**.
- New Profile Health could imply automatic reruns of every blocked item — resolved: show a **Profile Retry Preview** and let reviewers retry selected **Profile-Blocked Items**.
- "status" was used to mean both batch lifecycle and item-level stage — resolved: use **Pipeline Stage** + **Stage Status** for items, and derived progress for batches.
- "phase" was used interchangeably with "stage" — resolved: use **Pipeline Stage** exclusively.
- "batch" was used as a lifecycle controller — resolved: batches are grouping/import containers with no lifecycle control.
- "advance" was conflated with automated progression — resolved: happy-path progression is automation-owned (`sweepAutoAdvance` + `sweepDomainReleases`); manual advancement is reserved for explicit human decisions (approval, export, source-conflict resolution, URL/profile exception resolution).
- "review" was both a pipeline stage name and a UI drawer action — resolved: **Review** is the stage; the drawer is the **Review Drawer** within it.
- "category" was used to mean both **Category Page** placement and **Product Type** classification — resolved: these are distinct concepts.
- Customer-facing page names or hierarchy could be treated as direct product facts — resolved: they are **Page Context Evidence** and low-reliability.
- "new product type" can mean either a configured **Product Type** or a suggested **Unmapped Product Type** — resolved: classifiers may suggest but not create Product Types.
- **Product Type** could be confused with an exported ShopSite field — resolved: keep it local unless represented by a mapped **Product Attribute**.
- Unknown Primary Product Type could still lead to page assignment proposals — resolved: pause Category Page proposals until Primary Product Type is known.
- Product Type structure could depend on each store's merchandising preferences — resolved: capture manager preferences as **Catalog Manager Guidance** and Classification Configuration rather than assuming one universal hierarchy.
- Product Type-specific attribute grouping could be mistaken for classification behavior — resolved: use **Attribute Group Layout** only for manager-facing display.
- Manager instructions could become unbounded prompts — resolved: prefer **Structured Catalog Manager Guidance** and limit **Free-Form Catalog Manager Guidance** with Classification Safety Rules.
- Manager guidance can make review stricter but not looser — resolved: use **Manual Review Requirements** to require individual review without weakening safety rules.
- Free-form guidance could be mixed with product evidence or safety rules — resolved: maintain **Guidance Boundaries** for Model-Backed Classification Stages.
- Scraped pages or spreadsheet cells could contain instruction-like text — resolved: treat product evidence as **Untrusted Product Evidence** that can supply facts but not instructions.
- Raw product text could overwhelm or steer model-backed proposal stages — resolved: prefer **Structured Product Evidence** produced by an **Evidence Extraction Stage**.
- Manager guidance could be treated as mutable prompt text — resolved: guidance edits are reviewed **Configuration Changes** and included in the **Classification Configuration Snapshot**.
- Free-form guidance could invisibly change rule-based behavior — resolved: it informs **Model-Backed Classification Stages**, while **Deterministic Classification Stages** use structured guidance.
- Model selection could be assumed to be workspace-wide only — resolved: use advanced/admin **Stage Model Policies** with workspace defaults and optional stage overrides.
- Everyday managers could be exposed to raw provider/model details — resolved: offer **Classification Model Presets** that map to admin-controlled Stage Model Policies.
- Model/provider outages could silently switch execution environments — resolved: use explicit **Stage Model Fallbacks**, and never fall back from local-only to cloud unless configured.
- Cloud-backed stages could receive too much store data — resolved: enforce **Model Data Sharing Policies** and never send **Sensitive Store Data**.
- Image sharing could be treated the same as text sharing — resolved: use a stricter **Image Data Sharing Policy** and keep raw product images local unless explicitly enabled.
- Overlapping manager guidance could be silently merged — resolved: use **Guidance Precedence**, with safety rules first and the narrowest applicable scope winning.
- Deterministically resolved guidance conflicts could still surprise managers — resolved: surface them as **Guidance Override Warnings** rather than blocking configuration review.
- Products could appear to have multiple types — resolved: use at most one **Primary Product Type** for classification and use Category Pages or Product Attributes for secondary merchandising facets.
- Product review could force a Product Type when evidence is ambiguous — resolved: allow **Unknown Primary Product Type** and pause type-gated proposals including Category Page proposals without blocking product draft creation.
- Correcting Primary Product Type could look like a special decision type — resolved: treat it as a **Proposal Decision Revision** that triggers a Classification Refresh for dependent stages while preserving prior decisions.
- Product families or variants could imply inherited classification — resolved: classify each **Product SKU** independently until the domain has an explicit product-family concept.
- "variant data" could mean full family modeling or source-page option selection — resolved: use **Source-Page Variant** only for selecting the correct source-page option state for one imported **Product SKU**.
- Variant selection could rely on LLM guessing during automated Extraction — resolved: use a reviewed deterministic **Variant Selection Strategy** and fail closed on ambiguity.
- SKU could be confused with the stable local product identity — resolved: use **Product SKU** for the store-facing onboarding key and **Product Identity** after product draft creation.
- "field" was used to mean store-specific merchandising facts — resolved: call these **Product Attributes** in the domain language.
- Attribute grouping could be mistaken for classification semantics — resolved: use **Attribute Groups** only for manager-facing organization and duplicate-label context.
- Product Attribute applicability could be hidden in free-form guidance — resolved: express it as structured **Attribute Applicability Conditions** in Attribute Profiles.
- Unreviewed proposals could make irrelevant attributes appear required — resolved: use them only for **Applicability Previews** until values are accepted or reviewed.
- Required attributes could be interpreted as every attribute in a Product Type profile — resolved: required-field validation only applies when **Attribute Applicability Conditions** are satisfied.
- Non-applicable attributes could clutter product review — resolved: treat them as **Non-Applicable Product Attributes** that are hidden from the main review but available for configuration debugging.
- Manual review could silently override applicability rules — resolved: record an **Applicability Override** for the product and offer a Configuration Suggestion if the profile may be wrong.
- Applicability Overrides could be applied too broadly — resolved: keep them per-product and route broad corrections through Configuration Review or Product Type correction.
- Product marketing claims could be treated as creative inference — resolved: call them **Product Claims** and require **Direct Claim Evidence**.
- Free-from or allergen claims could be inferred from absence — resolved: call these **Absence-Based Claims** and do not propose them.
- Ingredients and nutrients could be treated as generic merchandisable fields — resolved: call them **Product Composition Attributes** and require strict evidence and provenance.
- Store-specific field maps were being treated as the classification model — resolved: keep **Product Attributes** separate from **Catalog Fields** through **Attribute Mappings**.
- A desired **Product Attribute** may lack a live field target — resolved: call it an **Unmapped Product Attribute** and do not write it as a final assignment.
- "Catalog Field" was considered for manual creation — resolved: **Catalog Fields** must match fields present in the live ShopSite XML pull.
- Live ShopSite XML changes may make mappings unsafe — resolved: call these **Stale Attribute Mappings** and block final Field Assignments that depend on them.
- "attribute value" can mean a controlled choice, free text, a structured measurement, a canonical unit, a synonym, or a plausible value outside the controlled list — resolved: model this distinction as **Attribute Value Mode**, **Measured Attribute Value**, **Canonical Measurement Unit**, **Attribute Value Alias**, **Ambiguous Attribute Value Alias**, and **Unmapped Attribute Value**.
- "classification" was used to imply both suggested and final values — resolved: call AI-generated suggestions **Classification Proposals** until reviewed.
- Automatic classification could imply all Product Type and Product Attribute proposals always run — resolved: **Baseline Classification** runs automatically, while **Configured Classification** requires active Classification Configuration.
- Configuration Suggestions could be handled as inline product decisions — resolved: route them through **Configuration Review** because they affect workspace behavior.
- Applying Configuration Review could leave affected product proposals stale — resolved: queue visible **Configuration-Driven Classification Refreshes** for affected products.
- Configuration-driven refreshes could wastefully rerun everything or silently rerun too little — resolved: use **Refresh Scope** to rerun known affected stages and fall back to a full run when impact is unclear.
- Configuration-driven refreshes could surprise managers with downstream product work — resolved: show a **Refresh Preview** before queuing affected refreshes.
- Refresh previews could imply managers can create dependency-invalid partial reruns — resolved: allow **Refresh Deferrals** for products, not arbitrary required-stage removal.
- Bulk review could be confused with auto-approval — resolved: call it **Bulk Proposal Acceptance** and limit it to safe, unambiguous proposals.
- Batch-wide bulk review could apply too many wrong decisions at once — resolved: call it **Batch Bulk Proposal Acceptance** and require a preview summary.
- Reversing a proposal decision could imply deleting history — resolved: use **Proposal Decision Revisions** and preserve earlier decisions.
- Accepted proposals could be confused with persisted product fields — resolved: show them as a **Product Draft Projection** until product draft creation.
- Active configuration changes could silently reinterpret accepted proposals — resolved: call this **Configuration Snapshot Drift** and require review before product draft creation.
- Skipped accepted proposals could be confused with product draft failure — resolved: call them **Skipped Draft Assignments** and continue product draft creation.
- Accepted page assignments could be applied after page deletion or ambiguity — resolved: call these **Unavailable Category Page Assignments** and skip them during product draft creation.
- Page assignments stored as display names could become ambiguous after sync — resolved: validate assignments with **Category Page Identity**, not page name alone.
- Assigning products across multiple page hierarchy levels could clutter broad pages — resolved: use Product Type-specific **Category Page Assignment Scope** with a workspace default fallback.
- AI-backed classification could be non-repeatable — resolved: treat each attempt as a reproducible **Classification Run** tied to a **Classification Configuration Snapshot**.
- Re-running classification could silently overwrite review decisions — resolved: call it a **Classification Refresh** and preserve prior **Proposal Decisions** in **Classification History**.
- Conflicting evidence could imply a silent winner — resolved: call this an **Evidence Conflict** and require review rather than silent preselection.
- Retailer or distributor pages could be treated like official sources — resolved: call this **Third-Party Evidence** and restrict it for claims and composition attributes unless configured.
- Classification setup edits could be confused with instant settings — resolved: durable setup changes are reviewed **Configuration Changes**.
- Incomplete classification setup could be confused with a product-level blocker — resolved: call it a **Configuration Gap** and block only affected Field Assignments.
- Final product values do not explain why classification happened — resolved: preserve the **Classification History** separately from final values.
- Source pages, images, or import files can change after review — resolved: retain bounded **Evidence Snapshots** rather than huge raw pages or full images by default.
- Evidence snapshots may need storage or privacy limits — resolved: control them with an **Evidence Retention Policy**, defaulting to retention unless configured otherwise and allowing type-specific overrides.
- **Classification History** could be confused with canonical catalog or ShopSite product data — resolved: it is local CMS operational/audit state only and is not exported to ShopSite.
- "VLM classification" was used to imply the vision model decides final values — resolved: visual models produce **Visual Product Evidence** as an **Evidence Extraction Stage**, while proposals remain reviewable.
- Visual observations could be applied to every attribute — resolved: each Product Attribute controls this with **Visual Evidence Eligibility**.
- "classifier" was used broadly enough to hide multiple responsibilities — resolved: classification is composed of focused **Classification Stages** rather than one all-in-one prompt.
- A failed Classification Stage could be confused with a failed product or run — resolved: call it a **Stage Failure** and preserve successful stage outputs.
- Stage ordering could be hidden in code — resolved: express ordering and required inputs as **Stage Dependencies**.
- Generative models could be used where rules already answer the question — resolved: run **Deterministic Classification Stages** first.
- Low-confidence classifiers could be forced to guess — resolved: use **Stage Abstention** and record the reason instead.
- Abstentions could clutter review — resolved: surface only important missing proposals as **Reviewable Abstentions**.

## Catalog Product Classification

Catalog Product Classification extends the classification pipeline to existing ShopSite products (not just onboarding pipeline items).

### Key Concepts

**Catalog Classification Run**: A classification run executed against an existing catalog product, identified by `source_kind = 'catalog_product'` and `onboarding_item_id IS NULL`.

**Source Kind**: Discriminates classification runs by their trigger: `onboarding` (from pipeline) or `catalog_product` (from product detail).

**Source Product Hash**: A deterministic SHA-256 hash of the classification-relevant product fields (name, description, weight, customFields, media) used for drift detection at apply time.

### Architecture

**Evidence Extraction**: The catalog adapter (`catalog-product-source.ts`) maps Product fields into a `NormalizedEvidenceInput` and feeds it to the shared evidence extractor (`product-evidence-extractor.ts`). This avoids dependency on the `onboarding_items` table.

**Stage Set**: Catalog runs omit `name_consolidation` (must not rename existing products). The remaining 6 stages run: evidence_extraction, primary_product_type, attribute_applicability, product_attribute_proposals, category_page_proposals, product_draft_projection.

**Draft-Only Application**: Accepted field and page proposals are applied by creating an **update change-set draft**, never by direct write. Source hash and config hash are verified at apply time to prevent clobbering concurrent edits.

### Terms

**Catalog Classification Run**: A `classification_runs` row with `source_kind = 'catalog_product'` and `onboarding_item_id IS NULL`.

**Catalog Evidence Source**: The `'catalog_product'` value in the `classification_evidence.source` CHECK constraint, indicating evidence derived directly from catalog product data.

**Primary Product Type (Catalog)**: Remains local to classification operational state — never written to ShopSite or the canonical product.

**Existing Page Context**: A catalog product's current `product_pages` assignments are surfaced as `'page_context'` evidence during classification so page proposals can be additive only (classification never removes existing assignments).

### Constraints

- At most one running catalog classification run per product SKU per workspace.
- Applying accepted proposals always creates a change-set draft; never a direct write.
- Older catalog-run proposals are marked stale (`stale` status) when a newer run completes.
- Catalog runs cannot rename products or write Primary Product Type to ShopSite.
- Refresh queue defers catalog classification to the Product Detail Rerun action; auto-refresh for catalog products is deferred to a future release.

## Operational state (2026-08-09, issue #17 D2/C2)

- **Active Classification Configuration**: the Bay State workspace's v2 bundle is
  activated through the config store (CAS, catalog-evidence verifier, verified
  Page IDs): bundle `b5ca076f…`, catalog evidence `3b276fed…`, nested catalog
  commit `024c6412` (scope `store/classification/**` only). The `store-pages`
  Category Page target is **enabled** (`optionSource: live_store`) against the
  active verified Page import `96d018cb` (211 `exported_guid` records, source
  hash `20d94f68…`). Model policy: Ollama/local-only; all ML features disabled.
- **Category Page Identity**: a Category Page assignment is validated against
  the verified Page snapshot (`captureVerifiedPageSnapshot` — one coherent
  transactional read of the active import + verified `page_index` rows);
  assignments reference page IDs, never display names, and page proposals
  abstain until a reviewed Primary Product Type exists.
- **Integrity**: the C2 live repair (2026-08-09) removed orphaned classification
  data (637 stage results, 2003 evidence, 191 proposals, 42 decisions, 180
  onboarding sources, 50 extractions, 1 profile revision, 22 dangling embedded
  proposals) in one transaction against a verified backup; post-audit clean.
- **Controlled Value Identity**: a controlled value ID is exactly its stored
  canonical string (NFC-normalized, trimmed); label equals ID by v2 policy.
  `src/classification/controlled-value-identity.ts` centralizes comparison
  keys, canonical validation (rejecting empty/control characters, non-NFC/
  non-trimmed values, duplicates, normalized/case-fold collision pairs, and
  aliases whose `mapsTo` is not an exact allowed ID), alias→exact-ID
  resolution, and `{value: id, label: id}` options (ADR-0012).
- **Built-in Output Policy**: `src/shopsite/built-in-output-policy.ts` is the
  immutable adapter-owned policy for built-in ShopSite output fields (Name,
  FileName, Price, SaleAmount, ProductDescription, MinimumQuantity,
  ProductType, Weight, Graphic, SearchKeywords, MoreInfoImage1–20); DTD-level
  behavior is not workspace-configurable (ADR-0011). Custom `ProductField*`
  values remain classification-managed via Catalog Field Serialization.

## Store Manager Operating Model (epic #46)

The operator-facing onboarding model adopted by ADR 0016. Automation owns progression; the Store Manager owns exceptions, final verification, and release decisions. The six internal Pipeline Stages remain the execution/diagnostics truth; this section governs how they are presented and operated.

**Batch Workspace**:
The primary Store Manager view for onboarding, replacing the Pipeline Board Kanban as the default operating model. Organized by operator meaning (Processing, Needs Attention, Waiting on Family, Ready for Review, Approved / Ready to Export) rather than by raw pipeline stage. Every product has exactly one current operator work-state, and Needs Attention is the most prominent queue while automation is active. The Pipeline Board remains available for diagnostics.
_Avoid_: Six-column Kanban as the primary operating surface, stage-by-stage interpretation

**Operator Work-State**:
The server-derived, human-facing projection of an onboarding item's state, owned by the server (never reverse-engineered by the client from `stage`, `stage_status`, error strings, source metadata, cohort state, or feature flags). Shape: `category` ∈ `processing | needs_attention | waiting_on_family | ready_for_review | approved | ready_to_export | completed | skipped`; optional `activity` ∈ `distributor_lookup | official_site_search | official_url_verification | extraction | curation | review | approval | export`; human `label`/`detail`; `attentionReason`/`attentionAction` (e.g. `verify_official_url`, `choose_official_url`, `setup_extractor_profile`, `retry_extraction`, `resolve_source_conflict`, `retry_processing`); optional `family` readiness `{ cohortId, label, memberCount, readyCount, blockedCount, waitingOnItemIds }`; `reviewState` ∈ `not_ready | unreviewed | reviewed | approved`. Example: `discovery/needs_input` + ambiguous candidates projects to Needs Attention / "Verify official product page"; `extraction/in_progress` projects to Processing / "Extracting product data"; `curation/pending` + cohort waiting on 2 siblings projects to Waiting on Family / "3 of 5 products ready".
_Avoid_: Client-side stage-status inference, raw error strings in operator UI, provider/query identifiers

**Automation-Owned Progression**:
The rule that an item satisfying the exit contract for the current automated activity with no human gate advances automatically. Manual advancement is reserved for explicit human decisions (URL/profile exception resolution, source-conflict resolution, approval, export) — never routine pipeline progression. This supersedes the "Advancement is always manual" wording of the Stage Advancement entry above for the operator-facing model; every automatic transition remains auditable, retries are idempotent, and automation fails closed into an actionable Needs Attention state when judgment is required.
_Avoid_: Click-to-advance happy paths, operator shepherding of machine stages

**Distributor Lookup**:
The human-facing name for the Sourcing stage. Distributor sources are checked first (ADR 0014 + Amendments A/B); a qualified distributor record is a complete product source that SKIPS Discovery (`distributor_record_to_extraction`, `source_type='distributor_record'`, null URL) and proceeds to the family barrier without operator review. Insufficient distributor data falls back to Official Site Search automatically. Source conflicts surface as Needs Attention only when human judgment is required. The UI identifies whether final listing evidence came from distributor records, official page extraction, or a supported combination.
_Avoid_: "Sourcing" as operator terminology, treating distributor records as a preliminary phase

**Official Site Resolution**:
The human-facing name for the combined URL-verification + extractor-profile operator workflow (Discovery + Extraction exception handling as one continuous task): confirm the correct product/variant page → if the domain has a usable extractor profile, resume automatic extraction; otherwise set up/fix the profile, which automatically retries affected domain items where safe. A confirmed URL is persisted before extraction resumes; a bad candidate URL can be replaced.
_Avoid_: Mentally switching between "Discovery" and "Extraction" as unrelated stages

**Family Readiness Barrier**:
The Curation gate: a product family (ADR 0013 durable candidate cohort) waits until every active member is Extraction-ready. There is no default partial-family Curation ("curate the available 3 of 4"). Ready cohorts may run automatically under the cohort Curation worker path (feature-flagged). Waiting vs blocked members are distinguished; blocking siblings link directly to their Needs Attention task.
_Avoid_: Per-SKU Curation as the default operator model, manual "curate now" partial-family actions

**Durable Review State**:
Explicit, independently recorded review/approval state distinct from pipeline stage: Curation-complete alone does not make a product reviewed. States: `not_ready` (Curation incomplete), `unreviewed` (Curation complete, not yet inspected), `reviewed` (human final inspection recorded), `approved` (bulk release decision recorded). Review covers every product; unreviewed products cannot be bulk-approved; editing a reviewed product invalidates review when the edited field affects approved output.
_Avoid_: Inferring "reviewed" from `stage='review'` / `stage_status='completed'` alone

**Bulk Approval**:
The deliberate release decision applied to the reviewed selection (approve-all-reviewed or selected reviewed items) with per-item validation (reviewed state + semantic/promotion gates), exact success/failure counts, visible retryable partial failures, and actor/time audit. Approval never implies export or publication.
_Avoid_: Risk-based auto-approval, approving unreviewed products, conflating approval with export

**Ready to Export**:
The operator output/release area that demotes Promotion from a peer machine stage: approved products appear here with accurate pending/exporting/exported/failed states and retry for failures. Language matches the actual side effect (e.g. ShopSite draft creation); a product is never called `published` or `exported` until the underlying operation has succeeded and been verified. Approval and export are separate decisions.
_Avoid_: Labeling approved items as published/exported, "Promotion" as a primary operator stage

### Terminology mapping (internal → human-facing)

| Internal stage | Human-facing term |
| --- | --- |
| Sourcing | Distributor Lookup |
| Discovery | Official Site Search / Verify Product Page |
| Extraction | Extracting Product Data |
| Curation | Curating Product Family |
| Review | Review |
| Promotion | Approved / Ready to Export / Exporting |

## Packaging OCR (2026-08-24 overhaul)

Packaging OCR extracts structured fields (productName, brand, UPC, size, species, …)
from a product's primary package image to ground curation titles and evidence.

- **Entry point:** `runPackagingOcrAttempt` in `src/onboarding/packaging-ocr.ts` —
  returns `{ ok: true, data } | { ok: false, reasonCode, … }`. Every failure carries a
  coded reason from `OcrFailureReasonEnum` (`src/shared/schemas/onboarding.ts`); nothing
  fails silently. `extractPackagingOcr` remains as a thin null-returning adapter.
- **Reliability:** circuit breaker (`src/onboarding/vlm-circuit-breaker.ts`, transient
  failures only), bounded flag-gated retry (`BAYSTATE_CMS_OCR_RETRIES_ENABLED`), per-attempt
  timeout (`BAYSTATE_CMS_OCR_TIMEOUT_MS`). Greedy `temperature=0` default; repetition-tail
  detection triggers one `frequency_penalty≈0.3` retry with fallback to the original response.
- **Model selection is data-driven:** all defaults live in `src/shared/vision-model-defaults.ts`
  (`DEFAULT_LOCAL_VISION_MODEL = 'qwen2.5vl:latest'`). Never hardcode model literals.
- **Stage path (flag-gated):** the `packaging_ocr` classification stage
  (`src/classification/stages/packaging-ocr-stage.ts`) runs behind
  `BAYSTATE_CMS_PACKAGING_OCR_STAGE_ENABLED` (default OFF = legacy behavior). Shadow mode
  (default ON) never writes live keys. Distributor-record items are URL-null and skip OCR
  by design (Amendment B — images are display-only).
- **Evaluation:** golden-set harness in `src/onboarding/ocr-eval/` + `scripts/ocr-eval.ts`.
  Model flips require the pre-registered gate in
  `docs/runbooks/packaging-ocr-model-rollout.md`; flip = one-constant commit.
- **Plan:** `docs/plans/packaging-ocr-overhaul-plan.md`.

## Naming footnote: `product_intelligence_assets` (ADR 0030)

The `product_intelligence_assets` table and `pi_reuse_policies` table keep their historical names even though the Agent Lab program was decommissioned: both are live-written onboarding infrastructure (distributor imagery verification + image reuse grants) whose homes moved to `src/onboarding/image-verification/`, `src/db/repositories/onboarding-pi-asset-repo.ts`, and `src/db/repositories/image-reuse-policy-repo.ts`. The names are retained for row-history continuity, not because an agent program exists.
