import { parseBackfillCensusXml, diffBackfillRecords } from './backfill-preflight';

export interface BackfillReconciliation {
  attempted: string[];
  imported: string[];
  skipped: string[];
  duplicate: string[];
  mismatched: Array<{ sku: string; fields: string[] }>;
  unexpectedNew: string[];
  ok: boolean;
}

/**
 * P0 #4 post-import reconciliation. Compares a fresh full live export against
 * the exact attempted SKU set and the approved outgoing XML: every intended
 * SKU exactly once with expected approved field values and no unexpected new
 * records. Records attempted, imported, skipped, duplicate, and mismatched
 * sets. SKUs and field tags only, never field values.
 */
export function reconcileBackfillImport(options: {
  attemptedSkus: string[];
  outgoingXml: string;
  freshLiveXml: string;
}): BackfillReconciliation {
  const attempted = [...new Set(options.attemptedSkus)];
  const live = parseBackfillCensusXml(options.freshLiveXml);
  const outgoing = parseBackfillCensusXml(options.outgoingXml);
  const attemptedSet = new Set(attempted);
  const imported: string[] = [];
  const skipped: string[] = [];
  const duplicate: string[] = [];
  const mismatched: Array<{ sku: string; fields: string[] }> = [];
  const unexpectedNew: string[] = [];

  if (!live.ok || !outgoing.ok) {
    return { attempted, imported, skipped: [...attempted], duplicate, mismatched, unexpectedNew, ok: false };
  }

  const liveBySku = new Map<string, (typeof live.records)[number]>();
  for (const record of live.records) {
    if (record.sku && !liveBySku.has(record.sku)) liveBySku.set(record.sku, record);
  }
  const outgoingBySku = new Map<string, (typeof outgoing.records)[number]>();
  for (const record of outgoing.records) {
    if (record.sku && !outgoingBySku.has(record.sku)) outgoingBySku.set(record.sku, record);
  }

  for (const sku of attempted) {
    const liveCount = live.countsBySku[sku] ?? 0;
    if (liveCount === 0) {
      skipped.push(sku);
    } else if (liveCount > 1) {
      duplicate.push(sku);
    } else {
      const liveRecord = liveBySku.get(sku);
      const outgoingRecord = outgoingBySku.get(sku);
      if (!liveRecord || !outgoingRecord) {
        skipped.push(sku);
        continue;
      }
      const deltas = diffBackfillRecords(outgoingRecord, liveRecord);
      if (deltas.length === 0) imported.push(sku);
      else mismatched.push({ sku, fields: deltas.map(delta => delta.field) });
    }
  }

  for (const record of live.records) {
    if (record.sku && !attemptedSet.has(record.sku) && !unexpectedNew.includes(record.sku)) {
      unexpectedNew.push(record.sku);
    }
  }

  return {
    attempted,
    imported,
    skipped,
    duplicate,
    mismatched,
    unexpectedNew,
    ok: skipped.length === 0 && duplicate.length === 0 && mismatched.length === 0 && unexpectedNew.length === 0,
  };
}
