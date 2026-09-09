# Candidate 2 — typed MerchandisingFieldSpec read model

## 1. Decision, authority, and narrow goal

**Status:** implementation-ready plan; implementation is not authorized by this document alone. Planning baseline: HEAD `589e361b9aaad4bea77e95f1a614e9e6cdbb4f09`; the worktree was clean when inspected. This planning task writes only this document. No source changes, tests, database operations, staging, commits, or pushes were performed.

**Binding decision:** the supplied Oracle verdict selects Candidate 2 first, in the order **2 → 4 → 3 → 1**, narrowly as a **composed, read-only field specification**, not a new configuration authority. Candidate 4 is a possible subsequent read-only inspection/navigation project, not a work item here.

**Problem:** settings and catalog presentation repeatedly associate Catalog Fields with Attribute Mappings, Product Attributes, and Curation Targets, then apply subtly different presentation rules. Introduce one typed, pure composition seam and explicit compatibility projections. Preserve successful existing settings/catalog behavior; make incomplete inputs and provenance distinguishable inside the new model. Do not replace classification, validation, serialization, or execution decisions.

### Evidence and corrections to the architecture review

References below were inspected at the baseline above. `E#` references elsewhere in this plan point to this evidence table; proposed behavior is explicitly a contract, not a claim about existing code.

| Ref | Verified evidence | Consequence for this plan |
|---|---|---|
| E1 | `src/classification/curation-targets.ts:177–260`, particularly `193–247` | Real duplication: registry/discovered fields are joined to mappings, targets, attributes, and observations. Candidate values are a presentation union, not exclusively configured allowed IDs. |
| E2 | `src/server/routes/catalog-routes.ts:128–194`, especially `136–180`; adjacent detail metadata at `199–230` and response at `277–297` | Real duplication: catalog metadata assembly. The list loads configuration twice; detail repeats the metadata join. Stats remain a separate concern. |
| E3 | `src/client/components/catalog-workbench/CatalogFieldsView.tsx:48–95` | Real duplication: fallback composes registry, mappings, and targets from independent responses, substitutes absent data, and has different stale/warning defaults from the server. |
| E4 | `src/client/components/catalog-workbench/TypesAttributesView.tsx:14–36,107–125` | This component consumes **one config response** and locally joins attributes/mappings; it does not fetch four independent authorities. Leave it unchanged in the first rollout. |
| E5 | `src/classification/controlled-value-identity.ts:32–71,91–156,164–170`; ADR 0012 | Identity, collision detection, canonical options, and alias resolution already exist. Reuse them; do not implement another normalizer or resolver. |
| E6 | `src/classification/curation-target-resolver.ts:124–181`; `src/classification/runtime-snapshot.ts:119–150,172–195`; ADR 0013, PR3 M2/PR5 amendments | Snapshot target resolution already consumes frozen, target-ID-keyed options. It must not start using settings candidates or live registry metadata. |
| E7 | `src/classification/release-validation.ts:717–764`; `src/classification/config-validation.ts:247,700–746,823–835` | Export-disposition agreement and controlled-value/profile-alias validation already have owners. This seam neither replaces nor relaxes them. |
| E8 | `src/classification/release-compiler.ts:69–98,108–159` | V4/V5 compiler derives Product Types/profiles and Curation Targets. Targets are not a fourth independent V5 configuration file. The profile expansion is about 30 lines, not 329. |
| E9 | `src/db/repositories/field-registry-repo.ts:3–25,30–38`; `src/server/services/field-metadata-service.ts:194–200,332` | Registry DB rows remain canonical metadata. The actual canonical service implementation is **`src/server/services/field-metadata-service.ts`** (`updateFieldMetadata`/`bootstrapSyncRegistry`); the supplied repository citation documents that service, rather than implementing it. No registry writes here. |
| E10 | ADR 0011; `src/shopsite/built-in-output-policy.ts:12–15,23–31,80–101` | ShopSite built-in omission/default/encoding/cardinality policy remains immutable and adapter-owned. ProductField values are not built-ins. No output-policy ownership moves into field specs. |
| E11 | `src/shared/schemas/classification.ts:67–98,139–171,176–193,452–541`; `src/classification/effective-curation-type.ts:118–149` | Attributes alone do not determine profile cardinality, applicability conditions, aliases, or effective type/profile selection. Legacy/v2 serialization shapes also differ. Preserve those distinctions. |
| E12 | `CONTEXT.md:99–113,123–174,446–462`; ADRs 0001 and 0006 | Product Attribute, Catalog Field, mapping, profile, value mode, cardinality, and alias are distinct concepts. Configuration stays versioned in the workspace; no new persisted field-spec authority. |
| E13 | `src/classification/release-authoring.ts:323–404`; `scripts/classification-author-release.ts:1–15` | Candidate 1 is partly implemented already. Do not include authoring, publishing, release edits, or pin changes. |
| E14 | `src/classification/curation-targets.ts:43–148,150–175`; `src/server/routes/catalog-routes.ts:13–64`; `src/client/components/catalog-workbench/types.ts:17–43` | Existing settings normalization/pipe splitting/limits, catalog raw histogram inference, enabled-target helpers, and public DTO shapes are compatibility contracts, not one universal option policy. |
| E15 | `src/server/routes/classification-routes.ts:169–196`; `src/client/onboarding-api.ts:835–868,911–913`; `src/client/api.ts:303–305,703–716` | Settings GET already receives one loaded config; write endpoints are frozen. Existing client API functions and duplicated candidate DTOs can be retained/re-exported without adding endpoints. |
| E16 | `docs/plans/classification-system-implementation-plan.md:7–47`; ADRs 0001, 0006, 0013 | Preserve worktree, single writer, canonical ownership, immutable execution inputs, and offline constraints. The older plan's scoped catalog-commit allowance is **not exercised** by this task. |
| E17 | `src/server/routes/field-registry-routes.ts:19–44`; `src/classification/config-loader.ts:723–749,760–785,825–846`; `src/classification/catalog-evidence.ts:391–417`; `src/server/services/field-metadata-service.ts:150–178`; `src/classification/release-shadow.ts:138–150` | Existing acquisition paths are not universally side-effect-free: registry GET can repair attestation; config loading can repair/clear registry projection state or append shadow observations. **Pure composition is not a certification that these legacy HTTP acquisitions are pure.** Do not invoke them against the live workspace during validation. |

