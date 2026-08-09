FROM oven/bun:1.3.14

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash curl jq \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY server/package.json ./server/package.json
RUN cd server && bun install --ignore-scripts
COPY server ./server
COPY tests/test384-opencode-local-package-e2e/run.sh ./tests/test384-opencode-local-package-e2e/run.sh
COPY tests/test621-test384-layer-isolation ./tests/test621-test384-layer-isolation

ARG SOURCE_COMMIT
ENV TEST621_SOURCE_COMMIT=$SOURCE_COMMIT
RUN chmod 0755 /workspace/tests/test621-test384-layer-isolation/run.sh
ENTRYPOINT ["/workspace/tests/test621-test384-layer-isolation/run.sh"]
