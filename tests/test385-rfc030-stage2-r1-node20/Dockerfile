FROM oven/bun:1.3.1 AS build

WORKDIR /repo
COPY agent-node /repo/agent-node
COPY tests/test385-rfc030-stage2-r1-node20 /repo/tests/test385-rfc030-stage2-r1-node20
RUN cd /repo/agent-node \
    && bun install --silent \
    && mkdir -p /out \
    && bun build \
      --target=node \
      --format=esm \
      --external better-sqlite3 \
      --outfile=/out/r1-node20-probe.mjs \
      /repo/tests/test385-rfc030-stage2-r1-node20/r1-node20-probe.ts

FROM node:20.20.0-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates procps python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /harness
RUN npm init -y >/dev/null \
    && npm install --save-exact --omit=dev better-sqlite3@12.9.0 >/dev/null
COPY --from=build /out/r1-node20-probe.mjs /harness/r1-node20-probe.mjs
COPY tests/test385-rfc030-stage2-r1-node20/fake-owned-upstream.mjs /harness/fake-owned-upstream.mjs
COPY tests/test385-rfc030-stage2-r1-node20/run.sh /harness/run.sh
RUN chmod +x /harness/fake-owned-upstream.mjs /harness/run.sh \
    && mkdir -p /repo/docs/tests

CMD ["bash", "/harness/run.sh"]
