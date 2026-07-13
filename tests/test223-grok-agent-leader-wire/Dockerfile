FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates coreutils jq util-linux \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY tests/test223-grok-agent-leader-wire /workspace/tests/test223-grok-agent-leader-wire

ENTRYPOINT ["bash", "/workspace/tests/test223-grok-agent-leader-wire/run.sh"]
