FROM oven/bun:1.3.14
WORKDIR /workspace
COPY server/package.json ./server/package.json
RUN cd server && bun install --ignore-scripts
COPY server ./server
COPY tests/test601-hub-scheduled-tasks ./tests/test601-hub-scheduled-tasks
ARG SOURCE_COMMIT
ENV TEST601_SOURCE_COMMIT=$SOURCE_COMMIT
RUN chmod 0755 /workspace/tests/test601-hub-scheduled-tasks/run.sh
ENTRYPOINT ["/workspace/tests/test601-hub-scheduled-tasks/run.sh"]
