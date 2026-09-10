# MIME Encoded XML Upload Format

This reference documents the `multipart/form-data` structure used when uploading XML product/page data to `dbupload.cgi` via MIME encoding.

> **Source:** ShopSite's "MIME Encoded XML Upload" documentation page.
> **Note:** Page XML MIME structure is not explicitly documented; treat the page section as a labeled placeholder.

---

## Boundary Format

ShopSite MIME uploads use a multipart boundary. The official ShopSite example uses:

```
---------------------------ShopSiteUpload_$
```

Boundary values are client-chosen — any valid multipart boundary works. This repo generates one per upload in `src/shopsite/multipart-upload.ts:6,52` (`BOUNDARY_PREFIX` + timestamp), which uses the same 27-dash prefix as the official example. The examples below use the official boundary string.

---

## Form Data Part Order

The multipart body must contain parts in this exact order:

### Part 1: `clientApp`

```
---------------------------ShopSiteUpload_$
Content-Disposition: form-data; name="clientApp"

1
```

### Part 2: `dbname`

```
---------------------------ShopSiteUpload_$
Content-Disposition: form-data; name="dbname"

products
```
(Pages use `pages` as the value.)

### Part 3: `uniqueName`

```
---------------------------ShopSiteUpload_$
Content-Disposition: form-data; name="uniqueName"

SKU
```
| Database | Valid Values |
|----------|-------------|
| Products | `Name`, `SKU`, `Product GUID`, `(none)` |
| Pages | `Name`, `File+Name`, `(none)` |

### Part 4: `batchsize`

```
---------------------------ShopSiteUpload_$
Content-Disposition: form-data; name="batchsize"

500
```

The batch size controls how many records are processed per batch. For large databases, typical values are 500–1000.

### Part 5: `newRecords`

```
---------------------------ShopSiteUpload_$
Content-Disposition: form-data; name="newRecords"

yes
```
- `yes` (default) — unmatched records are added as new
- `no` — unmatched records are ignored

### Part 6: `defer_linking`

```
---------------------------ShopSiteUpload_$
Content-Disposition: form-data; name="defer_linking"

no
```
- `no` (default) — linking happens as part of the upload
- `yes` — defer linking until all batches are uploaded (for multi-file batches)

### Part 7: `use_optimizer`

```
---------------------------ShopSiteUpload_$
Content-Disposition: form-data; name="use_optimizer"

no
```

**Note:** `use_optimizer` appears with value `no` in the official MIME example. Older doc captures vary, so treat non-`no` values as version-variable.

### Part 8: File Part (`Desktop`)

```
---------------------------ShopSiteUpload_$
Content-Disposition: form-data; name="Desktop"; filename="products.xml"
Content-Type: text/xml

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ShopSiteProducts PUBLIC "-//shopsite.com//ShopSiteProduct DTD//EN" "http://www.shopsite.com/XML/2.9/shopsiteproducts.dtd">
<ShopSiteProducts version="15.0">
<Response>
<ResponseCode>1</ResponseCode>
<ResponseDescription>success</ResponseDescription>
</Response>
<Products>
  <!-- product XML here -->
</Products>
</ShopSiteProducts>
```

Key details:
- Part name must be `Desktop`
- `Content-Type` should be `text/xml`
- `filename` can be any valid name (e.g., `products.xml`)
- The XML declaration and DOCTYPE are part of the file content
- Include the `<Response>` block inside the XML payload exactly as the official example does (see below)
- The official example declares `iso-8859-1`; this repo emits `UTF-8` (`src/shopsite/product-codec.ts:636`) and the repo's real-export fixtures use `UTF-8` — keep `UTF-8`
- For pages, use `ShopSitePages` / `Pages` with the page DOCTYPE (confirmed from a real export — see Page Upload section)

### The `<Response>` Block (Inside the XML Payload)

The official MIME example includes this block at the top of the uploaded XML, before `<Products>`:

```xml
<Response>
<ResponseCode>1</ResponseCode>
<ResponseDescription>success</ResponseDescription>
</Response>
```

