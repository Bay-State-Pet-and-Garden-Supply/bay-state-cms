# ADR 0035 — Brand Sourcing Strategies: approved multi-source collection

- **Status:** Accepted
- **Relates to:** ADR 0014 + Amendments A/B (multi-distributor sourcing), ADR 0016 (operating model), ADR 0017 (brand resolution and source authority), ADR 0034 (stage vocabulary and storage compatibility)
- **Implements:** spec #120, tickets #121–#125

## Context

Stage 1 presented **Source Route** alongside **Domain & Profile**, implying the
official brand website is the normal source and distributor records are an
exception. In practice some brands have no official product website, and useful
evidence is spread across official pages and multiple distributors. The
existing brand-strategy projection was a read-only derivation — not an approved
execution contract — and the single-source routing model (`preferred_then_fallback`
short-circuit, one winning source) could not express complementary collection.

## Decision

**One brand → one operator-approved sourcing strategy; collection gathers
complementary evidence within that boundary; Prepare listing consolidates it.**

- The system proposes a strategy from existing domain mappings and supported
  distributor connections. An operator reviews, adjusts, and explicitly
  approves it (`brand_sourcing_strategies`, revisioned, stale-write guarded).
  Proposals, mappings, preferences, and brand assignment never constitute
  approval.
- Scope is currently supported **official-page** extraction and
  **distributor-record** acquisition only. Distributor catalog scrapers remain
  record transports, not arbitrary page-extraction sources. No new
  retailer/distributor-page source kind is introduced.
- Strategy-driven sourcing attempts every selected usable distributor source;
  first success never short-circuits, and no unapproved fallback is added. An
  approved strategy with no usable source is setup attention, never a fake
  result. Distributor-only work stays profile-free and URL-null.
- Mixed evidence is an explicitly versioned multi-contribution result
  (`strategy-collection-v1`) with per-contribution source typing. Legacy
  single-source discriminators keep their meaning; unsupported versions fail
  closed; distributor evidence is never relabeled official. For new
  strategy-driven work, non-official candidates are excluded from official-page
  collection, including the legacy manual fallback.
- Post-consolidation insufficiency is a durable **Listing Evidence Gap**
  (`preparation_gaps`), resolved only by operator-supplied correction through
  preparation validation. Gaps block review approval via the existing
  approval checks; the five-section preparation display remains display-only.
- Stage 1 shows **Brand strategy** and **Collection readiness** from the same
  server facts. “Ready” means collection can run — never that a listing is
  complete. Identity/variant conflicts and source-authority exceptions stay
  upstream of blending.

## Consequences

- Brands without official websites are first-class (distributor-only
  strategies, no Missing Domain warning); unavailable planned sources are
  visible but do not block usable ones.
- Approval, availability, collection outcomes, and listing sufficiency are
  distinguishable states instead of one domain/profile flag.
- Historical single-source rows and protected legacy sourcing rows are
  untouched; no backfill, no replay, no silent approval.

## Amendment B1 — Save is explicit approval (brand strategy builder)

- **Supersedes the identical-source idempotency rule.** Every accepted
  explicit Save (`POST /api/onboarding/brands/strategy/approve`) creates
  exactly one new approved revision — including identical-source,
  source-only, and mapping/preference-only Saves. A retransmission carrying
  the same previous `expectedRevision` returns 409 and creates no revision.
- `expectedRevision` is required (0 matches only the absent-row case) and
  `expectedConfigurationToken` is required whenever `configuration` is
  present. Missing guards are 400, never unguarded writes. The approval,
  mapping, and advisory writes commit atomically; any failure rolls all
  three back together. *(Advisory-profile configuration and triple-write
  clauses superseded by Amendment B1.1 below; explicit-approval and
  optimistic-concurrency rules stand.)*
- No persisted draft, auto-save, approve-later workflow, or approval caused
  by a read, proposal view, mapping edit elsewhere, or brand assignment.
- **Runtime-support caveat.** Approved `official_page` sources remain
  explicitly `not_supported`: no collection path executes them. Active
  generations stay pinned to the revision/source set captured when execution
  began (`sourcing_generation_strategy_snapshots`); retries and new
  generations capture the latest approval. Broader official-page
  multi-source orchestration and collection-to-preparation blending are
  separate follow-ups and remain activation blockers where required.

## Amendment B1.1 — Retire brand advisory configuration (issue #150)

This amendment supersedes B1's advisory-profile configuration and atomic
triple-write clauses, not its explicit-approval or optimistic-concurrency
rules.

Brand strategies no longer contain editable aliases, sourcing policy, or
preferred distributor IDs. The approve command rejects these retired keys
(400, even empty/default-valued, at root and nested configuration).
Optional configuration contains only this brand's complete official-domain
mapping set and still requires `expectedConfigurationToken`. The token
covers versioned (`brand-strategy-mapping-configuration-v2`), exact-brand
mapping state, not retired advisory rows — pre-retirement tokens are stale
(409). Mapping changes and approval commit atomically; any validation,
stale guard, or persistence failure rolls both back. Every accepted
explicit Save creates exactly one approved revision, including
unchanged-source, source-only and mapping-only Saves; replay with the same
previous revision returns 409. There is no auto-save or
read/proposal/assignment-induced approval.

An approved generation executes only its frozen Included source boundary,
independent of proposals and any historical advisory settings. Approved
official-page sources remain explicitly unsupported as stated in B1; this
amendment does not implement official-page collection or blending.

New collection generations with no approved strategy use the versioned
query-all rule (`strategy-binding-v2`, mode `query_all`): attempt all
enabled workspace distributor connections under existing identifier,
authority, timeout and concurrency constraints. There is no preferred
ordering, preferred-only filtering, or success short-circuit.
Brand/register-name hints remain non-authoritative identity evidence, never
distributor stock filters. This intentionally removes the former
`preferred_only` spend-control knob and `preferred_then_fallback` early
stop and can increase attempts, spend, latency and detected conflicts. An
operator can bound future brand collection by explicitly approving Included
sources; connection disablement and the global capability kill switch
remain separate controls.

New captures use `strategy-binding-v2` with `approved` or `query_all`
mode. Existing valid approved pins (v1 or v2) remain frozen and executable
under their captured source set. Existing v1 `legacy_advisory` pins are
historical only and cannot execute or be silently relabeled query-all;
actionable setup attention requires an explicit new-generation retry.
Historical bindings/evidence are neither backfilled nor replayed. Raw
historical preference snapshot bytes are retained for audit but are not
configuration or execution authority.

The advisory profile table, its CRUD APIs and corresponding UI/client/
schema contracts are retired. Strategy identities/diagnostics use
exact-normalized mapped and stored approval brand names; Settings
suggestions also retain catalog/onboarding names. No alias-based/fuzzy
authority or synthetic mapping/approval is introduced. Advisory-only
settings and names may disappear from those settings lists and are
recoverable from the verified upgrade backup. Proposals remain read-only
suggestions and never imply approval (ADR 0035); ADR 0017
source-authority restrictions remain unchanged.
