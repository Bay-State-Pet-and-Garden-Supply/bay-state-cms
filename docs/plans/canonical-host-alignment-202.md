# Issue #202 — canonical-host alignment (Nutrisource + rule)

**Parent:** #197 (oracle-verified cost-tiered profile scale-up spec).
**Date:** 2026-09-16. **Method:** alignment-only, probe-free — redirect
evidence is consumed from the #201 verdict table (the input artifact), and
release matching is demonstrated with the pure helpers in
`src/onboarding/brand-hub/canonical-host-alignment-202.ts` (19 tests in
`src/tests/unit/canonical-host-alignment-202.test.ts`).
**No production writes** (no profile rows, no mapping rows, no source-URL
or suite edits, no generation-pin contact — the #198 release guard lands
separately and the profile row itself is #207's job).

## The problem

`brand_sites` says `nutrisourcepetfoods.com`, but the site serves from
`discovernutrisource.com`: the legacy mapped URL 301-redirects to the
canonical host on real product pages. Every release/profile predicate in
production keys on the **stored source-URL hostname (pre-redirect)**:

- `job-queue` extraction gate: `findProfileByDomain(hostOf(sourceUrl))` —
  a canonical-keyed profile never matches a legacy-host source URL
  (`profile_miss`);
- `domain-release.releaseDomainExtractionItems`: releases only rows where
  `hostOf(source_url) === profileDomain`;
- worker `assertSafeProfileDestination`: denies fetches outside
  `allowedSourceDomains` (profile domain auto-included) — a legacy-only
  allowlist denies the canonical fetch;
- `official-collector` stays inside the frozen approved domain, and the
  activation gate evaluates samples under the suite's domain key.

So a profile keyed on the wrong host can never release its items, however
healthy its selectors are. All five surfaces must agree on the host the
worker actually fetches.

## Nutrisource demonstration (demonstrated, not asserted)

| Surface | Aligned value | Evidence |
|---|---|---|
| Profile domain key | `discovernutrisource.com` | #201: final host, canonical link, and working `.js` endpoint agree |
| Approved mapping/strategy | `official_page:discovernutrisource.com` via `saveBrandStrategy` configuration | Planned (not executed here); both legacy-host brands re-owned |
| Stored source URLs | `https://discovernutrisource.com/products/…` | #201 200-probe final URLs; legacy-host URLs miss (tested) |
| Validation samples | suite key `discovernutrisource.com`, canonical-host sample URLs | Same final URLs; suite key must equal the profile key |
| Worker allowlists | `discovernutrisource.com` (explicit; profile domain auto-included) | Legacy-only allowlist denies the canonical fetch (tested) |

Redirect evidence (from #201, transcribed into
`NUTRISOURCE_ALIGNMENT_202` with fidelity tests):

- `nutrisourcepetfoods.com/our-food/…/chicken-rice-recipe/` → **301** →
  `discovernutrisource.com/products/chicken-rice-wet-dog-food` (200,
  `cf2e0329…`, Shopify);
- `discovernutrisource.com/products/adult-chicken-and-rice-dog-food`
  (200, `45bd713b…`, Shopify);
- endpoint `https://discovernutrisource.com/products/<handle>.js`:
  vendor `NutriSource®`, 1–3 variants with barcodes, 6–9 images.

`checkHostAgreement` passes on all five surfaces; simulated release
matching hits every canonical-host URL and misses every legacy-host URL.

## The reusable rule (next split domain follows this without rediscovery)

Also encoded as `ALIGNMENT_RULE_202` (seven steps):

1. **PROVE with leaf product-page redirect chains** — ≥1 status-200 leaf
   probe, unanimous final host, canonical link + working endpoint agree.
   Homepage canonical metadata alone never qualifies
   (`qualifyCanonicalHost` rejects it).
2. **KEY the profile on the post-redirect fetch host.**
3. **MOVE the approved mapping through `saveBrandStrategy`** with an
   `officialDomains` configuration — brand-scoped, never a blind
   `brand_sites` UPDATE. Respect multi-brand removal ownership (here:
   PureVita shares the legacy host; move/re-own both rows together).
4. **CONVERGE stored source URLs** to the canonical host via the
   assign-domain surface (release matching keys on the stored hostname).
5. **CONFIRM validation samples** on the canonical host under the
   canonical suite key.
6. **ALLOWLIST the canonical host** on every worker fetch path (profile
   domain is auto-included; still pass it explicitly).
7. **NEVER rewrite historical sourcing-generation frozen pins, touch
   unrelated domains, or write live profile rows before the release guard.**

## Untouched by this ticket (verified in review)

- Historical sourcing-generation frozen pins: no pin read, no pin write
  (the alignment module has no pin I/O at all).
- Unrelated domains (e.g. `openfarmpet.com` — agrees independently on its
  own host, tested).
- Live `extractor_profiles` rows: zero written (profile creation is #207,
  after the #198 guard).
- Live `brand_sites` / strategy rows: mapping move is planned, not
  executed (dry by construction — there is no applicator in this ticket).

## Handoff to #207 (ordered operator steps)

1. Land #198 (release guard), then re-approve brand strategies:
   `saveBrandStrategy` for **NutriSource** and **PureVita** with
   `configuration.officialDomains = ['discovernutrisource.com']`
   (expected-revision + configuration-token guarded; verify live
   `brand_sites` rows first — the seed shows both brands on the legacy
   host).
2. Converge the 27 items' stored source URLs to
   `discovernutrisource.com/…` via the assign-domain surface.
3. Confirm the representative suite under key
   `discovernutrisource.com` with canonical-host product URLs.
4. Create the minimal Shopify profile keyed `discovernutrisource.com`
   with `allowedSourceDomains` including the canonical host; validate
   through the production worker per #207 acceptance.
5. Selective release only (failed-extraction, owning workspace) — the
   #198 guard now governs automatic paths.

## Re-verification (read-only; re-run anytime)

```bash
curl -sIL -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' \
  https://nutrisourcepetfoods.com/our-food/nutrisource/nutrisource-dogs/nutrisource-grain-inclusive-dogs-wet/chicken-rice-recipe/ | grep -i 'HTTP/\|location'
curl -s 'https://discovernutrisource.com/products/adult-chicken-and-rice-dog-food.js' | head -c 300
npx vitest run src/tests/unit/canonical-host-alignment-202.test.ts
```
