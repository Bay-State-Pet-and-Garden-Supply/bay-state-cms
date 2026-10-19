/**
 * P0 #1 shared backfill preflight gate (backfill remediation plan, Milestone 1).
 *
 * A safe classification-only edit can otherwise overwrite a changed live name
 * or stock marker, because the upload path serializes whole approved drafts.
 * This module is the single shared gate invoked by `gate-batch.ts`,
 * `xcheck-export.ts`, and backfill-mode `sync-routes.ts` immediately before
 * upload: it compares a fresh full live XML snapshot, the approved baseline
 * (`baseJson` encoded by `ShopSiteProductCodec`), and the outgoing upload XML.
 *
 * Rules:
 * - Whole-record census via XML parser/validator (never regex field
 *   extraction): exactly one live and one outgoing top-level record per
 *   intended SKU. Duplicates, missing records, silent drops, and unexpected
 *   extras all fail closed.
 * - XML entities are compared semantically (`Foo&apos;s` parses to `Foo's`);
 *   name equality is exact, punctuation included.
 * - Every serializable live field must equal the encoded baseline; any live
 *   drift (name, stock marker, custom field, built-in, page, nested block)
 *   blocks the SKU until the baseline is refreshed and the draft re-reviewed.
 * - Every outgoing-vs-baseline delta must be an accepted decision of the
 *   item's bound `classificationRunId` (field values serialized through the
 *   cached attribute mapping, page additions by display name), the
 *   append-only PF2 classified marker, or an approved additive page. All
 *   other deltas — including codec defaults and GTIN fills — block here.
 *   Default/GTIN fill exceptions arrive with P0 #2, not here.
 * - The bound run must belong to the workspace and SKU, be a catalog run,
 *   and be completed. Unbound, foreign, running, or stale items fail.
 *
 * Issues never carry field values or merchant record identities — only the
 * SKU, the field tag, and a value-free reason.
 */

import { createRequire } from 'node:module';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { sanitizeXml } from './xml-sanitizer';
import { ShopSiteProductCodec } from './product-codec';
import {
  getEffectiveProposalTargetId,
  getEffectiveProposalValue,
} from '../classification/effective-proposal';
import { serializeAttributeValue } from '../classification/assignment-projection';
import { pageNameFromPageValue } from '../shared/proposal-display';
import type { Product } from '../shared/types';
import type { ChangeSetItemRow } from '../db/repositories/change-set-repo';
import type {
  AttributeMappingConfig,
  ClassificationProposal,
} from '../shared/schemas/classification';
import type { ClassificationRunRow } from '../db/repositories/classification-run-repo';

export interface BackfillPreflightIssue {
  sku: string;
  field: string;
  reason: string;
}
export interface BackfillPreflightResult {
  ok: boolean;
  issues: BackfillPreflightIssue[];
}

/**
 * P0 #5 masked merchant-identity fingerprint. Exposes two distinct twin
 * identities to the authenticated operator without leaking full identifiers:
 * short salted hashes of ProductID/ProductGUID/Name, never the raw values.
 */
export function fingerprintTwinIdentity(record: BackfillCensusRecord): string {
  const raw = [record.leaves['ProductID'] ?? '', record.leaves['ProductGUID'] ?? '', record.leaves['Name'] ?? ''].join('|');
  let hash = 0;
  for (let index = 0; index < raw.length; index += 1) {
    hash = ((hash << 5) - hash + raw.charCodeAt(index)) | 0;
  }
  return `twin-${Math.abs(hash).toString(36).slice(0, 6)}`;
}
export interface BackfillPreflightOptions {
  workspaceId: string;
  items: ChangeSetItemRow[];
  liveXml: string;
  outgoingXml: string;
}

/** Repository seam. The default implementation loads the real repositories
 * lazily so this module stays import-safe where no database exists; tests use
 * `preflightBackfillWithResolvers` with in-memory fakes. */
export interface BackfillPreflightResolvers {
  getRun(id: string): ClassificationRunRow | null;
  getAcceptedProposals(productSku: string, runId: string): ClassificationProposal[];
  getCachedAttributeMappings(workspaceId: string): AttributeMappingConfig[];
}

