FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
WORKDIR /work
COPY server/package.json server/package-lock.json ./server/
RUN cd server && bun install --frozen-lockfile
COPY server/src ./server/src
COPY agent-node/src ./agent-node/src
COPY agent-network/src ./agent-network/src
COPY contracts/side-thread/v1 ./contracts/side-thread/v1
COPY tests/test2017-node-session-control/run.sh /work/run.sh
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT
USER bun
CMD ["bash", "/work/run.sh"]
