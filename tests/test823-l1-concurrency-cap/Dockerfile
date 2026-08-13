ARG SOURCE_COMMIT
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates coreutils procps \
  && rm -rf /var/lib/apt/lists/*

ARG SOURCE_COMMIT
ARG RUNSH_BLOB
ENV TEST823_SOURCE_COMMIT=${SOURCE_COMMIT}
# 把 run.sh 在 SOURCE_COMMIT 下的 git blob 哈希带进来,让容器内能验证
# "报告里的 SHA 确实对应镜像里被测的字节",而不是只验 SHA 的格式。
ENV TEST823_RUNSH_BLOB=${RUNSH_BLOB}

WORKDIR /workspace
COPY scripts/qa.sh              /workspace/scripts/qa.sh
COPY tests/test823-l1-concurrency-cap/run.sh /workspace/run.sh

# 非 root:与本仓其它套件一致
RUN chown -R node:node /workspace
USER node

ENTRYPOINT ["bash", "/workspace/run.sh"]
