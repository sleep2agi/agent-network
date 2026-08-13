ARG SOURCE_COMMIT
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates coreutils procps \
  && rm -rf /var/lib/apt/lists/*

ARG SOURCE_COMMIT
ENV TEST823_SOURCE_COMMIT=${SOURCE_COMMIT}

WORKDIR /workspace
COPY scripts/qa.sh              /workspace/scripts/qa.sh
COPY tests/test823-l1-concurrency-cap/run.sh /workspace/run.sh

# 非 root:与本仓其它套件一致
RUN chown -R node:node /workspace
USER node

ENTRYPOINT ["bash", "/workspace/run.sh"]
