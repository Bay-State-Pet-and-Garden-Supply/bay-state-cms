# Bay State CMS

Bay State CMS manages store product data as local product drafts that can be reviewed, approved, and published to a ShopSite store.

The classification vocabulary records the confirmed domain contract in [ADR 0041](docs/adr/0041-single-product-classification-contract.md); its runtime migration is not implemented by this documentation update.

## Language

**Category Page**:
An existing customer-facing store page that a product can be assigned to for browsing.
_Avoid_: Category, taxonomy page, page category

**Taxonomy Category Page**:
An existing Category Page grouping products by Product Classification or permitted Classification Attributes, rather than Brand identity.
_Avoid_: Brand Page, Category field, invented page

**Brand Page**:
A store browsing page grouping products by established Brand identity, outside the Classification Engine's assignment and removal scope.
_Avoid_: Taxonomy Category Page, classifier-inferred Brand

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

**Category**:
A store-configured customer-facing classification group, distinct from a Category Page. Together with Product Type it forms a Product Classification.
_Avoid_: Category Page, inferred page hierarchy

**Product Type**:
The store-facing kind of product, such as Food or Toys, used with Category to form a Product Classification.
_Avoid_: Internal Product Type, Primary Product Type, template, delivery mode

**Product Classification**:
The single canonical Category and Product Type combination for a Product SKU. Its configured Attribute Profile determines the relevant Classification Attributes; there is no separately inferred internal type.
_Avoid_: Parallel website/internal types, hidden type, duplicate type decision

**Classification Engine**:
The product-level capability that proposes Product Classifications, permitted Classification Attributes, and Taxonomy Category Page changes from the SKU's supplied evidence.
_Avoid_: Listing generator, identity resolver, source-discovery engine

**Brand**:
A supplied product identity fact that is optional context for classification, never a classifier-owned assignment or removal.
_Avoid_: Classification Attribute, inferred classifier output

**Protected Product Data**:
Product information outside classifier ownership, including Brand, other identity information, listing content, pricing, inventory, and operational status.
_Avoid_: Arbitrary classification target, generic field enrichment

**Grooming**:
The Product Type for pet skin and coat care, including medicated shampoos, lotions, and anti-itch sprays. Products explicitly intended for flea or tick control belong to Flea & Tick Treatment.

**Insect & Pest Control**:
The Product Type for insect and pest control products, including mosquito repellents, electronic or heated repellent devices, and their dedicated repellent consumables.

**Unresolved Product Classification**:
A Product Classification whose Category or Product Type is missing, conflicting, or unsupported by the supplied evidence or approved configuration.
_Avoid_: Forced type, successful classification, guessed fallback

**Classification Readiness**:
Classification Readiness is achieved when a reviewed Product Classification has approved storefront values, its Attribute Profile is resolved, and every applicable required Classification Attribute has a current valid reviewed value. Optional unvalued or confirmed non-applicable attributes do not block; unresolved profile authority or unknown applicability for a required attribute keeps the product in Review and blocks draft creation.
_Avoid_: Run completed, model confidence, hidden internal-type gate

**Assistant**:
A bounded, schema-validated capability that proposes constrained outputs or explicitly abstains.
_Avoid_: Agent, specialist, autonomous catalog writer

**Catalog Adjudication Assistant**:
A bounded Assistant that proposes configured Product Classifications, Classification Attributes, and verified Taxonomy Category Page changes for a Product SKU.
_Avoid_: Independent type classifier, automatic classification authority

**Assistant Authority Gate**:
A qualification condition for permitted Assistant automation outside classification review; it never replaces a Proposal Decision for a Classification Proposal.
_Avoid_: Classification review bypass, confidence auto-approval

**Coded Abstention**:
An explicit unresolved result with a reason, not a successful assignment or a forced guess.
_Avoid_: Silent skip, forced value, successful assignment

**Product SKU**:
A store-facing product identifier used as the onboarding key.
_Avoid_: Product identity, product family, variant group

**Product Identity**:
The stable local CMS identity for a product after it becomes a product draft or approved product.
_Avoid_: SKU, onboarding row

**Product Family**:
A customer-facing group of variants of the same underlying product under a Family Variant Rule. Members may span onboarding batches and the existing approved catalog; an internal Curation Cohort does not establish membership.
_Avoid_: Brand-wide product line, Curation Cohort, source-page option state

**Family Variant Rule**:
A product-type-specific definition of which differences are permitted within a Product Family. Food families preserve brand, recipe, flavor, species, life stage, and form while package size may differ; other variation axes require an explicit rule.
_Avoid_: Name-stem similarity, universal size/color rule

**Subproduct**:
A product associated with a main product for joint storefront display, including a package-size member of a Product Family.
_Avoid_: SKU suffix, ordering option, family identity

**Main Product**:
The product through which a Product Family is presented. An existing Main Product is preserved; a new family's Main Product is one of its real, purchasable member SKUs.
_Avoid_: Automatically created display-only parent, synthetic UPC

**Short Name**:
A concise customer-facing label for a Subproduct, separate from its full product name and Product SKU. In a size-only Product Family, the Short Name identifies the member's package size.
_Avoid_: Product name, SKU, family name

**Curation Cohort**:
An internal group of Onboarding Items considered together to share curation context or computation. Membership establishes neither a storefront **Product Family** nor a requirement for otherwise independent items to advance together.
_Avoid_: Product Family, published variant relationship

**Item Readiness**:
The determination that one **Onboarding Item** satisfies the evidence, listing-completeness, review, and other requirements for its next stage. Readiness is independent of unrelated items and shared computation; genuinely linked multi-product changes retain their consistency requirements.
_Avoid_: Cohort completion, batch readiness, family membership

**Unmapped Product Type**:
A plausible Product Type that is not yet configured for the store.
_Avoid_: New category, auto-created type

**Product Attribute**:
A store-configured merchandisable fact about a product, such as flavor, color, size, material, or life stage.
_Avoid_: Field, custom field, classifier result

