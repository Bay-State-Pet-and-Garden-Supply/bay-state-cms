# Artifact recipes

Use this file when the user wants concrete examples instead of a prose-only explanation.

## Example output style

Prefer this structure for substantial artifact requests:

### Recommendation
Short explanation of the safest documented approach.

### Example
A URL, multipart body, or step-by-step batch plan.

### Caveats
Documented warnings, version-variable notes, and follow-up steps.

### Unspecified details
Anything the ShopSite pages do not fully define.

## Download request recipe

Use when the user asks for a `db_xml.cgi` example.

Collect:
- base CGI URL
- `dbname`
- optional `version`
- optional field list
- optional `fieldmap`
- optional `download_shopsite_version=1`

Rules:
- `fields` should be pipe-delimited, e.g. `|Name|SKU|Price|`
- if the user asks for a very specific export, include only the named fields
- mention that docs show query-style examples even while describing HTTP POST invocation

Helper:

```bash
python3 scripts/build_shopsite_examples.py download --base-url https://store.example.com/cgi-bin/merchant --dbname products --fields Name SKU Price
```

## Upload request recipe

Use when the user asks for a `dbupload.cgi` example.

For MIME multipart uploads, see `references/mime-upload-format.md` for the exact multipart structure, boundary format, and form-data part ordering.

For upload option semantics (uniqueName, newRecords, defer_linking, restart), see `references/upload-options.md`.

Collect:
- base CGI URL
- `dbname`
- `uniqueName`
- `newRecords`
- `defer_linking`
- optional `restart=1`
- optional `filename`
- optional version-variable knobs: `checkpoint`, `use_optimizer`

Rules:
- validate the unique key against the database type
- warn on `(none)`
- explain `newRecords=no`
- if this is a retry after timeout, include `restart=1`

Helper:

```bash
python3 scripts/build_shopsite_examples.py upload --base-url https://store.example.com/cgi-bin/merchant --dbname products --unique-name SKU --new-records no --defer-linking no
```

## MIME multipart recipe

Use when the user asks for a MIME upload template.

### Products
You may provide a documentation-derived starter because the crawlable docs show a product example.

### Pages
Do not fabricate an official XML structure. Provide only a placeholder and tell the user to export a ShopSite-generated pages sample.

Always add these reminders:
- the `Response` block appears in the product example, but its requiredness is unspecified
- after MIME upload, pass `return_string` to `dbmake.cgi` exactly as returned
- publish/regenerate after import

Helper:

```bash
python3 scripts/build_shopsite_examples.py mime --dbname products --unique-name Name --filename products.xml
```

## Batch planning recipe

Use when the user mentions large imports, timeouts, or tens of thousands of records.

Suggested plan shape:
1. split the upload into batches
2. use `defer_linking=yes` on every batch except the last
3. mention `checkpoint` / `use_optimizer` only as version-variable options
4. after the last batch, finish linking if needed and publish/regenerate
5. if an automated run was interrupted, consider `restart=1`

## Publish recipe

Use when the user asks how to make changes visible or wants a `generate.cgi` example.

Collect:
- base CGI URL
- whether they want `htmlpages`, `custompages`, `index`
- whether they need `regen`
- whether `sitemap` is relevant and available

Helper:

```bash
python3 scripts/build_shopsite_examples.py publish --base-url https://store.example.com/cgi-bin/merchant --htmlpages --custompages --index
```

## Troubleshooting recipe

### Upload timed out
- automated flow: mention `restart=1`
- back-office flow: mention Continue Upload / Discard Upload behavior
- remind them that unfinished uploads can block other uploads/downloads

### Duplicates appeared
- check whether `uniqueName=(none)` or an unstable matching key was used
- recommend a stronger key such as `SKU` for products when available

### Upload succeeded but storefront did not change
- remind them to publish/regenerate
- if they used deferred linking, remind them to complete the post-upload linking/publish sequence

### User asks for undocumented schema details
- say the docs are incomplete
- recommend exporting a real ShopSite sample as the authoritative template
