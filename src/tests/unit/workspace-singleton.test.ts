// story: e08s01 — singleton workspace guard fail-closed on >1
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAll = vi.fn();

vi.mock('@/db/connection', () => ({
  getDb: () => ({
    query: () => ({ all: mockAll }),
  }),
}));

import { getServerSingletonWorkspace, MultipleWorkspacesError } from '../../db/repositories/workspace-singleton';

describe('workspace-singleton', () => {
  beforeEach(() => mockAll.mockReset());

  it('returns null when no workspace', () => {
    mockAll.mockReturnValue([]);
    expect(getServerSingletonWorkspace()).toBeNull();
  });

  it('returns singleton when exactly one', () => {
    mockAll.mockReturnValue([{ id: 'ws1', name: 'a', workspace_path: '/tmp', git_path: '', created_at: '2026-01-01', updated_at: '2026-01-01', bootstrap_status: 'complete', baseline_commit: null }]);
    const ws = getServerSingletonWorkspace();
    expect(ws?.id).toBe('ws1');
  });

  it('throws MultipleWorkspacesError when >1', () => {
    mockAll.mockReturnValue([
      { id: 'ws1', name: 'a', workspace_path: '/a', git_path: '', created_at: '2026-01-01', updated_at: '2026-01-01', bootstrap_status: 'complete', baseline_commit: null },
      { id: 'ws2', name: 'b', workspace_path: '/b', git_path: '', created_at: '2026-01-02', updated_at: '2026-01-02', bootstrap_status: 'complete', baseline_commit: null },
    ]);
    expect(() => getServerSingletonWorkspace()).toThrow(MultipleWorkspacesError);
  });
});
