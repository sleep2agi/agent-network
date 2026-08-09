FROM oven/bun:1.3.14
WORKDIR /workspace
COPY server/package.json ./server/package.json
RUN cd server && bun install --ignore-scripts
COPY server ./server
COPY tests/test624-task-cursor-pagination ./tests/test624-task-cursor-pagination
ARG SOURCE_COMMIT
ENV TEST624_SOURCE_COMMIT=$SOURCE_COMMIT
RUN chmod 0755 /workspace/tests/test624-task-cursor-pagination/run.sh
ENTRYPOINT ["/workspace/tests/test624-task-cursor-pagination/run.sh"]
