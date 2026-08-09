FROM oven/bun:1.3.14

RUN apt-get update && apt-get install -y --no-install-recommends curl jq python3 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY server/ /repo/server/
RUN cd /repo/server && bun install --frozen-lockfile

COPY tests/docker-e2e.sh /repo/tests/docker-e2e.sh
COPY tests/lib/response-json.sh /repo/tests/lib/response-json.sh
COPY tests/test292-e2e-contract-drift/run.sh /repo/run.sh
RUN chmod +x /repo/run.sh

ARG TEST292_CONTRACT_SOURCE_COMMIT
ENV TEST292_CONTRACT_SOURCE_COMMIT=$TEST292_CONTRACT_SOURCE_COMMIT

ENTRYPOINT ["/repo/run.sh"]
