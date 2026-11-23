FROM node:22-bookworm AS node
FROM oven/bun:1.3.14
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /workspace
COPY server/package*.json server/
COPY agent-network/package*.json agent-network/
COPY agent-node/package*.json agent-node/
RUN cd server && bun install --frozen-lockfile --ignore-scripts && cd ../agent-network && bun install --frozen-lockfile --ignore-scripts
COPY server server
COPY contracts contracts
COPY agent-network agent-network
RUN cd agent-node && bun install --frozen-lockfile --ignore-scripts
COPY agent-node agent-node
COPY tests/test5338-usage-week tests/test5338-usage-week
ENV COMMHUB_DB=/tmp/usage-week-hub.db
RUN bun build tests/test5338-usage-week/sources.test.ts --target node --outfile /tmp/sources.mjs && bun build agent-network/src/node-server.ts --target node --outfile /tmp/node-server.mjs
RUN cd agent-node && bun run build
CMD ["sh","-ec","cd server && bun test src/report-status-workdir-schema.test.ts && cd .. && node --test /tmp/sources.mjs && bun tests/test5338-usage-week/node-smoke.ts"]
