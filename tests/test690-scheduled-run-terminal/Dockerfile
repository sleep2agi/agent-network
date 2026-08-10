FROM oven/bun:1.3.14
WORKDIR /workspace
COPY server/package.json ./server/package.json
RUN cd server && bun install --ignore-scripts
COPY server ./server
COPY tests/test601-hub-scheduled-tasks ./tests/test601-hub-scheduled-tasks
COPY tests/test690-scheduled-run-terminal ./tests/test690-scheduled-run-terminal
ARG SOURCE_COMMIT
ENV TEST690_SOURCE_COMMIT=$SOURCE_COMMIT
RUN chmod 0755 /workspace/tests/test690-scheduled-run-terminal/run.sh
ENTRYPOINT ["/workspace/tests/test690-scheduled-run-terminal/run.sh"]
