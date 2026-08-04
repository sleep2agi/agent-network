FROM oven/bun:1.3.14

WORKDIR /workspace
COPY agent-node/package.json ./agent-node/package.json
RUN cd agent-node && bun install --ignore-scripts
COPY agent-node/src ./agent-node/src
COPY tests/test586-codex-successor-reconcile/run.sh /harness/run.sh
COPY tests/test586-codex-successor-reconcile/mutate.ts /harness/mutate.ts
RUN chmod 0755 /harness/run.sh

ENTRYPOINT ["/harness/run.sh"]
