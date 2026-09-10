---
name: shopsite-page-fields
description: 'Documentation-grounded advisor for ShopSite page field modeling, page XML structure, page-parser, page import services, and the page database upload/download workflow. Use this skill whenever the user mentions ShopSite pages, page XML, page fields, page upload, page templates, page database, page parser, page import, ShopSitePages, ProductOnPages, page layout, page display settings, or creating page support. Triggers on: "page field", "ShopSite page", "page XML", "page upload fields", "page template", "page database", "page parser", "page import", "page table", "ShopSitePages", "shopSitePages.dtd", "ProductOnPages", "page layout", "page display", "page columns".'
---

# ShopSite Page Fields

Use this skill to answer questions about **ShopSite page field names, types, XML structure, and page XML support**. It bridges the documented ShopSite page field catalog with the CMS page implementation (parse + import exist; page write path does not yet).

> **Codebase reality:** page XML **parsing and import exist** — `src/shopsite/page-parser.ts` (`parseShopSitePagesXml`, `toPageRecords`, `ShopSitePagesXmlParserAdapter`), page Zod identities in `src/shared/schemas/page.ts` (`exported_guid` / `exported_file_name` / `unverified_name_only`), and the download/import/preflight services (`page-download-service.ts`, `page-import-service.ts`, `page-sync-preflight.ts`). There is **no page normalizer, page denormalizer, or page XML builder** — the page write path is genuinely missing. Ground truth for the XML shape is the real-export fixture `src/tests/fixtures/shopsite-pages-bay-state-redacted.xml`.

## What this skill is for

This is a **page-field reference and build-guidance skill**. It should:
- answer what documented page fields exist, their types, defaults, and allowed values
- explain the page XML structure (root/DOCTYPE/identity tags confirmed from a real export; remaining field tags labeled confirmed-vs-inferred)
- document current codebase state for page support (what exists vs what is missing)
- guide agents through building the missing page write path (normalizer/denormalizer/builder), following the existing parser/import seams
- explain how `ProductOnPages` relates products to pages (first-class `core.productOnPages` + codec `extractPageNamesFromBlock`, *not* a preserved-XML hack)

This is **not** a CGI workflow skill. For `db_xml.cgi` parameters, `dbupload.cgi` flows, or `generate.cgi` publishing, use `shopsite-database`.

This is **not** a product-field skill. For product fields, XML tags, or the product codec, use `shopsite-product-fields`.

## Read these resources first

For any substantive request, read:
- `references/page-field-catalog.md` — complete list of 60+ documented page fields
- `references/page-xml-structure.md` — page XML structure (root/DOCTYPE/identity tags confirmed from a real export; remaining tags labeled confirmed-vs-inferred)
- `references/page-codebase-gaps.md` — current page-support gaps + build guidance

The `field-type-system.md` from `shopsite-product-fields` is also relevant — page fields use the same ShopSite field types.

## Core operating rules

1. **Default to evidence.**
   Treat the v15 upload.fields.html page section as authoritative for field **names**, **types**, **defaults**, and **allowed values**. Tag the evidence source clearly.

2. **Distinguish confirmed from inferred tags.**
   Root (`<ShopSitePages version="15.0">`), DOCTYPE (`"-//shopsite.com//ShopSitePage DTD//EN"`, `shopsitepages.dtd`), `<Response>` wrapper, and identity tags (`<PageID>`, `<PageTitle>`, `<PageFileName>`, `<LinksToPage>`, `<ProductLinks>`) are **confirmed** from the repo's real-export fixture (`src/tests/fixtures/shopsite-pages-bay-state-redacted.xml`, parsed by `src/shopsite/page-parser.ts`). Remaining field tags follow the confirmed-vs-inferred labeling in the domain references — recommend confirming unlisted tags against a real export.

3. **State the codebase honestly: read path exists, write path does not.**
   Page XML parsing (`src/shopsite/page-parser.ts`), page Zod identities (`src/shared/schemas/page.ts`), and the download/import/preflight services **exist** — never tell an agent to build them. What does not exist yet: page normalizer, page denormalizer / XML builder. `ProductOnPages` is a first-class `core.productOnPages: string[]` resolved by the product codec (`extractPageNamesFromBlock` / `resolveProductPageNames`, `src/shopsite/product-codec.ts:670-734`), not a hack.

4. **Route product-field questions to shopsite-product-fields.**
   If the user asks about product fields, product XML tags, or the product codec, direct them to `shopsite-product-fields`.

5. **Route CGI/workflow questions to shopsite-database.**
   If the user asks about `db_xml.cgi` page downloads, `dbupload.cgi` page uploads, or `generate.cgi`, direct them to `shopsite-database`.

## Response structure

For substantial answers, use this shape:

1. **Direct answer** — the page field name, type, default, and allowed values
2. **XML structure** — how the field serializes (confirmed vs inferred, labeled as such)
3. **Codebase status** — what exists (parser/import/preflight) and what is missing (write path)
4. **Build guidance** — only for the missing write path; build on the existing parser/import seams
5. **Caveats** — inferred tags, preservation requirements, confirmed-vs-inferred distinctions

## Final reminders

- Root, DOCTYPE, `<Response>` wrapper, and page identity tags are confirmed from the repo's real-export fixture — only unlisted field tags still need export confirmation.
- The `ProductOnPages` field bridges products and pages (first-class `core.productOnPages`); changes to page relationships affect product XML.
- Page field types are identical to product field types — cross-reference `field-type-system.md` from `shopsite-product-fields`.
- When building the missing page write path, follow the existing seams: parser (`page-parser.ts`) → Zod identities (`schemas/page.ts`) → import/preflight services → new builder, preserving unknown elements and advanced blocks.
