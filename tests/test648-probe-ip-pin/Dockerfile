FROM oven/bun:1.3.14 AS bun-runtime

FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /workspace
COPY agent-node/package.json ./agent-node/package.json
RUN cd agent-node && npm install --omit=optional --ignore-scripts
COPY agent-node ./agent-node
COPY tests/test648-probe-ip-pin ./tests/test648-probe-ip-pin

ARG TEST648_SOURCE_COMMIT=unknown
ENV TEST648_SOURCE_COMMIT=$TEST648_SOURCE_COMMIT
RUN chmod 0755 tests/test648-probe-ip-pin/run.sh
ENTRYPOINT ["/workspace/tests/test648-probe-ip-pin/run.sh"]
