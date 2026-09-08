# Manual-Evidence Extraction Route for Family-Page-Only Brands — Implementation Plan

**Status:** Plan only — no code.
**Oracle verdict:** Option A — build manual-evidence extraction route for profile-blocked items. Keep distributor/spreadsheet as complement. Family-page URL is reference-only attachment. Reject generic scraping.
**Exemplar:** The Butcher's Pup (family/parent page only, no per-SKU product pages).
**Deliverable path:** `docs/plans/manual-evidence-extraction-route-plan.md` (this file).

Reference ground truth:
- `CONTEXT.md` §§610–780 (Sourcing / Discovery / Extraction / fail-closed / profile-blocked / distributor-record materialization) and §§946–1003 (operating model: Distributor Lookup, Official Site Resolution, Family Readiness Barrier, Durable Review State).
- `src/onboarding/sourcing/distributor-record-materializer.ts` (merchandising-depth, NULL URL, profile-free).
- `src/onboarding/page-extractor.ts` (fail-closed automated extraction, profile-match gate).
- `src/shared/schemas/onboarding.ts` (`SourceTypeEnum`, `ExtractionDataSchema`, sourcing routing contracts).
- `src/classification/stages/evidence-extraction.ts` (frozen-projection evidence emission, source-aware).
- `src/onboarding/extraction-ladder/result-shape.ts` (`PAGE_IDENTITY_STATUSES`, `classifyPageIdentity`).
- `src/classification/review-completion-gate.ts`, `src/db/onboarding-migration.sql`, `src/db/repositories/onboarding-extraction-repo.ts`, `src/onboarding/flags.ts`, `src/client/components/onboarding/attention/OfficialSiteResolutionWorkspace.tsx`, `src/onboarding/extraction/profile-blockers.ts`.

---

## 1. Goal and non-goals

### 1.1 Goal
Give operators an explicit, audited, per-SKU manual path to complete **Extraction** for items that are legitimately stuck as **profile-blocked / extraction-failed** because the brand exposes only a family/parent page (no per-SKU official product page, no healthy extractor profile possible within Profile Scope). The manual route produces a durable `onboarding_extractions` row that:

- keeps `source_type='official_page'` with manual provenance flags (no new `SourceTypeEnum` value — see §2);
- stores **NULL extraction source URL** (never a fake per-SKU URL); the family page URL, if kept, is a **reference-only attachment** on a separate column/table;
- records `identityStatus ∈ {parent_product_only, insufficient_evidence}` (never `exact_match` / `probable_match`);
- carries per-field `fieldProvenance='user'` + `extractionMethod='manual_evidence_v1'` + operator attestation id;
- flows through the existing evidence-provenance → Curation (frozen projection) → Review completeness → rights-attestation gates;
- leaves automated fail-closed extraction, Family Readiness Barrier, and Sourcing→Curation prohibitions intact.

### 1.2 Explicit non-goals / boundaries (MUST NOT touch)
- **No generic scraping fallback.** Do not add heuristic/LLM scraping that produces trusted evidence when no healthy profile matches. `page-extractor.ts` fail-closed gate stays authoritative.
- **No Sourcing→Curation bypass.** Do not create any route, transition, worker branch, or UI action that moves an item from `sourcing/*` to `curation/*`. `bundle_to_curation` remains parse-only/historical.
- **No new SourceTypeEnum value** unless §2 justification reverses (default: reuse `official_page`).
- **No family-inherited facts.** Do not copy family-page title/description/images/ingredients into per-SKU extraction fields. Do not create product-family inheritance, variant-group inference, or cross-SKU field copying.
- **No fake URLs.** Do not synthesize `https://brand/...#sku=...`, `?variant=`, UPC-suffixed, or search-URL extractions. Extraction `source_url` for manual rows is NULL.
- **No auto-degradation.** Automated worker never writes manual rows, never downgrades a blocked item to manual, never retries blocked items into manual.
- **No Family Readiness Barrier weakening.** No per-SKU "curate now" partial-family action. No cohort bypass.
- **No live-DB writes except via the new audited API path** (and never on production data during rollout without verified backup). No network crawls, paid crawls, model downloads, or live embedding requests (project constraint).
- **No dirty-worktree violations:** patch in place, one sequential writer per milestone, never reset/clean/stash/revert/broadly stage; leave outer-repo changes unstaged; the only permitted commit is the exact-path nested `storage/catalog` catalog commit (not used by this plan — this plan writes no catalog config).

---

## 2. Source-type decision (oracle-preferred): keep `official_page` + manual flags

### Decision
**Keep `SourceTypeEnum = ['official_page','distributor_record']` unchanged.** Represent manual-evidence rows as `source_type='official_page'` + all of:

- `extraction_method='manual_evidence_v1'` (new literal, see §5);
- `ExtractionData.sourceType='official_page'`;
- `ExtractionData.fieldProvenance[<every populated field>]='user'`;
- `ExtractionData.identityStatus ∈ {'parent_product_only','insufficient_evidence'}` + non-empty `identityReasons`;
- `ExtractionData.sourceUrl=null` (extraction source URL), family URL only in the new reference-attachment column (§5);
- `onboarding_extractions.sourcing_generation_id=NULL`, `evidence_hash=NULL` (manual rows are not sourcing generations);
- join to a new `onboarding_manual_evidence_attestations` row (operator, timestamp, per-field checklist, rights attestation).

