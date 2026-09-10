# ShopSite Field Type System

ShopSite uses specific field types to categorize database columns. Each type constrains the data format, serialization behavior, and parsing rules. This reference documents all known types and how they behave in XML upload/download workflows.

This reference applies to both **Product** and **Page** databases unless noted.

---

## Type Catalog

### 1. Text Entry

Unrestricted free-form text. Supports HTML tags and special characters. Best practice avoids single and double quotation marks.

| Attribute | Value |
|-----------|-------|
| **DTD/XML serialization** | Emitted as element text content or CDATA section for long values |
| **Parsing** | Read as-is; CDATA content extracted by XML parser |
| **Examples** | `ProductDescription`, `MoreInformationText`, `Graphic`, `SearchKeywords` |

**CDATA note:** Fields like `ProductDescription` and `MoreInformationText` are wrapped in `<![CDATA[...]]>` in ShopSite's XML output. The project's `denormalizeProduct()` uses `escapeCdata()` from `multipart-upload.ts` to safely wrap content. CDATA terminators (`]]>`) inside content must be escaped by splitting the CDATA section.

---

### 2. Short Text

Single-line or short text with a practical length limit. Used for names and identifiers.

| Attribute | Value |
|-----------|-------|
| **DTD/XML serialization** | Emitted as element text content |
| **Parsing** | Read as-is |
| **Examples** | `Name` (product name) |

**Required:** Unlike most fields, `Name` has no default and must always have a value.

---

### 3. Numeric Entry

Accepts only numeric values. May include numeric and decimal separators (e.g., `1,234.56`) but **no currency symbols**. The locale settings on the Preferences Locale screen control currency symbol display — the stored value is always numeric without symbols.

| Attribute | Value |
|-----------|-------|
| **XML serialization** | Emitted as plain number in element text |
| **Parsing** | Stored as string in the codebase (preserves formatting); parsed to number only for fields like `QuantityOnHand` |
| **Special behaviors** | `QuantityOnHand` supports delta updates: `+5` adds 5 to current, `-3` subtracts 3. Spreadsheet programs must set cell type to text-only to preserve the `+` prefix. |
| **Examples** | `Price`, `SaleAmount`, `Weight`, `QuantityOnHand`, `Low Stock Threshold`, `Out Of Stock Limit`, `Ground Shipping`, `Second Day Shipping`, `Next Day Shipping`, `Shipping 3`–`Shipping 9`, `Extra Handling Charge`, `Minimum Quantity`, `Customer Text Columns`, `Customer Text Rows`, `Number Products` |

---

### 4. Checkbox

Binary on/off state. Two values only.

| Attribute | Value |
|-----------|-------|
| **XML serialization** | `checked` = on/true; `uncheck` or blank = off/false |
| **Decoding** | In decode: `taxableRaw.toLowerCase() === 'checked'` → `true`. `ProductDisabled`: `'checked'` or `'1'` → `draft` status |
| **Examples** | `Taxable`, `Disable Product`/`ProductDisabled`, `Display Name?`, `Display SKU?`, `Display Price?`, `Display Graphic?`, `Sale On`, `Display more information page?`, `Display Order Quantity?`, `Display Ordering Options?`, `Use Add to Cart Image?`, `Option Append SKU`, `Option Use Multi Menus`, `Customer Text Entry Box`, `Search Products`, `Index`, `Include In Sitemap`, `Products First`, `No Shipping Charges`, `Variable Price?`, `Variable Name?`, `Variable SKU?`, `Google Merchant Center`, `Include Variant Options` |

---

### 5. Restricted Text Entry

Text restricted to specific allowed values. Case-sensitive — the entry must match an allowed value exactly.

| Attribute | Value |
|-----------|-------|
| **XML serialization** | Emitted as plain element text |
| **Parsing** | Validate against allowed set; warn on mismatch |
| **Examples** | Pull-down menus below (Name Style, Price Style, etc.) are technically this type with a fixed value set |

Used for fields with controlled vocabularies: `Search Dest Type`, `Search Dest`, `Product Type`, `Search Make Page`, `Add to Cart Button`, `View Cart Button`, `Cross Sell Products`, `Product On Pages`, `Add To Pages`, `Page Links`, `Product Links`, `Links To Page`, `Dimension Options`, `Dimension Text`, `Dimension Selected`, `FedEx Container`, `USPS Container`, `QBImport`, `Brand`, `GTIN (ISBN or UPC)`, `MPN`, `Google Product Category`, `Availability`, `Age Group`, `Gender`, `Color Option`, `Size Option`, `Material Option`, `Pattern Option`, `Google Condition`, `Doba Information`, `More Information Title`, `More Information Meta:Keywords`, `More Information Meta:Description`, `File name` |

---

### 6. Limited Text Entry

Text with a small set of pre-defined values, typically for SEO/priority settings.

| Attribute | Value |
|-----------|-------|
| **XML serialization** | Emitted as plain element text |
| **Parsing** | Accept known values or fall back to default |
| **Examples** | `Sitemap Priority` (`Google Default`, `0.0`–`1.0` in single decimal increments) |

---

### 7. Pull-down Menu

Named style/layout selection from a fixed set. Case-sensitive.

| Attribute | Value |
|-----------|-------|
| **XML serialization** | Emitted as plain element text |
| **Parsing** | Match against allowed set |
| **Examples** | `Name Style` (`Bold`, `Italic`, `Typewriter`, `Plain`), `Name Size` (`Normal`, `Big`, `Small`), `Price Style`, `Price Size`, `SKU Style`, `SKU Size`, `Description Style`, `Description Size`, `Image Alignment` (`Left`, `Right`, `Center`), `Text Wrap` (`On`, `Off`) |