Architecture-review source: `/var/folders/09/psvh1gl520384nntp58c2lrr0000gn/T/architecture-review-20260909-021900.html:147–238,432–438`. Its “unify”/`getFieldSpec(attributeId)` diagram and immediate runtime leverage are deliberately narrowed by the Oracle decision: **compose ownership, expose scoped information, and adopt settings/catalog first**. E4, E5–E8, and E13 supersede its duplication/scope implications. No supplied source path was missing; the canonical-service location correction is recorded in E9. `/tmp/*.md` was inventoried/searched; no Candidate-2-specific scout audit was found. Evidence is direct inspection, not an asserted scout consensus.

## 2. Hard boundaries

1. **Pure seam:** accepts supplied data, returns newly owned deeply readonly data, performs no DB/filesystem/network/cache/clock/environment reads, and has no write methods or global mutable cache. It must be importable in a browser without pulling in Bun, repositories, config loaders, or runtime services. E5/E6/E16.
2. **No authority merger:** registry metadata, configuration definitions/mappings, profile context, target metadata, and store observations remain separate source lanes. No inferred mapping, synthesized attribute, repaired registry entry, normalized configuration write, or generated target. E7–E12.
3. **No execution eligibility:** a field spec is not approval to propose, serialize, export, or promote a value. `isCurationTarget`, `isStale`, `required`, and `editable` are source metadata, not a combined permission. E6/E10/E11.
4. **No runtime adoption in the first delivery:** do not modify snapshot creation, frozen options, target resolution, effective type/profile resolution, stages, review, promotion, or model policies. In particular, do not alter `resolveAttributeAllowedValues`, `getExplicitCurationTargets`, `resolveEnabledTargets`, or `resolveTargetsFromSnapshot`. E6/E14.
5. **Preserve dirty worktrees:** implementation must recheck status and preserve changes that appeared after planning; one sequential writer, exact files only. No reset/clean/stash/broad revert, staging, commits, or pushes. No canonical catalog commit is needed. E16 plus this task's narrower authority.
6. **Offline/test-only validation:** no network, paid crawl, model calls/downloads, live server startup, live DB writes, repair, activation, or release commands. Any separately authorized future live repair/activation requires verified backups first; none is authorized here. Existing GET side effects are an explicit reason to use injected fixtures/mocks, not a reason to bypass freshness validation. E17.

## 3. Proposed seam — API specification, not implementation

### Module layout

**Create:**

- `src/shared/schemas/merchandising-field-spec.ts`: read-model types and small boundary schemas. Reuse existing classification/registry schemas and types; do not change configuration envelopes or parse v2 through legacy schemas. Include shared existing-shape `CatalogFieldSummary` and `ProductFieldCurationCandidate` DTO definitions for compatibility projections.
- `src/classification/merchandising-field-spec.ts`: pure composition/indexing and explicit lookups. Runtime value imports are limited to browser-safe schema/identity utilities.
- `src/classification/merchandising-field-spec-projections.ts`: pure, named settings/catalog compatibility projections; the only location that flattens the model into existing presentation DTOs.

These are ephemeral read models, not files in `store/classification`, not a repository, and not a replacement “service” that loads its own authorities. E9/E12/E16.

### Input contracts

All supplied arrays/objects are deeply readonly. `ReadSlice<T>` is a discriminated union: **available** with an ordered readonly row array, or **unavailable** with a bounded reason (`not_loaded`, `source_failed`, `invalid_payload`). An available empty array and unavailable data must never be interchangeable.

