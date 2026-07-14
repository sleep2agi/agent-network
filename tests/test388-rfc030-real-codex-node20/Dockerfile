FROM oven/bun:1.3.1 AS build

WORKDIR /repo
COPY agent-node /repo/agent-node
RUN cd /repo/agent-node \
    && bun install --silent \
    && bun run build:rfc030-integration \
    && bun build \
      --target=node \
      --format=esm \
      --outfile=dist/rfc030-baseline-gate.mjs \
      src/runtime/codex-policy-gateway/version-gate.ts

FROM node:20.20.0-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils grep procps util-linux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY --from=build /repo/agent-node/dist/rfc030-integration.mjs /repo/agent-node/dist/rfc030-integration.mjs
COPY --from=build /repo/agent-node/dist/rfc030-baseline-gate.mjs /repo/agent-node/dist/rfc030-baseline-gate.mjs
COPY agent-node/scripts/rfc030-real-cli-e2e.mjs /repo/agent-node/scripts/rfc030-real-cli-e2e.mjs

# All dependencies and the exact real Codex binary live only inside this
# disposable image. Nothing is installed into the host npm prefix.
RUN mkdir -p /opt/rfc030-real-codex \
    && cd /opt/rfc030-real-codex \
    && npm init -y >/dev/null \
    && npm install --save-exact --omit=dev @openai/codex@0.144.0 >/dev/null \
    && mkdir -p /repo/docs/tests

COPY tests/test388-rfc030-real-codex-node20 /repo/tests/test388-rfc030-real-codex-node20
RUN chmod +x /repo/tests/test388-rfc030-real-codex-node20/run.sh

ENV RFC030_CODEX_BIN=/opt/rfc030-real-codex/node_modules/.bin/codex
ENV RFC030_BUNDLE=/repo/agent-node/dist/rfc030-integration.mjs
ENV RFC030_BASELINE_BUNDLE=/repo/agent-node/dist/rfc030-baseline-gate.mjs

CMD ["bash", "/repo/tests/test388-rfc030-real-codex-node20/run.sh"]
