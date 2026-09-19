# agent-node 2.5.0-preview.74

`.73` 之后 `agent-node/` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| f0f9bd58 | #1928 | 把「多节点共用同一份 codex 登录态」的检测**下沉到本包**:不经 `anet` CLI、直接起 `agent-node/dist/cli.js` 的节点现在也会写指纹并告警;同时按「这份凭据还在不在被刷新」分支告警文案(#1918) |

## 🔴 为什么必须有这一版:上一版的护栏对绝大多数节点是不生效的

`.97`/`.73` 里那条共享登录态护栏,调用点**全部**在 `agent-network/bin/cli.ts`,也就是 `anet node start --copresence` 这一条路径上。

一台真实机器上逐台 `ps` / `/proc/*/cmdline` 清点 **35 台**节点的结果:经 `anet node start` 起的只有 **4 台**;其余 **31 台**是自定义脚本直接起 —— bridge 是 `node …/agent-node/dist/cli.js --config …`,app-server 是裸 `codex app-server --listen ws://…`。而那 31 台正是**共用同一个 codex 账号**的那批,也就是这条护栏唯一存在的理由。

⇒ **装了 `.97` 的包,对它们什么都不会发生**:不写指纹文件,不打告警。要让它生效,反而得先把 31 台的启动方式改回经 CLI —— 为一个诊断功能改 31 台起法,代价和风险都不成比例。**这是实现位置的问题,不是使用方式的问题。**

本版把行为放到 `agent-node`,因为它是**两条路的交汇点**:自定义脚本直接起它;而 anet 的共存路径最终也把 bridge 作为 agent-node 再入。放这里,两条路同时覆盖,且**不要求任何人改启动方式**。

## 第二件:告警文案在「谁都刷不动」的主机上是错的

旧文案逐字是 `whichever node refreshes first keeps working` —— 它假设刷新**是能成功的**。在出网到不了 OAuth token 端点的主机上(直连被拒、公司代理只放行模型 API 所以 403),**谁都刷不动**,共享同一份凭据的节点不是「先刷者活、其余后死」,而是**一起停**。

现场物证:三台节点的 `auth.json` **整文件字节全等**,连 access token 都是同一枚,`exp` 同为一个时刻 ⇒ 三台同时过期。

本版按**这份 copy 的 access token 是否已经过期**分支 —— 已过期 ⇒ 这份凭据显然已经没人在刷了,打「一起停」那一套(并给出已过期多久、以及「先修出网,别拷别的节点的 auth.json,那正是共链的来源」);未过期 ⇒ 保留原文案,并用 token 自己的 `exp` 补一句「还有多久到期」。

🔴 **它不声称知道网络状况**:启动路径上不该开 socket,而且探针只回答「此刻通不通」,回答不了那个十天长的窗口。判据用的是**凭据自己带的可观测事实**。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.74
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.98 @sleep2agi/agent-node@2.5.0-preview.74
```

🔴 **两个包要一起升。** 实现是一份**逐字节相同**的模块同时存在于两个包里(有 parity 门钉着),两条启动路径各用各的那份 —— 只升一个,另一条路径上的节点仍是旧行为。

## 证据

- **主判据落在「不经 CLI」那条路上**:只用 agent-node 起的节点写出 `.codex-auth-fingerprint.json`(mode 600);第二个节点共用同一份凭据时点名第一个;凭据不同则**一行都不打**;邻居的 `auth.json` 读不了也照样能检测到 —— 证明横向比较只读**别人公布的摘要**,不读别人的凭据。
- **两向见证**:拿掉 agent-node 的调用点 ⇒ 源码契约红(15 pass / 1 fail),恢复 16/0;把文案退回单分支 ⇒ 4 条红(12 pass / 4 fail),恢复 16/0;把两份 copy 改出一个字节的差 ⇒ parity 门红。
- 两个包不能互相 import(agent-node 不依赖 `@sleep2agi/agent-network`,反向被 `grok-build-drift.test.ts` 禁止),所以用了本仓对同一问题的既有答案(`telemetry-source-parity.test.ts`,#1727),而不是另造机制。为了能逐字节复制,模块现在只依赖 node 内置。
- agent-node 全套 1864 pass / 0 fail;typecheck 棘轮 81 = 基线;无 `tests/*/run.sh` 的 sed 锚落在改动行上。
- 🔴 一格自曝:`hub-timestamp-ratchet` 抓到了我自己新写的 `new Date(<ISO 串>)`。那是一道**计数棘轮**,故意不判单点,因为这个缺陷类**测试看不见**(bun 把测试钉在 UTC,本地与 UTC 解析结果一致)。"我这个值是自己 `toISOString()` 出来的,安全" —— 这正是每一个后来者都会说的话,所以没有抬基线,而是加了 `parseIsoInstant()`:要求显式时区,否则返回 null。

## promote 时的 must_contain

`"version": "2.5.0-preview.74"`