**Classification Attribute**:
A Product Attribute explicitly permitted as a classifier output by Classification Configuration. Brand and other Protected Product Data remain excluded even when represented by mapped product fields.
_Avoid_: Every Catalog Field, identity enrichment, arbitrary product field

**Attribute Group**:
An optional manager-facing grouping for Product Attributes.
_Avoid_: Product Type, classification rule, inheritance

**Attribute Group Layout**:
A Product Classification-specific display ordering or override for Attribute Groups.
_Avoid_: Classification rule, attribute applicability

**Unmapped Product Attribute**:
A Product Attribute without a live Catalog Field target.
_Avoid_: Planned field, final assignment

**Universal Classification Attribute**:
A permitted Classification Attribute whose applicability does not depend on a resolved Product Classification, while configured requiredness and applicability rules still apply.
_Avoid_: Global field, common metadata, universally writable product data

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
The configured set of Classification Attributes and their rules for a Product Classification; a profile may be shared by multiple classifications.
_Avoid_: Field set, schema, template

**Attribute Constraint**:
A Product Classification-specific limit on how a Classification Attribute may be assigned.
_Avoid_: Validation rule, configuration option

**Attribute Applicability Condition**:
A deterministic Attribute Profile rule that decides whether a Classification Attribute applies to a product.
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
Whether a Classification Attribute accepts one value or multiple values for a Product Classification.
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
An Attribute Value Alias that could map to different values in different Product Classifications or contexts.
_Avoid_: Bad alias, automatic match

**Canonical Controlled Value**:
A controlled Product Attribute value whose stored string IS its identity: NFC-normalized and trimmed, with label equal to the ID (v2 policy). Config validation rejects empty/control-character/non-NFC/non-trimmed values, exact duplicates, normalized/case-fold collision pairs, and aliases whose target is not an exact allowed value. Evidence-text matching is case-tolerant, but the emitted value is always the exact canonical ID — the runtime never guesses an ID from a display label. See `src/classification/controlled-value-identity.ts` and ADR 0012.
_Avoid_: Display string as ID, case-variant values, silent rewrite

**ShopSite Delivery Mode**:
The ShopSite product's fulfillment form, such as Tangible or Download, unrelated to its Product Classification.
_Avoid_: Product Type classification, merchandising type

**ShopSite Built-in Output Field**:
A native ShopSite product field with fixed output-format and default rules, distinct from store-specific Catalog Fields. Its fulfillment type is ShopSite Delivery Mode, not the business Product Type.
_Avoid_: Store-specific config for DTD behavior

**Catalog Field**:
A store-specific product field present in a live ShopSite export. Its semantic purpose requires verified settings or template evidence, not merely an observed tag or example value.
_Avoid_: Database column, classifier slot, planned field

**Catalog Field Serialization**:
The store-specific format used when writing one or more Product Attribute values into a Catalog Field.
_Avoid_: String formatting, display text

**Attribute Mapping**:
An approved workspace-specific link from a Product Attribute to a Catalog Field whose semantic purpose is established.
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
A reviewable suggestion for a Product Classification, Classification Attribute value, Taxonomy Category Page assignment, or Classification Removal.
_Avoid_: Automatic classification, final assignment

**Classification Removal**:
A reviewed clearing of an incompatible existing classification value or Taxonomy Category Page assignment, never Protected Product Data.
_Avoid_: Silent cleanup, automatic deletion, identity correction

**Classification Removal Proposal**:
A reviewable suggestion to clear an incompatible existing classification value or Taxonomy Category Page assignment.
_Avoid_: Applied removal, automatic overwrite, Brand removal

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
A preview of product draft classification values and taxonomy-page assignments, including clears and removals, derived from accepted Proposal Decisions.
_Avoid_: Final product draft, persisted field values

**Skipped Draft Assignment**:
An accepted proposal that is not written during product draft creation because it is stale or blocked by configuration.
_Avoid_: Silent omission, successful required assignment

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
A Classification Proposal requiring reconsideration because its classification, evidence, configuration, or dependent decision changed.
_Avoid_: Invalid field, deleted suggestion

**Classification Evidence**:
A supplied product fact or image observation belonging to the Product SKU and supporting a Classification Proposal.
_Avoid_: Model output, AI reasoning

**Evidence Source**:
The origin of a SKU's supplied Classification Evidence, such as its Name, descriptive text, image observation, imported product facts, or operator-attested details.
_Avoid_: Model reasoning, prompt output

**Third-Party Evidence**:
Classification Evidence from a retailer, marketplace, distributor, or other non-official product page.
_Avoid_: Official evidence, claim evidence

**Distributor Scraper**:
An `html_scraper` connector family that extracts distributor catalog data from web storefronts via authenticated sessions (orgill, pet_food_experts, phillips_storefront, bradley, central_pet). Distributor Scrapers are Distributor Connections whose transport is web scraping rather than a provider API or catalog feed (ADR 0014 Amendment B).
_Avoid_: Crawler, bot, legacy adapter

**Page Assignment Context**:
The SKU's existing page assignments and configured page hierarchy used to compare proposed placements and removals, not to establish product facts.
_Avoid_: Page Context Evidence, inherited classification, direct product evidence

**Evidence Conflict**:
A disagreement between supplied product facts that leaves affected classification results unresolved. Uncertain product or variant identity prevents combining the conflicting sources.
_Avoid_: Model error, bad data

**Evidence Reliability**:
The trustworthiness of an Evidence Source for preselecting a Classification Proposal.
_Avoid_: Truth, priority rule

**Approved Product Example**:
An existing reviewed product used to inform Classification Configuration, not to supply facts or inherited assignments for another Product SKU.
_Avoid_: Training data, global example

**Configuration Suggestion**:
A reviewable proposed Category, Product Type, Product Classification, Classification Attribute, constraint, or allowed value derived from store-local configuration evidence.
_Avoid_: Auto-generated configuration, inferred schema

