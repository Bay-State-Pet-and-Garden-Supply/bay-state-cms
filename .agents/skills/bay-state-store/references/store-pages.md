# Bay State Store Pages — Bootstrap List (Partial)

ProductOnPages assignments must match a real page `Name` exactly. The live authority is `GET /pages/verified-options`: rows in `page_index` under the ACTIVE page import with verified identity and `available` status (`listVerifiedPageOptions`, `src/db/repositories/page-repo.ts`). This file is only the offline bootstrap for when no import is active. It is **partial by construction** — anything not listed here must be verified against verified-options before use, never invented.

## Refresh procedure (full 211-page list)

Populate the real authority, then regenerate the category section from it:

1. POST `/pages/import/download` with `dbname=pages`, review the preview, POST `/pages/import/activate`
2. Read back `GET /pages/verified-options` (names where the import is active, verified, and available)
3. Replace the category section below with those names verbatim (entity-decoded: `&amp;` → `&`)
4. Keep system pages in the list — assignments to them fail validation unless the owner approves

Note: local DBs currently hold no page import (`page_index` empty), so verified-options is empty until the first activation — that is why this bootstrap exists.

## Category pages observed on live products (15)

Harvested from real product exports (`storage/catalog/exports/*/shopsite-products.xml`) — strongest evidence these exist, since live products are assigned to them:

- Brand - Instinct
- Cat Food Wet
- Cat Treats
- Dog Healthcare
- Dog Treats Bakery
- Dog Treats Biscuits Cookies & Crunchy Treats
- Dog Treats Bones Bully Sticks & Natural Chews
- Dog Treats Soft & Chewy
- Farm Animal Chicken & Poultry
- Horse Treats
- Jerky Dog Treats
- Pest Control
- Pest Control & Animal Repellents
- Season Products Summer
- Small Pet Bedding & Litter

## Pages in the redacted fixture (12)

From `src/tests/fixtures/shopsite-pages-bay-state-redacted.xml` — shape reference, not the full list. Category pages here overlap the section above (Jerky Dog Treats) and add: Wood Pellets, Plants, Brand - Science Diet, Special Offers. Remainder are system/utility pages (homepage, Contact Us, About, Terms & Conditions, Privacy/Security, Order Status, Facebook Store) — valid pages, but not product-category targets.

## Names seen only in tests (do NOT validate against these)

`Dog Food`, `Dog Treats Shop All`, `New Arrivals`, `Legacy Page`, `Page One`, `Page Two` appear in unit tests as synthetic data. They prove the format, not existence. A draft assigning one of these must still verify it in ShopSite.
