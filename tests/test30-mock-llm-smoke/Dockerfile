FROM oven/bun:1.3.14

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl jq \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY agent-network/package.json ./agent-network/package.json
RUN cd agent-network && bun install --ignore-scripts

COPY tests/MOCK-LLM-PROTOCOL.md ./tests/MOCK-LLM-PROTOCOL.md
COPY agent-network ./agent-network
COPY tests/helpers/mock-llm-server.ts ./tests/helpers/mock-llm-server.ts
COPY tests/test30-mock-llm-smoke ./tests/test30-mock-llm-smoke

ARG SOURCE_COMMIT=unknown
ENV TEST30_SOURCE_COMMIT=${SOURCE_COMMIT}
RUN chmod 0755 tests/test30-mock-llm-smoke/run.sh
ENTRYPOINT ["/workspace/tests/test30-mock-llm-smoke/run.sh"]
