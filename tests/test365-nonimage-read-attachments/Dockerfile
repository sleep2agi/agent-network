FROM oven/bun:1.3.14

RUN apt-get update && apt-get install -y --no-install-recommends curl jq ca-certificates python3 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace

COPY server/package.json ./server/package.json
RUN cd server && bun install --ignore-scripts
COPY agent-network/package.json ./agent-network/package.json
RUN cd agent-network && bun install --ignore-scripts
COPY agent-node/package.json ./agent-node/package.json
RUN cd agent-node && bun install --ignore-scripts

COPY server ./server
COPY agent-network ./agent-network
COPY agent-node ./agent-node
COPY tests/lib ./tests/lib
COPY tests/test365-nonimage-read-attachments ./tests/test365-nonimage-read-attachments

ARG TEST365_SOURCE_COMMIT=uncommitted
ENV TEST365_SOURCE_COMMIT=$TEST365_SOURCE_COMMIT
RUN chmod 0755 tests/test365-nonimage-read-attachments/run.sh

ENTRYPOINT ["/workspace/tests/test365-nonimage-read-attachments/run.sh"]