// ─── Census (parser-derived, never regex field extraction) ───────────────────

export interface BackfillCensusRecord {
  /** Exact SKU text after entity resolution; '' when the record has none. */
  sku: string;
  /** Canonical leaf tag -> value ('' for empty). Excludes pages/images. */
  leaves: Record<string, string>;
  /** Compacted MoreInfoImage values in slot order (`none`/empty dropped). */
  images: string[];
  /** Sorted unique page names with entities resolved. */
  pages: string[];
  /** Nested block tag -> whitespace-insensitive normalized JSON. */
  blocks: Record<string, string>;
  /** Distinct nested subproduct SKUs under this top-level record. */
  childSkus: string[];
}

export interface BackfillCensus {
  ok: boolean;
  records: BackfillCensusRecord[];
  countsBySku: Record<string, number>;
  blankSkuCount: number;
  error: string | null;
}

const censusParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: false,
  trimValues: true,
  parseTagValue: false,
  isArray: () => false,
});

/** Leaf-tag aliases the codec treats as one field (mirrors decode). */
const LEAF_ALIAS_BY_LOWER: Record<string, string> = {
  sku: 'SKU',
  name: 'Name',
  price: 'Price',
  saleamount: 'SaleAmount',
  productdisabled: 'ProductDisabled',
  quantityonhand: 'QuantityOnHand',
  quantity: 'QuantityOnHand',
  quantity_on_hand: 'QuantityOnHand',
  googlegtin: 'GoogleGTIN',
  google_gtin: 'GoogleGTIN',
};

function canonicalLeafKey(key: string): string {
  return LEAF_ALIAS_BY_LOWER[key.toLowerCase()] ?? key;
}

function isScalarNode(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !key.startsWith('@_'))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function collectPageStrings(node: unknown, out: Set<string>): void {
  if (typeof node === 'string') {
    const trimmed = node.trim();
    if (trimmed) out.add(trimmed);
    return;
  }
  if (Array.isArray(node)) {
    for (const entry of node) collectPageStrings(entry, out);
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key.startsWith('@_')) continue;
      collectPageStrings(value, out);
    }
  }
}

function collectSubproductSkus(node: unknown, out: Set<string>): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const entry of node) collectSubproductSkus(entry, out);
    return;
  }
  const record = node as Record<string, unknown>;
  const keys = Object.keys(record);
  const looksLikeSubproduct = keys.some(key => key === 'SKU' || key === 'sku' || key === 'Name' || key === 'name');
  if (looksLikeSubproduct) {
    const raw = record['SKU'] ?? record['sku'];
    const sku = raw == null ? '' : String(raw).trim();
    if (sku) out.add(sku);
  }
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith('@_')) continue;
    collectSubproductSkus(value, out);
  }
}

function censusRecordFromNode(node: Record<string, unknown>): BackfillCensusRecord {
  const rawSku = node['SKU'] ?? node['sku'];
  const sku = rawSku == null ? '' : String(rawSku).trim();
  const leaves: Record<string, string> = {};
  const blocks: Record<string, string> = {};
  const imageSlots: Array<{ index: number; value: string }> = [];
  let pages: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_')) continue;
    if (key === 'ProductOnPages' || key === 'productOnPages') {
      const names = new Set<string>();
      collectPageStrings(value, names);
      pages = [...names].sort();
      continue;
    }
    const imageMatch = /^MoreInfoImage(\d+)$/i.exec(key);
    if (imageMatch) {
      if (isScalarNode(value)) {
        const text = (value === null ? '' : String(value)).trim();
        if (text !== '' && text.toLowerCase() !== 'none') {
          imageSlots.push({ index: Number(imageMatch[1]), value: text });
        }
      }
      continue;
    }
    if (value == null) {
      leaves[canonicalLeafKey(key)] = '';
      continue;
    }
    if (isScalarNode(value)) {
      leaves[canonicalLeafKey(key)] = value === null ? '' : String(value);
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        leaves[canonicalLeafKey(key)] = '';
      } else if (value.every(isScalarNode)) {
        const last = value[value.length - 1];
        leaves[canonicalLeafKey(key)] = last === null ? '' : String(last);
      } else {
        blocks[key] = stableJson(value);
      }
      continue;
    }
    blocks[key] = stableJson(value);
  }
  imageSlots.sort((a, b) => a.index - b.index);
  const childSkus = new Set<string>();
  const subproducts = node['Subproducts'] ?? node['subproducts'];
  if (subproducts !== undefined) collectSubproductSkus(subproducts, childSkus);
  childSkus.delete(sku);
  return { sku, leaves, images: imageSlots.map(slot => slot.value), pages, blocks, childSkus: [...childSkus].sort() };
}

