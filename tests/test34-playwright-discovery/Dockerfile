FROM oven/bun:1.3.14

WORKDIR /workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

COPY agent-network/package.json agent-network/bun.lock* ./agent-network/
RUN cd agent-network && bun install --ignore-scripts

COPY agent-network ./agent-network
COPY tests/test34-playwright-discovery ./tests/test34-playwright-discovery

ARG SOURCE_COMMIT
ENV TEST34_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test34-playwright-discovery/run.sh
ENTRYPOINT ["/workspace/tests/test34-playwright-discovery/run.sh"]
