FROM oven/bun:1.3.14

WORKDIR /workspace/agent-network

COPY agent-network/package.json agent-network/package-lock.json ./
RUN bun install --ignore-scripts

COPY agent-network ./
COPY tests/test702-primary-network/run.sh /workspace/run.sh

ARG SOURCE_COMMIT=unknown
ENV TEST702_SOURCE_COMMIT=${SOURCE_COMMIT}

RUN chmod 0755 /workspace/run.sh
ENTRYPOINT ["/workspace/run.sh"]
