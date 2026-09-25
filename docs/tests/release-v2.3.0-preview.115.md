# `@sleep2agi/agent-network@2.3.0-preview.115`

## 为什么发这一版:节点「项目文件夹」只读浏览(#1999)

| 提交 | PR | 内容 |
|---|---|---|
| 92d10be5 | #1999 | 节点「项目文件夹」只读浏览:hub `list_node_files` / `read_node_file`(op `files_list` / `file_read`,复用规则文件门铃与请求表,独立单飞通道),能力位 `files_capable`;节点端按工作目录列目录/读文本(≤256 KiB),凭据类文件只列名不给内容,路径与软链接不得逃出工作目录 |

安全规则:hub 在写行之前就拒绝绝对路径、`~`、盘符、`..`、反斜杠、NUL;节点 token 不能发起文件浏览(节点 A 永远看不到节点 B);只有发起请求的登录用户能取结果。节点端:所有目标 realpath 后必须仍在工作目录内;`.env*`、私钥、`auth.json`、`*.npmrc`、`.git/`、`.ssh/`、`.aws/`、codex/grok/claude 会话目录等凭据类文件只列名字、不给内容和大小;`node_modules` / `.git` 只列不进。34 处安全守卫逐一变异全部变红。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.115
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.115 @sleep2agi/agent-node@2.5.0-preview.88
# hub:commhub-server@0.9.0-preview.59(生产 hub 走 deploy/hub/README.md 六步)
```

🔴 三者配套:hub `.59` + agent-node `.88` + agent-network `.115`;客户端 0.2.94 起显示「项目文件夹」。

## 证据

- hub `bun run test` 111 文件 1319 pass / 0 fail;agent-node 2029 pass / 0 fail;typecheck 棘轮 81 = 基线;共享模块 parity 测试绿;一次性 hub 端到端 15/15(无凭据值、无绝对路径出现在任何结果或 hub DB)。

## 未覆盖

- 请求表里暂存的文件内容目前不会自动清理——清理(取后即清 + 24 h TTL)在下一版 hub 修复。

## promote 时的 must_contain

`"version": "2.3.0-preview.115"`