| Type | Required shape and meaning |
|---|---|
| `MerchandisingFieldSpecInput` | `configuration`, `registry: ReadSlice<RegistryMetadata>`, ordered `discoveredCatalogFields`, and observations keyed by exact Catalog Field name. No workspace path, repository, fetch function, or lazy supplier. |
| `ConfigurationReadInput` | Discriminated union: `complete` with the caller's already-loaded `ClassificationConfig` **or** `ClassificationConfigBundleV2`; `references_only` with independently available mapping references and target slices; or `unavailable`. A reference-only response must not be represented as an empty complete configuration. |
| Complete configuration metadata | Preserve original schema version and all relevant typed attributes, profiles, product-type/profile pointers, mappings, targets, and optional export disposition. Use a v1/v2 discriminant/union; never cast v2 serialization to legacy `format` or discard v2-only metadata. Classification release extras outside this read model remain untouched. E8/E11. |
| `MappingReference` | `id`, `attributeId`, `catalogField`, `isStale`. Reference-only inputs explicitly have **unknown serialization**, not an invented default. This suffices for the existing fallback responses. E3/E15. |
| `RegistryMetadata` | Read-only projection of `FieldRegistryRow`: exact `xmlField`, label, kind, dataType, editable, required, uiGroup, and nullable sampleValuesJson. Registry timestamps/curated-fields information may be retained as provenance if needed, never inferred or updated. Use a shared structural type, not a runtime repository import. E9. |
| `FieldObservations` | Separate `liveOptions: ReadSlice<string>` and `catalogStats` availability. Live options are the values **reported by existing acquisition**, potentially already normalized/limited; do not claim they are raw product records. Catalog stats retain nonEmptyCount/distinctCount/sampleValues/topValues with frequencies. Registry samples stay a third separately attributed observation source. E1/E14. |
| Provenance | `configurationKind` and source availability are explicit. Complete-config composition uses one supplied config object; fallback is `independent_responses`, never “one coherent snapshot.” No fabricated bundle hash, capture timestamp, or frozen-execution claim. E2/E3/E6. |

**Acquisition stays outside:** settings calls existing repository/observation functions; catalog computes its existing stats; fallback uses its existing API functions. This plan does not add a “live” overload to the pure seam. E1–E3/E17.

### Output contracts

`MerchandisingFieldReadModel` contains ordered field specs, configuration/source availability, unmapped attribute definitions when available, and diagnostics. The field universe is the union of exact registry names, discovered names, explicit mapping destinations, and explicit product-field target destinations. Origin flags distinguish those cases. A mapping-only spec is **not** evidence that the field is present in the store; legacy projectors explicitly select their existing field universe.

| Type/member | Required shape and behavior |
|---|---|
| `MerchandisingFieldSpec.catalogField` | Exact field identity. No lowercasing, ProductField-number guessing, or attribute-name matching. |
| `display` | Registry-backed metadata or explicit absent/unavailable registry state. Label fallback to the Catalog Field name is marked display-only. Configured Attribute names and Target labels remain separate. A missing registry row does not create a canonical row. E9/E12. |
| `bindings` | Ordered mapping bindings, each with original mapping/reference, stale flag, serialization availability, referenced attribute availability, and attached profile contexts. Preserve all candidates; index creation must not silently overwrite duplicates. Mapping status distinguishes none, unique, ambiguous, and unavailable. |
| `configured` within a binding | Attribute definition/value mode, canonical unit, configured allowed IDs/options, attribute-level aliases, and optional export disposition. Non-controlled is distinct from controlled-with-zero-options, missing attribute, unavailable definitions, and invalid identity. Valid configured options use `canonicalOptions`; label equals exact ID. Never add observed values here. E5/E7/E11. |
| `profileContexts` | One record per profile membership, with exact profileId, productTypeId, and original membership: requiredness, cardinality, applicabilityConditions, constraints, confidenceThresholds, and profile valueAliases. Keep global and profile aliases separate. No effective alias union, cardinality default, or applicability result without explicit context. E11/E12. |
| `targets` | All matching product-field target records with original source order and association reason (`direct_catalog_field` and/or `mapped_attribute`). Preserve enabled, mandatory, selectionMode, optionSource, required, sortOrder, target label, and IDs. A target-only attribute reference is not an Attribute Mapping. E1/E8. |
| `observed` | Separate available/unavailable live options, parsed registry samples, and raw catalog stats. Any normalized presentation options retain their observation-source distinction; they never become configured allowed values. Catalog inferred mode is explicitly **display inference**, not Attribute valueMode. E14. |
| `diagnostics` | Bounded codes with relevant field/attribute/mapping/profile/target IDs: unavailable source, missing registry entry, missing attribute, unmapped attribute, ambiguous mapping, inconsistent target reference, malformed sample JSON, invalid configured identity. No secrets, payload dumps, guessed repairs, activation verdict, or new health-report taxonomy. |
| `unmappedAttributes` | Definitions with no supplied mapping, including `not_exported` attributes. Keep “intentionally not exported” distinct from “mapping missing” and “mappings unavailable.” No synthetic field destination. E7/E11. |

Do not expose writable source references. Clone relevant arrays/records before freezing the result; do not freeze or mutate caller-owned config. Do not expose mutable `Map`/`Set` instances as a purportedly frozen public API. Identity helpers retain their ownership; no novel alias-matching endpoint is needed. E5.

### Exported signatures

Only declarations/type sketches follow; they are specifications, not executable implementations.

```ts
composeMerchandisingFieldSpecs(
  input: MerchandisingFieldSpecInput,
): MerchandisingFieldReadModel;

getMerchandisingFieldSpec(
  model: MerchandisingFieldReadModel,
  catalogField: string,
): MerchandisingFieldSpec | null;

listMerchandisingFieldSpecsForAttribute(
  model: MerchandisingFieldReadModel,
  attributeId: string,
): readonly MerchandisingFieldSpec[];

getMerchandisingFieldProfileContext(
  model: MerchandisingFieldReadModel,
  query: { readonly attributeId: string; readonly profileId: string },
): ProfileContextLookup;

projectCurationFieldCandidates(
  model: MerchandisingFieldReadModel,
): ProductFieldCurationCandidate[];

projectCatalogFieldSummaries(
  model: MerchandisingFieldReadModel,
  view: 'catalog' | 'legacy-client-fallback',
): CatalogFieldSummary[];
```

