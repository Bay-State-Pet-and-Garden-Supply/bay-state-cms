# ShopSite Product Field Catalog

Complete reference of all documented ShopSite product database fields, sourced from the official [Database Upload/Download Fields](https://help.shopsite.com/help/15.0/en-US/sc/pro/upload.fields.html) page (ShopSite Pro v15).

> **Authority note:** Field **names, types, defaults, and allowed values** below come from the ShopSite docs. For **XML tags and DTD defaults as implemented**, `src/shopsite/field-catalog.ts` (`SHOP_SITE_FIELD_CATALOG_VERSION`, `getFieldByTag`, `getDtdDefault`) is authoritative — if this table and the catalog disagree, trust the catalog and file a fix against this table.

> **⚠️ XML Tag Column Convention**
> - **`tag`** = Tag confirmed by `product-codec.ts` (`CORE_FIELDS`/decode), `field-catalog.ts`, or a real `db_xml.cgi` export.
> - **`tag (inferred)`** = Tag derived from the field name following ShopSite naming conventions (PascalCase with no spaces). Highly likely correct but not confirmed against real XML output.
> - **`—`** = No known XML tag; field may only exist in delimited upload/download formats.

---

## 1. Core Identity Fields

| Field Name | Likely XML Tag | Type | Default | Allowed Values | Notes |
|---|---|---|---|---|---|
| `Name` | `Name` | Short Text | **Required, no default** | Any text including HTML | Core product name; required field in DTD |
| `ProductGUID` | `ProductGUID` | Text Entry | Assigned by ShopSite on creation | Alphanumeric UUID-like string | Stable ID survives name changes: `1c0d6b3a-2763-11e1-8033-000347315335` |
| `SKU` | `SKU` | Text Entry | **Required, no default** | Any alphanumeric string | Stock Keeping Unit; used as `uniqueName` primary key in this project |
| `ProductID` | `ProductID` | Text Entry | Assigned by ShopSite | Numeric string | Internal ShopSite product ID |

**Codebase handling:** `SKU` → `.sku` (fully handled). `Name` → `.core.name` (fully handled). `ProductGUID` → `.shopsite.productGuid` (parsed, preserved on round-trip). `ProductID` → `.shopsite.productId` (parsed, preserved on round-trip).

---

## 2. Pricing Fields

| Field Name | Likely XML Tag | Type | Default | Allowed Values | Notes |
|---|---|---|---|---|---|
| `Price` | `Price` | Numeric | `0.00` | Numeric, no currency symbol | Locale controls currency display |
| `Sale Amount` | `SaleAmount` (inferred) | Numeric or percentage | Null | Numeric or `10%` format | Only used if `Sale On` is `checked` |
| `Sale On` | (unknown — may be absent in XML) | Checkbox | `checked` | `checked` / `unchecked` | Master switch for sale price display |
| `Variable Price?` | (unknown) | Checkbox | `unchecked` | `checked` / `unchecked` | Customer can set their own price; regular price becomes minimum |
| `Variable Name?` | (unknown) | Checkbox | `unchecked` | `checked` / `unchecked` | Requires Variable Price |
| `Variable SKU?` | (unknown) | Checkbox | `unchecked` | `checked` / `unchecked` | Requires Variable Price |

**Codebase handling:** `Price` → `.core.price` (fully handled, optional emit). `SaleAmount` → `.core.salePrice` (fully handled, optional emit). Variable pricing fields are **not parsed** and would be preserved in `unknownElements`.

---

## 3. Description & Content Fields

| Field Name | Likely XML Tag | Type | Default | Allowed Values | Notes |
|---|---|---|---|---|---|
| `Product Description` | `ProductDescription` | Text Entry | Null | Any text, avoid `'` and `"` | Emitted as CDATA in XML |
| `More Information Text` | `MoreInformationText` (inferred) | Text Entry | Null | Any text, avoid `'` and `"` | Emitted as CDATA; **auto-synced from description in codebase** |
| `More Information Graphic` | `MoreInformationGraphic` | Image | `none` | File path/URL | Falls back to `Graphic` in decode; encode prefers preserved value, then primary, then `none` |
| `More Information Title` | — | Restricted Text | Null | No reserved chars | HTML `<title>` for More Information page |
| `More Information Meta:Keywords` | — | Text Entry | Null | No reserved chars | HTML meta keywords |
| `More Information Meta:Description` | — | Text Entry | Null | No reserved chars | HTML meta description |
| `More Information Image 1`–`25` | `MoreInfoImage1`–`MoreInfoImage20` (confirmed) | Image | Null | File path/URL | Slots 1–20 parsed; slots 21–25 would pass through as unknown elements |
| `More Info Extra Image Size` | — | Drop-down | `3` | `0` (Original), `1` (Medium), `2` (Small), `3` (Extra Small/Cart) | Image size category for extra images |
| `File name` | `FileName` | Restricted Text | Null | Valid `.htm` or `.html` filename | Resolved at encode via `normalizeFileName() ?? resolveBaseFileName()` (`product-codec.ts:568-570`) |

**Codebase handling:** `ProductDescription` → decoded into `.core.description` only when it differs from `MoreInformationText`/name; **encode emits `<ProductDescription>` from the product name** (catalog convention). `MoreInformationText` → preferred decode source for `.core.description`; encode precedence `customFields` → preserved → `.core.description`, plus auto-emitted `<DisplayMoreInformationPage>`. `MoreInformationGraphic` → `.core.media.primary` fallback; preserved separately in `unknownElements` when different from `Graphic`. `MoreInfoImage1`–`20` → `.core.media.additional[]` (21+ are dropped, not preserved). `FileName` → `.core.seo.fileName` on decode; resolved via `file-name.ts` on encode. Title/Meta fields are **not parsed** and pass through as unknown elements.

**Note:** `MoreInformationText` is settable per product via `customFields['MoreInformationText']` (encode honors it first) — it is not locked to the description.

---

## 4. Media & Display Fields

| Field Name | Likely XML Tag | Type | Default | Allowed Values | Notes |
|---|---|---|---|---|---|
| `Graphic` | `Graphic` | Image | `none` | File path/URL or `none` | Primary product image |
| `Product Image Size` | `ProductImageSize` ✅ | Text Entry | `2` | `0` (Original), `1` (Medium), `2` (Small/Thumb), `3` (Extra Small/Cart) | Image size category |
| `Display Name?` | `DisplayName` ✅ | Checkbox | `checked` | `checked` / `unchecked` | |
| `Display SKU?` | `DisplaySKU` ✅ | Checkbox | `checked` | `checked` / `unchecked` | |
| `Display Price?` | `DisplayPrice` ✅ | Checkbox | `checked` | `checked` / `unchecked` | |
| `Display Graphic?` | `DisplayGraphic` ✅ | Checkbox | `checked` | `checked` / `unchecked` | |
| `Name Style` | `NameStyle` ✅ | Pull-down | `Bold` | `Bold`, `Italic`, `Typewriter`, `Plain` | Font style for product name |
| `Name Size` | `NameSize` ✅ | Pull-down | `Normal` | `Normal`, `Big`, `Small` | |
| `Price Style` | `PriceStyle` ✅ | Pull-down | `Bold` | `Bold`, `Italic`, `Typewriter`, `Plain` | |
| `Price Size` | `PriceSize` ✅ | Pull-down | `Normal` | `Normal`, `Big`, `Small` | |
| `SKU Style` | `SKUStyle` ✅ | Pull-down | `Plain` | `Bold`, `Italic`, `Typewriter`, `Plain` | |
| `SKU Size` | `SKUSize` ✅ | Pull-down | `Normal` | `Normal`, `Big`, `Small` | |
| `Description Style` | `DescriptionStyle` ✅ | Pull-down | `Plain` | `Bold`, `Italic`, `Typewriter`, `Plain` | |
| `Description Size` | `DescriptionSize` ✅ | Pull-down | `Normal` | `Normal`, `Big`, `Small` | |
| `Image Alignment` | `ImageAlignment` ✅ | Pull-down | `Left` | `Left`, `Right`, `Center` | |
| `Text Wrap` | `TextWrap` ✅ | Pull-down | `On` | `On`, `Off` | Text wraps around image |
| `Add to Cart Button` | — | Text Entry | `[Add to Cart]` | Any text or graphic filename | Can use graphic by entering filename |
| `View Cart Button` | — | Text Entry | `[View Cart]` | Any text or graphic filename | |
| `Use Add to Cart Image?` | — | Radio Button | `0` | `0` (use text), `1` (use image file) | |
| `Add to Cart Image` | — | Image | `none` | File in media directory | Used when `Use Add to Cart Image? = 1` |
| `Use View Cart Image?` | — | Radio Button | `0` | `0` (use text), `1` (use image file) | |
| `View Cart Image` | — | Image | `none` | File in media directory | Used when `Use View Cart Image? = 1` |
| `Display Order Quantity?` | `DisplayOrderQuantity` ✅ | Checkbox | `unchecked` | `checked` / `unchecked` | Quantity input on store page |
| `Display Ordering Options?` | `DisplayOrderingOptions` ✅ | Checkbox | `checked` | `checked` / `unchecked` | Show ordering options on store page |

**Codebase handling:** `Graphic` → `.core.media.primary` (fully handled). All display style fields (`Display Name?`, `Name Style`, etc.) are **not parsed** and pass through as unknown elements.

---

## 5. Ordering Options & Variants

| Field Name | Likely XML Tag | Type | Default | Allowed Values | Notes |
|---|---|---|---|---|---|
| `Option Text` | — | Text Entry | Null | Any text including HTML | Header text above option menus |
| `Option Menu Text` | — | Text Entry | Null | Pipe+newline-delimited options | Format: `Option1\|n\|Option2` with `\|n\|\|n\|` as group separator |
| `Option Append SKU` | — | Checkbox | `unchecked` | `checked` / `unchecked` | Append option SKU to product SKU |
| `Option Use Multi Menus` | — | Checkbox | `unchecked` | `checked` / `unchecked` | Enable cascading menus |
| `Option Select Default` | — | Text Entry | Null | Any text | Default text at top of option drop-down |
| `Customer Text Entry Box` | — | Checkbox | `unchecked` | `checked` / `unchecked` | Customer text box on cart page |
| `Customer Text Entry Header` | — | Text Entry | Null | Any text including HTML | Label above customer text box |
| `Customer Text Columns` | — | Numeric | `40` | Any positive integer | Width of text box |
| `Customer Text Rows` | — | Numeric | `4` | Any positive integer | Height of text box |
| `Subproducts` | `Subproducts` | List | Null | `\|`-separated product names | Nested child products |

**Advanced Options** (multicolumn ordering options, stored as block-structured XML):

| Field Name | Likely XML Tag | Type | Default | Allowed Values | Notes |
|---|---|---|---|---|---|
| `Menu1`–`Menu4` | — | Text Entry | Null | Any text | Option group names; header starts with `!Menu1` |
| `Use` | — | Checkbox | `checked` | `checked` / `unchecked` | Whether row appears in drop-down |
| `AppText` | — | Text Entry | Null | Any text | Appended to product name |
| `SKU` (in Advanced Options row) | — | Text Entry | Null | Alphanumeric | Appended/ replaces product SKU |
| `PriceMod` | — | Numeric | `0.00` | Numeric including modifiers | Price delta from base (see Advanced Ordering Options rules) |
| `WeightMod` | — | Numeric | `0` | Numeric including modifiers | Weight delta from base |
| `QtyOnHand` | — | Numeric | `0` | Integer, supports `+`/`-` delta | Per-option inventory |
| `LowStock` | — | Numeric | Null | Integer | Per-option low stock warning |
| `OutOfStock` | — | Numeric | Null | Integer | Per-option out of stock alert |
| `Image` | — | Image | `none` | File path/URL | Per-option image |

**Codebase handling:** `Subproducts` → preserved as `advancedBlocks` (pass-through only, preserved as raw XML). Simple options fields (`Option Text`, `Option Menu Text`, etc.) are **not parsed** and pass through as unknown elements. Advanced Options block format (`!Menu1`/`##`/`!!`) is **not parsed** and would pass through if it survives XML parsing.

---

## 6. Inventory & Shipping Fields

| Field Name | Likely XML Tag | Type | Default | Allowed Values | Notes |
|---|---|---|---|---|---|
| `Quantity On Hand` | `QuantityOnHand` | Numeric | `0` | Integer, supports `+`/`-` delta | Delta: `+5` adds, `-10` subtracts |
| `Low Stock Threshold` | `LowStockThreshold` ✅ | Numeric | Null | Integer | Email alert threshold |
| `Out Of Stock Limit` | `OutOfStockLimit` ✅ | Numeric | Null | Integer | Out of stock alert threshold |
| `Weight` | `Weight` | Numeric | `0` | Integer or decimal | No units; consistent across all products |
| `Taxable` | `Taxable` | Checkbox | `checked` | `checked` / `unchecked` | Sales tax calculation |
| `Product Type` | `ProductType` (confirmed) | Restricted Text | `Tangible` | `Tangible`, `Download` | Physical vs digital |
| `Disable Product` | `ProductDisabled` | Checkbox | blank | blank / `checked` | Unpublished/seasonal product |
| `Ground Shipping` | `GroundShipping` ✅ | Numeric | `0` | Numeric, no currency symbol | Per-product shipping cost |
| `Second Day Shipping` | `SecondDayShipping` ✅ | Numeric | `0` | Numeric, no currency symbol | |
| `Next Day Shipping` | `NextDayShipping` ✅ | Numeric | `0` | Numeric, no currency symbol | |
| `Shipping 3`–`9` | — | Numeric | `0` | Numeric, no currency symbol | Custom shipping methods (merchant can rename) |
| `No Shipping Charges` | `NoShippingCharges` ✅ | Checkbox | `unchecked` | `checked` / `unchecked` | Free shipping / digital goods |
| `Extra Handling Charge` | `ExtraHandlingCharge` ✅ | Numeric | `0` | Numeric, no currency symbol | Special handling fee |
| `Dimension Options` | — | Restricted Numeric | `1` | `1` (weight only), `2` (custom), `3` (standard box) | Box dimension mode |
| `Dimension Text` | — | Restricted Text | Null | Format: `LxWxH` (e.g., `20x20x24`) | Custom box dimensions |
| `Dimension Selected` | — | Restricted Text | First configured box | Match configured box name | Standard box dimensions |
| `FedEx Container` | — | Restricted Text | Null | Match configured FedEx container | FedEx shipping container |
| `USPS Container` | — | Restricted Text | Null | Match configured USPS container | USPS shipping container |
| `Minimum Quantity` | `MinimumQuantity` (confirmed) | Numeric | `0` | Positive integer | Minimum purchase quantity |

**Codebase handling:** `QuantityOnHand` → `.core.inventory.quantityOnHand` (fully handled). `Weight` → `.core.weight` (fully handled). `Taxable` → `.core.taxable` (fully handled). `ProductType` → encode precedence `customFields` → preserved → DTD default `Tangible` (overridable, not hardcoded). `ProductDisabled` → `.status` (`'active'`/`'draft'`) (fully handled). `MinimumQuantity` → encode precedence `customFields` → preserved → DTD default `0` (overridable, not hardcoded). All shipping-cost fields, dimension fields, and container fields are **not parsed** and pass through as unknown elements.

**Emit behavior:** `ProductType` emits `customFields['ProductType']` when set (e.g. `Download` needs no codebase change — just set the custom field), else the preserved value, else DTD default `Tangible`. `MinimumQuantity` emits `customFields['MinimumQuantity']` when set, else the preserved value, else `0`.

---

## 7. Product-Page Relationship Fields

| Field Name | Likely XML Tag | Type | Default | Allowed Values | Notes |
|---|---|---|---|---|---|
| `Product On Pages` | `ProductOnPages` (block) | List | Null | `\|`-separated page names | Replaces existing list |
| `Add To Pages` | — | List | Null | `\|`-separated page names | Adds to existing list (formerly `In These Pages`) |
| `Display more information page?` | `DisplayMoreInformationPage` ✅ / `DisplayMoreInformationPage_` ✅ (legacy) | Checkbox | `unchecked` | `checked` / `unchecked` | Whether More Info page exists |
| `Cross Sell Products` | — | List | Null | `\|`-separated product names | Cross-sell product assignments |
| `Template` | `Template` ✅ | Text (case-sensitive) | Theme default | Any valid template name | Product display template |
| `Include In Sitemap` | — | Checkbox | `unchecked` | `checked` / `unchecked` | Google Sitemap inclusion |
| `Sitemap Priority` | — | Limited Text | `Google Default` | `Google Default`, `0.0`–`1.0` | Sitemap priority ranking |

**Codebase handling:** `ProductOnPages` → first-class `.core.productOnPages: string[]` with preserved fallbacks; encode emits modern `<ProductOnPages><PageLink><Name>` layout (`resolveProductPageNames`, `product-codec.ts:703-734`). `Add To Pages`/`Cross Sell Products`/display/template/sitemap fields are **not parsed** and pass through as unknown elements.

---

## 8. Search & SEO Fields

| Field Name | Likely XML Tag | Type | Default | Allowed Values | Notes |
|---|---|---|---|---|---|
| `Search Keywords` | `SearchKeywords` | Text Entry | Null | Space-separated keywords | Supplement to name/description search |
| `Search Make Page` | — | Restricted Text | Null | Fully-qualified URL | Search destination URL |
| `Search Dest Type` | — | Restricted Text | `selected` | `selected`, `specified` | Standard vs URL destination |
| `Search Dest` | — | Restricted Text | `Store` | `Store`, `More Info`, `Made`, `None` | How product appears in search |

**Codebase handling:** `SearchKeywords` → `.core.seo.searchKeywords` (fully handled, CDATA). Other search fields are **not parsed** and pass through as unknown elements.

---

## 9. Google Merchant Center / Shopping Fields

| Field Name | Likely XML Tag | Type | Default | Allowed Values | Notes |
|---|---|---|---|---|---|
| `Google Merchant Center` | — | Checkbox | `checked` | `checked` / `unchecked` | Include in Google Shopping feed |
| `Brand` | `Brand` ✅ | Restricted Text | Null | Any text | Required for Google Shopping |
| `GTIN (ISBN or UPC)` | `GoogleGTIN` / `GTIN` | Restricted Text | Null | Alphanumeric | Required for Google Shopping |
| `MPN (Manufacturer Part Number)` | — | Restricted Text | Null | Alphanumeric | |
| `Google Product Category` | `GoogleProductCategory` ✅ | Restricted Text | Null | Google taxonomy breadcrumb | Full category path |
| `Availability` | `Availability` | Restricted Text | Null | `in stock`, `available for order`, `out of stock`, `preorder` | |
| `Age Group` | — | Restricted Text | Null | `none`, `adult`, `kids` | |
| `Gender` | — | Restricted Text | Null | `none`, `male`, `female` | |
| `Include Variant Options` | — | Checkbox | `checked` | `checked` / `unchecked` | Include option variants in feed |
| `Color Option` | — | Text Entry | Null | Up to 4 semicolon-separated values | |
| `Size Option` | — | Text Entry | Null | Up to 4 semicolon-separated values | |
| `Material Option` | — | Text Entry | Null | Up to 4 semicolon-separated values | |
| `Pattern Option` | — | Text Entry | Null | Up to 4 semicolon-separated values | |
| `Google Condition` | `GoogleCondition` ✅ | Restricted Text | `New` | `New`, `Used`, `Refurbished` | Condition for Google Shopping |

**Codebase handling:** `GoogleGTIN` → `.customFields['GoogleGTIN']` (fully handled). `GTIN` → `.customFields['GTIN']` (fully handled). `Google_GTIN` (legacy) → merged into `.customFields['GoogleGTIN']`. `Availability` → `.core.availability` (fully handled). All other Google Shopping fields are **not parsed** and pass through as unknown elements.

**Note:** The codec emits `<GTIN>` from `customFields['GTIN']`, else `customFields['GoogleGTIN']`, else an 8–14-digit SKU. It emits `<GoogleGTIN>` **only** when `customFields['GoogleGTIN']` is explicitly set (`product-codec.ts:503-511`).

---

## 10. Integration Fields

| Field Name | Likely XML Tag | Type | Default | Allowed Values | Notes |
|---|---|---|---|---|---|
| `QBImport` | `QBImport` ✅ | Restricted Text | Null | `[#TYPE=PART#][#ACCNT=Sales:ShopSite#]`-style pairs | QuickBooks item categorization |
| `Doba Information` | — | Restricted Text | Null | Doba Item ID | Doba dropshipping integration |
| `Product Download Location` | `ProductDownloadLocation` ✅ | Text Entry | Null | Filename in download directory | Digital download products |

**Codebase handling:** None of these are parsed; they pass through as unknown elements.

---

## 11. Quantity Pricing Fields

| Field Name | Likely XML Tag | Type | Default | Allowed Values | Notes |
|---|---|---|---|---|---|
| `Quantity Pricing` | — | Restricted Text | Null | `CHECKED\|n\|COMMENT\|COLOR1\|...` (old format) or per-cell (new format) | Bulk pricing configuration |
| `Qty Pricing Background Color` | — | Restricted Text | Null | `#XXXXXX` hex | Table background |
| `Qty Pricing Price and Comment Color` | — | Restricted Text | Null | `#XXXXXX` hex | Price/comment row color |
| `Qty Pricing On Sale Color` | — | Restricted Text | Null | `#XXXXXX` hex | Sale row color |
| `Qty Pricing Comment` | — | Text Entry | Null | Any text | Comment below table |
| `Qty Pricing Number Price Breaks` | — | Restricted Text | Null | `2`–`10` | Number of price tiers |
| `Qty Pricing Ranges` | — | Restricted Text | Null | Range definitions | Per-tier quantity ranges |
| `Quantity Pricing Group` | — | Restricted Text | Null | Group name | Shared pricing group |
| `Display Quantity Pricing?` | `DisplayQuantityPricing` ✅ | Checkbox | `checked` | `checked` / `unchecked` | Show table on store page |

**Codebase handling:** None of these are parsed; they pass through as unknown elements.

---

## 12. Custom Fields

| Field Name | Likely XML Tag | Type | Default | Allowed Values | Notes |
|---|---|---|---|---|---|
| `Product Field 1`–`25` | `ProductField1`–`ProductField25` | Text Entry | Null | Any text including HTML | Only available in ShopSite Pro custom templates |
| `Subproducts` | `Subproducts` (block) | List | Null | `\|`-separated product names (or `name~SKU` format) | Grouped child products |

**Codebase handling:** `ProductField1`–`25` → `.customFields[tag]` (fully handled). Any tag starting with `ProductField` (even beyond 25) is captured into `customFields`. Invalid XML tag names in custom fields generate warnings during denormalization.

---

## 13. Fields Present in the Sample XML but Not in the Upload Fields Catalog

The following tags appear in the project's sample fixture (`src/tests/fixtures/shopsite-products-sample.xml`) but are **not** listed in the official upload fields documentation. They may be auto-generated by ShopSite or belong to newer versions:

| XML Tag | Appears In | Notes |
|---|---|---|
| `Availability` | Real export, codec decode/encode | Newer field (Google Shopping related) |
| `GoogleGTIN` | Real export, codec decode/encode | Google Shopping field |
| `ProductDisabled` | Real export, codec decode/encode | Shown as "Disable Product" in UI |
| `ProductID` | Product XML exports | Internal ShopSite ID |
| `ProductGUID` | Product XML exports | Stable GUID |
| `MinimumQuantity` | Product XML exports | DTD-required field |
| `ProductType` | Product XML exports | Tangible/Download |
| `SearchKeywords` | Sample XML | SEO search keywords |
| `FileName` | Codec encode output | Generated product page filename |

These are fields that ShopSite includes in the XML format but may not appear in the delimited upload field catalog because they are auto-managed or XML-only fields.
