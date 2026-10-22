# Opt-in composition check. Requires Hub relay PR2890 in the build context and
# --build-context app-src=<agent-network-app checkout at PR1016 exact head>.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
WORKDIR /work
COPY server/package.json server/package-lock.json ./server/
RUN cd server && bun install --frozen-lockfile
COPY server/src ./server/src
COPY agent-node/src ./agent-node/src
COPY agent-network/src ./agent-network/src
COPY contracts/side-thread/v1 ./contracts/side-thread/v1
COPY --from=app-src src/node-session-control.ts src/app-fetch.ts src/deadline.ts ./client-src/
COPY tests/test2014-session-background/integration/run.ts ./run.ts
COPY tests/test2014-session-background/integration/identity-wire.ts ./identity-wire.ts
USER bun
ENV COMMHUB_DB=/tmp/control-integration.db COMMHUB_DEV_OPEN=1 COMMHUB_AUTH_TOKEN=fixture-legacy-not-used
CMD ["bun", "/work/run.ts"]
