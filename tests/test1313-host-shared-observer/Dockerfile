FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /opt/node_modules/@sleep2agi/agent-node
COPY agent-node/package.json agent-node/package-lock.json ./
RUN npm ci --ignore-scripts
COPY agent-node .
COPY tests/test1313-host-shared-observer/run.sh /test1313/run.sh
COPY tests/test1313-host-shared-observer/cross-uid.ts /test1313/cross-uid.ts
# run.sh sources ../lib/safe-rm.sh relative to its own dir => /lib/safe-rm.sh in here.
COPY tests/lib/safe-rm.sh /lib/safe-rm.sh
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT
ENTRYPOINT ["bash", "/test1313/run.sh"]
