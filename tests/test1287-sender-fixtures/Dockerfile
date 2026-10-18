FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends bash curl jq python3 ca-certificates make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
COPY agent-network/package.json agent-network/package-lock.json ./agent-network/
COPY agent-node/package.json agent-node/package-lock.json ./agent-node/
RUN cd server && bun install --frozen-lockfile --ignore-scripts
RUN cd agent-network && bun install --frozen-lockfile --ignore-scripts
RUN cd agent-node && bun install --frozen-lockfile --ignore-scripts
COPY server ./server
COPY agent-network ./agent-network
COPY agent-node ./agent-node
RUN cd agent-network && bun run build
RUN cd agent-node && bun run build
RUN printf '#!/bin/sh\nexec node /app/agent-node/dist/cli.js "$@"\n' > /usr/local/bin/agent-node && chmod 0755 /usr/local/bin/agent-node
RUN printf '#!/bin/sh\nexec node /app/agent-network/dist/bin/anet.cjs "$@"\n' > /usr/local/bin/anet && chmod 0755 /usr/local/bin/anet
RUN mkdir -p "$HOME/.anet" && printf '{"hub":"http://127.0.0.1:9200","token":"test-auth-token"}' > "$HOME/.anet/config.json"
COPY tests/test8-runtime/run.sh ./test8-run.sh
COPY tests/qa-hub-10-network-scope-regressions/run.sh ./run.sh
COPY tests/lib/safe-rm.sh /lib/safe-rm.sh
COPY tests/test1287-sender-fixtures/run.sh ./fixture-run.sh
ENV COMMHUB_AUTH_TOKEN=test-auth-token
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT TEST8_SOURCE_COMMIT=$SOURCE_COMMIT
CMD ["bash", "/app/fixture-run.sh"]