### Why not a new `SourceTypeEnum` value (e.g. `manual_evidence`)
1. `SourceTypeEnum` drives **routing semantics**, not provenance granularity: `official_page` = "operator-asserted official-brand provenance, URL-dispatched, profile-gated"; `distributor_record` = "Sourcing-generation provenance, NULL URL, merchandising-depth, profile-free, skips Discovery" (CONTEXT.md Extraction; `distributor-record-materializer.ts`; `distributor-record-projection.ts`). A manual row is still **official-brand provenance claimed by the operator**, not distributor provenance — it must not inherit distributor-record semantics (no generation, no per-field merchandising provenance, no display-only image pipeline, no OCR skip rule tied to distributor).
2. Every consumer branches on the two-valued enum: `evidence-extraction.ts` frozen/distributor branch, `product-curator.ts`, `cohort-curator.ts` projections (`itemSourceType`/`extractionSourceType`), `job-queue.ts` dispatch, `draft-promoter.ts`, review gates, `migrations.ts` CHECK constraints, `onboarding-migration.sql` CHECK constraints, `onboarding-work-state.ts`, `cohorts.ts` schemas, client `attention-logic.ts`/`OfficialSiteResolutionWorkspace.tsx`. A third enum value requires touching every branch and risks silent `else → official_page` misclassification (fail-open). Additive `extraction_method` + `fieldProvenance` flags are backward-compatible (`passthrough` on `ExtractionDataSchema`) and fail-closed: old code that ignores the flags still sees a valid `official_page` row; new gates that require the flags refuse rows without them.
3. `distributor_record` NULL-URL invariant ("never a fake official URL") is shared with manual rows, but for opposite reasons (distributor: no URL exists; manual: per-SKU URL does not exist, family URL is not the source). Conflating them would let manual rows accidentally satisfy distributor-only gates (e.g. merchandising-depth allowances, OCR skip, profile-free promotion) or let distributor rows satisfy manual-attestation gates. Keep the types distinct by keeping the enum stable and discriminating on `extraction_method + attestation join`.

### Reversal condition (only justification that would force a new enum)
If during Milestone 1 schema audit any **CHECK-constraint, Zod discriminated union, or worker dispatch** is found to treat `source_type='official_page'` as proof that "a healthy profile match existed and automated extraction ran" (i.e. non-nullable `source_url`, non-nullable profile id, or `extraction_method` allowlist that cannot be extended without breaking the discriminator), then introduce `manual_evidence` as a third `SourceTypeEnum` value **and** update every branch above plus all CHECK constraints in the same migration (atomic rebuild with row/ID parity check per `migrations.ts:3788–3873` pattern). Default plan assumes this is not needed; Milestone 1 must produce written evidence (grep + test) that no such assumption exists.

---

## 3. Stage / state transition contract

Authoritative stage order (CONTEXT.md): Sourcing → Discovery → Extraction → Curation → Review → Promotion. Stage advancement for machine stages is exit-contract-driven and auditable; operator judgment enters only via Needs Attention tasks (CONTEXT.md §§946+ operating-model note superseding "always manual" wording for machine progression).

### 3.1 Allowed transitions for the manual route
| From | To | Actor | Precondition (all must hold) |
|---|---|---|---|
| `extraction / failed` with `error_message ~ 'No extractor profile for %'` (profile-blocked) **or** `extraction / failed` with non-profile failure explicitly triaged as family-page-only (operator-confirmed) | `extraction / completed` (manual) | Operator via new audited API only | Flag ON (§9); item in same batch/workspace; no healthy profile match exists at submit time (server re-checks); no qualified distributor record already materialized that would make manual redundant (server warns, requires explicit override reason); per-SKU attestation payload valid; at least the minimum manual field set present (§6); rights attested for every image URL submitted |
| `extraction / completed` (manual) | `curation / pending` | Existing advancement path (operator advances cohort/family when ready; Family Readiness Barrier still applies — §3.3) | Manual extraction row + attestation join exist and verify; Review-completeness pre-checks pass for extraction shape |

### 3.2 Explicitly forbidden transitions (fail-closed, tested in §8)
- `sourcing/*` → `curation/*` (any actor, any flag state) — reject with `sourcing_curation_bypass_rejected`.
- `sourcing/*` → `extraction/completed(manual)` — manual route entry is **only** from `extraction/failed` (blocked/triaged). Sourcing items must go through Discovery or `distributor_record_to_extraction` first.
- `discovery/*` → `extraction/completed(manual)` — Discovery must resolve first (confirm family-page-only + attach reference URL); manual evidence is submitted from Extraction.
- `extraction/pending` (never attempted) → `extraction/completed(manual)` without a prior automated fail-closed failure — reject with `extraction_never_attempted`. Rationale: manual is for blocked/failed items, never a shortcut around attempting automated extraction.
- Worker/auto-retry → manual — the worker, `domain-release.ts` sweep, `job-queue.ts`, and `profile-retry` paths must never write `extraction_method='manual_evidence_v1'`. Only the new operator API path may.
- `extraction/completed(manual)` → `review/*` skipping Curation — must complete Curation (cohort-aware) before Review. Curation consumes the manual row via the frozen projection like any other extraction.
- Any transition that sets an extraction `source_url` to the family page URL — reject with `fake_url_rejected`.

### 3.3 Family Readiness Barrier interaction
- Manual completion of one SKU does **not** release its cohort/family to Curation. `cohort-curator.ts` / `FamilyReadinessCard.tsx` / `FamilyWaitingView.tsx` logic unchanged: the durable candidate cohort waits until **every active member is Extraction-ready** (automated-complete, distributor-complete, or manual-complete). Waiting vs blocked distinction preserved; blocking siblings still deep-link to their Needs Attention task.
- No "curate this SKU now" button. No partial-family Curation flag.

### 3.4 Discovery handling for family-page-only brands
- Discovery confirms the family page URL as the **best available official reference** and stores it as `manual_reference_url` (new; §5), **not** as `onboarding_items.source_url` extraction source and **not** as `brand_url_index` verified per-SKU URL. `brand_url_index` enrichment (`enrichUrlMetadata`) must not mark the family URL as a per-SKU verified page.
- The item still advances Discovery → Extraction (automated extraction attempts → fail-closed profile-blocked) so the audit trail shows the automated path was tried. Only then is manual offered. Exception: if Discovery already proved "no per-SKU page exists" and an automated extraction attempt would be a guaranteed no-op fetch, the plan still requires **one recorded automated attempt** (fail-closed row) before manual — otherwise `extraction_never_attempted` rejects. This preserves "manual only on blocked/failed items."

---

## 4. Milestones / work items (dependency-ordered, one sequential writer)

