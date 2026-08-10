FROM oven/bun:1.3.14

WORKDIR /repo
COPY server/package.json /repo/server/package.json
RUN cd /repo/server && bun install
COPY server /repo/server
COPY docs/rfcs/RFC-035-task-runtime-evidence.md /repo/docs/rfcs/RFC-035-task-runtime-evidence.md
COPY docs-site/docs /repo/docs-site/docs
COPY tests/test671-task-runtime-evidence-hub /repo/tests/test671-task-runtime-evidence-hub
RUN chmod +x /repo/tests/test671-task-runtime-evidence-hub/run.sh

ARG TEST671_SOURCE_COMMIT=unknown
ENV TEST671_SOURCE_COMMIT=$TEST671_SOURCE_COMMIT

CMD ["bash", "/repo/tests/test671-task-runtime-evidence-hub/run.sh"]
