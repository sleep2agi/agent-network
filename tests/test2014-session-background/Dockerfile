ARG TEST2014_SOURCE_COMMIT=dev
FROM oven/bun:1.3.14
WORKDIR /app
COPY agent-node/src ./src
COPY agent-node/package.json ./package.json
RUN bun build ./src/runtime/opencode-copresence/v2-session.ts --target=node --packages=external --outdir /tmp/check-build
RUN bun build ./src/cli.ts --target=node --packages=external --outdir /tmp/cli-check
# L1 套件必须能被钉到提交上：qa.sh 靠 `^ARG TESTn_SOURCE_COMMIT` 决定传不传 --build-arg，
# 没有这一行不传**而且不报错**。这里既声明也打印，日志里能核对。
ENV TEST2014_SOURCE_COMMIT=$TEST2014_SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$TEST2014_SOURCE_COMMIT
RUN echo "source_commit=$TEST2014_SOURCE_COMMIT"
USER bun
# 拿不到真实 SHA 就 fail closed（照 tests/test746-setup-bun-pin/run.sh 的写法）；
# dev 是本地手工 build 的默认值，CI 由 qa.sh 传 40 位 SHA。
CMD ["sh", "-c", "case \"$TEST2014_SOURCE_COMMIT\" in dev) echo 'source_commit=dev (local build)' ;; *) echo \"$TEST2014_SOURCE_COMMIT\" | grep -Eq '^[0-9a-f]{40}$' || { echo 'FAIL: TEST2014_SOURCE_COMMIT must be one full lowercase Git SHA' >&2; exit 1; } ;; esac; exec bun test ./src/runtime/opencode-copresence/session-background.test.ts ./src/runtime/opencode-copresence/session-background-http.test.ts ./src/runtime/session-control-bridge.test.ts"]