### Milestone 0 — Safety freeze + scope audit (no behavior change)
**Files to read (no edits except audit notes):** `CONTEXT.md`; `src/shared/schemas/onboarding.ts`; `src/shared/schemas/onboarding-work-state.ts`; `src/shared/schemas/cohorts.ts`; `src/onboarding/page-extractor.ts`; `src/onboarding/extraction/profile-blockers.ts`; `src/onboarding/sourcing/distributor-record-materializer.ts`; `src/onboarding/sourcing/distributor-record-projection.ts`; `src/classification/stages/evidence-extraction.ts`; `src/classification/review-completion-gate.ts`; `src/classification/review-completeness.ts`; `src/db/repositories/onboarding-extraction-repo.ts`; `src/db/repositories/onboarding-item-repo.ts`; `src/db/migrations.ts` (~§3788+ sourcing/extraction migration); `src/db/onboarding-migration.sql`; `src/server/routes/onboarding-routes.ts`; `src/server/routes/onboarding-work-routes.ts`; `src/onboarding/job-queue.ts`; `src/onboarding/flags.ts`; `src/client/components/onboarding/attention/*` (AttentionQueueView, OfficialSiteResolutionWorkspace, ExtractorStatusPanel, attention-logic); `src/client/onboarding-api.ts`.
**Work:**
- Capture binary diffs / `git status` / untracked manifests / HEADs for outer repo + `storage/catalog` (follow classification-plan Milestone 0 pattern). Preserve baseline snapshot; do not stage/commit.
- Produce written audit: every branch on `source_type`, `extraction_method`, `fieldProvenance`, `identityStatus`, `source_url` NULL-ability; every place that assumes `official_page ⇒ profile match existed`. This audit is the §2 reversal evidence.
- Confirm `ClassificationEvidence['source']` union (in `src/shared/schemas/classification.ts` + `src/shared/types.ts`) — whether `operator_manual`/`user` is already representable or needs an additive enum member.
**Acceptance:** audit doc checked into the plan (appendix) listing file:line for each branch; explicit go/no-go on new-enum reversal; `bun run typecheck` clean (no edits).
**Validation:** `bun run typecheck`, `git status --porcelain` (outer repo still dirty-only-preexisting, no new stages).

### Milestone 1 — Shared schemas + migration (backward-compatible, flag-off)
**Files to touch:**
- `src/shared/schemas/onboarding.ts` — additive only:
  - `ManualEvidenceFieldProvenanceValue = 'user'` documented as the required per-field value for manual rows (reuse existing `'user'` literal in `fieldProvenance` comment; no new enum).
  - New `ManualEvidenceExtractionMethodEnum = z.literal('manual_evidence_v1')` (or extend the existing `extractionMethod` string union where it is validated — extraction-worker schema `src/shared/schemas/extraction-worker.ts:323+`, `cohorts.ts:272`).
  - New `ManualEvidenceAttestationSchema`: `{ attestationId, itemId, batchId, operatorId, attestedAt, fieldChecklist: Record<field, {valueHash, sourceKind: 'operator_transcription'|'packaging_photo'|'distributor_sheet'|'brand_family_reference', referenceUrl?: string}>, noFamilyInheritanceAttested: literal(true), perSkuVerificationAttested: literal(true), rightsAttestedForImages: literal(true) when images present, familyReferenceUrl?: url|null, notes?: string(max 2000) }` — all strings bounded.
  - New `SubmitManualEvidenceRequestSchema` (strict, `.strict()` like `ResolveSourcingUseDistributorRecordSchema`): `{ itemId, title, brand?, description?, bulletPoints?, weight?, dimensions?, primaryImage?, additionalImages?, sourceReferenceUrl?: url|null (family page, optional), attestation: { noFamilyInheritance: true, perSkuVerified: true, rightsAttested: true if images, notes? } }` — server ignores/rejects any client-supplied `sourceType/identityStatus/confidence/evidenceIds/provenance` (server-derived only, cf. sourcing resolve pattern).
  - `ExtractionDataSchema`: document manual invariant in comments; add optional `manualEvidenceAttestationId: z.string().nullable().default(null)` + optional `manualReferenceUrl: z.string().url().nullable().default(null)` (reference-only, never consumed as `sourceUrl`). Keep `passthrough` (no breaking change).
- `src/db/migrations.ts` — new migration function (follow `migrations.ts:3788–3873` rebuild pattern if needed; prefer additive-only):
  - `ALTER TABLE onboarding_extractions ADD COLUMN extraction_method` already exists — verify allowlist: if a CHECK constrains it, widen to include `'manual_evidence_v1'` via table rebuild with row/ID parity check (before/after COUNT + ordered id list, throw on mismatch).
  - New table `onboarding_manual_evidence_attestations (attestation_id PK, item_id FK CASCADE, batch_id, operator_id, attested_at, family_reference_url NULL, field_checklist_json NOT NULL, value_hashes_json NOT NULL, created_at)` + index on `item_id`.
  - `ALTER TABLE onboarding_extractions ADD COLUMN manual_attestation_id TEXT NULL REFERENCES onboarding_manual_evidence_attestations(attestation_id)` (nullable; non-null exactly when `extraction_method='manual_evidence_v1'` — enforced by trigger or by repo validation, not by a cross-table CHECK since SQLite cannot do cross-table CHECKs; enforce in `validateAndResolveExtractionInput` + a post-migration verification query).
  - `ALTER TABLE onboarding_items ADD COLUMN manual_reference_url TEXT NULL` (family page reference-only; never read as extraction source).
  - Add verification queries: manual rows must have NULL `source_url`, NULL `sourcing_generation_id`, `source_type='official_page'`; family reference URL must never appear in `onboarding_extractions.source_url` or `onboarding_items.source_url` for manual items (the latter stays NULL or the last attempted URL — decide in M1 and document; default: leave `onboarding_items.source_url` as the last attempted/confirmed URL for blocker grouping, but extraction row URL NULL; the plan must state this explicitly so tests assert it).
