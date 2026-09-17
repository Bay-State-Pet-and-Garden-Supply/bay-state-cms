import { describe, it, expect } from 'bun:test';
import { WORKSPACE_TABS, workspaceTabForCategory, getWorkspaceTab } from '../../client/components/onboarding/batch-workspace-logic';

describe('approval/export UI split (M4 / P1-D)', () => {
  it('has separate tabs for Approved and Ready to Export (no combined queue)', () => {
    const ids = WORKSPACE_TABS.map(t => t.id);
    expect(ids).toContain('approved');
    expect(ids).toContain('ready_to_export');
    expect(ids.length).toBe(6);
  });

  it('approved tab counts only approved, ready_to_export counts ready_to_export+completed', () => {
    const approved = getWorkspaceTab('approved');
    const ready = getWorkspaceTab('ready_to_export');
    expect(approved.countCategories).toEqual(['approved']);
    expect(ready.countCategories).toEqual(['ready_to_export', 'completed']);
    expect(approved.countCategories).not.toContain('ready_to_export');
  });

  it('workspaceTabForCategory maps ready_to_export to ready_to_export tab, not approved', () => {
    expect(workspaceTabForCategory('approved')).toBe('approved');
    expect(workspaceTabForCategory('ready_to_export')).toBe('ready_to_export');
    expect(workspaceTabForCategory('completed')).toBe('ready_to_export');
    expect(workspaceTabForCategory('ready_to_export')).not.toBe('approved');
  });

  it('labels are distinct', () => {
    const approved = getWorkspaceTab('approved');
    const ready = getWorkspaceTab('ready_to_export');
    expect(approved.label).toBe('Approved');
    expect(ready.label).toBe('Ready to Export');
    expect(approved.label).not.toBe(ready.label);
  });

  it('tabs have distinct empty messages', () => {
    const approved = getWorkspaceTab('approved');
    const ready = getWorkspaceTab('ready_to_export');
    expect(approved.emptyMessage).not.toBe(ready.emptyMessage);
  });
});
