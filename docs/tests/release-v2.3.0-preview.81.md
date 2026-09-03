# `@sleep2agi/agent-network@2.3.0-preview.81`

## 为什么发这一版:两条 claude/codex 节点的「看得见」修复

`.80` 之后 `agent-network/bin|src` 两个提交:

| 提交 | PR | 内容 |
|---|---|---|
| `3e644288` | #1798 | **#849** —— codex 共存 ① 就绪探针按端口探,不再等一句 codex 二进制不会打印的「listening on:」(此前每次等满 25 s 判失败) |
| `71bcbf13` | #1799 | **#171** —— claude-code 裸节点把配置里的 `model` 报给 hub(在线 38/38 此前为空) |

| 用户看到的 | `.80` | `.81` |
|---|---|---|
| `anet node start <codex 节点> --copresence` ① 步 | 等 25 s 后 `❌ app-server did not bind` | app-server 一绑上端口就 `READY`(实测 1.1 s) |
| Dashboard 上 claude-code 节点的 model | 空 | `anet node create --model X` 写的那个 X;没写仍为空 |

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.81
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.81
anet node stop <name> && anet node start <name>   # claude-code 节点的 .anet/node-server.js 启动时重生成
```

## 边界

- codex 共存的端口探针没有在真机起过三件套验证(需登录的 codex);行为与 Windows 启动器一致,端口绑上但服务未就绪的情形由下一步 bridge 探针兜底。
