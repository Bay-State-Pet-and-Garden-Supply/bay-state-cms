import { z } from 'zod';

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const CodePinSchema = z.object({ repository: z.string().min(1), revision: z.string().min(1) }).strict();
const PositiveLimitSchema = z.number().int().positive();

export const QualificationRuntimeLimitSchema = z.object({
  maxItems: PositiveLimitSchema,
  maxRuntimeMs: PositiveLimitSchema,
  maxSourceArtifacts: PositiveLimitSchema,
  maxResponseBytes: PositiveLimitSchema,
  maxModelCalls: z.number().int().nonnegative(),
}).strict();

export const QualificationArtifactSchema = z.object({
  path: z.string().min(1),
  sha256: Sha256Schema,
  role: z.enum(['workspace', 'catalog', 'config', 'activation', 'source_response', 'evidence']),
}).strict();

export const QualificationCredentialReferenceSchema = z.object({
  name: z.string().min(1),
  environmentKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
}).strict();

export const QualificationBillingReferenceSchema = z.object({
  provider: z.string().min(1),
  contractId: z.string().min(1),
  authorizationUsdMicros: z.number().int().nonnegative().max(3_000_000),
}).strict();

export const QualificationRuntimeRecordSchema = z.object({
  table: z.string().min(1),
  row: z.record(z.string(), z.unknown()),
}).strict();

export const QualificationRunSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  authorizationId: z.string().min(1),
  authorizedArms: z.array(z.enum(['baseline', 'candidate'])).min(1).max(2).refine(arms => new Set(arms).size === arms.length),
  mode: z.enum(['controlled_replay', 'live_operational']),
  population: z.object({
    split_payload_paths: z.object({ development: z.array(z.string().min(1)), holdout: z.array(z.string().min(1)) }).strict(),
  }).strict(),
  codePins: z.object({ baseline: CodePinSchema, candidate: CodePinSchema }).strict(),
  authorizationUsdMicros: z.number().int().nonnegative().max(3_000_000),
  artifacts: z.array(QualificationArtifactSchema).min(1),
  limits: QualificationRuntimeLimitSchema,
  credentialReferences: z.array(QualificationCredentialReferenceSchema),
  billingReferences: z.array(QualificationBillingReferenceSchema),
  identity: z.object({
    workspaceId: z.string().min(1),
    catalogCommit: z.string().min(1),
    configRelease: z.string().min(1),
    activationEvidenceId: z.string().min(1),
    routingHash: Sha256Schema,
    sharingHash: Sha256Schema,
    modelPolicyHash: Sha256Schema,
    domainStrategyHash: Sha256Schema,
    profileHash: Sha256Schema,
    catalogHash: Sha256Schema,
    configHash: Sha256Schema,
  }).strict(),
  runtimeRecords: z.array(QualificationRuntimeRecordSchema),
}).strict().superRefine((run, ctx) => {
  if (run.identity.workspaceId !== run.workspaceId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['identity', 'workspaceId'], message: 'Workspace identity must remain unchanged' });
  if (run.billingReferences.some(ref => ref.authorizationUsdMicros > run.authorizationUsdMicros)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['billingReferences'], message: 'Billing reference exceeds run authorization' });
  const credentialKeys = new Set<string>();
  for (const credential of run.credentialReferences) {
    if (credentialKeys.has(credential.environmentKey)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['credentialReferences'], message: 'Duplicate credential reference' });
    credentialKeys.add(credential.environmentKey);
  }
});

export type QualificationRun = z.infer<typeof QualificationRunSchema>;
export type QualificationArtifact = z.infer<typeof QualificationArtifactSchema>;
export type QualificationRuntimeRecord = z.infer<typeof QualificationRuntimeRecordSchema>;