These are encoded as **Restricted Text** values in upload/download fields, listed here separately because the back-office UI presents them as pull-down menus with specific options.

---

### 8. List

A pipe-delimited (`|`) list of page or product names. Used for cross-references between products and pages.

| Attribute | Value |
|-----------|-------|
| **XML serialization** | In delimited uploads: pipe-separated. In XML: usually handled via block elements (e.g., `<ProductOnPages><Name>page1</Name><Name>page2</Name></ProductOnPages>`) |
| **Parsing** | Split on `|` delimiter; strip whitespace |
| **Examples** | `Cross Sell Products`, `Product On Pages`, `Add To Pages`, `Page Links`, `Product Links`, `Links To Page`, `Subproducts` |

**Block-vs-delimited note:** In the XML format, list relationships like `ProductOnPages` and `Subproducts` are encoded as block elements with child elements (e.g., `<ProductOnPages><Name>...</Name></ProductOnPages>`), not pipe-delimited strings. The codebase preserves these as `advancedBlocks`.

---

### 9. Image

A reference to a graphic file. Accepts one of:
- A filename in the store's media directory (e.g., `media/product.jpg`)
- A full path to a file in another directory
- A full URL to an image
- The literal string `none` (no image)

| Attribute | Value |
|-----------|-------|
| **XML serialization** | Emitted as element text content |
| **Parsing** | Stored as string; `none` treated as null/missing |
| **Examples** | `Graphic`, `MoreInformationGraphic`, `More Information Graphic`, `More Information Image 1`–`25`, `Link Graphic`, `Background Image`, `Add to Cart Image`, `View Cart Image`, `More Info Extra Image` |

---

### 10. Radio Button

Binary choice between two options, represented numerically in upload files.

| Attribute | Value |
|-----------|-------|
| **XML serialization** | `0` for first option, `1` for second |
| **Parsing** | Parse as integer; map to boolean |
| **Examples** | `Use Add to Cart Image?` (`0` = use Add to Cart Button text, `1` = use Add to Cart Image file), `Use View Cart Image?` (`0`/`1`) |

---

### 11. Restricted Numeric

Numeric field with restricted values. Accepts only specific integer values.

| Attribute | Value |
|-----------|-------|
| **XML serialization** | Emitted as plain number |
| **Parsing** | Parse as integer; validate against allowed set |
| **Examples** | `Dimension Options` (`1` = ship by weight only / no dimensions, `2` = custom dimensions in `Dimension Text`, `3` = standard box from `Dimension Selected`) |

---

## Type Groupings in the Codebase

The `FieldRegistryEntry` schema (in `src/shared/schemas/field-registry.ts`) defines a `dataType` enum with a coarser grouping:

| Registry Type | Maps from ShopSite Types |
|---------------|--------------------------|
| `string` | Text Entry, Short Text, Restricted Text, Limited Text, Pull-down Menu, List |
| `number` | Numeric Entry, Restricted Numeric, Radio Button (`0`/`1`) |
| `boolean` | Checkbox |
| `html` | Text Entry with HTML content (ProductDescription, MoreInformationText) |
| `image` | Image |
| `list` | List (pipe-delimited) |
| `raw_xml` | Advanced blocks (Subproducts, ProductOptions, ProductOnPages) |

The `inferRegistryDataType()` function in `src/shopsite/product-codec.ts` (`:736`) maps specific tag names to the registry types:
```typescript
function inferDataType(tag: string, _value: string | null): 'string' | 'number' | 'boolean' | 'image' {
  if (tag === 'Price' || tag === 'SaleAmount' || tag === 'Weight' || tag === 'QuantityOnHand') {
    return 'number';
  }
  if (tag.includes('Image') || tag === 'Graphic' || tag === 'MoreInformationGraphic') {
    return 'image';
  }
  if (tag === 'Taxable' || tag === 'ProductDisabled') {
    return 'boolean';
  }
  return 'string';
}
```

## XML Serialization Summary

| ShopSite Type | XML Value | Empty/Missing |
|---------------|-----------|---------------|
| Text / Short Text | Element text | Omit element or emit empty |
| Numeric | Plain number string | Omit element (DTD optional) |
| Checkbox (`checked`) | `checked` | `uncheck` |
| Checkbox (`unchecked`) | `uncheck` | (default) |
| Image | Path/URL or `none` | Omit or `none` |
| Radio (`0`) | `0` | — |
| Radio (`1`) | `1` | — |
| Restricted Numeric | Plain number string | — |
| List (delimited) | Pipe-separated values | Empty string |
| List (XML block) | Child element per item | Omit block |
| CDATA content | `<![CDATA[...]]>` | Omit element |

## DTD Requirements

The ShopSite product DTD (`shopsiteproducts.dtd` v2.9, declared as `<!DOCTYPE ShopSiteProducts PUBLIC "-//shopsite.com//ShopSiteProduct DTD//EN" "http://www.shopsite.com/XML/2.9/shopsiteproducts.dtd">`) enforces:

- `SKU`, `Name` are required (no default)
- `MinimumQuantity` is required — the codebase hardcodes it to `0`
- `ProductDisabled` and `Taxable` are required — codebase always emits these
- `Price`, `SaleAmount`, `Weight`, `Graphic`, `QuantityOnHand` are optional
- `ProductType` is likely optional but the codebase defaults to `Tangible`