- `src/db/onboarding-migration.sql` — mirror the same DDL for fresh-DB bootstrap (new installs must match migrated DBs).
- `src/shared/schemas/extraction-worker.ts` — extend `fieldProvenance`/`fieldProvenanceDetails` validation to accept `method='manual_transcription'` (or `'user'`) without breaking existing validators.
**Behavioral contracts / fail-closed invariants:**
- Zod strict schemas reject unknown keys and client-supplied provenance (`sourceType`, `identityStatus`, `distributorRecordProvenance`, `evidenceHash`, `confidence`).
- DB CHECKs keep `source_type IN ('official_page','distributor_record')` unchanged (no enum widening).
- Migration is idempotent and verifies row/ID parity; any mismatch throws and blocks boot (same pattern as existing extraction rebuild).
**Tests (new files):**
- `src/tests/unit/manual-evidence-schema.test.ts` — asserts: strict request rejects `sourceType`/`identityStatus` smuggling; `fieldProvenance` user-only for manual; attestation literals required; family URL validated as URL-or-null; oversized notes rejected.
- `src/tests/unit/manual-evidence-migration.test.ts` — builds a pre-migration DB snapshot (in-memory or tmp file, never live DB), runs migration, asserts new columns/table exist, old rows unchanged (byte-identical payloads), CHECK constraints intact.
**Acceptance:** `bun run test src/tests/unit/manual-evidence-schema.test.ts src/tests/unit/manual-evidence-migration.test.ts`, `bun run typecheck`, `bun run lint` clean.
**Non-goals in this milestone:** no API, no UI, no worker changes; flag unused.

### Milestone 2 — Server: audited manual-evidence submission + retrieval (flag-gated)
**Files to touch:**
- `src/server/routes/onboarding-routes.ts` (or new `src/server/routes/manual-evidence-routes.ts` mounted from `src/server/app.ts` — prefer new file to minimize blast radius; wire import in `app.ts`):
  - `POST /api/onboarding/items/:id/submit-manual-evidence` — auth via `BAYSTATE_CMS_API_TOKEN` (existing mutating-request pattern); validates `SubmitManualEvidenceRequestSchema`; enforces §3.1 preconditions **server-side** (re-checks item stage/status, profile-match absence via same `findProfileByDomain`/scope/health check the worker uses, generation/attempt state, flag ON); ignores client provenance; derives `identityStatus` (`parent_product_only` when family reference URL present, else `insufficient_evidence`), `identityReasons`, `confidence=0` (manual rows never carry automated confidence), `fieldProvenance=all 'user'`, `sourceUrl=NULL`, `sourceType='official_page'`, `extractionMethod='manual_evidence_v1'`; writes attestation row + extraction row + item transition (`extraction/failed → extraction/completed`, `error_message` cleared or superseded with `manual_evidence:<attestationId>` marker, `manual_reference_url` set) **in one transaction**; writes an auditable history/conflict-style decision row (reuse `onboarding_conflict`/`acceptance` audit pattern or `classificationHistoryEvent` — M2 must pick one and document; do not invent a second audit log).
  - `GET /api/onboarding/items/:id/manual-evidence` — returns extraction row + attestation + reference URL for the drawer (read-only).
  - `POST /api/onboarding/items/:id/withdraw-manual-evidence` (optional but recommended) — operator withdraws a manual row (e.g. profile later becomes healthy): marks attestation superseded, deletes or supersedes extraction row, returns item to `extraction/failed` (profile-blocked) for automated retry. Prevents "manual blocks future automation."
- `src/db/repositories/onboarding-extraction-repo.ts` — extend `validateAndResolveExtractionInput` with the `manual_evidence_v1` branch: requires `sourceUrl===null`, `sourceType==='official_page'`, `sourcingGenerationId===null`, `evidenceHash===null`, `manualAttestationId` non-null and joined; requires `extractionDataJson` parses to `ExtractionDataSchema` with `identityStatus ∈ {parent_product_only, insufficient_evidence}`, `sourceUrl===null`, every populated field in `fieldProvenance==='user'`, `distributorRecordProvenance===null`; throws otherwise (fail-closed). Mirror the existing distributor `NULL URL` error message style.
- `src/db/repositories/onboarding-manual-evidence-repo.ts` (new) — `insertAttestation`, `findAttestationByItem`, `supersedeAttestation`, all parameterized, no raw string interpolation.
- `src/db/repositories/onboarding-item-repo.ts` — add `completeExtractionViaManualEvidence(itemId, attestationId, referenceUrl)` transactional helper (compare-and-swap on `stage='extraction' AND stage_status='failed'`; throws on mismatch so concurrent retries cannot double-complete).
- `src/onboarding/flags.ts` — add `BAYSTATE_CMS_MANUAL_EVIDENCE_ENABLED` fail-closed flag (absent/empty/malformed → disabled; explicit `true|1|yes` → enabled), following `parseEnabledEnv` pattern + in-memory override for tests. Route returns `410/manual_evidence_disabled` when OFF (not silent no-op).
**Behavioral contracts:**
- Server-derived provenance only (cf. `ResolveSourcingUseDistributorRecordSchema` precedent: "server recomputes qualification and IGNORES client ids/hash/providers").
- Idempotency: identical resubmission (same item + same canonical field hashes) replays prior attestation id without duplicating rows (cf. `onboarding-work-routes.ts:379` P1-D pattern).
- Precondition re-check at write time (TOCTOU-safe inside the transaction): profile became healthy between drawer load and submit → reject with `profile_now_healthy_retry_automated` and direct operator to Profile Retry Preview.
**Tests:**
- `src/tests/unit/manual-evidence-api.test.ts` (route-level, tmp DB): happy path writes all three rows atomically; flag OFF rejects; wrong stage rejects (`extraction_never_attempted`, `sourcing_curation_bypass_rejected`); client smuggling (`sourceType`, `identityStatus:'exact_match'`, `sourceUrl`) ignored/rejected; family URL stored only in reference column, extraction URL NULL; concurrent submit is single-winner.
- `src/tests/unit/manual-evidence-repo-guard.test.ts`: `insertExtraction` throws for manual branch violations (non-null URL, distributor provenance present, `identityStatus:'exact_match'`, missing attestation join).
**Acceptance:** new tests pass; existing extraction/sourcing test suites pass unmodified (prove no regression to fail-closed automation); `bun run typecheck/lint` clean.
**Validation commands:** `bun run test src/tests/unit/manual-evidence-*`, `bun run test src/tests/unit/*extraction* src/tests/unit/*sourcing*`, `bun run typecheck`, `bun run lint`.

