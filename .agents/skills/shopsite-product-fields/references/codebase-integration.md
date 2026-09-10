# Codebase Integration: Adding a New ShopSite Product Field

This guide documents the exact workflow for adding support for a new ShopSite product field to the CMS codebase. Follow these steps in order when extending the product model with additional ShopSite fields.

---

## Step 0: Identify the Field

Before writing code, determine:

1. **Field name** from the ShopSite documentation or a `db_xml.cgi` export (e.g., `Brand`, `Low Stock Threshold`)
2. **XML tag** from the export (e.g., `Brand`) or inferred from field name (e.g., `LowStockThreshold`)
3. **Type** from the [field type system](../field-type-system.md) (Text, Numeric, Checkbox, etc.)
4. **Default value** and **allowed values** from the [product field catalog](../product-field-catalog.md)
5. **Whether the field should be editable** through the CMS or preserved read-only

> **Recommendation:** Always confirm the XML tag from a real `db_xml.cgi` export before depending on it. Inferred tags (derived from field names) are highly likely correct but not guaranteed.

---

## Step 1: Add to the Zod Schema (`src/shared/schemas/product.ts`)

Add the field to the appropriate section of the `ProductSchema`. Choose the right location based on the field's category:

### For a core product field (price, weight, description, etc.):

Add to `CoreProductSchema`:

```typescript
export const CoreProductSchema = z.object({
  name: z.string().min(1, 'Product name is required'),
  price: z.string().nullable().default(null),
  // ... existing fields ...
  // NEW FIELD:
  brand: z.string().nullable().default(null),
});
```

### For an inventory field:

Add to `InventorySchema`:

```typescript
export const InventorySchema = z.object({
  quantityOnHand: z.number().int().nullable().default(null),
  lowStockThreshold: z.number().int().nullable().default(null),
  outOfStockLimit: z.number().int().nullable().default(null),
  // NEW FIELD:
  lowStockThreshold: z.number().int().nullable().default(null),
});
```

### For an SEO/meta field:

Add to `SeoSchema`:

```typescript
export const SeoSchema = z.object({
  fileName: z.string().nullable().default(null),
  searchKeywords: z.string().nullable().default(null),
  googleProductCategory: z.string().nullable().default(null),
  // NEW FIELD:
  brand: z.string().nullable().default(null),
});
```

### For a media field:

Add to `MediaSchema`:

```typescript
export const MediaSchema = z.object({
  primary: z.string().nullable().default(null),
  additional: z.array(z.string()).default(() => [] as string[]),
  // NEW FIELD (if appropriate):
  // (media fields are generally just primary + additional)
});
```

### For a custom/system field:

If the field doesn't fit core/inventory/seo/media, add it directly to `ProductSchema` or `ShopSiteMetaSchema`:

```typescript
export const ProductSchema = z.object({
  // ... existing fields ...
  // NEW FIELD at product level:
  customFields: z.record(z.string(), z.string()),
  // NEW structured field:
  googleShopping: z.object({
    brand: z.string().nullable().default(null),
    gtin: z.string().nullable().default(null),
    mpn: z.string().nullable().default(null),
    condition: z.string().default('New'),
  }).default({}),
});
```

### For a pass-through-only field:

If the field should remain preserved but not independently editable, skip the schema change. It will automatically survive round-trips in `unknownElements`.

---

## Step 2: Update Decode (`src/shopsite/product-codec.ts` — `ShopSiteProductCodec.decode`)

If the XML tag is not already in the `CORE_FIELDS` set (`product-codec.ts:51-63`), add it:

```typescript
const CORE_FIELDS = new Set([
  'SKU', 'sku', 'Name', 'name', 'Price', 'price',
  // ... existing fields ...
  // NEW FIELD:
  'Brand',
]);
```

**If the field is a block-level element** (contains child elements like `Subproducts`, `ProductOptions`, `ProductOnPages`), add it to the `BLOCK_TAGS` set (`product-codec.ts:64-68`) instead:

```typescript
const BLOCK_TAGS = new Set([
  'Subproducts', 'subproducts',
  'ProductOptions', 'Options', 'options',
  'ProductOnPages', 'productOnPages',
  // NEW BLOCK FIELD:
  'ShippingOptions',
]);
```

> **Why this matters:** Adding a tag to `CORE_FIELDS` makes it available as a simple key-value pair in the decoded `fields` record. Adding to `BLOCK_TAGS` preserves its raw XML structure in `advancedBlocks`. Adding to neither means it still lands in `unknownElements` (any non-core tag does), but without a simple keyed value.

---

## Step 3: Map the Field in Decode (`src/shopsite/product-codec.ts`, mapping at `:222-291`)

### 3a. Extract the field value:

```typescript
const brand = fields['Brand'] ?? null;
```

### 3b. Map to the Product field in the `product` literal:

```typescript
const product: Product = {
  // ... existing fields ...
  core: {
    // ... existing core fields ...
    brand,  // <-- NEW FIELD (schema must allow it first — see Step 1)
  },
};
```

