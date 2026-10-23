export type ComparisonInput = {
  row_id?: string;
  upc: string | null;
  register_name: string | null;
  price: number | null;
  import_disposition?: 'imported' | 'invalid' | 'skipped_existing' | 'duplicate' | 'missing_output';
  source_disposition?: string | null;
  primary_row_id?: string | null;
};
export type PreparationStop =
  | 'review_ready_for_operator' | 'needs_input' | 'policy_or_budget_denied'
  | 'failed' | 'cancelled' | 'deadline_exceeded' | 'no_progress'
  | 'source_resolution' | 'pipeline_pending' | 'unavailable';
export type ComparisonItem = {
  id: string;
  upc: string;
  stage: string;
  stageStatus: string;
  status: string;
  errorMessage?: string | null;
  sourceUrl?: string | null;
  preparationStop?: PreparationStop | null;
  evidenceReferences?: string[];
  costMicros?: number | null;
};
export type ComparisonSource = { id: string; itemId: string; url: string; isSelected: boolean };
export type ComparisonCandidate = { id: string; url: string; selected: boolean };
export type ComparisonDisposition =
  | 'duplicate' | 'missing_output' | 'blocked' | 'failed' | 'pipeline_pending'
  | 'unresolved_source' | 'invalid' | 'skipped_existing' | 'other';
export type ComparisonRow = {
  row_id: string | null;
  input: { upc: string | null; register_name: string | null; price: number | null };
  item_id: string | null;
  disposition: ComparisonDisposition;
  source_disposition: string | null;
  preparation_stop: PreparationStop;
  primary_row_id: string | null;
  stage: string | null;
  stage_status: string | null;
  status: string | null;
  reason: string | null;
  candidates: ComparisonCandidate[];
  gate_blocks: string[];
  evidence_references: string[];
  allocated_cost_micros: number | null;
};
export type CostEffect = {
  id: string;
  arm: string;
  attempt_id: string;
  logical_effect_id: string;
  beneficiary_ids: string[];
  amount_micros: number | null;
  kind: 'billed' | 'reported' | 'estimated' | 'reserved' | 'unknown';
};
export type CostAllocation = { itemId: string; amountMicros: number };
export type CostReconciliation = {
  physical_effects: number;
  attributed_micros: number | null;
  unallocated_micros: number | null;
  billed_micros: number | null;
  reported_micros: number | null;
  estimated_micros: number | null;
  reserved_micros: number | null;
  unknown_effects: number;
  reconciled: boolean;
  effects: CostEffect[];
};
export type ComparisonReport = {
  measurement_mode: 'controlled_replay' | 'live_operational';
  rows: ComparisonRow[];
  dispositions: Record<ComparisonDisposition, number>;
  source_rows: number;
  imported_rows: number;
  duplicate_rows: number;
  missing_rows: number;
  accounted_rows: number;
  costs: CostReconciliation;
  paired_status: 'not_paired' | 'blocked' | 'incomplete' | 'reported';
  unavailable_metrics: string[];
};

function sumKnown(values: Array<number | null>): number | null {
  if (values.length === 0 || values.some(value => value === null)) return null;
  return values.reduce<number>((sum, value) => sum + value!, 0);
}

/** Charge each unique physical attempt once; conflicting aliases refuse reconciliation. */
export function reconcileComparisonCosts(effects: CostEffect[]): CostReconciliation {
  const unique = new Map<string, CostEffect>();
  for (const effect of effects) {
    const existing = unique.get(effect.attempt_id);
    if (existing) {
      if (existing.amount_micros !== effect.amount_micros || existing.kind !== effect.kind || existing.logical_effect_id !== effect.logical_effect_id) {
        throw new Error(`Conflicting aliases for physical attempt ${effect.attempt_id}`);
      }
      existing.beneficiary_ids = [...new Set([...existing.beneficiary_ids, ...effect.beneficiary_ids])].sort();
    } else unique.set(effect.attempt_id, { ...effect, beneficiary_ids: [...new Set(effect.beneficiary_ids)].sort() });
  }
  const rows = [...unique.values()];
  const attributed = rows.filter(effect => effect.beneficiary_ids.length > 0);
  const unallocated = rows.filter(effect => effect.beneficiary_ids.length === 0);
  const sumKind = (kind: CostEffect['kind']) => sumKnown(rows.filter(effect => effect.kind === kind).map(effect => effect.amount_micros));
  const unknown = rows.filter(effect => effect.kind === 'unknown' || effect.amount_micros === null).length;
  const allKnown = rows.every(effect => effect.amount_micros !== null && effect.kind !== 'unknown');
  const total = sumKnown(rows.map(effect => effect.amount_micros));
  const attributedTotal = sumKnown(attributed.map(effect => effect.amount_micros));
  const unallocatedTotal = sumKnown(unallocated.map(effect => effect.amount_micros));
  return {
    physical_effects: rows.length,
    attributed_micros: attributedTotal,
    unallocated_micros: unallocatedTotal,
    billed_micros: sumKind('billed'),
    reported_micros: sumKind('reported'),
    estimated_micros: sumKind('estimated'),
    reserved_micros: sumKind('reserved'),
    unknown_effects: unknown,
    reconciled: allKnown && total === attributedTotal! + unallocatedTotal!,
    effects: rows,
  };
}

