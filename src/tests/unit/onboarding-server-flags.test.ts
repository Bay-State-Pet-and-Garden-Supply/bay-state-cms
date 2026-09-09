// @vitest-environment node
// Slice 0: execution-tail / tolerant-read scaffolding retired (council plan).
// This suite pins the retirement: the tail exports must be absent, while the
// sourcing + manual-evidence flags keep their semantics unchanged.
import { describe, expect, it } from 'vitest';
import * as flags from '../../onboarding/flags';
import {
  getSourcingFlags,
  loadManualEvidenceFlags,
  loadSourcingFlags,
} from '../../onboarding/flags';

describe('server flags // Slice 0 retirement', () => {
  it('tail/tolerant scaffolding is gone', () => {
    for (const key of [
      'STAGE_RENAME_TOLERANT_ENV_KEY',
      'EXECUTION_TAIL_WRITES_ENV_KEY',
      'loadStageRenameTolerant',
      'loadExecutionTailWrites',
      'getStageRenameTolerant',
      'getExecutionTailWrites',
      'overrideStageRenameTolerant',
      'overrideExecutionTailWrites',
      'resetStageRenameTolerantOverride',
      'resetExecutionTailWritesOverride',
    ]) {
      expect((flags as Record<string, unknown>)[key]).toBeUndefined();
    }
  });

  it('sourcing + manual-evidence flags unchanged', () => {
    // Ambient .env may enable manual evidence; assert parser defaults with an
    // explicit empty env so this suite is hermetic.
    expect(loadManualEvidenceFlags({}).enabled).toBe(false);
    expect(loadSourcingFlags({}).effectiveEnabled).toBe(true);
    expect(getSourcingFlags().effectiveEnabled).toBe(true);
  });
});
