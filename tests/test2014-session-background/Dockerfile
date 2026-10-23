FROM oven/bun:1.3.14
WORKDIR /app
COPY agent-node/src ./src
COPY agent-node/package.json ./package.json
RUN bun build ./src/runtime/opencode-copresence/v2-session.ts --target=node --packages=external --outdir /tmp/check-build
RUN bun build ./src/cli.ts --target=node --packages=external --outdir /tmp/cli-check
USER bun
CMD ["bun", "test", "./src/runtime/opencode-copresence/session-background.test.ts", "./src/runtime/opencode-copresence/session-background-http.test.ts", "./src/runtime/session-control-bridge.test.ts"]
