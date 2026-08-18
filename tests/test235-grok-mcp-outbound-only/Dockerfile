FROM oven/bun:1.3.14

ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=${SOURCE_COMMIT}

WORKDIR /workspace
COPY agent-network/package.json agent-network/package-lock.json /workspace/agent-network/
RUN cd /workspace/agent-network && bun install --ignore-scripts
COPY agent-network /workspace/agent-network
COPY agent-node /workspace/agent-node
COPY docs/grok-build-cli-preview.md /workspace/docs/grok-build-cli-preview.md
# 🔴 套件必须落在**与仓库同构**的位置。socket-harness.ts 里写的是
#     import { OUTBOUND_TOOL_NAMES } from "../../agent-network/src/outbound-tool-names";
#    这个相对路径在仓里（tests/test235-.../socket-harness.ts）指向仓根，是对的。
#    原来这里拷到 `/test235`，于是 `../../` 解析成 `/`，去找 `/agent-network` ——
#    而上面把它拷到了 `/workspace/agent-network`。报错是
#        error: Cannot find module '../../agent-network/src/outbound-tool-names' from '/test235/socket-harness.ts'
#    注意：**不是没拷进来**（第 9 行拷了），是拷到了相对路径够不着的地方。
#    我第一次就把它误判成「Dockerfile 没拷这个文件」了。
COPY tests/test235-grok-mcp-outbound-only /workspace/tests/test235-grok-mcp-outbound-only
RUN chmod 755 /workspace/tests/test235-grok-mcp-outbound-only/run.sh

ENTRYPOINT ["bash", "/workspace/tests/test235-grok-mcp-outbound-only/run.sh"]
