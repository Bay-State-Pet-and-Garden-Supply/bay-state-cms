---
name: shopsite-product-fields
description: 'Documentation-grounded advisor for ShopSite product field modeling, XML tag mapping, codec integration, and field-type behavior. Use this skill whenever the user mentions ShopSite product fields, product XML tags, the codec, ProductField entries, field types, adding a new product field to the schema, field defaults, field catalogs, or parsing/emitting specific product XML elements. Triggers on: "product field", "ShopSite product", "product XML tag", "codec", "ProductField", "field default", "field type", "add a ShopSite field", "product schema", "KNOWN_FIELD_LABELS", "product-codec", "field-catalog". Also triggers when the user asks about specific product field names like "MinimumQuantity", "ProductType", "QuantityOnHand", "GoogleGTIN", "MoreInfoImage", "ProductDescription", "ProductOnPages", or "SearchKeywords".'
---

# ShopSite Product Fields

Use this skill to answer questions about **ShopSite product field names, types, XML tags, codebase handling, and the field-addition workflow**. It bridges the documented ShopSite product field catalog with the project's codec implementation (`ShopSiteProductCodec` in `src/shopsite/product-codec.ts`, field authority in `src/shopsite/field-catalog.ts`).

## What this skill is for

This is a **field-modeling reference and workflow guide**. It should:
- answer what documented product fields exist, their types, defaults, and allowed values
- map documented field names to likely XML tags and the codebase `Product` model paths
- explain the current handling status of each field (decoded, mapped, emitted, pass-through only, or not handled)
- guide agents through the field-addition workflow when adding support for new ShopSite fields
- explain ShopSite field types and how they serialize to/from XML

This is **not** a CGI workflow skill. For `db_xml.cgi` parameters, `dbupload.cgi` flows, `generate.cgi` publishing, MIME uploads, or database download options, use `shopsite-database`.

## Read these resources first

For any substantive request, read:
- `references/product-field-catalog.md` — complete list of 100+ documented product fields
- `references/field-type-system.md` — the 11 ShopSite field types and XML serialization
- `references/product-xml-mapping.md` — bridges field names to XML tags, codebase paths, handling status, and source lines
- `references/codebase-integration.md` — concrete field-addition workflow with file paths and hard constraints

## Core operating rules

1. **Default to evidence.**
   Treat the v15 upload.fields.html documentation as authoritative for field **names**, **types**, **defaults**, and **allowed values**. Tag the evidence source clearly.

2. **Distinguish confirmed from inferred XML tags.**
   - **Confirmed**: tags verified against `product-codec.ts` (`CORE_FIELDS` / decode), `field-catalog.ts`, or a real `db_xml.cgi` export.
   - **Inferred**: tags derived from field names using ShopSite naming conventions (e.g., `ProductDescription` from "Product Description"). Inferred tags are highly likely but not guaranteed.
   - When an agent needs a tag for a field not yet handled in the codebase, recommend confirming against a real export.

3. **Do not overclaim codebase support.**
   Many fields are **pass-through only** (preserved in `unknownElements` or `advancedBlocks` and cannot be individually edited through the `Product` model). Always check the handling status before claiming a field can be modified.

4. **Route CGI/workflow questions to shopsite-database.**
   If the user asks about `db_xml.cgi`, `dbupload.cgi`, `generate.cgi`, MIME uploads, fieldmaps, batch uploads, or database download options, direct them to the `shopsite-database` skill.

5. **Route page-field questions to shopsite-page-fields.**
   If the user asks about page fields, page XML, page templates, or the page database, direct them to the `shopsite-page-fields` skill.

## Response structure

For substantial answers, use this shape:

1. **Direct answer** — the field name, XML tag, type, default, and allowed values
2. **Codebase status** — decode/encode status with exact file and line references
3. **Integration steps** — what to change in each layer (schema → codec → tests) when adding support
4. **Caveats** — pass-through fields, inferred tags, preservation constraints, confirmed-vs-inferred distinctions

## Final reminders

- Prefer the `product-xml-mapping.md` table for quick field lookups.
- When a field is pass-through only, explain what that means practically (can't edit through CMS; preserved as-is on round-trip).
- When the user wants to add support for a new field, use `codebase-integration.md` for the workflow and `product-field-catalog.md` for the field's documented properties.
- Always call out the three DTD-governed emit behaviors: `MinimumQuantity` (precedence `customFields` → preserved → default `0`), `ProductType` (precedence `customFields` → preserved → default `Tangible`), `MoreInformationText` (precedence `customFields` → preserved → description, plus auto-emitted `DisplayMoreInformationPage`). See `product-xml-mapping.md` Known divergences.
