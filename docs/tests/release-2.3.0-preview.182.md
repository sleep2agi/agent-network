# agent-network 2.3.0-preview.182

接在 `2.3.0-preview.181` 之后的 preview 版本，发布自 `main` 的 `ad401958`。

## 本版内容（相对 2.3.0-preview.181）

- **feat(#1510 首片 / PR #2819)**：节点向 Hub 上报「节点到 Hub 的链路形态」
  （`loopback` / `https` / `plain`），便于区分本机回环与经代理/明文入站的节点。
- **feat(#1491 E1 / PR #2816)**：Hub 增加节点密钥的 REST 入口（排队 + 轮询），
  复用既有 lane。
- **feat(#2056 / PR #2814)**：`anet node secret set/unset`；值只走 stdin 或既有
  env，不落命令行。
- **feat(#2056 首片 / #909 / PR #2812)**：`anet node secret list` 只列 key 名，
  不读值。
- **feat(#1474 / #909 / PR #2811)**：节点上报自己有哪些 env key 的**名字**，
  不上报值。
- **feat(#1473 / #909 / PR #2810)**：Hub 的 Skills / 密钥名 / Provider 增加只读
  REST 读面。
- **fix(#1940 / PR #2808)**：auto-chain 按「尝试」去重，终态父行不再被改写。
- **feat(#1198 / PR #2807)**：状态上报里带上节点运行的 OS 账号。
- 其余为测试与文档调整（DSH 文档与截图、续接判据用例等）。

> 本版**包含**此前已合入、但未随 `181` 出现在 GitHub Release 页的
> OpenCode V2 共用 Server（#2776 / #2777 / #2786 / #2788）。`181` 的 npm 包
> 已发布，但发布门在发后核实阶段因 registry 可见性超时判红，未生成 Release。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.182
```

## Upgrade

```bash
anet upgrade --channel preview
# 或指定版本
npm install -g @sleep2agi/agent-network@2.3.0-preview.182
```

> OpenCode V2 共用 Server 需要 CLI `2.3.0-preview.180+` 与 agent-node
> `2.5.0-preview.146` 的已验收配对；宿主需先启动
> `~/.anet/opencode-shared-server.json` 指向的 loopback Server。

## 验证

```bash
anet --version   # anet v2.3.0-preview.182
```
