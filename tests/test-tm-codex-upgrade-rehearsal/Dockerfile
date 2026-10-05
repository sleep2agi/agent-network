# TM codex-app-server upgrade rehearsal (#593): published agent-node/anet from npm, throwaway Hub
# from this checkout, fake codex. Needs registry access at run time (it installs the two releases).
FROM oven/bun:1.3.14 AS bun
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl jq procps ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
ENV npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false
WORKDIR /workspace
COPY server/package.json server/package-lock.json ./server/
RUN cd server && bun install --frozen-lockfile --ignore-scripts
COPY server ./server
COPY tests/test-tm-codex-upgrade-rehearsal/fake-codex.mjs /usr/local/bin/codex
COPY tests/test-tm-codex-upgrade-rehearsal/run.sh /run.sh
RUN chmod 0755 /usr/local/bin/codex /run.sh
ENTRYPOINT ["/run.sh"]
