FROM oven/bun:1.3.14
ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=${SOURCE_COMMIT}
WORKDIR /workspace
COPY server/package.json /workspace/server/package.json
RUN cd /workspace/server && bun install --ignore-scripts
COPY server /workspace/server
COPY agent-node/package.json /workspace/agent-node/package.json
RUN cd /workspace/agent-node && bun install --ignore-scripts
COPY agent-node /workspace/agent-node
COPY tests/test1176-codex-thread-runtime/run.sh /run.sh
RUN chmod 755 /run.sh
ENTRYPOINT ["bash", "/run.sh"]
