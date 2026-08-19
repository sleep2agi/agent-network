FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun-runtime

FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates jq unzip procps && rm -rf /var/lib/apt/lists/*
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx \
    && test "$(bun --version)" = "1.3.14" \
    && test "$(bunx --version)" = "1.3.14"

WORKDIR /app
COPY tests/qa-dash-08-cross-account-views/run.sh /app/run.sh
COPY tests/lib/safe-rm.sh /lib/safe-rm.sh
RUN chmod +x /app/run.sh

# SHA 绑定（#1092）。scripts/qa.sh 从这里 grep `^ARG SOURCE_COMMIT` 决定传不传
# --build-arg；没有这一行就**不传，而且不报错**，本次运行无法被钉到任何提交上。
# 放在 CMD 之前而不是文件开头 —— 否则每次 commit 都会让上面的 COPY 层失效。
ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=$SOURCE_COMMIT

CMD ["/app/run.sh"]
