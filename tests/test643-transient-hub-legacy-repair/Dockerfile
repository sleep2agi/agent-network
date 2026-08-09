FROM oven/bun:1.3.14

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl jq \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY agent-network/package.json ./agent-network/package.json
COPY server/package.json ./server/package.json
RUN cd agent-network && bun install --ignore-scripts \
  && cd /workspace/server && bun install --ignore-scripts

COPY agent-network ./agent-network
COPY server ./server
COPY tests/lib ./tests/lib
COPY tests/test643-transient-hub-legacy-repair ./tests/test643-transient-hub-legacy-repair

ARG SOURCE_COMMIT
ENV TEST643_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test643-transient-hub-legacy-repair/run.sh
ENTRYPOINT ["/workspace/tests/test643-transient-hub-legacy-repair/run.sh"]
