FROM oven/bun:1.3.14
WORKDIR /workspace

COPY agent-network/package.json ./agent-network/package.json
RUN cd agent-network && bun install --ignore-scripts
COPY agent-network ./agent-network
COPY tests/test653-batch-workdir /test653

ARG TEST653_SOURCE_COMMIT=unknown
ENV TEST653_SOURCE_COMMIT=$TEST653_SOURCE_COMMIT

RUN chmod 0755 /test653/run.sh /test653/tmux
ENTRYPOINT ["/test653/run.sh"]
