# @sleep2agi/agent-node 2.5.0-preview.55

## 为什么发这一版：这条链的**另一半**一直没发出去

`anet daemon list` 从 `agent-network@2.3.0-preview.70` 起会念「创建能力」那一格，
但**产出那一格的是 daemon 侧**，住在 `agent-node` 里 —— 而 agent-node 一直停在 `.54`。

实测（2026-08-30，带正控）：

```
agent-node main 的 package.json    2.5.0-preview.54
agent-node npm 上的 preview         2.5.0-preview.54     ← 同一个数字
main   config-apply.ts:570          会产出 create_capability_observed_ms_ago
npm 已发布的 dist/cli.js            该字符串出现 0 次
正控   同一份 dist 里 can_create_nodes 出现 1 次
       ⇒ grep 有效、压缩没吃掉这类属性名，所以那个 0 是真的 0
```

⇒ 升级 CLI 的人只会看到「未知 —— 这台 daemon 没报过这一格」，**而不是真实的新鲜度**。

🔴 **这正是 SOP §2.5 那条判据陷阱的又一次实例**：版本号逐字相同、内容不同。
判据必须落在**产物内容**上。发版时要问的不是「我改了什么」，是
**「这条链的每一半分别住在哪个包里」**。

## 内容（#1545 的 daemon 侧）

- **拆掉 `_createCapCache` 的按进程语义**（#1560）。此前 daemon 开机算一次就永久缓存：
  开机时 pin 坏 → 之后永远上报 blocked（哪怕运维已经修好）；开机时好 → 之后二进制被
  `chmod` 或被 `anet upgrade` 换掉，**永远上报 ready** —— 后者是朝「没问题」方向说谎。
- **每次上报重算**，并带上 `create_capability_observed_ms_ago`（那一格是多久以前测的）。
- 合并 `CreateBlockedReason` 的同义副本（此前 cli.ts 与 config-apply.ts 各一份，漂开时
  daemon 会报出 hub enum 没有的值 → 非 strict → **静默丢弃**）。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.55
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.55
# daemon 需要重启才会用新逻辑：
anet node stop <daemon> && anet daemon start <daemon>
```

验收（SOP §2.5 四步，第 ④ 步不能省）：

```bash
npm view @sleep2agi/agent-node dist-tags.preview                 # 2.5.0-preview.55
npm pack @sleep2agi/agent-node@2.5.0-preview.55
tar -xzf *.tgz && grep -c create_capability_observed_ms_ago package/dist/cli.js   # 期望 >0
# 正控:同一份 dist 里 can_create_nodes 也要 >0,否则说明 grep 本身无效
```

## 发布方式

`release-gate (v0)`，`package=agent-node`、`version=2.5.0-preview.55`、`publish=true`。
只发 preview；promote 到 latest 需要 owner ACK，本次**不做**。
