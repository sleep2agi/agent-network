FROM oven/bun:1
WORKDIR /app
RUN apt-get update && apt-get install -y curl python3 && rm -rf /var/lib/apt/lists/*
COPY server/ server/
RUN cd server && bun install
COPY tests/test3-security/run.sh /app/run.sh
RUN chmod +x /app/run.sh
ENV COMMHUB_AUTH_TOKEN=test-auth-token
# SHA 绑定（#1092）。scripts/qa.sh 从这里 grep `^ARG SOURCE_COMMIT` 决定传不传
# --build-arg；没有这一行就**不传，而且不报错**，本次运行无法被钉到任何提交上。
# 放在 CMD 之前而不是文件开头 —— 否则每次 commit 都会让上面的 COPY 层失效。
ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=$SOURCE_COMMIT

CMD ["bash", "/app/run.sh"]
