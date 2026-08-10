FROM oven/bun:1.3.14

WORKDIR /workspace
COPY server/package.json ./server/package.json
RUN cd server && bun install --ignore-scripts
COPY server ./server
COPY docs-site/docs/api/rest.md ./docs-site/docs/api/rest.md
COPY docs-site/docs/en/api/rest.md ./docs-site/docs/en/api/rest.md
COPY tests/test166-task-diagnostics ./tests/test166-task-diagnostics

ARG TEST166_SOURCE_COMMIT=unknown
ENV TEST166_SOURCE_COMMIT=${TEST166_SOURCE_COMMIT}
RUN chmod 0755 tests/test166-task-diagnostics/run.sh
ENTRYPOINT ["/workspace/tests/test166-task-diagnostics/run.sh"]
