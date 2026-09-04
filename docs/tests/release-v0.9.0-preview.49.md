# `@sleep2agi/commhub-server@0.9.0-preview.49`

## 为什么发这一版:**名册里的 version / 遥测不再在换手上报时被清空**(#1809)

`.48` 之后 `server/src` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| `8a2d2cae` | #1810 | **#1809** —— `report_status` 对同 alias「另一个 resume_id」的行走 DELETE+INSERT 时,INSERT 之后把没上报(仍为 NULL)的描述性列(version / agent / hostname / 六个遥测字段 / model / channels / registered_at …)从被替换的那行接手;状态类列(status / task / output / progress / score)仍以本次上报为准 |

| 用户看到的 | `.48` | `.49` |
|---|---|---|
| grok 共存 / claude 节点回复一条任务后的名册 version | 变空,3 分钟后心跳补回 | 一直在 |
| 同类节点的六个遥测字段 | 周期性出现又消失 | 一直在 |
| `registered_at` | 每次换手被改成当下 | 保留首次注册时间 |

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.49
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.49
# 生产 hub 走 deploy/hub/README.md 的六步(改 launcher 的 RUNTIME_DIR 那一行,pm2 restart),不要整文件覆盖
```

## 证据

- `report-status-resume-id-handover.test.ts` 4 条(换手保留 / 上报覆盖 / 来回换手 / 全新 alias 行为不变);变异去掉 version 接手 → 2 红;test698 的 sed 变异在本地重新见证红。
- server 全量 101 文件 rc=0;PR #1810 在 main 上 109 项检查全绿(2026-09-04)。
- DEV 真机(hub 日志 12:46:47–54):grok-v1 三次上报后 version .64 → NULL,即本版修的现象。

## promote 时的 must_contain

`"version": "0.9.0-preview.49"`(闸 4 对整个 `package/` 目录 `grep -rq`,命中 package.json;`.48` 产物 0 命中)。
