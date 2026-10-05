# test562b-node-remote — `anet node <start|stop|restart|edit> <alias> --remote` (#562 step 2).
# Real hub + real `anet daemon up` (host_supervisor) + a real child it created + the CLI under test
# run from source (agent-network/bin/cli.ts) with its own HOME, so the node is never local to it.
# Install shape as qa-create-node-workdir (local source npm-packed and installed globally: the daemon
# spawns children with that `anet`); bun from the digest-pinned image (as qa-180-rename-ghost).
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun-runtime

FROM node:22-bookworm-slim
ENV npm_config_audit=false npm_config_fund=false

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates jq procps build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx && test "$(bun --version)" = "1.3.14"

WORKDIR /app

COPY server /app/server
COPY agent-node /app/agent-node
COPY agent-network /app/agent-network

RUN cd /app/server && bun install --silent
RUN cd /app/agent-node && bun install --silent && bun run build
RUN cd /app/agent-network && bun install --silent && bun run build

RUN cd /app/agent-node && npm pack && npm install -g ./sleep2agi-agent-node-*.tgz
RUN cd /app/agent-network && npm pack && npm install -g ./sleep2agi-agent-network-*.tgz

RUN anet --version && which anet && which agent-node

COPY tests/lib/safe-rm.sh /app/tests/lib/safe-rm.sh
# Suite script last: editing run.sh only rebuilds these layers.
COPY tests/test562b-node-remote/run.sh /app/tests/test562b-node-remote/run.sh
RUN chmod +x /app/tests/test562b-node-remote/run.sh

ARG SOURCE_COMMIT
ENV TEST562B_SOURCE_COMMIT=$SOURCE_COMMIT

CMD ["/app/tests/test562b-node-remote/run.sh"]