`ProfileContextLookup` is `found` with one original profile-membership record, `not_in_profile`, `profile_missing`, `ambiguous`, or `unavailable`; never an implicit first profile. This lookup is inspection only. It does **not** select effective Product Type, evaluate reviewed facts, or replace `resolveEffectiveTypeProfile`. Attribute lookup deliberately returns plural field specs; attribute identity alone cannot select target/profile context. E11.

### Compatibility projections and fail-closed behavior

- **Settings field universe:** registry entries with `kind === custom` or names starting `ProductField`, plus discovered `ProductField` keys absent from that filtered registry. Do not add mapping-only/target-only fields merely because the richer model can describe them. Preserve numeric-suffix ordering and existing tie-breaks. E1/E14.
- **Settings values:** preserve existing controlled-or-missing-attribute presentation behavior and the union of configured values, observed live options, and registry samples. Preserve NFC/trim normalization, case-sensitive distinctness, pipe splitting for observations, malformed-sample tolerance, and current limit placement: acquisition limits live values to 250; candidate union itself is not newly capped. Free-text/measured candidates remain optionless. This legacy `values` field is explicitly **picker/display material**, never a runtime allowed-value set. E1/E14.
- **Settings association:** for valid inputs retain the original first matching target predicate and `mapping.attributeId ?? target.attributeId ?? null` display fallback. The model records whether an attribute ID is mapping-backed or target-only. Multiple valid targets remain present in the model; the legacy DTO is not a target-selection authority. E1.
- **Catalog universe:** registry rows only, in original registry order, including core/system fields. Label fallback, stale flag, all direct product-field targets (including disabled targets), and warning precedence stay unchanged. `isCurationTarget` means referenced, not executable. Preserve catalog histogram/inferred-mode rules; do not replace them with Attribute valueMode or pipe-split histograms. E2/E14.
- **Fallback:** keep existing endpoints and request fanout for this slice, but replace local joins with reference-only composition and the explicit `legacy-client-fallback` projection. Preserve cancellation, error handling, zero/unknown stats placeholders, `isStale: false`, and its existing unlabeled-warning behavior as **legacy presentation compatibility**. Actual stale metadata/source availability remains represented correctly in the read model. Do not endorse fallback booleans as authoritative; correcting their presentation is separate work. E3.
- **Partial failures:** model unavailable definitions/profiles/mappings/targets separately. Never manufacture configured options, aliases, serialization, mappings, or profiles from fallback observations. Missing mapping is not stale mapping; absent registry row does not independently rewrite `mapping.isStale`. E3/E9/E11.
- **Corrupt/ambiguous inputs:** never let a map overwrite select an authoritative binding. Retain diagnostics and source records; suppress a singular composed binding/configured options when identity is invalid or mapping identity is ambiguous. Compatibility guarantees apply to valid inputs; explicitly test conservative degradation for corrupt fixtures. Use `validateCanonicalValue`/`findCanonicalCollisions` when guarding canonical-option construction; never repair invalid configured bytes. Existing validators remain the activation authority. E5/E7.
- **Aliases:** expose them by original scope, without choosing precedence or converting display labels into IDs. Identity tests exercise the existing `resolveAlias`/`matchCanonicalValue` against exposed definitions; no new resolver implementation. Unknown/ambiguous aliases never become allowed options merely by appearing in observations. E5/E11.
- **Built-ins:** preserve registry metadata for them, but provide no configurable output rule, XML generator, defaulting, or export authorization. Existing mapping serialization is opaque metadata. ADR 0011/E10.

## 4. Sequential work items

All work below is future implementation work. Each item requires its predecessor's acceptance gate. No parallel writers.

### W0 — Pin characterization and scope before extraction

**Create:** `src/tests/unit/curation-field-candidates.test.ts` (Vitest, repository/DB reads mocked); `src/tests/unit/catalog-fields-view.test.tsx` (existing React/DOM test convention).

**Modify:** `src/tests/unit/catalog-routes.test.ts` only, extending existing route characterization.

**Work:**

1. Pin exact successful settings candidate DTOs, catalog list/detail DTOs, and fallback DTO/rendering against fixed complete and partial fixtures.
2. Include the documented differences: numeric settings order vs registry order; candidate union vs configured runtime options; direct-vs-attribute target association; disabled targets counted as catalog references; fallback stale/warning defaults; missing-config behavior.
3. Record existing acquisition call counts. Later catalog implementation must reduce two config loads to one per list response, not change the authoritative loader.
4. Before each subsequent edit, recheck status and preserve unrelated changes. Do not regenerate fixtures from the new implementation to manufacture parity.

**Acceptance:** tests pass against unmodified production code; each quirk above has an explicit expected value. Existing relevant tests remain unchanged baselines: `src/tests/unit/classification-pipeline.test.ts:480–534` (discovery and verified/name-deduplicated Pages), `src/tests/unit/catalog-routes.test.ts:152–200` (list/detail), and `src/tests/unit/classification-runtime-snapshot.test.ts:147–160` (canonical snapshot options). No live acquisition is invoked. E1–E3/E14/E17.

