FROM oven/bun:1.3.1 AS build

WORKDIR /repo
COPY agent-node /repo/agent-node
COPY tests/test386-rfc030-stage2-r2-launcher /repo/tests/test386-rfc030-stage2-r2-launcher
RUN cd /repo/agent-node \
    && bun install --silent \
    && mkdir -p /out \
    && bun build \
      --target=node \
      --format=esm \
      --external better-sqlite3 \
      --external ws \
      --outfile=/out/r2-launcher-probe.mjs \
      /repo/tests/test386-rfc030-stage2-r2-launcher/r2-launcher-probe.ts

FROM node:20.20.0-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils g++ make procps python3 util-linux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /harness
RUN npm init -y >/dev/null \
    && npm install --save-exact --omit=dev better-sqlite3@12.9.0 ws@8.21.0 >/dev/null \
    && ln -s /usr/local/bin/node /usr/bin/node
COPY --from=build /out/r2-launcher-probe.mjs /harness/r2-launcher-probe.mjs
COPY tests/test386-rfc030-stage2-r2-launcher/run.sh /harness/run.sh
COPY tests/test386-rfc030-stage2-r2-launcher/fake-codex.mjs /repo/tests/test386-rfc030-stage2-r2-launcher/fake-codex.mjs
RUN chmod +x \
      /harness/run.sh \
      /repo/tests/test386-rfc030-stage2-r2-launcher/fake-codex.mjs \
    && mkdir -p /repo/docs/tests

CMD ["bash", "/harness/run.sh"]
