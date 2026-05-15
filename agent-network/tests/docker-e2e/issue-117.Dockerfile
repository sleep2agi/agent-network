# Focused functional test for issue #117 — anet project up/restart/down.
# Self-contained: tmux + a fake `anet node start` shim (long-running sleep)
# stand in for the real runtime — this suite proves the project-level
# orchestration logic on the *obfuscated* dist, not the agent runtime.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends tmux ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /anet
COPY dist ./dist
COPY package.json ./

COPY tests/docker-e2e/issue-117-test.sh /test.sh
RUN chmod +x /test.sh

WORKDIR /work
ENV NODE_ENV=production
CMD ["/test.sh"]
