#!/usr/bin/env bash
# One authoritative verification gate (review finding P1-6 / round-2 finding 5).
# CI should invoke ONLY `bun run verify`.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> frozen install"
bun install --frozen-lockfile

echo "==> typecheck"
npx tsc --noEmit --skipLibCheck

echo "==> test-runner coverage (Bun/Vitest registration gate)"
bun run test:runner-coverage

echo "==> vitest (client + importable unit suites)"
npx vitest run

echo "==> bun test:db (DB integration suites)"
bun run test:db

echo "==> production build"
npx vite build

# ADR-0030: the old PI-specific ESLint gate was retired with src/product-intelligence/**.
# Directory-based import prevention for relocated onboarding code now lives in
# eslint.config.mjs (no-restricted-imports) and runs as part of `bun run lint`.

echo "verify: ALL GATES GREEN"
