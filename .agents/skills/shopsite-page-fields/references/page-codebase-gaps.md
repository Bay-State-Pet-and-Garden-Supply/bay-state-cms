# Page Codebase Gaps & Build Guidance

## Current Status: Read Path Exists, Write Path Missing

The Baystate CMS codebase has **page XML parsing, import, and preflight**. Here is exactly what exists, what does not, and what needs to be built.

---

## What Exists

| Component | File | Status |
|-----------|------|--------|
| Page DB table | `src/db/repositories/` (implied by workspace schema) | Likely but unused; no XML round-trip |
| Page XML parser | `src/shopsite/page-parser.ts` | ✅ Implemented | Parses a real ShopSite Pages export (root `<ShopSitePages version="15.0">`, `<Response>`, `<Pages>`/`<Page>`); preserves raw fragments + unknown elements; named + numeric entity decoding; emits `exported_guid` verified identities from `<PageID>` |
| Page identity/import schemas | `src/shared/schemas/page.ts` | ✅ Implemented | `PageIdentity` (exported_guid / exported_file_name / unverified_name_only), `PageRecord`, `PageImport`, preview/activation contracts |
| Page import seams | `src/shopsite/page-import-service.ts`, `src/db/repositories/page-import-repo.ts`, `src/server/routes/page-routes.ts` | ✅ Implemented | Parser-adapter contract (`PageParserAdapter`; `getPageParserAdapter()` returns the real parser); preview (no DB effect) / atomic activation; `page_imports` table; page_index identity columns |
| Page XML fixture | `src/tests/fixtures/shopsite-pages-bay-state-redacted.xml` | ✅ Implemented | Redacted 12-page subset of a real 211-page export (home/category/hidden/product pages, ProductLinks, HTML text, numeric entities) |
| Page XML tests | `src/tests/unit/page-parser.test.ts` | ✅ Implemented | Fixture round-trip, identity mapping, entity decoding, raw preservation; optional full-export test via `SHOP_SITE_PAGES_XML` |
| ProductOnPages handling | `src/shopsite/product-codec.ts:670-734` | First-class `core.productOnPages: string[]`; page names extracted via `extractPageNamesFromBlock`, emitted as `<ProductOnPages><PageLink><Name>` |
| Sample product data | `src/tests/fixtures/shopsite-products-sample.xml` | Product samples only |

---

## What is Missing

| Component | File (planned) | Status | Notes |
|-----------|----------------|--------|-------|
| Page normalizer | `src/shopsite/page-normalizer.ts` | ❌ Does not exist | Follow the product codec decode pattern (`CORE_FIELDS` → model mapping) |
| Page denormalizer | `src/shopsite/page-denormalizer.ts` | ❌ Does not exist | Follow the product codec encode pattern (explicit emit + unknown/block preservation) |
| Page XML builder | `src/shopsite/xml-builder.ts` | Existing (product only) | Would need page-specific handling |
| Verified Page activation | `src/shopsite/page-import-service.ts` activate | Pending real import | Activation is implemented and atomic; requires running an actual import (the redacted fixture is test data only) |
| Page workspace model | `src/shared/schemas/workspace.ts` | May have page fields | Schema-level page identity may exist |

---

## Current ProductToPages Handling

`ProductOnPages` is a **first-class product field**, not a preserved-XML hack:

### In decode (`src/shopsite/product-codec.ts`, `BLOCK_TAGS` `:64-68`):
The tag `ProductOnPages` is a block tag, so its raw XML is preserved in `advancedBlocks` — and `extractPageNamesFromBlock` immediately resolves it into first-class `core.productOnPages: string[]` (`src/shared/schemas/product.ts:45`).

### Resolution order (`resolveProductPageNames`, `product-codec.ts:703-734`):
1. `core.productOnPages` (canonical)
2. `unknownElements['ProductOnPages']` — un-migrated drafts or legacy rows
3. `advancedBlocks['ProductOnPages'/'productOnPages']` — raw XML fallback

`extractPageNamesFromBlock` (`:670-700`) handles `<Name>`, `<PageName>`, and `<PageLink>` child tags, with fallback text extraction.

### In encode (§15, `product-codec.ts:519-529`):
Resolved names are re-emitted in the modern layout:

```xml
<ProductOnPages>
  <PageLink>
    <Name>Category Page 1</Name>
  </PageLink>
  <PageLink>
    <Name>Category Page 2</Name>
  </PageLink>
</ProductOnPages>
```

**What this means:** The CMS round-trips product page assignments fully. What it still cannot do:
- Emit page XML (no page builder)
- Edit page metadata (titles, layout, colors, SEO) through a typed model
- Manage page-to-product assignments from the page side
- Create new pages

---

## Build Guidance (Write Path Only)

Phases 1–3 below are **done** (fixture + parser + Zod identities exist). The remaining work is Phases 4–5: the page write path.

### Phase 1: Discovery — DONE

Root, DOCTYPE, `<Response>` wrapper, and identity tags (`<PageID>`, `<PageTitle>`, `<PageFileName>`, `<LinksToPage>`, `<ProductLinks>`) are confirmed from `src/tests/fixtures/shopsite-pages-bay-state-redacted.xml`. Still open: unconfirmed ⚠️ field tags (see `page-xml-structure.md`), color-field encoding, and any XML-only fields. Resolve those from the fixture or a fresh store export — do not re-derive the root/DOCTYPE.

### Phase 2: Parser — DONE

`src/shopsite/page-parser.ts` (`parseShopSitePagesXml`, `toPageRecords`, `ShopSitePagesXmlParserAdapter`). Do not rebuild.

### Phase 3: Zod Schema — DONE (core identities)

`src/shared/schemas/page.ts` (`PageIdentity`, `PageRecord`, `PageImport`, preview/activation contracts). Extend — do not restart — if the write path needs more modeled fields.

### Phase 4: Build the Page Emit Layer

New work. Follow the product codec encode pattern (`ShopSiteProductCodec.encode`, `src/shopsite/product-codec.ts:430-626`):
- Emit known fields with proper escaping
- Preserve unknown elements and advanced blocks
- Handle CDATA sections for HTML text fields
- Validate XML tag names for custom fields (warn + skip)

### Phase 5: Add Tests

Extend `src/tests/unit/page-parser.test.ts` with emit/round-trip coverage, following `shopsite-xml-roundtrip.test.ts` patterns.

### Phase 6: HTTP Client (If Needed)

If needed, update `src/shopsite/shopsite-http-client.ts` to support:
- `db_xml.cgi?dbname=pages` for page downloads
- `dbupload.cgi?dbname=pages` for page uploads

---

## Preservation Rules (Must Follow)

When building page support, follow the same preservation rules as the product layer:

1. **Unknown elements MUST survive round-trips** — every unrecognized XML tag is preserved in `unknownElements` and re-emitted unchanged
2. **Advanced blocks MUST survive round-trips** — block-level elements are preserved as raw XML
3. **`PageField*` prefix convention** — any tag starting with `PageField` should be captured as a custom field
4. **CDATA content must be safely escaped** — use `escapeCdata()` from `multipart-upload.ts`
5. **Checkbox serialization** — use `checked`/`uncheck` format consistent with product XML
6. **Invalid XML tag names** — generate warnings and skip, consistent with the product codec encode (§§20/22)

---

## Known Unknowns

| Question | Why It's Unknown | Resolution |
|----------|-----------------|------------|
| Root element name | No official page XML example published | **Resolved:** `<ShopSitePages version="15.0">` + `<Response>`/`<Pages>`/`<Page>` per real-export fixture |
| DTD name and URL | Was inferred from pattern | **Resolved:** `"-//shopsite.com//ShopSitePage DTD//EN"`, `shopsitepages.dtd` per fixture |
| Color field encoding | Could be hex (`#000000`), named (`Black-True (#000000)`), or XML attributes | Fixture or fresh store export (still open) |
| Relationship field format | Was pipe-delimited vs blocks | **Resolved:** `<LinksToPage>` / `<ProductLinks>` blocks per fixture; round-trip encoding for emit still open |
| Field type for display columns | Columns/alignment have limited values; encoding unknown | Fixture or fresh store export (still open) |
| Additional XML-only fields | Some fields may only appear in XML format | Fixture or fresh store export (still open) |