### W1 — Add the typed pure seam and compatibility projections

**Create:** the three modules in §3; `src/tests/unit/merchandising-field-spec.test.ts`; `src/tests/unit/merchandising-field-spec-projections.test.ts`.

**Modify:** `src/client/components/catalog-workbench/types.ts` only to replace the local `CatalogFieldSummary` declaration with a type re-export from the shared read-model schema module. Keep all other workbench types unchanged.

**Work:** implement the contracts/signatures in §3, using ordered indexes rather than repeated cross-source `.find` joins. The model retains all bindings/targets/profile contexts; projections own field selection and existing view-specific defaults. Validate reference-only boundary payloads with small shared schemas/picks; do not import DB-aware validation/loader modules into the browser graph. Use existing identity helpers, and preserve v1/v2 serialization metadata through explicit unions. Do not implement transport, authoring, or snapshot adapters.

**Acceptance:** all pure test matrix rows pass; output is deterministic for identical ordered inputs, source data remains unchanged, the public result cannot be mutated, and the browser import graph contains no DB/Node runtime dependency. Compilation checks narrow the available/unavailable unions without `any`/double-cast shortcuts. Existing DTO shapes are unchanged. E5/E7/E11/E14.

### W2 — Adopt in settings candidate composition, without touching execution

**Modify:** `src/classification/curation-targets.ts`; `src/client/onboarding-api.ts` only for the existing `ProductFieldCurationCandidate` type re-export; extend `src/tests/unit/curation-field-candidates.test.ts`.

**Work:**

1. Replace only `listCurationTargetCandidates`' field association/assembly with input acquisition → composition → `projectCurationFieldCandidates`.
2. Keep Product Type options and verified Page/name-deduplication handling unchanged. Retain existing DB acquisitions and their error/limit semantics; no new SQL, repository expansion, or query optimization project. Move the candidate-only sample parser to the pure projection module if needed, preserving behavior.
3. Keep `listCatalogFieldOptions`, its runtime-used normalization, `getExplicitCurationTargets`, `resolveAttributeAllowedValues`, and `applyCurationTargetsToConfig` behavior unchanged. Existing direct SQL outside repositories is legacy debt, not permission to introduce more. E14.
4. Keep exported candidate type/import paths working via type re-exports. Do not change HTTP write paths or the settings response envelope. E15.

**Acceptance:** W0 settings outputs remain equal; Page behavior unchanged; malformed observations do not crash settings; no extra live option read for free-text/measured attributes; no execution consumer imports the new model. Existing snapshot tests and runtime option outputs remain identical. E1/E6/E14.

### W3 — Adopt in catalog list and adjacent detail metadata

**Modify:** `src/server/routes/catalog-routes.ts`; `src/tests/unit/catalog-routes.test.ts`.

**Work:**

1. For `/catalog/fields`, load the existing authoritative config **once**, represent load failure explicitly, and compose registry/config/stats. Replace mapping/target/warning assembly with the catalog projection.
2. Apply the same projection to `/catalog/fields/:xmlField` metadata so list/detail do not immediately diverge. Preserve missing-registry 404, stats/histogram/affected-SKU queries, and detail-only response fields.
3. Move only the pure inferred-mode calculation if required by the common projection. Do not change queries, stats limits, `/catalog/schema-summary`, `/catalog/mappings`, `/catalog/schema-health`, or Page routes.
4. Add no endpoint or response field requirement; preserve `{ fields }` and existing detail DTO shape. Do not replace `loadRuntimeConfig` with a cache, raw JSON, or a weaker loader to avoid E17 side effects.

**Acceptance:** successful list/detail response parity, registry order, warning precedence, core/system inclusion, and no-config degradation are pinned; exactly one config acquisition per list response; no source mutation or new write calls. Side-effect-free tests use mocked acquisition; the new composer/projection themselves have zero I/O. E2/E14/E17.

### W4 — Adopt in the existing CatalogFieldsView fallback

**Modify:** `src/client/components/catalog-workbench/CatalogFieldsView.tsx`; `src/tests/unit/catalog-fields-view.test.tsx`.

**Work:** keep the preferred `listCatalogFields` path untouched. Replace fallback's local mapping map/target set/registry assembly with reference-only seam input and `projectCatalogFieldSummaries(model, 'legacy-client-fallback')`. Preserve independent fulfillment/rejection information before constructing input slices; do not turn a caught failure into a supposedly authoritative empty config. Keep API paths, fanout, cancellation, rendering, and fallback compatibility semantics as pinned in W0.

**Acceptance:** successful primary path makes no fallback requests; failed primary uses the seam; each fallback-source failure yields the existing safe presentation without manufacturing definitions or options; all-rejected and unmounted cases are safe. Stale/warning quirks remain explicitly isolated in the compatibility projection, not rediscovered in JSX. Browser build/import proof passes. E3/E15/E17.

**Intentionally untouched:** `TypesAttributesView.tsx`. Its simpler one-config join is a possible later adopter after this seam proves useful, not a claimed four-authority duplication or required migration. E4.

### W5 — Close settings/catalog delivery and publish the runtime gate

