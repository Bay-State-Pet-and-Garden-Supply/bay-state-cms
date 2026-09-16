# Issue #200 — distributor/connector readiness verification

**Parent:** #197 (oracle-verified cost-tiered profile scale-up spec).
**Date:** 2026-09-16. **Method:** live read-only checks against the workspace
DB (`storage/catalog/.shopsite-cms/app.db`, `mode=ro`), process env, and
repo sources — nothing inferred from registration or configured keys alone.
**Code changes in this ticket:** none (report only; no production behavior
changed, no enablements flipped).

## Checklist (each item: verified state + where observed)

### 1. Effective sourcing mode — READY (default-on automatic)

- Env: neither `BAYSTATE_CMS_SOURCING_ENABLED` nor
  `BAYSTATE_CMS_SOURCING_MODE` is set (`env | grep -i SOURCING` → empty).
- Live parse (`bun -e` → `loadSourcingFlags(process.env)`):
  `{"sourcingEngineEnabled":true,"mode":"automatic","effectiveEnabled":true,"reason":"default_on"}`.
- Source: `src/onboarding/flags.ts` (`parseEnabledEnv`: absent = enabled;
  `parseSourcingMode`: absent = `automatic`); served at
  `GET /api/onboarding/capabilities` (`src/server/routes/onboarding-routes.ts:1246`).
- Entry policy: all 130 `onboarding_items` carry
  `sourcing_entry_policy_version = 1`; zero marker-v0 rows
  (`... WHERE sourcing_entry_policy_version=0` → `0`), so there is no
  stranded legacy cohort in this workspace.

### 2. Enabled workspace connections — READY (5/5 html_scraper)

Read-only query
(`SELECT distributor_id, enabled, secret_ref FROM distributor_connections`):

| distributor_id | connector_type | enabled | secret_ref |
|---|---|---|---|
| bradley | html_scraper | 1 | NULL (correct — public, no secret required) |
| central_pet | html_scraper | 1 | NULL (correct — public) |
| orgill | html_scraper | 1 | `orgill` |
| pet_food_experts | html_scraper | 1 | `pet_food_experts` |
| phillips_storefront | html_scraper | 1 | `phillips_storefront` |

Public-vs-auth mapping matches code
(`connectorRequiresSecret`, `src/onboarding/sourcing/connector-registry.ts`).
No `api` (Phillips REST / BCI OrderCloud) rows exist — acceptable: per
Amendment B the scrapers are the primary transports and the deferred SFTP/EDI
plans are superseded (`docs/runbooks/sourcing-engine-rollout.md`). If #203
wants REST+scraper dual coverage for Phillips, that is FU-5, not a blocker.

### 3. Usable secrets — READY (3/3 auth'd, shape-verified without disclosure)

`secret_ref` resolves server-side via env-then-`api_keys`
(`src/onboarding/sourcing/secret-resolver.ts`). Redacted shape check
(`bun:sqlite` readonly + `parseHtmlScraperCredentials` rules from
`src/onboarding/sourcing/html-scraper/credentials.ts` — lengths only, no
material printed):

- `orgill` (len 50), `pet_food_experts` (len 60), `phillips_storefront`
  (len 60): all parse as exactly-`{username,password}` with nonblank strings,
  none `•`-masked → **usable**.
- bradley / central_pet require no secret and present none → correct.

### 4. Qualified exact-identifier evidence availability — NOT YET (identifiers ready, zero qualification evidence)

- Identifier floor: **89/89** `route_sources/pending` items normalize via
  `normalizeGtin` (`src/shared/gtin.ts`); zero unnormalizable UPCs. The two
  #199 distributor-first-class brands are identifier-ready: OurPets (3 UPCs:
  `780824103001/18/25`), Coop & Range (2 UPCs: `607899670019`,
  `607899675014`).
