import { readdirSync, readFileSync } from 'fs';
import { initDb } from '../src/db/connection';
import { listActiveQuarantinedSkus } from '../src/db/repositories/sku-quarantine-repo';

interface WsProduct {
  sku: string;
  core?: { name?: string; media?: { primary?: string }; productOnPages?: string[] };
  customFields?: Record<string, string>;
  shopsite?: { preserved?: { advancedBlocks?: Record<string, string> } };
}

const db = initDb(process.env.BAYSTATE_CMS_DB_PATH ?? 'storage/catalog/.shopsite-cms/app.db');
const files = readdirSync('storage/catalog/products').filter(f => f.endsWith('.json'));

// Verified-baseline exclusions from repository queries (never a hard-coded
// done list): non-discarded change-set SKUs, open blocking drift, and
// quarantined duplicate/variant SKUs.
const done = new Set<string>();
const inChangeSets = db.query(
  `SELECT DISTINCT i.sku AS s FROM change_set_items i JOIN change_sets c ON c.id = i.change_set_id WHERE c.status != 'discarded'`,
).all() as Array<{ s: string }>;
for (const r of inChangeSets) done.add(r.s);
const blockingDrift = db.query(
  `SELECT DISTINCT sku AS s FROM remote_drift WHERE status IN ('open', 'in_reconcile')`,
).all() as Array<{ s: string }>;
for (const r of blockingDrift) done.add(r.s);
let workspaceId = '';
try {
  const ws = db.query('SELECT id FROM workspace LIMIT 1').get() as { id: string } | undefined;
  if (ws) workspaceId = ws.id;
} catch { /* no workspace table */ }
if (workspaceId) {
  for (const row of listActiveQuarantinedSkus(workspaceId)) done.add(row.sku);
}
console.log('excluded:', done.size);

interface Pat { re: RegExp; n: number; not?: RegExp }
const pats: Pat[] = [
  { re: /dry dog food|dog kibble|freeze-dried dog|freeze dried dog/i, n: 4 },
  { re: /wet dog food|canned dog food/i, n: 2 },
  { re: /dry cat food|freeze-dried cat|freeze dried cat/i, n: 3 },
  { re: /wet cat food|cat food.*(pate|wet|can|pouch)/i, n: 2 },
  { re: /dog treat|dog biscuit|puppy treat|jerky/i, n: 2, not: /toy/i },
  { re: /dog toy|squeak|rope toy/i, n: 1 },
  { re: /cat toy|catnip/i, n: 1 },
  { re: /bird food|bird seed|wild bird|suet|wild-bird feeder/i, n: 1 },
  { re: /grass seed|lawn fertilizer|potting soil|garden soil|plant food|mulch/i, n: 1 },
  { re: /fish food|aquarium/i, n: 1 },
];
// P1 #10: PF19 (Breed Size) and PF27 (Size) are retired as classification
// targets — never treated as missing slots. Freeze-dried/milk-replacer
// exclusion lifted after the v10 pin (new raw types exist).
const slots = [
  'ProductField17', 'ProductField18', 'ProductField22', 'ProductField23',
  'ProductField26', 'ProductField28', 'ProductField29', 'ProductField30',
];
let picked = 0;
for (const f of files) {
  const p = JSON.parse(readFileSync('storage/catalog/products/' + f, 'utf-8')) as WsProduct;
  if (done.has(p.sku)) continue;
  const name = p.core?.name ?? '';
  if (!name) continue;
  // Variant-bearing parents stay quarantined until the isolated fixture proves
  // ShopSite identity behavior; nested entries never count as candidates.
  const blocks = p.shopsite?.preserved?.advancedBlocks ?? {};
  if (blocks['Subproducts'] ?? blocks['subproducts']) continue;
  const cf = p.customFields ?? {};
  const media = p.core?.media?.primary;
  if (!media || media === 'none' || (p.core?.productOnPages ?? []).length === 0) continue;
  const miss = slots.filter(s => !(cf[s] ?? '').trim());
  if (miss.length === 0) continue;
  for (const pat of pats) {
    if (pat.n <= 0) continue;
    if (pat.re.test(name) && !(pat.not && pat.not.test(name))) {
      picked++;
      console.log(
        `${p.sku} | ${name.slice(0, 58)} | miss:${miss.map(s => s.replace('ProductField', 'PF')).join(',')} | pf1:${(cf.ProductField1 ?? '').slice(0, 22)}`,
      );
      done.add(p.sku);
      pat.n--;
      break;
    }
  }
  if (picked >= 14) break;
}
console.log('picked:', picked);
for (const pat of pats) {
  if (pat.n > 0) console.log('SHORT:', pat.re, pat.n);
}
if (picked < 14) console.log('NOTE: fewer than 14 met the gate; do not pad with unsafe SKUs or claim 100.');
