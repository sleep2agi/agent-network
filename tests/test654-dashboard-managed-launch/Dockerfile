FROM oven/bun:1.3.14

ARG TEST654_SOURCE_COMMIT=unknown
ENV TEST654_SOURCE_COMMIT=${TEST654_SOURCE_COMMIT}

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash nodejs npm jq lsof procps curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY agent-network /repo/agent-network
COPY tests/test654-dashboard-managed-launch /repo/tests/test654-dashboard-managed-launch
RUN cd /repo/agent-network && bun install --frozen-lockfile --ignore-scripts
RUN chmod +x /repo/tests/test654-dashboard-managed-launch/run.sh

CMD ["/repo/tests/test654-dashboard-managed-launch/run.sh"]
