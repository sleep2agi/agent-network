FROM oven/bun:1.3.14

WORKDIR /workspace

COPY agent-node/package.json ./agent-node/package.json
RUN cd agent-node && bun install --ignore-scripts

COPY agent-node ./agent-node
COPY tests/test613-codex-dead-endpoint ./tests/test613-codex-dead-endpoint

ARG SOURCE_COMMIT
ENV TEST613_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test613-codex-dead-endpoint/run.sh
ENTRYPOINT ["/workspace/tests/test613-codex-dead-endpoint/run.sh"]
