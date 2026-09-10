# Bay State Store Pages — Known List (Partial)

ProductOnPages assignments must match a real page `Name` exactly. This file is the offline validation list. It is **partial by construction** — anything not listed here must be verified in ShopSite (pages table) before use, never invented.

## Refresh procedure (full 211-page list)

Download the live pages table any sync and replace the category section below:

- `db_xml.cgi` with `dbname=pages` (see `shopsite-database` for parameters)
- Take each `<Page>` block's `<Name>` value verbatim (entity-decoded: `&amp;` → `&`)
- Keep system pages in the list — assignments to them fail validation unless the owner approves

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