**Configuration Review**:
A workspace-level review of Configuration Suggestions and Configuration Changes.
_Avoid_: Product review, inline product decision

**Starter Preset**:
An optional predefined set of Categories, Product Types, Product Classifications, Classification Attributes, constraints, and allowed values that a store may adapt.
_Avoid_: Default configuration, global taxonomy

**Batch Classification Hint**:
Temporary operator guidance for interpreting supplied evidence in one onboarding batch, not a substitute for each SKU's own product facts.
_Avoid_: Workspace configuration, permanent mapping

**Baseline Classification**:
Evidence interpretation and configuration-gap detection available before approved Classification Configuration exists, not permission to invent catalog assignments.
_Avoid_: Full classification, configured attribute proposal

**Configured Classification**:
Classification work that depends on active Classification Configuration.
_Avoid_: Baseline classification, always-on classification

**Classification Configuration**:
The approved workspace-specific Categories, Product Types, valid Product Classifications, Classification Attributes, Attribute Profiles, Attribute Mappings, and allowed values.
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
The workspace default and classification-specific override rules that control how long Evidence Snapshots are retained.
_Avoid_: Immediate purge, raw archive policy

**Visual Product Evidence**:
Structured Product Evidence obtained by interpreting a supplied image for that SKU; artwork is not proof of flavor, ingredients, or health claims.
_Avoid_: Final visual classification, image guess

**Visual Evidence Eligibility**:
Whether a Classification Attribute may use Visual Product Evidence for proposals.
_Avoid_: Image-based guessing, universal vision support

**Evidence Extraction Stage**:
A Classification Stage that interprets supplied Untrusted Product Evidence into Structured Product Evidence without discovering new sources or rewriting input product data.
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
A missing, stale, or unmapped part of Classification Configuration that prevents a supported classification or value from becoming an assignment. A gap affecting the profile or required classification keeps the product in Review.
_Avoid_: Model guess, automatic configuration change

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