/**
 * Parse a whole ShopSite product document into top-level census records.
 * Nested `<Subproduct>` nodes never appear here: they parse as a `Subproducts`
 * object on their parent, not as top-level records. Malformed XML fails
 * closed with `ok: false` (never an empty pass).
 */
export function parseBackfillCensusXml(xml: string): BackfillCensus {
  const failed = (error: string): BackfillCensus => ({
    ok: false,
    records: [],
    countsBySku: {},
    blankSkuCount: 0,
    error,
  });
  if (!xml || !xml.trim()) return failed('empty XML document');
  // Strip the prolog/DTD (no product data) and apply the same ampersand/entity
  // repair the codec uses, so a live export with a bare `&` reads identically.
  const stripped = sanitizeXml(xml)
    .replace(/<\?xml[^?]*\?>\s*/i, '')
    .replace(/<!DOCTYPE[^>]*>\s*/i, '');
  if (XMLValidator.validate(stripped) !== true) return failed('malformed XML document');
  let doc: unknown;
  try {
    doc = censusParser.parse(stripped);
  } catch {
    return failed('unparseable XML document');
  }
  if (!doc || typeof doc !== 'object') return failed('unparseable XML document');
  const root = ((doc as Record<string, unknown>)['ShopSiteProducts'] ?? doc) as Record<string, unknown>;
  if (!root || typeof root !== 'object') return failed('unparseable XML document');
  let container: unknown = root['Products'] ?? root['products'];
  if (container == null && ('Product' in root || 'product' in root)) container = root;
  let rawList: unknown[] = [];
  if (container !== null && typeof container === 'object' && !Array.isArray(container)) {
    const boxed = (container as Record<string, unknown>)['Product']
      ?? (container as Record<string, unknown>)['product'];
    if (Array.isArray(boxed)) rawList = boxed;
    else if (boxed !== null && typeof boxed === 'object') rawList = [boxed];
  }
  const records: BackfillCensusRecord[] = [];
  const countsBySku: Record<string, number> = {};
  let blankSkuCount = 0;
  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = censusRecordFromNode(entry as Record<string, unknown>);
    records.push(record);
    if (!record.sku) blankSkuCount += 1;
    else countsBySku[record.sku] = (countsBySku[record.sku] ?? 0) + 1;
  }
  return { ok: true, records, countsBySku, blankSkuCount, error: null };
}

// ─── Record diff ─────────────────────────────────────────────────────────────

export interface BackfillFieldDelta {
  /** Leaf tag, `MoreInfoImages`, `ProductOnPages`, or a nested block tag. */
  field: string;
}

/** Every serializable difference between two census records. Absent leaves
 * count as '' so an omitted tag and an explicitly empty tag compare equal. */
