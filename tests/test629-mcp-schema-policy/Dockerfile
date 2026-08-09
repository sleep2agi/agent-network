FROM oven/bun:1.3.14

WORKDIR /workspace/server
COPY server/package.json ./package.json
RUN bun install --ignore-scripts

COPY server/src/tools.ts ./src/tools.ts
COPY tests/test629-mcp-schema-policy/probe.ts ./test629/probe.ts
COPY tests/test629-mcp-schema-policy/run.sh ./test629/run.sh
RUN chmod 0755 ./test629/run.sh

ARG SOURCE_COMMIT=unknown
ENV TEST629_SOURCE_COMMIT=${SOURCE_COMMIT}

CMD ["./test629/run.sh"]
