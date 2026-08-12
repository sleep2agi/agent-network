FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates jq unzip procps && rm -rf /var/lib/apt/lists/*
ARG BUN_VERSION=1.3.14
ARG BUN_LINUX_X64_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
COPY tests/lib/install-bun-pinned.sh /usr/local/libexec/install-bun-pinned.sh
RUN BUN_VERSION="$BUN_VERSION" BUN_LINUX_X64_SHA256="$BUN_LINUX_X64_SHA256" \
    bash /usr/local/libexec/install-bun-pinned.sh

WORKDIR /app
COPY tests/qa-dash-10-incremental-poll/run.sh /app/run.sh
COPY tests/lib/safe-rm.sh /lib/safe-rm.sh
RUN chmod +x /app/run.sh

CMD ["/app/run.sh"]
