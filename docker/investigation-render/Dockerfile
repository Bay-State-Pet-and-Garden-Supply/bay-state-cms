# Tier 1 investigation render image (#237).
#
# Containerized rendered investigation: the existing rendered-page stack
# (Crawlee + Playwright Chromium) plus the Tier 1 render worker, with NO
# direct egress. At runtime the container lives on the isolated render
# network (`binv-render-only`, created with `--internal`) and its only
# egress is the validating forward proxy (host-side, broker-validated per
# request) whose URL arrives via the proxy env (see `buildRenderContainerSpec`).
#
# The worker defaults to the plain-Playwright backend (Chromium pre-warmed
# below, no runtime browser download — the container has no route to fetch
# one). Camoufox stays available for a future pre-warmed variant.
#
# Build: docker build -t baystate/investigation-render:1 \
#          -f docker/investigation-render/Dockerfile .
# Rebuild whenever render-worker.ts or the browser stack changes; the `:1`
# tag is the posture-pinned artifact the runner asserts.
#
# Network (ops): docker network create --internal binv-render-only
FROM oven/bun:1.3.5
WORKDIR /app

# Resolve + install production dependencies first (better layer caching).
COPY bun.lock package.json ./
RUN bun install --production --frozen-lockfile

# Pre-warm headless Chromium system deps + browser (no runtime download:
# the render network has no route to fetch one later).
RUN bunx playwright install --with-deps chromium

# Copy the render worker plus the exact sources it imports (repo-relative
# layout preserved so relative imports resolve unchanged).
COPY src/extraction-worker/browser ./src/extraction-worker/browser
COPY src/shared/hash.ts ./src/shared/hash.ts
COPY src/onboarding/browser-investigation/render-worker.ts ./src/onboarding/browser-investigation/render-worker.ts

# The runner supplies the command (`bun <worker>`) with the render task on
# stdin; nothing listens here and no server starts at build time.
USER 65532:65532
