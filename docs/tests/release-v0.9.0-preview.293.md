# commhub-server 0.9.0-preview.293

Since `.292`

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.293
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.293
# production: 装到新 runtime 目录 → 改 profile 的 HUB_RUNTIME_DIR → pm2 restart commhub-hub → 回读 /health
```

## What changed

```text
#3760  「CLI 在等一个选项」的可观测信号（只读展示，不改任何 runtime 行为）
        · report_status.config_snapshot 新增 interactive_prompt { kind, excerpt?, detected_at }
          （写进 schema —— zod 会静默丢未知键）
        · /api/nodes 投影 prompt_pending：{ kind, excerpt, detected_at } | null
        · 权限与 workdir 同一套：看不见该节点 ⇒ prompt_pending 为 null（连 kind 都不给）
          理由：codex_trust / claude_trust 的文本常带目录路径，摘录只做 token 脱敏、不认路径
```

## Verified

```text
· 检测器单测 5 pass（分类 / 宁漏不误 / ANSI / 脱敏 / 同类保留首次时间）
· schema + #476 字节预算 13 pass；投影 2 pass（含「普通成员拿不到」反向断言）
· 回归 api-nodes-shape + node-workdir-http 13 pass
```

## Not verified

```text
· 真机：节点实际触发提示后 prompt_pending 有值（节点侧接线在下一张卡 ②，本版只有管道）
```
