FROM oven/bun:1.3.14

WORKDIR /workspace/server
# 带上 server 的锁文件、--frozen-lockfile:只拷 package.json 时 bun 按 ^1.12.0 现解析,MCP SDK 一出新版(1.32.0)
# probe.ts 里「审计过的 SDK 版本」那一条就红,而这道门审计的正是锁文件里那一版(#466 同一类)。
COPY server/package.json server/package-lock.json ./
RUN bun install --ignore-scripts --frozen-lockfile

COPY server/src/tools.ts ./src/tools.ts
COPY tests/test629-mcp-schema-policy/probe.ts ./test629/probe.ts
COPY tests/test629-mcp-schema-policy/run.sh ./test629/run.sh
RUN chmod 0755 ./test629/run.sh

ARG SOURCE_COMMIT=unknown
ENV TEST629_SOURCE_COMMIT=${SOURCE_COMMIT}

CMD ["./test629/run.sh"]
