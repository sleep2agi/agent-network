# 为什么 test-npm-install 不进 per-PR CI

Verified: 2026-08-19
Revisit-when: Dockerfile 第 6 行不再是 `npm i -g @sleep2agi/*@preview`——
              即被测对象从「已发布的 npm preview」变成「本仓构建产物」时，
              它就该进 qa.sh 的 L1_TESTS，并删掉本文件。

## 理由：被测对象是**混合**的，其中一半不是这次提交

⚠️ 这里要说准，别照抄 test-npm-api 的理由 —— 我第一版就写错了，写成
「它测的不是这次提交」，实际只对了一半：

```
Dockerfile:6  RUN npm i -g @sleep2agi/commhub-server@preview @sleep2agi/agent-node@preview
Dockerfile:7  COPY agent-network/ /app/agent-network/
run.sh:6      ANET="bun /app/agent-network/bin/cli.ts"
```

| 组件 | 来源 | 属于这次提交？ |
|---|---|---|
| `anet` CLI | 仓内源码 | ✅ 是 |
| `commhub-server` / `agent-node` | npm `@preview` | ❌ 否 |

⇒ 它**确实**能覆盖 `agent-network/` 的改动，但它连的服务端是**已发布的 preview**：
- PR 改了 `server/` ⇒ 这道门看不见；
- 别人发了一版 preview ⇒ 它在**无关的 PR 上**变红。

一道绿和红都部分取决于「仓外何时发版」的门，不适合当 per-PR 判据。
它是**发版验证件**：验证「已发布的服务端 + 当前 CLI」端到端还能跑通。

## 本次修了什么（它在 main 上是 3 passed / 7 failed）

7 条失败**只有 2 个独立根因**，其余 5 条是级联：

### ① 逐字相等的版本钉子，随发版必然腐烂

```bash
[ "$PKG_VER" = "0.5.0-preview.28" ]      # 实测已经是 0.9.0-preview.29
```

Dockerfile 装的是**移动 tag** `@preview`，所以任何精确版本钉子都会过期。
🔴 **版本/计数类断言要写成地板或形状，不能写逐字相等 —— 否则「变好」也会把门打红。**
这个套件的真实意图是「npm 包装得上且能用」，不是「必须是某一版」。

### ② 被测对象被 `bunx` 换掉了，且用固定 sleep 当就绪

```bash
bunx @sleep2agi/commhub-server > /tmp/npm-install-server.log 2>&1 &
sleep 4
```

`bunx` 在**运行时**再拉一份，而 Dockerfile 已经 `npm i -g` 装好了 ——
本套件要验的正是「装上的那份能用」，`bunx` 把被测对象换成了另一份（还依赖运行时网络）。

实测：用**已安装的** `commhub-server` 起，`/health` 返回 **200**，
banner 打出 `CommHub MCP Server v0.9.0-preview.29`。
⇒ 「server failed to start」是**假失败**，产品没问题，后面 5 条 anet 失败全是它的级联。

固定 `sleep 4` 也换成了轮询 `/health` 响应体（最多 30s）——
**判据用 /health 的响应体，不用启动横幅：横幅先于就绪打印。**

### ③ `--runtime http-api` 已被产品移除

```
[anet] Refusing to create node: unsupported runtime "http-api"; expected one of:
claude-agent-sdk, claude-code-cli, codex-sdk, codex-app-server,
grok-build-acp, grok-build-cli, opencode-cli
```

同 #1106 那两条的形状：产品加了运行时白名单，套件写在它之前，**不是回归**。
换成受支持的 `claude-agent-sdk`（create 阶段不需要外部二进制，实测 rc=0）。
产品对未知 runtime 是**硬拒**的，所以这条断言在白名单再次变动时仍会变红。
