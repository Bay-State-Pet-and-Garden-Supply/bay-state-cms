import {
  captureQualificationPredictionsLive,
  type QualificationGoldOnlyEntry,
  type QualificationLiveCaptureOptions,
  type QualificationTaxonomyInput,
} from '../../classification/benchmark-prediction';
import { createDevAttemptGuard } from '../../classification/jev-benchmark-replay';

/** Real finite guard around the public capture API; callers mock only provider HTTP. */
export async function captureGuardedJevForTest(
  entries: QualificationGoldOnlyEntry[],
  options: QualificationLiveCaptureOptions,
  taxonomy?: QualificationTaxonomyInput,
) {
  const guard = createDevAttemptGuard({ maxHttpAttempts: 600, hardDeadlineMs: 30_000 });
  try {
    return await captureQualificationPredictionsLive(entries, {
      ...options,
      attemptBudget: options.attemptBudget ?? guard,
      deadlineSignal: options.deadlineSignal ?? guard.signal,
    }, taxonomy);
  } finally {
    guard.dispose();
  }
}
