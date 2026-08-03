FROM anet-test580:dev
RUN apt-get update && apt-get install -y --no-install-recommends curl jq sqlite3 procps build-essential python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY server /app/server
COPY agent-node /app/agent-node
COPY agent-network /app/agent-network
RUN mkdir -p /tmp/packs && cd /app/agent-node && bun install --frozen-lockfile && bun run build \
  && bun pm pack --destination /tmp/packs && bun add -g /tmp/packs/sleep2agi-agent-node-*.tgz
RUN cd /app/agent-network && bun install --frozen-lockfile && bun run build \
  && bun pm pack --destination /tmp/packs && bun add -g /tmp/packs/sleep2agi-agent-network-*.tgz
RUN chmod 0755 "$(realpath "$(command -v anet)")" "$(realpath "$(command -v agent-node)")"
RUN test -x /usr/local/bin/node || ln -s /usr/local/bin/bun /usr/local/bin/node
COPY tests/test581-daemon-server-e2e/run.sh /app/run581.sh
RUN chmod +x /app/run581.sh
CMD ["/app/run581.sh"]
