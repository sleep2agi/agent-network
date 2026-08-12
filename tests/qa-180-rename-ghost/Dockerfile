# P0 #180 rename ghost reproduction — docker e2e.
#
# Reproduces the reported symptom (rename --force → old claude process
# doesn't die → dashboard ghost). Uses a MOCK 'claude' binary (shell
# script) that emulates the process shape of real claude-code-cli:
#   - Accepts `-n <alias>` argv (matches findNodeProcessesByAlias)
#   - Heart-beats via POST /api/status every 2s (mimics MCP report_status)
#   - Ignores SIGTERM (simulates slow shutdown) unless SIGKILL / --force
#   - Fires a --tmux launch variant to test the tmux code path
#
# No real API key needed — the mock is a pure process-shape fixture that
# exercises anet's kill/verify logic without going through the SDK.
#
# Install path identical to qa-rfc026/qa-rfc027 (local source, no npm
# @preview) per RFC-024 教训.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates jq unzip procps tmux \
    build-essential python3 \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# bun 安装:重试 + fail-closed。与 tests/qa-cli-01-hub-start/Dockerfile 同一写法(#733)。
#
# 原来是 `curl -fsSL https://bun.sh/install | bash`,有两个坑:
#   1. Docker 用 /bin/sh 执行,没有 pipefail —— 管道的退出码只反映 bash(consumer),
#      curl(producer)失败会被吃掉,层照样通过;
#   2. 光靠事后 `test -x` 也分不清「本次装成功」和「上一次失败尝试留下的二进制」。
# 所以这里先把安装脚本下载到临时文件,curl 成功才执行,两步都成功才置 installed=1,
# 最后要求 installed=1 且二进制存在 —— 否则构建失败,不放行。
#
# 触发这次修改的实证:2026-08-13 本门在 PR #740 上红,失败原因正是
#   process "/bin/sh -c curl -fsSL https://bun.sh/install | bash" ... exit code: 1
# 这是硬门(非 report-only),所以上游 bun.sh 的任何抖动都会卡住每一个 PR。
RUN installed=0; \
    for i in 1 2 3; do \
      rm -f /tmp/bun-install.sh; \
      if curl -fsSL https://bun.sh/install -o /tmp/bun-install.sh \
          && bash /tmp/bun-install.sh; then \
        installed=1; \
        break; \
      fi; \
      echo "bun install attempt $i failed; retrying in $((i*5))s"; \
      sleep $((i*5)); \
    done; \
    rm -f /tmp/bun-install.sh; \
    test "$installed" = 1 && test -x "$HOME/.bun/bin/bun" \
      || { echo "bun install failed after 3 attempts"; exit 1; }
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app

COPY server /app/server
COPY agent-node /app/agent-node
COPY agent-network /app/agent-network
COPY tests/lib /app/tests/lib
COPY tests/qa-180-rename-ghost/mock-claude /usr/local/bin/claude
COPY tests/qa-180-rename-ghost/run.sh /app/tests/qa-180-rename-ghost/run.sh
RUN chmod +x /usr/local/bin/claude /app/tests/qa-180-rename-ghost/run.sh

RUN cd /app/server && bun install --silent
RUN cd /app/agent-node && bun install --silent && bun run build
RUN cd /app/agent-network && bun install --silent && bun run build

RUN cd /app/agent-node \
    && npm pack \
    && npm install -g ./sleep2agi-agent-node-*.tgz
RUN cd /app/agent-network \
    && npm pack \
    && npm install -g ./sleep2agi-agent-network-*.tgz

RUN anet --version && which anet && which claude

CMD ["/app/tests/qa-180-rename-ghost/run.sh"]
