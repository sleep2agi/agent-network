FROM anet-4150-native-project:local@sha256:dc86c5e20b7ac9d8ce86168d285b74bf3181f3688f321837cf9e9122ebc750c5
COPY agent-node/src /work/agent-node/src
COPY agent-network/src /work/agent-network/src
COPY agent-network/bin /work/agent-network/bin
COPY server/src /work/server/src
COPY contracts /work/contracts
COPY tests/test-shared-variant /work/tests/test-shared-variant
WORKDIR /work
ENTRYPOINT ["bun", "test"]
