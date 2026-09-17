# Spec: profile scale-up for the 52 blocked items (draft)

**Status:** draft for review · **Research:** `profile-platform-triage-research.md` (same dir)
**Domain model:** `CONTEXT.md` (Domain Extractor Profile, Profile Scope, Profile
Health, Confirmed Profile Sample, Profile Builder Workspace — proposal-only per
ADR 0008) · **ADRs:** 0008 (scope to page structures), 0017 (brand resolution),
0014 (distributor sourcing), 0016 (automation owns progression)

## Goal

Unblock all 52 profile-needing onboarding items with the cheapest correct
mechanism per domain — not one AI draft each. AI selector generation is scoped
to ~12 items across 2 bespoke/template domains; the rest go via platform flags,
verification, or distributor routing.

## Non-goals

- No change to Profile Health rules (≥2 Confirmed Profile Samples per scope,
  reviewed title/desc/images, single Profile Match).
- No auto-activation: Profile Builder stays proposal-only (ADR 0008).
- No trusted extraction from Profile Tooling output.
- The 28 completed / 8 in-review / 5 skipped items are untouched.

## Phase 0 — brand→domain resolution (37 items, 10 brands)

Brands with no `brand_sites` mapping: Snif-Snax (8), Jolly Pets (6), Hummzinger
(4), YowUp / Wondercide / Sevin / OurPets (3 each), Coop & Range (2), OC (1),
Horsemen's Pride (1). Use the `assignItemBrand` / `assignItemDomain` flow;
converge each brand onto one official domain (ADR 0017) so later profiles are
shared, not scattered across retailer domains.
**Accept:** every pending item has a mapped domain; newly mapped domains feed
Phase 1 triage (platform probe before any draft).

## Phase 1 — Shopify flag-profiles (35 items, 2 domains)

`discovernutrisource.com` (canonical host of nutrisourcepetfoods.com — 27 items)
and `openfarmpet.com` (8 items). No LLM generation:

1. Normalize the profile domain key to the canonical/final host
   (Nutrisource serves canonical `discovernutrisource.com`; key must match what
   the worker fetches).
2. Create the profile with the Shopify platform path (`shopify_json_path=1`,
   precedent: `thebetterbone.com`); no CSS selectors.
3. Verify on first discovered product URL: `detectPlatform()` returns `shopify`
   AND `/products/<handle>.js` returns title + vendor + variant data.
4. Collect 2 Confirmed Profile Samples per scope → Health → Retry Preview sweep.

**Accept:** both domains healthy; 35 items retry-eligible. **If verification
fails** (e.g. headless storefront without product JSON), the domain drops to
Phase 3 treatment.

## Phase 2 — Bonide verification (5 items)

Product pages unknown: probe for WooCommerce markers (`wc/store`) and
Product/Offer JSON-LD. If WooCommerce → platform-profile path like Phase 1. If
plain WordPress + Product schema only → single light AI draft (L2 structured
data carries most fields; selectors fill gaps). If neither → Phase 3 treatment.
**Accept:** decision recorded per finding; no heavy draft started blind.

## Phase 3 — AI drafts for bespoke/template domains (12 items, 2 domains)

- `nylabone.com` (Sitecore SXA, 5 items): ONE draft; shared SXA templates should
  generalize across product pages — validate on 2+ distinct product templates
  to prove scope coverage, not just two URLs off one template.
- `bluebuffalo.com` (Optimizely DXP, 7 items): full AI draft via
  `profile_generation` (deepseek-v4-flash, configured), visual-select fallback
  per field, reviewer approval per field.
  **Accept:** each domain healthy with image-preview review done (Health gate).

## Phase 4 — distributor routing for walled domains (5 domains, 0 current items)

`bil-jac.com`, `chickensouppets.com`, `multipet.com`, `northstatesind.com`,
`yeowww.com` are Cloudflare-403'd — never Profile Builder candidates. Route
future items for these brands via `distributor_record` (Amendment B:
merchandising-depth, URL-null, zero fetch/profile) or manual evidence where
distributor data is thin. Also the standing rule for any new no-sitemap /
bot-walled domain discovered in Phase 0.
**Accept:** documented routing decision per domain; zero wasted draft attempts.

## Phase 5 — retry sweep + observability

Release via existing Profile Retry Preview (selected retries, no auto-rerun).
Track per domain: layers used (flag vs draft), LLM tokens/cost per draft,
`SUITE_FAILED` / `LLM_NOT_CONFIGURED` rates, disclosure audit (sanitized HTML
leaves machine on hosted path).

## Open questions (need owner answers before build)

1. Who confirms the 2+ samples per scope, and what weekly review throughput can
   we assume? (Sets whether Phases 1–3 run serially or batched.)
2. Do flag-profiles (Phase 1) go through the same image-preview review bar for
   Health, or is platform-API evidence sufficient? (Recommendation: same bar —
   Health rules unchanged above.)
3. For Phase 0 brands with no official domain at all, is a retailer-domain
   profile acceptable, or distributor-only? (ADR 0017/scatter concern.)
