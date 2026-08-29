ARG SOURCE_COMMIT
# bun binary comes from the pinned oven/bun image (Docker Hub), NOT a raw
# github-releases curl. The prior `curl github.com/.../releases/download/
# bun-v1.3.14/bun-linux-x64.zip` 404'd PERSISTENTLY from GitHub Actions
# runners' release-assets CDN (7 retries over 30s all 404, while the URL
# resolves 200 elsewhere) — more retries can't fix a consistent 404. Same
# multi-stage pattern as tests/qa-180-rename-ghost (a passing gate); version
# pinned by digest for supply-chain safety.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun-runtime
FROM node:22-bookworm-slim
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends bash build-essential ca-certificates curl python3 util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && bun --version
WORKDIR /workspace
COPY server/package*.json server/
COPY agent-node/package*.json agent-node/
RUN cd server && npm ci && cd ../agent-node && npm ci
COPY server server
COPY agent-node agent-node
COPY contracts contracts
COPY tests/test1271-daemon-start-node tests/test1271-daemon-start-node
ARG SOURCE_COMMIT
ENV TEST1271_SOURCE_COMMIT=$SOURCE_COMMIT COMMHUB_DB=/tmp/test1271.db
RUN chmod 0755 tests/test1271-daemon-start-node/run.sh
ENTRYPOINT ["bash","tests/test1271-daemon-start-node/run.sh"]
