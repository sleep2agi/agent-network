# Review: `tests/test10-token-ratelimit/run.sh`

Reviewed file:
- [tests/test10-token-ratelimit/run.sh](/home/vansin/agent-orchestra/tests/test10-token-ratelimit/run.sh:1)

Related implementation references:
- [server/src/index.ts](/home/vansin/agent-orchestra/server/src/index.ts:46)
- [server/src/auth.ts](/home/vansin/agent-orchestra/server/src/auth.ts:136)
- [server/src/tools.ts](/home/vansin/agent-orchestra/server/src/tools.ts:325)

## Conclusion

这个脚本有价值，但目前把一部分“理想安全边界”当成了“现有代码契约”，所以会产生误报。最主要的问题是：

- `utok_ 不能调 MCP` 不是当前实现下合理的既有预期
- `ntok_ 不能访问 /api/networks` 也不是当前实现下稳定成立的预期
- 有几条断言过宽，存在 false positive 风险
- 覆盖面还没有打到最关键的跨网络 REST 泄露点

## 1. 断言是否正确

### 1.1 `utok_ blocked from MCP tool` 这个预期不合理

脚本位置：
- [run.sh:69](/home/vansin/agent-orchestra/tests/test10-token-ratelimit/run.sh:69)

现状实现：
- `/mcp` 只要求 `resolveToken(token)` 成功，不区分 `utok_ / ntok_ / atok_`： [server/src/index.ts:159](/home/vansin/agent-orchestra/server/src/index.ts:159)
- `resolveToken()` 也没有把 `scope` 暴露给后续授权层： [server/src/auth.ts:136](/home/vansin/agent-orchestra/server/src/auth.ts:136)

所以从“当前代码契约”看，`utok_` 调 MCP 是被允许的。脚本把“应该被禁止”写成断言，会把当前实现和未来安全目标混在一起。

更合理的写法：
- 如果要测“当前行为”，应断言 `utok_` 能通过认证，但不能跨 network 写入未授权数据。
- 如果要测“目标安全策略”，应在用例名里明确这是 `expected-to-fail until scope enforcement exists`。

### 1.2 `ntok_ cannot enumerate unrelated networks` 这个预期也不稳定

脚本位置：
- [run.sh:82](/home/vansin/agent-orchestra/tests/test10-token-ratelimit/run.sh:82)

现状实现：
- `/api/networks` 只要求 token 可解析，然后按 `resolved.user.user_id` 返回该用户的成员网络： [server/src/index.ts:361](/home/vansin/agent-orchestra/server/src/index.ts:361)
- `resolveToken()` 不区分 token scope： [server/src/auth.ts:136](/home/vansin/agent-orchestra/server/src/auth.ts:136)

因此 `ntok_` 现在很可能可以列出“同一用户所属的网络”。脚本把这判成失败，属于把“期望的新权限模型”当成了“现有 API 规范”。

### 1.3 `ntok_` 跨 network 写入被拦截，这条断言是合理的

脚本位置：
- [run.sh:76](/home/vansin/agent-orchestra/tests/test10-token-ratelimit/run.sh:76)

原因：
- `/mcp` 会把 `ntok_` 绑定的 `network_id` 传给 `registerTools()`，工具层会优先使用强制 network： [server/src/index.ts:165](/home/vansin/agent-orchestra/server/src/index.ts:165), [server/src/tools.ts:10](/home/vansin/agent-orchestra/server/src/tools.ts:10)

所以“`ntok_` 不能写入别的 network”是符合当前实现的有效断言。

### 1.4 revoked / expired token、rate limit 断言基本合理

脚本位置：
- revoked / expired: [run.sh:87](/home/vansin/agent-orchestra/tests/test10-token-ratelimit/run.sh:87)
- rate limit: [run.sh:112](/home/vansin/agent-orchestra/tests/test10-token-ratelimit/run.sh:112)

这些和当前实现是对齐的：
- `resolveToken()` 会检查 `expires_at`： [server/src/auth.ts:139](/home/vansin/agent-orchestra/server/src/auth.ts:139)
- login/register rate limit 在路由层定义得很明确： [server/src/index.ts:227](/home/vansin/agent-orchestra/server/src/index.ts:227), [server/src/index.ts:242](/home/vansin/agent-orchestra/server/src/index.ts:242)

## 2. False positive / False negative 风险

