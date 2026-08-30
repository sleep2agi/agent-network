# agent-network 2.3.0-preview.75

`.74` 之后 `agent-network/` 上有 3 个提交，**但只有 1 个对用户有实际影响**。

| 提交 | PR | 内容 | 用户可见 |
|---|---|---|---|
| `626429e0` | #1616 | `daemon restart` 起不来时说清「它现在是停着的」 | **是** |
| `16542789` | #1612 | 两处会腐烂的注释改写 | 否（注释） |
| `22a225fb` | #1611 | `PAIRED_AGENT_NETWORK_VERSION` 跟随 agent-node `.57` | 否（常量） |

发这一版的理由不是"攒了 3 个提交"，而是 **#1616 直接减少用户在真实故障下的困惑**。

## #1616 修的是什么

`anet daemon restart` = `stop` 然后 `start`。**`start` 失败时 daemon 处于停止状态**，
而上面已经打印过「先停」——用户很容易读成「restart 没成功」，而不是「**我的 daemon 现在没了**」。

现在失败时会明确打印：

```
🔴 [anet daemon] "<name>" 已经停了,但没能起来 —— 现在它是**停着的**。
   重试:  anet daemon start <name>
   先看上面的启动报错;常见原因是运行时二进制的版本不在验证清单里(见 #1615)。
```

异常**原样抛出**（退出码与栈都保留），只在抛之前把当前状态说清楚。

## 为什么需要它（2026-08-30 实测两次）

| 场次 | 先做了什么 | 之后才发现 |
|---|---|---|
| 1 | `stop` 了一个共存节点 | grok 自更新到未验证版本 ⇒ fail-closed 拒绝启动（#1615） |
| 2 | `stop` 了另一个共存节点 | 启动进程没活过父会话 ⇒ 起来了个寂寞 |

第 2 次造成了约 2 分钟的真实节点中断。**两次都是停掉之后才知道起不来。**

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.75
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.75
# daemon 是长驻进程,换包要重启才生效:
anet daemon restart <daemon>
```

## 版本戳同步（5 处）

`package.json` / `package-lock.json`(2) / `PAIRED_AGENT_NETWORK_VERSION` / 中英 `getting-started.md`(各 2)。

🔴 **有两处 `2.3.0-preview.74` 刻意不改**：

```
docs-site/docs/{,en/}guide/grok-copresence.md
  anet daemon restart <daemon>    # 需要 anet ≥ 2.3.0-preview.74
```

那是**能力下界**（这个命令从 `.74` 起存在），不是版本戳。**它在 `.75` 上依然为真，改了反而变假。**

## 发布方式

走 GitHub Actions（`release-gate (v0)`）。不在本机 publish，对外只从 main 出。
`latest` 保持 `2.3.0-preview.47` 不动 —— 升 latest 需要 owner ACK。
