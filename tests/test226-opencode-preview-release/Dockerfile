# RFC-029 release pin matrix.
#
# Build the same real ACP/runtime harness against an exact opencode-ai
# version supplied with --build-arg.  This deliberately exercises the
# source that will be bundled into @sleep2agi/agent-node; no mock vendor
# process is used.

FROM oven/bun:1.3.1
# npm audit 端点 2026-09-04 间歇挂起(DEV 实测 4/6 次 20s 超时),npm 自带重试让一个 4s 的 npm link 变 4 分钟;
# 这些镜像里 npm 只负责装依赖,供应链检查另有门(check-supply-chain),关掉 audit/fund 不改变任何判据。
ENV npm_config_audit=false npm_config_fund=false

ARG OPENCODE_VERSION
RUN test -n "$OPENCODE_VERSION"

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash curl jq ca-certificates procps nodejs npm && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" --silent \
    && test "$(opencode --version)" = "$OPENCODE_VERSION" \
    && opencode acp --help >/tmp/opencode-acp-help.txt

WORKDIR /harness

COPY agent-node /agent-node-src
COPY tests/test-rfc029-pr4-kernel-live/harness.ts /harness/harness.ts
COPY tests/test-rfc029-pr4-kernel-live/run.sh /harness/kernel-live.sh
COPY tests/test226-opencode-preview-release/run.sh /harness/run.sh

RUN chmod +x /harness/run.sh /harness/kernel-live.sh

ENV OPENCODE_VERSION_UNDER_TEST="$OPENCODE_VERSION"
CMD ["bash", "/harness/run.sh"]
