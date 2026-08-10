FROM oven/bun:1.3.14

WORKDIR /workspace
COPY agent-network/package.json ./agent-network/package.json
RUN cd agent-network && bun install --ignore-scripts
COPY agent-node/package.json ./agent-node/package.json
RUN cd agent-node && bun install --ignore-scripts
COPY agent-network ./agent-network
COPY agent-node ./agent-node
COPY tests/test520-dashboard-attachment-read ./tests/test520-dashboard-attachment-read

ARG TEST520_ATTACHMENT_SOURCE_COMMIT=uncommitted
ENV TEST520_ATTACHMENT_SOURCE_COMMIT=$TEST520_ATTACHMENT_SOURCE_COMMIT
RUN chmod 0755 tests/test520-dashboard-attachment-read/run.sh

ENTRYPOINT ["/workspace/tests/test520-dashboard-attachment-read/run.sh"]
