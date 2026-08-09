FROM oven/bun:1.3.14

RUN apt-get update && apt-get install -y --no-install-recommends curl jq python3 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY agent-network/ /repo/agent-network/
RUN cd /repo/agent-network && bun install --frozen-lockfile

COPY server/ /repo/server/
RUN cd /repo/server && bun install --frozen-lockfile

ARG TEST292_RENAME_SOURCE_COMMIT=unknown
ENV TEST292_RENAME_SOURCE_COMMIT=${TEST292_RENAME_SOURCE_COMMIT}

COPY tests/docker-e2e.sh /repo/tests/docker-e2e.sh
COPY tests/test4-base/run.sh /repo/tests/test4-base/run.sh
COPY tests/test292-e2e-rename-command/run.sh /repo/run.sh
RUN chmod +x /repo/run.sh

CMD ["/repo/run.sh"]
