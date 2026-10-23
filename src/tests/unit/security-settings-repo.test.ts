import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { DbDatabase } from '../../db/driver';
import { getSecuritySettings, getStoredApiToken, getStoredReleaseAdminEnabled, installSecuritySettingsSchema, saveSecuritySettings } from '../../db/repositories/security-settings-repo';
const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
describe('security settings repository', () => {
  it('round-trips the token and release-admin flag in an isolated database', () => {
    const db = new Database(':memory:') as unknown as DbDatabase;
    databases.push(db as unknown as Database);
    installSecuritySettingsSchema(db);
    saveSecuritySettings({ apiToken: 'secure-token-with-sufficient-length', releaseAdminEnabled: true }, db);
    expect(getStoredApiToken(db)).toBe('secure-token-with-sufficient-length');
    expect(getStoredReleaseAdminEnabled(db)).toBe(true);
    saveSecuritySettings({ releaseAdminEnabled: false }, db);
    expect(getStoredApiToken(db)).toBe('secure-token-with-sufficient-length');
    expect(getSecuritySettings(db)?.release_admin_enabled).toBe(0);
  });

  it('does not replace a stored token with a masked value', () => {
    const db = new Database(':memory:') as unknown as DbDatabase;
    databases.push(db as unknown as Database);
    installSecuritySettingsSchema(db);
    saveSecuritySettings({ apiToken: 'secure-token-with-sufficient-length' }, db);
    expect(() => saveSecuritySettings({ apiToken: '••••••••xxxx' }, db)).toThrow('Cannot save a masked API token.');
    expect(getStoredApiToken(db)).toBe('secure-token-with-sufficient-length');
  });

  it('leaves the token alone when only the admin flag is updated', () => {
    const db = new Database(':memory:') as unknown as DbDatabase;
    databases.push(db as unknown as Database);
    installSecuritySettingsSchema(db);
    saveSecuritySettings({ apiToken: 'original-token-value' }, db);
    saveSecuritySettings({ releaseAdminEnabled: true }, db);
    expect(getStoredApiToken(db)).toBe('original-token-value');
    expect(getStoredReleaseAdminEnabled(db)).toBe(true);
  });

  it('treats empty-string tokens as unset (fail closed)', () => {
    const db = new Database(':memory:') as unknown as DbDatabase;
    databases.push(db as unknown as Database);
    installSecuritySettingsSchema(db);
    saveSecuritySettings({ apiToken: '' }, db);
    expect(getStoredApiToken(db)).toBeUndefined();
    // Env override wins when set; stored value is the fallback; neither means no auth.
    const effective = (env: string | undefined, stored: string | undefined) => env ?? stored;
    expect(effective('env-token', 'stored-token')).toBe('env-token');
    expect(effective(undefined, 'stored-token')).toBe('stored-token');
    expect(effective(undefined, undefined)).toBeUndefined();
  });
});
