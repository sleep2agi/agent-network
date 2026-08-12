FROM oven/bun:1.3.14

ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=${SOURCE_COMMIT}

WORKDIR /workspace
COPY agent-node/package.json /workspace/agent-node/package.json
RUN cd /workspace/agent-node && bun install --ignore-scripts
COPY agent-node /workspace/agent-node
COPY tests/test696-human-low-value-reply/run.sh /test696/run.sh
RUN chmod 755 /test696/run.sh

ENTRYPOINT ["bash", "/test696/run.sh"]
