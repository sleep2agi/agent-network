# `@sleep2agi/commhub-server@0.9.0-preview.44`

## 为什么发这一版

`#1545` 那条链的 **hub 半边**有两个提交已经在 main 上，但**没有任何一版包含它们** ——
也就是说 daemon 侧和 CLI 侧都已经发出去了，而 hub 这一段还停在原地。

| 提交 | 内容 |
|---|---|
| `450614fe`（#1558） | hub 收下并带出「`can_create_nodes` 是多久以前测的」 |
| `c3e9bdfa`（#1588） | `create_node` 被拒时说清**这个判断是多久以前做的** |

### 为什么「多久以前」这一格值得单独发一版

一个 `blocked` 的 daemon，**刚测出来的**和**三周前测出来的**是两件不同的事：

- 刚测的 ⇒ 去那台机器按 `blocked_reason` 修；
- 三周前测的 ⇒ 那台 daemon 多半是**开机算一次就永久缓存**的旧版本（agent-node ≤ `2.5.0-preview.54`），
  它可能早就好了 —— 先重启/升级它，再谈修 pin。

而用户看到这条拒绝的时刻，正好就是他在决定「去修哪台机器」。

🔴 年龄未知时给的是**显式 `null` + 一个说明为什么的枚举**，不是省略这两个键 ——
省略读起来像「没有这个问题」，而调用方常常是个 agent，它会默认那是刚测的。
**朝「更可信」方向撒谎，比不给更糟。**

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.44
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.44
# hub 需要重启才会用新逻辑
```

验收（SOP §2.5 四步）：

```bash
npm view @sleep2agi/commhub-server dist-tags.preview        # 期望 0.9.0-preview.44
npm pack @sleep2agi/commhub-server@0.9.0-preview.44
tar -xzf *.tgz
grep -rc 'unknown_no_heartbeat_time'   package/src   # 期望 >0
grep -rc 'remediation_hint'            package/src   # 期望 >0
grep -rc 'daemon_cannot_create_nodes'  package/src   # 正控:期望 >0
```

🔴 **判据先在已发布的 `.43` 上量过两侧**，不是照着猜：

```
.43:  unknown_no_heartbeat_time   = 0    ← 目标串上一版确实不存在
.43:  remediation_hint            = 0    ← 同上
.43:  capability_observed_ms_ago  = 0    ← 同上(#1558 也是本版新增)
.43:  daemon_cannot_create_nodes  = 10   ← 正控:grep 在这份产物上确实有效
```

🔴 **这个包可以裸 grep，但那是查过才知道的**：它 `files: ["src","bin"]`、`main: src/index.ts`、
**没有 build 脚本** —— 发的是 TypeScript 源码，既不混淆也不压缩。
**别把这条判据照抄到 `agent-network`**：那个包的 `dist/bin/cli.js` 带
`javascript-obfuscator --string-array-encoding base64`，**裸 grep 恒 0**（见 SOP §2.5）。

## 🔴 本次**故意没有**改 `PINNED_SERVER_VERSION`

`agent-network/bin/cli.ts` 里的 `PINNED_SERVER_VERSION` 仍是 `0.9.0-preview.43`。

这是**对的**，不是漏改：`release-gate` 的 **gate 2** 会拿这个常量去 `npm view` 核对
**是否已发布**。把本次要发的版本提前写进去，发它的那个 run 会被自己的 pin 卡死
（2026-08-27 发 `.33` 时实测过一次，`publish` job 直接 skipped）。

正确顺序是两步，别合成一步：
1. 先发 `.44`（本 PR）——常量保持 `.43`；
2. `.44` 出现在 npm 上之后，再单独把常量改成 `.44`。

`tests/test766-bunx-preflight` 里那个字面量钉的是 `PINNED_SERVER_VERSION` 的值，
所以它此刻仍应是 `.43`，随第 2 步一起改。

## 发布方式

`release-gate (v0)`，`package=commhub-server`、`version=0.9.0-preview.44`、`publish=true`，
`--ref main`。只发 preview；promote 到 latest 需要 owner ACK，本次**不做**。

🔴 本机不发包（Vincent 2026-08-27 定）。
