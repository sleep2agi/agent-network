FROM oven/bun:1

WORKDIR /app
COPY server/package.json server/package-lock.json server/
# #466 —— 测试 import server/src(db.ts 的 import 链会带上 zod 等,#2247 起经 node-health-store)。
# 依赖照 lockfile 装;以前没装也能绿,只是因为那条 import 链碰巧零依赖。
RUN cd server && bun install --frozen-lockfile
COPY server/src/ server/src/
ENV COMMHUB_DB=/tmp/qa-ut-03.db

# 🔴 SHA 绑定。scripts/qa.sh 从 Dockerfile 里 grep `^ARG SOURCE_COMMIT` 来决定
#   要不要传 --build-arg；没有这一行的套件会在**没有 SHA 绑定**的情况下跑，
#   而输出看起来一切正常（qa.sh 自己的注释就警告过这个形状）。
#   放在 CMD 之前而不是文件开头 —— 否则每次 commit 都会让上面的 COPY 层失效。
ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=$SOURCE_COMMIT

# 绑了还要看得见：把 source_commit 打进输出，否则报告里无法回溯测的是哪个提交。
CMD ["sh", "-c", "printf 'source_commit=%s\\n' \"$SOURCE_COMMIT\"; exec bun test server/src/auth-validate.test.ts"]
