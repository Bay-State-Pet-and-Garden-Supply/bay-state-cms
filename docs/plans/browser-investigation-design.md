# Browser-Assisted Extraction Investigation — design and seam audit

Status: implemented T1–T6 (#225–#230). This document remains the design baseline; the T6 closeout record (`browser-investigation-t6-closeout.md`) records what was actually performed. No live profile activation, image attestation, or item release was performed during implementation.

Repository: `Bay-State-Pet-and-Garden-Supply/bay-state-cms`. Audit baseline: current `main`, `aeeb3fdd2182a35214a1007d4d39c2e7383bef13` (PR #209 merge). The working tree was clean before this design session. No runtime or database changes, live investigations, profile activations, image attestations, or item releases were performed.

## Objective

An operator pays for a bounded investigation to learn or repair a domain's extraction strategy. Bay State subsequently executes the reviewed strategy deterministically. Investigation is a control-plane capability, never a per-SKU extraction fallback.

Prefer one thin vertical slice that genuinely works over thousands of lines of record-only evidence. The feature is **Browser-Assisted Extraction Investigation**, not a vendor integration; persistence and application concepts must remain provider-neutral.

## Owner decisions from grilling

| Decision | Agreed outcome |
| --- | --- |
| Holdout exposure | True holdouts remain hidden from investigation and tuning. Exposed samples lose holdout status for that proposal. |
| First runtime adapter | Shopify end-to-end; reuse existing supported structured-data primitives. New WooCommerce endpoint integration and other new coded adapters are follow-ups. |
| Initial investigation provider | Constrained local first. Cloud v4 remains disabled until enforceable controls can satisfy the security contract. |
| Local engine | App-owned `local_browser_harness`, with bounded read-only model tools and reuse of compatible Node browser-worker infrastructure; no Python Browser Use agent dependency in the initial slice. |
| Workspace ownership | Investigations are workspace-private. Applying sanitized policy/evidence to an existing shared domain-profile draft is an explicit, disclosed operator action. Profiles remain globally shared by domain. |
| Failed proposals | Compilable proposals may become inactive, blocked drafts for manual repair. This is not validation success, approval, health, activation, or release. Unsupported executable primitives cannot be applied. |
| Model locality | Browser execution is local. Cloud text analysis requires explicit configuration/data-sharing opt-in; images have separate permission. No silent provider fallback. |
| Missing holdout | At least one blind holdout must pass before an investigation-derived policy becomes activation-eligible. Existing confirmation-count waivers cannot waive this requirement. |
| Default run budget | Up to 5 investigation PDPs, 20 bounded read operations, 8 model calls, 10 minutes. One active investigation per workspace/domain and one local browser investigation at a time. No automatic investigation reruns; at most one retry of an idempotent read within the same budget. |
| Isolation | Live investigation requires an isolated Docker browser worker with brokered, restricted network access. No store credentials, host browser profiles, or unrestricted egress. Unavailable isolation disables investigation, not normal extraction. |

These decisions deliberately amend the initial brief: Cloud v4 is deferred, the local harness becomes the initial provider, Docker is an investigation-only prerequisite, blocked drafts can be saved, and blind-holdout coverage is mandatory for investigation-derived policies. Do not later describe the initial delivery as a functioning Cloud v4 integration.

## Repository and issue audit

Read `CONTEXT.md`, ADRs 0008, 0009, 0023, 0024, 0030, 0031, 0037, PR #209, and issues #197–#208. Followed the rescoping references to #211 and #213. ADRs 0023/0024 are historical, superseded by the Agent Lab decommission; do not resurrect that runtime.

- PR #209 is merged. No dependent branch or unrelated #209 remediation is needed.
- #198–#203 are closed. #197 and #204–#208 remain open; the latter deliberately distinguish evidence packages from unperformed operator activation, image review, and release.
- #211 corrects the old barcode-loss diagnosis: Shopify barcodes already enter normalized GTIN identifiers. The merged worker also consults richer Shopify endpoint evidence when a multi-candidate embedded matrix lacks GTINs and an expected UPC is available.
- Production currently requires a healthy active profile and uses CSS-led extraction with additive ladder enrichment. A platform-generation hint is not a runtime adapter policy.
- Profiles, versions, active pointers, and representative suites are global by domain. Investigation workspace scoping must not be confused with existing profile ownership.
- Multi-template runtime dispatch is absent, despite the broader model described by ADR 0008/CONTEXT. Template clustering currently supports coverage, not profile selection.
- The shared reviewed-health evaluator now binds executable content to an active version. Preserve that protection when adding policy content.
- The matrix route currently derives expected title from the URL and treats a nonempty extracted title as success. It cannot, unchanged, prove the requested field/identity correctness. Extend the existing validation evidence path, not a second health definition.
- The actual confirmation gate is three confirmed samples or an audited count waiver. The stale two-sample statement in CONTEXT was corrected during this session; no runtime threshold was changed.
- Selected retry is a deliberate workspace-scoped failed-extraction action, distinct from health-gated automatic release. This feature must invoke neither.

## Existing seams to reuse

| Concern | Existing files / interface | Required adaptation |
| --- | --- | --- |
| Worker validation | `src/onboarding/profile-runner-client.ts` (`runProfileExtraction` / `runProfileForUrl`), `src/extraction-worker/routes/extract.ts` | Execute candidate policy content through the production runner, with expected identity and no trusted onboarding writes. |
| Deterministic extraction | `src/onboarding/extraction-ladder/`, worker static/rendered extraction | Add supported per-field source ordering and a complete Shopify endpoint-backed slice; preserve legacy profile semantics until an operator adopts a policy. Do not use the ladder's unwired profile seam as a second profile executor. |
| Variant identity | `src/onboarding/variant-resolver.ts`, worker `resolveVariantGate`, selected-variant materialization and receipts | Reuse normalized identifiers and matcher; extend missing trusted-identifier inputs/known variant-ID support at that seam, not via a second matcher. Verify endpoint/embedded parity and conflicts with tests. |
| Version binding | `src/db/repositories/profile-version-repo.ts` (`profileFromVersion`), `extractor-profile-repo.ts`, `src/onboarding/domain-version-health.ts` | Include policy content in the full executable snapshot and drift comparison. New drafts must not overwrite the active legacy row. |
| Health and activation | `domain-version-health.ts`, `profile-activation-gate.ts`, `src/server/routes/profile-activation-routes.ts` | Feed richer validation and blind-holdout evidence into the same evaluator. Preserve image review and confirmation/waiver rules. Add no investigation activation route. |
| Samples and matrix | `representative-suite-repo.ts`, `profile-test-matrix.ts`, `src/server/routes/profile-matrix-routes.ts` | Bind roles/expected identity, representative and blind-holdout coverage, policy hash, and artifact hashes to the validated version. |
| Corpus and strategy reporting | `src/onboarding/profile-audit/` including `versioned-corpus.ts`, `adapter-strategy-report.ts`, replay/scorer/gate machinery | Reuse tuning/holdout partitions, wrong-product/variant cases, image membership, and measured strategy reporting. Do not substitute a title-only matrix for these checks. |
| Workspace UX | `src/client/components/profile-workspace/`, `profile-builder/`, `src/onboarding/profile-workspace/output-first-service.ts`, `src/server/routes/profile-inspect-routes.ts` | Add investigation selection/history/results and separate Validate / Apply to Draft / Discard actions within the current workspace. |
| Network and artifacts | `src/shared/ssrf.ts`, worker safe profile fetch/guards, snapshot/artifact machinery | Reuse URL/IP classification and hashing; enforce restricted brokered reads for the isolated investigation browser. Existing browser defaults are not sufficient unchanged. |
| Diagnostics/telemetry | `domain-diagnostics-service.ts`, `onboarding-telemetry.ts`, existing model-call usage reporting | Derive operator views from persisted investigation/validation state; record actual metrics or explicit unavailability, not checked-in runtime ledgers. |

The current rendered runner enables session pooling, cookie persistence, and retries, and its guard interface sees a URL rather than a method/path policy. Reusing its infrastructure does **not** mean inheriting those defaults for investigation.

## Proposed module interfaces and authority

### Browser Investigation

One provider-neutral interface accepts a bounded request and returns a schema-validated but untrusted result. Initial implementations are the local harness and a deterministic fake for tests. Provider SDK types do not escape this seam. Do not add unused Cloud SDK plumbing merely to suggest future support.

Persist through normal SQLite repositories and shared Zod schemas:

- investigation ID, workspace, normalized domain, mode (`domain_onboarding` / `drift_repair`), lifecycle status;
- provider/run identity, requested and actual model metadata where available;
- input URL/context snapshot and hash, budget, timestamps;
- versioned structured observations, evidence references, compiled proposal or compilation refusal;
- actual usage/cost where available, stable operator-safe failure codes;
- immutable proposal/validation references and application/discard history sufficient to reject stale or replayed completions.

Keep investigation completion, compilation support, validation outcome, and human review distinct. A completed investigation can still yield `requires_code_adapter` or a blocked draft.

Only explicit investigation/repair routes can start a run. Normal extraction, worker polling, diagnostics reads, and failure handling cannot invoke a provider. Workspace scoping applies to reads, writes, artifacts, status/events, validation, apply, and discard. Shared configuration publication must not expose private prompts or raw workspace observations.

### Bounded local harness

The model may request approved-page inspection, rendered DOM/selector inspection, embedded-state observations, and permitted same-product endpoint/network observations. These are server-authored operations with declarative arguments, not arbitrary model-generated JavaScript, Python, shell, CDP commands, or executable adapters.

#### Enforcement outside the browser

The authoritative network boundary lives **outside the browser process**. The browser container/network namespace has no direct outbound route, including to the host, LAN, cloud metadata addresses, arbitrary DNS servers, or the public internet. All permitted HTTP(S) is mediated by the Bay State-controlled broker. The broker is separately constrained and validates each request against the immutable investigation scope. Playwright routing, CDP interception, and agent domain settings are defense-in-depth only; disabling or bypassing them must not create direct egress.

The broker must see and enforce the actual method, URL/path, headers, and response body. An opaque HTTPS `CONNECT` tunnel cannot enforce that contract and is **not sufficient**. A full-request fetch broker or equivalent inspectable transport may be used; upstream TLS verification remains enabled. Resolve and validate public addresses at the broker, connect to the validated destination without a second unchecked DNS lookup, and revalidate every redirect hop. Do not trust the browser to perform these checks or report the final destination truthfully.

Required investigation-container posture:

- No host networking, privileged mode, Docker socket, host browser profiles, store credentials, model/API keys, or unrelated host mounts.
- Run non-root, drop all Linux capabilities, set no-new-privileges, and retain the browser and container syscall/security sandboxes. Do not work around launch failures with privileged mode or `--no-sandbox`.
- Read-only root filesystem; bounded tmpfs for browser profile/scratch/shared memory. Any necessary writable exception must be narrow, documented, and size-bounded, never a broad host mount.
- Explicit non-unlimited CPU, memory, and process limits; fresh browser state per investigation; deterministic teardown on completion/cancellation/timeout.
- A narrow run-scoped control/broker channel, not access to general CMS APIs or an unrestricted host proxy. Egress policy cannot be changed by the browser or model.

Additional request constraints:

- Only approved public product-page/API/static-asset reads. Merely using `GET` is insufficient: cart/action URLs and unapproved paths remain forbidden. A matching hostname is not permission to navigate arbitrary paths.
- Deny unsupported channels, service workers, WebSockets, downloads, form submissions, authentication/CAPTCHA workflows, credential-bearing inputs, and non-read HTTP methods.
- New redirect/API/static-asset hosts are suggestions, not trust grants. Preserve original and final URLs. Use only approved hosts; otherwise report the missing permission/evidence rather than broadening trust.
- JavaScript-dependent variant clicking and POST-only APIs may be unsupported in this slice. Report that explicitly; use allowed variant URLs or deterministic representations where possible.
- Live execution is unavailable if isolation, model permissions, or required configuration is missing. No fallback to an unrestricted browser.

An implementation must prove the network design with container-level tests for direct-egress bypasses and private destinations before any real-domain pilot. Docker availability or passing mocked browser-route tests alone is not proof of containment.

#### Declarative inspection grammar

Do not restrict investigation to one-off platform helpers. Provide a small versioned, Zod-validated grammar expressive enough to examine unfamiliar pages:

| Primitive | Permitted behavior |
| --- | --- |
| `query_selector_all` | Read a bounded set of element references and selected text from a captured page using a bounded CSS selector. No clicking or mutation. |
| `read_attribute` | Read a named DOM attribute from an existing element reference. Return text only; a discovered URL gains no fetch permission. |
| `read_script_json` | Parse strict JSON from a selected script element, with size/depth/node limits. Never evaluate JavaScript assignments or hydration code. |
| `read_meta` | Read bounded meta/link metadata as observations, not domain-trust grants. |
| `inspect_network_response` | Read a bounded, sanitized projection of an already captured broker-approved response by opaque response ID. No arbitrary request replay or credential/header disclosure. |
| `read_json_pointer` | Read an own-property value or array element from a captured JSON value using bounded RFC 6901 pointer tokens. No recursive descent, filters, expressions, functions, interpolation, or prototype traversal. |

References are opaque and scoped to the investigation/workspace and captured artifact. Enforce selector length, match count, pointer depth, JSON node count, and result-byte limits outside the model. Unknown operations or parameters fail closed. These primitives consume the agreed read-operation budget even when no network request occurs.

Fixed application-authored DOM readers may execute internally, but no primitive accepts executable code. Novel inspection paths may produce useful evidence without a new tool per platform; this does **not** authorize the production compiler to execute an arbitrary investigation transcript. A novel source can be investigated successfully yet still require a coded runtime adapter.

#### Observation and inference budgets

Retain the agreed action/time limits. Add separately enforced size and fan-out limits so one permitted read cannot return an unbounded page or application-state blob. **Proposed initial defaults** (versioned configuration, shown before launch):

| Resource | Default maximum |
| --- | --- |
| HTTP response body | 5 MiB per response, enforced on both transferred and decompressed body bytes while streaming; do not trust `Content-Length`. |
| All HTTP response bodies | 50 MiB per investigation for each of transferred and decompressed bytes, including assets, redirects, and retries. |
| Broker request attempts | 500 per investigation, including subresources, redirects, denied requests, and retries; separate from the 20 model-visible read operations. |
| Retained DOM/state/network artifacts | 5 MiB per artifact and 50 MiB total per investigation; screenshots also consume the total. |
| Model-visible text/DOM/JSON/network-body observation | 32 KiB UTF-8 per operation, including observation metadata. No raw response-body bypass. |
| Model input | 64 KiB text per call and 256 KiB cumulatively, including instructions, schemas, metadata, and repeated history; image limits are separate. |
| Model output | 4,096 output tokens per call and a 32 KiB accepted structured result per call. Require an enforceable provider output-token limit before dispatch. |
| Model image exposure | Zero without image-sharing permission; otherwise at most two image attachments across all calls, each at most 512 KiB and 1,024 pixels on its longest edge. Re-sending an image consumes another attachment. |
| Declarative query | Selector at most 512 characters, at most 100 returned matches, JSON/pointer depth at most 32, and at most 10,000 visited JSON nodes per operation; the byte limits still apply. |

Enforce network/artifact limits at the broker/capture layer and model-payload limits before dispatch. Record the applied budget with the immutable input. Overrides must be explicit before launch; an oversized response cannot silently increase the budget. Stop oversized downloads with a stable failure code. A clipped observation must be marked incomplete with its source/artifact reference and cannot establish field absence, exhaustive image membership, or unique variant identity. Further bounded inspection consumes the remaining budget; incomplete coverage stays a visible gap. A retained-prefix hash must not masquerade as the full source-content hash.

Include optional `maxCostUsd` in the provider-neutral budget contract. Declare whether a provider can actually enforce it, rather than assuming that a same-named SDK property is a hard billing cap. A requested ceiling that cannot be honored fails before dispatch with `budget_not_enforceable`; post-hoc spend checks are not hard ceilings. Omission does not waive byte/token/action/time limits. Persist provider-reported usage/cost when available and keep any rate-derived estimate explicitly distinct from billed cost; never fabricate either.

### Proposal compiler and deterministic runtime

Compile only supported, versioned Bay State primitives: per-field source order, supported structured-data/state parsers, the Shopify adapter, and validated selector exceptions. URLs, selectors, and source references are data with bounded grammars, not generated programs. Unsupported paths or semantics yield `requires_code_adapter` / a typed unresolved gap.

Add a forward-compatible policy to the existing versioned profile contract rather than replacing profiles. Legacy profiles retain their current behavior. Policy-bearing versions use the new field ordering in the **same production worker**; the policy is part of the immutable executable snapshot and health evidence identity.

Product and variant identity bind all accepted fields and images. Missing data may fall through to another supported source for the same identity; conflicting or wrong-identity evidence must not silently fall through until something looks plausible.

Shopify must preserve parent/variant IDs, SKU, barcode/GTIN, options, variant image, price, and availability. Reuse the existing matcher, with exact GTIN first, then trusted source SKU / compatible existing MPN semantics, exact known variant ID, sufficiently discriminating exact options, or an operator receipt. Check supplied identifiers for conflict, including when a weaker identifier would otherwise win. A parent product ID alone cannot choose among variants. Store UPC-as-SKU is not automatically a manufacturer SKU. Never use fuzzy product-name similarity alone.

Detect incompatible extraction structures. Different visual templates may still share one proven platform representation; genuinely incompatible extraction policies must not be squeezed into a global selector set. No multi-template persistence/dispatch rewrite in this slice. Preserve the finding and block unsupported activation.

### Validation and governance

1. Freeze proposal content, sample roles, trusted expected identities, relevant baseline version, and artifact references.
2. Validate the supported draft through the production worker on representative samples and separately reserved blind holdouts.
3. Record field coverage, exact product/variant outcomes, image membership and existing review requirements. Persist explicit `wrong_product` / `wrong_variant` failures, not just a missing-title error.
4. Feed those results into existing matrix/corpus/strategy reporting and the shared health evaluator. Any holdout failure prevents activation; at least one blind holdout must pass for investigation-derived policies.
5. Permit an explicit Apply to Draft for compilable work even when validation fails or is incomplete, preserving all blockers. Unsupported executable proposals remain unappliable.
6. Apply publishes a sanitized inactive shared draft only. It cannot update the active profile, grant image attestation, mark health, release items, or write trusted extraction data.
7. Human image review, field review, existing activation, and existing release decisions remain separate and authoritative.

A policy edit invalidates validation tied to its previous hash; changing a baseline or sample partition cannot silently reuse old evidence. Drift repair proposes the smallest supported policy change against the frozen last-healthy baseline. All repairs use the same validation/review path.

One blind holdout establishes an independent check, **not statistical generalization or proof of whole-domain coverage**. Where the existing corpus permits it, suite selection should prefer at least one blind holdout per discovered extraction structure and at least two total, selecting for structural/variant diversity rather than arbitrary extra pages. This is a selection preference, not a new unconditional numeric activation gate; the hard minimum remains one. Report achieved coverage and gaps, and run every reserved holdout—do not discard a failing page to recover a pass. Structural incompatibility and existing coverage gates still apply regardless of sample count. Do not reveal newly discovered structure details from blind pages to the investigator merely to improve selection.

Blindness applies to the complete investigator input, not just `sampleUrls`: exclude holdout URLs/content from prior artifacts, failure context, reports, and model-visible metadata. A holdout exposed while diagnosing a failure becomes tuning evidence for the next proposal and must be replaced for independent validation. No automatic recursive re-investigation.

## Operator workflow

Within the domain Profile Workspace:

1. Choose Investigate Domain or Investigate Drift/Failure.
2. Review/select normally 3–5 representative PDPs, approved hosts, model/data-sharing policy, and hard limits. Display the separately reserved holdout coverage without sending it to the investigator.
3. Launch explicitly; show queued/running/terminal status and cancellation. Persist partial observations on failure without calling them a successful proposal.
4. Display platform and page structures; sources and evidence links; field-by-field recommendations; product/variant support; rendered-browser need; gaps; provider/model; actual usage/cost or unavailable; stable failure codes.
5. Separate Validate Proposal, Apply to Draft, and Discard. Clearly label shared-draft publication and failed/incomplete validation. No Activate Automatically or Release Automatically action.

No operator approvals or live validations may be inferred from this design document.

## Required proof before implementation is called complete

- Deterministic fake-provider tests: valid/malformed output, missing evidence, timeout/error/cancellation, replayed completion, stale application, budget exhaustion.
- Security: foreign workspace scoping, secret exclusion, private/invalid URLs, redirect and subresource restrictions, unsupported channels/methods/action paths, unavailable isolation, off-domain evidence remaining untrusted. Container integration tests must attempt direct HTTP(S), raw-IP/DNS/UDP/WebSocket and host/LAN access with browser interceptors disabled, and verify denial; broker tests cover DNS rebinding, redirected private destinations, opaque tunnel refusal, and upstream TLS validation.
- Observation limits: oversized/chunked/decompression-bomb bodies, asset fan-out, aggregate/retry accounting, DOM/JSON depth and selector-result bounds, prompt/history/image re-send accounting, and unsupported monetary ceilings. Prove that clipped evidence cannot certify complete variant/image membership or a full content hash.
- Inspection grammar: unknown/malformed operations, executable-expression rejection, foreign/stale artifact references, bounded generic DOM/meta/JSON/network inspection, and successful investigation of an unfamiliar structure without enabling an unsupported production primitive.
- Governance: investigation/compile/validate/apply/discard never activate, release, attest image review, or write trusted extraction output.
- Compilation: adapter-first, selector exception, selector-only supported path, unsupported primitive, `requires_code_adapter`, incompatible structures.
- Shopify: exact GTIN/SKU/known variant ID, conflicts, absent identifiers, precise option discrimination, variant-specific field/image binding, endpoint evidence selection.
- Verification: representative success, blind-holdout pass/failure/missing, non-waivable holdout requirement, optional preference for greater structure coverage without a second count gate, no dropping failed reserved holdouts, wrong product/variant, image review pending, stale policy/evidence hashes; legacy profile behavior retained.
- End-to-end local pilot: explicit operator request → isolated local investigation → typed observations → Shopify policy → production-worker representative and blind-holdout validation → visible governed draft. Record what was actually performed; no activation/release required to prove draft delivery.
- Separate mandatory negative invariant: normal product extraction makes **zero investigation-provider calls**.
- Cloud smoke is not part of the initial implementation: Cloud v4 remains intentionally disabled under the owner decision, even if a key exists.

## Validation commands for implementation

CI (`.github/workflows/ci.yml`) runs Bun 1.3.5, frozen install, typecheck, changed-code audit, test-runner coverage, Vitest, and Bun DB suites:

```sh
bun install --frozen-lockfile
bun run typecheck
bunx fallow audit \
  --dead-code-baseline .fallow-baselines/dead-code.json \
  --health-baseline .fallow-baselines/health.json \
  --dupes-baseline .fallow-baselines/dupes.json
bun run test:runner-coverage
bunx vitest run
bun run test:db
```

Register new tests in the proper runner; several profile/audit/worker tests require the Bun DB runner, not Vitest. Run changed-code lint and report the distinction from the repository's existing full-lint debt (full lint is not a current CI gate). Record the actual fallow version because #211 reports local/CI version skew. Do not claim any of these commands ran during this documentation-only session.

## Official provider evidence

Checked 2026-09-17; public contracts can change and must be rechecked before any future Cloud integration:

- [Cloud v4 structured output](https://docs.browser-use.com/cloud/agent/structured-output): `run.result` is a string; JSON instructions plus client-side Zod validation. No `outputSchema` / `output_schema` request field.
- [Cloud v4 Create Run](https://docs.browser-use.com/cloud/api-v4/runs/create-run): exact supported run properties; do not import v2-era navigation/step controls.
- [Cloud secrets](https://docs.browser-use.com/cloud/guides/secrets): secret-binding allowed domains are explicitly not a browser-wide network/navigation allowlist.
- [CAPTCHA handling](https://docs.browser-use.com/cloud/browser/captcha-handling): auto-solving enabled for agent runs; standalone-browser disable flag is not a v4 run setting.
- [OSS browser parameters](https://docs.browser-use.com/open-source/customize/browser/all-parameters), [tools](https://docs.browser-use.com/open-source/customize/tools/available), [security watchdog source](https://github.com/browser-use/browser-use/blob/main/browser_use/browser/watchdogs/security_watchdog.py): tool/navigation controls do not replace all-request DNS/egress enforcement.

The read-only audit verified API shapes and existing code; it did not prove live isolation or execute an investigation. Those remain implementation acceptance work.

## Addendum: Tier 0 containerized execution (#236)

Recorded network-shape decision (also encoded in code as
`INVESTIGATION_NETWORK_SHAPE` in `src/onboarding/browser-investigation/isolation.ts`):

- **Tier 0 (implemented): host-side broker fetch with in-container analysis.**
  The host performs only broker-mediated captures and artifact retention
  (hashing). The fixed read plan executes inside the investigation container
  (`baystate/investigation-browser:1`, `--network=none`) as the
  dependency-free analyzer (`tier0-analyzer.mjs` via `tier0-analyzer-cli.mjs`):
  captures arrive on stdin, typed observations leave on stdout as a versioned
  envelope. The container launches zero fetches of its own; the host never
  parses page bytes (no DOM library in `local-harness.ts`). Missing or
  unavailable isolation — including a runner that cannot execute analysis —
  fails closed with `isolation_unavailable` and never falls back to host
  execution. Teardown (`docker rm -f` on the deterministic container name)
  runs on success, failure, timeout, and cancellation.
- **Tier 1 (explicitly deferred, #237): render container with proxy-only
  egress.** A rendered investigation reusing the existing rendered-page stack
  inside a container whose only egress is a validating forward proxy does not
  exist yet. Nothing in the Tier 0 argv, image, or docs implies it: the Tier 0
  container has no proxy variables and no network beyond `none`.

Image build (rebuild whenever the analyzer files change; `:1` is the
posture-pinned artifact the runner asserts):

```sh
docker build -t baystate/investigation-browser:1 \
  -f docker/investigation-browser/Dockerfile .
```

Deterministic suites inject an explicitly labeled in-process analyzer double
and stay daemon-free; live container execution (real `docker run` per run,
envelope parsing, teardown verification) is proven by
`browser-investigation-tier0-container.test.ts` whenever a daemon is
available, and skips loudly otherwise.
