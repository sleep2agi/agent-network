FROM oven/bun:1.3.1

WORKDIR /opt/sdk
RUN bun add @anthropic-ai/claude-agent-sdk@0.3.289

WORKDIR /src
COPY agent-node/src/runtime/claude-auth-retry.ts /src/claude-auth-retry.ts
COPY agent-node/src/cli.ts /src/cli.ts
COPY tests/test672-claude-auth-abort/probe.ts /test672/probe.ts
COPY tests/test672-claude-auth-abort/run.sh /test672/run.sh
# Bun resolves imports from the script's directory, not the cwd. The SDK
# lives in /opt/sdk; the probe must see that node_modules.
RUN ln -s /opt/sdk/node_modules /test672/node_modules && chmod +x /test672/run.sh

ARG TEST672_SOURCE_COMMIT=dev
ENV TEST672_SOURCE_COMMIT=$TEST672_SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$TEST672_SOURCE_COMMIT

CMD ["bash", "/test672/run.sh"]
