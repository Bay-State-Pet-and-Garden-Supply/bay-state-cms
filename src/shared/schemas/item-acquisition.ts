import { z } from 'zod';

const NonnegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const PositiveIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** Finite cumulative ceilings; null monetary caps mean no requested cost ceiling, never zero price. */
export const ItemAcquisitionLimitsSchema = z.object({
  attempts: NonnegativeIntegerSchema,
  pages: NonnegativeIntegerSchema,
  actions: NonnegativeIntegerSchema,
  redirects: NonnegativeIntegerSchema,
  bytes: NonnegativeIntegerSchema,
  artifacts: NonnegativeIntegerSchema,
  durationMs: PositiveIntegerSchema,
  inputTokens: NonnegativeIntegerSchema,
  outputTokens: NonnegativeIntegerSchema,
  maxConcurrent: PositiveIntegerSchema,
  maxCostMicros: NonnegativeIntegerSchema.nullable(),
}).strict();
export type ItemAcquisitionLimits = z.infer<typeof ItemAcquisitionLimitsSchema>;

export const ItemAcquisitionModelPriceSchema = z.object({
  provider: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(128),
  maxRequestBytes: PositiveIntegerSchema,
  maxResponseBytesPerAttempt: PositiveIntegerSchema,
  maxInputTokensPerAttempt: PositiveIntegerSchema,
  maxOutputTokensPerAttempt: PositiveIntegerSchema,
  /** True only when the request adapter can enforce the output token limit before dispatch. */
  outputLimit: z.enum(['max_tokens', 'unsupported']),
  inputMicrosPerMillionTokens: NonnegativeIntegerSchema.nullable(),
  outputMicrosPerMillionTokens: NonnegativeIntegerSchema.nullable(),
}).strict();
export type ItemAcquisitionModelPrice = z.infer<typeof ItemAcquisitionModelPriceSchema>;

export const ItemAcquisitionServicePriceSchema = z.object({
  service: z.enum(['brave_search', 'browser']),
  /** Price for each externally dispatched attempt, null means unknown (not free). */
  costMicrosPerAttempt: NonnegativeIntegerSchema.nullable(),
}).strict();
export type ItemAcquisitionServicePrice = z.infer<typeof ItemAcquisitionServicePriceSchema>;

/** Explicitly reviewed policy; every resource ceiling is supplied, never defaulted. */
export const ItemAcquisitionPolicySchema = z.object({
  recordVersion: z.literal(1),
  enabled: z.boolean(),
  itemLimits: ItemAcquisitionLimitsSchema,
  batchLimits: ItemAcquisitionLimitsSchema,
  models: z.array(ItemAcquisitionModelPriceSchema),
  services: z.array(ItemAcquisitionServicePriceSchema),
}).strict().superRefine((policy, ctx) => {
  const models = new Set<string>();
  for (const [index, model] of policy.models.entries()) {
    const key = `${model.provider}\0${model.model}`;
    if (models.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['models', index], message: 'Duplicate provider/model pricing entry.' });
    models.add(key);
  }
  const services = new Set<string>();
  for (const [index, service] of policy.services.entries()) {
    if (services.has(service.service)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['services', index], message: 'Duplicate service pricing entry.' });
    services.add(service.service);
  }
});
export type ItemAcquisitionPolicy = z.infer<typeof ItemAcquisitionPolicySchema>;

export const ItemAcquisitionPolicyDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  policy: ItemAcquisitionPolicySchema,
  approvedBy: z.string().trim().min(1).max(256),
  approvedAt: z.string().datetime({ offset: true }),
}).strict();
export type ItemAcquisitionPolicyDocument = z.infer<typeof ItemAcquisitionPolicyDocumentSchema>;

