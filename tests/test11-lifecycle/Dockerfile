FROM oven/bun:1

WORKDIR /app

RUN apt-get update && apt-get install -y curl python3 && rm -rf /var/lib/apt/lists/*

COPY server/ server/
RUN cd server && bun install

COPY tests/test11-lifecycle/run.sh /app/run.sh
RUN chmod +x /app/run.sh

ENV COMMHUB_AUTH_TOKEN=test-auth-token
ENV COMMHUB_DB=/tmp/commhub-test11.db

ARG TEST11_SOURCE_COMMIT=dev
ENV TEST11_SOURCE_COMMIT=$TEST11_SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$TEST11_SOURCE_COMMIT

CMD ["bash", "/app/run.sh"]
