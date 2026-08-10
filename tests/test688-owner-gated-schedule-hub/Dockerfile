FROM oven/bun:1.3.14
WORKDIR /workspace
COPY server/package.json ./server/package.json
RUN cd server && bun install --ignore-scripts
COPY server ./server
COPY tests/test601-hub-scheduled-tasks ./tests/test601-hub-scheduled-tasks
COPY tests/test688-owner-gated-schedule-hub ./tests/test688-owner-gated-schedule-hub
ARG SOURCE_COMMIT
ENV TEST688_SOURCE_COMMIT=$SOURCE_COMMIT
RUN chmod 0755 /workspace/tests/test688-owner-gated-schedule-hub/run.sh
ENTRYPOINT ["/workspace/tests/test688-owner-gated-schedule-hub/run.sh"]
