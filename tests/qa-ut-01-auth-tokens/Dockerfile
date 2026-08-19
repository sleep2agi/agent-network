FROM oven/bun:1

WORKDIR /app
COPY server/package.json server/package.json
COPY server/src/ server/src/
# COMMHUB_DB routes db.ts schema bootstrap to a throwaway file —
# we test only pure generators/hashers, never touch the DB.
ENV COMMHUB_DB=/tmp/qa-ut-01.db

# 🔴 SHA 绑定。scripts/qa.sh 从 Dockerfile 里 grep `^ARG SOURCE_COMMIT` 来决定
#   要不要传 --build-arg；没有这一行的套件会在**没有 SHA 绑定**的情况下跑，
#   而输出看起来一切正常（qa.sh 自己的注释就警告过这个形状）。
#   放在 CMD 之前而不是文件开头 —— 否则每次 commit 都会让上面的 COPY 层失效。
ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=$SOURCE_COMMIT

# 绑了还要看得见：把 source_commit 打进输出，否则报告里无法回溯测的是哪个提交。
CMD ["sh", "-c", "printf 'source_commit=%s\\n' \"$SOURCE_COMMIT\"; exec bun test server/src/auth-tokens.test.ts"]
