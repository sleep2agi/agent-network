FROM oven/bun:1.3.1

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils grep python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY agent-node /repo/agent-node
COPY agent-network /repo/agent-network
COPY tests/test384-rfc030-stage2-wiring /repo/tests/test384-rfc030-stage2-wiring
RUN mkdir -p /repo/docs/tests \
    && chmod +x /repo/tests/test384-rfc030-stage2-wiring/run.sh \
    && cd /repo/agent-node \
    && bun install --silent \
    && cd /repo/agent-network \
    && bun install --silent

CMD ["bash", "/repo/tests/test384-rfc030-stage2-wiring/run.sh"]