export function diffBackfillRecords(
  baseline: BackfillCensusRecord,
  current: BackfillCensusRecord,
): BackfillFieldDelta[] {
  const deltas: BackfillFieldDelta[] = [];
  const leafKeys = new Set([...Object.keys(baseline.leaves), ...Object.keys(current.leaves)]);
  for (const key of leafKeys) {
    if ((baseline.leaves[key] ?? '') !== (current.leaves[key] ?? '')) deltas.push({ field: key });
  }
  if (JSON.stringify(baseline.images) !== JSON.stringify(current.images)) {
    deltas.push({ field: 'MoreInfoImages' });
  }
  if (backfillPageDelta(baseline.pages, current.pages).changed) {
    deltas.push({ field: 'ProductOnPages' });
  }
  const blockKeys = new Set([...Object.keys(baseline.blocks), ...Object.keys(current.blocks)]);
  for (const key of blockKeys) {
    if ((baseline.blocks[key] ?? '') !== (current.blocks[key] ?? '')) deltas.push({ field: key });
  }
  return deltas;
}

export function backfillPageDelta(
  baselinePages: string[],
  currentPages: string[],
): { added: string[]; removed: string[]; changed: boolean } {
  const baseline = new Set(baselinePages);
  const current = new Set(currentPages);
  const added = [...current].filter(page => !baseline.has(page)).sort();
  const removed = [...baseline].filter(page => !current.has(page)).sort();
  return { added, removed, changed: added.length > 0 || removed.length > 0 };
}

function splitPipeList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split('|')
    .map(part => part.trim())
    .filter(part => part !== '');
}

/**
 * Append-only PF2 classified-marker allowance (e.g. `classified101126`).
 * The outgoing PF2 set must be the baseline set plus exactly one
 * `classified<digits>` token; replacements, removals, and any other addition
 * are rejected. An unchanged marker needs no allowance (no delta).
 */
export function isAllowedPf2Append(
  baselineValue: string | undefined,
  outgoingValue: string | undefined,
): boolean {
  const baseline = new Set(splitPipeList(baselineValue));
  const outgoing = new Set(splitPipeList(outgoingValue));
  for (const part of baseline) {
    if (!outgoing.has(part)) return false;
  }
  const added = [...outgoing].filter(part => !baseline.has(part));
  return added.length === 1 && /^classified\d+$/.test(added[0]);
}
export interface ExpectedBackfillDeltas {
  fields: Map<string, string>;
  pages: Set<string>;
}

export function buildExpectedBackfillDeltas(
  proposals: ClassificationProposal[],
  mappings: AttributeMappingConfig[],
): { expected: ExpectedBackfillDeltas; fieldErrors: Array<{ field: string; reason: string }> } {
  const fields = new Map<string, string>();
  const pages = new Set<string>();
  const fieldErrors: Array<{ field: string; reason: string }> = [];
  for (const proposal of proposals) {
    if (proposal.proposalType === 'field_assignment') {
      const targetId = getEffectiveProposalTargetId(proposal);
      if (!targetId) continue;
      const mapping = mappings.find(entry => entry.attributeId === targetId);
      if (!mapping || mapping.isStale || !mapping.catalogField) continue;
      let serialized: string;
      try {
        serialized = serializeAttributeValue(getEffectiveProposalValue(proposal), mapping.serialization);
      } catch {
        fieldErrors.push({
          field: mapping.catalogField,
          reason: 'accepted value cannot be serialized for upload; revise the decision',
        });
        continue;
      }
      const prior = fields.get(mapping.catalogField);
      if (prior !== undefined && prior !== serialized) {
        fieldErrors.push({
          field: mapping.catalogField,
          reason: 'conflicting accepted values target the same upload field; revise the decisions',
        });
        continue;
      }
      fields.set(mapping.catalogField, serialized);
    } else if (proposal.proposalType === 'category_page') {
      const pageName = pageNameFromPageValue(getEffectiveProposalValue(proposal));
      if (!pageName) continue;
      pages.add(pageName);
    }
  }
  return { expected: { fields, pages }, fieldErrors };
}

const GTIN_FILL_RE = /^\d{8,14}$/;
const PROTECTED_BUILT_IN_FIELDS = new Set([
  'ProductDisabled',
  'MinimumQuantity',
  'ProductType',
  'Graphic',
  'ProductDescription',
]);

