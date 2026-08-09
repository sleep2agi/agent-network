FROM oven/bun:1.3.14
WORKDIR /workspace
COPY server/package.json ./server/package.json
RUN cd server && bun install --ignore-scripts
COPY server ./server
COPY tests/test601-hub-scheduled-tasks ./tests/test601-hub-scheduled-tasks
COPY tests/test602-scheduled-misfire ./tests/test602-scheduled-misfire
ARG SOURCE_COMMIT
ENV TEST602_SOURCE_COMMIT=$SOURCE_COMMIT
RUN chmod 0755 /workspace/tests/test602-scheduled-misfire/run.sh
ENTRYPOINT ["/workspace/tests/test602-scheduled-misfire/run.sh"]
