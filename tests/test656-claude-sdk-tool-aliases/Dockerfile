FROM oven/bun:1.3.14

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl jq ca-certificates procps && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY agent-node /repo/agent-node
COPY tests/test656-claude-sdk-tool-aliases /repo/tests/test656-claude-sdk-tool-aliases

RUN cd /repo/agent-node && bun install
RUN chmod +x /repo/tests/test656-claude-sdk-tool-aliases/run.sh

ARG TEST656_SOURCE_COMMIT=unknown
ENV TEST656_SOURCE_COMMIT=$TEST656_SOURCE_COMMIT

CMD ["bash", "/repo/tests/test656-claude-sdk-tool-aliases/run.sh"]