/**
 * P0 #2 explicit backfill field policy. Every nonempty outgoing value that
 * differs from a nonempty live value needs its own reviewed decision; when
 * live GTIN is empty, SKU-as-GTIN is an allowed *fill* only when the catalog
 * GTIN is blank and the numeric SKU is 8-14 digits. Built-ins never change by
 * default: ProductDisabled, MinimumQuantity, ProductType, Graphic, and
 * ProductDescription must remain exactly equal unless a reviewed decision
 * explicitly carries the new value.
 */
export function backfillBuiltInAllowance(options: {
  field: string;
  liveValue: string;
  outgoingValue: string;
  baselineValue: string;
  sku: string;
}): { allowed: boolean; reason: string } {
  const live = options.liveValue.trim();
  const outgoing = options.outgoingValue.trim();
  if (live !== '' && outgoing !== '' && live !== outgoing) {
    return { allowed: false, reason: 'live value differs from the approved upload without its own reviewed decision' };
  }
  if (options.field === 'GTIN' && live === '' && outgoing !== '') {
    const catalogGtin = options.baselineValue.trim();
    if (catalogGtin === '' && GTIN_FILL_RE.test(options.sku) && outgoing === options.sku) {
      return { allowed: true, reason: 'blank-live SKU-as-GTIN fill: catalog GTIN blank and numeric SKU is 8-14 digits' };
    }
    return { allowed: false, reason: 'GTIN fill requires a blank catalog GTIN and an 8-14 digit numeric SKU equal to the outgoing GTIN' };
  }
  if (PROTECTED_BUILT_IN_FIELDS.has(options.field)) {
    return { allowed: false, reason: 'built-in field changed without its own reviewed decision' };
  }
  return { allowed: true, reason: 'matches live or blank-live field' };
}


// ─── Gate ────────────────────────────────────────────────────────────────────

const COMPLETED_RUN_STATUSES: Record<string, true> = {
  completed: true,
  completed_with_abstentions: true,
};

function parseProductJson(json: string | null): Product | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<Product>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.sku !== 'string') return null;
    if (!parsed.core || typeof parsed.core !== 'object') return null;
    if (!parsed.customFields || typeof parsed.customFields !== 'object') return null;
    return parsed as Product;
  } catch {
    return null;
  }
}

function emitCensusRecord(product: Product): BackfillCensusRecord {
  const xml = ShopSiteProductCodec.encode(product).xml;
  const census = parseBackfillCensusXml(xml);
  if (!census.ok || census.records.length !== 1 || census.records[0].sku !== product.sku) {
    throw new Error('baseline emission did not produce exactly one matching record');
  }
  return census.records[0];
}

