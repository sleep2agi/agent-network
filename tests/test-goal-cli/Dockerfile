FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:/usr/local/bin:/usr/bin:/bin"

WORKDIR /workspace
COPY . /workspace

# SHA 绑定（#1092）。scripts/qa.sh 从这里 grep `^ARG SOURCE_COMMIT` 决定传不传
# --build-arg；没有这一行就**不传，而且不报错**，本次运行无法被钉到任何提交上。
# 放在 ENTRYPOINT 之前而不是文件开头 —— 否则每次 commit 都会让上面的 COPY 层失效。
ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=$SOURCE_COMMIT

ENTRYPOINT ["bash", "tests/test-goal-cli/run.sh"]
