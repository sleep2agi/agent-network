FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates jq unzip procps && rm -rf /var/lib/apt/lists/*

ARG BUN_VERSION=1.3.14
ARG BUN_LINUX_X64_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f

# Pin and verify the exact archive instead of executing today's bun.sh output.
# This check is a fail-closed CI signal; repository policy, not branch
# protection, is what prevents maintainers from merging while it is red.
RUN curl --fail --silent --show-error --location \
      --retry 3 --retry-delay 2 --retry-all-errors \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
      --output /tmp/bun-linux-x64.zip \
  && echo "${BUN_LINUX_X64_SHA256}  /tmp/bun-linux-x64.zip" | sha256sum --check --strict \
  && unzip -j /tmp/bun-linux-x64.zip 'bun-linux-x64/bun' -d /usr/local/bin \
  && chmod 0755 /usr/local/bin/bun \
  && ln -s bun /usr/local/bin/bunx \
  && test "$(bun --version)" = "$BUN_VERSION" \
  && test "$(bunx --version)" = "$BUN_VERSION" \
  && rm -f /tmp/bun-linux-x64.zip

WORKDIR /app
COPY tests/qa-cli-02-network-create/run.sh /app/run.sh
COPY tests/lib/safe-rm.sh /lib/safe-rm.sh
RUN chmod +x /app/run.sh

CMD ["/app/run.sh"]
