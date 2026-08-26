FROM oven/bun:1.3.14
WORKDIR /repo
RUN apt-get update -qq && apt-get install -y --no-install-recommends python3 make g++ >/dev/null && rm -rf /var/lib/apt/lists/*
COPY agent-node/package.json agent-node/package-lock.json ./agent-node/
RUN cd agent-node && bun install --frozen-lockfile
COPY server/package.json server/package-lock.json ./server/
RUN cd server && bun install --frozen-lockfile
COPY agent-node ./agent-node
COPY server ./server
COPY docs-site/docs/guide/codex-copresence.md ./docs-site/docs/guide/codex-copresence.md
COPY docs-site/docs/en/guide/codex-copresence.md ./docs-site/docs/en/guide/codex-copresence.md
COPY tests/test1176-codex-thread-runtime/run.sh ./run.sh
ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=${SOURCE_COMMIT}
RUN chmod 0755 ./run.sh
CMD ["./run.sh"]
