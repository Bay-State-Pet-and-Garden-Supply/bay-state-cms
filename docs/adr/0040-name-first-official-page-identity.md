# Name-first official-page identity with honest URL provenance and guided profiles

Official pages usually expose no GTIN, so Discovery, manual confirmation, and Extraction now share one conservative name/variant identity decision: the abbreviated register name must uniquely match the visible product name and exact size/flavor variant on a reachable official product-detail page. Pasted/imported URLs stay unconfirmed candidates until that check passes; one append-only decision atomically binds the selected page, evidence, and item URL. Confirmed pages feed local retrieval with page-observed metadata and explicit provenance, and profile setup is a guided manager path whose production matrix requires durable multi-field observations, image review, and activation.

**Status:** accepted

**Partial design supersession:** [ADR 0042](0042-evidence-first-item-local-onboarding.md) permits broader bounded candidate retrieval and per-item browser evidence acceptance without a healthy-profile prerequisite. Conservative name/variant matching, official-domain authority, honest URL provenance, and profile publishing governance remain binding; retailers do not become official pages and no runtime activation is implied.

## Context

The worker previously auto-selected only exact structured-GTIN proof on an official domain. Managers report that official pages usually carry no page GTIN, so ordinary products parked regardless of clear visible-name matches. Imported/pasted URLs were also conflated with confirmed URLs, retrieval shortcuts hid plausible alternatives, permissive extraction overlap accepted changed pages, and profile setup exposed selector internals plus local-only approvals by default.

## Decisions

- **Name-first identity, GTIN as corroboration.** `official-page-identity.ts` compares register name to visible product name/variant after conservative abbreviation/unit normalization. Outcomes are `unique_name_variant_match`, `needs_operator`, or `reject_conflict`. A page-observed GTIN corroborates or contradicts; absence is ordinary. Unknown abbreviations abstain.
- **Full-candidate assessment, unique auto-selection only.** Discovery searches every approved domain's index and sitemap without UPC/reachability short-circuits, reports `retrievalState`/`failedDomains`/`truncated`, and the worker verifies the bounded set under the frozen-domain guard. Auto-selection requires complete coverage, every fetch successful, exactly one authorized unique match, no unresolved variant, and the existing kill switch inactive.
- **Honest URL states.** `source_url` is the confirmed official page. Imports/pastes become unselected candidates; `/set-url` is replaced by propose-then-confirm through the same guarded service; decisions are append-only and survive reruns. Extraction revalidates identity and fails closed on changed pages or stale variant receipts.
- **Provenance-preserving retrieval.** Confirmed URLs upsert into `brand_url_index` with page-observed title/brand/identifiers and `confirmed_page` origin; sitemap refresh inactivates only sitemap-origin rows. Historical approvals are high-priority candidates that are always re-fetched and rechecked.
- **Guided, policy-safe profiles.** Setup defaults to confirm pages → review values → run production checks → use for this brand, with specialist controls under Advanced. Model proposals route through the frozen workspace policy (`profile_generation`); denial leaves deterministic/manual paths. Matrix expectations are durable manager-approved title/description/image/variant observations bound to draft versions; waiver remains count-only.
- **Brand authority unchanged.** ADR 0017 still governs official domains, retailer denial, frozen strategy boundaries, and manager domain assignment.

## Consequences

- Unique visible matches auto-advance without a page barcode; ambiguous variants, truncated coverage, fetch failures, contradictions, retailers, and listings park for explicit manager comparison.
- **Residual risk:** two genuinely similar products with incomplete page metadata remain a human-review case. “Unique” means unique within the observed catalog/search pass, not every page on the web; final Review remains mandatory.
- **Considered options:** keep GTIN-only auto-selection (rejected: parks ordinary products); similarity-score thresholds (rejected: hides ambiguity and launders weak evidence as proof).
