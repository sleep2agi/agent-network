# This suite can use an offline, preloaded image with the same Bun version.
# The default is the reproducible upstream toolchain, not a workstation cache.
ARG BASE_IMAGE=oven/bun:1.3.14-debian
FROM ${BASE_IMAGE}
WORKDIR /suite
COPY contracts ./contracts
COPY server/src/tmwork-wire.ts ./server/src/tmwork-wire.ts
COPY tests/test-tmwork-wire-v03/contract.test.ts ./tests/test-tmwork-wire-v03/contract.test.ts
ENTRYPOINT ["bun", "test", "tests/test-tmwork-wire-v03/contract.test.ts"]