### Milestone 3 — Curation / evidence-provenance / Review / rights wiring (no barrier change)
**Files to touch:**
- `src/classification/stages/evidence-extraction.ts` — add manual branch in **both** `executeFrozenEvidenceExtraction` and the live path: when `frozen.extractionMethod==='manual_evidence_v1'` (or `extractionSourceType==='official_page'` + attestation present), emit `ClassificationEvidence` with `source='operator_manual'` (or the confirmed union member from M0 audit — M3 implements whichever the M0 audit selected; default new literal) with `sourceUrl=null`, `reliability='low'` (manual transcription is low-reliability by design — requires Review), `metadata={ provenance:'manual_evidence', attestationId, fieldProvenance:'user', manualReferenceUrl (reference-only), per-field value hashes }`. Emit **only** operator-supplied fields (title/description/bullets/weight/dimensions + approved images); never synthesize copy; never emit family-page fields. Distributor branch untouched.
- `src/shared/schemas/classification.ts` + `src/shared/types.ts` — add the manual evidence source literal if missing (additive union member) + `reliability:'low'` allowance; update `packagingOcrDataToEvidence` comments (manual rows: no OCR expected; packaging photos are operator-supplied evidence, not VLM OCR).
- `src/classification/review-completion-gate.ts` — add manual-specific refusal codes (fail-closed, additive checks only; no existing check loosened):
  - `manual_attestation_missing` (manual extraction row without joined attestation);
  - `manual_attestation_incomplete` (any required literal not `true`, field checklist hash mismatch vs extraction payload);
  - `manual_family_inheritance_suspected` (any manual field value equals family-page text fetched at review time — M3 implements a bounded exact-match comparison against the stored family reference snapshot if available; never a network fetch at gate time);
  - `manual_image_rights_missing` (manual `primaryImage`/`additionalImages` non-empty without per-image rights attestation row with `rightsAttested:true, approvalOrigin:'operator_review'` — reuse `DistributorImageApprovalSchema` shape with a manual approval origin; do not reuse distributor attempt ids).
- `src/classification/review-completeness.ts` — manual evidence counts as **provided-but-unreviewed** (never auto-reviewed); abstention-correction rules apply unchanged.
- `src/onboarding/product-curator.ts` + `src/onboarding/cohort-curator.ts` — title-synthesis ordering: manual title is eligible as `titleSource='manual'` (existing `CurationData.titleSource` enum already includes `'manual'` — wire it; no schema change needed) but never overrides the fail-closed synthesis assertion (PR8 C3) and never bypasses cohort semantic validation (`family_product_type`, `coordinated_title`, `coordinated_page` checks still block on mismatch — manual rows get no exemption).
- `src/onboarding/draft-promoter.ts` — manual rows promote like any `official_page` row (no special path); the existing per-item fail-closed check after the run pointer covers manual rows without modification; image promotion requires the manual rights-approval join (same refusal as gate).
**Tests:**
- `src/tests/unit/manual-evidence-curation.test.ts` — frozen projection with manual row emits only manual-source evidence with null URL + attestation metadata; distributor/official branches byte-identical to pre-change snapshots; tampered attestation hash → gate refuses (`manual_attestation_incomplete`); `exact_match` manual payload → repo/gate refuses (never promotable); family-text-copied field → `manual_family_inheritance_suspected`; image without rights → `manual_image_rights_missing`.
- Update `src/tests/unit/shopsite-normalizer.test.ts`? No (out of scope — no ShopSite fields added).
**Acceptance:** curation + gate suites pass; no existing gate code loosened (diff review must show only additive refusals + one new evidence branch).

### Milestone 4 — UI: Needs Attention + Official Site Resolution (flag-gated, no auto-paths)
**Files to touch:**
- `src/client/components/onboarding/attention/attention-logic.ts` — add `attentionReason='manual_evidence_available'` (profile-blocked + family-page-only triage) vs existing `choose_variant`/`profile_blocked` reasons; `getAttentionConsequence` text: "Enter product facts manually (per-SKU attestation required). Family page is reference only."
- `src/client/components/onboarding/attention/AttentionQueueView.tsx` + `AttentionRow.tsx` — surface the new reason with distinct copy and a **"Enter manual evidence"** action (flag-gated; hidden when flag OFF). No bulk action. No auto-suggest.
- `src/client/components/onboarding/attention/OfficialSiteResolutionWorkspace.tsx` — new `phase='manual'` drawer section (after `extractor` phase): per-SKU form (title required; brand/description/bullets/weight/dimensions optional; images optional with per-image rights checkbox + source-kind selector per field: operator_transcription / packaging_photo / distributor_sheet / brand_family_reference-viewed); family reference URL field (optional, URL-validated, labeled "Reference only — not the extraction source"); three mandatory checkboxes (no family inheritance / per-SKU verified / image rights) + notes; submit → `POST submit-manual-evidence`; success shows attestation id + "return to Extraction-complete" state; profile-became-healthy error directs to Profile Retry Preview. Also add **"Withdraw manual evidence"** button when a manual row exists.
- `src/client/onboarding-api.ts` — `submitManualEvidence`, `getManualEvidence`, `withdrawManualEvidence` typed clients.
- `src/client/components/onboarding/attention/ExtractorStatusPanel.tsx` — when item is profile-blocked and flag ON, show manual option as an explicit alternative (not a default); when flag OFF, no manual copy at all.
- `ProfileRetryPreview.tsx` — manual-completed items excluded from retry-by-default selection (avoid clobbering manual work); operator can still withdraw-then-retry per item.
**Behavioral contracts:** UI never submits provenance (only raw fields + booleans + reference URL); UI never offers manual outside `extraction/failed` blocked/triaged items; UI never bulk-submits; family URL input labeled reference-only in two places (field label + submit confirmation).
**Tests:**
- `src/tests/unit/manual-evidence-attention-logic.test.ts` — reason mapping + consequence copy; flag OFF hides action (component test or logic-level flag test).
- Manual QA script (no automation): load a Butcher's-Pup-like blocked item, submit manual, verify drawer success + queue row clears, withdraw restores blocked state.
**Acceptance:** `bun run test` clean; visual review of drawer copy (reference-only labeling present twice).

