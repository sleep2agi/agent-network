FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun-runtime

FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates jq unzip procps && rm -rf /var/lib/apt/lists/*
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx \
    && test "$(bun --version)" = "1.3.14" \
    && test "$(bunx --version)" = "1.3.14"

WORKDIR /app
COPY tests/qa-hub-09-task-state-machine/run.sh /app/run.sh
COPY tests/lib/safe-rm.sh /lib/safe-rm.sh
RUN chmod +x /app/run.sh

CMD ["/app/run.sh"]
