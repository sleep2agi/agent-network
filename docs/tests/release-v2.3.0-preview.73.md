# `@sleep2agi/agent-network@2.3.0-preview.73`

## 为什么发这一版：三条「报错指错方向」的修复

这一版全部是同一族缺陷：**命令没崩，但它告诉你的原因是错的**，于是人朝错的方向使劲。

| # | 以前说什么 | 实际是什么 |
|---|---|---|
| [#1580](https://github.com/sleep2agi/agent-network/pull/1580) | 「升级 agent-node 才能看到」 | 升级不够 —— daemon 是长驻进程，**必须重启** |
| [#1581](https://github.com/sleep2agi/agent-network/pull/1581) | 「连不上 hub」 | hub 完全可达，是**本机 CLI 没凭据**（HTTP 401） |
| [#1586](https://github.com/sleep2agi/agent-network/pull/1586) | （什么都不说） | daemon 启动时就该告诉你：**你装了 grok，但这台 daemon 看不见它** |

### #1580 —— 升级不等于生效

`anet daemon list` 的两条文案叫人升级 `agent-node`，都没说要重启。而 daemon 是长驻进程，
这一格由它**在进程内**算出；换掉磁盘上的包，对一个已经在跑的进程没有任何影响。
真机上（Mac mini，daemon 已跑很久、agent-node 是 `.46`）照着做完仍显示「未知」。

### #1581 —— 401 不是「连不上」

实测同一台机器同一刻：`/health` → **200，0.79s**；`/api/host-supervisors` → **401**。
`fetchDaemonCapabilities()` 以前把**五种**失败（没配 hub / HTTP 错 / 401·403 / 应答读不懂 /
真连不上）全部返回 `null`，然后只印「连不上 hub」——而那句只对应其中一种。
现在五种各说各的，401 明说「hub 是通的，要修的是凭据」并给出 `anet login`。

### #1586 —— 在 daemon 启动时就说，而不是等节点报错

真机上那条链是：daemon 的 PATH 少了 `~/.grok/bin` → 建节点（**子节点继承 daemon 的 PATH**）
→ 节点报 `grok CLI not found` → 用户问它才看到。**问题在 daemon 这边，报错出现在节点那边。**
现在 `anet daemon start` 直接说，并给出可粘贴的 `export`。

🔴 只在「**装了、却不在 PATH 上**」时出声；「压根没装」不报 —— 因为 `daemon init` 默认声称
支持全部 runtime，逐个警告会让一台只跑 claude 的机器每次启动刷一屏无关内容，
**那种警告一周内就会被无视，等于悄悄删掉它**。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.73
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.73
# 🔴 本机的 anet 升级即生效;但**远端那台 daemon**要重启才会用新逻辑:
anet node stop <daemon> && anet daemon start <daemon>
```

验收（SOP §2.5 四步，第 ④ 步不能省）：

```bash
npm view @sleep2agi/agent-network dist-tags.preview            # 期望 2.3.0-preview.73
npm pack @sleep2agi/agent-network@2.3.0-preview.73
tar -xzf *.tgz
D=package/dist/src/daemon-capability-display.js
grep -c '必须重启 daemon'        $D   # 期望 >0  (#1580)
grep -c 'hub 拒绝了本机的身份'   $D   # 期望 >0  (#1581)
grep -c '升级它才能看到'         $D   # 期望 ==0 (旧文案已消失)
node package/dist/bin/cli.js --version                          # ④ 真的跑一次
```

🔴 **为什么验收位置是 `dist/src/daemon-capability-display.js` 而不是 `cli.js`**：
这个包的 build 会对 `cli.js` / `client.js` / `node-server.js` 跑
`javascript-obfuscator --string-array-encoding base64`，**裸 grep 在混淆产物上会骗人**。
`daemon-capability-display.js` 不在混淆名单里（它要在浏览器里被 dashboard import），
所以它是这个包唯一可靠的字符串验收位置。**这条判据不能从 agent-node 那个包照抄** ——
那个包只 `--minify` 不混淆。

🔴 **三条判据都先在已发布的 `.72` 上量过两侧**，不是照着猜：

```
.72:  必须重启 daemon      = 0     ← 目标串在上一版确实不存在
.72:  hub 拒绝了本机的身份 = 0     ← 同上
.72:  升级它才能看到       = 1     ← 旧文案在上一版确实存在(所以 .73 变 0 才有信息量)
```

## 发布方式

`release-gate (v0)`，`package=agent-network`、`version=2.3.0-preview.73`、`publish=true`，
`--ref main`。只发 preview；promote 到 latest 需要 owner ACK，本次**不做**。

🔴 本机不发包（Vincent 2026-08-27 定）。
