FROM oven/bun:1.3.14

ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=${SOURCE_COMMIT}

WORKDIR /workspace
COPY agent-node/package.json /workspace/agent-node/package.json
RUN cd /workspace/agent-node && bun install --ignore-scripts
COPY agent-node /workspace/agent-node
COPY tests/test236-dashboard-codex-goal /test236
RUN chmod -R a+rwX /workspace/agent-node && chmod 755 /test236/run.sh

ENTRYPOINT ["bash", "/test236/run.sh"]