- Qualification ceiling: `sourcing_generations` = 0,
  `sourcing_generation_strategy_snapshots` = 0,
  `onboarding_evidence_attempts` = 0, `onboarding_evidence_conflicts` = 0.
  No distributor record has qualified through the projection authority
  (`distributor-record-projection.ts`: exact normalized identifier equality +
  current-generation acceptance + nonblank name + full provenance + no open
  hard conflict) — because the worker has never run a generation in this
  workspace. Identifier availability is proven; **qualification is unproven**
  (FU-1/FU-4).

### 5. Frozen strategy pins — PARTIAL (1 approved; walled + #199 pins pending)

- `brand_sourcing_strategies`: exactly **1** row — `open farm` rev 2,
  `approved=1` (`2026-09-11`), 5 sources (official `openfarmpet.com` +
  bradley/central_pet/pet_food_experts/phillips_storefront distributor pins).
- The 5 walled-domain brands (bil-jac, chicken soup, multipet, north states,
  yeowww/yeowww!) have **no strategy rows** — expected: they have zero
  current items (see verdict) and their route decision belongs to #203.
- #199's OurPets / Coop & Range distributor-first-class pins are recorded in
  `docs/plans/brand-sourcing-strategies-199.md` but **not yet applied**
  (applicator `scripts/apply-brand-strategies-199.ts` exists; strategies
  table lacks them) — named dependency FU-2. Per #199, distributor collection
  stays `setup_attention` until this ticket verifies — now done for
  connections/secrets, still gated on FU-1/FU-4 for evidence.

### 6. Provider rollout gates — UNMET (0/100 on every connector)

Per `docs/runbooks/sourcing-engine-rollout.md` the gates are operator-run
measurements (no automatic gate engine): ≥100 labeled observations per
connector (≥30 found, ≥20 negative/wrong-variant), zero false accepts, ≤10%
source errors, p95 within the 60 s budget, then a 7-day/100-item automatic
canary. Current counts from the read-only observation queries: **0 attempts
on all providers** — every gate is 0% met. The live-smoke gate
(`BAYSTATE_CMS_SOURCING_LIVE_SMOKE=1`,
`src/onboarding/sourcing/html-scraper/live-smoke.ts:130`) is not enabled and
no smoke has been recorded. First step is FU-1 (offline fixture tests +
live smoke with the runbook TEST identifiers), then observe-mode accumulation
(FU-4).

### 7. Manual-evidence preconditions — DOCUMENTED (flag currently ON; entry + no-profile rules verified in code)

- Default-off design: `loadManualEvidenceFlags` returns
  `{enabled:false, reason:'disabled_default'}` when the key is absent
  (`src/onboarding/flags.ts:203+`). **Current live state is ENABLED**
  (`{enabled:true, reason:'env_enabled'}` — `.env` sets
  `BAYSTATE_CMS_MANUAL_EVIDENCE_ENABLED=true`). Enabling alone changes no
  automated behavior (every submission is an explicit audited operator act).
- Prior-eligible-failure requirement (`src/onboarding/manual-evidence-service.ts`):
  entry **only** from `extraction/failed` — `pending` rejects with
  `extraction_never_attempted`, other statuses with `extraction_not_failed`;
  non-profile failures additionally require explicit
  `familyPageOnlyConfirmed` (`not_profile_blocked` otherwise).
- No-existing-profile rule: submit rejects with `profile_now_healthy` when
  `findProfileByDomain(domain)` returns a row. Verified live: zero
  `extractor_profiles` rows for all 5 walled domains (23 profiles total, none
  walled) — the rule passes vacuously for walled routing today.
- Source: `docs/runbooks/manual-evidence-rollout.md` (enable/kill/observation
  queries).

## Verdict: which walled-domain brands can route via distributor-record today?

