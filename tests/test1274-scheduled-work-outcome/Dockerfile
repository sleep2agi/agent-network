FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
WORKDIR /workspace
COPY server/package.json server/package-lock.json ./server/
RUN cd server && bun install --frozen-lockfile --ignore-scripts
COPY server ./server
COPY tests/test601-hub-scheduled-tasks ./tests/test601-hub-scheduled-tasks
COPY tests/test1274-scheduled-work-outcome ./fixture
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT
CMD ["bash", "/workspace/fixture/run.sh"]
