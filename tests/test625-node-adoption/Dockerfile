FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
WORKDIR /work/server
COPY server/package.json server/package-lock.json ./
RUN bun install --frozen-lockfile
COPY server/src ./src
# start-node.test.ts also exercises the real daemon handler (source-only imports).
COPY agent-node/src /work/agent-node/src
COPY tests/test625-node-adoption/run.sh /work/run-adoption.sh
ENV COMMHUB_DB=/tmp/adoption-test.db
CMD ["bash", "/work/run-adoption.sh"]
