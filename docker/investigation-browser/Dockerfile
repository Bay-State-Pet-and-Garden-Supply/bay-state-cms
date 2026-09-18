# Tier 0 investigation analyzer image (#236).
#
# Minimal runtime for in-container Tier 0 analysis: stock Node plus the two
# dependency-free analyzer files. No browser, no proxy, no credentials, no
# package install at runtime. The runner launches this image with
# `--network=none`, pipes broker-approved captures on stdin, and reads the
# typed-observation envelope on stdout.
#
# Build: docker build -t baystate/investigation-browser:1 \
#          -f docker/investigation-browser/Dockerfile .
# Rebuild whenever tier0-analyzer.mjs or tier0-analyzer-cli.mjs changes;
# the `:1` tag is the posture-pinned artifact the runner asserts.
FROM node:22-bookworm
WORKDIR /app
COPY src/onboarding/browser-investigation/tier0-analyzer.mjs \
     src/onboarding/browser-investigation/tier0-analyzer-cli.mjs \
     /app/
