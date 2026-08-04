FROM oven/bun:1.3.14

ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=${SOURCE_COMMIT}

WORKDIR /workspace
COPY agent-network/package.json agent-network/package-lock.json /workspace/agent-network/
RUN cd /workspace/agent-network && bun install --ignore-scripts
COPY agent-network /workspace/agent-network
COPY agent-node /workspace/agent-node
COPY docs/grok-build-cli-preview.md /workspace/docs/grok-build-cli-preview.md
COPY tests/test235-grok-mcp-outbound-only /test235
RUN chmod 755 /test235/run.sh

ENTRYPOINT ["bash", "/test235/run.sh"]
