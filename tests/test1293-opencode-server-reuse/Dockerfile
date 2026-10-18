FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /opt/node_modules/@sleep2agi/agent-node
COPY agent-node/package.json agent-node/package-lock.json ./
RUN npm ci --ignore-scripts
COPY agent-node .
COPY tests/test1293-opencode-server-reuse/run.sh /test1293/run.sh
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT
ENTRYPOINT ["bash", "/test1293/run.sh"]