**Modify:** this plan's implementation checklist/evidence section only if recording completion; do not add runtime source files in this item.

**Work:** run §6; review exact changed paths; demonstrate removal of the three targeted local joins, preserved legacy DTOs, and unchanged runtime authority flow. Compare canonical release/config/snapshot fixture outputs with their pre-refactor values. Record all baseline failures separately; do not fix unrelated tests as part of this slice.

**Acceptance:** W0–W4 and all required matrix rows pass; no release/config/pin/schema/stage changes; no new data writes/network calls; output-policy and controlled-identity regression suites pass; dirty worktree preserved. Settings/catalog delivery may complete **without runtime adoption**.

### Exact first-delivery source allowlist

New: the three §3 modules. Modified: `src/classification/curation-targets.ts`, `src/server/routes/catalog-routes.ts`, `src/client/components/catalog-workbench/CatalogFieldsView.tsx`, `src/client/components/catalog-workbench/types.ts`, `src/client/onboarding-api.ts` (candidate type only). Tests: the four new suites named above plus the existing `catalog-routes.test.ts` extension. This plan may record completion. No other source/test-runner/dependency edits are presumed; if the established test environment cannot run the new Vitest tests, stop and report the prerequisite instead of downloading packages or expanding scope.

## 5. Parity and fail-closed test matrix

New suite abbreviations: **S** = `merchandising-field-spec.test.ts`; **P** = `merchandising-field-spec-projections.test.ts`; **C** = `curation-field-candidates.test.ts`; **R** = existing `catalog-routes.test.ts`; **U** = `catalog-fields-view.test.tsx`.

| Case | Required assertions | Suites / existing guard |
|---|---|---|
| Normal mapped controlled field | Registry label/type, attribute definition, mapping serialization, target references, and three value lanes are associated without ownership changes; legacy DTOs equal W0 fixtures. | S/P/C/R/U; E1–E3 |
| Global alias | Definition retains exact alias/target; existing `resolveAlias` returns exact allowed ID, not alias or label; alias is not appended as an allowed value. | S; `controlled-value-identity.test.ts`; ADR 0012 |
| Profile-specific aliases | Two profiles may carry different aliases for the same attribute; explicit profile lookup returns only that membership. No context-free effective alias/cardinality. Same-scope ambiguity/unknown target still returns null through existing helpers. | S; existing config validation tests; E5/E11 |
| NFC and identity | Composed `café` and observed `cafe\u0301` display consistently; invalid configured decomposed/untrimmed/control-character/empty values are not silently repaired into canonical options. Exact/case-fold collisions are reported; `Dog` vs `dog` remains distinct in legacy observation display, never proof of valid configuration. | S/P/C; identity/config validation tests; ADR 0012 |
| Configured vs observed | Configured `Chicken`, live `Turkey`, samples `Beef` remain separately attributed. Legacy settings union includes all three; configured options remain only `Chicken`. `optionSource=configured` does not remove observations from settings display or add them to runtime options. | S/P/C; E1/E6/E14 |
| Live-store option policy | Same fixture with `optionSource=live_store` leaves existing runtime configured-plus-live result/limit unchanged; no registry sample or histogram inference leaks into snapshot options. | C plus unchanged runtime-snapshot regressions; E6/E14 |
| FreeText/measured/empty controlled | No dropdown values for freeText/measured even with stored observations; empty controlled is distinct from missing/unknown definition. Canonical units retained, not formatted/exported. | S/P/C; E11/E14 |
| Pipe samples and limits | Array/scalar product observations, embedded pipes, blanks, malformed sample JSON, duplicates, >250 live choices, and union >250 preserve existing parser/limit placement. Catalog histogram stays raw and frequency-based. | P/C/R; E14 |
| Unmapped/target-only | Registry-only field stays visible; a target reference may supply the legacy candidate attribute ID without producing a mapping or serialization. Known unexported attribute has no synthetic destination. | S/P/C/R; E1/E7 |
| Stale mapping | Stale flag retained as configured, without auto-healing or deleting mapping. Catalog warning priority remains unlabeled-before-stale. Legacy fallback false-stale default stays isolated and explicitly tested. | S/P/R/U; E2/E3 |
| Missing registry row | Discovered ProductField appears in settings with field-name/string fallback; mapping-only spec is diagnosable but not added to legacy settings/catalog field lists; catalog detail remains 404. | S/P/C/R; `classification-pipeline.test.ts:480–508` |
| Missing attribute/ambiguous mapping | Missing definition is not known-empty; contradictory mappings are retained as diagnostics, never last-write-wins authoritative binding; singular composed options/binding unavailable. No config repair. | S/P/C/R; E7/E11 |
| Multiple/disabled/mandatory targets | Preserve full target list and enabled/mandatory/selectionMode separately; catalog direct reference includes disabled target; settings original target association preserved; runtime mandatory/enabled policy untouched. | S/P/C/R; E1/E6 |
| Profile cardinality/conditions | Same attribute single in one profile, multiple in another, conditional/required elsewhere: source records survive verbatim, no conditions evaluated. Unknown profile is not “no constraints.” | S; unchanged `effective-curation-type.test.ts` / `effective-curation-stages.test.ts`; E11 |
| V1/v2 metadata | Legacy `serialization.format` and v2 `serialization.kind` both survive without coercion; optional v2 export disposition remains optional for legacy input; derived release targets are consumed as supplied. | S/P; unchanged release-compiler tests; E8/E11 |
| Missing config/partial fallback | Independently fail mappings, targets, registry, and primary API; unknown lanes remain unknown. No hidden retry repairs, synthetic fields, additional endpoint, or configured options from partial responses. Primary success bypasses fallback. | S/P/R/U; E3/E17 |
| Ordering/display-only changes | Preserve numeric settings ordering, registry catalog ordering, label fallback, sample ordering rules; changing registry label does not alter configured IDs/aliases/mappings/options. | S/P/C/R; field-registry route regression; E9 |
| Purity/immutability | Same ordered input yields equal output; deep-frozen inputs work; outputs cannot mutate caller data; no exported mutable indexes. Composer import/execution requires no DB/fs/fetch/clock. No runtime module imports the seam. | S/P plus browser import/build and static review |
| Built-ins/Pages | Built-in registry fields remain metadata only; no ProductField enters adapter built-in policy. Product Type/Page candidate behavior unchanged, including verified-only/name-deduped Pages in settings. | R/C plus existing built-in-policy and classification-pipeline suites; E6/E10 |