export function preflightBackfillWithResolvers(
  options: BackfillPreflightOptions,
  resolvers: BackfillPreflightResolvers,
): BackfillPreflightResult {
  const issues: BackfillPreflightIssue[] = [];
  const push = (sku: string, field: string, reason: string): void => {
    issues.push({ sku, field, reason });
  };
  const { workspaceId, items, liveXml, outgoingXml } = options;

  if (!workspaceId || !items || items.length === 0) {
    push('', 'batch', 'batch has no intended SKUs; refusing an empty push');
    return { ok: false, issues };
  }

  const itemCountBySku = new Map<string, number>();
  for (const item of items) {
    itemCountBySku.set(item.sku, (itemCountBySku.get(item.sku) ?? 0) + 1);
  }
  for (const [sku, count] of itemCountBySku) {
    if (count > 1) push(sku, 'SKU', 'SKU is listed more than once in the batch; split or dedupe before push');
  }

  const live = parseBackfillCensusXml(liveXml);
  if (!live.ok) {
    for (const item of items) push(item.sku, 'live-xml', 'fresh live export is malformed or unreadable; abort push and refetch');
  }
  const outgoing = parseBackfillCensusXml(outgoingXml);
  if (!outgoing.ok) {
    for (const item of items) push(item.sku, 'outgoing-xml', 'outgoing upload XML is malformed or unreadable; regenerate the export');
  }
  if (!live.ok || !outgoing.ok) return { ok: false, issues };

  if (live.blankSkuCount > 0) {
    push('', 'SKU', 'fresh live export contains a record without a SKU; quarantine before push');
  }

  const liveBySku = new Map<string, BackfillCensusRecord>();
  for (const record of live.records) {
    if (record.sku && !liveBySku.has(record.sku)) liveBySku.set(record.sku, record);
  }
  const outgoingBySku = new Map<string, BackfillCensusRecord>();
  for (const record of outgoing.records) {
    if (record.sku && !outgoingBySku.has(record.sku)) outgoingBySku.set(record.sku, record);
  }

  for (const item of items) {
    const liveCount = live.countsBySku[item.sku] ?? 0;
    if (liveCount === 0) {
      push(item.sku, 'SKU', 'intended SKU is missing from the fresh live export; refresh the baseline and regenerate the draft');
    } else if (liveCount > 1) {
      const twins = live.records.filter(record => record.sku === item.sku).slice(0, 2);
      const fingerprints = twins.map(fingerprintTwinIdentity).join(',');
      push(item.sku, 'SKU', `intended SKU appears more than once in the fresh live export; quarantine the duplicate merchant records before push (${fingerprints})`);
    }
  }

  const intendedSkus = new Set(items.map(item => item.sku));
  for (const record of outgoing.records) {
    if (!record.sku) {
      push('', 'SKU', 'outgoing upload XML contains a record without a SKU; regenerate the export');
    } else if (!intendedSkus.has(record.sku)) {
      push(record.sku, 'SKU', 'upload XML contains a SKU outside the approved batch; remove it or approve it separately');
    }
  }
  for (const item of items) {
    const outgoingCount = outgoing.countsBySku[item.sku] ?? 0;
    if (outgoingCount === 0) {
      push(item.sku, 'SKU', 'intended SKU is missing from the upload XML; refusing a silent drop from the batch');
    } else if (outgoingCount > 1) {
      push(item.sku, 'SKU', 'intended SKU appears more than once in the upload XML; regenerate the export');
    }
  }

  for (const item of items) {
    checkBackfillItem(item, workspaceId, liveBySku, outgoingBySku, resolvers, push);
  }

  return { ok: issues.length === 0, issues };
}

