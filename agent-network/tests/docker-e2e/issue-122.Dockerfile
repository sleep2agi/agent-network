# Focused functional test for issue #122 — anet node start default auto-tmux
# wrap + opt-outs + recursion guard. Uses tmux + a sleep-shim posing as the
# runtime so tmux sessions stay alive for has-session checks.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends tmux ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /anet
COPY dist ./dist
COPY package.json ./

COPY tests/docker-e2e/issue-122-test.sh /test.sh
RUN chmod +x /test.sh

WORKDIR /work
ENV NODE_ENV=production
CMD ["/test.sh"]
