# ShopSite Page Field Catalog

Complete reference of all documented ShopSite page database fields, sourced from the official [Database Upload/Download Fields](https://help.shopsite.com/help/15.0/en-US/sc/pro/upload.fields.html) page (ShopSite Pro v15).

> **Tag status:** Root, DOCTYPE, `<Response>` wrapper, identity tags (`<PageID>`, `<PageTitle>`, `<PageFileName>`, `<LinksToPage>`, `<ProductLinks>`), and all ✅-marked tags are **confirmed** from the repo's real-export fixture (`src/tests/fixtures/shopsite-pages-bay-state-redacted.xml`, parsed by `src/shopsite/page-parser.ts`). Unmarked tags remain **inferred** from field names — confirm against a real export before emitting.

---

## 1. Core Identity Fields

| Field Name | XML Tag | Type | Default | Allowed Values | Notes |
|---|---|---|---|---|---|
| `Name` | `Name` | Text Entry | **Required, no default** | Any text including HTML | Page name; appears as heading |
| `File name` | `PageFileName` ✅ | Text Entry | Null | Valid `.htm` or `.html` filename | Published page filename (confirmed, **not** `FileName`) |
| `Title` | `PageTitle` ✅ | Restricted Text | Null | No reserved chars (`&`, `"`, `'`, `<`, `>`) | HTML `<title>` tag content (confirmed, **not** `Title`) |
| `Page ID` | `PageID` ✅ | System | Assigned by ShopSite | Integer | Stable page identity; feeds `exported_guid` identities in `schemas/page.ts` |
| `Display Name?` | `DisplayName` ✅ | Checkbox | `checked` | `checked` / `unchecked` | Show page name on store page |

---

## 2. Media & Display Fields

| Field Name | XML Tag | Type | Default | Allowed Values | Notes |
|---|---|---|---|---|---|
| `Graphic` | `Graphic` | Image | `none` | File path/URL | Page header graphic |
| `Page Graphic Desc` | `PageGraphicDesc` ✅ | Text Entry (inferred) | Null | Short text | Description of the page graphic (fixture-confirmed tag; doc type unconfirmed) |
| `Display Graphic?` | `DisplayGraphic` ✅ | Checkbox | `checked` | `checked` / `unchecked` | Show page graphic |
| `Text 1` | `Text1` | Text Entry | Null | Any text including HTML | Displayed below name/graphic, above products |
| `Text 2` | `Text2` | Text Entry | Null | Any text including HTML | Displayed below products/links, above footer |
| `Text 3` | `Text3` | Text Entry | Null | Any text including HTML | Displayed below page footer |
| `Link Name` | `LinkName` | Text Entry | Defaults to `Name` | Short text string | Text for links to this page |
| `Link Graphic` | `LinkGraphic` ✅ | Image | `none` | File path/URL | Graphic for links to this page |
| `Link Graphic Desc` | `LinkGraphicDesc` ✅ | Text Entry (inferred) | Null | Short text | Description of the link graphic (fixture-confirmed tag; doc type unconfirmed) |
| `Link Graphic Size` | `LinkGraphicSize` ✅ | Numeric (inferred) | `0` | Integer | Link graphic size flag (fixture-confirmed tag; doc type unconfirmed) |
| `Link Text` | `LinkText` ✅ | Text Entry | Null | Short text including HTML | Description in page links |
| `Text Wrap` | `TextWrap` ✅ | Pull-down | `On` | `On`, `Off` | Text wraps under link graphic |

---

## 3. Layout & Structure Fields

| Field Name | XML Tag | Type | Default | Allowed Values | Notes |
|---|---|---|---|---|---|
| `Template` | `Template` | Text (case-sensitive) | Theme default | Any valid page template name | Page display template |
| `Item Alignment` | `ItemAlignment` ✅ | Pull-down | `Left aligned` | `Left aligned`, `Right aligned`, `Centered`, `Staggered; Start left`, `Staggered; Start right` | Product/page-link alignment within columns |
| `Columns` | `Columns` ✅ | Pull-down | `One column` | `One column`–`Five columns` | Number of product display columns |
| `Page Link Columns` | `PageLinkColumns` ✅ | Pull-down | `One column` | `One column`–`Five columns` | Number of page-link display columns |
| `Display column borders?` | `DisplayColumnBorders` ✅ | Checkbox | `unchecked` | `checked` / `unchecked` | Thin border around columns |
| `Page Width` | `PageWidth` ✅ | Pull-down | `100% wide` | `100%`, `90%`, `85%`, `75%`, `65%`, `50%` wide | Percentage of browser window |
| `Page Width Type` | `PageWidthType` ✅ | Pull-down (inferred) | `px` | Unit selector alongside `Page Width` | Width unit flag (fixture-confirmed tag; doc type unconfirmed) |
| `Display Universal Header?` | `DisplayUniversalHeader` ✅ | Checkbox | `checked` | `checked` / `unchecked` | Show store-wide universal header |
| `Display Universal Footer?` | `DisplayUniversalFooter` ✅ | Checkbox | `checked` | `checked` / `unchecked` | Show store-wide universal footer |

---

## 4. Color & Style Fields

| Field Name | XML Tag | Type | Default | Allowed Values | Notes |
|---|---|---|---|---|---|
| `Text Color` | `TextColor` ✅ | Hex/Text | `Black-True (#000000)` | Hex `#000000` or named string | Non-link text color |
| `Background Color` | `BackgroundColor` ✅ | Hex/Text | `White-True (#FFFFFF)` | Hex or named string | Page background |
| `Link Color` | `LinkColor` ✅ | Hex/Text | `Blue-True (#0000FF)` | Hex or named string | Unvisited link color |
| `Visited Link Color` | `VisitedLinkColor` ✅ | Hex/Text | `Red-True (#FF0000)` | Hex or named string | Visited link color |
| `Active Link Color` | `ActiveLinkColor` ✅ | Hex/Text | `Bright_Green_4 (#00FF00)` | Hex or named string | Active link color |
| `Background Image` | `BackgroundImage` ✅ | Image | `none` | File path/URL | Page background image |

**Color format note:** Colors can be specified as hex values (preceded by `#`) or as named strings that match exactly with the back-office drop-down entries, including color name, parentheses, and hex (e.g., `Black-True (#000000)`).

---

## 5. SEO & Metadata Fields

| Field Name | XML Tag | Type | Default | Allowed Values | Notes |
|---|---|---|---|---|---|
| `Meta:Keywords` | `MetaKeywords` ✅ | Text Entry | Null | No reserved chars | HTML meta keywords |
| `Meta:Description` | `MetaDescription` ✅ | Text Entry | Null | No reserved chars | HTML meta description |
| `Search Products` | `SearchProducts` ✅ | Checkbox | `unchecked` | `checked` / `unchecked` | Product search box on page |
| `Index` | `Index` ✅ | Checkbox | `checked` | `checked` / `unchecked` | Index products on this page for search |
| `Include In Sitemap` | `PageSitemap` ✅ | Checkbox | `unchecked` | `checked` / `unchecked` | Google Sitemap inclusion |
| `Sitemap Priority` | `PageSitemapPriority` ✅ | Limited Text | `Google Default` | `Google Default`, `0.0`–`1.0` | Sitemap priority |

---

## 6. Product-Page Relationship Fields

| Field Name | XML Tag | Type | Default | Allowed Values | Notes |
|---|---|---|---|---|---|
| `Page Links` | `PageLinks` ✅ | List | Null | Block element in export (one entry per linked page) | Complete list of pages linking TO this page (replaces) |
| `Product Links` | `ProductLinks` ✅ | List | Null | Block element in export (one entry per product) | Complete list of products ON this page (replaces) |
| `Links To Page` | `LinksToPage` ✅ | List | Null | Block element in export | Adds pages TO existing link list (formerly `Link Location`) |
| `Page Global Cross Sell` | `PageGlobalCrossSell` ✅ | Checkbox (inferred) | `uncheck` | `checked` / `uncheck` | Page-level cross-sell flag (fixture-confirmed tag; doc type unconfirmed) |

**Important semantic difference:**
- `Page Links` = "which pages link to this page" (replaces the full list)
- `Links To Page` = "add links to this page from these pages" (appends to existing)
- `Product Links` = "which products appear on this page" (replaces; analogous to `Product On Pages` in the product table)

---

## 7. Sorting & Pagination Fields

| Field Name | XML Tag | Type | Default | Allowed Values | Notes |
|---|---|---|---|---|---|
| `Order` | `Order` ✅ | Pull-down | `None` | `None`, `Ascending`, `Descending` | Sort order for products and page links |
| `Products Sort Field` | `ProductsSortField` ✅ | Pull-down | `Name` | `Name`, `SKU`, `Price`, `Product Description` | Field to sort products by |
| `Pages Sort Field` | `PagesSortField` ✅ | Pull-down | `Name` | `Name`, `Link Name` | Field to sort page links by |
| `Products First` | `ProductsFirst` ✅ | Checkbox | `checked` | `checked` / `unchecked` | Display products before page links; unchecked = intermix |
| `Number Products` | `NumberProducts` ✅ | Numeric | `0` (unlimited) | Any integer | Max products per page; auto-generates additional pages |

---

## 8. Custom Fields

| Field Name | XML Tag | Type | Default | Allowed Values | Notes |
|---|---|---|---|---|---|
| `Page Field 1`–`25` | `PageField1`–`PageField25` | Text Entry | Null | Any text including HTML | Only available in ShopSite Pro custom templates |

---

## Field Type Cross-Reference

Page fields use the same ShopSite field types as product fields. See the `shopsite-product-fields/references/field-type-system.md` reference for detailed type documentation.

| Count | Type | Example Page Fields |
|-------|------|---------------------|
| ~20 | Text Entry | `Name`, `Text 1`/`2`/`3`, `Link Name`, `Link Text`, `File name`, `Title`, `Meta:Keywords`, `Meta:Description`, `Graphic`, `Link Graphic`, `Background Image`, `Page Field 1–25` |
| ~8 | Checkbox | `Display Name?`, `Display Graphic?`, `Display column borders?`, `Display Universal Header?`, `Display Universal Footer?`, `Search Products`, `Index`, `Include In Sitemap`, `Products First` |
| ~8 | Pull-down | `Columns`, `Page Link Columns`, `Item Alignment`, `Page Width`, `Order`, `Products Sort Field`, `Pages Sort Field`, `Text Wrap` |
| ~1 | Numeric | `Number Products` |
| ~6 | Hex/Text | `Text Color`, `Background Color`, `Link Color`, `Visited Link Color`, `Active Link Color` |
| ~1 | Image | `Background Image` |
| ~1 | Limited Text | `Sitemap Priority` |
| ~3 | List | `Page Links`, `Product Links`, `Links To Page` |
| ~1 | Text (case-sensitive) | `Template` |
