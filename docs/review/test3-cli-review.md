# CLI Review

Reviewed files:
- [agent-node/src/cli.ts](/home/vansin/agent-orchestra/agent-node/src/cli.ts)
- [agent-network/bin/cli.ts](/home/vansin/agent-orchestra/agent-network/bin/cli.ts)

## Findings

### High

1. `agent-node` 的 `http-api` runtime 不是和 Claude/Codex 同等级实现，功能明显缺失。[agent-node/src/cli.ts](/home/vansin/agent-orchestra/agent-node/src/cli.ts:511)
   它没有 session/thread resume、没有 tools、没有图片输入、没有预算控制、没有重试、也没有过程级日志；而 Claude 和 Codex 都实现了其中的大部分能力。[agent-node/src/cli.ts](/home/vansin/agent-orchestra/agent-node/src/cli.ts:351) [agent-node/src/cli.ts](/home/vansin/agent-orchestra/agent-node/src/cli.ts:419)

2. `agent-node` 启动时的 token 校验过于宽松，token 无效也继续启动并注册/SSE 重连。[agent-node/src/cli.ts](/home/vansin/agent-orchestra/agent-node/src/cli.ts:923)
   这里直接 `r.json()`，不先检查 HTTP 状态；401/403、非 JSON、老服务等情况最后都可能只变成 warn。后续仍然执行 `register()` 和 `connectSSE()`。[agent-node/src/cli.ts](/home/vansin/agent-orchestra/agent-node/src/cli.ts:955)

3. `agent-network create` 会把 `ntok_` 明文写入节点配置文件，默认体验方便，但安全边界偏弱。[agent-network/bin/cli.ts](/home/vansin/agent-orchestra/agent-network/bin/cli.ts:1110)
   CLI 通过 `/api/auth/node-token` 换取网络级 token 后，直接写进 `.anet/nodes/<name>/config.json`。这意味着项目目录泄露即泄露可操作网络 MCP 的长期凭据。

### Medium

4. `agent-node` 的 `network_id` 优先级和 token/hub 的优先级风格不一致，容易造成配置认知错误。[agent-node/src/cli.ts](/home/vansin/agent-orchestra/agent-node/src/cli.ts:319)
   当前是 `fileConfig.network_id || process.env.ANET_NETWORK_ID || globalConfig.network_id`，而 token 是 `env > node config > global config`。[agent-node/src/cli.ts](/home/vansin/agent-orchestra/agent-node/src/cli.ts:162)

5. Telegram 通道没有复用 `processTask()` 主流程，导致状态上报与过滤策略不一致。[agent-node/src/cli.ts](/home/vansin/agent-orchestra/agent-node/src/cli.ts:781)
   Telegram 消息走 `think()`，绕过了 `reportStatus("working"/"idle")`、统一错误包装和低价值回复策略。[agent-node/src/cli.ts](/home/vansin/agent-orchestra/agent-node/src/cli.ts:603)

6. `anet quickstart` 的 runtime 选项与 CLI 实际支持集不一致，用户会被引导到一个 `create` 阶段并未完整支持的选项。[agent-network/bin/cli.ts](/home/vansin/agent-orchestra/agent-network/bin/cli.ts:2371)
   Quickstart 暴露了 `http-api`，但 `createCommand()` 的 usage 只声明 `claude-code-cli|codex-sdk|claude-agent-sdk`。[agent-network/bin/cli.ts](/home/vansin/agent-orchestra/agent-network/bin/cli.ts:1060) 实际上 `normalizeRuntime()` 也不会把 `http-api` 识别成合法 runtime，会回退成 `claude-code-cli`。[agent-network/bin/cli.ts](/home/vansin/agent-orchestra/agent-network/bin/cli.ts:79)

7. `anet login --token` 只写 `current_network`，不拉取网络列表，导致保存的 network 上下文可能不完整。[agent-network/bin/cli.ts](/home/vansin/agent-orchestra/agent-network/bin/cli.ts:2469)
   普通登录分支会再调用 `/api/networks` 并选择网络；token 登录分支没有这一步，导致 `network_name` 可能缺失。[agent-network/bin/cli.ts](/home/vansin/agent-orchestra/agent-network/bin/cli.ts:2504)

8. `anet network create` 创建成功后没有自动切换到新网络，和很多 CLI 用户的预期不一致。[agent-network/bin/cli.ts](/home/vansin/agent-orchestra/agent-network/bin/cli.ts:2585)
   后续 `create`、`start`、`invite` 等命令仍然依赖全局当前网络，容易让用户误以为自己已经进入新网络。

### Low

