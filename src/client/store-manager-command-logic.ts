/**
 * Store Manager command/scope/preferences pure client derivation (operations
 * console, Issue 2).
 *
 * All new client-side logic lives here (NOT in the dirty store-manager-logic.ts):
 * palette filtering, command argument completions, plan-preview view models,
 * command-result formatting, and scope labels. Everything is deterministic
 * and import-free of React — easy to unit test.
 */

import type {
  StoreManagerCommandDescriptor,
  StoreManagerCommandResult,
  StoreManagerPreviewDescriptor,
  StoreManagerResolvedScope,
} from './store-manager-api';

/** True when the input looks like a slash command. */
export function isCommandInput(input: string): boolean {
  return input.trim().startsWith('/');
}

/** Extract the leading command token (e.g. "/audit" from "/audit ProductField24"). */
export function commandToken(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return '';
  return trimmed.split(/\s+/)[0] ?? '';
}

/** Match commands by name/alias/description for the palette list. */
export function filterStoreManagerCommands(
  commands: StoreManagerCommandDescriptor[],
  query: string,
): StoreManagerCommandDescriptor[] {
  const token = commandToken(query).replace(/^\/+/, '').toLowerCase();
  if (!token) return commands;
  return commands.filter((cmd) => {
    if (cmd.name.toLowerCase().startsWith(token)) return true;
    if (cmd.aliases.some((a) => a.toLowerCase().startsWith(token))) return true;
    return cmd.description.toLowerCase().includes(token);
  });
}

/** Find the exact command for a token (or alias). */
export function findStoreManagerCommand(
  commands: StoreManagerCommandDescriptor[],
  token: string,
): StoreManagerCommandDescriptor | undefined {
  const normalized = token.replace(/^\/+/, '').toLowerCase();
  return commands.find(
    (cmd) => cmd.name.toLowerCase() === normalized || cmd.aliases.some((a) => a.toLowerCase() === normalized),
  );
}

/** Argument completions for a partially typed command (server-sourced). */
export function argumentCompletions(
  command: StoreManagerCommandDescriptor,
  input: string,
): string[] {
  const afterToken = input.trim().slice(commandToken(input).length).trim();
  if (!command.argSpecs[0]) return [];
  const spec = command.argSpecs[0];
  const candidates = spec.suggestions ?? spec.options ?? [];
  if (!afterToken) return candidates.slice(0, 10);
  const lower = afterToken.toLowerCase();
  return candidates.filter((c) => c.toLowerCase().startsWith(lower)).slice(0, 10);
}

/** True when a command needs an argument before it can execute. */
export function commandNeedsArgument(command: StoreManagerCommandDescriptor): boolean {
  return command.argSpecs.some((a) => a.required);
}

/** Command line prefilled for argument entry (e.g. "/audit "). */
export function prefillCommand(command: StoreManagerCommandDescriptor): string {
  return `/${command.name} `;
}

/** Bounded text summary for a command result (never raw unbounded content). */
export function summarizeCommandResult(result: StoreManagerCommandResult): string {
  const text = (result.text ?? '').trim();
  const lines: string[] = [];
  if (text) lines.push(text.slice(0, 4000));
  for (const t of result.toolResults.slice(0, 20)) {
    if (t.status === 'ok') {
      const out = t.output === undefined || t.output === null ? '' : JSON.stringify(t.output);
      lines.push(`• ${t.toolName}: ${String(out ?? '').slice(0, 500)}`);
    } else if (t.status === 'denied') {
      lines.push(`• ${t.toolName}: denied`);
    } else {
      lines.push(`• ${t.toolName}: ${(t.errorText ?? 'error').slice(0, 300)}`);
    }
  }
  if (lines.length === 0) return 'Command completed with no textual output.';
  return lines.join('\n');
}

export const RISK_LABELS: Record<string, string> = {
  read: 'Read (no side effects)',
  proposal_write: 'Persistent proposal write',
  catalog_mutation: 'Catalog / Change Set mutation',
  network_filesystem_repair: 'Network + filesystem repair',
};

/** View-model rows for the PlanPreview component (contract-derived). */
export function buildPlanPreviewRows(preview: StoreManagerPreviewDescriptor): Array<{
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'danger';
}> {
  const rows: Array<{ label: string; value: string; tone?: 'ok' | 'warn' | 'danger' }> = [];
  rows.push({ label: 'Entrypoint', value: `${preview.entrypoint} · ${preview.executionMode}` });
  rows.push({ label: 'Expected tools', value: String(preview.expectedTools.length) });
  const approvals = preview.expectedApprovals.map((a) => `${a.toolName} v${a.toolVersion}`).join(', ');
  rows.push({
    label: 'Approval checkpoints',
    value: approvals || (preview.persistentToolsDenied ? 'none (persistent tools denied)' : 'none'),
    tone: preview.expectedApprovals.length > 0 ? 'warn' : 'ok',
  });
  rows.push({
    label: 'Network activity',
    value: preview.networkActivity === 'none' ? 'none' : 'bounded (contract-derived estimate)',
    tone: preview.networkActivity === 'bounded' ? 'warn' : 'ok',
  });
  rows.push({ label: 'Max tool calls', value: String(preview.budgets.maxToolCalls) });
  rows.push({ label: 'Deadline', value: `${Math.round(preview.budgets.deadlineMs / 1000)}s` });
  rows.push({
    label: 'Max model cost',
    value: `$${preview.budgets.maxModelCostUsd.toFixed(2)}`,
  });
  rows.push({
    label: 'Scope',
    value: preview.scopeHash ? 'pinned' : 'whole catalog',
  });
  if (preview.persistentToolsDenied) {
    rows.push({
      label: 'Persistent actions',
      value: 'denied in this mode',
      tone: 'danger',
    });
  }
  return rows;
}

/** Human-readable scope label for the pin chip. */
export function formatScopeLabel(scope: StoreManagerResolvedScope | null): string | null {
  if (!scope) return null;
  switch (scope.resolved.kind) {
    case 'product_field':
      return 'One product detail';
    case 'change_set':
      return 'Saved product changes';
    case 'sku_set': {
      const count = scope.resolved.itemCount ?? 0;
      return `${count} selected product${count === 1 ? '' : 's'}`;
    }
    case 'onboarding_batch':
      return 'Products from one import';
    default:
      return null;
  }
}

/** Compact scope descriptors for the pin form. */
export const SCOPE_KIND_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'product_field', label: 'A product detail' },
  { value: 'sku_set', label: 'Selected products' },
];

/** Bound text (deterministic truncation). */
export function truncateText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** Format a saved-preference revision for the Settings panel header. */
export function formatPreferenceRevision(revision: { version: number; createdAt: string } | null): string {
  if (!revision) return 'No saved preferences.';
  return `Revision v${revision.version} · ${new Date(revision.createdAt).toLocaleString()}`;
}
