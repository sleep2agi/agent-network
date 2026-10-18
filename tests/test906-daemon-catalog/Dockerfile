# TEST-ONLY native adapter validation. Does not install into the host.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
RUN npm install -g @opencode/cli@2.0.22
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /workspace
COPY agent-node/src/runtime/opencode-v2-catalog* agent-node/src/runtime/
# Doorbell tests import child-workdir, which loads config-apply and the adopt
# registry. cli.ts is read, not imported. The glob above stays narrow so this
# image does not pull the rest of the runtime.
COPY agent-node/src/runtime/opencode-catalog-dispatch.ts agent-node/src/runtime/opencode-catalog-dispatch.test.ts agent-node/src/runtime/child-workdir.ts agent-node/src/runtime/config-apply.ts agent-node/src/runtime/codex-config-flags.ts agent-node/src/runtime/adopt-registry.ts agent-node/src/runtime/
COPY agent-node/src/cli.ts agent-node/src/cli.ts
COPY tests/test906-daemon-catalog/ tests/test906-daemon-catalog/
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT
CMD ["sh", "tests/test906-daemon-catalog/run.sh"]
