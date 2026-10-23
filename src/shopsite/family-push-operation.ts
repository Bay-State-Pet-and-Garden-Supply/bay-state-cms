/**
 * Complete-family push planning for direct ShopSite import/finalization
 * (issue #373).
 *
 * Pure function over the approved immutable load ({@link LinkedExportLoad}):
 * derives the single complete upload payload, the live-census remote
 * existence/currentness checks for unchanged referenced members, and the
 * deterministic request/finalization wire order. Performs no network or
 * database IO, holds no credentials, and infers no storefront-family
 * identity — references are structural Subproducts dependencies, never
 * family claims.
 *
 * Server route (`sync-routes.ts`) owns transport, receipts, and index
 * mutation; this module owns the plan shape both the route and the
 * deterministic tests share.
 */
import { ShopSiteProductCodec, assertNoPreservedCorruption, extractSubproductSkus } from './product-codec';
import { buildUploadMultipart } from './multipart-upload';
import { parseBackfillCensusXml, type BackfillCensusRecord } from './backfill-preflight';
import { sha256Hex } from '../shared/stable-id';
import type { LinkedManifest } from '../shared/schemas/change-set';
import type { Product } from '../shared/types';

export const FAMILY_PUSH_OPERATION_VERSION = 1;

/** Stable SKU matching for the native wire (the ticket's "stable SKU matching"). */
export const FAMILY_PUSH_MATCH_KEY = 'SKU';
/** New children must be creatable — update-only would silently drop them. */
export const FAMILY_PUSH_NEW_RECORDS = 'yes';
export const FAMILY_PUSH_DEFER_LINKING = 'no';

/** One complete upload set: the approved write SKUs in stable document order. */
export interface FamilyPushSetPlan {
  /** Stable SKU document order (sorted; the codec's encode contract is explicit-sort upstream). */
  skus: string[];
  /** Unchanged referenced remote members required to exist/current remotely (sorted). */
  requiredRemoteSkus: string[];
  /** New-record SKUs within the set (create operations; sorted). */
  newSkus: string[];
  /** Update-record SKUs within the set (sorted). */
  updateSkus: string[];
  /** sha256 of the exact outgoing upload XML bytes. */
  payloadHash: string;
}

/** Live-census verdict for one required remote member. */
export interface FamilyPushRemoteCheck {
  sku: string;
  ok: boolean;
  reason: string;
}

export interface FamilyPushReadiness {
  ok: boolean;
  plan: FamilyPushSetPlan;
  /** Census-derived checks for required remote members (empty when none required). */
  remoteChecks: FamilyPushRemoteCheck[];
  /** Human-readable refusal reasons; empty when ok. */
  blockers: string[];
  /** The exact native request order the route must execute (documented, no hidden ordering). */
  wireOrder: readonly ['dbupload.cgi', 'dbmake.cgi', 'generate.cgi'] | readonly ['dbupload.cgi', 'dbmake.cgi', 'db_xml.cgi (reconcile census)', 'generate.cgi'];
}
export function planFamilyPushSet(products: Product[], manifest: LinkedManifest): FamilyPushSetPlan {
  assertNoPreservedCorruption(products);
  const bySku: Record<string, Product> = {};
  for (const p of products) bySku[p.sku] = p;
  const writes: Record<string, LinkedManifest['writes'][number]> = {};
  for (const w of manifest.writes) writes[w.sku] = w;
  const changed: Record<string, true> = {};
  for (const w of manifest.writes) changed[w.sku] = true;
  const missing: string[] = [];
  for (const sku of Object.keys(changed)) {
    if (!(sku in bySku)) missing.push(sku);
  }
  if (missing.length > 0) {
    throw new Error(
      `family_push_incomplete_payload: approved write SKU(s) missing from the immutable load (${missing.sort().join(', ')}); refusing a partial-family upload.`,
    );
  }
  // Pre-pages plan hash over the immutable load. The route re-hashes the
  // page-reconciled upload bytes with sha256Hex and records THAT hash as
  // the payload identity, so recorded hash === uploaded bytes === reconcile
  // baseline even when page reconciliation rewrites ProductOnPages content.
  const skus = Object.keys(changed).sort();
  const ordered = skus.map((sku) => bySku[sku]);
  const xml = ShopSiteProductCodec.encodeMany(ordered).xml;
  const referenced: Record<string, true> = {};
  for (const product of ordered) {
    for (const ref of extractSubproductSkus(product)) {
      if (ref !== product.sku && !(ref in changed)) referenced[ref] = true;
    }
  }
  const newSkus: string[] = [];
  const updateSkus: string[] = [];
  for (const sku of skus) {
    const op = writes[sku]?.operation;
    if (op === 'create') newSkus.push(sku);
    else updateSkus.push(sku);
  }
  const payloadHash = sha256Hex(xml);
  return {
    skus,
    requiredRemoteSkus: Object.keys(referenced).sort(),
    newSkus: newSkus.sort(),
    updateSkus: updateSkus.sort(),
    payloadHash,
  };
}