### 2.1 `grep '"ok":false\|"error"'` 过宽，容易 false positive

脚本位置：
- [run.sh:70](/home/vansin/agent-orchestra/tests/test10-token-ratelimit/run.sh:70)

问题：
- 这是对整段 MCP 返回做字符串匹配，不是对结构化 JSON 断言。
- 只要返回体里出现 `"error"` 字样，无论是不是权限错误，都可能被判成“成功拦截”。

建议：
- 解析 MCP `result.content[0].text` 里的 JSON，再精确判断 `ok === false` 和 `error` 内容。

### 2.2 `NTOK_MCP` 变量未使用，导致断言不完整

脚本位置：
- [run.sh:72](/home/vansin/agent-orchestra/tests/test10-token-ratelimit/run.sh:72)

问题：
- 脚本发了 `NTOK_MCP`，但没直接检查这个调用返回是否成功。
- 后面是靠 `/api/status` 间接验证，能看出副作用，但看不出 MCP 返回本身是不是异常。

建议：
- 直接断言 `NTOK_MCP` 返回里 `ok:true`。

### 2.3 过期 token 测试直接改 sqlite，耦合底层实现

脚本位置：
- [run.sh:100](/home/vansin/agent-orchestra/tests/test10-token-ratelimit/run.sh:100)

问题：
- 它假设后端一定是 sqlite 文件，且路径固定为 `/root/.commhub/commhub.db`。
- 如果以后 `db-adapter` 切换到别的后端，这条测试会变成基础设施 false negative。

这在 Docker E2E 里可以接受，但应该在注释里明确“这是测试注入，不是公共接口行为”。

### 2.4 `setup tokens and networks` 是弱断言

脚本位置：
- [run.sh:58](/home/vansin/agent-orchestra/tests/test10-token-ratelimit/run.sh:58)

问题：
- 它只检查关键字段是否非空，没有检查 `NET2_RES` 或 `NODE2` 是否 `ok:true`。
- 如果返回体结构变了，也可能出现“字段为空之外的信息没被识别”的情况。

建议：
- 对 `NET2_RES`、`NODE2`、`REG_B` 都单独校验 `ok:true`。

## 3. 覆盖遗漏

当前脚本没有覆盖到最重要的几类问题：

### 3.1 没测 REST 跨网络读泄露

应该补：
- `utok_` 是否能读别的 network 的 `/api/stats?network_id=...`
- `utok_` 是否能读别的 network 的 `/api/nodes?network_id=...`
- `/api/messages`、`/api/task_events`、`/api/completions` 是否会返回全局数据

这些是当前代码里更危险的边界问题。

### 3.2 没测 REST `POST /api/task` 的权限边界

应该补：
- `viewer` 或任意已登录用户能否直接走 `/api/task` 发任务

这条路径和 MCP `send_task` 是不同的，当前实现风险更大。

### 3.3 没测 token scope 是否影响用户接口

应该补：
- `ntok_` 调 `/api/auth/me`
- `ntok_` 调 `/api/auth/tokens`
- `full token` 调用户相关接口

否则“token boundary”这个名字只测了一部分。

### 3.4 没测 legacy `COMMHUB_AUTH_TOKEN` 的旁路能力

既然服务端保留了这个入口，就应该明确测：
- 它能访问哪些接口
- 它是否绕过 network membership

### 3.5 没测 localhost exemption

rate limit 只测了伪造外部 IP，没有补一条 localhost 不受限的正向验证。

## 建议修改方向

建议把脚本拆成两层：

1. `current-contract` 断言
- 只验证当前实现明确承诺的行为

2. `security-target` 断言
- 把尚未落地的 scope / permission 目标单列出来
- 明确标注为“bug test”或“expected fail until fixed”

具体到这份脚本，最需要调整的是：

- 把 `utok_ blocked from MCP tool` 改成更精确的 network-boundary 断言
- 把 `ntok_ cannot enumerate unrelated networks` 改成 scope-spec 断言，或先删除
- 把 MCP 返回判断改成结构化 JSON 解析
- 补 REST 侧跨 network 泄露与 `/api/task` 权限测试

## 最终判断

这份脚本不是没用，而是“安全目标测试”和“现状回归测试”混写了。  
如果直接拿它当稳定回归，会把设计差异、接口未定义行为、以及真正 bug 混在一起，结果噪声会比较大。
