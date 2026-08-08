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
RUN cd /workspace/docs-site && bun install --ignore-scripts
COPY docs-site /workspace/docs-site

COPY agent-network/bin/goal-wake-log-render.ts /workspace/agent-network/bin/goal-wake-log-render.ts
COPY agent-network/tests/goal-wake-log-render.test.ts /workspace/agent-network/tests/goal-wake-log-render.test.ts
COPY agent-network/bin/cli.ts /workspace/agent-network/bin/cli.ts
COPY tests/test596-goal-loop-docs/run.sh /test596/run.sh
RUN chmod 755 /test596/run.sh

ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=${SOURCE_COMMIT}

ENTRYPOINT ["bash", "/test596/run.sh"]
