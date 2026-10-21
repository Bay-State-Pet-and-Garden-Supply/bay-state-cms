import { Hono } from 'hono';
import { z } from 'zod';
import { derivePrincipal } from '../authenticated-principal';
import { requireServerSingletonWorkspace } from '../../db/repositories/workspace-singleton';
import { getApiKey, upsertApiKey, deleteApiKey } from '../../db/repositories/api-key-repo';
import {
  applyItemAcquisitionPolicy,
  previewItemAcquisitionPolicy,
  readItemAcquisitionPolicy,
} from '../../onboarding/item-acquisition-budget';
import { ItemAcquisitionPolicySchema } from '../../shared/schemas/item-acquisition';

export const itemAcquisitionRoutes = new Hono();

const PreviewInput = z.object({ policy: ItemAcquisitionPolicySchema }).strict();
const ApplyInput = z.object({
  policy: ItemAcquisitionPolicySchema,
  expectedDocumentHash: z.string().min(1).nullable(),
  expectedGitHead: z.string().min(1),
  expectedPolicyHash: z.string().min(1),
}).strict();
const CredentialInput = z.object({ apiKey: z.string().min(1).refine(value => value.trim().length > 0).nullable() }).strict();

function principal(c: { req: { header(name: string): string | undefined } }) { return derivePrincipal(c); }
function workspace(c: { json(body: unknown, status?: 400 | 401 | 403 | 404 | 409 | 422 | 503): Response }) {
  try { return { workspace: requireServerSingletonWorkspace(), response: null }; }
  catch { return { workspace: null, response: c.json({ code: 'workspace_unavailable' }, 503) }; }
}
function authorized(c: { req: { header(name: string): string | undefined }; json(body: unknown, status?: 400 | 401 | 403 | 404 | 409 | 422 | 503): Response }, mutation: boolean) {
  const user = principal(c);
  if (!user) return c.json({ code: 'unauthorized' }, 401);
  if (mutation && user.role !== 'catalog_approver' && user.role !== 'system') return c.json({ code: 'forbidden' }, 403);
  return user;
}

itemAcquisitionRoutes.get('/onboarding/item-acquisition/settings', (c) => {
  const user = authorized(c, false);
  if (user instanceof Response) return user;
  const scope = workspace(c);
  if (!scope.workspace) return scope.response!;
  try {
    const snapshot = readItemAcquisitionPolicy(scope.workspace.workspacePath);
    const credential = getApiKey('brave_search');
    return c.json({
      ...snapshot,
      hasCredential: Boolean(credential?.api_key),
      policyStatus: !snapshot.policy ? 'unconfigured' : snapshot.policy.enabled ? 'enabled' : 'disabled',
    });
  } catch {
    return c.json({ code: 'item_acquisition_settings_unavailable' }, 503);
  }
});

itemAcquisitionRoutes.post('/onboarding/item-acquisition/settings/preview', async (c) => {
  const user = authorized(c, true);
  if (user instanceof Response) return user;
  const scope = workspace(c);
  if (!scope.workspace) return scope.response!;
  const body = PreviewInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ code: 'invalid_item_acquisition_policy' }, 400);
  try {
    return c.json(previewItemAcquisitionPolicy({ workspacePath: scope.workspace.workspacePath, policy: body.data.policy }));
  } catch {
    return c.json({ code: 'invalid_item_acquisition_policy' }, 422);
  }
});

itemAcquisitionRoutes.post('/onboarding/item-acquisition/settings/apply', async (c) => {
  const user = authorized(c, true);
  if (user instanceof Response) return user;
  const scope = workspace(c);
  if (!scope.workspace) return scope.response!;
  const body = ApplyInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ code: 'invalid_item_acquisition_policy' }, 400);
  try {
    const result = await applyItemAcquisitionPolicy({
      workspacePath: scope.workspace.workspacePath,
      actor: user.actor,
      ...body.data,
    });
    return c.json(result);
  } catch (error) {
    const code = error instanceof Error && error.message === 'policy_conflict' ? 'policy_conflict' : 'item_acquisition_policy_apply_failed';
    return c.json({ code }, code === 'policy_conflict' ? 409 : 422);
  }
});

itemAcquisitionRoutes.post('/onboarding/item-acquisition/credential', async (c) => {
  const user = authorized(c, true);
  if (user instanceof Response) return user;
  const body = CredentialInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ code: 'invalid_brave_search_credential' }, 400);
  try {
    if (body.data.apiKey === null) deleteApiKey('brave_search');
    else upsertApiKey('brave_search', body.data.apiKey);
    return c.json({ hasCredential: Boolean(getApiKey('brave_search')?.api_key) });
  } catch {
    return c.json({ code: 'brave_search_credential_update_failed' }, 422);
  }
});
