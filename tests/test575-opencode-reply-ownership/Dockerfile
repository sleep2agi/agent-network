FROM oven/bun:1.3.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates nodejs \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY agent-node/package.json ./agent-node/package.json
RUN cd agent-node && bun install --ignore-scripts

COPY agent-node/src ./agent-node/src
COPY tests/test575-opencode-reply-ownership ./tests/test575-opencode-reply-ownership
RUN chmod 0755 ./tests/test575-opencode-reply-ownership/run.sh \
  ./tests/test575-opencode-reply-ownership/run-mutation.sh

ARG SOURCE_COMMIT
ENV TEST575_SOURCE_COMMIT=$SOURCE_COMMIT
ENTRYPOINT ["bash", "tests/test575-opencode-reply-ownership/run.sh"]