Corrupt-input safety is an explicit exception to byte-for-byte legacy corruption handling, not a pretext for changing valid-input behavior. Any newly discovered valid-input mismatch blocks that adopter until characterized; do not waive it by updating snapshots.

## 6. Validation commands and execution safety

These commands are **instructions for the future implementer**, not commands run during planning. Use installed tooling only. First inspect each DB-backed suite's temp-workspace setup; never let the singleton DB connection use application defaults. Existing tests may create fixture-only Git history in disposable test directories; never stage/commit the source repository or real catalog. No live HTTP smoke tests because of E17.

1. Boundary checks before/after work: `git status --short`; `git diff --name-only`; `git diff --check`. Compare against the exact allowlist. Confirm no changes under `src/classification/releases/`, `storage/catalog/`, DB migrations, runtime/stages, ShopSite adapter, or pins.
2. Pure/settings/catalog tests: `bun run test:unit -- src/tests/unit/merchandising-field-spec.test.ts src/tests/unit/merchandising-field-spec-projections.test.ts src/tests/unit/curation-field-candidates.test.ts src/tests/unit/catalog-routes.test.ts src/tests/unit/catalog-fields-view.test.tsx`.
3. Existing identity/validation/output-policy guards: `bun run test:unit -- src/tests/unit/controlled-value-identity.test.ts src/tests/unit/classification-config-validation.test.ts src/tests/unit/built-in-output-policy.test.ts src/tests/unit/catalog-field-serialization.test.ts`.
4. Isolated frozen-input guards: `bun test --timeout 30000 src/tests/unit/classification-runtime-snapshot.test.ts src/tests/unit/runtime-snapshot-v2.test.ts`.
5. Isolated effective-type guards: `bun test --timeout 30000 src/tests/unit/effective-curation-type.test.ts src/tests/unit/effective-curation-stages.test.ts`.
6. Settings/runtime integration baseline, separately because of module/DB isolation: `bun test --timeout 30000 src/tests/unit/classification-pipeline.test.ts`.
7. Registry authority and derived release guards, separate processes: `bun test --timeout 30000 src/tests/unit/field-registry-routes.test.ts`; `bun test --timeout 30000 src/tests/unit/release-compiler.test.ts`.
8. Type boundary: `bun run typecheck`; `bun run test:runner-coverage`. New pure/mocked/DOM tests belong to existing Vitest inclusion, not the Bun-DB list. Runner conventions: `package.json:8–14`, `vitest.config.ts:10–22`; existing DOM convention: `src/tests/unit/review-classification-panel.test.tsx:1–16,44–63`.
9. Lint touched TS/TSX files explicitly with the installed ESLint (`bunx --no-install eslint` followed by the exact touched file paths). Also record `bun run lint` results; do not remediate unrelated baseline failures. Scripts are defined in `package.json`.
10. Browser bundle/import verification: `bun run build` only in a disposable validation copy if generated build output would violate the worktree allowlist. Assert no Node/Bun runtime import is introduced through the client seam. No dependency installation if jsdom/build prerequisites are missing.

Full `bun run test` is optional additional evidence only after its broader fixtures/side effects have been checked; it is not a substitute for the focused parity gates. Failures, skipped prerequisites, and commands not run must be reported accurately.

## 7. Rollout and separately gated runtime follow-up

**Order:** W0 characterization → W1 pure seam → W2 settings → W3 catalog list/detail → W4 client fallback → W5 parity closeout. No feature flag, live shadow writer, persistence schema, or release activation is needed. Each adopter can stop independently while the previous delivery remains useful.

**Runtime is not accepted merely because settings tests pass.** Any later runtime adoption requires a separately authorized change with this entry gate:

