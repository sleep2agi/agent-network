FROM node:22-bookworm AS node
FROM oven/bun:1.3.14
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /workspace
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
COPY agent-node/package.json agent-node/package-lock.json ./agent-node/
COPY server/package.json server/package-lock.json ./server/
RUN cd agent-network && bun install --frozen-lockfile --ignore-scripts
RUN cd agent-node && bun install --frozen-lockfile --ignore-scripts
RUN cd server && bun install --frozen-lockfile --ignore-scripts
COPY agent-network ./agent-network
COPY agent-node ./agent-node
COPY server ./server
COPY contracts ./contracts
COPY tests/test-rfc044-windows-daemon ./tests/test-rfc044-windows-daemon
COPY tests/test1497-daemon-hub-isolation ./tests/test1497-daemon-hub-isolation
RUN bun tests/test-rfc044-windows-daemon/build.ts
# Published CLI code, source-built sibling runtime and lockfile dependencies.
RUN bun tests/test1497-daemon-hub-isolation/pin-cli.ts
ENV RFC044_NODE=/usr/local/bin/node
USER bun
CMD ["bash", "tests/test1497-daemon-hub-isolation/run.sh"]
