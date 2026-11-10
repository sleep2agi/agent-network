# 0.9.0-preview.196

> REST 建的任务也会记录**父子关系来源**，统计不再只覆盖一半。

## 为什么要它

`.195` 给 `send_task` 加了 `meta_json.parent_source`（`explicit` / `inferred`），用来回答 `#669`：**多少子任务靠推断挂上、多少是显式指定**。

但只在 MCP 路径写了。REST `/api/task` 没写——当时的理由是「REST 不走推断，别造第二真相」。方向对，结论少了一半：**REST 建的子任务同样是显式父子关系**，不标就被统计漏掉。

实测（`.195` 上线后 90 分钟）：

```
3 条带 parent_task_id 的任务，全部走 REST，全部没有 parent_source，meta_json 为 NULL
```

⇒ 分母只含 MCP 建的子任务 ⇒ `explicit` 占比被系统性压低，而它正是要统计的比例。

## 本版

```
REST /api/task 带 body.parent_task_id → meta_json.parent_source = "explicit"
不引入任何推断（REST 块内没有「找最近 delivered」的 SQL）
```

`parent_source` 已在 `logicalRequestMeta` 里排除，**不影响幂等重放判定**。

## 上线后怎么验

```bash
curl -s localhost:9200/health | jq -r .version      # 0.9.0-preview.196

# 等一条 REST 建的子任务（带 parent_task_id），期望：
#   select json_extract(meta_json,'$.parent_source') from tasks where task_id=…  → "explicit"
```

## 无 schema 变更

回滚：`HUB_RUNTIME_DIR` 指回 `.195`。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.196
commhub-server --version   # 0.9.0-preview.196
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.196
commhub-server --version   # 0.9.0-preview.196
```
