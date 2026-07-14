FROM oven/bun:1.3.1

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils grep \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY server /repo/server
COPY agent-node /repo/agent-node
COPY tests/test387-rfc030-stage2-server-entry-pre-h1 /repo/tests/test387-rfc030-stage2-server-entry-pre-h1

RUN cd /repo/server \
    && bun install --silent \
    && cd /repo/agent-node \
    && bun install --silent \
    && ln -s /repo/server/node_modules /repo/node_modules \
    && chmod +x /repo/tests/test387-rfc030-stage2-server-entry-pre-h1/run.sh \
    && mkdir -p /repo/docs/tests

CMD ["bash", "/repo/tests/test387-rfc030-stage2-server-entry-pre-h1/run.sh"]
