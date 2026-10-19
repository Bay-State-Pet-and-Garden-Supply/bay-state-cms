import { describe, expect, it } from 'bun:test';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import {
  isSkuQuarantined,
  listActiveQuarantinedSkus,
  quarantineSku,
  resolveSkuQuarantine,
} from '../../db/repositories/sku-quarantine-repo';

describe('SKU quarantine repository (P0 #5)', () => {
  it('quarantines, lists, and resolves a duplicate SKU', () => {
    initDb(':memory:');
    runMigrations();
    const now = new Date().toISOString();
    insertWorkspace({
      id: 'ws-quarantine',
      name: 'quarantine',
      workspacePath: '/tmp/quarantine',
      gitPath: '',
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });

    expect(isSkuQuarantined('ws-quarantine', 'DUP-1')).toBe(false);
    quarantineSku('ws-quarantine', 'DUP-1', 'duplicate live SKU', '{"twins":["twin-a","twin-b"]}');
    expect(isSkuQuarantined('ws-quarantine', 'DUP-1')).toBe(true);
    expect(listActiveQuarantinedSkus('ws-quarantine').map(row => row.sku)).toEqual(['DUP-1']);
    resolveSkuQuarantine('ws-quarantine', 'DUP-1');
    expect(isSkuQuarantined('ws-quarantine', 'DUP-1')).toBe(false);
    expect(listActiveQuarantinedSkus('ws-quarantine')).toEqual([]);
  });
});
