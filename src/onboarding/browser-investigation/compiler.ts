// Browser Investigation deterministic policy compiler (T2).
//
// Compiles the versioned typed (but UNTRUSTED) investigation result into an
// Extraction Policy Proposal — per-field source order plus minimal selector
// exceptions, with product and Source-Page Variant identity requirements —
// or into `requires_code_adapter` / typed unresolved gaps.
//
// Deterministic and pure: no DB, no network, no provider calls, no model
// output beyond the typed result it is given. Only allowlisted versioned
// primitives (SUPPORTED_POLICY_SOURCES) may appear in a proposal; arbitrary
// generated programs are never persisted for later execution. The
// free-form `recommendedStrategy` display string is never consulted.
//
// Precedence (documented, tested):
//   1. Declared incompatible structures → unresolved (blocked, never merged).
//   2. Conflicting first-choice sources across structures → unresolved.
//   3. Declared code-adapter need → requires_code_adapter.
//   4. Per-field compilation → proposal (with coverage gaps as blockers) or
//      unresolved when nothing compilable remains / identity is missing.

import {
  CompileOutcomeSchema,
  POLICY_FIELDS,
  UnresolvedGapSchema,
  isSupportedPolicySource,
  validatePolicySelector,
  type CompileOutcome,
  type FieldRecommendation,
  type PolicyField,
  type SupportedPolicySource,
  type UnresolvedGap,
} from '../../shared/schemas/browser-investigation-policy';
import type { InvestigationResult } from '../../shared/schemas/browser-investigation';

interface CompileContext {
  domain: string;
  investigationId: string;
  runId: string;
  inputHash: string;
  resultHash: string;
  now?: Date;
}

const MAX_GAPS = 50;

function gap(g: UnresolvedGap): UnresolvedGap {
  return UnresolvedGapSchema.parse(g);
}

function supportedFirstSource(sources: string[]): SupportedPolicySource | null {
  for (const source of sources) {
    if (isSupportedPolicySource(source)) return source;
  }
  return null;
}

function dedupeSupported(sources: string[]): SupportedPolicySource[] {
  const seen = new Set<string>();
  const out: SupportedPolicySource[] = [];
  for (const source of sources) {
    if (!isSupportedPolicySource(source) || seen.has(source)) continue;
    seen.add(source);
    out.push(source);
  }
  return out;
}

/** Scope key for conflict detection: declared structure or domain-wide. */
function scopeOf(rec: Pick<FieldRecommendation, 'structureId'>, knownStructures: Set<string>): string {
  if (rec.structureId && knownStructures.has(rec.structureId)) return rec.structureId;
  return '';
}

/** Stage 1: declared incompatible structures block any domain-wide policy. */
function declaredIncompatibilityGap(result: InvestigationResult): UnresolvedGap | null {
  const declared = (result.incompatibleStructureIds ?? []).filter((id) => id.trim());
  if (declared.length === 0) return null;
  return gap({
    kind: 'incompatible_structures',
    detail: `incompatible extraction structures (${declared.length}): ${declared.slice(0, 8).join(', ')} — no single domain-wide policy`,
  });
}

/**
 * Stage 2: conflicting first-choice sources (or selectors) across structures
 * block compilation. Distinct visual templates may share one proven platform
 * representation; genuinely conflicting extraction requirements must not be
 * squeezed into one domain-wide selector set. Fields missing from a
 * structure are honest coverage gaps, not conflicts.
 */
interface ConflictMaps {
  firstChoiceByField: Map<PolicyField, Map<string, string>>;
  selectorByField: Map<PolicyField, Map<string, string>>;
}

function trackRecommendationScope(rec: FieldRecommendation, scope: string, maps: ConflictMaps): void {
  const first = supportedFirstSource(rec.sources);
  if (first) {
    if (!maps.firstChoiceByField.has(rec.field)) maps.firstChoiceByField.set(rec.field, new Map());
    const perField = maps.firstChoiceByField.get(rec.field)!;
    if (!perField.has(scope)) perField.set(scope, first);
  }
  if (typeof rec.selector !== 'string' || !rec.selector.trim()) return;
  const validated = validatePolicySelector(rec.selector);
  if (!validated.ok) return;
  if (!maps.selectorByField.has(rec.field)) maps.selectorByField.set(rec.field, new Map());
  const perField = maps.selectorByField.get(rec.field)!;
  if (!perField.has(scope)) perField.set(scope, validated.selector);
}

