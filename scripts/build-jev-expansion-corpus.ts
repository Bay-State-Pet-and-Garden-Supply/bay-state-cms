#!/usr/bin/env bun
/**
 * Assemble source-only development adjudications against a sanctioned authority.
 * Dry-run by default. Never fetches, reseals, reads private custody, fits policy,
 * approves products, or authors a peer receipt. Existing generation bytes are
 * immutable; corrections belong in a new output directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { canonicalProductUrlKey } from './collect-jev-v3-sources';
import { JevSourceCandidateSchema, type JevSourceCandidate } from '../src/shared/schemas/jev-benchmark';
import {
  assertNoHoldoutAccess,
  convertRepresentativeToFrozenSnapshot,
  recomputeTaxonomyAuthorityHash,
} from '../src/classification/jev-benchmark-replay';
import { assertGoldWithinFrozenTaxonomy } from '../src/classification/benchmark-exporter';
import { parseQualificationGoldOnly, type QualificationGoldOnlyEntry } from '../src/classification/benchmark-prediction';
import { derivePageGold, loadPageRulePacket, type PageRulePacket } from './lib/page-gold';
import { applyEnrichmentOverlay, type EnrichmentOverlayEntry } from './lib/enrichment-overlay';

const TARGETS = ['breed-size', 'flavor', 'food-form', 'fuel-type', 'hose-length', 'life-stage', 'packaging-type', 'species'] as const;
const SUFFIXES = ['source-development.json', 'source-development-supplemental.json'] as const;
const PRIOR_RELEASES = ['jev-representative-v1', 'jev-representative-v2', 'jev-representative-v3', 'jev-representative-v4', 'jev-representative-v9'];
const AssignmentSchema = z.object({
  targetId: z.enum(TARGETS),
  state: z.enum(['known', 'no-fit', 'insufficient-evidence', 'inapplicable']),
  value: z.string().min(1).optional(),
}).strict();
const SourceEvidencePolicySchema = z.object({
  source: z.enum(['official_product_page', 'third_party_page', 'catalog_product']),
  titleReliability: z.enum(['high', 'medium', 'low']),
  descriptionReliability: z.enum(['high', 'medium', 'low']),
  excludedLocatorsBySku: z.record(z.string(), z.array(z.string())).default({}),
}).strict();
const LabelSchema = z.object({
  sku: z.string().min(1),
  productType: z.object({ kind: z.enum(['known-type', 'no-fit', 'insufficient-evidence']), typeId: z.string().min(1).nullable() }).strict(),
  fieldAssignments: z.array(AssignmentSchema).length(TARGETS.length),
  rationale: z.string().min(1),
  basis: z.array(z.object({ targetId: z.string().min(1), quote: z.string().min(1), locator: z.string().min(1), reason: z.string().min(1) }).strict()).min(1),
  identityIssues: z.array(z.string()),
  excludeReason: z.string().min(1).nullable(),
}).strict();
type Label = z.infer<typeof LabelSchema>;
interface SourceRecord { bank: string; source: JevSourceCandidate }
interface CollectionManifest {
  authorityHash: string;
  commitments: { devHash: string; devSuppHash: string };
}
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value: unknown): string => `${JSON.stringify(value, null, 1)}\n`;
function publicBytes(file: string): Buffer {
  assertNoHoldoutAccess(file);
  const real = fs.realpathSync(file);
  assertNoHoldoutAccess(real);
  return fs.readFileSync(real);
}
function sourceRows(file: string): JevSourceCandidate[] {
  return z.array(JevSourceCandidateSchema).parse(JSON.parse(publicBytes(file).toString('utf8')));
}
function productKey(row: { canonicalUrl: string }): string {
  const key = canonicalProductUrlKey(row.canonicalUrl);
  if (key === null) throw new Error(`invalid_product_identity: ${row.canonicalUrl}`);
  return key;
}
function fail(sku: string, reason: string): never { throw new Error(`invalid_adjudication: ${sku}: ${reason}`); }

function bindPublicOutput(requested: string): string {
  const absolute = path.resolve(requested);
  assertNoHoldoutAccess(absolute);
  let ancestor = absolute;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('output_ancestor_unresolvable');
    ancestor = parent;
  }
  const realAncestor = fs.realpathSync(ancestor);
  assertNoHoldoutAccess(realAncestor);
  const bound = path.resolve(realAncestor, path.relative(ancestor, absolute));
  assertNoHoldoutAccess(bound);
  return bound;
}

const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: {
  adjudication: { type: 'string' },
  authority: { type: 'string', default: 'docs/audits/jev-representative-v9/taxonomy.json' },
  sources: { type: 'string', default: 'docs/audits/jev-expansion-v1' },
  out: { type: 'string', default: 'docs/audits/jev-expansion-v2' },
  'page-rules': { type: 'string' },
  'owner-decisions': { type: 'string' },
  enrich: { type: 'string' },
  write: { type: 'boolean', default: false }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('Usage: bun scripts/build-jev-expansion-corpus.ts --adjudication <public.json> [--authority <taxonomy.json>] [--sources <directory>] [--out <new-generation-directory>] [--page-rules <packet.json> --owner-decisions <decisions.json>] [--enrich <enrichment-evidence.json>] [--write]');
  console.log('Without --page-rules, every entry emits unknown page gold (legacy behavior). With --page-rules + --owner-decisions, eligible-closed predicates derive explicit per-entry page gold.');
  console.log('With --enrich, already-public re-crawl excerpts overlay hash-verified bank sources (SKU + canonicalUrl exact, locator-dedupe; fail closed on mismatch/drift/overflow).');
  process.exit(0);
}
if (!values.adjudication) throw new Error('missing_adjudication: pass a complete public source-adjudication document');
const authorityBytes = publicBytes(values.authority!);
const authority = JSON.parse(authorityBytes.toString('utf8')) as {
  authorityHash?: string; binding: Record<string, unknown>; bundle: Record<string, unknown>; pages: Array<Record<string, unknown>>;
};
const authorityHash = recomputeTaxonomyAuthorityHash(authority);
if (authority.authorityHash !== undefined && authorityHash !== authority.authorityHash) throw new Error('authority_hash_drift: producer-domain commitment does not match the captured authority');
const frozen = convertRepresentativeToFrozenSnapshot(authority.bundle, authority.pages);
const types = new Map(frozen.productTypes.map(t => [t.id, t]));
const profiles = new Map((frozen.attributeProfiles ?? []).map(p => [p.id, p]));
const attributes = new Map(frozen.attributeTargets.map(t => [t.targetId, t]));
// Owner-approved page rules (optional): validated packet + decision binding, else legacy unknown pages.
if ((values['page-rules'] !== undefined) !== (values['owner-decisions'] !== undefined)) {
  throw new Error('page_rules_require_owner_binding: pass --page-rules and --owner-decisions together');
}
let pageRules: PageRulePacket | null = null;
let pageRulesSha256: string | null = null;
if (values['page-rules'] !== undefined) {
  assertNoHoldoutAccess(values['page-rules']!);
  assertNoHoldoutAccess(values['owner-decisions']!);
  pageRules = loadPageRulePacket({
    packetPath: values['page-rules']!,
    decisionsPath: values['owner-decisions']!,
    expectedAuthorityHash: authorityHash,
    frozenTypes: types,
    frozenTargets: new Map(frozen.attributeTargets.map(t => [t.targetId, new Set(t.options)])),
    frozenPageIds: new Set(frozen.pages.map(p => p.pageId)),
  });
  pageRulesSha256 = sha256(publicBytes(values['page-rules']!));
}
const sourceFiles: Array<{ path: string; sha256: string }> = [];
const allSources = new Map<string, SourceRecord>();
const sourceDir = fs.realpathSync(values.sources!);
assertNoHoldoutAccess(sourceDir);
for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true }).filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const manifestFile = path.join(sourceDir, entry.name, 'collection-manifest.json');
  if (!fs.existsSync(manifestFile)) continue;
  const manifest = JSON.parse(publicBytes(manifestFile).toString('utf8')) as CollectionManifest;
  if (manifest.authorityHash !== authorityHash) throw new Error(`authority_hash_drift: source bank ${entry.name}`);
  for (const [index, suffix] of SUFFIXES.entries()) {
    const file = path.join(sourceDir, entry.name, suffix);
    const bytes = publicBytes(file);
    const hash = sha256(bytes);
    const expected = index === 0 ? manifest.commitments.devHash : manifest.commitments.devSuppHash;
    if (hash !== expected) throw new Error(`source_hash_drift: ${file}`);
    sourceFiles.push({ path: path.relative(process.cwd(), file), sha256: hash });
    for (const source of z.array(JevSourceCandidateSchema).parse(JSON.parse(bytes.toString('utf8')))) {
      const previous = allSources.get(source.sku);
      if (previous && jsonBytes(previous.source) !== jsonBytes(source)) throw new Error(`conflicting_source_identity: ${source.sku}`);
      if (!previous) allSources.set(source.sku, { bank: entry.name, source });
    }
  }
}
const priorKeys = new Set<string>();
const priorFiles: Array<{ path: string; sha256: string }> = [];
// Enrichment overlay: AFTER bank load + hash verification (source_hash_drift still enforced above).
let enrichmentOverlay: EnrichmentOverlayEntry[] = [];
let enrichmentEvidenceSha256: string | null = null;
if (values.enrich !== undefined) {
  const enrichmentBytes = publicBytes(values.enrich!);
  enrichmentEvidenceSha256 = sha256(enrichmentBytes);
  enrichmentOverlay = applyEnrichmentOverlay(allSources, JSON.parse(enrichmentBytes.toString('utf8')));
}
for (const release of PRIOR_RELEASES) for (const suffix of SUFFIXES) {
  const file = path.join('docs/audits', release, suffix);
  if (!fs.existsSync(file)) continue;
  const bytes = publicBytes(file);
  priorFiles.push({ path: file, sha256: sha256(bytes) });
  for (const row of sourceRows(file)) priorKeys.add(productKey(row));
}
const excludedExposure = [...allSources.values()].filter(row => priorKeys.has(productKey(row.source)));
const eligible = [...allSources.values()].filter(row => !priorKeys.has(productKey(row.source))).sort((a, b) => a.source.sku.localeCompare(b.source.sku));
const adjudicationBytes = publicBytes(values.adjudication);
const adjudication = JSON.parse(adjudicationBytes.toString('utf8')) as {
  authorityHash?: string; entries?: unknown[]; sourceEvidencePolicies?: unknown;
};
if (adjudication.authorityHash !== authorityHash) throw new Error('authority_hash_drift: source adjudication must bind the same authority');
const sourceEvidencePolicies = z.record(z.string(), SourceEvidencePolicySchema).parse(adjudication.sourceEvidencePolicies);
const labels = new Map<string, Label>();
for (const raw of adjudication.entries ?? []) {
  const label = LabelSchema.parse(raw);
  if (labels.has(label.sku)) fail(label.sku, 'duplicate disposition');
  labels.set(label.sku, label);
}
if (labels.size !== eligible.length || eligible.some(row => !labels.has(row.source.sku))) {
  throw new Error(`incomplete_adjudication: need exactly ${eligible.length} eligible source dispositions, got ${labels.size}`);
}
const goldEntries: QualificationGoldOnlyEntry[] = [];
const labeledSources: JevSourceCandidate[] = [];
const pageReasons = new Map<string, string>();
// A recaptured URL is not a new independent product. Keep separately named
// real variants, choose a capture by source completeness (never gold), and
// account for every discarded recapture without merging its facts.
const capturesByIdentity = new Map<string, SourceRecord[]>();
for (const row of eligible) {
  const key = JSON.stringify([productKey(row.source), row.source.productIdentity]);
  const group = capturesByIdentity.get(key) ?? [];
  group.push(row);
  capturesByIdentity.set(key, group);
}
const duplicateOf = new Map<string, string>();
for (const group of capturesByIdentity.values()) {
  if (new Set(group.map(r => r.source.familyId)).size !== 1) throw new Error('conflicting_canonical_family: duplicate captures disagree on family');
  group.sort((a, b) => b.source.excerpts.length - a.source.excerpts.length ||
    a.source.retrievedAt.localeCompare(b.source.retrievedAt) || a.source.sku.localeCompare(b.source.sku));
  for (const duplicate of group.slice(1)) duplicateOf.set(duplicate.source.sku, group[0].source.sku);
}
for (const { bank, source } of eligible) {
  const label = labels.get(source.sku)!;
  const type = label.productType.kind === 'known-type' ? types.get(label.productType.typeId ?? '') : null;
  if (label.productType.kind === 'known-type' && !type) fail(source.sku, 'known type absent from authority');
  if (label.productType.kind !== 'known-type' && label.productType.typeId !== null) fail(source.sku, 'abstention carries a type value');
  if (new Set(label.fieldAssignments.map(f => f.targetId)).size !== TARGETS.length) fail(source.sku, 'targets must occur exactly once');
  const profile = type?.attributeProfileId ? profiles.get(type.attributeProfileId) : null;
  if (type && !profile) fail(source.sku, 'frozen profile missing');
  const applicable = new Set(profile?.attributes.map(a => a.attributeId) ?? []);
  for (const a of frozen.attributeTargets) if (a.isUniversal) applicable.add(a.targetId);
  for (const id of Object.keys(type?.invariantAttributes ?? {})) applicable.add(id);
  for (const field of label.fieldAssignments) {
    const permitted = attributes.get(field.targetId);
    if (!permitted) fail(source.sku, `unknown target ${field.targetId}`);
    if (field.state === 'known') {
      if (field.value === undefined || !permitted.options.includes(field.value)) fail(source.sku, `noncanonical ${field.targetId} value`);
    } else if (field.value !== undefined) fail(source.sku, `${field.targetId} abstention carries a value`);
    if ((!type || !applicable.has(field.targetId)) !== (field.state === 'inapplicable')) fail(source.sku, `${field.targetId} applicability mismatch`);
    const invariant = type?.invariantAttributes?.[field.targetId];
    if (invariant !== undefined && (field.state !== 'known' || field.value !== invariant)) fail(source.sku, `${field.targetId} invariant mismatch`);
    if (field.state === 'known' && invariant === undefined && !label.basis.some(b => b.targetId === field.targetId)) fail(source.sku, `${field.targetId} known value lacks citation`);
  }
  if (!label.basis.some(b => b.targetId === 'product-type')) fail(source.sku, 'type disposition lacks citation');
  const policy = sourceEvidencePolicies[bank];
  if (!policy) fail(source.sku, `publisher/evidence policy missing for ${bank}`);
  const excludedLocators = new Set(policy.excludedLocatorsBySku[source.sku] ?? []);
  const admissibleTargets = new Set<string>();
  for (const basis of label.basis) {
    const titleLocator = basis.locator === source.sourceLocator || basis.locator === source.canonicalUrl ||
      basis.locator === `${source.sourceLocator}#title`;
    const excerpt = source.excerpts.find(e => e.locator === basis.locator);
    const matchesTitle = titleLocator && source.title.includes(basis.quote);
    if (!matchesTitle && (!excerpt || !excerpt.text.includes(basis.quote))) fail(source.sku, 'citation quote does not match its declared captured locator');
    if (matchesTitle || !excludedLocators.has(basis.locator)) admissibleTargets.add(basis.targetId);
  }
  if (label.productType.kind === 'known-type' && !admissibleTargets.has('product-type')) fail(source.sku, 'known type relies solely on excluded review/ambiguous clips');
  for (const field of label.fieldAssignments) {
    if (field.state === 'known' && type?.invariantAttributes?.[field.targetId] === undefined && !admissibleTargets.has(field.targetId)) fail(source.sku, `${field.targetId} known value lacks admissible evidence`);
  }
  if (label.excludeReason || duplicateOf.has(source.sku)) continue;
  labeledSources.push(source);
  // Page gold: explicit derivation from owner-approved rules over direct evidence, else legacy unknown.
  let categoryPages: QualificationGoldOnlyEntry['gold']['categoryPages'] = { state: 'unknown', completeness: 'unknown', pageIds: [], pageAssignments: [] };
  let pageReason: string | null = pageRules === null ? 'page rules not supplied; page gold unknown' : null;
  if (pageRules !== null) {
    const derived = derivePageGold(pageRules, {
      sku: source.sku,
      productType: label.productType,
      fieldByTarget: new Map(label.fieldAssignments.map(f => [f.targetId, { state: f.state, value: f.value }])),
      brand: source.brand,
      evidenceQuotes: [source.title, ...source.excerpts.filter(e => !excludedLocators.has(e.locator)).map(e => e.text)],
    });
    categoryPages = { state: derived.state, completeness: derived.completeness, pageIds: derived.pageIds, pageAssignments: derived.pageAssignments };
    pageReason = derived.pageReason;
  }
  goldEntries.push({ sku: source.sku, familyId: source.familyId, split: 'dev', assortment: bank, gold: {
    productType: label.productType,
    fieldAssignments: [...label.fieldAssignments].sort((a, b) => a.targetId.localeCompare(b.targetId)),
    categoryPages,
  }, evidence: [
    { source: policy.source, snippet: source.title, reliability: policy.titleReliability, attributeId: null },
    ...source.excerpts.filter(e => !excludedLocators.has(e.locator)).map(e => ({
      source: policy.source, snippet: e.text, reliability: policy.descriptionReliability, attributeId: null,
    })),
  ] });
  if (pageReason !== null) pageReasons.set(source.sku, pageReason);
}
assertGoldWithinFrozenTaxonomy(goldEntries, frozen);
parseQualificationGoldOnly({ entries: goldEntries });
const typeCounts = new Map<string, { rows: number; families: Set<string> }>();
const fieldStateCounts: Record<string, number> = {};
for (const entry of goldEntries) {
  const id = entry.gold.productType.typeId ?? entry.gold.productType.kind;
  const count = typeCounts.get(id) ?? { rows: 0, families: new Set<string>() };
  count.rows++;
  count.families.add(entry.familyId);
  typeCounts.set(id, count);
  for (const field of entry.gold.fieldAssignments) fieldStateCounts[field.state] = (fieldStateCounts[field.state] ?? 0) + 1;
}
const completePageGoldRows = goldEntries.filter(e => e.gold.categoryPages?.state === 'known' && e.gold.categoryPages?.completeness === 'complete').length;
const partialPageGoldRows = goldEntries.filter(e => e.gold.categoryPages?.completeness === 'partial').length;
const unknownPageGoldRows = goldEntries.length - completePageGoldRows - partialPageGoldRows;
const counts = {
  publicSourceRows: allSources.size, priorPublicIdentityExclusions: excludedExposure.length,
  adjudicatedRows: labels.size, nonProductExclusions: eligible.filter(r => labels.get(r.source.sku)!.excludeReason).length,
  developmentRows: goldEntries.length, developmentFamilies: new Set(goldEntries.map(e => e.familyId)).size,
  duplicateCapturesExcluded: duplicateOf.size,
  knownRows: goldEntries.filter(e => e.gold.productType.kind === 'known-type').length,
  noFitRows: goldEntries.filter(e => e.gold.productType.kind === 'no-fit').length,
  insufficientRows: goldEntries.filter(e => e.gold.productType.kind === 'insufficient-evidence').length,
  representedKnownTypes: [...typeCounts.keys()].filter(id => types.has(id)).length,
  classesAtTwentyRows: [...typeCounts.entries()].filter(([id, c]) => types.has(id) && c.rows >= 20).length,
  completePageGoldRows, partialPageGoldRows, unknownPageGoldRows,
  pageRulesApplied: pageRules !== null, pageRulePacketVersion: pageRules !== null ? pageRules.artifactVersion : null,
  pageRulePacketSha256: pageRulesSha256,
  enrichmentApplied: enrichmentEvidenceSha256 !== null,
  enrichmentEvidenceSha256,
  enrichmentRowsOverlaid: enrichmentOverlay.length,
  enrichmentExcerptsAppended: enrichmentOverlay.reduce((n, e) => n + e.appendedExcerptLocators.length, 0),
  qualificationEligibleRows: 0,
};
const pageBlocker = pageRules === null
  ? 'Page identity is verified but complete assignment scope/gold is not closed'
  : `Page gold derived from ${pageRules.artifactVersion} (eligible ${pageRules.counts.eligible}/excluded ${pageRules.counts.excluded}/unresolved ${pageRules.counts.unresolved}); ${unknownPageGoldRows + partialPageGoldRows} rows remain partial/unknown with exact reasons${pageRules.ownerDecisionsRequired.length > 0 ? `; owner decisions ${pageRules.ownerDecisionsRequired.map(d => d.id).join(',')} still required` : '; all owner page decisions applied'}`;
const outputs: Record<string, string> = {
  'taxonomy.json': authorityBytes.toString('utf8'),
  'source-development.json': jsonBytes(labeledSources),
  'development-gold.json': jsonBytes({ authorityHash, authorityBinding: authority.binding, status: 'development-adjudicated-awaiting-peer-review', selectionPolicy: 'Every captured eligible public product is retained; prior public canonical identities and explicit non-product services are separately accounted for. Original source family IDs and dev split are preserved, never rehashed into a holdout.', qualificationTargetSet: { controlledAttributes: TARGETS }, pageRulePacket: pageRules === null ? null : { version: pageRules.artifactVersion, sha256: pageRulesSha256, counts: pageRules.counts }, entries: goldEntries }),
  'development-adjudication.json': jsonBytes({ authorityHash, sourceAdjudicationSha256: sha256(adjudicationBytes), sourceFiles, priorFiles, pageRulePacketSha256: pageRulesSha256, pageReasons: Object.fromEntries([...pageReasons].sort(([a], [b]) => a.localeCompare(b))), entries: eligible.map(r => ({ bank: r.bank, sourceHash: r.source.sourceHash, sourceFamilyId: r.source.familyId, ...labels.get(r.source.sku)! })) }),
  'development-support.json': jsonBytes({ authorityHash, counts, fieldStateCounts, classSupport: Object.fromEntries([...typeCounts].sort(([a], [b]) => a.localeCompare(b)).map(([id, c]) => [id, { rows: c.rows, families: c.families.size, twentyRowFloorMet: types.has(id) && c.rows >= 20 }])), status: 'not-qualified', blockers: ['No independent generation-specific development peer receipt yet', pageBlocker, 'Class floors apply to every evaluated class; absent/under-supported classes are not silently qualified', 'Sealed source custody is not labeled or qualified holdout gold', 'Fitted per-capability policies, live comparison and human canaries remain required'] }),
  'excluded-prior-identities.json': jsonBytes({ reason: 'previously public canonical product identity', sourceFiles: priorFiles, entries: excludedExposure.map(r => ({ bank: r.bank, sku: r.source.sku, familyId: r.source.familyId, canonicalUrl: r.source.canonicalUrl })) }),
  'duplicate-captures.json': jsonBytes({ selectionPolicy: 'Most complete captured source, then earliest retrieval, then SKU; no gold-based choice, fact merging or variant/family rekeying.', entries: [...duplicateOf].map(([sku, retainedSku]) => ({ sku, retainedSku, canonicalUrl: allSources.get(sku)!.source.canonicalUrl, productIdentity: allSources.get(sku)!.source.productIdentity, familyId: allSources.get(sku)!.source.familyId })) }),
};
outputs['development-manifest.json'] = jsonBytes({ authorityHash, binding: authority.binding, scope: 'source-adjudicated-expansion-development-only', entries: [], entriesSemantics: 'Development gold is the sole entry source, declared and SHA-bound below; no holdout membership is public.', counts, enrichmentOverlay: enrichmentEvidenceSha256 === null ? null : { enrichmentEvidenceSha256, entries: enrichmentOverlay }, declaredInputs: Object.fromEntries(Object.entries(outputs).map(([file, bytes]) => [file, { path: file, sha256: sha256(bytes) }])) });
const out = bindPublicOutput(values.out!);
if (values.write) {
  const existing = Object.keys(outputs).filter(file => fs.existsSync(path.join(out, file)));
  if (existing.length) throw new Error(`sealed_artifacts_exist: immutable generation already contains ${existing.join(', ')}`);
  fs.mkdirSync(out, { recursive: true });
  const realOut = fs.realpathSync(out);
  assertNoHoldoutAccess(realOut);
  if (realOut !== out) throw new Error('output_binding_changed: output directory moved after binding');
  for (const [file, bytes] of Object.entries(outputs)) fs.writeFileSync(path.join(realOut, file), bytes, { flag: 'wx' });
}
console.log(JSON.stringify({ mode: values.write ? 'write' : 'dry-run', authorityHash, counts, sourceFilesVerified: sourceFiles.length, outputDirectory: path.relative(process.cwd(), out), containmentFindings: 0, privateHoldoutRead: false, peerReceiptAuthored: false }, null, 2));