### Milestone 5 — Rollout, runbook, backfill policy (flag OFF by default)
**Files to touch/create:**
- `docs/runbooks/manual-evidence-rollout.md` (new) — flag semantics, read-only observation queries (count blocked-by-domain, count manual rows, attestation coverage, gate refusal codes), enable/disable procedure (env var + restart; no migration rollback needed since additive), withdraw procedure, backup requirement before any live-DB manual submission (`sqlite-backup-verifier` pattern), incident rollback (flag OFF immediately stops new submissions; existing manual rows stay gated by Review and can be withdrawn per item).
- Env wiring: document `BAYSTATE_CMS_MANUAL_EVIDENCE_ENABLED=true|1|yes` (case-insensitive, trimmed; absent/empty/malformed → disabled) in `.env.example` if present (check; do not commit secrets).
- Backfill policy: **no backfill.** Legacy rows (marker-v0, 148 rows), existing `extraction/completed` rows, and existing distributor rows are never converted to manual. Manual applies only to new operator submissions on currently-blocked items.
- Distributor/spreadsheet complement (per oracle): where a distributor record exists for the same SKU, the drawer shows it side-by-side as **reference** (read-only) and the operator may transcribe values field-by-field with `sourceKind='distributor_sheet'` per-field provenance — but this never auto-fills, never copies wholesale, and never creates a `distributor_record` linkage (no generation id, no attempt ids on the manual row).
**Tests:** runbook queries tested against tmp DB fixture (assert counts/refusals).
**Acceptance:** runbook merged; flag verified OFF in all non-test envs; `bun run test` full suite passes.

---

## 5. Schema + migration detail (normative)

### 5.1 `ExtractionData` manual shape (server-derived, never client-supplied)
```text
sourceType                  = 'official_page'          (unchanged enum)
sourceUrl                   = null                     (extraction source URL — always NULL for manual)
confidence                  = 0                        (no automated confidence)
fieldProvenance[f]          = 'user' for every populated f in {title,brand,description,bulletPoints,weight,dimensions,primaryImage,additionalImages}
distributorProviderId       = null
distributorEvidenceAttemptIds = []
distributorProviderIds      = []
distributorImageCandidates  = []                       (manual images are NOT distributor candidates)
distributorRecordProvenance = null
identityStatus              = 'parent_product_only'    (family reference URL attached) | 'insufficient_evidence' (no reference URL)
identityReasons             = ['operator manual transcription; family page is reference-only, not the extraction source', ...]
manualEvidenceAttestationId = <attestation UUID>       (new, required for manual rows)
manualReferenceUrl          = <family URL|null>        (new, reference-only mirror of the attestation column; never read as sourceUrl)
packagingOcrData / ocrOutcome = null                   (manual rows do not fabricate OCR)
selectedVariant / variantProvenance = absent unless a variant matrix was actually resolved (family-page-only brands normally absent)
productIntelligenceEvidence = []                       (never conflated)
```

### 5.2 `onboarding_extractions` row (manual)
```text
source_type='official_page', source_url=NULL, extraction_method='manual_evidence_v1',
sourcing_generation_id=NULL, accepted_evidence_attempt_ids_json=NULL, evidence_hash=NULL,
manual_attestation_id=<FK, NOT NULL for this method>, confidence=0.0
```

### 5.3 `onboarding_manual_evidence_attestations` row
```text
attestation_id PK, item_id FK, batch_id, operator_id, attested_at ISO,
family_reference_url NULL (URL-or-null, reference-only),
field_checklist_json NOT NULL (per-field {sourceKind, valueHash}),
value_hashes_json NOT NULL (canonical SHA-256 per field, server-computed),
superseded_at NULL | ISO
```

### 5.4 `onboarding_items` delta
- `manual_reference_url NULL` (family reference mirror; never consumed by extractor, discovery, or `brand_url_index`).
- Stage transition `extraction/failed → extraction/completed` only via `completeExtractionViaManualEvidence` CAS helper.

### 5.5 CHECK / invariant summary (enforced in repo + migration verification, not all expressible as SQLite CHECKs)
- `onboarding_extractions.source_type IN ('official_page','distributor_record')` — unchanged.
- `extraction_method='manual_evidence_v1' ⇒ source_type='official_page' AND source_url IS NULL AND sourcing_generation_id IS NULL AND manual_attestation_id IS NOT NULL` — enforced in `validateAndResolveExtractionInput` (throw) + post-migration verification query (fail boot on violation).
- `manualReferenceUrl IS NOT NULL ⇒ identityStatus='parent_product_only'`; `manualReferenceUrl IS NULL ⇒ identityStatus='insufficient_evidence'` — enforced in API derivation (client cannot set either).
- `identityStatus='exact_match'|'probable_match'` + `extraction_method='manual_evidence_v1'` ⇒ throw (never exact).
- Cross-table: every manual extraction has exactly one non-superseded attestation — enforced by repo join check at write and at gate time (fail-closed on missing/tampered).

---

## 6. Minimum manual field set + per-field rules

- **Required:** `title` (non-empty, ≤500 chars, must not equal family page title verbatim — server enforces non-equality against the stored family reference snapshot when available; otherwise operator attests), plus all three attestation booleans `true`.
- **Optional:** `brand`, `description` (≤4000), `bulletPoints` (≤10 × ≤500), `weight` (canonicalized via existing `normalizeWeightToLbs`/`convertToLbs` — unparseable ⇒ field absent, not raw text), `dimensions`, `primaryImage` + `additionalImages` (each valid `http(s)` URL, each requiring per-image rights attestation; distributor display-only images are not auto-imported).
- **Forbidden in manual payload:** `price`/`quantity`/`inventory` (trusted price comes from import/spreadsheet per Profile Health rule — "Price extraction is not required when the imported product provides the trusted price"), `distributorSku`/`manufacturerPartNumber` unless transcribed with `sourceKind='distributor_sheet'` and shown as operator transcription (never as distributor provenance), any `variantAttributes` unless the SKU's own packaging confirms them (family-level variant lists are not per-SKU facts).
- **Per-field provenance:** every populated field records `{sourceKind, valueHash}` in the attestation checklist; `fieldProvenance` in extraction JSON is uniformly `'user'` (matches existing `'user'` literal documented in `ExtractionDataSchema` comment: "Tracks where each field came from: 'json-ld', 'meta', 'html', 'ai', 'user'").
- **Curation title source:** manual title flows as `titleSource='manual'` in `CurationData` (enum already supports it) and `curationMethod` stays `'auto'` unless a reviewer later hand-edits curation (then `'manual'` per existing semantics — do not conflate extraction-manual with curation-manual).