/**
 * Encode the exact outgoing upload XML for one planned set in plan order.
 * The set ships whole — a planned SKU missing from the load refuses rather
 * than uploading short. Member order on the wire is the stable sorted plan
 * order (documented here; ShopSite applies the document at dbmake time, so
 * no forward-reference handling is needed or assumed).
 */
export function encodeFamilyPushXml(products: Product[], plan: FamilyPushSetPlan): string {
  const bySku: Record<string, Product> = {};
  for (const p of products) bySku[p.sku] = p;
  const ordered: Product[] = [];
  for (const sku of plan.skus) {
    const product = bySku[sku];
    if (!product) {
      throw new Error(
        `family_push_incomplete_payload: planned SKU "${sku}" missing from the immutable load; refusing a partial-family upload.`,
      );
    }
    ordered.push(product);
  }
  assertNoPreservedCorruption(ordered);
  return ShopSiteProductCodec.encodeMany(ordered).xml;
}

/**
 * Build the exact MIME multipart body for the family upload: stable SKU
 * record matching with new-record creation enabled (update-only would
 * silently drop new children). The returned dbmake token replays verbatim.
 */
export function buildFamilyPushMultipart(xml: string): { body: Uint8Array; contentType: string; contentLength: number } {
  return buildUploadMultipart(xml, {
    uniqueName: FAMILY_PUSH_MATCH_KEY,
    newRecords: FAMILY_PUSH_NEW_RECORDS,
    defer_linking: FAMILY_PUSH_DEFER_LINKING,
  });
}

/**
 * Build the expected live-census record for an unchanged member from its
 * immutable-commit bytes. The caller (route) resolves the product JSON at
 * the approved commit and hands it here — never mutable-workspace content.
 * Returns null when the commit bytes do not encode to exactly one census
 * record (fail closed upstream).
 */
export function expectedCensusRecordFor(product: Product): BackfillCensusRecord | null {
  const xml = ShopSiteProductCodec.encode(product).xml;
  const census = parseBackfillCensusXml(xml);
  if (!census.ok || census.records.length !== 1 || census.records[0].sku !== product.sku) return null;
  return census.records[0];
}

/**
 * Verify required remote members against a fresh live products census.
 *
 * Existence + currentness: each required SKU must appear exactly once in
 * the live census and its live record must equal the commit-resolved
 * expected record (leaves, images, pages, blocks, child references). A
 * missing, duplicated, or diverged member blocks the push honestly — the
 * operator includes the needed complete record in the approved group
 * instead of the push inventing it.
 */
export function checkRequiredRemoteMembers(
  requiredRemoteSkus: string[],
  liveProductsXml: string,
  expectedBySku: Record<string, BackfillCensusRecord>,
): FamilyPushRemoteCheck[] {
  if (requiredRemoteSkus.length === 0) return [];
  const census = parseBackfillCensusXml(liveProductsXml);
  if (!census.ok || !census.records) {
    return requiredRemoteSkus.map((sku) => ({
      sku,
      ok: false,
      reason: 'live census is malformed or unreadable; refetch before push',
    }));
  }
  const counts: Record<string, number> = {};
  const liveBySku: Record<string, BackfillCensusRecord> = {};
  for (const record of census.records) {
    if (!record.sku) continue;
    counts[record.sku] = (counts[record.sku] ?? 0) + 1;
    if (!(record.sku in liveBySku)) liveBySku[record.sku] = record;
  }
  return requiredRemoteSkus.map((sku) => {
    const expected = expectedBySku[sku];
    if (!expected) {
      return { sku, ok: false, reason: `unchanged member "${sku}" has no commit-resolved expectation; re-approve the group before push` };
    }
    if ((counts[sku] ?? 0) === 0) {
      return { sku, ok: false, reason: `unchanged member "${sku}" is absent from the live store; include its complete record in the approved group or remove the reference` };
    }
    if ((counts[sku] ?? 0) > 1) {
      return { sku, ok: false, reason: `unchanged member "${sku}" appears ${counts[sku]} times in the live store; quarantine the duplicate merchant records before push` };
    }
    if (!recordsEqual(expected, liveBySku[sku])) {
      return { sku, ok: false, reason: `unchanged member "${sku}" differs live from its approved-commit state; re-approve the group before push` };
    }
    return { sku, ok: true, reason: 'verified present and current' };
  });
}

