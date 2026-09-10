# Page XML Structure (Root + Identity Confirmed)

> Root element, DOCTYPE, `<Response>` wrapper, and identity tags below are **confirmed** from the repo's real-export fixture `src/tests/fixtures/shopsite-pages-bay-state-redacted.xml`, parsed by `src/shopsite/page-parser.ts`. Remaining field tags are labeled ✅ confirmed (seen in the fixture) or ⚠️ inferred (ShopSite convention, not yet seen in an export).

---

## Confirmed Root Element

From the real-export fixture (NOT inferred):

```xml
<?xml version="1.0" encoding="ISO-8859-1"?>
<!DOCTYPE ShopSitePages PUBLIC "-//shopsite.com//ShopSitePage DTD//EN" "http://www.shopsite.com/XML/2.9/shopsitepages.dtd">
<ShopSitePages version="15.0">
<Response>
<ResponseCode>1</ResponseCode>
<ResponseDescription>success</ResponseDescription>
</Response>
<Pages>
  <Page>
    <Name>##FaceBook Store</Name>
    <PageTitle>FaceBook Store</PageTitle>
    <PageFileName>facebook-store.html</PageFileName>
    <PageID>12</PageID>
    <!-- page fields here -->
    <LinksToPage>...</LinksToPage>
    <ProductLinks>...</ProductLinks>
  </Page>
</Pages>
</ShopSitePages>
```

**Confirmed facts:**
- Root is `<ShopSitePages version="15.0">` with `<Response>` / `<Pages>` / `<Page>` wrappers (same envelope pattern as products)
- DTD is singular `"-//shopsite.com//ShopSitePage DTD//EN"` (`shopsitepages.dtd`), **not** `"ShopSitePages DTD"`
- Identity tags are `<PageID>`, `<PageTitle>`, `<PageFileName>` — **not** `<Title>` or `<FileName>`
- Relationship blocks are `<LinksToPage>` and `<ProductLinks>`
- The parser (`parseShopSitePagesXml`, `page-parser.ts:171`) handles entities, identities, and raw preservation; `toPageRecords` (`:206`) emits `PageRecord` rows

---

## Field Tag Mapping (✅ = seen in real export, ⚠️ = inferred)

| Field Name | Tag | Status | Likely XML Format | Notes |
|---|---|---|---|---|
| `Name` | `Name` | ✅ | `<Name>Page Name</Name>` | Seen in fixture |
| `File name` | `PageFileName` | ✅ | `<PageFileName>page.html</PageFileName>` | **Not** `<FileName>` — confirmed by fixture |
| `Title` | `PageTitle` | ✅ | `<PageTitle>Page Title</PageTitle>` | **Not** `<Title>` — confirmed by fixture |
| `Page ID` | `PageID` | ✅ | `<PageID>12</PageID>` | Identity tag; feeds `exported_guid` identities |
| `Display Name?` | `DisplayName` | ⚠️ | `<DisplayName>checked</DisplayName>` | Checkbox format |
| `Graphic` | `Graphic` | ✅ | `<Graphic>media/banner.jpg</Graphic>` | Seen in fixture (value `none` when unset) |
| `Display Graphic?` | `DisplayGraphic` | ⚠️ | `<DisplayGraphic>checked</DisplayGraphic>` | Checkbox |
| `Text 1` | `Text1` | ✅ | `<Text1><![CDATA[...]]></Text1>` | Seen in fixture |
| `Text 2` | `Text2` | ✅ | `<Text2><![CDATA[...]]></Text2>` | Seen in fixture |
| `Text 3` | `Text3` | ✅ | `<Text3><![CDATA[...]]></Text3>` | Seen in fixture |
| `Link Name` | `LinkName` | ✅ | `<LinkName>Link Text</LinkName>` | Seen in fixture |
| `Link Graphic` | `LinkGraphic` | ✅ | `<LinkGraphic>media/link.jpg</LinkGraphic>` | Seen in fixture |
| `Link Text` | `LinkText` | ✅ | `<LinkText>Description</LinkText>` | Seen in fixture |
| `Text Wrap` | `TextWrap` | `<TextWrap>On</TextWrap>` | |
| `Template` | `Template` | `<Template>template-name</Template>` | Case-sensitive value |
| `Item Alignment` | (various) | (likely stored as coded value) | May use internal coded format |
| `Columns` | `Columns` | `<Columns>Two columns</Columns>` | Exact string match |
| `Page Link Columns` | `PageLinkColumns` | `<PageLinkColumns>One column</PageLinkColumns>` | |
| `Display column borders?` | (various) | (likely checkbox format) | |
| `Page Width` | `PageWidth` | `<PageWidth>100% wide</PageWidth>` | Exact string match |
| `Search Products` | `SearchProducts` | `<SearchProducts>checked</SearchProducts>` | |
| `Index` | `Index` | `<Index>checked</Index>` | |
| `Include In Sitemap` | `IncludeInSitemap` | `<IncludeInSitemap>checked</IncludeInSitemap>` | |
| `Sitemap Priority` | `SitemapPriority` | `<SitemapPriority>Google Default</SitemapPriority>` | |
| `Order` | `Order` | `<Order>None</Order>` | |
| `Products Sort Field` | `ProductsSortField` | `<ProductsSortField>Name</ProductsSortField>` | |
| `Pages Sort Field` | `PagesSortField` | `<PagesSortField>Name</PagesSortField>` | |
| `Products First` | `ProductsFirst` | `<ProductsFirst>checked</ProductsFirst>` | |
| `Number Products` | `NumberProducts` | `<NumberProducts>0</NumberProducts>` | |
| `Page Field 1`–`25` | `PageField1`–`PageField25` | `<PageField1>value</PageField1>` | Consistent with product's `ProductField*` |
| `Text Color` | (unknown) | Hex format `#000000` | May use hex or named format |
| `Background Color` | (unknown) | Hex format `#FFFFFF` | |
| `Background Image` | `BackgroundImage` | `<BackgroundImage>none</BackgroundImage>` | |