- A **Product Classification** consists of the website **Category** and **Product Type** for one **Product SKU**.
- **Category** and **Product Type** are canonical business values, not parallel website and internal classifications.
- Each configured **Product Classification** selects its **Attribute Profile**; profiles and identifiers are not additional types to predict or review.
- A provisional **Product Classification** may drive dependent attribute and taxonomy-page proposals in one pass without making them catalog truth.
- **Universal Classification Attributes** may be proposed from the SKU's own evidence under explicit configuration, without establishing **Classification Readiness**.
- A **Universal Classification Attribute** may be proposed without a **Product Classification**, but it cannot resolve or bypass a missing or invalid **Attribute Profile** selected by an established **Product Classification**.
- An **Unresolved Product Classification** is an explicit incomplete result, never a forced label or successful completed assignment.
- Changing **Category** or **Product Type** is a **Proposal Decision Revision** that invalidates dependent proposals, applicability, page placement, and readiness before application.
- Missing required **Category**, **Product Type**, profile configuration, or applicable required values keeps the product in **Review** before draft creation.
- An explicitly empty **Attribute Profile** is resolved with no attribute requirements; a missing or invalid declared profile is unresolved.
- An **Unmapped Product Type** or unsupported classification combination requires **Configuration Review**, not an invented assignment.
- An **Attribute Profile** may be shared by multiple **Product Classifications**.
- **Brand** is optional input context and never a classification assignment, replacement, removal, or brand-page proposal.
- **Protected Product Data** cannot become a classifier target through an Attribute Mapping, profile, model output, or reviewed target revision.
- Only a verified classification purpose authorizes a **Catalog Field** as an output; an **Attribute Mapping**, example values, or an empty slot cannot establish that ownership.
- An **Attribute Profile** may define **Attribute Constraints** for each included **Product Attribute**.
- An **Attribute Profile** may define **Attribute Applicability Conditions** for each included **Product Attribute**.
- An **Attribute Applicability Condition** may use unreviewed proposals only for **Applicability Previews**.
- Accepted or reviewed values are required before an **Attribute Applicability Condition** can affect final Field Assignments or required-field validation.
- Required-field validation applies only to Product Attributes whose **Attribute Applicability Conditions** are satisfied by accepted or reviewed values.
- A **Non-Applicable Product Attribute** does not affect final Field Assignments or required-field validation.
- Product review includes applicable attribute proposals and incompatible existing values requiring reviewed removal; other Non-Applicable Product Attributes remain available for configuration inspection.
- An **Applicability Override** may allow a Non-Applicable Product Attribute to receive a Proposal Decision for one product.
- An **Applicability Override** cannot authorize a classification output affecting **Protected Product Data**.
- An **Applicability Override** is not eligible for bulk actions.
- An **Applicability Override** may produce a **Configuration Suggestion** when it indicates the Attribute Profile may be wrong.
- An **Attribute Profile** may define **Attribute Cardinality** for each included **Product Attribute**.
- An **Attribute Profile** may define classification-specific **Attribute Value Aliases**.
- An **Attribute Profile** may define confidence thresholds for its **Classification Proposals**.
- An **Unmapped Attribute Value** requires review before it can become a **Field Assignment**.
- An **Unmapped Category Page** requires review before it can become a **Category Page**.
- A **Product Attribute** may appear in many **Attribute Profiles**.
- A **Product Attribute** may belong to one **Attribute Group** for review and configuration organization.
- **Classification Configuration** may define workspace-global **Attribute Groups**.
- A **Product Classification** may define an **Attribute Group Layout** for manager-facing display.
- An **Attribute Group** does not determine whether a Product Attribute applies to a product.
- A **Product Attribute** may have one **Attribute Mapping**.
- An **Unmapped Product Attribute** cannot produce a final **Field Assignment**.
- An **Attribute Mapping** points to one primary **Catalog Field**.
- A **Stale Attribute Mapping** cannot produce a final **Field Assignment** until remapped.
- A **Catalog Field** must come from the live ShopSite XML pulled from the store.
- A **Product Attribute** has exactly one **Attribute Value Mode**.
- A **Product Claim** requires **Direct Claim Evidence**; flavor, ingredients, and health claims require explicit product wording or facts rather than package artwork.
- An **Absence-Based Claim** cannot become a **Classification Proposal**.
- A **Product Composition Attribute** requires strict evidence and provenance.
- A measured **Product Attribute** stores **Measured Attribute Values** before field serialization.
- A measured **Product Attribute** has one **Canonical Measurement Unit**.
- A controlled **Product Attribute** may define **Attribute Value Aliases**.
- An **Ambiguous Attribute Value Alias** requires review before preselection.
- A **Field Assignment** applies to the **Catalog Field** identified by its **Attribute Mapping**.
- A **Field Assignment** uses **Catalog Field Serialization** when writing values into a **Catalog Field**.
- A product may belong to zero or more **Category Pages**.
- The **Classification Engine** proposes only existing verified **Taxonomy Category Pages**, not **Brand Pages** or newly created pages.
- A provisional **Product Classification**, applicable Classification Attributes, and the SKU's own evidence may support pending page proposals.
- Page placement follows the configured **Category Page Assignment Scope** for the Product Classification.
- **Category Page Assignment Scope** may have classification-specific rules with a workspace default.
- Without an explicit broader scope, page placement prefers the most specific matching verified taxonomy pages.
- **Page Assignment Context** supports comparison and reviewed removals, not proof of Category, Product Type, attributes, claims, or composition.
- Existing page membership does not establish a product fact or authorize inherited classification.
- Taxonomy-page proposals are separate from the **Category** field.
- A product can only be assigned to existing **Category Pages**.
- A **Category Page** has one **Category Page Identity**.
- An accepted Category Page assignment is validated by **Category Page Identity** before product draft creation.
- An accepted **Unavailable Category Page Assignment** requires resolution before product draft creation, not silent omission from a successful partial draft.
- A product may have zero or more **Field Assignments**.
- A **Field Assignment** records the value of one **Product Attribute** for one product.
- A **Classification Removal Proposal** requires an explicit **Proposal Decision** before clearing an existing classification value or taxonomy-page assignment.
- Correcting a classification does not silently clear existing values; **Brand** and other **Protected Product Data** remain outside removal scope.
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
- Value and placement proposals require the SKU's own **Classification Evidence**; removals also require the observed existing assignment and configured classification/applicability justification.
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
- An **Evidence Conflict** withholds affected proposals while independently supported results may continue.
- An **Approved Product Example** may inform configuration, never supply inherited facts for another Product SKU.
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
- **Classification Configuration** contains approved Category/Product Type combinations, Classification Attributes, Attribute Profiles, Attribute Mappings, allowed values, guidance, model policies, and data-sharing policies.
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
- Batch scheduling and frozen evidence do not authorize sharing classification evidence or inferred assignments across Product SKUs.
- The classifier interprets only supplied SKU facts and images; source discovery and input-data enrichment belong elsewhere.
- A **Classification Refresh** may make dependent **Classification Proposals** stale.
- A **Classification Refresh** has a **Refresh Scope**.
- Changes to the canonical **Product Classification** determine Refresh Scope through dependent proposals.
- A **Classification Refresh** may have a **Refresh Preview** before it is queued.
- A **Refresh Preview** may allow **Refresh Deferrals** for Product SKUs.
- A **Refresh Deferral** cannot alter required stages for included Product SKUs.
- A **Classification Refresh** must preserve prior **Proposal Decisions** in **Classification History**.
- **Configuration Review** may queue **Configuration-Driven Classification Refreshes** for affected products.
- A **Configuration-Driven Classification Refresh** reruns affected stages when dependencies are known and falls back to a full Classification Run when impact is unclear.
- A **Configuration Suggestion** becomes active only through a **Configuration Change**.
- A **Configuration Change** is reviewed before it updates **Classification Configuration**.
- A **Configuration Gap** blocks affected assignments and keeps the product in **Review** when the profile or a required classification value cannot be resolved.
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
- A skipped required classification assignment prevents **Classification Readiness** and draft creation; an unsupported optional value may remain unset.
- A **Classification Proposal** applies to one **Product SKU**.
- Classification assignments and removals are applied only from reviewed decisions through a separate CMS draft application step, never by the classifier itself.

## Example dialogue

> **Dev:** "If a food product is assigned to the **Dog Food** **Category Page**, do we automatically know its flavor?"
> **Domain expert:** "No — the **Category Page** controls where customers browse for it, while flavor is a **Product Attribute** determined from the product data."

## Onboarding Pipeline

