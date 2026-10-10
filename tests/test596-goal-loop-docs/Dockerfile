FROM oven/bun:1.3.14

WORKDIR /workspace

# VitePress reads Git timestamps while rendering pages. Keep the real binary in
# the isolated image so the docs gate exercises production build behavior.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

COPY agent-node/package.json /workspace/agent-node/package.json
RUN cd /workspace/agent-node && bun install --ignore-scripts
COPY agent-node /workspace/agent-node

COPY docs-site/package.json docs-site/package-lock.json /workspace/docs-site/
# bun 1.3.14 sometimes fails this layer with
# "Fail extracting tarball for mermaid" on an unchanged lockfile
# (job 114198259550, head 472393cc; the same image built on main).
# Drop the install cache so a truncated tarball is not reused.
RUN set -eu; \
    cd /workspace/docs-site; \
    ok=0; \
    for attempt in 1 2 3; do \
      if bun install --ignore-scripts; then ok=1; break; fi; \
      echo "docs-site bun install attempt ${attempt} failed" >&2; \
      rm -rf "${HOME}/.bun/install/cache"; \
      sleep $((attempt * 2)); \
    done; \
    test "$ok" = 1
COPY docs-site /workspace/docs-site

COPY agent-network/bin/goal-wake-log-render.ts /workspace/agent-network/bin/goal-wake-log-render.ts
COPY agent-network/tests/goal-wake-log-render.test.ts /workspace/agent-network/tests/goal-wake-log-render.test.ts
COPY agent-network/bin/cli.ts /workspace/agent-network/bin/cli.ts
COPY tests/test596-goal-loop-docs/run.sh /test596/run.sh
RUN chmod 755 /test596/run.sh

ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=${SOURCE_COMMIT}

ENTRYPOINT ["bash", "/test596/run.sh"]
