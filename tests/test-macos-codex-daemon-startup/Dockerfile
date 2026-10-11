FROM oven/bun:1.3.1-slim@sha256:86604aff15a156a8854137896af174e2d29e2310f9c9f1aa63de13882e25893d
WORKDIR /repo
RUN bun add --exact ws@8.22.0
COPY agent-network/src ./agent-network/src
COPY agent-network/bin ./agent-network/bin
COPY agent-node/src ./agent-node/src
COPY server/src/shared ./server/src/shared
USER bun
CMD ["timeout", "90", "bun", "test", "agent-network/src/darwin-process-identity.test.ts", "agent-network/src/copresence-identity.test.ts", "agent-network/src/codex-tui-client-health.test.ts", "agent-network/src/posix-codex-copresence.test.ts", "agent-node/src/runtime/codex-app-server-bridge.test.ts", "agent-node/src/runtime/create-node-daemon.test.ts"]
