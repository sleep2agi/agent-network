FROM oven/bun:1.3.14

WORKDIR /workspace

COPY agent-node/package.json ./agent-node/package.json
RUN cd agent-node && bun install --ignore-scripts

COPY agent-node ./agent-node
COPY tests/test612-visible-inbox-skip ./tests/test612-visible-inbox-skip

ARG SOURCE_COMMIT
ENV TEST612_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test612-visible-inbox-skip/run.sh
ENTRYPOINT ["/workspace/tests/test612-visible-inbox-skip/run.sh"]