function checkBackfillItem(
  item: ChangeSetItemRow,
  workspaceId: string,
  liveBySku: Map<string, BackfillCensusRecord>,
  outgoingBySku: Map<string, BackfillCensusRecord>,
  resolvers: BackfillPreflightResolvers,
  push: (sku: string, field: string, reason: string) => void,
): void {
  const sku = item.sku;

  if (item.operation !== 'update') {
    push(sku, 'operation', 'backfill push requires update drafts; refusing a non-update operation');
  }

  const base = parseProductJson(item.baseJson);
  if (!base) {
    push(sku, 'baseline', 'approved baseline is missing or unreadable; refresh the baseline and regenerate the draft');
    return;
  }
  const draft = parseProductJson(item.draftJson);
  if (!draft) {
    push(sku, 'draft', 'approved draft is missing or unreadable; regenerate the draft');
    return;
  }
  if (base.sku !== sku) {
    push(sku, 'SKU', 'approved baseline SKU does not match the batch SKU; refusing a stale baseline');
    return;
  }
  if (draft.sku !== sku) {
    push(sku, 'SKU', 'approved draft SKU does not match the batch SKU; refusing a stale draft');
    return;
  }

  const runId = item.classificationRunId;
  if (!runId) {
    push(sku, 'classificationRun', 'item is not bound to a catalog classification run; reclassify and re-approve');
    return;
  }
  let run: ClassificationRunRow | null;
  try {
    run = resolvers.getRun(runId);
  } catch {
    run = null;
  }
  if (
    !run ||
    run.workspaceId !== workspaceId ||
    run.productSku !== sku ||
    run.sourceKind !== 'catalog_product' ||
    !COMPLETED_RUN_STATUSES[run.status]
  ) {
    push(sku, 'classificationRun', 'bound classification run is missing, foreign, stale, or not a completed catalog run; reclassify and re-approve');
    return;
  }

  let accepted: ClassificationProposal[];
  let mappings: AttributeMappingConfig[];
  try {
    accepted = resolvers.getAcceptedProposals(sku, runId);
    mappings = resolvers.getCachedAttributeMappings(workspaceId);
  } catch {
    push(sku, 'classificationRun', 'accepted decisions for the bound run are unreadable; abort push');
    return;
  }
  const { expected, fieldErrors } = buildExpectedBackfillDeltas(accepted, mappings);
  for (const error of fieldErrors) push(sku, error.field, error.reason);

  let baselineRecord: BackfillCensusRecord;
  try {
    baselineRecord = emitCensusRecord(base);
  } catch {
    push(sku, 'baseline', 'approved baseline cannot be encoded for comparison; repair the draft');
    return;
  }
  let draftRecord: BackfillCensusRecord;
  try {
    draftRecord = emitCensusRecord(draft);
  } catch {
    push(sku, 'draft', 'approved draft cannot be encoded for comparison; repair the draft');
    return;
  }

  const liveRecord = liveBySku.get(sku);
  const outgoingRecord = outgoingBySku.get(sku);
  if (!liveRecord || !outgoingRecord) return; // Census issues already recorded.
  // P0 #3 variant quarantine: a parent carrying distinct nested child SKUs is
  // rejected from this wave on every side (live, baseline, outgoing). Nested
  // entries are never counted as new unique products; child gating arrives
  // with the later variant-safe import and its own per-child review.
  const variantSources: Array<{ record: BackfillCensusRecord; origin: string }> = [
    { record: liveRecord, origin: 'live' },
    { record: baselineRecord, origin: 'baseline' },
    { record: outgoingRecord, origin: 'upload' },
  ];
  let variantBlocked = false;
  for (const source of variantSources) {
    if (source.record.childSkus.length > 0) {
      push(sku, 'Subproducts', `${source.origin} record carries distinct nested variant SKUs; quarantine the parent from this wave`);
      variantBlocked = true;
    }
  }
  if (variantBlocked) return;
  // Live drift: every serializable live field must still equal the baseline.
  for (const delta of diffBackfillRecords(baselineRecord, liveRecord)) {
    if (delta.field === 'Name') {
      push(sku, 'Name', 'live Name differs from the approved baseline, punctuation included; refresh the baseline and re-review');
    } else {
      push(sku, delta.field, 'live value differs from the approved baseline; refresh the baseline and re-review');
    }
  }

  // Outgoing allowlist: accepted run deltas, PF2 marker, approved page adds.
  for (const delta of diffBackfillRecords(baselineRecord, outgoingRecord)) {
    if (delta.field === 'ProductOnPages') {
      const pageChange = backfillPageDelta(baselineRecord.pages, outgoingRecord.pages);
      if (pageChange.removed.length > 0) {
        push(sku, 'ProductOnPages', 'upload removes an approved page assignment; page removal needs its own reviewed change');
      }
      for (const added of pageChange.added) {
        if (!expected.pages.has(added)) {
          push(sku, 'ProductOnPages', 'upload adds a page without an accepted run decision; review it first');
        }
      }
      continue;
    }
    if (
      delta.field === 'ProductField2' &&
      isAllowedPf2Append(baselineRecord.leaves['ProductField2'], outgoingRecord.leaves['ProductField2'])
    ) {
      continue;
    }
    const allowed = expected.fields.get(delta.field);
    if (allowed !== undefined && (outgoingRecord.leaves[delta.field] ?? '').trim() === allowed.trim()) {
      continue;
    }
    // P0 #2 explicit field policy: compare ALL encoder-emitted fields, not
    // only custom ProductField deltas. The one visible allowance is a
    // blank-live SKU-as-GTIN fill; a different live GTIN, a built-in change,
    // or any other unreviewed delta blocks the SKU.
    const allowance = backfillBuiltInAllowance({
      field: delta.field,
      liveValue: liveRecord.leaves[delta.field] ?? '',
      outgoingValue: outgoingRecord.leaves[delta.field] ?? '',
      baselineValue: baselineRecord.leaves[delta.field] ?? '',
      sku,
    });
    if (!allowance.allowed) {
      push(sku, delta.field, `upload ${allowance.reason}; review or remove it`);
      continue;
    }
    if (delta.field === 'GTIN') {
      // Blank-live fill only, shown in the diff: do not silently accept it as
      // an ordinary accepted delta elsewhere.
      continue;
    }
    push(sku, delta.field, 'upload value differs from the approved baseline without an accepted run decision; review or remove it');
  }

  // Accepted decisions must actually be carried by the upload and the draft;
  // otherwise the batch is stale (decisions changed after the draft) or the
  // export was not built from the approved draft.
  for (const [field, value] of expected.fields) {
    if ((outgoingRecord.leaves[field] ?? '').trim() !== value.trim()) {
      push(sku, field, 'upload does not carry the accepted reviewed value; regenerate the export from the approved draft');
    }
    if ((draftRecord.leaves[field] ?? '').trim() !== value.trim()) {
      push(sku, field, 'approved draft predates the accepted reviewed value; re-apply and re-approve');
    }
  }
  for (const page of expected.pages) {
    if (!outgoingRecord.pages.includes(page)) {
      push(sku, 'ProductOnPages', 'upload does not carry an accepted page assignment; regenerate the export from the approved draft');
    }
    if (!draftRecord.pages.includes(page)) {
      push(sku, 'ProductOnPages', 'approved draft predates an accepted page assignment; re-apply and re-approve');
    }
  }
  for (const added of backfillPageDelta(baselineRecord.pages, draftRecord.pages).added) {
    if (!expected.pages.has(added)) {
      push(sku, 'ProductOnPages', 'approved draft adds a page without an accepted run decision; re-review');
    }
  }
}

