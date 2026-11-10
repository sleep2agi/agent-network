FROM node:20-alpine
RUN apk add --no-cache bash
WORKDIR /workspace
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
RUN cd agent-network && npm ci --omit=dev --ignore-scripts
COPY deploy/codex-large-history ./deploy/codex-large-history
COPY tests/test1260-codex-tui-large-history ./tests/test1260-codex-tui-large-history
ENTRYPOINT ["sh", "tests/test1260-codex-tui-large-history/run.sh"]
