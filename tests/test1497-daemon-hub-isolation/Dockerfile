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
ARG RUNTIME_VERSION=2.5.0-preview.210
# No runtime/CLI source build: both executables and package manifests are the
# published tarballs. Locked dependency trees must match their declarations.
RUN PIN_RUNTIME_VERSION=${RUNTIME_VERSION} bun tests/test1497-daemon-hub-isolation/pin-packages.ts
ENV RFC044_NODE=/usr/local/bin/node
ENV RFC044_EXPECT_RUNTIME=${RUNTIME_VERSION}
USER bun
CMD ["bash", "tests/test1497-daemon-hub-isolation/run.sh"]
