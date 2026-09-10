# Product XML Mapping: Field → Tag → Codebase → Handling Status

This reference bridges the documented ShopSite product fields to their XML tags, `Product` model paths, and current handling status in the codebase.

> **Codebase authority (post spec #136):** `src/shopsite/product-codec.ts` (`ShopSiteProductCodec.decode` / `encode`) owns all XML handling; `src/shopsite/field-catalog.ts` owns field tags, types, and DTD defaults; `src/shared/schemas/product.ts` owns the `Product` model. The old `product-parser.ts` / `product-normalizer.ts` / `product-denormalizer.ts` split no longer exists — any pointer to those files is stale.

---

## Legend

| Status | Meaning |
|--------|---------|
| ✅ **decoded** | Tag is explicitly recognized in `CORE_FIELDS` and mapped to the `Product` model in `ShopSiteProductCodec.decode` (`product-codec.ts:51-63`, mapping at `:222-291`) |
| 🔄 **mapped** | Mapped from parsed fields onto a `Product` model path in `decode` |
| ⬆️ **emitted** | Written back to XML in `ShopSiteProductCodec.encode` (`product-codec.ts:430`, §§1–22) |
| 📦 **preserved** | Passes through unchanged in `unknownElements` or `advancedBlocks`; not independently editable |
| ❌ **not handled** | May be discarded or not processed at all |
| ⚠️ **known divergence** | Code emits a hardcoded value regardless of parsed data |

---

## Core Identity

| Field | XML Tag | Status | Product Path | Source Lines |
|-------|---------|--------|--------------|--------------|
| SKU | `SKU` / `sku` | ✅ 🔄 ⬆️ | `.sku` | decode: CORE_FIELDS set (product-codec.ts:51-63). decode mapping (product-codec.ts:222-291). encode (ShopSiteProductCodec.encode) |
| Name | `Name` / `name` | ✅ 🔄 ⬆️ | `.core.name` | decode: CORE_FIELDS set (product-codec.ts:51-63). decode mapping (product-codec.ts:222-291). encode (ShopSiteProductCodec.encode) |
| ProductGUID | `ProductGUID` | ✅ 🔄 | `.shopsite.productGuid` | decode: CORE_FIELDS set (product-codec.ts:51-63), mapped at :222-291. Parsed into the model but **not re-emitted** by encode (known labels are excluded from the unknown-elements re-emit) |
| ProductID | `ProductID` | ✅ 🔄 | `.shopsite.productId` | decode: CORE_FIELDS set (product-codec.ts:51-63), mapped at :222-291. Parsed into the model but **not re-emitted** by encode |
| FileName | `FileName` | ✅ 🔄 ⬆️ | `.core.seo.fileName` | decode: `fields['FileName']` → `.core.seo.fileName` (product-codec.ts:222-291). encode §19: `normalizeFileName(options?.fileName) ?? resolveBaseFileName(product)` (product-codec.ts:568-570; `src/shopsite/file-name.ts`) — the stored value feeds resolution, it is not ignored |

**Note on `FileName`:** Encode resolves the filename as `normalizeFileName(options?.fileName) ?? resolveBaseFileName(product)` (`product-codec.ts:568-570`; helpers `slugifyFileName`, `normalizeFileName`, `resolveBaseFileName`, `uniquifyFileNames` in `src/shopsite/file-name.ts`). `<FileName>` is skipped in the unknown-elements re-emit loop (`product-codec.ts:605`) to avoid double emission.

---

## Pricing

| Field | XML Tag | Status | Product Path | Source Lines |
|-------|---------|--------|--------------|--------------|
| Price | `Price` / `price` | ✅ 🔄 ⬆️ | `.core.price` | decode: CORE_FIELDS set (product-codec.ts:51-63). decode mapping (product-codec.ts:222-291). encode (ShopSiteProductCodec.encode) (optional emit) |
| Sale Amount | `SaleAmount` / `saleAmount` | ✅ 🔄 ⬆️ | `.core.salePrice` | decode: CORE_FIELDS set (product-codec.ts:51-63). decode mapping (product-codec.ts:222-291). encode (ShopSiteProductCodec.encode) (optional emit) |

---

## Description & Content

| Field | XML Tag | Status | Product Path | Source Lines |
|-------|---------|--------|--------------|--------------|
| Product Description | `ProductDescription` / `description` | ✅ 🔄 ⬆️ | `.core.description` (only when it differs from `MoreInformationText`/name) | decode: `core.description = MoreInformationText ?? ProductDescription` (product-codec.ts:227-229). encode §9 emits `<ProductDescription>` CDATA from the product **name** per catalog upload convention (product-codec.ts:481-487) |
| More Information Text | `MoreInformationText` | ✅ 🔄 ⬆️ | `.core.description` (preferred decode source) + `customFields` override | decode feeds `MoreInformationText` into `core.description` (product-codec.ts:227-229). encode §16 precedence: `customFields['MoreInformationText']` → preserved `unknownElements` → `.core.description`, plus auto-emitted `<DisplayMoreInformationPage>` checked/uncheck (product-codec.ts:531-549) |
| More Information Graphic | `MoreInformationGraphic` | ✅ 🔄 ⬆️ | `.core.media.primary` (fallback) + preserved separately | decode: `media.primary = Graphic ?? MoreInformationGraphic`; preserved separately in `unknownElements` only when set, not `none`, and different from `Graphic` (product-codec.ts:222-291). encode §17: preserved value → primary → `none` default (product-codec.ts:550-558) |
| MoreInfoImage 1–20 | `MoreInfoImage1`–`MoreInfoImage20` | ✅ 🔄 ⬆️ | `.core.media.additional[]` | decode extracts 1–20, skipping `none` (product-codec.ts:222-291). encode §18 re-emits present entries (product-codec.ts:560-566) |
| MoreInfoImage 21–25 | `MoreInfoImage21`–`MoreInfoImage25` | ❌ | Dropped | Decode extracts only 1–20, and the unknown-elements filter excludes `/^MoreInfoImage\d+$/`, so tags 21+ are **not preserved** — do not rely on round-tripping these |
| More Information Title | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Not in any known field set; passes through |
| More Information Meta:Keywords | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Not in any known field set; passes through |
| More Information Meta:Description | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Not in any known field set; passes through |
| More Info Extra Image Size | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Not in any known field set; passes through |

---

## Media & Display

| Field | XML Tag | Status | Product Path | Source Lines |
|-------|---------|--------|--------------|--------------|
| Graphic | `Graphic` | ✅ 🔄 ⬆️ | `.core.media.primary` | decode: CORE_FIELDS set (product-codec.ts:51-63). decode mapping (product-codec.ts:222-291). encode (ShopSiteProductCodec.encode) |
| Product Image Size | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Display Name? | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Display SKU? | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Display Price? | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Display Graphic? | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Name Style | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Name Size | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Price Style | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Price Size | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| SKU Style | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| SKU Size | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Description Style | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Description Size | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Image Alignment | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Text Wrap | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Add to Cart Button | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| View Cart Button | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Use Add to Cart Image? | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Add to Cart Image | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Use View Cart Image? | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| View Cart Image | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Display Order Quantity? | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Display Ordering Options? | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |

All display/style fields are **pass-through only**. They survive round-trips in `unknownElements` but cannot be independently edited through the current `Product` model.

---

## Ordering Options & Variants

| Field | XML Tag | Status | Product Path | Source Lines |
|-------|---------|--------|--------------|--------------|
| Subproducts | `Subproducts` / `subproducts` | ✅ 📦 (block) | `.shopsite.preserved.advancedBlocks['Subproducts']` | decode: BLOCK_TAGS set (product-codec.ts:64-68); raw block preserved. encode §21 re-emits preserved blocks as raw XML (product-codec.ts:590-596) |
| Option Text | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Option Menu Text | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Option Append SKU | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Option Use Multi Menus | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Option Select Default | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Customer Text Entry Box | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Customer Text Entry Header | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Customer Text Columns | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Customer Text Rows | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Advanced Options (!Menu1 rows) | — | ❌ | Not preserved in standard path | The `!Menu1`/`##`/`!!` block format is incompatible with the XML parser and may not survive |

---

## Inventory & Shipping

| Field | XML Tag | Status | Product Path | Source Lines |
|-------|---------|--------|--------------|--------------|
| Quantity On Hand | `QuantityOnHand` / `quantity_on_hand` / `Quantity` | ✅ 🔄 ⬆️ | `.core.inventory.quantityOnHand` | decode: CORE_FIELDS set (product-codec.ts:51-63). decode mapping (product-codec.ts:222-291). encode (ShopSiteProductCodec.encode) |
| Low Stock Threshold | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Out Of Stock Limit | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Weight | `Weight` / `weight` | ✅ 🔄 ⬆️ | `.core.weight` | decode: CORE_FIELDS set (product-codec.ts:51-63). decode mapping (product-codec.ts:222-291). encode (ShopSiteProductCodec.encode) |
| Taxable | `Taxable` | ✅ 🔄 ⬆️ | `.core.taxable` | decode: CORE_FIELDS set (product-codec.ts:51-63). decode mapping (product-codec.ts:222-291). encode (ShopSiteProductCodec.encode) |
| Product Type | `ProductType` | 📦 ⚠️ | `customFields['ProductType']` → preserved → DTD default | encode §11 precedence: `customFields['ProductType']` → preserved `unknownElements['ProductType']` → `builtInDefaultValue('ProductType')` (`Tangible`) (product-codec.ts:491-497; `src/shopsite/built-in-output-policy.ts:65`). Always emitted; set `customFields['ProductType']` to override |
| Disable Product | `ProductDisabled` / `productDisabled` | ✅ 🔄 ⬆️ | `.status` (`'active'` / `'draft'`) | decode: CORE_FIELDS set (product-codec.ts:51-63). decode mapping (product-codec.ts:222-291). encode (ShopSiteProductCodec.encode) |
| Ground Shipping | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Second Day Shipping | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Next Day Shipping | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Shipping 3–9 | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| No Shipping Charges | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Extra Handling Charge | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Dimension Options | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Dimension Text | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Dimension Selected | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| FedEx Container | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| USPS Container | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Minimum Quantity | `MinimumQuantity` | ✅ 📦 ⚠️ | `customFields['MinimumQuantity']` → preserved → DTD default | decode: CORE_FIELDS set (product-codec.ts:51-63). encode §4 precedence: `customFields['MinimumQuantity']` → preserved `unknownElements['MinimumQuantity']` → `builtInDefaultValue('MinimumQuantity')` (`0`) (product-codec.ts:453-459; `src/shopsite/built-in-output-policy.ts:64`). Always emitted; set `customFields['MinimumQuantity']` to override |

**Known divergences (encode behavior, `ShopSiteProductCodec.encode`):**
1. `MinimumQuantity` (product-codec.ts:453-459) — always emitted; precedence `customFields` → preserved → DTD default `0`
2. `ProductType` (product-codec.ts:491-497) — always emitted; precedence `customFields` → preserved → DTD default `Tangible`
3. `MoreInformationText` (product-codec.ts:531-549) — precedence `customFields` → preserved → `.core.description`, plus auto-emitted `<DisplayMoreInformationPage>` checked/uncheck
4. `FileName` (product-codec.ts:568-570) — resolved via `normalizeFileName(options?.fileName) ?? resolveBaseFileName(product)`, not emitted from the stored value directly
5. `ProductDescription` (product-codec.ts:481-487) — emitted from the product **name** (CDATA) per catalog upload convention, not from `.core.description`

---

## Product-Page Relationship

| Field | XML Tag | Status | Product Path | Source Lines |
|-------|---------|--------|--------------|--------------|
| Product On Pages | `ProductOnPages` / `productOnPages` | ✅ 📦 ⬆️ (block) | First-class `.core.productOnPages: string[]` (`src/shared/schemas/product.ts:45`) + preserved fallbacks | decode runs `extractPageNamesFromBlock` over `advancedBlocks['ProductOnPages'/'productOnPages']` or `fields['ProductOnPages']` (product-codec.ts:670-700). encode §15 resolves `core.productOnPages` → preserved unknown → preserved blocks (`resolveProductPageNames`, product-codec.ts:703-734) and emits modern `<ProductOnPages><PageLink><Name>` layout (product-codec.ts:519-529) |
| Add To Pages | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Display more information page? | `DisplayMoreInformationPage` | ✅ ⬆️ | `customFields` / preserved → auto-emitted | Read from `customFields['DisplayMoreInformationPage'/'DisplayMoreInformationPage_']` or preserved unknown elements; encode auto-emits `checked`/`uncheck` alongside `MoreInformationText` (product-codec.ts:531-549) |
| Cross Sell Products | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Template | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Include In Sitemap | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Sitemap Priority | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |

**`ProductOnPages` detail:** `extractPageNamesFromBlock` (product-codec.ts:670-700) extracts page names from `<Name>`, `<PageName>`, and `<PageLink>` child tags, with fallback text extraction. Resolution order in `resolveProductPageNames` (product-codec.ts:703-734): (1) first-class `core.productOnPages`, (2) preserved `unknownElements['ProductOnPages']` (un-migrated drafts or legacy rows), (3) preserved `advancedBlocks['ProductOnPages'/'productOnPages']`. Output uses the modern `<ProductOnPages><PageLink><Name>...</Name></PageLink></ProductOnPages>` layout.

---

## Search & SEO

| Field | XML Tag | Status | Product Path | Source Lines |
|-------|---------|--------|--------------|--------------|
| Search Keywords | `SearchKeywords` | ✅ 🔄 ⬆️ | `.core.seo.searchKeywords` | decode: CORE_FIELDS set (product-codec.ts:51-63), mapped at :222-291. encode §8 emits CDATA when non-blank (product-codec.ts:473-479) |
| Search Make Page | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Search Dest Type | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Search Dest | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |

---

## Google Merchant Center

| Field | XML Tag | Status | Product Path | Source Lines |
|-------|---------|--------|--------------|--------------|
| Google Merchant Center | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Brand | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| GTIN (ISBN or UPC) | `GTIN` / `GoogleGTIN` / `Google_GTIN` | ✅ 🔄 ⬆️ | `.customFields['GTIN']` / `.customFields['GoogleGTIN']` | decode merges `GoogleGTIN ?? Google_GTIN ?? GTIN`; legacy `<GTIN>` → `customFields['GTIN']`, either Google variant → `customFields['GoogleGTIN']` (product-codec.ts:242-259). encode §13: `<GTIN>` from `customFields['GTIN']`, else `customFields['GoogleGTIN']`, else 8–14-digit SKU; `<GoogleGTIN>` only when explicitly set (product-codec.ts:503-511) |
| MPN | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Google Product Category | — | 📦 | `.core.seo.googleProductCategory` (partial) | decode auto-sets `'GTIN:' + gtin` when a GTIN merged; not independently settable (product-codec.ts:222-291) |
| Availability | `Availability` | ✅ 🔄 ⬆️ | `.core.availability` | decode: CORE_FIELDS set (product-codec.ts:51-63). decode mapping (product-codec.ts:222-291). encode (ShopSiteProductCodec.encode) |
| Age Group | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Gender | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Include Variant Options | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Color Option | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Size Option | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Material Option | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Pattern Option | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Google Condition | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |

**GTIN handling detail:** Decode merges the three tag variants with priority `GoogleGTIN` > `Google_GTIN` > `GTIN` for the merged value; a legacy `<GTIN>` tag lands in `customFields['GTIN']` while either Google variant lands in `customFields['GoogleGTIN']` (product-codec.ts:242-259). Encode emits `<GTIN>` from `customFields['GTIN']`, else `customFields['GoogleGTIN']`, else the SKU when it is 8–14 digits — and emits `<GoogleGTIN>` **only** when `customFields['GoogleGTIN']` is explicitly set (product-codec.ts:503-511).

---

## Integration Fields

| Field | XML Tag | Status | Product Path | Source Lines |
|-------|---------|--------|--------------|--------------|
| QBImport | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Doba Information | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Product Download Location | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |

---

## Quantity Pricing

All quantity pricing fields are **pass-through only**:

| Field | Status | Product Path |
|-------|--------|--------------|
| Quantity Pricing | 📦 | `.shopsite.preserved.unknownElements` |
| Qty Pricing Background Color | 📦 | `.shopsite.preserved.unknownElements` |
| Qty Pricing Price and Comment Color | 📦 | `.shopsite.preserved.unknownElements` |
| Qty Pricing On Sale Color | 📦 | `.shopsite.preserved.unknownElements` |
| Qty Pricing Comment | 📦 | `.shopsite.preserved.unknownElements` |
| Qty Pricing Number Price Breaks | 📦 | `.shopsite.preserved.unknownElements` |
| Qty Pricing Ranges | 📦 | `.shopsite.preserved.unknownElements` |
| Quantity Pricing Group | 📦 | `.shopsite.preserved.unknownElements` |
| Display Quantity Pricing? | 📦 | `.shopsite.preserved.unknownElements` |

---

## Custom Fields

| Field | XML Tag | Status | Product Path | Source Lines |
|-------|---------|--------|--------------|--------------|
| Product Field 1–N | `ProductField1`–`ProductFieldN` | ✅ 🔄 ⬆️ | `.customFields[tag]` | decode captures **any** tag starting with `ProductField` (no numeric cap) into `customFields` (product-codec.ts:247-259). encode §20 re-emits in natural numeric order, skipping built-ins and warning on invalid XML tag names (product-codec.ts:572-589) |

**Important:** Decode captures any tag starting with `ProductField` (not limited to 1–25). Invalid XML tag names in `customFields` produce a warning during encode and the field is skipped.

---

## Fields NOT Present in KNOWN_FIELD_LABELS

The `KNOWN_FIELD_LABELS` map in `src/shopsite/product-codec.ts` (`:70-97`) has **18 entries** and drives the field registry (`editable`, `required`, `uiGroup`) plus the unknown-elements filter — anything not listed (and not `ProductField*` / `MoreInfoImageN`) passes through as unknown elements. Only 18 of 100+ documented fields have explicit handling. The full list of handled labels:

```
SKU, Name, Price, SaleAmount, ProductDescription, Weight, Graphic,
MoreInformationGraphic, QuantityOnHand, Taxable, Availability,
ProductID, ProductGUID, GTIN, GoogleGTIN, Google_GTIN, FileName,
ProductDisabled
```

Everything else — display styles, shipping costs, Google Shopping fields, quantity pricing, options, integration fields — is **preserved but not independently editable**.
