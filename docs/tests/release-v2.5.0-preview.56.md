# `@sleep2agi/agent-node@2.5.0-preview.56`

## 为什么发这一版：一句报错让人去装一个已经装了的东西

真机（Mac mini）上，通过 daemon 建的一个 `grok-build-acp` 节点给用户回的是：

```
grok 错误: grok CLI not found. Install Grok Build CLI and run `grok --version`
before starting this node.
```

而那台机器上 grok **装着**，就在官方安装器放它的位置（`~/.grok/bin/grok`，实测
`grok 1.0.13`）。真因是 daemon 的 PATH 里没有 `~/.grok/bin`，而 **daemon 建出来的
子节点继承 daemon 的 PATH**。照那句话去重装，装十遍也不会好。

## 内容（#1582）

原来一个 `catch` 吞掉三种完全不同的失败，全说成「没装，去装」：

| 实际失败 | 该怎么修 | 旧文案 |
|---|---|---|
| `ENOENT`（不在 PATH） | 把 `~/.grok/bin` 加进 PATH | 「没装，去装」 |
| `EACCES`（不可执行） | `chmod +x` | 「没装，去装」 |
| 非零退出（grok 在，自己起不来） | 看它的 stderr | 「没装，去装」 |

现在按 errno 分三种，各自说出下一步，并**回显当前 PATH**（「PATH 里没有」不把 PATH
印出来等于没说）。ENOENT 那条额外点出真机上坑住人的那一点：**子节点继承 daemon 的
PATH，在你自己的 shell 里 export 没用。**

🔴 **不建议 `GROK_BINARY`**：那个覆盖只有 `grok-build-cli` 那条路读，
`grok-build-acp` 从头到尾没读过它。建议一个在本运行时无效的开关，等于把这条报错的
毛病换个方向再犯一次 —— 有一条测试专门钉住这点。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.56
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.56
# 🔴 daemon 是长驻进程，换包对已经在跑的进程没有任何影响，必须重启：
anet node stop <daemon> && anet daemon start <daemon>
```

验收（SOP §2.5 四步，第 ④ 步不能省）：

```bash
npm view @sleep2agi/agent-node dist-tags.preview                  # 期望 2.5.0-preview.56
npm pack @sleep2agi/agent-node@2.5.0-preview.56
tar -xzf *.tgz
grep -c '不在 PATH 上' package/dist/cli.js        # 期望 >0 —— 本版新增的文案
grep -c 'can_create_nodes' package/dist/cli.js    # 正控:期望 >0
```

🔴 **这两条判据是先在已发布的 `.55` 上量过才写进来的**，不是照着猜的：

```
.55 的 dist:  can_create_nodes = 1   ← 正控:grep 在这份产物上确实有效(minify 不混淆)
.55 的 dist:  '不在 PATH 上'   = 0   ← 目标串在上一版确实不存在
```

两侧都验过，所以 `.56` 上第一条 >0 才是有信息量的。**只写正控会漏掉「grep 恒 0」，
只写目标串会漏掉「产物被混淆导致恒 0」——那正是 agent-network 那个包的情况。**

## 发布方式

`release-gate (v0)`，`package=agent-node`、`version=2.5.0-preview.56`、`publish=true`，
`--ref main`。只发 preview；promote 到 latest 需要 owner ACK，本次**不做**。

🔴 本机不发包（Vincent 2026-08-27 定）。
