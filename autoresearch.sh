#!/usr/bin/env bash
# Classification-engine benchmark (autoresearch canonical entrypoint).
#
# Workload: deterministic ShopSite-field classification over the frozen
# bay-state-v9 dev corpus, scaled to 920 entries (23 x 40 replicas).
# Executes the REAL shipped path end to end per pass:
#   buildQualificationPredictionsFromCode (deterministic matcher precedence
#   over product types, ShopSite-mapped attributes, and pages) +
#   evaluateJevOfflineComparison (offline scorer).
#
# Deterministic: no network, no time-of-day dependence, fixed seeds/replicas.
# Primary metric: median ms per full pass (lower is better). The runner
# fail-closes on artifact-hash drift so silent workload changes can't pass
# as speedups.
set -euo pipefail
cd "$(dirname "$0")"
exec bun scripts/autoresearch-benchmark.ts --replicas=40 --repeats=7
