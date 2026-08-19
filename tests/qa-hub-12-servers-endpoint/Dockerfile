FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates jq unzip && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app/server
COPY server/package.json ./
RUN bun install
COPY server/src ./src

WORKDIR /app
COPY tests/qa-hub-12-servers-endpoint/run.sh /app/run.sh
COPY tests/lib/safe-rm.sh /lib/safe-rm.sh
RUN chmod +x /app/run.sh

# SHA 绑定（#1092）。scripts/qa.sh 从这里 grep `^ARG SOURCE_COMMIT` 决定传不传
# --build-arg；没有这一行就**不传，而且不报错**，本次运行无法被钉到任何提交上。
# 放在 CMD 之前而不是文件开头 —— 否则每次 commit 都会让上面的 COPY 层失效。
ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=$SOURCE_COMMIT

CMD ["/app/run.sh"]