function hasCrossScopeConflict(field: PolicyField, maps: ConflictMaps): boolean {
  const choices = maps.firstChoiceByField.get(field);
  if (choices && new Set(choices.values()).size > 1) return true;
  const selectors = maps.selectorByField.get(field);
  return !!selectors && new Set(selectors.values()).size > 1;
}

function detectCrossStructureConflicts(
  recommendations: FieldRecommendation[],
  knownStructures: Set<string>,
): PolicyField[] {
  const maps: ConflictMaps = { firstChoiceByField: new Map(), selectorByField: new Map() };
  for (const rec of recommendations) {
    trackRecommendationScope(rec, scopeOf(rec, knownStructures), maps);
  }
  return POLICY_FIELDS.filter((field) => hasCrossScopeConflict(field, maps));
}

interface FieldSink {
  pushGap: (g: UnresolvedGap) => void;
  warn: (message: string) => void;
}

interface CompiledField {
  field: PolicyField;
  sources: SupportedPolicySource[];
  selector?: string;
  evidenceRef?: string;
}

/** Report unsupported source names as typed gaps; return the supported remainder. */
function supportedSourcesWithGaps(rec: FieldRecommendation, field: PolicyField, sink: FieldSink): SupportedPolicySource[] {
  for (const name of rec.sources.filter((s) => !isSupportedPolicySource(s)).slice(0, 6)) {
    sink.pushGap({
      kind: 'unsupported_primitive',
      field,
      detail: `unsupported primitive '${name.slice(0, 80)}' for field '${field}': not a supported extraction source`,
      ...(rec.evidenceRef ? { evidenceRef: rec.evidenceRef } : {}),
    });
  }
  return dedupeSupported(rec.sources);
}

/** Warn about duplicate or dangling recommendations (deterministic first-wins). */
function warnRecommendationShape(field: PolicyField, recs: FieldRecommendation[], knownStructures: Set<string>, sink: FieldSink): FieldRecommendation {
  const rec = recs[0]!;
  if (recs.length > 1) {
    sink.warn(`duplicate recommendations for field '${field}': first wins deterministically`);
  }
  if (rec.structureId && !knownStructures.has(rec.structureId)) {
    sink.warn(`recommendation for field '${field}' references unknown structure '${rec.structureId}': treated as domain-wide`);
  }
  return rec;
}

/** Stage 4a: compile one field's recommendations to a policy entry or gaps. */
function compileFieldPolicy(
  field: PolicyField,
  recs: FieldRecommendation[],
  knownStructures: Set<string>,
  sink: FieldSink,
): CompiledField | null {
  if (recs.length === 0) {
    sink.pushGap({ kind: 'missing_field_evidence', field, detail: `no supported source observed for field '${field}'` });
    return null;
  }
  const rec = warnRecommendationShape(field, recs, knownStructures, sink);
  const supported = supportedSourcesWithGaps(rec, field, sink);
  if (supported.length === 0) return null;
  if (!supported.includes('selector')) {
    if (typeof rec.selector === 'string' && rec.selector.trim()) {
      sink.warn(`unused selector proposed for field '${field}': sources do not include 'selector', not persisted`);
    }
    return { field, sources: supported, ...(rec.evidenceRef ? { evidenceRef: rec.evidenceRef } : {}) };
  }
  return compileSelectorField(field, rec, supported, sink);
}

/** Selector-coupled field: validate the exception, else fall back to adapter sources. */
function compileSelectorField(
  field: PolicyField,
  rec: FieldRecommendation,
  supported: SupportedPolicySource[],
  sink: FieldSink,
): CompiledField | null {
  if (typeof rec.selector !== 'string' || !rec.selector.trim()) {
    sink.pushGap({ kind: 'selector_missing', field, detail: `selector source required for field '${field}' but no selector was proposed` });
    return null;
  }
  const validated = validatePolicySelector(rec.selector);
  if (validated.ok) {
    return { field, sources: supported, selector: validated.selector, ...(rec.evidenceRef ? { evidenceRef: rec.evidenceRef } : {}) };
  }
  // One bad selector cannot sink an otherwise adapter-backed field; the
  // rejection is preserved as a blocker.
  sink.pushGap({
    kind: 'selector_rejected',
    field,
    detail: `proposed selector for field '${field}' rejected (${validated.reason}): not persisted`,
    ...(rec.evidenceRef ? { evidenceRef: rec.evidenceRef } : {}),
  });
  const withoutSelector = supported.filter((s) => s !== 'selector');
  if (withoutSelector.length === 0) return null;
  return { field, sources: withoutSelector, ...(rec.evidenceRef ? { evidenceRef: rec.evidenceRef } : {}) };
}

