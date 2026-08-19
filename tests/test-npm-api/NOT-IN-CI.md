# 为什么 test-npm-api 不进 per-PR CI

Verified: 2026-08-19
Revisit-when: run.sh 第 30 行不再是 `npm install -g @sleep2agi/*@preview`——
              也就是这套断言的对象从「已发布的 npm preview」变成「本仓构建产物」时，
              它就该进 qa.sh 的 L1_TESTS，并删掉本文件。

## 理由：它测的不是这次提交

```
run.sh:30  npm install -g @sleep2agi/agent-network@preview \
                          @sleep2agi/agent-node@preview \
                          @sleep2agi/commhub-server@preview
```

⇒ 它起的 `commhub-server` 是**已发布到 npm 的 preview 版本**，不是 PR 里的代码。
把它挂进 per-PR CI 会造出一道**量错对象**的门：

- PR 改了 `server/src/tools.ts` → 这道门**看不见**（跑的是 npm 上那份）；
- 别人发了一版 preview → 这道门在**与之无关的 PR 上**变红。

两种情况下它的绿和红都不对应被审的那次改动。**一道在错误对象上开合的门，
比没有门更糟**：它会让人以为这条路径被覆盖了。

它还依赖 npm registry 网络可达（本机实测 build+run ≈ 60s+120s，其中绝大部分是
`npm install`）——这是第二个理由，但不是主要理由。

## 那它是什么

**发版验证件**：验证「已发布的三个包装上之后，端到端还能跑通」。
它该在发版流程里跑，由发版的人看，而不是在每个 PR 上跑。

## 本次（#1106）改了什么

它在 main 上一直是红的（21 条里 2 条失败），而且**两条都不是回归**：

1. `from_session_identity_mismatch` —— 产品新增了 ntok_ 身份守卫
   (`server/src/tools.ts:29-33`)，套件写在它之前；
2. utok 调 /mcp 期望 403，实际 200 —— V3 有意变更，理由写在
   `server/src/server.ts:725-728`（Dashboard 以用户身份登录，挡掉 utok_ 它就没法发任务）。

🔴 两条最省事的修法（让 send_task 直接能过、把 403 改成 200）都会让它变绿，
   但会**删掉仅有的两条安全断言**。本次改的方向相反 —— 断言数 20 → 22：

- ntok_ happy path 用与令牌绑定一致的 from_session（能过），
  **并新增**一条负向断言：换成别的别名必须被 `from_session_identity_mismatch` 拒绝；
- 把「utok 连不上」换成**现在真实存在的那条边界**：utok 能调 /mcp，但只能触及
  自己有权限的 network。配一条**正控**（同 token 写自己加入的网络必须成功），
  这样「被拒」不会被误读成「边界生效」——若请求本身坏了，正控会一起红。
