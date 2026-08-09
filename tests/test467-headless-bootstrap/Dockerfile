FROM oven/bun:1.3.14

WORKDIR /workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl jq \
  && rm -rf /var/lib/apt/lists/*

COPY server/package.json server/bun.lock* ./server/
RUN cd server && bun install --ignore-scripts

COPY agent-network/package.json agent-network/bun.lock* ./agent-network/
RUN cd agent-network && bun install --ignore-scripts

COPY server ./server
COPY agent-network ./agent-network
COPY tests/lib ./tests/lib
COPY tests/test467-headless-bootstrap ./tests/test467-headless-bootstrap

ARG SOURCE_COMMIT
ENV TEST467_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test467-headless-bootstrap/run.sh
ENTRYPOINT ["/workspace/tests/test467-headless-bootstrap/run.sh"]
