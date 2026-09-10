# Database Upload Options

This reference documents the upload option semantics for the ShopSite automated database XML upload and the back-office upload UI. Options are available both through `dbupload.cgi` parameters and the upload configuration screens.

---

## `uniqueName` — Record Matching Key

The `uniqueName` parameter controls how uploaded records are matched against existing records in the ShopSite database. Records that match an existing record are **updated**; records that do not match are added or ignored based on `newRecords`.

| Database | Valid `uniqueName` Values | Default |
|----------|--------------------------|---------|
| **Products** | `Name`, `SKU`, `(none)` | `Name` |
| **Pages** | `Name`, `File+Name`, `(none)` | `Name` |

### Behavior per value:
- **`Name`** (default) — matches products/pages by their display name. If names change between imports, matches may fail.
- **`SKU`** (Products only) — matches products by SKU. Recommended when SKUs are stable. Used as primary key in this CMS project.
- **`File+Name`** (Pages only) — matches pages by their file name. Useful when page names change but filenames remain stable.
- **`(none)`** — disables record matching entirely. Every record in the upload is treated as a new record. **Risk: duplicates.** If a product with the same name already exists, a duplicate entry will be created.

> **⚠️ Risk warning:** Using `uniqueName=(none)` will create duplicate entries. Only use this when you intentionally want multiple records with the same name/SKU in the database.

---

## `newRecords` — Unmatched Record Handling

Controls what happens to records in the upload file that do not match any existing record:

| Value | Behavior |
|-------|----------|
| `yes` (default) | Unmatched records are **added** as new products or pages |
| `no` | Unmatched records are **ignored** (only updates to existing records) |

> **⚠️ Silent skip:** When `newRecords=no`, unmatched rows are silently ignored with no error or warning. Make sure your data only contains records you intend to update.

---

## `defer_linking` — Batch Upload Linking Control

Controls when product-to-page linking happens. Useful for very large databases split across multiple files:

| Value | Behavior |
|-------|----------|
| `no` (default) | Linking happens as part of each upload |
| `yes` | Linking is postponed until all files have been uploaded |

### Batch upload workflow with deferred linking:

1. Set `defer_linking=yes` on all files except the **last one**
2. Upload each file in sequence
3. On the **last file**, either:
   - Set `defer_linking=no` (linking happens at end of last upload), **or**
   - Use the back-office **Update Links** button (Utilities → Database → Upload) after all uploads complete

4. After linking, remember to **publish** the store so changes are visible.

> **Note:** Deferred linking can save considerable time for extremely large databases.

---

## `restart` — Resuming Interrupted Uploads

If an upload times out or is interrupted:

| Value | Behavior |
|-------|----------|
| (omitted) | Normal upload from start |
| `1` | Resume from where the previous upload left off |

To restart: call `dbupload.cgi` with the same parameters as the original upload, plus `restart=1`.

---

## `batchsize` — Records Per Batch

Controls how many records are processed in each batch during MIME uploads:

- Typical value: `500` (used in ShopSite's MIME example)
- Larger values may cause timeouts on large databases
- Smaller values increase the number of round-trips but reduce per-request risk

---

## Back-Office Upload Options

When uploading via the back-office UI (not automated):

### Unique Product/Page Identifier
Allows overriding the default matching field:
- Default: product/page **Name**
- Alternative: **Product SKU** or **Page File Name**
- Option to have **no unique identifier** (duplicate risk applies)

### New Products/Pages
Controls how unmatched records are handled:
- **Add** (default) — create new records for unmatched rows
- **Ignore** — skip unmatched rows, only update existing

### Link Options
Checkbox to **Defer linking** until all files are uploaded. After uploading all files, click **Update Links** on the Database Upload screen.

---

## Risk Summary

| Configuration | Risk | Mitigation |
|--------------|------|------------|
| `uniqueName=(none)` | Duplicate records in database | Only use when intentionally creating duplicates |
| `newRecords=no` | Unmatched rows silently skipped | Verify your data only contains records to update |
| `defer_linking=yes` on all files | Products not linked to pages | Always set linking on the last file or run Update Links |
| Large batch without `restart` | Timeout on large databases | Use `restart=1` after timeout, or reduce `batchsize` |
