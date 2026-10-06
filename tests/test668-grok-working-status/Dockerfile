FROM oven/bun:1.3.14

WORKDIR /workspace
COPY agent-node/package.json agent-node/package-lock.json /workspace/agent-node/
COPY server/package.json server/package-lock.json /workspace/server/
RUN cd /workspace/agent-node && bun install --frozen-lockfile --ignore-scripts \
 && cd /workspace/server && bun install --frozen-lockfile --ignore-scripts
COPY agent-node/src /workspace/agent-node/src
COPY server/src /workspace/server/src
COPY tests/test668-grok-working-status /workspace/tests/test668-grok-working-status
RUN mkdir -p /opt/fake-grok \
 && cp /workspace/tests/test668-grok-working-status/fake-grok.ts /opt/fake-grok/grok \
 && chmod 0755 /opt/fake-grok/grok /workspace/tests/test668-grok-working-status/run.sh

ARG TEST668_SOURCE_COMMIT
ENV TEST668_SOURCE_COMMIT=$TEST668_SOURCE_COMMIT
ENTRYPOINT ["bash", "/workspace/tests/test668-grok-working-status/run.sh"]
