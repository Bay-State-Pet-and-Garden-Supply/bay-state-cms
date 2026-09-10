# Database Download Options

This reference documents the back-office database download configuration options (accessible from Utilities → Database → Upload/Download → Download). These are the **UI download options**; the automated equivalents via `db_xml.cgi` are documented in the main `SKILL.md` and `documented-surface.md`.

---

## Download Format Selection

When downloading a database from the back office, ShopSite supports these formats:

| Format | Available For | Description |
|--------|---------------|-------------|
| **Tab-delimited** | Products, Pages, Associates | Basic tab-separated values file, importable into spreadsheets |
| **XML** | Products, Pages (not Associates) | XML file with full field structure |
| **eBay® Turbo Lister** | Products only | eBay-specific format (requires configuration) |
| **QuickBooks®** | Products, Orders | QuickBooks IIF format (requires configuration) |

---

## Version Selection

For tab-delimited and XML downloads, you can select the ShopSite version format:

> You should probably select the current version of ShopSite unless you will be importing the information into a third-party application that requires an earlier version.

---

## Field Selection Modes

You can control which fields are included in the download:

### All Fields
Downloads every field in the database. This is the **default**.

### Selected Fields Only
Choose a specific subset of fields:
1. Click **Select** to open a pop-up window
2. Add fields from the left box (available) to the right box (selected) using **Add >**
3. Remove fields with **< Remove**
4. Click **OK** to save or **Cancel** to abandon

### Use Field Map
Create reusable field maps that control field subset, ordering, and custom labels:

1. Select **Use Field Map** → click **Change**
2. Create a new field map by entering a name in the **Field Map** text box
3. Add/remove fields using **Add >** and **< Remove**
4. Fields appear in the download in the order they appear in the right box
5. To rename a field in the download: select it in the right box → enter a new name in **Field Label** → click **Change**
6. To delete a field map: select it → click **Delete**
7. Click **Save** to close or **Cancel** to abandon

> **Note:** Field maps can be created from the back office by going to Utilities → Database → Upload/Download → select the database → Download. In the "Download fields" section, find "Use field map", select `<New>` from the pull-down, and click **Change**.

---

## Important: XML/QuickBooks Order Downloads

When downloading **orders**:
- **XML and QuickBooks format** downloads always include **ALL fields** regardless of field selection settings.
- Tab-delimited order downloads group product fields together after other order fields. You can change the order within the product block and the order of other information before it.

---

## Product/Page Field Maps and the `fieldmap` Parameter

The `fieldmap` parameter in `db_xml.cgi` (automated downloads) corresponds to field maps created through this UI. To use a field map programmatically:

```
/db_xml.cgi?clientApp=1&dbname=products&fieldmap=my_field_map
```

Field maps created in the UI can be referenced by name in automated calls.

---

## File Name and Extension

- **File name:** Enter a name (without extension). ShopSite appends the extension.
- **File type (extension):** Select from pull-down list or enter custom. This tells the browser how to handle the file but does not affect content.

---

## Download Options Screen

For Products, Pages, and Associates, choose where to save:
- **Download to browser** (local computer) — recommended for most cases
- **Download to store's output directory** — leaves the file on the server

For Orders, also select:
- Whether to copy **Billing Address** into **Shipping Address** fields when no separate shipping address exists
- Note: downloading orders **purges stored CVV2 data** from the ShopSite database
