FROM oven/bun:1.3.14
WORKDIR /work
COPY agent-network/src ./agent-network/src
COPY agent-network/bin ./agent-network/bin
COPY agent-node/src ./agent-node/src
COPY tests/test631-private-config-permissions/run.sh /run.sh
ARG TEST631_SOURCE_COMMIT=unknown
ENV TEST631_SOURCE_COMMIT=$TEST631_SOURCE_COMMIT
RUN chmod 0755 /run.sh
ENTRYPOINT ["/run.sh"]