Include it verbatim. There is **no** `Response` form-data part in the documented multipart body — any such part is not from the official docs.

---

## Closing Boundary

```
---------------------------ShopSiteUpload_$--
```

---

## Complete Worked Example (Products)

```
---------------------------ShopSiteUpload_$
Content-Disposition: form-data; name="clientApp"

1
---------------------------ShopSiteUpload_$
Content-Disposition: form-data; name="dbname"

products
---------------------------ShopSiteUpload_$
Content-Disposition: form-data; name="uniqueName"

SKU
---------------------------ShopSiteUpload_$
Content-Disposition: form-data; name="batchsize"

500
---------------------------ShopSiteUpload_$
Content-Disposition: form-data; name="newRecords"

yes
---------------------------ShopSiteUpload_$
Content-Disposition: form-data; name="defer_linking"

no
---------------------------ShopSiteUpload_$
Content-Disposition: form-data; name="use_optimizer"

no
---------------------------ShopSiteUpload_$
Content-Disposition: form-data; name="Desktop"; filename="products.xml"
Content-Type: text/xml

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ShopSiteProducts PUBLIC "-//shopsite.com//ShopSiteProduct DTD//EN" "http://www.shopsite.com/XML/2.9/shopsiteproducts.dtd">
<ShopSiteProducts version="15.0">
<Response>
<ResponseCode>1</ResponseCode>
<ResponseDescription>success</ResponseDescription>
</Response>
<Products>
  <Product>
    <SKU>EXAMPLE-1</SKU>
    <Name>Example Product</Name>
    <Price>19.99</Price>
  </Product>
</Products>
</ShopSiteProducts>
---------------------------ShopSiteUpload_$--
```

---

## Page Upload (Confirmed From a Real Export)

Page structure below is confirmed from the repo's real-export fixture
`src/tests/fixtures/shopsite-pages-bay-state-redacted.xml`, parsed by
`src/shopsite/page-parser.ts` — not inferred. For page uploads, follow the same
multipart structure but:
- `dbname: pages`
- `uniqueName: Name` or `File+Name`
- File uses `ShopSitePages` / `Pages` with the page DOCTYPE and a `<Response>` block

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ShopSitePages PUBLIC "-//shopsite.com//ShopSitePage DTD//EN" "http://www.shopsite.com/XML/2.9/shopsitepages.dtd">
<ShopSitePages version="15.0">
<Response>
<ResponseCode>1</ResponseCode>
<ResponseDescription>success</ResponseDescription>
</Response>
<Pages>
  <Page>
    <Name>Example Page</Name>
    <PageTitle>Example Page</PageTitle>
    <PageFileName>example.html</PageFileName>
  </Page>
</Pages>
</ShopSitePages>
```

> Identity tags (`<PageID>`, `<PageFileName>`, `<LinksToPage>`, `<ProductLinks>`) are confirmed. Remaining page field tags are cataloged in the `shopsite-page-fields` skill; confirm any unlisted tag against a real `db_xml.cgi` export before emitting it.

---

## `dbmake.cgi` Follow-Up

After a MIME upload completes, ShopSite returns a `return_string`. This string must be passed to `dbmake.cgi` to finalize the import:

```
http://store.example.com/cgi-path/dbmake.cgi?_return_string_
```

- Replace `_return_string_` with the exact value returned by `dbupload.cgi`
- The URL should point to the same ShopSite back-office CGI directory
- This step is **required** — the data is not committed until `dbmake.cgi` processes the return string

**Important:** Pass the return string **exactly as returned**, without URL-encoding or modifying it.

---

## Post-Upload Reminders

1. After a MIME upload + dbmake.cgi callback, the data is imported but **not yet visible to shoppers**.
2. Run `generate.cgi` (or use the back-office Publish function) to regenerate the store pages.
3. For batch uploads with `defer_linking=yes` on all but the last file, use the **Update Links** button in the back office (or equivalent linking step) after all files are uploaded.
