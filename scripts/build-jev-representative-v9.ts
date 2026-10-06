#!/usr/bin/env bun
/**
 * Build the bay-state-v9 representative development corpus (mechanical re-bind).
 *
 * Prerequisite: run the sanctioned generator first, which writes the new
 * authority payload into the same directory:
 *
 *   bun scripts/prepare-jev-benchmark.ts --workspace storage/catalog \
 *     --db storage/catalog/.shopsite-cms/app.db \
 *     --inventory docs/audits/jev-representative-v4/source-development.json \
 *     --write --out docs/audits/jev-representative-v9
 *
 * This script then re-binds the v8 dev-side custody artifacts to the freshly
 * generated authority and applies the owner-decided safety-toe-type
 * retirement. Labels, evidence, and citations are copied verbatim — only
 * authority bindings, hashes, counts, and the retired target change.
 *
 * NOT done here (custody step): the peer receipt. `development-peer-receipt.json`
 * hash-commits the gold; a replacement must be produced by the peer review
 * pass, never authored by the implementing agent.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const V4 = 'docs/audits/jev-representative-v4';
const V9 = 'docs/audits/jev-representative-v9';

interface AuthorityBinding {
  workspaceId?: string;
  release: string;
  authorityHash?: string;
  configHash: string;
  catalogGitCommit: string;
  capturedAt?: string;
  pageImportId?: string;
  pageImportHash?: string;
  taxonomy?: string;
  sourceBank?: string;
  [key: string]: unknown;
}
interface GeneratedManifest { authorityHash: string; binding: AuthorityBinding; entries: unknown[] }
interface GoldFieldAssignment { targetId: string; state: string }
interface GoldEntry { gold: { fieldAssignments: GoldFieldAssignment[] } }
interface GoldDoc {
  authorityHash: string;
  authorityBinding: AuthorityBinding;
  frozenConditionalInputs: unknown;
  qualificationTargetSet: { controlledAttributes: string[] };
  selectionPolicy: string;
  explicitFieldContract: Record<string, unknown> & { controlled9?: string[]; rule: string };
  entries: GoldEntry[];
}
interface SupportDoc {
  authorityHash: string;
  authorityBinding: AuthorityBinding;
  frozenConditionalInputs: unknown;
  fieldStateCounts: Record<string, number>;
  explicitFieldContract: unknown;
}
interface AdjudicationDoc { authorityHash: string; taxonomySourceHash: string; cardinalityLimitation: string }
interface CollectionManifestDoc { authorityHash: string; taxonomyPath: string; taxonomyFileHash: string }
interface DevManifestDoc { authorityHash: string; binding: AuthorityBinding; entries: unknown[]; entriesSemantics: string; scope: string; declaredInputs: Record<string, { path: string; sha256: string }> }

const sha256 = (bytes: Buffer | string): string => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = <T>(dir: string, file: string): T => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as T;
const write = (file: string, value: unknown): string => {
  const bytes = `${JSON.stringify(value, null, 1)}\n`;
  fs.writeFileSync(path.join(V9, file), bytes);
  return sha256(bytes);
};
const copyVerbatim = (file: string): { file: string; sha256: string } => {
  const bytes = fs.readFileSync(path.join(V4, file));
  fs.writeFileSync(path.join(V9, file), bytes);
  return { file, sha256: sha256(bytes) };
};

const generated = readJson<GeneratedManifest>(V9, 'manifest.json');
const authorityHash = generated.authorityHash;
const binding = generated.binding;
const RELEASE = binding.release;
if (RELEASE !== 'bay-state-v9') throw new Error(`expected a bay-state-v9 authority payload, found "${RELEASE}"`);

const authorityBinding: AuthorityBinding = {
  release: RELEASE,
  authorityHash,
  configHash: binding.configHash,
  catalogGitCommit: binding.catalogGitCommit,
  taxonomy: `${V9}/taxonomy.json`,
  sourceBank: `${V9}/source-development.json`,
};

// ── Verbatim copies first (content unchanged; hashes must stay stable) ─────
const sourceBank = copyVerbatim('source-development.json');
copyVerbatim('source-development-supplemental.json');
copyVerbatim('seeds.json');

// ── Gold: re-bind + retire safety-toe-type (owner decision 2026-10-06) ──────
const gold = readJson<GoldDoc>(V4, 'development-gold-v8.json');
gold.authorityHash = authorityHash;
gold.authorityBinding = authorityBinding;
gold.frozenConditionalInputs = {
  speciesCardinality: { defaultSingle: 'all-74-profiles' },
  configHash: binding.configHash,
  release: RELEASE,
};
gold.qualificationTargetSet.controlledAttributes = gold.qualificationTargetSet.controlledAttributes
  .filter(attributeId => attributeId !== 'safety-toe-type');
gold.selectionPolicy = gold.selectionPolicy.replace('all 9 controlled targets', 'all 8 controlled targets');

const goldContract = gold.explicitFieldContract;
goldContract.controlledAttributes = (goldContract.controlled9 ?? []).filter(attributeId => attributeId !== 'safety-toe-type');
delete goldContract.controlled9;
goldContract.rule = goldContract.rule.replace('all 9 inapplicable', 'all 8 inapplicable');

let retiredRows = 0;
for (const entry of gold.entries) {
  entry.gold.fieldAssignments = entry.gold.fieldAssignments.filter(field => {
    if (field.targetId !== 'safety-toe-type') return true;
    if (field.state !== 'inapplicable') {
      throw new Error('safety-toe-type row is not "inapplicable"; refusing to drop non-empty states.');
    }
    retiredRows += 1;
    return false;
  });
}
const goldSha = write('development-gold-v9.json', gold);

// ── Support: re-bind + matching counts/contract ─────────────────────────────
const support = readJson<SupportDoc>(V4, 'development-support-v8.json');
support.authorityHash = authorityHash;
support.authorityBinding = {
  ...authorityBinding,
  sourceBankSha256: sha256(fs.readFileSync(path.join(V9, 'source-development.json'))),
  supplemental: `${V9}/source-development-supplemental.json`,
  supplementalSha256: sha256(fs.readFileSync(path.join(V9, 'source-development-supplemental.json'))),
};
support.frozenConditionalInputs = {
  speciesCardinality: { defaultSingle: 'all-74-profiles' },
  configHash: binding.configHash,
  release: RELEASE,
};
support.fieldStateCounts = {
  ...support.fieldStateCounts,
  inapplicable: Number(support.fieldStateCounts.inapplicable) - retiredRows,
};
support.explicitFieldContract = goldContract;
const supportSha = write('development-support-v9.json', support);

// ── Adjudication: re-bind (labels/citations verbatim) ──────────────────────
const adjudication = readJson<AdjudicationDoc>(V4, 'development-adjudication-v8.json');
adjudication.authorityHash = authorityHash;
adjudication.taxonomySourceHash = binding.configHash;
adjudication.cardinalityLimitation = 'Frozen single everywhere (74 profiles) after the v9 species-cardinality normalization.';
const adjudicationSha = write('development-adjudication-v9.json', adjudication);

// ── Collection manifest: re-bind + new taxonomy bytes hash ─────────────────
const collectionManifest = readJson<CollectionManifestDoc>(V4, 'collection-manifest.json');
collectionManifest.authorityHash = authorityHash;
collectionManifest.taxonomyPath = `${V9}/taxonomy.json`;
collectionManifest.taxonomyFileHash = sha256(fs.readFileSync(path.join(V9, 'taxonomy.json')));
write('collection-manifest.json', collectionManifest);

// ── Development manifest (dev-replay shape, v9 bindings) ───────────────────
const v8Manifest = readJson<DevManifestDoc>(V4, 'development-manifest-v8.json');
const developmentManifest: DevManifestDoc = {
  authorityHash,
  binding: {
    workspaceId: binding.workspaceId,
    release: RELEASE,
    catalogGitCommit: binding.catalogGitCommit,
    configHash: binding.configHash,
    capturedAt: binding.capturedAt,
    pageImportId: binding.pageImportId,
    pageImportHash: binding.pageImportHash,
  },
  entries: [],
  entriesSemantics: v8Manifest.entriesSemantics.replace(/development-gold-v8\.json/g, 'development-gold-v9.json'),
  scope: 'fresh-development-v9-v4',
  declaredInputs: {
    devGold: { path: 'development-gold-v9.json', sha256: goldSha },
    devAdjudication: { path: 'development-adjudication-v9.json', sha256: adjudicationSha },
    devSupport: { path: 'development-support-v9.json', sha256: supportSha },
    taxonomy: { path: 'taxonomy.json', sha256: sha256(fs.readFileSync(path.join(V9, 'taxonomy.json'))) },
    sourceBank: { path: sourceBank.file, sha256: sourceBank.sha256 },
  },
};
write('development-manifest-v9.json', developmentManifest);

console.log(JSON.stringify({
  authorityHash,
  release: RELEASE,
  configHash: binding.configHash,
  retiredSafetyToeRows: retiredRows,
  goldSha,
  adjudicationSha,
  supportSha,
  corpusDir: V9,
}, null, 2));