---

## 7. Audit / provenance / rights chain (end-to-end)

1. **Submission audit:** attestation row (who/when/what-hashes) + extraction row (`manual_evidence_v1` + attestation FK) + item history event, all in one transaction. Resubmission is idempotent on canonical field hashes.
2. **Evidence provenance:** `evidence-extraction.ts` manual branch emits `ClassificationEvidence(source='operator_manual', sourceUrl=null, reliability='low', metadata={attestationId, valueHashes, manualReferenceUrl})` from the **frozen** projection (never live re-read), preserving frozen-vs-live snapshot discipline (ADR 0004/0013).
3. **Review completeness:** `validateReviewCompletionGate` additive refusals (§3-M3) ensure manual items cannot complete Review without intact attestation, non-inherited fields, and image rights. `Durable Review State` (`not_ready/unreviewed/reviewed/approved`) applies unchanged; editing a reviewed manual product invalidates review when the edited field affects approved output (existing rule).
4. **Rights attestation:** manual images require per-image `{imageUrl, rightsAttested:true, approvalOrigin:'operator_review', attestedBy, attestedAt}` (extend `DistributorImageApprovalSchema` approvalOrigin union additively with `'manual_operator_attestation'` or reuse `'operator_review'` — M1 decides; default reuse to minimize schema churn, with `sourceAttemptIds=[]` explicitly allowed for manual). Unattested images block Review and are excluded from `draft-promoter.ts` image assignment (fail-closed, same as distributor display-only rule).
5. **No silent promotion:** `draft-promoter.ts` consumes manual rows through the standard path; its post-run-pointer per-item fail-closed check plus the gate refusals above are the enforcement (no new promotion branch).

---

## 8. Test requirements (files + what each asserts)

| File | Asserts |
|---|---|
| `src/tests/unit/manual-evidence-schema.test.ts` (M1) | Strict request rejects smuggled `sourceType/identityStatus/confidence/distributorRecordProvenance/sourceUrl`; attestation literals required; family URL url-or-null; bounds enforced. |
| `src/tests/unit/manual-evidence-migration.test.ts` (M1) | Fresh + migrated DBs match; old rows byte-identical; CHECKs intact; new table/columns present. |
| `src/tests/unit/manual-evidence-api.test.ts` (M2) | Flag OFF → reject; `sourcing/*` → reject (`sourcing_curation_bypass_rejected`); `discovery/*` → reject; `extraction/pending`-never-attempted → reject (`extraction_never_attempted`); happy path atomic (3 rows); extraction URL NULL + reference column set; profile-became-healthy → `profile_now_healthy_retry_automated`; identical resubmit idempotent; concurrent submits single-winner. |
| `src/tests/unit/manual-evidence-repo-guard.test.ts` (M2) | `insertExtraction` manual branch throws on: non-null URL, non-`official_page` type, generation/evidence-hash present, missing attestation FK, `identityStatus exact_match/probable_match`, any `fieldProvenance≠'user'`, any distributor provenance present. |
| `src/tests/unit/manual-evidence-failclosed-preserved.test.ts` (M2) | Automated `page-extractor` still fail-closes with no profile (no generic fallback); worker/`domain-release` sweep never writes `manual_evidence_v1` (assert via method allowlist grep-test + behavioral test with healthy-profile fixture still auto-extracting). |
| `src/tests/unit/manual-evidence-curation.test.ts` (M3) | Frozen manual projection emits only `operator_manual`/null-URL/low-reliability evidence with attestation metadata; official/distributor projections byte-identical to snapshots; gate refuses tampered attestation / exact_match manual / family-copied field / unattested image with the exact codes in §3-M3. |
| `src/tests/unit/manual-evidence-attention-logic.test.ts` (M4) | New attention reason mapping + consequence copy; flag OFF hides the action; manual-completed items excluded from retry-preview default selection. |
| Rollback/runbook queries (M5) | Tmp-DB fixture asserts observation queries return correct counts and refusal-code breakdown. |

**Regression rule:** all pre-existing extraction/sourcing/curation/gate suites must pass unmodified. Any modification to an existing test to accommodate manual rows is a red flag requiring written justification in the PR (fail-closed preserved proof).

---

## 9. Rollout (behind flag, default OFF)

- **Flag:** `BAYSTATE_CMS_MANUAL_EVIDENCE_ENABLED` — `true|1|yes` (trimmed, case-insensitive) enables; absent/empty/whitespace/malformed disables (same fail-closed parse as `BAYSTATE_CMS_SOURCING_ENABLED` in `src/onboarding/flags.ts` + in-memory test override).
- **Sequence:** land M1 (schemas+migration, inert) → M2 (API, flag OFF in all envs; test ON only in tmp-DB tests) → M3 (gates, still OFF) → M4 (UI hidden unless flag ON) → M5 runbook → enable flag in **one non-production env**, exercise one Butcher's-Pup-like blocked item end-to-end (submit → Curation cohort → Review → withdraw → automated retry), verify audit rows + gate refusals, then decide on production enablement. No backfill at any step.
- **Kill switch:** unset/empty the env var + restart → new submissions reject immediately; in-flight Curation/Review of already-submitted manual rows continues under existing gates (no silent invalidation); per-item withdraw remains available.
- **Backups:** verified SQLite backup before enabling in any env with real data (follow `sqlite-backup-verifier` pattern); no live-DB writes during development except the sanctioned single-item pilot path with backup first.

---

## 10. Validation commands (per milestone)

```bash
bun run typecheck
bun run lint
bun run test src/tests/unit/manual-evidence-schema.test.ts src/tests/unit/manual-evidence-migration.test.ts
bun run test src/tests/unit/manual-evidence-api.test.ts src/tests/unit/manual-evidence-repo-guard.test.ts src/tests/unit/manual-evidence-failclosed-preserved.test.ts
bun run test src/tests/unit/manual-evidence-curation.test.ts src/tests/unit/manual-evidence-attention-logic.test.ts
bun run test src/tests/unit/*extraction* src/tests/unit/*sourcing* src/tests/unit/*curation* src/tests/unit/*review* src/tests/unit/*gate*
bun run test
git status --porcelain  # outer repo: only intended files; no catalog commit from this plan
```

