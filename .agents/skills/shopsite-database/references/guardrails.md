# Guardrails and wording

Use this file when the request pushes beyond what the ShopSite pages clearly document.

## Default posture

Start from this assumption:
- the CGI surface is documented well enough to explain workflows and build examples
- the full XML schema and auth story are **not** documented well enough to pretend certainty

When in doubt, be explicit about what is documented versus what is not.

## What to refuse or narrow

### Unsupported automated targets
If the user asks to automate XML uploads for tables outside `products` or `pages`, answer along these lines:

> The ShopSite pages I’m grounded on document automated XML upload/download for **products** and **pages**. They do not document the same automated XML workflow for that target here, so I can’t present it as an official supported flow.

### Full schema requests
If the user asks for a full XML schema, exact required tags, or a page XML root element:

> Product field names, types, defaults, and allowed values ARE documented in the `shopsite-product-fields` skill. Page field names, types, defaults, and allowed values ARE documented in the `shopsite-page-fields` skill. However, the exact XML tag names for fields not yet confirmed by the codebase or a real export are **inferred**, not guaranteed. The full DTD content, the page XML root element, and the page DTD name are still unspecified.

> I can give you a documentation-derived starter based on the field catalogs, but I can’t label inferred XML tags as official. Export a real sample from the target store to confirm.

### Authentication questions
If the user asks for session cookies, auth headers, login parameters, or a definitive execution recipe:

> The ShopSite pages I’m using here describe the CGI endpoints and parameters, but not a canonical authentication mechanism for automated calls. Auth is environment-specific in the material I’m grounded on.

## Risk confirmations

### `uniqueName=(none)`
Say clearly that:
- matching is disabled
- duplicate creation becomes possible
- the user should choose it only intentionally

Suggested wording:

> `uniqueName=(none)` turns off matching, so uploaded rows may create duplicates instead of updating existing records. If you only want inserts and you understand the duplicate risk, I can still show the example.

### `newRecords=no`
Say clearly that:
- unmatched rows will be ignored
- only matched records will update

Suggested wording:

> `newRecords=no` means ShopSite will ignore rows that do not match an existing record under your chosen unique key. That is safe for update-only jobs, but it will silently skip brand-new items.

## Version-variable details

Present these carefully:
- `checkpoint`
- `use_optimizer`
- `sitemap`

Suggested wording:

> This option appears in some official ShopSite captures but not consistently across the crawlable material I’m grounded on, so I’d treat it as version-variable rather than universally available.

## MIME-specific honesty

The crawlable MIME example is useful, but incomplete.

Always mention:
- it is product-oriented
- the `Response` block appears in the example, but its upload requiredness is unspecified
- page-side XML is not shown in the crawlable material
- `dbmake.cgi` is required after MIME upload using the returned `return_string`

Suggested wording:

> I can give you a documentation-derived MIME starter for products, but I can’t claim it is a full canonical schema. The ShopSite page shows a `Response` block in the example without clearly saying whether it is required for uploads.

## Safe next-best moves

When the docs run out, recommend one of these grounded next steps:
- consult the `shopsite-product-fields` or `shopsite-page-fields` skill for documented field names, types, defaults, and allowed values
- export a product/page sample from the target ShopSite store and treat that as the authoritative XML template for confirming tag names
- confirm environment-specific auth details from the store's actual setup
- compare the user's real upload results/report against the documented workflow
- use a safer matching key before attempting a large update

## Response pattern

When the request is tricky, structure the answer like this:
1. **What the docs do say**
2. **What I can safely generate**
3. **What remains unspecified**
4. **Best next step**

That shape keeps the skill useful without overstating certainty.