/**
 * Push-time staleness recheck (issue #373): the working tree must still
 * match the approved commit for every manifest write AND read file. A later
 * member edit, native-reference change, rename, or base change after
 * approval stales the pending publication — the push refuses instead of
 * rewriting the payload without review.
 *
 * Pure except for the injected file reader (the route passes a git
 * readFileAtCommit + fs reader pair; tests pass fakes). Compares raw file
 * bytes so any drift — content, rename, delete — refuses.
 */
export function checkFamilyPushStalenessFiles(
  manifest: LinkedManifest,
  readAtCommit: (filePath: string) => string | null,
  readWorktree: (filePath: string) => string | null,
): { ok: true } | { ok: false; error: string } {
  const files: Array<{ sku: string; filePath: string; kind: string }> = [
    ...manifest.writes.map((w) => ({ sku: w.sku, filePath: w.filePath, kind: 'changed member' })),
    ...manifest.reads.map((r) => ({ sku: r.sku, filePath: r.filePath, kind: 'unchanged member' })),
  ];
  for (const file of files) {
    const committed = readAtCommit(file.filePath);
    if (committed === null) {
      return { ok: false, error: `Family push refused: ${file.kind} "${file.sku}" is missing at the approved commit; the group is stale — re-approve before push.` };
    }
    const current = readWorktree(file.filePath);
    if (current === null) {
      return { ok: false, error: `Family push refused: ${file.kind} "${file.sku}" changed after approval (deleted from the working tree); re-approve before push.` };
    }
    if (current !== committed) {
      return { ok: false, error: `Family push refused: ${file.kind} "${file.sku}" changed after approval (stale pending publication); re-approve before push instead of transmitting unreviewed bytes.` };
    }
  }
  return { ok: true };
}
/**
 * Full readiness verdict: plan + live-census remote verification.
 * Pure; the route supplies the fresh live XML it fetched plus the
 * commit-resolved expectations it decoded from the approved commit.
 */
export function assessFamilyPushReadiness(
  products: Product[],
  manifest: LinkedManifest,
  liveProductsXml: string | null,
  expectedBySku?: Record<string, BackfillCensusRecord>,
): FamilyPushReadiness {
  const plan = planFamilyPushSet(products, manifest);
  const blockers: string[] = [];
  let remoteChecks: FamilyPushRemoteCheck[] = [];
  if (plan.requiredRemoteSkus.length > 0) {
    if (!liveProductsXml) {
      blockers.push(
        `family_push_remote_unverified: ${plan.requiredRemoteSkus.length} unchanged member(s) (${plan.requiredRemoteSkus.join(', ')}) require a fresh live census before push`,
      );
    } else {
      remoteChecks = checkRequiredRemoteMembers(plan.requiredRemoteSkus, liveProductsXml, expectedBySku ?? {});
      for (const check of remoteChecks) {
        if (!check.ok) blockers.push(`family_push_remote_blocked: ${check.reason}`);
      }
    }
  }
  return {
    ok: blockers.length === 0,
    plan,
    remoteChecks,
    // Native finalization order: upload, dbmake, reconcile census, and only
    // then generate.cgi on a reconciled success (publish never precedes the
    // verdict).
    wireOrder: ['dbupload.cgi', 'dbmake.cgi', 'db_xml.cgi (reconcile census)', 'generate.cgi'],
    blockers,
  };
}

/**
 * SKU scope of a live census document (issue #373 gap 1): the sorted
 * unique non-blank SKUs live in the document. Returns null when the
 * document is malformed or unreadable so callers fail closed instead of
 * scoping a reconcile against a partial set.
 */
export function liveCensusSkusOf(xml: string): string[] | null {
  const census = parseBackfillCensusXml(xml);
  if (!census.ok) return null;
  const skus = new Set<string>();
  for (const record of census.records) {
    if (record.sku) skus.add(record.sku);
  }
  return [...skus].sort();
}

/**
 * Post-import reconciliation verdict for the complete family set.
 * Every attempted SKU must be present exactly once in the fresh live census
 * with census-equal content to the outgoing XML; anything else (skipped,
 * duplicate, mismatched, unexpected-new, blank-SKU, malformed census) is a
 * partial/unknown outcome — never a sync.
 *
 * `unexpectedNew` scoping (issue #373 gap 1): a populated store legitimately
 * carries SKUs outside the attempted set, so `unexpectedNew` means SKUs that
 * appeared because of this push — live SKUs that are neither attempted nor
 * present in the pre-upload census baseline. Pre-existing store SKUs (in the
 * baseline) never fail the verdict. A baseline of `[]` is the strictest
 * scope (an empty pre-upload store); an omitted/null baseline keeps the
 * legacy strict behavior where every non-attempted live SKU is unexpected.
 * SKUs created concurrently between the baseline and the fresh census still
 * fail closed — they are neither attempted nor baseline.
 */
