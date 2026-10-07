/** Opt-in public-development comparison. Credentials exist only in process memory. */
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { initDb, closeDb } from '../src/db/connection';
import { runMigrations } from '../src/db/migrations';
import { getProviderConnection, upsertProviderConnection } from '../src/db/repositories/provider-connection-repo';
import { loadDevReplayInputs, createDevAttemptGuard, defaultDevReplayBudget, planDevReplayBudget, dryRunBudgetPreflight, assertNoHoldoutAccess } from '../src/classification/jev-benchmark-replay';
import { captureQualificationPredictionsLive, withFrozenAuthorityDetails, parseQualificationGoldOnly, frozenAuthorityDetailsHash, hashDevReplaySourceInputs, assertQualificationArtifactIntegrity, type QualificationPredictionArtifact, type QualificationGoldOnlyEntry } from '../src/classification/benchmark-prediction';
import { evaluateJevOfflineComparison } from '../src/classification/jev-qualification-service';
import { sha256Hex } from '../src/shared/stable-id';

const root = path.resolve(import.meta.dir, '..');
const value = (flag: string) => process.argv.find(argument => argument.startsWith(`${flag}=`))?.slice(flag.length + 1);
const directory = path.resolve(root, value('--directory') ?? 'docs/audits/jev-representative-v4');
assertNoHoldoutAccess(directory);
const inputs = loadDevReplayInputs({
  manifestPath: path.join(directory, 'development-manifest-v8.json'),
  goldPath: path.join(directory, 'development-gold-v8.json'),
  taxonomyPath: path.join(directory, 'taxonomy.json'),
});
const model = value('--model') ?? 'deepseek-flash';
const budget = defaultDevReplayBudget();
const candidatePlan = planDevReplayBudget(inputs.goldEntries, inputs.frozenSnapshot);
const comparatorPlan = inputs.goldEntries.length * 2 *
  (1 + inputs.frozenSnapshot.attributeTargets.length + (inputs.frozenSnapshot.pages.length > 0 ? 1 : 0));
for (const plannedHttpAttempts of [candidatePlan.plannedHttpAttempts, comparatorPlan]) {
  const preflight = dryRunBudgetPreflight({ entryCount: inputs.goldEntries.length, plannedHttpAttempts, budget });
  if (!preflight.allowed) throw new Error(preflight.reason);
}
const plan = { comparisonRole: 'secondary_comparator', provider: 'deepseek-cloud', model,
  entries: inputs.goldEntries.length, authorityHash: inputs.authorityDetails.authorityHash,
  candidateWorstCaseAttempts: candidatePlan.plannedHttpAttempts, comparatorWorstCaseAttempts: comparatorPlan,
  perLegBudget: budget, historicalIncumbentComparison: false, qualificationEligible: false };
const rescore = value('--rescore');
if (!process.argv.includes('--live') && !rescore) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}
const output = value('--out');
if (!output) throw new Error('Comparison requires a new --out=<json> artifact path.');
assertNoHoldoutAccess(output);
assertNoHoldoutAccess(path.dirname(output));
if (fs.existsSync(output) || !fs.existsSync(path.dirname(output))) throw new Error('Comparison output must be new with an existing public parent.');

function evaluateArtifact(artifact: QualificationPredictionArtifact, entries: QualificationGoldOnlyEntry[]) {
  assertQualificationArtifactIntegrity(artifact, withFrozenAuthorityDetails(inputs.frozenSnapshot, inputs.authorityDetails), entries);
  if (artifact.authorityHash !== inputs.authorityDetails.authorityHash ||
      artifact.authorityDetailsHash !== frozenAuthorityDetailsHash(inputs.authorityDetails) ||
      artifact.frozenTaxonomyHash !== inputs.frozenSnapshot.snapshotHash) {
    throw new Error('Captured comparison does not match frozen authority.');
  }
  const predictions = new Map(artifact.predictions.map(prediction => [prediction.sku, prediction]));
  if (predictions.size !== inputs.goldEntries.length || predictions.size !== artifact.predictions.length ||
      artifact.entryCount !== inputs.goldEntries.length || inputs.goldEntries.some(entry => !predictions.has(entry.sku))) {
    throw new Error('Captured comparison has different or duplicate input identities.');
  }
  const authority = JSON.parse(fs.readFileSync(path.join(directory, 'taxonomy.json'), 'utf8'));
  return evaluateJevOfflineComparison({ version: 1, description: 'DeepSeek secondary comparison, not historical incumbent qualification',
    adjudicatedBy: 'independently-peer-reviewed-agent-gold-not-human-approval', frozenTaxonomy: inputs.frozenSnapshot,
    verifiedPageImport: { importId: authority.binding.pageImportId, importHash: authority.binding.pageImportHash,
      provenance: 'frozen verified ShopSite Page import; no Page gold is complete' },
    entries: inputs.goldEntries.map(entry => ({ ...entry, ...predictions.get(entry.sku)! })) }, 'dev');
}