/** Deterministic integer allocation; sorted beneficiaries receive any division remainder. */
export function allocateSharedCost(amountMicros: number, itemIds: string[]): CostAllocation[] {
  if (!Number.isSafeInteger(amountMicros) || amountMicros < 0) throw new Error('Cost must be non-negative integer micros');
  const ids = [...new Set(itemIds)].sort();
  if (!ids.length) return [];
  const base = Math.floor(amountMicros / ids.length);
  const remainder = amountMicros % ids.length;
  return ids.map((itemId, index) => ({ itemId, amountMicros: base + (index < remainder ? 1 : 0) }));
}

/** Projects gate diagnostics from a parked run reason into report gate blocks.
 * Absent or truncated gate info yields unknown, never pass. */
export function projectGateBlocks(reason: string | null): string[] {
  if (reason === null) return ['BLOCKED_SOURCE_REVIEW'];
  const blocks = ['BLOCKED_SOURCE_REVIEW'];
  const gatesIdx = reason.indexOf('| gates:');
  if (gatesIdx === -1) return blocks;
  const gatesSection = reason.slice(gatesIdx);
  if (/no_authority/.test(gatesSection)) blocks.push('BLOCKED_IDENTITY_AUTHORITY');
  if (/incomplete_coverage/.test(gatesSection)) blocks.push('BLOCKED_IDENTITY_COVERAGE');
  if (/matcher:(?!unique_name_variant_match)|BLOCKED:.*matcher:/.test(gatesSection)) blocks.push('BLOCKED_IDENTITY_MATCHER');
  if (/contradiction\(/.test(gatesSection)) blocks.push('BLOCKED_IDENTITY_CONTRADICTION');
  return blocks;
}

/** Projects observations onto every original input row; absence is never success or zero cost. */
export function projectComparisonRows(
  inputs: ComparisonInput[],
  items: ComparisonItem[],
  sources: ComparisonSource[],
  options: { measurementMode?: 'controlled_replay' | 'live_operational'; costs?: CostEffect[]; paired?: boolean; terminalStop?: PreparationStop } = {},
): ComparisonReport {
  const costs = reconcileComparisonCosts(options.costs ?? []);
  const allocated = new Map<string, number | null>();
  for (const effect of costs.effects) {
    if (effect.amount_micros === null) {
      for (const beneficiary of effect.beneficiary_ids) allocated.set(beneficiary, null);
      continue;
    }
    for (const share of allocateSharedCost(effect.amount_micros, effect.beneficiary_ids)) {
      const previous = allocated.get(share.itemId);
      allocated.set(share.itemId, previous === null ? null : (previous ?? 0) + share.amountMicros);
    }
  }
  const itemByUpc = new Map<string, ComparisonItem>();
  for (const item of items) if (!itemByUpc.has(item.upc)) itemByUpc.set(item.upc, item);
  const seen = new Map<string, string | null>();
  const counts: ComparisonReport['dispositions'] = {
    duplicate: 0, missing_output: 0, blocked: 0, failed: 0,
    pipeline_pending: 0, unresolved_source: 0, invalid: 0, skipped_existing: 0, other: 0,
  };
  let importedRows = 0;
  const rows = inputs.map(input => {
    const rowId = input.row_id ?? null;
    const duplicate = input.import_disposition === 'duplicate' || seen.has(input.upc ?? '');
    if (!duplicate && input.import_disposition !== 'invalid' && input.import_disposition !== 'skipped_existing') seen.set(input.upc ?? '', rowId);
    const item = duplicate ? undefined : itemByUpc.get(input.upc ?? '');
    const candidates = item ? sources.filter(source => source.itemId === item.id).map(source => ({ id: source.id, url: source.url, selected: source.isSelected })) : [];
    let disposition: ComparisonDisposition;
    let stop: PreparationStop = 'unavailable';
    let gateBlocks: string[] = [];
    let reason: string | null = null;
    if (input.import_disposition === 'invalid') disposition = 'invalid';
    else if (input.import_disposition === 'skipped_existing') disposition = 'skipped_existing';
    else if (input.source_disposition && !['imported', 'duplicate', 'missing_output', 'invalid', 'skipped_existing'].includes(input.source_disposition)) disposition = 'other';
    else if (duplicate) disposition = 'duplicate';
    else if (!item || input.import_disposition === 'missing_output') disposition = 'missing_output';
    else {
      importedRows++;
      const stageStatus = item.stageStatus.toLowerCase();
      const stage = item.stage.toLowerCase();
      const observedReason = item.errorMessage ?? null;
      const noDomainSetup = observedReason !== null && /\b(no|missing|unconfigured|not configured)\b.{0,30}\bdomain\b|\bdomain\b.{0,30}\b(not configured|missing|unavailable)\b/i.test(observedReason);
      if (item.preparationStop) stop = item.preparationStop;
      else if (options.terminalStop && ['pending', 'running'].includes(stageStatus)) stop = options.terminalStop;
      else if (item.status === 'failed' || stageStatus === 'failed') stop = 'failed';
      else if (stageStatus === 'cancelled') stop = 'cancelled';
      else if (stageStatus === 'deadline_exceeded') stop = 'deadline_exceeded';
      else if (stageStatus === 'denied' || stageStatus === 'blocked') stop = 'policy_or_budget_denied';
      else if ((stage === 'review_listings' || stage === 'review') && stageStatus === 'pending') stop = 'review_ready_for_operator';
      else if (item.status === 'needs_review' || stageStatus === 'needs_input' || stageStatus === 'blocked' || /needs_review/i.test(observedReason ?? '')) stop = 'needs_input';
      else if (stageStatus === 'completed' && (stage === 'discovery' || stage === 'find_product_page') &&
        (!item.sourceUrl || !candidates.some(candidate => candidate.selected))) stop = 'source_resolution';
      else if (stageStatus !== 'completed') stop = 'pipeline_pending';
      else if (item.status === 'needs_input') stop = 'needs_input';
      else if (item.status === 'review_ready') stop = 'review_ready_for_operator';
      else stop = 'pipeline_pending';
      if (stop === 'failed') disposition = 'failed';
      else if (stop === 'policy_or_budget_denied' || stop === 'needs_input' || stop === 'source_resolution') {
        disposition = 'blocked';
        gateBlocks = noDomainSetup ? ['BLOCKED_DOMAIN_SETUP'] :
          stop === 'source_resolution' || stop === 'needs_input' || item.status === 'needs_review' ? projectGateBlocks(observedReason) :
            stop === 'policy_or_budget_denied' ? ['BLOCKED_POLICY_OR_BUDGET'] : ['BLOCKED_SOURCE_OR_INPUT'];
      } else if (stop === 'review_ready_for_operator') disposition = 'pipeline_pending';
      else if (stop === 'pipeline_pending') disposition = 'pipeline_pending';
      else disposition = 'blocked';
      reason = observedReason;
    }
    counts[disposition]++;
    const primaryRow = input.primary_row_id ?? (duplicate ? seen.get(input.upc ?? '') ?? null : null);
    return {
      row_id: rowId,
      input: { upc: input.upc, register_name: input.register_name, price: input.price },
      item_id: item?.id ?? null,
      disposition,
      source_disposition: input.source_disposition ?? input.import_disposition ?? null,
      preparation_stop: stop,
      primary_row_id: duplicate ? primaryRow : null,
      stage: item?.stage ?? null,
      stage_status: item?.stageStatus ?? null,
      status: item?.status ?? null,
      reason,
      candidates,
      gate_blocks: gateBlocks,
      evidence_references: item?.evidenceReferences ?? [],
      allocated_cost_micros: duplicate ? null : item ? (item.costMicros ?? allocated.get(item.id) ?? null) : null,
    };
  });
  const pairedStatus = !options.paired ? 'not_paired' :
    rows.some(row => ['unavailable', 'failed', 'cancelled', 'policy_or_budget_denied'].includes(row.preparation_stop)) ? 'blocked' :
      rows.some(row => ['pipeline_pending', 'deadline_exceeded', 'no_progress'].includes(row.preparation_stop)) ? 'incomplete' : 'reported';
  return {
    measurement_mode: options.measurementMode ?? 'live_operational',
    rows,
    dispositions: counts,
    source_rows: inputs.length,
    imported_rows: importedRows,
    duplicate_rows: counts.duplicate,
    missing_rows: counts.missing_output + counts.invalid + counts.skipped_existing,
    accounted_rows: rows.length,
    costs,
    paired_status: pairedStatus,
    unavailable_metrics: ['reviewed_accuracy', 'operator_effort', 'qualification'],
  };
}
