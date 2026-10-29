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
# 🔴 #675 —— L1 成员现在由 `tests/<套件>/qa.l1` 标记决定，不再是 qa.sh 里的一份数组。
#    本镜像只 COPY 了 scripts/qa.sh，于是镜像里的 qa.sh **一个套件都收不到**：
#    QA_L1_ONLY 那 6 个名字全部被判「未登记」⇒ exit 2 ⇒ 本套件在 CI 上红成
#    「选择失效 —— 实际只跑到 0 个套件（期望 6）」。
#    把 tests/ 一起带进来，镜像里 qa.sh 看到的 L1 才与仓库一致。
COPY tests /workspace/tests

# 非 root:与本仓其它套件一致
RUN chown -R node:node /workspace
USER node

ENTRYPOINT ["bash", "/workspace/run.sh"]
