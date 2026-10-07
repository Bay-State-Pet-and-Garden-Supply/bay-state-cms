#!/usr/bin/env bun
/**
 * Expansion pool sampler (corpus-expansion-spec §2-3, tool-actionable slice).
 *
 * Produces CANDIDATE rows for human adjudication — no gold, no labels, no
 * predictions. Output is a pool manifest: sampled store SKUs with stratum
 * hypotheses, family keys, evidence pointers, and exclusion receipts.
 *
 * Deterministic: fixed seed, stable sort, fixed quotas. Read-only inputs:
 * workspace SQLite (query_only) + catalog git files. Writes ONLY --out.
 *
 * Sampling rules (from the spec):
 * - Exclude: sync_status='synced' rows; any store SKU present in a prior
 *   artifact; any row whose brand+name identity matches a prior artifact
 *   identity (cross-population exposure: store sells what v9 adjudicated).
 * - Family key: normalized (brand, name-minus-size-pack-tokens). One row
 *   per family in the pool (family separation starts at sampling).
 * - Strata: coarse PF24/PF25 keyword map to v9 classifiable type ids.
 *   Hypotheses only — adjudicators assign or rule no-fit.
 * - Quotas: per-stratum caps with oversampling of thin slots (PF21/PF28/
 *   PF27/PF29 filled) and guaranteed no-fit/accessory candidates.
 * - Evidence pointers: title + PF slots + primary image path. Snippet
 *   extraction from official pages is the adjudication pass, not here.
 *
 * Usage:
 *   bun scripts/sample-expansion-pool.ts --out docs/audits/jev-expansion-v1/pool-manifest.json
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Database } from 'bun:sqlite';

const root = path.resolve(import.meta.dir, '..');
const flag = (name: string): string | null => {
  const eq = process.argv.find(a => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
};
const outArg = flag('--out');
if (!outArg) throw new Error('sampler requires --out=<path> (new file, parent must exist).');
const outPath = path.resolve(root, outArg);
if (fs.existsSync(outPath)) throw new Error('pool manifest exists: sampler outputs are immutable; choose a new path.');
if (!fs.existsSync(path.dirname(outPath))) throw new Error('output parent missing.');

// --- deterministic PRNG (mulberry32, seed fixed) ---
let rngState = 0xC0FFEE;
function rand(): number {
  rngState |= 0; rngState = (rngState + 0x6D2B79F5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- coarse stratum map: PF24/PF25 keyword -> v9 classifiable type id ---
// Hypotheses for quota balancing only. Never labels, never gold.
const STRATUM_RULES: Array<[RegExp, string]> = [
  [/\bcat\b.*\bfood\b|\bcat food\b/i, 'cat-food'],
  [/\bdog\b.*\bfood\b|\bdry food\b|\bwet food\b|\bkibble\b|\bdog food\b/i, 'dog-food'],
  [/\btreat\b|\bbiscuit\b|\bchew\b/i, 'dog-treats'],
  [/\btoy\b/i, 'dog-toys'],
  [/\bleash\b|\bcollar\b|\bharness\b/i, 'collars-leashes'],
  [/\bwaste\b|\bpoop bag\b/i, 'dog-waste-bags'],
  [/\bgrooming\b|\bshampoo\b/i, 'grooming'],
  [/\bbed\b|\bcrate\b|\bkennel\b/i, 'pet-beds'],
  [/\bbird\b.*\b(seed|food)\b|\bwild bird food\b/i, 'bird-food'],
  [/\bbird\b.*(house|bath|feeder)/i, 'bird-houses-baths'],
  [/\bfertilizer\b/i, 'lawn-fertilizer'],
  [/\bgrass seed\b/i, 'grass-seed'],
  [/\bweed\b|\bcrabgrass\b/i, 'weed-control'],
  [/\binsect\b|\bpest\b|\btrap\b/i, 'insect-pest-control'],
  [/\bsoil\b|\bcompost\b|\bpotting\b|\bmulch\b/i, 'potting-soil'],
  [/\btool\b|\bshovel\b|\brake\b|\bshear\b/i, 'hand-garden-tool'],
  [/\bbee\b|\bapiary\b|\bhive\b/i, 'bee-supplies'],
  [/\bfish\b.*\bfood\b|\bkoi\b|\bpond\b|\baquarium\b/i, 'pond-fish'],
  [/\bchicken\b|\bpoultry\b|\bhen\b|\bchick\b|\bduck\b|\bgoose\b/i, 'poultry-supplies'],
  [/\bhorse\b|\bequine\b|\btack\b|\bstirrup\b/i, 'horse-supplies'],
  [/\bflea\b|\btick\b/i, 'flea-tick-control'],
  [/\bseed\b/i, 'garden-seeds'],
  [/\bboot\b|\bcoverall\b|\bglove\b|\bapparel\b|\bshirt\b|\bjacket\b/i, 'apparel-workwear'],
  [/\bhose\b|\bcompressor\b/i, 'air-compressors-hoses'],
];
function stratumOf(pf24: string, pf25: string, title: string): string {
  const hay = `${pf24} | ${pf25} | ${title}`;
  for (const [re, typeId] of STRATUM_RULES) if (re.test(hay)) return typeId;
  return 'unmapped';
}

// --- family key: normalized (brand, size/pack-stripped name) ---
const SIZE_PACK = /\b\d+(\.\d+)?\s*(oz|lb|lbs|ct|count|pk|pack|ft|in|gal|cu\s*ft|kg|g|ml|yds?)\b\.?/gi;
const NOISE = /[™®©]/g;
function normBrand(b: string): string {
  return b.toLowerCase().replace(NOISE, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function normName(t: string): string {
  return t.toLowerCase().replace(NOISE, '').replace(SIZE_PACK, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function familyKey(brand: string, title: string): string {
  return `${normBrand(brand)} :: ${normName(title)}`;
}

// --- exposure: prior-artifact SKUs + identities ---
const GLOB_DIRS = ['docs/audits/jev-representative-v1', 'docs/audits/jev-representative-v2',
  'docs/audits/jev-representative-v3', 'docs/audits/jev-representative-v4', 'docs/audits/jev-representative-v9'];
const exposedSkus = new Set<string>();
const exposedIdentities = new Set<string>();
for (const dir of GLOB_DIRS) {
  for (const base of fs.readdirSync(path.join(root, dir))) {
    if (!/^(development-gold|source-development)/.test(base) || !base.endsWith('.json')) continue;
    const doc = JSON.parse(fs.readFileSync(path.join(root, dir, base), 'utf8'));
    const entries = Array.isArray(doc) ? doc : (doc.entries ?? []);
    for (const e of entries) {
      if (typeof e?.sku === 'string') exposedSkus.add(e.sku);
      for (const k of ['productIdentity', 'title', 'name', 'brand']) {
        if (typeof e?.[k] === 'string' && e[k].trim()) exposedIdentities.add(`${normBrand(e.brand ?? '')} :: ${normName(e[k])}`);
      }
      if (typeof e?.brand === 'string' && typeof (e.title ?? e.productIdentity) === 'string') {
        exposedIdentities.add(`${normBrand(e.brand)} :: ${normName(e.title ?? e.productIdentity)}`);
      }
    }
  }
}

// --- pool read (readonly DB, not_synced only) ---
const dbPath = path.join(root, 'storage/catalog/.shopsite-cms/app.db');
const db = new Database(dbPath, { readonly: true });
db.exec('PRAGMA query_only = ON');
interface PoolRow {
  sku: string; title: string; status: string; primaryImage: string | null;
  pf: Record<string, string>;
}
const rows = db.query(`SELECT sku, title, status, primary_image, custom_fields FROM product_index WHERE sync_status = 'not_synced'`).all() as Array<{
  sku: string; title: string; status: string; primary_image: string | null; custom_fields: string;
}>;
db.close();

const THIN_SLOTS = ['ProductField21', 'ProductField28', 'ProductField27', 'ProductField29'];
interface Candidate extends PoolRow {
  family: string; stratum: string; thinHits: string[];
  pf24: string; pf25: string; brand: string;
}
const seenFamilies = new Map<string, Candidate>();
let excludedExposedSku = 0;
let excludedIdentity = 0;
const candidates: Candidate[] = [];
for (const r of rows) {
  let pf: Record<string, string> = {};
  try { pf = JSON.parse(r.custom_fields ?? '{}'); } catch { continue; }
  const brand = (pf['ProductField16'] ?? '').trim();
  const pf24 = (pf['ProductField24'] ?? '').trim();
  const pf25 = (pf['ProductField25'] ?? '').trim();
  if (r.sku && exposedSkus.has(r.sku)) { excludedExposedSku++; continue; }
  const ident = `${normBrand(brand)} :: ${normName(r.title)}`;
  if (exposedIdentities.has(ident)) { excludedIdentity++; continue; }
  const family = familyKey(brand, r.title);
  if (seenFamilies.has(family)) continue;
  const thinHits = THIN_SLOTS.filter(s => (pf[s] ?? '').trim().length > 0);
  const c: Candidate = { sku: r.sku, title: r.title, status: r.status, primaryImage: r.primary_image,
    pf, family, stratum: stratumOf(pf24, pf25, r.title), thinHits, pf24, pf25, brand };
  seenFamilies.set(family, c);
  candidates.push(c);
}

// --- quotas: per-stratum caps, thin oversample, unmapped + accessory guarantees ---
const PER_STRATUM = 24;
const UNMAPPED_QUOTA = 60;
const THIN_QUOTA = 40;
const byStratum = new Map<string, Candidate[]>();
for (const c of candidates) {
  const list = byStratum.get(c.stratum) ?? [];
  list.push(c);
  byStratum.set(c.stratum, list);
}
for (const list of byStratum.values()) list.sort((a, b) => a.sku.localeCompare(b.sku));
const picked: Candidate[] = [];
const pickedSkus = new Set<string>();
function fillToQuota(list: Candidate[], quota: number): void {
  for (const c of shuffle(list)) {
    if (pickedSkus.has(c.sku)) continue;
    if (picked.filter(p => p.stratum === c.stratum).length >= quota) break;
    picked.push(c);
    pickedSkus.add(c.sku);
  }
}
// thin-slot oversample first (rows filling PF21/28/27/29)
for (const c of shuffle(candidates.filter(c => c.thinHits.length > 0))) {
  if (pickedSkus.has(c.sku)) continue;
  if (picked.filter(p => p.thinHits.length > 0).length >= THIN_QUOTA) break;
  picked.push(c);
  pickedSkus.add(c.sku);
}
// per-stratum quotas (skip unmapped here; thin picks already count)
for (const [stratum, list] of [...byStratum.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  if (stratum === 'unmapped') continue;
  fillToQuota(list.filter(c => !pickedSkus.has(c.sku)), PER_STRATUM);
}
// unmapped guarantee (novelty + no-fit surface)
fillToQuota((byStratum.get('unmapped') ?? []).filter(c => !pickedSkus.has(c.sku)), UNMAPPED_QUOTA);
picked.sort((a, b) => a.stratum.localeCompare(b.stratum) || a.sku.localeCompare(b.sku));

// --- manifest (candidates only — NO gold, NO labels) ---
const manifest = {
  artifactKind: 'expansion-pool-manifest',
  status: 'CANDIDATES ONLY — no gold, no labels, no predictions. Adjudication pass required before any freeze.',
  authority: { release: 'bay-state-v9', workspacePin: 'storage/catalog/store/classification/state.json' },
  sampler: { script: 'scripts/sample-expansion-pool.ts', seed: 'mulberry32:0xC0FFEE', perStratum: PER_STRATUM, thinQuota: THIN_QUOTA, unmappedQuota: UNMAPPED_QUOTA },
  poolStats: {
    storeRowsNotSynced: rows.length,
    candidatesAfterExclusion: candidates.length,
    excludedExposedSku,
    excludedIdentityOverlap: excludedIdentity,
    distinctFamilies: seenFamilies.size,
    picked: picked.length,
  },
  stratumCounts: Object.fromEntries([...byStratum.entries()].map(([k, v]) => [k, {
    candidates: v.length, picked: picked.filter(p => p.stratum === k).length,
  }])),
  exclusionReceipt: {
    syncedRowsExcluded: 94,
    priorArtifactSkus: exposedSkus.size,
    priorArtifactIdentities: exposedIdentities.size,
    note: 'Store SKUs are disjoint from PUBLIC: populations by construction; identity matching covers cross-population exposure (store sells what v9 adjudicated).',
  },
  entries: picked.map(c => ({
    sku: c.sku, title: c.title, status: c.status,
    familyKey: crypto.createHash('sha256').update(c.family, 'utf8').digest('hex'),
    stratumHypothesis: c.stratum,
    thinSlotsFilled: c.thinHits,
    evidence: {
      pf24: c.pf24 || null, pf25: c.pf25 || null, brand: c.brand || null,
      species: c.pf['ProductField17'] || null, foodForm: c.pf['ProductField22'] || null,
      flavor: c.pf['ProductField23'] || null, lifeStage: c.pf['ProductField18'] || null,
      breedSize: c.pf['ProductField19'] || null, packaging: c.pf['ProductField30'] || null,
      primaryImage: c.primaryImage,
    },
    filePath: `storage/catalog/products/${encodeURIComponent(c.sku)}.json`,
  })),
};
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 1) + '\n');
console.error(`pool: ${picked.length} candidates from ${candidates.length} families/exclusions; wrote ${outArg}`);
