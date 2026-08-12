FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

WORKDIR /repo
ARG TEST765_SOURCE_COMMIT=unknown
ENV TEST765_SOURCE_COMMIT=$TEST765_SOURCE_COMMIT

COPY agent-network/package.json /repo/agent-network/package.json
RUN cd /repo/agent-network && bun install --ignore-scripts

COPY agent-network /repo/agent-network
COPY tests/lib /repo/tests/lib
COPY tests/test765-batch-runtime-gate /repo/tests/test765-batch-runtime-gate
RUN chmod +x /repo/tests/test765-batch-runtime-gate/run.sh

CMD ["bash", "/repo/tests/test765-batch-runtime-gate/run.sh"]
