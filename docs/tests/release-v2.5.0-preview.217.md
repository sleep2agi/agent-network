# agent-node 2.5.0-preview.217

与 `@sleep2agi/agent-network` (CLI) **2.3.0-preview.251** 精确配对。

## Why

**节点开始上报自己的 workdir**（`#5125` 的另一半，Hub 侧 `.291` 已上线）。

```text
· 位置：report_status.config_snapshot **顶层** workdir
  （不塞 flags：flags 参与 config content-match，加键会让旧 Hub 的比对漂移）
· 只报绝对路径（/…、C:\…、\\server\…）；相对路径在 Hub 侧无意义 ⇒ 不报
· 空 / 含换行 / 超 4096 字符 ⇒ 不报（不猜）
```

效果：装了这一版并重启的节点，在 `/api/nodes` 里会从 `workdir_state=not_reported` 变成 `reported`，
App 的 fork 向导可以显示「与源节点共用目录 {path}」（能否看到仍由 Hub 的三态权限裁决）。

## Install

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.217 @sleep2agi/agent-network@2.3.0-preview.251
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
anet upgrade  # 按配对升级节点与 CLI
```

## 未验

```text
· 出包后我起一个节点确认 not_reported → reported（含真实路径）
```
