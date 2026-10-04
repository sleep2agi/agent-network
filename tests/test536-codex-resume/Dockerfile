FROM oven/bun:1.3.14

# tmux: co-presence sessions that make a fixture node "running" (private -L socket).
# procps: anet reads the process table with ps.
# bsdutils: `script`, which gives the CLI a real pty so the --pick prompt (TTY-only) can be driven.
RUN apt-get update && apt-get install -y --no-install-recommends tmux procps bsdutils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY agent-network/package.json ./agent-network/package.json
RUN cd agent-network && bun install --ignore-scripts

COPY agent-network ./agent-network
COPY tests/test536-codex-resume ./tests/test536-codex-resume
COPY tests/lib/safe-rm.sh ./tests/lib/safe-rm.sh

ARG SOURCE_COMMIT
ENV TEST536_SOURCE_COMMIT=$SOURCE_COMMIT

RUN chmod 0755 /workspace/tests/test536-codex-resume/run.sh
ENTRYPOINT ["/workspace/tests/test536-codex-resume/run.sh"]