---

## 11. Residual risks (conservative, fail-closed)

1. **Operator transcription error** (wrong title/weight for a SKU with no per-SKU page to cross-check). Mitigated by: per-SKU attestation, low-reliability evidence tier (always requires human Review), value hashes, distributor-sheet side-by-side reference, Review gate hash re-verification. Residual: human error still possible — accepted because Review is mandatory and promotion re-verifies.
2. **Family-text laundering** (operator pastes family description as SKU description despite attestation). Mitigated by verbatim-equality refusal + `manual_family_inheritance_suspected` gate + notes field for justification. Residual: paraphrased inheritance is undetectable deterministically — accepted; Review human judgment is the backstop, and the attestation creates accountability.
3. **Reference URL drift** (family page changes after attestation). Mitigated by storing the reference URL + value hashes at submit time and never re-fetching at gate time (no network in gates). Residual: reference snapshot may go stale — accepted; it is reference-only, never evidence.
4. **Manual-as-shortcut pressure** (operators prefer typing over fixing profiles). Mitigated by entry restricted to `extraction/failed` blocked/triaged items, one-recorded-automated-attempt requirement, no bulk action, per-SKU attestation friction, and observation queries that make manual volume visible. Residual: domain-level profile debt could accumulate — accepted; runbook tracks manual-per-domain counts as profile-priority signal.
5. **Enum-reuse confusion** (`official_page` rows of two provenances). Mitigated by mandatory `extraction_method + attestation join` discriminator and repo/gate enforcement. Residual: a future query that filters only on `source_type` without the method discriminator could conflate them — accepted; M0 audit + code comments at every `source_type` branch must note the discriminator.

---

## 12. Acceptance criteria (ship/no-ship)

- [ ] Butcher's-Pup-like profile-blocked item completes Extraction **only** via explicit operator submission with three `true` attestations; automated worker alone never completes it.
- [ ] Manual extraction row: `source_type='official_page'`, `source_url=NULL`, `extraction_method='manual_evidence_v1'`, `identityStatus ∈ {parent_product_only, insufficient_evidence}`, all `fieldProvenance='user'`, attestation FK present; family URL appears **only** in reference columns.
- [ ] `sourcing→curation`, `sourcing→manual`, `discovery→manual`, never-attempted→manual, worker→manual, and family-URL-as-sourceURL are all rejected with distinct codes (tested).
- [ ] Manual item completes Curation (cohort-aware, barrier intact) → Review (additive gates pass) → Promotion (standard path, rights-verified images only).
- [ ] Full `bun run test`, `typecheck`, `lint` green; no existing test modified without written justification; worktree/commit hygiene per project constraints.
- [ ] Rollout runbook exists; flag OFF by default in every real env; no backfill performed.

---

## Appendix A — Exact file touch list (normative)

**Create:** `docs/runbooks/manual-evidence-rollout.md`; `src/db/repositories/onboarding-manual-evidence-repo.ts`; `src/server/routes/manual-evidence-routes.ts` (or fold into `onboarding-routes.ts` — new file preferred); `src/tests/unit/manual-evidence-{schema,migration,api,repo-guard,failclosed-preserved,curation,attention-logic}.test.ts`.
**Modify:** `src/shared/schemas/onboarding.ts`; `src/shared/schemas/extraction-worker.ts`; `src/shared/schemas/classification.ts` (+`src/shared/types.ts` if the evidence source union lives there); `src/db/migrations.ts`; `src/db/onboarding-migration.sql`; `src/db/repositories/onboarding-extraction-repo.ts`; `src/db/repositories/onboarding-item-repo.ts`; `src/onboarding/flags.ts`; `src/classification/stages/evidence-extraction.ts`; `src/classification/review-completion-gate.ts`; `src/classification/review-completeness.ts` (comments/minimal); `src/client/components/onboarding/attention/{attention-logic,AttentionQueueView,AttentionRow,OfficialSiteResolutionWorkspace,ExtractorStatusPanel}.tsx`; `src/client/onboarding-api.ts`; `src/client/components/onboarding/attention/ProfileRetryPreview.tsx` (exclusion only); `src/server/app.ts` (route mount).
**Do not touch:** `src/onboarding/page-extractor.ts` (except comments referencing the new error code if needed); `src/onboarding/sourcing/*` (except read-only side-by-side display in the drawer); `src/onboarding/job-queue.ts`; `src/onboarding/extraction/domain-release.ts`; `src/classification/stages/*` (except evidence-extraction); `storage/catalog/**`; ShopSite normalizer/parser; live DBs.

## Appendix B — Oracle-constraint traceability

| Oracle constraint | Plan location |
|---|---|
| Manual-evidence route for profile-blocked items (Option A) | §§1, 3.1, M2/M4 |
| Distributor/spreadsheet as complement, family URL reference-only | §§1.1, 3.4, 5.1/5.3/5.4, M5 |
| Reject generic scraping | §§1.2, M2 failclosed-preserved test, §8 |
| Preserve fail-closed automated extraction | §§1.2, 3.2, M2/M3, §8 |
| No Sourcing→Curation bypass | §§1.2, 3.2, M2 tests |
| No fake URLs (reference ≠ source) | §§1.1, 3.2, 5.1/5.2, M2 tests |
| No family-inherited facts / no product-family data | §§1.2, 6, M3 gate `manual_family_inheritance_suspected` |
| Per-SKU operator attestation | §§1.1, 5.3, 6, 7 |
| Family Readiness Barrier intact | §§1.2, 3.3 |
| Prefer `official_page` + manual flags over new enum; justify if new enum | §2 (+ M0 reversal evidence) |
| Family URL if retained ⇒ `parent_product_only`/`insufficient_evidence`, never `exact_match` | §§1.1, 5.1, 5.5, M2/M3 tests |
| Explicit audited operator action on blocked/failed items, never auto-degradation | §§3.1/3.2, M2 (CAS + idempotency + TOCTOU re-check) |
| Complete Extraction manually before Curation | §§3.1, 3.2 (no skip transitions) |
| Route manual fields through evidence-provenance + Review completeness + rights attestation | §§7, M3 |

*End of plan.*
