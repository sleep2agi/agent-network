FROM oven/bun:1.3.1

RUN apt-get update \
  # python3: leader-lifecycle.test.ts 的 zombie 回归用例需要一个裸 fork()
  # 来造 zombie(#1315)。实测 sh / bash / setsid bash 三种 shell 都会在下一条
  # 命令前 reap 掉后台作业,/proc 条目直接消失而不是显示 Z,所以造不出来。
  # 本套件跑的是整个 src/runtime/grok-copresence 目录,因此也会执行到那条用例。
  && apt-get install -y --no-install-recommends gcc libc6-dev python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY agent-network /workspace/agent-network
COPY agent-node /workspace/agent-node
COPY tests/test233-grok-main-integration /test233
RUN chmod 755 /test233/run.sh

ENTRYPOINT ["bash", "/test233/run.sh"]
