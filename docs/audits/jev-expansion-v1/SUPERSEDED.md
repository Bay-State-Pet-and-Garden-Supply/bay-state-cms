# SUPERSEDED — do not use for adjudication or gold

`pool-manifest.json` in this directory is **quarantined, not deleted**
(manifest bytes untouched for audit trail).

**Reason (owner, 2026-10-06):** the storefront catalog this pool was
sampled from is untrustworthy and mostly incomplete — PF slot values are
not a source of truth and must not anchor gold, labels, or testing.

**Consequence:**
- No entry in `pool-manifest.json` may be adjudicated into gold, used as
  a test fixture, or cited as evidence of store state.
- The sampler (`scripts/sample-expansion-pool.ts`) is retained for
  post-repair re-sampling only, after storefront completeness is restored
  and re-verified. It must not be re-run against the current catalog for
  qualification purposes.

**Replacement direction:** corpus expansion re-sources from official brand
pages (`PUBLIC:` populations, v9 methodology: extractor profiles per
domain, peer-receipted freezes, new generations supersede) — see
`sourcing-worklist.md` in this directory for the per-type quota plan.
Distributor-record materialization (profile-free, URL-null) remains an
option for strata where official pages are unavailable.
