import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { getSecuritySettings, saveSecuritySettings } from '../../db/repositories/security-settings-repo';
import { securitySettingsUpdateSchema } from '../../shared/schemas/security-settings';

const securityRoutes = new Hono();

function securityStatus() {
  const stored = getSecuritySettings();
  const envToken = process.env.BAYSTATE_CMS_API_TOKEN;
  const envAdmin = process.env.BAYSTATE_CMS_RELEASE_ADMIN_ENABLED;
  const envAdminConfigured = envAdmin !== undefined;
  const effectiveToken = envToken ?? stored?.api_token ?? null;
  const effectiveAdmin = envAdminConfigured
    ? ['1', 'true', 'on'].includes(envAdmin.trim().toLowerCase())
    : stored?.release_admin_enabled === 1;
  return {
    tokenConfigured: Boolean(effectiveToken),
    tokenMask: effectiveToken ? `••••••••${effectiveToken.slice(-4)}` : null,
    releaseAdminEnabled: effectiveAdmin,
    apiTokenSource: envToken !== undefined ? 'environment' as const : stored?.api_token ? 'database' as const : 'unset' as const,
    releaseAdminSource: envAdminConfigured ? 'environment' as const : 'database' as const,
  };
}

securityRoutes.post('/settings/security/token', (c) => {
  // Generating a stored token while the environment override is active would
  // produce a credential that can never authenticate: both authorization
  // gates prefer the env token. Refuse loudly instead of minting a dead token.
  if (process.env.BAYSTATE_CMS_API_TOKEN !== undefined) {
    return c.json(
      {
        error: 'API token is managed by the BAYSTATE_CMS_API_TOKEN environment variable. Unset it to manage the token here.',
        code: 'environment_token_active',
      },
      409,
    );
  }
  const apiToken = randomBytes(32).toString('base64url');
  saveSecuritySettings({ apiToken });
  return c.json({ ...securityStatus(), generatedToken: apiToken });
});

securityRoutes.get('/settings/security', (c) => c.json(securityStatus()));

securityRoutes.put('/settings/security', async (c) => {
  const parsed = securitySettingsUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid security settings.' }, 400);
  const { releaseAdminEnabled } = parsed.data;
  saveSecuritySettings({ releaseAdminEnabled });
  return c.json(securityStatus());
});

export default securityRoutes;
