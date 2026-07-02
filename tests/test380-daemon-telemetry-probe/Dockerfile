# Mirror 通信龙's environment: node:22-bookworm-slim + npm-install
# @sleep2agi/agent-network@preview + @sleep2agi/agent-node@preview
# (currently preview.17 per `npm view @sleep2agi/agent-node@preview version`).
#
# The probe runs BOTH the isolated hub AND the daemon inside this container,
# talking to 127.0.0.1:9310. Different from 通信龙's gateway topology, but
# functionally identical for the "what does the daemon send" question — the
# payload shape and DB writes are what we're after, not network routing.

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash curl jq ca-certificates sqlite3 procps unzip && \
    rm -rf /var/lib/apt/lists/*

# Install bun for running the hub from source (we bind-mount main).
RUN curl -fsSL https://bun.sh/install | bash && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun

# npm-install the same preview versions 通信龙 used, so we probe the
# ACTUAL published tarballs (not the /repo main source). This is what
# `anet daemon up` spawns in production when agent-node isn't in PATH.
RUN npm i -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview

WORKDIR /repo
COPY . .
WORKDIR /repo/server
RUN bun install

WORKDIR /repo
CMD ["bash", "tests/test380-daemon-telemetry-probe/run.sh"]