### 3c. Add to `KNOWN_FIELD_LABELS` (`product-codec.ts:70-97`, currently 18 entries) so it appears in the field registry and is excluded from unknown-elements re-emit:

```typescript
const KNOWN_FIELD_LABELS: Record<string, { label: string; kind: string }> = {
  // ... existing entries ...
  Brand: { label: 'Brand', kind: 'custom' },
};
```

Choose the right `kind`:
- `'core'` — standard ShopSite product field
- `'system'` — ShopSite-internal (ProductID, ProductGUID, ProductDisabled; not editable)
- `'custom'` — custom/Google/integration fields

### 3d. Optionally update `inferRegistryDataType()` (`product-codec.ts:736`):

```typescript
function inferRegistryDataType(tag: string): 'string' | 'number' | 'boolean' | 'image' {
  // ... existing type mapping ...
  if (tag === 'Brand') return 'string';
}
```

---

## Step 4: Emit the Field in Encode (`src/shopsite/product-codec.ts` — `ShopSiteProductCodec.encode`, `:430-626`)

### 4a. Emit the field value when present (add a numbered section following the existing §1–§22 order):

```typescript
// Brand
if (product.core.brand) {
  lines.push(`  <Brand>${escapeXml(product.core.brand)}</Brand>`);
}
```

### 4b. For checkbox fields:

```typescript
// SomeCheckbox
lines.push(`  <SomeCheckbox>${product.core.someCheckbox ? 'checked' : 'uncheck'}</SomeCheckbox>`);
```

### 4c. For numeric fields:

```typescript
if (product.core.numericField != null) {
  lines.push(`  <NumericField>${product.core.numericField}</NumericField>`);
}
```

### 4d. For fields that should always be emitted (like `MinimumQuantity` §4 / `ProductType` §11):

```typescript
// Always emit, even when empty/default
lines.push(`  <AlwaysEmitField>${escapeXml(product.core.alwaysEmitField ?? '')}</AlwaysEmitField>`);
```

### 4e. Ensure unknown elements still round-trip:

Encode re-emits preserved unknown elements at §22 (`product-codec.ts:597-622`). If the new field was previously preserved as an unknown element, exclude it there to avoid duplication. Add an exclusion:

```typescript
for (const [tag, rawValue] of Object.entries(preserved.unknownElements)) {
  if (tag === 'Brand') continue; // handled above
  // ... existing logic ...
}
```

Also check the tag is not swallowed by the §22 skip-list or the `KNOWN_FIELD_LABELS` filter in decode — a newly-known tag must have an explicit emit (like this step) or it will be parsed but silently dropped on output (this is what happened to `ProductGUID`/`ProductID`: parsed into the model, not re-emitted).

---

## Step 5: Add Unit Tests (`src/tests/unit/shopsite-normalizer.test.ts`)

Tests exercise the codec seam directly: `ShopSiteProductCodec.decode(xml)` → `{ products, ... }` and `ShopSiteProductCodec.encode(product)` → `{ xml, warnings }`.

### 5a. Test decoding:

```typescript
it('should decode the Brand field from XML', () => {
  const { products } = ShopSiteProductCodec.decode(`<Product>
    <SKU>BRAND-TEST</SKU>
    <Name>Brand Test</Name>
    <Brand>Acme Corp</Brand>
  </Product>`);
  expect(products[0].core.brand).toBe('Acme Corp');
});
```

### 5b. Test encoding:

```typescript
it('should emit Brand tag when brand is set', () => {
  const { products } = ShopSiteProductCodec.decode(`<Product>
    <SKU>BRAND-TEST</SKU>
    <Name>Brand Test</Name>
    <Brand>Acme Corp</Brand>
  </Product>`);
  const { xml } = ShopSiteProductCodec.encode(products[0]);
  expect(xml).toContain('<Brand>Acme Corp</Brand>');
});
```

### 5c. Test round-trip preservation:

```typescript
it('should round-trip Brand through decode and encode', () => {
  const { products } = ShopSiteProductCodec.decode(`<Product>
    <SKU>BRAND-TEST</SKU>
    <Name>Brand Test</Name>
    <Brand>Acme Corp</Brand>
  </Product>`);
  const { xml } = ShopSiteProductCodec.encode(products[0]);
  // Re-decode the output
  const reDecoded = ShopSiteProductCodec.decode(xml);
  expect(reDecoded.products[0].core.brand).toBe('Acme Corp');
});
```

### 5d. Test default/empty behavior:

```typescript
it('should not emit Brand tag when brand is not set', () => {
  const { products } = ShopSiteProductCodec.decode(`<Product>
    <SKU>NO-BRAND</SKU>
    <Name>No Brand</Name>
  </Product>`);
  const { xml } = ShopSiteProductCodec.encode(products[0]);
  expect(xml).not.toContain('<Brand>');
});
```

---

## Step 6: Run Validation

