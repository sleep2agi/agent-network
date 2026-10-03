FROM oven/bun:1.3.14

WORKDIR /workspace

COPY server/package.json server/bun.lock* server/package-lock.json ./server/
RUN cd server && bun install --frozen-lockfile --ignore-scripts

COPY agent-network/package.json ./agent-network/package.json
RUN cd agent-network && bun install --ignore-scripts

COPY server ./server
COPY agent-network ./agent-network
COPY tests/test519-claude-code-peer-reply ./tests/test519-claude-code-peer-reply
RUN chmod 0755 tests/test519-claude-code-peer-reply/run.sh

# SHA binding (#1092): qa.yml reads `^ARG` names from this file.
ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=$SOURCE_COMMIT

ENTRYPOINT ["/workspace/tests/test519-claude-code-peer-reply/run.sh"]
