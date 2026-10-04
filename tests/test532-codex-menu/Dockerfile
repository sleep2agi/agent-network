FROM oven/bun:1.3.14

# tmux: the co-presence sessions that make a fixture node "running" (private -L socket).
# procps: `anet node stop` / delete read the process table with ps.
# bsdutils: `script`, which gives the CLI a real pty so the menu (TTY-only) can be driven.
RUN apt-get update && apt-get install -y --no-install-recommends tmux procps bsdutils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY agent-network/package.json ./agent-network/package.json
RUN cd agent-network && bun install --ignore-scripts

COPY agent-network ./agent-network
COPY tests/test532-codex-menu ./tests/test532-codex-menu
COPY tests/lib/safe-rm.sh ./tests/lib/safe-rm.sh

ARG SOURCE_COMMIT
ENV TEST532_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test532-codex-menu/run.sh
ENTRYPOINT ["/workspace/tests/test532-codex-menu/run.sh"]
