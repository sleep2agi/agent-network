FROM oven/bun:1.3.14

WORKDIR /workspace

COPY agent-node/package.json ./agent-node/package.json
RUN cd agent-node && bun install --ignore-scripts

COPY agent-node ./agent-node
COPY docs/grok-build-runtime.md ./docs/grok-build-runtime.md
COPY tests/test605-grok-startup-model-label ./tests/test605-grok-startup-model-label

ARG SOURCE_COMMIT
ENV TEST605_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test605-grok-startup-model-label/run.sh
ENTRYPOINT ["/workspace/tests/test605-grok-startup-model-label/run.sh"]
