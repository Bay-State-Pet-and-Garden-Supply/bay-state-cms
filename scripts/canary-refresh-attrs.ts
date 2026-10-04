/** Compatibility command: the same current-run, frozen-evidence refresh. */
import { refreshCanaryDependents } from './canary-recurate-attrs';
if (import.meta.main) refreshCanaryDependents().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
