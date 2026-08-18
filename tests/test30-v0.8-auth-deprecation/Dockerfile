FROM node:20

RUN apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app
# 🔴 run.sh 第 10 行 source 的是 `$(dirname $0)/../lib/safe-rm.sh` ——
#   在 WORKDIR /app 下解析成 `/lib/safe-rm.sh`。不拷它，套件起手就死：
#     /app/run.sh: line 10: /app/../lib/safe-rm.sh: No such file or directory
#   本仓 23 个套件的 Dockerfile 用的都是下面这一行，这是补齐它。
COPY tests/lib/safe-rm.sh /lib/safe-rm.sh
COPY tests/test30-v0.8-auth-deprecation/run.sh /app/run.sh
RUN chmod +x /app/run.sh

CMD ["/app/run.sh"]
