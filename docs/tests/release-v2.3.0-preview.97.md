# `@sleep2agi/agent-network@2.3.0-preview.97`

## 🔴 这一版不是配对空包:codex 那条护栏就装在本包里

上一版(`.96`)只带了配对号。**这一版不一样** —— `.96` 之后 `agent-network/bin|src` 有一个功能提交,而且它是今天两条修复里更要紧的那条:

| 提交 | PR | 内容 |
|---|---|---|
| 894d1213 | #1920 | codex 共存:启动时按 **refresh token** 指纹检测「多个节点共用同一份 codex 登录态」,命中就点名另一个 alias 告警(**只告警,不拒启**);刷新失败改成两个命名原因 —— `rotation-conflict` 与 `token-endpoint-unreachable`,各带各的修法(#1918 的 ①②) |

代码落在 `agent-network/bin/cli.ts` 与 `agent-network/src/codex-auth-fingerprint.ts`,进的是本包的 `dist` ⇒ **要拿到这条护栏,升的是 `anet`,不是 `agent-node`。** 同时配对常量升到 `2.5.0-preview.73`(`src/opencode-agent-node-pair.ts`),否则 published-pins 门会在 agent-node .73 发出后每天红。

## 这一版带给用户什么

**一个账号喂 N 台 codex 节点,今天是会断的,而且断得像随机故障。** 共存启动路径**刻意**把主机 `~/.codex/auth.json` 复制进每个节点的 CODEX_HOME,并且「节点自己那份更新就不动它」——因为 codex 是就地刷新。这组规则是**单向同步**(主机→节点),而轮换发生在**节点侧**,偏偏 OAuth refresh token 是一次性的:

```
节点 A 用 RT0 刷新  →  服务端发 RT1 给 A,作废 RT0
A 的 RT1 不回主机,也不到 B
节点 B 还拿着 RT0   →  "refresh token was already used"
```

谁先刷新谁活,其余的**几天后**才炸 —— 所以它读起来像随机掉线,不像配置错误。`.96` 之前产品里没有任何东西注意到这件事(非测试代码里 `refresh_token` 只出现在一段注释里)。本版让它**在启动时就说出来**:

```
[anet] ⚠ <alias> shares its codex login with: <其它 alias> (refresh fingerprint <8hex>)
```

**刷新失败不再只甩一句上游原文。** 两种形态的结局完全不同,现在分开命名:`rotation-conflict`(上游答「token 已被用过」⇒ 本节点重登一次,然后趁节点 idle 只重启 app-server);`token-endpoint-unreachable`(`Failed to refresh token: error sending request …/oauth/token` ⇒ 出网/代理到不了 token 端点,**谁的 token 都没在轮换**)。后者的文案明写**不要去拷别的节点的 auth.json** —— 现场把出网被墙误诊成轮换冲突,顺手拷一份,正好亲手制造出共链。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.97
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.97 @sleep2agi/agent-node@2.5.0-preview.73
anet node stop <name> && anet node start <name> --copresence   # codex 共存节点重启时才跑检测
```

## 边界与证据

- **只告警,不拒启**:一台机上所有节点往往共用一份登录态,拒启等于一次把整机弄停;函数里没有 `process.exit`,有契约测试钉着。
- **只读别人公布的摘要**:指纹写在 `<nodeDir>/.codex-auth-fingerprint.json`(0600),内容只有 `{schema_version, alias, fingerprint, written_at}`;横向比较读的是**别的节点这个文件**,只有本节点自己的 `auth.json` 会被打开。摘要是 `sha256(refresh_token)` 截 8 位十六进制 —— 够分辨「是不是同一份凭据」,不够当凭据。
- **为什么不能复用既有的 `accountFingerprint`**:那个哈希的是 `tokens.account_id`,回答「哪个账号」。同一个人同一账号在两台各登录一次,account_id 相同但 refresh token 不同,**彼此不会作废,属正常、不该告警**。所以复用同一个 `shortHash` 原语,作用在不同的值上。
- 23/23 单测(60 断言)、`bun test src/` 1259 pass / 0 fail、`tsc --noEmit` rc=0、doc-symbol-pins 两种 CI 参数形式全绿;五处定向变异逐个转红再恢复。
- **未做**:#1918 的 ③(token broker / 单刷新者)不在本版,单独排期。现场那台主机上「已经发生过轮换冲突」仍是 unproven —— 它同时撞着 `token-endpoint-unreachable`。
