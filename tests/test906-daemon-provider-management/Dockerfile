FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun
FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS core
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /work
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd agent-network && npm ci --ignore-scripts --no-audit --no-fund
COPY agent-network/src ./agent-network/src
COPY tests/test906-daemon-provider-management ./tests/test906-daemon-provider-management
COPY tests/test906-daemon-provider-management/run.sh /run.sh
RUN useradd --create-home --uid 10001 runner
USER runner
CMD ["sh", "/run.sh"]

# Optional installed-binary contract check; credentials remain synthetic.
FROM core AS codex-contract
USER root
RUN npm install --global --ignore-scripts --no-audit --no-fund @openai/codex@0.159.2
USER runner
CMD ["bun", "tests/test906-daemon-provider-management/native-provider-probe.ts"]

FROM core AS final
