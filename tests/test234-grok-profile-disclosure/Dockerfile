FROM oven/bun:1.3.14

ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=${SOURCE_COMMIT}

WORKDIR /workspace
COPY agent-network /workspace/agent-network
# bin/cli.ts imports smol-toml through the daemon provider modules. This image
# bundles the CLI without a prior install, so the package has to be on disk
# or `bun build` stops at Could not resolve: "smol-toml".
RUN cd /workspace/agent-network && bun install --ignore-scripts
COPY docs/grok-build-cli-preview.md /workspace/docs/grok-build-cli-preview.md
COPY tests/test234-grok-profile-disclosure /test234
RUN chmod 755 /test234/run.sh

ENTRYPOINT ["bash", "/test234/run.sh"]
