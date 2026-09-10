# ShopSite documented surface

Use this file for the facts the skill can state confidently.

## Source map

These are the official ShopSite page titles distilled in the deep research report:
- `Database Automated XML Upload/Download`
- `MIME Encoded XML Upload`
- `Database XML Upload/Download SDK`
- `Database Upload/Download`
- `Database Upload`
- `Database Upload - Match Upload Fields`
- `Database Upload Progress`
- `Databases Upload Results`
- `Database Upload/Download Fields` (v15) — product and page field catalogs
- `Automatic XML Orders Download` — order download flow and parameters
- `Orders Download XML Format` — order DTD
- `Custom CGI Interface` — thankyou.cgi/custom.cgi POST fields

When you mention sources, prefer these page titles over vague references.

## Field catalogs

Field names, types, defaults, and allowed values ARE documented for:
- **Products** — see `shopsite-product-fields` skill (`references/product-field-catalog.md`)
- **Pages** — see `shopsite-page-fields` skill (`references/page-field-catalog.md`)

What remains **underspecified** for both:
- Confirmed XML tag names for catalog fields not yet seen in a real `db_xml.cgi` export
- The full product/page DTD content

Confirmed from the repo's real-export fixture
(`src/tests/fixtures/shopsite-pages-bay-state-redacted.xml`, parsed by
`src/shopsite/page-parser.ts`): page root is `<ShopSitePages version="15.0">`
with `<Response>` / `<Pages>` / `<Page>` wrappers, DOCTYPE
`"-//shopsite.com//ShopSitePage DTD//EN"` (`shopsitepages.dtd`), and identity
tags `<PageID>`, `<PageTitle>`, `<PageFileName>`, `<LinksToPage>`, `<ProductLinks>`.

When asked about field details, route to the domain skills. When a field's XML tag is needed for code, recommend confirming from a real export.

## Supported automated scope

The grounded automated XML workflow is documented for:
- `products`
- `pages`

Do **not** assume the same automated XML upload flow is documented for orders, associates, or every other ShopSite table.

Order XML download is covered by a separate skill (`shopsite-orders`, if installed — not present in this repo).

## Core workflow

### Download flow
Use `db_xml.cgi` to download all or part of a supported database in XML.

### Upload flow
Use `dbupload.cgi` to upload XML or import an XML file that is already present in the HTML output directory.

### MIME upload completion
If the upload uses MIME multipart encoding, ShopSite documents a follow-up step with `dbmake.cgi` using the returned `return_string` exactly as returned.

### Publish flow
After import, use `generate.cgi` or the equivalent publish flow so the storefront reflects the changes.

## Endpoint matrix

| Endpoint | Purpose | Notes |
|---|---|---|
| `db_xml.cgi` | Download XML for `products` or `pages` | Docs discuss standard HTTP POST and also show query-style examples |
| `dbupload.cgi` | Upload/import XML for `products` or `pages` | Supports matching, new-record handling, deferred linking, restart |
| `dbmake.cgi` | Finalize a MIME upload | Use returned `return_string` exactly as returned |
| `generate.cgi` | Publish/regenerate store output | Needed after import so shoppers can see changes |

## Download parameters

| Parameter | Requiredness | Values / shape | Meaning |
|---|---|---|---|
| `clientApp` | Required | `1` | Interface version identifier |
| `dbname` | Required | `products`, `pages` | Target database |
| `download_shopsite_version` | Optional | `1` | Return running ShopSite version |
| `version` | Optional | `14.0`, `12.0` (default), `11.2`, `11.1`, `11.0`, … (per live v15 page; no v15 XML format version is documented) | XML compatibility version |
| `fields` | Optional | Pipe-delimited list, e.g. `|Name|SKU|Price|` | Limit downloaded fields |
| `fieldmap` | Optional | Existing fieldmap name | Use a predefined mapping |

## Upload parameters

| Parameter | Requiredness | Values / shape | Meaning |
|---|---|---|---|
| `clientApp` | Required | `1` | Interface version identifier |
| `dbname` | Required | `products`, `pages` | Target database |
| `filename` | Optional | Filename string | Import XML already present in the HTML output directory |
| `uniqueName` | Optional | Products: `Name`, `SKU`, `Product GUID`, `(none)`; Pages: `Name`, `File+Name`, `(none)` (defaults to `Name`) | Match uploaded rows to existing records |
| `newRecords` | Optional | `yes` default, `no` | Add unmatched rows or ignore them |
| `defer_linking` | Optional | `no` default, `yes` | Defer linking for staged/batched uploads |
| `restart` | Optional | `1` | Resume an interrupted upload |
| `checkpoint` | Version-variable | Integer, often `500` in one official capture (absent from the current v15 upload page) | Checkpoint interval for large uploads |
| `use_optimizer` | Documented | `no` in the official MIME example (older captures vary) | Optional optimization for very large uploads |
| `batchsize` | Documented | Integer, `500` in the official MIME example | Records processed per batch |

## Publish parameters

| Parameter | Requiredness | Values / shape | Meaning |
|---|---|---|---|
| `clientApp` | Required | `1` | Interface version identifier |
| `htmlpages` | Optional | `1` | Generate HTML pages |
| `custompages` | Optional | `1` | Generate custom pages |
| `index` | Optional | `1` | Update search index |
| `regen` | Optional | `1` | Force full regenerate |
| `sitemap` | Optional | `1` | Generate XML sitemap |

## Matching and risk rules

- `uniqueName=(none)` disables matching and allows duplicates.
- `newRecords=no` ignores unmatched rows instead of creating them.
- Stable identifiers are safer than name-only matching when the user has a true unique key.
- For products, `SKU` is typically the safest documented matching choice when available.

## Large-upload rules

- For very large uploads, recommend splitting work into batches.
- Use `defer_linking=yes` on all but the last batch.
- `checkpoint` should be presented as version-variable (older capture only), not universal. `use_optimizer` and `batchsize` are documented in the official MIME example.
- After deferred linking, remind the user to finish linking and publish.

## Recovery and troubleshooting rules

- `restart=1` is the documented automated recovery path for interrupted uploads.
- In back-office/UI flows, ShopSite documents Continue Upload / Discard Upload behavior.
- An unfinished upload can block starting new uploads or downloads until it is completed or discarded.
- If the user says changes are not visible, remind them to publish/regenerate the store.

## MIME upload facts

- The crawlable MIME example is **product-oriented**.
- It shows multipart form fields such as `clientApp`, `dbname`, `uniqueName`, `newRecords`, `use_optimizer`, and `defer_linking`.
- It includes a product XML example with `ShopSiteProducts`, a `Response` block, `Products`, `Product`, and `Name`.
- The official example includes the `<Response>` block **inside the uploaded XML payload** (before `<Products>`). Include it verbatim and treat it as required for safety. There is no `Response` form-data part in the documented multipart body.
- The docs do **not** publish a page-side XML example in the crawlable material — but the page root/DOCTYPE/identity tags are confirmed from this repo's real-export fixture (see above).

## Honest boundaries

The skill can speak confidently about:
- endpoint names
- documented parameters
- documented workflow order
- matching / duplicate / batching / restart behavior
- the need to finalize MIME uploads and publish imports

The skill must label these as unspecified or incomplete:
- canonical auth mechanism for automated CGI calls
- full product XML schema
- full page XML schema
- which XML child elements are required vs optional beyond the limited example
- a canonical machine-readable ShopSite error-code catalog
