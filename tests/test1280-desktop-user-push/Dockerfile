ARG SOURCE_COMMIT
FROM oven/bun:1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates nodejs npm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server /app/server
COPY prototype/anet-client-app /app/prototype/anet-client-app
COPY tests/test1280-desktop-user-push/run.sh /app/tests/test1280-desktop-user-push/run.sh

RUN chmod +x /app/tests/test1280-desktop-user-push/run.sh
RUN cd /app/server && npm ci
RUN cd /app/prototype/anet-client-app && npm ci

ARG SOURCE_COMMIT
ENV TEST1280_SOURCE_COMMIT=$SOURCE_COMMIT

CMD ["/app/tests/test1280-desktop-user-push/run.sh"]
