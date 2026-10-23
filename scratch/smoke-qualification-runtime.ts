import { resolve } from 'node:path';
import { materializeQualificationRuntime } from './comparison-runtime';

/** Offline-only: caller supplies a committed test-authority fixture, never a production workspace. */
export async function smokeQualificationRuntime(args: readonly string[]): Promise<void> {
  if (args.length !== 4) throw new Error('Usage: smoke-qualification-runtime <freeze.json> <private-root> <test-workspace> <disposable-root>');
  const [freezePath, privateRoot, testWorkspace, disposableRoot] = args.map(value => resolve(value));
  const result = await materializeQualificationRuntime(freezePath, privateRoot, testWorkspace, disposableRoot);
  if (result.run.mode !== 'controlled_replay') throw new Error('Smoke requires controlled_replay mode');
  console.log(JSON.stringify({ result: 'valid-controlled-fixture', provenance: 'caller-supplied-test-authority-fixture', workspaceId: result.run.workspaceId, authority: result.authority.kind }));
}

if (import.meta.main) {
  smokeQualificationRuntime(Bun.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : 'Qualification runtime smoke refused');
    process.exitCode = 1;
  });
}