**None — verified, not assumed.** The five Cloudflare-walled domains
(`bil-jac.com`, `chickensouppets.com`, `multipet.com`, `northstatesind.com`,
`yeowww.com` — all `domain_status=blocked`, "Cloudflare Bot Challenge / HTTP
403") are correctly set up to *never* take the profile path (zero profile
rows, and #203 must create none), and the mechanical floor beneath
distributor routing is ready (mode automatic, 5/5 connections enabled, 3/3
secrets usable, no profile collisions). But routability requires a qualified
record, and there is **zero** qualification evidence in this workspace: no
sourcing generations, no attempts, no approved strategy pins for any walled
brand, no rollout-gate observations — and none of the five brands even has a
current onboarding item to route. Mechanically ready, evidentially unproven.

Closest to routable: OurPets + Coop & Range (#199 distributor-first-class, 5
valid UPCs, covering connections enabled with usable secrets) — blocked only
on FU-1/FU-2/FU-4.

## Gaps → named follow-ups (nothing left as "probably fine")

- **FU-1 (#203 prerequisite):** per-connector live smoke
  (`BAYSTATE_CMS_SOURCING_LIVE_SMOKE=1`, runbook TEST identifiers:
  bradley `018653299524`, central_pet `035585775210`, orgill `755625321923`,
  pet_food_experts `33011808`, phillips_storefront `072705115310`) +
  no-secret/malformed-secret dry checks. Owner: #203.
- **FU-2:** apply #199 strategies
  (`bun scripts/apply-brand-strategies-199.ts --db=$BAYSTATE_CMS_DB_PATH --apply --acknowledge-oc-identity`)
  so OurPets/Coop & Range pins exist before their first generation. Owner: #199.
- **FU-3 (#203):** record an explicit route per walled domain
  (distributor flowing / manual-evidence staged with eligibility confirmed /
  blocked-with-reason + owner follow-up) once FU-1 yields real evidence.
- **FU-4:** observe-mode accumulation to the quantitative gates (100 labeled
  obs/connector, ≥30 found, ≥20 negative/wrong-variant, zero false accepts)
  before any automatic canary. Operator-run; queries in the sourcing runbook.
- **FU-5 (optional):** decide whether Phillips REST / BCI `api` connection
  rows are wanted alongside the scrapers for dual coverage. Not blocking —
  scrapers are the primary transports.

## Re-verification (read-only; re-run anytime)

```bash
DB="storage/catalog/.shopsite-cms/app.db"
sqlite3 "file:$DB?mode=ro" "SELECT distributor_id,connector_type,enabled,secret_ref FROM distributor_connections ORDER BY 1;"
sqlite3 "file:$DB?mode=ro" "SELECT service,length(api_key) FROM api_keys ORDER BY 1;"  # lengths only — never dump values
sqlite3 "file:$DB?mode=ro" "SELECT COUNT(*) FROM sourcing_generations; SELECT COUNT(*) FROM onboarding_evidence_attempts;"
sqlite3 "file:$DB?mode=ro" "SELECT brand,revision,approved FROM brand_sourcing_strategies;"
sqlite3 "file:$DB?mode=ro" "SELECT domain,status FROM domain_status WHERE domain IN ('bil-jac.com','chickensouppets.com','multipet.com','northstatesind.com','yeowww.com');"
bun -e "import {loadSourcingFlags,loadManualEvidenceFlags} from './src/onboarding/flags.ts'; console.log(JSON.stringify(loadSourcingFlags(process.env))); console.log(JSON.stringify(loadManualEvidenceFlags(process.env)));"
```

## Acceptance mapping

- [x] Each checklist item records verified state plus evidence of where it was observed (§1–§7 with queries, code paths, and runbooks).
- [x] Every gap has a named follow-up (FU-1–FU-5); no enablement changes were needed or made in this ticket.
- [x] Walled-domain routability stated plainly (verdict: none today; mechanical floor ready, qualification unproven; OurPets/Coop & Range closest).
- [x] No production behavior changes (report-only; DB access was read-only, env untouched).