- Inputs come exclusively from an already verified `RuntimeClassificationSnapshot`; no registry/workspace/cache callbacks and no fallback to settings acquisition. Existing snapshots lack registry display metadata; report it unavailable rather than extending/hydrating historical authority. E6.
- Obtain effective Product Type/profile through the existing effective-type helpers and their reviewed/execution precedence, including null-profile and missing-profile fail-closed behavior. Keep conditions reviewed-facts-only. Do not use the inspection lookup as an applicability engine. E11/ADR 0013.
- Obtain enabled/mandatory targets and exact target-ID-keyed options through `resolveTargetsFromSnapshot`; do not reconstruct them from configured/observed display unions. Snapshot options have no separate historical observation provenance; do not invent it. E6.
- Demonstrate same frozen input → identical target sets, option ordering/IDs, proposals/abstentions, dependency behavior, serialization, and canonical draft artifact before wiring any runtime consumer. Mutation of live registry/config/observations after freeze must have zero effect. Run existing cohort freeze/replay tests in isolated fixtures.
- Demonstrate no snapshot hash/schema/authority expansion and no live acquisitions during execution. A required hash/schema change or any semantic mismatch stops the follow-up for separate design/approval; it is not hidden in this refactor.

Candidate 4 may subsequently use this read model for **read-only** inspection/navigation; no navigation screen, profile browser, editor, or action workflow is part of this plan.

## 8. Explicit non-goals

- No edits to releases, authoring/publishing, activation, pin changes, generated config, canonical catalog state, profile-schema migration, taxonomy redesign, or stage/pipeline naming. E8/E13/E16.
- No replacement of registry canonical service or attestation mechanisms; no new SQL or repository reorganization. E9/E17.
- No new identity/alias resolver, release validator, effective-type resolver, target resolver, serializer, or ShopSite output policy. E5–E11.
- No redesign of `TypesAttributesView`, mappings/health/schema-summary views, Candidate 4 workbench, settings editing, or review/promotion. E4/E15.
- No fallback UX cleanup, stats-query optimization, new API endpoint, live shadow comparison, telemetry storage, cache invalidation system, snapshot metadata migration, or standalone persisted field-spec catalog. E2/E3/E6/E12.

## 9. Risks, rollback, and residual limitations

| Risk | Mitigation / residual limitation |
|---|---|
| A “read model” becomes a new execution authority | No eligibility fields or write/load API; source lanes and typed availability; no runtime consumers in first delivery. Runtime gate remains separate. |
| Legacy fallback lies about stale state or empty stats | Deliberately isolate its existing presentation defaults in a named projection. The richer model remains accurate about source metadata/availability. Fixing this UX is deferred, not silently declared solved. E3. |
| Independent responses or concurrent store updates produce mixed-time display | Fallback provenance explicitly says independent responses; main list uses one config object. Registry/config/observations are still advisory reads, not an atomic execution snapshot. No multi-source transaction guarantee is claimed. E2/E3/E6. |
| Accidental writes while testing “GET” endpoints | Mock acquisition; offline disposable fixtures only. E17's repair/shadow side effects remain pre-existing acquisition debt, outside the pure-seam guarantee. A demand for end-to-end side-effect-free HTTP reads requires a separate loader/attestation design, not bypassing validation here. |
| Shared module pulls server code into client or erases v2 data | Browser-safe value imports, shared structural types, v1/v2 unions, compile/bundle proof, no DB-aware validator imports. E5/E11. |
| Option normalization changes semantics | Existing helpers and exact limit/order fixtures; distinguish raw histogram data, normalized observations, and configured identity. Settings display union never feeds runtime. E5/E6/E14. |
| Duplicate/invalid inputs make legacy and new outputs disagree | Valid-input parity is mandatory. Explicitly fail closed for corrupted/ambiguous binding or canonical identity; preserve diagnostics, never repair config. E7. |
| Performance/memory regression from richer copies | Compose once per response, index associations once, retain existing observation limits; test a synthetic many-field/many-profile fixture. Do not add full product scans or global caching. Existing repeated observation/stats acquisition cost is not solved here. E1/E2. |
| Audit coverage gaps | No Candidate-2 scout handoff, no live verification, and no tests run during planning. All future skipped gates must remain visible. |

**Rollback:** before source adoption, retain W0 expected fixtures. If an adopter fails, remove only that adopter's seam call and restore its characterized implementation through an exact-file/manual edit; never use broad checkout/reset/revert on a dirty tree. Prefer rolling back client fallback, then catalog, then settings in reverse adoption order. Keep pure tests/modules if still used; remove unused new files only after checking references and ownership. This rollback changes no catalog config, release, pin, DB row, registry attestation, or snapshot and requires no data repair/activation. A behavioral parity failure blocks rollout rather than triggering a live “repair.”

## 10. Final acceptance checklist

- [x] Verified evidence/authority corrections honored; no ownership merger.
- [x] W0 valid-input parity fixtures predate implementation.
- [x] Typed, browser-safe, deeply readonly composition with explicit unavailable states.
- [x] Configured IDs, observed values, display metadata, and scoped profile/target records remain distinct.
- [x] Settings, catalog list/detail, and client fallback use the seam; targeted local joins removed.
- [x] Identity, stale/unmapped/missing-registry, profile aliases, NFC, and partial-source matrix passes.
- [x] Existing runtime helpers, frozen options/hashes, Pages, and adapter behavior unchanged.
- [x] No release/pin/schema/stage edits, writes, network activity, staging, commits, or pushes.
- [x] Exact path diff reviewed; unrelated work preserved; validation results and limitations recorded.
- [x] Runtime adoption and Candidate 4 remain separately gated follow-ups.
