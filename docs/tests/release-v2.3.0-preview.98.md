# `@sleep2agi/agent-network@2.3.0-preview.98`

`.97` 之后 `agent-network/bin|src` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| f0f9bd58 | #1928 | 共享 codex 登录态的检测**整段抽成 `checkCodexCredentialSharing`**,本包的 CLI 路径改为一行委派;同一份实现逐字节复制进 `agent-node`,让不经 CLI 起的节点也能检测;告警文案按「这份凭据还在不在被刷新」分支(#1918) |

## 🔴 这一版修的是 `.97` 的一个位置错误

`.97` 把护栏装在了本包的 `anet node start --copresence` 路径里。一台真实机器逐台清点 **35 台**节点:经 `anet node start` 起的只有 **4 台**,其余 **31 台**是自定义脚本直起 `agent-node/dist/cli.js` + 裸 `codex app-server` —— 而那 31 台正是共用同一个 codex 账号的那批。⇒ **`.97` 对最需要它的节点是不生效的**,而让它生效要去改 31 台的启动方式,代价与风险都不成比例。

本版把实现下沉到 `agent-node`(那是两条路的交汇点),本包保留自己的调用点并改为委派:

- 两份实现**逐字节相同**,由 `codex-auth-fingerprint-parity.test.ts` 钉住(两个包不能互相 import:agent-node 不依赖本包,反向被 `grok-build-drift.test.ts` 禁止;用的是本仓对同一问题的既有答案 `telemetry-source-parity.test.ts` / #1727,不另造机制)。
- `bin/cli.ts` 那边现在只剩一行调用,并有契约测试断言它**没有**重新长出自己的 `readdirSync` / `fingerprintRefreshToken` / `collidingNodes` / `sharedCredentialWarningLines`。

## 第二件:告警文案在「谁都刷不动」的主机上是错的

`whichever node refreshes first keeps working` 假设刷新**能成功**。在到不了 OAuth token 端点的主机上(直连被拒、公司代理只放行模型 API ⇒ 403),谁都刷不动,共享同一份凭据的节点**一起停**。现场物证:三台的 `auth.json` 整文件字节全等、access token `exp` 同为一个时刻 ⇒ 同时过期。

分支判据是**这份 copy 的 access token 是否已过期**(读 JWT 自己的 payload,不验签):已过期 ⇒ 打「一起停」那一套 + 先修出网 + **别去拷别的节点的 auth.json(那正是共链的来源)**;未过期 ⇒ 保留原文案 + 用 `exp` 补一句还有多久到期。启动路径上不开 socket:探针只回答「此刻通不通」,答不了那个十天长的窗口。

顺带一格:两台节点**共用同一个 CODEX_HOME** 时,旧建议(「在它的 CODEX_HOME 里重新登录」)会**覆盖掉邻居的凭据**,这种形态现在单独给话。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.98
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.98 @sleep2agi/agent-node@2.5.0-preview.74
anet node stop <name> && anet node start <name> --copresence
```

🔴 **两个包要一起升。** 不经 CLI 起的节点靠的是 `agent-node` 里那份;经 CLI 起的靠本包这份。只升一个,另一条路径上的节点仍是旧行为。

## 边界与证据

- 行为本身不变,仍然**只告警不拒启**、仍然**只读别的节点公布的摘要**(`<nodeDir>/.codex-auth-fingerprint.json`,0600,内容只有 `{schema_version, alias, fingerprint, written_at}`),只有本节点自己的 `auth.json` 会被打开。
- **主判据落在「不经 CLI」那条路上** —— 只用 agent-node 起的节点也写出指纹文件并告警;这正是 `.97` 覆盖不到的那一格。两向见证:拿掉 agent-node 调用点 ⇒ 契约红;文案退回单分支 ⇒ 4 条红;两份 copy 差一个字节 ⇒ parity 门红。
- `bun test src/` 1264 pass / 0 fail;`tsc --noEmit` rc=0;doc-symbol-pins 两种 CI 参数形式、version-claims 三种形式全 rc=0;`docs/architecture.md` 两处行号 pin 因 `cli.ts` 增行漂移,用该门自己的 `--fix` 重钉。
- **未做**:#1918 的 ③(token broker / 单刷新者)仍不在本版,单独排期。

## promote 时的 must_contain

`"version": "2.3.0-preview.98"`