// ─── Default entry: real repositories, fail closed without them ──────────────

let cachedRequire: ((id: string) => unknown) | null | undefined;

function loadRealResolvers(): BackfillPreflightResolvers | null {
  try {
    if (cachedRequire === undefined) {
      cachedRequire = createRequire(import.meta.url) as unknown as (id: string) => unknown;
    }
    if (cachedRequire === null) return null;
    const runRepo = cachedRequire('../db/repositories/classification-run-repo') as {
      getRun?: BackfillPreflightResolvers['getRun'];
      getAcceptedProposals?: BackfillPreflightResolvers['getAcceptedProposals'];
    };
    const configRepo = cachedRequire('../db/repositories/classification-config-repo') as {
      getCachedAttributeMappings?: BackfillPreflightResolvers['getCachedAttributeMappings'];
    };
    if (
      typeof runRepo.getRun !== 'function' ||
      typeof runRepo.getAcceptedProposals !== 'function' ||
      typeof configRepo.getCachedAttributeMappings !== 'function'
    ) {
      return null;
    }
    return {
      getRun: runRepo.getRun.bind(runRepo),
      getAcceptedProposals: runRepo.getAcceptedProposals.bind(runRepo),
      getCachedAttributeMappings: configRepo.getCachedAttributeMappings.bind(configRepo),
    };
  } catch {
    cachedRequire = null;
    return null;
  }
}

/**
 * Shared gate entry used by `gate-batch.ts`, `xcheck-export.ts`, and
 * backfill-mode `sync-routes.ts`. Loads the real run/decision/mapping
 * repositories; when they cannot load, every item fails closed rather than
 * passing without provenance.
 */
export function preflightBackfill(options: BackfillPreflightOptions): BackfillPreflightResult {
  const resolvers = loadRealResolvers();
  if (!resolvers) {
    const items = options?.items ?? [];
    if (items.length === 0) {
      return {
        ok: false,
        issues: [{ sku: '', field: 'batch', reason: 'batch has no intended SKUs; refusing an empty push' }],
      };
    }
    return {
      ok: false,
      issues: items.map(item => ({
        sku: item?.sku ?? '',
        field: 'classificationRun',
        reason: 'classification run provenance is unavailable in this runtime; abort push',
      })),
    };
  }
  return preflightBackfillWithResolvers(options, resolvers);
}
