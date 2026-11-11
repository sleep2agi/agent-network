# agent-node 2.5.0-preview.202

Since `.201`: 思考档位随模型清单上报；daemon 能代读收编节点的模型清单。

## Why

admin 2026-11-11：客户端模型面板对 OpenCode 节点写「思考档位 未知」，而 vdev 的 OpenCode
服务器对 deepseek-flash / deepseek-v4-pro 都提供 none / low / high / max。
- 节点自报清单多一格 `opencode_catalog_variants`（`provider/model=none,low,high,max`，只有 id）；
- daemon 代读模型清单时按收编登记找子节点目录（#3508），收编来的节点不再 node_not_found。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.234 @sleep2agi/agent-node@2.5.0-preview.202
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
```

⚠️ 与 agent-network `2.3.0-preview.234` 精确配对。

## What it does not do

- 不改已有节点的配置，不重启已运行的节点；只影响 daemon 处理 clone_node