export interface FamilyPushReconciliation {
  ok: boolean;
  imported: string[];
  skipped: string[];
  duplicate: string[];
  mismatched: string[];
  unexpectedNew: string[];
  summary: string;
}

export function reconcileFamilyPushImport(options: {
  attemptedSkus: string[];
  outgoingXml: string;
  freshLiveXml: string;
  /** Pre-upload census baseline scope (sorted unique SKUs, see liveCensusSkusOf). */
  baselineSkus?: string[] | null;
}): FamilyPushReconciliation {
  const attempted = [...new Set(options.attemptedSkus)].sort();
  const fail = (summary: string): FamilyPushReconciliation => ({
    ok: false, imported: [], skipped: [...attempted], duplicate: [], mismatched: [], unexpectedNew: [], summary,
  });
  const live = parseBackfillCensusXml(options.freshLiveXml);
  if (!live.ok) return fail('fresh live census is malformed or unreadable; the import outcome is unknown — reconcile before any synced marking');
  const outgoing = parseBackfillCensusXml(options.outgoingXml);
  if (!outgoing.ok) return fail('outgoing upload XML is malformed or unreadable; the import outcome is unknown — reconcile before any synced marking');
  if (live.blankSkuCount > 0) return fail('fresh live census contains a record without a SKU; quarantine before any synced marking');
  const attemptedSet = new Set(attempted);
  const liveBySku = new Map<string, BackfillCensusRecord>();
  for (const record of live.records) {
    if (record.sku && !liveBySku.has(record.sku)) liveBySku.set(record.sku, record);
  }
  const outgoingBySku = new Map<string, BackfillCensusRecord>();
  for (const record of outgoing.records) {
    if (record.sku && !outgoingBySku.has(record.sku)) outgoingBySku.set(record.sku, record);
  }
  const imported: string[] = [];
  const skipped: string[] = [];
  const duplicate: string[] = [];
  const mismatched: string[] = [];
  for (const sku of attempted) {
    const liveCount = live.countsBySku[sku] ?? 0;
    if (liveCount === 0) { skipped.push(sku); continue; }
    if (liveCount > 1) { duplicate.push(sku); continue; }
    const liveRecord = liveBySku.get(sku);
    const outgoingRecord = outgoingBySku.get(sku);
    if (!liveRecord || !outgoingRecord) { skipped.push(sku); continue; }
    if (recordsEqual(outgoingRecord, liveRecord)) imported.push(sku);
    else mismatched.push(sku);
  }
  const unexpectedNew: string[] = [];
  const baselineKnown: Record<string, true> = {};
  const hasBaseline = options.baselineSkus != null;
  if (hasBaseline) for (const sku of options.baselineSkus!) baselineKnown[sku] = true;
  for (const record of live.records) {
    if (!record.sku || attemptedSet.has(record.sku)) continue;
    if (hasBaseline && baselineKnown[record.sku]) continue;
    if (!unexpectedNew.includes(record.sku)) unexpectedNew.push(record.sku);
  }
  unexpectedNew.sort();
  const ok = skipped.length === 0 && duplicate.length === 0 && mismatched.length === 0 && unexpectedNew.length === 0
    && imported.length === attempted.length;
  const summary = ok
    ? `family import reconciled ${imported.length}/${attempted.length}`
    : `family import NOT reconciled: imported=${imported.length}/${attempted.length} skipped=${skipped.length} duplicate=${duplicate.length} mismatched=${mismatched.length} unexpectedNew=${unexpectedNew.length}`;
  return { ok, imported, skipped, duplicate, mismatched, unexpectedNew, summary };
}

function recordsEqual(a: BackfillCensusRecord, b: BackfillCensusRecord): boolean {
  if (a.sku !== b.sku) return false;
  const leafKeys = new Set([...Object.keys(a.leaves), ...Object.keys(b.leaves)]);
  for (const key of leafKeys) {
    if ((a.leaves[key] ?? '') !== (b.leaves[key] ?? '')) return false;
  }
  if (JSON.stringify(a.images) !== JSON.stringify(b.images)) return false;
  if (JSON.stringify([...a.pages].sort()) !== JSON.stringify([...b.pages].sort())) return false;
  const blockKeys = new Set([...Object.keys(a.blocks), ...Object.keys(b.blocks)]);
  for (const key of blockKeys) {
    if ((a.blocks[key] ?? '') !== (b.blocks[key] ?? '')) return false;
  }
  if (JSON.stringify([...a.childSkus].sort()) !== JSON.stringify([...b.childSkus].sort())) return false;
  return true;
}
