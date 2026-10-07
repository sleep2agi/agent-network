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

# qa.sh 只认 tests/<名>/qa.l1。镜像不带仓库的 tests/，不放桩就 exit 2，闸门一次都不跑。
# 不限并发的用例要求峰值 > 2。只放 1 个桩时峰值是 1，套件仍红，所以放 4 个。
# 这 4 个目录只活在镜像里，不进仓库的 tests/，不会变成真的 L1 套件。
# chown 必须在建桩之后，否则 node 读不到。
RUN mkdir -p \
      /workspace/tests/t823-stub-a \
      /workspace/tests/t823-stub-b \
      /workspace/tests/t823-stub-c \
      /workspace/tests/t823-stub-d \
 && printf '\n' > /workspace/tests/t823-stub-a/qa.l1 \
 && printf '\n' > /workspace/tests/t823-stub-b/qa.l1 \
 && printf '\n' > /workspace/tests/t823-stub-c/qa.l1 \
 && printf '\n' > /workspace/tests/t823-stub-d/qa.l1 \
 && chown -R node:node /workspace
USER node

ENTRYPOINT ["bash", "/workspace/run.sh"]
