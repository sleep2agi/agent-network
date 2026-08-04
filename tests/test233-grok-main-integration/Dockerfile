FROM oven/bun:1.3.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends gcc libc6-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY agent-network /workspace/agent-network
COPY agent-node /workspace/agent-node
COPY tests/test233-grok-main-integration /test233
RUN chmod 755 /test233/run.sh

ENTRYPOINT ["bash", "/test233/run.sh"]
