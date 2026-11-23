FROM oven/bun:1.3.14

WORKDIR /workspace
COPY contracts /workspace/contracts
# contracts/*.ts re-export ../server/src/contracts/*
COPY server/src/contracts /workspace/server/src/contracts
COPY agent-node/package.json agent-node/package-lock.json /workspace/agent-node/
COPY server/package.json server/package-lock.json /workspace/server/
RUN cd /workspace/agent-node && bun install --frozen-lockfile --ignore-scripts \
 && cd /workspace/server && bun install --frozen-lockfile --ignore-scripts
COPY agent-node/src /workspace/agent-node/src
COPY server/src /workspace/server/src
COPY tests/test5332-interrupt-mid-turn /workspace/tests/test5332-interrupt-mid-turn
RUN mkdir -p /opt/fake-grok \
 && cp /workspace/tests/test5332-interrupt-mid-turn/fake-grok.ts /opt/fake-grok/grok \
 && chmod 0755 /opt/fake-grok/grok /workspace/tests/test5332-interrupt-mid-turn/run.sh

ARG TEST5332_SOURCE_COMMIT
ENV TEST5332_SOURCE_COMMIT=$TEST5332_SOURCE_COMMIT
ENTRYPOINT ["bash", "/workspace/tests/test5332-interrupt-mid-turn/run.sh"]
