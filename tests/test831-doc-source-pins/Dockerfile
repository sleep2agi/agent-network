# test831 —— 文档站源码行号 pin 的下限门
#
# 见 #831:docs-site 下 141 处 blob/<ref>/<file>#L<N> 引用全部钉在 main 上,
# 没有一个钉在不可变 commit。钉 main 的锚点每次重构都会漂,而漂了不报错。
#
# 🔴 这道门不解决 #831,只守住下限:已知失效的那批不会变多。
#    它的召回率是实测的 5/10,判据与边界写在 scripts/check-doc-source-pins.py
#    的文件头,改这道门之前先读那段。

# 第一版这里写了一个我编造的 python:3.12-slim digest —— 那串 sha256 不对应任何
# 真实镜像。换成本地实际拉到并核对过的 alpine:3.20,python3 由 apk 装(3.12.13)。
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc

RUN apk add --no-cache python3 bash >/dev/null

WORKDIR /repo
ARG TEST831_SOURCE_COMMIT=unknown
ENV TEST831_SOURCE_COMMIT=$TEST831_SOURCE_COMMIT
ARG TEST831_RUNSH_BLOB=unknown
ENV TEST831_RUNSH_BLOB=$TEST831_RUNSH_BLOB

# 被扫的对象
COPY docs-site /repo/docs-site
# pin 指向的源码树 —— 不 COPY 的话每个 pin 都会被判成 missing-file,
# 门会红在一个纯粹是镜像装配错误的原因上。
COPY server /repo/server
COPY agent-network /repo/agent-network
COPY docs/doc-source-pins-baseline.txt /repo/docs/doc-source-pins-baseline.txt
COPY scripts/check-doc-source-pins.py /repo/scripts/check-doc-source-pins.py
COPY scripts/check-mcp-tool-anchor-sections.py /repo/scripts/check-mcp-tool-anchor-sections.py
COPY scripts/check-mcp-tool-index-coverage.py /repo/scripts/check-mcp-tool-index-coverage.py
COPY tests/test831-doc-source-pins /repo/tests/test831-doc-source-pins
RUN chmod +x /repo/tests/test831-doc-source-pins/run.sh

CMD ["bash", "/repo/tests/test831-doc-source-pins/run.sh"]
