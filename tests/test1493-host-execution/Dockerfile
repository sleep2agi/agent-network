FROM oven/bun:1.3.13@sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e AS bun
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN umask 022 && npm ci --ignore-scripts --no-audit --no-fund && chmod -R a+rX /app
WORKDIR /app
COPY server/src ./server/src
COPY agent-node/src ./agent-node/src
RUN ln -s /app/server/node_modules /app/agent-node/node_modules
COPY tests/test1493-host-execution ./tests/test1493-host-execution
ARG SOURCE_COMMIT
ARG RUNSH_BLOB
ENV SOURCE_COMMIT=$SOURCE_COMMIT RUNSH_BLOB=$RUNSH_BLOB
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT
USER 10001:10002
ENV COMMHUB_DB=/tmp/1493-test.db
CMD ["sh","tests/test1493-host-execution/run.sh"]
