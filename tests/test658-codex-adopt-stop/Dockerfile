FROM oven/bun:1.3.9
WORKDIR /test
COPY agent-node/src/runtime/adopt-codex-evidence.ts agent-node/src/runtime/adopt-codex-evidence.test.ts ./
USER bun
CMD ["bun", "test", "adopt-codex-evidence.test.ts"]
