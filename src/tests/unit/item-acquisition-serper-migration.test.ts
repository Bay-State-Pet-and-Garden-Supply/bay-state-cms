/**
 * Brave→Serper credential migration guarantees.
 *
 * A Brave-issued secret must never become a Serper credential: the migration
 * drops the retired `brave_search` row instead of relabeling it, fabricates
 * no `serper_search` row, and repeated startups cannot resurrect a removed key.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../../db/connection';
import { getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { deleteApiKey, getApiKey, upsertApiKey } from '../../db/repositories/api-key-repo';

let tempDir: string;

function services(): string[] {
  return (getDb().query('SELECT service FROM api_keys').all() as Array<{ service: string }>)
    .map((row) => row.service);
}

describe('Brave to Serper credential migration', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'serper-migration-'));
    initDb(path.join(tempDir, 'fixture.sqlite'));
    runMigrations();
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('drops the retired Brave row without fabricating a Serper credential', () => {
    upsertApiKey('brave_search', 'brave-issued-secret');
    runMigrations();
    expect(services()).not.toContain('brave_search');
    expect(getApiKey('serper_search')).toBeFalsy();
  });

  it('leaves an operator-supplied Serper key untouched and still drops Brave', () => {
    upsertApiKey('serper_search', 'real-serper-key');
    upsertApiKey('brave_search', 'brave-issued-secret');
    runMigrations();
    expect(getApiKey('serper_search')?.api_key).toBe('real-serper-key');
    expect(services()).not.toContain('brave_search');
  });

  it('cannot resurrect a Serper key the operator removed', () => {
    upsertApiKey('brave_search', 'brave-issued-secret');
    runMigrations();
    upsertApiKey('serper_search', 'real-serper-key');
    deleteApiKey('serper_search');
    runMigrations();
    expect(getApiKey('serper_search')).toBeFalsy();
    expect(services()).not.toContain('brave_search');
  });
});
