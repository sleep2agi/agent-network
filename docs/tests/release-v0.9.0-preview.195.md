# 0.9.0-preview.195

> 任务记录里多一个**来源标记**：`parent_task_id` 是显式指定还是推断得来。

## 为什么要它

`#669` 要求「先统计有多少子任务靠推断挂上，再决定要不要取消推断」。但那张卡一直做不动——因为 `tasks` 表只存 `parent_task_id`，**不记它是怎么来的**：

```
近 7 天带 parent_task_id 的任务：949 条
其中 meta_json 里能区分「显式 / 推断」的：0 条
```

一项统计，如果它的输入字段根本不存在，那这张卡会永远停在「等统计」。

## 本版加了什么

```
显式带 parent_task_id        → meta_json.parent_source = "explicit"
未带、推断命中最近 delivered  → meta_json.parent_source = "inferred"
两者都没有                    → 不写该字段
```

只加旁证字段，**不改任何派发/推断行为**。

## 一个它自己引发的坑（已修）

上线前 CI 抓到：`test1210-actual-target-contract` 红在

```
{"ok":false,"error":"idempotency_conflict",
 "message":"client_request_id was already used with a different task payload"}
```

根因是 `parent_source` 进了幂等指纹：库里存的 meta 多了这个字段，而幂等比较用「原始 meta」比「库里 meta」⇒ 不等。更隐蔽的是它**只在推断命中时**出现——第一次派发时可能没有可推断的父任务（不带该字段），重放时上一条已 delivered ⇒ 推断命中 ⇒ 字段出现。

修法：`parent_source` 与 `auth_origin` 同类（Hub 派生的审计事实，不属于客户端请求），在 `logicalRequestMeta` 里一并排除。

## 上线后怎么验

```bash
curl -s localhost:9200/health | jq -r .version      # 0.9.0-preview.195

# 7 天后可统计推断占比：
# select parent_source, count(*) from tasks
#  where parent_task_id is not null and created_at >= datetime('now','-7 day')
#  group by 1;
```

## 无 schema 变更

回滚：`HUB_RUNTIME_DIR` 指回 `.194`。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.195
commhub-server --version   # 0.9.0-preview.195
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.195
commhub-server --version   # 0.9.0-preview.195
```
