# Provider billing evidence — onboarding pilot

**Research date:** 2026-10-22  
**Scope:** Public first-party documentation and the observed local adapter/pricing contracts only. No provider API call, account/console access, secret inspection, or credit use was performed. This note is research, not operator-provided runtime data, source authorization, or price approval.

## Decision

**BLOCKED — no documentary evidence establishes a complete enforceable sub-$3 combined live spend ceiling.** TypeSafe publishes input-only Jev rates and context limits, but the reviewed public contract does not establish that all billable input usage (including any hidden/internal overhead) is bounded by the published request context limit, nor a provider-enforced run/account hard-spend ceiling covering concurrent and in-flight requests. Serper publicly advertises credits and package rates, but the reviewed public evidence does not establish an account-specific hard credit/spend fence, an exact charge rule for every physical request/error/retry, or a cap covering concurrency/in-flight effects. Local reservation policy is not upstream enforcement or operator approval.

Nothing found genuinely satisfies the `<$3` combined-live-authorization prerequisite. Published advertised unit prices are not themselves a run-wide cap. Do not remove the current TypeSafe refusal on the basis of this research.

## TypeSafe System One / Jev

### Published public claims (TypeSafe docs, reviewed 2026-10-22)

- [Models and pricing](https://docs.typesafe.ai/models): the current Jev table gives `$42 / $0.042` per Btok/Mtok for Jev 1.14 and 1.13. The page says: “You pay per input token. Output tokens are free.” A Btok is a billion tokens; an Mtok is a million tokens. Thus the published rate is **USD** `$0.042 / 1,000,000 input tokens` for those listed Jev versions; output tokens are advertised as free. This is a published advertised rate, not a complete bill contract.
- [Models: context length](https://docs.typesafe.ai/models#context-length): Jev 1.14/1.13 context limits are **64k per-request / 32k per-question** by default. With `TypeSafe-Danger-Zone-Long-Context: true`, both are **262k**. The docs define the per-request context as `state` plus all questions combined and per-question as `state` plus an individual question. Long context costs the same per token.
- [Request rules and errors](https://docs.typesafe.ai/api/errors#request-rules): request body is at most **32 MiB**; a request over model context returns `400` with `max_tokens_exceeded`. These are request validity limits, not a monetary cap. The same page documents `429` rate limit and `529` overload responses, and recommends retry/backoff; rate limiting is not a cumulative-spend cap.
- [System One API reference](https://docs.typesafe.ai/api/system-one): response usage includes `input_tokens` and `output_tokens` (example: `120` and `12`). The response schema documents usage reporting, not an upstream spend-limit control.
- [Organization rate limits](https://docs.typesafe.ai/models#rate-limits): limits are per organization and measured in tokens/second and requests/second; current values are in the authenticated developer console. Those are throughput limits, not spend fences. No account-specific values were accessed.

### What the evidence does and does not bound

- **Billable direction:** documented input-only; output tokens free. The model/pricing code currently stores Jev 1.13 input rate `0.042` per million and `outputPerMillion: null` (`src/ai/model-pricing.ts:34-37`), and computes cost from observed prompt/input token count while zeroing the output-cost leg for this output-free rate (`:79-89`). This estimate is not a pre-dispatch maximum.
- **Conditional arithmetic, not a proved billing maximum:** if every billable input token were guaranteed to be included in the documented context count, a standard request would be at most `64,000 × $0.042 / 1,000,000 = $0.002688`; long-context would be `262,000 × $0.042 / 1,000,000 = $0.011004`. These calculations are conditional illustrations only. The public docs reviewed do not explicitly bind the billable `usage.input_tokens` measure to a guaranteed maximum equal to those context counts, or state whether provider-internal/reasoning/prompt overhead is included in that maximum. No per-request billing cap or provider hard spend-fence feature was documented in the sources reviewed. Do not promote this arithmetic to an enforceable reservation amount.
- **Whole-run / concurrency / in-flight:** no public run-scoped spend cap, account hard-spend control, or semantics for stopping already accepted/concurrent/in-flight requests were established. A request-size/context maximum—even if fully tied to the billable counter—would not by itself cap a run with an unbounded number of attempts.
- **Missing documentary evidence:** explicit billing definition for all billed dimensions and internal overhead; an enforceable request-level maximum, or provider-enforced run/account monetary fence; cap semantics for concurrent requests, timeouts, retries, and accepted/in-flight requests; and any account-specific control/limit evidence. No console or account settings were checked.

### Existing local refusal (observed contract only)

`src/ai/systemone-transport.ts:833-838` explicitly says TypeSafe's documented System One request has no enforceable output-token cap and denies model-priced acquisition with `ItemAcquisitionBudgetDeniedError('budget_not_enforceable', 'typesafe_output_token_limit')` before fetch. The transport's local timeout and byte constraints are not represented here as upstream billing bounds. This research does not alter that refusal or claim that providers can never supply sufficient evidence.

## Serper Search

### Published / first-party information reviewed

- [Serper homepage](https://serper.dev/): the official landing page advertises **2,500 free queries**. The official homepage's indexed pricing content returned by web search on 2026-10-22 advertised a **Starter** package of **$50 for 50,000 credits**, shown as **$1.00/1k**, and “Submit 50,000 queries.” The direct page reader did not expose the pricing table in its extracted text; this exact tier is recorded as an advertised homepage claim, not independently account-verified pricing or approval. No currency other than the displayed **USD `$`** is inferred.
- [Serper Terms](https://serper.dev/terms): the accessible page identifies prepaid “Serper API credits” and refund conditions, but reviewed terms do not specify the charge-counting rule for a search request, failures, retries, or concurrent/in-flight jobs, nor a hard-spend stop behavior.
- Direct reads of `https://serper.dev/pricing` and `https://serper.dev/docs` returned HTTP 404 at research time. No accessible official public API billing specification establishing charge semantics or a hard account cap was located in this review. No API/account was contacted.

### Local request contract (not a provider charge guarantee)

`src/onboarding/serper-search.ts:3-5,28-51,63-70` shows one adapter invocation validates a query of 1–600 characters and at most 75 words, validates result `count` 1–20, and issues one fixed-origin `POST https://google.serper.dev/search` with `{q,num}`. It applies a 15-second timeout and a default 1 MiB complete-response cap. Caller `src/onboarding/item-evidence-acquisition.ts:620-645` requests `count: 20`, reserves one attempt, then dispatches the adapter. These are locally observable request/response bounds only. They do not prove the provider charges exactly one credit per POST, that failed/ambiguous requests are free, that retries cannot occur elsewhere, or that account credits cap all concurrent/in-flight work.

### Billing conclusion

- **Advertised rate/package:** a first-party homepage claim of $50 / 50,000 credits (`$1.00/1k`) is visible in indexed homepage content; it is neither operator-entered price authorization nor an account-specific statement.
- **Enforceable unit bound:** the adapter attempts one HTTP POST per invocation, but no reviewed official documentation establishes the exact billed unit for every response/error/retry or guarantees a finite number of physical calls for a full run.
- **Account-specific fence:** credit balance/current account settings and provider-side behavior are not verified. No documented run-scoped monetary fence or in-flight/concurrency cap was established.
- **Missing documentary evidence:** authoritative billing unit and treatment of errors/timeouts/retries, account-specific credit/spend status and hard-stop semantics, plus a cap that accounts for simultaneous and already-in-flight requests.

### Operator-reported account position (2026-10-23, unverified by tooling)

- Operator reports **$3.30 TypeSafe allowance** and **2,499 Serper credits** available for the pilot.
- This is an operator statement, not provider-console evidence: no API/account was contacted, no balance endpoint read, no statement attached.
- Treatment decision for T4: dollar accounting uses the $3.30 TypeSafe allowance as the USD ceiling input; Serper accounting counts **credits consumed per POST** against the 2,499-credit pool, reported separately — credits are not converted to dollars at an unverified rate.
- The per-POST worst case assumed for reservation is **1 credit per dispatched POST** (one HTTP POST per `searchSerperWeb` invocation). Provider-side retry/error billing beyond the single POST is uncontracted and stays an unknown liability until Serper documents it or the operator accepts the residual.

## Combined authorization status

The advertised Jev input rate and Serper package/query price are unit pricing evidence only. Neither establishes approved source/runtime data sharing or price approval, and neither alone bounds cumulative spend. No verified maximum for each physical effect plus all outstanding liabilities and concurrent/in-flight effects is evidenced here. Therefore the complete combined live authorization remains **BLOCKED** under the pilot's `$3 total across both arms, retries, source preparation, and paid checks` interpretation. This document does not authorize any call or substitute for operator-provided approval/source truth.
