FROM oven/bun:1.3.13@sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e AS bun
ARG SOURCE_COMMIT=dev
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
ARG SOURCE_COMMIT=dev
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN umask 022 && npm ci --ignore-scripts --no-audit --no-fund && chmod -R a+rX /app
WORKDIR /app
ENV SOURCE_COMMIT=$SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT
COPY server/src ./server/src
COPY agent-network/src ./agent-network/src
COPY tests/test1492-channel-evidence ./tests/test1492-channel-evidence
ENV COMMHUB_DB=/tmp/1492-test.db
CMD ["bash", "tests/test1492-channel-evidence/run.sh"]
