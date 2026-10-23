import { z } from 'zod';

export const securitySettingsUpdateSchema = z.object({
  releaseAdminEnabled: z.boolean(),
}).strict();
export const securitySettingsResponseSchema = z.object({
  tokenConfigured: z.boolean(),
  tokenMask: z.string().nullable(),
  releaseAdminEnabled: z.boolean(),
  apiTokenSource: z.enum(['environment', 'database', 'unset']),
  releaseAdminSource: z.enum(['environment', 'database']),
});
