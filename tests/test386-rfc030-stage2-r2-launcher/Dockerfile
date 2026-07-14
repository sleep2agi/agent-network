FROM oven/bun:1.3.1

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils nodejs procps util-linux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY agent-node /repo/agent-node
COPY tests/test386-rfc030-stage2-r2-launcher /repo/tests/test386-rfc030-stage2-r2-launcher
RUN cd /repo/agent-node \
    && bun install --silent \
    && chmod +x \
      /repo/tests/test386-rfc030-stage2-r2-launcher/run.sh \
      /repo/tests/test386-rfc030-stage2-r2-launcher/fake-codex.mjs \
    && mkdir -p /repo/docs/tests

CMD ["bash", "/repo/tests/test386-rfc030-stage2-r2-launcher/run.sh"]
