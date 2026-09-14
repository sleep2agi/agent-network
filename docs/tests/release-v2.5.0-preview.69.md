# agent-node 2.5.0-preview.69

`.68` 之后 `agent-node/` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| main after #1869 | #1869 | 回复里指向本机文件的 markdown 链接自动上传到 hub 并作为附件(`runtime/reply-file-links.ts` + `sendReply`) |

## 这一版带给用户什么

任何 runtime 的节点在回复里写 `[报告](/abs/path/report.pdf)`,人在桌面端就能看到附件卡片并下载;此前只有 claude-agent-sdk 的 `upload_file` 工具能做到,codex 等节点贴的本地路径在桌面端只剩一行文字(2026-09-14 真机)。上传不了的会在链接后注明原因(不在节点 cwd/家目录内、超 12 MB、不存在……)。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.69
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.69
anet node stop <name> && anet node start <name>      # 或 anet daemon restart <daemon>
```

## 证据

- `reply-file-links.test.ts` 9/9;agent-node 全套 1786 pass;typecheck ratchet 81 = 基线 81。

## promote 时的 must_contain

`"version": "2.5.0-preview.69"`
