FROM oven/bun:1.3.14
WORKDIR /work
COPY agent-network/src/private-state.ts agent-network/src/private-state.test.ts ./agent-network/src/
COPY agent-node/src/runtime/config-apply.ts agent-node/src/runtime/config-apply.test.ts ./agent-node/src/runtime/
COPY agent-network/bin/cli.ts ./agent-network/bin/cli.ts
COPY agent-node/src/cli.ts ./agent-node/src/cli.ts
COPY tests/test631-private-config-permissions/run.sh /run.sh
ARG TEST631_SOURCE_COMMIT=unknown
ENV TEST631_SOURCE_COMMIT=$TEST631_SOURCE_COMMIT
RUN chmod 0755 /run.sh
ENTRYPOINT ["/run.sh"]
