FROM oven/bun:1.3.14
WORKDIR /workspace

COPY agent-network/src ./agent-network/src
COPY agent-node/src ./agent-node/src
COPY tests/test646-config-node-id-precedence/run.sh /run.sh

ARG TEST646_SOURCE_COMMIT=unknown
ENV TEST646_SOURCE_COMMIT=$TEST646_SOURCE_COMMIT

RUN chmod 0755 /run.sh
ENTRYPOINT ["/run.sh"]