**Color fields** (`Text Color`, `Background Color`, `Link Color`, etc.) may use non-standard tag names because they accept both hex values and named strings with parenthetical hex codes. Their XML tag names are less predictable.

**Relationship fields** are confirmed as blocks: `<LinksToPage>` and `<ProductLinks>` (seen in fixture; parsed generically into `fields`/`blocks` by `page-parser.ts:129-151`).

---

## ProductOnPages Relationship

Products reference pages through the `ProductOnPages` block element in product XML, emitted in the modern layout:

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

Conversely, pages reference products through `ProductLinks` in page XML. These are two views of the same relationship:
- **Product side:** `ProductOnPages` — first-class `core.productOnPages: string[]`, resolved by the product codec (`extractPageNamesFromBlock` / `resolveProductPageNames`, `src/shopsite/product-codec.ts:670-734`)
- **Page side:** `ProductLinks` — parsed by `page-parser.ts`; page-side *emission* is not yet implemented (no page builder)

---

## DTD Note

The page DTD name is confirmed singular — `"-//shopsite.com//ShopSitePage DTD//EN"` (`shopsitepages.dtd`, 2.9 URL) — matching the product pattern (`"ShopSiteProduct DTD"`). Per-element DTD requirements beyond that are still unconfirmed; only a real page DTD could settle them.

---

## Recommendation for Build (Write Path Only)

The read path — parser (`src/shopsite/page-parser.ts`), Zod identities (`src/shared/schemas/page.ts`), download/import/preflight services, tests (`src/tests/unit/page-parser.test.ts`) — **already exists. Do not rebuild it.** What remains is the page write path (normalizer/denormalizer/builder). When building it:

1. **Reuse the fixture** `src/tests/fixtures/shopsite-pages-bay-state-redacted.xml` as the shape reference (root, DOCTYPE, identity tags confirmed)
2. **Analyze remaining gaps**: which ⚠️-inferred tags above are still unconfirmed; how relationship blocks (`LinksToPage`, `ProductLinks`) should round-trip
3. **Build on existing seams**: `ShopSitePagesDocument` / `PageRecord` types, `page-import-service.ts` preview/activate flow, `page-sync-preflight.ts` reconciliation
4. **Follow the product codec pattern**: `CORE_FIELDS`-style tag set → model mapping → `encode`-style emission with unknown-element preservation, consulting `src/shopsite/field-catalog.ts` conventions
5. **Add round-trip tests** following `page-parser.test.ts` and `shopsite-xml-roundtrip.test.ts` patterns
