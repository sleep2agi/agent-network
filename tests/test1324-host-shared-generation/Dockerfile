FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
# #1324 needs a REAL supported V2 install, plus a real V1 one for the negative.
# V2 goes into the default prefix (the shared `opencode` bin must be V2); V1 goes
# into its own prefix so it cannot shadow that bin. Both real binaries are
# captured by resolved path for the tests.
RUN npm install -g @opencode/cli@2.0.22 --no-audit --no-fund \
 && test "$(opencode --version)" = 'opencode v2.0.22' \
 && readlink -f "$(command -v opencode)" > /v2-bin
RUN npm install -g --prefix /opt/v1 opencode-ai@1.18.34 --no-audit --no-fund \
 && /opt/v1/bin/opencode --version | grep -q '^1\.18\.34$' \
 && readlink -f /opt/v1/bin/opencode > /v1-bin
RUN echo "v2=$(cat /v2-bin) v1=$(cat /v1-bin)"
WORKDIR /opt/node_modules/@sleep2agi/agent-node
COPY agent-node/package.json agent-node/package-lock.json ./
RUN npm ci --ignore-scripts
COPY agent-node .
COPY tests/test1324-host-shared-generation/run.sh /test1324/run.sh
COPY tests/test1324-host-shared-generation/integration.ts /test1324/integration.ts
COPY tests/lib/safe-rm.sh /lib/safe-rm.sh
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT
ENTRYPOINT ["bash", "/test1324/run.sh"]