```bash
# TypeScript type checking
bun run typecheck

# Run the test suite
bun run test

# Run linting
bun run lint
```

All existing tests must pass. The round-trip tests in `shopsite-xml-roundtrip.test.ts` are especially important — they verify that unknown elements and advanced blocks survive the normalize → denormalize cycle.

---

## Hard Constraints

These constraints **must not** be violated when adding new fields:

### 1. Unknown elements MUST survive round-trips

Every tag not explicitly handled in decode/encode must be preserved in `.shopsite.preserved.unknownElements` and re-emitted unchanged. This is ensured by:
- Decode puts non-`CORE_FIELDS` tags into `unknownElements` unless they are known labels, `ProductField*`, or `MoreInfoImageN` (`product-codec.ts:196-197`, `:215-216`, filter at `:276`)
- Encode re-emits everything from `.shopsite.preserved.unknownElements` at §22 (`product-codec.ts:597-622`)

When you add a new field, you must explicitly exclude it from the unknown elements loop to avoid double-emission:

```typescript
// In the encode §22 unknown elements loop:
if (tag === 'Brand') continue; // handled by explicit emit above
```

### 2. Advanced blocks MUST survive round-trips

Block-level elements (`Subproducts`, `ProductOptions`, `ProductOnPages`) are preserved as raw XML in `.shopsite.preserved.advancedBlocks`. They are re-emitted as raw XML without re-parsing.

### 3. `ProductField*` prefix convention

Any XML tag starting with `ProductField` is automatically captured into `.customFields` by decode — no numeric cap (`product-codec.ts:247-259`). Encode validates that custom field names are valid XML tag names before emitting at §20 (`product-codec.ts:572-589`). Invalid names produce a warning and the field is skipped.

### 4. DOCTYPE must reference `shopsiteproducts.dtd` v2.9

The XML output must declare:
```xml
<!DOCTYPE ShopSiteProducts PUBLIC "-//shopsite.com//ShopSiteProduct DTD//EN" "http://www.shopsite.com/XML/2.9/shopsiteproducts.dtd">
```

This is currently emitted by `ShopSiteProductCodec.encodeMany` (`product-codec.ts:636-638`) via the thin `src/shopsite/xml-builder.ts` delegate, and should remain unchanged.

### 5. SKU is the primary key

The project uses `SKU` as `uniqueName` for product matching (`source.uniqueName: 'SKU'` is set on every decoded product, `product-codec.ts:333`). Decode requires the field record to yield a usable product; encode always emits `<SKU>` (§6, `product-codec.ts:463-464`).

### 6. CDATA content must be safely escaped

Fields like `ProductDescription`, `MoreInformationText`, and `SearchKeywords` are wrapped in CDATA sections. The `escapeCdata()` helper from `multipart-upload.ts` must be used to escape `]]>` terminators inside the content (used by `ShopSiteProductCodec.encode`).

### 7. Numeric fields with delta support

`QuantityOnHand` supports delta updates (`+5`, `-10`). If implementing similar inventory fields, respect this convention. The parsed value is an integer; the delta prefix is handled by ShopSide at upload time.

---

## Quick Reference: File Paths

| Layer | File | Key Function/Area |
|-------|------|-------------------|
| Schema | `src/shared/schemas/product.ts` | `CoreProductSchema`, `InventorySchema`, `SeoSchema`, `ProductSchema` (incl. first-class `core.productOnPages: string[]`) |
| Codec decode | `src/shopsite/product-codec.ts` | `CORE_FIELDS` (`:51-63`), `BLOCK_TAGS` (`:64-68`), field mapping (`:222-291`), `KNOWN_FIELD_LABELS` (`:70-97`), `inferRegistryDataType()` (`:736`), `extractPageNamesFromBlock` (`:670-700`) |
| Codec encode | `src/shopsite/product-codec.ts` | `ShopSiteProductCodec.encode` (`:430`, §§1–22), `encodeMany` (`:628`), `resolveProductPageNames` (`:703-734`) |
| Field authority | `src/shopsite/field-catalog.ts` | `SHOP_SITE_FIELD_CATALOG_VERSION`, `getFieldByTag`, `getDtdDefault`, DTD-default policy via `built-in-output-policy.ts` |
| XML builder | `src/shopsite/xml-builder.ts` | Thin `encode`/`encodeMany` delegate; `buildProductsXml`, `buildProductXml` |
| Tests | `src/tests/unit/shopsite-normalizer.test.ts` | Codec-seam unit tests (`decode`/`encode` directly) |
| Round-trip tests | `src/tests/unit/shopsite-xml-roundtrip.test.ts` | Round-trip preservation tests |
| Sample fixture | `src/tests/fixtures/shopsite-products-sample.xml` | Sample XML for tests |
| Field registry | `src/shared/schemas/field-registry.ts` | `FieldRegistryEntrySchema` |

## Command Reference

```bash
bun run typecheck    # TypeScript type checking
bun run test         # Run all tests (Vitest)
bun run lint         # ESLint code style
```
