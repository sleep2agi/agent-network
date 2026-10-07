ARG SOURCE_COMMIT
FROM node:22-bookworm-slim
# board #734 — real codex 0.133.0 (pre-ordinal) and 0.159.2 (paginated rollouts) + bun.
ENV npm_config_audit=false npm_config_fund=false
ARG SOURCE_COMMIT
ENV T734_SOURCE_COMMIT=$SOURCE_COMMIT
# Pinned bun, per .github/scripts/check-bun-install-pin.py (same pin as test720/test750).
# 🔴 ENV, not ARG: hub-orphan-gates passes --build-arg NAME=$GITHUB_SHA for every ARG.
ENV BUN_VERSION=1.3.14
ENV BUN_LINUX_X64_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git unzip python3 tmux procps \
  && rm -rf /var/lib/apt/lists/*
RUN curl --fail --silent --show-error --location \
      --retry 3 --retry-delay 2 --retry-all-errors \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
      --output /tmp/bun-linux-x64.zip \
  && echo "${BUN_LINUX_X64_SHA256}  /tmp/bun-linux-x64.zip" | sha256sum --check --strict \
  && unzip -j /tmp/bun-linux-x64.zip 'bun-linux-x64/bun' -d /usr/local/bin \
  && chmod 0755 /usr/local/bin/bun \
  && test "$(bun --version)" = "$BUN_VERSION" \
  && rm -f /tmp/bun-linux-x64.zip
RUN npm install -g --prefix /opt/codex-0.133.0 @openai/codex@0.133.0 \
 && npm install -g --prefix /opt/codex-0.159.2 @openai/codex@0.159.2 \
 && /opt/codex-0.133.0/bin/codex --version | grep -Fx 'codex-cli 0.133.0' \
 && /opt/codex-0.159.2/bin/codex --version | grep -Fx 'codex-cli 0.159.2'
# 🔴 The release zip ships bun WITHOUT bunx; `anet hub start` paths spawn through bunx (#766).
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
WORKDIR /workspace
COPY server/package.json server/package-lock.json ./server/
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd server && npm ci --ignore-scripts \
 && cd ../agent-network && npm ci --ignore-scripts
# Launcher-layer codex STUBS (real binaries stay under /opt): they answer --version like the
# real version and record the argv of `app-server` when the launcher gets that far.
RUN for v in 0.133.0 0.159.2; do \
      printf '%s\n' '#!/bin/sh' \
        "if [ \"\$1\" = \"--version\" ]; then echo 'codex-cli $v'; exit 0; fi" \
        "if [ \"\$1\" = \"app-server\" ]; then echo \"$v \$*\" >> /tmp/t734-appserver-argv.log; fi" \
        'exec sleep 3600' > /usr/local/bin/codex-stub-$v && chmod 0755 /usr/local/bin/codex-stub-$v; \
    done \
 && ln -s /usr/local/bin/codex-stub-0.159.2 /usr/local/bin/codex
COPY . /workspace
RUN rm -rf /workspace/.git /workspace/.anet
ENTRYPOINT ["bash", "tests/test734-codex-paginated-rollout-guard/run.sh"]