/** Stage 4b: assemble the bound proposal artifact from compiled fields. */
function assembleProposal(
  result: InvestigationResult,
  ctx: CompileContext,
  fields: CompiledField[],
): CompileOutcome {
  const structures = result.structures ?? [];
  const identity = result.identityRequirements!;
  return CompileOutcomeSchema.parse({
    status: 'proposal' as const,
    proposal: {
      version: 1,
      domain: ctx.domain,
      investigationId: ctx.investigationId,
      runId: ctx.runId,
      inputHash: ctx.inputHash,
      resultHash: ctx.resultHash,
      platform: result.platform ?? 'unknown',
      structures:
        structures.length > 0
          ? structures.map((s) => ({
              id: s.id,
              sampleUrls: s.sampleUrls ?? [],
              ...(s.description ? { description: s.description } : {}),
              ...(s.platformSource ? { platformSource: s.platformSource } : {}),
            }))
          : [{ id: 'single-structure', sampleUrls: [] }],
      fields,
      identity: {
        productIdentity: [...identity.productIdentity],
        variantIdentity: [...identity.variantIdentity],
        optionAxes: [...(identity.optionAxes ?? [])],
      },
      renderedBrowserRequired: result.renderedBrowserRequired ?? false,
      evidenceRefs: [...(result.evidenceRefs ?? [])],
      compiledAt: (ctx.now ?? new Date()).toISOString(),
    },
    gaps: [],
    warnings: [],
  });
}

export function compileInvestigationResult(
  result: InvestigationResult,
  ctx: CompileContext,
): CompileOutcome {
  const structures = result.structures ?? [];
  const recommendations = result.fieldRecommendations ?? [];
  const knownStructures = new Set(structures.map((s) => s.id));

  const declared = declaredIncompatibilityGap(result);
  if (declared) {
    return CompileOutcomeSchema.parse({ status: 'unresolved' as const, gaps: [declared] });
  }

  const conflicts = detectCrossStructureConflicts(recommendations, knownStructures);
  if (conflicts.length > 0) {
    return CompileOutcomeSchema.parse({
      status: 'unresolved' as const,
      gaps: [
        gap({
          kind: 'incompatible_structures',
          detail: `conflicting extraction requirements across structures for: ${conflicts.slice(0, 9).join(', ')} — no single domain-wide policy`,
        }),
      ],
    });
  }

  if (result.codeAdapterNeeded) {
    return CompileOutcomeSchema.parse({
      status: 'requires_code_adapter' as const,
      codeAdapterRequest: {
        summary: `requires coded runtime adapter (${result.codeAdapterNeeded.capability}): investigation evidence cannot compile to supported primitives`,
        capability: result.codeAdapterNeeded.capability,
        reason: result.codeAdapterNeeded.reason,
        evidenceRefs: (result.evidenceRefs ?? []).slice(0, 50),
        structureIds: structures.map((s) => s.id).slice(0, 8),
      },
    });
  }

  const gaps: UnresolvedGap[] = [];
  const warnings: string[] = [];
  const sink: FieldSink = {
    pushGap: (g) => {
      if (gaps.length < MAX_GAPS) gaps.push(gap(g));
    },
    warn: (message) => {
      warnings.push(message);
    },
  };
  const fields: CompiledField[] = [];
  for (const field of POLICY_FIELDS) {
    const compiled = compileFieldPolicy(
      field,
      recommendations.filter((r) => r.field === field),
      knownStructures,
      sink,
    );
    if (compiled) fields.push(compiled);
  }

  // Identity correctness outranks field coverage: a proposal without product
  // and variant identity requirements is unresolved, not compilable.
  const identity = result.identityRequirements;
  if (!identity || identity.productIdentity.length === 0 || identity.variantIdentity.length === 0) {
    sink.pushGap({ kind: 'missing_identity', detail: 'product and Source-Page Variant identity requirements are missing' });
    return CompileOutcomeSchema.parse({ status: 'unresolved' as const, gaps });
  }

  if (fields.length === 0) {
    if (gaps.length === 0) {
      gaps.push(gap({ kind: 'missing_field_evidence', detail: 'no field compiled to a supported primitive' }));
    }
    return CompileOutcomeSchema.parse({ status: 'unresolved' as const, gaps });
  }

  const outcome = assembleProposal(result, ctx, fields);
  if (outcome.status !== 'proposal') return outcome;
  return CompileOutcomeSchema.parse({ ...outcome, gaps, warnings });
}

/** Only `proposal` outcomes may be applied to a draft; everything else stays unappliable. */
export function isAppliableOutcome(outcome: CompileOutcome): boolean {
  return outcome.status === 'proposal';
}
