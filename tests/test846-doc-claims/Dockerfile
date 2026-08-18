# test846 —— docs/stale-issue-review.md 里那些「某文件某行写着某句」的断言,还成立吗
#
# 起因:#846 的审查指出本仓要求所有改动跑 Docker E2E,而那份文档是纯散文、
# 没有可执行断言。这就是把它变成门的那一步。
#
# 🔴 边界:这道门只证明「引的行号没漂」。正文的结论对不对、引用之外的散文,
#    它都不碰。判据与理由写在 scripts/check-doc-claims.py 的文件头。

FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc

RUN apk add --no-cache python3 bash >/dev/null

WORKDIR /repo
ARG TEST846_SOURCE_COMMIT=unknown
ENV TEST846_SOURCE_COMMIT=$TEST846_SOURCE_COMMIT
ARG TEST846_RUNSH_BLOB=unknown
ENV TEST846_RUNSH_BLOB=$TEST846_RUNSH_BLOB

# 被检的文档
COPY docs/stale-issue-review.md /repo/docs/stale-issue-review.md
# 清单指向的源码树 —— 不 COPY 的话每条都会红在 missing-file 上,
# 而那是镜像装配错误,不是文档漂移。
COPY server /repo/server
COPY agent-node /repo/agent-node
COPY agent-network /repo/agent-network
COPY scripts/check-doc-claims.py /repo/scripts/check-doc-claims.py
COPY tests/test846-doc-claims /repo/tests/test846-doc-claims
RUN chmod +x /repo/tests/test846-doc-claims/run.sh

CMD ["bash", "/repo/tests/test846-doc-claims/run.sh"]
