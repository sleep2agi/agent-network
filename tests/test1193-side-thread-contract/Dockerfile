FROM oven/bun:1.3.14-debian

WORKDIR /app
ARG TEST1193_SOURCE_COMMIT=unknown
ENV TEST1193_SOURCE_COMMIT=${TEST1193_SOURCE_COMMIT}

# #2224 —— side-thread 的台账/租约/出件队列现在把 rename 走 shared/windows-rename-retry
# （Windows 的 EPERM/EBUSY 重试）。本镜像只复制 side-thread 目录，缺这支会在加载时报
# "Cannot find module '../../shared/windows-rename-retry'"——那是**跑法造成的红**。
COPY agent-node/src/shared /app/agent-node/src/shared
COPY agent-node/src/runtime/side-thread /app/agent-node/src/runtime/side-thread
COPY tests/test1193-side-thread-contract /app/tests/test1193-side-thread-contract
RUN chmod +x /app/tests/test1193-side-thread-contract/run.sh

CMD ["/app/tests/test1193-side-thread-contract/run.sh"]