if (rescore) {
  if (process.argv.includes('--live')) throw new Error('Rescoring cannot enable live capture.');
  const captureGold = value('--capture-gold');
  if (!captureGold) throw new Error('Rescoring requires the preserved --capture-gold=<json> revision.');
  for (const inputPath of [rescore, captureGold]) assertNoHoldoutAccess(inputPath);
  const originalBytes = fs.readFileSync(rescore, 'utf8');
  const original = JSON.parse(originalBytes);
  if (original.comparisonRole !== plan.comparisonRole || original.provider !== plan.provider || original.model !== model) {
    throw new Error('Rescoring requires the explicitly selected secondary comparator.');
  }
  const committedSourceInputsHash: unknown = original.artifact?.sourceInputsHash ?? original.sourceInputsHash ?? null;
  if (typeof committedSourceInputsHash !== 'string' || committedSourceInputsHash.length === 0) {
    throw new Error('Rescoring requires a capture-time source-input commitment (legacy capture: rerun live capture).');
  }
  if (typeof original.artifact?.artifactHash !== 'string' || original.artifact.artifactHash.length === 0) {
    throw new Error('Rescoring requires the bound capture artifact identity.');
  }
  const priorBytes = fs.readFileSync(captureGold, 'utf8');
  const priorEntries = parseQualificationGoldOnly(JSON.parse(priorBytes));
  const currentSourceInputsHash = hashDevReplaySourceInputs(inputs.goldEntries, inputs.frozenSnapshot, inputs.authorityDetails);
  const priorSourceInputsHash = hashDevReplaySourceInputs(priorEntries, inputs.frozenSnapshot, inputs.authorityDetails);
  if (priorSourceInputsHash !== committedSourceInputsHash || currentSourceInputsHash !== committedSourceInputsHash) {
    throw new Error('Rescoring cannot reuse predictions for changed source inputs.');
  }
  // Bound-identity check (P1-1): the envelope commitment must match the
  // commitment bound inside the artifact. A recomputed commitment swapped
  // into one layer but not the other is rejected here; a swap into both
  // layers still fails because the stored `artifactHash` stays bound to the
  // original commitment (re-verified by `evaluateArtifact` below).
  if (original.artifact.sourceInputsHash !== committedSourceInputsHash) {
    throw new Error('Rescoring cannot reuse predictions for changed source inputs.');
  }
  const result = { ...plan, sourceCapture: rescore, sourceCaptureSha256: sha256Hex(originalBytes),
    sourceArtifactHash: original.artifact.artifactHash, captureGoldSha256: sha256Hex(priorBytes),
    evaluatedGoldSha256: sha256Hex(fs.readFileSync(path.join(directory, 'development-gold-v8.json'), 'utf8')),
    sourceInputsHash: committedSourceInputsHash, sourceInputsUnchanged: true, predictionsUnchanged: true, additionalModelRequests: 0,
    report: evaluateArtifact(original.artifact, inputs.goldEntries), candidateAudit: original.candidateAudit, comparatorAudit: original.comparatorAudit,
    pageCohortContext: 'isolated_single_choice_approximation', policiesPublishedBeforeHoldout: false, holdoutInference: false };
  fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ output, artifactHash: result.sourceArtifactHash, additionalModelRequests: 0 }, null, 2));
  process.exit(0);
}
const source = new Database(path.join(root, 'storage/catalog/.shopsite-cms/app.db'), { readonly: true, create: false });
source.exec('PRAGMA query_only = ON');
const connection = getProviderConnection('deepseek-cloud', source);
source.close();
if (!connection?.enabled || !connection.credential || connection.transport !== 'openai-compatible') {
  throw new Error('The explicitly selected DeepSeek connection is unavailable.');
}
if (!process.env.TYPESAFE_API_KEY) throw new Error('Jev credential is not provisioned.');
const candidateGuard = createDevAttemptGuard(budget);
const comparatorGuard = createDevAttemptGuard(budget);
try {
  initDb(':memory:');
  runMigrations();
  upsertProviderConnection(connection);
  const artifact = await captureQualificationPredictionsLive(inputs.goldEntries, {
    jev: { apiKey: process.env.TYPESAFE_API_KEY, model: 'jev-1.13.0' },
    baselineRoute: { provider: connection.id, model, credentialRef: `provider_connections:${connection.id}`, isolatedStore: ':memory:' },
    attemptBudget: candidateGuard, deadlineSignal: candidateGuard.signal,
    baselineAttemptBudget: comparatorGuard, baselineDeadlineSignal: comparatorGuard.signal,
  }, withFrozenAuthorityDetails(inputs.frozenSnapshot, inputs.authorityDetails));
  const report = evaluateArtifact(artifact, inputs.goldEntries);
  const result = { ...plan, artifact, report, candidateAudit: candidateGuard.audit(), comparatorAudit: comparatorGuard.audit(),
    evaluatedGoldSha256: sha256Hex(fs.readFileSync(path.join(directory, 'development-gold-v8.json'), 'utf8')),
    sourceDatabaseReadonly: true, evaluationDatabase: ':memory:', credentialsPersisted: false,
    pageCohortContext: 'isolated_single_choice_approximation', policiesPublishedBeforeHoldout: false, holdoutInference: false };
  fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ ...plan, artifactHash: artifact.artifactHash,
    candidateAudit: result.candidateAudit, comparatorAudit: result.comparatorAudit, output }, null, 2));
} finally {
  candidateGuard.dispose();
  comparatorGuard.dispose();
  closeDb();
}
