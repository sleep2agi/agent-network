# @sleep2agi/agent-network 2.3.0-preview.70

## 为什么发这一版

`.69` 已在 npm（2026-08-30T03:42Z）。**它的 `exports` 里只有 `"."`** ——
`./daemon-capability-display` 子路径导出是 #1568 合入的，晚于 `.69` 出包。

```
npm view @sleep2agi/agent-network@2.3.0-preview.69 exports
→ { ".": { import: "./dist/src/client.js", types: "./dist/client.d.ts" } }
```

⇒ Dashboard 复用 `describeCapability` 这条路**在 `.69` 上走不通**，必须发 `.70`。

🔴 **注意这里有一个会骗人的对照**：`.69` 之前 `agent-network/package.json` 里写的也是
`2.3.0-preview.69`，与 npm 上的版本号**逐字相同** —— 只看版本号会得出「已经发过了」。
**判据必须是产物内容**（这里比的是 `exports` 键），不是版本号。

## 这一版包含什么（#1545 一条完整的链）

| PR | 内容 |
|---|---|
| #1555 | `probeAnetBinReadiness` —— 把 anet_bin 判定变成不抛异常、可被问出来的值 |
| #1558 | hub 收下并带出 `create_capability_observed_ms_ago`（那一格是**多久以前**测的） |
| #1560 | daemon 拆掉进程级缓存，**每次上报重算**并带年龄 |
| #1565 | `anet daemon list` 说出「这台 daemon 现在能不能建节点」，五种情况五句不同的话 |
| #1567 | 文档改掉与工具**相反**的那句话（原文说 `anet daemon list` 只读本机配置） |
| #1568 | 子路径导出 `./daemon-capability-display`，供 Dashboard 复用**同一份判据** |

另含本轮的工程质量改动：agent-node 首次拥有类型检查棘轮（#1550，基线 86 → 81）、
`doc-symbol-pins` 支持字面量锚并因此捞出一处 85 行的真实漂移（#1566）、
`check-docs-site-drift` 不再把代码围栏里的行当指纹（#1552）。

## 发布方式

`release-gate (v0)` workflow_dispatch，`package=agent-network`、
`version=2.3.0-preview.70`、`publish=true`。**四道门全绿才发**，且**只发 preview 通道**。
promote 到 latest 需要 owner ACK，本次**不做**。

## 验收判据（发完必须自己核，别只看 workflow 绿）

```bash
npm view @sleep2agi/agent-network dist-tags.preview        # 期望 2.3.0-preview.70
npm view @sleep2agi/agent-network@2.3.0-preview.70 exports # 期望含 ./daemon-capability-display
```

🔴 **第二条不能省**：workflow 绿说明「发布这个动作成功了」，
而这一版存在的全部理由是**那个子路径导出真的在包里**。
两者不是一回事 —— `.69` 就是「发布成功、但要的东西不在里面」。