**Onboarding Batch**:
A group of products imported together from a spreadsheet and viewed together in a Batch Workspace. Its progress is derived from its Onboarding Items rather than a lifecycle of its own.
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
The first pipeline stage that evaluates distributor evidence against each imported product (ADR 0014 + Amendment A). The capability is **DEFAULT ON** (`BAYSTATE_CMS_SOURCING_ENABLED` absent = enabled, mode `automatic`; explicit `false|0|no` is the global kill switch; empty/whitespace/malformed values fail closed disabled; `BAYSTATE_CMS_SOURCING_MODE` selects `observe|manual|automatic`). Imports derive their entry stage from the effective capability (`manual`/`automatic` → **Sourcing**, otherwise **Discovery**) and write `sourcing_entry_policy_version = 1`; pre-Amendment rows (version 0, incl. the 148 legacy rows) are never claimed, observed, or backfilled and stay on the audited **Continue to Official Site Discovery** path. When active, the worker runs the provider-neutral engine (`src/onboarding/sourcing/`) — enabled distributor connections (Phillips/BCI Phase 1 REST `api` connectors; Orgill/PFX/Phillips-storefront/Bradley/Central Pet `html_scraper` **Distributor Scraper** connectors per Amendment B — the deferred Orgill/PFX SFTP plans and Central Pet EDI feed are superseded as primary transports), each invoked with an exact normalized UPC/GTIN lookup (brand/register-name hints are non-authoritative identity evidence, never a filter and never imply `not_stocked`; brand advisory settings are retired — issue #150). Generations without an approved strategy query every enabled connection (query-all: no preference ordering, filter, or short-circuit); approved generations run only their frozen Included boundary. Evidence attempts are immutable and generation-scoped (`sourcing_generations`); a retry supersedes the generation. The reconciler compares identity-critical fields (upc/gtin/MPN/weight/size/count/packCount/brand, plus variant axes incl. flavor/formula and connector-declared axes): a deterministic projection authority decides qualification; hard identity disagreements persist as durable conflicts (`sourcing/needs_input`) resolvable only via the operator workflow (use candidate / custom value / dismiss); no evidence or provider errors degrade to audited fallback routes. **A qualified distributor record SKIPS Discovery**: the route `distributor_record_to_extraction` moves the item to `extraction/pending` with `source_type='distributor_record'` and a null URL (never a fake official URL). Materialization is **merchandising-depth** (Amendment B): identity fields plus description, features, category, dimensions, case pack, unit of measure, ingredients, and image URLs (display-only); price/inventory stay excluded and the URL stays null. Merchandising fields merge with per-field provenance and never trigger conflicts — only identity-critical fields do. Modes: `observe` writes only generations+attempts (zero decisions/acceptances/conflicts/extractions); `manual` holds non-conflict outcomes at `needs_input` with a server-derived qualification view and two operator actions (**Use distributor record** / **Continue to Official Site Discovery**); `automatic` applies the full route table (hard conflicts always manual). `bundle_to_curation` is prohibited and unactionable everywhere; no Sourcing → Curation routing exists. Distributor images are display-only until PI-6 rights verification. See `docs/runbooks/sourcing-engine-rollout.md` for the rollout/rollback sequence and read-only observation queries.
_Avoid_: Branding stage, distributor-to-curation routing, fake source URLs

**Brand Sourcing Strategy**:
A system-proposed, operator-approved reusable plan for gathering product evidence from one or more legitimate sources for a brand; an official website is optional. Each explicit Save is the approval command and immediately produces the next approved revision. Advisory settings (aliases, sourcing policy, preferred distributors) are retired (issue #150 / ADR 0035 B1.1): the configuration covers official-domain mappings only, and unapproved collection queries every enabled connection until an Included set is approved. Complementary evidence remains attributable to its sources and is collected for consolidation during **Prepare listing**, rather than requiring one exclusive source.
_Avoid_: Official-domain requirement, single-source route, extractor profile

**Partial Source Collection**:
Gathering evidence from available sources in an approved **Brand Sourcing Strategy** while other planned sources are unavailable. Unavailable sources remain visible but do not block collection from usable sources; listing sufficiency is assessed during **Prepare listing**.
_Avoid_: Whole-product profile block, silent source omission

**Browser-Assisted Evidence Collection**:
Bounded product-specific research for missing listing evidence after structured and static source collection, distinct from domain-level **Browser Investigation**. Observations remain attributable to their sources and are not accepted merely because a browser or model produced them.
_Avoid_: Browser Investigation, browser-first pipeline, automatically trusted extraction

**Item Evidence Acceptance**:
The decision that source-attributed product facts may support listing preparation after source authority, exact sellable-item and variant matching, provenance, conflict, and applicable rights requirements are satisfied. Browser-assisted facts may qualify per item without a healthy **Domain Extractor Profile**; acceptance is not human **Review**, release approval, or **Profile Health**.
_Avoid_: Model confidence as verification, profile activation, listing approval

**Listing Completeness Standard**:
The product-type-specific checklist of content needed for a curated rich listing to be ready for **Review**, subject only to explicit **Listing Completeness Exceptions**, rather than an obligation to reproduce all manufacturer content. Completeness is distinct from whether the supplied facts are sufficiently supported.
_Avoid_: Universal field checklist, all available manufacturer content, factual verification

**Listing Completeness Exception**:
An operator-approved, item-specific omission of a designated non-critical requirement from a **Listing Completeness Standard**, with the omitted field and reason recorded. It does not waive exact sellable-item and variant resolution, image rights, or required safety information, or assert that missing facts are known.
_Avoid_: Automatic waiver, completed field, fabricated substitute

**Grounded Listing Copy**:
Customer-facing product wording composed only from facts that have passed **Item Evidence Acceptance**, with claims traceable to supporting evidence. A generative model may compose the wording but cannot create product facts, resolve evidence conflicts, or turn a **Listing Completeness Exception** into an asserted value.
_Avoid_: Model-generated facts, unsupported benefits, inferred missing specifications

**Retailer Corroboration**:
Source-attributed use of third-party retailer observations to cross-check basic product facts after the exact sellable item has been matched. It does not authorize reuse of retailer prose or imagery or turn a retailer page into an **Official Product Page**.
_Avoid_: Licensed retailer content, manufacturer evidence, image reuse approval

**Listing Evidence Gap**:
Missing product information that prevents a listing from meeting its **Listing Completeness Standard** after collected evidence is consolidated during **Prepare listing**, requiring operator help in that stage. A gap is distinct from an identity or variant conflict, which must be resolved before conflicting evidence can be used together.
_Avoid_: Incomplete individual source, missing official domain, source identity conflict

**Discovery** (v2 canonical `find_product_page` / Find product page — owner-approved 2026-09-08):
The pipeline stage that finds candidate official product pages for an imported register item, keeping offered URLs distinct from **Confirmed Official Pages**.

**Extraction** (v2 canonical `collect_details` / Collect details — owner-approved 2026-09-08):
The pipeline stage that collects source-attributed product details for one sellable item and variant before listing preparation. Observations remain distinct from accepted facts, and collection alone establishes neither image rights nor **Profile Health**.

**Domain Extractor Profile**:
A reviewed, reusable extraction contract for one product-page structure on a domain, identifying the structures used by profile-based **Extraction**.
_Avoid_: Crawlee profile, generic scraper, selector cache

**Profile Scope**:
The subset of a domain's product pages that a Domain Extractor Profile covers, described by both an operator-visible URL pattern and a page-structure signal.
_Avoid_: Whole-domain assumption, URL-only rule

**Page Structure Signal**:
A stable product-page structure observation used to confirm that a Domain Extractor Profile still applies to a source URL.
_Avoid_: Visual design, exact DOM snapshot, URL pattern

**Profile Match**:
The single healthy **Domain Extractor Profile** selected for a source URL before profile-based **Extraction** begins.
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
The reviewed readiness of a **Domain Extractor Profile**, including product identity, description, image, and relevant variant evidence, to support profile-based **Extraction** within its scope.
_Avoid_: Profile exists, latest generation status, domain uptime

**Profile Revalidation Requirement**:
The review state created when a Domain Extractor Profile may no longer match its covered page structure.
_Avoid_: Immediate profile deletion, transient page failure, silent profile decay

**Fail-Closed Extraction**:
The rule that a profile-based **Extraction** attempt cannot contribute accepted facts when it lacks a healthy, applicable **Domain Extractor Profile**.
_Avoid_: Generic fallback extraction, best-effort scraping

**Profile-Blocked Item**:
An **Onboarding Item** whose profile-based **Extraction** attempt is blocked because no usable **Profile Match** is available.
_Avoid_: Failed product, auto-retry candidate, skipped item

**Manual Evidence**:
Operator-transcribed product facts submitted per SKU with an attestation covering per-SKU verification, no family inheritance, and applicable image rights, subject to **Review** before promotion. It is distinct from browser-collected observations and does not create **Profile Health**.
_Avoid_: Automated extraction, distributor record, generic fallback scraping

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

**Browser Investigation**:
An explicitly requested investigation of public product pages to propose deterministic extraction sources for domain onboarding or drift repair. It belongs to the requesting workspace and cannot itself establish Profile Health or release Onboarding Items.
_Avoid_: Extraction run, per-SKU browser agent, trusted extractor

**Investigation Evidence**:
An untrusted, source-attributed observation supporting a Browser Investigation recommendation. It is not trusted product evidence or proof that the recommended extraction strategy works.
_Avoid_: Verified extraction, healthy profile, model confidence as approval

**Extraction Policy Proposal**:
A reviewable proposal for per-field extraction source order, optional selector exceptions, and product and Source-Page Variant identity requirements. Applying it to a shared Domain Extractor Profile draft is an explicit operator action, not validation, activation, or release.
_Avoid_: Executable agent script, automatic adapter, active profile

**Profile Validation Sample**:
A product page used to test whether a Domain Extractor Profile extracts the expected product evidence within its Profile Scope.
_Avoid_: Training data, random URL, product approval

**Confirmed Profile Sample**:
A Profile Validation Sample whose source URL has been reviewed as the correct product page for its product, with durable manager-approved title/description/image/variant observations bound to the draft version being tested.
_Avoid_: Sitemap guess, search result, unreviewed candidate

**Register Name**:
The abbreviated product name from the imported spreadsheet row, used as the identity reference for official-page matching after conservative abbreviation/unit normalization.
_Avoid_: Consolidated name, curated title, page title

**Official Product Page**:
The brand's own product-detail page for one imported product and package variant; distinct from a ShopSite Category Page and never a retailer, listing, or blog page.
_Avoid_: Retailer page, category page, search result

**Page Candidate**:
An offered official-page URL (index, sitemap, import, operator, historical, or legacy) that has not yet passed guarded page-identity verification.
_Avoid_: Confirmed URL, selected source, approved page

**Confirmed Official Page**:
An Official Product Page whose visible name and exact size/flavor variant were verified against the Register Name under the frozen official-domain authority and recorded in an append-only decision with its evidence.
_Avoid_: Pasted URL, high-confidence match, reachable page

**Page Identity**:
The deterministic decision that a fetched product page is the same product and exact variant as the register item; ambiguities abstain and contradictions reject rather than scoring similarity.
_Avoid_: Title similarity, confidence score, UPC-on-page requirement

**Operator Attestation**:
An explicit manager confirmation of product and variant for a Needs Attention page whose evidence is plausible but not uniquely provable; recorded as evidence, never inferred.
_Avoid_: Auto-approval, implicit confirmation, silent exception

**Blind Profile Holdout**:
A Profile Validation Sample withheld from Browser Investigation and proposal tuning, reserved for independently testing the proposed extraction policy rather than establishing statistical generalization. A sample disclosed during investigation or tuning is no longer a holdout for that proposal.
_Avoid_: Agent-visible holdout, representative training sample, reused tuning evidence

**Tier 0 Static Reconnaissance**:
The default Browser Investigation runtime: host-side broker fetch of approved pages with deterministic analysis inside an isolated container that has no network egress of its own. Page bytes are never processed in the host; only typed observations leave the container. No model reasoning is involved.
_Avoid_: Host-side scraping, rendered browser, model-led browsing

**Tier 1 Rendered Investigation**:
The deferred Browser Investigation runtime behind Tier 0: a render-required investigation fails closed with the stable `render_deferred` code and performs no render attempt, leaving Tier 0 evidence standing; the render machinery exists but is not production-valid until rendered navigation works through the validating boundary (#237 stays open).
_Avoid_: Unrestricted browser, direct-egress rendering, implied proxy

**Curation** (v2 canonical `prepare_listing` / Prepare listing — owner-approved 2026-09-08):
The listing-preparation stage combining clean store-ready content with separate per-SKU Product Classification, attribute, and taxonomy-page proposals. Content and identity preparation are not Classification Engine outputs.

**Review** (v2 canonical `review_listings` / Review listings — owner-approved 2026-09-08):
The human quality-assurance stage for curated product listings. Recording a product as reviewed is distinct from approving its release and from creating its CMS draft.

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
- The profile-based official-page **Extraction** route requires a healthy **Domain Extractor Profile** for the source URL's domain. **Distributor-record sources are profile-free**: `distributor_record_to_extraction` items materialize merchandising-depth structured data (null URL, Amendment B) and never require a profile or URL.
- A domain may have multiple **Domain Extractor Profiles** when its product pages use different structures.
- Each **Domain Extractor Profile** has one **Profile Scope**.
- A **Profile Scope** includes both an operator-visible URL pattern and a **Page Structure Signal**.
- Profile-based **Extraction** requires a source URL to resolve to exactly one **Profile Match** before that route can produce trusted product evidence.
- A **Profile Match** requires both the source URL and the source page's **Page Structure Signal** to fit the **Profile Scope**.
- The most specific healthy **Profile Scope** determines the **Profile Match**.
- Ambiguous matching **Profile Scopes** prevent a **Profile Match** until a reviewer resolves the ambiguity.
- A default **Domain Extractor Profile** may produce a **Profile Match** only when it is explicitly scoped as the domain default and healthy.
- When a source URL fits a **Profile Scope** URL pattern but its **Page Structure Signal** no longer fits, **Fail-Closed Extraction** stops that profile-based attempt.
- A **Page Structure Signal** mismatch creates a **Profile Revalidation Requirement** for the relevant **Domain Extractor Profile**.
- A single **Page Structure Signal** mismatch does not remove **Profile Health** without repeated mismatches or reviewer confirmation.
- **Profile Tooling Extraction** may run when automated **Extraction** would fail closed.
- **Profile Tooling Extraction** may support profile generation, validation, previews, and diagnostics.
- **Profile Tooling Extraction** cannot produce trusted product evidence or advance an item past **Extraction**.
- The **Profile Builder** produces Domain Extractor Profile proposals only.
- The **Profile Builder** cannot create **Profile Health** without validation and reviewer approval.
- A **Browser Investigation** is explicitly requested for domain onboarding or drift repair, never invoked by normal per-product **Extraction**.
- A **Browser Investigation** produces **Investigation Evidence** and an **Extraction Policy Proposal**, not trusted product data or **Profile Health**.
- **Browser Investigation** inputs and results belong to one workspace; applying an **Extraction Policy Proposal** to a shared **Domain Extractor Profile** draft is a separate operator decision.
- An **Extraction Policy Proposal** may be saved as an inactive draft despite failed or incomplete validation; its failures remain visible and prevent activation.
- An investigation-derived extraction policy requires passing **Blind Profile Holdout** validation in addition to existing **Profile Health** requirements. A confirmation-count waiver does not waive the holdout requirement.
- **Item Evidence Acceptance** for **Browser-Assisted Evidence Collection** is per item and does not establish **Profile Health** or bypass **Review**.
- A **Listing Completeness Exception** may resolve a designated non-critical **Listing Evidence Gap** for one item; it does not supply missing evidence.
- Shared work and **Curation Cohort** membership do not determine **Item Readiness** for otherwise independent items.
- A **Profile Builder Workspace** is organized around one domain, not one product item.
- An **Onboarding Item** may provide a seed **Profile Validation Sample** for a **Profile Builder Workspace**.
- A **Profile Builder Workspace** may use unreviewed sitemap product URLs as exploratory Profile Validation Samples.
- Only **Confirmed Profile Samples** count toward **Profile Health**.
- A normal **Domain Extractor Profile** requires at least three **Confirmed Profile Samples** within its **Profile Scope**, or an audited confirmation-count waiver, before it can be healthy.
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
- A **Profile-Blocked Item** may resume profile-based collection through a reviewed retry or obtain facts through a separate eligible route; neither alternative evidence nor item acceptance creates **Profile Health**.
- A **Profile-Blocked Item** may advance using **Manual Evidence** or **Browser-Assisted Evidence Collection** only when **Item Evidence Acceptance** and its own **Item Readiness** requirements are satisfied.
- **Manual Evidence** does not reinterpret distributor or historical records and never exempts **Review**, image-rights approval, or readiness of a genuinely linked **Product Family** operation.
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
- **Category**, **Product Type**, and **Category Page** are distinct: the first two form one canonical **Product Classification**; the third is a browsing placement.
- Existing page membership is **Page Assignment Context**, not product-fact evidence.
- An unconfigured classification or value requires **Configuration Review**; classifiers do not create configuration or substitute a nearby allowed value.
- A profile-selector identifier is not an independent internal Product Type or another review gate.
- Provisional canonical classification may support pending taxonomy-page proposals; review remains required before application.
- Product Type structure could depend on each store's merchandising preferences — resolved: capture manager preferences as **Catalog Manager Guidance** and Classification Configuration rather than assuming one universal hierarchy.
- Classification-specific attribute grouping is **Attribute Group Layout**, a display concern rather than classification or applicability authority.
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
- There is one canonical **Product Classification**, not independently inferred internal and website types.
- Ambiguous Category/Product Type results remain **Unresolved Product Classifications**; required gaps keep the product in **Review**, never force a type or silently permit draft creation.
- Correcting Category or Product Type is a **Proposal Decision Revision** that invalidates dependent proposals while retaining review history.
- Curation Cohort membership never authorizes inherited product facts or classification assignments; each **Product SKU** uses its own supplied evidence.
- "variant data" could mean full family modeling or source-page option selection — resolved: use **Source-Page Variant** only for selecting the correct source-page option state for one imported **Product SKU**.
- Variant selection could rely on LLM guessing during automated Extraction — resolved: use a reviewed deterministic **Variant Selection Strategy** and fail closed on ambiguity.
- SKU could be confused with the stable local product identity — resolved: use **Product SKU** for the store-facing onboarding key and **Product Identity** after product draft creation.
- "field" was used to mean store-specific merchandising facts — resolved: call these **Product Attributes** in the domain language.
- Attribute grouping could be mistaken for classification semantics — resolved: use **Attribute Groups** only for manager-facing organization and duplicate-label context.
- Product Attribute applicability could be hidden in free-form guidance — resolved: express it as structured **Attribute Applicability Conditions** in Attribute Profiles.
- Unreviewed proposals could make irrelevant attributes appear required — resolved: use them only for **Applicability Previews** until values are accepted or reviewed.
- Required attributes are not every attribute in a profile; required-field validation applies only under the configured **Attribute Applicability Conditions**.
- Non-applicable attributes without existing values may be hidden from ordinary review; incompatible existing values require visible **Classification Removal Proposals** rather than silent omission.
- Manual review could silently override applicability rules — resolved: record an **Applicability Override** for the product and offer a Configuration Suggestion if the profile may be wrong.
- Applicability Overrides remain per-product; broad corrections require **Configuration Review** or correction of the canonical **Product Classification**.
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

The domain terms above and ADR 0041 govern the active single-classification contract. Current implementation ownership is recorded in ADR 0041's Shared interpretations section. The architecture and operational details below are historical pre-cutover snapshots; they do not define a parallel business Product Type, live-cache fallback, or alternate review gate.

### Key Concepts

**Catalog Classification Run**: A classification run executed against an existing catalog product, identified by `source_kind = 'catalog_product'` and `onboarding_item_id IS NULL`.

**Source Kind**: Discriminates classification runs by their trigger: `onboarding` (from pipeline) or `catalog_product` (from product detail).

**Source Product Hash**: A deterministic SHA-256 hash of the classification-relevant product fields (name, description, weight, customFields, media) used for drift detection at apply time.

### Architecture (pre-ADR-0041 implementation snapshot)

**Evidence Extraction**: The catalog adapter (`catalog-product-source.ts`) maps Product fields into a `NormalizedEvidenceInput` and feeds it to the shared evidence extractor (`product-evidence-extractor.ts`). This avoids dependency on the `onboarding_items` table.

**Stage Set**: Catalog runs omit `name_consolidation` (must not rename existing products). The remaining 6 stages run: evidence_extraction, primary_product_type, attribute_applicability, product_attribute_proposals, category_page_proposals, product_draft_projection.

**Draft-Only Application**: Accepted field and page proposals are applied by creating an **update change-set draft**, never by direct write. Source hash and config hash are verified at apply time to prevent clobbering concurrent edits.

### Terms

**Catalog Classification Run**: A `classification_runs` row with `source_kind = 'catalog_product'` and `onboarding_item_id IS NULL`.

**Catalog Evidence Source**: The `'catalog_product'` value in the `classification_evidence.source` CHECK constraint, indicating evidence derived directly from catalog product data.

**Existing Page Context** (implementation snapshot): Existing catalog page assignments provide comparison context; the agreed contract permits reviewed taxonomy-page removals rather than an additive-only policy.

### Constraints

- At most one running catalog classification run per product SKU per workspace.
- Applying accepted proposals always creates a change-set draft; never a direct write.
- Older catalog-run proposals are marked stale (`stale` status) when a newer run completes.
- Under the agreed contract, catalog classification cannot rename products, assign/remove Brand, or alter other Protected Product Data; canonical Category/Product Type and permitted classification changes require review.
- Refresh queue defers catalog classification to the Product Detail Rerun action; auto-refresh for catalog products is deferred to a future release.

## Operational state (2026-08-09, issue #17 D2/C2)

This dated snapshot records historical implementation and does not override the Product Classification contract in ADR 0041.

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
The primary Store Manager view of one Onboarding Batch, bringing together pipeline context, required human attention, preparation evidence, final review, and release decisions. Pipeline Stage and Operator Work-State describe different aspects of the same products rather than separate onboarding workflows.
_Avoid_: Pipeline Board, independently scoped competing workspaces

**Needs Attention**:
The set of Onboarding Items requiring a human decision or correction before their current work can continue. Batch-wide attention spans Pipeline Stages; a product merely waiting on automatic processing or an unblocked sibling is not itself an attention task.
_Avoid_: Failed products only, processing queue, all waiting products

**Preparation Details**:
Product-specific evidence and results from preparing a listing, including packaging OCR, family readiness, naming, canonical Product Classification, and attribute/page proposals. Preparation Details are distinct from final human review and release approval.
_Avoid_: Five preparation stages, batch completion checklist, approved listing

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
The Curation gate: a candidate Curation Cohort waits until every active member is Extraction-ready. There is no default partial-cohort Curation ("curate the available 3 of 4"). Ready cohorts may run automatically under the cohort Curation worker path (feature-flagged). Waiting vs blocked members are distinguished; blocking siblings link directly to their Needs Attention task.
_Avoid_: Per-SKU Curation as the default operator model, manual "curate now" partial-family actions

**Durable Review State**:
Explicit, independently recorded review/approval state distinct from pipeline stage: Curation-complete alone does not make a product reviewed. States: `not_ready` (Curation incomplete), `unreviewed` (Curation complete, not yet inspected), `reviewed` (human final inspection recorded), `approved` (bulk release decision recorded). Review covers every product; unreviewed products cannot be bulk-approved; editing a reviewed product invalidates review when the edited field affects approved output.
_Avoid_: Inferring "reviewed" from `stage='review'` / `stage_status='completed'` alone

**Bulk Approval**:
The deliberate release decision applied to the reviewed selection (approve-all-reviewed or selected reviewed items) with per-item validation (reviewed state + semantic/promotion gates), exact success/failure counts, visible retryable partial failures, and actor/time audit. Approval never implies export or publication.
_Avoid_: Risk-based auto-approval, approving unreviewed products, conflating approval with export

**Ready to Export**:
The operator work-state of a product whose CMS export draft has been created and awaits downstream export. It is distinct from approval, verified export, and publication.
_Avoid_: Approved without a draft, already exported, published

### Terminology mapping (internal → human-facing)

| Internal stage | Human-facing term |
| --- | --- |
| Sourcing | Identify & Route Sources |
| Discovery | Find product page |
| Extraction | Collect details |
| Curation | Prepare listing |
| Review | Review listings |
| Promotion | Create drafts |

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
