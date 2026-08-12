FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

WORKDIR /repo
ARG TEST766_SOURCE_COMMIT=unknown
ENV TEST766_SOURCE_COMMIT=$TEST766_SOURCE_COMMIT

COPY agent-network/package.json /repo/agent-network/package.json
RUN cd /repo/agent-network && bun install --ignore-scripts

COPY agent-network /repo/agent-network
COPY tests/lib /repo/tests/lib
COPY tests/test766-bunx-preflight /repo/tests/test766-bunx-preflight
RUN chmod +x /repo/tests/test766-bunx-preflight/run.sh \
  /repo/tests/test766-bunx-preflight/fake-bun-only/bun \
  /repo/tests/test766-bunx-preflight/fake-bunx/bunx

CMD ["bash", "/repo/tests/test766-bunx-preflight/run.sh"]