9. `agent-node connectSSE()` 的解析器只按单行 `data:` 处理，不支持标准 SSE 的多行 data 聚合与 `event:`/`id:` 字段。[agent-node/src/cli.ts](/home/vansin/agent-orchestra/agent-node/src/cli.ts:894)
   当前对现有服务可能够用，但协议兼容性偏弱。

10. `agent-network quickstart` 对错误原因的区分不够清晰，注册失败后直接 fallback 到登录。[agent-network/bin/cli.ts](/home/vansin/agent-orchestra/agent-network/bin/cli.ts:2332)
   如果真实原因是 429、服务异常、JSON 错误，不会先告诉用户“注册失败的原因”，而是直接尝试登录，增加排障噪音。

## Runtime Consistency

`agent-node` 三个 runtime 目前分成三个层级：
- Claude 最完整：支持 tools、maxTurns、budget、resume、tool hook、stderr、usage/cost 日志。
- Codex 次完整：支持 thread resume、structured input、事件流日志、失败后重建线程重跑。
- HTTP 最弱：一次性请求封装，只适合最基础文本问答，不适合被宣传成与前两者等价的 runtime。

这不是小差异，而是能力模型不同。CLI 和文案里如果继续把三者并列成同一层，需要明确标注 `http-api` 是降级模式。

## Token Use

`agent-node`
- token 优先级正确：`env > node config > global config`。[agent-node/src/cli.ts](/home/vansin/agent-orchestra/agent-node/src/cli.ts:162)
- `network_id` 优先级不一致：`node config > env > global config`。[agent-node/src/cli.ts](/home/vansin/agent-orchestra/agent-node/src/cli.ts:319)
- SSE/MCP 都正确带了 `Authorization: Bearer ...`。[agent-node/src/cli.ts](/home/vansin/agent-orchestra/agent-node/src/cli.ts:281) [agent-node/src/cli.ts](/home/vansin/agent-orchestra/agent-node/src/cli.ts:879)

`agent-network`
- `getToken()` 是 `CLI --token > env > global config`，实现清晰。[agent-network/bin/cli.ts](/home/vansin/agent-orchestra/agent-network/bin/cli.ts:26)
- `createCommand()` 会优先为节点申请 `ntok_`，这是对网络隔离友好的默认值。[agent-network/bin/cli.ts](/home/vansin/agent-orchestra/agent-network/bin/cli.ts:1110)
- 但 token 的落盘和展示策略仍偏宽松，缺少更明显的安全提醒。

## Error Handling

做得比较好的地方：
- `friendlyError()` 至少覆盖了常见 401/403/429 和连通性错误。[agent-network/bin/cli.ts](/home/vansin/agent-orchestra/agent-network/bin/cli.ts:560)
- `processTask()` 用 `finally` 保证 agent 状态会回到 idle。[agent-node/src/cli.ts](/home/vansin/agent-orchestra/agent-node/src/cli.ts:603)

不足主要在两类：
- 宽泛吞错太多：`catch {}` 在 `agent-node` 和 `agent-network` 都比较多，导致真实故障被静默降级，例如 token 校验、网络选择、节点 token 申请、quickstart 登录后网络拉取。
- HTTP runtime 缺少和 Claude/Codex 同级的失败日志和恢复策略。

## UX Notes

- `quickstart` 把 `http-api` 暴露为一等选项，但后续 create/runtime 体系没有真正对齐，容易让用户以为选了某个 runtime，实际却走了回退路径。
- `login --token` 和普通 `login` 的后续行为不同，用户很难理解为什么一个会补齐网络上下文，一个不会。
- `network create` 后不自动切换网络，会让“刚创建网络就去 create/start 节点”的路径显得别扭。
- `agent-node` 在无 token 时只打印告警继续运行，对新用户来说不容易意识到“此时没有数据隔离”是高风险状态。[agent-node/src/cli.ts](/home/vansin/agent-orchestra/agent-node/src/cli.ts:947)

## Summary

当前两份 CLI 的核心问题不是“不能用”，而是边界和心智模型不够一致：
- runtime 在文案层被并列，但实现层并不对齐；
- token/network 在默认路径上大体正确，但优先级、校验严格度和落盘安全性还不统一；
- quickstart/login/create/network 这些高频入口的行为存在细小但会累积成困惑的分叉。

优先建议：
1. 统一 `network_id` 和 token/hub 的优先级策略。
2. 把 `http-api` 明确标为降级 runtime，或补齐最小能力集合。
3. 让 `quickstart`、`create`、`login --token` 的网络选择逻辑完全一致。
4. 收紧 token 校验与 token 落盘提示，至少在无效 token / 无 token 场景上更明确地 fail fast 或强提醒。
